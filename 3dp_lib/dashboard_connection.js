/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 接続管理モジュール
 * @file dashboard_connection.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_connection
 *
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
 * - {@link sendGcodeCommand}：G-code 送信
 * - {@link updateConnectionUI}：UI 状態更新
 * - {@link simulateReceivedJson}：受信データシミュレート
 *
* @version 1.390.516 (PR #236)
* @since   1.390.451 (PR #205)
* @lastModified 2025-06-28 14:54:54
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

import {
  monitorData,
  currentHostname,
  PLACEHOLDER_HOSTNAME,
  setCurrentHostname,
  setNotificationSuppressed
} from "./dashboard_data.js";
import { pushLog } from "./dashboard_log_util.js";
import { aggregatorUpdate } from "./dashboard_aggregator.js";
import { handleMessage } from "./dashboard_msg_handler.js";
import { restartAggregatorTimer, stopAggregatorTimer } from "./dashboard_aggregator.js";
import * as printManager from "./dashboard_printmanager.js";
import { showAlert } from "./dashboard_notification_manager.js";
import { startCameraStream } from "./dashboard_camera_ctrl.js";

// ---------------------------------------------------------------------------
// 複数プリンタ接続に対応するため、接続状態をホスト名ごとに保持するマップを用意
// ---------------------------------------------------------------------------

/** @type {Record<string, ConnectionState>} */
const connectionMap = {};

/**
 * @typedef {Object} ConnectionState
 * @property {WebSocket|null} ws            - 接続ソケット
 * @property {number|null}    hbInterval    - ハートビート用タイマーID
 * @property {number}         reconnect     - 再接続試行回数
 * @property {number|null}    retryTimer    - 再接続待機タイマーID
 * @property {number|null}    fetchTimer    - ホスト確定待ちポーリングID
 * @property {number|null}    hostReadyAt   - ホスト名確定時刻(Unix ms)
 * @property {boolean}        historyReceived - 履歴取得済みフラグ
 * @property {boolean}        fileReqSent   - ファイル一覧要求済みか
 * @property {boolean}        historyReqSent - 履歴要求済みか
 * @property {boolean}        userDisc      - ユーザー操作により切断されたか
 * @property {Array<Object>}  buffer        - ホスト確定前に受信したデータ
 * @property {Object|null}    latest        - 最新受信データ
 * @property {string}         dest          - 接続先(IP:PORT)
 * @property {"disconnected"|"connecting"|"connected"|"waiting"} state
 *                                        - UI 表示用状態
 */

/** 再接続上限回数 */
const MAX_RECONNECT = 5;

let isAutoScrollEnabled = true;      // 現在「自動スクロール中」なら true
let lastActiveTab = "received";      // "received" or "error"
let lastWsAlertTime = 0;             // 最後に接続エラーを表示した時刻

/**
 * ダミー状態（未選択時に使用）
 * @type {ConnectionState}
 */
const placeholderState = {
  ws: null,
  hbInterval: null,
  reconnect: 0,
  retryTimer: null,
  fetchTimer: null,
  hostReadyAt: null,
  historyReceived: false,
  fileReqSent: false,
  historyReqSent: false,
  userDisc: false,
  buffer: [],
  latest: null,
  dest: "",
  state: "disconnected"
};

/**
 * 指定ホストの接続状態オブジェクトを取得します。
 * 存在しない場合は初期構造を生成して返します。
 * PLACEHOLDER_HOSTNAME のときはマップへ登録せず
 * {@link placeholderState} を共有して返します。
 *
 * @private
 * @param {string} host - ホスト名
 * @returns {ConnectionState}
 */
function getState(host) {
  if (host === PLACEHOLDER_HOSTNAME) {
    return placeholderState;
  }
  if (!connectionMap[host]) {
    connectionMap[host] = {
      ws: null,
      hbInterval: null,
      reconnect: 0,
      retryTimer: null,
      fetchTimer: null,
      hostReadyAt: null,
      historyReceived: false,
      fileReqSent: false,
      historyReqSent: false,
      userDisc: false,
      buffer: [],
      latest: null,
      dest: "",
      state: "disconnected"
    };
  }
  return connectionMap[host];
}

/**
 * 最新の WebSocket 受信データを返します。
 * @returns {Promise<Object|null>}
 */
export function fetchStoredData(host = currentHostname) {
  const st = connectionMap[host];
  return Promise.resolve(st?.latest ?? null);
}

/**
 * 現在設定されている monitorData.appSettings.wsDest から IP を抽出する。
 * @returns {string} IP アドレス文字列（失敗時は空文字）
 */
export function getDeviceIp(host = currentHostname) {
  const st = connectionMap[host];
  const raw = st?.dest || monitorData.appSettings.wsDest || "";
  const h = raw.split(":")[0];
  return h || "";
}

/**
 * updateConnectionHost:
 * ---------------------
 * IP 接続後に正式なホスト名が判明した際、接続情報のキーを
 * 旧ホスト名から新ホスト名へ移動します。
 *
 * @param {string} oldHost - 接続時に使用したホスト名または IP
 * @param {string} newHost - サーバーから得た正式ホスト名
 * @returns {string} 実際に利用されるホスト名
 */
export function updateConnectionHost(oldHost, newHost) {
  if (oldHost === newHost || newHost === PLACEHOLDER_HOSTNAME) {
    return oldHost;
  }
  const state = connectionMap[oldHost];
  if (!state) return newHost;

  const target = connectionMap[newHost];
  if (target) {
    Object.assign(target, state);
    delete connectionMap[oldHost];

    if (target.ws instanceof WebSocket) {
      target.ws.onopen    = () => handleSocketOpen(newHost);
      target.ws.onmessage = evt => handleSocketMessage(evt, newHost);
      target.ws.onerror   = err => handleSocketError(err, newHost);
      target.ws.onclose   = () => handleSocketClose(newHost);
    }

    if (currentHostname === newHost) {
      updateConnectionUI(target.state, {}, newHost);
    }
    updatePrinterListUI();
    return newHost;
  }

  connectionMap[newHost] = state;
  delete connectionMap[oldHost];

  if (state.ws instanceof WebSocket) {
    state.ws.onopen    = () => handleSocketOpen(newHost);
    state.ws.onmessage = evt => handleSocketMessage(evt, newHost);
    state.ws.onerror   = err => handleSocketError(err, newHost);
    state.ws.onclose   = () => handleSocketClose(newHost);
  }

  if (currentHostname === newHost) {
    updateConnectionUI(state.state, {}, newHost);
  }
  updatePrinterListUI();
  return newHost;
}

/**
 * flushBufferedMessages:
 * ----------------------
 * currentHostname 切り替え時に、保持していた未処理メッセージを
 * 順に処理します。
 *
 * @private
 * @param {string} host - バッファを処理するホスト名
 * @returns {void}
 */
function flushBufferedMessages(host) {
  const state = connectionMap[host];
  if (!state || !Array.isArray(state.buffer)) return;
  while (state.buffer.length > 0) {
    const msgObj = state.buffer.shift();
    try {
      handleSocketMessage({ data: JSON.stringify(msgObj) }, host);
    } catch (e) {
      pushLog("バッファ処理中にエラー: " + e.message, "error");
      console.error("[flushBufferedMessages]", e);
    }
  }
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
export function connectWs(hostOrDest) {
  const inputDest = document.getElementById("destination-input")?.value.trim();
  let dest = hostOrDest || inputDest || monitorData.appSettings.wsDest || "";
  if (!dest) return;
  if (!dest.includes(":")) dest += ":9999";
  const host = dest.split(":")[0];
  // 接続開始直後から currentHostname を最新に保つ
  setCurrentHostname(host);
  const state = getState(host);
  state.dest = dest;
  state.historyReceived = false;
  state.hostReadyAt = null;


  if (state.userDisc) {
    state.reconnect = 0;
    state.userDisc = false;
  }
  if (state.reconnect >= MAX_RECONNECT) {
    pushLog(`自動接続リトライが上限(${MAX_RECONNECT})に達しました。`, "error");
    return;
  }

  state.reconnect++;
  state.state = "connecting";
  updateConnectionUI("connecting", { attempt: state.reconnect, max: MAX_RECONNECT }, host);
  updatePrinterListUI();
  pushLog(`WS接続を試みます...(試行${state.reconnect}回目/${MAX_RECONNECT}回)`, "warn");

  const protocol = location.protocol === "https:" ? "wss://" : "ws://";
  const ws = new WebSocket(protocol + dest);
  state.ws = ws;
  ws.onopen    = () => handleSocketOpen(host);
  ws.onmessage = evt => handleSocketMessage(evt, host);
  ws.onerror   = err => handleSocketError(err, host);
  ws.onclose   = () => handleSocketClose(host);
}

/**
 * WebSocket が open したときのハンドラ。
 * - heartbeat と aggregatorUpdate の定期実行を開始
 * - reconnectAttempts をリセット
 * - UI を「接続済み」に切り替え
 * - ホスト名確定を待ってから履歴/ファイル取得
 */
function handleSocketOpen(host) {
  pushLog("WebSocket接続が確立しました。", "info");
  const st = getState(host);
  st.reconnect = 0;
  st.userDisc = false;

  // Heartbeat開始（30秒おき）
  startHeartbeat(st.ws, 30_000, host);

  if (host === currentHostname) {
    restartAggregatorTimer(500);    // 集計ループ開始
    updateConnectionUI("connected", {}, host);
  }
  st.state = "connected";
  updatePrinterListUI();
  if (monitorData.appSettings.cameraToggle) {
    startCameraStream();
  }
  // 接続復帰後は通知抑制を解除
  setNotificationSuppressed(false);

  // ホスト名確定後に履歴/ファイル一覧を遅延取得するタイマー
  st.historyReceived = false;
  st.hostReadyAt = null;
  st.fileReqSent = false;
  st.historyReqSent = false;
  if (st.fetchTimer !== null) {
    clearInterval(st.fetchTimer);
  }
  st.fetchTimer = setInterval(() => {
    // 接続が閉じられた場合はタイマー破棄
    if (!st.ws || st.ws.readyState !== WebSocket.OPEN) {
      clearInterval(st.fetchTimer);
      st.fetchTimer = null;
      st.hostReadyAt = null;
      return;
    }
    const hostReady =
      currentHostname !== PLACEHOLDER_HOSTNAME && currentHostname !== host;
    if (!hostReady) {
      return;
    }

    if (st.hostReadyAt === null) {
      // ホスト名確定直後のタイムスタンプを記録
      st.hostReadyAt = Date.now();
      st.fileReqSent = false;
      st.historyReqSent = false;
      return;
    }

    const elapsed = Date.now() - st.hostReadyAt;

    if (!st.fileReqSent && elapsed >= 2500) {
      document.getElementById("btn-file-list")?.click();
      st.fileReqSent = true;
    }

    if (!st.historyReqSent && elapsed >= 7500) {
      if (!st.historyReceived) {
        document.getElementById("btn-history-list")?.click();
      }
      st.historyReqSent = true;
    }

    if (st.fileReqSent && st.historyReqSent) {
      clearInterval(st.fetchTimer);
      st.fetchTimer = null;
      st.hostReadyAt = null;
      st.fileReqSent = false;
      st.historyReqSent = false;
    }
  }, 100);

};


/**
 * WebSocket メッセージ受信時の処理。
 *
 * - "ok"（heartbeat 応答）はスキップ
 * - JSON にパースし、オブジェクト形式であれば handleMessage() に渡す
 * - 印刷履歴の再取得と保存・描画を行う
 * - 現在のホストでなければメッセージをバッファリングし、
 *   data.hostname があれば {@link updateConnectionHost} でホスト名を更新
 * - ホスト名未確定時は data.hostname を優先的に処理
 *
 * - "ok" は heartbeat 応答として無視
 * - JSON をパースして handleMessage() に渡す
 *
 * @param {MessageEvent} event
 */
function handleSocketMessage(event, host) {
  let hostKey = host;
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

  // --- 5a) ホスト名未確定時は先に hostname を処理 ----------------------
  if ((currentHostname === null || currentHostname === PLACEHOLDER_HOSTNAME) &&
      data && typeof data.hostname === "string" && data.hostname) {
    setCurrentHostname(data.hostname);
    hostKey = updateConnectionHost(hostKey, data.hostname);
  }

// 5.5) handleMessage(と内部でprocessData(data)の実施:起動後1度のみ)
  try {
    let st = getState(hostKey);
    st.latest = data;
    // currentHostname が未確定 (PLACEHOLDER_HOSTNAME) の場合も
    // 受信データから hostname を得るため handleMessage を実行する
    const before = currentHostname;
    if (hostKey === currentHostname || currentHostname === PLACEHOLDER_HOSTNAME) {
      handleMessage(data);
      if (currentHostname !== before && currentHostname !== PLACEHOLDER_HOSTNAME) {
        hostKey = updateConnectionHost(hostKey, currentHostname);
      }
    } else {
      if (data && typeof data.hostname === "string" && data.hostname) {
        const newKey = updateConnectionHost(hostKey, data.hostname);
        if (newKey !== hostKey) {
          hostKey = newKey;
          st = getState(hostKey);
        }
      }
      st.buffer.push(data);
    }
  } catch (e) {
    pushLog("handleMessage処理中にエラーが発生: " + e.message, "error");
    console.error("[ws.onmessage] handleMessage処理エラー:", e);
  }
  // 現在のホスト名が有効かどうか判定
  const hostReady = hostKey === currentHostname &&
                    currentHostname !== PLACEHOLDER_HOSTNAME;
  // 共通ベース URL
  const ip = getDeviceIp(hostKey);
  const baseUrl = `http://${ip}`;

// 6) 印刷履歴情報の保存・再描画
  try {
    // 印刷履歴の再取得・保存・レンダリング は各モジュールで行われています
    // （dashboard_printManager.js 側で実装）
    if (hostReady && Array.isArray(data.historyList)) {
      pushLog("historyList を受信しました", "info");
      const baseUrl80 = `http://${getDeviceIp(hostKey)}:80`;
      printManager.updateHistoryList(data.historyList, baseUrl80, hostKey);
      const s = getState(hostKey);
      s.historyReceived = true;
    }
    if (hostReady && Array.isArray(data.elapseVideoList)) {
      pushLog("elapseVideoList を受信しました", "info");
      const baseUrl80 = `http://${getDeviceIp(hostKey)}:80`;
      printManager.updateVideoList(data.elapseVideoList, baseUrl80, hostKey);
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
function handleSocketError(error, host) {
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
 * - 進行中のホスト名待ちポーリングを解除
 * - ユーザ切断 or 上限超えなら UI を切断状態へ
 * - それ以外は Exponential Backoff で再接続
 */
function handleSocketClose(host) {
  pushLog("WebSocket接続が閉じられました。", "warn");
 // 切断直後は通知を抑制する
  setNotificationSuppressed(true);
  const st = getState(host);

  // ホスト名待ちポーリングが残っていれば解除
  if (st.fetchTimer !== null) {
    clearInterval(st.fetchTimer);
    st.fetchTimer = null;
  }
  st.hostReadyAt = null;
  st.historyReceived = false;
  st.fileReqSent = false;
  st.historyReqSent = false;

  // Heartbeat停止...
  stopHeartbeat(host);             // ハートビート停止
  if (host === currentHostname) {
    stopAggregatorTimer();       // 集計ループ停止
  }

  // 明示的にユーザが「切断」ボタンを押した場合
  if (st.userDisc) {
    st.userDisc  = false;
    st.state = "disconnected";
    if (host === currentHostname) updateConnectionUI("disconnected", {}, host);
    updatePrinterListUI();
    pushLog("ユーザー操作により切断されました。", "info");
    return;
  }

  // 自動再接続が上限に達した場合
  if (st.reconnect >= MAX_RECONNECT) {
    if (host === currentHostname) updateConnectionUI("disconnected", {}, host);
    st.state = "disconnected";
    updatePrinterListUI();
    pushLog(`自動接続リトライが上限(${MAX_RECONNECT})に達しました。`, "error");
    return;
  }

  // 再接続待機 UI 表示＆ログ
  // if (!userDisconnected && reconnectAttempts < MAX_RECONNECT)
  const delayMs = 2000 * Math.pow(2, st.reconnect - 1);
  const delaySec = Math.ceil(delayMs / 1000);
  const nextAttempt = st.reconnect + 1;

  // ① ログ出力
  pushLog(`Ws接続が切断されました。${delaySec}秒後に再試行します...（${nextAttempt}/${MAX_RECONNECT}）`, "warn");

  // ② 待機UIに切り替え
  if (host === currentHostname) {
    updateConnectionUI("waiting", {
      attempt: nextAttempt,
      max: MAX_RECONNECT,
      wait: delaySec
    }, host);
  }
  st.state = "waiting";
  updatePrinterListUI();
  
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
  if (st.retryTimer) clearTimeout(st.retryTimer);

  // ⑤ 再接続本体
  st.retryTimer = setTimeout(() => {
    clearInterval(cdTimer);
    st.retryTimer = null;
    connectWs(st.dest);
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
export function startHeartbeat(socket, intervalMs = 30_000, host = currentHostname) {
  const st = getState(host);
  st.ws = socket;
  if (st.hbInterval !== null) {
    clearInterval(st.hbInterval);
  }
  st.hbInterval = setInterval(() => {
    if (st.ws && st.ws.readyState === WebSocket.OPEN) {
      const payload = {
        ModeCode: "heart_beat",
        msg: new Date().toISOString()
      };
      st.ws.send(JSON.stringify(payload));
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
export function stopHeartbeat(host = currentHostname) {
  const st = connectionMap[host];
  if (st && st.hbInterval !== null) {
    clearInterval(st.hbInterval);
    st.hbInterval = null;
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
export function disconnectWs(host = currentHostname) {
  const st = getState(host);
  st.userDisc = true;

  // pending な自動再接続タイマーをキャンセル
  if (st.retryTimer) {
    clearTimeout(st.retryTimer);
    st.retryTimer = null;
  }

  // 接続状態なら明示的に close を発行
  if (st.ws && st.ws.readyState === WebSocket.OPEN) {
    st.ws.close();
  }

  // 再接続カウント初期化
  st.reconnect = 0;

  // 入力欄を再度書き換え可に
  // UIを切断状態に更新
  if (host === currentHostname) {
    updateConnectionUI("disconnected", {}, host);
  }
  st.state = "disconnected";
  updatePrinterListUI();

  // 切断時点で保持中のホスト名をリセットしておく
  // これにより次回接続時、初回メッセージで新しい
  // ホスト名が確実に設定され、履歴データの混在を防ぐ
  if (host === currentHostname) setCurrentHostname(PLACEHOLDER_HOSTNAME);
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
 * プリンタ選択 UI を初期化します。
 * セレクトボックスの変更に合わせて監視対象を切り替えます。
 *
 * @returns {void}
 */
export function setupPrinterUI() {
  const sel = document.getElementById("printer-select");
  if (!sel) return;
  sel.addEventListener("change", () => {
    const host = sel.value;
    if (host) {
      setCurrentHostname(host);
      updateConnectionUI(connectionMap[host]?.state || "disconnected", {}, host);
      flushBufferedMessages(host);
    }
  });
  updatePrinterListUI();
}

/**
 * ペイロードを送信し、同一 id の応答を待つ Promise を返す
 * @param {string} method - コマンド名
 * @param {Object} params - パラメータ
 * @returns {Promise<Object>} サーバー result フィールド
 */
export function sendCommand(method, params = {}, host = currentHostname) {
  const st = getState(host);
  if (!st.ws || st.ws.readyState !== WebSocket.OPEN) {
    const now = Date.now();
    if (now - lastWsAlertTime > 1000) {
      lastWsAlertTime = now;
      const ts = new Date(now).toISOString();
      const hostName = host === PLACEHOLDER_HOSTNAME ? "(placeholder)" : host;
      const detail = st.ws ? `readyState=${st.ws.readyState}` : "ws=null";
      const msg = `[${hostName}] WebSocket が接続されていません @ ${ts} (${detail})`;
      showAlert(msg, "error");
    }
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
      st.ws.removeEventListener("message", onResp);
      if (msg.error) {
        showAlert(`${method} エラー: ${msg.error.message}`, "error");
        reject(msg.error);
      } else {
        showAlert(`${method} 成功`, "success");
        resolve(msg.result);
      }
    };
    st.ws.addEventListener("message", onResp);

    // ── 送信ログ（紫色）
    const json = JSON.stringify(payload);
    pushLog(`送信: ${json}`, "send");
    st.ws.send(json);

  });
}

/**
 * G-code コマンドを送信します。
 *
 * @param {string} gcode - 送信する G-code 文字列
 * @param {string} [host=currentHostname] - 接続先ホスト名
 * @returns {Promise<Object>} サーバー result フィールド
 */
export function sendGcodeCommand(gcode, host = currentHostname) {
  const st = getState(host);
  if (!st.ws || st.ws.readyState !== WebSocket.OPEN) {
    const now = Date.now();
    if (now - lastWsAlertTime > 1000) {
      lastWsAlertTime = now;
      const ts = new Date(now).toISOString();
      const hostName = host === PLACEHOLDER_HOSTNAME ? "(placeholder)" : host;
      const detail = st.ws ? `readyState=${st.ws.readyState}` : "ws=null";
      const msg = `[${hostName}] WebSocket が接続されていません @ ${ts} (${detail})`;
      showAlert(msg, "error");
    }
    return Promise.reject(new Error("WebSocket not connected"));
  }

  const id = `set_gcode_${Date.now()}`;
  const payload = { id, method: "set", params: { gcodeCmd: gcode } };

  return new Promise((resolve, reject) => {
    const onResp = evt => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (msg.id !== id) return;
      st.ws.removeEventListener("message", onResp);
      if (msg.error) {
        showAlert(`set_gcode エラー: ${msg.error.message}`, "error");
        reject(msg.error);
      } else {
        showAlert("set_gcode 成功", "success");
        resolve(msg.result);
      }
    };
    st.ws.addEventListener("message", onResp);

    const json = JSON.stringify(payload);
    pushLog(`送信: ${json}`, "send");
    st.ws.send(json);
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
export function updateConnectionUI(state, opt = {}, host = currentHostname) {
  const ipInput       = document.getElementById("destination-input");
  const ipDisplay     = document.getElementById("destination-display");
  const statusEl      = document.getElementById("connection-status");
  const btnConnect    = document.getElementById("connect-button");
  const btnDisconnect = document.getElementById("disconnect-button");
  const muteTag       = document.getElementById("audio-muted-tag");

  // wsDest からホスト部のみを取り出す（例 "192.168.1.5:9090" → "192.168.1.5"）
  const st = getState(host);
  const rawDest  = st.dest || monitorData.appSettings.wsDest || "";
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
  updatePrinterListUI();
}

/**
 * 接続中プリンタ一覧の UI を更新します。
 * select 要素とステータス表示を再構築します。
 *
 * @private
 * @returns {void}
 */
function updatePrinterListUI() {
  const sel  = document.getElementById("printer-select");
  const list = document.getElementById("printer-status-list");
  if (!sel || !list) return;

  const hosts = Object.keys(connectionMap).filter(h => h !== PLACEHOLDER_HOSTNAME);
  sel.innerHTML = hosts.map(h => `<option value="${h}">${h}</option>`).join("");
  sel.value = hosts.includes(currentHostname) ? currentHostname : "";

  list.innerHTML = hosts
    .map(h => {
      const st = connectionMap[h];
      const label = `${h} : ${st.state}`;
      return `<div>${label}</div>`;
    })
    .join("");
}

/**
 * Debug helper: treat a raw JSON string as a received WebSocket message.
 * @param {string} jsonStr - JSON text to process
 */
export function simulateReceivedJson(jsonStr, host = currentHostname) {
  handleSocketMessage({ data: jsonStr }, host);
}