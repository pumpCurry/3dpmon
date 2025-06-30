/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 テンキー UI コンポーネント
 * @file Keypad.js
 * -----------------------------------------------------------
 * @module splash/Keypad
 *
 * 【機能内容サマリ】
 * - スプラッシュ画面で利用するテンキーを描画
 * - 現フェーズでは全キーを disabled 表示し Enter のみ有効
 *
 * 【公開クラス一覧】
 * - {@link Keypad}：テンキー UI クラス
 *
 * @version 1.390.580 (PR #268)
 * @since   1.390.580 (PR #268)
 * @lastModified 2025-07-01 00:00:00
 * -----------------------------------------------------------
 * @todo
 * - パスワード入力機能の有効化
 */

/**
 * テンキー UI クラス。
 */
export default class Keypad {
  /**
   * @param {Function} onEnter - Enter ボタン押下時のコールバック
   */
  constructor(onEnter) {
    /** @type {HTMLElement|null} */
    this.el = null;
    /** @type {Function} */
    this.onEnter = onEnter;
  }

  /**
   * DOM を生成しルートへ追加する。
   *
   * @param {HTMLElement} root - 追加先ルート要素
   * @returns {void}
   */
  mount(root) {
    this.el = document.createElement('div');
    this.el.className = 'keypad';
    const labels = ['1','2','3','4','5','6','7','8','9','Clear','0','Enter'];
    labels.forEach((label) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      if (label === 'Enter') {
        btn.className = 'enter';
        btn.addEventListener('click', () => this.onEnter());
      } else {
        btn.disabled = true;
      }
      this.el.appendChild(btn);
    });
    root.appendChild(this.el);
  }

  /**
   * DOM を除去する。
   *
   * @returns {void}
   */
  destroy() {
    if (this.el && this.el.parentNode) {
      this.el.parentNode.removeChild(this.el);
    }
    this.el = null;
  }
}
