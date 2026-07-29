/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 推定 candidate Human Decision Core モジュール
 * @file dashboard_inferred_candidate_decision.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_inferred_candidate_decision
 *
 * 【機能内容サマリ】
 * - O5A として、pending inferredCandidate の Confirm / Reject / Reassign を提供する。
 * - O5D として、confirmed / reassigned candidate の Undo を提供する。
 * - STAND ALONE と PARENT は確定台帳の権威として decision を実行できる。
 * - SATELLITE はローカル candidate/ledger を書かず、Parent へ decision request を送る。
 * - Confirm/Reassign は台帳反映、candidate 状態遷移、耐久保存を一連の transaction として扱い、
 *   保存失敗時はメモリ rollback と rollback 状態の耐久保存を試みる。
 * - Parent/Standalone のローカル decision は全体直列化し、保存待ち中の別 decision が rollback
 *   snapshot をまたいで混線しないようにする。
 * - Undo も同じ transaction 境界で、O5 が追加した台帳 event と履歴 attribution だけを逆反映する。
 *
 * 【公開関数一覧】
 * - {@link canExecuteLedgerDecision}：この端末で O5 decision を実行できるか判定する
 * - {@link canSubmitLedgerDecision}：この端末から O5 decision を送信できるか判定する
 * - {@link confirmInferredCandidate}：candidate spool で推定使用量を確定する
 * - {@link rejectInferredCandidate}：candidate を否認し、確定台帳には触れない
 * - {@link reassignInferredCandidate}：別 spool へ再割当てして推定使用量を確定する
 * - {@link undoInferredCandidateDecision}：確定済み candidate の台帳反映を取り消す
 *
 * @version 1.390.1268 (PR #419)
 * @since   1.390.1261 (PR #414)
 * @lastModified 2026-07-29 17:25:57
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

import { monitorData } from "./dashboard_data.js";
import { saveUnifiedStorageDurably } from "./dashboard_storage.js";
import {
  INFERRED_CANDIDATE_STATUS,
  transitionInferredCandidate
} from "./dashboard_offline_candidate_store.js";
import {
  applyInferredCandidateLedger,
  rollbackInferredCandidateLedger,
  undoInferredCandidateLedger
} from "./dashboard_inferred_candidate_ledger.js";
import { getRelayMode, sendRelayFilament } from "./dashboard_client_sync.js";
import { wallNowMs } from "./dashboard_time.js";

/**
 * O5 decision 復旧要求を保存する monitorData field 名。
 *
 * @constant {string}
 */
const RECOVERY_FIELD = "inferredDecisionRecoveryRequired";

/**
 * Reject の理由として受け付ける短い識別子。
 *
 * @constant {Set<string>}
 */
const ALLOWED_REJECT_REASONS = new Set([
  "not-same-spool",
  "already-accounted",
  "insufficient-evidence",
  "operator-decision",
  "other"
]);

/**
 * Parent/Standalone で実行する O5 decision の直列化キュー。
 *
 * 【詳細説明】
 * - JavaScript は単一スレッドだが、`await saveUnifiedStorageDurably()` 中には別の UI/RPC 操作が
 *   開始できるため、同一 spool の rollback snapshot が後続 decision を巻き戻す危険がある。
 * - 初期実装では host/spool 単位ではなく全 O5 decision を直列化し、Confirm/Reassign/Reject/Undo の
 *   競合範囲を安全側で閉じる。
 *
 * @type {Promise<void>}
 */
let _decisionQueue = Promise.resolve();

/**
 * ローカル O5 decision を全体キューへ投入する。
 *
 * 【詳細説明】
 * - 直前 decision が成功しても失敗しても、次の decision は必ずその後に開始する。
 * - 呼び出し元には task の戻り値をそのまま返し、キュー内部では rejection を吸収して後続が詰まらない
 *   ようにする。
 *
 * @private
 * @function _enqueueDecision
 * @param {Function} task - 実行する decision 本体。
 * @returns {Promise<*>} decision 本体の戻り値。
 */
function _enqueueDecision(task) {
  const run = _decisionQueue.then(task, task);
  _decisionQueue = run.catch(() => {});
  return run;
}

/**
 * JSON 互換オブジェクトを deep clone する。
 *
 * @private
 * @function _clone
 * @param {*} value - clone 対象。
 * @returns {*} clone 済みの値。
 */
function _clone(value) {
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
 * リレー子端末かどうかを判定する。
 *
 * 【詳細説明】
 * - 初期 O5 では SATELLITE/readonly 子は candidate を閲覧できるが、確定台帳の権威を持たない。
 * - 既存 relay 実装では子端末を `window._3dpmonRelayChild === true` で表しているため、その
 *   境界に合わせる。
 *
 * @private
 * @function _isRelayChild
 * @returns {boolean} リレー子端末なら true。
 */
function _isRelayChild() {
  return typeof window !== "undefined" && window._3dpmonRelayChild === true;
}

/**
 * Satellite から Parent へ O5 decision request を送れる状態か判定する。
 *
 * 【詳細説明】
 * - `window._3dpmonRelayChild === true` だけでは readonly 子も含むため、relay mode が
 *   `satellite` に昇格済みの場合だけ true にする。
 * - 初回 snapshot 未受信や WebSocket 未接続の細かい条件は `sendRelayFilament()` 側で
 *   最終ゲートされるため、ここでは UI の大まかな操作可否だけを返す。
 *
 * @private
 * @function _canRequestLedgerDecision
 * @returns {boolean} Parent へ decision request を送れる可能性がある場合 true。
 */
function _canRequestLedgerDecision() {
  return _isRelayChild() && getRelayMode() === "satellite";
}

/**
 * candidate store を安全に取得する。
 *
 * @private
 * @function _store
 * @returns {Object.<string,Object>} inferredCandidateStore。
 */
function _store() {
  if (!monitorData.inferredCandidateStore || typeof monitorData.inferredCandidateStore !== "object") {
    monitorData.inferredCandidateStore = {};
  }
  return monitorData.inferredCandidateStore;
}

/**
 * candidateHash から candidate record を取得する。
 *
 * @private
 * @function _candidate
 * @param {string} candidateHash - 対象 candidateHash。
 * @returns {?Object} candidate record。存在しない場合は null。
 */
function _candidate(candidateHash) {
  return candidateHash ? (_store()[candidateHash] || null) : null;
}

/**
 * オブジェクト参照を保ったまま snapshot へ復元する。
 *
 * 【詳細説明】
 * - candidate record は store 内の同じ参照を UI やテストが持つ可能性があるため、差し替えではなく
 *   in-place で保存前状態へ戻す。
 *
 * @private
 * @function _restoreObjectInPlace
 * @param {Object} target - 復元対象。
 * @param {Object} snapshot - 保存前 snapshot。
 * @returns {void}
 */
function _restoreObjectInPlace(target, snapshot) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, _clone(snapshot));
}

/**
 * candidate が O5 decision 可能な pending record か検証する。
 *
 * 【詳細説明】
 * - O5 は pending だけを確定入口として扱う。
 * - confirmed/rejected/reassigned/superseded などの終端状態は、同一 hash/identity であっても
 *   baseline や確定台帳へ再利用しない。
 *
 * @private
 * @function _validatePendingCandidate
 * @param {string} candidateHash - 対象 candidateHash。
 * @returns {{ok:boolean, reason:string, record:?Object}} 検証結果。
 */
function _validatePendingCandidate(candidateHash) {
  if (!candidateHash) return { ok: false, reason: "candidate_hash_required", record: null };
  const record = _candidate(candidateHash);
  if (!record) return { ok: false, reason: "candidate_not_found", record: null };
  if (record.status !== INFERRED_CANDIDATE_STATUS.PENDING) {
    return { ok: false, reason: "candidate_not_pending", record };
  }
  return { ok: true, reason: "candidate_pending", record };
}

/**
 * candidate が O5 Undo 可能な resolved record か検証する。
 *
 * 【詳細説明】
 * - Undo は確定台帳へ実際に debit を反映した `confirmed` と `reassigned` だけを対象にする。
 * - pending/rejected/superseded/undone は台帳反映を持たない、または既に取り消し済みなので拒否する。
 *
 * @private
 * @function _validateUndoableCandidate
 * @param {string} candidateHash - 対象 candidateHash。
 * @returns {{ok:boolean, reason:string, record:?Object}} 検証結果。
 */
function _validateUndoableCandidate(candidateHash) {
  if (!candidateHash) return { ok: false, reason: "candidate_hash_required", record: null };
  const record = _candidate(candidateHash);
  if (!record) return { ok: false, reason: "candidate_not_found", record: null };
  if (record.status !== INFERRED_CANDIDATE_STATUS.CONFIRMED
      && record.status !== INFERRED_CANDIDATE_STATUS.REASSIGNED) {
    return { ok: false, reason: "candidate_not_undoable", record };
  }
  return { ok: true, reason: "candidate_undoable", record };
}

/**
 * rollback 後も耐久保存できない場合の復旧要求を monitorData へ記録する。
 *
 * 【詳細説明】
 * - 保存失敗後のメモリ rollback は実施済みでも、その rollback 状態が耐久化できない場合は、
 *   次回起動時に candidate と ledger の整合確認が必要になる。
 * - O5B/O5C で UI 表示や起動時 reconciliation を追加できるよう、独立した recovery flag を残す。
 *
 * @private
 * @function _markRecoveryRequired
 * @param {Object} data - 復旧要求 metadata。
 * @param {{nowMs?:number}} [options] - clock 注入オプション。
 * @returns {Object} 保存した復旧要求。
 */
function _markRecoveryRequired(data, options = {}) {
  monitorData[RECOVERY_FIELD] = {
    ...data,
    createdAt: _nowMs(options)
  };
  return monitorData[RECOVERY_FIELD];
}

/**
 * decision 実行前の共通ガードを適用する。
 *
 * 【詳細説明】
 * - SATELLITE/readonly 子は初期 O5 では閲覧専用であり、Confirm/Reject/Reassign を実行しない。
 * - 未解決の recovery flag がある場合は、新しい確定操作を止め、先に整合復旧を要求する。
 *
 * @private
 * @function _decisionGuard
 * @param {string} candidateHash - 対象 candidateHash。
 * @returns {?{ok:boolean,reason:string}} ガードに引っかかった場合の戻り値。問題なければ null。
 */
function _decisionGuard(candidateHash) {
  if (!canExecuteLedgerDecision()) return { ok: false, reason: "decision_not_authorized", candidateHash };
  if (monitorData[RECOVERY_FIELD]) return { ok: false, reason: "decision_recovery_required", candidateHash, recovery: monitorData[RECOVERY_FIELD] };
  return null;
}

/**
 * Satellite から Parent へ O5 decision request を送信する。
 *
 * 【詳細説明】
 * - Satellite は確定台帳の権威を持たないため、ローカル candidate/ledger を変更しない。
 * - 送信後の実結果は Parent の耐久保存後に relay-delta / snapshot で還流する。
 * - `sendRelayFilament()` が readonly・未接続・初回 snapshot 未受信を fail-closed する。
 *
 * @private
 * @function _requestLedgerDecision
 * @param {string} action - 親へ送る O5 decision action。
 * @param {string} candidateHash - 対象 candidateHash。
 * @param {Object} payload - 追加 payload。
 * @param {{actor?:string}} [options] - 操作者オプション。
 * @returns {{ok:boolean,reason:string,relayed?:boolean,action:string,candidateHash:string}}
 *   request 送信結果。
 */
function _requestLedgerDecision(action, candidateHash, payload = {}, options = {}) {
  if (!candidateHash) return { ok: false, reason: "candidate_hash_required", action, candidateHash };
  if (!_canRequestLedgerDecision()) {
    return { ok: false, reason: "decision_not_authorized", action, candidateHash };
  }
  const sent = sendRelayFilament(action, {
    candidateHash,
    actor: options.actor || "satellite-user",
    ...payload
  });
  if (!sent) return { ok: false, reason: "decision_request_not_sent", action, candidateHash };
  return { ok: true, reason: "decision_requested", relayed: true, action, candidateHash };
}

/**
 * candidate 状態だけを保存前 snapshot へ戻す。
 *
 * @private
 * @function _rollbackCandidateRecord
 * @param {string} candidateHash - 対象 candidateHash。
 * @param {Object} candidateSnapshot - 保存前 candidate snapshot。
 * @returns {{ok:boolean,reason:string}} rollback 結果。
 */
function _rollbackCandidateRecord(candidateHash, candidateSnapshot) {
  const record = _candidate(candidateHash);
  if (!record) return { ok: false, reason: "candidate_missing_during_rollback" };
  _restoreObjectInPlace(record, candidateSnapshot);
  return { ok: true, reason: "candidate_rolled_back" };
}

/**
 * 変更後に耐久保存し、失敗した場合は candidate と ledger を rollback する。
 *
 * 【詳細説明】
 * - Confirm/Reassign/Undo は ledger と candidate の両方を変更するため、保存失敗時は両方を復元する。
 * - Reject は ledgerSnapshot が null で、candidate 状態だけを復元する。
 * - rollback 後の状態も再度耐久保存し、これに失敗した場合は recovery flag を残す。
 *
 * @private
 * @function _saveDecisionOrRollback
 * @param {Object} params - 保存と rollback に必要な値。
 * @param {string} params.candidateHash - 対象 candidateHash。
 * @param {string} params.action - decision 名。
 * @param {?Object} params.ledgerSnapshot - ledger rollback snapshot。
 * @param {Object} params.candidateSnapshot - candidate rollback snapshot。
 * @param {Object} params.transition - candidate 状態遷移結果。
 * @param {{save?:boolean,nowMs?:number}} [options] - 保存・clock オプション。
 * @returns {Promise<{ok:boolean,reason:string,save?:Object,rollback?:Object,candidateRollback?:Object,rollbackSave?:Object,recovery?:Object}>}
 *   保存または rollback の結果。
 */
async function _saveDecisionOrRollback(params, options = {}) {
  const save = options.save === false
    ? { ok: true, backend: "disabled", reason: "save_disabled" }
    : await saveUnifiedStorageDurably();
  if (!save || save.ok !== false) {
    return { ok: true, reason: "decision_saved", save };
  }

  const rollback = params.ledgerSnapshot ? rollbackInferredCandidateLedger(params.ledgerSnapshot) : null;
  const candidateRollback = _rollbackCandidateRecord(params.candidateHash, params.candidateSnapshot);
  const rollbackSave = options.save === false
    ? { ok: true, backend: "disabled", reason: "save_disabled" }
    : await saveUnifiedStorageDurably();
  if (rollbackSave && rollbackSave.ok === false) {
    const recovery = _markRecoveryRequired({
      candidateHash: params.candidateHash,
      action: params.action,
      reason: "rollback_durable_save_failed",
      save,
      rollback,
      candidateRollback,
      rollbackSave,
      transition: params.transition
    }, options);
    return {
      ok: false,
      reason: "rollback_durable_save_failed",
      save,
      rollback,
      candidateRollback,
      rollbackSave,
      recovery
    };
  }
  return {
    ok: false,
    reason: save.reason || "decision_not_durably_saved",
    save,
    rollback,
    candidateRollback,
    rollbackSave
  };
}

/**
 * この端末で O5 の確定台帳 decision を実行できるか判定する。
 *
 * 【詳細説明】
 * - STAND ALONE と PARENT は `window._3dpmonRelayChild !== true` なので true を返す。
 * - SATELLITE/readonly 子はローカル確定台帳の権威を持たないため false を返す。
 * - SATELLITE から Parent へ decision request を送れるかは {@link canSubmitLedgerDecision} で判定する。
 *
 * @function canExecuteLedgerDecision
 * @returns {boolean} ローカルで Confirm/Reject/Reassign/Undo を実行できる場合 true。
 * @example
 * if (canExecuteLedgerDecision()) enableConfirmButton();
 */
export function canExecuteLedgerDecision() {
  return !_isRelayChild();
}

/**
 * この端末から O5 decision を送信できるか判定する。
 *
 * 【詳細説明】
 * - STAND ALONE / PARENT はローカル実行できるため true。
 * - SATELLITE はローカル実行はできないが、relay mode が `satellite` なら Parent へ request
 *   を送れるため true。
 * - readonly 子は request も送れないため false。
 *
 * @function canSubmitLedgerDecision
 * @returns {boolean} UI 上で Confirm/Reject/Reassign/Undo を有効にできる場合 true。
 * @example
 * if (canSubmitLedgerDecision()) enableDecisionButtons();
 */
export function canSubmitLedgerDecision() {
  return canExecuteLedgerDecision() || _canRequestLedgerDecision();
}

/**
 * candidate spool のまま推定使用量を確定する。
 *
 * 【詳細説明】
 * - pending candidate の observation key に対応する未帰属履歴を再検証し、spool.remainingLengthMm、
 *   履歴 filamentInfo、spool.usedLengthLog を更新する。
 * - candidate は `confirmed` へ遷移し、保存失敗時は ledger と candidate を保存前状態へ戻す。
 *
 * @function confirmInferredCandidate
 * @param {string} candidateHash - 確定する candidateHash。
 * @param {{actor?:string,nowMs?:number,save?:boolean}} [options] - 操作者・clock・保存オプション。
 * @returns {Promise<Object>} decision 結果。
 * @example
 * const result = await confirmInferredCandidate("ic-abcd", { actor: "operator" });
 */
export async function confirmInferredCandidate(candidateHash, options = {}) {
  if (_isRelayChild()) return _requestLedgerDecision("confirmInferredCandidate", candidateHash, {}, options);
  return _enqueueDecision(() => _confirmInferredCandidateLocal(candidateHash, options));
}

/**
 * candidate spool のまま推定使用量をローカル確定する。
 *
 * @private
 * @function _confirmInferredCandidateLocal
 * @param {string} candidateHash - 確定する candidateHash。
 * @param {{actor?:string,nowMs?:number,save?:boolean}} [options] - 操作者・clock・保存オプション。
 * @returns {Promise<Object>} decision 結果。
 */
async function _confirmInferredCandidateLocal(candidateHash, options = {}) {
  const guard = _decisionGuard(candidateHash);
  if (guard) return guard;
  const pending = _validatePendingCandidate(candidateHash);
  if (!pending.ok) return { ok: false, reason: pending.reason, candidateHash, record: pending.record };
  const record = pending.record;
  const candidateSnapshot = _clone(record);
  const applied = applyInferredCandidateLedger(record, record.candidateSpoolId, {
    nowMs: options.nowMs,
    actor: options.actor || "user",
    decisionType: "confirm",
    originalCandidateSpoolId: record.candidateSpoolId
  });
  if (!applied.ok) return { ok: false, reason: applied.reason, candidateHash, record, applied };
  const transition = transitionInferredCandidate(candidateHash, INFERRED_CANDIDATE_STATUS.CONFIRMED, {
    nowMs: options.nowMs,
    actor: options.actor || "user",
    reason: "operator-confirmed"
  });
  if (!transition.ok) {
    const rollback = rollbackInferredCandidateLedger(applied.snapshot);
    return { ok: false, reason: transition.reason, candidateHash, record, applied, transition, rollback };
  }
  const saved = await _saveDecisionOrRollback({
    candidateHash,
    action: "confirm",
    ledgerSnapshot: applied.snapshot,
    candidateSnapshot,
    transition
  }, options);
  if (!saved.ok) return { ok: false, reason: saved.reason, candidateHash, record: _candidate(candidateHash), applied, transition, ...saved };
  return { ok: true, reason: "confirmed", candidateHash, record: transition.record, applied, transition, save: saved.save };
}

/**
 * pending candidate を否認する。
 *
 * 【詳細説明】
 * - Reject は確定台帳へ一切触れず、candidate status を `rejected` へ遷移するだけに留める。
 * - 保存失敗時は candidate status を保存前状態へ戻し、rollback 状態の耐久保存を試みる。
 *
 * @function rejectInferredCandidate
 * @param {string} candidateHash - 否認する candidateHash。
 * @param {{actor?:string,reason?:string,note?:string,nowMs?:number,save?:boolean}} [options]
 *   - 操作者・否認理由・clock・保存オプション。
 * @returns {Promise<Object>} decision 結果。
 * @example
 * const result = await rejectInferredCandidate("ic-abcd", { reason: "not-same-spool" });
 */
export async function rejectInferredCandidate(candidateHash, options = {}) {
  if (_isRelayChild()) {
    const rejectReason = options.reason || "operator-decision";
    if (!ALLOWED_REJECT_REASONS.has(rejectReason)) {
      return { ok: false, reason: "invalid_reject_reason", candidateHash, rejectReason };
    }
    return _requestLedgerDecision("rejectInferredCandidate", candidateHash, {
      reason: rejectReason,
      note: options.note || ""
    }, options);
  }
  return _enqueueDecision(() => _rejectInferredCandidateLocal(candidateHash, options));
}

/**
 * pending candidate をローカル否認する。
 *
 * @private
 * @function _rejectInferredCandidateLocal
 * @param {string} candidateHash - 否認する candidateHash。
 * @param {{actor?:string,reason?:string,note?:string,nowMs?:number,save?:boolean}} [options]
 *   - 操作者・否認理由・clock・保存オプション。
 * @returns {Promise<Object>} decision 結果。
 */
async function _rejectInferredCandidateLocal(candidateHash, options = {}) {
  const guard = _decisionGuard(candidateHash);
  if (guard) return guard;
  const rejectReason = options.reason || "operator-decision";
  if (!ALLOWED_REJECT_REASONS.has(rejectReason)) {
    return { ok: false, reason: "invalid_reject_reason", candidateHash, rejectReason };
  }
  const pending = _validatePendingCandidate(candidateHash);
  if (!pending.ok) return { ok: false, reason: pending.reason, candidateHash, record: pending.record };
  const record = pending.record;
  const candidateSnapshot = _clone(record);
  const transition = transitionInferredCandidate(candidateHash, INFERRED_CANDIDATE_STATUS.REJECTED, {
    nowMs: options.nowMs,
    actor: options.actor || "user",
    reason: rejectReason
  });
  if (!transition.ok) return { ok: false, reason: transition.reason, candidateHash, record, transition };
  if (options.note) {
    if (!Array.isArray(transition.record.events)) transition.record.events = [];
    transition.record.events.push({
      type: "decision-note",
      at: _nowMs(options),
      status: INFERRED_CANDIDATE_STATUS.REJECTED,
      actor: options.actor || "user",
      reason: rejectReason,
      note: String(options.note)
    });
  }
  const saved = await _saveDecisionOrRollback({
    candidateHash,
    action: "reject",
    ledgerSnapshot: null,
    candidateSnapshot,
    transition
  }, options);
  if (!saved.ok) return { ok: false, reason: saved.reason, candidateHash, record: _candidate(candidateHash), transition, ...saved };
  return { ok: true, reason: "rejected", candidateHash, record: transition.record, transition, save: saved.save };
}

/**
 * pending candidate を別 spool へ再割当てして確定する。
 *
 * 【詳細説明】
 * - Reassign は候補 spool ではなく operator が選んだ target spool へ使用量を反映する。
 * - 確定先 spool の残量が不明、履歴が既に帰属済み、target spool が存在しない場合は fail-closed する。
 * - 保存失敗時は ledger と candidate を保存前状態へ戻す。
 *
 * @function reassignInferredCandidate
 * @param {string} candidateHash - 再割当てする candidateHash。
 * @param {string} targetSpoolId - 再割当て先 spool ID。
 * @param {{actor?:string,nowMs?:number,save?:boolean}} [options] - 操作者・clock・保存オプション。
 * @returns {Promise<Object>} decision 結果。
 * @example
 * const result = await reassignInferredCandidate("ic-abcd", "spool-b");
 */
export async function reassignInferredCandidate(candidateHash, targetSpoolId, options = {}) {
  if (_isRelayChild()) {
    if (!targetSpoolId) return { ok: false, reason: "target_spool_required", candidateHash };
    return _requestLedgerDecision("reassignInferredCandidate", candidateHash, {
      targetSpoolId: String(targetSpoolId)
    }, options);
  }
  return _enqueueDecision(() => _reassignInferredCandidateLocal(candidateHash, targetSpoolId, options));
}

/**
 * pending candidate を別 spool へローカル再割当てして確定する。
 *
 * @private
 * @function _reassignInferredCandidateLocal
 * @param {string} candidateHash - 再割当てする candidateHash。
 * @param {string} targetSpoolId - 再割当て先 spool ID。
 * @param {{actor?:string,nowMs?:number,save?:boolean}} [options] - 操作者・clock・保存オプション。
 * @returns {Promise<Object>} decision 結果。
 */
async function _reassignInferredCandidateLocal(candidateHash, targetSpoolId, options = {}) {
  const guard = _decisionGuard(candidateHash);
  if (guard) return guard;
  if (!targetSpoolId) return { ok: false, reason: "target_spool_required", candidateHash };
  const pending = _validatePendingCandidate(candidateHash);
  if (!pending.ok) return { ok: false, reason: pending.reason, candidateHash, record: pending.record };
  const record = pending.record;
  if (String(targetSpoolId) === String(record.candidateSpoolId)) {
    return { ok: false, reason: "target_spool_same_as_candidate", candidateHash, record };
  }
  const candidateSnapshot = _clone(record);
  const applied = applyInferredCandidateLedger(record, targetSpoolId, {
    nowMs: options.nowMs,
    actor: options.actor || "user",
    decisionType: "reassign",
    originalCandidateSpoolId: record.candidateSpoolId
  });
  if (!applied.ok) return { ok: false, reason: applied.reason, candidateHash, record, applied };
  const transition = transitionInferredCandidate(candidateHash, INFERRED_CANDIDATE_STATUS.REASSIGNED, {
    nowMs: options.nowMs,
    actor: options.actor || "user",
    reason: "operator-reassigned",
    assignedSpoolId: String(targetSpoolId)
  });
  if (!transition.ok) {
    const rollback = rollbackInferredCandidateLedger(applied.snapshot);
    return { ok: false, reason: transition.reason, candidateHash, record, applied, transition, rollback };
  }
  const saved = await _saveDecisionOrRollback({
    candidateHash,
    action: "reassign",
    ledgerSnapshot: applied.snapshot,
    candidateSnapshot,
    transition
  }, options);
  if (!saved.ok) return { ok: false, reason: saved.reason, candidateHash, record: _candidate(candidateHash), applied, transition, ...saved };
  return { ok: true, reason: "reassigned", candidateHash, record: transition.record, applied, transition, save: saved.save };
}

/**
 * confirmed / reassigned candidate の確定台帳反映を取り消す。
 *
 * 【詳細説明】
 * - O5 が作成した usedLengthLog event と履歴 filamentInfo を candidateHash で照合し、一意に確認できる
 *   場合だけ残量を戻して candidate を `undone` へ遷移する。
 * - SATELLITE はローカル台帳を書かず、Parent へ Undo request を送る。
 * - 保存失敗時は台帳と candidate status を保存前状態へ rollback し、その rollback 状態も耐久保存する。
 *
 * @function undoInferredCandidateDecision
 * @param {string} candidateHash - Undo する candidateHash。
 * @param {{actor?:string,nowMs?:number,save?:boolean}} [options] - 操作者・clock・保存オプション。
 * @returns {Promise<Object>} decision 結果。
 * @example
 * const result = await undoInferredCandidateDecision("ic-abcd", { actor: "operator" });
 */
export async function undoInferredCandidateDecision(candidateHash, options = {}) {
  if (_isRelayChild()) return _requestLedgerDecision("undoInferredCandidateDecision", candidateHash, {}, options);
  return _enqueueDecision(() => _undoInferredCandidateDecisionLocal(candidateHash, options));
}

/**
 * confirmed / reassigned candidate の確定台帳反映をローカルで取り消す。
 *
 * @private
 * @function _undoInferredCandidateDecisionLocal
 * @param {string} candidateHash - Undo する candidateHash。
 * @param {{actor?:string,nowMs?:number,save?:boolean}} [options] - 操作者・clock・保存オプション。
 * @returns {Promise<Object>} decision 結果。
 */
async function _undoInferredCandidateDecisionLocal(candidateHash, options = {}) {
  const guard = _decisionGuard(candidateHash);
  if (guard) return guard;
  const undoable = _validateUndoableCandidate(candidateHash);
  if (!undoable.ok) return { ok: false, reason: undoable.reason, candidateHash, record: undoable.record };
  const record = undoable.record;
  const candidateSnapshot = _clone(record);
  const undone = undoInferredCandidateLedger(record, {
    nowMs: options.nowMs,
    actor: options.actor || "user"
  });
  if (!undone.ok) return { ok: false, reason: undone.reason, candidateHash, record, undone };
  const transition = transitionInferredCandidate(candidateHash, INFERRED_CANDIDATE_STATUS.UNDONE, {
    nowMs: options.nowMs,
    actor: options.actor || "user",
    reason: "operator-undo"
  });
  if (!transition.ok) {
    const rollback = rollbackInferredCandidateLedger(undone.snapshot);
    return { ok: false, reason: transition.reason, candidateHash, record, undone, transition, rollback };
  }
  const saved = await _saveDecisionOrRollback({
    candidateHash,
    action: "undo",
    ledgerSnapshot: undone.snapshot,
    candidateSnapshot,
    transition
  }, options);
  if (!saved.ok) return { ok: false, reason: saved.reason, candidateHash, record: _candidate(candidateHash), undone, transition, ...saved };
  return { ok: true, reason: "undone", candidateHash, record: transition.record, undone, transition, save: saved.save };
}
