/**
 * @fileoverview オフライン推定帰属(Option4)の観測レイヤ — #411-O1
 * @file dashboard_offline_observation.js
 * @copyright (c) pumpCurry 2026 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_offline_observation
 *
 * 【責務（レビュー#411 で固定）】O1 は「観測・保存・比較」だけを行う Observation レイヤ。
 *   解釈・分類・candidate 生成（O2）や推定残量（O3）は含めない。公開 API は3つ:
 *   - recordObservation(host)          … 稼働中の観測を current へ記録（baseline 非上書き）
 *   - computeObservationWindow(host)   … baseline vs current で ObservationWindow を返す（純関数）
 *   - commitObservationWindow(host,..) … 窓評価後に baseline 昇格（fail-closed transaction）
 *
 * 【重要な安全性（レビュー指摘）】
 *   - baseline は「最新 SEEN_CAP 件」に切詰めるため retainedRange（時系列境界）を保存し、
 *     比較は境界内/以降のみ。境界より古い履歴を offline 扱いしない（5000件問題の根治）。
 *   - 同一実行は jobObservationIdentity（id＋開始/完了時刻＋file）の複合キーで識別。
 *     識別材料不足/再利用IDは offline **候補単位**で判定し bounded=false／unresolved へ。
 *   - commit は fail-closed（windowId/candidatePersistedAt/expectedSequence 必須・不一致は拒否）。
 *
 * 【read-only 境界】書き込みは hostObservationWatermark / hostObservationCurrent のみ。
 *   安全基盤（completionObservationId/pendingUnattributedUsage/mountHistory/intervalId/
 *   usedLengthLog/remainingLengthMm 等）には一切触れない。残量は減らさない。
 *
 * @version 2.3.0
 * @since   2.3.0
 * -----------------------------------------------------------
 */

"use strict";

import { monitorData } from "./dashboard_data.js";
import { wallNowMs } from "./dashboard_time.js";
import { completedJobObservations, historyGenerationFingerprint } from "./dashboard_history_identity.js";

/** 観測キーの保持上限（completion 時系列で最新のみ保持）。 */
const SEEN_CAP = 5000;

/** @private */
function _identity(host) {
  const sd = monitorData.machines?.[host]?.storedData || {};
  const model = sd.model?.rawValue ?? "";
  const type = monitorData.appSettings?.connectionTargets?.find?.(t => t && t.hostname === host)?.printerType ?? "";
  return `${host}|${type}|${model}`;
}

/** @private 継続採番（再起動で 1 へ戻さない）。current/baseline から常に単調増加。 */
function _nextSeq(host) {
  const base = Number(monitorData.hostObservationWatermark?.[host]?.observationSequence) || 0;
  const cur = Number(monitorData.hostObservationCurrent?.[host]?.observationSequence) || 0;
  return Math.max(base, cur) + 1;
}

/** @private 現在履歴から観測スナップショットを構築（read-only）。 */
function _buildObservation(host, { mountIntervalId = null, mountIntervalStatus = "none" } = {}) {
  const hist = monitorData.machines?.[host]?.printStore?.history;
  const obsAll = completedJobObservations(hist); // completion 時系列・重複排除
  const totalCompletedCount = obsAll.length;
  const retained = obsAll.length > SEEN_CAP ? obsAll.slice(obsAll.length - SEEN_CAP) : obsAll;
  const truncated = totalCompletedCount > retained.length;
  const spoolId = monitorData.hostSpoolMap?.[host] ?? null;
  const first = retained[0] || null;
  const last = retained[retained.length - 1] || null;
  return {
    observedAtEpochMs: wallNowMs(),
    persistedAt: null,
    observationSequence: _nextSeq(host),
    mountedSpoolId: spoolId,
    mountIntervalId: mountIntervalId ?? null,
    mountIntervalStatus,
    observationState: spoolId ? "mounted" : "unmounted",
    printerIdentity: _identity(host),
    generation: historyGenerationFingerprint(hist),
    seenObservationKeys: retained.map(o => o.key),
    // ★ retainedRange: 比較を境界内に限定するための時系列境界（5000件問題対策）。
    retainedRange: {
      firstKey: first ? first.key : null,
      lastKey: last ? last.key : null,
      firstCompletedAt: first ? (first.finishAt || 0) : 0,
      lastCompletedAt: last ? (last.finishAt || 0) : 0,
      truncated
    },
    retainedObservationCount: retained.length,
    totalCompletedCount,
    truncated
  };
}

