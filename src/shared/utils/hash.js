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
* @version 1.390.578 (PR #267)
* @since   1.390.537 (PR #246)
* @lastModified 2025-06-30 10:14:14
 * -----------------------------------------------------------
 * @todo
 * - なし
 * @function sha1Hex
 */

/**
 * Web Crypto API または Node.js の crypto モジュールを利用して SHA-1
 * ハッシュを計算する。ブラウザ環境では `crypto.subtle.digest` を使用し、
 * それが利用できない場合は Node.js の `createHash` で代替する。
 *
 * @async
 * @param {string} str - ハッシュ化する文字列
 * @returns {Promise<string>} SHA-1 ハッシュの16進表現
 */
export async function sha1Hex(str) {
  // ブラウザまたは Node 両方で利用可能な Web Crypto API が存在する場合は
  // そちらを優先して利用する。Node.js v20 以降では安定版である。
  if (globalThis.crypto && globalThis.crypto.subtle) {
    const data = new TextEncoder().encode(str);
    const digest = await globalThis.crypto.subtle.digest('SHA-1', data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // 上記 API が無い環境、主に Node.js < v20 を想定。
  // この場合は動的 import で `node:crypto` を読み込み、createHash を利用する。
  const { createHash } = await import('node:crypto');
  return createHash('sha1').update(str).digest('hex');
}
