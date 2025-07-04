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
* @version 1.390.657 (PR #304)
* @since   1.390.536 (PR #245)
* @lastModified 2025-07-04 12:00:00
 * -----------------------------------------------------------
 * @todo
 * - DashboardManager 連携
 */

import { sha1Hex } from '@shared/utils/hash.js';
import WSClient from './WSClient.js';

/**
 * WebSocket 接続を管理するクラス。
 */
export class ConnectionManager {
  /** @type {Map<string, {client: WSClient|null, meta: Object, state: string, retry: number}>} */
  #registry = new Map();

  /**
   * @param {Object} bus - EventBus インスタンス
   */
  constructor(bus) {
    /** @type {Object} */
    this.bus = bus;
    this.bus.on('conn:add', async (meta) => {
      const id = await this.add(meta);
      this.saveAll();
      this.bus.emit('conn:added', { id, ...meta });
    });
    this.bus.on('conn:remove', ({ id }) => {
      const entry = this.#registry.get(id);
      if (entry && entry.client) {
        entry.client.destroy();
      }
      this.#registry.delete(id);
      this.saveAll();
    });
  }

  /**
   * 接続メタデータを追加する。まだソケットは接続しない。
   *
   * @param {{ip:string, wsPort:number, camPort?:number}} config - 接続設定
   * @returns {Promise<string>} 生成された接続 ID
   */
  async add(config) {
    const id = await sha1Hex(`${config.ip}:${config.wsPort}`);
    this.#registry.set(id, { client: null, meta: { ...config }, state: 'closed', retry: 0, manual: false });
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
    const client = new WSClient(url, connectionId);
    entry.client = client;

    client.addEventListener('open', () => {
      entry.state = 'open';
      entry.retry = 0;
      this.bus.emit('cm:open', { id: connectionId });
      this.bus.emit('log:add', `[WS] ${entry.meta.ip} connected`);
    });

    client.addEventListener('message', (e) => {
      this.bus.emit('cm:message', { id: connectionId, data: e.detail });
    });

    client.addEventListener('error', (e) => {
      this.bus.emit('cm:error', { id: connectionId, error: e.detail });
    });

    client.addEventListener('close', () => {
      entry.state = 'closed';
      this.bus.emit('cm:close', { id: connectionId });
      this.bus.emit('log:add', `[WS] ${entry.meta.ip} disconnected`);
      if (!entry.manual) {
        this.#scheduleReconnect(connectionId);
      }
      entry.manual = false;
    });

    client.connect();
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
    if (entry && entry.client && entry.state === 'open') {
      entry.client.send(json);
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
    if (entry && entry.client) {
      entry.manual = true;
      entry.client.destroy();
      entry.state = 'closed';
      this.bus.emit('cm:close', { id: connectionId });
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
   * localStorage から保存済み設定を読み込む。
   * @returns {Promise<void>} 読み込み完了
   */
  async loadStored() {
    const json = window.localStorage.getItem('connections');
    if (!json) return;
    try {
      const arr = JSON.parse(json);
      for (const meta of arr) {
        const id = await this.add(meta);
        this.bus.emit('conn:added', { id, ...meta });
      }
    } catch (e) {
      console.error('[cm] loadStored', e);
    }
  }

  /**
   * 登録済み設定を localStorage へ保存する。
   * @returns {void}
   */
  saveAll() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      const arr = this.list().map(({ state, ...meta }) => meta);
      window.localStorage.setItem('connections', JSON.stringify(arr));
    }, 500);
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
    if (entry.client) {
      entry.client.destroy();
      entry.client = null;
    }
    entry.retry = Math.min(entry.retry + 1, 6);
    const delay = Math.min(60000, 1000 * 2 ** entry.retry);
    this.bus.emit('log:add', `[WS] retry in ${delay}ms`);
    setTimeout(() => {
      this.connect(connectionId);
    }, delay);
  }
}
