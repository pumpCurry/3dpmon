/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 material topology パネル描画モジュール
 * @file dashboard_material_topology_panel.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_topology_panel
 *
 * 【機能内容サマリ】
 * - Printer Core v3 material topology view model をフィラメントパネルへread-only描画
 * - 外部スプール1本とCFS/CFS-Cの設定台数分slotを同一UIで表示
 * - selected、残量、材料色、装填状態、assignment、fresh/staleを表示する
 * - 明示的なcommand authority候補と送信hookが揃った場合だけ、CFS操作ボタンを有効化する
 *
 * 【公開関数一覧】
 * - {@link renderMaterialTopologyPanel}：material topology view model をDOMへ描画
 *
 * @version 1.390.1532 (PR #439)
 * @since   1.390.1362 (PR #432)
 * @lastModified 2026-08-31 17:24:20
 * -----------------------------------------------------------
 * @todo
 * - Gate 19.5後続で、操作結果と実観測stateの相関表示をより詳細化する
 */

"use strict";

import { getMaterialCssColor } from "./dashboard_material_color.js";

/**
 * CFS操作ボタン定義。
 *
 * 【詳細説明】
 * - action はUI内部名、commandKind は Printer Core v3 command authority の command kind。
 * - 表示ラベルは短くし、詳細はtitle/aria-labelへ逃がす。
 *
 * @constant {Array<object>}
 */
const MATERIAL_CONTROL_BUTTONS = Object.freeze([
  Object.freeze({ action: "select", commandKind: "cfs-slot-select", label: "選択", title: "このCFSスロットを選択します" }),
  Object.freeze({ action: "load", commandKind: "cfs-load", label: "装填", title: "このCFSスロットのフィラメントを装填します" }),
  Object.freeze({ action: "unload", commandKind: "cfs-unload", label: "取外", title: "このCFSスロットのフィラメントを取り外します" }),
  Object.freeze({ action: "feed", commandKind: "cfs-feed", label: "送出", title: "このCFSスロットのフィラメントを送ります" }),
  Object.freeze({ action: "retract", commandKind: "cfs-retract", label: "巻戻", title: "このCFSスロットのフィラメントを戻します" }),
]);

/**
 * CFS/CFS-C操作の既定timeout ms。
 *
 * 【詳細説明】
 * - UIはPrinter Core dispatcherの戻りを待つが、transportや通信層が返らない場合に
 *   ボタンが押下中のまま固着しないよう、表示境界でtimeoutを設ける。
 *
 * @constant {number}
 */
const DEFAULT_CFS_CONTROL_TIMEOUT_MS = 15000;

/**
 * HTMLテキストとして安全に表示する文字列を返す。
 *
 * 【詳細説明】
 * - DOM APIでtextContentへ入れる前の表示用fallbackとして使う。
 *
 * @private
 * @param {*} value - 表示値候補
 * @param {string=} fallback - 空値時のfallback
 * @returns {string} 表示用文字列
 */
function displayText(value, fallback = "--") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

/**
 * CSS class名へ安全に埋め込めるpresence値を返す。
 *
 * 【詳細説明】
 * - ViewModel由来のpresenceに未知値が来ても、DOM class注入にならないよう許可リストで制限する。
 *
 * @private
 * @param {*} value - presence候補
 * @returns {string} presence class suffix
 */
function normalizePresenceClass(value) {
  return ["loaded", "empty", "unobserved", "unknown"].includes(value)
    ? value
    : "unknown";
}

/**
 * 日時を `yyyy-mm-dd hh:mm:ss` へ変換する。
 *
 * 【詳細説明】
 * - CFSの観測鮮度は「最新/最終観測」だけでは判断しづらいため、利用者のローカル時刻で表示する。
 *
 * @private
 * @param {*} value - 日時候補
 * @returns {string|null} 表示用日時、またはnull
 */
function formatLocalDateTime(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  const pad = (numberValue) => String(numberValue).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + " " + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join(":");
}

/**
 * topology stateを利用者向けの日本語表示へ変換する。
 *
 * 【詳細説明】
 * - fresh/staleの語だけでは「いつの値か」が分からないため、観測済みなら常に日時を表示する。
 * - 通信中は状態表示の前に `(📡: xx秒)` を付け、probe応答待ちであることを明示する。
 *
 * @private
 * @param {*} value - topology state候補
 * @param {object=} observation - ViewModelの観測情報
 * @returns {string} 利用者向け状態ラベル
 */
function formatTopologyState(value, observation = {}) {
  const observedAtText = formatLocalDateTime(observation?.lastObservedAt);
  const request = observation?.request && typeof observation.request === "object" ? observation.request : {};
  const requestPrefix = request.state === "in-flight" && Number.isFinite(Number(request.elapsedSeconds))
    ? `(📡: ${Math.max(0, Number(request.elapsedSeconds))}秒) `
    : "";
  if (observedAtText) {
    return `${requestPrefix}${value === "stale" ? "最終観測" : "状態"}: ${observedAtText}`;
  }
  if (value === "stale") {
    return `${requestPrefix}状態: 最終観測時刻不明`;
  }
  return `${requestPrefix}状態: 取得待ち`;
}

/**
 * presenceを利用者向けの日本語表示へ変換する。
 *
 * 【詳細説明】
 * - loaded/empty/unobserved/unknownを現場で誤読しにくい短い日本語へ変換する。
 *
 * @private
 * @param {string} presence - 正規化済みpresence
 * @returns {string} 利用者向けpresenceラベル
 */
function formatPresenceState(presence) {
  if (presence === "loaded") {
    return "装填中";
  }
  if (presence === "empty") {
    return "未装填";
  }
  if (presence === "unobserved") {
    return "未観測";
  }
  return "装填状態 不明";
}

/**
 * material colorをCSSで使える表示値へ変換する。
 *
 * 【詳細説明】
 * - firmware由来の色はユーザー/機器設定値として扱い、正規表現で安全なhexだけをswatchへ反映する。
 *
 * @private
 * @param {object|null|undefined} material - material view
 * @returns {string|null} CSS色値、またはnull
 */
function resolveMaterialColor(material) {
  return getMaterialCssColor(material?.color);
}

/**
 * 残量表示情報を生成する。
 *
 * 【詳細説明】
 * - invalid値は0%へ丸めて表示せず、「不明」として報告値異常を明示する。
 * - stale中の有効値は現在値ではなく「最終観測」として表示する。
 *
 * @private
 * @param {object|null|undefined} remaining - ViewModelのremaining情報
 * @param {boolean=} isStale - trueなら最終観測値として表示する
 * @returns {{text: string, className: string, title: string}} 表示情報
 */
function formatRemaining(remaining, isStale = false) {
  if (!remaining || remaining.displayPercent === null || remaining.displayPercent === undefined) {
    return {
      text: "残量 未観測",
      className: "mtv-remaining-unobserved",
      title: "残量はまだ観測されていません",
    };
  }
  const rawTitle = remaining.rawPercent === null || remaining.rawPercent === undefined
    ? ""
    : `装置報告値: ${remaining.rawPercent}%`;
  if (remaining.valid === false) {
    return {
      text: "残量 不明 ⚠",
      className: "mtv-remaining-invalid",
      title: rawTitle ? `${rawTitle}（報告値異常）` : "報告値異常のため残量は不明です",
    };
  }
  const percent = Number(remaining.displayPercent);
  if (!Number.isFinite(percent)) {
    return {
      text: "残量 未観測",
      className: "mtv-remaining-unobserved",
      title: "残量はまだ観測されていません",
    };
  }
  return {
    text: `${isStale ? "最終観測" : "残量"} ${Math.round(percent)}%`,
    className: isStale ? "mtv-remaining-stale" : "mtv-remaining-valid",
    title: rawTitle,
  };
}

/**
 * assignment表示文字列を生成する。
 *
 * 【詳細説明】
 * - tool割当が未観測の場合は空文字を返し、slotの主要情報を圧迫しない。
 *
 * @private
 * @param {Array<object>} assignments - assignment一覧
 * @returns {string} 表示文字列
 */
function formatAssignments(assignments) {
  const values = (Array.isArray(assignments) ? assignments : [])
    .map((assignment) => assignment.assignmentId)
    .filter(Boolean);
  return values.length > 0 ? values.join(", ") : "";
}

/**
 * assignmentを利用者向けの短い説明へ変換する。
 *
 * 【詳細説明】
 * - `T1A` は物理slot名ではなくG-code/slicer側のtool aliasなので、裸表示せず「印刷割当」を付ける。
 *
 * @private
 * @param {Array<object>} assignments - assignment一覧
 * @param {boolean=} isStale - trueなら最終観測値として表示する
 * @returns {string} 表示文字列
 */
function formatAssignmentLabel(assignments, isStale = false) {
  const assignmentText = formatAssignments(assignments);
  if (!assignmentText) {
    return "";
  }
  return `${isStale ? "最終観測: " : ""}印刷割当 ${assignmentText}`;
}

/**
 * assignment badge の補足説明を返す。
 *
 * 【詳細説明】
 * - タッチ環境ではtooltipを見られない場合もあるが、desktopでは `T1A` を物理スロット名と誤読しないための補助にする。
 *
 * @private
 * @function getAssignmentTitle
 * @returns {string} assignment badge 用 title
 */
function getAssignmentTitle() {
  return "T1A/T1B等は物理CFSスロット名ではなく、印刷/G-code側の割当識別子です。";
}

/**
 * 指定tag/classのDOM要素を生成する。
 *
 * 【詳細説明】
 * - renderer内のDOM構築を読みやすくする小さなヘルパー。
 *
 * @private
 * @param {Document} documentRef - DOM document
 * @param {string} tagName - 生成するtag名
 * @param {string=} className - 付与するclassName
 * @param {string=} text - textContent
 * @returns {HTMLElement} 生成要素
 */
function createElement(documentRef, tagName, className = "", text = "") {
  const element = documentRef.createElement(tagName);
  if (className) {
    element.className = className;
  }
  if (text) {
    element.textContent = text;
  }
  return element;
}

/**
 * CFS操作actionの利用者向けラベルを返す。
 *
 * @private
 * @param {string} action - CFS操作action
 * @returns {string} 利用者向け短縮ラベル
 */
function formatControlActionLabel(action) {
  const match = MATERIAL_CONTROL_BUTTONS.find((button) => button.action === action);
  return match?.label || displayText(action, "操作");
}

/**
 * CFS操作timeoutを有限な正数へ正規化する。
 *
 * @private
 * @param {*} value - timeout ms候補
 * @returns {number} timeout ms
 */
function normalizeControlTimeoutMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.max(100, Math.floor(numeric));
  }
  return DEFAULT_CFS_CONTROL_TIMEOUT_MS;
}

