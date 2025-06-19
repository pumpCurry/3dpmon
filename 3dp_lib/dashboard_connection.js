/**
 * @fileoverview
 *  @description 3Dプリンタ監視ツール 3dpmon 用 接続管理 モジュール
 * @file dashboard_connection.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_connection
 * 【機能内容サマリ】
 * - WebSocket 接続と再接続処理
 * - Heartbeat 管理と定期更新トリガー
 * - UI 更新通知および aggregator 起動
 *
 * 【公開関数一覧】
 * - {@link fetchStoredData}：サーバーからデータ取得
 * - {@link getDeviceIp}：接続先 IP 取得
 * - {@link connectWs}：WebSocket 接続開始
 * - {@link startHeartbeat}：ハートビート開始
 * - {@link stopHeartbeat}：ハートビート停止
 * - {@link disconnectWs}：接続解除
 * - {@link setupConnectButton}：接続ボタン初期化
 * - {@link sendCommand}：任意コマンド送信
 * - {@link updateConnectionUI}：UI 状態更新
 * - {@link simulateReceivedJson}：受信データシミュレート
 *
 * @version 1.390.315 (PR #143)
 * @since   1.390.193 (PR #86)
 * @lastModified 2025-06-19 22:01:15
 * -----------------------------------------------------------
 * @todo
 * - なし
 */

"use strict";

import {
  monitorData,
  currentHostname,
  PLACEHOLDER_HOSTNAME
} from "./dashboard_data.js";
import { pushLog } from "./dashboard_log_util.js";
import { aggregatorUpdate } from "./dashboard_aggregator.js";
import { handleMessage } from "./dashboard_msg_handler.js";
import { restartAggregatorTimer, stopAggregatorTimer } from "./dashboard_aggregator.js";
import * as printManager from "./dashboard_printmanager.js";

let ws = null;
let heartbeatInterval = null;
let reconnectAttempts = 0;
let reconnectTimeout  = null;
const MAX_RECONNECT   = 5;
let userDisconnected  = false;

/** hostname 取得までの受信データを一時的に保持するバッファ */
let temporaryBuffer = [];

/** 最新の WS 受信データを格納 */
let latestStoredData = null;

let isAutoScrollEnabled = true;      // 現在「自動スクロール中」なら true
let lastActiveTab = "received";      // "received" or "error"

/**
 * 最新の WebSocket 受信データを返します。
 * @returns {Promise<Object|null>}
 */
export function fetchStoredData() {
  return Promise.resolve(latestStoredData);
}

/**
 * 現在設定されている monitorData.appSettings.wsDest から IP を抽出する。
 * @returns {string} IP アドレス文字列（失敗時は空文字）
 */
export function getDeviceIp() {
  const raw = monitorData.appSettings.wsDest || "";
  const host = raw.split(":")[0];
  return host || "";
}


/* ===================== WebSocket 接続・受信処理 ===================== */

/**
 * connectWs:
 * WebSocket 接続を確立し、データ受信・heartbeat 管理・aggregator 起動を行う。
 *
 * 再接続処理は Exponential Backoff によって制御され、最大 {@link MAX_RECONNECT} 回までリトライ可能。
 * 成功時には aggregatorUpdate() の定期実行（interval）、heartbeat送信、UI更新が行われる。
 * 
 * 接続先は 再接続の場合
 * 3dp_dashboard_init.jsのinitializeDashboard (5) にて`monitorData.appSettings.wsDest` が
 * destination-inputテキストボックスに反映されたうえでポート `:9999` を追加したもの。
 * プロトコルは HTTPS環境では wss://、それ以外では ws:// が使用される。
 *
 * イベントハンドラ:
 * - `onopen`: 接続成功処理
 * - `onmessage`: メッセージ受信処理（"ok" はスキップ）
 * - `onerror`: エラーハンドリング
 * - `onclose`: 切断時の再接続判定と UI 更新
 *
 * @function
 * @returns {void}
 */
