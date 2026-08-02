/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 推定 candidate 台帳照合モジュール
 * @file dashboard_inferred_reconciliation.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_inferred_reconciliation
 *
 * 【機能内容サマリ】
 * - O7 Ledger Reconciliation の read-only 入口として、O5 が作成した candidate decision と
 *   確定台帳 event、Undo 逆仕訳 event、履歴 attribution の構造的一致を検査する。
 * - monitorData を読み取るだけで、spool 残量・履歴・candidate store・recovery flag は変更しない。
 * - 自動修復は行わず、O6/O7 の Recovery surface へ表示できる issue report を返す。
 *
 * 【公開関数一覧】
 * - {@link buildInferredLedgerReconciliationReport}：推定 candidate 台帳の read-only 照合結果を生成する
 *
 * @version 1.390.1275 (PR #425)
 * @since   1.390.1275 (PR #425)
 * @lastModified 2026-08-02 19:10:00
 * -----------------------------------------------------------
 * @todo
 * - O7B で通常 print finalize 由来の usedLengthLog と残量再計算 baseline を統合する。
 */

"use strict";

import { monitorData } from "./dashboard_data.js";
import { jobObservationIdentity } from "./dashboard_history_identity.js";
import {
  INFERRED_DECISION_LEDGER_EVENT_TYPE,
  INFERRED_DECISION_UNDO_LEDGER_EVENT_TYPE
} from "./dashboard_inferred_candidate_ledger.js";
import { INFERRED_CANDIDATE_STATUS } from "./dashboard_offline_candidate_store.js";
import { wallNowMs } from "./dashboard_time.js";

/**
 * O7 issue の重大度。
 *
 * @enum {string}
 */
export const INFERRED_RECONCILIATION_SEVERITY = Object.freeze({
  BLOCKER: "blocker",
  WARNING: "warning",
  INFO: "info"
});

/**
 * O5 が確定対象にする candidate debit の状態。
 *
 * @constant {string}
 */
const INFERRED_DEBIT_STATUS = "inferred-debit";

/**
 * JSON 互換値を deep clone する。
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
 * 正の有限 mm 値へ正規化する。
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
 * JSON 表現が一致するか判定する。
 *
 * @private
 * @function _sameJson
 * @param {*} a - 比較値。
 * @param {*} b - 比較値。
 * @returns {boolean} JSON 表現が一致する場合 true。
 */
function _sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 文字列配列を sort 済みの一意配列へ正規化する。
 *
 * @private
 * @function _stringSetArray
 * @param {*} value - 配列候補。
 * @returns {Array<string>} 正規化済み文字列配列。
 */
function _stringSetArray(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(item => String(item)).filter(Boolean))].sort()
    : [];
}

/**
 * candidate store を安全に取得する。
 *
 * @private
 * @function _store
 * @returns {Object.<string,Object>} candidateHash をキーにした store。
 */
function _store() {
  return monitorData.inferredCandidateStore && typeof monitorData.inferredCandidateStore === "object"
    ? monitorData.inferredCandidateStore
    : {};
}

/**
 * active spool 配列を安全に取得する。
 *
 * @private
 * @function _spools
 * @returns {Array<Object>} active spool 配列。
 */
function _spools() {
  return Array.isArray(monitorData.filamentSpools)
    ? monitorData.filamentSpools.filter(spool => spool && !spool.deleted && !spool.isDeleted)
    : [];
}

/**
 * spool ID から active spool を取得する。
 *
 * @private
 * @function _spoolById
 * @param {?string} spoolId - spool ID。
 * @returns {?Object} spool。存在しない場合は null。
 */
function _spoolById(spoolId) {
  if (spoolId == null) return null;
  const id = String(spoolId);
  return _spools().find(spool => String(spool?.id) === id) || null;
}

/**
 * host の履歴配列を取得する。
 *
 * @private
 * @function _historyForHost
 * @param {?string} host - host key。
 * @returns {Array<Object>} printStore.history 相当の配列。
 */
function _historyForHost(host) {
  const history = monitorData.machines?.[host]?.printStore?.history;
  return Array.isArray(history) ? history : [];
}

