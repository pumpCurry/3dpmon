/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 レイアウトエクスポートモジュール
 * @file backup.js
 * -----------------------------------------------------------
 * @module core/backup
 *
 * 【機能内容サマリ】
 * - レイアウトと接続設定をまとめて出力するヘルパ
 *
 * 【公開関数一覧】
 * - {@link exportLayouts}：localStorage からレイアウトと接続を収集
 *
 * @version 1.390.653 (PR #303)
 * @since   1.390.653 (PR #303)
 * @lastModified 2025-07-04 12:00:00
 * -----------------------------------------------------------
 * @todo
 * - なし
 */

import LayoutStore from './LayoutStore.js';

/**
 * localStorage からレイアウトと接続情報を取得して返す。
 *
 * @function exportLayouts
 * @returns {{connections:Object[], layouts:Object[]}} - 出力データ
 */
export function exportLayouts() {
  const store = new LayoutStore();
  const layouts = store.getAll();
  let connections = [];
  try {
    const raw = window.localStorage.getItem('connections');
    connections = raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('[exportLayouts]', e);
  }
  return { connections, layouts };
}
