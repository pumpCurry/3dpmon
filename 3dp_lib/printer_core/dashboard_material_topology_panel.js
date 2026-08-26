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
 * @version 1.390.1402 (PR #434)
 * @since   1.390.1362 (PR #432)
 * @lastModified 2026-08-26 22:30:00
 * -----------------------------------------------------------
 * @todo
 * - Gate 19.5後続で、実接続層のproduction dispatcherへ操作hookを接続する
 */

"use strict";

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
 * topology stateを利用者向けの日本語表示へ変換する。
 *
 * 【詳細説明】
 * - protocol内部語のfresh/staleをそのまま出すと現在値/過去値の判断が難しいため、
 *   監視画面では「最新」「最終観測」などの運用語へ置き換える。
 *
 * @private
 * @param {*} value - topology state候補
 * @returns {string} 利用者向け状態ラベル
 */
function formatTopologyState(value) {
  if (value === "fresh") {
    return "状態: 最新";
  }
  if (value === "stale") {
    return "状態: 最終観測";
  }
  return "状態: 取得待ち";
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
  return "不明";
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
  const displayHex = String(material?.color?.displayHex || "").trim();
  const normalized = String(material?.color?.normalized || "").trim();
  const raw = String(material?.color?.raw || "").trim();
  const candidate = displayHex
    ? `#${displayHex.replace(/^#/, "")}`
    : (normalized ? `#${normalized.replace(/^#/, "")}` : raw);
  return /^#[0-9a-fA-F]{6}$/.test(candidate) ? candidate : null;
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
 * - 実行中は二重クリックを避けるため、対象ボタンだけ一時disabledにする。
 *
 * @private
 * @param {Document} documentRef - DOM document
 * @param {object} row - ViewModel source row
 * @param {boolean} isStale - topologyがstaleならtrue
 * @param {object} controlPolicy - 操作方針
 * @returns {HTMLElement} 操作ボタンコンテナ
 */
function renderSlotControls(documentRef, row, isStale, controlPolicy) {
  const controls = createElement(documentRef, "div", "mtv-controls");
  for (const buttonConfig of MATERIAL_CONTROL_BUTTONS) {
    const reason = getControlDisabledReason(row, isStale, controlPolicy, buttonConfig);
    const button = createElement(documentRef, "button", "mtv-control-btn", buttonConfig.label);
    button.type = "button";
    button.dataset.action = buttonConfig.action;
    button.dataset.commandKind = buttonConfig.commandKind;
    button.disabled = Boolean(reason);
    button.title = reason || buttonConfig.title;
    button.setAttribute("aria-label", `${displayText(row?.displaySlot)} ${buttonConfig.title}`);
    button.addEventListener("click", async () => {
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
        return;
      }
      button.disabled = true;
      button.dataset.running = "true";
      try {
        await controlPolicy.onCommand(commandPayload);
      } finally {
        button.dataset.running = "false";
        button.disabled = false;
      }
    });
    controls.appendChild(button);
  }
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
 * @returns {HTMLElement} slot要素
 */
function renderSourceSlot(documentRef, row, isStale = false, controlPolicy = {}) {
  const presence = normalizePresenceClass(row?.presence);
  const slot = createElement(documentRef, "div", `mtv-slot mtv-presence-${presence}`);
  slot.dataset.slot = row?.displaySlot || "";
  slot.dataset.presence = presence;
  if (row?.selected === true) {
    slot.classList.add("mtv-selected");
  }

  const header = createElement(documentRef, "div", "mtv-slot-header");
  header.appendChild(createElement(documentRef, "span", "mtv-slot-label", displayText(row?.displaySlot)));
  const stateLabel = row?.selected === true
    ? (isStale ? "最終観測:選択中" : "現在選択中")
    : formatPresenceState(presence);
  header.appendChild(createElement(documentRef, "span", "mtv-slot-state", stateLabel));
  slot.appendChild(header);

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

  const assignmentText = formatAssignments(row?.assignments);
  if (assignmentText) {
    slot.appendChild(createElement(documentRef, "div", "mtv-assignment", assignmentText));
  }
  if (controlPolicy.showControls && row?.kind === "cfs-slot") {
    slot.appendChild(renderSlotControls(documentRef, row, isStale, controlPolicy));
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
 * @returns {HTMLElement} unit要素
 */
function renderUnit(documentRef, unit, isStale = false, controlPolicy = {}) {
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
    slots.appendChild(renderSourceSlot(documentRef, row, isStale, controlPolicy));
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
 * @returns {{update: function(object): void, destroy: function(): void}} renderer handle
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
    container.replaceChildren();
    const root = createElement(documentRef, "div", "mtv-root");
    const header = createElement(documentRef, "div", "mtv-header");
    const topologyState = currentViewModel?.summary?.topologyState || "unobserved";
    const isStale = topologyState === "stale";
    const controlPolicy = createControlPolicy(currentViewModel, options);
    root.classList.add(`mtv-root-${topologyState}`);
    header.appendChild(createElement(documentRef, "span", "mtv-title", "フィラメント供給"));
    header.appendChild(createElement(documentRef, "span", "mtv-topology-state", formatTopologyState(topologyState)));
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
        external.appendChild(renderSourceSlot(documentRef, row, isStale, controlPolicy));
      }
      root.appendChild(external);
    }

    const units = createElement(documentRef, "div", "mtv-units");
    for (const unit of Array.isArray(currentViewModel?.units) ? currentViewModel.units : []) {
      units.appendChild(renderUnit(documentRef, unit, isStale, controlPolicy));
    }
    root.appendChild(units);

    const footer = createElement(documentRef, "div", "mtv-readonly-note");
    const host = options.hostname ? `${options.hostname}: ` : "";
    footer.textContent = controlPolicy.canSendCommands
      ? `${host}CFS/CFS-C操作はPrinter Core v3 dispatcherで送信直前に再検証されます。`
      : `${host}🔒 CFS/CFS-Cは現在監視のみです。フィラメント操作はプリンタ本体から行ってください。`;
    root.appendChild(footer);
    container.appendChild(root);
  }

  draw(viewModel);
  return {
    update(nextViewModel) {
      draw(nextViewModel);
    },
    destroy() {
      container.replaceChildren();
    },
  };
}
