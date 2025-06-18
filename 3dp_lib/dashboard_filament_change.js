/**
 * @fileoverview
 * 3Dプリンタ監視ツール 3dpmon 用 フィラメント交換ダイアログ モジュール
 * dashboard_filament_change.js
 * (c) pumpCurry 2025
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
 * @version 1.390.243 (PR #109)
 * @since   1.390.230 (PR #104)
*/
"use strict";

import { getSpools, setCurrentSpoolId } from "./dashboard_spool.js";
import { consumeInventory, getInventoryItem } from "./dashboard_filament_inventory.js";
import { monitorData } from "./dashboard_data.js";

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
  .fc-dialog{background:#fff;border-radius:8px;width:90%;max-width:320px;box-shadow:0 2px 12px rgba(0,0,0,0.4);display:flex;flex-direction:column;}
  .fc-header{font-weight:bold;font-size:1.2em;padding:8px;border-bottom:1px solid #ddd;}
  .fc-body{padding:8px;}
  .fc-buttons{display:flex;justify-content:flex-end;padding:8px;border-top:1px solid #ddd;gap:8px;}
  .fc-buttons button{padding:6px 12px;font-size:14px;}
  .fc-carousel{display:flex;overflow-x:auto;gap:6px;margin-bottom:8px;}
  .fc-item{flex:0 0 auto;padding:4px 8px;border:1px solid #ddd;border-radius:4px;cursor:pointer;background:#f4f4f5;font-size:12px;}
  .fc-dropdown{width:100%;box-sizing:border-box;font-size:14px;margin-bottom:8px;}
  .fc-preview{font-size:12px;margin-top:4px;}
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
function updatePreview(sp) {
  const fp = window.filamentPreview;
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
        <div id="fc-fav" class="fc-carousel"></div>
        <div id="fc-recent" class="fc-carousel"></div>
        <select id="fc-manufacturer" class="fc-dropdown"></select>
        <select id="fc-filament" class="fc-dropdown"></select>
        <div id="fc-preview" class="fc-preview"></div>
      </div>
      <div class="fc-buttons">
        <button id="fc-cancel">キャンセル</button>
        <button id="fc-ok">このフィラメントに決定</button>
      </div>
    `;

    const favEl = dlg.querySelector("#fc-fav");
    const recentEl = dlg.querySelector("#fc-recent");
    const manuSel = dlg.querySelector("#fc-manufacturer");
    const filSel = dlg.querySelector("#fc-filament");
    const prevEl = dlg.querySelector("#fc-preview");

    const spools = getSpools();
    let selectedSpool = spools.find(s => s.isActive) || spools[0] || null;

    function renderManufacturerOptions() {
      const makers = [...new Set(spools.map(sp => sp.manufacturerName || sp.brand))];
      manuSel.innerHTML = '<option value="">メーカー選択</option>';
      makers.forEach(m => {
        const o = document.createElement('option');
        o.value = m;
        o.textContent = m || '(不明)';
        manuSel.appendChild(o);
      });
      if (selectedSpool) {
        manuSel.value = selectedSpool.manufacturerName || selectedSpool.brand;
      }
    }

    function renderFilamentOptions() {
      const maker = manuSel.value;
      filSel.innerHTML = '';
      spools.filter(sp => !maker || (sp.manufacturerName || sp.brand) === maker)
        .forEach(sp => {
          const o = document.createElement('option');
          o.value = sp.id;
          o.textContent = sp.name;
          filSel.appendChild(o);
        });
      if (selectedSpool) filSel.value = selectedSpool.id;
    }

    function updateInfo(sp) {
      if (!sp) { prevEl.textContent = ''; return; }
      const inv = sp.presetId ? getInventoryItem(sp.presetId) : null;
      prevEl.textContent = inv ? `在庫: ${inv.quantity}` : '在庫: -';
      updatePreview(sp);
    }

    function setupCarousel(list, container) {
      container.innerHTML = '';
      list.forEach(sp => {
        const d = document.createElement('div');
        d.className = 'fc-item';
        d.textContent = sp.name;
        d.dataset.id = sp.id;
        container.appendChild(d);
      });
    }

    const favList = spools.filter(sp => sp.isFavorite);
    const recentIds = [];
    monitorData.usageHistory.slice(-16).reverse().forEach(u => {
      if (!recentIds.includes(u.spoolId)) recentIds.push(u.spoolId);
    });
    const recentList = recentIds.map(id => spools.find(s => s.id === id)).filter(Boolean);

    setupCarousel(favList, favEl);
    setupCarousel(recentList, recentEl);

    favEl.addEventListener('click', e => {
      const id = e.target.dataset.id;
      if (!id) return;
      selectedSpool = spools.find(s => s.id === id);
      renderManufacturerOptions();
      renderFilamentOptions();
      updateInfo(selectedSpool);
    });
    recentEl.addEventListener('click', e => {
      const id = e.target.dataset.id;
      if (!id) return;
      selectedSpool = spools.find(s => s.id === id);
      renderManufacturerOptions();
      renderFilamentOptions();
      updateInfo(selectedSpool);
    });

    manuSel.addEventListener('change', () => {
      renderFilamentOptions();
      selectedSpool = spools.find(s => s.id === filSel.value) || null;
      updateInfo(selectedSpool);
    });

    filSel.addEventListener('change', () => {
      selectedSpool = spools.find(s => s.id === filSel.value) || null;
      updateInfo(selectedSpool);
    });

    renderManufacturerOptions();
    renderFilamentOptions();
    if (selectedSpool) updateInfo(selectedSpool);

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
