/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 SHA-1 ハッシュ生成ユーティリティ
 * @file hash.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * -----------------------------------------------------------
 * @module shared/utils/hash
 *
 * 【機能内容サマリ】
 * - 文字列から SHA-1 ダイジェストを生成し16進表現で返す
 *
 * 【公開関数一覧】
 * - {@link sha1Hex}：SHA-1 ハッシュ文字列を生成
 *
* @version 1.390.537 (PR #246)
* @since   1.390.537 (PR #246)
* @lastModified 2025-06-28 19:47:19
 * -----------------------------------------------------------
 * @todo
 * - なし
 * @function sha1Hex
 */

/**
 * 与えられた文字列から SHA-1 ハッシュを生成して16進表現で返す。
 *
 * @param {string} str - ハッシュ化する文字列
 * @returns {string} SHA-1 ハッシュの16進表現
 */
import { createHash } from 'node:crypto';

export function sha1Hex(str) {
  return createHash('sha1').update(str).digest('hex');
}
