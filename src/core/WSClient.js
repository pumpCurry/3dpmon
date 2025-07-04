/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 WebSocket クライアントモジュール
 * @file WSClient.js
 * -----------------------------------------------------------
 * @module core/WSClient
 *
 * 【機能内容サマリ】
 * - WebSocket 接続とハートビート管理を担当
 * - 接続ロスト検知および再接続をサポート
 *
 * 【公開クラス一覧】
 * - {@link WSClient}：WebSocket クライアント
 *
* @version 1.390.657 (PR #304)
* @since   1.390.657 (PR #304)
 * @lastModified 2025-07-04 12:00:00
 * -----------------------------------------------------------
 * @todo
 * - なし
 */

import { bus } from './EventBus.js';

/**
 * WebSocket クライアント。接続管理とハートビート送受信を行う。
 */
export default class WSClient extends EventTarget {
  /**
   * @param {string} url - 接続先 URL
   * @param {string} id  - 識別子
   */
  constructor(url, id) {
    super();
    /** @type {string} */
    this.url = url;
    /** @type {string} */
    this.id = id;
    /** @type {WebSocket|null} */
    this.socket = null;
    /** @type {number} */
    this.retry = 0;
    /** @type {number|null} */
    this._hbTimer = null;
    /** @type {number|null} */
    this._monTimer = null;
    /** @type {number} */
    this.lastHb = Date.now();
    this._onOpen = this.#handleOpen.bind(this);
    this._onMsg = this.#handleMessage.bind(this);
    this._onErr = this.#handleError.bind(this);
    this._onClose = this.#handleClose.bind(this);
  }

  /**
   * WebSocket 接続を開始する。
   *
   * @returns {void}
   */
  connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('open', this._onOpen);
    this.socket.addEventListener('message', this._onMsg);
    this.socket.addEventListener('error', this._onErr);
    this.socket.addEventListener('close', this._onClose);
  }

  /**
   * JSON データを送信する。
   *
   * @param {Object} obj - 送信オブジェクト
   * @returns {void}
   */
  send(obj) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
    }
  }

  /**
   * ハートビート送信を開始する。
   *
   * @function
   * @returns {void}
   */
  startHeartbeat() {
    this.stopHeartbeat();
    this.lastHb = Date.now();
    this._hbTimer = setInterval(() => {
      this.send({ ModeCode: 'heart_beat', msg: new Date().toISOString() });
    }, 30000);
    this._monTimer = setInterval(() => {
      const diff = Date.now() - this.lastHb;
      if (diff > 45000) {
        bus.emit('printer:timeout', this.id);
        bus.emit('log:add', `[HB] lost ${this.id}`);
      }
      if (diff > 60000) {
        this.socket?.close();
      }
    }, 5000);
  }

  /**
   * ハートビート関連タイマーを停止する。
   *
   * @function
   * @returns {void}
   */
  stopHeartbeat() {
    if (this._hbTimer) {
      clearInterval(this._hbTimer);
      this._hbTimer = null;
    }
    if (this._monTimer) {
      clearInterval(this._monTimer);
      this._monTimer = null;
    }
  }

  /**
   * リソースを破棄する。
   *
   * @returns {void}
   */
  destroy() {
    this.stopHeartbeat();
    if (this.socket) {
      if (this.socket.removeEventListener) {
        this.socket.removeEventListener('open', this._onOpen);
        this.socket.removeEventListener('message', this._onMsg);
        this.socket.removeEventListener('error', this._onErr);
        this.socket.removeEventListener('close', this._onClose);
      } else {
        this.socket.onopen = null;
        this.socket.onmessage = null;
        this.socket.onerror = null;
        this.socket.onclose = null;
      }
      this.socket.close();
      this.socket = null;
    }
  }

  /**
   * open イベントハンドラ。
   *
   * @private
   * @returns {void}
   */
  #handleOpen() {
    this.dispatchEvent(new Event('open'));
    this.startHeartbeat();
  }

  /**
   * message イベントハンドラ。
   *
   * @private
   * @param {MessageEvent} evt - メッセージ
   * @returns {void}
   */
  #handleMessage(evt) {
    const txt = evt.data;
    if (txt === 'ok') {
      this.lastHb = Date.now();
      return;
    }
    let obj = null;
    try {
      obj = JSON.parse(txt);
      if (obj && obj.ModeCode === 'heart_beat') {
        this.lastHb = Date.now();
        return;
      }
    } catch {
      /* ignore parse error */
    }
    this.dispatchEvent(new CustomEvent('message', { detail: obj ?? txt }));
  }

  /**
   * error イベントハンドラ。
   *
   * @private
   * @param {Event} e - エラーイベント
   * @returns {void}
   */
  #handleError(e) {
    bus.emit('log:add', `[ERR] ${this.id} socket error`);
    this.dispatchEvent(new CustomEvent('error', { detail: e }));
  }

  /**
   * close イベントハンドラ。
   *
   * @private
   * @returns {void}
   */
  #handleClose() {
    this.stopHeartbeat();
    this.dispatchEvent(new Event('close'));
  }
}

