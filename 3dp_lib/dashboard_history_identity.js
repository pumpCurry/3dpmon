/**
 * @fileoverview 履歴ジョブの同一性・完了判定の下位純粋ユーティリティ（#411）
 * @file dashboard_history_identity.js
 * @copyright (c) pumpCurry 2026 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_history_identity
 *
 * 完了判定・canonical job id・複合観測 identity・履歴 generation fingerprint を1か所へ集約する。
 * monitorData に依存しない純関数のみ。
 *
 * @version 2.3.0
 * @since   2.3.0
 * -----------------------------------------------------------
 */

"use strict";

/**
 * 履歴エントリが「完了」しているかの共通判定。
 * printfinish は完了フラグ（1=成功/0=失敗、いずれも「完了」。null=未完了）。旧保存データは
 * printfinish 欠落でも finishTime/finishTimeSec/endtime/usagetime による完了証拠があれば完了扱い。
 *
 * @function isCompletedHistoryEntry
 * @param {Object} entry
 * @returns {boolean}
 */
export function isCompletedHistoryEntry(entry) {
  if (!entry) return false;
  // printfinish は数値フラグのみ完了扱い（空文字等の曖昧値は完了証拠にしない）。
  if (typeof entry.printfinish === "number") return true;
  if (typeof entry.printfinish === "boolean") return true; // 明示 true/false は「完了(成/否)」
  return (Number(entry.finishTime) > 0) || (Number(entry.finishTimeSec) > 0)
    || (Number(entry.endtime) > 0) || (Number(entry.usagetime) > 0);
}

/**
 * ジョブの canonical identity key（表示・関連付け用。Number 化しない＝精度損失なし）。
 * 有効な job id（空/"0"/全ゼロ 以外）を String のまま返す。無効は null。
 *
 * @function canonicalJobKey
 * @param {Object|string|number} entryOrId
 * @returns {?string}
 */
export function canonicalJobKey(entryOrId) {
  const raw = (entryOrId && typeof entryOrId === "object") ? entryOrId.id : entryOrId;
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === "" || /^0+$/.test(s)) return null;
  return s;
}

/**
 * epoch 値を ms へ正規化する（秒/ミリ秒を自動判定）。判定不能は 0。
 * @private
 * @param {*} v
 * @returns {number} epoch ms（不明は 0）
 */
function _epochMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 1e12) return Math.floor(n);        // すでに ms
  if (n >= 1e9) return Math.floor(n * 1000);  // 秒 → ms
  return 0;                                    // 小さすぎ＝単位不明
}

/**
 * ファイル同一性を正規化する（OS差異・URLエンコード・Unicode・大小を吸収）。
 * @private
 * @param {*} f
 * @returns {string}
 */
function _normFile(f) {
  if (f == null) return "";
  let s = String(f).replace(/\\/g, "/");
  try { s = decodeURIComponent(s); } catch { /* 不正 %xx はそのまま */ }
  try { s = s.normalize("NFC"); } catch { /* noop */ }
  return s.toLowerCase();
}

/**
 * ジョブの開始/完了時刻・時刻source を返す（#411-P1-1/P1-3）。
 * ★ id を時刻 fallback にしない（巨大 id の Number 化＝丸め衝突を防ぐ）。
 * finishTimeSec は明示的に秒として *1000。finishTime/endtime は秒/ms 自動判定。
 *
 * @function jobTemporal
 * @param {Object} entry
 * @returns {{startAt:number, finishAt:number, timeSource:string}}  時刻は epoch ms（不明は 0）
 */
export function jobTemporal(entry) {
  const startAt = _epochMs(entry?.printStartTime) || _epochMs(entry?.starttime) || _epochMs(entry?.startTime);
  let finishAt = 0, timeSource = "unknown";
  if (_epochMs(entry?.finishTime)) { finishAt = _epochMs(entry.finishTime); timeSource = "finishTime"; }
  else if (Number(entry?.finishTimeSec) > 0) { finishAt = Math.floor(Number(entry.finishTimeSec) * 1000); timeSource = "finishTimeSec"; }
  else if (_epochMs(entry?.endtime)) { finishAt = _epochMs(entry.endtime); timeSource = "endtime"; }
  return { startAt, finishAt, timeSource };
}

/**
 * ジョブの複合観測 identity（構造体）を返す（#411-P0-1/P1-2）。
 * 文字列連結ではなく構造体＋安定シリアライズでキー化し、区切り文字衝突を排す。
 *
 * @function jobObservationIdentity
 * @param {Object} entry
 * @returns {?{canonicalJobId:string, startAt:?number, finishAt:?number, fileSignature:?string,
 *            timeSource:string, hasDistinguishing:boolean, key:string}}
 */
export function jobObservationIdentity(entry) {
  const canonicalJobId = canonicalJobKey(entry);
  if (canonicalJobId == null) return null;
  const { startAt, finishAt, timeSource } = jobTemporal(entry);
  const fileSignature = _normFile(entry?.filemd5 ?? entry?.filename ?? entry?.file);
  const hasDistinguishing = finishAt > 0 || startAt > 0 || fileSignature !== "";
  // 安定シリアライズ（JSON tuple）＝区切り文字・エスケープ衝突なし。
  const key = JSON.stringify([canonicalJobId, startAt || 0, finishAt || 0, fileSignature]);
  return {
    canonicalJobId,
    startAt: startAt || null,
    finishAt: finishAt || null,
    fileSignature: fileSignature || null,
    timeSource,
    hasDistinguishing,
    key
  };
}

/**
 * 完了ジョブの複合観測 identity 配列（completion 時系列で安定ソート・キー重複排除）。
 *
 * @function completedJobObservations
 * @param {Array<Object>} history
 * @returns {Array<Object>} jobObservationIdentity[]（finishAt 昇順・tie-break startAt→key）
 */
export function completedJobObservations(history) {
  const seen = new Set();
  const obs = [];
  if (Array.isArray(history)) {
    for (const j of history) {
      if (!isCompletedHistoryEntry(j)) continue;
      const o = jobObservationIdentity(j);
      if (!o || seen.has(o.key)) continue;
      seen.add(o.key);
      obs.push(o);
    }
  }
  obs.sort((a, b) =>
    ((a.finishAt || 0) - (b.finishAt || 0))
    || ((a.startAt || 0) - (b.startAt || 0))
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return obs;
}

/** 決定論的な軽量ハッシュ（FNV-1a 32bit 相当）。 */
function _hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

/**
 * 履歴 generation fingerprint（#411-P0-2・completion 時系列ベース）。
 *
 * @function historyGenerationFingerprint
 * @param {Array<Object>} history
 * @returns {{completedCount:number, earliestCompletedAt:number, latestCompletedAt:number, retainedHash:string}}
 */
export function historyGenerationFingerprint(history) {
  const obs = completedJobObservations(history);
  const finishes = obs.map(o => o.finishAt || 0).filter(t => t > 0);
  return {
    completedCount: obs.length,
    earliestCompletedAt: finishes.length ? Math.min(...finishes) : 0,
    latestCompletedAt: finishes.length ? Math.max(...finishes) : 0,
    retainedHash: _hash(obs.map(o => o.key).join("\n"))
  };
}

/**
 * 完了ジョブの表示用 canonical id 集合（重複排除・文字列ソート）。表示/関連付け用。
 * ※ 集合差分（オフライン窓）には jobObservationIdentity.key（複合キー）を使うこと。
 *
 * @function completedJobKeySet
 * @param {Array<Object>} history
 * @returns {string[]}
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