/**
 * 履歴行の observation key 候補を列挙する。
 *
 * @private
 * @function _entryObservationKeys
 * @param {Object} entry - 履歴行。
 * @returns {Array<string>} observation key 候補。
 */
function _entryObservationKeys(entry) {
  const keys = new Set();
  const identity = jobObservationIdentity(entry);
  if (identity?.key) keys.add(String(identity.key));
  if (entry?.observationKey != null) keys.add(String(entry.observationKey));
  if (entry?._observationKey != null) keys.add(String(entry._observationKey));
  return [...keys];
}

/**
 * observation key から履歴行を一意に引く Map を作る。
 *
 * @private
 * @function _historyByObservationKey
 * @param {Array<Object>} history - printStore.history 相当の配列。
 * @returns {Map<string,{status:string,entries:Array<Object>}>} observation key lookup。
 */
function _historyByObservationKey(history) {
  const map = new Map();
  for (const entry of history) {
    for (const key of _entryObservationKeys(entry)) {
      const current = map.get(key);
      if (!current) {
        map.set(key, { status: "unique", entries: [entry] });
      } else {
        current.status = "ambiguous";
        current.entries.push(entry);
      }
    }
  }
  return map;
}

/**
 * candidate record から確定対象 debit を抽出する。
 *
 * @private
 * @function _candidateDebits
 * @param {Object} record - candidate record。
 * @returns {Array<Object>} inferred debit 配列。
 */
function _candidateDebits(record) {
  return Array.isArray(record?.candidateDebits)
    ? record.candidateDebits.filter(item => item?.status === INFERRED_DEBIT_STATUS)
    : [];
}

/**
 * candidate の debit 合計を計算する。
 *
 * @private
 * @function _candidateDebitTotalMm
 * @param {Object} record - candidate record。
 * @returns {number} inferred debit 合計 mm。
 */
function _candidateDebitTotalMm(record) {
  return _candidateDebits(record).reduce((sum, item) => sum + _positiveMm(item?.usedMm), 0);
}

/**
 * candidate と ledger event の observation key 集合が一致するか検査する。
 *
 * @private
 * @function _checkObservationKeys
 * @param {Object} record - candidate record。
 * @param {Object} event - O5 ledger event。
 * @returns {?Object} 不一致 issue。問題なければ null。
 */
function _checkObservationKeys(record, event) {
  const candidateKeys = _stringSetArray(record?.observationKeys);
  const eventKeys = _stringSetArray(event?.observationKeys);
  if (_sameJson(candidateKeys, eventKeys)) return null;
  return _issue(INFERRED_RECONCILIATION_SEVERITY.BLOCKER, "candidate_ledger_observation_keys_mismatch", {
    candidateHash: record.candidateHash,
    host: record.host,
    spoolId: event?.spoolId,
    eventId: event?.eventId,
    details: { candidateKeys, eventKeys }
  });
}

/**
 * candidate が実際に台帳へ反映された spool ID を返す。
 *
 * @private
 * @function _resolvedSpoolId
 * @param {Object} record - candidate record。
 * @returns {?string} resolved spool ID。
 */
function _resolvedSpoolId(record) {
  const id = record?.assignedSpoolId || record?.candidateSpoolId;
  return id == null ? null : String(id);
}

/**
 * spool.usedLengthLog を配列として返す。
 *
 * @private
 * @function _usedLengthLog
 * @param {?Object} spool - spool object。
 * @returns {Array<Object>} usedLengthLog。
 */
function _usedLengthLog(spool) {
  return Array.isArray(spool?.usedLengthLog) ? spool.usedLengthLog : [];
}

/**
 * spool.usedLengthLog から O5 confirmed event を抽出する。
 *
 * @private
 * @function _decisionEventsForCandidate
 * @param {?Object} spool - spool object。
 * @param {string} candidateHash - candidateHash。
 * @returns {Array<Object>} matching event 配列。
 */
function _decisionEventsForCandidate(spool, candidateHash) {
  return _usedLengthLog(spool).filter(item =>
    item
    && item.type === INFERRED_DECISION_LEDGER_EVENT_TYPE
    && item.candidateHash === candidateHash
  );
}