/**
 * 稼働中の観測を current へ記録する（baseline 非上書き。未設定初回のみ bootstrap）。
 * @function recordObservation
 * @param {string} host
 * @param {{mountIntervalId?:?string, mountIntervalStatus?:string}} [opts]
 * @returns {?Object} current スナップショット
 */
export function recordObservation(host, opts = {}) {
  if (!host) return null;
  if (!monitorData.hostObservationWatermark || typeof monitorData.hostObservationWatermark !== "object") monitorData.hostObservationWatermark = {};
  if (!monitorData.hostObservationCurrent || typeof monitorData.hostObservationCurrent !== "object") monitorData.hostObservationCurrent = {};
  const snap = _buildObservation(host, opts);
  monitorData.hostObservationCurrent[host] = snap;
  if (!monitorData.hostObservationWatermark[host]) {
    monitorData.hostObservationWatermark[host] = {
      ...snap, committedReason: "bootstrap", persistedAt: wallNowMs(), lastCommittedWindowId: "bootstrap"
    };
  }
  return snap;
}

/**
 * オフライン観測窓を計算する（純関数。O2 はこの ObservationWindow を分類する）。
 *
 * @function computeObservationWindow
 * @param {string} host
 * @returns {{windowId:string, bounded:boolean, truncated:boolean, generationChanged:boolean,
 *   reason:string, offlineObservationKeys:string[], unresolvedJobIds:string[],
 *   baselineFingerprint:?Object, currentFingerprint:Object,
 *   baselineSequence:number, currentSequence:number, stalenessMs:?number, watermark:?Object}}
 */
export function computeObservationWindow(host) {
  const wm = monitorData.hostObservationWatermark?.[host] || null;
  const curSnap = monitorData.hostObservationCurrent?.[host] || null;
  const hist = monitorData.machines?.[host]?.printStore?.history;
  const currentObs = completedJobObservations(hist);
  const currentFingerprint = historyGenerationFingerprint(hist);
  const baselineSequence = Number(wm?.observationSequence) || 0;
  const currentSequence = Number(curSnap?.observationSequence) || 0;
  const windowId = `${host}|b${baselineSequence}|c${currentSequence}`;

  const base = {
    windowId, truncated: !!wm?.retainedRange?.truncated,
    baselineFingerprint: wm?.generation || null, currentFingerprint,
    baselineSequence, currentSequence, watermark: wm
  };

  if (!wm || !Array.isArray(wm.seenObservationKeys)) {
    return { ...base, bounded: false, generationChanged: false, reason: "no-prior-observation",
      offlineObservationKeys: [], unresolvedJobIds: [], stalenessMs: null };
  }

  const identityChanged = wm.printerIdentity !== _identity(host);
  const seen = new Set(wm.seenObservationKeys);
  const baselineIds = new Set(wm.seenObservationKeys.map(_idOf));
  const firstAt = Number(wm.retainedRange?.firstCompletedAt) || 0;

  // ★ P0-2(世代反証): baseline/current fingerprint を実比較。current キー集合は一度だけ構築（O(n)）。
  const currentKeySet = new Set(currentObs.map(o => o.key));
  const priorCount = wm.seenObservationKeys.length;
  let missing = 0;
  if (priorCount) for (const k of wm.seenObservationKeys) if (!currentKeySet.has(k)) missing++;
  const mostMissing = priorCount > 0 && missing > Math.floor(priorCount * 0.5);
  const shrunk = currentObs.length < Math.floor((Number(wm.retainedObservationCount) || 0) * 0.5);
  const baseLatest = Number(wm.generation?.latestCompletedAt) || 0;
  const curLatest = Number(currentFingerprint.latestCompletedAt) || 0;
  const timeRollback = baseLatest > 0 && curLatest > 0 && curLatest < baseLatest;
  const generationChanged = identityChanged || mostMissing || shrunk || timeRollback;

  // ★ P0-1(retainedRange 境界): baseline に無く、かつ retained 境界「以降」の完了のみ offline 候補。
  //   境界より古い履歴（切詰めで捨てた分）は offline にしない。finishAt 不明は候補単位で unresolved。
  const offlineObservationKeys = [];
  const unresolvedJobIds = [];
  let hasIdReuse = false, hasInsufficient = false;
  for (const o of currentObs) {
    if (seen.has(o.key)) continue;                 // 既観測
    if (o.finishAt && firstAt && o.finishAt < firstAt) continue; // 境界より古い＝offline 対象外
    const idReused = baselineIds.has(o.canonicalJobId);
    // ★ P0-2(候補単位判定): 識別材料が無い候補は unresolved。canonicalJobId が baseline と
    //   衝突（再利用）で検証できない場合と、単なる識別不足を分けて理由を立てる。
    if (!o.hasDistinguishing) {
      if (idReused) hasIdReuse = true; else hasInsufficient = true;
      unresolvedJobIds.push(o.canonicalJobId);
      continue;
    }
    if (idReused && o.finishAt === 0) {            // 再利用IDで時刻検証もできない
      hasIdReuse = true;
      unresolvedJobIds.push(o.canonicalJobId);
      continue;
    }
    offlineObservationKeys.push(o.key);            // 識別十分＝offline 確定候補（再利用IDでも別実行として保持）
  }

  let reason;
  if (identityChanged) reason = "printer-identity-changed";
  else if (timeRollback) reason = "history-time-rollback";
  else if (mostMissing) reason = "history-generation-changed";
  else if (shrunk) reason = "history-shrunk";
  else if (hasIdReuse) reason = "reused-job-id-unverifiable";
  else if (hasInsufficient) reason = "job-identity-insufficient";
  else reason = "diff-ok";

  const persistedAt = Number(wm.persistedAt) || Number(wm.observedAtEpochMs) || 0;
  const stalenessMs = persistedAt > 0 ? Math.max(0, wallNowMs() - persistedAt) : null;

  return {
    ...base,
    bounded: !generationChanged && unresolvedJobIds.length === 0,
    generationChanged, reason, offlineObservationKeys, unresolvedJobIds, stalenessMs
  };
}

