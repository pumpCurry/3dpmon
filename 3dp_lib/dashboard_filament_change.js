/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 フィラメント交換ダイアログ モジュール
 * @file dashboard_filament_change.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_filament_change
 *
 * 【機能内容サマリ】
 * - フィラメント交換モーダルの表示
 * - 選択したスプールを現在のスプールとして設定
 *
 * 【公開関数一覧】
 * - {@link showFilamentChangeDialog}：交換ダイアログ表示
 *
 * @version 1.390.630 (PR #292)
 * @since   1.390.230 (PR #104)
 * @lastModified 2025-07-02 16:26:34
 * -----------------------------------------------------------
 * @todo
 * - none
 */
"use strict";

import { getSpools, getSpoolById, setCurrentSpoolId, addSpoolFromPreset } from "./dashboard_spool.js";
import { consumeInventory, getInventoryItem } from "./dashboard_filament_inventory.js";
import { monitorData } from "./dashboard_data.js";
import { createFilamentPreview } from "./dashboard_filament_view.js";
import { showFilamentManager } from "./dashboard_filament_manager.js";

let styleInjected = false;
let filamentChangeDialogOpen = false;

/**
 * ダイアログ用CSSを一度だけ注入する。
 *
 * @private
 * @returns {void}
 */
function injectStyles() {
  if (styleInjected) return;
  styleInjected = true;
  const css = `
  .fc-overlay{position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:3000;}
  .fc-dialog{background:#fff;border-radius:8px;width:90%;max-width:740px;box-shadow:0 2px 12px rgba(0,0,0,0.4);display:flex;flex-direction:column;}
  .fc-header{font-weight:bold;font-size:1.2em;padding:8px;border-bottom:1px solid #ddd;}
  .fc-body{padding:8px;}
  .fc-buttons{display:flex;justify-content:flex-end;padding:8px;border-top:1px solid #ddd;gap:8px;}
  .fc-buttons button{padding:6px 12px;font-size:14px;}
  .fc-search{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px;}
  .fc-search select,.fc-search input{padding:2px;font-size:12px;}
  .fc-search-field{border:1px solid #ccc;border-radius:6px;padding:4px;margin-bottom:4px;}
  .fc-search-field legend{font-size:12px;}
  .fc-stock{font-size:12px;text-align:center;margin-top:4px;}
  .registered-container{display:flex;gap:8px;align-items:flex-start;}
  .registered-preview{flex:0 0 120px;min-width:120px;min-height:120px;}
  .registered-list{flex:1;overflow-y:auto;max-height:60vh;}
  .registered-table{width:100%;border-collapse:collapse;font-size:12px;}
  .registered-table th,.registered-table td{border:1px solid #ddd;padding:4px;}
  .registered-table th{cursor:pointer;}
  .registered-table tr.selected{background:#e0f2fe;}
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * フィラメントプレビューに選択スプールの情報を反映する。
 *
 * @private
 * @param {Object} sp - スプールデータ
 * @returns {void}
 */
export function updatePreview(sp, preview = window.filamentPreview) {
  const fp = preview;
  if (!fp || !sp) return;
  if (sp.filamentColor) fp.setOption("filamentColor", sp.filamentColor);
  else if (sp.color) fp.setOption("filamentColor", sp.color);
  if (typeof sp.totalLengthMm === "number") fp.setOption("filamentTotalLength", sp.totalLengthMm);
  if (typeof sp.filamentDiameter === "number") fp.setOption("filamentDiameter", sp.filamentDiameter);
  if (sp.name) { fp.setOption("reelName", sp.name); fp.setOption("showReelName", true); }
  if (sp.material || sp.materialName) {
    fp.setOption("materialName", sp.material || sp.materialName);
    fp.setOption("showMaterialName", true);
  } else {
    fp.setOption("showMaterialName", false);
  }
  if (typeof sp.remainingLengthMm === "number") {
    fp.setRemainingLength(sp.remainingLengthMm);
  }
  if (sp.colorName) {
    fp.setOption("materialColorName", sp.colorName);
    fp.setOption("showMaterialColorName", true);
  } else {
    fp.setOption("showMaterialColorName", false);
  }
  if (sp.filamentColor || sp.color) {
    fp.setOption("materialColorCode", sp.filamentColor || sp.color);
    fp.setOption("showMaterialColorCode", true);
  } else {
    fp.setOption("showMaterialColorCode", false);
  }
}

/**
 * プリセットから新品スプールを選択するダイアログを表示する。
 *
 * @function showPresetOpenDialog
 * @returns {Promise<boolean>} true:セット実行 / false:キャンセル
 */
export function showPresetOpenDialog(hostname) {
  injectStyles();
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "fc-overlay";
    const dlg = document.createElement("div");
    dlg.className = "fc-dialog";
    overlay.appendChild(dlg);

    dlg.innerHTML = `
      <div class="fc-header">新品フィラメント選択</div>
      <div class="fc-body">
        <fieldset class="fc-search-field">
          <legend>検索</legend>
          <form id="fc-search" class="fc-search">
            <select id="fc-brand"></select>
            <select id="fc-material"></select>
            <select id="fc-color"></select>
            <input id="fc-name" placeholder="名称">
            <button id="fc-search-btn">検索</button>
          </form>
        </fieldset>
        <div class="registered-container">
          <div class="registered-preview">
            <div id="fc-preview"></div>
            <div id="fc-stock" class="fc-stock"></div>
          </div>
          <div class="registered-list">
            <table class="registered-table">
              <thead>
                <tr><th>ブランド</th><th>材質</th><th>色名</th><th>名称</th><th>サブ名称</th></tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="fc-buttons">
        <button id="fc-cancel">キャンセル</button>
        <button id="fc-ok" disabled>このフィラメントを選択</button>
      </div>
    `;

    const brandSel = dlg.querySelector("#fc-brand");
    const matSel = dlg.querySelector("#fc-material");
    const colorSel = dlg.querySelector("#fc-color");
    const nameIn = dlg.querySelector("#fc-name");
    const searchForm = dlg.querySelector("#fc-search");
    const tableBody = dlg.querySelector(".registered-table tbody");
    const prevEl = dlg.querySelector("#fc-preview");
    const stockEl = dlg.querySelector("#fc-stock");
    const okBtn = dlg.querySelector("#fc-ok");

    const preview = createFilamentPreview(prevEl, {
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

    const presets = monitorData.filamentPresets || [];
    let selectedPreset = null;

    function buildUsageMap() {
      const map = {};
      (monitorData.usageHistory || []).forEach(h => {
        const sp = monitorData.filamentSpools.find(s => s.id === h.spoolId);
        if (!sp || !sp.presetId) return;
        const m = map[sp.presetId] || { count: 0 };
        m.count += 1;
        map[sp.presetId] = m;
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
      brandSel.innerHTML = '<option value="">ブランド</option>';
      [...brands].forEach(b => {
        const o = document.createElement('option');
        o.value = b;
        o.textContent = b;
        brandSel.appendChild(o);
      });
      matSel.innerHTML = '<option value="">材質</option>';
      [...mats].forEach(m => {
        const o = document.createElement('option');
        o.value = m;
        o.textContent = m;
        matSel.appendChild(o);
      });
      colorSel.innerHTML = '<option value="">色名</option>';
      [...colors].forEach(c => {
        const o = document.createElement('option');
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
        if (nameIn.value && !(p.name || '').includes(nameIn.value)) return false;
        return true;
      });
    }

    const usageMap = buildUsageMap();

    function updateInfo(p) {
      if (!p) { stockEl.textContent = ''; return; }
      const inv = getInventoryItem(p.presetId);
      if (inv) {
        stockEl.textContent = `在庫: ${inv.quantity} / 使用数: ${inv.totalUsedNum}`;
      } else {
        stockEl.textContent = `使用数: ${usageMap[p.presetId]?.count || 0}`;
      }
      preview.setState({
        filamentDiameter: p.filamentDiameter ?? p.diameter,
        filamentTotalLength: p.filamentTotalLength ?? p.defaultLength,
        filamentCurrentLength: p.filamentCurrentLength ?? (p.filamentTotalLength ?? p.defaultLength),
        filamentColor: p.color,
        reelOuterDiameter: p.reelOuterDiameter,
        reelThickness: p.reelThickness,
        reelWindingInnerDiameter: p.reelWindingInnerDiameter,
        reelCenterHoleDiameter: p.reelCenterHoleDiameter,
        reelName: p.name || '',
        reelSubName: p.reelSubName || '',
        materialName: p.material,
        materialColorName: p.colorName,
        materialColorCode: p.color,
        manufacturerName: p.brand
      });
    }

    function renderTable() {
      const list = applyFilter(presets);
      tableBody.innerHTML = '';
      list.forEach(p => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${p.brand || ''}</td>` +
          `<td>${p.material || ''}</td>` +
          `<td><span style='color:${p.color}'>■</span>${p.colorName || ''}</td>` +
          `<td>${p.name || ''}</td>` +
          `<td>${p.reelSubName || ''}</td>`;
        tr.addEventListener('click', () => {
          tableBody.querySelector('tr.selected')?.classList.remove('selected');
          tr.classList.add('selected');
          selectedPreset = p;
          okBtn.disabled = false;
          updateInfo(p);
        });
        tableBody.appendChild(tr);
      });
    }

    fillOptions(presets);
    renderTable();

    searchForm.addEventListener('submit', ev => {
      ev.preventDefault();
      renderTable();
    });

    document.body.appendChild(overlay);

    dlg.querySelector('#fc-cancel').addEventListener('click', () => {
      overlay.remove();
      resolve(false);
    });

    dlg.querySelector('#fc-ok').addEventListener('click', () => {
      if (!selectedPreset) { overlay.remove(); resolve(false); return; }
      const sp = addSpoolFromPreset(selectedPreset);
      setCurrentSpoolId(sp.id, hostname);
      const hostPreview = window._filamentPreviews?.get(hostname);
      updatePreview(sp, hostPreview);
      overlay.remove();
      resolve(true);
    });
  });
}

