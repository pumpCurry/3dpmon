/**
 * @fileoverview
 * 3Dプリンタ監視ツール 3dpmon 用 カメラ制御モジュール
 * dashboard_camera_ctrl.js
 * (c) pumpCurry 2025
 * -----------------------------------------------------------
 * @module dashboard_camera_ctrl
 *
 * 【機能内容サマリ】
 * - <img> タグによる映像ストリームの開始／停止
 * - 接続状態に応じた UI 更新
 * - Exponential Backoff による再接続
 * - 配信サービス停止時は一度だけエラー通知
 *
 * 【公開関数一覧】
 * - {@link startCameraStream}：カメラストリーム開始
 * - {@link stopCameraStream}：カメラストリーム停止
 * - {@link handleCameraError}：接続エラー処理
 *
 * @version 1.390.193 (PR #86)
 * @since   1.390.193 (PR #86)
 */

"use strict";

import { monitorData }              from "./dashboard_data.js";
import { pushLog }                  from "./dashboard_log_util.js";
import { notificationManager }      from "./dashboard_notification_manager.js";

// ─── 定数 ────────────────────────────────────────────────────
const CAMERA_MAX_RETRY      = 5;     // 最大再接続試行回数
const DEFAULT_RETRY_DELAY   = 2000;  // 基本リトライ間隔 (ms)
const STREAM_PORT           = 8080;  // ストリーム提供ポート

// ─── 内部状態 ────────────────────────────────────────────────
let cameraImg               = null;  // <img id="camera-feed">
let cameraAttempts          = 0;     // 現在のリトライ試行回数
let cameraRetryTimeout      = null;  // setTimeout ID
let cameraCountdownTimer    = null;  // setInterval ID
let userRequestedDisconnect = false; // ユーザによる停止フラグ
let serviceStoppedNotified  = false; // サービス停止通知済みフラグ

/**
 * updateCameraConnectionUI
 * カメラ接続状態に応じて UI を更新します。
 *
 * @param {"disconnected"|"connecting"|"retrying"|"connected"} state
 * @param {{attempt?:number, max?:number, wait?:number}} [opt={}]
 */