/**
 * spool.usedLengthLog から O5 Undo event を抽出する。
 *
 * @private
 * @function _undoEventsForCandidate
 * @param {?Object} spool - spool object。
 * @param {string} candidateHash - candidateHash。
 * @returns {Array<Object>} matching undo event 配列。
 */
function _undoEventsForCandidate(spool, candidateHash) {
  return _usedLengthLog(spool).filter(item =>
    item
    && item.type === INFERRED_DECISION_UNDO_LEDGER_EVENT_TYPE
    && item.candidateHash === candidateHash
  );
}

/**
 * 監査 issue を作る。
 *
 * @private
 * @function _issue
 * @param {string} severity - issue severity。
 * @param {string} reason - issue reason。
 * @param {Object} data - 追加 metadata。
 * @returns {Object} issue object。
 */
function _issue(severity, reason, data = {}) {
  return {
    severity,
    reason,
    candidateHash: data.candidateHash || null,
    host: data.host || null,
    spoolId: data.spoolId || null,
    eventId: data.eventId || null,
    observationKey: data.observationKey || null,
    details: data.details ? _clone(data.details) : {}
  };
}

/**
 * event snapshot 配列を observation key で引く Map へ変換する。
 *
 * @private
 * @function _snapshotMap
 * @param {Array<Object>} items - historyBefore/historyAfter 配列。
 * @returns {{ok:boolean,map:Map<string,Object>,reason:?string}} snapshot lookup。
 */
function _snapshotMap(items) {
  if (!Array.isArray(items)) return { ok: false, map: new Map(), reason: "history_snapshot_missing" };
  const map = new Map();
  for (const item of items) {
    const key = String(item?.observationKey ?? "");
    if (!key) return { ok: false, map: new Map(), reason: "history_snapshot_invalid" };
    if (map.has(key)) return { ok: false, map: new Map(), reason: "history_snapshot_ambiguous" };
    map.set(key, item);
  }
  return { ok: true, map, reason: null };
}

/**
 * 現在の履歴 attribution snapshot を O5 event 形式で取得する。
 *
 * @private
 * @function _captureHistoryState
 * @param {Object} entry - 履歴行。
 * @param {string} observationKey - observation key。
 * @returns {Object} 履歴 attribution snapshot。
 */
function _captureHistoryState(entry, observationKey) {
  const hasFilamentInfo = Object.hasOwn(entry, "filamentInfo");
  const hasFilamentId = Object.hasOwn(entry, "filamentId");
  return {
    observationKey: String(observationKey ?? ""),
    filamentInfoPresent: hasFilamentInfo,
    filamentInfo: hasFilamentInfo ? _clone(entry.filamentInfo) : null,
    filamentIdPresent: hasFilamentId,
    filamentId: hasFilamentId ? _clone(entry.filamentId) : null
  };
}

/**
 * candidate の履歴 attribution が event snapshot と一致するか検査する。
 *
 * @private
 * @function _checkHistoryState
 * @param {Object} record - candidate record。
 * @param {Object} decisionEvent - O5 confirmed event。
 * @param {boolean} expectAfter - true なら historyAfter、false なら historyBefore と比較する。
 * @returns {Array<Object>} issue 配列。
 */