/**
 * フィラメント交換ダイアログを表示する。
 * 既にダイアログが開いている場合は再表示しない。
 *
 * @function showFilamentChangeDialog
 * @returns {Promise<boolean>} true:交換実行 / false:キャンセル
 */
export function showFilamentChangeDialog(hostname) {
  injectStyles();
  if (filamentChangeDialogOpen) {
    return Promise.resolve(false);
  }
  filamentChangeDialogOpen = true;
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "fc-overlay";
    const dlg = document.createElement("div");
    dlg.className = "fc-dialog";
    overlay.appendChild(dlg);

    dlg.innerHTML = `
      <div class="fc-header">フィラメント交換</div>
      <div class="fc-body">
        <fieldset class="fc-search-field">
          <legend>検索</legend>
          <form id="fc-search" class="fc-search">
            <select id="fc-brand"></select>
            <select id="fc-material"></select>
            <select id="fc-color"></select>
            <input id="fc-name" placeholder="名称">
            <button id="fc-search-btn">検索</button>
          </form>
        </fieldset>
        <div class="registered-container">
          <div class="registered-preview">
            <div id="fc-preview"></div>
            <div id="fc-stock" class="fc-stock"></div>
          </div>
          <div class="registered-list">
            <table class="registered-table">
              <thead>
                <tr><th>ブランド</th><th>材質</th><th>色名</th><th>名称</th><th>サブ名称</th></tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="fc-buttons">
        <button id="fc-cancel">キャンセル</button>
        <button id="fc-used">過去取り外したスプールから選択</button>
        <button id="fc-new">新品を開封</button>
        <button id="fc-ok" disabled>このフィラメントを選択</button>
      </div>
    `;

    const brandSel = dlg.querySelector("#fc-brand");
    const matSel = dlg.querySelector("#fc-material");
    const colorSel = dlg.querySelector("#fc-color");
    const nameIn = dlg.querySelector("#fc-name");
    const searchForm = dlg.querySelector("#fc-search");
    const tableBody = dlg.querySelector(".registered-table tbody");
    const prevEl = dlg.querySelector("#fc-preview");
    const stockEl = dlg.querySelector("#fc-stock");
    const okBtn = dlg.querySelector("#fc-ok");

    const dialogPreview = createFilamentPreview(prevEl, {
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

    const spools = getSpools();
    let selectedSpool = spools.find(s => s.isActive) || null;

    function fillOptions(list) {
      const brands = new Set();
      const mats = new Set();
      const colors = new Set();
      list.forEach(sp => {
        if (sp.manufacturerName) brands.add(sp.manufacturerName);
        else if (sp.brand) brands.add(sp.brand);
        if (sp.materialName) mats.add(sp.materialName);
        else if (sp.material) mats.add(sp.material);
        if (sp.colorName) colors.add(sp.colorName);
      });
      brandSel.innerHTML = '<option value="">ブランド</option>';
      [...brands].forEach(b => {
        const o = document.createElement('option');
        o.value = b;
        o.textContent = b;
        brandSel.appendChild(o);
      });
      matSel.innerHTML = '<option value="">材質</option>';
      [...mats].forEach(m => {
        const o = document.createElement('option');
        o.value = m;
        o.textContent = m;
        matSel.appendChild(o);
      });
      colorSel.innerHTML = '<option value="">色名</option>';
      [...colors].forEach(c => {
        const o = document.createElement('option');
        o.value = c;
        o.textContent = c;
        colorSel.appendChild(o);
      });
    }

    function applyFilter(list) {
      return list.filter(sp => {
        if (brandSel.value) {
          const b = sp.manufacturerName || sp.brand || '';
          if (b !== brandSel.value) return false;
        }
        if (matSel.value) {
          const m = sp.materialName || sp.material || '';
          if (m !== matSel.value) return false;
        }
        if (colorSel.value && sp.colorName !== colorSel.value) return false;
        if (nameIn.value) {
          const n = `${sp.name || ''}${sp.reelName || ''}${sp.reelSubName || ''}`;
          if (!n.includes(nameIn.value)) return false;
        }
        return true;
      });
    }

    function updateInfo(sp) {
      if (!sp) { stockEl.textContent = ''; return; }
      const inv = sp.presetId ? getInventoryItem(sp.presetId) : null;
      stockEl.textContent = inv ? `在庫: ${inv.quantity}` : '在庫: -';
      updatePreview(sp, dialogPreview);
    }

    function renderTable() {
      const list = applyFilter(spools);
      tableBody.innerHTML = '';
      list.forEach(sp => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${sp.manufacturerName || sp.brand || ''}</td>` +
          `<td>${sp.materialName || sp.material || ''}</td>` +
          `<td><span style='color:${sp.filamentColor || sp.color || '#000'}'>■</span>${sp.colorName || ''}</td>` +
          `<td>${sp.name || sp.reelName || ''}</td>` +
          `<td>${sp.reelSubName || ''}</td>`;
        tr.addEventListener('click', () => {
          tableBody.querySelector('tr.selected')?.classList.remove('selected');
          tr.classList.add('selected');
          selectedSpool = sp;
          okBtn.disabled = false;
          updateInfo(sp);
        });
        tableBody.appendChild(tr);
      });
    }

    fillOptions(spools);
    renderTable();
    if (selectedSpool) updateInfo(selectedSpool);

    searchForm.addEventListener('submit', ev => {
      ev.preventDefault();
      renderTable();
    });

    document.body.appendChild(overlay);

    const closeDialog = result => {
      overlay.remove();
      filamentChangeDialogOpen = false;
      resolve(result);
    };

    dlg.querySelector("#fc-cancel").addEventListener("click", () => {
      closeDialog(false);
    });

    dlg.querySelector("#fc-ok").addEventListener("click", () => {
      if (selectedSpool) {
        setCurrentSpoolId(selectedSpool.id, hostname);
        if (selectedSpool.presetId) consumeInventory(selectedSpool.presetId, 1);
        const hostPreview = window._filamentPreviews?.get(hostname);
        updatePreview(selectedSpool, hostPreview);
      }
      closeDialog(true);
    });

    dlg.querySelector("#fc-used").addEventListener("click", () => {
      closeDialog(false);
      showFilamentManager(2, hostname);
    });

    dlg.querySelector("#fc-new").addEventListener("click", async () => {
      closeDialog(await showPresetOpenDialog(hostname));
    });
  });
}

