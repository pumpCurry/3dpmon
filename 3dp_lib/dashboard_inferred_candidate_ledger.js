/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 推定 candidate 確定台帳反映モジュール
 * @file dashboard_inferred_candidate_ledger.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_inferred_candidate_ledger
 *
 * 【機能内容サマリ】
 * - O5 Human Decision Layer で承認された inferredCandidate を、確定台帳へ反映する。
 * - 確定残量、印刷履歴 filamentInfo、spool.usedLengthLog を同じ決定単位で更新する。
 * - 保存失敗時にメモリ状態を元へ戻せるよう、反映前 snapshot と rollback API を提供する。
 *
 * 【公開関数一覧】
 * - {@link applyInferredCandidateLedger}：pending candidate を指定スプールへ確定反映する
 * - {@link rollbackInferredCandidateLedger}：確定反映前 snapshot へメモリ状態を戻す
 *
 * @version 1.390.1261 (PR #414)
 * @since   1.390.1261 (PR #414)
 * @lastModified 2026-07-25 13:45:00
 * -----------------------------------------------------------
 * @todo
 * - O5B UI で decision timeline へ表示する詳細 event 文言を調整する。
 */

"use strict";

import { monitorData } from "./dashboard_data.js";
import { jobObservationIdentity } from "./dashboard_history_identity.js";
import { buildOfflineFilamentInfo, getSpoolById, shouldLinkOfflineJob } from "./dashboard_spool.js";
import { randomEventId, wallNowMs } from "./dashboard_time.js";

/**
 * 確定反映できる candidate debit の状態。
 *
 * @constant {string}
 */
const INFERRED_DEBIT_STATUS = "inferred-debit";

/**
 * O5 が spool.usedLengthLog へ追記する確定使用量 event の種別。
 *
 * @constant {string}
 */
export const INFERRED_DECISION_LEDGER_EVENT_TYPE = "inferred-continuity-confirmed";

/**
 * JSON 互換オブジェクトを deep clone する。
 *
 * 【詳細説明】
 * - rollback 用 snapshot は monitorData の参照変異から独立している必要がある。
 * - structuredClone が使える実行環境ではそれを優先し、テスト環境や古い WebView では JSON clone へ
 *   フォールバックする。
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
 * 【詳細説明】
 * - テストでは `options.nowMs` を注入し、実行環境では `wallNowMs()` を使う。
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
 * 正の有限 mm 値へ正規化する。
 *
 * 【詳細説明】
 * - candidate store や履歴から来る値は文字列化されている可能性があるため Number 化する。
 * - 0 以下、NaN、Infinity は確定消費として扱わない。
 *
 * @private
 * @function _positiveMm
 * @param {*} value - mm 値候補。
 * @returns {number} 正の有限値。不正値は 0。
 */
function _positiveMm(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 残量として使用可能な mm 値へ正規化する。
 *
 * 【詳細説明】
 * - O5 の Confirm/Reassign は確定台帳を書き換えるため、残量不明の spool には適用しない。
 * - null/undefined/空文字/NaN/負値は不明扱いで null を返す。
 *
 * @private
 * @function _remainingOrNull
 * @param {*} value - spool.remainingLengthMm 相当の値。
 * @returns {?number} 0 以上の有限値。不明値は null。
 */
function _remainingOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * host の履歴配列を取得する。
 *
 * 【詳細説明】
 * - O5 は `monitorData.machines[host].printStore.history` を確定対象として扱う。
 * - 対象 host が無い場合や履歴配列が無い場合は null を返し、呼び出し元で fail-closed する。
 *
 * @private
 * @function _historyForHost
 * @param {string} host - 対象ホスト名。
 * @returns {?Array<Object>} 履歴配列。存在しない場合は null。
 */
function _historyForHost(host) {
  const history = monitorData.machines?.[host]?.printStore?.history;
  return Array.isArray(history) ? history : null;
}

/**
 * observation key から履歴 index を一意に引ける Map を作る。
 *
 * 【詳細説明】
 * - O3 と同じ `jobObservationIdentity()` を使い、candidate の observationKey と履歴行を照合する。
 * - fixture や旧保存データ向けに、履歴行が `observationKey` を直接持つ場合も補助キーとして採用する。
 * - 同じ key が複数行へ一致した場合は ambiguous とし、履歴順に依存した first-wins を避ける。
 *
 * @private
 * @function _historyIndexByObservationKey
 * @param {Array<Object>} history - printStore.history 相当の履歴配列。
 * @returns {Map<string,{status:string,indexes:Array<number>}>} observation key から履歴 index への Map。
 */
function _historyIndexByObservationKey(history) {
  const map = new Map();
  for (let index = 0; index < history.length; index++) {
    const entry = history[index];
    const keys = new Set();
    const identity = jobObservationIdentity(entry);
    if (identity?.key) keys.add(String(identity.key));
    if (entry?.observationKey != null) keys.add(String(entry.observationKey));
    if (entry?._observationKey != null) keys.add(String(entry._observationKey));
    for (const key of keys) {
      const current = map.get(key);
      if (!current) {
        map.set(key, { status: "unique", indexes: [index] });
        continue;
      }
      current.status = "ambiguous";
      current.indexes.push(index);
    }
  }
  return map;
}

/**
 * candidate record から確定対象 debit を抽出する。
 *
 * 【詳細説明】
 * - O3 projection で `inferred-debit` と判定済みの行だけを確定対象にする。
 * - 履歴へ書く usedMm は candidateDebits の値を使い、合計は candidate.usedMm と一致することを検証する。
 *
 * @private
 * @function _candidateDebits
 * @param {Object} candidateRecord - inferredCandidateStore の record。
 * @returns {Array<Object>} 確定対象 debit 配列。
 */
function _candidateDebits(candidateRecord) {
  return Array.isArray(candidateRecord?.candidateDebits)
    ? candidateRecord.candidateDebits.filter(item => item?.status === INFERRED_DEBIT_STATUS)
    : [];
}

/**
 * candidate の合計使用量と debit 合計が安全に一致するか検証する。
 *
 * 【詳細説明】
 * - candidate.usedMm と個別 debit の合計が大きくずれている場合は、保存済み candidate が壊れているか、
 *   将来の形式変更で O5 が理解できないため fail-closed する。
 *
 * @private
 * @function _validateDebitTotal
 * @param {Object} candidateRecord - inferredCandidateStore の record。
 * @param {Array<Object>} debits - 確定対象 debit 配列。
 * @returns {{ok:boolean, usedMm:number, debitTotalMm:number, reason:?string}} 検証結果。
 */
function _validateDebitTotal(candidateRecord, debits) {
  const usedMm = _positiveMm(candidateRecord?.usedMm);
  const debitTotalMm = debits.reduce((sum, item) => sum + _positiveMm(item?.usedMm), 0);
  if (usedMm <= 0) return { ok: false, usedMm, debitTotalMm, reason: "candidate_used_mm_missing" };
  if (debits.length === 0 || debitTotalMm <= 0) {
    return { ok: false, usedMm, debitTotalMm, reason: "candidate_debits_missing" };
  }
  if (Math.abs(usedMm - debitTotalMm) > 0.001) {
    return { ok: false, usedMm, debitTotalMm, reason: "candidate_debit_total_mismatch" };
  }
  return { ok: true, usedMm, debitTotalMm, reason: null };
}

/**
 * spool.usedLengthLog に同じ candidate の確定 event が既にあるか判定する。
 *
 * 【詳細説明】
 * - O5 の decision は candidate status 側でも二重適用を防ぐが、台帳側でも同じ candidateHash の
 *   確定 event が存在する場合は fail-closed し、残量の二重減算を防ぐ。
 *
 * @private
 * @function _hasExistingDecisionEvent
 * @param {Object} spool - 対象 spool。
 * @param {string} candidateHash - candidateHash。
 * @returns {boolean} 既存 event がある場合 true。
 */
function _hasExistingDecisionEvent(spool, candidateHash) {
  const log = Array.isArray(spool?.usedLengthLog) ? spool.usedLengthLog : [];
  return log.some(item =>
    item
    && item.type === INFERRED_DECISION_LEDGER_EVENT_TYPE
    && item.candidateHash === candidateHash
  );
}

/**
 * history entry へ O5 確定 filamentInfo を upsert する。
 *
 * 【詳細説明】
 * - 色だけの `filamentInfo` が1件ある場合は、その同じ行へ spool 情報を補完し、UI が2行表示に
 *   ならないようにする。
 * - spoolId 付きの既存帰属がある場合は呼び出し前 validation で拒否されるため、ここでは
 *   未帰属履歴だけを更新する。
 *
 * @private
 * @function _linkHistoryEntryToSpool
 * @param {Object} entry - 更新対象履歴行。
 * @param {Object} spool - 確定対象 spool。
 * @param {number} usedMm - この履歴行に帰属させる使用量 mm。
 * @param {Object} metadata - O5 decision の監査 metadata。
 * @returns {void}
 */
function _linkHistoryEntryToSpool(entry, spool, usedMm, metadata) {
  const info = {
    ...buildOfflineFilamentInfo(spool, usedMm),
    isOfflineInferred: false,
    isInferredContinuityConfirmed: true,
    candidateHash: metadata.candidateHash,
    decisionType: metadata.decisionType,
    originalCandidateSpoolId: metadata.originalCandidateSpoolId ?? null,
    confirmedAt: metadata.createdAt,
    confirmedBy: metadata.actor
  };
  const prev = Array.isArray(entry.filamentInfo) ? entry.filamentInfo : [];
  if (prev.length === 1 && prev[0] && !prev[0].spoolId) {
    Object.assign(prev[0], info);
    entry.filamentInfo = prev;
  } else {
    entry.filamentInfo = [...prev, info];
  }
  entry.filamentId = spool.id;
}

/**
 * snapshot 内の spool オブジェクトへ保存前状態を復元する。
 *
 * 【詳細説明】
 * - monitorData 内の spool 配列要素参照を保つため、配列要素を差し替えずにプロパティを復元する。
 * - 既存プロパティを一度削除してから snapshot を代入し、保存失敗中に追加された O5 専用フィールドも
 *   残らないようにする。
 *
 * @private
 * @function _restoreObjectInPlace
 * @param {Object} target - 復元対象オブジェクト。
 * @param {Object} snapshot - 保存前 snapshot。
 * @returns {void}
 */
function _restoreObjectInPlace(target, snapshot) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, _clone(snapshot));
}

/**
 * pending candidate を指定スプールへ確定反映する。
 *
 * 【詳細説明】
 * - O5 Decision Core が Confirm/Reassign のために呼ぶ低レベル API。
 * - この関数はメモリ上の台帳だけを更新し、保存は行わない。保存失敗時は戻り値の snapshot を
 *   {@link rollbackInferredCandidateLedger} へ渡して復元する。
 * - 確定対象は `candidateDebits[].status === "inferred-debit"` の履歴だけであり、既に spoolId や
 *   filamentId を持つ履歴は二重帰属防止のため拒否する。
 *
 * @function applyInferredCandidateLedger
 * @param {Object} candidateRecord - inferredCandidateStore の pending candidate record。
 * @param {string} targetSpoolId - 確定先 spool ID。Confirm では candidateSpoolId、Reassign では再割当先。
 * @param {{nowMs?:number, actor?:string, decisionType?:string, originalCandidateSpoolId?:?string, eventId?:string}} [options]
 *   - decision metadata。
 * @returns {{ok:boolean, reason:string, snapshot:?Object, spool:?Object, historyEntries?:Array<Object>, event?:Object}}
 *   反映結果。保存失敗 rollback に必要な snapshot を含む。
 * @example
 * const applied = applyInferredCandidateLedger(record, record.candidateSpoolId);
 */
export function applyInferredCandidateLedger(candidateRecord, targetSpoolId, options = {}) {
  if (!candidateRecord?.candidateHash) return { ok: false, reason: "candidate_required", snapshot: null, spool: null };
  const host = candidateRecord.host;
  if (!host) return { ok: false, reason: "candidate_host_missing", snapshot: null, spool: null };
  const spool = getSpoolById(targetSpoolId);
  if (!spool) return { ok: false, reason: "target_spool_not_found", snapshot: null, spool: null };
  const remaining = _remainingOrNull(spool.remainingLengthMm);
  if (remaining == null) return { ok: false, reason: "confirmed_remaining_unknown", snapshot: null, spool };
  if (_hasExistingDecisionEvent(spool, candidateRecord.candidateHash)) {
    return { ok: false, reason: "candidate_ledger_event_exists", snapshot: null, spool };
  }

  const history = _historyForHost(host);
  if (!history) return { ok: false, reason: "history_not_found", snapshot: null, spool };
  const debits = _candidateDebits(candidateRecord);
  const total = _validateDebitTotal(candidateRecord, debits);
  if (!total.ok) return { ok: false, reason: total.reason, snapshot: null, spool };

  const byKey = _historyIndexByObservationKey(history);
  const updates = [];
  const seenIndexes = new Set();
  for (const debit of debits) {
    const key = String(debit.observationKey ?? "");
    const lookup = byKey.get(key);
    if (!lookup) return { ok: false, reason: "history_entry_missing", snapshot: null, spool, observationKey: key };
    if (lookup.status !== "unique" || lookup.indexes.length !== 1) {
      return { ok: false, reason: "history_observation_ambiguous", snapshot: null, spool, observationKey: key };
    }
    const index = lookup.indexes[0];
    if (seenIndexes.has(index)) {
      return { ok: false, reason: "candidate_debits_duplicate_history_entry", snapshot: null, spool, observationKey: key };
    }
    seenIndexes.add(index);
    const entry = history[index];
    if (!shouldLinkOfflineJob(entry)) {
      return { ok: false, reason: "history_already_attributed", snapshot: null, spool, observationKey: key };
    }
    const usedMm = _positiveMm(debit.usedMm);
    if (usedMm <= 0) return { ok: false, reason: "candidate_debit_used_mm_missing", snapshot: null, spool, observationKey: key };
    updates.push({ index, entry, debit, usedMm });
  }

  const snapshot = {
    candidateHash: candidateRecord.candidateHash,
    spoolId: spool.id,
    spool: _clone(spool),
    host,
    historyEntries: updates.map(item => ({ index: item.index, entry: _clone(item.entry) }))
  };
  const now = _nowMs(options);
  const actor = options.actor || "user";
  const decisionType = options.decisionType || "confirm";
  const metadata = {
    candidateHash: candidateRecord.candidateHash,
    decisionType,
    originalCandidateSpoolId: options.originalCandidateSpoolId ?? candidateRecord.candidateSpoolId ?? null,
    createdAt: now,
    actor
  };

  for (const item of updates) {
    _linkHistoryEntryToSpool(item.entry, spool, item.usedMm, metadata);
  }

  spool.remainingLengthMm = Math.max(0, remaining - total.usedMm);
  if (!Array.isArray(spool.usedLengthLog)) spool.usedLengthLog = [];
  const event = {
    eventId: options.eventId || randomEventId("icd"),
    type: INFERRED_DECISION_LEDGER_EVENT_TYPE,
    candidateHash: candidateRecord.candidateHash,
    host,
    spoolId: spool.id,
    originalCandidateSpoolId: metadata.originalCandidateSpoolId,
    decisionType,
    actor,
    usedMm: total.usedMm,
    observationKeys: Array.isArray(candidateRecord.observationKeys) ? candidateRecord.observationKeys.map(String).sort() : [],
    createdAt: now
  };
  spool.usedLengthLog.push(event);

  return {
    ok: true,
    reason: "ledger_applied",
    snapshot,
    spool,
    historyEntries: updates.map(item => item.entry),
    event
  };
}

/**
 * 確定反映前 snapshot へメモリ台帳を戻す。
 *
 * 【詳細説明】
 * - Confirm/Reassign 後の耐久保存に失敗した場合、Decision Core がこの関数で spool と履歴を
 *   保存前状態へ戻す。
 * - rollback 自体はメモリ操作であり、呼び出し元が再度 `saveUnifiedStorageDurably()` を実行して
 *   rollback 状態を耐久化する。
 *
 * @function rollbackInferredCandidateLedger
 * @param {?Object} snapshot - {@link applyInferredCandidateLedger} が返した snapshot。
 * @returns {{ok:boolean, reason:string}} rollback 結果。
 * @example
 * const rollback = rollbackInferredCandidateLedger(applied.snapshot);
 */
export function rollbackInferredCandidateLedger(snapshot) {
  if (!snapshot?.spoolId || !snapshot?.host) return { ok: false, reason: "snapshot_required" };
  const spool = getSpoolById(snapshot.spoolId);
  const history = _historyForHost(snapshot.host);
  if (!spool || !history) return { ok: false, reason: "rollback_target_missing" };
  _restoreObjectInPlace(spool, snapshot.spool);
  for (const item of snapshot.historyEntries || []) {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= history.length) {
      return { ok: false, reason: "rollback_history_index_missing" };
    }
    _restoreObjectInPlace(history[item.index], item.entry);
  }
  return { ok: true, reason: "rolled_back" };
}
