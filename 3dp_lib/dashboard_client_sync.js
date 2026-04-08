/**
 * @fileoverview
 * @description 3dpmon 子クライアント同期モジュール — 親リレーからのデータ受信と適用
 * @file dashboard_client_sync.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_client_sync
 *
 * 【機能内容サマリ】
 * - 親リレーサーバへの WebSocket 接続
 * - relay-snapshot / relay-delta の受信と monitorData への反映
 * - satellite モードでのコマンド/フィラメント操作の送信
 *
 * 【公開関数一覧】
 * - {@link initClientSync}：子クライアント同期を開始
 * - {@link getRelayMode}：現在のリレーモードを返す
 * - {@link sendRelayCommand}：親経由でプリンタにコマンド送信
 * - {@link sendRelayFilament}：親経由でフィラメント操作
 *
 * @version 1.390.820 (PR #367)
 * @since   1.390.820 (PR #367)
 * -----------------------------------------------------------
 */

"use strict";

import {
  monitorData,
  ensureMachineData,
  setStoredDataForHost,
  markAllKeysDirty,
  PLACEHOLDER_HOSTNAME
} from "./dashboard_data.js";

/** リレーモード: null=未検出, "parent"=親, "readonly"=子閲覧, "satellite"=子操作 */
let _relayMode = null;

/** リレー WebSocket インスタンス */
let _relayWs = null;

/** 再接続タイマー */
let _reconnectTimer = null;

/** クライアントID（サーバから割り当て） */
let _clientId = null;

/** 親サーバのホスト:ポート */
let _parentOrigin = "";

/**
 * リレーモードを検出する。
 * - Electron親: window.electronAPI 存在 → "parent"
 * - ブラウザ子: URL ?relay=readonly|satellite → "readonly"|"satellite"
 * - それ以外: "standalone"（従来のスタンドアロン動作）
 *
 * @returns {string} "parent" | "readonly" | "satellite" | "standalone"
 */
export function detectRelayMode() {
  // Electron 親モード
  if (window.electronAPI?.isElectron?.()) {
    return "parent";
  }

  // URL パラメータでモード指定
  const params = new URLSearchParams(window.location.search);
  const relayParam = params.get("relay");
  if (relayParam === "satellite") return "satellite";
  if (relayParam === "readonly") return "readonly";

  // http:// で開かれている場合はデフォルトで readonly 子
  // （file:// ならスタンドアロン）
  if (window.location.protocol === "http:" || window.location.protocol === "https:") {
    // 同一マシンの localhost ならスタンドアロンの可能性もあるが、
    // Electron 経由なら上の isElectron で既に判定済み → ここに来たらブラウザ子
    return "readonly";
  }

  return "standalone";
}

/**
 * 現在のリレーモードを返す。
 *
 * @returns {string|null} "parent" | "readonly" | "satellite" | "standalone" | null(未初期化)
 */
export function getRelayMode() {
  return _relayMode;
}

/**
 * 子クライアント同期を初期化する。
 * モードを検出し、子モードなら親リレーに WebSocket 接続する。
 *
 * ★ connectAllSavedTargets() の前に呼ぶこと。
 *   子モードならプリンタ直接接続をスキップさせるため。
 *
 * @returns {boolean} 子モードで初期化された場合 true
 */
export function initClientSync() {
  _relayMode = detectRelayMode();

  if (_relayMode === "parent" || _relayMode === "standalone") {
    console.info(`[client-sync] モード: ${_relayMode}（リレー子ではない）`);
    return false;
  }

  console.info(`[client-sync] 子モード: ${_relayMode}`);
  _parentOrigin = window.location.host; // "parentIP:5313"

  // 親リレーに接続
  _connectToParent();

  return true; // 子モードで初期化された
}

/**
 * 親リレーサーバへの WebSocket 接続を確立する。
 *
 * @private
 */
function _connectToParent() {
  const wsUrl = `ws://${_parentOrigin}/?mode=${_relayMode}`;
  console.info(`[client-sync] 親リレーに接続: ${wsUrl}`);

  try {
    _relayWs = new WebSocket(wsUrl);
  } catch (e) {
    console.error("[client-sync] WebSocket 生成失敗:", e);
    _scheduleReconnect();
    return;
  }

  _relayWs.onopen = () => {
    console.info("[client-sync] 親リレーに接続完了");
    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }
  };

  _relayWs.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    _handleRelayMessage(msg);
  };

  _relayWs.onclose = () => {
    console.warn("[client-sync] 親リレーから切断");
    _relayWs = null;
    _scheduleReconnect();
  };

  _relayWs.onerror = (err) => {
    console.error("[client-sync] WebSocket エラー:", err);
  };
}

/**
 * 再接続をスケジュールする。
 * @private
 */
function _scheduleReconnect() {
  if (_reconnectTimer) return;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    _connectToParent();
  }, 3000);
}

/**
 * リレーメッセージを処理する。
 *
 * @private
 * @param {Object} msg - 受信メッセージ
 */
function _handleRelayMessage(msg) {
  switch (msg.type) {
    case "relay-init":
      _clientId = msg.clientId;
      _relayMode = msg.mode;
      console.info(`[client-sync] 初期化: clientId=${_clientId}, mode=${_relayMode}`);
      // body にモードクラスを設定（readonly制御CSSが適用される）
      document.body.classList.add(`relay-${_relayMode}`);
      // トップバーにモードバッジを表示
      _showModeBadge(_relayMode);
      break;

    case "relay-snapshot":
      _applySnapshot(msg.state);
      break;

    case "relay-delta":
      _applyDelta(msg);
      break;

    case "relay-pong":
      // 接続確認応答
      break;

    case "relay-error":
      console.warn(`[client-sync] サーバエラー: ${msg.message}`);
      break;

    default:
      console.debug(`[client-sync] 未知のメッセージ: ${msg.type}`);
  }
}