/**
 * 履歴用: プリセットから新品スプールを作成するダイアログ。
 * `showPresetOpenDialog` と同じUIだが `setCurrentSpoolId` を呼ばない。
 *
 * @private
 * @param {string} hostname - ホスト名
 * @returns {Promise<{spool:Object, isNew:boolean}|false>}
 */
function showPresetOpenDialogForHistory(hostname) {
  injectStyles();
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "fc-overlay";
    const dlg = document.createElement("div");
    dlg.className = "fc-dialog";
    overlay.appendChild(dlg);

    dlg.innerHTML = `
      <div class="fc-header">新品フィラメントを開封して指定</div>
      <div class="fc-body">
        <fieldset class="fc-search-field">
          <legend>検索</legend>
          <form id="fc-search" class="fc-search">
            <select id="fc-brand"></select>
            <select id="fc-material"></select>
            <select id="fc-color"></select>
            <input id="fc-name" placeholder="名称">
            <button id="fc-search-btn">検索</button>
          </form>
        </fieldset>
        <div class="registered-container">
          <div class="registered-preview">
            <div id="fc-preview"></div>
            <div id="fc-stock" class="fc-stock"></div>
          </div>
          <div class="registered-list">
            <table class="registered-table">
              <thead>
                <tr><th>ブランド</th><th>材質</th><th>色名</th><th>名称</th><th>サブ名称</th></tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="fc-buttons">
        <button id="fc-cancel">キャンセル</button>
        <button id="fc-ok" disabled>このフィラメントを選択</button>
      </div>
    `;

    const brandSel = dlg.querySelector("#fc-brand");
    const matSel = dlg.querySelector("#fc-material");
    const colorSel = dlg.querySelector("#fc-color");
    const nameIn = dlg.querySelector("#fc-name");
    const searchForm = dlg.querySelector("#fc-search");
    const tableBody = dlg.querySelector(".registered-table tbody");
    const prevEl = dlg.querySelector("#fc-preview");
    const stockEl = dlg.querySelector("#fc-stock");
    const okBtn = dlg.querySelector("#fc-ok");

    const preview = createFilamentPreview(prevEl, {
      filamentDiameter: 1.75, filamentTotalLength: 336000,
      filamentCurrentLength: 336000, filamentColor: "#22C55E",
      reelOuterDiameter: 200, reelThickness: 68,
      reelWindingInnerDiameter: 95, reelCenterHoleDiameter: 54,
      widthPx: 120, heightPx: 120, showSlider: false,
      isFilamentPresent: true, showUsedUpIndicator: true,
      disableInteraction: true, showOverlayLength: true,
      showOverlayPercent: true, showOverlayBar: true,
      showReelName: true, showReelSubName: true,
      showMaterialName: true, showMaterialColorName: true,
      showMaterialColorCode: true, showManufacturerName: true,
      showPurchaseButton: true,
      reelName: "", reelSubName: "", materialName: "",
      materialColorName: "", materialColorCode: "", manufacturerName: ""
    });

    const presets = monitorData.filamentPresets || [];
    let selectedPreset = null;

    function fillOptions(list) {
      const brands = new Set(), mats = new Set(), colors = new Set();
      list.forEach(p => {
        if (p.brand) brands.add(p.brand);
        if (p.material) mats.add(p.material);
        if (p.colorName) colors.add(p.colorName);
      });
      brandSel.innerHTML = '<option value="">ブランド</option>';
      [...brands].forEach(b => { const o = document.createElement('option'); o.value = b; o.textContent = b; brandSel.appendChild(o); });
      matSel.innerHTML = '<option value="">材質</option>';
      [...mats].forEach(m => { const o = document.createElement('option'); o.value = m; o.textContent = m; matSel.appendChild(o); });
      colorSel.innerHTML = '<option value="">色名</option>';
      [...colors].forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; colorSel.appendChild(o); });
    }

    function applyFilter(list) {
      return list.filter(p => {
        if (brandSel.value && p.brand !== brandSel.value) return false;
        if (matSel.value && p.material !== matSel.value) return false;
        if (colorSel.value && p.colorName !== colorSel.value) return false;
        if (nameIn.value && !(p.name || '').includes(nameIn.value)) return false;
        return true;
      });
    }

    function renderTable() {
      const list = applyFilter(presets);
      tableBody.innerHTML = '';
      list.forEach(p => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${p.brand || ''}</td><td>${p.material || ''}</td>` +
          `<td><span style='color:${p.color}'>■</span>${p.colorName || ''}</td>` +
          `<td>${p.name || ''}</td><td>${p.reelSubName || ''}</td>`;
        tr.addEventListener('click', () => {
          tableBody.querySelector('tr.selected')?.classList.remove('selected');
          tr.classList.add('selected');
          selectedPreset = p;
          okBtn.disabled = false;
          if (!p) { stockEl.textContent = ''; return; }
          const inv = getInventoryItem(p.presetId);
          stockEl.textContent = inv ? `在庫: ${inv.quantity}` : '';
          preview.setState({
            filamentDiameter: p.filamentDiameter ?? p.diameter,
            filamentTotalLength: p.filamentTotalLength ?? p.defaultLength,
            filamentCurrentLength: p.filamentCurrentLength ?? (p.filamentTotalLength ?? p.defaultLength),
            filamentColor: p.color,
            reelOuterDiameter: p.reelOuterDiameter, reelThickness: p.reelThickness,
            reelWindingInnerDiameter: p.reelWindingInnerDiameter,
            reelCenterHoleDiameter: p.reelCenterHoleDiameter,
            reelName: p.name || '', reelSubName: p.reelSubName || '',
            materialName: p.material, materialColorName: p.colorName,
            materialColorCode: p.color, manufacturerName: p.brand
          });
        });
        tableBody.appendChild(tr);
      });
    }

    fillOptions(presets);
    renderTable();
    document.body.appendChild(overlay);
    searchForm.addEventListener('submit', ev => { ev.preventDefault(); renderTable(); });

    dlg.querySelector('#fc-cancel').addEventListener('click', () => {
      overlay.remove(); resolve(false);
    });
    dlg.querySelector('#fc-ok').addEventListener('click', () => {
      if (!selectedPreset) { overlay.remove(); resolve(false); return; }
      const sp = addSpoolFromPreset(selectedPreset);
      // 機器装着しない（setCurrentSpoolId を呼ばない）
      overlay.remove();
      resolve({ spool: sp, isNew: true });
    });
  });
}

/**
 * 印刷履歴用フィラメント指定/修正ダイアログ。
 * 機器への装着（setCurrentSpoolId）は行わず、選択されたスプール情報を返す。
 *
 * @function showHistoryFilamentDialog
 * @param {Object} opts
 * @param {string} opts.hostname         - ホスト名
 * @param {number} opts.materialUsedMm   - この印刷で使用したフィラメント量(mm)
 * @param {string|null} opts.currentSpoolId - 現在指定中のスプールID（修正モード）
 * @param {string} opts.jobId            - ジョブID
 * @returns {Promise<{spool:Object, isNew:boolean}|false>}
 */
export function showHistoryFilamentDialog({ hostname, materialUsedMm = 0, currentSpoolId = null, jobId = "" }) {
  injectStyles();
  if (filamentChangeDialogOpen) return Promise.resolve(false);
  filamentChangeDialogOpen = true;

  const isEdit = !!currentSpoolId;
  const currentSpool = isEdit ? getSpoolById(currentSpoolId) : null;

  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "fc-overlay";
    const dlg = document.createElement("div");
    dlg.className = "fc-dialog";
    overlay.appendChild(dlg);

    /* 現在の指定情報（修正モード時） */
    let currentInfoHtml = "";
    if (isEdit && currentSpool) {
      const cColor = currentSpool.filamentColor || currentSpool.color || "#000";
      const cName = currentSpool.name || currentSpool.reelName || "(不明)";
      const cMat = currentSpool.material || currentSpool.materialName || "";
      const cRemain = currentSpool.remainingLengthMm ?? 0;
      currentInfoHtml = `
        <fieldset class="fc-search-field" style="margin-bottom:6px;background:#fef3c7;">
          <legend>現在の指定</legend>
          <div style="display:flex;align-items:center;gap:8px;font-size:13px;">
            <span style="color:${cColor};font-size:18px;">■</span>
            <span><b>${cName}</b> ${cMat}</span>
            <span>残: ${Math.round(cRemain).toLocaleString()} mm</span>
            <span>使用量: ${Math.round(materialUsedMm).toLocaleString()} mm</span>
          </div>
        </fieldset>
      `;
    }

    dlg.innerHTML = `
      <div class="fc-header">${isEdit ? "フィラメント修正" : "フィラメント指定"}</div>
      <div class="fc-body">
        ${currentInfoHtml}
        <fieldset class="fc-search-field">
          <legend>検索</legend>
          <form id="fc-search" class="fc-search">
            <select id="fc-brand"></select>
            <select id="fc-material"></select>
            <select id="fc-color"></select>
            <input id="fc-name" placeholder="名称">
            <button id="fc-search-btn">検索</button>
          </form>
        </fieldset>
        <div class="registered-container">
          <div class="registered-preview">
            <div id="fc-preview"></div>
            <div id="fc-stock" class="fc-stock"></div>
          </div>
          <div class="registered-list">
            <table class="registered-table">
              <thead>
                <tr><th>ブランド</th><th>材質</th><th>色名</th><th>名称</th><th>サブ名称</th></tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="fc-buttons">
        <button id="fc-cancel">キャンセル</button>
        <button id="fc-used">過去取り外したスプールから選択</button>
        <button id="fc-new">新品を開封</button>
        <button id="fc-ok" disabled>このフィラメントを選択</button>
      </div>
    `;

    const brandSel = dlg.querySelector("#fc-brand");
    const matSel = dlg.querySelector("#fc-material");
    const colorSel = dlg.querySelector("#fc-color");
    const nameIn = dlg.querySelector("#fc-name");
    const searchForm = dlg.querySelector("#fc-search");
    const tableBody = dlg.querySelector(".registered-table tbody");
    const prevEl = dlg.querySelector("#fc-preview");
    const stockEl = dlg.querySelector("#fc-stock");
    const okBtn = dlg.querySelector("#fc-ok");

    const dialogPreview = createFilamentPreview(prevEl, {
      filamentDiameter: 1.75, filamentTotalLength: 336000,
      filamentCurrentLength: 336000, filamentColor: "#22C55E",
      reelOuterDiameter: 200, reelThickness: 68,
      reelWindingInnerDiameter: 95, reelCenterHoleDiameter: 54,
      widthPx: 120, heightPx: 120, showSlider: false,
      isFilamentPresent: true, showUsedUpIndicator: true,
      disableInteraction: true, showOverlayLength: true,
      showOverlayPercent: true, showOverlayBar: true,
      showReelName: true, showReelSubName: true,
      showMaterialName: true, showMaterialColorName: true,
      showMaterialColorCode: true, showManufacturerName: true,
      showPurchaseButton: true,
      reelName: "", reelSubName: "", materialName: "",
      materialColorName: "", materialColorCode: "", manufacturerName: ""
    });

    const spools = getSpools();
    let selectedSpool = null;
    let showRemovedOnly = false;

    function fillOptions(list) {
      const brands = new Set(), mats = new Set(), colors = new Set();
      list.forEach(sp => {
        if (sp.manufacturerName) brands.add(sp.manufacturerName);
        else if (sp.brand) brands.add(sp.brand);
        if (sp.materialName) mats.add(sp.materialName);
        else if (sp.material) mats.add(sp.material);
        if (sp.colorName) colors.add(sp.colorName);
      });
      brandSel.innerHTML = '<option value="">ブランド</option>';
      [...brands].forEach(b => { const o = document.createElement('option'); o.value = b; o.textContent = b; brandSel.appendChild(o); });
      matSel.innerHTML = '<option value="">材質</option>';
      [...mats].forEach(m => { const o = document.createElement('option'); o.value = m; o.textContent = m; matSel.appendChild(o); });
      colorSel.innerHTML = '<option value="">色名</option>';
      [...colors].forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; colorSel.appendChild(o); });
    }

    function applyFilter(list) {
      return list.filter(sp => {
        if (brandSel.value) {
          const b = sp.manufacturerName || sp.brand || '';
          if (b !== brandSel.value) return false;
        }
        if (matSel.value) {
          const m = sp.materialName || sp.material || '';
          if (m !== matSel.value) return false;
        }
        if (colorSel.value && sp.colorName !== colorSel.value) return false;
        if (nameIn.value) {
          const n = `${sp.name || ''}${sp.reelName || ''}${sp.reelSubName || ''}`;
          if (!n.includes(nameIn.value)) return false;
        }
        return true;
      });
    }

    function updateInfo(sp) {
      if (!sp) { stockEl.textContent = ''; return; }
      const inv = sp.presetId ? getInventoryItem(sp.presetId) : null;
      stockEl.textContent = inv ? `在庫: ${inv.quantity}` : '';
      updatePreview(sp, dialogPreview);
    }

    function renderTable() {
      let list = applyFilter(spools);
      if (showRemovedOnly) list = list.filter(sp => sp.removedAt);
      tableBody.innerHTML = '';
      list.forEach(sp => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${sp.manufacturerName || sp.brand || ''}</td>` +
          `<td>${sp.materialName || sp.material || ''}</td>` +
          `<td><span style='color:${sp.filamentColor || sp.color || '#000'}'>■</span>${sp.colorName || ''}</td>` +
          `<td>${sp.name || sp.reelName || ''}</td>` +
          `<td>${sp.reelSubName || ''}</td>`;
        tr.addEventListener('click', () => {
          tableBody.querySelector('tr.selected')?.classList.remove('selected');
          tr.classList.add('selected');
          selectedSpool = sp;
          okBtn.disabled = false;
          updateInfo(sp);
        });
        tableBody.appendChild(tr);
      });
    }

    fillOptions(spools);
    renderTable();
    if (selectedSpool) updateInfo(selectedSpool);
    document.body.appendChild(overlay);
    searchForm.addEventListener('submit', ev => { ev.preventDefault(); renderTable(); });

    const closeDialog = result => {
      overlay.remove();
      filamentChangeDialogOpen = false;
      resolve(result);
    };

    dlg.querySelector("#fc-cancel").addEventListener("click", () => closeDialog(false));

    dlg.querySelector("#fc-ok").addEventListener("click", () => {
      if (!selectedSpool) return;
      // 機器装着しない（setCurrentSpoolId を呼ばない）
      closeDialog({ spool: selectedSpool, isNew: false });
    });

    // 取り外し済みスプールの表示切替（ダイアログ内フィルタ）
    const usedBtn = dlg.querySelector("#fc-used");
    usedBtn.addEventListener("click", () => {
      showRemovedOnly = !showRemovedOnly;
      usedBtn.textContent = showRemovedOnly ? "全スプールを表示" : "過去取り外したスプールから選択";
      selectedSpool = null;
      okBtn.disabled = true;
      renderTable();
    });

    dlg.querySelector("#fc-new").addEventListener("click", async () => {
      closeDialog(await showPresetOpenDialogForHistory(hostname));
    });
  });
}

// ボタンと紐付け
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("filament-change-btn")?.addEventListener("click", () => {
    showFilamentChangeDialog();
  });
});
