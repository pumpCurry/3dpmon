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
* @version 1.390.582 (PR #269)
* @since   1.390.536 (PR #245)
* @lastModified 2025-06-30 13:41:06
 * -----------------------------------------------------------
 * @todo
 * - AuthGate と App モジュールの統合
 * @function main
 */

/* eslint-env browser */
// SCSS トークンおよび各カードのスタイルを取り込む
import '../styles/root.scss';
import { initTheme } from './core/ThemeManager.js';
import { bus } from './core/EventBus.js';
window.bus = bus;

console.log('[startup] bootstrap v2 skeleton');

/**
 * アプリケーションのエントリポイント。
 *
 * @async
 * @returns {Promise<void>} 処理完了を示す Promise
 */
async function main() {
  initTheme();
  const root = document.querySelector('#app-root');
  const { default: SplashScreen } = await import('./splash/SplashScreen.js');
  const splash = new SplashScreen(bus);
  splash.mount(root);
  bus.on('auth:ok', async () => {
    splash.destroy();
    const { App } = await import('./core/App.js');
    new App('#app-root');
  });
}

main();
