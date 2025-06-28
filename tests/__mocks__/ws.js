/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 WebSocket モッククラス
 * @file ws.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * -----------------------------------------------------------
 * @module tests/__mocks__/ws
 *
 * 【機能内容サマリ】
 * - Vitest 環境で WebSocket 通信を模倣する
 *
 * 【公開クラス一覧】
 * - {@link WebSocketMock}：簡易 WebSocket モック
 *
 * @version 1.390.540 (PR #247)
 * @since   1.390.540 (PR #247)
 * @lastModified 2025-06-28 19:55:55
 * -----------------------------------------------------------
 * @todo
 * - なし
 */

export default class WebSocketMock {
  constructor(url) {
    this.url = url;
    // すぐに open イベントを発火して接続済み状態を模倣
    setTimeout(() => this.onopen?.(), 5);
  }

  /**
   * addEventListener の簡易実装。対応する onXXX ハンドラへ登録する。
   *
   * @param {string} evt - イベント名
   * @param {Function} fn - ハンドラ
   * @returns {void}
   */
  addEventListener(evt, fn) {
    this[`on${evt}`] = fn;
  }

  /**
   * メッセージ送信をエコーとして扱い、即時 onmessage を発火する。
   *
   * @param {string} msg - 送信フレーム
   * @returns {void}
   */
  send(msg) {
    setTimeout(() => this.onmessage?.({ data: msg }), 5);
  }

  /**
   * 接続を閉じたことを通知する。
   *
   * @returns {void}
   */
  close() {
    this.onclose?.();
  }
}
