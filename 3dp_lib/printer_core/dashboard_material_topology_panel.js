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
 *
 * 【公開関数一覧】
 * - {@link renderMaterialTopologyPanel}：material topology view model をDOMへ描画
 *
 * @version 1.390.1362 (PR #432)
 * @since   1.390.1362 (PR #432)
 * @lastModified 2026-08-09 16:25:00
 * -----------------------------------------------------------
 * @todo
 * - command authority Gateで、Core経由の安全なfeed/retract/select操作だけを別UIとして追加する
 */

"use strict";

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
  const normalized = String(material?.color?.normalized || "").trim();
  const raw = String(material?.color?.raw || "").trim();
  const candidate = normalized ? `#${normalized.replace(/^#/, "")}` : raw;
  return /^#[0-9a-fA-F]{6}$/.test(candidate) ? candidate : null;
}

/**
 * 残量表示文字列を生成する。
 *
 * 【詳細説明】
 * - 残量未観測と0%を混同しないため、null/invalidは別ラベルにする。
 *
 * @private
 * @param {object|null|undefined} remaining - ViewModelのremaining情報
 * @returns {string} 表示文字列
 */
function formatRemaining(remaining) {
  if (!remaining || remaining.displayPercent === null || remaining.displayPercent === undefined) {
    return "残量 --";
  }
  const percent = Number(remaining.displayPercent);
  if (!Number.isFinite(percent)) {
    return "残量 --";
  }
  const suffix = remaining.valid === false ? " ?" : "";
  return `残量 ${Math.round(percent)}%${suffix}`;
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
 * material source rowをslotカードとして描画する。
 *
 * 【詳細説明】
 * - selected/presence/remainingをclassとtextで同時に表し、色だけに依存しない表示にする。
 *
 * @private
 * @param {Document} documentRef - DOM document
 * @param {object} row - ViewModel source row
 * @returns {HTMLElement} slot要素
 */
function renderSourceSlot(documentRef, row) {
  const presence = normalizePresenceClass(row?.presence);
  const slot = createElement(documentRef, "div", `mtv-slot mtv-presence-${presence}`);
  slot.dataset.slot = row?.displaySlot || "";
  slot.dataset.presence = presence;
  if (row?.selected === true) {
    slot.classList.add("mtv-selected");
  }

  const header = createElement(documentRef, "div", "mtv-slot-header");
  header.appendChild(createElement(documentRef, "span", "mtv-slot-label", displayText(row?.displaySlot)));
  const stateLabel = row?.selected === true ? "selected" : presence;
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

  slot.appendChild(createElement(documentRef, "div", "mtv-remaining", formatRemaining(row?.status?.remaining)));

  const assignmentText = formatAssignments(row?.assignments);
  if (assignmentText) {
    slot.appendChild(createElement(documentRef, "div", "mtv-assignment", assignmentText));
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
 * @returns {HTMLElement} unit要素
 */
function renderUnit(documentRef, unit) {
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
  header.appendChild(createElement(documentRef, "span", "mtv-unit-meta", details.join(" / ") || "unobserved"));
  unitEl.appendChild(header);

  const slots = createElement(documentRef, "div", "mtv-slots");
  for (const row of Array.isArray(unit?.slots) ? unit.slots : []) {
    slots.appendChild(renderSourceSlot(documentRef, row));
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
    header.appendChild(createElement(documentRef, "span", "mtv-title", "Material Sources"));
    header.appendChild(createElement(documentRef, "span", "mtv-topology-state", topologyState));
    root.appendChild(header);

    const summary = currentViewModel?.summary || {};
    const summaryText = [
      `${summary.loadedSourceCount ?? 0} loaded`,
      `${summary.selectedSourceCount ?? 0} selected`,
      `${summary.cfsUnitCount ?? 0}/${currentViewModel?.limits?.cfsUnitLimit ?? 0} units`,
    ].join(" / ");
    root.appendChild(createElement(documentRef, "div", "mtv-summary", summaryText));

    const externalRows = Array.isArray(currentViewModel?.external) ? currentViewModel.external : [];
    if (externalRows.length > 0) {
      const external = createElement(documentRef, "section", "mtv-external");
      external.appendChild(createElement(documentRef, "div", "mtv-section-title", "External Spool"));
      for (const row of externalRows) {
        external.appendChild(renderSourceSlot(documentRef, row));
      }
      root.appendChild(external);
    }

    const units = createElement(documentRef, "div", "mtv-units");
    for (const unit of Array.isArray(currentViewModel?.units) ? currentViewModel.units : []) {
      units.appendChild(renderUnit(documentRef, unit));
    }
    root.appendChild(units);

    const footer = createElement(documentRef, "div", "mtv-readonly-note");
    const host = options.hostname ? `${options.hostname}: ` : "";
    footer.textContent = `${host}read-only observation / no feed-retract authority`;
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
