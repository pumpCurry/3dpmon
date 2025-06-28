/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 共通バー基底クラス
 * @file BaseBar.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * -----------------------------------------------------------
 * @module cards/BaseBar
 *
 * 【機能内容サマリ】
 * - バー系コンポーネントの共通ライフサイクルを提供
 *
 * 【公開クラス一覧】
 * - {@link BaseBar}：バーコンポーネント基底クラス
 *
 * @version 1.390.553 (PR #253)
 * @since   1.390.549 (PR #252)
 * @lastModified 2025-06-28 20:00:00
 * -----------------------------------------------------------
 * @todo
 * - なし
 */

/**
 * バーコンポーネントの基底クラス。
 */
export default class BaseBar {
  /**
   * @param {Object} bus - EventBus インスタンス
   */
  constructor(bus) {
    /** @type {Object} */
    this.bus = bus;
    /** @type {HTMLElement|null} */
    this.el = null;
  }

  /**
   * ドラッグハンドルを取得するスタブメソッド。
   * 具体的なバー側でオーバーライドしてドラッグ領域を返す想定。
   *
   * @returns {HTMLElement|null} ドラッグ操作対象の要素
   */
  dragHandle() {
    // 共通化のためのスタブ。デフォルトでは null を返す。
    return null;
  }

  /**
   * DOM ルートへバー要素を追加する。
   *
   * @param {HTMLElement} root - 挿入先ルート要素
   * @returns {void}
   */
  mount(root) {
    if (this.el) {
      root.appendChild(this.el);
    }
  }

  /**
   * バー要素を DOM から削除する。
   *
   * @returns {void}
   */
  destroy() {
    if (this.el && this.el.parentNode) {
      this.el.parentNode.removeChild(this.el);
    }
  }
}
