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
 *
 * 【公開関数一覧】
 * - なし（エントリポイントとして即時実行）
 *
 * @version 1.390.435 (PR #196)
 * @since   1.390.193 (PR #86)
 * @lastModified 2025-06-22 18:30:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

// ——— 依存モジュールのインポート ———
import { initializeDashboard } from "./3dp_dashboard_init.js";
import { audioManager } from "./dashboard_audio_manager.js";
import { notificationManager } from "./dashboard_notification_manager.js";

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
 * - ストレージ復元／クリーンアップ
 * - 自動接続のセットアップ
 * - 自動保存タイマーの登録
 *
 * UI要素のバインド（ボタン・トグル・ログ・グラフ・プレビュー等）は
 * パネルシステム (dashboard_panel_factory / dashboard_panel_boot) が
 * per-host で実行します。
 */
document.addEventListener("DOMContentLoaded", async () => {
  await initializeDashboard();

  initStorageUI();

});
