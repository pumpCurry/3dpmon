/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 パネル追加メニュー モジュール
 * @file dashboard_panel_menu.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_panel_menu
 *
 * 【機能内容サマリ】
 * - サイドメニューUIで利用可能なパネルを一覧表示
 * - 接続中のホスト一覧と組み合わせてパネルを追加
 * - パネルメニューの開閉制御
 *
 * 【公開関数一覧】
 * - {@link initPanelMenu}：パネルメニューを初期化
 * - {@link openPanelMenu}：パネルメニューを開く
 * - {@link closePanelMenu}：パネルメニューを閉じる
 * - {@link updatePanelMenuHosts}：接続ホスト一覧を更新
 *
 * @version 1.390.783 (PR #366)
 * @since   1.390.783 (PR #366)
 * @lastModified 2026-03-10 23:45:00
 * -----------------------------------------------------------
 * @todo
 * - ドラッグ&ドロップによるパネル追加
 */

"use strict";

import { getPanelTypes, addPanel, removePanel, isActivePanelId, getActivePanelEntries, getGrid, unlockAllPanels, setPanelFontSize, getLayoutTemplates, applyLayoutTemplate } from "./dashboard_panel_factory.js";
import { startCameraStream, stopCameraStream } from "./dashboard_camera_ctrl.js";
import { monitorData } from "./dashboard_data.js";

/**
 * メニュー要素の参照
 * @type {HTMLElement|null}
 */
let menuEl = null;

/**
 * 接続中ホスト一覧
 * @type {string[]}
 */
let connectedHosts = [];

/**
 * パネルメニューを初期化し、DOM に挿入する。
 *
 * 【詳細説明】
 * - メニューのHTML構造を動的に生成
 * - タイトルバーにトグルボタンを追加
 * - 各パネル種別ごとに追加ボタンを生成
 *
 * @function initPanelMenu
 * @returns {void}
 */
export function initPanelMenu() {
  /* メニュー本体を生成 */
  menuEl = document.createElement("div");
  menuEl.className = "panel-menu";
  menuEl.id = "panel-menu";
  menuEl.innerHTML = `
    <div class="panel-menu-header">
      <span>パネル管理</span>
      <button class="panel-menu-close" id="panel-menu-close-btn">×</button>
    </div>
    <div class="panel-menu-body" id="panel-menu-body"></div>
  `;
  document.body.appendChild(menuEl);

  /* 閉じるボタン */
  document.getElementById("panel-menu-close-btn")
    ?.addEventListener("click", closePanelMenu);

  /* トグルボタン: トップメニューバー内の既存ボタン、またはタイトルバーに動的生成 */
  const existingToggle = document.getElementById("panel-menu-toggle");
  if (existingToggle) {
    existingToggle.addEventListener("click", togglePanelMenu);
  } else {
    const titleRight = document.querySelector(".title-bar .right");
    if (titleRight) {
      const btn = document.createElement("button");
      btn.id = "panel-menu-toggle";
      btn.textContent = "\uFF0B\u30D1\u30CD\u30EB";
      btn.addEventListener("click", togglePanelMenu);
      titleRight.prepend(btn);
    }
  }

  /* メニュー内容を描画 */
  _renderMenuBody();
}

/**
 * パネルメニューを開く。
 *
 * @function openPanelMenu
 * @returns {void}
 */
export function openPanelMenu() {
  if (menuEl) {
    _renderMenuBody();
    menuEl.classList.add("open");
  }
}

/**
 * パネルメニューを閉じる。
 *
 * @function closePanelMenu
 * @returns {void}
 */
export function closePanelMenu() {
  if (menuEl) {
    menuEl.classList.remove("open");
  }
}

/**
 * パネルメニューの開閉をトグルする。
 *
 * @private
 * @function togglePanelMenu
 * @returns {void}
 */
function togglePanelMenu() {
  if (menuEl?.classList.contains("open")) {
    closePanelMenu();
  } else {
    openPanelMenu();
  }
}

/**
 * 接続中ホスト一覧を更新する。
 * 接続/切断イベント発生時に呼び出す。
 *
 * @function updatePanelMenuHosts
 * @param {string[]} hosts - 接続中ホスト名の配列
 * @returns {void}
 */
export function updatePanelMenuHosts(hosts) {
  connectedHosts = [...hosts];
  if (menuEl?.classList.contains("open")) {
    _renderMenuBody();
  }
}

/* ─── 内部ヘルパー ─── */

/**
 * メニュー本体の内容を描画する。
 *
 * 【詳細説明】
 * - パネル種別を「ホスト別」と「共通」に分類
 * - ホスト別パネルは接続中ホストごとに追加ボタンを生成
 * - 共通パネルは1つだけ追加ボタンを生成
 *
 * @private
 * @function _renderMenuBody
 * @returns {void}
 */
function _renderMenuBody() {
  const body = document.getElementById("panel-menu-body");
  if (!body) return;

  const types = getPanelTypes();
  const activeEntries = getActivePanelEntries();

  /*
   * メニュー構築の方針：
   * 1. 接続中ホストとグリッド上ホストの和集合でセクションを構成
   * 2. 各セクション内で、パネル種別ごとにトグル表示
   *
   * ※ "shared" パネルは接続前の初期状態で使用される。
   *    プリンタ接続時に migratePanelsToHost() で自動移行されるため、
   *    通常の運用では "shared" は残らない。
   */

  /* グリッド上のパネルが所属するホスト一覧を収集 */
  const activeHostsFromGrid = new Set();
  for (const [, entry] of activeEntries) {
    activeHostsFromGrid.add(entry.host);
  }

  /* メニューに表示するホスト別セクションを決定:
     接続中ホスト + グリッド上ホスト + 保存済みホスト名 の和集合（重複排除）
     これにより、未接続でも保存済みのプリンタのパネルを管理できる。 */
  const menuHosts = [];
  const seen = new Set();

  /* 1) 接続中ホスト優先 */
  for (const h of connectedHosts) {
    if (h !== "shared" && !seen.has(h)) {
      menuHosts.push(h);
      seen.add(h);
    }
  }
  /* 2) グリッド上にあるが接続中でないホスト（切断済みパネルが残っている場合） */
  for (const h of activeHostsFromGrid) {
    if (!seen.has(h)) {
      menuHosts.push(h);
      seen.add(h);
    }
  }
  /* 3) connectionTargets に保存済みのホスト名（未接続でも表示）
        ホスト名が未確定（空文字）の場合はスキップ */
  const savedTargets = monitorData.appSettings.connectionTargets || [];
  for (const t of savedTargets) {
    const h = t.hostname;
    if (h && h !== "shared" && !seen.has(h)) {
      menuHosts.push(h);
      seen.add(h);
    }
  }
  /* 接続も保存もなければメッセージを表示 */
  if (menuHosts.length === 0) {
    body.innerHTML = `<div class="panel-menu-empty">接続中のプリンタがありません。<br>接続設定からプリンタを追加してください。</div>`;
    return;
  }

  const perHostTypes = types.filter(t => t.perHost);
  const sharedTypes  = types.filter(t => !t.perHost);

  let html = "";

  /* ─ ホスト別パネル（表示チェック + ロックを1行に統合）─ */
  for (const host of menuHosts) {
    const isConnected = connectedHosts.includes(host);
    const statusIcon = isConnected ? "\u2705" : "\u26AA";
    // ホストに所属するアクティブパネルを取得
    const hostPanelEntries = activeEntries.filter(([, e]) => e.host === host);
    const hasLockedPanels = hostPanelEntries.some(([, e]) => e.widget?.gridstackNode?.noMove);
    html += `<div class="panel-menu-section">`;
    html += `<div style="display:flex;align-items:center;gap:6px">`;
    html += `<h4 style="flex:1;margin:0">${statusIcon} ${host}</h4>`;
    if (hasLockedPanels) {
      html += `<button class="panel-menu-host-unlock" data-host="${host}" style="font-size:10px;padding:2px 6px;cursor:pointer;border:1px solid #ddd;border-radius:3px" title="この機器のパネルを全解除">🔓全解除</button>`;
    }
    html += `</div>`;
    for (const pt of perHostTypes) {
      const panelId = `${pt.id}:${host}`;
      html += _renderPanelToggle(pt, host, panelId, activeEntries);
    }
    html += `</div>`;
  }

  /* ─ 共通パネル（perHost=false） ─ */
  if (sharedTypes.length > 0) {
    html += `<div class="panel-menu-section">`;
    html += `<h4>共通パネル</h4>`;
    for (const pt of sharedTypes) {
      const panelId = `${pt.id}:shared`;
      html += _renderPanelToggle(pt, "shared", panelId, activeEntries);
    }
    html += `</div>`;
  }

  // レイアウトテンプレートセクション
  html += `<div class="panel-menu-section">`;
  html += `<div class="panel-menu-section-title">📐 レイアウトテンプレート</div>`;
  const templates = getLayoutTemplates();
  for (const tpl of templates) {
    html += `<button class="panel-menu-template-btn" data-template="${tpl.id}" title="${tpl.description}">${tpl.label}</button> `;
  }
  html += `</div>`;

  body.innerHTML = html;

  /* テンプレート適用ボタンのイベント設定 */
  body.querySelectorAll(".panel-menu-template-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const templateId = btn.dataset.template;
      const { showConfirmDialog } = await import("./dashboard_ui_confirm.js");
      const ok = await showConfirmDialog({
        level: "warn",
        title: "レイアウトリセット",
        message: `現在のパネル配置を全て削除し、「${btn.textContent}」テンプレートで再配置します。よろしいですか？`,
        confirmText: "リセット",
        cancelText: "キャンセル"
      });
      if (!ok) return;
      const count = applyLayoutTemplate(templateId);
      const { showAlert } = await import("./dashboard_notification_manager.js");
      showAlert(`レイアウトをリセットしました（${count}パネル）`, "success");
      _renderMenuBody();
    });
  });

  /* 機器別 全解除ボタンのイベント設定 */
  body.querySelectorAll(".panel-menu-host-unlock").forEach(btn => {
    btn.addEventListener("click", () => {
      const host = btn.dataset.host;
      const grid = getGrid();
      if (!grid) return;
      for (const [, entry] of getActivePanelEntries()) {
        if (entry.host !== host) continue;
        grid.update(entry.widget, { noMove: false, noResize: false });
        entry.element?.classList.remove("panel-locked");
        const lockBtn = entry.element?.querySelector(".panel-lock-btn");
        if (lockBtn) { lockBtn.textContent = "📌"; lockBtn.title = "このパネルを固定"; }
      }
      _renderMenuBody();
    });
  });

  /* 個別ロックトグルのイベント設定 (親ボタンの表示トグルと分離) */
  body.querySelectorAll(".panel-row-lock").forEach(btn => {
    btn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault(); // 親ボタンの click 発火を防止
      const panelId = btn.dataset.panelId;
      const entry = getActivePanelEntries().find(([id]) => id === panelId);
      if (!entry) return;
      const [, info] = entry;
      const grid = getGrid();
      if (!grid) return;
      const isLocked = !!(info.widget?.gridstackNode?.noMove);
      grid.update(info.widget, { noMove: !isLocked, noResize: !isLocked });
      info.element?.classList.toggle("panel-locked", !isLocked);
      const headerBtn = info.element?.querySelector(".panel-lock-btn");
      if (headerBtn) {
        headerBtn.textContent = isLocked ? "📌" : "🔒";
        headerBtn.title = isLocked ? "このパネルを固定" : "このパネルの固定を解除";
      }
      _renderMenuBody();
    });
  });

  /* パネル表示トグルのイベント設定 */
  body.querySelectorAll(".panel-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const typeId  = btn.dataset.type;
      const host    = btn.dataset.host;
      const panelId = btn.dataset.panelId;

      if (isActivePanelId(panelId)) {
        removePanel(panelId);
      } else {
        addPanel(typeId, host);
      }
      _renderMenuBody();
    });
  });

  /* フォントサイズスライダーのイベント設定 */
  body.querySelectorAll(".panel-fontsize-range").forEach(slider => {
    slider.addEventListener("input", (e) => {
      e.stopPropagation();
      const panelId = slider.dataset.panelId;
      const size = slider.value + "px";
      setPanelFontSize(panelId, size);
      const valSpan = slider.parentElement?.querySelector(".panel-fontsize-val");
      if (valSpan) valSpan.textContent = size;
    });
  });

  /* カメラ映像ON/OFFサブコントロールのイベント設定 */
  body.querySelectorAll(".camera-stream-toggle").forEach(cb => {
    cb.addEventListener("change", () => {
      const host = cb.dataset.host;
      monitorData.hostCameraToggle[host] = cb.checked;
      if (cb.checked) {
        startCameraStream(host);
      } else {
        stopCameraStream(host);
      }
      _renderMenuBody();
    });
  });
}

