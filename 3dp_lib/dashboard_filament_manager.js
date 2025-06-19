/**
 * @fileoverview
 * 3Dプリンタ監視ツール 3dpmon 用 フィラメント管理モーダル モジュール
 * dashboard_filament_manager.js
 * (c) pumpCurry 2025
 * -----------------------------------------------------------
 * @module dashboard_filament_manager
 *
 * 【機能内容サマリ】
 * - フィラメント管理ダイアログの表示
 * - 使用記録/在庫/プリセットの一覧表示
 *
 * 【公開関数一覧】
 * - {@link showFilamentManager}：管理モーダルを開く
 *
 * @version 1.390.290 (PR #132)
 * @since   1.390.228 (PR #102)
*/

"use strict";

import { monitorData } from "./dashboard_data.js";
import {
  getCurrentSpool,
  getSpools,
  addSpool,
  updateSpool,
  addSpoolFromPreset,
  deleteSpool
} from "./dashboard_spool.js";
import {
  getInventory,
  setInventoryQuantity,
  adjustInventory
} from "./dashboard_filament_inventory.js";
import { FILAMENT_PRESETS } from "./dashboard_filament_presets.js";
import { saveUnifiedStorage } from "./dashboard_storage.js";
import { createFilamentPreview } from "./dashboard_filament_view.js";

let styleInjected = false;

/**
 * 新規登録時に使用するフィラメント設定のデフォルト値。
 *
 * @private
 * @constant {Object}
 */
const DEFAULT_FILAMENT_DATA = {
  filamentDiameter: 1.75,
  filamentTotalLength: 336000,
  filamentCurrentLength: 336000,
  reelOuterDiameter: 195,
  reelThickness: 58,
  reelWindingInnerDiameter: 68,
  reelCenterHoleDiameter: 54,
  reelBodyColor: "#91919A",
  reelFlangeTransparency: 0.4,
  reelCenterHoleForegroundColor: "#F4F4F5",
  manufacturerName: "",
  reelName: "",
  reelSubName: "",
  filamentColor: "#22C55E",
  materialName: "PLA",
  materialColorName: "",
  materialColorCode: "",
  purchaseLink: "",
  price: 0,
  currencySymbol: "\u00A5"
};

/**
 * 必要な CSS を一度だけ注入する。
 *
 * @private
 * @returns {void}
 */
function injectStyles() {
  if (styleInjected) return;
  styleInjected = true;
  const css = `
    .filament-manager-overlay{position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:3000;}
    .filament-manager-modal{background:#fff;border-radius:8px;width:90%;max-width:740px;box-shadow:0 2px 12px rgba(0,0,0,0.4);display:flex;flex-direction:column;}
    .filament-manager-header{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid #ddd;}
    .filament-manager-tabs{display:flex;border-bottom:1px solid #ddd;}
    .filament-manager-tabs button{flex:1;padding:6px;border:none;background:#f4f4f5;cursor:pointer;}
    .filament-manager-tabs button.active{background:#fff;border-bottom:2px solid #38bdf8;}
    .filament-manager-content{padding:8px;overflow-y:auto;max-height:70vh;}
    .filament-manager-content table{width:100%;border-collapse:collapse;}
    .filament-manager-content th,.filament-manager-content td{border:1px solid #ddd;padding:4px;font-size:12px;}
    .filament-manager-content .inv-qty-input{width:60px;text-align:right;}
    .filament-manager-content .inv-adjust{margin:0 2px;padding:0 4px;}
    .filament-manager-content .search-form{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px;}
    .filament-manager-content .search-form select,
    .filament-manager-content .search-form input{padding:2px;font-size:12px;}
    .filament-manager-content .search-field{border:1px solid #ccc;border-radius:6px;padding:4px;margin-bottom:4px;}
    .filament-manager-content .search-field legend{font-size:12px;}
    .registered-table tr.selected{background:#e0f2fe;}
    .registered-container{display:flex;gap:8px;align-items:flex-start;}
    .registered-preview{flex:0 0 120px;min-width:120px;min-height:120px;}
    .registered-list{flex:1;overflow-y:auto;max-height:70vh;}
    .registered-table th{cursor:pointer;}
    .edit-form label{display:block;margin:4px 0;font-size:12px;}
    .edit-form input,.edit-form select{width:100%;box-sizing:border-box;font-size:12px;padding:2px;}
    .edit-buttons{display:flex;justify-content:flex-end;gap:8px;margin-top:8px;}
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * 使用履歴タブの内容を生成する。
 *
 * @private
 * @returns {HTMLElement} 生成された要素
 */
function createHistoryContent() {
  const div = document.createElement("div");
  div.className = "filament-manager-content";
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>ID</th><th>Spool</th><th>Used(mm)</th><th>Time</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  monitorData.usageHistory.forEach(u => {
    const tr = document.createElement("tr");
    const t = new Date(Number(u.startedAt || u.timestamp || 0));
    tr.innerHTML = `<td>${u.usageId || ""}</td><td>${u.spoolId}</td><td>${u.usedLength || 0}</td><td>${t.toLocaleString()}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  div.appendChild(table);
  return div;
}

