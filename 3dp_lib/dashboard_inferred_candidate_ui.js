/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 推定 candidate 操作 UI モジュール
 * @file dashboard_inferred_candidate_ui.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_inferred_candidate_ui
 *
 * 【機能内容サマリ】
 * - O5B Candidate Center として pending/処理済み candidate の一覧、詳細、監査 timeline を描画する。
 * - Confirm / Reject / Reassign / Undo の操作ダイアログを提供し、実更新は Decision Core へ委譲する。
 * - SATELLITE 子では Parent へ decision request を送り、readonly 子では操作ボタンを disabled にする。
 *
 * 【公開関数一覧】
 * - {@link createInferredCandidateCenterContent}：フィラメント管理モーダル用 Candidate Center を生成する
 *
 * @version 1.390.1266 (PR #417)
 * @since   1.390.1262 (PR #415)
 * @lastModified 2026-07-26 11:03:46
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

import { monitorData } from "./dashboard_data.js";
import {
  confirmInferredCandidate,
  rejectInferredCandidate,
  reassignInferredCandidate,
  undoInferredCandidateDecision
} from "./dashboard_inferred_candidate_decision.js";
import {
  INFERRED_CANDIDATE_FILTER,
  INFERRED_CANDIDATE_SORT,
  buildInferredCandidateViewModel,
  countPendingInferredCandidates,
  listInferredCandidateViewModels
} from "./dashboard_inferred_candidate_view.js";
import { showAlert } from "./dashboard_notification_manager.js";
import { showConfirmDialog } from "./dashboard_ui_confirm.js";
import { createEmptyState } from "./dashboard_ui_components.js";

/**
 * Reject UI で選べる理由。
 *
 * @constant {Array<{value:string,label:string}>}
 */
const REJECT_OPTIONS = Object.freeze([
  { value: "already-accounted", label: "Already handled" },
  { value: "not-same-spool", label: "Wrong detection" },
  { value: "operator-decision", label: "Operator decision" },
  { value: "other", label: "Other" }
]);

/**
 * reason code と日本語表示の対応表。
 *
 * @constant {Object.<string,string>}
 */
const REASON_LABELS = Object.freeze({
  candidate_not_found: "候補が見つかりません",
  candidate_not_pending: "候補はすでに処理済みです",
  candidate_hash_required: "候補IDが不正です",
  decision_not_authorized: "この端末では操作できません。親端末で実行してください",
  decision_request_not_sent: "親端末へ送信できません。接続と同期状態を確認してください",
  decision_recovery_required: "整合性確認が必要です",
  target_spool_required: "再割当て先スプールを選択してください",
  target_spool_same_as_candidate: "候補スプールと同じため再割当てできません",
  target_spool_not_found: "対象スプールが見つかりません",
  confirmed_remaining_unknown: "確定残量が不明なため処理できません",
  history_entry_missing: "対象履歴が不足しています",
  history_observation_ambiguous: "対象履歴が曖昧です",
  history_already_attributed: "履歴がすでに別スプールへ確定されています",
  candidate_ledger_event_exists: "この候補はすでに台帳へ反映されています",
  candidate_not_undoable: "この候補は取り消しできません",
  candidate_ledger_event_missing: "取り消し対象の台帳イベントが見つかりません",
  candidate_ledger_event_ambiguous: "取り消し対象の台帳イベントが曖昧です",
  candidate_ledger_event_spool_mismatch: "台帳イベントのスプールが一致しません",
  candidate_ledger_event_host_mismatch: "台帳イベントの端末情報が一致しません",
  candidate_history_link_missing: "取り消し対象の履歴帰属が見つかりません",
  candidate_history_link_ambiguous: "取り消し対象の履歴帰属が曖昧です",
  candidate_history_snapshot_missing: "取り消し前の履歴情報が不足しています",
  candidate_history_snapshot_invalid: "取り消し前の履歴情報が不正です",
  candidate_history_snapshot_ambiguous: "取り消し前の履歴情報が曖昧です",
  candidate_ledger_event_total_mismatch: "台帳イベントと候補の消費量が一致しません",
  invalid_reject_reason: "否認理由が不正です",
  rollback_durable_save_failed: "復旧状態の保存に失敗しました"
});

/**
 * warning code と日本語表示の対応表。
 *
 * @constant {Object.<string,string>}
 */
const WARNING_LABELS = Object.freeze({
  "history-ambiguous": "対象履歴が曖昧です",
  "history-missing": "対象履歴の一部が見つかりません",
  "history-already-attributed": "対象履歴が既に帰属済みです",
  "spool-missing": "候補スプールが見つかりません",
  "remaining-unknown": "確定残量が不明です",
  "remaining-insufficient": "確定残量が推定消費量より少ない状態です",
  "low-confidence": "信頼度が低い候補です",
  "decision-recovery-required": "整合性確認が必要です",
  "relay-readonly": "この端末は閲覧専用です"
});

/**
 * ダイアログ内 form ID の単調カウンタ。
 *
 * @private
 * @type {number}
 */
let _dialogSeq = 0;

/**
 * DOM 要素を作成する。
 *
 * @private
 * @function _el
 * @param {string} tagName - タグ名。
 * @param {string} [className=""] - className。
 * @param {string} [text=""] - textContent。
 * @returns {HTMLElement} 作成した要素。
 */
function _el(tagName, className = "", text = "") {
  const el = document.createElement(tagName);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

/**
 * reason code を UI 表示へ変換する。
 *
 * @private
 * @function _reasonLabel
 * @param {?string} reason - reason code。
 * @returns {string} 表示文。
 */
function _reasonLabel(reason) {
  return REASON_LABELS[reason] || reason || "処理に失敗しました";
}

/**
 * HTML 属性/本文へ入れる文字列を escape する。
 *
 * @private
 * @function _escapeHtml
 * @param {*} value - escape 対象。
 * @returns {string} HTML escape 済み文字列。
 */
function _escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 操作者情報を生成する。
 *
 * 【詳細説明】
 * - 現時点では認証基盤がないため local-user を固定値として渡す。
 * - Decision Core 側は文字列 actor を監査 event に保存し、将来のロール/ユーザーID化へ備える。
 *
 * @private
 * @function _actor
 * @returns {string} actor ID。
 */
function _actor() {
  return "local-user";
}

/**
 * ボタンを disabled にしながら非同期操作を実行する。
 *
 * @private
 * @function _withBusy
 * @param {HTMLElement} root - 操作中にボタンを無効化する範囲。
 * @param {Function} task - 実行する async function。
 * @returns {Promise<*>} task の戻り値。
 */
async function _withBusy(root, task) {
  const buttons = [...root.querySelectorAll("button, select")];
  const previousDisabled = new Map(buttons.map(button => [button, button.disabled]));
  buttons.forEach(button => { button.disabled = true; });
  try {
    return await task();
  } finally {
    buttons.forEach(button => { button.disabled = previousDisabled.get(button) === true; });
  }
}

/**
 * 状態 badge を生成する。
 *
 * @private
 * @function _statusBadge
 * @param {Object} vm - candidate ViewModel。
 * @returns {HTMLElement} badge。
 */
function _statusBadge(vm) {
  const badge = _el("span", `ic-status ic-status-${vm.status}`, vm.statusLabel);
  return badge;
}

/**
 * 色 swatch を生成する。
 *
 * @private
 * @function _swatch
 * @param {string} color - CSS color。
 * @returns {HTMLElement} swatch。
 */
function _swatch(color) {
  const swatch = _el("span", "ic-color-swatch");
  if (color) swatch.style.background = color;
  return swatch;
}

/**
 * key/value 行を生成する。
 *
 * @private
 * @function _kv
 * @param {string} label - ラベル。
 * @param {string} value - 値。
 * @returns {HTMLElement} 行。
 */
function _kv(label, value) {
  const row = _el("div", "ic-kv");
  row.append(_el("span", "ic-kv-label", label), _el("span", "ic-kv-value", value));
  return row;
}

/**
 * warning chips を生成する。
 *
 * @private
 * @function _warningChips
 * @param {Array<string>} codes - warning code 配列。
 * @returns {HTMLElement} chips wrapper。
 */
function _warningChips(codes) {
  const wrap = _el("div", "ic-warning-row");
  for (const code of codes) {
    wrap.appendChild(_el("span", "ic-warning-chip", WARNING_LABELS[code] || code));
  }
  return wrap;
}

/**
 * active spool の選択肢を返す。
 *
 * @private
 * @function _selectableSpools
 * @param {Object} vm - candidate ViewModel。
 * @returns {Array<Object>} 選択可能 spool 配列。
 */
function _selectableSpools(vm) {
  return (monitorData.filamentSpools || [])
    .filter(spool => spool && !spool.deleted && !spool.isDeleted && String(spool.id) !== String(vm.candidateSpoolId));
}

/**
 * Confirm 操作の確認ダイアログを表示する。
 *
 * @private
 * @function _confirmAction
 * @param {Object} vm - candidate ViewModel。
 * @returns {Promise<boolean>} 実行する場合 true。
 */
async function _confirmAction(vm) {
  const body = _el("div", "ic-confirm-summary");
  body.append(
    _kv("対象", vm.candidateSpoolName),
    _kv("推定消費", vm.usedDisplay),
    _kv("確定残量", vm.confirmedRemainingDisplay),
    _kv("確定後", vm.projectedRemainingDisplay),
    _kv("対象ジョブ", `${vm.jobCount}件`)
  );
  const ok = await showConfirmDialog({
    level: "warn",
    title: "フィラメント消費を確定",
    html: body.outerHTML,
    confirmText: "この内容で確定",
    cancelText: "キャンセル"
  });
  return ok === true;
}

/**
 * Reject 操作用ダイアログを表示して入力を取得する。
 *
 * @private
 * @function _rejectAction
 * @returns {Promise<?{reason:string,note:string}>} 入力結果。キャンセル時は null。
 */
async function _rejectAction() {
  const formId = `ic-reject-${++_dialogSeq}`;
  const options = REJECT_OPTIONS
    .map(item => `<option value="${_escapeHtml(item.value)}">${_escapeHtml(item.label)}</option>`)
    .join("");
  const ok = await showConfirmDialog({
    level: "warn",
    title: "候補を否認",
    html:
      `<form id="${formId}" class="ic-dialog-form">` +
      `<label>Reason<select name="reason">${options}</select></label>` +
      `<label>Note<textarea name="note" rows="3"></textarea></label>` +
      `</form>`,
    confirmText: "否認する",
    cancelText: "キャンセル"
  });
  if (ok !== true) return null;
  const form = document.getElementById(formId);
  return {
    reason: form?.elements?.reason?.value || "operator-decision",
    note: form?.elements?.note?.value || ""
  };
}

/**
 * Reassign 操作用ダイアログを表示して target spool を取得する。
 *
 * @private
 * @function _reassignAction
 * @param {Object} vm - candidate ViewModel。
 * @returns {Promise<?string>} target spool ID。キャンセル時は null。
 */
async function _reassignAction(vm) {
  const spools = _selectableSpools(vm);
  if (spools.length === 0) {
    showAlert("再割当て可能なスプールがありません", "warn");
    return null;
  }
  const formId = `ic-reassign-${++_dialogSeq}`;
  const options = spools.map(spool => {
    const remaining = Number.isFinite(Number(spool.remainingLengthMm))
      ? `${Math.round(Number(spool.remainingLengthMm)).toLocaleString()} mm`
      : "残量不明";
    const label = `${spool.name || spool.id} / ${spool.materialName || spool.material || ""} / ${remaining}`;
    return `<option value="${_escapeHtml(spool.id)}">${_escapeHtml(label)}</option>`;
  }).join("");
  const ok = await showConfirmDialog({
    level: "warn",
    title: "別スプールへ再割当て",
    html:
      `<form id="${formId}" class="ic-dialog-form">` +
      `<label>Spool<select name="targetSpoolId">${options}</select></label>` +
      `</form>`,
    confirmText: "再割当てして確定",
    cancelText: "キャンセル"
  });
  if (ok !== true) return null;
  const form = document.getElementById(formId);
  return form?.elements?.targetSpoolId?.value || null;
}

/**
 * Undo 操作の確認ダイアログを表示する。
 *
 * 【詳細説明】
 * - Undo は O5 が確定した残量・履歴帰属・usedLengthLog を戻すため、実行前に対象と消費量を表示する。
 * - 実際に戻せるかどうかは Decision Core / Ledger 側で再検証する。
 *
 * @private
 * @function _undoAction
 * @param {Object} vm - candidate ViewModel。
 * @returns {Promise<boolean>} 実行する場合 true。
 */
async function _undoAction(vm) {
  const body = _el("div", "ic-confirm-summary");
  body.append(
    _kv("対象", vm.candidateSpoolName),
    _kv("取り消す消費", vm.usedDisplay),
    _kv("現在状態", vm.statusLabel),
    _kv("対象ジョブ", `${vm.jobCount}件`)
  );
  const ok = await showConfirmDialog({
    level: "warn",
    title: "確定済み候補を取り消し",
    html: body.outerHTML,
    confirmText: "取り消す",
    cancelText: "キャンセル"
  });
  return ok === true;
}

/**
 * decision 結果を通知し、必要なら再描画する。
 *
 * @private
 * @function _handleDecisionResult
 * @param {Object} result - Decision Core の戻り値。
 * @param {Function} render - 再描画関数。
 * @param {Function} [onAfterDecision] - 外部再描画 hook。
 * @returns {void}
 */
function _handleDecisionResult(result, render, onAfterDecision) {
  if (result?.ok) {
    const label = result.reason === "confirmed" ? "確定しました"
      : result.reason === "reassigned" ? "再割当てを確定しました"
        : result.reason === "rejected" ? "否認しました"
          : result.reason === "undone" ? "取り消しました"
            : result.reason === "decision_requested" ? "親端末へ送信しました"
              : "処理しました";
    showAlert(label, "success");
    try { onAfterDecision?.(result); } catch { /* noop */ }
    render();
    return;
  }
  showAlert(_reasonLabel(result?.reason), "error");
  render();
}

/**
 * 詳細 modal の action buttons を生成する。
 *
 * @private
 * @function _appendActionButtons
 * @param {HTMLElement} wrap - ボタン追加先。
 * @param {Object} vm - candidate ViewModel。
 * @param {Function} render - 再描画関数。
 * @param {Function} close - modal close 関数。
 * @param {Function} [onAfterDecision] - 外部再描画 hook。
 * @returns {void}
 */
function _appendActionButtons(wrap, vm, render, close, onAfterDecision) {
  const readonlyNote = vm.readOnlyReason ? _el("div", "ic-readonly-note", "この端末はSatellite/閲覧専用です。親端末で操作してください。") : null;
  if (readonlyNote) wrap.appendChild(readonlyNote);

  const confirmBtn = _el("button", "ic-action-primary", "Confirm");
  confirmBtn.disabled = !vm.canConfirm;
  confirmBtn.addEventListener("click", async () => {
    await _withBusy(wrap, async () => {
      if (!await _confirmAction(vm)) return;
      const result = await confirmInferredCandidate(vm.candidateHash, { actor: _actor() });
      _handleDecisionResult(result, render, onAfterDecision);
      if (result?.ok) close();
    });
  });

  const rejectBtn = _el("button", "ic-action-secondary", "Reject");
  rejectBtn.disabled = !vm.canReject;
  rejectBtn.addEventListener("click", async () => {
    await _withBusy(wrap, async () => {
      const input = await _rejectAction();
      if (!input) return;
      const result = await rejectInferredCandidate(vm.candidateHash, { actor: _actor(), reason: input.reason, note: input.note });
      _handleDecisionResult(result, render, onAfterDecision);
      if (result?.ok) close();
    });
  });

  const reassignBtn = _el("button", "ic-action-secondary", "Reassign");
  reassignBtn.disabled = !vm.canReassign;
  reassignBtn.addEventListener("click", async () => {
    await _withBusy(wrap, async () => {
      const targetSpoolId = await _reassignAction(vm);
      if (!targetSpoolId) return;
      const result = await reassignInferredCandidate(vm.candidateHash, targetSpoolId, { actor: _actor() });
      _handleDecisionResult(result, render, onAfterDecision);
      if (result?.ok) close();
    });
  });

  const undoBtn = _el("button", "ic-action-secondary", "Undo");
  undoBtn.disabled = !vm.canUndo;
  undoBtn.addEventListener("click", async () => {
    await _withBusy(wrap, async () => {
      if (!await _undoAction(vm)) return;
      const result = await undoInferredCandidateDecision(vm.candidateHash, { actor: _actor() });
      _handleDecisionResult(result, render, onAfterDecision);
      if (result?.ok) close();
    });
  });

  wrap.append(confirmBtn, rejectBtn, reassignBtn, undoBtn);
}

/**
 * candidate 詳細 modal を表示する。
 *
 * @private
 * @function _showDetail
 * @param {Object} vm - candidate ViewModel。
 * @param {Function} render - 再描画関数。
 * @param {Function} [onAfterDecision] - 外部再描画 hook。
 * @returns {void}
 */
function _showDetail(vm, render, onAfterDecision) {
  const overlay = _el("div", "ic-detail-overlay");
  const modal = _el("div", "ic-detail-modal");
  const header = _el("div", "ic-detail-header");
  header.append(_el("span", "", "推定候補詳細"));
  const closeBtn = _el("button", "ic-icon-button", "\u00D7");
  closeBtn.addEventListener("click", () => overlay.remove());
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const body = _el("div", "ic-detail-body");
  const summary = _el("section", "ic-detail-section");
  summary.append(
    _statusBadge(vm),
    _kv("プリンタ", vm.hostLabel),
    _kv("候補スプール", vm.candidateSpoolName),
    _kv("推定消費", vm.usedDisplay),
    _kv("確定残量", vm.confirmedRemainingDisplay),
    _kv("確定後", vm.projectedRemainingDisplay),
    _kv("信頼度", vm.confidenceLabel)
  );
  if (vm.warningCodes.length) summary.appendChild(_warningChips(vm.warningCodes));
  body.appendChild(summary);

  const jobs = _el("section", "ic-detail-section");
  jobs.appendChild(_el("h4", "", "対象ジョブ"));
  const jobTable = _el("table", "ic-detail-table");
  const jobHead = document.createElement("thead");
  jobHead.innerHTML = "<tr><th>ファイル</th><th>使用量</th><th>帰属</th></tr>";
  const jobBody = document.createElement("tbody");
  for (const job of vm.jobs) {
    const tr = document.createElement("tr");
    tr.append(_el("td", "", job.filename), _el("td", "", job.usedDisplay), _el("td", "", job.attributionState));
    jobBody.appendChild(tr);
  }
  jobTable.append(jobHead, jobBody);
  jobs.appendChild(jobTable);
  body.appendChild(jobs);

  const audit = _el("section", "ic-detail-section");
  audit.appendChild(_el("h4", "", "根拠・監査"));
  audit.append(
    _kv("Candidate Hash", vm.candidateHash),
    _kv("Window ID", vm.windowId || "--"),
    _kv("Baseline Interval", vm.candidateBaselineIntervalId || "--"),
    _kv("Current Interval", vm.candidateCurrentIntervalId || "--")
  );
  const timeline = _el("div", "ic-timeline");
  for (const event of vm.events) {
    const row = _el("div", "ic-timeline-row");
    row.append(_el("span", "ic-timeline-type", event.type || "event"), _el("span", "ic-timeline-meta", `${event.status || ""} ${event.reason || ""}`.trim()));
    timeline.appendChild(row);
  }
  audit.appendChild(timeline);
  body.appendChild(audit);
  modal.appendChild(body);

  const actions = _el("div", "ic-detail-actions");
  _appendActionButtons(actions, vm, render, () => overlay.remove(), onAfterDecision);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

/**
 * 一覧 table row を生成する。
 *
 * @private
 * @function _row
 * @param {Object} vm - candidate ViewModel。
 * @param {Function} render - 再描画関数。
 * @param {Function} [onAfterDecision] - 外部再描画 hook。
 * @returns {HTMLTableRowElement} table row。
 */
function _row(vm, render, onAfterDecision) {
  const tr = document.createElement("tr");
  const statusTd = document.createElement("td");
  statusTd.appendChild(_statusBadge(vm));
  const spoolTd = document.createElement("td");
  spoolTd.append(_swatch(vm.candidateSpoolColor), document.createTextNode(vm.candidateSpoolName));
  const afterTd = document.createElement("td");
  afterTd.textContent = `${vm.confirmedRemainingDisplay} → ${vm.projectedRemainingDisplay}`;
  const openBtn = _el("button", "ic-open-button", "Open");
  openBtn.addEventListener("click", () => _showDetail(buildInferredCandidateViewModel(monitorData.inferredCandidateStore?.[vm.candidateHash] || vm), render, onAfterDecision));
  const actionTd = document.createElement("td");
  actionTd.appendChild(openBtn);
  tr.append(
    statusTd,
    _el("td", "", vm.hostLabel),
    spoolTd,
    _el("td", "", vm.usedDisplay),
    afterTd,
    _el("td", "", vm.confidenceLabel),
    _el("td", "", String(vm.jobCount)),
    _el("td", "", vm.createdAtDisplay),
    actionTd
  );
  return tr;
}

/**
 * Candidate Center 本体を生成する。
 *
 * 【詳細説明】
 * - フィラメント管理モーダル内の1タブとして使用する。
 * - filter/sort/refresh は表示モデルを作り直すだけで、candidate store や台帳は変更しない。
 * - detail modal の Confirm/Reject/Reassign は Decision Core を呼び、成功後に一覧を再描画する。
 *
 * @function createInferredCandidateCenterContent
 * @param {{host?:?string,onAfterDecision?:Function}} [options] - 初期 host と外部再描画 hook。
 * @returns {{el:HTMLElement,render:Function}} タブ要素と再描画関数。
 * @example
 * const center = createInferredCandidateCenterContent();
 */
export function createInferredCandidateCenterContent(options = {}) {
  const root = _el("div", "filament-manager-content ic-center");
  const toolbar = _el("div", "ic-toolbar");
  const count = _el("span", "ic-count");
  const statusSelect = document.createElement("select");
  for (const [value, label] of [
    [INFERRED_CANDIDATE_FILTER.PENDING, "Pending"],
    [INFERRED_CANDIDATE_FILTER.CONFIRMED, "Confirmed"],
    [INFERRED_CANDIDATE_FILTER.REJECTED, "Rejected"],
    [INFERRED_CANDIDATE_FILTER.REASSIGNED, "Reassigned"],
    [INFERRED_CANDIDATE_FILTER.SUPERSEDED, "Superseded"],
    [INFERRED_CANDIDATE_FILTER.UNDONE, "Undone"],
    [INFERRED_CANDIDATE_FILTER.ALL, "All"]
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    statusSelect.appendChild(option);
  }
  const sortSelect = document.createElement("select");
  for (const [value, label] of [
    [INFERRED_CANDIDATE_SORT.NEWEST, "Newest"],
    [INFERRED_CANDIDATE_SORT.OLDEST, "Oldest"],
    [INFERRED_CANDIDATE_SORT.CONFIDENCE, "Confidence"],
    [INFERRED_CANDIDATE_SORT.PRINTER, "Printer"],
    [INFERRED_CANDIDATE_SORT.SPOOL, "Spool"]
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    sortSelect.appendChild(option);
  }
  const refreshBtn = _el("button", "ic-open-button", "Refresh");
  toolbar.append(count, statusSelect, sortSelect, refreshBtn);
  const body = _el("div", "ic-list-wrap");
  root.append(toolbar, body);

  /**
   * Candidate Center の一覧表示を最新 store から再構築する。
   *
   * 【詳細説明】
   * - フィルタ・ソート・host 条件を ViewModel 層へ渡し、表示対象だけを描画する。
   * - 表示対象がない場合は共通 empty state を表示し、候補がある場合はテーブル行を再生成する。
   *
   * @function render
   * @returns {void} 戻り値はない。
   */
  function render() {
    const models = listInferredCandidateViewModels({
      status: statusSelect.value,
      sort: sortSelect.value,
      host: options.host || null
    });
    count.textContent = `Pending ${countPendingInferredCandidates(options.host || null)} / Total ${listInferredCandidateViewModels({ status: INFERRED_CANDIDATE_FILTER.ALL, host: options.host || null }).length}`;
    body.innerHTML = "";
    if (models.length === 0) {
      body.appendChild(createEmptyState({
        icon: "候補",
        title: "表示対象の候補はありません",
        message: "pending candidate が作成されるとここに表示されます"
      }));
      return;
    }
    const table = _el("table", "ic-table");
    const thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>状態</th><th>プリンタ</th><th>候補スプール</th><th>推定消費</th><th>残量</th><th>信頼度</th><th>ジョブ</th><th>作成</th><th>操作</th></tr>";
    const tbody = document.createElement("tbody");
    for (const vm of models) tbody.appendChild(_row(vm, render, options.onAfterDecision));
    table.append(thead, tbody);
    body.appendChild(table);
  }

  statusSelect.addEventListener("change", render);
  sortSelect.addEventListener("change", render);
  refreshBtn.addEventListener("click", render);
  render();
  return { el: root, render };
}
