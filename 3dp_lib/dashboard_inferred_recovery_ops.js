/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 O6 Recovery Operations モジュール
 * @file dashboard_inferred_recovery_ops.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_inferred_recovery_ops
 *
 * 【機能内容サマリ】
 * - O6A として、O5 decision recovery / mount ledger repair / rejected mount event の復旧操作を提供する。
 * - STAND ALONE と PARENT だけが復旧操作を実行し、SATELLITE は親権威の診断を閲覧するだけにする。
 * - 各操作は O5 decision と同じ直列化キューを使い、保存境界や rollback 境界の競合を避ける。
 * - 復旧操作は `inferredRecoveryEvents` へ監査 event を追記し、耐久保存失敗時はメモリ状態を rollback する。
 *
 * 【公開関数一覧】
 * - {@link canExecuteRecoveryOperation}：この端末で O6 recovery 操作を実行できるか判定する
 * - {@link retryInferredRecoveryDurableSave}：現在の recovery / repair 状態を再度耐久保存する
 * - {@link clearInferredDecisionRecoveryRequired}：確認済みの O5 decision recovery flag を解除する
 * - {@link repairLedgerMountIntervals}：曖昧な mount interval の survivor を明示選択して修復する
 * - {@link clearLedgerRepairRequired}：確認済みの host 単位 ledger repair flag を解除する
 * - {@link archiveMountHistoryRejectedEvents}：隔離済み mount event を監査 event に移して warning を閉じる
 *
 * @version 1.390.1273 (PR #423)
 * @since   1.390.1270 (PR #420)
 * @lastModified 2026-08-02 18:20:00
 * -----------------------------------------------------------
 * @todo
 * - O7 Ledger Reconciliation で、手動解除前の再計算監査と修復案提示を追加する。
 */

"use strict";

import { monitorData } from "./dashboard_data.js";
import {
  canExecuteLedgerDecision,
  enqueueLedgerDecisionTask
} from "./dashboard_inferred_candidate_decision.js";
import { appendSupersedeEvent, getMountIntervalStatus } from "./dashboard_filament_ledger.js";
import { saveUnifiedStorageDurably } from "./dashboard_storage.js";
import { wallNowMs } from "./dashboard_time.js";

/**
 * O6 recovery audit event の保持上限。
 *
 * @constant {number}
 */
const RECOVERY_EVENT_CAP = 1000;

/**
 * O5 decision recovery flag の monitorData field 名。
 *
 * @constant {string}
 */
const DECISION_RECOVERY_FIELD = "inferredDecisionRecoveryRequired";

/**
 * O6 recovery audit event の type 一覧。
 *
 * @enum {string}
 */
export const INFERRED_RECOVERY_EVENT_TYPE = Object.freeze({
  DURABLE_SAVE_RETRIED: "recovery-durable-save-retried",
  DECISION_RECOVERY_CLEARED: "decision-recovery-cleared",
  LEDGER_INTERVALS_REPAIRED: "ledger-intervals-repaired",
  LEDGER_REPAIR_CLEARED: "ledger-repair-cleared",
  REJECTED_MOUNT_EVENTS_ARCHIVED: "mount-history-rejected-events-archived"
});

/**
 * recovery audit event ID 生成用の単調カウンタ。
 *
 * @private
 * @type {number}
 */
let _eventSeq = 0;

/**
 * JSON 互換値を deep clone する。
 *
 * @private
 * @function _clone
 * @param {*} value - clone 対象。
 * @returns {*} clone 済みの値。
 */
function _clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/**
 * epoch ms の現在時刻を返す。
 *
 * @private
 * @function _nowMs
 * @param {{nowMs?:number}} [options] - clock 注入オプション。
 * @returns {number} epoch ms。
 */
function _nowMs(options = {}) {
  const injected = Number(options.nowMs);
  if (Number.isFinite(injected) && injected > 0) return injected;
  return wallNowMs();
}

/**
 * recovery audit event ID を生成する。
 *
 * 【詳細説明】
 * - crypto.randomUUID が使える環境では UUID を使う。
 * - テスト環境や古いブラウザでは時刻とページ内カウンタで一意化し、監査 event の重複を避ける。
 *
 * @private
 * @function _eventId
 * @param {number} nowMs - event 作成時刻。
 * @returns {string} recovery event ID。
 */
function _eventId(nowMs) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `ir-${crypto.randomUUID()}`;
  }
  _eventSeq += 1;
  return `ir-${Math.floor(nowMs)}-${_eventSeq}`;
}

