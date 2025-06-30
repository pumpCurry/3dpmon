/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 認証ゲートモジュール
 * @file AuthGate.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module core/AuthGate
 *
 * 【機能内容サマリ】
 * - 起動時の認証処理を提供する
 *
 * 【公開関数一覧】
 * - {@link initAuth}：認証処理の初期化
 *
 * @version 1.390.580 (PR #268)
 * @since   1.390.531 (PR #1)
 * @lastModified 2025-07-01 00:00:00
 * -----------------------------------------------------------
 * @todo
 * - PIN 認証画面の実装
 * - localStorage からの設定取得
 */

/**
 * 認証処理を初期化する。
 * 現状は仮実装で常に成功する。
 *
 * @async
 * @returns {Promise<boolean>} 認証成功なら true を解決する Promise
 */
export async function initAuth() {
  // TODO: 実際の認証ロジックを実装
  return true;
}

/**
 * パスワードが設定されているか返すスタブ。
 *
 * @async
 * @returns {Promise<boolean>} 常に false を解決する Promise
 */
export async function hasPassword() {
  return false;
}

/**
 * パスワードを検証するスタブ実装。
 *
 * @async
 * @param {string} pwd - 入力されたパスワード
 * @returns {Promise<boolean>} 常に true を解決する Promise
 */
export async function validate(pwd) {
  void pwd;
  return true;
}
