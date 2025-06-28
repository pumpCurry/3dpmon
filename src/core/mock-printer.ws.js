/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 モックプリンタ WebSocket サーバ
 * @file mock-printer.ws.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * -----------------------------------------------------------
 * @module core/mock-printer
 *
 * 【機能内容サマリ】
 * - ローカル開発用の単純なエコー WebSocket サーバ
 *
 * 【公開関数一覧】
 * - なし（実行スクリプト）
 *
* @version 1.390.536 (PR #245)
* @since   1.390.536 (PR #245)
* @lastModified 2025-06-28 19:30:39
 * -----------------------------------------------------------
 * @todo
 * - 高度なテスト応答
 */

import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 9999 });

wss.on('connection', (socket) => {
  socket.on('message', (msg) => {
    // 受信したメッセージをそのまま返すだけの単純なエコー
    socket.send(msg.toString());
  });
});

console.log('mock printer ws started on ws://127.0.0.1:9999');
