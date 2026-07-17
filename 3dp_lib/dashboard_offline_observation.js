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
 * 【同一実行の識別（レビュー#411 P0-1）】job id だけではプリンタ再起動で同じ id が別の
 *   物理印刷へ再利用された場合を区別できない。id ＋ 開始/完了時刻 ＋ ファイル同一性の
 *   複合キー（jobObservationKey）を集合差分に使う。識別材料が不足するときは bounded=false。
 *
 * 【世代反証（P0-2）】printer identity 変化に加え、履歴 generation fingerprint（completion 時系列
 *   ベース）を baseline/current で実際に比較し、latest completion 巻き戻り・世代交代・大幅縮小を検出する。
 *
 * 【ライフサイクル（P0-1）】baseline(hostObservationWatermark)と current(hostObservationCurrent)を
 *   別スロット化。record は current のみ更新（baseline 非上書き。未設定初回のみ bootstrap）。
 *   commitObservationBaseline は「窓評価後」に windowId 付きで昇格する（同一 windowId は冪等）。
 *
 * 【安全境界（レビュー4の絶対条件）】read-only。書き込みは hostObservationWatermark /
 *   hostObservationCurrent のみ。completionObservationId/completionOpId/opId/intervalId/
 *   pendingUnattributedUsage/mountHistoryRejectedEvents/ledgerRepairRequired/mountHistory/
 *   usedLengthLog/remainingLengthMm には一切触れない。残量は減らさない（O3 以降・確認後）。
 *
 * @version 2.3.0
 * @since   2.3.0
 * -----------------------------------------------------------
 */

"use strict";

import { monitorData } from "./dashboard_data.js";
import { wallNowMs } from "./dashboard_time.js";
import { completedJobObservations, historyGenerationFingerprint } from "./dashboard_history_identity.js";

/** 観測キーの保持上限（#411-P1-4。completion 時系列で最新のみ保持）。 */
const SEEN_CAP = 5000;
/** 「識別材料不足」とみなす割合しきい（未識別が半数超なら bounded=false）。 */
const INSUFFICIENT_RATIO = 0.5;

/** per-host session observation counter（メモリ。再起動後は baseline/current から継続採番）。 */
const _sessionObsSeq = new Map();

/**
 * プリンタ同一性シグネチャ（read-only・取得できる範囲）。
 * @private @param {string} host @returns {string}
 */
function _identity(host) {
  const sd = monitorData.machines?.[host]?.storedData || {};
  const model = sd.model?.rawValue ?? "";
  const type = monitorData.appSettings?.connectionTargets?.find?.(t => t && t.hostname === host)?.printerType ?? "";
  return `${host}|${type}|${model}`;
}

/**
 * 観測 sequence を継続採番する（#411-P1-3。再起動で 1 へ戻さない）。
 * @private @param {string} host @returns {number}
 */
function _nextSeq(host) {
  const base = Number(monitorData.hostObservationWatermark?.[host]?.observationSequence) || 0;
  const cur = Number(monitorData.hostObservationCurrent?.[host]?.observationSequence) || 0;
  const mem = _sessionObsSeq.get(host) || 0;
  const next = Math.max(base, cur, mem) + 1;
  _sessionObsSeq.set(host, next);
  return next;
}

/**
 * 現在の観測スナップショットを構築する（read-only）。
 * @private
 */