/**
 * パネルトグルボタンのHTMLを生成する。
 * カメラパネルには映像ON/OFFサブコントロールを付加する。
 *
 * @private
 * @function _renderPanelToggle
 * @param {object} pt      - パネル種別定義
 * @param {string} host    - ホスト名（実際の addPanel/removePanel に使うホスト）
 * @param {string} panelId - パネルID（shared統合済みの正しいID）
 * @returns {string} HTML文字列
 */
function _renderPanelToggle(pt, host, panelId, activeEntries = []) {
  const active = isActivePanelId(panelId);
  // このパネルのロック状態を取得
  const panelEntry = activeEntries.find(([id]) => id === panelId);
  const isLocked = panelEntry ? !!(panelEntry[1].widget?.gridstackNode?.noMove) : false;

  // 表示チェック + ロックを同一ボタン内に
  let html = "";
  html += `<button class="panel-toggle-btn${active ? " active" : ""}" data-type="${pt.id}" data-host="${host}" data-panel-id="${panelId}" style="display:flex;align-items:center;width:100%">`;
  html += `<span class="panel-toggle-icon">${active ? "\u2611" : "\u2610"}</span>`;
  html += `<span style="flex:1;text-align:left;margin-left:4px">${pt.label}</span>`;
  if (active) {
    html += `<span class="panel-row-lock${isLocked ? " locked" : ""}" data-panel-id="${panelId}" title="${isLocked ? "固定解除" : "固定する"}">${isLocked ? "🔒" : "📌"}</span>`;
  }
  html += `</button>`;
  // フォントサイズ調整 (テキスト主体のパネル向け)
  const fontSizePanels = ["status", "machine-info", "control-temp", "control-cmd", "log"];
  if (active && fontSizePanels.includes(pt.id)) {
    const curSize = panelEntry?.[1]?.element?.style.fontSize || "13px";
    html += `<div class="panel-fontsize-control">`;
    html += `<span>文字</span>`;
    html += `<input type="range" class="panel-fontsize-range" data-panel-id="${panelId}" min="9" max="18" step="1" value="${parseInt(curSize) || 13}">`;
    html += `<span class="panel-fontsize-val">${parseInt(curSize) || 13}px</span>`;
    html += `</div>`;
  }

  /* カメラパネルには映像接続サブコントロールを追加 */
  if (pt.id === "camera") {
    const camOn = !!(monitorData.hostCameraToggle[host] ?? monitorData.appSettings.cameraToggle);
    html += `<div class="panel-sub-control">`;
    html += `<label class="camera-sub-label">`;
    html += `<input type="checkbox" class="camera-stream-toggle" data-host="${host}" ${camOn ? "checked" : ""}>`;
    html += `<span class="camera-sub-icon">${camOn ? "\uD83D\uDFE2" : "\uD83D\uDD34"}</span>`;
    html += ` 映像接続`;
    html += `</label>`;
    html += `</div>`;
  }

  return html;
}