/** @private 複合キー(JSON tuple)から canonicalJobId を取り出す。 */
function _idOf(key) {
  try { const a = JSON.parse(key); return Array.isArray(a) ? String(a[0]) : ""; } catch { return ""; }
}

/**
 * 観測窓評価後に baseline を昇格する（fail-closed transaction。#411-P0-3）。
 *
 * 必須: windowId（非空）・candidatePersistedAt・expectedSequence（評価時の currentSequence）。
 * 不一致は昇格せず理由を返す。同一 windowId は冪等（二重昇格しない）。
 *
 * @function commitObservationWindow
 * @param {string} host
 * @param {{windowId:string, expectedSequence:number, candidatePersistedAt:number, candidateHash?:string}} opts
 * @returns {{ok:boolean, reason:string, baseline?:Object, idempotent?:boolean}}
 */
export function commitObservationWindow(host, { windowId, expectedSequence, candidatePersistedAt, candidateHash = null } = {}) {
  if (!host) return { ok: false, reason: "host_required" };
  if (windowId == null || String(windowId) === "") return { ok: false, reason: "window_id_required" };
  if (!monitorData.hostObservationWatermark || typeof monitorData.hostObservationWatermark !== "object") monitorData.hostObservationWatermark = {};
  const prev = monitorData.hostObservationWatermark[host];
  // ★ 冪等: 既に同一 windowId を昇格済みなら、以後の観測変化に関わらず no-op（二重適用防止）。
  if (prev && prev.lastCommittedWindowId === windowId) {
    return { ok: true, reason: "idempotent", baseline: prev, idempotent: true };
  }
  // ★ fail-closed 契約: 新規窓は candidate 永続証跡＋評価時 sequence 一致が必須。
  if (!(Number(candidatePersistedAt) > 0)) return { ok: false, reason: "candidate_not_persisted" };
  const cur = monitorData.hostObservationCurrent?.[host];
  if (!cur) return { ok: false, reason: "no_current_observation" };
  if (Number(expectedSequence) !== Number(cur.observationSequence)) {
    return { ok: false, reason: "observation_changed_since_evaluation" };
  }
  const baseline = {
    ...cur,
    committedReason: "window-evaluated",
    persistedAt: wallNowMs(),
    baselineCommittedAt: wallNowMs(),
    candidatePersistedAt: Number(candidatePersistedAt),
    candidateHash,
    lastCommittedWindowId: windowId
  };
  monitorData.hostObservationWatermark[host] = baseline;
  return { ok: true, reason: "committed", baseline };
}

/**
 * confidence（推定確度）を reasons 付きで組み立てる純関数。remaining には影響しない。
 * @function buildConfidence
 * @param {"high"|"medium"|"low"|"none"} level
 * @param {string[]} [reasons]
 * @returns {{level:string, reasons:string[]}}
 */
export function buildConfidence(level, reasons = []) {
  const lv = ["high", "medium", "low", "none"].includes(level) ? level : "none";
  return { level: lv, reasons: Array.isArray(reasons) ? reasons.slice() : [] };
}
