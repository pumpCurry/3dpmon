/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 ログ管理ユーティリティ
 * @file logger.js
 * -----------------------------------------------------------
 * @module shared/logger
 *
 * 【機能内容サマリ】
 * - イベントバスからのログを保持
 * - 種別フィルタと最大200件のバッファを提供
 *
 * 【公開定数一覧】
 * - {@link buffer}：ログ配列
 * - {@link listen}：bus 監視開始
 * - {@link push}：手動ログ追加
 * - {@link filter}：種別で抽出
 *
 * @version 1.390.618 (PR #286)
 * @since   1.390.618 (PR #286)
 * @lastModified 2025-07-02 09:09:00
 * -----------------------------------------------------------
 * @todo
 * - なし
 */

/** @type {Array<string>} */
export const buffer = [];

/**
 * バッファへメッセージを追加する。
 * 最大200件を保持する。
 *
 * @param {string} str - 追加するログ
 * @returns {void}
 */
export function push(str) {
  buffer.push(str);
  if (buffer.length > 200) buffer.shift();
}

/**
 * bus の log:add を監視して push する。
 *
 * @param {Object} bus - EventBus インスタンス
 * @returns {void}
 */
export function listen(bus) {
  bus.on('log:add', push);
}

/**
 * 指定種別のログを取得する。
 *
 * @param {string} kind - 'All'|'WS'|'Error'
 * @returns {Array<string>} 取得結果配列
 */
export function filter(kind) {
  if (kind === 'All') return [...buffer];
  return buffer.filter(line => line.startsWith(`[${kind}]`));
}

export default { buffer, push, listen, filter };
