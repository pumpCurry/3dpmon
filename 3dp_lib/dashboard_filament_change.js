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
 * @version 1.390.317 (PR #143)
 * @since   1.390.230 (PR #104)
 * @lastModified 2025-06-19 22:38:18
 * -----------------------------------------------------------
 * @todo
 * - none
 */
"use strict";

import { getSpools, setCurrentSpoolId } from "./dashboard_spool.js";
import { consumeInventory, getInventoryItem } from "./dashboard_filament_inventory.js";
import { monitorData } from "./dashboard_data.js";
import { createFilamentPreview } from "./dashboard_filament_view.js";

let styleInjected = false;

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
function updatePreview(sp, preview = window.filamentPreview) {
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
  if (typeof sp.remainingLengthMm === "number") fp.setRemainingLength(sp.remainingLengthMm);
}

/**
 * フィラメント交換ダイアログを表示する。
 *
 * @function showFilamentChangeDialog
 * @returns {Promise<boolean>} true:交換実行 / false:キャンセル
 */
export function showFilamentChangeDialog() {
  injectStyles();
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

    dlg.querySelector("#fc-cancel").addEventListener("click", () => {
      overlay.remove();
      resolve(false);
    });

    dlg.querySelector("#fc-ok").addEventListener("click", () => {
      if (selectedSpool) {
        setCurrentSpoolId(selectedSpool.id);
        if (selectedSpool.presetId) consumeInventory(selectedSpool.presetId, 1);
        updatePreview(selectedSpool);
      }
      overlay.remove();
      resolve(true);
    });
  });
}

// ボタンと紐付け
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("filament-change-btn")?.addEventListener("click", () => {
    showFilamentChangeDialog();
  });
});