/**
 * command resultが失敗系かを判定する。
 *
 * 【詳細説明】
 * - CommandResultのstatusはtransport層により少し揺れるため、失敗として利用者へ表示すべき値だけを
 *   明示的に列挙する。
 *
 * @private
 * @param {*} result - command hookの戻り値
 * @returns {boolean} 失敗表示すべき場合true
 */
function isFailedCommandResult(result) {
  const status = String(result?.status || result?.result || "").trim().toLowerCase();
  return [
    "rejected",
    "failed",
    "error",
    "transport-error",
    "confirmation-error",
    "timeout",
  ].includes(status) || Boolean(result?.error);
}

/**
 * command resultがtransport受理のみで観測未確認か判定する。
 *
 * 【詳細説明】
 * - Printer Core CommandResultでは、transportAcceptedでもexpected-state/correlationが未確認なら
 *   `completed:false` になる。UIではこれを成功色にせず、観測待ちとして扱う。
 *
 * @private
 * @param {*} result - command hookの戻り値
 * @returns {boolean} 観測未確認として扱う場合true
 */
function isUnconfirmedCommandResult(result) {
  if (!result || typeof result !== "object") {
    return false;
  }
  if (result.completed === false) {
    return true;
  }
  if (result.postCommandObservation?.confirmed === false) {
    return true;
  }
  if (result.confirmation?.checked === true && result.confirmation?.confirmed !== true) {
    return true;
  }
  return false;
}

