/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 パネルファクトリ モジュール
 * @file dashboard_panel_factory.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_panel_factory
 *
 * 【機能内容サマリ】
 * - GridStack パネルの生成・管理・破棄
 * - 既存HTMLテンプレートからパネルを複製し、data-host スコープを付与
 * - マルチプリンタ対応：同一パネル種別を複数ホスト分生成可能
 * - パネルレイアウトの保存・復元
 *
 * 【公開関数一覧】
 * - {@link initGridStack}：GridStack グリッドを初期化
 * - {@link addPanel}：パネルをグリッドに追加
 * - {@link removePanel}：パネルをグリッドから削除
 * - {@link removePanelsForHost}：指定ホストの全パネルを削除
 * - {@link saveLayout}：現在のレイアウトを localStorage に保存
 * - {@link restoreLayout}：保存済みレイアウトを復元
 * - {@link getPanelTypes}：利用可能なパネル種別一覧を返す
 * - {@link isActivePanelId}：パネルが表示中かどうかを返す
 * - {@link getActivePanelEntries}：アクティブ全パネルの一覧を返す
 * - {@link getGrid}：GridStack インスタンスを返す
 * - {@link migratePanelsToHost}：shared パネルを指定ホストに移行
 * - {@link renamePanelsHost}：旧ホスト名パネルを新ホスト名に移行（IP→機器名）
 * - {@link ensureHostPanels}：ホスト用デフォルトパネルを生成
 * - {@link updateAllPanelHeaders}：全パネルヘッダーの色・ホスト名を再描画
 *
 * @version 1.390.783 (PR #366)
 * @since   1.390.783 (PR #366)
 * @lastModified 2026-03-10 21:00:00
 * -----------------------------------------------------------
 * @todo
 * - パネルのタブ化（同一セル内に複数パネルを重ねる）
 * - パネル最小化・最大化
 */

"use strict";

import { initializePanel, destroyPanel } from "./dashboard_panel_init.js";
import { monitorData, PLACEHOLDER_HOSTNAME } from "./dashboard_data.js";
import { registerFieldElements, unregisterFieldElements } from "./dashboard_ui.js";

/* ─── localStorage キー ─── */

/**
 * レイアウト保存用の localStorage キー
 * @constant {string}
 */
const LAYOUT_STORAGE_KEY = "3dpmon_panel_layout_v4";
// v2 → v3 マイグレーション: cellHeight 80→40 に伴い h, y を2倍化
(function migrateLayoutV2toV3() {
  const v2 = localStorage.getItem("3dpmon_panel_layout_v2");
  if (!v2 || localStorage.getItem("3dpmon_panel_layout_v3")) return;
  try {
    const layout = JSON.parse(v2);
    if (!Array.isArray(layout)) return;
    const migrated = layout.map(item => ({
      ...item,
      y: (item.y || 0) * 2,
      h: (item.h || 4) * 2
    }));
    localStorage.setItem("3dpmon_panel_layout_v3", JSON.stringify(migrated));
    console.info("[layout] v2→v3 マイグレーション完了 (cellHeight 80→40)");
  } catch { /* ignore */ }
})();
// v3 → v4 マイグレーション: column 12→24 に伴い x, w を2倍化
(function migrateLayoutV3toV4() {
  const v3 = localStorage.getItem("3dpmon_panel_layout_v3");
  if (!v3 || localStorage.getItem("3dpmon_panel_layout_v4")) return;
  try {
    const layout = JSON.parse(v3);
    if (!Array.isArray(layout)) return;
    const migrated = layout.map(item => ({
      ...item,
      x: (item.x || 0) * 2,
      w: (item.w || 4) * 2
    }));
    localStorage.setItem("3dpmon_panel_layout_v4", JSON.stringify(migrated));
    console.info("[layout] v3→v4 マイグレーション完了 (column 12→24)");
  } catch { /* ignore */ }
})();

/* ─── パネル種別定義 ─── */

/**
 * 利用可能なパネル種別の定義。
 * templateId は 3dp_monitor.html 内の要素IDに対応する。
 *
 * @typedef {Object} PanelTypeDef
 * @property {string} id            - パネル種別の識別子
 * @property {string} label         - 表示名
 * @property {string} templateId    - HTML内のテンプレート要素ID
 * @property {number} defaultW      - デフォルト幅（グリッド単位）
 * @property {number} defaultH      - デフォルト高さ（グリッド単位）
 * @property {number} minW          - 最小幅
 * @property {number} minH          - 最小高さ
 * @property {boolean} perHost      - ホストごとに複製するかどうか
 */

/**
 * パネル種別定義の配列。
 * 既存HTMLの各カード/セクションに対応する。
 *
 * @constant {PanelTypeDef[]}
 */
// 24列 x cellHeight=40px (旧12列x80px から倍精度化)
// defaultW/minW は旧値の2倍, defaultH/minH も旧80px時代の2倍
const PANEL_TYPES = [
  { id: "camera",        label: "カメラ",           templateId: "panel-tpl-camera",        defaultW: 8,  defaultH: 10, minW: 4, minH: 4,  perHost: true },
  { id: "head-preview",  label: "ヘッド位置プレビュー", templateId: "panel-tpl-head-preview", defaultW: 6,  defaultH: 12, minW: 4, minH: 6,  perHost: true },
  { id: "filament",      label: "フィラメント",      templateId: "panel-tpl-filament",      defaultW: 6,  defaultH: 8,  minW: 4, minH: 4,  perHost: true },
  { id: "status",        label: "状態",             templateId: "panel-tpl-status",         defaultW: 8,  defaultH: 12, minW: 4, minH: 6,  perHost: true },
  { id: "control-cmd",   label: "操作ボタン",        templateId: "panel-tpl-control-cmd",   defaultW: 6,  defaultH: 6,  minW: 4, minH: 4,  perHost: true },
  { id: "control-temp",  label: "温度・ファン制御",   templateId: "panel-tpl-control-temp",  defaultW: 12, defaultH: 12, minW: 6, minH: 6,  perHost: true },
  { id: "temp-graph",    label: "温度グラフ",        templateId: "panel-tpl-temp-graph",    defaultW: 12, defaultH: 8,  minW: 4, minH: 4,  perHost: true },
  { id: "machine-info",  label: "機器情報",          templateId: "panel-tpl-machine-info",  defaultW: 8,  defaultH: 8,  minW: 4, minH: 4,  perHost: true },
  { id: "log",           label: "ログ",             templateId: "panel-tpl-log",            defaultW: 16, defaultH: 8,  minW: 4, minH: 4,  perHost: true },
  { id: "current-print", label: "現在の印刷",        templateId: "panel-tpl-current-print", defaultW: 24, defaultH: 6,  minW: 6, minH: 4,  perHost: true },
  { id: "history",       label: "印刷履歴",          templateId: "panel-tpl-history",       defaultW: 24, defaultH: 10, minW: 6, minH: 4,  perHost: true },
  { id: "file-list",     label: "ファイル一覧",       templateId: "panel-tpl-file-list",    defaultW: 24, defaultH: 10, minW: 6, minH: 4,  perHost: true },
];

/* ─── GridStack インスタンス ─── */

/**
 * GridStack インスタンスの参照
 * @type {object|null}
 */
let grid = null;

/**
 * 生成済みパネルの管理マップ。
 * キーは "{panelTypeId}:{hostname}" 形式。
 *
 * @type {Map<string, {widget: object, element: HTMLElement, host: string, type: string}>}
 */
const activePanels = new Map();

/**
 * restoreLayout でホスト未解決のためスキップされたレイアウト情報。
 * 接続時に ensureHostPanels から参照し、保存済みレイアウトを復元する。
 * @type {Map<string, Array<{panelType: string, x: number, y: number, w: number, h: number}>>}
 */
const _deferredLayouts = new Map();

/**
 * レイアウト復元保留リストにエントリを追加する。
 * @private
 * @param {string} hostname - ホスト名
 * @param {{panelType: string, x: number, y: number, w: number, h: number}} item
 */
function _deferLayout(hostname, item) {
  if (!_deferredLayouts.has(hostname)) {
    _deferredLayouts.set(hostname, []);
  }
  _deferredLayouts.get(hostname).push({
    panelType: item.panelType,
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h
  });
}

/* ─── パネルIDユーティリティ ─── */

/**
 * パネルの一意IDを生成する。
 *
 * @function makePanelId
 * @param {string} typeId   - パネル種別ID
 * @param {string} hostname - ホスト名
 * @returns {string} パネル一意ID
 */
function makePanelId(typeId, hostname) {
  return `${typeId}:${hostname}`;
}

/* ─── 公開API ─── */

/**
 * GridStack グリッドを初期化する。
 *
 * 【詳細説明】
 * - 指定コンテナ内に GridStack を生成
 * - 12カラムグリッド、セル高さ 80px
 * - ドラッグ・リサイズ・フロート有効
 *
 * @function initGridStack
 * @param {string|HTMLElement} container - グリッドコンテナのセレクタまたは要素
 * @returns {object} GridStack インスタンス
 */
export function initGridStack(container) {
  if (grid) {
    return grid;
  }

  const el = typeof container === "string"
    ? document.querySelector(container)
    : container;

  if (!el) {
    throw new Error(`initGridStack: コンテナが見つかりません: ${container}`);
  }

  /* GridStack が CDN/npm からロード済みであることを前提とする */
  grid = GridStack.init({
    column: 24,
    cellHeight: 40,
    float: true,
    animate: true,
    draggable: {
      handle: ".panel-header"
    },
    resizable: {
      handles: "se, s, e"
    },
    removable: false,
    acceptWidgets: true,
    margin: 4
  }, el);

  /* レイアウト変更時に自動保存 */
  grid.on("change", () => {
    saveLayout();
  });

  return grid;
}

/**
 * パネルをグリッドに追加する。
 *
 * 【詳細説明】
 * - PANEL_TYPES から定義を検索
 * - テンプレート要素を複製し、data-host 属性を付与
 * - ID衝突を回避するため、複製内の全IDにホスト名プレフィックスを付加
 * - GridStack ウィジェットとして追加
 *
 * @function addPanel
 * @param {string} typeId   - パネル種別ID（PANEL_TYPES.id）
 * @param {string} hostname            - ホスト名（必須。"shared" は非推奨）
 * @param {object} [posOverride=null]  - 位置指定 {x, y, w, h}
 * @returns {string|null} 生成されたパネルID、失敗時は null
 */
export function addPanel(typeId, hostname, posOverride = null) {
  if (!hostname) {
    console.warn(`addPanel: hostname が未指定です (typeId=${typeId})`);
    return null;
  }
  const typeDef = PANEL_TYPES.find(t => t.id === typeId);
  if (!typeDef) {
    console.warn(`addPanel: 未知のパネル種別: ${typeId}`);
    return null;
  }

  const panelId = makePanelId(typeId, hostname);

  /* 重複チェック */
  if (activePanels.has(panelId)) {
    console.warn(`addPanel: パネル "${panelId}" は既に存在します`);
    return panelId;
  }

  /* テンプレートからDOM複製 */
  const template = document.getElementById(typeDef.templateId);
  if (!template) {
    console.warn(`addPanel: テンプレートが見つかりません: ${typeDef.templateId}`);
    return null;
  }

  const content = template.content
    ? template.content.cloneNode(true)
    : template.cloneNode(true);

  /* パネルラッパー生成
   * ※ grid-stack-item-content クラスは付けない。
   *   GridStack が生成する .grid-stack-item-content の子要素として挿入するため、
   *   二重に付けると overflow: visible !important が競合し高さチェーンが壊れる。 */
  const panelEl = document.createElement("div");
  panelEl.className = "panel-wrapper";
  panelEl.dataset.panelId = panelId;
  panelEl.dataset.panelType = typeId;
  panelEl.dataset.host = hostname;

  /* パネルヘッダー（ドラッグハンドル） */
  const header = document.createElement("div");
  header.className = "panel-header";

  /* ホストに紐づく色設定を取得 */
  const hostConf = _getHostConfig(hostname);
  if (hostConf.color) {
    header.style.background = hostConf.color;
  }

  /* カメラパネルにはトグルスイッチを追加 */
  const cameraToggleHtml = typeId === "camera"
    ? `<label class="panel-header-toggle" title="カメラ ON/OFF">
         <input type="checkbox" id="camera-toggle-title">
         <span class="toggle-slider"></span>
       </label>`
    : "";

  /* ホスト名表示: showHostTag 設定に従う */
  const showTag = monitorData.appSettings.showHostTag !== false;
  const tagText = (showTag && hostname !== "shared")
    ? (hostConf.label || hostname) : "";

  header.innerHTML = `
    <span class="panel-title">${typeDef.label}</span>
    ${cameraToggleHtml}
    <span class="panel-host-tag">${tagText}</span>
    <button class="panel-lock-btn" title="このパネルを固定/解除">📌</button>
    <button class="panel-close-btn" title="パネルを閉じる">×</button>
  `;
  panelEl.appendChild(header);

  /* パネルコンテンツ */
  const body = document.createElement("div");
  body.className = "panel-body";
  body.appendChild(content);
  panelEl.appendChild(body);

  /* GridStack ウィジェットとして追加 */
  const widgetOpts = {
    w: posOverride?.w ?? typeDef.defaultW,
    h: posOverride?.h ?? typeDef.defaultH,
    minW: typeDef.minW,
    minH: typeDef.minH,
    id: panelId,
    content: ""  /* content は手動で設定するため空文字 */
  };

  if (posOverride?.x != null) widgetOpts.x = posOverride.x;
  if (posOverride?.y != null) widgetOpts.y = posOverride.y;

  const widget = grid.addWidget(widgetOpts);

  /* カメラパネルは overflow:hidden が必要なため .grid-stack-item にマーカークラスを追加 */
  if (typeId === "camera") {
    widget.classList.add("gs-camera-panel");
  }

  /* GridStack が生成した .grid-stack-item-content にパネル内容を移動 */
  const gsContent = widget.querySelector(".grid-stack-item-content");
  if (gsContent) {
    gsContent.innerHTML = "";
    gsContent.appendChild(panelEl);
  }

  /* 閉じるボタンのイベント */
  header.querySelector(".panel-close-btn")?.addEventListener("click", () => {
    removePanel(panelId);
  });

  /* 個別ロックボタンのイベント */
  header.querySelector(".panel-lock-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const isLocked = widget.gridstackNode?.noMove;
    grid.update(widget, { noMove: !isLocked, noResize: !isLocked });
    const btn = header.querySelector(".panel-lock-btn");
    btn.textContent = isLocked ? "📌" : "🔒";
    btn.title = isLocked ? "このパネルを固定" : "このパネルの固定を解除";
    panelEl.classList.toggle("panel-locked", !isLocked);
    saveLayout();
  });

  /* 管理マップに登録 */
  activePanels.set(panelId, {
    widget,
    element: panelEl,
    host: hostname,
    type: typeId
  });

  /* パネル初期化関数を呼び出す（イベントリスナーのバインド等）
     ※ _scopeElementIds の前に実行し、init関数が元のIDで要素を取得できるようにする。
     クロージャで保持された要素参照はID変更後も有効。 */
  initializePanel(typeId, body, hostname);

  /* perHost パネルの場合、内部IDを書き換えて衝突を回避
     ※ initializePanel の後に実行し、init関数内の querySelector("#originalId") が動作するようにする */
  if (typeDef.perHost) {
    _scopeElementIds(body, hostname);
  }

  /* data-field 要素をキャッシュに登録（B: 要素キャッシュ、per-host） */
  registerFieldElements(body, hostname);

  return panelId;
}

/**
 * パネルをグリッドから削除する。
 *
 * @function removePanel
 * @param {string} panelId - 削除するパネルID
 * @returns {boolean} 削除成功なら true
 */
export function removePanel(panelId) {
  const entry = activePanels.get(panelId);
  if (!entry) {
    return false;
  }

  /* パネル破棄前のクリーンアップ（タイマー停止等） */
  const body = entry.element.querySelector(".panel-body");
  if (body) {
    /* data-field 要素をキャッシュから除去（B: 要素キャッシュ、per-host） */
    unregisterFieldElements(body, entry.host);
    destroyPanel(entry.type, body, entry.host);
  }

  grid.removeWidget(entry.widget);
  activePanels.delete(panelId);
  saveLayout();
  return true;
}

/**
 * 指定ホストの全パネルを削除する。
 * プリンタ切断時に使用。
 *
 * @function removePanelsForHost
 * @param {string} hostname - 削除対象ホスト名
 * @returns {number} 削除したパネル数
 */
export function removePanelsForHost(hostname) {
  /* 削除対象を先に収集（イテレーション中の削除を避ける） */
  const toRemove = [];
  for (const [id, entry] of activePanels) {
    if (entry.host === hostname) {
      toRemove.push({ id, entry });
    }
  }

  for (const { id, entry } of toRemove) {
    /* パネル破棄前のクリーンアップ（タイマー停止等） */
    const body = entry.element?.querySelector(".panel-body");
    if (body) {
      /* data-field 要素をキャッシュから除去（B: 要素キャッシュ、per-host） */
      unregisterFieldElements(body, entry.host);
      destroyPanel(entry.type, body, entry.host);
    }
    grid.removeWidget(entry.widget);
    activePanels.delete(id);
  }
  return toRemove.length;
}

/** グローバルレイアウトロック状態 */
let _globalLocked = false;

/**
 * 全パネルのドラッグ・リサイズを一括ロック/解除する。
 * @param {boolean} [lock] - true=ロック, false=解除, 省略=トグル
 * @returns {boolean} 新しいロック状態
 */
export function toggleGlobalLock(lock) {
  _globalLocked = lock ?? !_globalLocked;
  if (!grid) return _globalLocked;
  grid.enableMove(!_globalLocked);
  grid.enableResize(!_globalLocked);
  // appSettings に保存
  monitorData.appSettings.layoutLocked = _globalLocked;
  return _globalLocked;
}

/** 現在のグローバルロック状態を返す */
export function isGlobalLocked() { return _globalLocked; }

/**
 * 全パネルの個別ロックを解除する。
 */
/**
 * パネルのフォントサイズを設定する。
 * @param {string} panelId
 * @param {string} size - CSS font-size (例: "12px", "0.9em")
 */
export function setPanelFontSize(panelId, size) {
  const entry = activePanels.get(panelId);
  if (entry?.element) {
    entry.element.style.fontSize = size;
    saveLayout();
  }
}

export function unlockAllPanels() {
  if (!grid) return;
  for (const [, entry] of activePanels) {
    grid.update(entry.widget, { noMove: false, noResize: false });
    entry.element?.classList.remove("panel-locked");
    const lockBtn = entry.element?.querySelector(".panel-lock-btn");
    if (lockBtn) { lockBtn.textContent = "📌"; lockBtn.title = "このパネルを固定"; }
  }
  saveLayout();
}

/**
 * 現在のレイアウトを localStorage に保存する。
 *
 * @function saveLayout
 * @returns {void}
 */
export function saveLayout() {
  if (!grid) return;

  const items = grid.getGridItems();
  const layout = items.map(el => {
    const node = el.gridstackNode;
    const panelWrapper = el.querySelector("[data-panel-id]");
    return {
      panelId: panelWrapper?.dataset.panelId ?? node?.id ?? "",
      panelType: panelWrapper?.dataset.panelType ?? "",
      host: panelWrapper?.dataset.host ?? "",
      x: node?.x ?? 0,
      y: node?.y ?? 0,
      w: node?.w ?? 4,
      h: node?.h ?? 4,
      locked: !!(node?.noMove),
      fontSize: panelWrapper?.style.fontSize || ""
    };
  });

  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch (e) {
    console.warn("saveLayout: localStorage 保存に失敗しました", e);
  }
}

/**
 * 保存済みレイアウトを復元する。
 *
 * @function restoreLayout
 * @returns {boolean} 復元成功なら true
 */
export function restoreLayout() {
  if (!grid) return false;

  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return false;

    const layout = JSON.parse(raw);
    if (!Array.isArray(layout) || layout.length === 0) return false;

    /* 接続先として有効なホスト一覧を構築
       connectionTargets のIPとホスト名、wsDest、および machines キーを含める。
       machines キーは前回接続時のホスト名を保持しているため、
       リロード直後でまだ接続していない状態でもレイアウト復元に必要。 */
    const validHosts = new Set();
    const targets = monitorData.appSettings.connectionTargets || [];
    for (const t of targets) {
      validHosts.add(t.dest.split(":")[0]);
      validHosts.add(t.dest);
      if (t.hostname) validHosts.add(t.hostname);
    }
    if (monitorData.appSettings.wsDest) {
      validHosts.add(monitorData.appSettings.wsDest.split(":")[0]);
      validHosts.add(monitorData.appSettings.wsDest);
    }
    /* machines にあるホスト名（前回接続時に解決済み）も有効とする */
    for (const machineHost of Object.keys(monitorData.machines || {})) {
      if (machineHost && machineHost !== "shared" && machineHost !== "__placeholder__") {
        validHosts.add(machineHost);
      }
    }

    /* 接続先が無い場合はレイアウト復元をスキップ
       （次回接続時に ensureHostPanels で自動生成される） */
    if (validHosts.size === 0) return false;

    /* 既存パネルをすべて削除（data-field キャッシュも解除） */
    for (const [, entry] of activePanels) {
      const body = entry.element?.querySelector(".panel-body");
      if (body) unregisterFieldElements(body, entry.host);
    }
    grid.removeAll();
    activePanels.clear();
    _deferredLayouts.clear();

    /* レイアウトデータからパネルを再生成 */
    for (const item of layout) {
      /* 旧 "settings" パネルは接続モーダルに統合済み → スキップ */
      if (item.panelType === "settings") continue;

      /* 旧 "control" パネルを新しい分割パネルに移行 */
      if (item.panelType === "control") {
        if (!item.host || validHosts.has(item.host)) {
          addPanel("control-cmd", item.host, {
            x: item.x, y: item.y, w: Math.min(item.w, 3), h: Math.min(item.h, 3)
          });
          addPanel("control-temp", item.host, {
            x: item.x, y: item.y + 3, w: item.w, h: Math.max(item.h - 3, 3)
          });
        } else {
          /* control → 分割して保留 */
          _deferLayout(item.host, { panelType: "control-cmd", x: item.x, y: item.y, w: Math.min(item.w, 3), h: Math.min(item.h, 3) });
          _deferLayout(item.host, { panelType: "control-temp", x: item.x, y: item.y + 3, w: item.w, h: Math.max(item.h - 3, 3) });
        }
        continue;
      }

      /* 旧 "history" パネルの場合、file-list パネルが存在しなければ追加 */
      if (item.panelType === "history") {
        const hasFileList = layout.some(
          l => l.panelType === "file-list" && l.host === item.host
        );
        if (!hasFileList) {
          /* 履歴パネルの直下にファイル一覧パネルを挿入 */
          const fileListItem = {
            panelType: "file-list",
            host: item.host,
            x: item.x,
            y: item.y + (item.h || 5),
            w: item.w,
            h: item.h || 5
          };
          if (item.host && !validHosts.has(item.host)) {
            _deferLayout(item.host, fileListItem);
          } else {
            addPanel(fileListItem.panelType, fileListItem.host, {
              x: fileListItem.x, y: fileListItem.y,
              w: fileListItem.w, h: fileListItem.h
            });
          }
        }
      }

      if (item.host && !validHosts.has(item.host)) {
        /* ホストが未解決 → 接続時に復元できるよう保留 */
        _deferLayout(item.host, item);
        console.info(`restoreLayout: ホスト "${item.host}" は未解決のため保留（接続時に復元）`);
        continue;
      }
      const restoredPanelId = addPanel(item.panelType, item.host, {
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h
      });
      // フォントサイズの復元
      if (item.fontSize && restoredPanelId) {
        const entry = activePanels.get(restoredPanelId);
        if (entry?.element) entry.element.style.fontSize = item.fontSize;
      }
      // ロック状態の復元
      if (item.locked && restoredPanelId) {
        const entry = activePanels.get(restoredPanelId);
        if (entry?.widget) {
          grid.update(entry.widget, { noMove: true, noResize: true });
          entry.element?.classList.add("panel-locked");
          const lockBtn = entry.element?.querySelector(".panel-lock-btn");
          if (lockBtn) { lockBtn.textContent = "🔒"; lockBtn.title = "このパネルの固定を解除"; }
        }
      }
    }

    return true;
  } catch (e) {
    console.warn("restoreLayout: 復元に失敗しました", e);
    return false;
  }
}

