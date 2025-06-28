/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 起動モジュール
 * @file startup.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module startup
 *
 * 【機能内容サマリ】
 * - 認証処理を実行し、アプリ本体を遅延読み込みする
 *
 * 【公開関数一覧】
 * - {@link startup}：起動処理を実行する
 *
 * @version 1.390.531 (PR #1)
 * @since   1.390.531 (PR #1)
 * @lastModified 2025-06-28 09:54:02
 * -----------------------------------------------------------
 * @todo
 * - 認証方式の実装
 * - エラーハンドリング
 * @function startup
 */

import { initAuth } from './core/AuthGate.js';

/**
 * アプリケーションの起動処理を実行する。
 * 認証が成功した場合のみ App モジュールをロードして起動する。
 *
 * @async
 * @returns {Promise<void>} 認証が成功した場合は解決する Promise
 */
export async function startup() {
  // 認証処理を実行して結果を待つ
  if (await initAuth()) {
    // 認証成功後に App クラスを遅延インポートしてインスタンス化
    const { App } = await import('./core/App.js');
    // ルート要素に対してアプリケーションを生成
    new App('#app-root');
  }
}

// 起動処理を即時実行
startup();
