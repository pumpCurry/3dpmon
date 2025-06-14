/**
 * @fileoverview
 * dashboard_storage.js (v1.331)
 *
 * - initializeDashboard(): ダッシュボード初期化
 * - restorePrintResume(): 印刷再開用データ復元
 * - persistPrintResume(): 印刷再開用データ永続化
 */

"use strict";

import {
  restoreUnifiedStorage,
  restoreLegacyStoredData,
  cleanupLegacy,
  saveUnifiedStorage
} from "./dashboard_storage.js";
import {
  setCurrentHostname,
  PLACEHOLDER_HOSTNAME,
  currentHostname,
  monitorData,
  setStoredData
} from "./dashboard_data.js";
import {
  restoreXYPreviewState,
  initXYPreview,
  setFlatView,
  setTilt45View,
  setObliqueView,
  toggleZSpin
} from "./dashboard_stage_preview.js";
import {
  initLogAutoScroll,
  initLogRenderer,
  logManager,
  flushNotificationLogsToDom,
  pushLog
} from "./dashboard_log_util.js";
import { updateConnectionUI } from "./dashboard_connection.js";
import {
  startCameraStream,
  stopCameraStream
} from "./dashboard_camera_ctrl.js";
import {
  initTemperatureGraph,
  updateTemperatureGraphFromStoredData
} from "./dashboard_chart.js";
import { FileManager } from "./dashboard_filemanager.js";
import { createFilamentPreview } from "./dashboard_filament_view.js";
import * as printManager from "./dashboard_printManager.js";
import {
  copyLogsToClipboard,
  copyStoredDataToClipboard
} from "./dashboard_utils.js";
import { notificationManager } from "./dashboard_notification_manager.js";
import { persistAggregatorState,stopAggregatorTimer } from "./dashboard_aggregator.js";
import { showAlert } from "./dashboard_notification_manager.js";
import { initSendRawJson, initTestRawJson } from "./dashboard_send_command.js";

let filamentPreview = null;
/**
 * @fileoverview
 * ダッシュボードを初期化します。
 *
 * @param {object} hooks
 * @param {() => void} hooks.onConnect                     接続開始時に呼び出す
 * @param {() => void} hooks.onDisconnect                  切断時に呼び出す
 * @param {() => void} hooks.onCameraError                 カメラエラー時に呼び出す
 * @param {(connected: boolean) => void} hooks.onConnectionStateChange
 *                                                        接続状態変化時に呼び出す
 * @param {(data: any) => void} hooks.onMessage            メッセージ受信時に呼び出す
 * @param {object} hooks.notificationManager               通知マネージャ
 */