/**
 * 利用可能なパネル種別一覧を返す。
 *
 * @function getPanelTypes
 * @returns {PanelTypeDef[]} パネル種別定義の配列
 */
export function getPanelTypes() {
  return [...PANEL_TYPES];
}

/**
 * 指定パネルIDが現在アクティブ（表示中）かどうかを返す。
 *
 * @function isActivePanelId
 * @param {string} panelId - "{typeId}:{hostname}" 形式のパネルID
 * @returns {boolean} 表示中なら true
 */
export function isActivePanelId(panelId) {
  return activePanels.has(panelId);
}

/**
 * 現在アクティブな全パネルのエントリ一覧を返す。
 *
 * @function getActivePanelEntries
 * @returns {Array<{panelId: string, type: string, host: string}>}
 */
export function getActivePanelEntries() {
  return [...activePanels.entries()];
}

/**
 * GridStack インスタンスを返す。
 *
 * @function getGrid
 * @returns {object|null} GridStack インスタンス、未初期化時は null
 */
export function getGrid() {
  return grid;
}

/**
 * "shared" パネルを指定ホストのパネルに移行する（レガシー互換）。
 *
 * 【詳細説明】
 * 現在は起動時に shared パネルを生成しないため、通常この関数には到達しない。
 * 旧バージョンの保存レイアウトに shared パネルが残っている場合の互換処理。
 *
 * 移行方式: shared パネルの位置・サイズを記録し、削除→再生成する。
 * ID スコーピングや init 関数の実行を addPanel に委譲することで、
 * 新規作成パネルと同一の初期化パスを保証する。
 *
 * @function migratePanelsToHost
 * @param {string} newHost - 移行先ホスト名
 * @returns {number} 移行したパネル数
 */
