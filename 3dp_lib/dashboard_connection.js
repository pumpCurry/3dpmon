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
 * - {@link sendCommand}：任意コマンド送信（タイムアウト付き）
 * - {@link sendGcodeCommand}：G-code 送信（タイムアウト付き）
 * - {@link updateConnectionUI}：UI 状態更新
 * - {@link simulateReceivedJson}：受信データシミュレート
 * - {@link cleanupConnection}：接続情報の完全破棄
 * - {@link getConnectionMap}：接続中ホスト一覧取得
 * - {@link getConnectionState}：指定ホストの接続状態取得
 *
 * @version 1.390.787 (PR #367)
 * @since   1.390.451 (PR #205)
 * @lastModified 2026-03-12
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
  setNotificationSuppressed,
  setStoredDataForHost,
  ensureMachineData,
  markAllKeysDirty,
  scopedById
} from "./dashboard_data.js";
import { pushLog } from "./dashboard_log_util.js";
import { aggregatorUpdate, restoreAggregatorState } from "./dashboard_aggregator.js";
import { restorePrintResume } from "./3dp_dashboard_init.js";
import { handleMessage, processData } from "./dashboard_msg_handler.js";
import { restartAggregatorTimer, stopAggregatorTimer } from "./dashboard_aggregator.js";
import * as printManager from "./dashboard_printmanager.js";
import { showAlert } from "./dashboard_notification_manager.js";
import { startCameraStream, stopCameraStream } from "./dashboard_camera_ctrl.js";
import { getCurrentTimestamp } from "./dashboard_utils.js";
import { updatePanelMenuHosts } from "./dashboard_panel_menu.js";
import { migratePanelsToHost, renamePanelsHost, ensureHostPanels, removePanelsForHost, updateAllPanelHeaders } from "./dashboard_panel_factory.js";
import { saveUnifiedStorage, restoreLegacyStoredData, cleanupLegacy } from "./dashboard_storage.js";
import { showConfirmDialog } from "./dashboard_ui_confirm.js";

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
 * @property {number}         fileReqRetry  - ファイル一覧リトライ回数
 * @property {boolean}        fileInfoReceived - ファイル一覧応答受信済みか
 * @property {boolean}        historyReqSent - 履歴要求済みか
 * @property {number}         historyReqRetry - 履歴リトライ回数
 * @property {boolean}        userDisc      - ユーザー操作により切断されたか
 * @property {Array<Object>}  buffer        - ホスト確定前に受信したデータ
 * @property {Object|null}    latest        - 最新受信データ
 * @property {string}         dest          - 接続先(IP:PORT)
 * @property {"disconnected"|"connecting"|"connected"|"waiting"} state
 *                                        - UI 表示用状態
 */

/** 再接続上限回数 */
const MAX_RECONNECT = 5;

/* ─── 接続先リスト永続化ヘルパー ─── */

/**
 * 接続先を connectionTargets リストに追加し永続化する。
 * 同一 dest（IP:PORT 完全一致）の重複は登録しない。
 * 機器ごとにポートが異なる場合があるため、IP のみでの照合は行わない。
 *
 * @private
 * @param {string} dest - "IP:PORT" 形式の接続先
 */
function _addConnectionTarget(dest) {
  if (!dest) return;
  const targets = monitorData.appSettings.connectionTargets ??= [];
  /* 同一 dest（IP:PORT）の重複を防ぐ */
  if (targets.some(t => t.dest === dest)) return;
  targets.push({ dest, color: "", label: "", hostname: "" });
  saveUnifiedStorage();
}

/**
 * 接続先設定にホスト名を紐づける。
 * ホスト名解決後に呼び出してラベル表示等に利用する。
 *
 * @private
 * @param {string} dest     - "IP:PORT" 形式
 * @param {string} hostname - 解決されたホスト名
 */
function _setConnectionTargetHostname(dest, hostname) {
  const t = _findConnectionTarget(dest);
  if (!t) return;
  if (t.hostname === hostname) return; // 変更なし

  if (t.hostname && t.hostname !== hostname) {
    // ★ 既にホスト名が紐付いている dest で別のホスト名が返ってきた
    // → IP再利用（DHCP）の可能性。旧ホスト名を保護し、新規エントリとして追加
    console.warn(`[_setConnectionTargetHostname] IP再利用検出: ${dest} の hostname が ${t.hostname} → ${hostname} に変化`);
    // 旧エントリのhostnameはそのまま残す（旧機器が復帰する可能性）
    // 新エントリとして同じdestに新hostnameを追加（hostname違いの重複を許容）
    const targets = monitorData.appSettings.connectionTargets ??= [];
    const exists = targets.some(e => e.dest === dest && e.hostname === hostname);
    if (!exists) {
      targets.push({ dest, hostname, color: t.color || "", label: "" });
    }
    // 旧エントリのhostnameを更新（現在の接続先を反映）
    t.hostname = hostname;
    saveUnifiedStorage();
    // ★ MAC アドレスで機器変更を確認
    _resolveAndSaveMac(dest, hostname);
    return;
  }

  // 初回: ホスト名が空 → 設定
  t.hostname = hostname;
  saveUnifiedStorage();
  // ★ MAC アドレスを非同期で解決（Electron版のみ）
  _resolveAndSaveMac(dest, hostname);
}

/**
 * 接続先の MAC アドレスを ARP テーブルから解決して connectionTargets に保存する。
 * Electron 環境でのみ動作（window.electronAPI.arpResolve が必要）。
 * 非同期で実行し、UI をブロックしない。
 *
 * @private
 * @param {string} dest - "IP:PORT" 形式
 * @param {string} hostname - 解決済みホスト名
 */
async function _resolveAndSaveMac(dest, hostname) {
  if (!window.electronAPI?.arpResolve) return;
  const ip = dest.split(":")[0];
  try {
    const mac = await window.electronAPI.arpResolve(ip);
    if (!mac) return;
    const t = _findConnectionTarget(dest);
    if (t && t.macAddress !== mac) {
      // MAC が変わった（= 別の機器がIPを再利用）場合に検出
      if (t.macAddress && t.macAddress !== mac) {
        console.warn(`[MAC] IP再利用検出: ${ip} の MAC が ${t.macAddress} → ${mac} に変化（${hostname}）`);
      }
      t.macAddress = mac;
      saveUnifiedStorage(true);
      console.info(`[MAC] ${hostname} (${ip}) → ${mac}`);
    }
  } catch (e) {
    console.debug(`[MAC] ARP解決失敗 (${ip}):`, e.message);
  }
}

/**
 * 接続先設定を dest（IP:PORT）で検索して返す。
 * dest 完全一致 → ホスト名一致 の優先順で検索する。
 *
 * @private
 * @param {string} destOrHost - "IP:PORT" 形式の接続先、またはホスト名
 * @returns {object|null} connectionTargets 内のエントリ、または null
 */
function _findConnectionTarget(destOrHost) {
  if (!destOrHost) return null;
  const targets = monitorData.appSettings.connectionTargets || [];
  /* dest 完全一致（IP:PORT）を優先 */
  const exact = targets.find(t => t.dest === destOrHost);
  if (exact) return exact;
  /* ホスト名での検索（connectWs からの逆引き用） */
  return targets.find(t => t.hostname === destOrHost) || null;
}

/**
 * 接続先を connectionTargets リストから削除し永続化する。
 * dest（IP:PORT）完全一致で検索する。
 * 削除前に保存されていたホスト名を返す（クリーンアップ用）。
 *
 * @private
 * @param {string} dest - "IP:PORT" 形式の接続先
 * @returns {string} 削除されたエントリに紐づくホスト名（未設定時は空文字）
 */
function _removeConnectionTarget(dest) {
  if (!dest) return "";
  const targets = monitorData.appSettings.connectionTargets;
  if (!targets) return "";
  const idx = targets.findIndex(t => t.dest === dest);
  if (idx >= 0) {
    const removed = targets.splice(idx, 1)[0];
    saveUnifiedStorage();
    return removed.hostname || "";
  }
  return "";
}

/**
 * 全保存済み接続先に自動接続する。
 * 起動時に呼び出す。wsDest（メイン）と connectionTargets の両方をカバーする。
 *
 * @function connectAllSavedTargets
 * @returns {void}
 */
export function connectAllSavedTargets() {
  const connected = new Set();

  /* wsDest が connectionTargets に未登録なら移行する（後方互換） */
  const main = monitorData.appSettings.wsDest;
  if (main) {
    _addConnectionTarget(main);
  }

  /* connectionTargets を唯一の接続先リストとして使用 */
  const targets = monitorData.appSettings.connectionTargets || [];
  for (const t of targets) {
    const ip = t.dest.split(":")[0];
    if (!connected.has(ip)) {
      connected.add(ip);
      connectWs(t.dest);
    }
  }
}

/** ホスト確定前メッセージバッファの上限 */
const MAX_BUFFER_SIZE = 100;

let isAutoScrollEnabled = true;      // 現在「自動スクロール中」なら true
let lastActiveTab = "received";      // "received" or "error"
let lastWsAlertTime = 0;             // 最後に接続エラーを表示した時刻

/**
 * 各ホストのカウントダウンタイマーID を保持するマップ。
 * 再接続待機中のカウントダウン表示タイマーの競合を防止する。
 * @type {Record<string, number|null>}
 */
const countdownTimers = {};

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
  fileReqRetry: 0,
  fileInfoReceived: false,
  historyReqSent: false,
  historyReqRetry: 0,
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
      fileReqRetry: 0,
      fileInfoReceived: false,
      historyReqSent: false,
      historyReqRetry: 0,
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
 * resolveActiveState:
 * --------------------
 * 指定ホスト名から実際の接続状態オブジェクトを取得します。
 * 大文字小文字の違いにより {@link getState} で取得できない場合に備え、
 * connectionMap を走査して一致するホストを検索します。
 *
 * @private
 * @param {string} host - 検索対象のホスト名
 * @returns {ConnectionState} 接続状態オブジェクト
 */
function resolveActiveState(host) {
  let st = getState(host);
  if (!st.ws) {
    const alt = Object.keys(connectionMap).find(
      (k) => k.toLowerCase() === host.toLowerCase()
    );
    if (alt) {
      st = connectionMap[alt];
    }
  }
  return st;
}

/**
 * 最新の WebSocket 受信データを返します。
 * @returns {Promise<Object|null>}
 */
export function fetchStoredData(host) {
  const st = connectionMap[host];
  return Promise.resolve(st?.latest ?? null);
}

/**
 * 指定ホストの接続先 IP アドレスを返す。
 *
 * @function getDeviceIp
 * @param {string} host - ホスト名
 * @returns {string} IP アドレス文字列（失敗時は空文字）
 */
export function getDeviceIp(host) {
  const st = connectionMap[host];
  const raw = st?.dest || monitorData.appSettings.wsDest || "";
  return raw.split(":")[0] || "";
}

/**
 * 指定ホストの接続先 "IP:PORT" を返す。
 * WebSocket ポートが機器ごとに異なる場合に dest 全体を取得するために使用する。
 *
 * @function getDeviceDest
 * @param {string} host - ホスト名
 * @returns {string} "IP:PORT" 形式（失敗時は空文字）
 */
export function getDeviceDest(host) {
  const st = connectionMap[host];
  return st?.dest || monitorData.appSettings.wsDest || "";
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
  if (newHost === PLACEHOLDER_HOSTNAME) {
    return oldHost;
  }
  if (oldHost === newHost) {
    /* キーは同一でもパネルが未生成の可能性があるため確保する */
    _syncPanelsForHost(newHost);
    return oldHost;
  }
  const state = connectionMap[oldHost];
  if (!state) return newHost;

  /* 接続先設定にホスト名を紐づける */
  const dest = state.dest || oldHost;
  _setConnectionTargetHostname(dest, newHost);

  /* ★ machines のキー移行: IP → ホスト名
     IP → ホスト名 の遷移（初回接続時）のみ移行する。
     ホスト名 → ホスト名 の遷移（IP再利用で別機器が応答）は
     移行せず、旧データを保護して新キーを新規作成する。 */
  const _isIpLike = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
  if (monitorData.machines[oldHost] && oldHost !== newHost) {
    if (_isIpLike(oldHost)) {
      // IP → ホスト名: 正常な初回接続 → machines データを移行
      const oldMachine = monitorData.machines[oldHost];
      if (!monitorData.machines[newHost]) {
        monitorData.machines[newHost] = oldMachine;
      } else {
        // 既にホスト名キーがある（restore済み）→ storedData をマージ
        const existing = monitorData.machines[newHost];
        if (oldMachine.storedData) {
          existing.storedData ??= {};
          for (const [key, val] of Object.entries(oldMachine.storedData)) {
            if (!(key in existing.storedData) || existing.storedData[key]?.rawValue == null) {
              existing.storedData[key] = val;
            }
          }
        }
        if (oldMachine.printStore?.history?.length && !existing.printStore?.history?.length) {
          existing.printStore = oldMachine.printStore;
        }
      }
      delete monitorData.machines[oldHost];
      try {
        const lsKey = "3dpmon-host-" + encodeURIComponent(oldHost);
        if (localStorage.getItem(lsKey)) localStorage.removeItem(lsKey);
      } catch { /* ignore */ }
      console.info(`[updateConnectionHost] machines IP→ホスト名移行: ${oldHost} → ${newHost}`);
    } else {
      // ホスト名 → ホスト名: IP再利用で別機器が応答した可能性
      // ★ 旧ホスト名のデータは保護し、新ホスト名を新規作成する
      console.warn(`[updateConnectionHost] ホスト名変更検出: ${oldHost} → ${newHost} (IP再利用の可能性 — 旧データ保護)`);
      if (!monitorData.machines[newHost]) {
        ensureMachineData(newHost);
      }
      // 旧キーの machines データは削除しない（後で正しいIPで再接続される可能性がある）
    }
  }

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

    updateConnectionUI(target.state, {}, newHost);
    updatePrinterListUI();
    _syncPanelsForHost(newHost, oldHost);
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

  updateConnectionUI(state.state, {}, newHost);
  updatePrinterListUI();
  _syncPanelsForHost(newHost, oldHost);
  return newHost;
}

/**
 * flushBufferedMessages:
 * ----------------------
 * 指定ホストの接続確立後に、保持していた未処理メッセージを
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
      pushLog("バッファ処理中にエラー: " + e.message, "error", false, host);
      console.error("[flushBufferedMessages]", e);
    }
  }
}


/**
 * _cleanupMachineKeys:
 * --------------------
 * 指定された全キーに対して monitorData.machines の **IP キー** エントリのみ削除する。
 * ホスト名キー（非IPキー）は削除しない。
 * IP が変わっても同一ホスト名であればデータを引き継げるようにするため。
 *
 * ユーザによる明示的な接続先削除時にのみ呼び出す。
 *
 * @private
 * @param {string[]} keys - 削除対象のキー配列（IP アドレスのみ渡すこと）
 * @returns {void}
 */
function _cleanupMachineKeys(keys) {
  const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  for (const key of keys) {
    if (!key || key === PLACEHOLDER_HOSTNAME) continue;
    /* ホスト名キーを誤って消さないよう、IP 形式のみ対象とする */
    if (!IP_RE.test(key)) continue;
    if (monitorData.machines[key]) {
      delete monitorData.machines[key];
    }
  }
}

/**
 * getHttpPort:
 * -------------
 * 指定ホストの HTTP ポートを返す。
 * connectionTarget に httpPort が設定されていればそれを使い、
 * なければ appSettings.httpPort のデフォルト（80）を返す。
 *
 * @private
 * @param {string} host - ホスト名
 * @returns {number} HTTP ポート番号
 */
export function getHttpPort(host) {
  const st = connectionMap[host];
  const dest = st?.dest || "";
  const tgt = _findConnectionTarget(dest) || _findConnectionTarget(host);
  return tgt?.httpPort || monitorData.appSettings.httpPort || 80;
}

/**
 * _syncPanelsForHost:
 * -------------------
 * ホスト名確定時にパネルを同期する。
 * - oldHost が指定された場合: IP→ホスト名のパネルID移行を行う
 * - 接続ホストが1台目の場合: "shared" パネルをそのホストに移行
 * - 2台目以降の場合: そのホスト用のデフォルトパネルセットを生成
 *
 * @private
 * @param {string} hostname - 確定したホスト名
 * @param {string} [oldHost] - 旧ホスト名（IP→ホスト名移行時に指定）
 * @returns {void}
 */
function _syncPanelsForHost(hostname, oldHost) {
  if (!hostname || hostname === "shared" || hostname === PLACEHOLDER_HOSTNAME) return;

  /* IP→ホスト名移行: 旧IPベースのパネルを新ホスト名に移行する */
  if (oldHost && oldHost !== hostname) {
    renamePanelsHost(oldHost, hostname);
  }

  /* shared パネルの移行を試みる（起動時に shared で生成されている場合） */
  const migrated = migratePanelsToHost(hostname);

  /* 移行対象がなかった場合（初回起動でパネル未生成 or 2台目以降）
     → このホスト用パネルを自動生成する */
  if (migrated === 0) {
    ensureHostPanels(hostname);
  }

  /* ★ 接続確立時に per-host 状態を復元（全ホスト共通）
     handleMessage の初回ブランチでは initHost のみ復元されるが、
     2台目以降のホストはここで復元する。既に復元済みでも冪等。 */
  restoreAggregatorState(hostname);

  /* 印刷再開用データの復元（per-host） */
  const curId = Number(monitorData.machines[hostname]?.storedData?.printStartTime?.rawValue || 0) || null;
  restorePrintResume(hostname, curId);

  /* パネル生成後、processData がパネル生成前に到着済みのデータを
     新しい DOM に反映するため、全キーを dirty にマークして
     次回の aggregatorUpdate で再描画されるようにする */
  markAllKeysDirty(hostname);

  /* aggregator を即座に実行し、キャッシュ済みデータを描画する */
  restartAggregatorTimer(100);
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
 * 接続先入力欄（レガシー: destination-input / Electron: conn-modal-ip）に
 * 反映されたうえでポート `:9999` を追加したもの。
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
  // ★ リレー子モードではプリンタ直接接続をスキップ
  if (window._3dpmonRelayChild) return;

  let dest = hostOrDest || "";
  if (!dest) return;
  if (!dest.includes(":")) dest += ":9999";
  const ip = dest.split(":")[0];

  /* 再接続時に正しいホスト名キーを使うため、connectionTargets に保存済みの
     ホスト名を参照する。ホスト名が未確定（初回接続等）の場合は IP をキーにする。
     これにより、再接続時に connectionMap に IP キーの孤立エントリが生まれる問題を防ぐ。 */
  const target = _findConnectionTarget(dest);
  const host = (target?.hostname) || ip;

  // 初回接続 or まだ PLACEHOLDER の場合のみ currentHostname を切り替える。
  // 2台目以降の追加接続では currentHostname を変更しない（既存接続のデータ処理を維持）。
  //
  // ★ ホスト名未知（初回IP接続で target.hostname が空）の場合は
  //    setCurrentHostname を呼ばない。handleMessage() の初期化ブロック
  //    (restoreUnifiedStorage / restartAggregatorTimer 等) は
  //    currentHostname が null/PLACEHOLDER の状態でのみ実行されるため、
  //    ここで IP を設定してしまうと初期化パスがスキップされる。
  //    WS 応答の data.hostname を受信した時点で handleMessage() 内で
  //    setCurrentHostname(hostname) が呼ばれ初期化が実行される。
  // ★ currentHostname 未設定なら最初の接続で設定（後方互換用のグローバル値）
  if ((!currentHostname || currentHostname === PLACEHOLDER_HOSTNAME) && target?.hostname) {
    setCurrentHostname(host);
  }
  // 後方互換: wsDest にメイン接続先を保持（全ホスト共通で最後の接続先を記録）
  monitorData.appSettings.wsDest = dest;
  const state = getState(host);
  state.dest = dest;
  state.historyReceived = false;
  state.hostReadyAt = null;

  /* 接続先を永続リストに保存 */
  _addConnectionTarget(dest);

  if (state.userDisc) {
    state.reconnect = 0;
    state.userDisc = false;
  }
  if (state.reconnect >= MAX_RECONNECT) {
    pushLog(`自動接続リトライが上限(${MAX_RECONNECT})に達しました。`, "error", false, host);
    return;
  }

  state.reconnect++;
  state.state = "connecting";
  updateConnectionUI("connecting", { attempt: state.reconnect, max: MAX_RECONNECT }, host);
  updatePrinterListUI();
  pushLog(`WS接続を試みます...(試行${state.reconnect}回目/${MAX_RECONNECT}回)`, "warn", false, host);

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
  pushLog("WebSocket接続が確立しました。", "info", false, host);
  const st = getState(host);
  st.reconnect = 0;
  st.userDisc = false;

  // Heartbeat開始（30秒おき）
  startHeartbeat(st.ws, 30_000, host);

  // 接続中ホストが1台でもあれば集計ループを維持
  restartAggregatorTimer(500);
  updateConnectionUI("connected", {}, host);
  st.state = "connected";
  updatePrinterListUI();

  /* ホスト名が既知の場合（再接続等）はパネルを確保する。
     未知（IP接続の初回）の場合は handleSocketMessage での
     hostname 解決後に _syncPanelsForHost が呼ばれる。 */
  const knownTarget = _findConnectionTarget(st.dest || host);
  if (knownTarget?.hostname && knownTarget.hostname === host) {
    _syncPanelsForHost(host);
  }

  if (monitorData.hostCameraToggle[host] ?? monitorData.appSettings.cameraToggle) {
    startCameraStream(host);
  }
  // 通知抑制は handleMessage の初期化完了後に解除する（ここでは解除しない）
  // リロード直後に onopen → aggregatorUpdate の間に通知が爆発するのを防止

  // ホスト名確定後に履歴/ファイル一覧を遅延取得する（リトライ付き）
  st.historyReceived = false;
  st.hostReadyAt = null;
  st.fileReqSent = false;
  st.fileReqRetry = 0;
  st.fileInfoReceived = false;
  st.historyReqSent = false;
  st.historyReqRetry = 0;
  if (st.fetchTimer !== null) {
    clearInterval(st.fetchTimer);
  }

  // ホスト名解決を待ってから _fetchWithRetry を起動するポーリング
  st.fetchTimer = setInterval(() => {
    if (!st.ws || st.ws.readyState !== WebSocket.OPEN) {
      clearInterval(st.fetchTimer);
      st.fetchTimer = null;
      return;
    }
    const actualHost = Object.keys(connectionMap).find(
      k => connectionMap[k] === st
    );
    const hostReady = actualHost && actualHost !== PLACEHOLDER_HOSTNAME;
    if (!hostReady) return;

    // ホスト名確定 → ポーリング停止してリトライ付き取得を開始
    clearInterval(st.fetchTimer);
    st.fetchTimer = null;
    _fetchWithRetry(actualHost);
  }, 500);

}


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
    pushLog("受信: heart beat:" + event.data, "success", false, hostKey);
    return;
  }

