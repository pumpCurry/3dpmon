/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 定数定義モジュール
 * @file dashboard_constants.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_constants
 *
 * 【機能内容サマリ】
 * - ログ/通知レベルの定数を集約
 *
 * 【公開関数一覧】
 * - {@link LEVELS}：使用可能レベル配列
 * - {@link ERROR_LEVELS}：エラーレベル集合
 *
 * @version 1.390.317 (PR #143)
 * @since   1.390.193 (PR #86)
 * @lastModified 2025-06-19 22:38:18
 * -----------------------------------------------------------
 * @todo
 * - none
 */

/**
 * ログ／通知で使用可能なレベル一覧（順序もUIの選択肢順として反映）。
 * @constant {string[]}
 */
// REVIEW: 配列が外部から変更されないよう freeze しておくと安全です。
// REVIEW: 現状は ["debug","info","warn","error","normal","success"] の順ですが、
//         "normal" の位置や "success" の扱いがやや特殊なので、UI/UXに合わせて再検討を。
export const LEVELS = Object.freeze([
  "debug",
  "info",
  "warn",
  "error",
  "normal",
  "success",
  "send"
]);

/**
 * エラーレベルのセット（ログ管理や通知発火時の判断に利用）。
 * @constant {Set<string>}
 */
// REVIEW: Set も freeze して不変にすると安全です。
// REVIEW: 現在は warn と error のみを「エラー」とみなしています。
//         もし "success" や "normal" を別扱いにしたい場合は、この定義を拡張してください。
export const ERROR_LEVELS = Object.freeze(new Set([
  "warn",
  "error"
]));