export function migratePanelsToHost(newHost) {
  if (!grid || !newHost || newHost === "shared") return 0;

  /* 既にこのホストのパネルが1つでもあれば移行不要 */
  for (const [, entry] of activePanels) {
    if (entry.host === newHost) return 0;
  }

  /* 移行対象の shared パネルを収集（位置・サイズを保存） */
  const toMigrate = [];
  for (const [panelId, entry] of activePanels) {
    if (entry.host === "shared") {
      const node = entry.widget?.gridstackNode;
      toMigrate.push({
        oldId: panelId,
        typeId: entry.type,
        pos: node ? { x: node.x, y: node.y, w: node.w, h: node.h } : null
      });
    }
  }
  if (toMigrate.length === 0) return 0;

  /* shared パネルを全て削除 */
  for (const { oldId } of toMigrate) {
    removePanel(oldId);
  }

  /* 同じ種別・同じ位置で新ホスト名のパネルを再生成 */
  let count = 0;
  for (const { typeId, pos } of toMigrate) {
    if (addPanel(typeId, newHost, pos)) count++;
  }

  if (count > 0) saveLayout();
  updateAllPanelHeaders();
  console.info(`migratePanelsToHost: ${count} パネルを "${newHost}" に再生成（shared から移行）`);
  return count;
}