/**
 * recovery audit event 配列を取得する。
 *
 * @private
 * @function _events
 * @returns {Array<Object>} recovery audit event 配列。
 */
function _events() {
  if (!Array.isArray(monitorData.inferredRecoveryEvents)) {
    monitorData.inferredRecoveryEvents = [];
  }
  return monitorData.inferredRecoveryEvents;
}

/**
 * host 単位の ledger repair map を取得する。
 *
 * @private
 * @function _ledgerRepairRequired
 * @returns {Object.<string,Object>} ledger repair map。
 */
function _ledgerRepairRequired() {
  if (!monitorData.ledgerRepairRequired || typeof monitorData.ledgerRepairRequired !== "object") {
    monitorData.ledgerRepairRequired = {};
  }
  return monitorData.ledgerRepairRequired;
}

/**
 * 隔離済み mountHistory event 配列を取得する。
 *
 * @private
 * @function _rejectedMountEvents
 * @returns {Array<Object>} 隔離済み event 配列。
 */
function _rejectedMountEvents() {
  if (!Array.isArray(monitorData.mountHistoryRejectedEvents)) {
    monitorData.mountHistoryRejectedEvents = [];
  }
  return monitorData.mountHistoryRejectedEvents;
}

/**
 * 復旧対象が存在するかを判定する。
 *
 * @private
 * @function _hasRecoveryIssues
 * @returns {boolean} recovery / repair / rejected event のいずれかが存在すれば true。
 */
function _hasRecoveryIssues() {
  return !!monitorData[DECISION_RECOVERY_FIELD]
    || Object.keys(_ledgerRepairRequired()).length > 0
    || _rejectedMountEvents().length > 0;
}

/**
 * recovery 関連フィールドの rollback snapshot を取得する。
 *
 * @private
 * @function _snapshotRecoveryState
 * @param {{includeMountHistory?:boolean}} [options] - mountHistory も rollback 対象に含める場合 true。
 * @returns {Object} rollback 用 snapshot。
 */
function _snapshotRecoveryState(options = {}) {
  const snapshot = {
    inferredDecisionRecoveryRequired: _clone(monitorData[DECISION_RECOVERY_FIELD] || null),
    ledgerRepairRequired: _clone(_ledgerRepairRequired()),
    mountHistoryRejectedEvents: _clone(_rejectedMountEvents()),
    inferredRecoveryEvents: _clone(_events())
  };
  if (options.includeMountHistory) {
    snapshot.mountHistory = _clone(Array.isArray(monitorData.mountHistory) ? monitorData.mountHistory : []);
    snapshot.mountHistorySeq = Number(monitorData.mountHistorySeq) || 0;
  }
  return snapshot;
}

/**
 * recovery 関連フィールドを snapshot へ戻す。
 *
 * 【詳細説明】
 * - 配列と object は可能な限り参照を保ったまま中身だけ置換し、開いている UI の参照を壊さない。
 * - decision recovery flag は単一 object / null なので field を直接戻す。
 *
 * @private
 * @function _restoreRecoveryState
 * @param {Object} snapshot - {@link _snapshotRecoveryState} の戻り値。
 * @returns {void}
 */