/**
 * 現在スプール表示タブを生成する。
 *
 * @private
 * @param {Function} onUse - 使用ボタン押下時に呼び出す処理
 * @param {Function} onChange - 変更後に呼び出す処理
 * @returns {HTMLElement} DOM 要素
*/
function createCurrentSpoolContent() {
  const div = document.createElement("div");
  div.className = "filament-manager-content";
  const sp = getCurrentSpool();
  if (!sp) {
    div.textContent = "現在選択中のスプールがありません";
    return div;
  }
  const wrap = document.createElement("div");
  wrap.className = "registered-container";
  const prevBox = document.createElement("div");
  prevBox.className = "registered-preview";
  wrap.appendChild(prevBox);

  const ul = document.createElement("ul");
  ul.style.fontSize = "12px";
  ul.innerHTML = `
    <li>名前: ${sp.name}</li>
    <li>材質: ${sp.material}</li>
    <li>残量: ${sp.remainingLengthMm} / ${sp.totalLengthMm} mm</li>
  `;
  wrap.appendChild(ul);
  div.appendChild(wrap);

  createFilamentPreview(prevBox, {
    filamentDiameter: sp.filamentDiameter,
    filamentTotalLength: sp.totalLengthMm,
    filamentCurrentLength: sp.remainingLengthMm,
    filamentColor: sp.filamentColor || sp.color,
    reelOuterDiameter: sp.reelOuterDiameter,
    reelThickness: sp.reelThickness,
    reelWindingInnerDiameter: sp.reelWindingInnerDiameter,
    reelCenterHoleDiameter: sp.reelCenterHoleDiameter,
    widthPx: 120,
    heightPx: 120,
    showSlider: false,
    isFilamentPresent: true,
    showUsedUpIndicator: true,
    blinkingLightColor: "#0EA5E9",
    showInfoLength: false,
    showInfoPercent: false,
    showInfoLayers: false,
    showResetButton: false,
    showProfileViewButton: true,
    showSideViewButton: true,
    showFrontViewButton: true,
    showAutoRotateButton: true,
    enableDrag: true,
    enableClick: false,
    onClick: null,
    disableInteraction: true,
    showOverlayLength: true,
    showOverlayPercent: true,
    showLengthKg: false,
    showReelName: true,
    showReelSubName: true,
    showMaterialName: true,
    showMaterialColorName: true,
    showMaterialColorCode: true,
    showManufacturerName: true,
    showOverlayBar: true,
    showPurchaseButton: true,
    reelName: sp.name || "",
    reelSubName: sp.reelSubName || "",
    materialName: sp.materialName || sp.material || "",
    materialColorName: sp.colorName || "",
    materialColorCode: sp.filamentColor || sp.color || "",
    manufacturerName: sp.manufacturerName || sp.brand || ""
  });
  return div;
}

/**
 * 在庫一覧タブを生成する。
 * 在庫数を増減するボタンと入力欄を備え、直接数量変更が可能。
 *
 * @private
 * @returns {HTMLElement} DOM 要素
 */
