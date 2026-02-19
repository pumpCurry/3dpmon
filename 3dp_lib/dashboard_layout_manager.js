/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 レイアウト管理モジュール
 * @file dashboard_layout_manager.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_layout_manager
 *
 * 【機能内容サマリ】
 * - ダッシュボードプリセット切り替え（1ペイン / 2ペイン）
 * - ペイン-プリンタ割り当て管理
 * - プリンタカラーの CSS 変数適用
 *
 * 【公開関数一覧】
 * - {@link setLayout}：レイアウトプリセットを切り替える
 * - {@link assignPrinterToPane}：ペインにプリンタを割り当てる
 * - {@link applyPrinterColor}：ペイン要素にプリンタカラーを適用する
 * - {@link restoreLayout}：保存済みレイアウトを復元する
 * - {@link showLayoutSelectDialog}：レイアウト選択ダイアログを開く
 *
 * @version 1.400.001 (PR #303)
 * @since   1.400.001 (PR #303)
 * @lastModified 2025-07-04 10:30:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

import { monitorData } from "./dashboard_data.js";
import { saveUnifiedStorage } from "./dashboard_storage.js";

// ---------------------------------------------------------------------------
// レイアウトプリセット定義
// ---------------------------------------------------------------------------

/**
 * 利用可能なレイアウトプリセット
 * @type {Array<{id:string, label:string, icon:string, panes:number}>}
 */
const LAYOUT_PRESETS = [
  { id: "preset1", label: "1 台表示",   icon: "⬛",       panes: 1 },
  { id: "preset2", label: "2 台並列",   icon: "⬛⬛",    panes: 2 }
];

// ---------------------------------------------------------------------------
// レイアウト切り替え
// ---------------------------------------------------------------------------

/**
 * ダッシュボードのレイアウトプリセットを切り替えます。
 *
 * @param {string} layoutName - レイアウト名 ("preset1" | "preset2")
 * @returns {void}
 */
export function setLayout(layoutName) {
  const root = document.getElementById("dashboard-root");
  if (!root) {
    console.warn("setLayout: #dashboard-root が見つかりません");
    return;
  }

  // 既存の layout-xxx クラスをすべて除去
  root.classList.forEach(cls => {
    if (cls.startsWith("layout-")) root.classList.remove(cls);
  });
  root.classList.add(`layout-${layoutName}`);

  monitorData.appSettings.activeLayout = layoutName;
  saveUnifiedStorage();

  // 2ペインモード時はペイン2も初期化済みの色を適用
  if (layoutName === "preset2") {
    _applyAllPaneColors();
  }

  // レイアウト切り替えイベントを発行（将来拡張用）
  document.dispatchEvent(new CustomEvent("dashboard:layout-changed", {
    detail: { layout: layoutName }
  }));
}

// ---------------------------------------------------------------------------
// ペイン-プリンタ割り当て
// ---------------------------------------------------------------------------

/**
 * ペインにプリンタを割り当て、カラーを適用します。
 *
 * @param {number|string} paneIndex - ペイン番号 (1 or 2)
 * @param {string|null}   connectionId - 接続 ID (null で割り当て解除)
 * @returns {void}
 */
export function assignPrinterToPane(paneIndex, connectionId) {
  const pa = monitorData.appSettings.paneAssignment;
  if (!pa) {
    monitorData.appSettings.paneAssignment = {};
  }
  monitorData.appSettings.paneAssignment[paneIndex] = connectionId;
  saveUnifiedStorage();

  const paneEl = document.getElementById(`pane-${paneIndex}`);
  if (!paneEl) return;

  if (!connectionId) {
    // 割り当て解除 → デフォルトカラーに戻す
    paneEl.style.removeProperty("--printer-color");
    paneEl.style.removeProperty("--printer-color-faint");
    return;
  }

  const conn = (monitorData.appSettings.connections || []).find(c => c.id === connectionId);
  if (conn) {
    applyPrinterColor(paneEl, conn.color);
  }

  // ペインのセレクタを更新
  _updatePaneSelectorValue(paneIndex, connectionId);
}

// ---------------------------------------------------------------------------
// カラー適用
// ---------------------------------------------------------------------------

/**
 * ペイン要素にプリンタカラーを CSS 変数として適用します。
 *
 * @param {HTMLElement} paneEl - ペイン DOM 要素
 * @param {string}      color  - カラーコード (#rrggbb)
 * @returns {void}
 */
export function applyPrinterColor(paneEl, color) {
  if (!paneEl || !color) return;
  paneEl.style.setProperty("--printer-color",       color);
  paneEl.style.setProperty("--printer-color-faint", color + "1a");
}

/**
 * 全ペインのカラーを保存済み割り当てから再適用します。
 * @private
 */
function _applyAllPaneColors() {
  const pa = monitorData.appSettings.paneAssignment || {};
  for (const [pane, connId] of Object.entries(pa)) {
    if (!connId) continue;
    const conn = (monitorData.appSettings.connections || []).find(c => c.id === connId);
    if (!conn) continue;
    const paneEl = document.getElementById(`pane-${pane}`);
    if (paneEl) applyPrinterColor(paneEl, conn.color);
  }
}

// ---------------------------------------------------------------------------
// ペインセレクタ更新
// ---------------------------------------------------------------------------

/**
 * ページ内の全ペインセレクタを接続一覧で更新します。
 * @returns {void}
 */
export function updatePaneSelectors() {
  const connections = monitorData.appSettings.connections || [];
  const pa = monitorData.appSettings.paneAssignment || {};

  for (const pane of [1, 2]) {
    const sel = document.querySelector(`.pane-printer-select[data-pane="${pane}"]`);
    if (!sel) continue;

    sel.innerHTML = `<option value="">-- 未割り当て --</option>` +
      connections.map(c =>
        `<option value="${c.id}" ${pa[pane] === c.id ? "selected" : ""}>${c.name || c.ip}</option>`
      ).join("");

    // 変更時に assignPrinterToPane を呼ぶ
    if (!sel.dataset.bound) {
      sel.dataset.bound = "1";
      sel.addEventListener("change", () => {
        assignPrinterToPane(pane, sel.value || null);
      });
    }
  }
}

/**
 * 指定ペインのセレクタ選択値を更新します。
 * @private
 */
function _updatePaneSelectorValue(paneIndex, connectionId) {
  const sel = document.querySelector(`.pane-printer-select[data-pane="${paneIndex}"]`);
  if (sel) sel.value = connectionId || "";
}

// ---------------------------------------------------------------------------
// レイアウト復元
// ---------------------------------------------------------------------------

/**
 * 保存済みレイアウト設定を復元します。
 * DOMContentLoaded 後に一度だけ呼び出します。
 *
 * @returns {void}
 */
export function restoreLayout() {
  const layout = monitorData.appSettings.activeLayout || "preset1";
  setLayout(layout);

  // ペインセレクタを接続一覧で埋める
  updatePaneSelectors();

  // 保存済み割り当てのカラーを適用
  _applyAllPaneColors();
}

// ---------------------------------------------------------------------------
// レイアウト選択ダイアログ
// ---------------------------------------------------------------------------

/**
 * レイアウト選択ダイアログを表示します。
 * グローバルメニューの「ダッシュボード選択...」から呼ばれます。
 *
 * @returns {void}
 */
export function showLayoutSelectDialog() {
  // 既存ダイアログがあれば閉じる
  document.querySelector("dialog.layout-select-dialog")?.remove();

  const dialog = document.createElement("dialog");
  dialog.className = "layout-select-dialog";
  dialog.setAttribute("aria-label", "ダッシュボード選択");

  const current = monitorData.appSettings.activeLayout || "preset1";

  dialog.innerHTML = `
    <div class="layout-select-header">
      <h2>ダッシュボード選択</h2>
      <button class="layout-close-btn" aria-label="閉じる">×</button>
    </div>
    <div class="layout-options">
      ${LAYOUT_PRESETS.map(p => `
        <button class="layout-option-btn ${p.id === current ? "active" : ""}" data-layout="${p.id}">
          <span class="layout-option-icon">${p.icon}</span>
          <span class="layout-option-label">${p.label}</span>
        </button>
      `).join("")}
    </div>
  `;

  dialog.querySelector(".layout-close-btn")
    ?.addEventListener("click", () => { dialog.close(); dialog.remove(); });

  dialog.querySelectorAll(".layout-option-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      setLayout(btn.dataset.layout);
      updatePaneSelectors();
      dialog.close();
      dialog.remove();
    });
  });

  dialog.addEventListener("click", e => {
    if (e.target === dialog) { dialog.close(); dialog.remove(); }
  });

  document.body.appendChild(dialog);
  dialog.showModal();
}