function _restoreRecoveryState(snapshot) {
  monitorData[DECISION_RECOVERY_FIELD] = snapshot.inferredDecisionRecoveryRequired
    ? _clone(snapshot.inferredDecisionRecoveryRequired)
    : null;

  const repair = _ledgerRepairRequired();
  for (const key of Object.keys(repair)) delete repair[key];
  Object.assign(repair, _clone(snapshot.ledgerRepairRequired || {}));

  const rejected = _rejectedMountEvents();
  rejected.splice(0, rejected.length, ..._clone(snapshot.mountHistoryRejectedEvents || []));

  const events = _events();
  events.splice(0, events.length, ..._clone(snapshot.inferredRecoveryEvents || []));

  if (Object.hasOwn(snapshot, "mountHistory")) {
    if (!Array.isArray(monitorData.mountHistory)) monitorData.mountHistory = [];
    monitorData.mountHistory.splice(0, monitorData.mountHistory.length, ..._clone(snapshot.mountHistory || []));
    monitorData.mountHistorySeq = Number(snapshot.mountHistorySeq) || 0;
  }
}

/**
 * recovery audit event を追記する。
 *
 * @private
 * @function _appendRecoveryEvent
 * @param {string} type - event type。
 * @param {Object} data - event metadata。
 * @param {{actor?:string,nowMs?:number}} [options] - 操作者・clock オプション。
 * @returns {Object} 追記した audit event。
 */
function _appendRecoveryEvent(type, data = {}, options = {}) {
  const nowMs = _nowMs(options);
  const event = {
    eventId: _eventId(nowMs),
    type,
    actor: options.actor || "local-user",
    createdAt: nowMs,
    ..._clone(data)
  };
  const events = _events();
  events.push(event);
  if (events.length > RECOVERY_EVENT_CAP) {
    events.splice(0, events.length - RECOVERY_EVENT_CAP);
  }
  return event;
}

/**
 * 変更後状態を耐久保存し、失敗した場合は snapshot へ rollback する。
 *
 * 【詳細説明】
 * - 操作本体の変更と audit event は同じ保存境界で扱う。
 * - 保存失敗時はメモリ状態を操作前へ戻し、その rollback 状態の耐久保存も試みる。
 * - rollback 保存にも失敗した場合、呼び出し元は returned reason を blocker として扱える。
 *
 * @private
 * @function _saveOrRollbackRecoveryMutation
 * @param {Object} snapshot - 操作前 snapshot。
 * @param {string} failureReason - 保存失敗時に返す reason。
 * @param {{save?:boolean}} [options] - 保存オプション。
 * @returns {Promise<{ok:boolean,reason:string,save?:Object,rollbackSave?:Object}>} 保存結果。
 */
async function _saveOrRollbackRecoveryMutation(snapshot, failureReason, options = {}) {
  const save = options.save === false
    ? { ok: true, backend: "disabled", reason: "save_disabled" }
    : await saveUnifiedStorageDurably();
  if (!save || save.ok !== false) {
    return { ok: true, reason: "recovery_operation_saved", save };
  }

  _restoreRecoveryState(snapshot);
  const rollbackSave = options.save === false
    ? { ok: true, backend: "disabled", reason: "save_disabled" }
    : await saveUnifiedStorageDurably();
  return {
    ok: false,
    reason: rollbackSave && rollbackSave.ok === false
      ? "recovery_operation_rollback_save_failed"
      : failureReason,
    save,
    rollbackSave
  };
}

/**
 * recovery 操作の権限ガードを適用する。
 *
 * @private
 * @function _operationGuard
 * @returns {?{ok:boolean,reason:string}} 実行不可なら結果 object。実行可能なら null。
 */
function _operationGuard() {
  if (!canExecuteRecoveryOperation()) {
    return { ok: false, reason: "recovery_not_authorized" };
  }
  return null;
}

/**
 * ledger repair flag を解除してよい状態か検証する。
 *
 * 【詳細説明】
 * - `ledgerRepairRequired` は、mount interval が ambiguous/corrupt のまま暗黙クローズを止めた
 *   ことを示す blocker である。
 * - O6B では自動修復や survivor 選択までは行わないが、現在も ambiguous/corrupt なら解除を拒否する。
 * - 状態が `ok` または `none` へ戻っている場合だけ、オペレーター確認済みとして flag 解除へ進める。
 *
 * @private
 * @function _validateLedgerRepairClearance
 * @param {string} host - host key。
 * @param {Object} repairItem - ledgerRepairRequired の対象 item。
 * @returns {{ok:boolean,reason:string,status?:Object}} 検証結果。
 */
