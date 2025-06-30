/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 アプリケーションメインクラス
 * @file App.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * -----------------------------------------------------------
 * @module core/App
 *
 * 【機能内容サマリ】
 * - ダッシュボードの初期化とレンダリング制御
 *
 * 【公開クラス一覧】
 * - {@link App}：アプリケーションメインクラス
 *
* @version 1.390.576 (PR #260)
* @since   1.390.531 (PR #1)
* @lastModified 2025-06-30 12:00:00
 * -----------------------------------------------------------
 * @todo
* - ConnectionManager の高度化
* - DashboardManager のカード連携
 */

import { ConnectionManager } from './ConnectionManager.js';
import DashboardManager from './DashboardManager.js';
import { bus } from './EventBus.js';

/**
 * アプリケーションメインクラス。
 */
export class App {
  /**
   * @param {string} rootSelector - ルート要素のセレクター
   */
  constructor(rootSelector) {
    /** @type {HTMLElement|null} */
    this.root = document.querySelector(rootSelector);
    this.cm = new ConnectionManager(bus);
    this.db = new DashboardManager(bus, this.cm);
    if (this.root) {
      this.db.render(this.root);
    }
  }
}