/**
 * renamePanelsHost:
 * -----------------
 * 既存パネルのホスト名を oldHost から newHost に移行する。
 * IP接続後にホスト名が判明した際に、IPベースのパネルIDを
 * ホスト名ベースに切り替えるために使用する。
 *
 * 移行方式は migratePanelsToHost と同一: 旧パネルの位置・サイズを記録し、
 * 削除→新ホスト名で再生成する。IDスコーピングや init 関数の実行を
 * addPanel に委譲することで、新規作成パネルと同一の初期化パスを保証する。
 *
 * @function renamePanelsHost
 * @param {string} oldHost - 移行元ホスト名（IP等）
 * @param {string} newHost - 移行先ホスト名
 * @returns {number} 移行したパネル数
 */
export function renamePanelsHost(oldHost, newHost) {
  if (!grid || !oldHost || !newHost || oldHost === newHost) return 0;
  if (newHost === "shared" || newHost === PLACEHOLDER_HOSTNAME) return 0;

  /* IP→ホスト名の移行のみ許可する。
     oldHost がホスト名形式（＝別の機器名）の場合は移行しない。
     別機器のパネルをリサイクルすると、異なるデータが混在するため危険。
     その場合は旧パネルはそのまま残し、新ホスト用パネルは ensureHostPanels で生成する。 */
  const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  if (!IP_RE.test(oldHost)) {
    console.info(
      `renamePanelsHost: "${oldHost}" はIPではないため移行スキップ` +
      `（別機器の可能性あり、"${newHost}" 用パネルは新規生成）`
    );
    return 0;
  }

  /* 既にこのホストのパネルが存在する場合は旧IPパネルを削除するのみ */
  let hasNewHostPanels = false;
  for (const [, entry] of activePanels) {
    if (entry.host === newHost) { hasNewHostPanels = true; break; }
  }

  /* 移行対象の旧IPパネルを収集（位置・サイズを保存） */
  const toMigrate = [];
  for (const [panelId, entry] of activePanels) {
    if (entry.host === oldHost) {
      const node = entry.widget?.gridstackNode;
      toMigrate.push({
        oldId: panelId,
        typeId: entry.type,
        pos: node ? { x: node.x, y: node.y, w: node.w, h: node.h } : null
      });
    }
  }
  if (toMigrate.length === 0) return 0;

  /* 旧IPパネルを全て削除 */
  for (const { oldId } of toMigrate) {
    removePanel(oldId);
  }

  /* 新ホスト名で同じ種別・同じ位置にパネルを再生成
     （既に新ホストパネルがある場合は重複生成しない） */
  let count = 0;
  if (!hasNewHostPanels) {
    for (const { typeId, pos } of toMigrate) {
      if (addPanel(typeId, newHost, pos)) count++;
    }
  }

  if (count > 0 || toMigrate.length > 0) saveLayout();
  updateAllPanelHeaders();
  console.info(
    `renamePanelsHost: "${oldHost}" → "${newHost}" ${count} パネルを再生成` +
    (hasNewHostPanels ? `（旧パネル ${toMigrate.length} 個を削除のみ）` : "")
  );
  return count;
}

