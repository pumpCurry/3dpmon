/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Bar_SideMenu コンポーネント
 * @file Bar_SideMenu.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * -----------------------------------------------------------
 * @module cards/Bar_SideMenu
 *
 * 【機能内容サマリ】
 * - ハンバーガーから展開するサイドメニュー
 *
 * 【公開クラス一覧】
 * - {@link Bar_SideMenu}：UI コンポーネントクラス
 *
 * @version 1.390.563 (PR #259)
 * @since   1.390.563 (PR #259)
 * @lastModified 2025-06-29 13:09:40
 * -----------------------------------------------------------
 * @todo
 * - メニュー項目の追加
 */

import BaseBar from './BaseBar.js';

/**
 * サイドメニューを表すクラス。
 */
export default class Bar_SideMenu extends BaseBar {
  /** @type {string} */
  static id = 'SIDE';

  constructor(bus) {
    super(bus);
    /** @type {HTMLElement|null} */
    this.panel = null;
    /** @type {HTMLElement|null} */
    this.firstFocus = null;
    /** @type {HTMLElement|null} */
    this.lastFocus = null;
    this.handleKey = (e) => this.#trap(e);
  }

  /**
   * DOM へ挿入し非表示状態で準備する。
   * @param {HTMLElement} root - 追加先
   * @returns {void}
   */
  mount(root) {
    this.el = document.createElement('div');
    this.el.className = 'side-menu';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    this.el.tabIndex = -1;
    this.el.innerHTML = `<nav><button class="close">×</button><ul><li role="menuitem">About</li></ul></nav>`;
    this.panel = this.el.querySelector('nav');
    this.firstFocus = this.el.querySelector('button.close');
    this.lastFocus = this.el.querySelector('li[role="menuitem"]');
    this.firstFocus.addEventListener('click', () => this.close());
    super.mount(root);
    this.close();
  }

  /**
   * メニューを開く。
   * @returns {void}
   */
  open() {
    if (!this.el) return;
    this.el.style.transform = 'translateX(0)';
    document.addEventListener('keydown', this.handleKey);
    this.firstFocus.focus();
  }

  /**
   * メニューを閉じる。
   * @returns {void}
   */
  close() {
    if (!this.el) return;
    this.el.style.transform = 'translateX(-100%)';
    document.removeEventListener('keydown', this.handleKey);
  }

  /**
   * フォーカストラップ用ハンドラ。
   * @private
   * @param {KeyboardEvent} e - キーボードイベント
   * @returns {void}
   */
  #trap(e) {
    if (e.key === 'Escape') {
      this.close();
      this.bus.emit('menu:close');
      return;
    }
    if (e.key === 'Tab' && this.el) {
      const focusable = [this.firstFocus, this.lastFocus];
      if (e.shiftKey && document.activeElement === this.firstFocus) {
        e.preventDefault();
        this.lastFocus.focus();
      } else if (!e.shiftKey && document.activeElement === this.lastFocus) {
        e.preventDefault();
        this.firstFocus.focus();
      }
    }
  }
}
