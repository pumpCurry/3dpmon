/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 パネルライフサイクル管理モジュール
 * @file dashboard_panel_init.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_panel_init
 *
 * 【機能内容サマリ】
 * - GridStack パネル生成後の初期化関数レジストリ
 * - パネル破棄前のクリーンアップ関数レジストリ
 * - パネル種別ごとに init/destroy 関数を登録・呼び出し
 *
 * 【設計意図】
 * bootPanelSystem() が <template> からパネルをクローン生成した後、
 * イベントリスナーやコンポーネント初期化が失われる問題を解決する。
 * パネル生成直後に initializePanel() を呼ぶことで、
 * クローンされた DOM 要素に対して正しくバインドし直す。
 *
 * 【公開関数一覧】
 * - {@link registerPanelInit}：パネル初期化関数の登録
 * - {@link registerPanelDestroy}：パネル破棄関数の登録
 * - {@link initializePanel}：パネル生成後の初期化実行
 * - {@link destroyPanel}：パネル破棄前のクリーンアップ実行
 * - {@link registerAllPanelInits}：全パネル種別の初期化関数を一括登録
 *
 * @version 1.390.783 (PR #366)
 * @since   1.390.783 (PR #366)
 * @lastModified 2026-03-10 23:30:00
 * -----------------------------------------------------------
 */

"use strict";

import { initTemperatureGraph, resetTemperatureGraph } from "./dashboard_chart.js";
import {
  registerCameraPanel,
  unregisterCameraPanel,
  startCameraStream,
  stopCameraStream
} from "./dashboard_camera_ctrl.js";
import {
  restoreXYPreviewState,
  initXYPreview,
  registerPreviewPanel,
  setPrinterModel,
  setFlatView,
  setTilt45View,
  setObliqueView,
  toggleZSpin
} from "./dashboard_stage_preview.js";
import { createFilamentPreview } from "./dashboard_filament_view.js";
import { showFilamentChangeDialog } from "./dashboard_filament_change.js";
import { showFilamentManager } from "./dashboard_filament_manager.js";
import { initLogAutoScroll, initLogRenderer } from "./dashboard_log_util.js";
import { monitorData, currentHostname } from "./dashboard_data.js";
import { getDeviceIp, getHttpPort, sendCommand } from "./dashboard_connection.js";
import * as printManager from "./dashboard_printmanager.js";
import { initializeCommandPalette, initializeRateControls } from "./dashboard_send_command.js";

// ==============================
// レジストリ
// ==============================

/**
 * パネル種別 → 初期化関数のマップ
 * @type {Map<string, (panelBody: HTMLElement, hostname: string) => void>}
 */
const _initMap = new Map();

/**
 * パネル種別 → 破棄関数のマップ
 * @type {Map<string, (panelBody: HTMLElement, hostname: string) => void>}
 */
const _destroyMap = new Map();

/**
 * registerPanelInit:
 *   パネル種別に対する初期化関数を登録する。
 *   パネル生成後（GridStack へ追加後）に呼ばれる。
 *
 * @param {string} panelType - パネル種別 ID（例: "camera", "temp-graph"）
 * @param {(panelBody: HTMLElement, hostname: string) => void} initFn - 初期化関数
 */
export function registerPanelInit(panelType, initFn) {
  _initMap.set(panelType, initFn);
}

/**
 * registerPanelDestroy:
 *   パネル種別に対する破棄関数を登録する。
 *   パネル削除前に呼ばれ、タイマー停止やリスナー解除を行う。
 *
 * @param {string} panelType - パネル種別 ID
 * @param {(panelBody: HTMLElement, hostname: string) => void} destroyFn - 破棄関数
 */
export function registerPanelDestroy(panelType, destroyFn) {
  _destroyMap.set(panelType, destroyFn);
}

/**
 * initializePanel:
 *   パネル生成後に呼び出す。登録された初期化関数を実行する。
 *
 * @param {string} panelType - パネル種別 ID
 * @param {HTMLElement} panelBody - パネル本体の DOM 要素（.panel-body）
 * @param {string} hostname - 対象ホスト名（共有パネルの場合は "shared"）
 */
export function initializePanel(panelType, panelBody, hostname) {
  const fn = _initMap.get(panelType);
  if (fn) {
    try {
      fn(panelBody, hostname);
    } catch (e) {
      console.error(`[panel-init] ${panelType} の初期化に失敗:`, e);
    }
  }
}

/**
 * destroyPanel:
 *   パネル破棄前に呼び出す。登録されたクリーンアップ関数を実行する。
 *
 * @param {string} panelType - パネル種別 ID
 * @param {HTMLElement} panelBody - パネル本体の DOM 要素
 * @param {string} hostname - 対象ホスト名
 */
export function destroyPanel(panelType, panelBody, hostname) {
  const fn = _destroyMap.get(panelType);
  if (fn) {
    try {
      fn(panelBody, hostname);
    } catch (e) {
      console.error(`[panel-destroy] ${panelType} の破棄に失敗:`, e);
    }
  }
}

// ==============================
// 各パネルの初期化関数
// ==============================

/**
 * カメラパネルの初期化。
 * カメラレジストリに登録し、トグルスイッチやキャンセルボタンのイベントをバインドする。
 * ストリームの開始・停止・リトライは dashboard_camera_ctrl に委譲する。
 *
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initCameraPanel(body, hostname) {
  const img = body.querySelector("img");
  if (!img) return;

  /* トグルスイッチはパネルヘッダー内に生成されている */
  const panelWrapper = body.closest(".panel-wrapper");
  const toggle = panelWrapper?.querySelector(".panel-header-toggle input");

  /* カメラレジストリに登録（リトライ・UI更新は camera_ctrl が管理） */
  registerCameraPanel(hostname, img, body, toggle);

  /* トグルスイッチのイベント */
  if (toggle) {
    toggle.checked = !!monitorData.appSettings.cameraToggle;
    toggle.addEventListener("change", () => {
      monitorData.appSettings.cameraToggle = toggle.checked;
      if (toggle.checked) {
        startCameraStream(hostname);
      } else {
        stopCameraStream(hostname);
      }
    });
  }

  /* NO SIGNAL にホスト名・IPを表示 */
  _updateNoSignalInfo(body, hostname);

  /* パネル表示復元時: カメラONならストリーム開始 */
  if (monitorData.appSettings.cameraToggle) {
    startCameraStream(hostname);
  }

  /* キャンセルボタン（ユーザ操作 → フル停止） */
  const cancelBtn = body.querySelector("[id$='camera-cancel-button']") ||
                    body.querySelector(".camera-cancel-btn");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      monitorData.appSettings.cameraToggle = false;
      stopCameraStream(hostname);
    });
  }

  /* パネルの hostname を destroy 用に保持 */
  body._cameraHostname = hostname;
}