export function connectWs() {
  // もし直前にユーザー操作で切断された（disconnectWs()）フラグなら、
  // 再接続試行カウントをクリアして userDisconnected を戻す
  if (userDisconnected) {
    reconnectAttempts = 0;
    userDisconnected = false;
  }

  // 再接続回数が上限を超えた場合、ログを出して処理終了
  if (reconnectAttempts >= MAX_RECONNECT) {
    pushLog(`自動接続リトライが上限(${MAX_RECONNECT})に達しました。`, "error");
    return;
  }

  // 回数加算 / UI を「接続中…」に切り替え
  reconnectAttempts++;
  updateConnectionUI("connecting", {attempt: reconnectAttempts, max: MAX_RECONNECT});
  pushLog(`WS接続を試みます...(試行${reconnectAttempts}回目/${MAX_RECONNECT}回)`, "warn");

  // 接続先の構築（ws:// または wss://）
  // → ユーザー入力にポートがあればそのまま、なければ:9999を追加

  const destInput = document.getElementById("destination-input")?.value.trim();
  let dest = destInput || monitorData.appSettings.wsDest || "";

  if (dest && !dest.includes(":")) {
    dest += ":9999";
  }
  const protocol = location.protocol === "https:" ? "wss://" : "ws://";
  ws = new WebSocket(protocol + dest);
  ws.onopen    = handleSocketOpen;
  ws.onmessage = handleSocketMessage;
  ws.onerror   = handleSocketError;
  ws.onclose   = handleSocketClose;
}

/**
 * WebSocket が open したときのハンドラ。
 * - heartbeat と aggregatorUpdate の定期実行を開始
 * - reconnectAttempts をリセット
 * - UI を「接続済み」に切り替え
 */
function handleSocketOpen() {
  pushLog("WebSocket接続が確立しました。", "info");
  reconnectAttempts = 0;
  userDisconnected = false;

  // Heartbeat開始（30秒おき）
  startHeartbeat(ws);
  
  // aggregatorUpdate タイマー開始（500ms間隔）
  restartAggregatorTimer(500);    // 集計ループ開始

  // 成功したら input を再び隠し、ラベルを「接続済み」に書き換え
  updateConnectionUI("connected");

  // 1秒ディレイしてから履歴一覧取得とファイル一覧取得を実施
  setTimeout(() => {
    document.getElementById("btn-history-list")?.click();
    document.getElementById("btn-file-list")?.click();
  }, 1000);

};


/**
 * WebSocket メッセージ受信時の処理。
 *
 * - "ok"（heartbeat 応答）はスキップ
 * - JSON にパースし、オブジェクト形式であれば handleMessage() に渡す
 * - 印刷履歴の再取得と保存・描画を行う
 *
 * - "ok" は heartbeat 応答として無視
 * - JSON をパースして handleMessage() に渡す
 *
 * @param {MessageEvent} event
 */