function _checkHistoryState(record, decisionEvent, expectAfter) {
  const issues = [];
  const fieldName = expectAfter ? "historyAfter" : "historyBefore";
  const snapshots = _snapshotMap(decisionEvent?.[fieldName]);
  if (!snapshots.ok) {
    issues.push(_issue(INFERRED_RECONCILIATION_SEVERITY.BLOCKER, snapshots.reason, {
      candidateHash: record.candidateHash,
      host: record.host,
      spoolId: decisionEvent?.spoolId,
      eventId: decisionEvent?.eventId,
      details: { fieldName }
    }));
    return issues;
  }

  const history = _historyForHost(record.host);
  const byKey = _historyByObservationKey(history);
  for (const key of Array.isArray(decisionEvent?.observationKeys) ? decisionEvent.observationKeys.map(String) : []) {
    const lookup = byKey.get(key);
    if (!lookup) {
      issues.push(_issue(INFERRED_RECONCILIATION_SEVERITY.BLOCKER, "history_entry_missing", {
        candidateHash: record.candidateHash,
        host: record.host,
        spoolId: decisionEvent?.spoolId,
        eventId: decisionEvent?.eventId,
        observationKey: key
      }));
      continue;
    }
    if (lookup.status !== "unique" || lookup.entries.length !== 1) {
      issues.push(_issue(INFERRED_RECONCILIATION_SEVERITY.BLOCKER, "history_observation_ambiguous", {
        candidateHash: record.candidateHash,
        host: record.host,
        spoolId: decisionEvent?.spoolId,
        eventId: decisionEvent?.eventId,
        observationKey: key
      }));
      continue;
    }
    const expected = snapshots.map.get(key);
    if (!expected) {
      issues.push(_issue(INFERRED_RECONCILIATION_SEVERITY.BLOCKER, "history_snapshot_key_missing", {
        candidateHash: record.candidateHash,
        host: record.host,
        spoolId: decisionEvent?.spoolId,
        eventId: decisionEvent?.eventId,
        observationKey: key,
        details: { fieldName }
      }));
      continue;
    }
    const current = _captureHistoryState(lookup.entries[0], key);
    if (!_sameJson(current, expected)) {
      issues.push(_issue(INFERRED_RECONCILIATION_SEVERITY.BLOCKER, "history_attribution_mismatch", {
        candidateHash: record.candidateHash,
        host: record.host,
        spoolId: decisionEvent?.spoolId,
        eventId: decisionEvent?.eventId,
        observationKey: key,
        details: { expectedField: fieldName }
      }));
    }
  }
  return issues;
}

/**
 * resolved candidate と O5 ledger event の整合を検査する。
 *
 * @private
 * @function _checkResolvedCandidate
 * @param {Object} record - candidate record。
 * @returns {Array<Object>} issue 配列。
 */
function _checkResolvedCandidate(record) {
  const issues = [];
  const spoolId = _resolvedSpoolId(record);
  const spool = _spoolById(spoolId);
  if (!spool) {
    return [_issue(INFERRED_RECONCILIATION_SEVERITY.BLOCKER, "resolved_spool_missing", {
      candidateHash: record.candidateHash,
      host: record.host,
      spoolId
    })];
  }
  const decisionEvents = _decisionEventsForCandidate(spool, record.candidateHash);
  if (decisionEvents.length === 0) {
    return [_issue(INFERRED_RECONCILIATION_SEVERITY.BLOCKER, "candidate_ledger_event_missing", {
      candidateHash: record.candidateHash,
      host: record.host,
      spoolId
    })];
  }
  if (decisionEvents.length > 1) {
    issues.push(_issue(INFERRED_RECONCILIATION_SEVERITY.BLOCKER, "candidate_ledger_event_ambiguous", {
      candidateHash: record.candidateHash,
      host: record.host,
      spoolId,
      details: { eventCount: decisionEvents.length }
    }));
    return issues;
  }

  const event = decisionEvents[0];
  const keyIssue = _checkObservationKeys(record, event);
  if (keyIssue) issues.push(keyIssue);
  const usedMm = _positiveMm(record.usedMm);
  const debitTotalMm = _candidateDebitTotalMm(record);
  const eventUsedMm = _positiveMm(event.usedMm);
  if (Math.abs(usedMm - debitTotalMm) > 0.001 || Math.abs(usedMm - eventUsedMm) > 0.001) {
    issues.push(_issue(INFERRED_RECONCILIATION_SEVERITY.BLOCKER, "candidate_ledger_used_mm_mismatch", {
      candidateHash: record.candidateHash,
      host: record.host,
      spoolId,
      eventId: event.eventId,
      details: { usedMm, debitTotalMm, eventUsedMm }
    }));
  }
  if (String(event.host ?? "") !== String(record.host ?? "")) {
    issues.push(_issue(INFERRED_RECONCILIATION_SEVERITY.BLOCKER, "candidate_ledger_host_mismatch", {
      candidateHash: record.candidateHash,
      host: record.host,
      spoolId,
      eventId: event.eventId,
      details: { eventHost: event.host }
    }));
  }
  if (String(event.spoolId ?? "") !== String(spoolId ?? "")) {
    issues.push(_issue(INFERRED_RECONCILIATION_SEVERITY.BLOCKER, "candidate_ledger_spool_mismatch", {
      candidateHash: record.candidateHash,
      host: record.host,
      spoolId,
      eventId: event.eventId,
      details: { eventSpoolId: event.spoolId }
    }));
  }
  issues.push(..._checkHistoryState(record, event, true));
  return issues;
}

