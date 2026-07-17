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
 * ジョブの完了時刻/開始時刻/ファイル同一性を抽出する（read-only・ベストエフォート）。
 * printStore.history のスキーマ差異を吸収する。
 *
 * @function jobTemporal
 * @param {Object} entry - 履歴ジョブ
 * @returns {{startAt:number, finishAt:number, fileSig:string}}
 */
export function jobTemporal(entry) {
  const startAt = Number(entry?.printStartTime) || Number(entry?.starttime)
    || Number(entry?.startTime) || Number(entry?.id) || 0; // K1: id = 開始 epoch 秒
  const finishAt = Number(entry?.finishTime) || Number(entry?.finishTimeSec)
    || Number(entry?.endtime) || 0;
  const fileSig = String(entry?.filemd5 ?? entry?.filename ?? entry?.file ?? "");
  return { startAt, finishAt, fileSig };
}

/**
 * ジョブの「物理実行を識別する複合観測キー」を返す（#411-P0-1）。
 * 単なる job id では、プリンタ再起動で同じ id が別の物理印刷へ再利用された場合に区別できない。
 * id ＋ 開始/完了時刻 ＋ ファイル同一性で同一実行を識別する。表示用 id は別途 canonicalJobKey。
 *
 * @function jobObservationKey
 * @param {Object} entry - 履歴ジョブ
 * @returns {?{key:string, id:string, hasDistinguishing:boolean, finishAt:number}}
 *   識別不能（有効 id 無し）なら null。hasDistinguishing=false は「id 以外の識別材料が無い」。
 */
export function jobObservationKey(entry) {
  const id = canonicalJobKey(entry);
  if (id == null) return null;
  const { startAt, finishAt, fileSig } = jobTemporal(entry);
  // 開始が id と同源(=id を start に使った)場合は識別材料に数えない。
  const startDistinct = startAt > 0 && String(startAt) !== id;
  const hasDistinguishing = finishAt > 0 || fileSig !== "" || startDistinct;
  const key = `${id}|s${startAt}|f${finishAt}|${fileSig}`;
  return { key, id, hasDistinguishing, finishAt };
}

/**
 * 完了ジョブの複合観測キー配列（完了時刻→キーで安定ソート・重複排除）を返す（#411-P0-1/P0-2）。
 *
 * @function completedJobObservations
 * @param {Array<Object>} history - printStore.history 配列
 * @returns {Array<{key:string, id:string, hasDistinguishing:boolean, finishAt:number}>}
 *   completion 時系列（finishAt 昇順、tie-break key）で安定ソート済み・キー重複排除済み。
 */
export function completedJobObservations(history) {
  const seen = new Set();
  const obs = [];
  if (Array.isArray(history)) {
    for (const j of history) {
      if (!isCompletedHistoryEntry(j)) continue;
      const o = jobObservationKey(j);
      if (!o || seen.has(o.key)) continue;
      seen.add(o.key);
      obs.push(o);
    }
  }
  // ★ #411-P1-4: 文字列 sort ではなく completion 時系列（finishAt）で安定ソート。
  obs.sort((a, b) => (a.finishAt - b.finishAt) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return obs;
}

/** 決定論的な軽量ハッシュ（FNV-1a 32bit 相当）。 */
function _hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/**
 * 履歴 generation fingerprint を返す（#411-P0-2・時系列ベース）。
 * completion 時刻の最古/最新、件数、順序ハッシュを含む。文字列 sort ではなく時系列で構成し、
 * computeOfflineWindow で baseline/current を実際に比較して世代交代・時刻巻き戻り・ID 再利用を検出する。
 *
 * @function historyGenerationFingerprint
 * @param {Array<Object>} history - printStore.history 配列
 * @returns {{count:number, earliestAt:number, latestAt:number, hash:string}}
 */
export function historyGenerationFingerprint(history) {
  const obs = completedJobObservations(history);
  const finishes = obs.map(o => o.finishAt).filter(t => t > 0);
  return {
    count: obs.length,
    earliestAt: finishes.length ? Math.min(...finishes) : 0,
    latestAt: finishes.length ? Math.max(...finishes) : 0,
    hash: _hash(obs.map(o => o.key).join("\n"))
  };
}

/**
 * 完了ジョブの表示用 canonical id 集合（重複排除・文字列ソート）。表示/関連付け用。
 * ※ 集合差分（オフライン窓）には jobObservationKey（複合キー）を使うこと。
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