/**
 * フルスナップショットを monitorData に適用する。
 *
 * @private
 * @param {Object} state - スナップショットデータ
 */
function _applySnapshot(state) {
  if (!state) return;
  console.info("[client-sync] スナップショット受信、適用開始");

  // 接続先情報を設定
  if (state.appSettings?.connectionTargets) {
    monitorData.appSettings.connectionTargets = state.appSettings.connectionTargets;
  }

  // フィラメントデータ（★ 子クライアントはスナップショットで全置換して問題ない
  //   — 子のローカル変更は親に送信済みのため、親の状態が正）
  if (state.filamentSpools) monitorData.filamentSpools = state.filamentSpools;
  if (state.hostSpoolMap) Object.assign(monitorData.hostSpoolMap, state.hostSpoolMap);

  // per-host データ
  if (state.machines) {
    for (const [hostname, fields] of Object.entries(state.machines)) {
      if (hostname === PLACEHOLDER_HOSTNAME) continue;
      ensureMachineData(hostname);
      for (const [key, rawValue] of Object.entries(fields)) {
        setStoredDataForHost(hostname, key, rawValue, true);
      }
      markAllKeysDirty(hostname);
    }
  }

  console.info(`[client-sync] スナップショット適用完了: ${Object.keys(state.machines || {}).length}ホスト`);

  // ★ aggregator タイマー起動 + パネル自動生成
  // dynamic import のエラーを .catch() で確実に捕捉する
  const hostnames = state.machines ? Object.keys(state.machines).filter(h => h !== PLACEHOLDER_HOSTNAME) : [];

  import("./dashboard_aggregator.js").then(({ restartAggregatorTimer }) => {
    restartAggregatorTimer();
    console.info("[client-sync] aggregator タイマー起動");
  }).catch(e => console.error("[client-sync] aggregator import 失敗:", e));

  import("./dashboard_panel_factory.js").then(({ ensureHostPanels, restoreLayout }) => {
    const restored = restoreLayout();
    console.info(`[client-sync] restoreLayout: ${restored ? "成功" : "データなし"}`);
    // ★ restoreLayout 成功/失敗に関わらず、スナップショットの全ホストにパネルを保証
    // （レイアウトが1台分しか保存されていなくても、2台目のパネルを自動生成）
    for (const hostname of hostnames) {
      const count = ensureHostPanels(hostname);
      if (count > 0) {
        console.info(`[client-sync] ensureHostPanels(${hostname}): ${count}パネル生成`);
      }
    }
  }).catch(e => console.error("[client-sync] パネル生成失敗:", e));
}

/**
 * デルタ更新を monitorData に適用する。
 *
 * @private
 * @param {Object} msg - デルタメッセージ
 */
function _applyDelta(msg) {
  // per-host 差分
  if (msg.machines) {
    for (const [hostname, changes] of Object.entries(msg.machines)) {
      if (hostname === PLACEHOLDER_HOSTNAME) continue;
      ensureMachineData(hostname);
      for (const [key, rawValue] of Object.entries(changes)) {
        setStoredDataForHost(hostname, key, rawValue, true);
      }
      // ★ デルタ適用後に dirty マークを設定し、子クライアントの画面を更新
      markAllKeysDirty(hostname);
    }
  }

  // 共有データ差分（★ delta は親が権威なので全置換で正しい）
  if (msg.shared) {
    if (msg.shared.filamentSpools) monitorData.filamentSpools = msg.shared.filamentSpools;
    if (msg.shared.hostSpoolMap) Object.assign(monitorData.hostSpoolMap, msg.shared.hostSpoolMap);
  }
}

/**
 * 親経由でプリンタにコマンドを送信する（satellite モード専用）。
 *
 * @param {string} method - コマンドメソッド（"set", "get" 等）
 * @param {Object} params - コマンドパラメータ
 * @param {string} hostname - 対象プリンタのホスト名
 * @returns {boolean} 送信成功なら true
 */
export function sendRelayCommand(method, params, hostname) {
  if (_relayMode !== "satellite") {
    console.warn("[client-sync] readonly モードではコマンド送信不可");
    return false;
  }
  if (!_relayWs || _relayWs.readyState !== 1) {
    console.warn("[client-sync] リレー未接続");
    return false;
  }
  _relayWs.send(JSON.stringify({
    type: "relay-command",
    target: hostname,
    method,
    params
  }));
  return true;
}

/**
 * 親経由でフィラメント操作を送信する（satellite モード専用）。
 *
 * @param {string} action - "mount" | "unmount"
 * @param {Object} data - 操作データ
 * @returns {boolean} 送信成功なら true
 */
/**
 * トップバーにリレーモードバッジを表示する。
 *
 * @private
 * @param {string} mode - "readonly" | "satellite"
 */
function _showModeBadge(mode) {
  const badge = document.getElementById("relay-mode-badge");
  if (!badge) return;
  const labels = {
    readonly: "👁 READONLY",
    satellite: "🛰 SATELLITE"
  };
  badge.textContent = labels[mode] || mode;
  badge.className = `relay-mode-badge ${mode}`;
  badge.style.display = "";
}

export function sendRelayFilament(action, data) {
  if (_relayMode !== "satellite") return false;
  if (!_relayWs || _relayWs.readyState !== 1) return false;
  _relayWs.send(JSON.stringify({
    type: "relay-filament",
    action,
    data
  }));
  return true;
}
