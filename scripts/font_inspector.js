/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 フォント検査ユーティリティ
 * @file font_inspector.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module font_inspector
 *
 * 【機能内容サマリ】
 * - フォントファイルに登録された文字一覧を出力
 * - 実際にデザインが存在する文字のみを抽出
 *
 * 【公開関数一覧】
 * - {@link dumpRegisteredAllChar}: 登録済みの全 Unicode 文字を出力
 * - {@link dumpExistDesignedAllChar}: デザインが存在する文字だけを出力
 *
 * @version 1.390.744 (PR #342)
 * @since   1.390.744 (PR #342)
 * @lastModified  2025-07-14 11:20:18
 * -----------------------------------------------------------
 * @todo
 * - なし
 */

import opentype from 'opentype.js';

/**
 * 指定されたフォントファイルから Unicode 文字の一覧を取得する。
 *
 * @function dumpRegisteredAllChar
 * @param {string} fontPath - フォントファイルパス
 * @returns {string[]} - 登録されている Unicode 文字一覧
 */
export function dumpRegisteredAllChar(fontPath) {
  const font = opentype.loadSync(fontPath);
  const chars = [];
  for (const glyph of font.glyphs.glyphs) {
    if (glyph.unicode !== undefined) {
      chars.push(String.fromCodePoint(glyph.unicode));
    }
  }
  return chars;
}

/**
 * フォントに実際にデザインされている文字のみを抽出する。
 *
 * 輪郭パスが存在し、かつバウンディングボックスの幅・高さが正の値
 * のものだけを対象とする。
 *
 * @function dumpExistDesignedAllChar
 * @param {string} fontPath - スキャン対象フォントパス
 * @returns {string[]} - デザイン済み文字の一覧
 */
export function dumpExistDesignedAllChar(fontPath) {
  const font = opentype.loadSync(fontPath);
  const chars = [];
  for (const glyph of font.glyphs.glyphs) {
    if (glyph.unicode === undefined) {
      continue;
    }
    if (!glyph.path || glyph.path.commands.length === 0) {
      continue;
    }
    const { x1, y1, x2, y2 } = glyph.getBoundingBox();
    if (x1 === x2 || y1 === y2) {
      continue;
    }
    chars.push(String.fromCodePoint(glyph.unicode));
  }
  return chars;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const fontArgIndex = args.findIndex((a) => a === '--target_font');
  const fontPath = fontArgIndex !== -1 ? args[fontArgIndex + 1] : null;
  if (!fontPath) {
    console.error('Usage: node font_inspector.js --target_font <path> --dump_registed_all_char|--dump_exist_designed_all_char');
    process.exit(1);
  }
  if (args.includes('--dump_registed_all_char')) {
    const list = dumpRegisteredAllChar(fontPath);
    console.log(list.join(''));
  } else if (args.includes('--dump_exist_designed_all_char')) {
    const list = dumpExistDesignedAllChar(fontPath);
    console.log(list.join(''));
  } else {
    console.error('Specify --dump_registed_all_char or --dump_exist_designed_all_char');
    process.exit(1);
  }
}
