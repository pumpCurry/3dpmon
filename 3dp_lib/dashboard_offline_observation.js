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
 * @version 1.390.1246 (PR #411)
 * @since   2.3.0
 * @lastModified 2026-07-23 09:57:05
 * -----------------------------------------------------------
 */

"use strict";

import { monitorData } from "./dashboard_data.js";
import { wallNowMs, randomEventId } from "./dashboard_time.js";
import { completedJobObservations, historyGenerationFingerprint, jobObservationIdentity } from "./dashboard_history_identity.js";

/** 観測キーの保持上限（completion 時系列で最新のみ保持）。 */
const SEEN_CAP = 5000;

/** アプリ起動セッションID（P1-2: 永続復元された旧 current と現セッション観測を区別）。 */
let _appSessionId = null;
/** @private セッションIDを遅延生成して返す（同一セッション内で安定）。 */
function _sessionId() {
  if (_appSessionId == null) { try { _appSessionId = randomEventId(); } catch { _appSessionId = "session-0"; } }
  return _appSessionId;
}

/**
 * @private プリンタ識別を構造化して返す（P1-1）。model/serial/deviceId のいずれかが
 * 機器から届いていれば completeness="strong"、未取得は "weak"（printerType は設定値なので
 * strong 判定には使わない）。weak→strong は情報補完でありプリンタ交換ではない。
 */
function _identity(host) {
  const sd = monitorData.machines?.[host]?.storedData || {};
  const model = String(sd.model?.rawValue ?? "").trim();
  const printerType = monitorData.appSettings?.connectionTargets?.find?.(t => t && t.hostname === host)?.printerType ?? "";
  const serialNumber = String(sd.sn?.rawValue ?? sd.serialNumber?.rawValue ?? "").trim();
  const deviceId = String(sd.deviceId?.rawValue ?? sd.id?.rawValue ?? "").trim();
  const completeness = (model || serialNumber || deviceId) ? "strong" : "weak";
  return { host, printerType, model, serialNumber, deviceId, completeness };
}

/** @private 文字列（旧保存）/構造体いずれの identity も構造体へ正規化する。 */
function _normIdentity(id) {
  if (id && typeof id === "object") {
    const model = id.model ?? "", serialNumber = id.serialNumber ?? "", deviceId = id.deviceId ?? "";
    return {
      host: id.host ?? "", printerType: id.printerType ?? "", model, serialNumber, deviceId,
      completeness: id.completeness || ((model || serialNumber || deviceId) ? "strong" : "weak")
    };
  }
  if (typeof id === "string") {
    const [host = "", printerType = "", model = ""] = id.split("|");
    return { host, printerType, model, serialNumber: "", deviceId: "", completeness: model ? "strong" : "weak" };
  }
  return { host: "", printerType: "", model: "", serialNumber: "", deviceId: "", completeness: "weak" };
}

/**
 * @private baseline/current identity の一致強度を返す（P1-1）。
 * model は同機種で共通し得るため「一意識別子」ではない＝一致しても same-strong にしない。
 *  - same-strong: serialNumber または deviceId が一致（本当に同一筐体）
 *  - same-descriptive: model/type は一致するが一意IDが無い（同一機とは断定できない）
 *  - contradicted: 比較可能な一意ID/model が不一致（＝プリンタ交換の反証）
 *  - unverifiable: 情報不足（weak／weak→strong 補完）。反証にはしない。
 * @param {*} baseId
 * @param {*} curId
 * @returns {{status:string, matchedBy:?string}}
 */
function _identityMatch(baseId, curId) {
  const a = _normIdentity(baseId), b = _normIdentity(curId);
  if (a.serialNumber && b.serialNumber) {
    return { status: a.serialNumber === b.serialNumber ? "same-strong" : "contradicted", matchedBy: "serialNumber" };
  }
  if (a.deviceId && b.deviceId) {
    return { status: a.deviceId === b.deviceId ? "same-strong" : "contradicted", matchedBy: "deviceId" };
  }
  if (a.model && b.model) {
    const same = a.model === b.model && a.printerType === b.printerType;
    return { status: same ? "same-descriptive" : "contradicted", matchedBy: "model" };
  }
  return { status: "unverifiable", matchedBy: null };
}

/** @private 継続採番（再起動で 1 へ戻さない）。current/baseline から常に単調増加。 */
function _nextSeq(host) {
  const base = Number(monitorData.hostObservationWatermark?.[host]?.observationSequence) || 0;
  const cur = Number(monitorData.hostObservationCurrent?.[host]?.observationSequence) || 0;
  return Math.max(base, cur) + 1;
}

/**
 * @private 観測スナップショットから装着「事実」だけを投影する（解釈しない）。
 * O2 が baseline/current の装着状態を比較できるよう ObservationWindow へ載せる。
 * @param {?Object} snap 観測スナップショット（watermark or current）
 * @returns {{spoolId:?string, intervalId:?string, intervalStatus:string, observationState:string}}
 */
function _mountFacts(snap) {
  if (!snap) return { spoolId: null, intervalId: null, intervalStatus: "unknown", observationState: "unknown" };
  return {
    spoolId: snap.mountedSpoolId ?? null,
    intervalId: snap.mountIntervalId ?? null,
    intervalStatus: snap.mountIntervalStatus || "unknown",
    observationState: snap.observationState || (snap.mountedSpoolId != null ? "mounted" : "unmounted")
  };
}

/** @private 現在履歴から観測スナップショットを構築（read-only）。 */
function _buildObservation(host, { mountIntervalId = null, mountIntervalStatus = "none", activeJobId = null, printState = null, activePrinting = false } = {}) {
  const machine = monitorData.machines?.[host];
  // ★ P1-B: 印刷中/一時停止のときだけ、印刷中ジョブの複合 identity（id+開始時刻+file）を保存。
  //   idle の残存 current や ID 再利用で high 誤判定しないよう、O2 は composite 一致を要求する。
  let activeJobObservation = null;
  if (activePrinting) {
    const cur = machine?.printStore?.current;
    const oid = cur ? jobObservationIdentity(cur) : null;
    if (oid && oid.canonicalJobId != null) {
      activeJobObservation = { canonicalJobId: oid.canonicalJobId, startAt: oid.startAt ?? null, fileSignature: oid.fileSignature ?? null };
    }
  }
  const hist = machine?.printStore?.history;
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
    // ★ P0-4: 連続印刷の証拠（停止前に何を印刷中だったか）。O2 の activeJobContinued 判定に使う。
    activeJobId: activeJobId ?? (machine?.printStore?.current?.id ?? null),
    activeJobObservation, // ★ P1-B: 印刷中のみ非null（複合 identity）
    printState: printState ?? null,
    historyRevision: machine?.printStore?._historyRev ?? null,
    // ★ P1-2: 現セッションで取得した観測か（永続復元された旧 current と区別する）。
    appSessionId: _sessionId(),
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
 * 観測を記録すべきかを判定する純関数（P0-1: signature 変化 or heartbeat 経過で記録）。
 * signature には履歴 revision・現在ジョブ・印刷状態・装着スプール・mount status/interval id を含める。
 * これにより「稼働中に完了を観測したのに 5s 以内クラッシュで offline 化」する隙間を縮める。
 *
 * @function observationDue
 * @param {?{lastAtMs:?number, signature:?string}} prev 前回記録の時刻(monotonic)と signature
 * @param {{historyRevision:*, activeJobId:*, printState:*, mountedSpoolId:*, mountIntervalStatus:*, mountIntervalId:*}} facts
 * @param {{nowMs:number, heartbeatMs?:number}} clock
 * @returns {{record:boolean, signature:string}}
 */
export function observationDue(prev, facts = {}, { nowMs = 0, heartbeatMs = 5000 } = {}) {
  const signature = [
    facts.historyRevision ?? "", facts.activeJobId ?? "", facts.printState ?? "",
    facts.mountedSpoolId ?? "", facts.mountIntervalStatus ?? "", facts.mountIntervalId ?? ""
  ].join("|");
  const lastAt = prev?.lastAtMs;
  const record = lastAt == null || (nowMs - lastAt) > heartbeatMs || prev?.signature !== signature;
  return { record, signature };
}

/** @private 複合キー(JSON tuple)から canonicalJobId を取り出す。 */
function _idOf(key) {
  try { const a = JSON.parse(key); return Array.isArray(a) ? String(a[0]) : ""; } catch { return ""; }
}

/** @private 複合キー配列から観測 identity を復元する（純関数・履歴非依存）。 */
function _obsFromKeys(keys) {
  const out = [];
  if (!Array.isArray(keys)) return out;
  for (const key of keys) {
    let a; try { a = JSON.parse(key); } catch { continue; }
    if (!Array.isArray(a)) continue;
    const canonicalJobId = String(a[0]);
    const startAt = Number(a[1]) || 0;
    const finishAt = Number(a[2]) || 0;
    const fileSignature = a[3] || "";
    out.push({ key, canonicalJobId, startAt, finishAt, fileSignature, hasDistinguishing: finishAt > 0 || startAt > 0 || fileSignature !== "" });
  }
  return out;
}

/**
 * オフライン観測窓を計算する **完全な純関数**（O1-P1-4）。
 * 前回観測(previous=baseline)と現在観測(current)の2スナップショットのみを入力にとり、
 * グローバル状態（watermark/履歴/live identity）を一切参照しない。O2 はこの ObservationWindow を分類する。
 *
 * @function computeOfflineWindow
 * @param {?Object} previous baseline 観測スナップショット
 * @param {?Object} current  現在観測スナップショット
 * @param {string|{host?:string, sessionId?:?string}} [opts] windowId 用 host と、鮮度検証用 sessionId
 * @returns {Object} ObservationWindow
 */
export function computeOfflineWindow(previous, current, opts = {}) {
  const { host = "", sessionId = null } = (typeof opts === "string") ? { host: opts } : (opts || {});
  const currentFingerprint = current?.generation || { completedCount: 0, earliestCompletedAt: 0, latestCompletedAt: 0, retainedHash: "" };
  const baselineSequence = Number(previous?.observationSequence) || 0;
  const currentSequence = Number(current?.observationSequence) || 0;
  const windowId = `${host ? host + "|" : ""}b${baselineSequence}|c${currentSequence}`;
  // ★ P1-2: current は「現セッションで取得した観測」だけを装着状態の根拠にする。
  //   sessionId 未指定（純関数テスト等）は fresh 扱い。復元された旧 current は stale＝不採用。
  const currentIsFresh = !!current && (sessionId == null || current.appSessionId === sessionId);
  const currentObservationStale = !!current && !currentIsFresh;
  const hasCurrentObservation = currentIsFresh;
  const baselineMount = _mountFacts(previous);
  const currentMount = _mountFacts(currentIsFresh ? current : null);
  const printerIdentityMatch = _identityMatch(previous?.printerIdentity, current?.printerIdentity);

  const base = {
    windowId, host: host || null, truncated: !!previous?.retainedRange?.truncated,
    baselineFingerprint: previous?.generation || null, currentFingerprint,
    baselineSequence, currentSequence, watermark: previous || null,
    hasCurrentObservation, currentObservationStale, baselineMount, currentMount,
    printerIdentityMatch, identityChanged: false
  };

  if (!previous || !Array.isArray(previous.seenObservationKeys)) {
    return { ...base, windowKind: "no-prior", bounded: false, generationChanged: false,
      reason: "no-prior-observation", offlineObservationKeys: [], unresolvedJobIds: [], stalenessMs: null };
  }
  // ★ O2-P0-2 / P1-2: baseline はあるが「現セッションの」current 観測がまだ無い＝装着状態未確認。
  //   復元された旧 current だけでは復帰後の装着を検証できないため incomplete とする。
  if (!hasCurrentObservation) {
    return { ...base, windowKind: "incomplete", bounded: false, generationChanged: false,
      reason: currentObservationStale ? "current-observation-stale" : "current-observation-missing",
      offlineObservationKeys: [], unresolvedJobIds: [], stalenessMs: null };
  }

  // current 観測は保存済みキーから復元（履歴を再読しない＝純関数化）。
  const currentObs = _obsFromKeys(current.seenObservationKeys);
  const identityChanged = printerIdentityMatch.status === "contradicted";
  const seen = new Set(previous.seenObservationKeys);
  const baselineIds = new Set(previous.seenObservationKeys.map(_idOf));
  const firstAt = Number(previous.retainedRange?.firstCompletedAt) || 0;
  const truncatedBaseline = !!previous.retainedRange?.truncated;

  // ★ P0-2(世代反証): baseline/current を実比較。current キー集合は一度だけ構築（O(n)）。
  const currentKeySet = new Set(currentObs.map(o => o.key));
  const priorCount = previous.seenObservationKeys.length;
  let missing = 0;
  if (priorCount) for (const k of previous.seenObservationKeys) if (!currentKeySet.has(k)) missing++;
  const mostMissing = priorCount > 0 && missing > Math.floor(priorCount * 0.5);
  const shrunk = currentObs.length < Math.floor((Number(previous.retainedObservationCount) || 0) * 0.5);
  const baseLatest = Number(previous.generation?.latestCompletedAt) || 0;
  const curLatest = Number(currentFingerprint.latestCompletedAt) || 0;
  const timeRollback = baseLatest > 0 && curLatest > 0 && curLatest < baseLatest;
  const generationChanged = identityChanged || mostMissing || shrunk || timeRollback;

  // ★ P0-1(retainedRange 境界): baseline に無く、かつ retained 境界「以降」の完了のみ offline 候補。
  const offlineObservationKeys = [];
  const unresolvedJobIds = [];
  let hasIdReuse = false, hasInsufficient = false, hasTruncatedUnverifiable = false;
  for (const o of currentObs) {
    if (seen.has(o.key)) continue;                 // 既観測
    if (o.finishAt && firstAt && o.finishAt < firstAt) continue; // 境界より古い＝offline 対象外
    // ★ codex-P1: baseline が truncated のとき、retained 時系列境界で「窓の内側」だと確認できない
    //   （候補の finishAt 不明 or 境界時刻 firstAt 不明）ものは offline 確定しない。切詰めで落ちた
    //   古い履歴や、履歴再取得で finishTime/複合キーが変わった古い完了を誤って offline 化しないための
    //   fail-closed（unresolved 扱い＝bounded=false）。
    if (truncatedBaseline && !(o.finishAt > 0 && firstAt > 0)) {
      hasTruncatedUnverifiable = true;
      unresolvedJobIds.push(o.canonicalJobId);
      continue;
    }
    const idReused = baselineIds.has(o.canonicalJobId);
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
    offlineObservationKeys.push(o.key);            // 識別十分＝offline 確定候補
  }

  let reason;
  if (identityChanged) reason = "printer-identity-changed";
  else if (timeRollback) reason = "history-time-rollback";
  else if (mostMissing) reason = "history-generation-changed";
  else if (shrunk) reason = "history-shrunk";
  else if (hasIdReuse) reason = "reused-job-id-unverifiable";
  else if (hasInsufficient) reason = "job-identity-insufficient";
  else if (hasTruncatedUnverifiable) reason = "history-truncated-unverifiable";
  else reason = "diff-ok";

  // 鮮度は current 観測時刻 − baseline 永続時刻で算出（wall clock を読まず純関数を保つ）。
  const baseAt = Number(previous.persistedAt) || Number(previous.observedAtEpochMs) || 0;
  const curAt = Number(current.observedAtEpochMs) || 0;
  const stalenessMs = (baseAt > 0 && curAt > 0) ? Math.max(0, curAt - baseAt) : null;
  const bounded = !generationChanged && unresolvedJobIds.length === 0;

  // ★ O2-P1-1: 構造化した windowKind を提供し、O2 が reason 文字列に依存しないようにする。
  let windowKind;
  if (hasIdReuse || hasInsufficient || hasTruncatedUnverifiable) windowKind = "insufficient";
  else if (!bounded) windowKind = "unbounded";
  else windowKind = "bounded";

  return {
    ...base, windowKind, bounded, generationChanged, identityChanged, shrunk,
    reason, offlineObservationKeys, unresolvedJobIds, stalenessMs
  };
}

/**
 * host の baseline/current 観測から ObservationWindow を計算する（薄いラッパ）。
 * 実体は純関数 computeOfflineWindow。O2 はこの窓を分類する。read-only。
 *
 * @function computeObservationWindow
 * @param {string} host
 * @returns {Object} ObservationWindow
 */
export function computeObservationWindow(host) {
  const previous = monitorData.hostObservationWatermark?.[host] || null;
  const current = monitorData.hostObservationCurrent?.[host] || null;
  // ★ P1-2: 現セッションで取得した current だけを装着根拠にする（復元された旧 current は stale）。
  return computeOfflineWindow(previous, current, { host, sessionId: _sessionId() });
}

/**
 * 観測窓評価後に baseline を昇格する（fail-closed transaction。#411-P0-3）。
 *
 * 必須: windowId（非空）・candidatePersistedAt・expectedSequence（評価時の currentSequence）。
 * 不一致は昇格せず理由を返す。同一 windowId は冪等（二重昇格しない）。
 *
 * @function commitObservationWindow
 * @param {string} host
 * @param {{windowId:string, expectedSequence:number, candidatePersistedAt:number, candidateHash?:string, expectedAppSessionId?:?string}} opts
 * @returns {{ok:boolean, reason:string, baseline?:Object, idempotent?:boolean}}
 */
export function commitObservationWindow(host, { windowId, expectedSequence, candidatePersistedAt, candidateHash = null, expectedAppSessionId = null } = {}) {
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
  // ★ P1-A: current は「現セッションで取得した観測」でなければ baseline へ昇格しない。
  //   candidate 永続化直後・baseline 昇格前にクラッシュ→旧 current を復元→sequence 一致でも
  //   fresh 観測が無いまま commit されるのを防ぐ（stale current で確定させない）。
  if (cur.appSessionId !== _sessionId()) return { ok: false, reason: "current_observation_stale" };
  if (expectedAppSessionId != null && cur.appSessionId !== expectedAppSessionId) {
    return { ok: false, reason: "app_session_changed_since_evaluation" };
  }
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
 * confidence（推定確度）を reasons/contradictions 付きで組み立てる純関数。remaining には影響しない。
 * @function buildConfidence
 * @param {"high"|"medium"|"low"|"none"} level
 * @param {string[]} [reasons]
 * @param {string[]} [contradictions]
 * @returns {{level:string, reasons:string[], contradictions:string[]}}
 */
export function buildConfidence(level, reasons = [], contradictions = []) {
  const lv = ["high", "medium", "low", "none"].includes(level) ? level : "none";
  return {
    level: lv,
    reasons: Array.isArray(reasons) ? reasons.slice() : [],
    contradictions: Array.isArray(contradictions) ? contradictions.slice() : []
  };
}
