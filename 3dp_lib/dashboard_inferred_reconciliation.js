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
 * - 再計算可能な spool では `startLength` と `usedLengthLog` から期待残量を計算し、保存残量との
 *   差分を検出する。
 * - monitorData を読み取るだけで、spool 残量・履歴・candidate store・recovery flag は変更しない。
 * - 自動修復は行わず、O6/O7 の Recovery surface へ表示できる issue report を返す。
 *
 * 【公開関数一覧】
 * - {@link buildInferredLedgerReconciliationReport}：推定 candidate 台帳の read-only 照合結果を生成する
 *
 * @version 1.390.1279 (PR #426)
 * @since   1.390.1275 (PR #425)
 * @lastModified 2026-08-04 11:50:46
 * -----------------------------------------------------------
 * @todo
 * - none
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
 * 残量再計算で許容する丸め誤差 [mm]。
 *
 * @constant {number}
 */
const REMAINING_TOLERANCE_MM = 0.1;

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
 * 有限 mm 値へ正規化する。
 *
 * @private
 * @function _finiteMmOrNull
 * @param {*} value - mm 値候補。
 * @returns {?number} 有限値。不正値は null。
 */
function _finiteMmOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 0以上の有限 mm 値へ正規化する。
 *
 * @private
 * @function _nonNegativeMmOrNull
 * @param {*} value - mm 値候補。
 * @returns {?number} 0以上の有限値。不正値は null。
 */
function _nonNegativeMmOrNull(value) {
  const n = _finiteMmOrNull(value);
  return n != null && n >= 0 ? n : null;
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
 * 全 spool 配列を安全に取得する。
 *
 * @private
 * @function _spools
 * @returns {Array<Object>} 削除済みを含む spool 配列。
 */
function _spools() {
  return Array.isArray(monitorData.filamentSpools)
    ? monitorData.filamentSpools.filter(spool => spool)
    : [];
}

/**
 * spool が archive / deleted 相当か判定する。
 *
 * @private
 * @function _isArchivedSpool
 * @param {?Object} spool - spool object。
 * @returns {boolean} 廃棄・削除済みなら true。
 */
function _isArchivedSpool(spool) {
  return !!(spool?.deleted || spool?.isDeleted);
}

/**
 * 残量再計算対象の active spool 配列を返す。
 *
 * @private
 * @function _activeSpools
 * @returns {Array<Object>} active spool 配列。
 */
function _activeSpools() {
  return _spools().filter(spool => !_isArchivedSpool(spool));
}

/**
 * spool ID から spool を取得する。
 *
 * @private
 * @function _spoolById
 * @param {?string} spoolId - spool ID。
 * @returns {?Object} 削除済みを含む spool。存在しない場合は null。
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
 * usedLengthLog の1行を残量再計算用 delta へ変換する。
 *
 * 【詳細説明】
 * - 通常 print finalize の `{jobId, used}` は残量を減らす正の delta として扱う。
 * - O5 Confirm/Reassign の confirmed event は `usedMm` を正の delta として扱う。
 * - O5 Undo の undone event は `usedMm` を負の delta として扱い、逆仕訳として残量を戻す。
 * - 未知 typed event や不正値は再計算を壊さないよう `ok:false` で返し、呼び出し側が
 *   unverifiable issue に変換する。
 *
 * @private
 * @function _usedLengthDelta
 * @param {Object} entry - usedLengthLog entry。
 * @returns {{ok:boolean,deltaMm:number,kind:string,reason:?string}} 残量計算 delta。
 */
function _usedLengthDelta(entry) {
  if (!entry || typeof entry !== "object") {
    return { ok: false, deltaMm: 0, kind: "invalid", reason: "used_length_log_entry_invalid" };
  }
  if (entry.type === INFERRED_DECISION_LEDGER_EVENT_TYPE) {
    const usedMm = _positiveMm(entry.usedMm);
    if (usedMm <= 0) return { ok: false, deltaMm: 0, kind: "inferred-confirmed", reason: "inferred_event_used_mm_invalid" };
    return { ok: true, deltaMm: usedMm, kind: "inferred-confirmed", reason: null };
  }
  if (entry.type === INFERRED_DECISION_UNDO_LEDGER_EVENT_TYPE) {
    const usedMm = _positiveMm(entry.usedMm);
    if (usedMm <= 0) return { ok: false, deltaMm: 0, kind: "inferred-undone", reason: "inferred_undo_used_mm_invalid" };
    return { ok: true, deltaMm: -usedMm, kind: "inferred-undone", reason: null };
  }
  if (entry.type) {
    return { ok: false, deltaMm: 0, kind: "unknown-typed", reason: "used_length_log_type_unknown" };
  }
  const used = _nonNegativeMmOrNull(entry.used);
  if (used == null) return { ok: false, deltaMm: 0, kind: "print-finalize", reason: "used_length_log_used_invalid" };
  return { ok: true, deltaMm: used, kind: "print-finalize", reason: null };
}

/**
 * spool から残量再計算用 baseline を取得する。
 *
 * 【詳細説明】
 * - `startLength` は再装着時に現在残量へ更新されるため、usedLengthLog 全件の基点とは限らない。
 * - `remainingLedgerBaseline` などの明示 boundary がある場合だけ、そこから後続 log を再計算する。
 * - baseline が無く log が存在する場合は、旧データ・再装着・手動補正の境界を証明できないため
 *   `remaining_baseline_boundary_unknown` として fail-safe に unverifiable へ落とす。
 *
 * @private
 * @function _remainingLedgerBaseline
 * @param {Object} spool - spool object。
 * @param {Array<Object>} log - usedLengthLog。
 * @returns {{ok:boolean,reason:?string,remainingLengthMm:?number,usedLengthLogIndex:number,source:string}}
 *   baseline 情報。
 */
function _remainingLedgerBaseline(spool, log) {
  const candidates = [
    { source: "remainingLedgerBaseline", value: spool?.remainingLedgerBaseline },
    { source: "ledgerBaseline", value: spool?.ledgerBaseline },
    { source: "remainingBalanceBaseline", value: spool?.remainingBalanceBaseline }
  ];
  for (const candidate of candidates) {
    const value = candidate.value;
    if (!value || typeof value !== "object") continue;
    const remainingLengthMm = _finiteMmOrNull(
      value.remainingLengthMm ?? value.remainingMm ?? value.startLengthMm ?? value.startLength
    );
    const rawIndex = Number(value.usedLengthLogIndex ?? value.logIndex ?? 0);
    if (remainingLengthMm == null) {
      return { ok: false, reason: "remaining_baseline_length_unknown", remainingLengthMm: null, usedLengthLogIndex: 0, source: candidate.source };
    }
    if (!Number.isInteger(rawIndex) || rawIndex < 0 || rawIndex > log.length) {
      return { ok: false, reason: "remaining_baseline_log_index_invalid", remainingLengthMm: null, usedLengthLogIndex: 0, source: candidate.source };
    }
    return {
      ok: true,
      reason: null,
      remainingLengthMm,
      usedLengthLogIndex: rawIndex,
      source: candidate.source
    };
  }
  if (log.length === 0) {
    const startLengthMm = _nonNegativeMmOrNull(spool?.startLength);
    if (startLengthMm != null) {
      return { ok: true, reason: null, remainingLengthMm: startLengthMm, usedLengthLogIndex: 0, source: "startLength-empty-log" };
    }
  }
  return {
    ok: false,
    reason: log.length > 0 ? "remaining_baseline_boundary_unknown" : "remaining_baseline_missing",
    remainingLengthMm: null,
    usedLengthLogIndex: 0,
    source: "none"
  };
}

/**
 * issue reason から read-only 修復方針を返す。
 *
 * 【詳細説明】
 * - O7 は自動修復を行わないため、issue には次に確認すべき運用操作や調査対象を添える。
 * - ここで返す値は UI/レビュー用の提案であり、実際の台帳変更は O6/O7 の明示操作だけが行う。
 *
 * @private
 * @function _repairHintForReason
 * @param {string} reason - issue reason。
 * @returns {string} 推奨される確認・修復方針。
 */
function _repairHintForReason(reason) {
  if (reason === "spool_remaining_recalculation_mismatch") return "verify-spool-balance-and-repair-ledger";
  if (reason === "spool_balance_unverifiable") return "inspect-used-length-log-baseline";
  if (reason === "spool_negative_remaining") return "review-negative-remaining-ledger";
  if (reason === "orphan_inferred_ledger_event") return "restore-candidate-or-append-reversal";
  if (reason === "unresolved_candidate_has_ledger_event") return "resolve-candidate-status-or-reverse-ledger-event";
  if (reason === "candidate_ledger_event_missing") return "restore-ledger-event-or-reopen-candidate";
  if (reason === "candidate_undo_event_missing_or_ambiguous") return "inspect-undo-ledger-events";
  if (reason === "history_attribution_mismatch") return "inspect-history-attribution-before-undo";
  if (reason.includes("history")) return "inspect-print-history-snapshots";
  if (reason.includes("undo")) return "inspect-undo-ledger-events";
  if (reason.includes("ledger")) return "inspect-candidate-ledger-events";
  return "manual-reconciliation-required";
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
    repairHint: data.repairHint || _repairHintForReason(reason),
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
 * spool の startLength と usedLengthLog から期待残量を再計算する。
 *
 * 【詳細説明】
 * - `startLength` はこの spool の台帳開始点であり、通常 print finalize と O5 inferred decision の
 *   delta をすべて差し引くことで期待残量を求める。
 * - `startLength` や `remainingLengthMm` が不明な spool は、古い import や手動編集の可能性があるため
 *   issue にはせず `status:"unverifiable"` として集計だけ行う。
 * - usedLengthLog 内の不正 entry は再計算結果を信用できないため warning issue を返す。
 *
 * @private
 * @function _checkSpoolRemainingBalance
 * @param {Object} spool - spool object。
 * @returns {{balance:Object,issues:Array<Object>}} balance と issue 配列。
 */
function _checkSpoolRemainingBalance(spool) {
  const spoolId = spool?.id == null ? null : String(spool.id);
  const startLengthMm = _nonNegativeMmOrNull(spool?.startLength);
  const remainingLengthMm = _finiteMmOrNull(spool?.remainingLengthMm);
  const log = _usedLengthLog(spool);
  const base = {
    spoolId,
    startLengthMm,
    remainingLengthMm,
    baselineRemainingMm: null,
    usedLengthLogStartIndex: null,
    baselineSource: null,
    expectedRemainingMm: null,
    rawExpectedRemainingMm: null,
    netUsedMm: null,
    deltaMm: null,
    status: "unverifiable",
    reason: null,
    logCount: log.length
  };
  if (!spoolId) {
    return {
      balance: { ...base, reason: "spool_id_missing" },
      issues: [_issue(INFERRED_RECONCILIATION_SEVERITY.WARNING, "spool_balance_unverifiable", {
        spoolId,
        details: { reason: "spool_id_missing" }
      })]
    };
  }
  if (remainingLengthMm == null) {
    return {
      balance: {
        ...base,
        reason: "remaining_length_unknown"
      },
      issues: []
    };
  }

  const baseline = _remainingLedgerBaseline(spool, log);
  if (!baseline.ok) {
    const baselineIssues = log.length > 0
      ? [_issue(INFERRED_RECONCILIATION_SEVERITY.WARNING, "spool_balance_unverifiable", {
        spoolId,
        details: { reason: baseline.reason, baselineSource: baseline.source, logCount: log.length }
      })]
      : [];
    return {
      balance: {
        ...base,
        reason: baseline.reason,
        baselineSource: baseline.source
      },
      issues: baselineIssues
    };
  }

  let netUsedMm = 0;
  const issues = [];
  for (let index = baseline.usedLengthLogIndex; index < log.length; index++) {
    const delta = _usedLengthDelta(log[index]);
    if (!delta.ok) {
      issues.push(_issue(INFERRED_RECONCILIATION_SEVERITY.WARNING, "spool_balance_unverifiable", {
        spoolId,
        eventId: log[index]?.eventId || null,
        repairHint: "inspect-used-length-log-entry",
        details: {
          reason: delta.reason,
          index,
          kind: delta.kind
        }
      }));
      return {
        balance: {
          ...base,
          baselineRemainingMm: baseline.remainingLengthMm,
          usedLengthLogStartIndex: baseline.usedLengthLogIndex,
          baselineSource: baseline.source,
          status: "unverifiable",
          reason: delta.reason
        },
        issues
      };
    }
    netUsedMm += delta.deltaMm;
  }

  const expectedRemainingMm = baseline.remainingLengthMm - netUsedMm;
  const deltaMm = remainingLengthMm - expectedRemainingMm;
  const ok = Math.abs(deltaMm) <= REMAINING_TOLERANCE_MM;
  const balance = {
    ...base,
    baselineRemainingMm: baseline.remainingLengthMm,
    usedLengthLogStartIndex: baseline.usedLengthLogIndex,
    baselineSource: baseline.source,
    expectedRemainingMm,
    rawExpectedRemainingMm: expectedRemainingMm,
    netUsedMm,
    deltaMm,
    status: ok ? (expectedRemainingMm < 0 ? "negative-but-accounted" : "ok") : "mismatch",
    reason: ok ? (expectedRemainingMm < 0 ? "negative_remaining_accounted" : null) : "remaining_length_mismatch"
  };
  if (ok && expectedRemainingMm < 0) {
    issues.push(_issue(INFERRED_RECONCILIATION_SEVERITY.WARNING, "spool_negative_remaining", {
      spoolId,
      details: {
        baselineRemainingMm: baseline.remainingLengthMm,
        usedLengthLogStartIndex: baseline.usedLengthLogIndex,
        netUsedMm,
        expectedRemainingMm,
        remainingLengthMm
      }
    }));
  }
  if (!ok) {
    issues.push(_issue(INFERRED_RECONCILIATION_SEVERITY.BLOCKER, "spool_remaining_recalculation_mismatch", {
      spoolId,
      details: {
        startLengthMm,
        baselineRemainingMm: baseline.remainingLengthMm,
        usedLengthLogStartIndex: baseline.usedLengthLogIndex,
        netUsedMm,
        expectedRemainingMm,
        remainingLengthMm,
        deltaMm
      }
    }));
  }
  return { balance, issues };
}

/**
 * 全 active spool の残量再計算結果を作る。
 *
 * @private
 * @function _checkSpoolRemainingBalances
 * @returns {{balances:Array<Object>,issues:Array<Object>}} balance report。
 */
function _checkSpoolRemainingBalances() {
  const balances = [];
  const issues = [];
  for (const spool of _activeSpools()) {
    const result = _checkSpoolRemainingBalance(spool);
    balances.push(result.balance);
    issues.push(...result.issues);
  }
  return { balances, issues };
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
  const remainingBalances = _checkSpoolRemainingBalances();
  issues.push(...remainingBalances.issues);

  const maxIssues = Math.max(1, Math.min(100, Number(options.maxIssues) || 20));
  const limitedIssues = issues.slice(0, maxIssues);
  const blockerCount = issues.filter(issue => issue.severity === INFERRED_RECONCILIATION_SEVERITY.BLOCKER).length;
  const warningCount = issues.filter(issue => issue.severity === INFERRED_RECONCILIATION_SEVERITY.WARNING).length;
  const infoCount = issues.filter(issue => issue.severity === INFERRED_RECONCILIATION_SEVERITY.INFO).length;
  const decisionEventCount = _spools().reduce((sum, spool) =>
    sum + _usedLengthLog(spool).filter(event => event?.type === INFERRED_DECISION_LEDGER_EVENT_TYPE).length, 0);
  const undoEventCount = _spools().reduce((sum, spool) =>
    sum + _usedLengthLog(spool).filter(event => event?.type === INFERRED_DECISION_UNDO_LEDGER_EVENT_TYPE).length, 0);
  const remainingBalanceOkCount = remainingBalances.balances.filter(item => item.status === "ok").length;
  const remainingBalanceNegativeCount = remainingBalances.balances.filter(item => item.status === "negative-but-accounted").length;
  const remainingBalanceMismatchCount = remainingBalances.balances.filter(item => item.status === "mismatch").length;
  const remainingBalanceUnverifiableCount = remainingBalances.balances.filter(item => item.status === "unverifiable").length;

  return {
    ok: issues.length === 0,
    status: blockerCount > 0 ? "blocker" : warningCount > 0 ? "warning" : "ok",
    checkedAt: _nowMs(options),
    candidateCount: records.length,
    spoolCount: _spools().length,
    decisionEventCount,
    undoEventCount,
    remainingBalanceOkCount,
    remainingBalanceNegativeCount,
    remainingBalanceMismatchCount,
    remainingBalanceUnverifiableCount,
    remainingBalances: remainingBalances.balances,
    issueCount: issues.length,
    visibleIssueCount: limitedIssues.length,
    truncated: limitedIssues.length < issues.length,
    blockerCount,
    warningCount,
    infoCount,
    issues: limitedIssues
  };
}