function handleSocketMessage(event) {
  // 1) --- 生データ "ok" はスキップ ---
  if (event.data === "ok") { 
    pushLog("受信: heart beat:" + event.data, "success");
    return;
  }

// --- 2) タイムスタンプ更新 (lastLogTimestamp に現在時刻を反映) ---
  const now = new Date().toISOString();
  const tsField = document.querySelector('[data-field="lastLogTimestamp"] .value');
  if (tsField) tsField.textContent = now;

// --- 3) ログ出力 (受信した JSON 生データ) ---
  pushLog("受信: " + event.data, "normal");

// --- 4) JSON パース ---
  let data;
  try {
    data = JSON.parse(event.data);
  } catch (e) {
    pushLog("JSONパースエラー: " + event.data, "error");
    console.warn("[ws.onmessage] JSON.parse 失敗:", event.data, e);
    return;
  }

// 5) パース失敗 → 異常データとしてトラップ
  if (typeof data !== "object" && data === null) {
    pushLog("非オブジェクト形式のメッセージ: " + event.data, "warn");
    console.warn("[ws.onmessage] 非オブジェクト:", data);
    return;
  }

// 5.5) handleMessage(と内部でprocessData(data)の実施:起動後1度のみ)
  try {
    latestStoredData = data;
    handleMessage(data);
  } catch (e) {
    pushLog("handleMessage処理中にエラーが発生: " + e.message, "error");
    console.error("[ws.onmessage] handleMessage処理エラー:", e);
  }
  // 現在のホスト名が有効かどうか判定
  const hostReady = currentHostname &&
                    currentHostname !== PLACEHOLDER_HOSTNAME;
  // 共通ベース URL
  const ip = getDeviceIp();
  const baseUrl = `http://${ip}`;

// 6) 印刷履歴情報の保存・再描画
  try {
    // 印刷履歴の再取得・保存・レンダリング は各モジュールで行われています
    // （dashboard_printManager.js 側で実装）
    if (hostReady && Array.isArray(data.historyList)) {
      pushLog("historyList を受信しました", "info");
      const baseUrl80 = `http://${getDeviceIp()}:80`;
      printManager.updateHistoryList(data.historyList, baseUrl80);
    }
    if (hostReady && Array.isArray(data.elapseVideoList)) {
      pushLog("elapseVideoList を受信しました", "info");
      const baseUrl80 = `http://${getDeviceIp()}:80`;
      printManager.updateVideoList(data.elapseVideoList, baseUrl80);
    }
  } catch (e) {
    pushLog("印刷履歴処理中にエラーが発生: " + e.message, "error");
    console.error("[ws.onmessage] 印刷履歴処理エラー:", e);
  }

// 7) ファイル一覧の保存・再描画
  try {
    // 印刷履歴の再取得・保存・レンダリング は各モジュールで行われています
    // （dashboard_printManager.js 側で実装）
    if (data.retGcodeFileInfo) {
      pushLog("retGcodeFileInfo を受信しました", "info");
      printManager.renderFileList(data.retGcodeFileInfo, baseUrl);
    }
  } catch (e) {
    pushLog("印刷履歴処理中にエラーが発生: " + e.message, "error");
    console.error("[ws.onmessage] 印刷履歴処理エラー:", e);
  }





};


/**
 * WebSocket エラー発生時の処理。
 * エラー情報を pushLog に記録し、コンソールにも出力。
 *
 * @param {Event} error - WebSocket エラーイベント
 */
function handleSocketError(error) {
  const msg = "WebSocketエラー: " + (error?.message || String(error));
  pushLog(msg, "error");
  console.error("[ws.onerror]", error);
};


/**
 * 接続終了時の処理。
 * 接続が閉じられた際、UI の更新および heartbeat タイマーの停止、
 * 自動再接続処理を実施する。
 * WebSocket が close したときのハンドラ。
 * - heartbeat/aggregator タイマーをクリア
 * - ユーザ切断 or 上限超えなら UI を切断状態へ
 * - それ以外は Exponential Backoff で再接続
 */
function handleSocketClose() {
  pushLog("WebSocket接続が閉じられました。", "warn");

  // Heartbeat停止...
  stopHeartbeat();             // ハートビート停止
  stopAggregatorTimer();       // 集計ループ停止

  // 明示的にユーザが「切断」ボタンを押した場合
  if (userDisconnected) {
    userDisconnected  = false;
    updateConnectionUI("disconnected");
    pushLog("ユーザー操作により切断されました。", "info");
    return;
  }

  // 自動再接続が上限に達した場合
  if (reconnectAttempts >= MAX_RECONNECT) {
    updateConnectionUI("disconnected");
    pushLog(`自動接続リトライが上限(${MAX_RECONNECT})に達しました。`, "error");
    return;
  }

  // 再接続待機 UI 表示＆ログ
  // if (!userDisconnected && reconnectAttempts < MAX_RECONNECT)
  const delayMs = 2000 * Math.pow(2, reconnectAttempts - 1);
  const delaySec = Math.ceil(delayMs / 1000);
  const nextAttempt = reconnectAttempts + 1;

  // ① ログ出力
  pushLog(`Ws接続が切断されました。${delaySec}秒後に再試行します...（${nextAttempt}/${MAX_RECONNECT}）`, "warn");

  // ② 待機UIに切り替え
  updateConnectionUI("waiting", {
    attempt: nextAttempt,
    max: MAX_RECONNECT,
    wait: delaySec
  });
  
  // ③ カウントダウンタイマー開始
  let remaining = delaySec;
  const cdTimer = setInterval(() => {
    remaining--;
    if (remaining > 0) {
      updateConnectionUI("waiting", {
        attempt: nextAttempt,
        max: MAX_RECONNECT,
        wait: remaining
      });
    } else {
      clearInterval(cdTimer);
    }
  }, 1000);

  // ④ 既存タイマーがあればクリア
  if (reconnectTimeout) clearTimeout(reconnectTimeout);

  // ⑤ 再接続本体
  reconnectTimeout = setTimeout(() => {
    clearInterval(cdTimer);
    reconnectTimeout = null;
    connectWs();
  }, delayMs);
  return;
}

