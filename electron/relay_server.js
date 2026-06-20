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
 * - 初回接続は常に readonly（操作権限は relay-promote-request + PIN 検証経由でのみ付与）
 *
 * @version 1.390.1110 (PR #380)
 * @since   1.390.820 (PR #367)
 * @lastModified 2026-06-12 12:00:00
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
    // ★ 初回接続は常に readonly で受け付ける（PIN 保護の徹底）。
    //   旧実装は ?mode=satellite を指定するだけで PIN 検証なしに操作権限が
    //   付与されており、昇格 PIN 機能を素通りできる穴になっていた。
    //   satellite を要求するクライアントは relay-init 受信後に
    //   relay-promote-request を送る（クライアント側で自動送信。
    //   親に PIN 未設定なら即昇格、設定済みなら PIN 入力が必要）。
    const validMode = "readonly";

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
    resolvePromote,
    getClientCount: () => _clients.size,
    getClients: () => [..._clients].map(c => ({ id: c.id, mode: c.mode, connectedAt: c.connectedAt }))
  };
}

/**
 * 親レンダラーの PIN 検証結果を受けて、対象クライアントの昇格を確定/拒否する。
 *
 * @param {string} clientId - 対象クライアントID
 * @param {boolean} granted - 昇格を許可するか
 * @param {string} [reason] - 拒否理由（"pin-required" | "pin-mismatch" 等）
 * @returns {void}
 */
function resolvePromote(clientId, granted, reason) {
  for (const client of _clients) {
    if (client.id !== clientId) continue;
    if (granted) {
      client.mode = "satellite";
      _safeSend(client.ws, { type: "relay-promote-granted" });
      console.log(`[relay] ${clientId} を satellite に昇格`);
    } else {
      _safeSend(client.ws, { type: "relay-promote-denied", reason: reason || "denied" });
      console.log(`[relay] ${clientId} の昇格を拒否 (${reason || "denied"})`);
    }
    break;
  }
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
  // readonly モードはコマンド送信不可。
  // ただし昇格/降格リクエストと ping は readonly でも受け付ける。
  const ALWAYS_ALLOWED = new Set([
    "relay-ping", "relay-promote-request", "relay-demote-request"
  ]);
  if (client.mode === "readonly" && !ALWAYS_ALLOWED.has(msg.type)) {
    _safeSend(client.ws, { type: "relay-error", message: "Readonly mode: commands not allowed" });
    return;
  }

  switch (msg.type) {
    case "relay-promote-request":
      // ★ 操作モードへの昇格要求。PIN 検証は親レンダラー（appSettings 保持側）に委譲する。
      //   子クライアントは PIN を参照できないため、入力 PIN を親へ送り検証させる。
      if (_sendToRenderer) {
        _sendToRenderer("relay-promote-request", {
          clientId: client.id,
          pin: typeof msg.pin === "string" ? msg.pin : ""
        });
      } else {
        _safeSend(client.ws, { type: "relay-promote-denied", reason: "no-parent" });
      }
      break;

    case "relay-demote-request":
      // ★ 閲覧専用への降格はサーバ側で即時実行（PIN 不要）
      client.mode = "readonly";
      _safeSend(client.ws, { type: "relay-demote-granted" });
      console.log(`[relay] ${client.id} を readonly に降格`);
      break;

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

    case "relay-settings":
      // ★ ItemKeeper 等の外部連携設定変更の中継: satellite → 親レンダラー。
      //   readonly はここに到達しない（上の readonly ガードで弾かれる＝閲覧専用ミラー）。
      if (_sendToRenderer && msg.payload) {
        _sendToRenderer("relay-settings", { payload: msg.payload });
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
