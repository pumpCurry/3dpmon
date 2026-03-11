/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 カメラ制御モジュール
 * @file dashboard_camera_ctrl.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_camera_ctrl
 *
 * 【機能内容サマリ】
 * - ホスト別のカメラ映像ストリーム管理
 * - パネル内 <img> タグへの直接操作（IDスコーピング対応）
 * - 接続状態に応じた NO SIGNAL / CONNECTING / RETRYING UI
 * - Exponential Backoff による再接続（最大5回）
 * - 配信サービス停止時は一度だけエラー通知
 *
 * 【公開関数一覧】
 * - {@link registerCameraPanel}：カメラパネルを登録
 * - {@link unregisterCameraPanel}：カメラパネルを登録解除
 * - {@link startCameraStream}：カメラストリーム開始
 * - {@link stopCameraStream}：カメラストリーム停止
 * - {@link stopAllCameraStreams}：全ホストのカメラを停止
 * - {@link handleCameraError}：接続エラー処理（互換用）
 *
 * @version 1.390.783 (PR #366)
 * @since   1.390.193 (PR #86)
 * @lastModified 2026-03-10 23:30:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

import { monitorData } from "./dashboard_data.js";
import { getDeviceIp, getDeviceDest } from "./dashboard_connection.js";
import { pushLog }                  from "./dashboard_log_util.js";
import { notificationManager }      from "./dashboard_notification_manager.js";

// ─── 定数 ────────────────────────────────────────────────────
/** @constant {number} 最大再接続試行回数 */
const CAMERA_MAX_RETRY      = 5;
/** @constant {number} 基本リトライ間隔 (ms) */
const DEFAULT_RETRY_DELAY   = 2000;
/** @constant {number} デフォルトのストリーム提供ポート */
const DEFAULT_STREAM_PORT   = 8080;

// ─── ホスト別カメラ状態レジストリ ─────────────────────────────
/**
 * ホスト名をキーとするカメラパネル登録情報。
 * パネル初期化時に registerCameraPanel で登録し、
 * パネル破棄時に unregisterCameraPanel で解除する。
 *
 * @typedef {Object} CameraPanelEntry
 * @property {HTMLImageElement} img       - パネル内の <img> 要素
 * @property {HTMLElement}      body      - パネル本体要素（.panel-body）
 * @property {HTMLInputElement|null} toggle - ヘッダー内のトグルスイッチ
 * @property {number}   attempts          - リトライ試行回数
 * @property {number|null} retryTimeout   - setTimeout ID
 * @property {number|null} countdownTimer - setInterval ID
 * @property {boolean}  firstConnected    - 初回接続完了フラグ
 * @property {boolean}  userStopped       - ユーザによる明示停止フラグ
 * @property {boolean}  serviceNotified   - サービス停止通知済みフラグ
 */

/**
 * ホスト名 → CameraPanelEntry のマップ
 * @type {Map<string, CameraPanelEntry>}
 */
const cameraRegistry = new Map();

/* ─── パネル登録 API ─── */

/**
 * カメラパネルをレジストリに登録する。
 * パネル初期化（initCameraPanel）から呼び出す。
 *
 * @function registerCameraPanel
 * @param {string} hostname          - ホスト名
 * @param {HTMLImageElement} img     - パネル内の <img> 要素
 * @param {HTMLElement} body         - パネル本体要素
 * @param {HTMLInputElement|null} toggle - ヘッダーのトグルスイッチ
 * @returns {void}
 */
export function registerCameraPanel(hostname, img, body, toggle) {
  /* 既存エントリがあればタイマーをクリーンアップ */
  const prev = cameraRegistry.get(hostname);
  if (prev) _cancelTimers(prev);

  cameraRegistry.set(hostname, {
    hostname,
    img,
    body,
    toggle,
    attempts: 0,
    retryTimeout: null,
    countdownTimer: null,
    firstConnected: false,
    userStopped: false,
    serviceNotified: false
  });
}

/**
 * カメラパネルをレジストリから解除する。
 * パネル破棄時に呼び出す。ストリームも停止する。
 *
 * @function unregisterCameraPanel
 * @param {string} hostname - ホスト名
 * @returns {void}
 */
export function unregisterCameraPanel(hostname) {
  const entry = cameraRegistry.get(hostname);
  if (!entry) return;
  _stopEntry(entry);
  cameraRegistry.delete(hostname);
}

/* ─── ストリーム制御 API ─── */

/**
 * 指定ホストのカメラストリームを開始する。
 * レジストリに登録済みのパネルが無い場合は何もしない。
 *
 * @function startCameraStream
 * @param {string} [hostname] - ホスト名
 * @returns {void}
 */
export function startCameraStream(hostname) {
  const host = hostname;
  if (!host) return;

  const entry = cameraRegistry.get(host);
  if (!entry) {
    /* レジストリ未登録（パネルが閉じている等）→ 何もしない */
    return;
  }

  entry.userStopped = false;
  entry.serviceNotified = false;
  entry.firstConnected = false;

  /* cameraToggle が OFF ならストリームを開始せず切断表示にする */
  if (!monitorData.appSettings.cameraToggle) {
    _updateUI(entry, "disconnected");
    return;
  }

  /* デバイスIP解決 */
  const deviceIp = getDeviceIp(host);
  const ip = deviceIp || monitorData.appSettings.wsDest?.split(":")[0];
  if (!ip) {
    _updateUI(entry, "disconnected");
    return;
  }

  /* カメラポート解決: per-host（connectionTarget.cameraPort）→ グローバル設定 → デフォルト
     connectionTarget の検索は getDeviceDest 経由で dest を取得して行う */
  const dest = getDeviceDest(host);
  const targets = monitorData.appSettings.connectionTargets || [];
  const tgt = targets.find(t => t.dest === dest) || targets.find(t => t.hostname === host);
  const port = tgt?.cameraPort || monitorData.appSettings.cameraPort || DEFAULT_STREAM_PORT;

  entry.attempts = 0;
  entry.cameraPort = port;
  _cancelTimers(entry);
  _connectStream(entry, ip.split(":")[0]);
}

/**
 * 指定ホストのカメラストリームを停止する。
 * ユーザ操作による停止であることをフラグで記録し、自動リトライを防止する。
 *
 * @function stopCameraStream
 * @param {string} [hostname] - ホスト名
 * @returns {void}
 */
export function stopCameraStream(hostname) {
  const host = hostname;
  if (!host) return;

  const entry = cameraRegistry.get(host);
  if (!entry) return;

  entry.userStopped = true;
  _stopEntry(entry);
  _updateUI(entry, "disconnected");
  pushLog(`カメラストリーム停止 (${host})`, "info", false, host);
  notificationManager.notify("cameraConnectionStopped", { hostname: host });
}

/**
 * 全ホストのカメラストリームを停止する。
 *
 * @function stopAllCameraStreams
 * @returns {void}
 */
export function stopAllCameraStreams() {
  for (const [, entry] of cameraRegistry) {
    entry.userStopped = true;
    _stopEntry(entry);
    _updateUI(entry, "disconnected");
  }
}

/**
 * 旧API互換エントリポイント。
 *
 * @function handleCameraError
 * @returns {void}
 */
export function handleCameraError(hostname) {
  if (!hostname) return;
  const entry = cameraRegistry.get(hostname);
  if (entry) _updateUI(entry, "disconnected");
  pushLog("カメラ映像の読み込みエラー", "error", false, hostname);
}

/* ─── 内部ヘルパー ─── */

/**
 * タイマーとイベントハンドラをクリアする。
 *
 * @private
 * @param {CameraPanelEntry} entry
 * @returns {void}
 */
function _cancelTimers(entry) {
  if (entry.img) {
    entry.img.onload = null;
    entry.img.onerror = null;
  }
  if (entry.retryTimeout != null) {
    clearTimeout(entry.retryTimeout);
    entry.retryTimeout = null;
  }
  if (entry.countdownTimer != null) {
    clearInterval(entry.countdownTimer);
    entry.countdownTimer = null;
  }
}

/**
 * ストリームを停止しタイマーをクリアする（UI更新はしない）。
 *
 * @private
 * @param {CameraPanelEntry} entry
 * @returns {void}
 */
function _stopEntry(entry) {
  _cancelTimers(entry);
  entry.attempts = 0;
  if (entry.img) {
    entry.img.src = "";
    entry.img.classList.add("off");
  }
}

/**
 * ストリーム配信サービスが停止しているか判定する。
 *
 * @private
 * @param {string} host - IPアドレス
 * @returns {Promise<boolean>}
 */
async function _isServiceDown(host, port) {
  port = port || monitorData.appSettings.cameraPort || DEFAULT_STREAM_PORT;
  try {
    await fetch(`http://${host}:${port}/`, { method: "GET", mode: "no-cors" });
    return false;
  } catch {
    return true;
  }
}

/**
 * <img> の src を設定してストリームを開始する。
 * onload/onerror でリトライを制御する。
 *
 * @private
 * @param {CameraPanelEntry} entry
 * @param {string} host - IPアドレス（ポートなし）
 * @returns {void}
 */
function _connectStream(entry, host) {
  if (entry.userStopped) return;

  /* リトライ上限チェック */
  if (entry.attempts >= CAMERA_MAX_RETRY) {
    entry.userStopped = true;
    _cancelTimers(entry);
    _updateUI(entry, "disconnected");
    pushLog(`カメラ自動リトライ上限(${CAMERA_MAX_RETRY})に達しました`, "error", false, entry.hostname);
    notificationManager.notify("cameraConnectionFailed", { hostname: entry.hostname });
    return;
  }

  entry.attempts++;
  _updateUI(entry, "connecting", {
    attempt: entry.attempts,
    max: CAMERA_MAX_RETRY
  });
  pushLog(`カメラストリーム接続試行 (${entry.attempts}/${CAMERA_MAX_RETRY})`, "info", false, entry.hostname);

  const delayMs = DEFAULT_RETRY_DELAY * Math.pow(2, entry.attempts - 1);
  const waitSec = Math.ceil(delayMs / 1000);
  const port = entry.cameraPort || monitorData.appSettings.cameraPort || DEFAULT_STREAM_PORT;
  const url = `http://${host}:${port}/?action=stream`;

  _cancelTimers(entry);

  /* 読み込み成功 */
  entry.img.onload = () => {
    if (entry.userStopped) return;

    _cancelTimers(entry);

    if (!entry.firstConnected) {
      entry.attempts = 0;
      entry.firstConnected = true;
      _updateUI(entry, "connected");
      pushLog("カメラ接続成功", "success", false, entry.hostname);
      notificationManager.notify("cameraConnected", { hostname: entry.hostname });
    } else if (entry.attempts > 0) {
      entry.attempts = 0;
      _updateUI(entry, "connected");
      pushLog("カメラ再接続成功", "info", false, entry.hostname);
    }
  };

  /* 読み込みエラー */
  entry.img.onerror = async () => {
    if (entry.userStopped) return;

    /* サービス停止チェック */
    if (!entry.serviceNotified && await _isServiceDown(host, port)) {
      entry.serviceNotified = true;
      _updateUI(entry, "disconnected");
      pushLog("機器側の動画配信サービスが異常停止しています", "error", false, entry.hostname);
      notificationManager.notify("cameraServiceStopped", { hostname: entry.hostname });
      return;
    }

    /* 通常の再試行ロジック */
    _updateUI(entry, "retrying", {
      attempt: entry.attempts + 1,
      max: CAMERA_MAX_RETRY,
      wait: waitSec
    });
    pushLog(`カメラ切断検知 (${entry.attempts}/${CAMERA_MAX_RETRY})`, "warn", false, entry.hostname);

    /* カウントダウン表示 */
    let remaining = waitSec;
    entry.countdownTimer = setInterval(() => {
      remaining--;
      if (remaining > 0) {
        _updateUI(entry, "retrying", {
          attempt: entry.attempts + 1,
          max: CAMERA_MAX_RETRY,
          wait: remaining
        });
      } else {
        clearInterval(entry.countdownTimer);
        entry.countdownTimer = null;
      }
    }, 1000);

    /* リトライスケジュール */
    entry.retryTimeout = setTimeout(() => {
      if (entry.userStopped) return;
      entry.img.src = "";
      _connectStream(entry, host);
    }, delayMs);
  };

  /* ストリーム開始 */
  entry.img.src = url;
  entry.img.classList.remove("off");
}

/**
 * パネル内の UI 要素を状態に応じて更新する。
 * パネルの body 内を querySelector で検索するため、IDスコーピングに依存しない。
 *
 * @private
 * @param {CameraPanelEntry} entry
 * @param {"disconnected"|"connecting"|"retrying"|"connected"} state
 * @param {{attempt?:number, max?:number, wait?:number}} [opt={}]
 * @returns {void}
 */
function _updateUI(entry, state, opt = {}) {
  const { body, img } = entry;
  if (!body) return;

  /* パネル内の UI 要素を body 起点で検索（IDスコーピング非依存） */
  const noSignal     = body.querySelector(".no-signal");
  const noSignalMain = noSignal?.querySelector(".no-signal-main");
  const statusBox    = body.querySelector(".camera-status");
  const labelEl      = statusBox?.querySelector("[id$='camera-status-label']")
                    || statusBox?.querySelector(".camera-status-label");
  const subEl        = statusBox?.querySelector("[id$='camera-status-sub']")
                    || statusBox?.querySelector(".camera-status-sub");
  const spinner      = statusBox?.querySelector("[id$='camera-spinner']")
                    || statusBox?.querySelector(".spinner");
  const cancelBtn    = body.querySelector(".camera-cancel-btn")
                    || body.querySelector("[id$='camera-cancel-button']");

  const show = el => el?.classList.remove("hidden");
  const hide = el => el?.classList.add("hidden");

  switch (state) {
    case "disconnected":
      if (noSignalMain) noSignalMain.textContent = "- NO SIGNAL -";
      if (labelEl) labelEl.textContent = "";
      if (subEl) subEl.textContent = "";
      img?.classList.add("off");
      statusBox?.classList.add("hidden");
      show(noSignal);
      hide(spinner);
      show(cancelBtn);
      break;

    case "connecting":
      if (noSignalMain) noSignalMain.textContent = "... CONNECTING ...";
      if (labelEl) labelEl.textContent = "接続中...";
      if (subEl) subEl.textContent = `(${opt.attempt || 0}/${opt.max || CAMERA_MAX_RETRY})`;
      img?.classList.add("off");
      statusBox?.classList.remove("hidden");
      show(noSignal);
      show(spinner);
      show(cancelBtn);
      break;

    case "retrying":
      if (noSignalMain) noSignalMain.textContent = "- SIGNAL LOST -";
      if (labelEl) labelEl.textContent = "再接続待機";
      if (subEl) subEl.textContent = `再試行まで ${opt.wait || 0} 秒`;
      img?.classList.add("off");
      statusBox?.classList.remove("hidden");
      show(noSignal);
      show(spinner);
      show(cancelBtn);
      break;

    case "connected":
      if (noSignalMain) noSignalMain.textContent = "- NO SIGNAL -";
      if (labelEl) labelEl.textContent = "";
      if (subEl) subEl.textContent = "";
      img?.classList.remove("off");
      statusBox?.classList.add("hidden");
      hide(noSignal);
      hide(spinner);
      hide(cancelBtn);
      break;
  }

  /* トグルスイッチの状態をカメラ設定に同期 */
  if (entry.toggle) {
    entry.toggle.checked = !!monitorData.appSettings.cameraToggle;
  }
}
