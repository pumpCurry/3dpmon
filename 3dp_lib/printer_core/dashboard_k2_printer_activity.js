/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 K2 printer activity 判定モジュール
 * @file dashboard_k2_printer_activity.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_k2_printer_activity
 *
 * 【機能内容サマリ】
 * - K2/F012 printer statusをjob lifecycleとphysical activityへ分離して判定
 * - 完了後も残るprintJobTimeをdiagnosticとして保持し、busy authorityには使わない
 * - CFS物理操作に必要なidle複合証拠の完全性と矛盾をfail-closedで評価
 *
 * 【公開関数一覧】
 * - {@link listObservedK2PrinterStatusScalarKeys}：観測済みstatus scalar keyを列挙
 * - {@link mergeK2PrinterStatusScalarSnapshot}：観測済みscalarを累積snapshotへ反映
 * - {@link classifyK2PrinterActivity}：K2 statusのactivityとphysical idle証拠を分類
 *
 * @version 1.390.1670 (PR #442)
 * @since   1.390.1669 (PR #442)
 * @lastModified 2026-09-09 11:16:25
 * -----------------------------------------------------------
 * @todo
 * - Gate19実機certificationでfeedStateの意味が確定した場合は補助診断へ追加する
 */

"use strict";

/**
 * K2 printer statusとして扱うroot scalar key一覧。
 *
 * 【詳細説明】
 * - boxsInfoだけのframeでprinter idle証跡を延命しないため、status由来のkeyだけを列挙する。
 * - `dProgress`と`fileName`はfirmware差異を吸収するaliasとして含める。
 *
 * @constant {ReadonlyArray<string>}
 */
export const K2_PRINTER_STATUS_SCALAR_KEYS = Object.freeze([
  "state",
  "deviceState",
  "printProgress",
  "dProgress",
  "printJobTime",
  "printLeftTime",
  "nozzleTemp",
  "bedTemp0",
  "targetNozzleTemp",
  "targetBedTemp0",
  "printFileName",
  "fileName",
  "printId",
]);

/**
 * CFS物理操作用idle証拠に必須とするstatus scalar key一覧。
 *
 * 【詳細説明】
 * - state/deviceStateだけでは加熱中や残り時間ありを除外できないため、hard blocker三項目も必須とする。
 * - printJobTimeは完了後も残る実機観測があるため必須値にもbusy根拠にも含めない。
 *
 * @constant {ReadonlyArray<string>}
 */
export const K2_PHYSICAL_IDLE_REQUIRED_SCALAR_KEYS = Object.freeze([
  "state",
  "deviceState",
  "printLeftTime",
  "targetNozzleTemp",
  "targetBedTemp0",
]);

/**
 * 値がobject自身のpropertyとして存在するか判定する。
 *
 * @private
 * @function hasOwn
 * @param {object|null|undefined} value - 検査対象
 * @param {string} key - 検査するproperty名
 * @returns {boolean} own propertyとして存在する場合true
 */
function hasOwn(value, key) {
  return !!value && Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * status scalar候補を有限numberへ変換する。
 *
 * 【詳細説明】
 * - null、空文字、NaN、Infinityは未観測と同じnullへ寄せる。
 * - firmwareが返す数値文字列はnumberへ変換する。
 *
 * @private
 * @function toFiniteNumberOrNull
 * @param {*} value - 数値候補
 * @returns {number|null} 有限number、またはnull
 */
function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || typeof value === "boolean") {
    return null;
  }
  if (typeof value === "string" && value.trim() === "") {
    return null;
  }
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

/**
 * K2 status frameで今回観測されたprinter scalar keyを列挙する。
 *
 * 【詳細説明】
 * - 累積stateではなく引数自身だけを見て、古い値をcurrent frameの証拠へ混ぜない。
 * - 結果は診断・fixture比較を安定させるため辞書順へ揃える。
 *
 * @function listObservedK2PrinterStatusScalarKeys
 * @param {object|null|undefined} payload - K2 WS9999 status payload
 * @returns {string[]} 今回frameに含まれたstatus scalar key
 * @example
 * const keys = listObservedK2PrinterStatusScalarKeys({ state: 2, deviceState: 0 });
 */
export function listObservedK2PrinterStatusScalarKeys(payload) {
  return K2_PRINTER_STATUS_SCALAR_KEYS
    .filter((key) => hasOwn(payload, key))
    .sort();
}

/**
 * K2 printer statusの観測済みscalarを累積snapshotへ反映する。
 *
 * 【詳細説明】
 * - deltaに存在しないkeyだけをpreviousから継承する。
 * - 明示されたnull、空白、無効値も新しい観測証拠として保持し、以前のsafe値を失効させる。
 * - progress/file nameのaliasは後着した表現を優先し、古いaliasがclassifierへ残らないよう除去する。
 * - 入力objectは変更せず、printer status scalarだけを含む新しいsnapshotを返す。
 *
 * @function mergeK2PrinterStatusScalarSnapshot
 * @param {object|null|undefined} previous - 直前までの累積scalar snapshot
 * @param {object|null|undefined} delta - 今回観測したK2 status payload
 * @returns {object} 観測済みscalarを反映した新しいsnapshot
 * @example
 * const snapshot = mergeK2PrinterStatusScalarSnapshot(
 *   { state: 2, printProgress: 100 },
 *   { printProgress: 75 }
 * );
 */
export function mergeK2PrinterStatusScalarSnapshot(previous = {}, delta = {}) {
  const snapshot = {};
  for (const key of K2_PRINTER_STATUS_SCALAR_KEYS) {
    if (hasOwn(previous, key)) {
      snapshot[key] = previous[key];
    }
  }
  for (const key of K2_PRINTER_STATUS_SCALAR_KEYS) {
    if (hasOwn(delta, key)) {
      snapshot[key] = delta[key];
    }
  }
  if (hasOwn(delta, "printProgress")) {
    delete snapshot.dProgress;
  } else if (hasOwn(delta, "dProgress")) {
    delete snapshot.printProgress;
  }
  if (hasOwn(delta, "printFileName")) {
    delete snapshot.fileName;
  } else if (hasOwn(delta, "fileName")) {
    delete snapshot.printFileName;
  }
  return snapshot;
}

/**
 * K2 printer statusをjob lifecycleとphysical activityへ分離して分類する。
 *
 * 【詳細説明】
 * - `state=0`と`state=2`はdeviceState=0の場合だけterminal idle候補とする。
 * - printLeftTimeまたはtarget温度が正の場合は、core stateにかかわらずhard busyとする。
 * - printJobTime、printFileName、printIdは完了後も残るためdiagnosticとしてのみ返す。
 * - CFS物理操作用idleは必須五項目が同一snapshotに有限値として揃い、三つのphysical scalarがexact zeroの場合だけtrueにする。
 * - completedでprintProgressが観測され100以外ならterminal stateとの矛盾としてidleを拒否する。
 *
 * @function classifyK2PrinterActivity
 * @param {object|null|undefined} payload - K2 printer status scalar payloadまたは累積snapshot
 * @returns {object} activity、completeness、physical idle判定と正規化済みscalar
 * @example
 * const result = classifyK2PrinterActivity({
 *   state: 2,
 *   deviceState: 0,
 *   printLeftTime: 0,
 *   targetNozzleTemp: 0,
 *   targetBedTemp0: 0,
 * });
 */
export function classifyK2PrinterActivity(payload = {}) {
  const state = toFiniteNumberOrNull(payload?.state);
  const deviceState = toFiniteNumberOrNull(payload?.deviceState);
  const printProgress = toFiniteNumberOrNull(
    hasOwn(payload, "printProgress") ? payload.printProgress : payload?.dProgress
  );
  const printJobTime = toFiniteNumberOrNull(payload?.printJobTime);
  const printLeftTime = toFiniteNumberOrNull(payload?.printLeftTime);
  const targetNozzleTemp = toFiniteNumberOrNull(payload?.targetNozzleTemp);
  const targetBedTemp0 = toFiniteNumberOrNull(payload?.targetBedTemp0);
  const coreStateComplete = state !== null && deviceState !== null;
  const physicalIdleEvidenceComplete = K2_PHYSICAL_IDLE_REQUIRED_SCALAR_KEYS.every((key) => {
    return hasOwn(payload, key) && toFiniteNumberOrNull(payload[key]) !== null;
  });
  const safeTerminalState = coreStateComplete && [0, 2].includes(state) && deviceState === 0;
  const hardBusy = (printLeftTime !== null && printLeftTime > 0) ||
    (targetNozzleTemp !== null && targetNozzleTemp > 0) ||
    (targetBedTemp0 !== null && targetBedTemp0 > 0);
  const lifecycleBlocksIdle = state !== null && ![0, 2].includes(state);
  const deviceBusy = deviceState !== null && deviceState !== 0;
  const completedProgressConflict = state === 2 && printProgress !== null && printProgress !== 100;
  const physicalIdleConflictReasons = [];
  if (completedProgressConflict) {
    physicalIdleConflictReasons.push("completed-progress-conflict");
  }
  if (printLeftTime !== null && printLeftTime < 0) {
    physicalIdleConflictReasons.push("invalid-negative-print-left-time");
  }
  if (targetNozzleTemp !== null && targetNozzleTemp < 0) {
    physicalIdleConflictReasons.push("invalid-negative-target-nozzle-temperature");
  }
  if (targetBedTemp0 !== null && targetBedTemp0 < 0) {
    physicalIdleConflictReasons.push("invalid-negative-target-bed-temperature");
  }
  const active = hardBusy || lifecycleBlocksIdle || deviceBusy || completedProgressConflict;
  const activityState = coreStateComplete
    ? (active ? "active" : "idle")
    : (active ? "active-without-core-state" : "unknown-core-state");
  const physicalIdleScalarsAreZero = printLeftTime === 0 &&
    targetNozzleTemp === 0 &&
    targetBedTemp0 === 0;
  const idle = physicalIdleEvidenceComplete &&
    physicalIdleScalarsAreZero &&
    safeTerminalState &&
    !active &&
    physicalIdleConflictReasons.length === 0;
  const idleReason = idle
    ? (state === 2 ? "completed-terminal-state" : "idle-terminal-state")
    : null;
  return {
    active,
    activityState,
    coreStateComplete,
    snapshotCompleteness: coreStateComplete ? "complete" : "partial",
    physicalIdleEvidenceComplete,
    physicalIdleScalarsAreZero,
    idle,
    idleReason,
    physicalIdleConflictReasons,
    observedScalarKeys: listObservedK2PrinterStatusScalarKeys(payload),
    state,
    deviceState,
    printProgress,
    printJobTime,
    printLeftTime,
    targetNozzleTemp,
    targetBedTemp0,
  };
}