/**
 * startHeartbeat
 * ----------------
 * WebSocket 接続が OPEN 状態にある場合に、定期的にサーバへ
 * Heartbeat（ModeCode="heart_beat"）を送信し続けます。
 * 接続維持と切断検知の両方に利用します。
 *
 * 既に Timer が起動中であればクリアしてから再度設定します。
 *
 * @param {WebSocket} socket - Heartbeat を送信する WebSocket インスタンス
 * @param {number} [intervalMs=30000] - 送信間隔（ミリ秒）
 * @returns {void}
 */
export function startHeartbeat(socket, intervalMs = 30_000) {
  ws = socket;
  // 既存タイマーをクリア
  if (heartbeatInterval !== null) {
    clearInterval(heartbeatInterval);
  }

  // 新規タイマーを設定
  heartbeatInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      const payload = {
        ModeCode: "heart_beat",
        msg: new Date().toISOString()
      };
      ws.send(JSON.stringify(payload));
    }
  }, intervalMs);
}

/**
 * stopHeartbeat
 * ----------------
 * 起動中の Heartbeat Timer を停止します。
 *
 * @returns {void}
 */
export function stopHeartbeat() {
  if (heartbeatInterval !== null) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}


/**
 * disconnectWs:
 * ユーザが明示的に切断ボタンを押した場合の WebSocket 切断処理。
 * 接続状態のフラグ更新と UI 更新を含む。
 *
 * @function
 * @returns {void}
 */
export function disconnectWs() {
  // 明示的切断フラグをセット（再接続を抑止するため）
  userDisconnected = true;

  // pending な自動再接続タイマーをキャンセル
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  // 接続状態なら明示的に close を発行
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }

  // 再接続カウント初期化
  reconnectAttempts = 0;

  // 入力欄を再度書き換え可に
  // UIを切断状態に更新
  updateConnectionUI("disconnected");
}

/* ===================== DOM 更新ヘルパー ===================== */

/**
 * connect ボタンにクリック時の WebSocket 接続処理をバインドします
 * @returns {void}
 */
export function setupConnectButton() {
  const btn = document.getElementById("connect-button");
  if (btn) {
    btn.addEventListener("click", connectWs);
  }
}

/**
 * ペイロードを送信し、同一 id の応答を待つ Promise を返す
 * @param {string} method - コマンド名
 * @param {Object} params - パラメータ
 * @returns {Promise<Object>} サーバー result フィールド
 */
export function sendCommand(method, params = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showAlert("WebSocket が接続されていません", "error");
    return Promise.reject(new Error("WebSocket not connected"));
  }
  const id = `${method}_${Date.now()}`;
  const payload = { id, method, params };
  return new Promise((resolve, reject) => {
    const onResp = evt => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (msg.id !== id) return;
      ws.removeEventListener("message", onResp);
      if (msg.error) {
        showAlert(`${method} エラー: ${msg.error.message}`, "error");
        reject(msg.error);
      } else {
        showAlert(`${method} 成功`, "success");
        resolve(msg.result);
      }
    };
    ws.addEventListener("message", onResp);

    // ── 送信ログ（紫色）
    const json = JSON.stringify(payload);
    pushLog(`送信: ${json}`, "send");
    ws.send(json);

  });
}