function _validateLedgerRepairClearance(host, repairItem) {
  const spoolId = repairItem?.spoolId != null ? String(repairItem.spoolId) : "";
  if (!spoolId) return { ok: false, reason: "ledger_repair_spool_required" };
  try {
    const status = getMountIntervalStatus(spoolId, host);
    if (status?.status === "ambiguous" || status?.status === "corrupt") {
      return {
        ok: false,
        reason: "ledger_repair_still_unresolved",
        status
      };
    }
    return { ok: true, reason: "ledger_repair_clearable", status };
  } catch (error) {
    return {
      ok: false,
      reason: "ledger_repair_validation_failed",
      status: { error: error?.message || String(error) }
    };
  }
}

/**
 * mount interval repair 操作用に現在の open 区間を取得する。
 *
 * 【詳細説明】
 * - O6 の repair 操作は曖昧な mount interval だけを対象にする。
 * - corrupt 状態は参照不整合を含むため、survivor 選択だけでは安全に直せない可能性がある。
 * - そのためここでは `ambiguous` 以外を fail-closed にし、O7 の再計算監査へ委ねる。
 *
 * @private
 * @function _validateLedgerIntervalRepair
 * @param {string} host - host key。
 * @param {Object} repairItem - ledgerRepairRequired の対象 item。
 * @param {string} survivingIntervalId - 残す intervalId。
 * @returns {{ok:boolean,reason:string,status?:Object,spoolId?:string,openIntervals?:Array<Object>,targetIntervalIds?:Array<string>}}
 *   修復入力の検証結果。
 */
function _validateLedgerIntervalRepair(host, repairItem, survivingIntervalId) {
  const spoolId = repairItem?.spoolId != null ? String(repairItem.spoolId) : "";
  if (!spoolId) return { ok: false, reason: "ledger_repair_spool_required" };
  const survivorId = String(survivingIntervalId || "");
  if (!survivorId) return { ok: false, reason: "ledger_repair_survivor_required", spoolId };
  let status;
  try {
    status = getMountIntervalStatus(spoolId, host);
  } catch (error) {
    return {
      ok: false,
      reason: "ledger_repair_validation_failed",
      spoolId,
      status: { error: error?.message || String(error) }
    };
  }
  if (status?.status !== "ambiguous") {
    return { ok: false, reason: "ledger_repair_not_ambiguous", spoolId, status };
  }
  const openIntervals = Array.isArray(status.intervals)
    ? status.intervals.filter(interval => interval && interval.untilJobId == null && !interval.superseded)
    : [];
  const survivor = openIntervals.find(interval => String(interval.intervalId) === survivorId);
  if (!survivor) {
    return { ok: false, reason: "ledger_repair_survivor_not_open", spoolId, status, openIntervals };
  }
  const targetIntervalIds = openIntervals
    .map(interval => String(interval.intervalId))
    .filter(intervalId => intervalId && intervalId !== survivorId)
    .sort();
  if (targetIntervalIds.length === 0) {
    return { ok: false, reason: "ledger_repair_not_ambiguous", spoolId, status, openIntervals };
  }
  return { ok: true, reason: "ledger_repair_repairable", spoolId, status, openIntervals, targetIntervalIds };
}

/**
 * この端末で O6 recovery 操作を実行できるか判定する。
 *
 * 【詳細説明】
 * - Recovery Operations は確定台帳・recovery flag・隔離 event を変更するため、初期 O6 では
 *   STAND ALONE / PARENT のみ許可する。
 * - SATELLITE は親から同期された診断を閲覧するだけで、復旧操作は親端末で実行する。
 *
 * @function canExecuteRecoveryOperation
 * @returns {boolean} ローカルで recovery 操作を実行できる場合 true。
 * @example
 * if (canExecuteRecoveryOperation()) enableRecoveryButtons();
 */
