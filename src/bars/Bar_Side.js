/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 左サイドバー UI モジュール
 * @file Bar_Side.js
 * -----------------------------------------------------------
 * @module bars/Bar_Side
 *
 * 【機能内容サマリ】
 * - 固定表示のサイドツールバーを提供
 * - 各アイコン押下で EventBus へ通知
 *
 * 【公開クラス一覧】
 * - {@link SideBar}：左サイドバー UI クラス
 *
 * @version 1.390.620 (PR #287)
 * @since   1.390.618 (PR #286)
 * @lastModified 2025-07-01 18:43:23
 * -----------------------------------------------------------
 * @todo
 * - なし
 */

import BaseBar from '../cards/BaseBar.js';

/**
 * 左側に固定表示されるサイドバークラス。
 */
export default class SideBar extends BaseBar {
  /**
   * DOM 要素を生成しマウントする。
   *
   * @param {HTMLElement} root - ルート要素
   * @returns {void}
   */
  mount(root) {
    this.el = document.createElement('div');
    this.el.className = 'sidebar';
    this.el.innerHTML = `
      <button data-act="conn" aria-label="Connections" title="Connections">C</button>
      <button data-act="logs" aria-label="Logs" title="Logs">L</button>
      <button data-act="theme" aria-label="Theme" title="Theme">T</button>
    `;
    this.el.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (btn && btn.dataset.act) {
        this.bus.emit(`sidebar:${btn.dataset.act}`);
      }
    });
    super.mount(root);
  }
}
