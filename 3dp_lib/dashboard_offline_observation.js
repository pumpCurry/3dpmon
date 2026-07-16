/**
 * @fileoverview オフライン推定帰属(Option4)の観測 watermark 層 — #411-O1
 * @file dashboard_offline_observation.js
 * @copyright (c) pumpCurry 2026 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_offline_observation
 *
 * 【役割】アプリ稼働中に per-host で「見えていた状態」を記録し（観測 watermark）、
 *   再起動後に「現在の完了履歴 − 停止前観測」でオフライン新規ジョブを特定する材料にする。
 *
 * 【ライフサイクル（レビュー#411 P0-1）】
 *   停止前基準(baseline=hostObservationWatermark)と現セッションの最新観測
 *   (current=hostObservationCurrent)を**別スロット**にする。
 *   - recordHostObservation は current を更新し、baseline は上書きしない
 *     （baseline が無い初回のみ bootstrap＝新規導入は評価対象が無い）。
 *   - computeOfflineWindow は baseline vs 現在履歴でオフライン窓を計算する。
 *   - commitObservationBaseline はオフライン窓「評価後」に current を baseline へ昇格する
 *     （O2 が評価完了後に呼ぶ。O1 では基準を勝手に前進させない）。
 *
 * 【安全境界（レビュー4の絶対条件）】read-only。書き込みは hostObservationWatermark /
 *   hostObservationCurrent（Option4 専用の新規フィールド）のみ。
 *   completionObservationId / completionOpId / opId / intervalId / pendingUnattributedUsage /
 *   mountHistoryRejectedEvents / ledgerRepairRequired / mountHistory / usedLengthLog /
 *   remainingLengthMm には一切触れない。残量は減らさない（O3 以降・ユーザ確認後）。
 *
 * @version 2.3.0
 * @since   2.3.0
 * -----------------------------------------------------------
 */

"use strict";

import { monitorData } from "./dashboard_data.js";
import { wallNowMs } from "./dashboard_time.js";
import { completedJobKeySet, historyGenerationFingerprint } from "./dashboard_history_identity.js";

/** seen key の保持上限（#411-P1-3。世代 fingerprint と併用して再利用/縮小を検出する）。 */
const SEEN_CAP = 5000;

/** per-host observationSequence カウンタ（セッション内の観測回数。監査・鮮度用）。 */
const _obsSeq = new Map();

/**
 * プリンタ同一性シグネチャ（read-only）。取得できる範囲で構成する
 * （host/type/model のみでは再起動を検出できないため、世代反証は computeOfflineWindow で別途行う）。
 * @private
 * @param {string} host
 * @returns {string}
 */
function _identity(host) {
  const sd = monitorData.machines?.[host]?.storedData || {};
  const model = sd.model?.rawValue ?? "";
  const type = monitorData.appSettings?.connectionTargets?.find?.(t => t && t.hostname === host)?.printerType ?? "";
  return `${host}|${type}|${model}`;
}

/**
 * 現在の観測スナップショットを構築する（read-only）。
 * @private
 * @param {string} host
 * @param {{mountIntervalId?:?string, mountIntervalStatus?:string}} opts
 * @returns {Object}
 */
function _buildObservation(host, { mountIntervalId = null, mountIntervalStatus = "unknown" } = {}) {
  const hist = monitorData.machines?.[host]?.printStore?.history;
  let keys = completedJobKeySet(hist); // Set 由来・重複排除済み（#411-P1-1/P1-2）
  if (keys.length > SEEN_CAP) keys = keys.slice(keys.length - SEEN_CAP); // #411-P1-3
  const spoolId = monitorData.hostSpoolMap?.[host] ?? null;
  _obsSeq.set(host, (_obsSeq.get(host) || 0) + 1);
  return {
    observedAtEpochMs: wallNowMs(),
    persistedAt: null,                        // durable commit 時に確定（#411-P1-5）
    observationSequence: _obsSeq.get(host),
    mountedSpoolId: spoolId,
    mountIntervalId: mountIntervalId ?? null, // #411-P0-4: 呼び出し側が明示配線
    mountIntervalStatus: mountIntervalStatus, // ok/none/ambiguous/corrupt/unknown
    observationState: spoolId ? "mounted" : "unmounted", // #411-P0-3
    printerIdentity: _identity(host),
    generation: historyGenerationFingerprint(hist), // #411-P0-2 反証材料
    seenCompletedJobKeys: keys,
    historyCount: keys.length
  };
}

/**
 * アプリ稼働中の観測を per-host に記録する（#411-O1・read-only）。
 * current を更新し、baseline は上書きしない（baseline 未設定の初回のみ bootstrap）。
 *
 * @function recordHostObservation
 * @param {string} host
 * @param {{mountIntervalId?:?string, mountIntervalStatus?:string}} [opts]
 * @returns {?Object} current スナップショット（host 未指定なら null）
 */
