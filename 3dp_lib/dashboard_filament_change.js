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
 * @version 1.390.239 (PR #105)
 * @since   1.390.230 (PR #104)
*/
"use strict";

import { getSpools, setCurrentSpoolId } from "./dashboard_spool.js";
import { consumeInventory } from "./dashboard_filament_inventory.js";

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
        <select id="fc-select" style="width:100%;box-sizing:border-box;font-size:14px;"></select>
      </div>
      <div class="fc-buttons">
        <button id="fc-cancel">キャンセル</button>
        <button id="fc-ok">決定</button>
      </div>
    `;

    const sel = dlg.querySelector("#fc-select");
    const spools = getSpools();
    spools.forEach(sp => {
      const opt = document.createElement("option");
      opt.value = sp.id;
      opt.textContent = `${sp.name} (${sp.remainingLengthMm}/${sp.totalLengthMm} mm)`;
      if (sp.isActive) opt.selected = true;
      sel.appendChild(opt);
    });

    document.body.appendChild(overlay);

    dlg.querySelector("#fc-cancel").addEventListener("click", () => {
      overlay.remove();
      resolve(false);
    });

    dlg.querySelector("#fc-ok").addEventListener("click", () => {
      const id = sel.value;
      const spool = spools.find(s => s.id === id);
      if (spool) {
        setCurrentSpoolId(id);
        if (spool.presetId) consumeInventory(spool.presetId, 1);
        updatePreview(spool);
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
