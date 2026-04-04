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

import { getSpools, getSpoolById, setCurrentSpoolId, getCurrentSpoolId, getCurrentSpool, addSpoolFromPreset, formatSpoolDisplayId, getSpoolState, getSpoolStateLabel, formatFilamentAmount } from "./dashboard_spool.js";
import { consumeInventory, getInventoryItem } from "./dashboard_filament_inventory.js";
import { monitorData } from "./dashboard_data.js";
import { getAllPresets } from "./dashboard_filament_presets.js";
import { createFilamentPreview } from "./dashboard_filament_view.js";
import { showFilamentManager } from "./dashboard_filament_manager.js";
import { showAlert } from "./dashboard_notification_manager.js";

let styleInjected = false;
let filamentChangeDialogOpen = false;

/**
 * 交換ダイアログのデフォルトタブを設定値から決定する。
 * - "preset": 常に新品タブ
 * - "remember": 前回使ったタブを復元
 * - "auto" (デフォルト): 装着中スプールの残量%が閾値以下なら新品、それ以外は保管中
 *
 * @private
 * @param {string} hostname - 対象ホスト名
 * @returns {string} "stored" | "preset" | "favorite"
 */
function _resolveDefaultTab(hostname) {
  const setting = monitorData.appSettings.filamentChangeDefaultTab || "auto";
  if (setting === "preset") return "preset";
  if (setting === "remember") {
    try {
      const last = localStorage.getItem("3dpmon_fc_last_tab");
      if (last && ["stored", "preset", "favorite"].includes(last)) return last;
    } catch { /* ignore */ }
    return "preset"; // 記憶なし → 新品
  }
  // auto: 残量%で判定
  const threshold = monitorData.appSettings.filamentChangeAutoThreshold ?? 25;
  const spool = getCurrentSpool(hostname);
  if (!spool) return "preset"; // 未装着 → 新品
  const pct = spool.totalLengthMm > 0
    ? (spool.remainingLengthMm / spool.totalLengthMm) * 100
    : 0;
  return pct <= threshold ? "preset" : "stored";
}

/**
 * ダイアログ用CSSを一度だけ注入する。
 *
 * @private
 * @returns {void}
 */
function injectStyles() {
  // CSS は 3dp_panel.css に移行済み（Phase 1-C）
  // この関数は後方互換性のために残す
}

/**
 * フィラメントプレビューに選択スプールの情報を反映する。
 *
 * @private
 * @param {Object} sp - スプールデータ
 * @returns {void}
 */