export function recordHostObservation(host, opts = {}) {
  if (!host) return null;
  if (!monitorData.hostObservationWatermark || typeof monitorData.hostObservationWatermark !== "object") {
    monitorData.hostObservationWatermark = {};
  }
  if (!monitorData.hostObservationCurrent || typeof monitorData.hostObservationCurrent !== "object") {
    monitorData.hostObservationCurrent = {};
  }
  const snap = _buildObservation(host, opts);
  monitorData.hostObservationCurrent[host] = snap;
  // ★ P0-1: 既存 baseline は評価前に上書きしない。無い初回のみ bootstrap（新規導入＝offline無し）。
  if (!monitorData.hostObservationWatermark[host]) {
    monitorData.hostObservationWatermark[host] = { ...snap, committedReason: "bootstrap", persistedAt: wallNowMs() };
  }
  return snap;
}

/**
 * オフライン窓「評価後」に current を baseline へ昇格する（#411-O1。O2 が評価完了後に呼ぶ）。
 *
 * @function commitObservationBaseline
 * @param {string} host
 * @param {{reason?:string}} [opts]
 * @returns {?Object} 新しい baseline（current 未設定なら null）
 */
export function commitObservationBaseline(host, { reason = "committed" } = {}) {
  if (!host) return null;
  const cur = monitorData.hostObservationCurrent?.[host];
  if (!cur) return null;
  if (!monitorData.hostObservationWatermark || typeof monitorData.hostObservationWatermark !== "object") {
    monitorData.hostObservationWatermark = {};
  }
  monitorData.hostObservationWatermark[host] = { ...cur, committedReason: reason, persistedAt: wallNowMs() };
  return monitorData.hostObservationWatermark[host];
}

/**
 * 「アプリ停止中に新たに現れた完了ジョブ」を集合差分で求める純関数（#411-O1/O2 の基盤）。
 *
 * offlineJobKeys = 現在の完了 key 集合 − baseline の seen 集合。ただし以下は
 * bounded=false（同じ窓と断定しない）:
 *   - 前回観測が無い（初回導入/移行）
 *   - printer identity 変化
 *   - 履歴 generation 交代の反証（#411-P0-2）: baseline seen の過半が現在履歴から消えた／
 *     現在履歴が baseline の半分未満へ縮小（＝履歴全置換・ID 再利用の疑い）
 *
 * @function computeOfflineWindow
 * @param {string} host
 * @returns {{bounded:boolean, offlineJobKeys:string[], reason:string,
 *            identityChanged:boolean, generationChanged:boolean,
 *            stalenessMs:?number, watermark:?Object}}
 */
export function computeOfflineWindow(host) {
  const wm = monitorData.hostObservationWatermark?.[host] || null;
  const hist = monitorData.machines?.[host]?.printStore?.history;
  const currentKeys = completedJobKeySet(hist);
  if (!wm || !Array.isArray(wm.seenCompletedJobKeys)) {
    return { bounded: false, offlineJobKeys: [], reason: "no-prior-observation",
      identityChanged: false, generationChanged: false, stalenessMs: null, watermark: wm };
  }
  const identityChanged = wm.printerIdentity !== _identity(host);
  const seen = new Set(wm.seenCompletedJobKeys);
  const currentSet = new Set(currentKeys);
  // #411-P0-2: 世代交代/ID 再利用の反証。
  const priorCount = wm.seenCompletedJobKeys.length;
  const missing = priorCount ? wm.seenCompletedJobKeys.filter(k => !currentSet.has(k)).length : 0;
  const mostMissing = priorCount > 0 && missing > Math.floor(priorCount * 0.5);
  const shrunk = currentKeys.length < Math.floor((Number(wm.historyCount) || 0) * 0.5);
  const generationChanged = identityChanged || mostMissing || shrunk;

  const offlineJobKeys = currentKeys.filter(k => !seen.has(k));
  let reason;
  if (identityChanged) reason = "printer-identity-changed";
  else if (mostMissing) reason = "history-generation-changed";
  else if (shrunk) reason = "history-shrunk";
  else reason = "diff-ok";

  const persistedAt = Number(wm.persistedAt) || Number(wm.observedAtEpochMs) || 0;
  const stalenessMs = persistedAt > 0 ? Math.max(0, wallNowMs() - persistedAt) : null;

  return { bounded: !generationChanged, offlineJobKeys, reason,
    identityChanged, generationChanged, stalenessMs, watermark: wm };
}

/**
 * confidence（推定確度）を reasons 付きで組み立てる純関数（#411 で schema 先行導入）。
 * remaining には一切影響しない（表示・監査用の宣言のみ）。
 *
 * @function buildConfidence
 * @param {"high"|"medium"|"low"|"none"} level
 * @param {string[]} [reasons] - 根拠コード（seen-job/continuous-print/no-spool-change/elapsed-time/stale-watermark 等）
 * @returns {{level:string, reasons:string[]}}
 */
export function buildConfidence(level, reasons = []) {
  const lv = ["high", "medium", "low", "none"].includes(level) ? level : "none";
  return { level: lv, reasons: Array.isArray(reasons) ? reasons.slice() : [] };
}
