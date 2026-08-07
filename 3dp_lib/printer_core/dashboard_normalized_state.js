/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 normalized state モジュール
 * @file dashboard_normalized_state.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_normalized_state
 *
 * 【機能内容サマリ】
 * - Adapter が生成する NormalizedPrinterState と Normalized Patch の標準形を提供
 * - K1/K2 系 WS9999 status payload を legacy processData と比較しやすい patch へ正規化
 * - 温度、ファン、印刷状態、位置、エラー、AI/カメラ能力、CFS topology を意味単位へ分解
 *
 * 【公開関数一覧】
 * - {@link createEmptyNormalizedPrinterState}：空の NormalizedPrinterState を生成
 * - {@link createK1StatusPatch}：K1 系 payload を Normalized Patch へ変換
 * - {@link createK2StatusPatch}：K2 系 status payload を Normalized Patch へ変換
 * - {@link createK2BoxsInfoPatch}：K2 系 boxsInfo payload を material topology patch へ変換
 * - {@link applyNormalizedStatePatch}：Normalized Patch を既存 state へ適用
 * - {@link toFiniteNumber}：実機 payload の数値文字列を安全に number 化
 * - {@link parseK1Position}：`X:... Y:... Z:...` 形式の現在位置を分解
 *
 * @version 1.390.1303 (PR #432)
 * @since   1.390.1296 (PR #432)
 * @lastModified 2026-08-07 21:00:10
 * -----------------------------------------------------------
 * @todo
 * - Data Schema v3 の DeviceEndpoint / MaterialSource store と接続する
 */

"use strict";

import { EMPTY_CAPABILITY_SET } from "./dashboard_capabilities.js";

/**
 * NormalizedPrinterState の schema version。
 *
 * 【詳細説明】
 * - Gate 2 では dry-run 比較用の version であり、永続 Data Schema v3 の store version ではない。
 *
 * @constant {number}
 */
export const NORMALIZED_PRINTER_STATE_SCHEMA_VERSION = 1;

/**
 * Normalized Patch の schema version。
 *
 * 【詳細説明】
 * - state と patch の version を分け、差分 frame を扱う境界を明示する。
 *
 * @constant {number}
 */
export const NORMALIZED_PRINTER_PATCH_SCHEMA_VERSION = 1;

/**
 * K1 系印刷状態コードと Printer Core v3 ラベルの対応。
 *
 * 【詳細説明】
 * - legacy `PRINT_STATE_CODE` と同じ数値を維持し、UI の既存語彙へ接続しやすくする。
 *
 * @constant {object}
 */
const K1_PRINT_STATE_LABELS = Object.freeze({
  0: "idle",
  1: "printing",
  2: "completed",
  3: "checking",
  4: "failed",
  5: "paused",
});

/**
 * 実機 payload 値を有限 number へ変換する。
 *
 * 【詳細説明】
 * - K1 系 firmware は温度などを `"27.500000"` のような文字列で返す。
 * - 空文字、null、undefined、NaN、Infinity は `fallback` へ寄せる。
 *
 * @function toFiniteNumber
 * @param {*} value - 数値候補
 * @param {?number=} fallback - 変換不能な場合の戻り値
 * @returns {?number} 有限 number、または fallback
 * @example
 * const nozzleTemp = toFiniteNumber(payload.nozzleTemp);
 */
export function toFiniteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

/**
 * 実機 payload 値を percent 値へ変換する。
 *
 * 【詳細説明】
 * - 0 未満や 100 超の外れ値は表示崩れを防ぐため 0..100 に丸める。
 * - 変換不能な値は null として扱い、0 と区別する。
 *
 * @function toPercentNumber
 * @param {*} value - percent 値候補
 * @returns {?number} 0..100 の number、または null
 * @example
 * const fanPct = toPercentNumber(payload.modelFanPct);
 */
export function toPercentNumber(value) {
  const numberValue = toFiniteNumber(value);
  if (numberValue === null) {
    return null;
  }
  return Math.max(0, Math.min(100, numberValue));
}

/**
 * 最初に取得できた有限 number を返す。
 *
 * 【詳細説明】
 * - firmware 差で同じ値が複数 key に出るため、優先順位を配列で表現する。
 *
 * @private
 * @param {Array<*>} values - 数値候補の配列
 * @returns {?number} 最初に変換できた有限 number、または null
 */
function firstFiniteNumber(values) {
  for (const entry of values) {
    if (entry && typeof entry === "object" && !entry.present) {
      continue;
    }
    const value = entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "value")
      ? entry.value
      : entry;
    const numberValue = toFiniteNumber(value);
    if (numberValue !== null) {
      return numberValue;
    }
  }
  return null;
}

/**
 * 最初に取得できた percent number を返す。
 *
 * 【詳細説明】
 * - 呼び出し側が渡した優先順位に従い、percent として解釈できる最初の値だけを採用する。
 *
 * @private
 * @param {Array<*>} values - percent 候補の配列
 * @returns {?number} 最初に変換できた percent number、または null
 */
function firstPercentNumber(values) {
  for (const entry of values) {
    if (entry && typeof entry === "object" && !entry.present) {
      continue;
    }
    const value = entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "value")
      ? entry.value
      : entry;
    const percentValue = toPercentNumber(value);
    if (percentValue !== null) {
      return percentValue;
    }
  }
  return null;
}

/**
 * string 値を null 許容の trimmed string へ変換する。
 *
 * 【詳細説明】
 * - 空文字は legacy の意味を壊さないため空文字のまま返す。
 * - null / undefined は未観測として null を返す。
 *
 * @private
 * @param {*} value - 文字列候補
 * @returns {?string} 文字列、または null
 */
