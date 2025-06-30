/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 スプラッシュ画面モジュール
 * @file SplashScreen.js
 * -----------------------------------------------------------
 * @module splash/SplashScreen
 *
 * 【機能内容サマリ】
 * - 起動時のロゴ表示とテンキー UI 管理
 * - Enter 押下で bus へ 'auth:ok' を通知
 *
 * 【公開クラス一覧】
 * - {@link SplashScreen}：スプラッシュ画面クラス
 *
 * @version 1.390.580 (PR #268)
 * @since   1.390.580 (PR #268)
 * @lastModified 2025-07-01 00:00:00
 * -----------------------------------------------------------
 * @todo
 * - ローディングアニメ追加
 */

import Keypad from './Keypad.js';

/**
 * スプラッシュ画面クラス。
 */
export default class SplashScreen {
  /**
   * @param {Object} bus - EventBus インスタンス
   */
  constructor(bus) {
    /** @type {Object} */
    this.bus = bus;
    /** @type {HTMLElement|null} */
    this.el = null;
    /** @type {Keypad|null} */
    this.keypad = null;
  }

  /**
   * 画面を生成しルートへ追加する。
   *
   * @param {HTMLElement} root - 描画先ルート要素
   * @returns {void}
   */
  mount(root) {
    this.el = document.createElement('div');
    this.el.className = 'splash-screen';

    const logo = document.createElement('div');
    logo.className = 'logo';
    logo.textContent = '3dpmon';
    logo.setAttribute('role', 'img');
    logo.setAttribute('aria-label', 'logo');
    this.el.appendChild(logo);

    this.keypad = new Keypad(() => this.#enter());
    this.keypad.mount(this.el);

    root.appendChild(this.el);

    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.#enter();
    });
  }

  /**
   * Enter アクション時に認証成功を通知する。
   *
   * @private
   * @returns {void}
   */
  #enter() {
    this.bus.emit('auth:ok');
  }

  /**
   * DOM を除去する。
   *
   * @returns {void}
   */
  destroy() {
    if (this.keypad) this.keypad.destroy();
    if (this.el && this.el.parentNode) {
      this.el.parentNode.removeChild(this.el);
    }
    this.el = null;
  }
}