export function initializeDashboard({
  onConnect,
  onDisconnect,
  onCameraError,
  onConnectionStateChange,
  onMessage,
  notificationManager
}) {
  // (1) ストレージ復元／マイグレーション
  restoreLegacyStoredData();
  cleanupLegacy();
  restoreUnifiedStorage();

  // (2) ホスト未定義ならプレースホルダ設定
  if (!currentHostname) {
    setCurrentHostname(PLACEHOLDER_HOSTNAME);
  }

  // (3) プレビュー復元＆初期化
  restoreXYPreviewState();
  initXYPreview();
  const fpMount = document.getElementById("filament-preview");
  if (fpMount) {
    const machine = monitorData.machines[currentHostname] || {};
    const opts = {
      filamentDiameter:      machine.settings?.filamentDiameterMm ?? 1.75,
      filamentTotalLength:   machine.settings?.filamentTotalLengthMm ?? 330000,
      filamentCurrentLength: machine.settings?.filamentRemainingMm ?? 0,
      filamentColor:         machine.settings?.filamentColor ?? "#22C55E",
      reelOuterDiameter:     200,
      reelThickness:         68,
      reelWindingInnerDiameter: 95,
      reelCenterHoleDiameter: 54
    };
    filamentPreview = createFilamentPreview(fpMount, opts);
    window.filamentPreview = filamentPreview;
  }

  // ステージ回転ボタン
  document.getElementById("btn-stage-flat")?.addEventListener("click", setFlatView);
  document.getElementById("btn-stage-45")?.addEventListener("click", setTilt45View);
  document.getElementById("btn-stage-65-72")?.addEventListener("click", setObliqueView);
  document.getElementById("btn-stage-spin")?.addEventListener("click", toggleZSpin);

  // (4) ログ描画・自動スクロール設定
  const logBox = document.getElementById("log");
  initLogAutoScroll(logBox);
  initLogRenderer(logBox);

  // (5) 接続／切断ボタンバインド
  const ipInput    = document.getElementById("destination-input");
  const acb        = document.getElementById("auto-connect-toggle");
  const camToggle  = document.getElementById("camera-toggle-title");
  const btnConnect = document.getElementById("connect-button");
  const btnDisc    = document.getElementById("disconnect-button");


  // ここで monitorData.appSettings から UI に反映
  ipInput.value     = monitorData.appSettings.wsDest        || "";
  acb.checked       = monitorData.appSettings.autoConnect;
  camToggle.checked = monitorData.appSettings.cameraToggle;


  // 接続ボタンクリック → IPチェック→保存→接続
  btnConnect?.addEventListener("click", () => {
    const ip = ipInput.value.trim();
    if (!ip) {
      showAlert("接続先のIPアドレスを設定し、接続を押してください", "warn");
      return;
    }
    // 設定に反映して永続化
    monitorData.appSettings.wsDest = ip;
    saveUnifiedStorage();

    onConnect();  // connectWs() を呼び出す
  });

  // 切断
  btnDisc?.addEventListener("click", onDisconnect);

  // (6) ログコピー・クリア操作
  document.getElementById("copy-all-notification-button")
    ?.addEventListener("click", e => copyLogsToClipboard(logManager.getNotifications(), null, e.currentTarget));
  document.getElementById("copy-last-50-notification-button")
    ?.addEventListener("click", e => copyLogsToClipboard(logManager.getNotifications(), 50, e.currentTarget));
  document.getElementById("clear-notification-logs-button")
    ?.addEventListener("click", () => {
      logManager.clear();
      flushNotificationLogsToDom();
    });
  document.getElementById("copy-all-button")
    ?.addEventListener("click", e => copyLogsToClipboard(logManager.getAll(), null, e.currentTarget));
  document.getElementById("copy-last-50-button")
    ?.addEventListener("click", e => copyLogsToClipboard(logManager.getAll(), 50, e.currentTarget));
  document.getElementById("copy-storeddata-button")
    ?.addEventListener("click", copyStoredDataToClipboard);

  // (7) カメラトグル制御
  camToggle.addEventListener("change", () => {
    monitorData.appSettings.cameraToggle = camToggle.checked;
    saveUnifiedStorage();
    if (camToggle.checked) startCameraStream();
    else                    stopCameraStream();
  });

  // (8) 自動接続トグル
  acb.addEventListener("change", () => {
    monitorData.appSettings.autoConnect = acb.checked;
    saveUnifiedStorage();
    pushLog(`自動接続を ${acb.checked ? "ON" : "OFF"} にしました`, "info");
    showAlert (`自動接続を ${acb.checked ? "ON" : "OFF"} にしました`, "info");
  });


  // (9) 通知設定パネル初期化
  const notifBody = document.getElementById("notification-panel-body");
  if (notifBody && notificationManager && typeof notificationManager.initSettingsUI === "function") {
    notificationManager.initSettingsUI(notifBody);
  }

  // (10) 温度グラフ初期化＆過去データ読み込み
  initTemperatureGraph();
  updateTemperatureGraphFromStoredData(
    monitorData.machines[currentHostname].storedData
  );

  // (11) ページロード時の自動接続
  // 起動時は接続先が設定されているときだけ AutoConnect
  if (monitorData.appSettings.autoConnect && monitorData.appSettings.wsDest) {
    setTimeout(onConnect, 1500);
  } else {
    showAlert("接続先欄に機器アドレスを入力して、接続を押すと監視がはじまります","warn");
  }
  
  // (12) ページロード時のカメラ起動
  if (monitorData.appSettings.cameraToggle && monitorData.appSettings.wsDest) {
    setTimeout(startCameraStream(), 1500);
  }

  // (13) ファイルマネージャ初期化
  FileManager.init();

  // (14) 印刷履歴手動リフレッシュ
  const historyBtn = document.getElementById("history-refresh-btn");
  if (historyBtn) {
    historyBtn.addEventListener("click", () => {
      document.getElementById("btn-history-list")?.click();
    });
  }

  // (14.5) コマンドパレット側ボタン → 上部クイックボタンの代理クリック
  const aliasClick = (src, dest) => {
    const s = document.getElementById(src);
    const d = document.getElementById(dest);
    if (s && d) s.addEventListener("click", () => d.click());
  };
  aliasClick("btn-stop-print-cmd",   "btn-stop-print");
  aliasClick("btn-pause-print-cmd",  "btn-pause-print");
  aliasClick("btn-resume-print-cmd", "btn-resume-print");
  aliasClick("btn-history-list-cmd","btn-history-list");
  aliasClick("btn-file-list-cmd",  "btn-file-list");

  printManager.initHistoryTabs();

  // (15) ファイルアップロード初期化
  printManager.setupUploadUI();

  // (16) 通知コンテナ初期化（notificationManager 用）
  if (!document.querySelector(".notification-container")) {
    const container = document.createElement("div");
    container.className = "notification-container";
    document.body.appendChild(container);
  }

  // (17) 初期状態（切断）の UI 表示を整える
  const cancelBtn = document.getElementById("camera-cancel-button");
  cancelBtn?.addEventListener("click", () => {
    stopCameraStream();
  });
  updateConnectionUI("disconnected");

  // (18) 時間計算用変数自動保存
  initializeAutoSave();

  // (19) JSONコマンド送信機能
  initSendRawJson();
  initTestRawJson();
}