function toNullableString(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

/**
 * payload が指定 key を持つか判定する。
 *
 * 【詳細説明】
 * - 差分 frame では「key が無い」と「key があり null が届いた」を区別する必要がある。
 *
 * @private
 * @param {object|null|undefined} payload - WS9999 status payload
 * @param {string} key - 検査する key
 * @returns {boolean} key が存在する場合 true
 */
function hasOwn(payload, key) {
  return !!payload && Object.prototype.hasOwnProperty.call(payload, key);
}

/**
 * 条件付きで object に値を追加する。
 *
 * 【詳細説明】
 * - key が観測された場合だけ patch に値を入れ、未観測値で既存 state を消さない。
 *
 * @private
 * @param {object} target - 追加先 object
 * @param {string} key - 追加する key
 * @param {boolean} present - payload に key が存在する場合 true
 * @param {*} value - 追加する値
 * @returns {void}
 */
function setIfPresent(target, key, present, value) {
  if (present) {
    target[key] = value;
  }
}

/**
 * 追加済み key を持つ object だけ返す。
 *
 * 【詳細説明】
 * - 空 object を patch に入れないことで、`applyNormalizedStatePatch()` の処理対象を明確にする。
 *
 * @private
 * @param {object} value - 候補 object
 * @returns {object|undefined} key がある object、または undefined
 */
function omitEmpty(value) {
  return Object.keys(value).length > 0 ? value : undefined;
}

/**
 * 数値 flag を boolean へ変換する。
 *
 * 【詳細説明】
 * - 変換不能な値は null にし、false と未観測を区別する。
 *
 * @private
 * @param {*} value - flag 候補
 * @returns {?boolean} boolean、または null
 */
function toBooleanFlag(value) {
  const numberValue = toFiniteNumber(value);
  return numberValue === null ? null : numberValue === 1;
}

/**
 * K1 系 `curPosition` 文字列を XYZ 座標へ分解する。
 *
 * 【詳細説明】
 * - legacy `parseCurPosition()` と同じ `X:... Y:... Z:...` 形式を受け付ける。
 * - 一部軸が欠ける値は壊れた payload とみなし null を返す。
 *
 * @function parseK1Position
 * @param {*} value - `curPosition` 値
 * @returns {{x: number, y: number, z: number, raw: string}|null} 分解済み座標、または null
 * @example
 * const position = parseK1Position("X:296.50 Y:220.00 Z:300.16");
 */
export function parseK1Position(value) {
  if (typeof value !== "string") {
    return null;
  }
  const x = value.match(/X:\s*([-+]?\d+(?:\.\d+)?)/iu);
  const y = value.match(/Y:\s*([-+]?\d+(?:\.\d+)?)/iu);
  const z = value.match(/Z:\s*([-+]?\d+(?:\.\d+)?)/iu);
  if (!x || !y || !z) {
    return null;
  }
  return {
    x: Number(x[1]),
    y: Number(y[1]),
    z: Number(z[1]),
    raw: value,
  };
}

/**
 * payload の key 一覧を比較しやすい配列へ変換する。
 *
 * 【詳細説明】
 * - differential test で「この状態はどの raw field から来たか」を追えるようにする。
 *
 * @private
 * @param {object|null|undefined} payload - WS9999 status payload
 * @returns {string[]} ソート済み key 一覧
 */
function listRawKeys(payload) {
  return payload && typeof payload === "object" ? Object.keys(payload).sort() : [];
}

/**
 * K2 CFS topology の空 state を生成する。
 *
 * 【詳細説明】
 * - CFS と外部スプールを同じ `sources` 配列で表し、sourceId を参照 key にする。
 * - Gate 4 では read-only 観測だけに使い、既存 filament ledger や hostSpoolMap は更新しない。
 *
 * @private
 * @returns {object} 空の material topology state
 */
function createEmptyMaterialTopology() {
  return {
    schemaVersion: 1,
    cfs: {
      connected: null,
      enabled: null,
      unitCount: 0,
      topologyState: "unobserved",
    },
    units: [],
    sources: [],
    assignments: [],
    sameMaterialGroups: [],
  };
}

/**
 * 温度系 payload を NormalizedPrinterState の温度 object へ変換する。
 *
 * 【詳細説明】
 * - nozzle / bed / chamber を固定 slot とし、存在しない値は null にする。
 *
 * @private
 * @param {object} payload - K1 系 WS9999 status payload
 * @param {object=} options - 正規化オプション
 * @param {boolean=} options.patch - 差分 patch として未観測 key を省略する場合 true
 * @param {object=} options.protocolState - delta frame を累積した protocol state
 * @returns {object} 正規化済み温度 object
 */
function normalizeTemperatures(payload, options = {}) {
  const semanticPayload = options.protocolState && typeof options.protocolState === "object"
    ? options.protocolState
    : payload;
  if (!options.patch) {
    return {
      nozzle: {
        current: toFiniteNumber(payload.nozzleTemp),
        target: toFiniteNumber(payload.targetNozzleTemp),
        max: toFiniteNumber(payload.maxNozzleTemp),
      },
      bed: {
        current: firstFiniteNumber([payload.bedTemp0, payload.bedTemp1, payload.bedTemp2]),
        target: firstFiniteNumber([payload.targetBedTemp0, payload.targetBedTemp1, payload.targetBedTemp2]),
        max: toFiniteNumber(payload.maxBedTemp),
      },
      chamber: {
        current: toFiniteNumber(payload.boxTemp),
        target: toFiniteNumber(payload.targetBoxTemp),
        max: toFiniteNumber(payload.maxBoxTemp),
      },
    };
  }
  const nozzle = {};
  const bed = {};
  const chamber = {};
  setIfPresent(nozzle, "current", hasOwn(payload, "nozzleTemp"), toFiniteNumber(payload.nozzleTemp));
  setIfPresent(nozzle, "target", hasOwn(payload, "targetNozzleTemp"), toFiniteNumber(payload.targetNozzleTemp));
  setIfPresent(nozzle, "max", hasOwn(payload, "maxNozzleTemp"), toFiniteNumber(payload.maxNozzleTemp));
  if (hasOwn(payload, "bedTemp0") || hasOwn(payload, "bedTemp1") || hasOwn(payload, "bedTemp2")) {
    bed.current = firstFiniteNumber([
      { present: hasOwn(semanticPayload, "bedTemp0"), value: semanticPayload.bedTemp0 },
      { present: hasOwn(semanticPayload, "bedTemp1"), value: semanticPayload.bedTemp1 },
      { present: hasOwn(semanticPayload, "bedTemp2"), value: semanticPayload.bedTemp2 },
    ]);
  }
  if (hasOwn(payload, "targetBedTemp0") || hasOwn(payload, "targetBedTemp1") || hasOwn(payload, "targetBedTemp2")) {
    bed.target = firstFiniteNumber([
      { present: hasOwn(semanticPayload, "targetBedTemp0"), value: semanticPayload.targetBedTemp0 },
      { present: hasOwn(semanticPayload, "targetBedTemp1"), value: semanticPayload.targetBedTemp1 },
      { present: hasOwn(semanticPayload, "targetBedTemp2"), value: semanticPayload.targetBedTemp2 },
    ]);
  }
  setIfPresent(bed, "max", hasOwn(payload, "maxBedTemp"), toFiniteNumber(payload.maxBedTemp));
  setIfPresent(chamber, "current", hasOwn(payload, "boxTemp"), toFiniteNumber(payload.boxTemp));
  setIfPresent(chamber, "target", hasOwn(payload, "targetBoxTemp"), toFiniteNumber(payload.targetBoxTemp));
  setIfPresent(chamber, "max", hasOwn(payload, "maxBoxTemp"), toFiniteNumber(payload.maxBoxTemp));
  return {
    ...(omitEmpty(nozzle) ? { nozzle } : {}),
    ...(omitEmpty(bed) ? { bed } : {}),
    ...(omitEmpty(chamber) ? { chamber } : {}),
  };
}

/**
 * ファン系 payload を NormalizedPrinterState のファン object へ変換する。
 *
 * 【詳細説明】
 * - `fan` / `fanAuxiliary` / `fanCase` は有効状態、`modelFanPct` / `auxiliaryFanPct` / `caseFanPct` は
 *   回転率として別の意味に正規化する。
 * - `caseFanPct` は筐体ファンであり、K2 系の chamber temperature / chamber heater と衝突しないよう
 *   `fans.case` として保持する。
 *
 * @private
 * @param {object} payload - K1 系 WS9999 status payload
 * @param {object=} options - 正規化オプション
 * @param {boolean=} options.patch - 差分 patch として未観測 key を省略する場合 true
 * @returns {object} 正規化済み fan object
 */
function normalizeFans(payload, options = {}) {
  const partCooling = {};
  const auxiliary = {};
  const caseFan = {};
  const partCoolingLegacyPct = options.patch ? null : firstPercentNumber([payload.modelFanPct]);
  const auxiliaryLegacyPct = options.patch ? null : firstPercentNumber([payload.auxiliaryFanPct]);
  const caseLegacyPct = options.patch ? null : firstPercentNumber([payload.caseFanPct]);
  setIfPresent(partCooling, "enabled", !options.patch || hasOwn(payload, "fan"), toBooleanFlag(payload.fan));
  setIfPresent(partCooling, "percent", !options.patch || hasOwn(payload, "modelFanPct"), partCoolingLegacyPct ?? toPercentNumber(payload.modelFanPct));
  setIfPresent(auxiliary, "enabled", !options.patch || hasOwn(payload, "fanAuxiliary"), toBooleanFlag(payload.fanAuxiliary));
  setIfPresent(auxiliary, "percent", !options.patch || hasOwn(payload, "auxiliaryFanPct"), auxiliaryLegacyPct ?? toPercentNumber(payload.auxiliaryFanPct));
  setIfPresent(caseFan, "enabled", !options.patch || hasOwn(payload, "fanCase"), toBooleanFlag(payload.fanCase));
  setIfPresent(caseFan, "percent", !options.patch || hasOwn(payload, "caseFanPct"), caseLegacyPct ?? toPercentNumber(payload.caseFanPct));
  return {
    ...(omitEmpty(partCooling) ? { partCooling } : {}),
    ...(omitEmpty(auxiliary) ? { auxiliary } : {}),
    ...(omitEmpty(caseFan) ? { case: caseFan } : {}),
  };
}

/**
 * K1 系状態コードを Printer Core v3 ラベルへ変換する。
 *
 * 【詳細説明】
 * - 未知の状態コードは `unknown` として保持し、元コードは `stateCode` に残す。
 *
 * @private
 * @param {*} stateCode - K1 系 `state` 値
 * @returns {{stateCode: ?number, stateLabel: string}} 状態コードとラベル
 */
function normalizePrintState(stateCode) {
  const code = toFiniteNumber(stateCode);
  return {
    stateCode: code,
    stateLabel: code === null ? "unknown" : (K1_PRINT_STATE_LABELS[code] || "unknown"),
  };
}

/**
 * 印刷ジョブ系 payload を NormalizedPrinterState の print object へ変換する。
 *
 * 【詳細説明】
 * - legacy processData と同じく `printFileName` を優先し、`fileName` を fallback にする。
 * - `printStartTime` は ID として使われるため数値化して `startedAtSec` に保持する。
 *
 * @private
 * @param {object} payload - K1 系 WS9999 status payload
 * @returns {object} 正規化済み print object
 */
function normalizePrint(payload) {
  const state = normalizePrintState(payload.state);
  return {
    ...state,
    deviceStateCode: toFiniteNumber(payload.deviceState),
    progressPct: firstPercentNumber([payload.printProgress, payload.dProgress]),
    layer: toFiniteNumber(payload.layer),
    totalLayer: toFiniteNumber(payload.TotalLayer),
    remainingSec: toFiniteNumber(payload.printLeftTime),
    elapsedSec: toFiniteNumber(payload.printJobTime),
    fileName: toNullableString(payload.printFileName ?? payload.fileName),
    jobId: toNullableString(payload.printId),
    startedAtSec: toFiniteNumber(payload.printStartTime),
  };
}

/**
 * 印刷ジョブ系 payload を差分 patch へ変換する。
 *
 * 【詳細説明】
 * - 受信 key だけを patch に入れ、差分 frame で filename や state を消さない。
 *
 * @private
 * @param {object} payload - K1 系 WS9999 status payload
 * @param {object=} protocolState - delta frame を累積した protocol state
 * @returns {object|undefined} print patch、または undefined
 */
function createPrintPatch(payload, protocolState = payload) {
  const patch = {};
  if (hasOwn(payload, "state")) {
    Object.assign(patch, normalizePrintState(payload.state));
  }
  setIfPresent(patch, "deviceStateCode", hasOwn(payload, "deviceState"), toFiniteNumber(payload.deviceState));
  if (hasOwn(payload, "printProgress") || hasOwn(payload, "dProgress")) {
    patch.progressPct = firstPercentNumber([
      { present: hasOwn(protocolState, "printProgress"), value: protocolState.printProgress },
      { present: hasOwn(protocolState, "dProgress"), value: protocolState.dProgress },
    ]);
  }
  setIfPresent(patch, "layer", hasOwn(payload, "layer"), toFiniteNumber(payload.layer));
  setIfPresent(patch, "totalLayer", hasOwn(payload, "TotalLayer"), toFiniteNumber(payload.TotalLayer));
  setIfPresent(patch, "remainingSec", hasOwn(payload, "printLeftTime"), toFiniteNumber(payload.printLeftTime));
  setIfPresent(patch, "elapsedSec", hasOwn(payload, "printJobTime"), toFiniteNumber(payload.printJobTime));
  if (hasOwn(payload, "printFileName") || hasOwn(payload, "fileName")) {
    patch.fileName = toNullableString(protocolState.printFileName ?? protocolState.fileName);
  }
  setIfPresent(patch, "jobId", hasOwn(payload, "printId"), toNullableString(payload.printId));
  setIfPresent(patch, "startedAtSec", hasOwn(payload, "printStartTime"), toFiniteNumber(payload.printStartTime));
  return omitEmpty(patch);
}

/**
 * エラー payload を NormalizedPrinterState の error object へ変換する。
 *
 * 【詳細説明】
 * - legacy processData は `err.errcode` と `err.key` を通知重複判定に使うため、同じ値を保持する。
 * - エラーなしは `active:false` として表す。
 *
 * @private
 * @param {object} payload - K1 系 WS9999 status payload
 * @returns {object} 正規化済み error object
 */
function normalizeError(payload) {
  const raw = payload.err && typeof payload.err === "object" ? payload.err : null;
  const code = toFiniteNumber(raw?.errcode);
  const key = toFiniteNumber(raw?.key);
  return {
    active: !!raw && !(code === 0 && key === 0),
    code,
    key,
    value: raw && Object.prototype.hasOwnProperty.call(raw, "value") ? toNullableString(raw.value) : null,
    raw,
  };
}

/**
 * AI 関連 payload を NormalizedPrinterState の ai object へ変換する。
 *
 * 【詳細説明】
 * - K1/K2 系 firmware は AI 機能を複数 flag で返すため、各 flag をそのまま number で保持する。
 *
 * @private
 * @param {object} payload - K1 系 WS9999 status payload
 * @param {object=} options - 正規化オプション
 * @param {boolean=} options.patch - 差分 patch として未観測 key を省略する場合 true
 * @returns {object} 正規化済み AI object
 */
function normalizeAi(payload, options = {}) {
  const ai = {};
  setIfPresent(ai, "detection", !options.patch || hasOwn(payload, "aiDetection"), toFiniteNumber(payload.aiDetection));
  setIfPresent(ai, "switchEnabled", !options.patch || hasOwn(payload, "aiSw"), toFiniteNumber(payload.aiSw));
  setIfPresent(ai, "pauseOnDetection", !options.patch || hasOwn(payload, "aiPausePrint"), toFiniteNumber(payload.aiPausePrint));
  setIfPresent(ai, "firstLayer", !options.patch || hasOwn(payload, "aiFirstFloor"), toFiniteNumber(payload.aiFirstFloor));
  return ai;
}

/**
 * CFS source ID を生成する。
 *
 * 【詳細説明】
 * - sourceId は fixture / runtime 比較用の一時 ID であり、Data Schema v3 の永続 MaterialSource ID ではない。
 * - 外部スプールと CFS slot を分け、CFS attach/detach と identity を混同しない。
 *
 * @private
 * @param {object} box - `materialBoxs[]` の box object
 * @param {object} material - `materials[]` の material object
 * @returns {string} sourceId
 */
function createMaterialSourceId(box, material) {
  const boxId = String(box?.id ?? "unknown");
  const slotId = String(material?.id ?? "unknown");
  if (Number(box?.id) === 0 || Number(box?.type) === 1) {
    return `external:${boxId}:slot:${slotId}`;
  }
  return `cfs:${boxId}:slot:${slotId}`;
}

/**
 * protocol color 値を raw と比較用 normalized へ分ける。
 *
 * 【詳細説明】
 * - K2 firmware は `#0ffffff` と `0ffffff` のように表記揺れした色を返すため、raw 表現を残しつつ
 *   比較用の正規形を別 field にする。
 *
 * @private
 * @param {*} value - protocol color 値
 * @returns {{raw: ?string, normalized: ?string}} 色表現
 */
function normalizeProtocolColor(value) {
  const raw = toNullableString(value);
  if (raw === null || raw === "") {
    return {
      raw,
      normalized: raw,
    };
  }
  return {
    raw,
    normalized: raw.replace(/^#/u, "").toLowerCase(),
  };
}

/**
 * K2 `materialBoxs[]` の1件を CFS unit へ正規化する。
 *
 * 【詳細説明】
 * - serialNumber は fixture で redaction 済みの値をそのまま保持し、identity authority には使わない。
 * - 外部スプール box は CFS unit ではないため null を返す。
 *
 * @private
 * @param {object} box - `materialBoxs[]` の box object
 * @returns {object|null} CFS unit、または null
 */
function normalizeCfsUnit(box) {
  if (!box || typeof box !== "object" || Number(box.id) === 0 || Number(box.type) === 1) {
    return null;
  }
  const boxId = Number(box.id);
  return {
    unitId: `cfs:${boxId}`,
    boxId,
    stateCode: toFiniteNumber(box.state),
    temperature: toFiniteNumber(box.temp),
    humidity: toFiniteNumber(box.humidity),
    serialNumber: toNullableString(box.sn),
    observedSlotCount: Array.isArray(box.materials) ? box.materials.length : 0,
  };
}

/**
 * K2 CFS material を MaterialSource へ正規化する。
 *
 * 【詳細説明】
 * - CFS slot と外部スプールを区別しつつ、UI/Schema v3 が共通に扱える material source として並べる。
 * - RFID は fixture 側で redaction 済みの値だけを保持し、永続 spool ID には使わない。
 *
 * @private
 * @param {object} box - `materialBoxs[]` の box object
 * @param {object} material - `materials[]` の material object
 * @returns {object} 正規化済み material source
 */
function normalizeMaterialSource(box, material) {
  const boxId = toFiniteNumber(box?.id);
  const slotId = toFiniteNumber(material?.id);
  const isExternal = Number(box?.id) === 0 || Number(box?.type) === 1;
  return {
    sourceId: createMaterialSourceId(box, material),
    kind: isExternal ? "external-spool" : "cfs-slot",
    unitId: isExternal ? null : `cfs:${boxId}`,
    boxId,
    slotId,
    boxStateCode: toFiniteNumber(box?.state),
    boxTypeCode: toFiniteNumber(box?.type),
    material: {
      vendor: toNullableString(material?.vendor),
      type: toNullableString(material?.type),
      name: toNullableString(material?.name),
      color: normalizeProtocolColor(material?.color),
      rfid: toNullableString(material?.rfid),
      minTemp: toFiniteNumber(material?.minTemp),
      maxTemp: toFiniteNumber(material?.maxTemp),
      pressure: toFiniteNumber(material?.pressure),
    },
    status: {
      selected: toBooleanFlag(material?.selected),
      percent: toPercentNumber(material?.percent),
      stateCode: toFiniteNumber(material?.state),
      editStatusCode: toFiniteNumber(material?.editStatus),
      scrap: toFiniteNumber(material?.scrap),
    },
  };
}

/**
 * material source の参照 index を生成する。
 *
 * 【詳細説明】
 * - `colorMatch` や `same_material` から sourceId を推測で再構築せず、実際に正規化した sources を参照する。
 *
 * @private
 * @param {Array<object>} sources - 正規化済み material source 一覧
 * @returns {Map<string, string>} `boxId:slotId` から sourceId への index
 */
function createMaterialSourceIndex(sources) {
  return new Map((Array.isArray(sources) ? sources : []).map((source) => {
    return [`${source.boxId}:${source.slotId}`, source.sourceId];
  }));
}

/**
 * source index から material source 参照を解決する。
 *
 * 【詳細説明】
 * - 未解決参照は null と `resolution:"unresolved"` で返し、壊れた payload の証拠を失わない。
 *
 * @private
 * @param {Map<string, string>} sourceIndex - material source index
 * @param {*} boxIdValue - box ID 候補
 * @param {*} materialIdValue - material/slot ID 候補
 * @returns {{sourceId: ?string, resolution: string, boxId: ?number, slotId: ?number}} 解決結果
 */
function resolveMaterialSourceRef(sourceIndex, boxIdValue, materialIdValue) {
  const boxId = toFiniteNumber(boxIdValue);
  const slotId = toFiniteNumber(materialIdValue);
  const key = `${boxId}:${slotId}`;
  const sourceId = sourceIndex.get(key) || null;
  return {
    sourceId,
    resolution: sourceId ? "resolved" : "unresolved",
    boxId,
    slotId,
  };
}

/**
 * K2 `colorMatch[]` を tool assignment へ正規化する。
 *
 * 【詳細説明】
 * - `T1A` などの tool ID は firmware の観測値として保持し、sourceId で material source と結び付ける。
 *
 * @private
 * @param {Array<object>} colorMatch - K2 `boxsInfo.colorMatch`
 * @param {Map<string, string>} sourceIndex - material source index
 * @returns {Array<object>} 正規化済み tool assignment
 */
function normalizeColorMatches(colorMatch, sourceIndex) {
  return (Array.isArray(colorMatch) ? colorMatch : []).map((entry) => {
    const ref = resolveMaterialSourceRef(sourceIndex, entry?.boxId, entry?.materialId);
    return {
      assignmentId: toNullableString(entry?.id),
      namespace: "creality-color-match",
      sourceId: ref.sourceId,
      resolution: ref.resolution,
      boxId: ref.boxId,
      slotId: ref.slotId,
    };
  });
}

/**
 * K2 `same_material[]` を同材質グループへ正規化する。
 *
 * 【詳細説明】
 * - auto-refill 判断の材料になるが、Gate 4 では観測結果として保持するだけで制御には使わない。
 *
 * @private
 * @param {Array<Array<*>>} groups - K2 `boxsInfo.same_material`
 * @param {Map<string, string>} sourceIndex - material source index
 * @returns {Array<object>} 正規化済み same-material group
 */
function normalizeSameMaterialGroups(groups, sourceIndex) {
  return (Array.isArray(groups) ? groups : []).map((entry) => {
    const locations = Array.isArray(entry?.[2]) ? entry[2] : [];
    const sourceRefs = locations.map((location) => {
      return resolveMaterialSourceRef(sourceIndex, location?.boxId, location?.materialId);
    });
    const sourceIds = sourceRefs.map((ref) => ref.sourceId).filter(Boolean).sort();
    const materialCode = toNullableString(entry?.[0]);
    const color = normalizeProtocolColor(entry?.[1]);
    const materialType = toNullableString(entry?.[3]);
    const groupKey = [
      materialType || "unknown",
      materialCode || "unknown",
      color.normalized || "unknown",
      sourceIds.join("_") || "unresolved",
    ].join(":");
    return {
      groupId: `same-material:${groupKey}`,
      materialCode,
      color,
      materialType,
      sourceIds,
      sourceRefs,
    };
  });
}

/**
 * K2 `boxsInfo` payload を material topology へ正規化する。
 *
 * 【詳細説明】
 * - `materialBoxs` の CFS unit と slot、外部スプール、tool assignment を read-only snapshot として保持する。
 * - CFS が未接続または payload が壊れている場合でも同じ shape を返す。
 *
 * @function normalizeK2BoxsInfo
 * @param {object|null|undefined} boxsInfo - K2 `boxsInfo` payload
 * @param {object=} options - 正規化オプション
 * @param {?boolean=} options.connected - status frame で観測した CFS 接続有無
 * @returns {object} 正規化済み material topology
 * @example
 * const topology = normalizeK2BoxsInfo(payload.boxsInfo);
 */
export function normalizeK2BoxsInfo(boxsInfo, options = {}) {
  if (!boxsInfo || typeof boxsInfo !== "object") {
    return createEmptyMaterialTopology();
  }
  const boxes = Array.isArray(boxsInfo.materialBoxs) ? boxsInfo.materialBoxs : [];
  const units = boxes.map((box) => normalizeCfsUnit(box)).filter(Boolean);
  const sources = boxes.flatMap((box) => {
    const materials = Array.isArray(box?.materials) ? box.materials : [];
    return materials.map((material) => normalizeMaterialSource(box, material));
  });
  const sourceIndex = createMaterialSourceIndex(sources);
  return {
    schemaVersion: 1,
    cfs: {
      connected: options.connected ?? (units.length > 0 ? true : null),
      enabled: boxsInfo.enable === null || boxsInfo.enable === undefined ? null : Number(boxsInfo.enable) === 1,
      unitCount: units.length,
      topologyState: "fresh",
    },
    units,
    sources,
    assignments: normalizeColorMatches(boxsInfo.colorMatch, sourceIndex),
    sameMaterialGroups: normalizeSameMaterialGroups(boxsInfo.same_material, sourceIndex),
  };
}

/**
 * カメラ関連 payload を NormalizedPrinterState の camera object へ変換する。
 *
 * 【詳細説明】
 * - `video` / `video1` / `webrtcSupport` を boolean capability として扱う。
 *
 * @private
 * @param {object} payload - K1 系 WS9999 status payload
 * @param {object=} options - 正規化オプション
 * @param {boolean=} options.patch - 差分 patch として未観測 key を省略する場合 true
 * @param {object=} options.protocolState - delta frame を累積した protocol state
 * @returns {object} 正規化済み camera object
 */
function normalizeCamera(payload, options = {}) {
  const semanticPayload = options.protocolState && typeof options.protocolState === "object"
    ? options.protocolState
    : payload;
  const camera = {};
  if (!options.patch || hasOwn(payload, "video") || hasOwn(payload, "video1")) {
    camera.mjpeg = Number(semanticPayload.video) === 1 || Number(semanticPayload.video1) === 1;
  }
  setIfPresent(camera, "webrtc", !options.patch || hasOwn(payload, "webrtcSupport"), Number(payload.webrtcSupport) === 1);
  setIfPresent(camera, "timelapseEnabled", !options.patch || hasOwn(payload, "videoElapse"), Number(payload.videoElapse) === 1);
  return camera;
}

/**
 * 空の NormalizedPrinterState を生成する。
 *
 * 【詳細説明】
 * - Adapter がまだ frame を観測していない Instance でも同じ形状を返す。
 * - 呼び出し側が deviceId や sessionId を注入できるよう options を受け取る。
 *
 * @function createEmptyNormalizedPrinterState
 * @param {object=} options - 生成オプション
 * @param {?string=} options.deviceId - 物理機 identity
 * @param {?string=} options.sessionId - 接続セッション ID
 * @param {?string=} options.adapterId - Adapter ID
 * @returns {object} 空の NormalizedPrinterState
 * @example
 * const state = createEmptyNormalizedPrinterState({ deviceId: "serial:demo" });
 */
export function createEmptyNormalizedPrinterState(options = {}) {
  return {
    schemaVersion: NORMALIZED_PRINTER_STATE_SCHEMA_VERSION,
    source: {
      adapterId: options.adapterId ?? null,
      protocol: options.protocol ?? null,
      sequence: options.sequence ?? 0,
      receivedAt: options.receivedAt ?? null,
      rawKeys: [],
    },
    identity: {
      deviceId: options.deviceId ?? null,
      sessionId: options.sessionId ?? null,
      reportedModel: null,
      reportedHostname: null,
    },
    capabilities: options.capabilities ?? EMPTY_CAPABILITY_SET,
    temperatures: normalizeTemperatures({}),
    fans: normalizeFans({}),
    light: {
      enabled: null,
    },
    print: normalizePrint({}),
    motion: {
      position: null,
      rawPosition: null,
    },
    error: normalizeError({}),
    camera: {
      mjpeg: null,
      webrtc: null,
      timelapseEnabled: null,
    },
    ai: normalizeAi({}),
    materials: createEmptyMaterialTopology(),
  };
}

/**
 * object を JSON 安全な deep clone にする。
 *
 * 【詳細説明】
 * - NormalizedState は plain data のみなので、structuredClone が無い環境では JSON clone に fallback する。
 *
 * @function cloneNormalizedValue
 * @param {*} value - clone 対象
 * @returns {*} clone 済み値
 * @example
 * const immutableCopy = cloneNormalizedValue(state);
 */
export function cloneNormalizedValue(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * object を深く merge する。
 *
 * 【詳細説明】
 * - patch に存在する key だけを既存値へ反映する。
 * - null は明示的な更新値として扱い、欠落 key と区別する。
 *
 * @private
 * @param {*} base - merge 元
 * @param {*} patch - merge patch
 * @returns {*} merge 済み値
 */
function deepMergePatch(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return cloneNormalizedValue(patch);
  }
  const next = base && typeof base === "object" && !Array.isArray(base)
    ? cloneNormalizedValue(base)
    : {};
  for (const [key, value] of Object.entries(patch)) {
    next[key] = value && typeof value === "object" && !Array.isArray(value)
      ? deepMergePatch(next[key], value)
      : cloneNormalizedValue(value);
  }
  return next;
}

/**
 * Normalized Patch を既存 NormalizedPrinterState へ適用する。
 *
 * 【詳細説明】
 * - 実機の差分 WS frame に合わせ、patch に含まれる field だけを更新する。
 * - source は最新 frame の metadata として毎回更新し、state 本体は deep merge する。
 *
 * @function applyNormalizedStatePatch
 * @param {object} state - 適用前 NormalizedPrinterState
 * @param {object} normalizedPatch - Adapter が返した Normalized Patch
 * @returns {object} 適用後 NormalizedPrinterState
 * @example
 * const nextState = applyNormalizedStatePatch(currentState, patch);
 */
export function applyNormalizedStatePatch(state, normalizedPatch) {
  const next = deepMergePatch(state, normalizedPatch?.patch || {});
  return {
    ...next,
    schemaVersion: NORMALIZED_PRINTER_STATE_SCHEMA_VERSION,
    source: {
      ...state.source,
      ...(normalizedPatch?.source || {}),
    },
  };
}

/**
 * K1 系 WS9999 status payload を Normalized Patch へ変換する。
 *
 * 【詳細説明】
 * - payload に含まれる key だけを patch に入れ、欠落 key で既存 state を消さない。
 * - `{key:null}` は明示的な null 更新として扱う。
 *
 * @function createK1StatusPatch
 * @param {object|null|undefined} payload - K1 系 WS9999 status payload
 * @param {object=} options - 正規化オプション
 * @param {?string=} options.deviceId - 物理機 identity
 * @param {?string=} options.sessionId - 接続セッション ID
 * @param {?string=} options.adapterId - Adapter ID
 * @param {?string=} options.protocol - 受信 protocol 名
 * @param {?number=} options.sequence - Instance 内の受信順序
 * @param {?string=} options.receivedAt - 受信時刻 ISO 文字列
 * @param {object=} options.capabilities - Adapter が推定した capability set
 * @param {object=} options.protocolState - delta frame を累積した protocol state
 * @returns {object} Normalized Patch
 * @example
 * const patch = createK1StatusPatch(payload, { adapterId: "creality-k1" });
 */
export function createK1StatusPatch(payload, options = {}) {
  const rawPayload = payload && typeof payload === "object" ? payload : {};
  const protocolState = options.protocolState && typeof options.protocolState === "object"
    ? options.protocolState
    : rawPayload;
  const patch = {};
  const identity = {};
  const temperatures = normalizeTemperatures(rawPayload, { patch: true, protocolState });
  const fans = normalizeFans(rawPayload, { patch: true });
  const print = createPrintPatch(rawPayload, protocolState);
  const ai = normalizeAi(rawPayload, { patch: true });
  const camera = normalizeCamera(rawPayload, { patch: true, protocolState });

  setIfPresent(identity, "deviceId", true, options.deviceId ?? null);
  setIfPresent(identity, "sessionId", true, options.sessionId ?? null);
  setIfPresent(identity, "reportedModel", hasOwn(rawPayload, "model"), toNullableString(rawPayload.model));
  if (hasOwn(rawPayload, "hostname") || hasOwn(rawPayload, "deviceName")) {
    identity.reportedHostname = toNullableString(protocolState.hostname ?? protocolState.deviceName);
  }
  setIfPresent(patch, "identity", true, identity);
  setIfPresent(patch, "temperatures", Object.keys(temperatures).length > 0, temperatures);
  setIfPresent(patch, "fans", Object.keys(fans).length > 0, fans);
  setIfPresent(patch, "light", hasOwn(rawPayload, "lightSw"), { enabled: toBooleanFlag(rawPayload.lightSw) });
  setIfPresent(patch, "print", !!print, print);
  if (hasOwn(rawPayload, "curPosition")) {
    const position = parseK1Position(rawPayload.curPosition);
    patch.motion = {
      position: position ? { x: position.x, y: position.y, z: position.z } : null,
      rawPosition: position?.raw ?? null,
    };
  }
  setIfPresent(patch, "error", hasOwn(rawPayload, "err"), normalizeError(rawPayload));
  setIfPresent(patch, "camera", Object.keys(camera).length > 0, camera);
  setIfPresent(patch, "ai", Object.keys(ai).length > 0, ai);

  return {
    kind: "state-patch",
    schemaVersion: NORMALIZED_PRINTER_PATCH_SCHEMA_VERSION,
    source: {
      adapterId: options.adapterId ?? "creality-k1",
      protocol: options.protocol ?? "ws9999",
      sequence: options.sequence ?? 0,
      receivedAt: options.receivedAt ?? null,
      rawKeys: listRawKeys(rawPayload),
    },
    capabilities: options.capabilities ?? EMPTY_CAPABILITY_SET,
    patch,
  };
}

/**
 * K2 系 WS9999 status payload を Normalized Patch へ変換する。
 *
 * 【詳細説明】
 * - K2 Pro Combo の status key は K1 系と近いため、温度・ファン・印刷状態などは既存変換を再利用する。
 * - `cfsConnect` は material topology の接続状態として patch に追加する。
 * - `boxsInfo` 専用 frame は {@link createK2BoxsInfoPatch} で扱う。
 *
 * @function createK2StatusPatch
 * @param {object|null|undefined} payload - K2 系 WS9999 status payload
 * @param {object=} options - 正規化オプション
 * @param {?string=} options.deviceId - 物理機 identity
 * @param {?string=} options.sessionId - 接続セッション ID
 * @param {?string=} options.adapterId - Adapter ID
 * @param {?string=} options.protocol - 受信 protocol 名
 * @param {?number=} options.sequence - Instance 内の受信順序
 * @param {?string=} options.receivedAt - 受信時刻 ISO 文字列
 * @param {object=} options.capabilities - Adapter が推定した capability set
 * @param {object=} options.protocolState - delta frame を累積した protocol state
 * @returns {object} Normalized Patch
 * @example
 * const patch = createK2StatusPatch(payload, { adapterId: "creality-k2" });
 */
export function createK2StatusPatch(payload, options = {}) {
  const rawPayload = payload && typeof payload === "object" ? payload : {};
  const patch = createK1StatusPatch(rawPayload, {
    ...options,
    adapterId: options.adapterId ?? "creality-k2",
    protocol: options.protocol ?? "ws9999",
  });
  if (hasOwn(rawPayload, "cfsConnect")) {
    const connected = Number(rawPayload.cfsConnect) === 1;
    patch.patch = {
      ...patch.patch,
      materials: {
        cfs: {
          connected,
          ...(connected ? {} : { topologyState: "stale" }),
        },
      },
    };
  }
  return patch;
}

/**
 * K2 `boxsInfo` payload を Normalized Patch へ変換する。
 *
 * 【詳細説明】
 * - topology frame は material state だけを更新し、温度や印刷状態を消さない。
 * - source metadata には rawKeys と sequence を残し、fixture replay で観測順を確認できるようにする。
 *
 * @function createK2BoxsInfoPatch
 * @param {object|null|undefined} boxsInfo - K2 `boxsInfo` payload
 * @param {object=} options - 正規化オプション
 * @param {?string=} options.adapterId - Adapter ID
 * @param {?string=} options.protocol - 受信 protocol 名
 * @param {?number=} options.sequence - Instance 内の受信順序
 * @param {?string=} options.receivedAt - 受信時刻 ISO 文字列
 * @param {object=} options.capabilities - Adapter が推定した capability set
 * @param {object=} options.protocolState - delta frame を累積した protocol state
 * @returns {object} Normalized Patch
 * @example
 * const patch = createK2BoxsInfoPatch(payload.boxsInfo, { sequence: 2 });
 */
export function createK2BoxsInfoPatch(boxsInfo, options = {}) {
  return {
    kind: "state-patch",
    schemaVersion: NORMALIZED_PRINTER_PATCH_SCHEMA_VERSION,
    source: {
      adapterId: options.adapterId ?? "creality-k2",
      protocol: options.protocol ?? "ws9999",
      sequence: options.sequence ?? 0,
      receivedAt: options.receivedAt ?? null,
      rawKeys: ["boxsInfo"],
    },
    capabilities: options.capabilities ?? EMPTY_CAPABILITY_SET,
    patch: {
      identity: {
        deviceId: options.deviceId ?? null,
        sessionId: options.sessionId ?? null,
      },
      materials: normalizeK2BoxsInfo(boxsInfo, {
        connected: options.protocolState && Object.prototype.hasOwnProperty.call(options.protocolState, "cfsConnect")
          ? Number(options.protocolState.cfsConnect) === 1
          : undefined,
      }),
    },
  };
}

/**
 * K1 系 WS9999 status payload を NormalizedPrinterState へ変換する。
 *
 * 【詳細説明】
 * - Gate 2 では legacy processData と並走する dry-run 状態を生成するだけで、UI へは送らない。
 * - raw field の意味を壊さず比較できるよう、未観測値は null として明示する。
 *
 * @function normalizeK1StatusPayload
 * @param {object|null|undefined} payload - K1 系 WS9999 status payload
 * @param {object=} options - 正規化オプション
 * @param {?string=} options.deviceId - 物理機 identity
 * @param {?string=} options.sessionId - 接続セッション ID
 * @param {?string=} options.adapterId - Adapter ID
 * @param {?string=} options.protocol - 受信 protocol 名
 * @param {?number=} options.sequence - Instance 内の受信順序
 * @param {?string=} options.receivedAt - 受信時刻 ISO 文字列
 * @param {object=} options.capabilities - Adapter が推定した capability set
 * @returns {object} 正規化済み NormalizedPrinterState
 * @example
 * const state = normalizeK1StatusPayload(payload, { adapterId: "creality-k1" });
 */
export function normalizeK1StatusPayload(payload, options = {}) {
  if (!payload || typeof payload !== "object") {
    return createEmptyNormalizedPrinterState(options);
  }

  const position = parseK1Position(payload.curPosition);
  return {
    schemaVersion: NORMALIZED_PRINTER_STATE_SCHEMA_VERSION,
    source: {
      adapterId: options.adapterId ?? "creality-k1",
      protocol: options.protocol ?? "ws9999",
      sequence: options.sequence ?? 0,
      receivedAt: options.receivedAt ?? null,
      rawKeys: listRawKeys(payload),
    },
    identity: {
      deviceId: options.deviceId ?? null,
      sessionId: options.sessionId ?? null,
      reportedModel: toNullableString(payload.model),
      reportedHostname: toNullableString(payload.hostname ?? payload.deviceName),
    },
    capabilities: options.capabilities ?? EMPTY_CAPABILITY_SET,
    temperatures: normalizeTemperatures(payload),
    fans: normalizeFans(payload),
    light: {
      enabled: payload.lightSw === null || payload.lightSw === undefined ? null : Number(payload.lightSw) === 1,
    },
    print: normalizePrint(payload),
    motion: {
      position: position ? { x: position.x, y: position.y, z: position.z } : null,
      rawPosition: position?.raw ?? null,
    },
    error: normalizeError(payload),
    camera: normalizeCamera(payload),
    ai: normalizeAi(payload),
  };
}