function _buildObservation(host, { mountIntervalId = null, mountIntervalStatus = "unknown" } = {}) {
  const hist = monitorData.machines?.[host]?.printStore?.history;
  const obsAll = completedJobObservations(hist);          // completion 時系列・重複排除済み
  const totalCompletedCount = obsAll.length;
  // ★ P1-4: 文字列順ではなく completion 時系列の「最新 SEEN_CAP 件」を保持。
  const retained = obsAll.length > SEEN_CAP ? obsAll.slice(obsAll.length - SEEN_CAP) : obsAll;
  const spoolId = monitorData.hostSpoolMap?.[host] ?? null;
  return {
    observedAtEpochMs: wallNowMs(),
    persistedAt: null,
    observationSequence: _nextSeq(host),
    mountedSpoolId: spoolId,
    mountIntervalId: mountIntervalId ?? null,
    mountIntervalStatus,                                   // ok/none/ambiguous/corrupt/unknown
    observationState: spoolId ? "mounted" : "unmounted",
    printerIdentity: _identity(host),
    generation: historyGenerationFingerprint(hist),       // 時系列ベース fingerprint
    seenObservationKeys: retained.map(o => o.key),         // 複合キー（diff 基準）
    undistinguishedCount: retained.filter(o => !o.hasDistinguishing).length,
    retainedObservationCount: retained.length,
    totalCompletedCount,
    truncated: totalCompletedCount > retained.length
  };
}

/**
 * アプリ稼働中の観測を per-host に記録する（#411-O1・read-only）。current を更新し baseline は不変。
 * @function recordHostObservation
 * @param {string} host
 * @param {{mountIntervalId?:?string, mountIntervalStatus?:string}} [opts]
 * @returns {?Object}
 */
export function recordHostObservation(host, opts = {}) {
  if (!host) return null;
  if (!monitorData.hostObservationWatermark || typeof monitorData.hostObservationWatermark !== "object") monitorData.hostObservationWatermark = {};
  if (!monitorData.hostObservationCurrent || typeof monitorData.hostObservationCurrent !== "object") monitorData.hostObservationCurrent = {};
  const snap = _buildObservation(host, opts);
  monitorData.hostObservationCurrent[host] = snap;
  // ★ P0-1: 既存 baseline は評価前に上書きしない。無い初回のみ bootstrap（新規導入＝offline無し）。
  if (!monitorData.hostObservationWatermark[host]) {
    monitorData.hostObservationWatermark[host] = {
      ...snap, committedReason: "bootstrap", persistedAt: wallNowMs(),
      baselineObservationSequence: snap.observationSequence, lastCommittedWindowId: "bootstrap"
    };
  }
  return snap;
}

/**
 * オフライン窓「評価後」に current を baseline へ昇格する（#411-O1/P1-2）。
 *
 * ★ commit 順序契約（O2 が守る）: ①window 評価 → ②candidate/report を永続化 →
 *   ③同一 windowId で本関数を呼び baseline 昇格 → ④durable flush。baseline を先に進めない。
 * 同一 windowId の再処理は冪等（既昇格なら no-op）＝クラッシュ後の再実行で二重昇格しない。
 *
 * @function commitObservationBaseline
 * @param {string} host
 * @param {{reason?:string, windowId?:?string, candidatePersistedAt?:?number}} [opts]
 * @returns {?Object} 新しい baseline（未昇格 or current 無しなら null）
 */
export function commitObservationBaseline(host, { reason = "committed", windowId = null, candidatePersistedAt = null } = {}) {
  if (!host) return null;
  const cur = monitorData.hostObservationCurrent?.[host];
  if (!cur) return null;
  if (!monitorData.hostObservationWatermark || typeof monitorData.hostObservationWatermark !== "object") monitorData.hostObservationWatermark = {};
  const prev = monitorData.hostObservationWatermark[host];
  // 冪等: 同一 windowId で既に昇格済みなら何もしない。
  if (windowId != null && prev && prev.lastCommittedWindowId === windowId) return prev;
  monitorData.hostObservationWatermark[host] = {
    ...cur,
    committedReason: reason,
    persistedAt: wallNowMs(),
    baselineCommittedAt: wallNowMs(),
    baselineObservationSequence: cur.observationSequence,
    currentObservationSequence: cur.observationSequence,
    candidatePersistedAt: candidatePersistedAt ?? (prev?.candidatePersistedAt ?? null),
    lastCommittedWindowId: windowId ?? (prev?.lastCommittedWindowId ?? null)
  };
  return monitorData.hostObservationWatermark[host];
}

