/**
 * @fileoverview
 * 3Dプリンタ監視ツール 3dpmon 用 エントリポイントモジュール
 * 3dp_dashboard_main.js
 * (c) pumpCurry 2025
 * -----------------------------------------------------------
 * @module 3dp_dashboard_main
 *
 * 【機能内容サマリ】
 * - 各モジュールの読み込みと初期化
 * - 例外ハンドリングやデバッグオブジェクト設定
 * - DOMContentLoaded で初期化処理を実行
 *
 * 【公開関数一覧】
 * - なし（エントリポイントとして即時実行）
 *
 * @version 1.390.230 (PR #104)
 * @since   1.390.193 (PR #86)
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
  startCameraStream,
  stopCameraStream,
  handleCameraError
} from "./dashboard_camera_ctrl.js";
import { initializeDashboard } from "./3dp_dashboard_init.js";
import { audioManager } from "./dashboard_audio_manager.js";
import { notificationManager } from "./dashboard_notification_manager.js";

import { initUIEventHandlers } from "./dashboard_ui.js";
import { initStorageUI } from "./dashboard_storage_ui.js";
// 以下2モジュールは DOMContentLoaded 後の UI 初期化で使用するため
// 副作用目的で読み込む
import "./dashboard_spool_ui.js";
import "./dashboard_filament_manager.js";
import "./dashboard_filament_change.js";

// ——— グローバル例外ハンドリング ———
window.addEventListener("unhandledrejection", evt => {
  console.error("unhandledrejection:", evt.reason);
});

// ——— デバッグ用グローバル参照 ———
window.audioManager = audioManager;
window.notificationManager = notificationManager;

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
  initializeDashboard({
    /** 接続ボタン押下時 */
    onConnect: () => {
      disconnectWs();
      connectWs();
    },
    /** 切断ボタン押下時 */
    onDisconnect: () => {
      disconnectWs();
    },
    /** カメラエラー時 */
    onCameraError: () => {
      handleCameraError();
    },
    /** WebSocket 接続状態が変化したとき */
    onConnectionStateChange: connected => {
      updateConnectionUI("connected");
    },
    /** 受信メッセージを処理するとき */
    onMessage: data => {
      handleMessage(data);
    },
    /** オーディオ管理 */
    audioManager,
    /** 通知管理 */
    notificationManager
  });

  initUIEventHandlers();
  initStorageUI();

});