// --- 2) タイムスタンプ更新 (lastLogTimestamp に現在時刻を反映) ---
  const now = getCurrentTimestamp();
  const tsEl = scopedById("last-log-timestamp", hostKey);
  const tsField = tsEl?.querySelector(".value");
  if (tsField) tsField.textContent = now;

// --- 3) ログ出力 (受信した JSON 生データ) ---
  pushLog("受信: " + event.data, "normal", false, hostKey);

// --- 4) JSON パース ---
  let data;
  try {
    data = JSON.parse(event.data);
  } catch (e) {
    pushLog("JSONパースエラー: " + event.data, "error", false, hostKey);
    console.warn("[ws.onmessage] JSON.parse 失敗:", event.data, e);
    return;
  }

// 5) パース結果が null またはオブジェクト以外 → 異常データとしてトラップ
  if (data === null || typeof data !== "object") {
    pushLog("非オブジェクト形式のメッセージ: " + event.data, "warn", false, hostKey);
    console.warn("[ws.onmessage] 非オブジェクト:", data);
    return;
  }

  // --- 5a) ホスト名未確定時は先に connectionMap のキーを解決 --------
  // ★ setCurrentHostname はここでは呼ばない。
  //    handleMessage() の初期化ブロック (line 151) が
  //    currentHostname === null/PLACEHOLDER を条件としているため、
  //    ここで設定すると初期化（restoreUnifiedStorage/restartAggregatorTimer等）
  //    がスキップされてしまう。
  //    setCurrentHostname は handleMessage() 内で呼ばれる。
