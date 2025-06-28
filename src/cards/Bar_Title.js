/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 TitleBar コンポーネント
 * @file Bar_Title.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * -----------------------------------------------------------
 * @module cards/Bar_Title
 *
 * 【機能内容サマリ】
 * - 最上位バーとして接続タブを表示
 * - タブ選択時に EventBus へ通知
 *
 * 【公開クラス一覧】
 * - {@link TitleBar}：タイトルバー UI クラス
 *
* @version 1.390.554 (PR #254)
 * @since   1.390.531 (PR #1)
* @lastModified 2025-06-28 12:39:10
 * -----------------------------------------------------------
 * @todo
 * - なし
 */

import BaseBar from './BaseBar.js';

/**
 * タイトルバーを表すクラス。
 */
export default class TitleBar extends BaseBar {
  /** @type {string} */
  static id = 'TTLB';

  /**
   * @param {Object} bus - EventBus インスタンス
   */
  constructor(bus) {
    super(bus);
    /** @type {Array<{id:string,label:string,color?:string,icon?:string}>} */
    this.tabs = [];
    /** @type {string|null} */
    this.activeId = null;
  }

  /**
   * DOM 要素を生成し mount する。
   *
   * @param {HTMLElement} root - ルート要素
   * @override
   * @returns {void}
   */
  mount(root) {
    this.el = document.createElement('div');
    this.el.className = 'title-bar';

    const menu = document.createElement('button');
    menu.className = 'hamburger';
    menu.textContent = '≡';
    // グローバルメニュー呼び出しまでの暫定実装
    menu.addEventListener('click', () => {
      this.bus.emit('menu:global');
    });
    this.el.appendChild(menu);

    this.nav = document.createElement('nav');
    this.nav.className = 'tabs';
    this.nav.setAttribute('role', 'tablist');
    this.el.appendChild(this.nav);

    this.nav.addEventListener('click', (e) => {
      const t = e.target;
      if (t instanceof HTMLElement && t.classList.contains('tab')) {
        this.activate(t.dataset.id);
      }
    });

    this.nav.addEventListener('keydown', (e) => {
      const tabs = Array.from(this.nav.querySelectorAll('.tab'));
      const idx = tabs.findIndex((b) => b.dataset.id === this.activeId);
      if (idx === -1) return;
      if (e.key === 'ArrowRight') {
        const next = tabs[(idx + 1) % tabs.length];
        this.activate(next.dataset.id);
        next.focus();
      } else if (e.key === 'ArrowLeft') {
        const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
        this.activate(prev.dataset.id);
        prev.focus();
      } else if (e.key === 'Enter') {
        this.bus.emit('tab:select', this.activeId);
      }
    });

    super.mount(root);
    this.#renderTabs();
  }

  /**
   * タブ一覧を設定し再描画する。
   *
   * @param {Array<{id:string,label:string,color?:string,icon?:string}>} tabs - タブ情報配列
   * @returns {void}
   */
  setTabs(tabs) {
    this.tabs = [...tabs];
    this.activeId = tabs[0]?.id ?? null;
    this.#renderTabs();
  }

  /**
   * 新しいタブを追加して描画する。
   *
   * @param {{id:string,label:string,color?:string,icon?:string}} meta - タブ情報
   * @returns {void}
   */
  addTab(meta) {
    this.tabs.push(meta);
    this.#renderTabs();
    this.bus.emit('tab:add', meta.id);
  }

  /**
   * 指定 ID のタブを削除する。
   *
   * @param {string} id - タブ ID
   * @returns {void}
   */
  removeTab(id) {
    this.tabs = this.tabs.filter((t) => t.id !== id);
    if (this.activeId === id) this.activeId = this.tabs[0]?.id ?? null;
    this.#renderTabs();
    this.bus.emit('tab:remove', id);
  }

  /**
   * タブをアクティブ表示し選択イベントを発火する。
   *
   * @param {string} id - タブ ID
   * @returns {void}
   */
  activate(id) {
    this.activeId = id;
    this.#updateActive();
    this.bus.emit('tab:select', id);
  }

  /**
   * DOM 上のタブ群を再構築する内部メソッド。
   *
   * @private
   * @returns {void}
   */
  #renderTabs() {
    if (!this.nav) return;
    this.nav.textContent = '';
    this.tabs.forEach((t) => {
      const btn = document.createElement('button');
      btn.className = 'tab';
      btn.dataset.id = t.id;
      btn.textContent = t.label;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-controls', `panel-${t.id}`);
      btn.setAttribute('tabindex', t.id === this.activeId ? '0' : '-1');
      btn.setAttribute('aria-selected', t.id === this.activeId ? 'true' : 'false');
      if (t.color) btn.style.setProperty('--tab-color', t.color);
      if (t.id === this.activeId) btn.classList.add('active');
      this.nav.appendChild(btn);
    });
  }

  /**
   * アクティブ状態だけを更新する。
   *
   * @private
   * @returns {void}
   */
  #updateActive() {
    if (!this.nav) return;
    this.nav.querySelectorAll('.tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.id === this.activeId);
      btn.setAttribute('aria-selected', btn.dataset.id === this.activeId ? 'true' : 'false');
      btn.setAttribute('tabindex', btn.dataset.id === this.activeId ? '0' : '-1');
    });
  }
}