/**
 * NO SIGNAL 表示にホスト名とIPを反映する
 * @private
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function _updateNoSignalInfo(body, hostname) {
  const hostEl = body.querySelector("[id$='camera-no-signal-host']") || body.querySelector(".no-signal-host");
  const ipEl = body.querySelector("[id$='camera-no-signal-ip']") || body.querySelector(".no-signal-ip");
  const displayHost = (hostname && hostname !== "shared")
    ? hostname
    : (currentHostname || "");
  const ip = getDeviceIp(displayHost) || monitorData.appSettings.wsDest?.split(":")[0] || "";
  if (hostEl) hostEl.textContent = displayHost || "";
  if (ipEl) ipEl.textContent = ip ? `(${ip})` : "";
}

/**
 * ヘッド位置プレビューパネルの初期化
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initHeadPreviewPanel(body, hostname) {
  /* パネル本体をプレビューモジュールに登録（per-host DOM参照） */
  registerPreviewPanel(body, hostname);

  const xyStage = body.querySelector("#xy-stage");
  if (xyStage) {
    restoreXYPreviewState(hostname);
    initXYPreview(body, hostname);
  }

  // 回転ボタンのバインド
  const btnFlat = body.querySelector("#btn-stage-flat");
  const btn45 = body.querySelector("#btn-stage-45");
  const btnOblique = body.querySelector("#btn-stage-65-72");
  const btnSpin = body.querySelector("#btn-stage-spin");

  if (btnFlat) btnFlat.addEventListener("click", setFlatView);
  if (btn45) btn45.addEventListener("click", setTilt45View);
  if (btnOblique) btnOblique.addEventListener("click", setObliqueView);
  if (btnSpin) btnSpin.addEventListener("click", toggleZSpin);
}

