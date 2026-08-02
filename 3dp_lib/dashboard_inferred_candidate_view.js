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
 * - status filter、sort、pending count、残量差分、履歴照合警告、decision/undo 送信可否を計算する。
 * - recovery / repair flag と O6 復旧操作 audit event を診断カードへ変換し、異常系を操作前後で見える状態にする。
 * - UI が candidate record や確定台帳を直接変更しないための表示専用境界を提供する。
 *
 * 【公開関数一覧】
 * - {@link buildInferredCandidateViewModel}：candidate record 1件を表示モデルへ変換する
 * - {@link listInferredCandidateViewModels}：candidate 一覧表示モデルを生成する
 * - {@link countPendingInferredCandidates}：pending candidate 件数を返す
 * - {@link buildInferredRecoverySurfaceViewModel}：recovery / repair 状態を診断表示モデルへ変換する
 *
 * @version 1.390.1274 (PR #424)
 * @since   1.390.1262 (PR #415)
 * @lastModified 2026-08-02 18:33:44
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

import { monitorData } from "./dashboard_data.js";
import { getMountIntervalStatus } from "./dashboard_filament_ledger.js";
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
  UNDONE: "undone",
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
  superseded: "Superseded",
  undone: "Undone"
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
 * 任意値を表示用の短い文字列へ変換する。
 *
 * 【詳細説明】
 * - recovery flag には save/rollback などの object が入る場合があるため、UI では重要な
 *   先頭情報だけを読めるよう JSON 化する。
 * - 表示不能な値は `"--"` に寄せ、診断カード生成で例外を出さない。
 *
 * @private
 * @function _formatValue
 * @param {*} value - 表示対象値。
 * @returns {string} 表示文字列。
 */
function _formatValue(value) {
  if (value == null || value === "") return "--";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * recovery surface 用の key/value 配列を生成する。
 *
 * 【詳細説明】
 * - undefined/null/空文字の値は表示対象から外し、カード内の情報量を絞る。
 * - reason や candidateHash など、修復対象を特定するための値だけを上位で指定して渡す。
 *
 * @private
 * @function _details
 * @param {Array<{label:string,value:*}>} entries - detail 候補。
 * @returns {Array<{label:string,value:string}>} 表示可能な detail。
 */
function _details(entries) {
  return entries
    .filter(item => item && item.value != null && item.value !== "")
    .map(item => ({ label: item.label, value: _formatValue(item.value) }));
}

/**
 * recovery audit event から短い対象説明を生成する。
 *
 * 【詳細説明】
 * - event type ごとに見るべき target が異なるため、候補 ID / host / 件数を優先して要約する。
 * - 表示専用の整形であり、監査 event 本体は `inferredRecoveryEvents` にそのまま残す。
 *
 * @private
 * @function _recoveryEventTarget
 * @param {Object} event - recovery audit event。
 * @returns {string} 表示用 target。
 */
function _recoveryEventTarget(event) {
  if (event?.clearedRecovery?.candidateHash) return String(event.clearedRecovery.candidateHash);
  if (event?.clearedRecovery?.operation) return String(event.clearedRecovery.operation);
  if (event?.decisionRecovery?.candidateHash) return String(event.decisionRecovery.candidateHash);
  if (event?.host) return String(event.host);
  if (Number.isFinite(Number(event?.rejectedEventCount))) return `${Number(event.rejectedEventCount)} rejected events`;
  return "--";
}

/**
 * mount interval を Recovery surface 表示用へ整形する。
 *
 * 【詳細説明】
 * - O6 の修復操作では、操作者が残す open interval を明示選択する。
 * - ViewModel では intervalId、境界、アンカー値だけを提示し、確定台帳の変更は UI から行わない。
 *
 * @private
 * @function _openIntervalOptions
 * @param {?Object} status - {@link getMountIntervalStatus} の戻り値。
 * @returns {Array<Object>} 選択可能な open interval 表示モデル。
 */
function _openIntervalOptions(status) {
  const intervals = Array.isArray(status?.intervals) ? status.intervals : [];
  return intervals
    .filter(interval => interval && interval.untilJobId == null && !interval.superseded)
    .map(interval => ({
      intervalId: String(interval.intervalId || ""),
      sinceJobId: Number(interval.sinceJobId) || 0,
      anchorRemainingMm: Number(interval.anchorRemainingMm) || 0,
      anchorRemainingDisplay: _formatMm(interval.anchorRemainingMm),
      boundaryStatus: interval.boundaryStatus || "unknown"
    }))
    .filter(interval => interval.intervalId)
    .sort((a, b) => (a.sinceJobId - b.sinceJobId) || a.intervalId.localeCompare(b.intervalId));
}

/**
 * ledger repair flag の現在状態を read-only に取得する。
 *
 * 【詳細説明】
 * - 表示層で例外が出ても Candidate Center 全体を壊さないよう、失敗時は error status として返す。
 * - repair 操作の最終判定は O6 Recovery Operations 側で再取得・再検証する。
 *
 * @private
 * @function _ledgerRepairStatusView
 * @param {string} host - host key。
 * @param {Object} item - ledgerRepairRequired の対象 item。
 * @returns {{status:Object,openIntervals:Array<Object>}} 表示用の現在状態。
 */
function _ledgerRepairStatusView(host, item) {
  const spoolId = item?.spoolId != null ? String(item.spoolId) : "";
  if (!spoolId) {
    return {
      status: { status: "unknown", diagnostics: [{ code: "spoolId-missing" }] },
      openIntervals: []
    };
  }
  try {
    const status = getMountIntervalStatus(spoolId, host);
    return {
      status,
      openIntervals: _openIntervalOptions(status)
    };
  } catch (error) {
    return {
      status: { status: "error", diagnostics: [{ code: "status-read-failed", detail: error?.message || String(error) }] },
      openIntervals: []
    };
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
  const hasRecoveryBlocker = !!monitorData.inferredDecisionRecoveryRequired
    || !!monitorData.inferredRecoveryOperationRecoveryRequired;
  if (hasRecoveryBlocker) warnings.add("decision-recovery-required");
  const canSubmit = !hasRecoveryBlocker && (options.canSubmit ?? canSubmitLedgerDecision());
  if (!canSubmit) warnings.add("relay-readonly");
  const isPending = status === INFERRED_CANDIDATE_STATUS.PENDING;
  const isUndoable = status === INFERRED_CANDIDATE_STATUS.CONFIRMED
    || status === INFERRED_CANDIDATE_STATUS.REASSIGNED;

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
    canUndo: canSubmit && isUndoable,
    readOnlyReason: canSubmit ? null : (hasRecoveryBlocker ? "recovery-required" : "relay-readonly"),
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

/**
 * O5/ledger の recovery / repair 状態を診断表示モデルへ変換する。
 *
 * 【詳細説明】
 * - この関数は monitorData を参照するだけで、recovery flag の解除や candidate 遷移は行わない。
 * - `inferredDecisionRecoveryRequired` は新規 decision を止める blocker として表示する。
 * - `ledgerRepairRequired` は host 単位の mount ledger 修復要求として表示する。
 * - `mountHistoryRejectedEvents` は隔離済みイベントの件数と最新数件を表示し、元データが失われていない
 *   ことをオペレーターが確認できるようにする。
 * - `inferredRecoveryEvents` は復旧操作の監査履歴として、問題が解消済みでも最新数件を表示する。
 *
 * @function buildInferredRecoverySurfaceViewModel
 * @param {{maxRejectedEvents?:number,maxRecoveryEvents?:number}} [options] - 表示する隔離/audit event の最大件数。
 * @returns {{hasIssues:boolean,totalCount:number,blockerCount:number,warningCount:number,infoCount:number,cards:Array<Object>}}
 *   recovery surface 表示モデル。
 * @example
 * const recovery = buildInferredRecoverySurfaceViewModel();
 */
export function buildInferredRecoverySurfaceViewModel(options = {}) {
  const cards = [];
  const recovery = monitorData.inferredDecisionRecoveryRequired;
  if (recovery && typeof recovery === "object") {
    cards.push({
      type: "decision-recovery",
      severity: "blocker",
      title: "O5 decision recovery required",
      summary: "保存失敗後のrollback状態を確認するまで、新しいcandidate decisionは停止されます",
      host: recovery.host || null,
      candidateHash: recovery.candidateHash || null,
      createdAt: Number(recovery.createdAt) || 0,
      createdAtDisplay: _formatTime(recovery.createdAt),
      details: _details([
        { label: "Action", value: recovery.action },
        { label: "Reason", value: recovery.reason },
        { label: "Candidate", value: recovery.candidateHash },
        { label: "Save", value: recovery.save?.reason },
        { label: "Rollback save", value: recovery.rollbackSave?.reason }
      ])
    });
  }

  const operationRecovery = monitorData.inferredRecoveryOperationRecoveryRequired;
  if (operationRecovery && typeof operationRecovery === "object") {
    cards.push({
      type: "recovery-operation-recovery",
      severity: "blocker",
      title: "O6 recovery operation recovery required",
      summary: "復旧操作のrollback状態を保存できなかったため、状態確認まで新しい操作は停止されます",
      host: operationRecovery.target?.host || null,
      candidateHash: null,
      createdAt: Number(operationRecovery.createdAt) || 0,
      createdAtDisplay: _formatTime(operationRecovery.createdAt),
      details: _details([
        { label: "Operation", value: operationRecovery.operation },
        { label: "Reason", value: operationRecovery.reason },
        { label: "Failure", value: operationRecovery.failureReason },
        { label: "Target", value: operationRecovery.target },
        { label: "Save", value: operationRecovery.save?.reason },
        { label: "Rollback save", value: operationRecovery.rollbackSave?.reason }
      ])
    });
  }

  const repair = monitorData.ledgerRepairRequired && typeof monitorData.ledgerRepairRequired === "object"
    ? monitorData.ledgerRepairRequired
    : {};
  for (const [host, item] of Object.entries(repair)) {
    if (!item || typeof item !== "object") continue;
    const repairStatus = _ledgerRepairStatusView(host, item);
    cards.push({
      type: "ledger-repair",
      severity: "blocker",
      title: "Mount ledger repair required",
      summary: `${_hostLabel(host)} の装着区間が曖昧なため、暗黙クローズを停止しています`,
      host,
      spoolId: item.spoolId || null,
      candidateHash: null,
      createdAt: Number(item.detectedAtEpochMs) || 0,
      createdAtDisplay: _formatTime(item.detectedAtEpochMs),
      repairStatus: repairStatus.status,
      openIntervals: repairStatus.openIntervals,
      details: _details([
        { label: "Host", value: _hostLabel(host) },
        { label: "Spool", value: item.spoolId },
        { label: "Status", value: item.status },
        { label: "Current status", value: repairStatus.status?.status },
        { label: "Open intervals", value: repairStatus.openIntervals.length },
        { label: "Detected", value: _formatTime(item.detectedAtEpochMs) }
      ])
    });
  }

  const rejected = Array.isArray(monitorData.mountHistoryRejectedEvents)
    ? monitorData.mountHistoryRejectedEvents
    : [];
  const maxRejected = Math.max(1, Math.min(10, Number(options.maxRejectedEvents) || 3));
  if (rejected.length > 0) {
    const recent = rejected.slice(-maxRejected).reverse();
    cards.push({
      type: "mount-history-rejected",
      severity: "warning",
      title: "Rejected mount history events",
      summary: `${rejected.length}件の mountHistory event が隔離されています`,
      host: null,
      candidateHash: null,
      createdAt: 0,
      createdAtDisplay: "--",
      details: recent.map((item, index) => ({
        label: `Rejected ${index + 1}`,
        value: _formatValue({
          reason: item?.reason || "unknown",
          host: item?.event?.host || null,
          spoolId: item?.event?.spoolId || null,
          evId: item?.event?.evId || null
        })
      }))
    });
  }

  const recoveryEvents = Array.isArray(monitorData.inferredRecoveryEvents)
    ? monitorData.inferredRecoveryEvents
    : [];
  const maxRecoveryEvents = Math.max(1, Math.min(10, Number(options.maxRecoveryEvents) || 5));
  if (recoveryEvents.length > 0) {
    const recentEvents = recoveryEvents
      .slice()
      .sort((a, b) => (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0))
      .slice(0, maxRecoveryEvents);
    cards.push({
      type: "recovery-audit",
      severity: "info",
      title: "Recovery operation audit",
      summary: `${recoveryEvents.length}件の recovery 操作監査eventがあります`,
      host: null,
      candidateHash: null,
      createdAt: Number(recentEvents[0]?.createdAt) || 0,
      createdAtDisplay: _formatTime(recentEvents[0]?.createdAt),
      details: recentEvents.map((event, index) => ({
        label: `Audit ${index + 1}`,
        value: _formatValue({
          type: event?.type || "unknown",
          target: _recoveryEventTarget(event),
          actor: event?.actor || null,
          at: _formatTime(event?.createdAt)
        })
      }))
    });
  }

  const blockerCount = cards.filter(card => card.severity === "blocker").length;
  const warningCount = cards.filter(card => card.severity === "warning").length;
  const infoCount = cards.filter(card => card.severity === "info").length;
  return {
    hasIssues: cards.length > 0,
    totalCount: cards.length,
    blockerCount,
    warningCount,
    infoCount,
    cards
  };
}
