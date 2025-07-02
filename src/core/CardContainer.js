/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 CardContainer モジュール
 * @file CardContainer.js
 * -----------------------------------------------------------
 * @module core/CardContainer
 *
 * 【機能内容サマリ】
 * - カード要素を包むコンテナの生成とフィルタ・移動処理
 *
 * 【公開クラス一覧】
 * - {@link CardContainer}: カードコンテナクラス
 *
 * @version 1.390.640 (PR #298)
 * @since   1.390.640 (PR #298)
 * @lastModified 2025-07-03 13:40:00
 * -----------------------------------------------------------
 * @todo
 * - レイアウト保存連携
 */

/**
 * カードコンテナを表すクラス。
 */
export default class CardContainer {
  /**
   * @param {Object} bus - EventBus インスタンス
   * @param {import('./LayoutStore.js').LayoutStore} store - LayoutStore インスタンス
   */
  constructor(bus, store) {
    /** @type {Object} */
    this.bus = bus;
    /** @type {import('./LayoutStore.js').LayoutStore} */
    this.store = store;
    /** @type {HTMLElement|null} */
    this.root = null;
  }

  /**
   * DOM へコンテナを追加する。
   *
   * @param {HTMLElement} root - 追加先要素
   * @returns {void}
   */
  mount(root) {
    this.root = document.createElement('div');
    this.root.className = 'card-container';
    root.appendChild(this.root);
    this.bus.on('filter:change', (id) => this.updateFilter(id));
  }

  /**
   * 位置変更時にグリッド内へ収める。
   *
   * @param {HTMLElement} el - 対象カード要素
   * @param {number} x - 列位置
   * @param {number} y - 行位置
   * @param {number} w - 幅
   * @param {number} h - 高さ
   * @param {{cols:number,rows:number}} grid - グリッドサイズ
   * @returns {{x:number,y:number}} 適用結果
   */
  move(el, x, y, w, h, grid) {
    const cols = grid.cols;
    const rows = grid.rows;
    const nx = Math.max(0, Math.min(x, cols - w));
    const ny = Math.max(0, Math.min(y, rows - h));
    if (el) {
      el.style.gridColumn = `${nx + 1} / span ${w}`;
      el.style.gridRow = `${ny + 1} / span ${h}`;
    }
    return { x: nx, y: ny };
  }

  /**
   * フィルタ ID に基づき表示制御する。
   *
   * @param {string} id - 'ALL' or deviceId
   * @returns {void}
   */
  updateFilter(id) {
    if (!this.root) return;
    this.root.querySelectorAll('[data-card]').forEach((el) => {
      const match = id === 'ALL' || el.dataset.device === id;
      el.style.opacity = match ? '1' : '0.2';
      el.style.pointerEvents = match ? 'auto' : 'none';
    });
  }
}
