/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Vitest セットアップモジュール
 * @file setup.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * -----------------------------------------------------------
 * @module tests/setup
 *
 * 【機能内容サマリ】
 * - テスト実行時に WebSocket モックを登録する
 *
 * 【公開関数一覧】
 * - なし（実行時副作用のみ）
 *
 * @version 1.390.540 (PR #247)
 * @since   1.390.540 (PR #247)
 * @lastModified 2025-06-28 19:55:55
 * -----------------------------------------------------------
 * @todo
 * - なし
 */

// Vitest 起動時に WebSocket モジュールをモック化する
vi.mock('ws', async () => ({
  default: (await import('./__mocks__/ws.js')).default
}));

// ConnectionManager がグローバルの WebSocket を利用するため、
// テスト環境ではグローバルへモックを設定する
import WebSocketMock from './__mocks__/ws.js';
globalThis.WebSocket = WebSocketMock;
