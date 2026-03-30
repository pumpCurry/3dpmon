/**
 * @fileoverview
 * @description 3dpmon WSリレーサーバ — 子クライアントへのデータ配信とコマンド中継
 * @file electron/relay_server.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module relay_server
 *
 * 【機能内容サマリ】
 * - HTTP サーバにアタッチする WebSocket リレーサーバ
 * - 子クライアントへの state snapshot / delta 配信
 * - 子（satellite）からのコマンドを親レンダラーに中継
 *
 * @version 1.390.820 (PR #367)
 * @since   1.390.820 (PR #367)
 * -----------------------------------------------------------
 */

"use strict";

const { WebSocketServer } = require("ws");

/**
 * 接続中の子クライアントセッション
 * @typedef {Object} RelayClient
 * @property {import("ws").WebSocket} ws - WebSocket接続
 * @property {string} mode - "readonly" | "satellite"
 * @property {number} connectedAt - 接続時刻
 * @property {string} id - クライアントID
 */

/** @type {Set<RelayClient>} */
const _clients = new Set();

/** @type {import("ws").WebSocketServer|null} */
let _wss = null;

/** メインウィンドウへのIPC送信用コールバック */
let _sendToRenderer = null;

/** クライアントID採番用 */
let _clientSeq = 0;

/**
 * WSリレーサーバを起動する。
 * 既存のHTTPサーバにアタッチし、子クライアントのWebSocket接続を受け付ける。
 *
 * @param {import("http").Server} httpServer - アタッチ先のHTTPサーバ
 * @param {Object} options - オプション
 * @param {Function} options.sendToRenderer - レンダラーにIPCメッセージを送る関数
 * @returns {Object} リレーサーバAPI
 */
function startRelayServer(httpServer, options = {}) {
  _sendToRenderer = options.sendToRenderer || null;

  _wss = new WebSocketServer({ server: httpServer });

  _wss.on("connection", (ws, req) => {
    // モード判定: URLクエリパラメータから
    const url = new URL(req.url, "http://localhost");
    const mode = url.searchParams.get("mode") || "readonly";
    const validMode = (mode === "satellite") ? "satellite" : "readonly";

    const client = {
      ws,
      mode: validMode,
      connectedAt: Date.now(),
      id: `client-${++_clientSeq}`
    };
    _clients.add(client);

    console.log(`[relay] 子クライアント接続: ${client.id} (${validMode}) — 合計${_clients.size}台`);

    // 初期化メッセージ送信
    _safeSend(ws, {
      type: "relay-init",
      mode: validMode,
      clientId: client.id,
      serverTime: Date.now()
    });

    // スナップショット要求を親レンダラーに依頼
    if (_sendToRenderer) {
      _sendToRenderer("relay-request-snapshot", { clientId: client.id });
    }

    // 子からのメッセージ処理
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      _handleClientMessage(client, msg);
    });

    ws.on("close", () => {
      _clients.delete(client);
      console.log(`[relay] 子クライアント切断: ${client.id} — 残${_clients.size}台`);
    });

    ws.on("error", (err) => {
      console.warn(`[relay] クライアントエラー ${client.id}:`, err.message);
    });
  });

  console.log("[relay] WSリレーサーバ起動完了");

  return {
    broadcastDelta,
    sendToClient,
    getClientCount: () => _clients.size,
    getClients: () => [..._clients].map(c => ({ id: c.id, mode: c.mode, connectedAt: c.connectedAt }))
  };
}

/**
 * 全子クライアントにデルタ更新を配信する。
 * aggregator 周期ごとに呼び出される。
 *
 * @param {Object} delta - 差分データ
 * @param {Object} delta.machines - per-host変更 { hostname: { key: value } }
 * @param {Object} [delta.shared] - 共有データ変更（filamentSpools等）
 */
function broadcastDelta(delta) {
  if (_clients.size === 0) return;
  const msg = JSON.stringify({ type: "relay-delta", ...delta, timestamp: Date.now() });
  for (const client of _clients) {
    if (client.ws.readyState === 1) { // OPEN
      client.ws.send(msg);
    }
  }
}

/**
 * 特定のクライアントにメッセージを送信する。
 * スナップショット送信時に使用。
 *
 * @param {string} clientId - 対象クライアントID
 * @param {Object} data - 送信データ
 */
function sendToClient(clientId, data) {
  for (const client of _clients) {
    if (client.id === clientId && client.ws.readyState === 1) {
      _safeSend(client.ws, data);
      break;
    }
  }
}

/**
 * 子クライアントからのメッセージを処理する。
 *
 * @private
 * @param {RelayClient} client - 送信元クライアント
 * @param {Object} msg - 受信メッセージ
 */
function _handleClientMessage(client, msg) {
  // readonly モードはコマンド送信不可
  if (client.mode === "readonly" && msg.type !== "relay-ping") {
    _safeSend(client.ws, { type: "relay-error", message: "Readonly mode: commands not allowed" });
    return;
  }

  switch (msg.type) {
    case "relay-command":
      // プリンタコマンドの中継: 子 → 親レンダラー → プリンタ
      if (_sendToRenderer && msg.target && msg.method) {
        _sendToRenderer("relay-command", {
          target: msg.target,
          method: msg.method,
          params: msg.params || {}
        });
      }
      break;

    case "relay-filament":
      // フィラメント操作の中継: 子 → 親レンダラー
      if (_sendToRenderer && msg.action) {
        _sendToRenderer("relay-filament", {
          action: msg.action,
          data: msg.data || {}
        });
      }
      break;

    case "relay-ping":
      _safeSend(client.ws, { type: "relay-pong", timestamp: Date.now() });
      break;

    default:
      console.debug(`[relay] 未知のメッセージタイプ: ${msg.type} from ${client.id}`);
  }
}

/**
 * WebSocket に安全に送信する（例外を吸収）。
 * @private
 */
function _safeSend(ws, data) {
  try {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    }
  } catch (e) {
    console.warn("[relay] 送信エラー:", e.message);
  }
}

module.exports = { startRelayServer };
