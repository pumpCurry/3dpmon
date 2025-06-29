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
* @version 1.390.571 (PR #263)
* @since   1.390.537 (PR #246)
* @lastModified 2025-06-29 21:24:38
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
import { sha1 } from 'js-sha1';

export function sha1Hex(str) {
  // js-sha1 はブラウザと Node 両方で動作する軽量実装
  // 文字列から SHA-1 ダイジェストを生成し16進表現のまま返す
  return sha1(str);
}
