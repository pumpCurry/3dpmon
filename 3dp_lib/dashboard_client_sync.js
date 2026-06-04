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
      _updateRelayModeUI(_relayMode);
      _setupPromoteButton();
      break;

    case "relay-promote-granted":
      console.info("[client-sync] 操作モードへ昇格しました");
      _relayMode = "satellite";
      _updateRelayModeUI("satellite");
      _notifyModeChange("operate");
      break;

    case "relay-promote-denied":
      console.warn(`[client-sync] 昇格拒否: ${msg.reason}`);
      _onPromoteDenied(msg.reason);
      break;

    case "relay-demote-granted":
      console.info("[client-sync] 閲覧専用に戻りました");
      _relayMode = "readonly";
      _updateRelayModeUI("readonly");
      _notifyModeChange("view");
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
 * 親から受信した printStore（印刷履歴・現在ジョブ）を monitorData に反映する。
 * 子（satellite/readonly）はプリンタへ直接接続しないため、履歴はこの経路でのみ届く。
 *
 * @private
 * @param {string} hostname - ホスト名
 * @param {{history?:Array, current?:Object|null}} ps - 受信した printStore
 */
function _applyRelayPrintStore(hostname, ps) {
  if (!ps) return;
  ensureMachineData(hostname);
  const machine = monitorData.machines[hostname];
  if (!machine.printStore) machine.printStore = { current: null, history: [], videos: {} };
  if (Array.isArray(ps.history)) machine.printStore.history = ps.history;
  if (Object.prototype.hasOwnProperty.call(ps, "current")) {
    machine.printStore.current = ps.current;
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

  // ★ フィラメントデータ: IDベースマージ（全置換は既存スプールを破壊するため禁止）
  if (Array.isArray(state.filamentSpools) && state.filamentSpools.length > 0) {
    const existingIds = new Set(monitorData.filamentSpools.map(s => s.id));
    for (const sp of state.filamentSpools) {
      if (!sp.id) continue;
      if (existingIds.has(sp.id)) {
        const existing = monitorData.filamentSpools.find(s => s.id === sp.id);
        if (existing) {
          const prevActive = existing.isActive;
          const prevInUse = existing.isInUse;
          const prevHostname = existing.hostname;
          Object.assign(existing, sp);
          // ランタイム装着状態を保護
          existing.isActive = prevActive || existing.isActive;
          existing.isInUse = prevInUse || existing.isInUse;
          existing.hostname = prevHostname || existing.hostname;
        }
      } else {
        monitorData.filamentSpools.push(sp);
      }
    }
  }
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

  // ★ 印刷履歴・現在ジョブを適用（この後の ensureHostPanels で履歴パネルが自動描画する）
  if (state.printStores) {
    for (const [hostname, ps] of Object.entries(state.printStores)) {
      if (hostname === PLACEHOLDER_HOSTNAME) continue;
      _applyRelayPrintStore(hostname, ps);
    }
  }

  // ★ ファイル一覧を適用（initFileListPanel が _cachedFileInfo を読んで描画する）
  if (state.fileInfos) {
    for (const [hostname, info] of Object.entries(state.fileInfos)) {
      if (hostname === PLACEHOLDER_HOSTNAME) continue;
      ensureMachineData(hostname);
      monitorData.machines[hostname]._cachedFileInfo = info;
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
    // ★ 再接続などで既存パネルがある場合に履歴/ファイル一覧を再描画する。
    //   新規生成パネルは init 時に描画済みだが、再描画は冪等なので無害。
    return import("./dashboard_printmanager.js").then(pm => {
      for (const hostname of hostnames) {
        pm.rerenderHistoryForHost(hostname);
        pm.rerenderFileListForHost(hostname);
      }
    });
  }).catch(e => console.error("[client-sync] パネル生成/履歴描画失敗:", e));
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
        // setStoredDataForHost が変更キーを自動的に dirty 化するため
        // markAllKeysDirty は不要（全キー dirty 化による性能低下を回避）
        setStoredDataForHost(hostname, key, rawValue, true);
      }
    }
  }

  // ★ 共有データ差分: IDベースマージ（全置換は既存データを破壊するため禁止）
  if (msg.shared) {
    if (Array.isArray(msg.shared.filamentSpools) && msg.shared.filamentSpools.length > 0) {
      const existingIds = new Set(monitorData.filamentSpools.map(s => s.id));
      for (const sp of msg.shared.filamentSpools) {
        if (!sp.id) continue;
        if (existingIds.has(sp.id)) {
          const existing = monitorData.filamentSpools.find(s => s.id === sp.id);
          if (existing) {
            const prevActive = existing.isActive;
            const prevInUse = existing.isInUse;
            const prevHostname = existing.hostname;
            Object.assign(existing, sp);
            existing.isActive = prevActive || existing.isActive;
            existing.isInUse = prevInUse || existing.isInUse;
            existing.hostname = prevHostname || existing.hostname;
          }
        } else {
          monitorData.filamentSpools.push(sp);
        }
      }
    }
    if (msg.shared.hostSpoolMap) Object.assign(monitorData.hostSpoolMap, msg.shared.hostSpoolMap);
  }

  // ★ 印刷履歴・現在ジョブの差分適用 + 履歴パネル再描画
  if (msg.printStores) {
    for (const [hostname, ps] of Object.entries(msg.printStores)) {
      if (hostname === PLACEHOLDER_HOSTNAME) continue;
      _applyRelayPrintStore(hostname, ps);
    }
    const hosts = Object.keys(msg.printStores).filter(h => h !== PLACEHOLDER_HOSTNAME);
    import("./dashboard_printmanager.js").then(pm => {
      for (const h of hosts) pm.rerenderHistoryForHost(h);
    }).catch(e => console.error("[client-sync] 履歴delta描画失敗:", e));
  }

  // ★ ファイル一覧の差分適用 + ファイル一覧パネル再描画
  if (msg.fileInfos) {
    for (const [hostname, info] of Object.entries(msg.fileInfos)) {
      if (hostname === PLACEHOLDER_HOSTNAME) continue;
      ensureMachineData(hostname);
      monitorData.machines[hostname]._cachedFileInfo = info;
    }
    const hosts = Object.keys(msg.fileInfos).filter(h => h !== PLACEHOLDER_HOSTNAME);
    import("./dashboard_printmanager.js").then(pm => {
      for (const h of hosts) pm.rerenderFileListForHost(h);
    }).catch(e => console.error("[client-sync] ファイル一覧delta描画失敗:", e));
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
 * リレーモードに応じてUI（body クラス・バッジ・昇格ボタン）を一括更新する。
 *
 * @private
 * @param {string} mode - "readonly" | "satellite"
 */
function _updateRelayModeUI(mode) {
  // body クラス: 旧モードを除去して現モードを設定（readonly制御CSSの切替）
  document.body.classList.remove("relay-readonly", "relay-satellite");
  document.body.classList.add(`relay-${mode}`);
  _showModeBadge(mode);
  _updatePromoteButton(mode);
}

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

/**
 * 昇格/降格ボタンのラベル・表示をモードに合わせて更新する。
 *
 * @private
 * @param {string} mode - "readonly" | "satellite"
 */
function _updatePromoteButton(mode) {
  const btn = document.getElementById("relay-promote-btn");
  if (!btn) return;
  if (mode === "readonly") {
    btn.textContent = "🛰 操作モードへ昇格";
    btn.title = "プリンタを直接操作できるモードに切り替えます";
    btn.style.display = "";
  } else if (mode === "satellite") {
    btn.textContent = "👁 閲覧専用に戻す";
    btn.title = "操作を無効化し閲覧専用に戻します";
    btn.style.display = "";
  } else {
    btn.style.display = "none";
  }
}

/** 昇格ボタンのリスナー登録済みフラグ */
let _promoteBtnWired = false;

/**
 * 昇格/降格ボタンにクリックリスナーを登録する（1度だけ）。
 *
 * @private
 */
function _setupPromoteButton() {
  if (_promoteBtnWired) return;
  const btn = document.getElementById("relay-promote-btn");
  if (!btn) return;
  _promoteBtnWired = true;
  btn.addEventListener("click", _onPromoteButtonClick);
}

/**
 * 昇格/降格ボタンのクリック処理。
 * readonly→確認ダイアログ→昇格要求、satellite→確認ダイアログ→降格要求。
 *
 * @private
 */
async function _onPromoteButtonClick() {
  const { showConfirmDialog } = await import("./dashboard_ui_confirm.js");
  if (_relayMode === "readonly") {
    const ok = await showConfirmDialog({
      level: "warn",
      title: "操作モードへ昇格",
      message: "プリンタを直接操作できるようになります。昇格しますか？",
      confirmText: "昇格する",
      cancelText: "キャンセル"
    });
    if (!ok) return;
    _sendPromoteRequest("");  // まず PIN なしで要求。親が必要と判定したら PIN を促す
  } else if (_relayMode === "satellite") {
    const ok = await showConfirmDialog({
      level: "info",
      title: "閲覧専用に戻す",
      message: "操作を無効化し、閲覧専用モードに戻します。よろしいですか？",
      confirmText: "戻す",
      cancelText: "キャンセル"
    });
    if (!ok) return;
    if (_relayWs && _relayWs.readyState === 1) {
      _relayWs.send(JSON.stringify({ type: "relay-demote-request" }));
    }
  }
}

/**
 * 昇格要求をサーバへ送信する。
 *
 * @private
 * @param {string} pin - 入力PIN（不要なら空文字）
 */
function _sendPromoteRequest(pin) {
  if (!_relayWs || _relayWs.readyState !== 1) {
    console.warn("[client-sync] リレー未接続のため昇格要求を送れません");
    return;
  }
  _relayWs.send(JSON.stringify({ type: "relay-promote-request", pin: pin || "" }));
}

/**
 * 昇格拒否時の処理。PIN 要求/不一致なら PIN 入力ダイアログを出して再要求する。
 *
 * @private
 * @param {string} reason - 拒否理由
 */
async function _onPromoteDenied(reason) {
  const { showConfirmDialog, showInputDialog } = await import("./dashboard_ui_confirm.js");
  if (reason === "pin-required" || reason === "pin-mismatch") {
    const message = reason === "pin-mismatch"
      ? "PINが一致しません。もう一度入力してください。"
      : "操作モードへの昇格にはPINが必要です。親機で設定されたPINを入力してください。";
    const pin = await showInputDialog({
      level: "warn",
      title: "昇格PINの入力",
      message,
      placeholder: "PIN",
      confirmText: "認証",
      cancelText: "キャンセル"
    });
    if (pin == null || String(pin).trim() === "") return;
    _sendPromoteRequest(String(pin).trim());
  } else {
    await showConfirmDialog({
      level: "error",
      title: "昇格できません",
      message: `操作モードへの昇格が拒否されました (${reason || "denied"})`,
      confirmText: "OK"
    });
  }
}

/**
 * モード変更をトースト等で通知する（任意UI）。
 *
 * @private
 * @param {string} kind - "operate" | "view"
 */
function _notifyModeChange(kind) {
  try {
    const label = kind === "operate" ? "操作モードに切り替えました" : "閲覧専用に戻しました";
    const el = document.getElementById("relay-mode-badge");
    if (el) {
      el.classList.add("relay-mode-flash");
      setTimeout(() => el.classList.remove("relay-mode-flash"), 1200);
    }
    console.info(`[client-sync] ${label}`);
  } catch { /* 通知失敗は無視 */ }
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
