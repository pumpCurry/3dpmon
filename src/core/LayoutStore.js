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
* @version 1.390.653 (PR #303)
* @since   1.390.635 (PR #295)
* @lastModified 2025-07-04 12:00:00
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
   * JSON 配列からレイアウトをインポートする。既存と同名の場合は末尾に
   * " (n)" を付与して追加入力する。
   *
   * @param {Array<import('../types').Layout>} layouts - 取り込み対象レイアウト
   *   配列
   * @returns {number} 追加した件数
   */
  importJson(layouts) {
    const list = this.getAll();
    let added = 0;
    for (const lt of layouts) {
      const base = lt.name;
      let name = base;
      let n = 2;
      while (list.some(l => l.name === name)) {
        name = `${base} (${n++})`;
      }
      list.push({ ...lt, id: this.generateId(), name });
      added += 1;
    }
    localStorage.setItem(this.#key, JSON.stringify(list));
    return added;
  }

  /**
   * 現在のレイアウトを取得する。
   *
   * @returns {import('../types').Layout|undefined} - レイアウト
   */
  getCurrentLayout() {
    return this.current;
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