// 5.5) ★ 全ホスト統一パス: 1台目も2台目も同じ処理
  try {
    // ホスト名を解決（受信データの hostname フィールドで connectionMap キーを更新）
    if (data && typeof data.hostname === "string" && data.hostname) {
      const newKey = updateConnectionHost(hostKey, data.hostname);
      if (newKey !== hostKey) {
        hostKey = newKey;
      }
    }

    let st = getState(hostKey);
    st.latest = data;

    // ★ currentHostname が未設定なら最初のホストで設定（1回だけ）
    // これは後方互換用のグローバル値であり、per-host 処理には影響しない
    if ((currentHostname === null || currentHostname === PLACEHOLDER_HOSTNAME) &&
        data?.hostname) {
      setCurrentHostname(data.hostname);
      restoreLegacyStoredData();
      cleanupLegacy();
    }

    // ★ 全ホスト共通: ensureMachineData + processData
    // processData 内の per-host 初期化ブロック (_initializedHosts) が
    // 各ホストの初回のみ aggregator復元/履歴表示/印刷再開を実行する
    const resolvedHost = data?.hostname || hostKey;
    ensureMachineData(resolvedHost);
    processData(data, resolvedHost);
  } catch (e) {
    pushLog("handleMessage処理中にエラーが発生: " + e.message, "error", false, hostKey);
    console.error("[ws.onmessage] handleMessage処理エラー:", e);
  }
  // ホスト名が有効かどうか判定（PLACEHOLDER でないこと）
  const hostReady = hostKey && hostKey !== PLACEHOLDER_HOSTNAME;
  // 共通ベース URL（HTTP ポートは per-host または appSettings のデフォルト）
  const ip = getDeviceIp(hostKey);
  const httpPort = getHttpPort(hostKey);
  const baseUrl = `http://${ip}`;

