/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 推定 candidate 表示モデル生成モジュール
 * @file dashboard_inferred_candidate_view.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_inferred_candidate_view
 *
 * 【機能内容サマリ】
 * - inferredCandidateStore の保存レコードから O5 UI 用 ViewModel を生成する。
 * - status filter、sort、pending count、残量差分、履歴照合警告、decision 送信可否を計算する。
 * - UI が candidate record や確定台帳を直接変更しないための表示専用境界を提供する。
 *
 * 【公開関数一覧】
 * - {@link buildInferredCandidateViewModel}：candidate record 1件を表示モデルへ変換する
 * - {@link listInferredCandidateViewModels}：candidate 一覧表示モデルを生成する
 * - {@link countPendingInferredCandidates}：pending candidate 件数を返す
 *
 * @version 1.390.1263 (PR #416)
 * @since   1.390.1262 (PR #415)
 * @lastModified 2026-07-25 20:55:00
 * -----------------------------------------------------------
 * @todo
 * - O5C で recovery flag の起動時 reconciliation 結果を警告表示へ接続する。
 */

"use strict";

import { monitorData } from "./dashboard_data.js";
import { jobObservationIdentity } from "./dashboard_history_identity.js";
import { canSubmitLedgerDecision } from "./dashboard_inferred_candidate_decision.js";
import { INFERRED_CANDIDATE_STATUS } from "./dashboard_offline_candidate_store.js";
import { formatFilamentAmount, formatSpoolDisplayId } from "./dashboard_spool.js";

/**
 * Candidate Center の status filter。
 *
 * @enum {string}
 */
export const INFERRED_CANDIDATE_FILTER = Object.freeze({
  PENDING: "pending",
  CONFIRMED: "confirmed",
  REJECTED: "rejected",
  REASSIGNED: "reassigned",
  SUPERSEDED: "superseded",
  ALL: "all"
});

/**
 * Candidate Center の sort key。
 *
 * @enum {string}
 */
export const INFERRED_CANDIDATE_SORT = Object.freeze({
  NEWEST: "newest",
  OLDEST: "oldest",
  CONFIDENCE: "confidence",
  PRINTER: "printer",
  SPOOL: "spool"
});

/**
 * confidence level の表示順位。
 *
 * @private
 * @constant {Object.<string,number>}
 */
const CONFIDENCE_RANK = Object.freeze({
  high: 3,
  medium: 2,
  low: 1
});

/**
 * status label の表示テキスト。
 *
 * @private
 * @constant {Object.<string,string>}
 */
const STATUS_LABELS = Object.freeze({
  pending: "Pending",
  confirmed: "Confirmed",
  rejected: "Rejected",
  reassigned: "Reassigned",
  superseded: "Superseded"
});

/**
 * confidence label の表示テキスト。
 *
 * @private
 * @constant {Object.<string,string>}
 */
const CONFIDENCE_LABELS = Object.freeze({
  high: "High",
  medium: "Medium",
  low: "Low"
});

/**
 * monitorData の candidate store を取得する。
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
 * active な spool 配列から対象 spool を取得する。
 *
 * @private
 * @function _spoolById
 * @param {?string} spoolId - spool ID。
 * @returns {?Object} spool。存在しない場合は null。
 */
function _spoolById(spoolId) {
  if (!spoolId) return null;
  const id = String(spoolId);
  return (monitorData.filamentSpools || []).find(spool =>
    spool && String(spool.id) === id && !spool.deleted && !spool.isDeleted
  ) || null;
}

/**
 * host の表示名を返す。
 *
 * @private
 * @function _hostLabel
 * @param {?string} host - host key。
 * @returns {string} UI 表示名。
 */
function _hostLabel(host) {
  if (!host) return "--";
  const machine = monitorData.machines?.[host];
  return machine?.storedData?.hostname?.rawValue
    || machine?.storedData?.model?.rawValue
    || host;
}

/**
 * mm 値を UI 表示用文字列へ変換する。
 *
 * @private
 * @function _formatMm
 * @param {*} mm - mm 値。
 * @param {?Object} [spool=null] - spool context。
 * @returns {string} 表示文字列。
 */
function _formatMm(mm, spool = null) {
  const n = Number(mm);
  if (!Number.isFinite(n)) return "--";
  try {
    return formatFilamentAmount(n, spool).display;
  } catch {
    return `${Math.round(n).toLocaleString()} mm`;
  }
}

/**
 * epoch ms を短い日時文字列へ変換する。
 *
 * @private
 * @function _formatTime
 * @param {*} epochMs - epoch ms。
 * @returns {string} 表示文字列。
 */
function _formatTime(epochMs) {
  const n = Number(epochMs);
  if (!Number.isFinite(n) || n <= 0) return "--";
  try {
    return new Date(n).toLocaleString("ja-JP", { hour12: false });
  } catch {
    return "--";
  }
}

/**
 * 履歴配列を取得する。
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
 * 履歴行の候補 observation key を列挙する。
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
 * observation key から履歴候補への Map を作る。
 *
 * @private
 * @function _historyByObservationKey
 * @param {Array<Object>} history - printStore.history 相当の配列。
 * @returns {Map<string,{status:string,entries:Array<Object>}>} key lookup。
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
 * 履歴行が確定帰属済みか判定する。
 *
 * @private
 * @function _historyAttributionState
 * @param {?Object} entry - 履歴行。
 * @returns {string} `missing` / `attributed` / `pending`。
 */
function _historyAttributionState(entry) {
  if (!entry) return "missing";
  const info = Array.isArray(entry.filamentInfo) ? entry.filamentInfo : [];
  if (info.some(item => item && item.spoolId)) return "attributed";
  if (entry.filamentId) return "attributed";
  return "pending";
}

/**
 * candidate に紐づく履歴表示モデルを作る。
 *
 * @private
 * @function _jobViewModels
 * @param {Object} record - candidate record。
 * @param {?Object} spool - candidate spool。
 * @returns {{jobs:Array<Object>,warningCodes:Array<string>}} 履歴表示モデルと警告。
 */
function _jobViewModels(record, spool) {
  const history = _historyForHost(record.host);
  const byKey = _historyByObservationKey(history);
  const warnings = new Set();
  const debits = Array.isArray(record.candidateDebits) ? record.candidateDebits : [];
  const jobs = debits.map(debit => {
    const key = String(debit?.observationKey ?? "");
    const lookup = byKey.get(key);
    let entry = null;
    let lookupStatus = "missing";
    if (lookup?.status === "unique" && lookup.entries.length === 1) {
      entry = lookup.entries[0];
      lookupStatus = "unique";
    } else if (lookup?.status === "ambiguous") {
      lookupStatus = "ambiguous";
      warnings.add("history-ambiguous");
    } else {
      warnings.add("history-missing");
    }
    const attributionState = _historyAttributionState(entry);
    if (attributionState === "attributed") warnings.add("history-already-attributed");
    const usedMm = Number(debit?.usedMm);
    return {
      observationKey: key,
      status: debit?.status || "unknown",
      lookupStatus,
      filename: entry?.filename || entry?.file || entry?.name || key,
      usedMm: Number.isFinite(usedMm) ? usedMm : 0,
      usedDisplay: Number.isFinite(usedMm) ? _formatMm(usedMm, spool) : "--",
      attributionState,
      reason: debit?.reason || null
    };
  });
  return { jobs, warningCodes: [...warnings] };
}

/**
 * candidate record 1件を表示モデルへ変換する。
 *
 * 【詳細説明】
 * - inferredCandidateStore の生 record と monitorData の spool/history を read-only に参照する。
 * - 操作可否は candidate status と `canSubmitLedgerDecision()` で決める。
 * - warningCodes は O4 保存後に履歴や spool が変化した場合の UI 警告として使う。
 *
 * @function buildInferredCandidateViewModel
 * @param {Object} record - inferredCandidateStore の candidate record。
 * @param {{canSubmit?:boolean}} [options] - テスト用の操作可否注入。
 * @returns {Object} O5 UI 用 ViewModel。
 * @example
 * const vm = buildInferredCandidateViewModel(record);
 */
export function buildInferredCandidateViewModel(record, options = {}) {
  const candidateHash = record?.candidateHash || "";
  const status = record?.status || "unknown";
  const spool = _spoolById(record?.candidateSpoolId);
  const usedMm = Number(record?.usedMm);
  const confirmedRemainingMm = spool && Number.isFinite(Number(spool.remainingLengthMm))
    ? Number(spool.remainingLengthMm)
    : null;
  const projectedRemainingMm = confirmedRemainingMm == null || !Number.isFinite(usedMm)
    ? null
    : Math.max(0, confirmedRemainingMm - usedMm);
  const confidenceLevel = record?.confidence?.level || "unknown";
  const jobData = _jobViewModels(record || {}, spool);
  const warnings = new Set(jobData.warningCodes);
  if (!spool) warnings.add("spool-missing");
  if (confirmedRemainingMm == null) warnings.add("remaining-unknown");
  if (confirmedRemainingMm != null && Number.isFinite(usedMm) && confirmedRemainingMm < usedMm) {
    warnings.add("remaining-insufficient");
  }
  if (confidenceLevel === "low") warnings.add("low-confidence");
  if (monitorData.inferredDecisionRecoveryRequired) warnings.add("decision-recovery-required");
  const canSubmit = options.canSubmit ?? canSubmitLedgerDecision();
  if (!canSubmit) warnings.add("relay-readonly");
  const isPending = status === INFERRED_CANDIDATE_STATUS.PENDING;

  return {
    candidateHash,
    status,
    statusLabel: STATUS_LABELS[status] || status,
    host: record?.host || null,
    hostLabel: _hostLabel(record?.host),
    candidateSpoolId: record?.candidateSpoolId || null,
    candidateSpoolName: spool ? `${formatSpoolDisplayId(spool)} ${spool.name || ""}`.trim() : (record?.candidateSpoolId || "--"),
    candidateSpoolColor: spool?.filamentColor || spool?.color || "",
    usedMm: Number.isFinite(usedMm) ? usedMm : 0,
    usedDisplay: Number.isFinite(usedMm) ? _formatMm(usedMm, spool) : "--",
    confirmedRemainingMm,
    confirmedRemainingDisplay: confirmedRemainingMm == null ? "--" : _formatMm(confirmedRemainingMm, spool),
    projectedRemainingMm,
    projectedRemainingDisplay: projectedRemainingMm == null ? "--" : _formatMm(projectedRemainingMm, spool),
    confidenceLevel,
    confidenceLabel: CONFIDENCE_LABELS[confidenceLevel] || confidenceLevel,
    confidenceRank: CONFIDENCE_RANK[confidenceLevel] || 0,
    jobCount: jobData.jobs.length,
    jobs: jobData.jobs,
    createdAt: Number(record?.createdAt) || 0,
    createdAtDisplay: _formatTime(record?.createdAt),
    updatedAt: Number(record?.updatedAt) || 0,
    updatedAtDisplay: _formatTime(record?.updatedAt),
    windowId: record?.windowId || "",
    candidateBaselineIntervalId: record?.candidateBaselineIntervalId || "",
    candidateCurrentIntervalId: record?.candidateCurrentIntervalId || "",
    observationKeys: Array.isArray(record?.observationKeys) ? record.observationKeys.map(String) : [],
    confidence: record?.confidence || null,
    evidence: record?.evidence || null,
    events: Array.isArray(record?.events) ? record.events.map(event => ({ ...event })) : [],
    canConfirm: canSubmit && isPending,
    canReject: canSubmit && isPending,
    canReassign: canSubmit && isPending,
    readOnlyReason: canSubmit ? null : "relay-readonly",
    warningCodes: [...warnings].sort()
  };
}

/**
 * candidate 一覧表示モデルを生成する。
 *
 * 【詳細説明】
 * - status filter が `all` 以外の場合は対象状態だけを返す。
 * - host が指定された場合はその host の candidate だけを返す。
 * - sort は UI の選択値に従い、安定した tie-break として candidateHash を最後に使う。
 *
 * @function listInferredCandidateViewModels
 * @param {{status?:string,sort?:string,host?:?string,canSubmit?:boolean}} [options] - filter/sort 条件。
 * @returns {Array<Object>} ViewModel 配列。
 * @example
 * const pending = listInferredCandidateViewModels({ status: "pending" });
 */
export function listInferredCandidateViewModels(options = {}) {
  const statusFilter = options.status || INFERRED_CANDIDATE_FILTER.PENDING;
  const sort = options.sort || INFERRED_CANDIDATE_SORT.NEWEST;
  const host = options.host || null;
  const models = Object.values(_store())
    .filter(record => record && typeof record === "object")
    .filter(record => !host || record.host === host)
    .filter(record => statusFilter === INFERRED_CANDIDATE_FILTER.ALL || record.status === statusFilter)
    .map(record => buildInferredCandidateViewModel(record, { canSubmit: options.canSubmit }));

  models.sort((a, b) => {
    if (sort === INFERRED_CANDIDATE_SORT.OLDEST) return (a.createdAt - b.createdAt) || a.candidateHash.localeCompare(b.candidateHash);
    if (sort === INFERRED_CANDIDATE_SORT.CONFIDENCE) return (b.confidenceRank - a.confidenceRank) || (b.createdAt - a.createdAt);
    if (sort === INFERRED_CANDIDATE_SORT.PRINTER) return a.hostLabel.localeCompare(b.hostLabel) || (b.createdAt - a.createdAt);
    if (sort === INFERRED_CANDIDATE_SORT.SPOOL) return a.candidateSpoolName.localeCompare(b.candidateSpoolName) || (b.createdAt - a.createdAt);
    return (b.createdAt - a.createdAt) || a.candidateHash.localeCompare(b.candidateHash);
  });
  return models;
}

/**
 * pending candidate 件数を返す。
 *
 * @function countPendingInferredCandidates
 * @param {?string} [host=null] - host を指定するとその host だけを数える。
 * @returns {number} pending candidate 件数。
 * @example
 * const count = countPendingInferredCandidates();
 */
export function countPendingInferredCandidates(host = null) {
  return listInferredCandidateViewModels({
    status: INFERRED_CANDIDATE_FILTER.PENDING,
    host,
    canSubmit: true
  }).length;
}