export function updatePreview(sp, preview = null) {
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

    const presetMachineObj = monitorData.machines[hostname] || {};
    const presetDisplayHost = presetMachineObj.storedData?.hostname?.rawValue
                           || presetMachineObj.storedData?.model?.rawValue || hostname || "";
    dlg.innerHTML = `
      <div class="fc-header">新品フィラメント選択 <span class="fc-header-host">${presetDisplayHost}</span></div>
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
            <div id="fc-preview" style="width:120px;height:120px;position:relative;"></div>
            <div id="fc-stock" class="fc-stock"></div>
          </div>
          <div class="registered-list" style="max-height:50vh;overflow-y:auto">
            <table class="registered-table fixed-header sortable-table">
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

    const presets = getAllPresets();
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
      if (!setCurrentSpoolId(sp.id, hostname)) {
        showAlert("このスプールは既に別のプリンタに装着されています", "warn");
        overlay.remove();
        resolve(false);
        return;
      }
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
   try {
    const overlay = document.createElement("div");
    overlay.className = "fc-overlay";
    const dlg = document.createElement("div");
    dlg.className = "fc-dialog";
    overlay.appendChild(dlg);

    // 対象プリンタの表示名を取得
    const machineObj = monitorData.machines[hostname] || {};
    const displayHost = machineObj.storedData?.hostname?.rawValue
                     || machineObj.storedData?.model?.rawValue || hostname || "";
    // 現在装着中スプール情報バー
    const curSpool = getCurrentSpool(hostname);
    let currentBar = "";
    if (curSpool) {
      const curPct = curSpool.totalLengthMm > 0
        ? Math.round((curSpool.remainingLengthMm / curSpool.totalLengthMm) * 100) : 0;
      currentBar = `
        <div class="fc-current-bar">
          <span class="fc-color-swatch-lg" style="color:${curSpool.filamentColor || '#000'}">■</span>
          <span><b>${formatSpoolDisplayId(curSpool)}</b> ${curSpool.name || ""}</span>
          <span class="fc-material-label">${curSpool.materialName || curSpool.material || ""}</span>
          <span class="fc-pct-mounted">${curPct}%</span>
          <span class="flex-1"></span>
          <button id="fc-remove" class="btn-font-xs">取り外す</button>
        </div>`;
    } else {
      currentBar = `<div class="fc-current-bar-empty">スプール未装着</div>`;
    }

    // ★ デフォルトタブ: テンプレートリテラルの前に決定する必要がある
    const activeTab_initial = _resolveDefaultTab(hostname);

    dlg.innerHTML = `
      <div class="fc-header">フィラメント交換 <span class="fc-header-host">${displayHost}</span></div>
      <div class="fc-body">
        ${currentBar}
        <div class="fc-tab-row">
          <button class="fc-tab-btn${activeTab_initial === "stored" ? " active" : ""}" data-tab="stored">📦 保管中スプール</button>
          <button class="fc-tab-btn${activeTab_initial === "preset" ? " active" : ""}" data-tab="preset">🆕 新品を開封</button>
          <button class="fc-tab-btn${activeTab_initial === "favorite" ? " active" : ""}" data-tab="favorite">⭐ お気に入り</button>
        </div>
        <fieldset class="fc-search-field" style="margin-bottom:4px">
          <form id="fc-search" class="fc-search">
            <select id="fc-brand"></select>
            <select id="fc-material"></select>
            <select id="fc-color"></select>
            <input id="fc-name" placeholder="名称">
            <button id="fc-search-btn">🔍</button>
          </form>
        </fieldset>
        <div style="display:flex;gap:8px;flex:1;min-height:0">
          <div class="registered-list" style="flex:1;overflow-y:auto;min-width:0">
            <table class="registered-table fixed-header sortable-table">
              <thead>
                <tr id="fc-thead-row"></tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
          <div id="fc-preview-panel" style="flex-shrink:0;width:160px;display:flex;flex-direction:column;align-items:center;gap:4px;">
            <div id="fc-preview" style="width:150px;height:150px;position:relative;"></div>
            <div id="fc-preview-info" class="fc-preview-info"></div>
          </div>
        </div>
      </div>
      <div class="fc-buttons">
        <button id="fc-cancel">キャンセル</button>
        <button id="fc-ok" disabled>このフィラメントに交換</button>
      </div>
    `;

    const brandSel = dlg.querySelector("#fc-brand");
    const matSel = dlg.querySelector("#fc-material");
    const colorSel = dlg.querySelector("#fc-color");
    const nameIn = dlg.querySelector("#fc-name");
    const searchForm = dlg.querySelector("#fc-search");
    const tableBody = dlg.querySelector(".registered-table tbody");
    const okBtn = dlg.querySelector("#fc-ok");
    const previewEl = dlg.querySelector("#fc-preview");
    const previewInfoEl = dlg.querySelector("#fc-preview-info");

    // プレビュー生成
    let dialogPreview = null;
    try {
      dialogPreview = createFilamentPreview(previewEl, {
        filamentDiameter: 1.75,
        filamentTotalLength: 336000,
        filamentCurrentLength: 336000,
        filamentColor: "#22C55E",
        reelOuterDiameter: 200,
        reelThickness: 68,
        reelWindingInnerDiameter: 95,
        reelCenterHoleDiameter: 54,
        widthPx: 150, heightPx: 150,
        showSlider: false,
        isFilamentPresent: false,
        showUsedUpIndicator: true,
        showInfoLength: false, showInfoPercent: false, showInfoLayers: false,
        showResetButton: false,
        showProfileViewButton: false, showSideViewButton: false,
        showFrontViewButton: false, showAutoRotateButton: true,
        enableDrag: true, enableClick: false,
        disableInteraction: true,
        showOverlayLength: false, showOverlayPercent: true,
        showOverlayBar: true,
        showReelName: true, showReelSubName: false,
        showMaterialName: false, showMaterialColorName: false,
        showMaterialColorCode: false, showManufacturerName: true,
        showPurchaseButton: false
      });
    } catch (e) {
      console.warn("[fc] preview生成エラー:", e);
    }

    /** 選択したスプール/プリセットのプレビューを更新 */
    function updatePreviewPanel(sp) {
      if (!dialogPreview) return;
      if (sp) {
        const opts = {
          isFilamentPresent: true,
          filamentCurrentLength: sp.remainingLengthMm ?? sp.filamentCurrentLength ?? sp.defaultLength ?? 336000,
          filamentTotalLength: sp.totalLengthMm ?? sp.filamentTotalLength ?? sp.defaultLength ?? 336000,
          filamentColor: sp.filamentColor || sp.color || "#22C55E",
          reelOuterDiameter: sp.reelOuterDiameter || 200,
          reelThickness: sp.reelThickness || 68,
          reelWindingInnerDiameter: sp.reelWindingInnerDiameter || 95,
          reelCenterHoleDiameter: sp.reelCenterHoleDiameter || 54,
          reelName: sp.name || sp.colorName || "",
          manufacturerName: sp.manufacturerName || sp.brand || ""
        };
        if (sp.reelBodyColor) opts.reelBodyColor = sp.reelBodyColor;
        if (sp.reelFlangeTransparency != null) opts.reelFlangeTransparency = sp.reelFlangeTransparency;
        dialogPreview.setState(opts);
        // 情報テキスト
        const mat = sp.materialName || sp.material || "";
        const color = sp.colorName || "";
        previewInfoEl.textContent = `${mat} ${color}`;
      } else {
        dialogPreview.setState({ isFilamentPresent: false, reelName: "", manufacturerName: "" });
        previewInfoEl.textContent = "";
      }
    }

    const spools = getSpools();
    const presets = getAllPresets();
    const curId = hostname ? getCurrentSpoolId(hostname) : null;
    let selectedSpool = null;
    let selectedPreset = null;
    let activeTab = activeTab_initial;
    const theadRow = dlg.querySelector("#fc-thead-row");
    // タブごとの選択状態を保持
    const tabSelections = { stored: null, preset: null, favorite: null };

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


    function renderTable() {
      tableBody.innerHTML = '';
      // タブの以前の選択をリストア
      const prevSel = tabSelections[activeTab];
      selectedSpool = (activeTab !== "preset" && prevSel) ? prevSel : null;
      selectedPreset = (activeTab === "preset" && prevSel) ? prevSel : null;
      okBtn.disabled = !prevSel;

      if (activeTab === "stored" || activeTab === "favorite") {
        // スプール一覧表示
        theadRow.innerHTML = "<th>フィラメント</th><th>素材</th><th style='text-align:right'>残量</th><th>状態</th>";
        let list = applyFilter(spools);
        if (activeTab === "stored") {
          // 保管中 (取り外し済み + 在庫) — 装着中は除外 (現在の機器以外)
          list = list.filter(sp => !sp.hostname || sp.hostname === hostname);
        } else {
          // お気に入り
          list = list.filter(sp => sp.isFavorite);
        }
        list.forEach(sp => {
          const tr = document.createElement('tr');
          const pct = sp.totalLengthMm > 0
            ? Math.round((sp.remainingLengthMm / sp.totalLengthMm) * 100) : 0;
          const fmtRemain = formatFilamentAmount(sp.remainingLengthMm, sp);
          const mountedOn = sp.hostname || null;
          const isCurrent = mountedOn && mountedOn === hostname;
          const isOtherHost = mountedOn && mountedOn !== hostname;
          let stateLabel = "";
          if (isCurrent) stateLabel = `<span class="fc-state-mounted">◀ 装着中</span>`;
          else if (isOtherHost) {
            const otherName = monitorData.machines[mountedOn]?.storedData?.hostname?.rawValue || mountedOn;
            stateLabel = `<span class="fc-state-other">${otherName}</span>`;
          }
          tr.innerHTML =
            `<td><span class="fc-color-swatch" style="color:${sp.filamentColor || sp.color || '#000'}">■</span> <b>${formatSpoolDisplayId(sp)}</b> ${sp.name || ""}<div class="fc-cell-sub">${sp.manufacturerName || sp.brand || ""}</div></td>` +
            `<td>${sp.materialName || sp.material || ""}</td>` +
            `<td class="fc-cell-right"><div>${pct}%</div><div class="fc-cell-sub">${fmtRemain.display}</div></td>` +
            `<td>${stateLabel}</td>`;
          if (isCurrent) tr.classList.add("fc-row-current");
          if (isOtherHost) tr.classList.add("fc-row-other");
          // タブ切替時の選択リストア
          if (prevSel && prevSel.id === sp.id) tr.classList.add('selected');
          tr.style.cursor = isOtherHost ? 'not-allowed' : 'pointer';
          tr.addEventListener('click', () => {
            if (isOtherHost) { showAlert("このスプールは別のプリンタに装着中です", "warn"); return; }
            tableBody.querySelector('tr.selected')?.classList.remove('selected');
            tr.classList.add('selected');
            selectedSpool = sp;
            selectedPreset = null;
            tabSelections[activeTab] = sp;
            okBtn.disabled = false;
            updatePreviewPanel(sp);
          });
          tableBody.appendChild(tr);
        });
      } else {
        // プリセット一覧 (新品開封)
        theadRow.innerHTML = "<th>フィラメント</th><th>素材</th><th style='text-align:right'>残量</th><th></th>";
        let list = presets;
        // 検索フィルタ適用
        list = list.filter(p => {
          if (brandSel.value && (p.brand || '') !== brandSel.value) return false;
          if (matSel.value && (p.material || '') !== matSel.value) return false;
          if (colorSel.value && (p.colorName || '') !== colorSel.value) return false;
          if (nameIn.value) {
            const n = `${p.name || ''}${p.brand || ''}${p.colorName || ''}`;
            if (!n.toLowerCase().includes(nameIn.value.toLowerCase())) return false;
          }
          return true;
        });
        list.forEach(p => {
          const tr = document.createElement('tr');
          const lengthM = ((p.filamentTotalLength || p.defaultLength || 0) / 1000).toFixed(0);
          tr.innerHTML =
            `<td><span class="fc-color-swatch" style="color:${p.color || '#000'}">■</span> <b>${p.colorName || ""}</b> ${p.name || ""}<div class="fc-cell-sub">${p.brand || ""}</div></td>` +
            `<td>${p.material || ""}</td>` +
            `<td class="fc-cell-right">${lengthM}m</td>` +
            `<td><span class="fc-state-new">🆕 新品</span></td>`;
          tr.style.cursor = 'pointer';
          if (prevSel && prevSel.presetId === p.presetId) tr.classList.add('selected');
          tr.addEventListener('click', () => {
            tableBody.querySelector('tr.selected')?.classList.remove('selected');
            tr.classList.add('selected');
            selectedPreset = p;
            selectedSpool = null;
            tabSelections[activeTab] = p;
            okBtn.disabled = false;
            updatePreviewPanel(p);
          });
          tableBody.appendChild(tr);
        });
      }
    }

    // タブ切替
    dlg.querySelectorAll(".fc-tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        dlg.querySelectorAll(".fc-tab-btn").forEach(b => {
          b.classList.remove("active");
        });
        btn.classList.add("active");
        activeTab = btn.dataset.tab;
        // ★ タブ記憶（"remember" モード用）
        try { localStorage.setItem("3dpmon_fc_last_tab", activeTab); } catch {}
        // タブ切替時に検索フィルタのオプションを再構築
        if (activeTab === "preset") {
          fillOptions(presets.map(p => ({
            manufacturerName: p.brand, brand: p.brand,
            materialName: p.material, material: p.material,
            colorName: p.colorName
          })));
        } else {
          fillOptions(spools);
        }
        renderTable();
      });
    });

    // ソート状態
    let sortCol = null; // 0=フィラメント, 1=素材, 2=残量, 3=状態
    let sortAsc = true;

    /** テーブル行をソートする */
    function sortRows() {
      if (sortCol === null) return;
      const rows = [...tableBody.querySelectorAll("tr")];
      rows.sort((a, b) => {
        const aCell = a.cells[sortCol]?.textContent?.trim() || "";
        const bCell = b.cells[sortCol]?.textContent?.trim() || "";
        // 残量列は数値ソート
        if (sortCol === 2) {
          const aNum = parseFloat(aCell) || 0;
          const bNum = parseFloat(bCell) || 0;
          return sortAsc ? aNum - bNum : bNum - aNum;
        }
        return sortAsc ? aCell.localeCompare(bCell) : bCell.localeCompare(aCell);
      });
      rows.forEach(r => tableBody.appendChild(r));
    }

    // ヘッダークリックでソート
    theadRow.addEventListener("click", (ev) => {
      const th = ev.target.closest("th");
      if (!th) return;
      const idx = [...theadRow.children].indexOf(th);
      if (idx < 0) return;
      if (sortCol === idx) { sortAsc = !sortAsc; }
      else { sortCol = idx; sortAsc = true; }
      // インジケータ更新
      theadRow.querySelectorAll("th").forEach((h, i) => {
        h.textContent = h.textContent.replace(/ [▲▼]$/, "");
        if (i === sortCol) h.textContent += sortAsc ? " ▲" : " ▼";
      });
      sortRows();
    });

    fillOptions(spools);
    renderTable();

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
      let mountSpool = selectedSpool;
      // 新品開封の場合はプリセットからスプールを作成
      if (!mountSpool && selectedPreset) {
        mountSpool = addSpoolFromPreset(selectedPreset);
        if (!mountSpool) {
          showAlert("スプールの作成に失敗しました", "error");
          return;
        }
      }
      if (mountSpool) {
        if (!setCurrentSpoolId(mountSpool.id, hostname)) {
          showAlert("このスプールは既に別のプリンタに装着されています", "warn");
          return;
        }
        // フィラメントパネルのプレビューを即時反映
        const hostPreview = window._filamentPreviews?.get(hostname);
        if (hostPreview) {
          const updatedSpool = getSpoolById(mountSpool.id) || mountSpool;
          hostPreview.setState({
            isFilamentPresent: true,
            filamentCurrentLength: updatedSpool.remainingLengthMm || 0,
            filamentTotalLength: updatedSpool.totalLengthMm || 330000,
            filamentColor: updatedSpool.filamentColor || updatedSpool.color || "#22C55E",
            reelName: updatedSpool.name || "",
            reelSubName: updatedSpool.reelSubName || "",
            materialName: updatedSpool.materialName || updatedSpool.material || "",
            materialColorName: updatedSpool.colorName || "",
            materialColorCode: updatedSpool.filamentColor || "",
            manufacturerName: updatedSpool.manufacturerName || updatedSpool.brand || ""
          });
        }
        showAlert(`${formatSpoolDisplayId(mountSpool)} を ${displayHost} に装着しました`, "success");
      }
      closeDialog(true);
    });

    // 取り外しボタン (現在装着中バー内)
    const removeBtn = dlg.querySelector("#fc-remove");
    if (removeBtn) {
      removeBtn.addEventListener("click", () => {
        setCurrentSpoolId(null, hostname);
        const hostPreview = window._filamentPreviews?.get(hostname);
        if (hostPreview) {
          hostPreview.setState({
            isFilamentPresent: false, filamentCurrentLength: 330000,
            reelName: "", reelSubName: "", materialName: "",
            materialColorName: "", materialColorCode: "", manufacturerName: ""
          });
        }
        showAlert(`${displayHost} からスプールを取り外しました`, "info");
        closeDialog(true);
      });
    }
   } catch (e) {
    console.error("[showFilamentChangeDialog] ダイアログ生成エラー:", e);
    filamentChangeDialogOpen = false;
    resolve(false);
   }
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
            <div id="fc-preview" style="width:120px;height:120px;position:relative;"></div>
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

    const presets = getAllPresets();
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
      const cDispId = formatSpoolDisplayId(currentSpool);
      currentInfoHtml = `
        <fieldset class="fc-search-field fc-search-field-highlight">
          <legend>現在の指定</legend>
          <div class="fc-current-bar">
            <span class="fc-color-swatch-lg" style="color:${cColor}">■</span>
            <span><b>${cDispId} ${cName}</b> ${cMat}</span>
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
            <div id="fc-preview" style="width:120px;height:120px;position:relative;"></div>
            <div id="fc-stock" class="fc-stock"></div>
          </div>
          <div class="registered-list" style="max-height:50vh;overflow-y:auto">
            <table class="registered-table fixed-header sortable-table">
              <thead>
                <tr><th>#</th><th>ブランド</th><th>材質</th><th>色名</th><th>名称</th><th style="text-align:right">残量</th></tr>
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
        const pct = sp.totalLengthMm > 0
          ? Math.round((sp.remainingLengthMm / sp.totalLengthMm) * 100)
          : 0;
        tr.innerHTML = `<td>${formatSpoolDisplayId(sp)}</td>` +
          `<td>${sp.manufacturerName || sp.brand || ''}</td>` +
          `<td>${sp.materialName || sp.material || ''}</td>` +
          `<td><span style='color:${sp.filamentColor || sp.color || '#000'}'>■</span>${sp.colorName || ''}</td>` +
          `<td>${sp.name || sp.reelName || ''}</td>` +
          `<td>${pct}%</td>`;
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

