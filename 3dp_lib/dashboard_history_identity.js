/**
 * @fileoverview 履歴ジョブの同一性・完了判定の下位純粋ユーティリティ（#411-P1-4）
 * @file dashboard_history_identity.js
 * @copyright (c) pumpCurry 2026 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_history_identity
 *
 * 完了判定・canonical job key・履歴 generation fingerprint を1か所へ集約する。
 * dashboard_spool / dashboard_offline_observation の双方から使い、判定ロジックの二重化を排す。
 * monitorData に依存しない純関数のみ（引数で受ける）。
 *
 * @version 2.3.0
 * @since   2.3.0
 * -----------------------------------------------------------
 */

"use strict";

/**
 * 履歴エントリが「完了」しているかの共通判定。
 * printfinish が正のシグナル。旧保存データは printfinish 欠落でも
 * finishTime/finishTimeSec/endtime/usagetime による完了証拠があれば完了扱いにする。
 *
 * @function isCompletedHistoryEntry
 * @param {Object} entry - 履歴ジョブ
 * @returns {boolean}
 */
export function isCompletedHistoryEntry(entry) {
  if (!entry) return false;
  if (entry.printfinish != null) return true;
  return (Number(entry.finishTime) > 0) || (Number(entry.finishTimeSec) > 0)
    || (Number(entry.endtime) > 0) || (Number(entry.usagetime) > 0);
}

/**
 * ジョブの canonical identity key を返す（#411-P1-2）。
 * Number 化しない（2^53 超・文字列ID・leading zero・複合IDを壊さない）。
 * 有効な job id（空/"0"/null 以外）を String のまま返す。無効は null。
 *
 * @function canonicalJobKey
 * @param {Object|string|number} entryOrId - 履歴ジョブ または id
 * @returns {?string} canonical key（無効なら null）
 */
export function canonicalJobKey(entryOrId) {
  const raw = (entryOrId && typeof entryOrId === "object") ? entryOrId.id : entryOrId;
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === "" || s === "0") return null;
  // 全ゼロ相当（"00"等）や記号のみを弾く（数値0扱いの偽ID防止）。
  if (/^0+$/.test(s)) return null;
  return s;
}

/**
 * 指定履歴配列の「完了ジョブ canonical key 集合」を返す（重複排除・ソート済み）。
 *
 * @function completedJobKeySet
 * @param {Array<Object>} history - printStore.history 配列
 * @returns {string[]} 完了ジョブの canonical key（ユニーク・昇順風の文字列ソート）
 */
export function completedJobKeySet(history) {
  const set = new Set();
  if (Array.isArray(history)) {
    for (const j of history) {
      if (!isCompletedHistoryEntry(j)) continue;
      const k = canonicalJobKey(j);
      if (k != null) set.add(k);
    }
  }
  return [...set].sort();
}

/**
 * 履歴 generation fingerprint を返す（#411-P0-2 ID再利用/世代交代の反証材料）。
 * 件数と最古/最新の完了キー、キー集合サイズを含む。プリンタ履歴の全置換・大幅縮小・
 * ID 再利用を後で検出するために用いる（identity だけでは再起動を検出できないため）。
 *
 * @function historyGenerationFingerprint
 * @param {Array<Object>} history - printStore.history 配列
 * @returns {{count:number, oldestKey:?string, newestKey:?string}}
 */
export function historyGenerationFingerprint(history) {
  const keys = completedJobKeySet(history);
  return {
    count: keys.length,
    oldestKey: keys.length ? keys[0] : null,
    newestKey: keys.length ? keys[keys.length - 1] : null
  };
}
