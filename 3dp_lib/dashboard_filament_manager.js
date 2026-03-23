/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 フィラメント管理モーダル モジュール
 * @file dashboard_filament_manager.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_filament_manager
 *
 * 【機能内容サマリ】
 * - フィラメント管理ダイアログの表示
 * - ダッシュボード（装着中/保管中スプール概要）
 * - 在庫・プリセット統合管理
 * - スプール一覧（状態バッジ・フィルタ付き）
 * - 使用履歴（種別フィルタ付き）
 * - 集計レポート
 *
 * 【公開関数一覧】
 * - {@link showFilamentManager}：管理モーダルを開く
 *
* @version 1.390.790 (PR #367)
* @since   1.390.228 (PR #102)
* @lastModified 2026-03-12 12:00:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

import { monitorData, PLACEHOLDER_HOSTNAME } from "./dashboard_data.js";
import { getConnectionState } from "./dashboard_connection.js";
import {
  getCurrentSpool,
  getCurrentSpoolId,
  getSpools,
  addSpool,
  updateSpool,
  addSpoolFromPreset,
  deleteSpool,
  setCurrentSpoolId,
  restoreSpool,
  getSpoolState,
  getSpoolStateLabel,
  formatSpoolDisplayId,
  formatFilamentAmount,
  buildSpoolAnalytics,
  getSpoolById,
  SPOOL_STATE
} from "./dashboard_spool.js";
import {
  getInventory,
  setInventoryQuantity,
  adjustInventory
} from "./dashboard_filament_inventory.js";
import { FILAMENT_PRESETS } from "./dashboard_filament_presets.js";
import { saveUnifiedStorage } from "./dashboard_storage.js";
import { createFilamentPreview } from "./dashboard_filament_view.js";
import { showAlert } from "./dashboard_notification_manager.js";
import { showConfirmDialog } from "./dashboard_ui_confirm.js";
import { showFilamentChangeDialog } from "./dashboard_filament_change.js";

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
  colorName: "",
  materialColorCode: "",
  purchaseLink: "",
  price: 0,
  currencySymbol: "\u00A5"
};

/**
 * プレビュー表示の共通デフォルトオプション。
 * 各所で copy-paste されていた設定を一元化する。
 *
 * @private
 * @constant {Object}
 */
const DEFAULT_PREVIEW_OPTIONS = {
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
};

/**
 * 必要な CSS を一度だけ注入する。
 *
 * @private
 * @returns {void}
 */
function injectStyles() {
  // CSS は 3dp_panel.css に移行済み（Phase 1-C）
  // この関数は後方互換性のために残す
}

/**
 * スプールオブジェクトからプレビューに渡すオプションのオーバーライドを生成する。
 *
 * @private
 * @param {Object} sp - スプールオブジェクト
 * @returns {Object} プレビューオプションのオーバーライド
 */
function spoolToPreviewOverrides(sp) {
  return {
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
  };
}

/**
 * 残量バー HTML を生成する。
 *
 * @private
 * @param {number} remaining - 残量 [mm]
 * @param {number} total - 全量 [mm]
 * @param {string} [color="#22C55E"] - バー色
 * @returns {string} HTML 文字列
 */
function renderRemainBar(remaining, total, color) {
  const pct = total > 0 ? Math.min(100, (remaining / total) * 100) : 0;
  const barColor = color || "#22C55E";
  return `<span class="remain-bar"><span class="remain-bar-fill" style="width:${pct.toFixed(1)}%;background:${barColor}"></span></span>${pct.toFixed(0)}%`;
}

/**
 * 状態バッジ HTML を生成する。
 *
 * @private
 * @param {string} state - SPOOL_STATE の値
 * @returns {string} HTML 文字列
 */
function renderStateBadge(state) {
  const label = getSpoolStateLabel(state);
  return `<span class="spool-state-badge spool-state-${state}">${label}</span>`;
}

/**
 * 接続中の全ホスト名リストを取得する（PLACEHOLDER を除外）。
 *
 * @private
 * @returns {string[]} ホスト名配列
 */
function getActiveHosts() {
  return Object.keys(monitorData.machines).filter(h =>
    h !== PLACEHOLDER_HOSTNAME && getConnectionState(h) === "connected"
  );
}

// ═══════════════════════════════════════════════════════════════
// Tab 0: ダッシュボード
// ═══════════════════════════════════════════════════════════════

/**
 * ダッシュボードタブの内容を生成する。
 * 各ホストの装着中スプールと保管中スプールのカルーセルを表示する。
 *
 * @private
 * @param {string} hostname - 現在のホスト名
 * @param {Function} switchTab - タブ切り替え関数
 * @returns {HTMLElement} DOM 要素
 */
function createDashboardContent(hostname, switchTab) {
  const div = document.createElement("div");
  div.className = "filament-manager-content";

  /** 内部描画 */
  function render() {
    div.innerHTML = "";

    const hosts = getActiveHosts();
    const allSpools = getSpools(true);

    // サマリ集計
    let mountedCount = 0;
    let storedCount = 0;
    let discardedCount = 0;
    allSpools.forEach(sp => {
      const st = getSpoolState(sp);
      if (st === SPOOL_STATE.MOUNTED) mountedCount++;
      else if (st === SPOOL_STATE.STORED) storedCount++;
      else if (st === SPOOL_STATE.DISCARDED) discardedCount++;
    });

    // サマリ行
    const summary = document.createElement("div");
    summary.className = "dashboard-summary";
    summary.innerHTML =
      `<span>装着中: ${mountedCount}</span>` +
      `<span>保管中: ${storedCount}</span>` +
      `<span>廃棄済: ${discardedCount}</span>`;
    div.appendChild(summary);

    // per-host セクション
    if (hosts.length === 0) {
      const noHost = document.createElement("div");
      noHost.className = "fm-empty-msg";
      noHost.textContent = "接続中のプリンタがありません";
      div.appendChild(noHost);
    }

    hosts.forEach(host => {
      const section = document.createElement("div");
      section.className = "dashboard-host-section";

      const title = document.createElement("div");
      title.className = "dashboard-host-title";
      const machine = monitorData.machines[host] || {};
      const displayName = machine.storedData?.hostname?.rawValue || machine.storedData?.model?.rawValue || host;
      title.textContent = displayName;
      section.appendChild(title);

      const spoolId = getCurrentSpoolId(host);
      const spool = spoolId ? allSpools.find(s => s.id === spoolId && !s.deleted) : null;

      if (spool) {
        // 装着中スプールの表示
        const mountedWrap = document.createElement("div");
        mountedWrap.className = "fm-mounted-wrap";

        const prevBox = document.createElement("div");
        prevBox.className = "fm-mounted-preview";
        mountedWrap.appendChild(prevBox);

        createFilamentPreview(prevBox, {
          ...DEFAULT_PREVIEW_OPTIONS,
          ...spoolToPreviewOverrides(spool),
          widthPx: 100,
          heightPx: 100
        });

        const infoBox = document.createElement("div");
        infoBox.className = "fm-mounted-info";
        const pct = spool.totalLengthMm > 0
          ? ((spool.remainingLengthMm / spool.totalLengthMm) * 100).toFixed(0)
          : 0;
        const colorSwatch = `<span class="color-swatch color-swatch-md" style="background:${spool.filamentColor || spool.color || "#ccc"}"></span>`;
        // 残量を人間可読フォーマットで表示
        const remainFmt = formatFilamentAmount(spool.remainingLengthMm, spool);
        // 枯渇予測
        const analytics = buildSpoolAnalytics(spool.id);
        let predLine = "";
        if (analytics) {
          const parts = [];
          if (analytics.estimatedRemainingPrints != null) parts.push(`あと約${analytics.estimatedRemainingPrints}回`);
          if (analytics.estimatedRemainingDays != null) parts.push(`約${analytics.estimatedRemainingDays}日`);
          if (analytics.remainingCost > 0) parts.push(`${analytics.currency}${Math.round(analytics.remainingCost).toLocaleString()}残`);
          if (parts.length > 0) predLine = `<div class="fm-spool-sub">${parts.join(" / ")}</div>`;
        }
        infoBox.innerHTML =
          `<div><strong>${formatSpoolDisplayId(spool)}</strong> ${spool.name || ""}</div>` +
          `<div>${colorSwatch}${spool.colorName || ""} / ${spool.materialName || spool.material || ""}</div>` +
          `<div style="margin:2px 0">${remainFmt.display} (${pct}%)</div>` +
          `<div>${renderRemainBar(spool.remainingLengthMm, spool.totalLengthMm, spool.filamentColor || spool.color)}</div>` +
          predLine;

        const btnWrap = document.createElement("div");
        btnWrap.className = "fm-mounted-buttons";
        const changeBtn = document.createElement("button");
        changeBtn.textContent = "交換";
        changeBtn.className = "btn-font-xs";
        changeBtn.addEventListener("click", async () => {
          try { await showFilamentChangeDialog(host); } catch (e) {
            console.error("[filament-manager] 交換ダイアログエラー:", e);
          }
        });
        const removeBtn = document.createElement("button");
        removeBtn.textContent = "取り外す";
        removeBtn.className = "btn-font-xs";
        removeBtn.addEventListener("click", async () => {
          const hostDisplayName = monitorData.machines[host]?.storedData?.hostname?.rawValue || host;
          const ok = await showConfirmDialog({
            level: "warn",
            title: "スプール取り外し",
            message: `${hostDisplayName} から ${formatSpoolDisplayId(spool)} ${spool.name || ""} を取り外しますか?`,
            confirmText: "取り外す",
            cancelText: "キャンセル"
          });
          if (!ok) return;
          setCurrentSpoolId(null, host);
          render();
        });
        btnWrap.append(changeBtn, removeBtn);
        infoBox.appendChild(btnWrap);
        mountedWrap.appendChild(infoBox);
        section.appendChild(mountedWrap);
      } else {
        // 未装着
        const empty = document.createElement("div");
        empty.className = "fm-empty-msg";
        empty.textContent = "スプール未装着";
        const mountBtn = document.createElement("button");
        mountBtn.textContent = "装着";
        mountBtn.className = "btn-font-xs";
        mountBtn.addEventListener("click", () => {
          // スプール一覧タブへ切り替え
          switchTab(2);
        });
        empty.appendChild(document.createTextNode(" "));
        empty.appendChild(mountBtn);
        section.appendChild(empty);
      }

      div.appendChild(section);
    });

    // 保管中スプール カルーセル
    const storedSpools = allSpools.filter(sp => {
      const st = getSpoolState(sp);
      return st === SPOOL_STATE.STORED || st === SPOOL_STATE.INVENTORY;
    });

    if (storedSpools.length > 0) {
      const storedFs = document.createElement("fieldset");
      storedFs.className = "carousel-field";
      const storedLg = document.createElement("legend");
      storedLg.textContent = "保管中スプール";
      storedFs.appendChild(storedLg);

      const carousel = document.createElement("div");
      carousel.className = "stored-carousel";

      storedSpools.forEach(sp => {
        const item = document.createElement("div");
        item.className = "stored-item";

        const prevMount = document.createElement("div");
        prevMount.className = "fm-carousel-preview";
        item.appendChild(prevMount);
        createFilamentPreview(prevMount, {
          ...DEFAULT_PREVIEW_OPTIONS,
          ...spoolToPreviewOverrides(sp),
          widthPx: 60,
          heightPx: 60,
          showOverlayLength: false,
          showOverlayPercent: false,
          showOverlayBar: false,
          showProfileViewButton: false,
          showSideViewButton: false,
          showFrontViewButton: false,
          showAutoRotateButton: false,
          showPurchaseButton: false,
          enableDrag: false
        });

        const pct = sp.totalLengthMm > 0
          ? ((sp.remainingLengthMm / sp.totalLengthMm) * 100).toFixed(0)
          : 0;
        const label = document.createElement("div");
        label.innerHTML = `${formatSpoolDisplayId(sp)}<br>${pct}%`;
        item.appendChild(label);

        // 装着ボタン
        if (hosts.length > 0) {
          const mountBtn = document.createElement("button");
          mountBtn.textContent = "装着";
          mountBtn.className = "btn-font-xs";
          mountBtn.addEventListener("click", () => {
            if (hosts.length === 1) {
              if (!setCurrentSpoolId(sp.id, hosts[0])) {
                showAlert("このスプールは既に別のプリンタに装着されています", "warn");
                return;
              }
              render();
            } else {
              // 複数ホストの場合、ホスト選択ドロップダウンを表示
              const sel = document.createElement("select");
              sel.className = "btn-font-xs";
              hosts.forEach(h => {
                const m = monitorData.machines[h] || {};
                const name = m.storedData?.hostname?.rawValue || h;
                const o = document.createElement("option");
                o.value = h;
                o.textContent = name;
                sel.appendChild(o);
              });
              const okBtn = document.createElement("button");
              okBtn.textContent = "OK";
              okBtn.className = "btn-font-xs";
              okBtn.addEventListener("click", () => {
                if (!setCurrentSpoolId(sp.id, sel.value)) {
                  showAlert("このスプールは既に別のプリンタに装着されています", "warn");
                  return;
                }
                render();
              });
              item.append(sel, okBtn);
            }
          });
          item.appendChild(mountBtn);
        }

        carousel.appendChild(item);
      });

      storedFs.appendChild(carousel);
      div.appendChild(storedFs);
    }
  }

  render();
  return { el: div, render };
}

// ═══════════════════════════════════════════════════════════════
// Tab 1: 在庫・プリセット（統合）
// ═══════════════════════════════════════════════════════════════

/**
 * 在庫・プリセット統合タブを生成する。
 * プリセット一覧に在庫数カラムを追加し、開封登録・装着操作を行える。
 *
 * @private
 * @param {string} hostname - 現在のホスト名
 * @param {Function} switchTab - タブ切り替え関数
 * @param {Function} onRegisteredRefresh - 登録済みタブの再描画関数
 * @returns {{el:HTMLElement, render:function():void}} タブ要素と描画関数
 */
function createInventoryPresetContent(hostname, switchTab, onRegisteredRefresh) {
  const div = document.createElement("div");
  div.className = "filament-manager-content";

  // 検索フォーム
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
  countSpan.className = "fm-count";

  const wrap = document.createElement("div");
  wrap.className = "registered-container";
  const prevBox = document.createElement("div");
  prevBox.className = "registered-preview";
  wrap.appendChild(prevBox);

  const listBox = document.createElement("div");
  listBox.className = "registered-list scrollable-body";
  listBox.className = "scroll-box";

  const table = document.createElement("table");
  table.className = "registered-table fixed-header sortable-table";
  const thead = document.createElement("thead");
  thead.innerHTML =
    "<tr><th>色見本</th><th data-sort='brand'>ブランド</th><th data-sort='material'>材質</th>" +
    "<th data-sort='colorName'>色名</th><th data-sort='name'>名称</th>" +
    "<th data-sort='qty' style='text-align:right'>在庫(±)</th><th data-sort='count' style='text-align:right'>累計使用数</th><th>コマンド</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);
  listBox.appendChild(table);
  wrap.appendChild(listBox);

  div.append(searchFs, countSpan, wrap);

  const preview = createFilamentPreview(prevBox, { ...DEFAULT_PREVIEW_OPTIONS });

  let sortKey = "";
  let sortAsc = true;
  let selectedTr = null;

  /** プリセットからスプール使用数を集計する */
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

  /** 在庫データをモデルIDでマップ化 */
  function buildInvMap() {
    const map = {};
    getInventory().forEach(inv => {
      map[inv.modelId] = inv;
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
      o.value = b; o.textContent = b; brandSel.appendChild(o);
    });
    matSel.innerHTML = "<option value=''>材質</option>";
    [...mats].forEach(m => {
      const o = document.createElement("option");
      o.value = m; o.textContent = m; matSel.appendChild(o);
    });
    colorSel.innerHTML = "<option value=''>色名</option>";
    [...colors].forEach(c => {
      const o = document.createElement("option");
      o.value = c; o.textContent = c; colorSel.appendChild(o);
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
        case "brand": va = a.brand || ""; vb = b.brand || ""; break;
        case "material": va = a.material || ""; vb = b.material || ""; break;
        case "colorName": va = a.colorName || ""; vb = b.colorName || ""; break;
        case "name": va = a.name || ""; vb = b.name || ""; break;
        case "qty":
          va = invMap[a.presetId]?.quantity || 0;
          vb = invMap[b.presetId]?.quantity || 0;
          break;
        case "count":
          va = usageMap[a.presetId]?.count || 0;
          vb = usageMap[b.presetId]?.count || 0;
          break;
        default: break;
      }
      if (va === vb) return 0;
      const cmp = va > vb ? 1 : -1;
      return sortAsc ? cmp : -cmp;
    });
  }

  let usageMap = buildUsageMap();
  let invMap = buildInvMap();

  function render() {
    const presets = monitorData.filamentPresets || FILAMENT_PRESETS;
    usageMap = buildUsageMap();
    invMap = buildInvMap();
    fillOptions(presets);
    const list = sortList(applyFilter(presets));
    tbody.innerHTML = "";
    const hosts = getActiveHosts();

    list.forEach(p => {
      const tr = document.createElement("tr");
      const usage = usageMap[p.presetId]?.count || 0;
      const inv = invMap[p.presetId];
      const qty = inv ? inv.quantity : 0;

      // 色見本
      const colorTd = document.createElement("td");
      colorTd.innerHTML = `<span class="color-swatch color-swatch-xl" style="background:${p.color || "#ccc"}"></span>`;
      tr.appendChild(colorTd);

      // ブランド・材質
      const brandTd = document.createElement("td");
      brandTd.textContent = p.brand || "";
      tr.appendChild(brandTd);
      const matTd = document.createElement("td");
      matTd.textContent = p.material || "";
      tr.appendChild(matTd);

      // 色名
      const cnTd = document.createElement("td");
      cnTd.textContent = p.colorName || "";
      tr.appendChild(cnTd);

      // 名称
      const nameTd = document.createElement("td");
      nameTd.textContent = p.name || "";
      tr.appendChild(nameTd);

      // 在庫(±)
      const qtyTd = document.createElement("td");
      const minus = document.createElement("button");
      minus.textContent = "-";
      minus.className = "inv-adjust";
      const qtySpan = document.createElement("span");
      qtySpan.textContent = String(qty);
      qtySpan.style.margin = "0 4px";
      const plus = document.createElement("button");
      plus.textContent = "+";
      plus.className = "inv-adjust";
      minus.addEventListener("click", ev => {
        ev.stopPropagation();
        const newQty = adjustInventory(p.presetId, -1);
        qtySpan.textContent = String(newQty);
      });
      plus.addEventListener("click", ev => {
        ev.stopPropagation();
        const newQty = adjustInventory(p.presetId, 1);
        qtySpan.textContent = String(newQty);
      });
      qtyTd.append(minus, qtySpan, plus);
      tr.appendChild(qtyTd);

      // 累計使用数
      const usageTd = document.createElement("td");
      usageTd.textContent = String(usage);
      tr.appendChild(usageTd);

      // コマンド
      const cmd = document.createElement("td");
      const regBtn = document.createElement("button");
      regBtn.textContent = "開封して登録";
      regBtn.className = "btn-font-xs";
      regBtn.addEventListener("click", ev => {
        ev.stopPropagation();
        addSpoolFromPreset(p);
        if (onRegisteredRefresh) onRegisteredRefresh();
        render();
        showAlert("スプールを登録しました", "success");
      });
      cmd.appendChild(regBtn);

      const mountBtn = document.createElement("button");
      mountBtn.textContent = "開封して装着";
      mountBtn.className = "btn-font-xs";
      mountBtn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const sp = addSpoolFromPreset(p);
        if (!sp) return;
        if (hosts.length === 1) {
          if (!setCurrentSpoolId(sp.id, hosts[0])) {
            showAlert("装着に失敗しました", "warn");
            return;
          }
          _syncFilamentPreview(hosts[0], sp);
          if (onRegisteredRefresh) onRegisteredRefresh();
          render();
          showAlert("スプールを装着しました", "success");
        } else if (hosts.length > 1) {
          const { showConfirmDialog } = await import("./dashboard_ui_confirm.js");
          const hostOptions = hosts.map(h => {
            const m = monitorData.machines[h] || {};
            return m.storedData?.hostname?.rawValue || h;
          });
          const ok = await showConfirmDialog({
            level: "info",
            title: "装着先の選択",
            html: `<div class="fm-host-prompt">${formatSpoolDisplayId(sp)} を装着するプリンタを選択</div>
              <select id="mount-host-select" class="fm-host-select">
                ${hosts.map((h, i) => `<option value="${h}">${hostOptions[i]}</option>`).join("")}
              </select>`,
            confirmText: "装着",
            cancelText: "キャンセル"
          });
          if (!ok) return;
          const selEl = document.getElementById("mount-host-select");
          const targetHost = selEl?.value || hosts[0];
          if (!setCurrentSpoolId(sp.id, targetHost)) {
            showAlert("このスプールは既に別のプリンタに装着されています", "warn");
            return;
          }
          _syncFilamentPreview(targetHost, sp);
          if (onRegisteredRefresh) onRegisteredRefresh();
          render();
          showAlert("スプールを装着しました", "success");
        } else {
          if (onRegisteredRefresh) onRegisteredRefresh();
          render();
          showAlert("スプールを登録しました（装着先が見つかりません）", "info");
        }
      });
      cmd.appendChild(mountBtn);
      tr.appendChild(cmd);

      // 行クリックでプレビュー更新
      tr.addEventListener("click", () => {
        selectedTr?.classList.remove("selected");
        selectedTr = tr;
        tr.classList.add("selected");
        preview.setState({
          filamentDiameter: p.filamentDiameter ?? p.diameter,
          filamentTotalLength: p.filamentTotalLength ?? p.defaultLength,
          filamentCurrentLength: p.filamentCurrentLength ?? (p.filamentTotalLength ?? p.defaultLength),
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

// ═══════════════════════════════════════════════════════════════
// Tab 2: スプール一覧（強化版）
// ═══════════════════════════════════════════════════════════════

/**
 * スプール一覧タブを生成する。
 * 全スプール（廃棄済み含む）を状態バッジ・残量バー付きで一覧表示する。
 *
 * @private
 * @param {Function} openEditor - エディタ起動関数
 * @param {string} hostname - 現在のホスト名
 * @returns {{el:HTMLElement, render:function():void}} タブ要素と描画関数
 */
/**
 * フィラメントパネルのプレビューをスプール変更に同期する。
 * @param {string} host - ホスト名
 * @param {Object|null} spool - 新しいスプール (null で未装着)
 */
function _syncFilamentPreview(host, spool) {
  const preview = window._filamentPreviews?.get(host);
  if (!preview) return;
  if (spool) {
    preview.setState({
      isFilamentPresent: true,
      filamentCurrentLength: spool.remainingLengthMm || 0,
      filamentTotalLength: spool.totalLengthMm || 330000,
      filamentColor: spool.filamentColor || spool.color || "#22C55E",
      reelName: spool.name || "",
      reelSubName: spool.reelSubName || "",
      materialName: spool.materialName || spool.material || "",
      materialColorName: spool.colorName || "",
      materialColorCode: spool.filamentColor || "",
      manufacturerName: spool.manufacturerName || spool.brand || ""
    });
  } else {
    preview.setState({
      isFilamentPresent: false,
      filamentCurrentLength: 330000,
      reelName: "", reelSubName: "", materialName: "",
      materialColorName: "", materialColorCode: "", manufacturerName: ""
    });
  }
}

function createRegisteredContent(openEditor, hostname) {
  const div = document.createElement("div");
  div.className = "filament-manager-content";

  const addBtn = document.createElement("button");
  addBtn.textContent = "新規登録";
  addBtn.className = "btn-font-sm";

  // 状態フィルタバー
  const filterBar = document.createElement("div");
  filterBar.className = "state-filter-bar";
  const filterStates = [
    { key: "all", label: "全て" },
    { key: SPOOL_STATE.MOUNTED, label: "装着中" },
    { key: SPOOL_STATE.STORED, label: "保管中" },
    { key: SPOOL_STATE.INVENTORY, label: "未使用" },
    { key: SPOOL_STATE.EXHAUSTED, label: "使い切り" },
    { key: SPOOL_STATE.DISCARDED, label: "廃棄済" }
  ];
  let activeFilter = "all";
  filterStates.forEach(fs => {
    const btn = document.createElement("button");
    btn.textContent = fs.label;
    btn.dataset.filter = fs.key;
    if (fs.key === "all") btn.classList.add("active");
    btn.addEventListener("click", () => {
      activeFilter = fs.key;
      filterBar.querySelectorAll("button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      render();
    });
    filterBar.appendChild(btn);
  });

  const favFs = document.createElement("fieldset");
  favFs.className = "carousel-field";
  const favLg = document.createElement("legend");
  favLg.textContent = "お気に入り";
  favFs.appendChild(favLg);
  const favCarousel = document.createElement("div");
  favCarousel.className = "filament-carousel";
  favFs.appendChild(favCarousel);

  const freqFs = document.createElement("fieldset");
  freqFs.className = "carousel-field";
  const freqLg = document.createElement("legend");
  freqLg.textContent = "よく使うフィラメント";
  freqFs.appendChild(freqLg);
  const freqCarousel = document.createElement("div");
  freqCarousel.className = "filament-carousel";
  freqFs.appendChild(freqCarousel);

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
  countSpan.className = "fm-count";

  const wrap = document.createElement("div");
  wrap.className = "registered-container";
  const prevBox = document.createElement("div");
  prevBox.className = "registered-preview";
  wrap.appendChild(prevBox);

  const listBox = document.createElement("div");
  listBox.className = "registered-list scrollable-body";
  listBox.className = "scroll-box";

  const table = document.createElement("table");
  table.className = "registered-table fixed-header sortable-table";
  const thead = document.createElement("thead");
  thead.innerHTML =
    "<tr><th data-sort='serial'>ID</th><th>状態</th>" +
    "<th data-sort='brand'>ブランド</th><th data-sort='material'>材質</th>" +
    "<th data-sort='colorName'>色名</th><th data-sort='name'>名称</th>" +
    "<th style='text-align:right'>残量</th>" +
    "<th data-sort='count' style='text-align:right'>使用数</th><th data-sort='last'>最終利用日時</th><th>コマンド</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);
  listBox.appendChild(table);
  wrap.appendChild(listBox);

  div.append(addBtn, filterBar, favFs, freqFs, searchFs, countSpan, wrap);

  const preview = createFilamentPreview(prevBox, { ...DEFAULT_PREVIEW_OPTIONS });

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
      o.value = b; o.textContent = b; brandSel.appendChild(o);
    });
    matSel.innerHTML = "<option value=''>材質</option>";
    [...mats].forEach(m => {
      const o = document.createElement("option");
      o.value = m; o.textContent = m; matSel.appendChild(o);
    });
    colorSel.innerHTML = "<option value=''>色名</option>";
    [...colors].forEach(c => {
      const o = document.createElement("option");
      o.value = c; o.textContent = c; colorSel.appendChild(o);
    });
  }

  function applyFilter(spools) {
    return spools.filter(sp => {
      // 状態フィルタ
      if (activeFilter !== "all") {
        const st = getSpoolState(sp);
        if (st !== activeFilter) return false;
      }
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
        case "serial":
          va = a.serialNo || 0;
          vb = b.serialNo || 0;
          break;
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

  function updateCarousels(list) {
    favCarousel.innerHTML = "";
    freqCarousel.innerHTML = "";
    const nonDeleted = list.filter(sp => !sp.deleted);
    const favs = nonDeleted.filter(sp => sp.isFavorite);
    const freq = nonDeleted
      .map(sp => ({ sp, c: usageMap[sp.id]?.count || 0 }))
      .sort((a, b) => b.c - a.c)
      .slice(0, 5)
      .map(v => v.sp);
    const addItem = (sp, box) => {
      const item = document.createElement("div");
      item.className = "carousel-item";
      box.appendChild(item);
      createFilamentPreview(item, {
        ...DEFAULT_PREVIEW_OPTIONS,
        ...spoolToPreviewOverrides(sp),
        widthPx: 80,
        heightPx: 80,
        showSlider: false,
        showOverlayLength: false,
        showOverlayPercent: false,
        showOverlayBar: false,
        showProfileViewButton: false,
        showSideViewButton: false,
        showFrontViewButton: false,
        showAutoRotateButton: false,
        enableDrag: false,
        enableClick: true,
        onClick: () => openEditor(sp, render),
        showPurchaseButton: false
      });
    };
    favs.forEach(sp => addItem(sp, favCarousel));
    freq.forEach(sp => addItem(sp, freqCarousel));
  }

  function render() {
    // 全スプール取得（廃棄済み含む）
    const spools = getSpools(true);
    usageMap = buildMaps();
    updateCarousels(spools);
    fillOptions(spools);
    const list = sortList(applyFilter(spools));
    const hosts = getActiveHosts();
    tbody.innerHTML = "";
    list.forEach(sp => {
      const tr = document.createElement("tr");
      if (sp.deleted) tr.classList.add("deleted-row");

      const state = getSpoolState(sp);
      const brand = sp.manufacturerName || sp.brand || "";
      const mat = sp.materialName || sp.material || "";
      const usage = usageMap[sp.id]?.count || 0;
      const last = usageMap[sp.id]?.last
        ? new Date(usageMap[sp.id].last).toLocaleString()
        : "";

      // #NNN ID
      const idTd = document.createElement("td");
      idTd.textContent = formatSpoolDisplayId(sp);
      tr.appendChild(idTd);

      // 状態バッジ + 装着先統合
      const stateTd = document.createElement("td");
      let stateHtml = renderStateBadge(state);
      if (state === SPOOL_STATE.MOUNTED && sp.hostname) {
        const mountName = monitorData.machines[sp.hostname]?.storedData?.hostname?.rawValue || sp.hostname;
        stateHtml += `<div style="font-size:10px;color:#64748b;margin-top:1px">${mountName}</div>`;
      }
      stateTd.innerHTML = stateHtml;
      tr.appendChild(stateTd);

      // ブランド
      const brandTd = document.createElement("td");
      brandTd.textContent = brand;
      tr.appendChild(brandTd);

      // 材質
      const matTd = document.createElement("td");
      matTd.textContent = mat;
      tr.appendChild(matTd);

      // 色名
      const colorCell = document.createElement("td");
      colorCell.innerHTML = `<span style='color:${sp.filamentColor || sp.color || "#000"}'>&#9632;</span>${sp.colorName || ""}`;
      tr.appendChild(colorCell);

      // 名称
      const nameTd = document.createElement("td");
      nameTd.textContent = sp.name || sp.reelName || "";
      tr.appendChild(nameTd);

      // 残量バー
      const remainTd = document.createElement("td");
      remainTd.innerHTML = renderRemainBar(
        sp.remainingLengthMm || 0,
        sp.totalLengthMm || 0,
        sp.filamentColor || sp.color
      );
      tr.appendChild(remainTd);

      // 使用数
      const usageTd = document.createElement("td");
      usageTd.textContent = String(usage);
      tr.appendChild(usageTd);

      // 最終利用日時
      const lastTd = document.createElement("td");
      lastTd.textContent = last;
      tr.appendChild(lastTd);

      // コマンド
      const cmd = document.createElement("td");
      switch (state) {
        case SPOOL_STATE.MOUNTED: {
          const editBtn = document.createElement("button");
          editBtn.textContent = "編集";
          editBtn.className = "btn-font-xs";
          editBtn.addEventListener("click", ev => { ev.stopPropagation(); openEditor(sp, render); });
          const removeBtn = document.createElement("button");
          removeBtn.textContent = "取り外す";
          removeBtn.className = "btn-font-xs";
          removeBtn.addEventListener("click", ev => {
            ev.stopPropagation();
            const targetHost = sp.hostname || hostname;
            const ok = setCurrentSpoolId(null, targetHost);
            // setCurrentSpoolId が hostSpoolMap 不整合で取り外せなかった場合の安全弁
            if (!ok || sp.isActive) {
              sp.isActive = false;
              sp.isInUse = false;
              sp.hostname = null;
              sp.removedAt = Date.now();
              if (targetHost) monitorData.hostSpoolMap[targetHost] = null;
            }
            // フィラメントカードのプレビューを更新
            _syncFilamentPreview(targetHost, null);
            render();
          });
          cmd.append(editBtn, removeBtn);
          break;
        }
        case SPOOL_STATE.STORED:
        case SPOOL_STATE.INVENTORY: {
          const mountBtn = document.createElement("button");
          mountBtn.textContent = "装着";
          mountBtn.className = "btn-font-xs";
          mountBtn.addEventListener("click", async (ev) => {
            ev.stopPropagation();
            if (hosts.length === 1) {
              if (!setCurrentSpoolId(sp.id, hosts[0])) {
                showAlert("このスプールは既に別のプリンタに装着されています", "warn");
                return;
              }
              _syncFilamentPreview(hosts[0], sp);
              showAlert("スプールを装着しました", "success");
              render();
            } else if (hosts.length > 1) {
              // 確認ダイアログで装着先を選択（インライン追加ではなくダイアログで）
              const { showConfirmDialog } = await import("./dashboard_ui_confirm.js");
              const hostOptions = hosts.map(h => {
                const m = monitorData.machines[h] || {};
                return m.storedData?.hostname?.rawValue || h;
              });
              const ok = await showConfirmDialog({
                level: "info",
                title: "装着先の選択",
                html: `<div style="font-size:13px;margin-bottom:8px">${formatSpoolDisplayId(sp)} ${sp.name || ""} をどのプリンタに装着しますか？</div>
                  <select id="mount-host-select" style="width:100%;padding:6px;font-size:13px;border:1px solid #ccc;border-radius:4px">
                    ${hosts.map((h, i) => `<option value="${h}">${hostOptions[i]}</option>`).join("")}
                  </select>`,
                confirmText: "装着",
                cancelText: "キャンセル"
              });
              if (!ok) return;
              const selEl = document.getElementById("mount-host-select");
              const targetHost = selEl?.value || hosts[0];
              if (!setCurrentSpoolId(sp.id, targetHost)) {
                showAlert("このスプールは既に別のプリンタに装着されています", "warn");
                return;
              }
              _syncFilamentPreview(targetHost, sp);
              showAlert("スプールを装着しました", "success");
              render();
            }
          });
          const editBtn = document.createElement("button");
          editBtn.textContent = "編集";
          editBtn.className = "btn-font-xs";
          editBtn.addEventListener("click", ev => { ev.stopPropagation(); openEditor(sp, render); });
          const delBtn = document.createElement("button");
          delBtn.textContent = "廃棄";
          delBtn.className = "btn-font-xs";
          delBtn.addEventListener("click", ev => {
            ev.stopPropagation();
            deleteSpool(sp.id, hostname);
            render();
          });
          cmd.append(mountBtn, editBtn, delBtn);
          break;
        }
        case SPOOL_STATE.EXHAUSTED: {
          const editBtn = document.createElement("button");
          editBtn.textContent = "編集";
          editBtn.className = "btn-font-xs";
          editBtn.addEventListener("click", ev => { ev.stopPropagation(); openEditor(sp, render); });
          const delBtn = document.createElement("button");
          delBtn.textContent = "廃棄";
          delBtn.className = "btn-font-xs";
          delBtn.addEventListener("click", ev => {
            ev.stopPropagation();
            deleteSpool(sp.id, hostname);
            render();
          });
          cmd.append(editBtn, delBtn);
          break;
        }
        case SPOOL_STATE.DISCARDED: {
          const resBtn = document.createElement("button");
          resBtn.textContent = "復活";
          resBtn.className = "btn-font-xs";
          resBtn.addEventListener("click", ev => {
            ev.stopPropagation();
            restoreSpool(sp.id);
            render();
          });
          cmd.appendChild(resBtn);
          break;
        }
        default: {
          const editBtn = document.createElement("button");
          editBtn.textContent = "編集";
          editBtn.className = "btn-font-xs";
          editBtn.addEventListener("click", ev => { ev.stopPropagation(); openEditor(sp, render); });
          cmd.appendChild(editBtn);
          break;
        }
      }
      // お気に入りトグルボタン（全状態共通）
      const favBtn = document.createElement("button");
      favBtn.textContent = sp.isFavorite ? "★" : "☆";
      favBtn.title = sp.isFavorite ? "お気に入り解除" : "お気に入りに追加";
      favBtn.className = "icon-btn";
      favBtn.className = "fm-fav-btn";
      favBtn.style.color = sp.isFavorite ? "#f59e0b" : "#94a3b8";
      favBtn.style.borderColor = sp.isFavorite ? "#f59e0b" : "#ddd";
      favBtn.addEventListener("click", ev => {
        ev.stopPropagation();
        sp.isFavorite = !sp.isFavorite;
        updateSpool(sp.id, { isFavorite: sp.isFavorite });
        render();
      });
      cmd.prepend(favBtn);
      tr.appendChild(cmd);

      // 行クリックでプレビュー更新 + 詳細ドリルダウン表示
      tr.addEventListener("click", () => {
        selectedTr?.classList.remove("selected");
        selectedTr = tr;
        tr.classList.add("selected");
        preview.setState(spoolToPreviewOverrides(sp));
        renderDrilldown(sp);
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

  // ── スプール詳細ドリルダウンパネル ──
  const drilldown = document.createElement("div");
  drilldown.className = "spool-drilldown";
  drilldown.className = "drilldown-panel";
  div.appendChild(drilldown);

  /**
   * スプール詳細ドリルダウンを描画する。
   * @param {Object} sp - スプールオブジェクト
   */
  function renderDrilldown(sp) {
    drilldown.style.display = "";
    drilldown.innerHTML = "";

    const analytics = buildSpoolAnalytics(sp.id);
    if (!analytics) {
      drilldown.innerHTML = "<p>分析データがありません</p>";
      return;
    }

    // ヘッダー
    const hdr = document.createElement("div");
    hdr.className = "drilldown-header";
    const colorSwatch = `<span class="color-swatch color-swatch-lg" style="background:${sp.filamentColor || sp.color || "#ccc"}"></span>`;
    hdr.innerHTML = `<h3 style="margin:0;font-size:1.1em">${colorSwatch}${formatSpoolDisplayId(sp)} ${sp.name || ""} <small class="text-secondary-xs">${analytics.material}</small></h3>`;
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.className = "drilldown-close";
    closeBtn.addEventListener("click", () => { drilldown.style.display = "none"; });
    hdr.appendChild(closeBtn);
    drilldown.appendChild(hdr);

    // サマリカード
    const remainFmt = formatFilamentAmount(analytics.remainMm, sp);
    const consumedFmt = formatFilamentAmount(analytics.consumedMm, sp);
    const cards = document.createElement("div");
    cards.className = "stat-cards";
    const cardItems = [
      { label: "残量", value: `${remainFmt.display}`, sub: `${analytics.consumedPct > 0 ? (100 - analytics.consumedPct).toFixed(0) : "?"}%` },
      { label: "消費済", value: consumedFmt.display, sub: `${analytics.consumedPct.toFixed(0)}%` },
      { label: "印刷回数", value: `${analytics.printCount}回`, sub: `平均 ${formatFilamentAmount(analytics.avgPerPrint).m}m/回` },
      { label: "使用期間", value: `${analytics.daysActive}日`, sub: `${analytics.printsPerDay}回/日` },
    ];
    if (analytics.estimatedRemainingPrints != null) {
      cardItems.push({ label: "残印刷予測", value: `約${analytics.estimatedRemainingPrints}回`, sub: `約${analytics.estimatedRemainingDays}日` });
    }
    if (analytics.price > 0) {
      cardItems.push({ label: "コスト", value: `${analytics.currency}${Math.round(analytics.costPerPrint)}/回`, sub: `残${analytics.currency}${Math.round(analytics.remainingCost).toLocaleString()}` });
    }
    for (const c of cardItems) {
      const card = document.createElement("div");
      card.className = "stat-card";
      card.innerHTML = `<div class="stat-card-label">${c.label}</div><div class="stat-card-value">${c.value}</div>${c.sub ? `<div class="stat-card-sub">${c.sub}</div>` : ""}`;
      cards.appendChild(card);
    }
    drilldown.appendChild(cards);

    // 消費推移グラフ (4-1: usedLengthLog の可視化)
    if (analytics.usedLengthLog.length > 0) {
      const chartFs = document.createElement("fieldset");
      chartFs.className = "analysis-fieldset";
      chartFs.innerHTML = "<legend style='font-weight:bold;font-size:0.9em'>消費推移 (ジョブ別)</legend>";
      const canvas = document.createElement("canvas");
      canvas.className = "chart-constrained";
      chartFs.appendChild(canvas);
      drilldown.appendChild(chartFs);

      if (typeof Chart !== "undefined") {
        const log = analytics.usedLengthLog;
        // 累積残量を逆算
        let remaining = analytics.totalMm;
        const cumulativeData = [];
        for (let i = 0; i < log.length; i++) {
          remaining -= (log[i].used || 0);
          cumulativeData.push(Math.max(0, remaining) / 1000); // m 単位
        }
        new Chart(canvas.getContext("2d"), {
          type: "line",
          data: {
            labels: log.map((_, i) => `#${i + 1}`),
            datasets: [{
              label: "残量 (m)",
              data: cumulativeData,
              borderColor: sp.filamentColor || "#3b82f6",
              backgroundColor: (sp.filamentColor || "#3b82f6") + "20",
              fill: true,
              tension: 0.3
            }]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            scales: { y: { min: 0, title: { display: true, text: "残量 (m)" } } },
            plugins: { legend: { display: false } }
          }
        });
      }
    }

    // 印刷実績テーブル (usedLengthLog → ジョブID参照)
    if (analytics.usedLengthLog.length > 0) {
      const histFs = document.createElement("fieldset");
      histFs.className = "analysis-fieldset";
      histFs.innerHTML = "<legend style='font-weight:bold;font-size:0.9em'>消費ログ (直近20件)</legend>";
      const htable = document.createElement("table");
      htable.style.cssText = "width:100%;font-size:0.85em";
      htable.innerHTML = "<thead><tr><th>#</th><th>ジョブID</th><th style='text-align:right'>消費量</th></tr></thead>";
      const htbody = document.createElement("tbody");
      const recentLog = analytics.usedLengthLog.slice(-20).reverse();
      recentLog.forEach((entry, i) => {
        const fmtUsed = formatFilamentAmount(entry.used, sp);
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${analytics.usedLengthLog.length - i}</td><td style="font-family:monospace;font-size:0.85em">${entry.jobId || "—"}</td><td style="text-align:right">${fmtUsed.display}</td>`;
        htbody.appendChild(tr);
      });
      htable.appendChild(htbody);
      histFs.appendChild(htable);
      drilldown.appendChild(histFs);
    }
  }

  render();
  return { el: div, render };
}

// ═══════════════════════════════════════════════════════════════
// Tab 3: 使用履歴（強化版）
// ═══════════════════════════════════════════════════════════════

/**
 * 使用履歴タブの内容を生成する。
 * 種別フィルタ付きで、人間可読なスプール情報・ジョブ情報を表示する。
 *
 * @private
 * @returns {HTMLElement} 生成された要素
 */
function createHistoryContent() {
  const div = document.createElement("div");
  div.className = "filament-manager-content";

  // 種別フィルタ
  const filterBar = document.createElement("div");
  filterBar.className = "state-filter-bar";
  const typeFilters = [
    { key: "all", label: "全て" },
    { key: "consume", label: "消費" },
    { key: "mount", label: "装着" },
    { key: "snapshot", label: "スナップショット" }
  ];
  let activeType = "all";
  typeFilters.forEach(tf => {
    const btn = document.createElement("button");
    btn.textContent = tf.label;
    if (tf.key === "all") btn.classList.add("active");
    btn.addEventListener("click", () => {
      activeType = tf.key;
      filterBar.querySelectorAll("button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderTable();
    });
    filterBar.appendChild(btn);
  });
  div.appendChild(filterBar);

  const scrollWrap = document.createElement("div");
  scrollWrap.className = "scrollable-body";
  scrollWrap.className = "scroll-box";
  const table = document.createElement("table");
  table.className = "fixed-header sortable-table";
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>日時</th><th>スプール</th><th>印刷ジョブ</th><th style='text-align:right'>使用量</th><th style='text-align:right'>残量</th><th>種別</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);
  scrollWrap.appendChild(table);
  div.appendChild(scrollWrap);

  /** スプールIDからスプール情報を取得（削除済み含む） */
  function findSpool(id) {
    return monitorData.filamentSpools.find(s => s.id === id) || null;
  }

  /** 使用履歴レコードの種別を判定する */
  function getRecordType(u) {
    if (u.isSnapshot) return "snapshot";
    if (u.usedLength != null) return "consume";
    if (u.startLength != null) return "mount";
    return "unknown";
  }

  /** 種別の日本語ラベルを返す */
  function getTypeLabel(type) {
    switch (type) {
      case "snapshot": return "スナップショット";
      case "consume": return "消費";
      case "mount": return "装着";
      default: return "不明";
    }
  }

  /** 印刷ジョブIDからジョブ名を解決する */
  function resolveJobName(jobId) {
    if (!jobId) return "";
    // 各ホストの historyData からジョブ名を探す
    for (const host of Object.keys(monitorData.machines)) {
      const machine = monitorData.machines[host];
      if (!machine || !Array.isArray(machine.historyData)) continue;
      const entry = machine.historyData.find(h => h.id === jobId);
      if (entry) {
        return entry.name || entry.filename || jobId;
      }
    }
    return jobId;
  }

  function renderTable() {
    tbody.innerHTML = "";
    const history = [...(monitorData.usageHistory || [])].reverse();

    history.forEach(u => {
      const type = getRecordType(u);

      // 種別フィルタ
      if (activeType !== "all" && type !== activeType) return;

      const tr = document.createElement("tr");

      // 日時
      const timeTd = document.createElement("td");
      const t = new Date(Number(u.startedAt || u.timestamp || 0));
      timeTd.textContent = t.toLocaleString();
      tr.appendChild(timeTd);

      // スプール情報
      const spoolTd = document.createElement("td");
      const sp = findSpool(u.spoolId);
      if (sp) {
        const colorSwatch = `<span class="color-swatch color-swatch-sm" style="background:${sp.filamentColor || sp.color || "#ccc"}"></span>`;
        spoolTd.innerHTML = `${formatSpoolDisplayId(sp)} ${colorSwatch}${sp.name || ""}`;
      } else {
        spoolTd.textContent = u.spoolId || "";
      }
      tr.appendChild(spoolTd);

      // 印刷ジョブ
      const jobTd = document.createElement("td");
      const rawJobId = u.jobId || u.startPrintID || "";
      jobTd.textContent = resolveJobName(rawJobId);
      jobTd.title = rawJobId; // ホバーで内部IDを表示
      tr.appendChild(jobTd);

      // 使用量
      const usedTd = document.createElement("td");
      usedTd.style.textAlign = "right";
      usedTd.textContent = u.usedLength != null ? formatFilamentAmount(u.usedLength, sp).display : "--";
      tr.appendChild(usedTd);

      // 残量
      const remainTd = document.createElement("td");
      remainTd.style.textAlign = "right";
      const remVal = u.currentLength ?? u.startLength ?? null;
      remainTd.textContent = remVal != null ? formatFilamentAmount(remVal, sp).display : "--";
      tr.appendChild(remainTd);

      // 種別
      const typeTd = document.createElement("td");
      typeTd.textContent = getTypeLabel(type);
      tr.appendChild(typeTd);

      tbody.appendChild(tr);
    });
  }

  renderTable();
  return div;
}

// ═══════════════════════════════════════════════════════════════
// Tab 4: 集計レポート（既存維持）
// ═══════════════════════════════════════════════════════════════

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

  // ── データ集計 ───────────────────────────────
  const dailyMap = {};
  const weeklyMap = {};
  const monthlyMap = {};
  const materialMap = {};     // 素材別消費量
  const materialCostMap = {}; // 素材別コスト
  let totalMm = 0, totalCost = 0, totalPrints = 0;

  (monitorData.usageHistory || []).forEach(u => {
    const used = Number(u.usedLength || 0);
    if (used <= 0) return;
    totalMm += used;

    const dateObj = new Date(Number(u.startedAt || 0));
    const dayKey = dateObj.toISOString().slice(0, 10);
    if (!dailyMap[dayKey]) dailyMap[dayKey] = { ids: new Set(), len: 0, cost: 0 };
    dailyMap[dayKey].ids.add(u.spoolId);
    dailyMap[dayKey].len += used;

    // スプール情報でコスト・素材を集計
    const spool = getSpoolById(u.spoolId);
    const mat = spool?.materialName || spool?.material || "不明";
    materialMap[mat] = (materialMap[mat] || 0) + used;

    let entryCost = 0;
    if (spool?.purchasePrice > 0 && spool?.totalLengthMm > 0) {
      entryCost = (used / spool.totalLengthMm) * spool.purchasePrice;
      dailyMap[dayKey].cost += entryCost;
      totalCost += entryCost;
      materialCostMap[mat] = (materialCostMap[mat] || 0) + entryCost;
    }

    const wKey = formatWeekKey(dateObj);
    weeklyMap[wKey] = (weeklyMap[wKey] || 0) + used;

    const mKey = formatMonthKey(dateObj);
    monthlyMap[mKey] = (monthlyMap[mKey] || 0) + used;
  });

  // 印刷回数（消費エントリ数）
  totalPrints = (monitorData.usageHistory || []).filter(u => Number(u.usedLength || 0) > 0).length;

  const currency = getSpools(false).find(s => s.currencySymbol)?.currencySymbol || "¥";

  // ── 0) サマリカード ─────────────────────────────────
  const summaryDiv = document.createElement("div");
  summaryDiv.className = "summary-grid";
  const summaryItems = [
    { label: "総消費量", value: formatFilamentAmount(totalMm).display },
    { label: "推定総コスト", value: `${currency}${Math.round(totalCost).toLocaleString()}` },
    { label: "消費記録数", value: `${totalPrints}回` },
    { label: "素材種類", value: `${Object.keys(materialMap).length}種` }
  ];
  for (const item of summaryItems) {
    const card = document.createElement("div");
    card.className = "summary-card";
    card.innerHTML = `<div class="summary-card-label">${item.label}</div><div class="summary-card-value">${item.value}</div>`;
    summaryDiv.appendChild(card);
  }
  div.appendChild(summaryDiv);

  // ── 1) 素材別内訳 ─────────────────────────────────
  if (Object.keys(materialMap).length > 0) {
    const matFs = document.createElement("fieldset");
    matFs.className = "analysis-fieldset";
    matFs.innerHTML = "<legend style='font-weight:bold'>素材別内訳</legend>";
    const matTable = document.createElement("table");
    matTable.style.width = "100%";
    matTable.innerHTML = `<thead><tr><th>素材</th><th style="text-align:right">消費量</th><th style="text-align:right">比率</th><th style="text-align:right">推定コスト</th></tr></thead>`;
    const matTbody = document.createElement("tbody");
    Object.entries(materialMap)
      .sort((a, b) => b[1] - a[1])
      .forEach(([mat, mm]) => {
        const pct = totalMm > 0 ? ((mm / totalMm) * 100).toFixed(1) : "0";
        const cost = materialCostMap[mat] || 0;
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${mat}</td><td style="text-align:right">${formatFilamentAmount(mm).display}</td><td style="text-align:right">${pct}%</td><td style="text-align:right">${currency}${Math.round(cost).toLocaleString()}</td>`;
        matTbody.appendChild(tr);
      });
    matTable.appendChild(matTbody);
    matFs.appendChild(matTable);
    div.appendChild(matFs);
  }

  // ── 2) スプール枯渇予測 ─────────────────────────────
  const activeSpools = getSpools(false).filter(s => {
    const st = getSpoolState(s);
    return st === SPOOL_STATE.MOUNTED || st === SPOOL_STATE.STORED;
  });
  if (activeSpools.length > 0) {
    const predFs = document.createElement("fieldset");
    predFs.className = "analysis-fieldset";
    predFs.innerHTML = "<legend style='font-weight:bold'>スプール消費予測</legend>";
    const predTable = document.createElement("table");
    predTable.style.width = "100%";
    predTable.innerHTML = `<thead><tr><th>スプール</th><th>素材</th><th style="text-align:right">残量</th><th style="text-align:right">残印刷数</th><th style="text-align:right">残日数</th><th style="text-align:right">コスト残</th></tr></thead>`;
    const predTbody = document.createElement("tbody");
    for (const sp of activeSpools) {
      const a = buildSpoolAnalytics(sp.id);
      if (!a) continue;
      const remainFmt = formatFilamentAmount(a.remainMm, sp);
      const remainPct = a.totalMm > 0 ? ((a.remainMm / a.totalMm) * 100).toFixed(0) : "?";
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${formatSpoolDisplayId(sp)} ${sp.name || ""}</td>` +
        `<td>${a.material}</td>` +
        `<td style="text-align:right">${remainFmt.display} (${remainPct}%)</td>` +
        `<td style="text-align:right">${a.estimatedRemainingPrints != null ? `約${a.estimatedRemainingPrints}回` : "—"}</td>` +
        `<td style="text-align:right">${a.estimatedRemainingDays != null ? `約${a.estimatedRemainingDays}日` : "—"}</td>` +
        `<td style="text-align:right">${a.price > 0 ? `${a.currency}${Math.round(a.remainingCost).toLocaleString()}` : "—"}</td>`;
      predTbody.appendChild(tr);
    }
    predTable.appendChild(predTbody);
    predFs.appendChild(predTable);
    div.appendChild(predFs);
  }

  // ── 3) 日別集計テーブル ───────────────────────────────
  const table = document.createElement("table");
  table.style.width = "100%";
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>日付</th><th style='text-align:right'>スプール数</th><th style='text-align:right'>消費量</th><th style='text-align:right'>推定コスト</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");

  Object.entries(dailyMap)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .forEach(([d, info]) => {
      const tr = document.createElement("tr");
      const fmtLen = formatFilamentAmount(info.len);
      tr.innerHTML = `<td>${d}</td><td style="text-align:right">${info.ids.size}</td><td style="text-align:right">${fmtLen.display}</td><td style="text-align:right">${info.cost > 0 ? `${currency}${Math.round(info.cost).toLocaleString()}` : "—"}</td>`;
      tbody.appendChild(tr);
    });
  table.appendChild(tbody);
  div.appendChild(table);

  // ── 4) 週次・月次チャート ─────────────────
  const weekCanvas = document.createElement("canvas");
  weekCanvas.className = "chart-constrained-lg";
  div.appendChild(weekCanvas);

  const monthCanvas = document.createElement("canvas");
  monthCanvas.className = "chart-constrained-lg";
  div.appendChild(monthCanvas);

  if (typeof Chart !== "undefined") {
    // 素材別の週次消費データを構築
    const weekKeys = Object.keys(weeklyMap).sort();
    const matColors = { PLA: "#f97316", PETG: "#3b82f6", ABS: "#ef4444", TPU: "#a855f7" };
    const matKeys = Object.keys(materialMap);

    // 週次: 素材別スタック棒グラフ
    const weeklyMatData = {};
    (monitorData.usageHistory || []).forEach(u => {
      const used = Number(u.usedLength || 0);
      if (used <= 0) return;
      const wKey = formatWeekKey(new Date(Number(u.startedAt || 0)));
      const spool = getSpoolById(u.spoolId);
      const mat = spool?.materialName || spool?.material || "不明";
      if (!weeklyMatData[mat]) weeklyMatData[mat] = {};
      weeklyMatData[mat][wKey] = (weeklyMatData[mat][wKey] || 0) + used;
    });

    const weekDatasets = matKeys.map((mat, i) => ({
      label: mat,
      data: weekKeys.map(w => (weeklyMatData[mat]?.[w] || 0) / 1000),
      backgroundColor: matColors[mat] || `hsl(${i * 60}, 60%, 55%)`
    }));

    new Chart(weekCanvas.getContext("2d"), {
      type: "bar",
      data: { labels: weekKeys, datasets: weekDatasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: { x: { stacked: true }, y: { stacked: true, title: { display: true, text: "消費量 (m)" } } }
      }
    });

    // 月次: 素材別円グラフ
    new Chart(monthCanvas.getContext("2d"), {
      type: "pie",
      data: {
        labels: matKeys.map(m => `${m} ${formatFilamentAmount(materialMap[m]).m}m`),
        datasets: [{
          data: matKeys.map(m => materialMap[m]),
          backgroundColor: matKeys.map((m, i) => matColors[m] || `hsl(${i * 60}, 60%, 55%)`)
        }]
      },
      options: { responsive: true, maintainAspectRatio: false }
    });
  }

  return div;
}

// ═══════════════════════════════════════════════════════════════
// エディタ（非表示タブ、既存維持）
// ═══════════════════════════════════════════════════════════════

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

  const preview = createFilamentPreview(prevBox, { ...DEFAULT_PREVIEW_OPTIONS });

  let current = null;
  let isNew = false;
  let dirty = false;

  form.addEventListener("input", () => { dirty = true; });

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
    matColorIn.value = d.colorName || d.materialColorName || "";
    linkIn.value = d.purchaseLink || "";
    curSel.value = d.currencySymbol || DEFAULT_FILAMENT_DATA.currencySymbol;
    priceIn.value = d.purchasePrice || d.price || 0;
    presetIn.value = d.presetId || "";
    noteIn.value = d.note || "";
    favIn.checked = !!d.isFavorite;
    dirty = false;

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
      colorName: matColorIn.value,
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
      colorName: matColorIn.value,
      materialColorCode: colorIn.value,
      purchaseLink: linkIn.value,
      purchasePrice: Number(priceIn.value) || 0,
      currencySymbol: curSel.value,
      presetId: presetIn.value || null,
      note: noteIn.value,
      isFavorite: favIn.checked
    };
    if (isNew) addSpool(data); else updateSpool(current.id, data);
    showAlert("フィラメントを保存しました", "success");
    dirty = false;
    onDone();
  });

  cancelBtn.addEventListener("click", async () => {
    if (dirty) {
      const ok = await showConfirmDialog({
        level: "warn",
        title: "確認",
        message: "保存せずに戻りますか?",
        confirmText: "はい",
        cancelText: "いいえ"
      });
      if (!ok) return;
    }
    onDone();
  });

  return {
    el: div,
    setSpool(sp = {}, fresh = false) {
      current = sp;
      isNew = fresh || !sp.id;
      fillForm(sp);
    }
  };
}

// ═══════════════════════════════════════════════════════════════
// メインモーダル
// ═══════════════════════════════════════════════════════════════

/**
 * フィラメント管理モーダルを表示する。
 *
 * @function showFilamentManager
 * @param {number} [activeIdx=0] - 初期表示タブインデックス
 * @param {string} [hostname] - 対象ホスト名
 * @returns {void}
 */
export function showFilamentManager(activeIdx = 0, hostname) {
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
  closeBtn.textContent = "\u00D7";
  closeBtn.addEventListener("click", () => overlay.remove());
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const tabBar = document.createElement("div");
  tabBar.className = "filament-manager-tabs";

  const SPOOL_LIST_IDX = 2;
  const tabs = [
    "ダッシュボード",
    "在庫・プリセット",
    "スプール一覧",
    "使用履歴",
    "集計レポート"
  ];

  let switchTab = () => {};

  // エディタ（非表示タブ、index 5）
  const editTab = createEditorContent(() => {
    registered.render();
    switchTab(SPOOL_LIST_IDX);
  });

  // ダッシュボード（Tab 0）
  const dashboardTab = createDashboardContent(hostname, idx => switchTab(idx));

  // 使用履歴（Tab 3）
  const historyEl = createHistoryContent();

  // contents 配列：0=ダッシュボード, 1=在庫プリセット, 2=スプール一覧, 3=使用履歴, 4=レポート, 5=エディタ(非表示)
  const contents = [
    dashboardTab.el,
    null, // 在庫プリセット（後で設定）
    null, // スプール一覧（後で設定）
    historyEl,
    createReportContent(),
    editTab.el
  ];

  // スプール一覧（Tab 2）
  const registered = createRegisteredContent((sp, refresh) => {
    editTab.setSpool(sp || {}, !sp);
    switchTab(contents.length - 1); // エディタタブへ
    if (refresh) refresh();
  }, hostname);

  // 在庫・プリセット（Tab 1）
  const invPresetTab = createInventoryPresetContent(hostname, idx => switchTab(idx), () => registered.render());

  contents[1] = invPresetTab.el;
  contents[SPOOL_LIST_IDX] = registered.el;

  const contentWrap = document.createElement("div");
  contentWrap.className = "fm-content-wrap";
  modal.appendChild(tabBar);
  modal.appendChild(contentWrap);

  switchTab = function (idx) {
    tabBar.querySelectorAll("button").forEach((b, i) => {
      b.classList.toggle("active", i === idx);
    });
    contents.forEach((c, i) => {
      if (!c) return;
      if (i === idx) {
        c.style.display = "flex";
        c.style.flexDirection = "column";
      } else {
        c.style.display = "none";
      }
    });
    // ダッシュボードタブに切り替えた場合は再描画
    if (idx === 0) dashboardTab.render();
  };

  // 可視タブボタンの生成（エディタタブは非表示）
  tabs.forEach((name, i) => {
    const btn = document.createElement("button");
    btn.textContent = name;
    if (i === activeIdx) btn.classList.add("active");
    btn.addEventListener("click", () => switchTab(i));
    tabBar.appendChild(btn);
  });

  contents.forEach((c, i) => {
    if (!c) return;
    if (i !== activeIdx) c.style.display = "none";
    contentWrap.appendChild(c);
  });

  document.body.appendChild(overlay);
  switchTab(activeIdx);
}

