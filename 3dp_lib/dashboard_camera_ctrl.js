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
 * - <img> タグによる映像ストリームの開始／停止
 * - 接続状態に応じた UI 更新
 * - Exponential Backoff による再接続
 * - 配信サービス停止時は一度だけエラー通知
 * - マルチペイン対応: ホストごとに独立した状態を管理
 *
 * 【公開関数一覧】
 * - {@link startCameraStream}：カメラストリーム開始
 * - {@link stopCameraStream}：カメラストリーム停止
 * - {@link handleCameraError}：接続エラー処理
 *
 * @version 1.400.509 (PR #303)
 * @since   1.390.193 (PR #86)
 * @lastModified 2025-07-04 10:30:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

import { monitorData }              from "./dashboard_data.js";
import { pushLog }                  from "./dashboard_log_util.js";
import { notificationManager }      from "./dashboard_notification_manager.js";

// ─── 定数 ────────────────────────────────────────────────────
const CAMERA_MAX_RETRY      = 5;     // 最大再接続試行回数
const DEFAULT_RETRY_DELAY   = 2000;  // 基本リトライ間隔 (ms)
const STREAM_PORT           = 8080;  // ストリーム提供ポート

// ─── マルチインスタンス状態管理 ────────────────────────────────

/**
 * ホストごとのカメラ接続状態
 * @type {Record<string, CameraState>}
 */
const cameraStateMap = {};

/**
 * @typedef {Object} CameraState
 * @property {HTMLImageElement|null} img
 * @property {number}    attempts
 * @property {number|null} retryTimeout
 * @property {number|null} countdownTimer
 * @property {boolean}   firstConnected
 * @property {boolean}   userRequestedDisconnect
 * @property {boolean}   serviceStoppedNotified
 * @property {number}    paneIndex
 */

/**
 * ホストに対応するカメラ状態を取得（なければ生成）
 * @param {string} hostKey
 * @returns {CameraState}
 */
function getCameraState(hostKey) {
  if (!cameraStateMap[hostKey]) {
    cameraStateMap[hostKey] = {
      img: null,
      attempts: 0,
      retryTimeout: null,
      countdownTimer: null,
      firstConnected: false,
      userRequestedDisconnect: false,
      serviceStoppedNotified: false,
      paneIndex: 1
    };
  }
  return cameraStateMap[hostKey];
}

/**
 * paneIndex に対応した要素を取得するヘルパー
 * @param {string} id
 * @param {number} paneIndex
 * @returns {HTMLElement|null}
 */
function getPaneEl(id, paneIndex) {
  return document.getElementById(`p${paneIndex}-${id}`) ||
         document.getElementById(id);
}

/**
 * _cancelCameraTimers
 * カメラ接続に関連するタイマーとハンドラをすべて解除します。
 *
 * @private
 * @param {string} hostKey
 * @returns {void}
 */
function _cancelCameraTimers(hostKey) {
  const s = cameraStateMap[hostKey];
  if (!s) return;
  if (s.img) {
    s.img.onload = null;
    s.img.onerror = null;
  }
  clearTimeout(s.retryTimeout);
  s.retryTimeout = null;
  clearInterval(s.countdownTimer);
  s.countdownTimer = null;
}

/**
 * updateCameraConnectionUI
 * カメラ接続状態に応じて UI を更新します。
 *
 * @param {"disconnected"|"connecting"|"retrying"|"connected"} state
 * @param {{attempt?:number, max?:number, wait?:number}} [opt={}]
 * @param {number} [paneIndex=1]
 */
function updateCameraConnectionUI(state, opt = {}, paneIndex = 1) {
  const labelEl   = getPaneEl("camera-status-label", paneIndex);
  const subEl     = getPaneEl("camera-status-sub",   paneIndex);
  const spinner   = getPaneEl("camera-spinner",      paneIndex);
  const paneEl    = document.getElementById(`pane-${paneIndex}`) || document.body;
  const noSignal  = paneEl.querySelector(".no-signal");
  const statusBox = paneEl.querySelector(".camera-status");
  const cancelBtn = getPaneEl("camera-cancel-button", paneIndex);
  const cameraImg = getPaneEl("camera-feed", paneIndex);
  const show = el => el?.classList.remove("hidden");
  const hide = el => el?.classList.add("hidden");

  switch (state) {
    case "disconnected":
      // 「- NO SIGNAL -」
      if (noSignal) noSignal.textContent = "- NO SIGNAL -";
      if (labelEl) labelEl.textContent = "";
      if (subEl)   subEl.textContent   = "";

      // 表示制御
      cameraImg?.classList.add("off");
      statusBox?.classList.add("hidden");
      show(noSignal);
      hide(spinner);
      show(cancelBtn);
      break;

    case "connecting":
      if (noSignal) noSignal.textContent = "... CONNECTING ...";
      if (labelEl) labelEl.textContent = "接続中...";
      if (subEl)   subEl.textContent   = `(${opt.attempt||0}/${opt.max||CAMERA_MAX_RETRY})`;

      cameraImg?.classList.add("off");
      statusBox?.classList.remove("hidden");
      show(noSignal);
      show(spinner);
      show(cancelBtn);
      break;

    case "retrying":
      if (noSignal) noSignal.textContent = "- SIGNAL LOST -";
      if (labelEl) labelEl.textContent = "再接続待機";
      if (subEl)   subEl.textContent   = `再試行まで ${opt.wait||0} 秒`;

      cameraImg?.classList.add("off");
      statusBox?.classList.remove("hidden");
      show(noSignal);
      show(spinner);
      show(cancelBtn);
      break;

    case "connected":
      if (noSignal) noSignal.textContent = "- NO SIGNAL -";
      if (labelEl) labelEl.textContent = "";
      if (subEl)   subEl.textContent   = "";

      cameraImg?.classList.remove("off");
      statusBox?.classList.add("hidden");
      hide(noSignal);
      hide(spinner);
      hide(cancelBtn);
      break;
  }
}

/**
 * isStreamServiceDown
 * ポート 8080/ への GET で ERR_CONNECTION_REFUSED が返るか試し、
 * サービス停止と判断します。
 *
 * @param {string} host
 * @returns {Promise<boolean>}
 */
async function isStreamServiceDown(host) {
  try {
    await fetch(`http://${host}:${STREAM_PORT}/`, { method: "GET", mode: "no-cors" });
    return false;
  } catch (err) {
    return true;
  }
}

/**
 * startCameraStream
 * カメラ映像ストリームを開始／再接続します。
 *
 * @export
 * @param {string} [hostOverride] - 接続先ホスト（省略時は appSettings.wsDest を使用）
 * @param {number} [paneIndex=1]  - ペイン番号
 * @returns {void}
 */
export function startCameraStream(hostOverride, paneIndex = 1) {
  const rawHost = hostOverride || monitorData.appSettings.wsDest?.split(":")[0];
  const host = rawHost || "";
  const hostKey = host || "_default";

  const s = getCameraState(hostKey);
  s.paneIndex = paneIndex;
  s.userRequestedDisconnect = false;
  s.serviceStoppedNotified  = false;
  s.firstConnected          = false;

  // OFF or ホスト未設定 なら即停止
  if (!host || !monitorData.appSettings.cameraToggle) {
    updateCameraConnectionUI("disconnected", {}, paneIndex);
    return;
  }

  s.img = getPaneEl("camera-feed", paneIndex);
  if (!s.img) {
    console.error(`[camera] #p${paneIndex}-camera-feed 要素が見つかりません`);
    updateCameraConnectionUI("disconnected", {}, paneIndex);
    return;
  }

  // カウンタ＆タイマー初期化
  s.attempts = 0;
  clearTimeout(s.retryTimeout);
  clearInterval(s.countdownTimer);

  _connectImgStream(hostKey, paneIndex);
}

/**
 * stopCameraStream
 * カメラ映像ストリームを停止します。
 *
 * @export
 * @param {string} [hostOverride]
 * @param {number} [paneIndex=1]
 * @returns {void}
 */
export function stopCameraStream(hostOverride, paneIndex = 1) {
  const rawHost = hostOverride || monitorData.appSettings.wsDest?.split(":")[0];
  const hostKey = rawHost || "_default";
  const s = cameraStateMap[hostKey];

  if (s?.img) {
    s.img.src = "";
    s.img.classList.add("off");
  }
  if (s) {
    s.userRequestedDisconnect = true;
    s.attempts = 0;
  }

  _cancelCameraTimers(hostKey);
  updateCameraConnectionUI("disconnected", {}, paneIndex);
  pushLog("カメラストリーム停止", "info");
  notificationManager.notify("cameraConnectionStopped");
}

/**
 * handleCameraError
 * 旧API互換エントリポイント。
 * 画像読み込みエラー発生時に呼び出します。
 *
 * @export
 * @param {number} [paneIndex=1]
 * @returns {void}
 */
export function handleCameraError(paneIndex = 1) {
  updateCameraConnectionUI("disconnected", {}, paneIndex);
  pushLog("カメラ映像の読み込みエラー", "error");
}

/**
 * _connectImgStream
 * 実際に <img> の src を切り替えてストリームを開始／再接続します。
 *
 * @param {string} hostKey
 * @param {number} paneIndex
 */
function _connectImgStream(hostKey, paneIndex) {
  const s = getCameraState(hostKey);
  if (s.userRequestedDisconnect) return;

  // ホストキーが "_default" の場合は実際のIPを取得
  const host = hostKey === "_default"
    ? (monitorData.appSettings.wsDest?.split(":")[0] || "")
    : hostKey;

  // リトライ上限チェック
  if (s.attempts >= CAMERA_MAX_RETRY) {
    s.userRequestedDisconnect = true;
    _cancelCameraTimers(hostKey);
    updateCameraConnectionUI("disconnected", {}, paneIndex);
    pushLog(`カメラ自動リトライ上限(${CAMERA_MAX_RETRY})に達しました`, "error");
    notificationManager.notify("cameraConnectionFailed");
    return;
  }

  s.attempts++;
  updateCameraConnectionUI("connecting", {
    attempt: s.attempts,
    max:     CAMERA_MAX_RETRY
  }, paneIndex);
  pushLog(`カメラストリーム接続試行 (${s.attempts}/${CAMERA_MAX_RETRY})`, "info");

  const delayMs = DEFAULT_RETRY_DELAY * Math.pow(2, s.attempts - 1);
  const waitSec = Math.ceil(delayMs / 1000);
  const url     = `http://${host}:${STREAM_PORT}/?action=stream`;

  // 既存タイマークリア
  clearTimeout(s.retryTimeout);
  clearInterval(s.countdownTimer);

  // 読み込み成功 (フレーム受信)
  s.img.onload = () => {
    if (s.userRequestedDisconnect) return;

    if (s.retryTimeout) {
      clearTimeout(s.retryTimeout);
      s.retryTimeout = null;
    }
    if (s.countdownTimer) {
      clearInterval(s.countdownTimer);
      s.countdownTimer = null;
    }

    if (!s.firstConnected) {
      s.attempts = 0;
      s.firstConnected = true;
      updateCameraConnectionUI("connected", {}, paneIndex);
      pushLog("カメラ接続成功", "success");
      notificationManager.notify("cameraConnected");
    } else if (s.attempts > 0) {
      s.attempts = 0;
      updateCameraConnectionUI("connected", {}, paneIndex);
      pushLog("カメラ再接続成功", "info");
    }
  };

  // 読み込みエラー
  s.img.onerror = async () => {
    if (s.userRequestedDisconnect) return;

    // サービス停止チェック
    if (!s.serviceStoppedNotified && await isStreamServiceDown(host)) {
      s.serviceStoppedNotified = true;
      updateCameraConnectionUI("disconnected", {}, paneIndex);
      pushLog("機器側の動画配信サービスが異常停止しています", "error");
      notificationManager.notify("cameraServiceStopped");
      return;
    }

    // 通常の再試行ロジック
    updateCameraConnectionUI("retrying", {
      attempt: s.attempts + 1,
      max:     CAMERA_MAX_RETRY,
      wait:    waitSec
    }, paneIndex);
    pushLog(`カメラ切断検知 (${s.attempts}/${CAMERA_MAX_RETRY})`, "warn");

    // カウントダウン表示
    let remaining = waitSec;
    s.countdownTimer = setInterval(() => {
      remaining--;
      if (remaining > 0) {
        updateCameraConnectionUI("retrying", {
          attempt: s.attempts + 1,
          max:     CAMERA_MAX_RETRY,
          wait:    remaining
        }, paneIndex);
      } else {
        clearInterval(s.countdownTimer);
      }
    }, 1000);

    // リトライスケジュール
    s.retryTimeout = setTimeout(() => {
      if (s.userRequestedDisconnect) return;
      s.img.src = "";
      _connectImgStream(hostKey, paneIndex);
    }, delayMs);
  };

  // ストリーム開始
  s.img.src = url;
  s.img.classList.remove("off");
}
