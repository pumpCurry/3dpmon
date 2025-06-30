/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 接続管理モーダルモジュール
 * @file ConnManagerModal.js
 * -----------------------------------------------------------
 * @module dialogs/ConnManagerModal
 *
 * 【機能内容サマリ】
 * - 接続設定の一覧表示と追加・削除を行うモーダル
 *
 * 【公開クラス一覧】
 * - {@link ConnManagerModal}：接続設定モーダルクラス
 *
 * @version 1.390.600 (PR #277)
 * @since   1.390.600 (PR #277)
 * @lastModified 2025-07-01 12:00:00
 * -----------------------------------------------------------
 * @todo
 * - 編集機能の強化
 */

/* eslint-env browser */

export default class ConnManagerModal {
  /**
   * @param {Object} bus - EventBus インスタンス
   */
  constructor(bus) {
    /** @type {Object} */
    this.bus = bus;
    /** @type {HTMLDialogElement|null} */
    this.dialog = null;
  }

  /**
   * モーダルを開く。
   * @returns {void}
   */
  open() {
    if (this.dialog) return;
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'conn-manager';
    this.dialog.setAttribute('role', 'dialog');
    this.dialog.setAttribute('aria-modal', 'true');
    this.dialog.innerHTML = `
      <form method="dialog">
        <label>IP <input name="ip" required></label>
        <label>WS <input name="ws" type="number" required></label>
        <label>Cam <input name="cam" type="number"></label>
        <button type="submit">Save</button>
        <button type="button" data-close>Close</button>
      </form>
      <table><tbody></tbody></table>
    `;
    this.dialog.querySelector('[data-close]').addEventListener('click', () => this.close());
    this.dialog.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const form = /** @type {HTMLFormElement} */ (e.target);
      const ip = form.ip.value.trim();
      const ws = form.ws.value.trim();
      const cam = form.cam.value.trim();
      if (ConnManagerModal.validate(ip, ws, cam)) {
        this.bus.emit('conn:add', { ip, wsPort: Number(ws), camPort: Number(cam) });
        this.close();
      } else {
        form.reportValidity();
      }
    });
    document.body.appendChild(this.dialog);
    this.#renderList();
    this.dialog.showModal();
  }

  /**
   * モーダルを閉じて DOM から削除する。
   * @returns {void}
   */
  close() {
    if (!this.dialog) return;
    this.dialog.close();
    this.dialog.remove();
    this.dialog = null;
  }

  /**
   * 現在保存されている接続一覧を表示する。
   * @private
   * @returns {void}
   */
  #renderList() {
    if (!this.dialog) return;
    const tbody = this.dialog.querySelector('tbody');
    if (!tbody) return;
    const list = JSON.parse(window.localStorage.getItem('connections') || '[]');
    tbody.textContent = '';
    list.forEach((c) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${c.ip}</td><td>${c.wsPort}</td>`;
      tbody.appendChild(tr);
    });
  }

  /**
   * 入力値を検証する。
   *
   * @param {string} ip - IP アドレス
   * @param {string} ws - WebSocket ポート
   * @param {string} cam - カメラポート
   * @returns {boolean} 検証結果
   */
  static validate(ip, ws, cam) {
    const ipOk = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip);
    const portOk = (p) => /^\d+$/.test(p) && Number(p) > 0 && Number(p) < 65536;
    return ipOk && portOk(ws) && (cam === '' || portOk(cam));
  }
}