/**
 * CFS command hookの戻り値を表示判定用CommandResultへ正規化する。
 *
 * 【詳細説明】
 * - integration層は `{ accepted:true, result }` のenvelopeを返すため、rendererが外側だけを見ると
 *   内側の `completed:false` を見落として成功表示してしまう。表示判定では内側CommandResultを優先する。
 * - integration自体が拒否した場合は、CommandResult風のrejected objectへ寄せて既存失敗表示へ流す。
 *
 * @private
 * @function normalizeCommandHookResult
 * @param {*} result - command hook の戻り値
 * @returns {object|null} 表示判定用CommandResult風object
 */
function normalizeCommandHookResult(result) {
  if (!result || typeof result !== "object") {
    return result || null;
  }
  if (result.accepted === true && result.result && typeof result.result === "object") {
    return result.result;
  }
  if (result.accepted === false) {
    return {
      status: "rejected",
      reason: result.reason || "cfs-command-rejected",
      error: result.error || {
        code: result.reason || "cfs-command-rejected",
      },
    };
  }
  return result;
}

/**
 * command resultから利用者へ見せる失敗理由を取り出す。
 *
 * @private
 * @param {*} result - command hookの戻り値
 * @returns {string} 表示用失敗理由
 */
function formatCommandFailureReason(result) {
  const code = displayText(result?.error?.code || result?.reason || result?.status, "");
  const errors = Array.isArray(result?.error?.errors) ? result.error.errors.join(", ") : "";
  const message = displayText(result?.error?.message, "");
  return [code, errors, message].filter(Boolean).join(" / ") || "理由不明";
}

/**
 * CFS command実行状態を生成する。
 *
 * 【詳細説明】
 * - 再描画でDOMが作り直されても、非冪等commandのsubmitting/submitted/probing/unknown状態を失わないため、
 *   renderer handleのclosureに保持する。
 *
 * @private
 * @returns {object} command execution state
 */
function createCommandExecutionState() {
  return {
    state: "idle",
    sourceId: null,
    action: null,
    commandKind: null,
    message: "",
    statusClass: "idle",
    baselineObservationKey: null,
    reconciliation: null,
    refreshers: new Set(),
  };
}

/**
 * CFS commandの未確認状態をUIでどうreconcileできるかを返す。
 *
 * 【詳細説明】
 * - `cfs-slot-select` はNormalizedState上のselected sourceで確認できるため、送信前は未選択だったslotが
 *   次観測で選択中になった場合だけprinter単位mutexを解除する。
 * - `load/unload/feed/retract` は現時点では物理状態の権威的なexpected-stateが未確定なので、
 *   単に観測時刻が進んだだけでは再操作可能にしない。
 *
 * @private
 * @function createSubmittedCommandReconciliation
 * @param {object} commandPayload - rendererからcommand hookへ渡したpayload
 * @param {object} buttonConfig - CFS操作ボタン定義
 * @param {object|null|undefined} row - ViewModel source row
 * @returns {object} submitted状態のreconcile方針
 */
function createSubmittedCommandReconciliation(commandPayload, buttonConfig, row = null) {
  if (buttonConfig?.commandKind === "cfs-slot-select" && commandPayload?.sourceId) {
    return {
      kind: "selected-source",
      expectedSourceId: commandPayload.sourceId,
      wasSelectedAtSubmit: row?.selected === true,
    };
  }
  return {
    kind: "manual-physical-confirmation",
    expectedSourceId: commandPayload?.sourceId || null,
  };
}

/**
 * view modelの観測進行を比較するためのkeyを返す。
 *
 * 【詳細説明】
 * - submitted状態は「送信は受理されたが観測確認が未完了」のため、次のmaterial provider観測が来たら
 *   人間が再判断できるようprinter単位mutexを解除する。日時が無い環境では勝手に解除しない。
 *
 * @private
 * @function getViewModelObservationKey
 * @param {object|null|undefined} viewModel - material topology view model
 * @returns {string|null} 観測比較key
 */
function getViewModelObservationKey(viewModel) {
  return displayText(viewModel?.observation?.lastObservedAt, "") ||
    displayText(viewModel?.cfs?.provider?.lastObservedAt, "") ||
    null;
}