/**
 * @fileoverview
 * 接続 UI の表示状態を一元管理します。
 * - "connecting": 接続試行中 → 「接続中…(n/m)」
 * - "waiting":    再接続待機中 → 「接続中…(n/m) リトライ待ち(あと x 秒)」
 * - "connected":  接続済み     → ホスト名表示・切断ボタン
 * - "disconnected":切断中     → 入力欄再表示・接続ボタン
 *
 * @param {"connecting"|"waiting"|"connected"|"disconnected"} state
 *   接続状態を指定
 * @param {{attempt?: number, max?: number, wait?: number}} [opt={}]
 *   connecting/waiting 時に使用する { attempt, max, wait }
 */
export function updateConnectionUI(state, opt = {}) {
  const ipInput       = document.getElementById("destination-input");
  const ipDisplay     = document.getElementById("destination-display");
  const statusEl      = document.getElementById("connection-status");
  const btnConnect    = document.getElementById("connect-button");
  const btnDisconnect = document.getElementById("disconnect-button");
  const muteTag       = document.getElementById("audio-muted-tag");

  // wsDest からホスト部のみを取り出す（例 "192.168.1.5:9090" → "192.168.1.5"）
  const rawDest  = monitorData.appSettings.wsDest || "";
  const hostOnly = rawDest.split(":")[0] || "";

  // 入力欄を隠し・無効化
  function hideInput() {
    if (ipInput) {
      ipInput.classList.add("hidden");
      ipInput.setAttribute("disabled", "true");
    }
  }

  // 入力欄を表示・有効化し、値を復元
  function showInput() {
    if (ipInput) {
      ipInput.classList.remove("hidden");
      ipInput.removeAttribute("disabled");
      ipInput.value = rawDest;
    }
  }

  // ミュート中タグを隠す
  function hideMute() {
    if (muteTag) {
      muteTag.classList.add("hidden");
    }
  }

  switch (state) {
    case "connecting": {
      // --- 接続試行中 ---
      hideInput();
      const { attempt = 0, max = 0 } = opt;
      const label = `接続中…(${attempt}/${max})`;
      // ホスト名は常に表示
      if (ipDisplay) {
        ipDisplay.classList.remove("hidden");
        ipDisplay.textContent = hostOnly;
      }
      if (statusEl) {
        statusEl.textContent = label;
      }
      btnConnect?.classList.add("hidden");
      btnConnect?.setAttribute("disabled", "true");
      btnDisconnect?.classList.remove("hidden");
      break;
    }

    case "waiting": {
      // --- 再接続待機中 ---
      hideInput();
      const { attempt = 0, max = 0, wait = 0 } = opt;
      const label = `接続中…(${attempt}/${max}) リトライ待ち(あと ${wait} 秒)`;
      if (ipDisplay) {
        ipDisplay.classList.remove("hidden");
        ipDisplay.textContent = hostOnly;
      }
      if (statusEl) {
        statusEl.textContent = label;
      }
      btnConnect?.classList.add("hidden");
      btnDisconnect?.classList.remove("hidden");
      break;
    }

    case "connected": {
      // --- 接続済み ---
      hideInput();
      if (ipDisplay) {
        ipDisplay.classList.remove("hidden");
        ipDisplay.textContent = hostOnly;
      }
      if (statusEl) {
        statusEl.textContent = "接続済み";
      }
      btnConnect?.classList.add("hidden");
      btnDisconnect?.classList.remove("hidden");
      // ミュートタグはそのまま残す
      break;
    }

    case "disconnected": {
      // --- 切断中 ---
      showInput();
      if (ipDisplay) {
        ipDisplay.classList.add("hidden");
      }
      if (statusEl) {
        statusEl.textContent = "切断";
      }
      btnConnect?.removeAttribute("disabled");
      btnConnect?.classList.remove("hidden");
      btnDisconnect?.classList.add("hidden");
      hideMute();
      break;
    }

    default:
      console.error(`updateConnectionUI: unknown state="${state}"`);
  }
}

/**
 * Debug helper: treat a raw JSON string as a received WebSocket message.
 * @param {string} jsonStr - JSON text to process
 */
export function simulateReceivedJson(jsonStr) {
  handleSocketMessage({ data: jsonStr });
}