/**
 * 指定ホスト用のデフォルトパネルセットを生成する。
 * 接続確立後にそのホストのパネルが1つも無い場合に呼ばれる。
 * - グリッド上にパネルが一切無い場合はフルセットを生成
 * - 他ホストのパネルがある場合は主要パネルのみ追加
 *
 * @function ensureHostPanels
 * @param {string} hostname - ホスト名
 * @returns {number} 生成したパネル数
 */
export function ensureHostPanels(hostname) {
  if (!grid || !hostname || hostname === "shared") return 0;

  /* 既にこのホストのパネルが存在するか確認 */
  for (const [, entry] of activePanels) {
    if (entry.host === hostname) return 0;
  }

  /* 保留レイアウトがあればそこから復元 */
  if (_deferredLayouts.has(hostname)) {
    const deferred = _deferredLayouts.get(hostname);
    _deferredLayouts.delete(hostname);
    let count = 0;
    for (const item of deferred) {
      if (addPanel(item.panelType, hostname, { x: item.x, y: item.y, w: item.w, h: item.h })) count++;
    }
    if (count > 0) {
      saveLayout();
      return count;
    }
  }

  /* 保留レイアウトがない場合はデフォルトパネルセットを生成 */
  let count = 0;

  /* 既存パネルの最大Y座標を計算（2台目以降の配置開始位置） */
  let maxY = 0;
  if (activePanels.size > 0) {
    for (const [, entry] of activePanels) {
      const node = entry.widget?.gridstackNode;
      if (node) {
        const bottom = (node.y || 0) + (node.h || 0);
        if (bottom > maxY) maxY = bottom;
      }
    }
  }

  /* 旧シングルHTML配置を模した初期レイアウト
     上段: カメラ＋ヘッドプレビュー＋ステータス
     中段左: 温度グラフ  中段右: フィラメント＋操作系＋機器情報
     下段: 現在の印刷→ログ→印刷履歴→ファイル一覧 */
  const defaultPanels = [
    { type: "camera",        x: 0,  y: 0,  w: 4,  h: 6 },
    { type: "head-preview",  x: 4,  y: 0,  w: 4,  h: 6 },
    { type: "status",        x: 8,  y: 0,  w: 4,  h: 6 },
    { type: "temp-graph",    x: 0,  y: 6,  w: 6,  h: 5 },
    { type: "filament",      x: 6,  y: 6,  w: 3,  h: 5 },
    { type: "control-cmd",   x: 9,  y: 6,  w: 3,  h: 3 },
    { type: "machine-info",  x: 9,  y: 9,  w: 3,  h: 2 },
    { type: "control-temp",  x: 0,  y: 11, w: 12, h: 3 },
    { type: "current-print", x: 0,  y: 14, w: 12, h: 3 },
    { type: "log",           x: 0,  y: 17, w: 12, h: 4 },
    { type: "history",       x: 0,  y: 21, w: 12, h: 5 },
    { type: "file-list",     x: 0,  y: 26, w: 12, h: 5 }
  ];
  for (const p of defaultPanels) {
    if (addPanel(p.type, hostname, { x: p.x, y: p.y + maxY, w: p.w, h: p.h })) count++;
  }

  if (count > 0) saveLayout();
  return count;
}