export function canExecuteRecoveryOperation() {
  return canExecuteLedgerDecision();
}

/**
 * 現在の recovery / repair 状態を再度耐久保存する。
 *
 * 【詳細説明】
 * - rollback 保存失敗などで「現在メモリ上にある復旧状態をもう一度 durable store へ書く」ための操作。
 * - 新しい candidate decision は行わず、監査 event を追記して保存完了だけを確認する。
 *
 * @function retryInferredRecoveryDurableSave
 * @param {{actor?:string,nowMs?:number,save?:boolean}} [options] - 操作者・clock・保存オプション。
 * @returns {Promise<Object>} recovery 操作結果。
 * @example
 * const result = await retryInferredRecoveryDurableSave({ actor: "operator" });
 */
export function retryInferredRecoveryDurableSave(options = {}) {
  return enqueueLedgerDecisionTask(async () => {
    const guard = _operationGuard();
    if (guard) return guard;
    if (!_hasRecoveryIssues()) return { ok: false, reason: "recovery_not_required" };

    const snapshot = _snapshotRecoveryState();
    const event = _appendRecoveryEvent(INFERRED_RECOVERY_EVENT_TYPE.DURABLE_SAVE_RETRIED, {
      reason: "operator-retry",
      decisionRecovery: monitorData[DECISION_RECOVERY_FIELD] ? _clone(monitorData[DECISION_RECOVERY_FIELD]) : null,
      ledgerRepairHosts: Object.keys(_ledgerRepairRequired()),
      rejectedMountEventCount: _rejectedMountEvents().length
    }, options);
    const saved = await _saveOrRollbackRecoveryMutation(snapshot, "recovery_retry_not_durably_saved", options);
    if (!saved.ok) return saved;
    return { ok: true, reason: "recovery_durable_save_retried", event, save: saved.save };
  });
}

/**
 * 確認済みの O5 decision recovery flag を解除する。
 *
 * 【詳細説明】
 * - rollback 後の状態をオペレーターが確認した場合だけ呼ぶ。
 * - flag 解除と audit event 追記は同一保存境界で行い、保存失敗時は flag を戻す。
 *
 * @function clearInferredDecisionRecoveryRequired
 * @param {{actor?:string,note?:string,nowMs?:number,save?:boolean}} [options] - 操作者・メモ・保存オプション。
 * @returns {Promise<Object>} recovery 操作結果。
 * @example
 * const result = await clearInferredDecisionRecoveryRequired({ actor: "operator", note: "checked" });
 */
export function clearInferredDecisionRecoveryRequired(options = {}) {
  return enqueueLedgerDecisionTask(async () => {
    const guard = _operationGuard();
    if (guard) return guard;
    const current = monitorData[DECISION_RECOVERY_FIELD];
    if (!current || typeof current !== "object") return { ok: false, reason: "decision_recovery_not_found" };

    const snapshot = _snapshotRecoveryState();
    monitorData[DECISION_RECOVERY_FIELD] = null;
    const event = _appendRecoveryEvent(INFERRED_RECOVERY_EVENT_TYPE.DECISION_RECOVERY_CLEARED, {
      reason: "operator-cleared-decision-recovery",
      note: options.note || "",
      clearedRecovery: _clone(current)
    }, options);
    const saved = await _saveOrRollbackRecoveryMutation(snapshot, "decision_recovery_clear_not_durably_saved", options);
    if (!saved.ok) return saved;
    return { ok: true, reason: "decision_recovery_cleared", event, save: saved.save };
  });
}

/**
 * 確認済みの host 単位 ledger repair flag を解除する。
 *
 * 【詳細説明】
 * - 現在の mount interval 状態を確認し、まだ ambiguous/corrupt の場合は fail-closed で解除しない。
 * - O7 の再計算監査が入るまでは、`ok` / `none` に戻っている host について、オペレーターが
 *   mount ledger を確認済みであることを前提とする手動解除 API として扱う。
 * - 解除対象の元 flag は audit event に保存し、保存失敗時は map を操作前へ戻す。
 *
 * @function clearLedgerRepairRequired
 * @param {string} host - 解除する host key。
 * @param {{actor?:string,note?:string,nowMs?:number,save?:boolean}} [options] - 操作者・メモ・保存オプション。
 * @returns {Promise<Object>} recovery 操作結果。
 * @example
 * const result = await clearLedgerRepairRequired("k1max.local", { actor: "operator" });
 */
