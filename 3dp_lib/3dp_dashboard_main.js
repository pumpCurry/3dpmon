/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 エントリポイントモジュール
 * @file 3dp_dashboard_main.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module 3dp_dashboard_main
 *
 * 【機能内容サマリ】
 * - 各モジュールの読み込みと初期化
 * - 例外ハンドリングやデバッグオブジェクト設定
 * - DOMContentLoaded で初期化処理を実行
 * - グローバルメニューバーのイベント登録
 * - connections[] からの自動接続復元
 * - レイアウト設定の復元（1ペイン / 2ペイン）
 * - ペイン2の initializeDashboard 呼び出し
 *
 * 【公開関数一覧】
 * - なし（エントリポイントとして即時実行）
 *
 * @version 1.400.435 (PR #303)
 * @since   1.390.193 (PR #86)
 * @lastModified 2025-07-04 12:00:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

// ——— 依存モジュールのインポート ———
import {
  connectWs,
  disconnectWs,
  updateConnectionUI
} from "./dashboard_connection.js";
import { handleMessage } from "./dashboard_msg_handler.js";
import {
  stopCameraStream,
  handleCameraError
} from "./dashboard_camera_ctrl.js";
import { initializeDashboard } from "./3dp_dashboard_init.js";
import { audioManager } from "./dashboard_audio_manager.js";
import { notificationManager } from "./dashboard_notification_manager.js";
import { monitorData } from "./dashboard_data.js";

import { initUIEventHandlers } from "./dashboard_ui.js";
import { initStorageUI } from "./dashboard_storage_ui.js";
// 以下2モジュールは DOMContentLoaded 後の UI 初期化で使用するため
// 副作用目的で読み込む
import "./dashboard_spool_ui.js";
import "./dashboard_filament_manager.js";
import "./dashboard_filament_change.js";

// ——— レイアウト / 接続設定モジュール ———
import {
  restoreLayout,
  showLayoutSelectDialog,
  updatePaneSelectors
} from "./dashboard_layout_manager.js";
import { ConnSettingsModal } from "./dashboard_conn_settings.js";

// ——— グローバル例外ハンドリング ———
window.addEventListener("unhandledrejection", evt => {
  console.error("unhandledrejection:", evt.reason);
});

// ——— デバッグ用グローバル参照 ———
window.audioManager = audioManager;
window.notificationManager = notificationManager;

// ─── グローバルメニューバー ────────────────────────────────────────

/**
 * グローバルメニューバーのイベントを登録する。
 * @private
 * @returns {void}
 */
function _initGlobalMenuBar() {
  const menuBtn     = document.getElementById("gmb-menu-btn");
  const dropdown    = document.getElementById("gmb-dropdown");
  const connBtn     = document.getElementById("gmb-conn-settings");
  const layoutBtn   = document.getElementById("gmb-layout-select");

  // ≡ Menu ▾ の開閉
  menuBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown?.classList.toggle("hidden");
  });

  // ドロップダウン外クリックで閉じる（menuBtn自身のクリックはtoggleで処理するため除外）
  document.addEventListener("click", (e) => {
    if (dropdown && !dropdown.classList.contains("hidden")) {
      const target = /** @type {Node} */(e.target);
      if (!dropdown.contains(target) && !menuBtn?.contains(target)) {
        dropdown.classList.add("hidden");
      }
    }
  });

  // 接続設定...
  connBtn?.addEventListener("click", () => {
    dropdown?.classList.add("hidden");
    new ConnSettingsModal().open();
  });

  // ダッシュボード選択...
  layoutBtn?.addEventListener("click", () => {
    dropdown?.classList.add("hidden");
    showLayoutSelectDialog();
  });
}

// ─── 自動接続復元 ────────────────────────────────────────────────

/**
 * connections[] の autoConnect フラグが立っているプリンタへ自動接続する。
 * 各接続は 200ms ずつずらして呼び出し、WebSocket の競合を防ぐ。
 *
 * @private
 * @returns {void}
 */
