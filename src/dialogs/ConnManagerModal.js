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
 * @version 1.390.602 (PR #278)
 * @since   1.390.600 (PR #277)
 * @lastModified 2025-07-01 08:38:00
 * -----------------------------------------------------------
 * @todo
 * - 編集機能の強化
 */

/* eslint-env browser */

export default class ConnManagerModal {
  /** @type {RegExp} */
  static ipRe = /^(25[0-5]|2[0-4]\d|1?\d{1,2})(\.(25[0-5]|2[0-4]\d|1?\d{1,2})){3}$/;

  /** @type {RegExp} */
  static portRe = /^(6553[0-5]|655[0-2]\d|65[0-4]\d{2}|6[0-4]\d{3}|[1-5]?\d{0,4})$/;
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
        <div class="conn-row">
          <input name="ip" placeholder="IP" required>
          <input name="ws" placeholder="WS" type="number" required>
          <input name="cam" placeholder="Cam" type="number">
          <button type="submit" tabindex="1">Save</button>
          <button type="button" data-close tabindex="3">×</button>
        </div>
      </form>
      <table><tbody></tbody></table>
    `;
    this.dialog.querySelector('[data-close]')?.addEventListener('click', () => this.close());
    this.dialog.querySelector('form')?.addEventListener('submit', (e) => this.#onSave(e));
    this.dialog.addEventListener('click', (e) => {
      const btn = (e.target instanceof HTMLElement) && e.target.closest('button[data-id]');
      if (btn) {
        this.#onDelete(btn.dataset.id);
      }
    });
    document.body.appendChild(this.dialog);
    this.#renderList();
    this.dialog.showModal();
    const ipBox = this.dialog.querySelector('input[name="ip"]');
    ipBox?.focus();
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
      tr.innerHTML = `
        <td>${c.ip}</td>
        <td>${c.wsPort}</td>
        <td><button type="button" data-id="${c.id}" tabindex="2">Del</button></td>`;
      tbody.appendChild(tr);
    });
  }

  /**
   * フォーム送信時の処理を行う。
   *
   * @private
   * @param {SubmitEvent} e - submit イベント
   * @returns {void}
   */
  #onSave(e) {
    e.preventDefault();
    const form = /** @type {HTMLFormElement} */ (e.target);
    const ip = form.ip.value.trim();
    const ws = form.ws.value.trim();
    const cam = form.cam.value.trim();
    const ipValid = ConnManagerModal.ipRe.test(ip);
    const wsValid = ConnManagerModal.portRe.test(ws);
    const camValid = cam === '' || ConnManagerModal.portRe.test(cam);
    form.ip.classList.toggle('invalid', !ipValid);
    form.ws.classList.toggle('invalid', !wsValid);
    form.cam.classList.toggle('invalid', !camValid);
    if (ipValid && wsValid && camValid) {
      this.bus.emit('conn:add', { ip, wsPort: Number(ws), camPort: cam ? Number(cam) : undefined });
      this.close();
    }
  }

  /**
   * 削除ボタン押下時に発火する処理。
   *
   * @private
   * @param {string} id - 接続 ID
   * @returns {void}
   */
  #onDelete(id) {
    this.bus.emit('conn:remove', { id });
    this.#renderList();
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
    const ipOk = ConnManagerModal.ipRe.test(ip);
    const portOk = ConnManagerModal.portRe.test(ws);
    const camOk = cam === '' || ConnManagerModal.portRe.test(cam);
    return ipOk && portOk && camOk;
  }
}