export function clearLedgerRepairRequired(host, options = {}) {
  return enqueueLedgerDecisionTask(async () => {
    const guard = _operationGuard();
    if (guard) return guard;
    const hostKey = String(host || "");
    if (!hostKey) return { ok: false, reason: "ledger_repair_host_required" };
    const repair = _ledgerRepairRequired();
    const current = repair[hostKey];
    if (!current || typeof current !== "object") return { ok: false, reason: "ledger_repair_not_found", host: hostKey };
    const clearance = _validateLedgerRepairClearance(hostKey, current);
    if (!clearance.ok) return { ok: false, reason: clearance.reason, host: hostKey, status: clearance.status };

    const snapshot = _snapshotRecoveryState();
    delete repair[hostKey];
    const event = _appendRecoveryEvent(INFERRED_RECOVERY_EVENT_TYPE.LEDGER_REPAIR_CLEARED, {
      reason: "operator-cleared-ledger-repair",
      host: hostKey,
      note: options.note || "",
      clearedRepair: _clone(current),
      clearanceStatus: _clone(clearance.status)
    }, options);
    const saved = await _saveOrRollbackRecoveryMutation(snapshot, "ledger_repair_clear_not_durably_saved", options);
    if (!saved.ok) return saved;
    return { ok: true, reason: "ledger_repair_cleared", host: hostKey, event, save: saved.save };
  });
}

/**
 * 曖昧な mount interval を survivor 明示選択で修復する。
 *
 * 【詳細説明】
 * - `ledgerRepairRequired[host]` が存在し、現在の mount interval 状態が `ambiguous` の場合だけ実行する。
 * - 操作者が選んだ survivor 以外の open interval を `supersede` event で無効化し、投影後に
 *   open interval が survivor 1件へ収束したことを再検証する。
 * - 修復 event、ledger repair flag 解除、recovery audit event は同じ耐久保存境界で扱う。
 * - 保存失敗時は `mountHistory` / `mountHistorySeq` / repair flag / audit event を操作前へ戻す。
 *
 * @function repairLedgerMountIntervals
 * @param {string} host - 修復対象 host key。
 * @param {string} survivingIntervalId - 残す mount interval ID。
 * @param {{actor?:string,note?:string,nowMs?:number,save?:boolean}} [options] - 操作者・メモ・保存オプション。
 * @returns {Promise<Object>} recovery 操作結果。
 * @example
 * const result = await repairLedgerMountIntervals("k1max.local", "mount_S1_100", { actor: "operator" });
 */
