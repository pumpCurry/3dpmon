/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用オフライン継続推定 candidate store モジュール
 * @file dashboard_offline_candidate_store.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_offline_candidate_store
 *
 * 【機能内容サマリ】
 * - #412-O4 の candidate 永続化層として、O2/O3 の分類結果と projection 結果を
 *   `monitorData.inferredCandidateStore` へ冪等保存する。
 * - 同一 window/candidate/observation key 集合は同じ candidateHash へ畳み、再起動や再送で
 *   推定 debit が二重作成されないようにする。
 * - candidate は削除せず、`status` と `events` による状態遷移で監査可能にする。
 *
 * 【公開関数一覧】
 * - {@link buildInferredCandidateHash}：candidate の安定 hash を生成する
 * - {@link persistInferredCandidate}：O2/O3 結果を candidate store へ冪等保存する
 * - {@link transitionInferredCandidate}：candidate の状態を監査 event 付きで変更する
 * - {@link getInferredCandidatesForHost}：host 単位で candidate を取得する
 *
 * @version 1.390.1245 (PR #412)
 * @since   1.390.1245 (PR #412)
 * @lastModified 2026-07-19 18:45:00
 * -----------------------------------------------------------
 * @todo
 * - O4 後続で aggregator の O2/O3 ライブ配線から `persistInferredCandidate` を呼び出す。
 * - O5 で confirmed/rejected/reassigned の UI 操作から `transitionInferredCandidate` を呼び出す。
 */

"use strict";

import { monitorData } from "./dashboard_data.js";

/** candidate store で許可する状態。 */
export const INFERRED_CANDIDATE_STATUS = Object.freeze({
  PENDING: "pending",
  CONFIRMED: "confirmed",
  REJECTED: "rejected",
  REASSIGNED: "reassigned",
  SUPERSEDED: "superseded"
});

/**
 * JSON 化前にオブジェクトのキー順を安定させる。
 *
 * 【詳細説明】
 * - candidateHash は再起動後にも同じ値でなければならないため、Object の挿入順に依存しない
 *   安定 JSON を作る。
 * - 配列順は observation の意味を持つためそのまま保持する。O2 側で順序が安定している前提。
 *
 * @private
 * @function _stable
 * @param {*} value - 安定化したい値。
 * @returns {*} キー順を正規化した値。
 */
function _stable(value) {
  if (Array.isArray(value)) return value.map(_stable);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = _stable(value[key]);
    return out;
  }
  return value;
}

/**
 * 決定論的な FNV-1a 32bit hash を返す。
 *
 * 【詳細説明】
 * - crypto API を使わず、browser / Node テスト双方で同じ値を返す軽量 hash。
 * - 衝突可能性はゼロではないため、candidateHash は安全上の権威 ID ではなく、冪等キーとして扱う。
 *
 * @private
 * @function _hashString
 * @param {string} text - hash 対象文字列。
 * @returns {string} 16進 hash。
 */
function _hashString(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * 現在 epoch ms を返す。
 *
 * @private
 * @function _nowMs
 * @param {{nowMs?:number}} [options] - テスト用 clock 注入。
 * @returns {number} epoch ms。
 */
function _nowMs(options = {}) {
  const injected = Number(options.nowMs);
  if (Number.isFinite(injected) && injected > 0) return injected;
  return Date.now();
}

/**
 * candidate store オブジェクトを初期化して返す。
 *
 * @private
 * @function _store
 * @returns {Object.<string, Object>} candidateHash をキーにした store。
 */
function _store() {
  if (!monitorData.inferredCandidateStore || typeof monitorData.inferredCandidateStore !== "object") {
    monitorData.inferredCandidateStore = {};
  }
  return monitorData.inferredCandidateStore;
}

/**
 * O2/O3 candidate の安定 hash を生成する。
 *
 * 【詳細説明】
 * - windowId、候補スプール、offline observation keys、推定 debit 総量を hash 材料にする。
 * - confidence や evidence は表示・監査属性であり、後から詳細が増えても同じ物理 candidate を
 *   別物にしないため hash 材料へ入れない。
 *
 * @function buildInferredCandidateHash
 * @param {{windowId?:?string, candidate?:?Object}} classificationResult - O2 分類結果。
 * @param {{inferredContinuityUsedMm?:number, candidateDebits?:Array<Object>}} projection - O3 projection 結果。
 * @returns {string} `ic-` 接頭辞付き candidate hash。
 * @example
 * const hash = buildInferredCandidateHash(classification, projection);
 */
export function buildInferredCandidateHash(classificationResult, projection) {
  const candidate = classificationResult?.candidate || {};
  const keys = Array.isArray(candidate.offlineObservationKeys) ? candidate.offlineObservationKeys.slice().sort() : [];
  const material = {
    windowId: classificationResult?.windowId ?? candidate.windowId ?? null,
    candidateSpoolId: candidate.candidateSpoolId ?? null,
    candidateBaselineIntervalId: candidate.candidateBaselineIntervalId ?? null,
    candidateCurrentIntervalId: candidate.candidateCurrentIntervalId ?? null,
    observationKeys: keys,
    usedMm: Math.max(0, Number(projection?.inferredContinuityUsedMm) || 0)
  };
  return `ic-${_hashString(JSON.stringify(_stable(material)))}`;
}

/**
 * O2/O3 の結果を candidate store へ冪等保存する。
 *
 * 【詳細説明】
 * - `projection.inferredContinuityUsedMm` が 0 以下なら、推定 debit 対象が無いため保存しない。
 * - 同じ candidateHash が既に存在する場合は既存レコードを返し、二重作成しない。
 * - 作成時点の candidate/projection/confidence/evidence をスナップショット化し、後続 UI が
 *   生の 5000 件 observation を見ずに状態表示できるようにする。
 *
 * @function persistInferredCandidate
 * @param {Object} classificationResult - `classifyObservationWindow()` の戻り値。
 * @param {Object} projection - `buildInferredContinuityProjection()` の戻り値。
 * @param {{nowMs?:number}} [options] - テスト用 clock 注入。
 * @returns {{ok:boolean, reason:string, candidateHash:?string, record:?Object, idempotent?:boolean}}
 *   保存結果。
 * @example
 * const result = persistInferredCandidate(classification, projection);
 */
export function persistInferredCandidate(classificationResult, projection, options = {}) {
  const usedMm = Math.max(0, Number(projection?.inferredContinuityUsedMm) || 0);
  if (usedMm <= 0) {
    return { ok: false, reason: "no_inferred_debit", candidateHash: null, record: null };
  }
  const candidate = classificationResult?.candidate || null;
  if (!candidate?.candidateSpoolId || !classificationResult?.windowId) {
    return { ok: false, reason: "candidate_incomplete", candidateHash: null, record: null };
  }
  const candidateHash = buildInferredCandidateHash(classificationResult, projection);
  const store = _store();
  if (store[candidateHash]) {
    return { ok: true, reason: "idempotent", candidateHash, record: store[candidateHash], idempotent: true };
  }

  const now = _nowMs(options);
  const record = {
    candidateHash,
    windowId: classificationResult.windowId,
    host: classificationResult.host ?? projection?.host ?? null,
    candidateSpoolId: String(candidate.candidateSpoolId),
    candidateBaselineIntervalId: candidate.candidateBaselineIntervalId ?? null,
    candidateCurrentIntervalId: candidate.candidateCurrentIntervalId ?? null,
    observationKeys: Array.isArray(candidate.offlineObservationKeys) ? candidate.offlineObservationKeys.slice() : [],
    candidateDebits: Array.isArray(projection?.candidateDebits) ? projection.candidateDebits.map(item => ({
      observationKey: item.observationKey,
      status: item.status,
      usedMm: Math.max(0, Number(item.usedMm) || 0),
      reason: item.reason,
      confirmedSpoolIds: Array.isArray(item.confirmedSpoolIds) ? item.confirmedSpoolIds.slice() : []
    })) : [],
    usedMm,
    confidence: classificationResult.confidence ? { ...classificationResult.confidence } : null,
    evidence: classificationResult.evidence ? { ...classificationResult.evidence } : null,
    status: INFERRED_CANDIDATE_STATUS.PENDING,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    events: [{ type: "created", at: now, status: INFERRED_CANDIDATE_STATUS.PENDING, usedMm }]
  };
  store[candidateHash] = record;
  return { ok: true, reason: "created", candidateHash, record };
}

/**
 * candidate の状態を監査 event 付きで変更する。
 *
 * 【詳細説明】
 * - candidate は削除しない。確認・否認・再割当て・supersede は status と event として記録する。
 * - 同じ状態へ再適用された場合も event を増殖させず、冪等 no-op として返す。
 * - `reassigned` では `assignedSpoolId` を保持し、後続 UI/確定処理が候補スプール以外へ割当可能にする。
 *
 * @function transitionInferredCandidate
 * @param {string} candidateHash - 対象 candidateHash。
 * @param {"pending"|"confirmed"|"rejected"|"reassigned"|"superseded"} status - 新しい状態。
 * @param {{nowMs?:number, actor?:string, reason?:string, assignedSpoolId?:?string, supersededBy?:?string}} [options]
 *   - 状態遷移に付与する監査情報。
 * @returns {{ok:boolean, reason:string, record:?Object}}
 * @example
 * const result = transitionInferredCandidate(hash, "rejected", { reason: "user-denied" });
 */
export function transitionInferredCandidate(candidateHash, status, options = {}) {
  const allowed = new Set(Object.values(INFERRED_CANDIDATE_STATUS));
  if (!candidateHash) return { ok: false, reason: "candidate_hash_required", record: null };
  if (!allowed.has(status)) return { ok: false, reason: "invalid_status", record: null };
  const record = _store()[candidateHash];
  if (!record) return { ok: false, reason: "candidate_not_found", record: null };

  const assignedSpoolId = options.assignedSpoolId ?? null;
  const supersededBy = options.supersededBy ?? null;
  if (record.status === status
      && (status !== INFERRED_CANDIDATE_STATUS.REASSIGNED || record.assignedSpoolId === assignedSpoolId)
      && (status !== INFERRED_CANDIDATE_STATUS.SUPERSEDED || record.supersededBy === supersededBy)) {
    return { ok: true, reason: "idempotent", record };
  }

  const now = _nowMs(options);
  record.status = status;
  record.updatedAt = now;
  if (status !== INFERRED_CANDIDATE_STATUS.PENDING) record.resolvedAt = now;
  if (status === INFERRED_CANDIDATE_STATUS.REASSIGNED) record.assignedSpoolId = assignedSpoolId;
  if (status === INFERRED_CANDIDATE_STATUS.SUPERSEDED) record.supersededBy = supersededBy;
  if (!Array.isArray(record.events)) record.events = [];
  record.events.push({
    type: "status-changed",
    at: now,
    status,
    actor: options.actor ?? "system",
    reason: options.reason ?? null,
    assignedSpoolId,
    supersededBy
  });
  return { ok: true, reason: "transitioned", record };
}

/**
 * 指定 host の candidate 一覧を取得する。
 *
 * 【詳細説明】
 * - UI や relay 確認用に、host で絞り込んだコピーを返す。
 * - status 指定がある場合はその状態だけを返す。元 store は変更しない。
 *
 * @function getInferredCandidatesForHost
 * @param {string} host - 対象ホスト名。
 * @param {{status?:string}} [options] - 絞り込み条件。
 * @returns {Array<Object>} candidate レコードの浅いコピー配列。
 * @example
 * const pending = getInferredCandidatesForHost("k1", { status: "pending" });
 */
export function getInferredCandidatesForHost(host, options = {}) {
  const out = [];
  for (const record of Object.values(_store())) {
    if (!record || record.host !== host) continue;
    if (options.status && record.status !== options.status) continue;
    out.push({ ...record, events: Array.isArray(record.events) ? record.events.slice() : [] });
  }
  return out.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
}
