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
* @version 1.390.536 (PR #245)
* @since   1.390.536 (PR #245)
* @lastModified 2025-06-28 19:30:39
 * -----------------------------------------------------------
 * @todo
 * - なし
 * @function sha1Hex
 */

/**
 * 与えられた文字列から SHA-1 ハッシュを生成して16進表現で返す。
 *
 * @param {string} str - ハッシュ化する文字列
 * @returns {Promise<string>} SHA-1 ハッシュの16進表現
 */
export async function sha1Hex(str) {
  const enc = new TextEncoder();
  const data = enc.encode(str);
  const digest = await crypto.subtle.digest('SHA-1', data);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