// 6) 印刷履歴情報の保存・再描画
  try {
    // 印刷履歴の再取得・保存・レンダリング は各モジュールで行われています
    // （dashboard_printManager.js 側で実装）
    if (hostReady && Array.isArray(data.historyList)) {
      pushLog("historyList を受信しました", "info", false, hostKey);
      const baseUrlHttp = `http://${ip}:${httpPort}`;
      printManager.updateHistoryList(data.historyList, baseUrlHttp, "print-current-container", hostKey);
      const s = getState(hostKey);
      s.historyReceived = true;
    }
    if (hostReady && Array.isArray(data.elapseVideoList)) {
      pushLog("elapseVideoList を受信しました", "info", false, hostKey);
      const baseUrlHttp = `http://${ip}:${httpPort}`;
      printManager.updateVideoList(data.elapseVideoList, baseUrlHttp, hostKey);
    }
  } catch (e) {
    pushLog("印刷履歴処理中にエラーが発生: " + e.message, "error", false, hostKey);
    console.error("[ws.onmessage] 印刷履歴処理エラー:", e);
  }

// 7) ファイル一覧の保存・再描画
  try {
    if (hostReady && data.retGcodeFileInfo) {
      pushLog("retGcodeFileInfo を受信しました", "info", false, hostKey);
      const baseUrlHttp = `http://${ip}:${httpPort}`;
      /* キャッシュ: パネル未生成時でも後から initHistoryPanel で描画可能にする */
      const machine = monitorData.machines[hostKey];
      if (machine) machine._cachedFileInfo = data.retGcodeFileInfo;
      printManager.renderFileList(data.retGcodeFileInfo, baseUrlHttp, hostKey);
      /* ファイル一覧受信完了フラグ → reqHistory 送出を許可する */
      const stFile = getState(hostKey);
      stFile.fileInfoReceived = true;
    }
  } catch (e) {
    pushLog("印刷履歴処理中にエラーが発生: " + e.message, "error", false, hostKey);
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
  pushLog(msg, "error", false, host);
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
  pushLog("WebSocket接続が閉じられました。", "warn", false, host);
 // 切断直後は該当ホストの通知を抑制する（他ホストには影響しない）
  setNotificationSuppressed(true, host);
  const st = getState(host);

  // ホスト名待ちポーリングが残っていれば解除
  if (st.fetchTimer !== null) {
    clearInterval(st.fetchTimer);
    st.fetchTimer = null;
  }
  st.hostReadyAt = null;
  st.historyReceived = false;
  st.fileReqSent = false;
  st.fileReqRetry = 0;
  st.fileInfoReceived = false;
  st.historyReqSent = false;
  st.historyReqRetry = 0;
  st._historyReqAt = null;
  st._fileReqAt = null;

  // Heartbeat停止...
  stopHeartbeat(host);             // ハートビート停止

  // 接続中ホストが0になった場合のみ集計ループ停止
  const remainingConnected = Object.values(connectionMap).some(
    s => s && s.ws && s.ws.readyState === WebSocket.OPEN && s !== getState(host)
  );
  if (!remainingConnected) {
    stopAggregatorTimer();
  }

  // 明示的にユーザが「切断」ボタンを押した場合
  if (st.userDisc) {
    st.userDisc  = false;
    st.state = "disconnected";
    stopCameraStream(host);
    updateConnectionUI("disconnected", {}, host);
    updatePrinterListUI();
    pushLog("ユーザー操作により切断されました。", "info", false, host);
    return;
  }

  // 自動再接続が上限に達した場合
  if (st.reconnect >= MAX_RECONNECT) {
    stopCameraStream(host);
    updateConnectionUI("disconnected", {}, host);
    st.state = "disconnected";
    updatePrinterListUI();
    pushLog(`自動接続リトライが上限(${MAX_RECONNECT})に達しました。`, "error", false, host);
    return;
  }

  // 再接続待機 UI 表示＆ログ
  const delayMs = 2000 * Math.pow(2, st.reconnect - 1);
  const delaySec = Math.ceil(delayMs / 1000);
  const nextAttempt = st.reconnect + 1;

  // ① ログ出力
  pushLog(`Ws接続が切断されました。${delaySec}秒後に再試行します...（${nextAttempt}/${MAX_RECONNECT}）`, "warn", false, host);

  // ② 待機UIに切り替え
  updateConnectionUI("waiting", {
    attempt: nextAttempt,
    max: MAX_RECONNECT,
    wait: delaySec
  }, host);
  st.state = "waiting";
  updatePrinterListUI();
  
  // ③ 既存カウントダウンタイマーがあればクリア（競合防止）
  if (countdownTimers[host]) {
    clearInterval(countdownTimers[host]);
    countdownTimers[host] = null;
  }

  // ④ カウントダウンタイマー開始
  let remaining = delaySec;
  countdownTimers[host] = setInterval(() => {
    remaining--;
    if (remaining > 0) {
      updateConnectionUI("waiting", {
        attempt: nextAttempt,
        max: MAX_RECONNECT,
        wait: remaining
      }, host);
    } else {
      clearInterval(countdownTimers[host]);
      countdownTimers[host] = null;
    }
  }, 1000);

  // ⑤ 既存再接続タイマーがあればクリア
  if (st.retryTimer) clearTimeout(st.retryTimer);

  // ⑥ 再接続本体
  st.retryTimer = setTimeout(() => {
    if (countdownTimers[host]) {
      clearInterval(countdownTimers[host]);
      countdownTimers[host] = null;
    }
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
export function startHeartbeat(socket, intervalMs = 30_000, host) {
  const st = getState(host);
  st.ws = socket;
  if (st.hbInterval !== null) {
    clearInterval(st.hbInterval);
  }
  st.hbInterval = setInterval(() => {
    if (st.ws && st.ws.readyState === WebSocket.OPEN) {
      const payload = {
        ModeCode: "heart_beat",
        msg: getCurrentTimestamp()
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
export function stopHeartbeat(host) {
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
export function disconnectWs(host) {
  const st = getState(host);
  st.userDisc = true;

  // pending な自動再接続タイマーをキャンセル
  if (st.retryTimer) {
    clearTimeout(st.retryTimer);
    st.retryTimer = null;
  }

  // カウントダウンタイマーもキャンセル
  if (countdownTimers[host]) {
    clearInterval(countdownTimers[host]);
    countdownTimers[host] = null;
  }

  // 接続状態なら明示的に close を発行
  if (st.ws && st.ws.readyState === WebSocket.OPEN) {
    st.ws.close();
  }

  // 再接続カウント初期化
  st.reconnect = 0;

  // 入力欄を再度書き換え可に
  // UIを切断状態に更新
  updateConnectionUI("disconnected", {}, host);
  st.state = "disconnected";
  updatePrinterListUI();
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
export function sendCommand(method, params = {}, host) {
  // ★ リレー子モード: 親経由でコマンド送信
  if (window._3dpmonRelayChild) {
    import("./dashboard_client_sync.js").then(m => m.sendRelayCommand(method, params, host));
    return;
  }
  const st = resolveActiveState(host);
  if (!st.ws || st.ws.readyState !== WebSocket.OPEN) {
    const now = Date.now();
    if (now - lastWsAlertTime > 1000) {
      lastWsAlertTime = now;
      const ts = getCurrentTimestamp();
      const hostName = host === PLACEHOLDER_HOSTNAME ? "(placeholder)" : host;
      const detail = st.ws ? `readyState=${st.ws.readyState}` : "ws=null";
      const msg = `[${hostName}] WebSocket が接続されていません @ ${ts} (${detail})`;
      showAlert(msg, "error", false, host);
    }
    return Promise.reject(new Error("WebSocket not connected"));
  }
  // id はキャッシュバスティング用。機器は id を無視し、
  // 応答に id を含めないため、id による応答照合は行わない。
  const id = `${method}_${Date.now()}`;
  const payload = { id, method, params };
  const json = JSON.stringify(payload);
  pushLog(`送信: ${json}`, "send", false, host);
  try {
    st.ws.send(json);
  } catch (e) {
    return Promise.reject(e);
  }
  // 機器は WS データメッセージとして応答を返す。
  // 応答の処理は handleMessage / processData で行われるため、
  // sendCommand はファイア・アンド・フォーゲットで resolve する。
  return Promise.resolve(null);
}

/**
 * G-code コマンドを送信します。
 *
 * @param {string} gcode - 送信する G-code 文字列
 * @param {string} [host] - 接続先ホスト名（省略時は最初の接続済みホスト）
 * @returns {Promise<Object>} サーバー result フィールド
 */
export function sendGcodeCommand(gcode, host) {
  const st = resolveActiveState(host);
  if (!st.ws || st.ws.readyState !== WebSocket.OPEN) {
    const now = Date.now();
    if (now - lastWsAlertTime > 1000) {
      lastWsAlertTime = now;
      const ts = getCurrentTimestamp();
      const hostName = host === PLACEHOLDER_HOSTNAME ? "(placeholder)" : host;
      const detail = st.ws ? `readyState=${st.ws.readyState}` : "ws=null";
      const msg = `[${hostName}] WebSocket が接続されていません @ ${ts} (${detail})`;
      showAlert(msg, "error", false, host);
    }
    return Promise.reject(new Error("WebSocket not connected"));
  }

  const id = `set_gcode_${Date.now()}`;
  const payload = { id, method: "set", params: { gcodeCmd: gcode } };
  const json = JSON.stringify(payload);
  pushLog(`送信: ${json}`, "send", false, host);
  try {
    st.ws.send(json);
  } catch (e) {
    return Promise.reject(e);
  }
  return Promise.resolve(null);
}

/**
 * 接続 UI の表示状態を一元管理します。
 * - "connecting": 接続試行中 → 「接続中…(n/m)」
 * - "waiting":    再接続待機中 → 「接続中…(n/m) リトライ待ち(あと x 秒)」
 * - "connected":  接続済み     → ホスト名表示・切断ボタン
 * - "disconnected":切断中     → 入力欄再表示・接続ボタン
 *
 * NOTE: この関数はレガシー接続 UI 要素（3dp_monitor.html 内の
 * destination-input, destination-display, connection-status,
 * connect-button, disconnect-button, audio-muted-tag）を対象とする。
 * Electron パネルシステムでは接続モーダル（conn-modal-*）が使われるため、
 * これらの要素は存在しない場合がある。各要素アクセスにはnullガードを適用。
 *
 * @param {"connecting"|"waiting"|"connected"|"disconnected"} state
 *   接続状態を指定
 * @param {{attempt?: number, max?: number, wait?: number}} [opt={}]
 *   connecting/waiting 時に使用する { attempt, max, wait }
 * @param {string} [host] - 対象ホスト名
 */
export function updateConnectionUI(state, opt = {}, host) {
  // ホスト指定が無い場合はプリンタ一覧のみ更新
  if (!host) {
    updatePrinterListUI();
    return;
  }

  /* レガシー接続 UI 要素（Electron モードでは存在しない場合がある） */
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
 * select 要素、トップメニューバー、接続モーダル内リストを再構築します。
 * 保存済み（未接続）の接続先も表示します。
 *
 * @function updatePrinterListUI
 * @returns {void}
 */
/** プリンタ一覧の定期更新タイマー ID */
let _printerListTimer = null;

/** 接続先リストの再描画をブロックするフラグ (色ピッカー操作中等) */
let _printerListUpdateBlocked = false;

export function updatePrinterListUI() {
  const sel  = document.getElementById("printer-select");
  const list = document.getElementById("printer-status-list");

  /* トップメニューバー用要素（パネルモード） */
  const topDot   = document.getElementById("top-status-dot");
  const topLabel = document.getElementById("top-conn-label");
  const topList  = document.getElementById("top-printer-list");
  const connList = document.getElementById("conn-modal-printer-list");

  const hosts = Object.keys(connectionMap).filter(h => h !== PLACEHOLDER_HOSTNAME);

  // セレクトボックス更新（従来UI）
  if (sel) {
    sel.innerHTML = hosts.map(h => `<option value="${h}">${h}</option>`).join("");
    sel.value = hosts.includes(currentHostname) ? currentHostname : "";
  }

  // ── プリンタ情報をビルド（共通データ） ──
  /**
   * @type {Array<{host:string, stateIcon:string, line1:string, line2:string, state:string}>}
   */
  const printerInfos = hosts.map(h => {
    const st = connectionMap[h];
    const machine = monitorData.machines[h];

    // 接続状態アイコン
    const stateIcon = st.state === "connected" ? "\u2705"
                    : st.state === "connecting" ? "\u23F3"
                    : st.state === "waiting" ? "\u{1F504}"
                    : "\u274C";

    // 基本情報
    let line1 = `${stateIcon} ${h}`;
    line1 += ` [${st.dest}]`;

    // データ情報
    let line2 = "";
    if (machine?.storedData) {
      const sd = machine.storedData;
      const model = sd.model?.rawValue || "";
      const nozzle = sd.nozzleTemp?.rawValue;
      const bed = sd.bedTemp0?.rawValue;
      const box = sd.boxTemp?.rawValue;
      const printState = sd.state?.rawValue;
      const progress = sd.printProgress?.rawValue;
      const hostname = sd.hostname?.rawValue || "";

      if (hostname && hostname !== h) line2 += `(${hostname}) `;
      if (model) line2 += `${model} `;
      if (nozzle != null) line2 += `N:${parseFloat(nozzle).toFixed(1)}\u2103 `;
      if (bed != null) line2 += `B:${parseFloat(bed).toFixed(1)}\u2103 `;
      if (box != null) line2 += `Box:${parseFloat(box).toFixed(0)}\u2103 `;
      if (Number(printState) === 1 && progress != null) line2 += `${progress}%`;
    } else {
      line2 = "\u30C7\u30FC\u30BF\u672A\u53D7\u4FE1";
    }

    return { host: h, stateIcon, line1, line2, state: st.state };
  });

  // ── 従来のサイドバーステータスリスト更新 ──
  if (list) {
    list.innerHTML = printerInfos.map(info => {
      return `<div class="printer-item conn-item" data-host="${info.host}">
        <div>${info.line1}</div>
        <div class="conn-item-sub">${info.line2}</div>
      </div>`;
    }).join("");

  }

  // ── トップメニューバー更新（パネルモード） ──
  if (topDot) {
    const anyConnected = printerInfos.some(i => i.state === "connected");
    const anyConnecting = printerInfos.some(i => i.state === "connecting" || i.state === "waiting");
    topDot.className = "status-dot " + (anyConnected ? "connected" : anyConnecting ? "connecting" : "disconnected");
  }
  if (topLabel) {
    const connCount = printerInfos.filter(i => i.state === "connected").length;
    topLabel.textContent = connCount > 0 ? `${connCount}\u53F0\u63A5\u7D9A\u4E2D` : "\u672A\u63A5\u7D9A";
  }
  if (topList) {
    topList.innerHTML = printerInfos.map(info => {
      const bg = info.state === "connected" ? "#555" : "#777";
      return `<span class="printer-item conn-chip" data-host="${info.host}" style="background:${bg}">${info.stateIcon} ${info.host}</span>`;
    }).join("");
  }

  // ── 接続モーダル内のプリンタリスト更新 ──
  // 色ピッカーや編集ダイアログ操作中は再描画をスキップ（ピッカーが消える問題の回避）
  if (connList && !_printerListUpdateBlocked) {
    // 接続中プリンタの表示
    let listHtml = printerInfos.map(info => {
      const st = connectionMap[info.host];
      const dest = st?.dest || info.host;
      const tgt = _findConnectionTarget(dest);
      const color = tgt?.color || "#444444";
      const whEnabled = tgt?.webhookEnabled !== false;
      const cameraPort = tgt?.cameraPort || monitorData.appSettings.cameraPort || 8080;
      const httpPort = tgt?.httpPort || monitorData.appSettings.httpPort || 80;
      return `<div class="printer-item conn-detail-item" data-host="${info.host}">
        <div class="conn-detail-row">
          <input type="color" class="conn-target-color conn-color-picker" data-dest="${dest}" value="${color}" title="パネルバー色">
          <span class="conn-detail-name">${info.line1}</span>
          <label class="conn-webhook-label" title="Webhook 通知の ON/OFF"><input type="checkbox" class="conn-target-webhook" data-dest="${dest}" ${whEnabled ? "checked" : ""}>📡</label>
          <button class="conn-target-edit conn-edit-btn" data-dest="${dest}" title="接続先設定を編集">⚙</button>
          <button class="conn-target-delete conn-delete-btn" data-dest="${dest}" data-host="${info.host}" title="切断・削除">✕</button>
        </div>
        <div class="conn-detail-sub">${info.line2} <span class="conn-ports">cam:${cameraPort} http:${httpPort}</span></div>
      </div>`;
    }).join("");

    // 保存済みだが未接続の接続先も表示（dest = IP:PORT 単位で照合）
    const connectedDests = new Set(hosts.map(h => connectionMap[h]?.dest || h));
    const savedTargets = monitorData.appSettings.connectionTargets || [];
    for (const t of savedTargets) {
      if (!connectedDests.has(t.dest)) {
        const savedColor = t.color || "#444444";
        const savedLabel = t.hostname ? ` (${t.hostname})` : "";
        listHtml += `<div class="conn-detail-item disconnected">
          <div class="conn-detail-row">
            <input type="color" class="conn-target-color conn-color-picker" data-dest="${t.dest}" value="${savedColor}" title="パネルバー色">
            <span class="conn-detail-name">⬜ ${t.dest}${savedLabel} (未接続)</span>
            <button class="conn-target-reconnect conn-reconnect-btn" data-dest="${t.dest}" title="再接続">接続</button>
            <button class="conn-target-delete conn-delete-btn" data-dest="${t.dest}" data-host="${t.hostname || ""}" title="削除">✕</button>
          </div>
        </div>`;
      }
    }

    connList.innerHTML = listHtml;

    // 削除ボタンのイベント設定（確認ダイアログ付き）
    connList.querySelectorAll(".conn-target-delete").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const dest = btn.dataset.dest;
        const host = btn.dataset.host;
        const displayName = host || dest;

        /* 確認ダイアログ */
        const ok = await showConfirmDialog({
          level: "warn",
          title: "接続先の削除",
          html: `<strong>${displayName}</strong> (${dest}) を削除しますか？<br>接続中の場合は切断され、パネルも削除されます。`,
          confirmText: "削除する",
          cancelText: "キャンセル"
        });
        if (!ok) return;

        const ip = dest.split(":")[0];

        /* 接続先設定から削除（保存済みホスト名を取得） */
        const savedHostname = _removeConnectionTarget(dest);

        /* 接続中ホストの切断・パネル削除
           connectionMap のキーは hostname（解決済み）または IP（未解決）。
           host（data-host 属性）が設定されていればそれを使い、
           なければ savedHostname → IP の順で試す。 */
        const connKey = host || savedHostname || ip;
        if (connKey && connKey !== PLACEHOLDER_HOSTNAME) {
          disconnectWs(connKey);
          removePanelsForHost(connKey);
          cleanupConnection(connKey);
        }
        /* IP でも接続中の場合（ホスト名未解決のまま切断された場合） */
        if (ip !== connKey) {
          disconnectWs(ip);
          removePanelsForHost(ip);
          cleanupConnection(ip);
        }

        /* machines のホスト名キーは削除しない。
           IP が変わっても同一ホスト名なら履歴データを引き継ぐため。
           IP キーの孤立エントリのみ除去する（害はないが不要データ）。 */
        _cleanupMachineKeys([ip]);

        // wsDest も同一IPなら除去
        if (monitorData.appSettings.wsDest?.split(":")[0] === ip) {
          monitorData.appSettings.wsDest = "";
        }
        saveUnifiedStorage();
        updatePrinterListUI();
      });
    });

    // 再接続ボタンのイベント設定
    connList.querySelectorAll(".conn-target-reconnect").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        connectWs(btn.dataset.dest);
      });
    });

    // 編集ボタン (⚙) のイベント設定
    connList.querySelectorAll(".conn-target-edit").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const dest = btn.dataset.dest;
        const tgt = _findConnectionTarget(dest);
        if (!tgt) return;
        const currentCam = tgt.cameraPort || monitorData.appSettings.cameraPort || 8080;
        const currentHttp = tgt.httpPort || monitorData.appSettings.httpPort || 80;
        const currentLabel = tgt.label || tgt.hostname || "";

        const result = await showConfirmDialog({
          level: "info",
          title: `接続先設定: ${dest}`,
          html: `
            <div class="conn-edit-grid">
              <label>表示名:</label>
              <input type="text" id="edit-label" value="${currentLabel}">
              <label>カメラポート:</label>
              <input type="number" id="edit-cam-port" value="${currentCam}" min="1" max="65535">
              <label>HTTPポート:</label>
              <input type="number" id="edit-http-port" value="${currentHttp}" min="1" max="65535">
            </div>`,
          confirmText: "保存",
          cancelText: "キャンセル"
        });
        if (!result) return;
        // showConfirmDialog から値を取得（DOM がまだ存在する場合）
        const labelEl = document.getElementById("edit-label");
        const camEl = document.getElementById("edit-cam-port");
        const httpEl = document.getElementById("edit-http-port");
        if (labelEl) tgt.label = labelEl.value;
        if (camEl) tgt.cameraPort = parseInt(camEl.value, 10) || currentCam;
        if (httpEl) tgt.httpPort = parseInt(httpEl.value, 10) || currentHttp;
        saveUnifiedStorage();
        updatePrinterListUI();
      });
    });

    // Webhook ON/OFF イベント設定
    connList.querySelectorAll(".conn-target-webhook").forEach(chk => {
      chk.addEventListener("change", (e) => {
        e.stopPropagation();
        const dest = chk.dataset.dest;
        const tgt = _findConnectionTarget(dest);
        if (tgt) {
          tgt.webhookEnabled = chk.checked;
          saveUnifiedStorage();
        }
      });
    });

    // 色変更イベント設定 (操作中は再描画をブロック)
    connList.querySelectorAll(".conn-target-color").forEach(picker => {
      picker.addEventListener("focus", () => { _printerListUpdateBlocked = true; });
      picker.addEventListener("blur", () => { _printerListUpdateBlocked = false; });
      picker.addEventListener("click", (e) => { e.stopPropagation(); });
      picker.addEventListener("input", (e) => {
        e.stopPropagation();
        const dest = picker.dataset.dest;
        const tgt = _findConnectionTarget(dest);
        if (tgt) {
          tgt.color = picker.value;
          saveUnifiedStorage();
          updateAllPanelHeaders();
        }
      });
    });
  }

  // パネルメニューのホスト一覧を同期（同一 dest の重複を排除）
  // dest（IP:PORT）単位でキーを管理し、ホスト名解決済みのキーを優先する
  const destToHost = new Map();
  for (const h of hosts) {
    const fullDest = connectionMap[h]?.dest || h;
    const prev = destToHost.get(fullDest);
    if (!prev || (/^\d+\.\d+\.\d+\.\d+/.test(prev) && !/^\d+\.\d+\.\d+\.\d+/.test(h))) {
      destToHost.set(fullDest, h);
    }
  }
  updatePanelMenuHosts([...new Set(destToHost.values())]);

  // 接続中のプリンタがある場合、定期的にリスト表示を更新する（温度等の変化を反映）
  if (hosts.some(h => connectionMap[h]?.state === "connected") && !_printerListTimer) {
    _printerListTimer = setInterval(() => {
      const connectedHosts = Object.keys(connectionMap).filter(
        h => h !== PLACEHOLDER_HOSTNAME && connectionMap[h]?.state === "connected"
      );
      if (connectedHosts.length === 0) {
        clearInterval(_printerListTimer);
        _printerListTimer = null;
        return;
      }
      updatePrinterListUI();
    }, 3000);
  }
}

