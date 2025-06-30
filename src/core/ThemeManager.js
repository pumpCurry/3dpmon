/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 テーマ管理モジュール
 * @file ThemeManager.js
 * -----------------------------------------------------------
 * @module core/ThemeManager
 *
 * 【機能内容サマリ】
 * - Light/Dark/Printer のテーマ切替を管理
 * - localStorage へ保存し起動時に復元
 *
 * 【公開関数一覧】
 * - {@link initTheme}：保存値の自動適用
 * - {@link setTheme}：テーマを適用し保存
 * - {@link getTheme}：現在のテーマ取得
 * - {@link store}：内部ストレージラッパー
 *
 * @version 1.390.597 (PR #276)
 * @since   1.390.597 (PR #276)
 * @lastModified 2025-07-01 12:00:00
 * -----------------------------------------------------------
 * @todo
 * - プリンタごとの詳細カラー反映
 */

/* eslint-env browser */

/**
 * 使用可能なテーマ一覧。
 * @constant {Array<'light'|'dark'|'printer'>}
 */
export const THEMES = ['light', 'dark', 'printer'];

/**
 * ストレージアクセス用ラッパー。
 * 将来的に indexedDB 等へ差し替え可能とする。
 *
 * @constant {Object}
 * @property {(k:string)=>string|null} get - 取得関数
 * @property {(k:string,v:string)=>void} set - 保存関数
 */
export const store = {
  get(k) {
    return window.localStorage.getItem(k);
  },
  set(k, v) {
    window.localStorage.setItem(k, v);
  }
};

/**
 * 現在適用されているテーマ名。
 * @private
 * @type {'light'|'dark'|'printer'}
 */
let current = 'light';

/**
 * 現在のテーマを取得する。
 *
 * @function getTheme
 * @returns {'light'|'dark'|'printer'} テーマ名
 */
export function getTheme() {
  return current;
}

/**
 * 指定テーマを適用し保存する。
 *
 * @function setTheme
 * @param {'light'|'dark'|'printer'} t - 適用するテーマ
 * @returns {void}
 */
export function setTheme(t) {
  if (!THEMES.includes(t)) return;
  current = t;
  document.documentElement.dataset.theme = t;
  store.set('theme', t);

  if (t === 'printer') {
    const conn = window.connection ?? { model: 'K1' };
    const color = conn.model === 'K1-Max' ? 'orange' : 'teal';
    document.documentElement.style.setProperty('--color-bg', color);
  } else {
    document.documentElement.style.removeProperty('--color-bg');
  }
}

/**
 * 起動時に保存されたテーマを適用する。
 *
 * @function initTheme
 * @returns {void}
 */
export function initTheme() {
  const saved = store.get('theme');
  setTheme(saved && THEMES.includes(saved) ? saved : 'light');
}
