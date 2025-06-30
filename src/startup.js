/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 起動スクリプト
 * @file startup.js
 * -----------------------------------------------------------
 * @module startup
 *
 * 【機能内容サマリ】
 * - アプリ初期化処理を呼び出すエントリポイント
 *
* @version 1.390.576 (PR #260)
* @since   1.390.536 (PR #245)
* @lastModified 2025-06-30 12:00:00
 * -----------------------------------------------------------
 * @todo
 * - AuthGate と App モジュールの統合
 * @function main
 */

/* eslint-env browser */
import { App } from './core/App.js';

console.log('[startup] bootstrap v2 skeleton');

/**
 * アプリケーションのエントリポイント。
 *
 * @async
 * @returns {Promise<void>} 処理完了を示す Promise
 */
async function main() {
  new App('#app-root');
}

main();
