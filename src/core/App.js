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
 * @version 1.390.549 (PR #252)
 * @since   1.390.531 (PR #1)
 * @lastModified 2025-06-28 20:00:00
 * -----------------------------------------------------------
 * @todo
 * - ConnectionManager の実装
 * - DashboardManager の実装
 */

import TitleBar from '@cards/Bar_Title.js';
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
    if (this.root) {
      this.titleBar = new TitleBar(bus);
      this.titleBar.mount(this.root);
      this.titleBar.setTabs([
        { id: 'd1', label: 'Dummy1', color: '#f66' },
        { id: 'd2', label: 'Dummy2', color: '#6f6' },
        { id: 'd3', label: 'Dummy3', color: '#66f' }
      ]);
    }
  }
}
