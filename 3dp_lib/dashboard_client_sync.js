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
 *   （フィラメント共有状態は親権威の全置換 + mountHistory 同期）
 * - satellite モードでのコマンド/フィラメント操作の送信（操作は親へ RPC 委譲）
 * - 初回接続は常に readonly。?relay=satellite 要求時は自動昇格リクエスト（PIN 保護）
 *
 * 【公開関数一覧】
 * - {@link initClientSync}：子クライアント同期を開始
 * - {@link getRelayMode}：現在のリレーモードを返す
 * - {@link sendRelayCommand}：親経由でプリンタにコマンド送信
 * - {@link sendRelayFilament}：親経由でフィラメント操作
 *
 * @version 1.390.1110 (PR #380)
 * @since   1.390.820 (PR #367)
 * @lastModified 2026-06-12 12:00:00
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

/** URL で要求されたモード（自動昇格判定用。サーバ初回接続は常に readonly のため） */
let _wantedMode = null;

/** このページロード中に一度でも satellite へ昇格したか（再接続時の自動再昇格用） */
let _everSatellite = false;

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
 * - ブラウザ: URL ?relay=standalone → "standalone"（直接接続・明示オプトアウト）
 * - ブラウザ子: URL ?relay=readonly|satellite → "readonly"|"satellite"
 * - それ以外の http(s): デフォルトで "readonly"（リレー子）
 * - file://: "standalone"
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
  // ★ ?relay=standalone : http(s) でもリレー子にせずプリンタ直接接続する明示オプトアウト。
  //   （既定は下の readonly のまま。サテライト運用に影響しない。）
  if (relayParam === "standalone" || relayParam === "direct") return "standalone";
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
  _wantedMode = _relayMode; // URL 要求モードを記憶（relay-init 後の自動昇格判定に使用）
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
      // ★ サーバは初回接続を常に readonly で受け付ける（?mode=satellite による
      //   PIN 回避を防止）。URL が satellite を要求している、または切断前に
      //   satellite だった（再接続）場合は自動で昇格要求を送る。
      //   親に PIN 未設定なら即昇格、設定済みなら PIN 入力ダイアログが開く。
      if (msg.mode === "readonly" && (_wantedMode === "satellite" || _everSatellite)) {
        console.info("[client-sync] satellite を要求 → 昇格リクエストを自動送信");
        _sendPromoteRequest("");
      }
      break;

    case "relay-promote-granted":
      console.info("[client-sync] 操作モードへ昇格しました");
      _relayMode = "satellite";
      _everSatellite = true; // 再接続時の自動再昇格用
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
      _everSatellite = false; // 明示的な降格 → 再接続時に自動再昇格しない
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
 * 親から受信した共有フィラメント状態（filamentSpools / hostSpoolMap / mountHistory）を
 * monitorData へ「全置換」で適用する。
 *
 * 【詳細説明】
 * - 親が唯一の権威。子はフィラメント状態をローカル変更しない
 *   （aggregator はリレー子ガード済み、ユーザー操作は relay-filament RPC で親に委譲）ため、
 *   受信値での全置換が安全であり、取り外し・削除・交換の伝搬も正しく行われる。
 * - 配列・オブジェクトは参照を保ったまま中身を置換する（in-place）。
 *   ビューやモジュールが monitorData.filamentSpools / hostSpoolMap の参照を保持しているため。
 * - フィールドが欠落（undefined）している場合はそのフィールドを変更しない
 *   （差分メッセージに shared が部分的にしか含まれないケースの安全策）。
 * - 適用後はフィラメントプレビューへ反映する（パネルの装着スプール表示の追従）。
 *
 * ※ モジュール内部用だが、マージ規則の回帰テストのために export している。
 *
 * @function _applySharedFilamentState
 * @param {{filamentSpools?:Array<Object>, hostSpoolMap?:Object, mountHistory?:Array<Object>}} shared
 *   - 受信した共有データ
 * @returns {void}
 */
export function _applySharedFilamentState(shared) {
  if (!shared) return;
  if (Array.isArray(shared.filamentSpools)) {
    // 空配列も正当（親が全削除した状態）。全置換で削除を伝搬する。
    monitorData.filamentSpools.splice(
      0, monitorData.filamentSpools.length, ...shared.filamentSpools
    );
  }
  if (shared.hostSpoolMap && typeof shared.hostSpoolMap === "object") {
    for (const k of Object.keys(monitorData.hostSpoolMap)) {
      delete monitorData.hostSpoolMap[k];
    }
    Object.assign(monitorData.hostSpoolMap, shared.hostSpoolMap);
  }
  if (Array.isArray(shared.mountHistory)) {
    // ADR-0004 台帳（装着履歴）。子では読み取り専用のため全置換でよい。
    monitorData.mountHistory = shared.mountHistory.slice();
  }
  _refreshFilamentPreviews();
}

/** 前回プレビューへ反映した装着構成シグネチャ（host → signature）。再描画間引き用 */
const _prevPreviewSig = new Map();

/**
 * 各ホストのフィラメントプレビュー（リール描画）へ、同期済みの装着スプール情報を反映する。
 *
 * 【詳細説明】
 * - 親側ではスプール操作フロー（交換ダイアログ等）が直接 preview.setState を呼ぶが、
 *   子では操作が RPC 化されており UI 反映の契機が無いため、共有データ適用後に
 *   本関数で一括反映する。
 * - 印刷中は共有デルタが 500ms ごとに届く（remainingLengthMm が毎 tick 変化する）ため、
 *   「装着構成（スプールID・名称・色・総量）」のシグネチャが変化したときのみ
 *   setState する。残量のライブ更新は従来どおり storedData の
 *   filamentRemainingMm dirty-key 経由（dashboard_ui.js）が担うため、
 *   ここで毎デルタ再描画する必要はない（再描画2重化によるCPU増を防ぐ）。
 * - プレビュー未生成（パネル未構築）の場合は何もしない。
 *
 * @private
 * @returns {void}
 */
function _refreshFilamentPreviews() {
  try {
    const previews = (typeof window !== "undefined" && window._filamentPreviews) || null;
    if (!previews || typeof previews.entries !== "function") return;
    for (const [host, fp] of previews.entries()) {
      if (!fp || typeof fp.setState !== "function") continue;
      const spId = monitorData.hostSpoolMap?.[host];
      const sp = spId ? monitorData.filamentSpools.find(s => s && s.id === spId) : null;
      // 装着構成シグネチャ（残量は含めない — ライブ更新は dirty-key 経路が担当）
      const sig = sp
        ? [sp.id, sp.name, sp.filamentColor || sp.color, sp.totalLengthMm,
           sp.materialName || sp.material, sp.colorName].join("|")
        : "(none)";
      if (_prevPreviewSig.get(host) === sig) continue;
      _prevPreviewSig.set(host, sig);
      if (sp) {
        fp.setState({
          isFilamentPresent: true,
          filamentCurrentLength: sp.remainingLengthMm ?? 0,
          filamentTotalLength: sp.totalLengthMm || 330000,
          filamentColor: sp.filamentColor || sp.color || "#22C55E",
          reelName: sp.name || "",
          reelSubName: sp.reelSubName || "",
          materialName: sp.materialName || sp.material || "",
          materialColorName: sp.colorName || "",
          materialColorCode: sp.filamentColor || "",
          manufacturerName: sp.manufacturerName || sp.brand || ""
        });
      } else {
        fp.setState({ isFilamentPresent: false });
      }
    }
  } catch (e) {
    console.debug("[client-sync] フィラメントプレビュー反映スキップ:", e?.message || e);
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

  // ★ フィラメントデータ: 親が唯一の権威 — 受信内容で全置換する。
  //   旧実装は IDベースマージ + sticky フラグ保護（prevActive || ... ）だったため、
  //   (a) 親で取り外し/交換しても子の isActive/isInUse/hostname が永遠に解除されない、
  //   (b) 親で削除したスプールが子に残り続ける、という親子乖離の根本原因だった。
  //   子はスプール状態をローカル変更しない（aggregator はリレー子ガード済み・
  //   操作は relay-filament RPC で親に委譲）ため、全置換が安全かつ正しい。
  //   配列/オブジェクトの参照は保持する（ビュー側が参照を保持しているため in-place 置換）。
  _applySharedFilamentState(state);

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

  // ★ 共有データ差分: 親が唯一の権威 — 受信内容で全置換する（スナップショットと同一規則）。
  //   親は変更検出時に filamentSpools/hostSpoolMap の「完全な現在値」を送るため、
  //   差分でも全置換で整合する（IDマージ+stickyフラグは乖離の根本原因だった）。
  if (msg.shared) {
    _applySharedFilamentState(msg.shared);
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
    _alertRelayBlocked("readonly");
    return false;
  }
  if (!_relayWs || _relayWs.readyState !== 1) {
    console.warn("[client-sync] リレー未接続");
    _alertRelayBlocked("disconnected");
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

/** リレー操作ブロック時のトースト連続表示を抑制するための最終表示時刻 */
let _lastRelayAlertMs = 0;

/**
 * リレー経由の操作が送信できなかったことをユーザーへトースト通知する。
 *
 * 【詳細説明】
 * - 旧実装は console.warn のみでサイレント失敗していたため、
 *   サテライト側のボタンが「押せるのに何も起きない」モック的挙動に見えていた。
 * - 1.5 秒以内の連続失敗は 1 回にまとめる（スライダー操作等の連打対策）。
 *
 * @private
 * @param {"readonly"|"disconnected"} reason - ブロック理由
 * @returns {void}
 */
function _alertRelayBlocked(reason) {
  const now = Date.now();
  if (now - _lastRelayAlertMs < 1500) return;
  _lastRelayAlertMs = now;
  import("./dashboard_notification_manager.js").then(({ showAlert }) => {
    const msg = reason === "readonly"
      ? "閲覧専用モードのため操作できません（右上の昇格ボタンから操作モードに切り替えてください）"
      : "親機との接続が切れているため操作を送信できません";
    showAlert(msg, "warn");
  }).catch(() => { /* 通知不能時は console のみ */ });
}

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

/**
 * 親経由でフィラメント操作を送信する（satellite モード専用）。
 *
 * 【詳細説明】
 * - 子（satellite）はスプール状態をローカル変更せず、本関数で親へ操作を委譲する。
 *   親が実処理（dashboard_relay_bridge の onRelayFilament ハンドラ）を実行し、
 *   結果は relay-delta（filamentSpools/hostSpoolMap/mountHistory 全置換）で還流する。
 * - readonly モード・未接続時はトーストでユーザーへ通知し false を返す。
 *
 * @function sendRelayFilament
 * @param {string} action - 操作種別
 *   ("mount" | "unmount" | "addSpoolFromPreset" | "mountNewSpoolFromPreset" |
 *    "updateSpool" | "deleteSpool" | "restoreSpool" |
 *    "confirmInferredSpool" | "revertInferredSpool")
 * @param {Object} data - 操作データ（action ごとのペイロード）
 * @returns {boolean} 送信できた場合 true
 */
export function sendRelayFilament(action, data) {
  if (_relayMode !== "satellite") {
    console.warn(`[client-sync] readonly モードではフィラメント操作不可: ${action}`);
    _alertRelayBlocked("readonly");
    return false;
  }
  if (!_relayWs || _relayWs.readyState !== 1) {
    console.warn(`[client-sync] リレー未接続のためフィラメント操作を送信できません: ${action}`);
    _alertRelayBlocked("disconnected");
    return false;
  }
  _relayWs.send(JSON.stringify({
    type: "relay-filament",
    action,
    data
  }));
  return true;
}