/**
 * 「アプリ停止中に新たに現れた完了ジョブ」を複合観測キーの集合差分で求める純関数（#411-O1/O2 基盤）。
 *
 * @function computeOfflineWindow
 * @param {string} host
 * @returns {{bounded:boolean, offlineJobKeys:string[], reason:string, identityChanged:boolean,
 *            generationChanged:boolean, stalenessMs:?number, watermark:?Object}}
 */
export function computeOfflineWindow(host) {
  const wm = monitorData.hostObservationWatermark?.[host] || null;
  const hist = monitorData.machines?.[host]?.printStore?.history;
  const currentObs = completedJobObservations(hist);
  const currentGen = historyGenerationFingerprint(hist);

  if (!wm || !Array.isArray(wm.seenObservationKeys)) {
    return { bounded: false, offlineJobKeys: [], reason: "no-prior-observation",
      identityChanged: false, generationChanged: false, stalenessMs: null, watermark: wm };
  }

  const identityChanged = wm.printerIdentity !== _identity(host);
  const seen = new Set(wm.seenObservationKeys);
  const currentKeys = currentObs.map(o => o.key);
  const currentSet = new Set(currentKeys);

  // #411-P0-2: 世代反証（baseline/current fingerprint を実際に比較）。
  const priorCount = wm.seenObservationKeys.length;
  const missing = priorCount ? wm.seenObservationKeys.filter(k => !currentSet.has(k)).length : 0;
  const mostMissing = priorCount > 0 && missing > Math.floor(priorCount * 0.5);
  const shrunk = currentObs.length < Math.floor((Number(wm.retainedObservationCount) || 0) * 0.5);
  const baseLatest = Number(wm.generation?.latestAt) || 0;
  const curLatest = Number(currentGen.latestAt) || 0;
  const timeRollback = baseLatest > 0 && curLatest > 0 && curLatest < baseLatest;

  // #411-P0-1: 識別材料不足（id 以外の distinguishing が半数超で無い）→ 複合キーを信頼できない。
  const undist = currentObs.filter(o => !o.hasDistinguishing).length;
  const identityInsufficient = currentObs.length > 0 && undist > Math.floor(currentObs.length * INSUFFICIENT_RATIO);

  const generationChanged = identityChanged || mostMissing || shrunk || timeRollback;
  const offlineJobKeys = currentKeys.filter(k => !seen.has(k));

  let reason;
  if (identityChanged) reason = "printer-identity-changed";
  else if (timeRollback) reason = "history-time-rollback";
  else if (mostMissing) reason = "history-generation-changed";
  else if (shrunk) reason = "history-shrunk";
  else if (identityInsufficient) reason = "job-identity-insufficient";
  else reason = "diff-ok";

  const persistedAt = Number(wm.persistedAt) || Number(wm.observedAtEpochMs) || 0;
  const stalenessMs = persistedAt > 0 ? Math.max(0, wallNowMs() - persistedAt) : null;

  return {
    bounded: !generationChanged && !identityInsufficient,
    offlineJobKeys, reason, identityChanged, generationChanged, stalenessMs, watermark: wm
  };
}

/**
 * confidence（推定確度）を reasons 付きで組み立てる純関数（#411 で schema 先行導入）。
 * remaining には一切影響しない（表示・監査用の宣言のみ）。
 *
 * @function buildConfidence
 * @param {"high"|"medium"|"low"|"none"} level
 * @param {string[]} [reasons]
 * @returns {{level:string, reasons:string[]}}
 */
export function buildConfidence(level, reasons = []) {
  const lv = ["high", "medium", "low", "none"].includes(level) ? level : "none";
  return { level: lv, reasons: Array.isArray(reasons) ? reasons.slice() : [] };
}