/**
 * 全パネルのヘッダーを現在の設定に合わせて更新する。
 * ホスト色・ホスト名表示の変更後に呼び出す。
 *
 * @function updateAllPanelHeaders
 * @returns {void}
 */
export function updateAllPanelHeaders() {
  const showTag = monitorData.appSettings.showHostTag !== false;
  for (const [, entry] of activePanels) {
    const wrapper = entry.element;
    if (!wrapper) continue;
    const header = wrapper.querySelector(".panel-header");
    if (!header) continue;

    /* ホスト色を反映 */
    const conf = _getHostConfig(entry.host);
    header.style.background = conf.color || "";

    /* ホスト名タグを更新 */
    const tag = header.querySelector(".panel-host-tag");
    if (tag) {
      tag.textContent = (showTag && entry.host !== "shared")
        ? (conf.label || entry.host) : "";
    }
  }
}

/* ─── 内部ヘルパー ─── */

/**
 * 指定ホストに紐づく色・ラベル設定を返す。
 * connectionTargets の各エントリに color/label が保存されている場合にそれを返す。
 *
 * @private
 * @function _getHostConfig
 * @param {string} hostname - ホスト名
 * @returns {{color: string, label: string}} color/label（未設定時は空文字）
 */
function _getHostConfig(hostname) {
  const result = { color: "", label: "" };
  if (!hostname || hostname === "shared") return result;

  const targets = monitorData.appSettings.connectionTargets || [];
  /* ホスト名 or IP で接続先設定を検索 */
  for (const t of targets) {
    const ip = t.dest?.split(":")[0];
    if (t.dest === hostname || ip === hostname ||
        t.hostname === hostname) {
      result.color = t.color || "";
      result.label = t.label || "";
      return result;
    }
  }
  return result;
}

/**
 * 要素内の全IDにホスト名プレフィックスを付加し、ID衝突を回避する。
 *
 * 【詳細説明】
 * - マルチプリンタ時に同一パネルが複数存在するため、
 *   DOM ID の重複を防ぐ
 * - data-field 属性はそのまま維持（data-host スコープで区別）
 * - label の for 属性も連動して書き換える
 *
 * @private
 * @function _scopeElementIds
 * @param {HTMLElement} root     - スコープ対象のルート要素
 * @param {string}      hostname - プレフィックスとして使うホスト名
 * @returns {void}
 */
function _scopeElementIds(root, hostname) {
  /* ホスト名を安全なプレフィックスに変換（ドットやコロンを置換） */
  const prefix = hostname.replace(/[^a-zA-Z0-9_-]/g, "_");

  /* ID を持つ全要素を書き換え */
  const idEls = root.querySelectorAll("[id]");
  idEls.forEach(el => {
    const oldId = el.id;
    el.id = `${prefix}__${oldId}`;

    /* 対応する label の for 属性も更新 */
    const labels = root.querySelectorAll(`label[for="${oldId}"]`);
    labels.forEach(lbl => {
      lbl.setAttribute("for", el.id);
    });
  });
}