/**
 * cleanupConnection:
 * 指定ホストの接続情報を完全に破棄する。
 * WebSocket を閉じ、全タイマーを停止し、connectionMap からエントリを削除する。
 * プリンタの永久切断時やメモリ節約のために使用。
 *
 * @function cleanupConnection
 * @param {string} host - 破棄するホスト名
 * @returns {boolean} クリーンアップ実行した場合 true
 */
export function cleanupConnection(host) {
  const st = connectionMap[host];
  if (!st) return false;

  // WebSocket を閉じる
  if (st.ws) {
    try {
      // onclose ハンドラが再接続を試みないよう userDisc を設定
      st.userDisc = true;
      if (st.ws.readyState === WebSocket.OPEN ||
          st.ws.readyState === WebSocket.CONNECTING) {
        st.ws.close();
      }
    } catch (e) {
      console.warn(`cleanupConnection: WebSocket close エラー (${host})`, e);
    }
    st.ws = null;
  }

  // 全タイマーを停止
  if (st.hbInterval !== null) {
    clearInterval(st.hbInterval);
    st.hbInterval = null;
  }
  if (st.fetchTimer !== null) {
    clearInterval(st.fetchTimer);
    st.fetchTimer = null;
  }
  if (st.retryTimer !== null) {
    clearTimeout(st.retryTimer);
    st.retryTimer = null;
  }
  if (countdownTimers[host]) {
    clearInterval(countdownTimers[host]);
    delete countdownTimers[host];
  }

  // バッファクリア
  st.buffer.length = 0;
  st.latest = null;

  // connectionMap から削除
  delete connectionMap[host];
  updatePrinterListUI();

  pushLog(`接続情報をクリーンアップしました: ${host}`, "info", false, host);
  return true;
}