function updateCameraConnectionUI(state, opt = {}) {
  const labelEl   = document.getElementById("camera-status-label");
  const subEl     = document.getElementById("camera-status-sub");
  const spinner   = document.getElementById("camera-spinner");
  const noSignal  = document.querySelector(".no-signal");
  const statusBox = document.querySelector(".camera-status");
  const cancelBtn = document.getElementById("camera-cancel-button");
  const show = el => el?.classList.remove("hidden");
  const hide = el => el?.classList.add("hidden");

  switch (state) {
    case "disconnected":
      // 「- NO SIGNAL -」
      if (noSignal) noSignal.textContent = "- NO SIGNAL -";
      labelEl.textContent = "";
      subEl.textContent   = "";

      // 表示制御
      cameraImg?.classList.add("off");
      statusBox?.classList.add("hidden");
      show(noSignal);
      hide(spinner);
      show(cancelBtn);
      break;

    case "connecting":
      if (noSignal) noSignal.textContent = "... CONNECTING ...";
      labelEl.textContent = "接続中...";
      subEl.textContent   = `(${opt.attempt||0}/${opt.max||CAMERA_MAX_RETRY})`;

      // 表示制御
      cameraImg?.classList.add("off");
      statusBox?.classList.remove("hidden");
      show(noSignal);
      show(spinner);
      show(cancelBtn);
      break;

    case "retrying":
      if (noSignal) noSignal.textContent = "- SIGNAL LOST -";
      labelEl.textContent = "再接続待機";
      subEl.textContent   = `再試行まで ${opt.wait||0} 秒`;

      // 表示制御
      cameraImg?.classList.add("off");
      statusBox?.classList.remove("hidden");
      show(noSignal);
      show(spinner);
      show(cancelBtn);
      break;

    case "connected":
      if (noSignal) noSignal.textContent = "- NO SIGNAL -";
      labelEl.textContent = "";
      subEl.textContent   = "";

      // 表示制御
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
 * -------------------
 * ポート 8080/ への GET で ERR_CONNECTION_REFUSED が返るか試し、
 * サービス停止と判断します。
 *
 * @param {string} host
 * @returns {Promise<boolean>}
 */
async function isStreamServiceDown(host) {
  try {
    // no-cors モードでシンプル GET
    await fetch(`http://${host}:${STREAM_PORT}/`, { method: "GET", mode: "no-cors" });
    return false;
  } catch (err) {
    // 接続拒否などはここに到達
    return true;
  }
}

/**
 * startCameraStream
 * -----------------
 * カメラ映像ストリームを開始／再接続します。
 * カメラトグル設定をチェックし、要素取得後に内部接続を開始します。
 *
 * @export
 * @returns {void}
 */
export function startCameraStream() {
  const host = monitorData.appSettings.wsDest?.split(":")[0];
  userRequestedDisconnect = false;
  serviceStoppedNotified  = false; // 毎起動時に通知フラグクリア

  // OFF or ホスト未設定 なら即停止
  if (!host || !monitorData.appSettings.cameraToggle) {
    updateCameraConnectionUI("disconnected");
    return;
  }

  cameraImg = document.getElementById("camera-feed");
  if (!cameraImg) {
    console.error("[camera] #camera-feed 要素が見つかりません");
    updateCameraConnectionUI("disconnected");
    return;
  }

  // カウンタ＆タイマー初期化
  cameraAttempts = 0;
  clearTimeout(cameraRetryTimeout);
  clearInterval(cameraCountdownTimer);

  // 実作業は内部関数へ
  _connectImgStream(host);
}

/**
 * stopCameraStream
 * カメラ映像ストリームを停止します。
 * 映像停止＆タイマークリア後、UIを「切断」に更新します。
 *
 * @export
 * @returns {void}
 */
export function stopCameraStream() {
  // ユーザ操作によるOFF
  if (cameraImg) {
    cameraImg.src = "";
    cameraImg.classList.add("off");
    cameraImg.onload  = null;
    cameraImg.onerror = null;
  }
  userRequestedDisconnect = true;
  
  // リトライカウンタ＆タイマー初期化
  cameraAttempts = 0;
  clearTimeout(cameraRetryTimeout);
  clearInterval(cameraCountdownTimer);

  // すぐに NO SIGNAL
  updateCameraConnectionUI("disconnected");
  pushLog("カメラストリーム停止", "info");
  notificationManager.notify("cameraConnectionStopped");
}


/**
 * handleCameraError
 * -----------------
 * 旧API互換エントリポイント。
 * 画像読み込みエラー発生時に呼び出します。
 *
 * @export
 * @returns {void}
 */
export function handleCameraError() {
  updateCameraConnectionUI("disconnected");
  pushLog("カメラ映像の読み込みエラー", "error");
}

/**
 * _connectImgStream
 * 実際に <img> の src を切り替えてストリームを開始／再接続します。
 *
 * @param {string} host
 */
function _connectImgStream(host) {
  if (userRequestedDisconnect) return;

  // リトライ上限チェック
  if (cameraAttempts >= CAMERA_MAX_RETRY) {
    updateCameraConnectionUI("disconnected");
    pushLog(`カメラ自動リトライ上限(${CAMERA_MAX_RETRY})に達しました`, "error");
    notificationManager.notify("cameraConnectionFailed");
    return;
  }

  cameraAttempts++;
  updateCameraConnectionUI("connecting", {
    attempt: cameraAttempts,
    max:     CAMERA_MAX_RETRY
  });
  pushLog(`カメラストリーム接続試行 (${cameraAttempts}/${CAMERA_MAX_RETRY})`, "info");

  const delayMs = DEFAULT_RETRY_DELAY * Math.pow(2, cameraAttempts - 1);
  const waitSec = Math.ceil(delayMs / 1000);
  const url     = `http://${host}:${STREAM_PORT}/?action=stream`;

  // 既存タイマークリア
  clearTimeout(cameraRetryTimeout);
  clearInterval(cameraCountdownTimer);

  // 読み込み成功
  cameraImg.onload = () => {
    if (userRequestedDisconnect) return;
    cameraAttempts = 0;
    updateCameraConnectionUI("connected");
    pushLog("カメラ接続成功", "success");
    notificationManager.notify("cameraConnected");
  };

  // 読み込みエラー
  cameraImg.onerror = async () => {
    if (userRequestedDisconnect) return;

    // サービス停止チェック
    if (!serviceStoppedNotified && await isStreamServiceDown(host)) {
      serviceStoppedNotified = true;
      updateCameraConnectionUI("disconnected");
      pushLog("機器側の動画配信サービスが異常停止しています", "error");
      notificationManager.notify("cameraServiceStopped");
      return; // リトライ打ち切り
    }

    // 通常の再試行ロジック
    updateCameraConnectionUI("retrying", {
      attempt: cameraAttempts + 1,
      max:     CAMERA_MAX_RETRY,
      wait:    waitSec
    });
    pushLog(`カメラ切断検知 (${cameraAttempts}/${CAMERA_MAX_RETRY})`, "warn");

    // カウントダウン表示
    let remaining = waitSec;
    cameraCountdownTimer = setInterval(() => {
      remaining--;
      if (remaining > 0) {
        updateCameraConnectionUI("retrying", {
          attempt: cameraAttempts + 1,
          max:     CAMERA_MAX_RETRY,
          wait:    remaining
        });
      } else {
        clearInterval(cameraCountdownTimer);
      }
    }, 1000);

    // リトライスケジュール
    cameraRetryTimeout = setTimeout(() => {
      if (userRequestedDisconnect) return;
      cameraImg.src = "";          // 強制リセット
      _connectImgStream(host);     // 再帰的に再接続
    }, delayMs);
  };

  // ストリーム開始
  cameraImg.src = url;
  cameraImg.classList.remove("off");
}
