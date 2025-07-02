/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 カード基底クラス
 * @file BaseCard.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * -----------------------------------------------------------
 * @module cards/BaseCard
 *
 * 【機能内容サマリ】
 * - カード共通の DOM 操作とスケール変更を提供
 *
 * 【公開クラス一覧】
 * - {@link BaseCard}：カード基底クラス
 *
 * @version 1.390.632 (PR #293)
 * @since   1.390.554 (PR #254)
 * @lastModified 2025-07-02 12:00:00
 * -----------------------------------------------------------
 * @todo
 * - なし
 */

/**
 * カードコンポーネントの抽象基底クラス。
 */
export default class BaseCard {
  /**
   * @param {Object} bus - EventBus インスタンス
   */
  constructor(bus) {
    /** @type {HTMLElement|null} */
    this.el = null;
    /** @type {Object} */
    this.bus = bus;
    /** @type {number} */
    this.scaleValue = 1;
  }

  /**
   * DOM へ挿入する。サブクラスで this.el を生成しておくこと。
   *
   * @param {HTMLElement} root - 追加先要素
   * @returns {void}
   */
  mount(root) {
    if (this.el) root.appendChild(this.el);
  }

  /**
   * 要素のスケールを変更する。
   *
   * @param {number} val - 倍率 (0.5-2.0)
   * @returns {void}
   */
  scale(val) {
    this.scaleValue = val;
    if (this.el) this.el.style.transform = `scale(${val})`;
  }

  /**
   * カード位置を設定する。
   *
   * @param {number} x - X 座標
   * @param {number} y - Y 座標
   * @returns {void}
   */
  setPosition(x, y) {
    if (this.el) {
      this.el.style.left = `${x}px`;
      this.el.style.top = `${y}px`;
      this.el.style.position = 'absolute';
    }
  }

  /**
   * EventBus への購読を行う。各カードでオーバーライドする想定。
   *
   * @returns {void}
   */
  connected() {
    // サブクラスで必要な購読処理を実装する
  }

  /**
   * 破棄処理。DOM から削除する。
   *
   * @returns {void}
   */
  destroy() {
    if (this.el && this.el.parentNode) this.el.remove();
  }
}
