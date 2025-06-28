/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 WebSocket 接続管理クラス
 * @file ConnectionManager.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * -----------------------------------------------------------
 * @module core/ConnectionManager
 *
 * 【機能内容サマリ】
 * - プリンタごとの WebSocket 接続を管理しイベントバスへ転送
 * - 自動再接続機能を備える
 *
 * 【公開クラス一覧】
 * - {@link ConnectionManager}：接続管理クラス
 *
* @version 1.390.536 (PR #245)
* @since   1.390.536 (PR #245)
* @lastModified 2025-06-28 19:30:39
 * -----------------------------------------------------------
 * @todo
 * - DashboardManager 連携
 */

import { sha1Hex } from '@shared/utils/hash.js';

/**
 * WebSocket 接続を管理するクラス。
 */
export class ConnectionManager {
  /** @type {Map<string, {socket: WebSocket|null, meta: Object, state: string, retry: number}>} */
  #registry = new Map();

  /**
   * @param {Object} bus - EventBus インスタンス
   */
  constructor(bus) {
    /** @type {Object} */
    this.bus = bus;
  }

  /**
   * 接続メタデータを追加する。まだソケットは接続しない。
   *
   * @param {{ip:string, wsPort:number, camPort?:number}} config - 接続設定
   * @returns {Promise<string>} 生成された接続 ID
   */
  async add(config) {
    const id = await sha1Hex(`${config.ip}:${config.wsPort}`);
    this.#registry.set(id, { socket: null, meta: { ...config }, state: 'closed', retry: 0 });
    return id;
  }

  /**
   * 指定 ID の接続を開始する。
   *
   * @param {string} connectionId - 接続 ID
   * @returns {Promise<void>} 処理完了を示す Promise
   */
  async connect(connectionId) {
    const entry = this.#registry.get(connectionId);
    if (!entry || entry.state === 'open' || entry.state === 'connecting') return;

    entry.state = 'connecting';
    const url = `ws://${entry.meta.ip}:${entry.meta.wsPort}`;
    const ws = new WebSocket(url);
    entry.socket = ws;

    ws.addEventListener('open', () => {
      entry.state = 'open';
      entry.retry = 0;
      this.bus.emit('cm:open', { id: connectionId });
    });

    ws.addEventListener('message', (evt) => {
      try {
        const data = JSON.parse(evt.data);
        this.bus.emit('cm:message', { id: connectionId, data });
      } catch (e) {
        console.error('[cm] parse error', e);
      }
    });

    ws.addEventListener('error', (e) => {
      this.bus.emit('cm:error', { id: connectionId, error: e });
    });

    ws.addEventListener('close', () => {
      entry.state = 'closed';
      this.bus.emit('cm:close', { id: connectionId });
      this.#scheduleReconnect(connectionId);
    });
  }

  /**
   * 接続済みソケットへ JSON を送信する。
   *
   * @param {string} connectionId - 接続 ID
   * @param {Object} json - 送信する JSON オブジェクト
   * @returns {void}
   */
  send(connectionId, json) {
    const entry = this.#registry.get(connectionId);
    if (entry && entry.socket && entry.state === 'open') {
      entry.socket.send(JSON.stringify(json));
    }
  }

  /**
   * 手動で接続を閉じる。
   *
   * @param {string} connectionId - 接続 ID
   * @returns {void}
   */
  close(connectionId) {
    const entry = this.#registry.get(connectionId);
    if (entry && entry.socket) {
      entry.socket.close();
    }
  }

  /**
   * 現在の接続状態を取得する。
   *
   * @param {string} connectionId - 接続 ID
   * @returns {'open'|'connecting'|'closed'} 接続状態
   */
  getState(connectionId) {
    return this.#registry.get(connectionId)?.state ?? 'closed';
  }

  /**
   * 登録されている接続メタ一覧を返す。
   *
   * @returns {Array<Object>} 接続メタ情報配列
   */
  list() {
    return [...this.#registry.entries()].map(([id, { meta, state }]) => ({ id, ...meta, state }));
  }

  /**
   * 再接続をスケジュールする内部メソッド。
   *
   * @private
   * @param {string} connectionId - 接続 ID
   * @returns {void}
   */
  #scheduleReconnect(connectionId) {
    const entry = this.#registry.get(connectionId);
    if (!entry) return;
    entry.retry = Math.min(entry.retry + 1, 6);
    const delay = Math.min(60000, 1000 * 2 ** entry.retry);
    setTimeout(() => {
      this.connect(connectionId);
    }, delay);
  }
}