/**
 * フィラメントプレビューパネルの初期化（プレビュー生成＋交換/一覧ボタンバインド）
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initFilamentPanel(body, hostname) {
  const container = body.querySelector("#filament-preview");
  if (!container) return;

  // フィラメントプレビューを生成（per-host）
  try {
    const preview = createFilamentPreview(container, {
      filamentDiameter: 1.75,
      filamentTotalLength: 330000,
      filamentCurrentLength: 330000,
      filamentColor: "#00cc66",
      reelOuterDiameter: 200,
      reelThickness: 68,
      reelWindingInnerDiameter: 95,
      reelCenterHoleDiameter: 54,
    });
    /* per-host Map + 後方互換 window.filamentPreview */
    if (!window._filamentPreviews) window._filamentPreviews = new Map();
    window._filamentPreviews.set(hostname, preview);
    window.filamentPreview = preview;
  } catch (e) {
    console.warn("[panel-init] filament preview 生成エラー:", e);
  }

  // 交換・一覧ボタンのバインド
  const changeBtn = body.querySelector("#filament-change-btn");
  if (changeBtn) {
    changeBtn.addEventListener("click", () => {
      try { showFilamentChangeDialog(); } catch (e) {
        console.warn("[panel-init] filament change dialog エラー:", e);
      }
    });
  }
  const listBtn = body.querySelector("#filament-list-btn");
  if (listBtn) {
    listBtn.addEventListener("click", () => {
      try { showFilamentManager(); } catch (e) {
        console.warn("[panel-init] filament manager エラー:", e);
      }
    });
  }
}