/**
 * undone candidate と O5 Undo 逆仕訳 event の整合を検査する。
 *
 * @private
 * @function _checkUndoneCandidate
 * @param {Object} record - candidate record。
 * @returns {Array<Object>} issue 配列。
 */
function _checkUndoneCandidate(record) {
  const issues = [];
  const spoolId = _resolvedSpoolId(record);
  const spool = _spoolById(spoolId);
  if (!spool) {
    return [_issue(INFERRED_RECONCILIATION_SEVERITY.BLOCKER, "resolved_spool_missing", {
      candidateHash: record.candidateHash,
      host: record.host,
      spoolId
    })];
  }
  const decisionEvents = _decisionEventsForCandidate(spool, record.candidateHash);
  const undoEvents = _undoEventsForCandidate(spool, record.candidateHash);
  if (decisionEvents.length !== 1) {
    issues.push(_issue(INFERRED_RECONCILIATION_SEVERITY.BLOCKER, "candidate_ledger_event_missing_or_ambiguous", {
      candidateHash: record.candidateHash,
      host: record.host,
      spoolId,
      details: { eventCount: decisionEvents.length }
    }));
    return issues;
  }
  if (undoEvents.length !== 1) {
    issues.push(_issue(INFERRED_RECONCILIATION_SEVERITY.BLOCKER, "candidate_undo_event_missing_or_ambiguous", {
      candidateHash: record.candidateHash,
      host: record.host,
      spoolId,
      details: { undoEventCount: undoEvents.length }
    }));
    return issues;
  }
  const decision = decisionEvents[0];
  const undo = undoEvents[0];
  const keyIssue = _checkObservationKeys(record, decision);
  if (keyIssue) issues.push(keyIssue);
  if (String(undo.reversesEventId ?? "") !== String(decision.eventId ?? "")) {
    issues.push(_issue(INFERRED_RECONCILIATION_SEVERITY.BLOCKER, "candidate_undo_reversal_mismatch", {
      candidateHash: record.candidateHash,
      host: record.host,
      spoolId,
      eventId: undo.eventId,
      details: { reversesEventId: undo.reversesEventId, decisionEventId: decision.eventId }
    }));
  }
  if (Math.abs(_positiveMm(undo.usedMm) - _positiveMm(decision.usedMm)) > 0.001) {
    issues.push(_issue(INFERRED_RECONCILIATION_SEVERITY.BLOCKER, "candidate_undo_used_mm_mismatch", {
      candidateHash: record.candidateHash,
      host: record.host,
      spoolId,
      eventId: undo.eventId,
      details: { undoUsedMm: undo.usedMm, decisionUsedMm: decision.usedMm }
    }));
  }
  issues.push(..._checkHistoryState(record, decision, false));
  return issues;
}

/**
 * 未解決 candidate に確定台帳 event が混入していないか検査する。
 *
 * @private
 * @function _checkUnresolvedCandidate
 * @param {Object} record - candidate record。
 * @returns {Array<Object>} issue 配列。
 */
function _checkUnresolvedCandidate(record) {
  const issues = [];
  for (const spool of _spools()) {
    const decisionEvents = _decisionEventsForCandidate(spool, record.candidateHash);
    if (decisionEvents.length > 0) {
      issues.push(_issue(INFERRED_RECONCILIATION_SEVERITY.BLOCKER, "unresolved_candidate_has_ledger_event", {
        candidateHash: record.candidateHash,
        host: record.host,
        spoolId: spool.id,
        details: { eventCount: decisionEvents.length, status: record.status }
      }));
    }
  }
  return issues;
}