/**
 * ViewModel内で指定sourceIdがselectedとして観測されているか判定する。
 *
 * 【詳細説明】
 * - 外部スプールとCFS unit slotの両方を同じsource rowとして扱い、sourceId一致とselected=trueを確認する。
 * - ここはUI mutex解除の補助判定であり、command authorityのpost-command correlationを代替しない。
 *
 * @private
 * @function isSourceSelectedInViewModel
 * @param {object|null|undefined} viewModel - material topology view model
 * @param {string|null|undefined} expectedSourceId - 期待sourceId
 * @returns {boolean} 指定sourceがselectedとして観測された場合true
 */
function isSourceSelectedInViewModel(viewModel, expectedSourceId) {
  const sourceId = displayText(expectedSourceId, "");
  if (!sourceId) {
    return false;
  }
  const rows = [];
  if (Array.isArray(viewModel?.external)) {
    rows.push(...viewModel.external);
  }
  for (const unit of Array.isArray(viewModel?.units) ? viewModel.units : []) {
    if (Array.isArray(unit?.slots)) {
      rows.push(...unit.slots);
    }
  }
  return rows.some((row) => row?.sourceId === sourceId && row?.selected === true);
}

/**
 * 未確認command状態を新しい観測でreconcileする。
 *
 * 【詳細説明】
 * - `submitted` はtransport受理後の観測待ちだが、観測時刻だけでは非冪等な物理操作の結果を確定できない。
 * - selected-sourceをexpected-stateとして確認できる操作だけ、対象sourceのselected観測後にmutexを解除する。
 * - `unknown` はtimeout/transport-error等で実機状態が不明なため、自動解除せず人間の再確認を要求する。
 *
 * @private
 * @function reconcileCommandExecutionState
 * @param {object} executionState - command execution state
 * @param {object|null|undefined} viewModel - 最新view model
 * @returns {void}
 */
function reconcileCommandExecutionState(executionState, viewModel) {
  if (!["submitted", "probing"].includes(executionState?.state)) {
    return;
  }
  const currentObservationKey = getViewModelObservationKey(viewModel);
  if (!currentObservationKey || !executionState.baselineObservationKey || currentObservationKey === executionState.baselineObservationKey) {
    return;
  }
  const reconciliation = executionState.reconciliation || {};
  if (reconciliation.kind === "selected-source") {
    if (reconciliation.wasSelectedAtSubmit === true) {
      executionState.state = "unknown";
      executionState.baselineObservationKey = currentObservationKey;
      executionState.statusClass = "warning";
      executionState.message = `${executionState.message || "CFS操作は送信済みです。"} 送信前から選択済みだったため再操作を保留しています。`;
      return;
    }
    if (!isSourceSelectedInViewModel(viewModel, reconciliation.expectedSourceId)) {
      executionState.state = "probing";
      executionState.baselineObservationKey = currentObservationKey;
      executionState.statusClass = "warning";
      executionState.message = `${executionState.message || "CFS操作は送信済みです。"} 最新観測を受信しましたが、対象スロットの選択はまだ確認できません。`;
      return;
    }
    executionState.state = "confirmed";
    executionState.statusClass = "success";
    executionState.message = `${executionState.message || "CFS操作は送信済みです。"} 最新観測で対象スロットの選択を確認しました。再操作できます。`;
    executionState.reconciliation = null;
    return;
  }
  executionState.state = "probing";
  executionState.baselineObservationKey = currentObservationKey;
  executionState.statusClass = "warning";
  executionState.message = `${executionState.message || "CFS操作は送信済みです。"} 最新観測を受信しましたが、物理状態の確認方法が未確定のため再操作を保留しています。`;
}

/**
 * CFS command実行状態がprinter単位の操作mutexを要求するか判定する。
 *
 * 【詳細説明】
 * - CFSのmaterial pathを共有する可能性があるため、slot単位ではなくpanel/printer単位で停止する。
 *
 * @private
 * @param {object} executionState - command execution state
 * @returns {boolean} 同一printerのCFS操作を止める場合true
 */
function isCommandMutexActive(executionState) {
  return ["running", "submitting", "submitted", "settling", "probing", "unknown"].includes(executionState?.state);
}

/**
 * 再描画時にslotへ表示すべきcommand statusを返す。
 *
 * 【詳細説明】
 * - 実行したslotだけにstatus文言を復元し、他slotはprinter単位mutexによるdisabledだけを反映する。
 *
 * @private
 * @param {object} row - ViewModel source row
 * @param {object} executionState - command execution state
 * @returns {{state: string, message: string, executionState: string}|null} 表示対象status
 */
function getVisibleExecutionStatusForRow(row, executionState) {
  if (!executionState?.message || executionState.sourceId !== row?.sourceId) {
    return null;
  }
  return {
    state: executionState.statusClass || "idle",
    message: executionState.message,
    executionState: executionState.state || "idle",
  };
}

/**
 * 現在描画中のCFS操作ボタンをすべて再評価する。
 *
 * 【詳細説明】
 * - submitting/submitted/probing/unknownはprinter単位mutexなので、クリックしたslotだけでなく同じpanel内の
 *   全slotのbutton状態を即時に揃える。
 *
 * @private
 * @param {object} executionState - command execution state
 * @param {boolean=} busy - 明示busy
 * @returns {void}
 */
function refreshAllCommandButtons(executionState, busy = false) {
  if (!executionState?.refreshers || typeof executionState.refreshers.forEach !== "function") {
    return;
  }
  executionState.refreshers.forEach((refresh) => refresh(busy));
}

/**
 * slot操作ステータス行を更新する。
 *
 * @private
 * @param {HTMLElement} statusElement - ステータス表示DOM
 * @param {string} state - running/success/error/timeout/warning/idle
 * @param {string} message - 表示文
 * @param {string=} executionState - UI操作の段階状態
 * @returns {void}
 */