/**
 * 温度グラフパネルの初期化
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initTempGraphPanel(body, hostname) {
  const canvas = body.querySelector("#temp-graph-canvas");
  if (!canvas) return;

  // Chart.js の初期化（per-host インスタンス）
  resetTemperatureGraph(hostname);
  initTemperatureGraph(body, hostname);

  // リセットボタン
  const resetBtn = body.querySelector("#temp-graph-reset-button");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      resetTemperatureGraph(hostname);
    });
  }
}

/**
 * 状態パネルの初期化（data-field バインディングのみ、追加初期化不要）
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initStatusPanel(body, hostname) {
  // data-field 属性による自動バインディングのため、特別な初期化は不要
}

/**
 * 操作ボタンパネルの初期化（停止・一時停止等のボタンのみ）
 * initializeCommandPalette はグローバルに getElementById で探すため、
 * 温度パネル生成後にまとめて呼ぶ。ここではボタンのみに限定的にバインドする。
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initControlCmdPanel(body, hostname) {
  try {
    initializeCommandPalette(body, hostname);
  } catch (e) {
    console.warn("[panel-init] command palette 初期化エラー:", e);
  }
}

/**
 * 温度・ファン制御パネルの初期化
 * initializeCommandPalette を呼んでファン/温度/レート制御すべてをバインドする。
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initControlTempPanel(body, hostname) {
  try {
    initializeCommandPalette(body, hostname);
  } catch (e) {
    console.warn("[panel-init] command palette 初期化エラー:", e);
  }
}

/**
 * ログパネルの初期化
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initLogPanel(body, hostname) {
  const logBox = body.querySelector("#log");
  const notifBox = body.querySelector("#notification-history");

  if (logBox) {
    initLogAutoScroll(logBox);
    initLogRenderer(logBox, notifBox, hostname);
  }

  // タブ切り替え
  const tabReceived = body.querySelector("#tab-received");
  const tabNotification = body.querySelector("#tab-notification");
  const tsReceivedEl = body.querySelector("#last-log-timestamp");
  const tsErrorEl = body.querySelector("#last-notification-timestamp");

  if (tabReceived && tabNotification) {
    tabReceived.addEventListener("click", () => {
      tabReceived.classList.add("active");
      tabNotification.classList.remove("active");
      if (logBox) logBox.classList.remove("hidden");
      if (tsReceivedEl) tsReceivedEl.classList.remove("hidden");
      if (notifBox) notifBox.classList.add("hidden");
      if (tsErrorEl) tsErrorEl.classList.add("hidden");
    });

    tabNotification.addEventListener("click", () => {
      tabNotification.classList.add("active");
      tabReceived.classList.remove("active");
      if (logBox) logBox.classList.add("hidden");
      if (tsReceivedEl) tsReceivedEl.classList.add("hidden");
      if (notifBox) notifBox.classList.remove("hidden");
      if (tsErrorEl) tsErrorEl.classList.remove("hidden");
    });
  }

  // コピーボタン（HTML上のID: copy-all-button, copy-last-50-button, copy-storeddata-button,
  //   copy-all-notification-button, copy-last-50-notification-button）
  const copyAll = body.querySelector("#copy-all-button");
  if (copyAll) {
    copyAll.addEventListener("click", () => {
      const el = logBox || body.querySelector("#log");
      if (el) navigator.clipboard.writeText(el.innerText).catch(() => {});
    });
  }
  const copyLast50 = body.querySelector("#copy-last-50-button");
  if (copyLast50) {
    copyLast50.addEventListener("click", () => {
      const el = logBox || body.querySelector("#log");
      if (el) {
        const lines = el.innerText.split("\n");
        navigator.clipboard.writeText(lines.slice(-50).join("\n")).catch(() => {});
      }
    });
  }
  const copyStoredData = body.querySelector("#copy-storeddata-button");
  if (copyStoredData) {
    copyStoredData.addEventListener("click", () => {
      const hn = hostname === "shared" ? currentHostname : hostname;
      const machine = monitorData.machines[hn];
      if (machine?.storedData) {
        navigator.clipboard.writeText(JSON.stringify(machine.storedData, null, 2)).catch(() => {});
      }
    });
  }
  // 通知ログ用コピーボタン
  const copyAllNotif = body.querySelector("#copy-all-notification-button");
  if (copyAllNotif) {
    copyAllNotif.addEventListener("click", () => {
      const el = notifBox || body.querySelector("#notification-history");
      if (el) navigator.clipboard.writeText(el.innerText).catch(() => {});
    });
  }
  const copyLast50Notif = body.querySelector("#copy-last-50-notification-button");
  if (copyLast50Notif) {
    copyLast50Notif.addEventListener("click", () => {
      const el = notifBox || body.querySelector("#notification-history");
      if (el) {
        const lines = el.innerText.split("\n");
        navigator.clipboard.writeText(lines.slice(-50).join("\n")).catch(() => {});
      }
    });
  }
  // 通知ログクリアボタン
  const clearNotif = body.querySelector("#clear-notification-logs-button");
  if (clearNotif) {
    clearNotif.addEventListener("click", () => {
      const el = notifBox || body.querySelector("#notification-history");
      if (el) el.innerHTML = "";
    });
  }

  // 受信ログ/通知ログ切替時にコントロール表示も切り替え
  const logControls = body.querySelector("#log-controls");
  const notifControls = body.querySelector("#notification-controls");
  if (tabReceived && logControls && notifControls) {
    tabReceived.addEventListener("click", () => {
      logControls.classList.remove("hidden");
      notifControls.classList.add("hidden");
    });
    tabNotification.addEventListener("click", () => {
      logControls.classList.add("hidden");
      notifControls.classList.remove("hidden");
    });
  }
}

/**
 * 現在の印刷パネルの初期化
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initCurrentPrintPanel(body, hostname) {
  const container = body.querySelector("#print-current-container");
  if (container) {
    printManager.renderPrintCurrent(container, hostname);
  }
}

/**
 * 印刷履歴パネルの初期化
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initHistoryPanel(body, hostname) {
  // タブ切り替え（履歴/ファイル一覧）
  // HTML上のID: #tab-print-history, #tab-file-list
  // ペインID: #panel-print-history-tab, #panel-file-list
  const tabHistory = body.querySelector("#tab-print-history");
  const tabFile    = body.querySelector("#tab-file-list");
  const paneHistory = body.querySelector("#panel-print-history-tab");
  const paneFile    = body.querySelector("#panel-file-list");

  if (tabHistory && tabFile && paneHistory && paneFile) {
    tabHistory.addEventListener("click", () => {
      tabHistory.classList.add("active");
      tabFile.classList.remove("active");
      paneHistory.classList.remove("hidden");
      paneFile.classList.add("hidden");
    });
    tabFile.addEventListener("click", () => {
      tabFile.classList.add("active");
      tabHistory.classList.remove("active");
      paneFile.classList.remove("hidden");
      paneHistory.classList.add("hidden");
    });
  }

  // 履歴再読み込みボタン
  const refreshBtn = body.querySelector("#history-refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      sendCommand("get", { reqHistory: 1 }, hostname || currentHostname);
    });
  }

  // 保存済み履歴を表示
  try {
    const jobs = printManager.loadHistory(hostname);
    if (jobs.length) {
      const ip = getDeviceIp(hostname);
      const baseUrl = `http://${ip}:${getHttpPort(hostname)}`;
      const raw = printManager.jobsToRaw(jobs);
      printManager.renderHistoryTable(raw, baseUrl, hostname);
    }
  } catch (e) {
    console.warn("[panel-init] history render エラー:", e);
  }
}

/**
 * 機器情報パネルの初期化（data-field バインディングのみ）
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initMachineInfoPanel(body, hostname) {
  // data-field 属性による自動バインディングのため、特別な初期化は不要
}

// ==============================
// 一括登録
// ==============================

/**
 * registerAllPanelInits:
 *   全パネル種別の初期化関数を一括登録する。
 *   bootPanelSystem() の初期段階で1度だけ呼び出す。
 */