export function repairLedgerMountIntervals(host, survivingIntervalId, options = {}) {
  return enqueueLedgerDecisionTask(async () => {
    const guard = _operationGuard();
    if (guard) return guard;
    const hostKey = String(host || "");
    if (!hostKey) return { ok: false, reason: "ledger_repair_host_required" };
    const repair = _ledgerRepairRequired();
    const current = repair[hostKey];
    if (!current || typeof current !== "object") return { ok: false, reason: "ledger_repair_not_found", host: hostKey };
    const validation = _validateLedgerIntervalRepair(hostKey, current, survivingIntervalId);
    if (!validation.ok) return { ok: false, reason: validation.reason, host: hostKey, status: validation.status, openIntervals: validation.openIntervals };

    const snapshot = _snapshotRecoveryState({ includeMountHistory: true });
    const nowMs = _nowMs(options);
    const supersedeEvent = appendSupersedeEvent({
      host: hostKey,
      spoolId: validation.spoolId,
      targetIntervalIds: validation.targetIntervalIds,
      survivingIntervalId: String(survivingIntervalId),
      reason: "operator-selected-survivor",
      ts: nowMs,
      opId: `o6_repair_${hostKey}_${validation.spoolId}_${String(survivingIntervalId)}_${nowMs}`
    });
    if (!supersedeEvent) {
      _restoreRecoveryState(snapshot);
      return { ok: false, reason: "ledger_repair_supersede_failed", host: hostKey, status: validation.status };
    }

    let afterStatus;
    try {
      afterStatus = getMountIntervalStatus(validation.spoolId, hostKey);
    } catch (error) {
      _restoreRecoveryState(snapshot);
      return {
        ok: false,
        reason: "ledger_repair_validation_failed",
        host: hostKey,
        status: { error: error?.message || String(error) }
      };
    }
    if (afterStatus?.status !== "ok" || String(afterStatus?.openInterval?.intervalId || "") !== String(survivingIntervalId)) {
      _restoreRecoveryState(snapshot);
      return { ok: false, reason: "ledger_repair_post_status_invalid", host: hostKey, status: afterStatus };
    }

    delete repair[hostKey];
    const event = _appendRecoveryEvent(INFERRED_RECOVERY_EVENT_TYPE.LEDGER_INTERVALS_REPAIRED, {
      reason: "operator-repaired-ledger-intervals",
      host: hostKey,
      spoolId: validation.spoolId,
      note: options.note || "",
      repairedRepair: _clone(current),
      beforeStatus: _clone(validation.status),
      afterStatus: _clone(afterStatus),
      survivingIntervalId: String(survivingIntervalId),
      supersededIntervalIds: _clone(validation.targetIntervalIds),
      supersedeEvent: _clone(supersedeEvent)
    }, { ...options, nowMs });
    const saved = await _saveOrRollbackRecoveryMutation(snapshot, "ledger_repair_repair_not_durably_saved", options);
    if (!saved.ok) return saved;
    return {
      ok: true,
      reason: "ledger_repair_intervals_repaired",
      host: hostKey,
      survivingIntervalId: String(survivingIntervalId),
      supersededIntervalIds: validation.targetIntervalIds,
      supersedeEvent,
      event,
      save: saved.save
    };
  });
}

/**
 * 隔離済み mountHistory event を recovery audit event へ退避し、warning を閉じる。
 *
 * 【詳細説明】
 * - `mountHistoryRejectedEvents` は有効 projection から外した event の隔離領域であり、確認済み後も
 *   元情報を失わないよう audit event 内へ snapshot を保存してから配列を空にする。
 * - 保存失敗時は隔離配列と audit event を操作前へ戻す。
 *
 * @function archiveMountHistoryRejectedEvents
 * @param {{actor?:string,note?:string,nowMs?:number,save?:boolean}} [options] - 操作者・メモ・保存オプション。
 * @returns {Promise<Object>} recovery 操作結果。
 * @example
 * const result = await archiveMountHistoryRejectedEvents({ actor: "operator" });
 */
export function archiveMountHistoryRejectedEvents(options = {}) {
  return enqueueLedgerDecisionTask(async () => {
    const guard = _operationGuard();
    if (guard) return guard;
    const rejected = _rejectedMountEvents();
    if (rejected.length === 0) return { ok: false, reason: "mount_history_rejected_events_not_found" };

    const rejectedSnapshot = _clone(rejected);
    const snapshot = _snapshotRecoveryState();
    rejected.splice(0, rejected.length);
    const event = _appendRecoveryEvent(INFERRED_RECOVERY_EVENT_TYPE.REJECTED_MOUNT_EVENTS_ARCHIVED, {
      reason: "operator-archived-rejected-mount-events",
      note: options.note || "",
      rejectedEventCount: rejectedSnapshot.length,
      rejectedEvents: rejectedSnapshot
    }, options);
    const saved = await _saveOrRollbackRecoveryMutation(snapshot, "mount_history_rejected_archive_not_durably_saved", options);
    if (!saved.ok) return saved;
    return {
      ok: true,
      reason: "mount_history_rejected_events_archived",
      archivedCount: rejectedSnapshot.length,
      event,
      save: saved.save
    };
  });
}
