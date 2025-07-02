/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 レイアウト保存管理モジュール
 * @file LayoutStore.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * -----------------------------------------------------------
 * @module core/LayoutStore
 *
 * 【機能内容サマリ】
 * - ユーザが作成したレイアウト情報を localStorage へ保存・取得する
 *
 * 【公開クラス一覧】
 * - {@link LayoutStore}：レイアウト永続化クラス
 *
 * @version 1.390.637 (PR #296)
 * @since   1.390.635 (PR #295)
 * @lastModified 2025-07-02 21:44:27
 * -----------------------------------------------------------
 * @todo
 * - なし
 */

import { nanoid } from 'nanoid/non-secure';

/**
 * レイアウト永続化を担当するストアクラス。
 * @class
 */
export class LayoutStore {
  /** @private */
  #key = 'layouts';

  /**
   * すべてのレイアウトを取得する。
   * @returns {import('../types').Layout[]} Layout 配列
   */
  getAll() {
    const raw = localStorage.getItem(this.#key);
    if (!raw) return [];
    try {
      return JSON.parse(raw) || [];
    } catch (e) {
      console.error('LayoutStore#getAll parse error', e);
      return [];
    }
  }

  /**
   * 指定 ID のレイアウトを取得する。
   * @param {string} id - レイアウト ID
   * @returns {import('../types').Layout|undefined} レイアウトオブジェクト
   */
  get(id) {
    return this.getAll().find(l => l.id === id);
  }

  /**
   * レイアウトを保存（存在すれば更新）。
   * @param {import('../types').Layout} layout - 保存対象レイアウト
   * @returns {void}
   */
  save(layout) {
    const list = this.getAll();
    const idx = list.findIndex(l => l.id === layout.id);
    if (idx >= 0) list[idx] = layout; else list.push(layout);
    localStorage.setItem(this.#key, JSON.stringify(list));
  }

  /**
   * 指定 ID のレイアウトを削除する。
   * @param {string} id - レイアウト ID
   * @returns {void}
   */
  delete(id) {
    const list = this.getAll().filter(l => l.id !== id);
    localStorage.setItem(this.#key, JSON.stringify(list));
  }

  /**
   * 一意な ID を生成する。
   * @returns {string} 新しい ID
   */
  generateId() {
    return nanoid();
  }
}

export default LayoutStore;