function setCommandStatus(statusElement, state, message, executionState = "") {
  if (!statusElement) {
    return;
  }
  statusElement.className = `mtv-command-status mtv-command-status-${state}`;
  statusElement.textContent = message || "";
  if (message && executionState) {
    statusElement.dataset.executionState = executionState;
  } else {
    delete statusElement.dataset.executionState;
  }
  statusElement.hidden = !message;
}

/**
 * Promiseをtimeout付きで待つ。
 *
 * 【詳細説明】
 * - rendererはtransportの再試行や成功判定を行わないが、UI固着だけは防止する。
 *
 * @private
 * @param {Promise<*>} promise - command hook promise
 * @param {number} timeoutMs - timeout ms
 * @returns {Promise<*>} command hook結果
 */
function waitForCommandWithTimeout(promise, timeoutMs) {
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error("cfs-command-timeout");
      error.code = "cfs-command-timeout";
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  });
}

/**
 * renderer option と view model authority から操作方針を生成する。
 *
 * 【詳細説明】
 * - ViewModelだけ、またはrenderer optionだけでは操作を許可しない。
 * - renderer側の`allowedActions`未指定は「全許可」ではなく空許可として扱い、二重whitelistを必須にする。
 * - 実送信前にはcommand dispatcherが再検証するため、ここはUI上の一次disabled判定に限定する。
 *
 * @private
 * @param {object} viewModel - material topology view model
 * @param {object} options - renderer options
 * @returns {object} 操作方針
 */
function createControlPolicy(viewModel, options) {
  const authority = viewModel?.authority || {};
  const optionControl = options?.control && typeof options.control === "object" ? options.control : {};
  const authorityActions = new Set(Array.isArray(authority.allowedActions) ? authority.allowedActions : []);
  const optionActions = new Set(Array.isArray(optionControl.allowedActions) ? optionControl.allowedActions : []);
  const allowedActions = new Set([...authorityActions].filter((action) => optionActions.has(action)));
  const hasSendHook = typeof optionControl.onCommand === "function";
  const canSendCommands = authority.canSendCommands === true &&
    optionControl.canSendCommands === true &&
    hasSendHook &&
    allowedActions.size > 0;
  return {
    canSendCommands,
    showControls: optionControl.showControls === true || authority.canSendCommands === true,
    allowedActions,
    onCommand: hasSendHook ? optionControl.onCommand : null,
    validateCommandIntent: typeof optionControl.validateCommandIntent === "function"
      ? optionControl.validateCommandIntent
      : null,
    commandTimeoutMs: normalizeControlTimeoutMs(optionControl.commandTimeoutMs),
    observationKey: getViewModelObservationKey(viewModel),
    reason: canSendCommands
      ? null
      : (optionControl.disabledReason || authority.reason || "command-authority-not-enabled"),
  };
}

/**
 * CFS操作ボタンのdisabled理由を返す。
 *
 * 【詳細説明】
 * - stale/未観測/未装填/外部スプールでは操作を許可しない。
 * - 理由文字列がnullならUI上は操作可能候補とするが、実送信時の最終判断はdispatcherへ委ねる。
 *
 * @private
 * @param {object} row - ViewModel source row
 * @param {boolean} isStale - topologyがstaleならtrue
 * @param {object} controlPolicy - 操作方針
 * @param {object} buttonConfig - 操作ボタン定義
 * @returns {string|null} disabled理由、またはnull
 */
function getControlDisabledReason(row, isStale, controlPolicy, buttonConfig) {
  if (row?.kind !== "cfs-slot") {
    return "外部スプールはこの操作の対象外です";
  }
  if (!controlPolicy.canSendCommands) {
    return controlPolicy.reason || "CFS操作権限がありません";
  }
  if (!controlPolicy.allowedActions.has(buttonConfig.action)) {
    return "この操作は現在許可されていません";
  }
  if (isStale) {
    return "CFS情報が最終観測状態のため操作できません";
  }
  if (!row?.sourceId) {
    return "このスロットはまだ観測されていません";
  }
  if (row?.presence !== "loaded") {
    return "このスロットにはフィラメントが装填されていません";
  }
  return null;
}

/**
 * slot操作イベントpayloadを生成する。
 *
 * 【詳細説明】
 * - rendererは直接command requestを作らず、slot/sourceの識別情報だけを送信hookへ渡す。
 *
 * @private
 * @param {object} row - ViewModel source row
 * @param {object} buttonConfig - 操作ボタン定義
 * @returns {object} 操作hook payload
 */
function createControlCommandPayload(row, buttonConfig) {
  return {
    action: buttonConfig.action,
    commandKind: buttonConfig.commandKind,
    sourceId: row?.sourceId || null,
    displaySlot: row?.displaySlot || null,
    unitIndex: row?.unitIndex ?? null,
    slotIndex: row?.slotIndex ?? null,
    boxId: row?.boxId ?? null,
    protocolSlotId: row?.protocolSlotId ?? null,
  };
}

/**
 * CFS slot 操作ボタン群を描画する。
 *
 * 【詳細説明】
 * - disabled状態でもボタンを表示し、なぜ操作できないかをtitleで示す。
 * - 実行中や結果不明時は、CFSの共有material pathへ別操作を重ねないようprinter単位で一時停止する。
 *
 * @private
 * @param {Document} documentRef - DOM document
 * @param {object} row - ViewModel source row
 * @param {boolean} isStale - topologyがstaleならtrue
 * @param {object} controlPolicy - 操作方針
 * @param {object=} executionState - renderer handleで保持するcommand実行状態
 * @returns {HTMLElement} 操作ボタンコンテナ
 */