/**
 * orphan O5 ledger event を検出する。
 *
 * @private
 * @function _checkOrphanLedgerEvents
 * @param {Set<string>} knownCandidateHashes - candidate store に存在する hash。
 * @returns {Array<Object>} issue 配列。
 */
function _checkOrphanLedgerEvents(knownCandidateHashes) {
  const issues = [];
  for (const spool of _spools()) {
    for (const event of _usedLengthLog(spool)) {
      if (!event || (event.type !== INFERRED_DECISION_LEDGER_EVENT_TYPE && event.type !== INFERRED_DECISION_UNDO_LEDGER_EVENT_TYPE)) {
        continue;
      }
      const hash = String(event.candidateHash || "");
      if (!hash || knownCandidateHashes.has(hash)) continue;
      issues.push(_issue(INFERRED_RECONCILIATION_SEVERITY.BLOCKER, "orphan_inferred_ledger_event", {
        candidateHash: hash || null,
        host: event.host || null,
        spoolId: spool.id,
        eventId: event.eventId,
        details: { type: event.type }
      }));
    }
  }
  return issues;
}

/**
 * 推定 candidate 台帳の read-only 照合結果を生成する。
 *
 * 【詳細説明】
 * - O5 が扱う `inferredCandidateStore` と `spool.usedLengthLog` の O5 event、履歴 attribution snapshot
 *   を読み取り、構造的不一致を issue として返す。
 * - この関数は監査専用であり、検出した不一致を自動修復しない。
 * - `remainingLengthMm` の完全再計算は通常 print finalize の baseline が必要なため、O7B の対象にする。
 *
 * @function buildInferredLedgerReconciliationReport
 * @param {{nowMs?:number,maxIssues?:number}} [options] - clock と返却 issue 上限。
 * @returns {Object} read-only reconciliation report。
 * @example
 * const report = buildInferredLedgerReconciliationReport();
 */
export function buildInferredLedgerReconciliationReport(options = {}) {
  const issues = [];
  const store = _store();
  const records = Object.values(store).filter(record => record && typeof record === "object");
  const known = new Set(records.map(record => String(record.candidateHash || "")).filter(Boolean));

  for (const record of records) {
    const status = record.status || "unknown";
    if (status === INFERRED_CANDIDATE_STATUS.CONFIRMED || status === INFERRED_CANDIDATE_STATUS.REASSIGNED) {
      issues.push(..._checkResolvedCandidate(record));
    } else if (status === INFERRED_CANDIDATE_STATUS.UNDONE) {
      issues.push(..._checkUndoneCandidate(record));
    } else {
      issues.push(..._checkUnresolvedCandidate(record));
    }
  }
  issues.push(..._checkOrphanLedgerEvents(known));

  const maxIssues = Math.max(1, Math.min(100, Number(options.maxIssues) || 20));
  const limitedIssues = issues.slice(0, maxIssues);
  const blockerCount = issues.filter(issue => issue.severity === INFERRED_RECONCILIATION_SEVERITY.BLOCKER).length;
  const warningCount = issues.filter(issue => issue.severity === INFERRED_RECONCILIATION_SEVERITY.WARNING).length;
  const infoCount = issues.filter(issue => issue.severity === INFERRED_RECONCILIATION_SEVERITY.INFO).length;
  const decisionEventCount = _spools().reduce((sum, spool) =>
    sum + _usedLengthLog(spool).filter(event => event?.type === INFERRED_DECISION_LEDGER_EVENT_TYPE).length, 0);
  const undoEventCount = _spools().reduce((sum, spool) =>
    sum + _usedLengthLog(spool).filter(event => event?.type === INFERRED_DECISION_UNDO_LEDGER_EVENT_TYPE).length, 0);

  return {
    ok: issues.length === 0,
    status: blockerCount > 0 ? "blocker" : warningCount > 0 ? "warning" : "ok",
    checkedAt: _nowMs(options),
    candidateCount: records.length,
    spoolCount: _spools().length,
    decisionEventCount,
    undoEventCount,
    issueCount: issues.length,
    visibleIssueCount: limitedIssues.length,
    truncated: limitedIssues.length < issues.length,
    blockerCount,
    warningCount,
    infoCount,
    issues: limitedIssues
  };
}