function createInventoryContent() {
  const div = document.createElement("div");
  div.className = "filament-manager-content";
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>ID</th><th>数量</th><th>合計使用数</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  getInventory().forEach(inv => {
    const tr = document.createElement("tr");

    const idTd = document.createElement("td");
    idTd.textContent = inv.modelId;

    const qtyTd = document.createElement("td");
    const minus = document.createElement("button");
    minus.textContent = "-";
    minus.className = "inv-adjust";
    minus.addEventListener("click", () => {
      qtyInput.value = adjustInventory(inv.modelId, -1).toString();
    });

    const qtyInput = document.createElement("input");
    qtyInput.type = "number";
    qtyInput.className = "inv-qty-input";
    qtyInput.value = inv.quantity;
    qtyInput.addEventListener("change", () => {
      qtyInput.value = setInventoryQuantity(inv.modelId, qtyInput.value).toString();
    });

    const plus = document.createElement("button");
    plus.textContent = "+";
    plus.className = "inv-adjust";
    plus.addEventListener("click", () => {
      qtyInput.value = adjustInventory(inv.modelId, 1).toString();
    });

    qtyTd.append(minus, qtyInput, plus);

    const usedTd = document.createElement("td");
    usedTd.textContent = inv.totalUsedNum;

    tr.append(idTd, qtyTd, usedTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  div.appendChild(table);
  return div;
}

/**
 * 登録済みフィラメント一覧タブを生成する。
 * 検索フォームと一覧テーブルを備え、編集・追加操作が可能。
 *
 * @private
 * @returns {HTMLElement} DOM 要素
 */
function createRegisteredContent(openEditor) {
  const div = document.createElement("div");
  div.className = "filament-manager-content";
  div.style.overflowY = "visible";
  div.style.maxHeight = "none";

  const addBtn = document.createElement("button");
  addBtn.textContent = "新規登録";
  addBtn.style.fontSize = "12px";
  addBtn.style.marginBottom = "4px";

  const form = document.createElement("form");
  form.className = "search-form";
  const searchFs = document.createElement("fieldset");
  searchFs.className = "search-field";
  const searchLg = document.createElement("legend");
  searchLg.textContent = "検索";
  searchFs.appendChild(searchLg);
  searchFs.appendChild(form);
  const brandSel = document.createElement("select");
  const matSel = document.createElement("select");
  const colorSel = document.createElement("select");
  const nameIn = document.createElement("input");
  nameIn.placeholder = "名称";
  const searchBtn = document.createElement("button");
  searchBtn.textContent = "検索";
  form.append(brandSel, matSel, colorSel, nameIn, searchBtn);

  const countSpan = document.createElement("div");
  countSpan.style.fontSize = "12px";
  countSpan.style.margin = "4px 0";

  const wrap = document.createElement("div");
  wrap.className = "registered-container";
  const prevBox = document.createElement("div");
  prevBox.className = "registered-preview";
  wrap.appendChild(prevBox);

  const listBox = document.createElement("div");
  listBox.className = "registered-list";

  const table = document.createElement("table");
  table.className = "registered-table";
  const thead = document.createElement("thead");
  thead.innerHTML =
    "<tr><th data-sort='brand'>ブランド</th><th data-sort='material'>材質</th>" +
    "<th data-sort='colorName'>色名</th><th data-sort='name'>名称</th>" +
    "<th data-sort='reelSubName'>サブ名称</th>" +
    "<th data-sort='count'>使用数</th><th data-sort='last'>最終利用日時</th><th>コマンド</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);
  listBox.appendChild(table);
  wrap.appendChild(listBox);

  div.append(addBtn, searchFs, countSpan, wrap);

  const preview = createFilamentPreview(prevBox, {
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    filamentColor: "#22C55E",
    reelOuterDiameter: 200,
    reelThickness: 68,
    reelWindingInnerDiameter: 95,
    reelCenterHoleDiameter: 54,
    widthPx: 120,
    heightPx: 120,
    showSlider: false,
    isFilamentPresent: true,
    showUsedUpIndicator: true,
    blinkingLightColor: "#0EA5E9",
    showInfoLength: false,
    showInfoPercent: false,
    showInfoLayers: false,
    showResetButton: false,
    showProfileViewButton: true,
    showSideViewButton: true,
    showFrontViewButton: true,
    showAutoRotateButton: true,
    enableDrag: true,
    enableClick: false,
    onClick: null,
    disableInteraction: true,
    showOverlayLength: true,
    showOverlayPercent: true,
    showLengthKg: false,
    showReelName: true,
    showReelSubName: true,
    showMaterialName: true,
    showMaterialColorName: true,
    showMaterialColorCode: true,
    showManufacturerName: true,
    showOverlayBar: true,
    showPurchaseButton: true,
    reelName: "",
    reelSubName: "",
    materialName: "",
    materialColorName: "",
    materialColorCode: "",
    manufacturerName: ""
  });

  let sortKey = "";
  let sortAsc = true;
  let selectedTr = null;

  function buildMaps() {
    const map = {};
    (monitorData.usageHistory || []).forEach(h => {
      const m = map[h.spoolId] || { count: 0, last: 0 };
      m.count += 1;
      const t = Number(h.startedAt || 0);
      if (t > m.last) m.last = t;
      map[h.spoolId] = m;
    });
    return map;
  }

  function fillOptions(spools) {
    const brands = new Set();
    const mats = new Set();
    const colors = new Set();
    spools.forEach(sp => {
      if (sp.manufacturerName) brands.add(sp.manufacturerName);
      else if (sp.brand) brands.add(sp.brand);
      if (sp.materialName) mats.add(sp.materialName);
      else if (sp.material) mats.add(sp.material);
      if (sp.colorName) colors.add(sp.colorName);
    });
    brandSel.innerHTML = "<option value=''>ブランド</option>";
    [...brands].forEach(b => {
      const o = document.createElement("option");
      o.value = b;
      o.textContent = b;
      brandSel.appendChild(o);
    });
    matSel.innerHTML = "<option value=''>材質</option>";
    [...mats].forEach(m => {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m;
      matSel.appendChild(o);
    });
    colorSel.innerHTML = "<option value=''>色名</option>";
    [...colors].forEach(c => {
      const o = document.createElement("option");
      o.value = c;
      o.textContent = c;
      colorSel.appendChild(o);
    });
  }

  function applyFilter(spools) {
    return spools.filter(sp => {
      if (brandSel.value) {
        const b = sp.manufacturerName || sp.brand || "";
        if (b !== brandSel.value) return false;
      }
      if (matSel.value) {
        const m = sp.materialName || sp.material || "";
        if (m !== matSel.value) return false;
      }
      if (colorSel.value) {
        if (sp.colorName !== colorSel.value) return false;
      }
      if (nameIn.value) {
        const n = `${sp.name || ""}${sp.reelName || ""}${sp.reelSubName || ""}`;
        if (!n.includes(nameIn.value)) return false;
      }
      return true;
    });
  }

  function sortList(list) {
    if (!sortKey) return list;
    return list.sort((a, b) => {
      let va = "";
      let vb = "";
      switch (sortKey) {
        case "brand":
          va = a.manufacturerName || a.brand || "";
          vb = b.manufacturerName || b.brand || "";
          break;
        case "material":
          va = a.materialName || a.material || "";
          vb = b.materialName || b.material || "";
          break;
        case "colorName":
          va = a.colorName || "";
          vb = b.colorName || "";
          break;
        case "name":
          va = a.name || a.reelName || "";
          vb = b.name || b.reelName || "";
          break;
        case "reelSubName":
          va = a.reelSubName || "";
          vb = b.reelSubName || "";
          break;
        case "count":
          va = usageMap[a.id]?.count || 0;
          vb = usageMap[b.id]?.count || 0;
          break;
        case "last":
          va = usageMap[a.id]?.last || 0;
          vb = usageMap[b.id]?.last || 0;
          break;
        default:
          break;
      }
      if (va === vb) return 0;
      const cmp = va > vb ? 1 : -1;
      return sortAsc ? cmp : -cmp;
    });
  }

  function render() {
    const spools = getSpools();
    usageMap = buildMaps();
    fillOptions(spools);
    const list = sortList(applyFilter(spools));
    tbody.innerHTML = "";
    list.forEach(sp => {
      const tr = document.createElement("tr");
      const brand = sp.manufacturerName || sp.brand || "";
      const mat = sp.materialName || sp.material || "";
      const colorCell = document.createElement("td");
      colorCell.innerHTML = `<span style='color:${sp.filamentColor || sp.color || "#000"}'>■</span>${sp.colorName || ""}`;
      const name = sp.name || sp.reelName || "";
      const sub = sp.reelSubName || "";
      const usage = usageMap[sp.id]?.count || 0;
      const last = usageMap[sp.id]?.last
        ? new Date(usageMap[sp.id].last).toLocaleString()
        : "";
      tr.innerHTML = `<td>${brand}</td><td>${mat}</td>`;
      tr.appendChild(colorCell);
      tr.innerHTML += `<td>${name}</td><td>${sub}</td><td>${usage}</td><td>${last}</td>`;
      const cmd = document.createElement("td");
      const edit = document.createElement("button");
      edit.textContent = "編集";
      edit.addEventListener("click", () => {
        openEditor(sp, render);
      });
      cmd.appendChild(edit);
      tr.appendChild(cmd);
      tr.addEventListener("click", () => {
        selectedTr?.classList.remove("selected");
        selectedTr = tr;
        tr.classList.add("selected");
        preview.setState({
          filamentDiameter: sp.filamentDiameter,
          filamentTotalLength: sp.totalLengthMm,
          filamentCurrentLength: sp.remainingLengthMm,
          filamentColor: sp.filamentColor || sp.color,
          reelOuterDiameter: sp.reelOuterDiameter,
          reelThickness: sp.reelThickness,
          reelWindingInnerDiameter: sp.reelWindingInnerDiameter,
          reelCenterHoleDiameter: sp.reelCenterHoleDiameter,
          reelBodyColor: sp.reelBodyColor,
          reelFlangeTransparency: sp.reelFlangeTransparency,
          reelWindingForegroundColor: sp.reelWindingForegroundColor,
          reelCenterHoleForegroundColor: sp.reelCenterHoleForegroundColor,
          reelName: sp.name || "",
          reelSubName: sp.reelSubName || "",
          materialName: sp.materialName || sp.material || "",
          materialColorName: sp.colorName || "",
          materialColorCode: sp.filamentColor || sp.color || "",
          manufacturerName: sp.manufacturerName || sp.brand || ""
        });
      });
      tbody.appendChild(tr);
    });
    countSpan.textContent = `一覧：(${list.length}/${spools.length}件)`;
  }

  let usageMap = buildMaps();

  thead.addEventListener("click", ev => {
    const th = ev.target.closest("th");
    if (!th || !th.dataset.sort) return;
    if (sortKey === th.dataset.sort) {
      sortAsc = !sortAsc;
    } else {
      sortKey = th.dataset.sort;
      sortAsc = true;
    }
    render();
  });

  form.addEventListener("submit", ev => {
    ev.preventDefault();
    render();
  });

  addBtn.addEventListener("click", () => {
    openEditor(null, render);
  });

  render();
  return { el: div, render };
}

/**
 * プリセット一覧タブを生成する。
 *
 * @private
 * @param {Function} onUse - プリセット使用時の処理
 * @param {Function} onChange - 登録状態変更時の処理
 * @returns {HTMLElement} DOM 要素
 */
function createPresetContent(onUse, onChange) {
  const div = document.createElement("div");
  div.className = "filament-manager-content";
  div.style.overflowY = "visible";
  div.style.maxHeight = "none";

  const form = document.createElement("form");
  form.className = "search-form";
  const searchFs = document.createElement("fieldset");
  searchFs.className = "search-field";
  const searchLg = document.createElement("legend");
  searchLg.textContent = "検索";
  searchFs.appendChild(searchLg);
  searchFs.appendChild(form);
  const brandSel = document.createElement("select");
  const matSel = document.createElement("select");
  const colorSel = document.createElement("select");
  const nameIn = document.createElement("input");
  nameIn.placeholder = "名称";
  const searchBtn = document.createElement("button");
  searchBtn.textContent = "検索";
  form.append(brandSel, matSel, colorSel, nameIn, searchBtn);

  const countSpan = document.createElement("div");
  countSpan.style.fontSize = "12px";
  countSpan.style.margin = "4px 0";

  const wrap = document.createElement("div");
  wrap.className = "registered-container";
  const prevBox = document.createElement("div");
  prevBox.className = "registered-preview";
  wrap.appendChild(prevBox);

  const listBox = document.createElement("div");
  listBox.className = "registered-list";

  const table = document.createElement("table");
  table.className = "registered-table";
  const thead = document.createElement("thead");
  thead.innerHTML =
    "<tr><th data-sort='brand'>ブランド</th><th data-sort='material'>材質</th>" +
    "<th data-sort='colorName'>色名</th><th data-sort='name'>名称</th>" +
    "<th data-sort='reelSubName'>サブ名称</th>" +
    "<th data-sort='count'>使用数</th><th data-sort='last'>最終利用日時</th><th>コマンド</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);
  listBox.appendChild(table);
  wrap.appendChild(listBox);

  div.append(searchFs, countSpan, wrap);

  const preview = createFilamentPreview(prevBox, {
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    filamentColor: "#22C55E",
    reelOuterDiameter: 200,
    reelThickness: 68,
    reelWindingInnerDiameter: 95,
    reelCenterHoleDiameter: 54,
    widthPx: 120,
    heightPx: 120,
    showSlider: false,
    isFilamentPresent: true,
    showUsedUpIndicator: true,
    blinkingLightColor: "#0EA5E9",
    showInfoLength: false,
    showInfoPercent: false,
    showInfoLayers: false,
    showResetButton: false,
    showProfileViewButton: true,
    showSideViewButton: true,
    showFrontViewButton: true,
    showAutoRotateButton: true,
    enableDrag: true,
    enableClick: false,
    onClick: null,
    disableInteraction: true,
    showOverlayLength: true,
    showOverlayPercent: true,
    showLengthKg: false,
    showReelName: true,
    showReelSubName: true,
    showMaterialName: true,
    showMaterialColorName: true,
    showMaterialColorCode: true,
    showManufacturerName: true,
    showOverlayBar: true,
    showPurchaseButton: true,
    reelName: "",
    reelSubName: "",
    materialName: "",
    materialColorName: "",
    materialColorCode: "",
    manufacturerName: ""
  });

  let sortKey = "";
  let sortAsc = true;

  function buildUsageMap() {
    const map = {};
    (monitorData.usageHistory || []).forEach(h => {
      const sp = monitorData.filamentSpools.find(s => s.id === h.spoolId);
      if (!sp || !sp.presetId) return;
      const m = map[sp.presetId] || { count: 0, last: 0 };
      m.count += 1;
      const t = Number(h.startedAt || 0);
      if (t > m.last) m.last = t;
      map[sp.presetId] = m;
    });
    return map;
  }

  function buildExistsMap() {
    const map = {};
    getSpools().forEach(sp => {
      if (sp.presetId && !sp.deleted) map[sp.presetId] = true;
    });
    return map;
  }

  function fillOptions(list) {
    const brands = new Set();
    const mats = new Set();
    const colors = new Set();
    list.forEach(p => {
      if (p.brand) brands.add(p.brand);
      if (p.material) mats.add(p.material);
      if (p.colorName) colors.add(p.colorName);
    });
    brandSel.innerHTML = "<option value=''>ブランド</option>";
    [...brands].forEach(b => {
      const o = document.createElement("option");
      o.value = b;
      o.textContent = b;
      brandSel.appendChild(o);
    });
    matSel.innerHTML = "<option value=''>材質</option>";
    [...mats].forEach(m => {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m;
      matSel.appendChild(o);
    });
    colorSel.innerHTML = "<option value=''>色名</option>";
    [...colors].forEach(c => {
      const o = document.createElement("option");
      o.value = c;
      o.textContent = c;
      colorSel.appendChild(o);
    });
  }

  function applyFilter(list) {
    return list.filter(p => {
      if (brandSel.value && p.brand !== brandSel.value) return false;
      if (matSel.value && p.material !== matSel.value) return false;
      if (colorSel.value && p.colorName !== colorSel.value) return false;
      if (nameIn.value && !(p.name || "").includes(nameIn.value)) return false;
      return true;
    });
  }

  function sortList(list) {
    if (!sortKey) return list;
    return list.sort((a, b) => {
      let va = "";
      let vb = "";
      switch (sortKey) {
        case "brand":
          va = a.brand || "";
          vb = b.brand || "";
          break;
        case "material":
          va = a.material || "";
          vb = b.material || "";
          break;
        case "colorName":
          va = a.colorName || "";
          vb = b.colorName || "";
          break;
        case "name":
          va = a.name || "";
          vb = b.name || "";
          break;
        case "reelSubName":
          va = a.reelSubName || "";
          vb = b.reelSubName || "";
          break;
        case "count":
          va = usageMap[a.presetId]?.count || 0;
          vb = usageMap[b.presetId]?.count || 0;
          break;
        case "last":
          va = usageMap[a.presetId]?.last || 0;
          vb = usageMap[b.presetId]?.last || 0;
          break;
        default:
          break;
      }
      if (va === vb) return 0;
      const cmp = va > vb ? 1 : -1;
      return sortAsc ? cmp : -cmp;
    });
  }

  function render() {
    const presets = monitorData.filamentPresets || FILAMENT_PRESETS;
    usageMap = buildUsageMap();
    existsMap = buildExistsMap();
    fillOptions(presets);
    const list = sortList(applyFilter(presets));
    tbody.innerHTML = "";
    list.forEach(p => {
      const tr = document.createElement("tr");
      const usage = usageMap[p.presetId]?.count || 0;
      const last = usageMap[p.presetId]?.last
        ? new Date(usageMap[p.presetId].last).toLocaleString()
        : "";
      tr.innerHTML = `<td>${p.brand || ""}</td><td>${p.material || ""}</td>`;
      const colorCell = document.createElement("td");
      colorCell.innerHTML = `<span style='color:${p.color}'>■</span>${p.colorName || ""}`;
      tr.appendChild(colorCell);
      tr.innerHTML += `<td>${p.name || ""}</td><td>${p.reelSubName || ""}</td><td>${usage}</td><td>${last}</td>`;
      const cmd = document.createElement("td");
      const btn = document.createElement("button");
      if (existsMap[p.presetId]) {
        btn.textContent = "登録済み";
        btn.disabled = true;
        const quit = document.createElement("button");
        quit.textContent = "やめる";
        quit.addEventListener("click", () => {
          const sp = getSpools().find(s => s.presetId === p.presetId && !s.deleted);
          if (sp) deleteSpool(sp.id);
          render();
          onChange();
        });
        cmd.append(btn, quit);
      } else {
        btn.textContent = "使う";
        btn.addEventListener("click", () => {
          onUse(p);
          render();
          onChange();
        });
        cmd.appendChild(btn);
      }
      tr.appendChild(cmd);
      tr.addEventListener("click", () => {
        selectedTr?.classList.remove("selected");
        selectedTr = tr;
        tr.classList.add("selected");
        preview.setState({
          filamentDiameter: p.filamentDiameter ?? p.diameter,
          filamentTotalLength: p.filamentTotalLength ?? p.defaultLength,
          filamentCurrentLength:
            p.filamentCurrentLength ?? (p.filamentTotalLength ?? p.defaultLength),
          filamentColor: p.color,
          reelOuterDiameter: p.reelOuterDiameter,
          reelThickness: p.reelThickness,
          reelWindingInnerDiameter: p.reelWindingInnerDiameter,
          reelCenterHoleDiameter: p.reelCenterHoleDiameter,
          reelBodyColor: p.reelBodyColor,
          reelFlangeTransparency: p.reelFlangeTransparency,
          reelWindingForegroundColor: p.reelWindingForegroundColor,
          reelCenterHoleForegroundColor: p.reelCenterHoleForegroundColor,
          reelName: p.name || "",
          reelSubName: p.reelSubName || "",
          materialName: p.material,
          materialColorName: p.colorName,
          materialColorCode: p.color,
          manufacturerName: p.brand
        });
      });
      tbody.appendChild(tr);
    });
    countSpan.textContent = `一覧：(${list.length}/${presets.length}件)`;
  }

  let usageMap = buildUsageMap();
  let existsMap = buildExistsMap();

  thead.addEventListener("click", ev => {
    const th = ev.target.closest("th");
    if (!th || !th.dataset.sort) return;
    if (sortKey === th.dataset.sort) {
      sortAsc = !sortAsc;
    } else {
      sortKey = th.dataset.sort;
      sortAsc = true;
    }
    render();
  });

  form.addEventListener("submit", ev => {
    ev.preventDefault();
    render();
  });

  render();
  return { el: div, render };
}

/**
 * スプール登録・編集タブを生成する。
 * プレビューと入力フォームを備え、保存後に指定コールバックを実行する。
 *
 * @private
 * @param {Function} onDone - 保存/キャンセル後に呼び出す処理
 * @returns {{el:HTMLElement, setSpool:function(Object?, boolean=):void}} タブ要素と設定関数
 */
function createEditorContent(onDone) {
  const div = document.createElement("div");
  div.className = "filament-manager-content";

  const wrap = document.createElement("div");
  wrap.className = "registered-container";
  const prevBox = document.createElement("div");
  prevBox.className = "registered-preview";
  wrap.appendChild(prevBox);

  const form = document.createElement("form");
  form.className = "edit-form";
  wrap.appendChild(form);
  div.appendChild(wrap);

  // ── スプール基本情報 ──────────────────────────────
  const spoolField = document.createElement("fieldset");
  const spoolLegend = document.createElement("legend");
  spoolLegend.textContent = "スプール基本情報";
  spoolField.appendChild(spoolLegend);

  const diaLabel = document.createElement("label");
  diaLabel.textContent = "フィラメント太さ";
  const diaIn = document.createElement("input");
  diaIn.type = "number";
  diaIn.step = "0.01";
  diaLabel.appendChild(diaIn);

  const totLabel = document.createElement("label");
  totLabel.textContent = "フィラメント長";
  const totIn = document.createElement("input");
  totIn.type = "number";
  totLabel.appendChild(totIn);

  const curLabel = document.createElement("label");
  curLabel.textContent = "残量";
  const curIn = document.createElement("input");
  curIn.type = "number";
  curIn.disabled = true;
  curLabel.appendChild(curIn);

  const odLabel = document.createElement("label");
  odLabel.textContent = "リール外径";
  const odIn = document.createElement("input");
  odIn.type = "number";
  odLabel.appendChild(odIn);

  const thickLabel = document.createElement("label");
  thickLabel.textContent = "リール厚";
  const thickIn = document.createElement("input");
  thickIn.type = "number";
  thickLabel.appendChild(thickIn);

  const idLabel = document.createElement("label");
  idLabel.textContent = "巻き径";
  const idIn = document.createElement("input");
  idIn.type = "number";
  idLabel.appendChild(idIn);

  const holeLabel = document.createElement("label");
  holeLabel.textContent = "中心穴径";
  const holeIn = document.createElement("input");
  holeIn.type = "number";
  holeLabel.appendChild(holeIn);

  const bodyColorLabel = document.createElement("label");
  bodyColorLabel.textContent = "リール色";
  const bodyColorIn = document.createElement("input");
  bodyColorIn.type = "color";
  bodyColorLabel.appendChild(bodyColorIn);

  const transLabel = document.createElement("label");
  transLabel.textContent = "フランジ透過";
  const transIn = document.createElement("input");
  transIn.type = "number";
  transIn.step = "0.1";
  transLabel.appendChild(transIn);

  const holeColorLabel = document.createElement("label");
  holeColorLabel.textContent = "中心穴色";
  const holeColorIn = document.createElement("input");
  holeColorIn.type = "color";
  holeColorLabel.appendChild(holeColorIn);

  totIn.addEventListener("input", () => {
    curIn.value = totIn.value;
  });

  diaIn.addEventListener("input", () => {
    preview.setOption("filamentDiameter", Number(diaIn.value));
  });

  [totIn, curIn, odIn, thickIn, idIn, holeIn].forEach(el => {
    el.addEventListener("input", () => {
      preview.setState({
        filamentTotalLength: Number(totIn.value) || DEFAULT_FILAMENT_DATA.filamentTotalLength,
        filamentCurrentLength: Number(curIn.value) || DEFAULT_FILAMENT_DATA.filamentCurrentLength,
        reelOuterDiameter: Number(odIn.value) || DEFAULT_FILAMENT_DATA.reelOuterDiameter,
        reelThickness: Number(thickIn.value) || DEFAULT_FILAMENT_DATA.reelThickness,
        reelWindingInnerDiameter: Number(idIn.value) || DEFAULT_FILAMENT_DATA.reelWindingInnerDiameter,
        reelCenterHoleDiameter: Number(holeIn.value) || DEFAULT_FILAMENT_DATA.reelCenterHoleDiameter
      });
    });
  });

  [bodyColorIn, transIn, holeColorIn].forEach(el => {
    el.addEventListener("input", () => {
      preview.setState({
        reelBodyColor: bodyColorIn.value,
        reelFlangeTransparency: Number(transIn.value) || DEFAULT_FILAMENT_DATA.reelFlangeTransparency,
        reelCenterHoleForegroundColor: holeColorIn.value
      });
    });
  });

  spoolField.append(
    diaLabel,
    totLabel,
    curLabel,
    odLabel,
    thickLabel,
    idLabel,
    holeLabel,
    bodyColorLabel,
    transLabel,
    holeColorLabel
  );

  // ── フィラメント基本情報 ──────────────────────────
  const filamentField = document.createElement("fieldset");
  const filLegend = document.createElement("legend");
  filLegend.textContent = "フィラメント基本情報";
  filamentField.appendChild(filLegend);

  const manuLabel = document.createElement("label");
  manuLabel.textContent = "ブランド";
  const manuIn = document.createElement("input");
  manuLabel.appendChild(manuIn);

  const nameLabel = document.createElement("label");
  nameLabel.textContent = "名称";
  const nameIn = document.createElement("input");
  nameLabel.appendChild(nameIn);

  const subLabel = document.createElement("label");
  subLabel.textContent = "サブ名称";
  const subIn = document.createElement("input");
  subLabel.appendChild(subIn);

  const colorLabel = document.createElement("label");
  colorLabel.textContent = "色";
  const colorIn = document.createElement("input");
  colorIn.type = "color";
  colorLabel.appendChild(colorIn);

  // 色変更時はプレビューに反映
  colorIn.addEventListener("input", () => {
    preview.setOption("filamentColor", colorIn.value);
  });

  const matLabel = document.createElement("label");
  matLabel.textContent = "素材";
  const matSel = document.createElement("select");
  ["PLA", "PETG", "ABS", "TPU"].forEach(m => {
    const o = document.createElement("option");
    o.value = m; o.textContent = m; matSel.appendChild(o);
  });
  matLabel.appendChild(matSel);

  const matColorLabel = document.createElement("label");
  matColorLabel.textContent = "素材色名";
  const matColorIn = document.createElement("input");
  matColorLabel.appendChild(matColorIn);

  const linkLabel = document.createElement("label");
  linkLabel.textContent = "購入先";
  const linkIn = document.createElement("input");
  linkLabel.appendChild(linkIn);

  const priceLabel = document.createElement("label");
  priceLabel.textContent = "値段";
  const curSel = document.createElement("select");
  ["\u00A5", "$"].forEach(s => {
    const o = document.createElement("option");
    o.value = s; o.textContent = s; curSel.appendChild(o);
  });
  const priceIn = document.createElement("input");
  priceIn.type = "number";
  priceLabel.append(curSel, priceIn);

  const presetLabel = document.createElement("label");
  presetLabel.textContent = "プリセットID";
  const presetIn = document.createElement("input");
  presetIn.disabled = true;
  presetLabel.appendChild(presetIn);

  const noteLabel = document.createElement("label");
  noteLabel.textContent = "メモ";
  const noteIn = document.createElement("input");
  noteLabel.appendChild(noteIn);

  const favLabel = document.createElement("label");
  const favIn = document.createElement("input");
  favIn.type = "checkbox";
  favLabel.appendChild(favIn);
  favLabel.append(" お気に入り");

  filamentField.append(
    manuLabel,
    nameLabel,
    subLabel,
    colorLabel,
    matLabel,
    matColorLabel,
    linkLabel,
    priceLabel,
    presetLabel,
    noteLabel,
    favLabel
  );

  const btnBox = document.createElement("div");
  btnBox.className = "edit-buttons";
  const okBtn = document.createElement("button");
  okBtn.textContent = "保存";
  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "戻る";
  cancelBtn.type = "button";
  btnBox.append(okBtn, cancelBtn);

  form.append(spoolField, filamentField, btnBox);

  const preview = createFilamentPreview(prevBox, {
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    filamentColor: "#22C55E",
    reelOuterDiameter: 200,
    reelThickness: 68,
    reelWindingInnerDiameter: 95,
    reelCenterHoleDiameter: 54,
    widthPx: 120,
    heightPx: 120,
    showSlider: false,
    isFilamentPresent: true,
    showUsedUpIndicator: true,
    blinkingLightColor: "#0EA5E9",
    showInfoLength: false,
    showInfoPercent: false,
    showInfoLayers: false,
    showResetButton: false,
    showProfileViewButton: true,
    showSideViewButton: true,
    showFrontViewButton: true,
    showAutoRotateButton: true,
    enableDrag: true,
    enableClick: false,
    onClick: null,
    disableInteraction: true,
    showOverlayLength: true,
    showOverlayPercent: true,
    showLengthKg: false,
    showReelName: true,
    showReelSubName: true,
    showMaterialName: true,
    showMaterialColorName: true,
    showMaterialColorCode: true,
    showManufacturerName: true,
    showOverlayBar: true,
    showPurchaseButton: true,
    reelName: "",
    reelSubName: "",
    materialName: "",
    materialColorName: "",
    materialColorCode: "",
    manufacturerName: ""
  });

  let current = null;
  let isNew = false;

  function fillForm(sp) {
    const d = { ...DEFAULT_FILAMENT_DATA, ...sp };
    diaIn.value = d.filamentDiameter;
    totIn.value = d.filamentTotalLength ?? d.totalLengthMm;
    curIn.value = d.filamentCurrentLength ?? d.remainingLengthMm ?? totIn.value;
    odIn.value = d.reelOuterDiameter;
    thickIn.value = d.reelThickness;
    idIn.value = d.reelWindingInnerDiameter;
    holeIn.value = d.reelCenterHoleDiameter;
    bodyColorIn.value = d.reelBodyColor;
    transIn.value = d.reelFlangeTransparency;
    holeColorIn.value = d.reelCenterHoleForegroundColor;

    manuIn.value = d.manufacturerName || d.brand;
    nameIn.value = d.reelName || d.name;
    subIn.value = d.reelSubName || "";
    colorIn.value = d.filamentColor || d.color;
    matSel.value = d.materialName || d.material || "PLA";
    matColorIn.value = d.materialColorName || d.colorName || "";
    linkIn.value = d.purchaseLink || "";
    curSel.value = d.currencySymbol;
    priceIn.value = d.price || d.purchasePrice || 0;
    presetIn.value = d.presetId || "";
    noteIn.value = d.note || "";
    favIn.checked = !!d.isFavorite;

    preview.setState({
      filamentDiameter: Number(diaIn.value) || DEFAULT_FILAMENT_DATA.filamentDiameter,
      filamentTotalLength: Number(totIn.value) || DEFAULT_FILAMENT_DATA.filamentTotalLength,
      filamentCurrentLength: Number(curIn.value) || DEFAULT_FILAMENT_DATA.filamentCurrentLength,
      filamentColor: colorIn.value,
      reelOuterDiameter: Number(odIn.value) || DEFAULT_FILAMENT_DATA.reelOuterDiameter,
      reelThickness: Number(thickIn.value) || DEFAULT_FILAMENT_DATA.reelThickness,
      reelWindingInnerDiameter: Number(idIn.value) || DEFAULT_FILAMENT_DATA.reelWindingInnerDiameter,
      reelCenterHoleDiameter: Number(holeIn.value) || DEFAULT_FILAMENT_DATA.reelCenterHoleDiameter,
      reelBodyColor: bodyColorIn.value,
      reelFlangeTransparency: Number(transIn.value) || DEFAULT_FILAMENT_DATA.reelFlangeTransparency,
      reelCenterHoleForegroundColor: holeColorIn.value,
      reelName: nameIn.value,
      reelSubName: subIn.value,
      materialName: matSel.value,
      materialColorName: matColorIn.value,
      materialColorCode: colorIn.value,
      manufacturerName: manuIn.value
    });
  }

  okBtn.addEventListener("click", ev => {
    ev.preventDefault();
    const data = {
      filamentDiameter: Number(diaIn.value) || DEFAULT_FILAMENT_DATA.filamentDiameter,
      filamentTotalLength: Number(totIn.value) || DEFAULT_FILAMENT_DATA.filamentTotalLength,
      filamentCurrentLength: Number(curIn.value) || DEFAULT_FILAMENT_DATA.filamentCurrentLength,
      reelOuterDiameter: Number(odIn.value) || DEFAULT_FILAMENT_DATA.reelOuterDiameter,
      reelThickness: Number(thickIn.value) || DEFAULT_FILAMENT_DATA.reelThickness,
      reelWindingInnerDiameter: Number(idIn.value) || DEFAULT_FILAMENT_DATA.reelWindingInnerDiameter,
      reelCenterHoleDiameter: Number(holeIn.value) || DEFAULT_FILAMENT_DATA.reelCenterHoleDiameter,
      reelBodyColor: bodyColorIn.value,
      reelFlangeTransparency: Number(transIn.value) || DEFAULT_FILAMENT_DATA.reelFlangeTransparency,
      reelCenterHoleForegroundColor: holeColorIn.value,
      manufacturerName: manuIn.value,
      reelName: nameIn.value,
      reelSubName: subIn.value,
      filamentColor: colorIn.value,
      materialName: matSel.value,
      materialColorName: matColorIn.value,
      materialColorCode: colorIn.value,
      purchaseLink: linkIn.value,
      price: Number(priceIn.value) || 0,
      currencySymbol: curSel.value,
      presetId: presetIn.value || null,
      note: noteIn.value,
      isFavorite: favIn.checked
    };
    if (isNew) addSpool(data); else updateSpool(current.id, data);
    onDone();
  });

  cancelBtn.addEventListener("click", () => onDone());

  return {
    el: div,
    setSpool(sp = {}, fresh = false) {
      current = sp;
      isNew = fresh || !sp.id;
      fillForm(sp);
    }
  };
}

/**
 * 日付から週番号キー (YYYY-WW) を生成する。
 *
 * @private
 * @param {Date} date - 変換対象の日付
 * @returns {string} 週キー
 */
function formatWeekKey(date) {
  const first = new Date(date.getFullYear(), 0, 1);
  const days = Math.floor((date - first) / 86400000);
  const week = Math.floor((days + first.getDay()) / 7) + 1;
  return `${date.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * 日付から月番号キー (YYYY-MM) を生成する。
 *
 * @private
 * @param {Date} date - 変換対象の日付
 * @returns {string} 月キー
 */
function formatMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * 集計レポートタブの内容を生成する。
 * 日別集計テーブルに加え、週次・月次のグラフを表示する。
 *
 * @private
 * @returns {HTMLElement} DOM 要素
 */
function createReportContent() {
  const div = document.createElement("div");
  div.className = "filament-manager-content";

  // ── 1) 日別集計テーブル ───────────────────────────────
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>日付</th><th>スプール数</th><th>消費量(mm)</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");

  const dailyMap = {};
  const weeklyMap = {};
  const monthlyMap = {};

  (monitorData.usageHistory || []).forEach(u => {
    const dateObj = new Date(Number(u.startedAt || 0));
    const dayKey = dateObj.toISOString().slice(0, 10);
    if (!dailyMap[dayKey]) dailyMap[dayKey] = { ids: new Set(), len: 0 };
    dailyMap[dayKey].ids.add(u.spoolId);
    const used = Number(u.usedLength || 0);
    dailyMap[dayKey].len += used;

    const wKey = formatWeekKey(dateObj);
    weeklyMap[wKey] = (weeklyMap[wKey] || 0) + used;

    const mKey = formatMonthKey(dateObj);
    monthlyMap[mKey] = (monthlyMap[mKey] || 0) + used;
  });

  Object.entries(dailyMap)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .forEach(([d, info]) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${d}</td><td>${info.ids.size}</td><td>${info.len.toLocaleString()}</td>`;
      tbody.appendChild(tr);
    });
  table.appendChild(tbody);
  div.appendChild(table);

  // ── 2) 週次・月次の消費量を Chart.js で表示 ─────────────────
  const weekCanvas = document.createElement("canvas");
  weekCanvas.style.maxHeight = "200px";
  div.appendChild(weekCanvas);

  const monthCanvas = document.createElement("canvas");
  monthCanvas.style.maxHeight = "200px";
  div.appendChild(monthCanvas);

  if (typeof Chart !== "undefined") {
    new Chart(weekCanvas.getContext("2d"), {
      type: "bar",
      data: {
        labels: Object.keys(weeklyMap),
        datasets: [
          { label: "週次消費量(mm)", data: Object.values(weeklyMap) }
        ]
      },
      options: { responsive: true, maintainAspectRatio: false }
    });

    new Chart(monthCanvas.getContext("2d"), {
      type: "pie",
      data: {
        labels: Object.keys(monthlyMap),
        datasets: [
          { label: "月次消費量(mm)", data: Object.values(monthlyMap) }
        ]
      },
      options: { responsive: true, maintainAspectRatio: false }
    });
  }

  return div;
}

/**
 * フィラメント管理モーダルを表示する。
 *
 * @function showFilamentManager
 * @returns {void}
 */
export function showFilamentManager() {
  injectStyles();
  const overlay = document.createElement("div");
  overlay.className = "filament-manager-overlay";
  const modal = document.createElement("div");
  modal.className = "filament-manager-modal";
  overlay.appendChild(modal);

  const header = document.createElement("div");
  header.className = "filament-manager-header";
  header.innerHTML = '<span>フィラメント管理</span>';
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => overlay.remove());
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const tabBar = document.createElement("div");
  tabBar.className = "filament-manager-tabs";
  const REGISTERED_IDX = 3;
  const tabs = [
    "使用記録簿",
    "現在のスプール",
    "在庫",
    "登録済みフィラメント",
    "プリセット",
    "集計レポート"
  ];

  let switchTab = () => {};

  const editTab = createEditorContent(() => {
    contents[REGISTERED_IDX].render();
    switchTab(REGISTERED_IDX);
  });

  const contents = [
    createHistoryContent(),
    createCurrentSpoolContent(),
    createInventoryContent(),
    null,
    null,
    createReportContent(),
    editTab.el
  ];

  const registered = createRegisteredContent((sp, refresh) => {
    editTab.setSpool(sp || {}, !sp);
    switchTab(contents.length - 1);
    if (refresh) refresh();
  });
  const presetTab = createPresetContent(
    p => {
      addSpoolFromPreset(p);
      registered.render();
    },
    () => {
      registered.render();
    }
  );
  contents[REGISTERED_IDX] = registered.el;
  contents[REGISTERED_IDX + 1] = presetTab.el;

  const contentWrap = document.createElement("div");
  modal.appendChild(tabBar);
  modal.appendChild(contentWrap);

  switchTab = function (idx) {
    tabBar.querySelectorAll("button").forEach((b, i) => {
      b.classList.toggle("active", i === idx);
    });
    contents.forEach((c, i) => {
      c.style.display = i === idx ? "block" : "none";
    });
  };

  tabs.forEach((name, i) => {
    const btn = document.createElement("button");
    btn.textContent = name;
    if (i === 0) btn.classList.add("active");
    btn.addEventListener("click", () => switchTab(i));
    tabBar.appendChild(btn);
  });

  contents.forEach((c, i) => {
    if (i !== 0) c.style.display = "none";
    contentWrap.appendChild(c);
  });

  document.body.appendChild(overlay);
}

// DOM 読み込み後にボタンをバインド
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("filament-list-btn")?.addEventListener("click", () => {
    showFilamentManager();
  });
});