// ────────────── 印刷再開データの復元／永続化 ──────────────

/**
 * @constant {string[]}
 * @description
 * restorePrintResume / persistPrintResume の両関数で使うキー一覧
 */

// 印刷再開用に保存したいキー
const persistKeys = [
  "preparationTime",
  "firstLayerCheckTime",
  "pauseTime",
  "completionElapsedTime",
  "actualStartTime",
  "initialLeftTime",
  "initialLeftAt",
  "predictedFinishEpoch",
  "estimatedRemainingTime",
  "tsCompleteStart",
  "printFinishTime"
];

/**
 * @function restorePrintResume
 * @description
 *  localStorage に保存された印刷再開データを読み出し、
 *  storedData の computedValue として復元します。
 */
export function restorePrintResume() {
  const host = currentHostname;
  if (!host) return;

  persistKeys.forEach(key => {
    const raw = localStorage.getItem(`pd_${host}_${key}`);
    if (raw == null) return;  // データなし

    try {
      // JSON パースして storedData にセット（rawValue／computedValue 両方に流し込む）
      const value = JSON.parse(raw);

      // 第3引数 true を渡すことで rawValue にもセットします
      setStoredData(key, value, true);

    } catch (e) {
      console.warn(`restorePrintResume: '${key}' の JSON パースに失敗しました`, e);
    }
  });
}

/**
 * @function persistPrintResume
 * @description
 *  現在の storedData から印刷再開データを抽出し、
 *  localStorage に個別保存または削除します。
 */
export function persistPrintResume() {
  const host = currentHostname;
  if (!host || !monitorData.machines[host]) return;

  const machineSD = monitorData.machines[host].storedData;
  persistKeys.forEach(key => {
    const entry = machineSD[key];
    const storageKey = `pd_${host}_${key}`;
    if (entry?.rawValue != null) {
      localStorage.setItem(storageKey, JSON.stringify(entry.rawValue));
    } else {
      // 該当データがない場合はキーを消しておく
      localStorage.removeItem(`pd_${host}_${key}`);
    }
  });
}

 
/** 自動保存間隔（ミリ秒） */
const AUTO_SAVE_INTERVAL_MS = 10 * 1000; // 10秒

/**
 * autoSaveAll:
 *   - 印刷再開用データを localStorage に保存
 *   - 統一ストレージ（dashboard_storage）を保存
 *   - aggregator の内部状態を localStorage に保存
 *
 * @returns {void}
 */
function autoSaveAll() {
  try {
    persistPrintResume();
    saveUnifiedStorage();
    persistAggregatorState();
  } catch (e) {
    console.warn("autoSaveAll: データ永続化中にエラーが発生しました", e);
  }
}

/**
 * initializeAutoSave:
 *   - DOMContentLoaded 後に一度だけ beforeunload イベントへ autoSaveAll を登録
 *   - 定期的な autoSaveAll をセット
 *
 * @returns {void}
 */
export function initializeAutoSave() {
  window.addEventListener("DOMContentLoaded", () => {
    // ページを離脱するときにも保存
    window.addEventListener("beforeunload", autoSaveAll);

    //aggrigatorを停止
    stopAggregatorTimer();

    // 一定間隔で定期保存
    setInterval(autoSaveAll, AUTO_SAVE_INTERVAL_MS);
  });

}