export function registerAllPanelInits() {
  registerPanelInit("camera", initCameraPanel);
  registerPanelInit("head-preview", initHeadPreviewPanel);
  registerPanelInit("filament", initFilamentPanel);
  registerPanelInit("status", initStatusPanel);
  registerPanelInit("control-cmd", initControlCmdPanel);
  registerPanelInit("control-temp", initControlTempPanel);
  registerPanelInit("temp-graph", initTempGraphPanel);
  registerPanelInit("machine-info", initMachineInfoPanel);
  registerPanelInit("log", initLogPanel);
  registerPanelInit("current-print", initCurrentPrintPanel);
  registerPanelInit("history", initHistoryPanel);

  // 破棄関数
  registerPanelDestroy("camera", (body) => {
    /* パネル非表示時はレジストリから解除しストリームを停止する。
       cameraToggle はユーザが明示的にOFFにしない限り維持する。 */
    const hostname = body._cameraHostname;
    if (hostname) {
      unregisterCameraPanel(hostname);
    } else {
      /* フォールバック: レジストリ未登録の場合は直接クリア */
      const img = body.querySelector("img");
      if (img) {
        img.onload = null;
        img.onerror = null;
        img.src = "";
      }
    }
  });
  registerPanelDestroy("temp-graph", (body, hostname) => {
    resetTemperatureGraph(hostname);
  });
}