function _autoConnectAll() {
  const connections = monitorData.appSettings.connections ?? [];
  let delay = 0;
  for (const conn of connections) {
    if (!conn.autoConnect || !conn.ip) continue;
    const dest = `${conn.ip}:${conn.wsPort ?? 9999}`;
    setTimeout(() => {
      connectWs(dest);
    }, delay);
    delay += 200;
  }
}

// ─── ペイン2の初期化 ──────────────────────────────────────────────

/**
 * ペイン2の initializeDashboard を呼び出す。
 * layout-preset2 クラスが付いているときだけ実質的に意味を持つが、
 * DOM要素が存在すれば初期化しておく。
 *
 * @private
 * @returns {void}
 */
function _initPane2() {
  if (!document.getElementById("pane-2")) return;

  initializeDashboard({
    /** 接続ボタン押下時（ペイン2） */
    onConnect: () => {
      disconnectWs();
      connectWs();
    },
    /** 切断ボタン押下時（ペイン2） */
    onDisconnect: () => {
      disconnectWs();
      stopCameraStream(undefined, 2);
    },
    /** カメラエラー時（ペイン2） */
    onCameraError: () => {
      handleCameraError(2);
    },
    /** WebSocket 接続状態変化時（ペイン2） */
    onConnectionStateChange: _connected => {
      updateConnectionUI("connected", {}, undefined, 2);
    },
    /** 受信メッセージ処理（ペイン2） */
    onMessage: data => {
      handleMessage(data);
    },
    /** オーディオ管理 */
    audioManager,
    /** 通知管理 */
    notificationManager,
    /** ペイン番号 */
    paneIndex: 2
  });
}

/**
 * ページ読み込み完了後のエントリポイント。
 * initializeDashboard() 内で以下を行います:
 * - 各種 UI（ボタン・トグル・ログ・グラフ・プレビュー等）のバインド
 * - ストレージ復元／クリーンアップ
 * - 自動接続・カメラ起動・ファイルマネージャなどの初期化
 * - WebSocket 接続／切断ボタンへの connectWs()/disconnectWs() バインド
 * - notificationManager・audioManager のテスト・設定バインド
 */
document.addEventListener("DOMContentLoaded", () => {

  // ── ペイン1 初期化 ──────────────────────────────────────────────
  initializeDashboard({
    /** 接続ボタン押下時 */
    onConnect: () => {
      disconnectWs();
      connectWs();
    },
    /** 切断ボタン押下時 */
    onDisconnect: () => {
      disconnectWs();
      // IPアドレス再入力後に旧カメラストリームが残らないよう停止
      stopCameraStream(undefined, 1);
    },
    /** カメラエラー時 */
    onCameraError: () => {
      handleCameraError(1);
    },
    /** WebSocket 接続状態が変化したとき */
    onConnectionStateChange: _connected => {
      updateConnectionUI("connected", {}, undefined, 1);
    },
    /** 受信メッセージを処理するとき */
    onMessage: data => {
      handleMessage(data);
    },
    /** オーディオ管理 */
    audioManager,
    /** 通知管理 */
    notificationManager,
    /** ペイン番号 */
    paneIndex: 1
  });

  // ── ペイン2 初期化 ──────────────────────────────────────────────
  _initPane2();

  // ── UI イベント ─────────────────────────────────────────────────
  initUIEventHandlers();
  initStorageUI();

  // ── グローバルメニューバー ───────────────────────────────────────
  _initGlobalMenuBar();

  // ── レイアウト復元 ──────────────────────────────────────────────
  // connections[] の順序でペインセレクタを再構築し、
  // 保存済みレイアウト（preset1/preset2）と paneAssignment を復元する
  updatePaneSelectors();
  restoreLayout();

  // ── 自動接続 ────────────────────────────────────────────────────
  // connections[] の autoConnect フラグが立っているプリンタに接続する
  // （initializeDashboard 内の旧 wsDest ベース自動接続とは排他になるよう
  //   dashboard_data.js のマイグレーション後はここのみで動作する）
  _autoConnectAll();
});