/**
 * getConnectionMap:
 * 接続中ホスト名の一覧を返す。
 * パネルメニューなど外部モジュールからの参照用。
 *
 * @function getConnectionMap
 * @returns {string[]} 接続中ホスト名の配列
 */
export function getConnectionMap() {
  return Object.keys(connectionMap).filter(h => h !== PLACEHOLDER_HOSTNAME);
}

/**
 * _fetchWithRetry:
 * reqHistory → reqGcodeFile の順でリクエストを送出する。
 * 各リクエストは 6秒タイムアウト × 最大3回リトライ。
 * 接続直後に呼ばれる。
 *
 * @private
 * @param {string} host - ホスト名
 */
function _fetchWithRetry(host) {
  const st = connectionMap[host];
  if (!st?.ws || st.ws.readyState !== WebSocket.OPEN) return;

  const MAX_RETRY = 3;
  const TIMEOUT = 6000;

  st.historyReceived = false;
  st.historyReqRetry = 0;
  st.fileInfoReceived = false;
  st.fileReqRetry = 0;

  /**
   * 1つのリクエストを送出し、応答フラグを監視してリトライする。
   * @param {string} label - ログ表示名
   * @param {Object} params - sendCommand に渡すパラメータ
   * @param {() => boolean} isDone - 応答受信済み判定
   * @param {() => number} getRetry - 現在のリトライ回数取得
   * @param {(n: number) => void} setRetry - リトライ回数セット
   * @returns {Promise<boolean>} 受信できたら true
   */
  function attempt(label, params, isDone, getRetry, setRetry) {
    return new Promise((resolve) => {
      function tryOnce() {
        if (isDone()) { resolve(true); return; }
        if (!st.ws || st.ws.readyState !== WebSocket.OPEN) { resolve(false); return; }
        const retry = getRetry();
        if (retry >= MAX_RETRY) {
          pushLog(`[fetchRetry] ${label} ${MAX_RETRY}回リトライ後も応答なし`, "warn", false, host);
          resolve(false);
          return;
        }
        setRetry(retry + 1);
        pushLog(`[fetchRetry] ${label} 送出 (${retry + 1}/${MAX_RETRY})`, "info", false, host);
        // sendCommand ではなく直接 ws.send する。
        // プリンタは get コマンドに対して id フィールドを含まない応答を返すため、
        // sendCommand の id 照合タイムアウトが常に発火してしまう。
        // 応答は _fetchWithRetry のフラグ (isDone) で別途監視する。
        try {
          st.ws.send(JSON.stringify({ method: "get", params }));
        } catch (e) {
          pushLog(`[fetchRetry] ${label} 送信エラー: ${e.message}`, "warn", false, host);
        }
        // TIMEOUT 後に応答チェック
        setTimeout(() => {
          if (isDone()) { resolve(true); return; }
          pushLog(`[fetchRetry] ${label} タイムアウト (${getRetry()}/${MAX_RETRY})`, "warn", false, host);
          tryOnce();
        }, TIMEOUT);
      }
      tryOnce();
    });
  }

  // reqHistory → reqGcodeFileInfo の順に送出（500ms 遅延後に開始）
  setTimeout(async () => {
    await attempt(
      "reqHistory", { reqHistory: 1 },
      () => st.historyReceived,
      () => st.historyReqRetry,
      (n) => { st.historyReqRetry = n; }
    );
    await attempt(
      "reqGcodeFile", { reqGcodeFile: 1 },
      () => st.fileInfoReceived,
      () => st.fileReqRetry,
      (n) => { st.fileReqRetry = n; }
    );
  }, 500);
}

/**
 * getConnectionState:
 * 指定ホストの接続状態文字列を返す。
 *
 * @function getConnectionState
 * @param {string} host - ホスト名
 * @returns {"disconnected"|"connecting"|"connected"|"waiting"} 接続状態
 */
export function getConnectionState(host) {
  const st = connectionMap[host];
  return st?.state || "disconnected";
}

/**
 * Debug helper: treat a raw JSON string as a received WebSocket message.
 * @param {string} jsonStr - JSON text to process
 */
export function simulateReceivedJson(jsonStr, host) {
  handleSocketMessage({ data: jsonStr }, host);
}