function renderSlotControls(documentRef, row, isStale, controlPolicy, executionState = createCommandExecutionState()) {
  const controls = createElement(documentRef, "div", "mtv-controls");
  const statusElement = createElement(documentRef, "div", "mtv-command-status", "");
  const buttonEntries = [];
  statusElement.setAttribute("aria-live", "polite");
  const restoredStatus = getVisibleExecutionStatusForRow(row, executionState);
  if (restoredStatus) {
    setCommandStatus(statusElement, restoredStatus.state, restoredStatus.message, restoredStatus.executionState);
  } else {
    statusElement.hidden = true;
  }

  /**
   * slot内の操作ボタン状態を再評価する。
   *
   * 【詳細説明】
   * - 1つのCFS操作を送信している間に、同じprinterへ別操作を重ねて送らないよう全ボタンを止める。
   *
   * @private
   * @param {boolean=} busy - trueならprinter内の全操作を一時停止する
   * @returns {void}
   */
  function refreshButtonStates(busy = false) {
    const mutexBusy = busy || isCommandMutexActive(executionState);
    for (const entry of buttonEntries) {
      const reason = getControlDisabledReason(row, isStale, controlPolicy, entry.buttonConfig);
      entry.button.disabled = mutexBusy || Boolean(reason);
      entry.button.title = mutexBusy ? "CFS操作の結果確認中です" : (reason || entry.buttonConfig.title);
      entry.button.dataset.busy = mutexBusy ? "true" : "false";
    }
  }
  if (executionState?.refreshers && typeof executionState.refreshers.add === "function") {
    executionState.refreshers.add(refreshButtonStates);
  }

  for (const buttonConfig of MATERIAL_CONTROL_BUTTONS) {
    const reason = getControlDisabledReason(row, isStale, controlPolicy, buttonConfig);
    const button = createElement(documentRef, "button", "mtv-control-btn", buttonConfig.label);
    button.type = "button";
    button.dataset.action = buttonConfig.action;
    button.dataset.commandKind = buttonConfig.commandKind;
    button.disabled = isCommandMutexActive(executionState) || Boolean(reason);
    button.title = isCommandMutexActive(executionState) ? "CFS操作の結果確認中です" : (reason || buttonConfig.title);
    button.dataset.busy = isCommandMutexActive(executionState) ? "true" : "false";
    button.setAttribute("aria-label", `${displayText(row?.displaySlot)} ${buttonConfig.title}`);
    buttonEntries.push({ button, buttonConfig });
    button.addEventListener("click", async () => {
      if (isCommandMutexActive(executionState)) {
        setCommandStatus(
          statusElement,
          executionState.statusClass || "running",
          executionState.message || "CFS操作の結果確認中です。",
          executionState.state || "submitting"
        );
        return;
      }
      const currentReason = getControlDisabledReason(row, isStale, controlPolicy, buttonConfig);
      if (currentReason || typeof controlPolicy.onCommand !== "function") {
        return;
      }
      const commandPayload = createControlCommandPayload(row, buttonConfig);
      let freshReason = null;
      if (typeof controlPolicy.validateCommandIntent === "function") {
        try {
          freshReason = await controlPolicy.validateCommandIntent(commandPayload);
        } catch {
          freshReason = "CFS情報の再確認に失敗したため操作できません";
        }
      }
      if (freshReason) {
        button.title = freshReason;
        setCommandStatus(statusElement, "warning", freshReason, "rejected");
        return;
      }
      const actionLabel = formatControlActionLabel(buttonConfig.action);
      executionState.state = "submitting";
      executionState.sourceId = row?.sourceId || null;
      executionState.action = buttonConfig.action;
      executionState.commandKind = buttonConfig.commandKind;
      executionState.statusClass = "running";
      executionState.message = `${actionLabel}を送信中...`;
      executionState.baselineObservationKey = controlPolicy.observationKey || null;
      refreshAllCommandButtons(executionState, true);
      button.dataset.running = "true";
      setCommandStatus(statusElement, "running", executionState.message, executionState.state);
      try {
        const resultEnvelope = await waitForCommandWithTimeout(
          Promise.resolve(controlPolicy.onCommand(commandPayload)),
          controlPolicy.commandTimeoutMs
        );
        const result = normalizeCommandHookResult(resultEnvelope);
        if (isFailedCommandResult(result)) {
          const failureMessage = `${actionLabel}に失敗しました: ${formatCommandFailureReason(result)}`;
          const status = String(result?.status || result?.result || "").trim().toLowerCase();
          const shouldKeepLocked = ["timeout", "transport-error", "confirmation-error"].includes(status);
          executionState.state = shouldKeepLocked ? "unknown" : "rejected";
          executionState.statusClass = "error";
          executionState.message = failureMessage;
          executionState.reconciliation = null;
          setCommandStatus(
            statusElement,
            "error",
            failureMessage,
            executionState.state
          );
        } else if (isUnconfirmedCommandResult(result)) {
          executionState.state = "submitted";
          executionState.statusClass = "warning";
          executionState.message = `${actionLabel}を送信しました。CFS状態反映待ちです。最新観測で確認します。`;
          executionState.reconciliation = createSubmittedCommandReconciliation(commandPayload, buttonConfig, row);
          setCommandStatus(statusElement, "warning", executionState.message, executionState.state);
        } else {
          executionState.state = "confirmed";
          executionState.statusClass = "success";
          executionState.message = `${actionLabel}を送信しました。確認済みです。`;
          executionState.reconciliation = null;
          setCommandStatus(statusElement, "success", executionState.message, executionState.state);
        }
      } catch (error) {
        const isTimeout = error?.code === "cfs-command-timeout" || error?.message === "cfs-command-timeout";
        executionState.state = isTimeout ? "unknown" : "rejected";
        executionState.statusClass = isTimeout ? "timeout" : "error";
        executionState.message = isTimeout
          ? `${actionLabel}がタイムアウトしました。現在状態を再確認してください。`
          : `${actionLabel}に失敗しました: ${error?.message || String(error)}`;
        setCommandStatus(
          statusElement,
          executionState.statusClass,
          executionState.message,
          executionState.state
        );
      } finally {
        button.dataset.running = "false";
        refreshAllCommandButtons(executionState, false);
      }
    });
    controls.appendChild(button);
  }
  controls.appendChild(statusElement);
  return controls;
}

