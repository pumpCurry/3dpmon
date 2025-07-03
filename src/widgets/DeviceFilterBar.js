/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 DeviceFilterBar コンポーネント
 * @file DeviceFilterBar.js
 * -----------------------------------------------------------
 * @module widgets/DeviceFilterBar
 *
 * 【機能内容サマリ】
 * - 接続中デバイスのフィルタチップを表示してカードを絞り込む
 *
 * 【公開クラス一覧】
 * - {@link DeviceFilterBar}: デバイスフィルタバークラス
 *
 * @version 1.390.642 (PR #299)
 * @since   1.390.640 (PR #298)
 * @lastModified 2025-07-03 12:39:33
 * -----------------------------------------------------------
 * @todo
 * - なし
 */

import BaseBar from '../cards/BaseBar.js';

/**
 * デバイスフィルタチップを表示するバークラス。
 */
export default class DeviceFilterBar extends BaseBar {
  /**
   * @param {import('../core/LayoutStore.js').LayoutStore} store - LayoutStore インスタンス
   * @param {Object} bus - EventBus インスタンス
   */
  constructor(store, bus) {
    super(bus);
    /** @type {import('../core/LayoutStore.js').LayoutStore} */
    this.store = store;
    /** @type {Array<{id:string,label:string,color?:string}>} */
    this.devices = [];
  }

  /** @inheritDoc */
  mount(root) {
    this.el = document.createElement('div');
    this.el.className = 'device-filter-bar';
    this.el.setAttribute('role', 'toolbar');
    // キーボードからの操作に対応するため keydown イベントで Space/Enter を監視する
    this.el.addEventListener('keydown', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (e.code === 'Space' || e.code === 'Enter' || e.key === ' ') {
        e.preventDefault();
        b.click();
      }
    });
    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) {
        const id = b.dataset.id || 'ALL';
        this.store.current.filter = id;
        this.store.save(this.store.current);
        this.bus.emit('filter:change', id);
        this.#highlight();
      }
    });
    super.mount(root);
    this.bus.on('conn:added', (meta) => {
      this.devices.push({ id: meta.id, label: meta.ip, color: meta.color });
      this.#render();
    });
    this.bus.on('conn:remove', ({ id }) => {
      this.devices = this.devices.filter((d) => d.id !== id);
      if (this.store.current.filter === id) {
        this.store.current.filter = 'ALL';
        this.store.save(this.store.current);
        this.bus.emit('filter:change', 'ALL');
      }
      this.#render();
    });
    this.bus.on('layout:switch', ({ layout }) => {
      this.store.current = layout;
      this.#highlight();
    });
    this.#render();
  }

  /** @private */
  #render() {
    if (!this.el) return;
    this.el.innerHTML = '';
    const all = this.#chip('ALL', 'All', '#999');
    this.el.appendChild(all);
    for (const d of this.devices) {
      this.el.appendChild(this.#chip(d.id, d.label, d.color));
    }
    this.#highlight();
  }

  /**
   * チップ要素を生成する。
   * @private
   * @param {string} id - deviceId または 'ALL'
   * @param {string} label - 表示ラベル
   * @param {string} [color] - デバイスカラー
   * @returns {HTMLButtonElement} ボタン要素
   */
  #chip(id, label, color) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.id = id;
    b.textContent = label;
    // 初期状態では非アクティブなので aria-pressed="false" を設定
    b.setAttribute('aria-pressed', 'false');
    if (color) b.style.borderColor = color;
    return b;
  }

  /** @private */
  #highlight() {
    if (!this.el) return;
    const active = this.store.current?.filter || 'ALL';
    this.el.querySelectorAll('.chip').forEach((b) => {
      const on = b.dataset.id === active;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
}
