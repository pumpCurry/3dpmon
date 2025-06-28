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
 * @version 1.390.549 (PR #252)
 * @since   1.390.536 (PR #245)
 * @lastModified 2025-06-28 20:00:00
 * -----------------------------------------------------------
 * @todo
 * - AuthGate と App モジュールの統合
 * @function main
 */

/* eslint-env browser */
import { App } from './core/App.js';
import { bus } from '@core/EventBus.js';
import { ConnectionManager } from '@core/ConnectionManager.js';

console.log('[startup] bootstrap v2 skeleton');

/**
 * アプリケーションのエントリポイント。
 *
 * @async
 * @returns {Promise<void>} 処理完了を示す Promise
 */
async function main() {
  const cm = new ConnectionManager(bus);
  const id = await cm.add({ ip: '127.0.0.1', wsPort: 9999 });
  cm.connect(id);

  bus.on('cm:message', ({ id: cid, data }) => {
    console.log('[cm]', cid, data);
  });

  new App('#app-root');
}

main();