/**
 * material source rowをslotカードとして描画する。
 *
 * 【詳細説明】
 * - selected/presence/remainingをclassとtextで同時に表し、色だけに依存しない表示にする。
 *
 * @private
 * @param {Document} documentRef - DOM document
 * @param {object} row - ViewModel source row
 * @param {boolean=} isStale - trueなら最終観測値として描画する
 * @param {object=} controlPolicy - 操作方針
 * @param {object=} executionState - renderer handleで保持するcommand実行状態
 * @returns {HTMLElement} slot要素
 */
function renderSourceSlot(documentRef, row, isStale = false, controlPolicy = {}, executionState = null) {
  const presence = normalizePresenceClass(row?.presence);
  const slot = createElement(documentRef, "div", `mtv-slot mtv-presence-${presence}`);
  slot.dataset.slot = row?.displaySlot || "";
  slot.dataset.presence = presence;
  if (Array.isArray(row?.assignments) && row.assignments.length > 0) {
    slot.classList.add("mtv-assigned");
  }
  if (row?.selected === true) {
    slot.classList.add("mtv-selected");
  }

  const header = createElement(documentRef, "div", "mtv-slot-header");
  header.appendChild(createElement(documentRef, "span", "mtv-slot-label", displayText(row?.displaySlot)));
  const presenceText = formatPresenceState(presence);
  header.appendChild(createElement(
    documentRef,
    "span",
    "mtv-slot-state",
    isStale ? `最終観測: ${presenceText}` : presenceText
  ));
  slot.appendChild(header);

  if (row?.selected === true) {
    slot.appendChild(createElement(
      documentRef,
      "div",
      "mtv-selected-badge",
      isStale ? "最終観測: 機器選択" : "機器選択中"
    ));
  }

  const materialLine = createElement(documentRef, "div", "mtv-material-line");
  const swatch = createElement(documentRef, "span", "mtv-swatch");
  const color = resolveMaterialColor(row?.material);
  if (color) {
    swatch.style.backgroundColor = color;
  }
  materialLine.appendChild(swatch);
  const materialName = displayText(row?.material?.name || row?.material?.type);
  materialLine.appendChild(createElement(documentRef, "span", "mtv-material-name", materialName));
  slot.appendChild(materialLine);

  const remainingView = formatRemaining(row?.status?.remaining, isStale);
  const remaining = createElement(documentRef, "div", `mtv-remaining ${remainingView.className}`, remainingView.text);
  if (remainingView.title) {
    remaining.title = remainingView.title;
  }
  slot.appendChild(remaining);

  const assignmentText = formatAssignmentLabel(row?.assignments, isStale);
  if (assignmentText) {
    const assignment = createElement(documentRef, "div", "mtv-assignment", assignmentText);
    assignment.title = getAssignmentTitle();
    slot.appendChild(assignment);
  }
  if (controlPolicy.showControls && row?.kind === "cfs-slot") {
    slot.appendChild(renderSlotControls(documentRef, row, isStale, controlPolicy, executionState));
  }
  return slot;
}

/**
 * CFS/CFS-C unitを描画する。
 *
 * 【詳細説明】
 * - 未観測unitも設定台数に含まれる場合は枠を残し、未接続/未観測を表示で区別する。
 *
 * @private
 * @param {Document} documentRef - DOM document
 * @param {object} unit - ViewModel unit row
 * @param {boolean=} isStale - trueなら最終観測値として描画する
 * @param {object=} controlPolicy - 操作方針
 * @param {object=} executionState - renderer handleで保持するcommand実行状態
 * @returns {HTMLElement} unit要素
 */
function renderUnit(documentRef, unit, isStale = false, controlPolicy = {}, executionState = null) {
  const unitEl = createElement(documentRef, "section", "mtv-unit");
  if (!unit?.observed) {
    unitEl.classList.add("mtv-unit-unobserved");
  }
  const header = createElement(documentRef, "div", "mtv-unit-header");
  header.appendChild(createElement(documentRef, "span", "mtv-unit-title", `CFS ${unit?.displayUnit ?? "--"}`));
  const details = [];
  if (unit?.boxId !== null && unit?.boxId !== undefined) {
    details.push(`box ${unit.boxId}`);
  }
  if (unit?.temperature !== null && unit?.temperature !== undefined) {
    details.push(`${unit.temperature}C`);
  }
  if (unit?.humidity !== null && unit?.humidity !== undefined) {
    details.push(`${unit.humidity}%`);
  }
  header.appendChild(createElement(documentRef, "span", "mtv-unit-meta", details.join(" / ") || "未観測"));
  unitEl.appendChild(header);

  const slots = createElement(documentRef, "div", "mtv-slots");
  for (const row of Array.isArray(unit?.slots) ? unit.slots : []) {
    slots.appendChild(renderSourceSlot(documentRef, row, isStale, controlPolicy, executionState));
  }
  unitEl.appendChild(slots);
  return unitEl;
}

