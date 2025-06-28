/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 起動スクリプト
 * @file startup.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * -----------------------------------------------------------
 * @module startup
 *
 * 【機能内容サマリ】
 * - Vite 雛形としてブラウザに基本メッセージを表示する
 *
 * 【公開関数一覧】
 * - {@link main}：起動処理を実行
 *
* @version 1.390.536 (PR #245)
* @since   1.390.536 (PR #245)
* @lastModified 2025-06-28 19:30:39
 * -----------------------------------------------------------
 * @todo
 * - AuthGate と App モジュールの統合
 * @function main
 */

/* eslint-env browser */
import { bus } from '@core/EventBus.js';
import { ConnectionManager } from '@core/ConnectionManager.js';

console.log('[startup] bootstrap v2 skeleton');

/**
 * アプリケーションのエントリポイント。
 * 仮の認証ステップを省略し、単純なテキストを画面に表示する。
 *
 * @async
 * @returns {Promise<void>} 処理完了を示す Promise
 */
async function main() {
  const root = document.querySelector('#app-root');
  root.textContent = 'Hello, 3dpmon v2 skeleton!';

  const cm = new ConnectionManager(bus);
  const id = await cm.add({ ip: '127.0.0.1', wsPort: 9999 });
  cm.connect(id);

  bus.on('cm:message', ({ id: cid, data }) => {
    console.log('[cm]', cid, data);
  });
}

main();
