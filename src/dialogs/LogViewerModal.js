/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 ログビューアモーダル
 * @file LogViewerModal.js
 * -----------------------------------------------------------
 * @module dialogs/LogViewerModal
 *
 * 【機能内容サマリ】
 * - bus.emit('log:add') された文字列を表示
 * - フィルタタブで種別を絞り込み
 *
 * 【公開クラス一覧】
 * - {@link LogViewerModal}：ログ表示モーダルクラス
 *
 * @version 1.390.620 (PR #287)
 * @since   1.390.618 (PR #286)
 * @lastModified 2025-07-01 18:43:23
 * -----------------------------------------------------------
 * @todo
 * - なし
 */

/* eslint-env browser */

import logger from '../shared/logger.js';

/**
 * ログ表示用モーダルダイアログ。
 */
export default class LogViewerModal {
  /**
   * @param {Object} bus - EventBus インスタンス
   */
  constructor(bus) {
    /** @type {Object} */
    this.bus = bus;
    /** @type {HTMLDialogElement|null} */
    this.dialog = null;
    /** @type {string} */
    this.filter = 'All';
    this._onAdd = (s) => this.#append(s);
  }

  /**
   * モーダルを開く。
   * @returns {void}
   */
  open() {
    if (this.dialog) return;
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'log-viewer';
    this.dialog.innerHTML = `
      <div class="filters">
        <button data-f="All">All</button>
        <button data-f="WS">WS</button>
        <button data-f="Error">Error</button>
        <button data-close style="float:right">×</button>
      </div>
      <pre></pre>
    `;
    this.dialog.querySelector('[data-close]')?.addEventListener('click', () => this.close());
    this.dialog.querySelectorAll('[data-f]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.filter = btn.dataset.f || 'All';
        this.#render();
      });
    });
    this.dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
    document.body.appendChild(this.dialog);
    this.bus.on('log:add', this._onAdd);
    this.#render();
    this.dialog.showModal();
  }

  /**
   * モーダルを閉じる。
   * @returns {void}
   */
  close() {
    if (!this.dialog) return;
    this.bus.off('log:add', this._onAdd);
    this.dialog.close();
    this.dialog.remove();
    this.dialog = null;
  }

  /**
   * ログを追記しスクロール位置を末尾へ移動する。
   * @private
   * @param {string} str - 追加するログ文字列
   * @returns {void}
   */
  #append(str) {
    if (!this.dialog) return;
    const pre = this.dialog.querySelector('pre');
    if (pre) {
      pre.textContent += `${str}\n`;
      pre.scrollTop = pre.scrollHeight;
    }
  }

  /**
   * 現在のフィルタでログを再表示する。
   * @private
   * @returns {void}
   */
  #render() {
    if (!this.dialog) return;
    const pre = this.dialog.querySelector('pre');
    if (pre) {
      pre.textContent = logger.filter(this.filter).join('\n');
      pre.scrollTop = pre.scrollHeight;
    }
  }
}