/**
 * material topology view modelをDOMへ描画する。
 *
 * 【詳細説明】
 * - container配下をrenderer管理領域として再構築する。
 * - 戻り値のupdateは同じcontainerに再描画するだけで、commandや保存処理は実行しない。
 *
 * @function renderMaterialTopologyPanel
 * @param {HTMLElement} container - 描画先コンテナ
 * @param {object} viewModel - {@link createMaterialTopologyViewModel} の返り値
 * @param {object=} options - 描画オプション
 * @param {string=} options.hostname - 対象ホスト名
 * @param {object=} options.control - CFS操作候補設定
 * @param {boolean=} options.control.showControls - 操作候補ボタンを表示する場合true
 * @param {boolean=} options.control.canSendCommands - renderer側で操作候補を有効化する場合true
 * @param {Array<string>=} options.control.allowedActions - renderer側で許可する操作action
 * @param {Function=} options.control.onCommand - 操作hook
 * @param {Function=} options.control.validateCommandIntent - click時の最新状態再確認hook
 * @returns {{update: function(object, object=): void, destroy: function(): void}} renderer handle
 * @example
 * const handle = renderMaterialTopologyPanel(container, viewModel, { hostname: "K2Pro" });
 */
export function renderMaterialTopologyPanel(container, viewModel, options = {}) {
  if (!container) {
    return {
      update() {},
      destroy() {},
    };
  }
  const documentRef = container.ownerDocument || document;
  const commandExecutionState = createCommandExecutionState();
  let activeOptions = {
    ...options,
    control: options?.control || null,
  };

  /**
   * 現在のview modelをcontainerへ描画する。
   *
   * 【詳細説明】
   * - 再描画ごとにDOMを作り直し、slot数やunit数の設定変更にも追随する。
   *
   * @private
   * @param {object} currentViewModel - 描画対象view model
   * @returns {void}
   */
  function draw(currentViewModel) {
    reconcileCommandExecutionState(commandExecutionState, currentViewModel);
    container.replaceChildren();
    commandExecutionState.refreshers.clear();
    const root = createElement(documentRef, "div", "mtv-root");
    const header = createElement(documentRef, "div", "mtv-header");
    const topologyState = currentViewModel?.summary?.topologyState || "unobserved";
    const isStale = topologyState === "stale";
    const controlPolicy = createControlPolicy(currentViewModel, activeOptions);
    root.classList.add(`mtv-root-${topologyState}`);
    header.appendChild(createElement(documentRef, "span", "mtv-title", "機器観測フィラメント"));
    header.appendChild(createElement(documentRef, "span", "mtv-topology-state", formatTopologyState(topologyState, currentViewModel?.observation)));
    root.appendChild(header);

    if (isStale) {
      root.appendChild(createElement(
        documentRef,
        "div",
        "mtv-stale-banner",
        "⚠ CFS情報を現在取得できません。以下は最後に観測した状態です。"
      ));
    } else if (topologyState === "unobserved") {
      root.appendChild(createElement(
        documentRef,
        "div",
        "mtv-observing-banner",
        "CFS/CFS-C情報を取得中です。外部スプールとCFSスロットは観測でき次第、別々の欄に表示します。"
      ));
    }

    const summary = currentViewModel?.summary || {};
    const summaryText = [
      `装填 ${summary.loadedSourceCount ?? 0}`,
      `選択中 ${summary.selectedSourceCount ?? 0}`,
      `CFS ${summary.cfsUnitCount ?? 0}/${currentViewModel?.limits?.cfsUnitLimit ?? 0}台`,
    ].join(" / ");
    root.appendChild(createElement(documentRef, "div", "mtv-summary", summaryText));

    const externalRows = Array.isArray(currentViewModel?.external) ? currentViewModel.external : [];
    if (externalRows.length > 0) {
      const external = createElement(documentRef, "section", "mtv-external");
      external.appendChild(createElement(documentRef, "div", "mtv-section-title", "外部スプール（CFSとは別管理）"));
      for (const row of externalRows) {
        external.appendChild(renderSourceSlot(documentRef, row, isStale, controlPolicy, commandExecutionState));
      }
      root.appendChild(external);
    }

    const units = createElement(documentRef, "div", "mtv-units");
    for (const unit of Array.isArray(currentViewModel?.units) ? currentViewModel.units : []) {
      units.appendChild(renderUnit(documentRef, unit, isStale, controlPolicy, commandExecutionState));
    }
    root.appendChild(units);

    const footer = createElement(documentRef, "div", "mtv-readonly-note");
    const host = activeOptions.hostname ? `${activeOptions.hostname}: ` : "";
    footer.textContent = controlPolicy.canSendCommands
      ? `${host}CFS/CFS-C操作はPrinter Core v3 dispatcherで送信直前に再検証されます。`
      : `${host}🔒 CFS/CFS-Cは現在監視のみです。フィラメント操作はプリンタ本体から行ってください。`;
    root.appendChild(footer);
    container.appendChild(root);
  }

  draw(viewModel);
  return {
    update(nextViewModel, nextOptions = null) {
      if (nextOptions && typeof nextOptions === "object") {
        activeOptions = {
          ...activeOptions,
          ...nextOptions,
          control: Object.prototype.hasOwnProperty.call(nextOptions, "control")
            ? nextOptions.control
            : activeOptions.control,
        };
      }
      draw(nextViewModel);
    },
    destroy() {
      container.replaceChildren();
    },
  };
}
