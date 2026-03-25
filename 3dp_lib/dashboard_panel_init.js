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
  replayPreviewState,
  destroyPreviewPanel,
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
/* initStorageUIInPanel は設定パネル統合により不要 */
import { monitorData } from "./dashboard_data.js";
import { getCurrentSpool, setCurrentSpoolId, formatSpoolDisplayId } from "./dashboard_spool.js";
import { showAlert } from "./dashboard_notification_manager.js";
import { getDeviceIp, getHttpPort, sendCommand } from "./dashboard_connection.js";
import * as printManager from "./dashboard_printmanager.js";
import { buildFleetSummary, buildDailyProductionReport, buildEstimateVsActual } from "./dashboard_production.js";
import {
  initializeCommandPalette,
  initializeRateControls,
  initSendRawJson,
  initSendGcode,
  initTestRawJson,
  initPauseHome,
  initXYUnlock
} from "./dashboard_send_command.js";

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
    toggle.checked = !!(monitorData.hostCameraToggle[hostname] ?? monitorData.appSettings.cameraToggle);
    toggle.addEventListener("change", () => {
      monitorData.hostCameraToggle[hostname] = toggle.checked;
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
  if (monitorData.hostCameraToggle[hostname] ?? monitorData.appSettings.cameraToggle) {
    startCameraStream(hostname);
  }

  /* キャンセルボタン（ユーザ操作 → フル停止） */
  const cancelBtn = body.querySelector("[id$='camera-cancel-button']") ||
                    body.querySelector(".camera-cancel-btn");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      monitorData.hostCameraToggle[hostname] = false;
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
    : "";
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

  /* localStorage から位置・モデル・回転状態を復元 */
  restoreXYPreviewState(hostname);

  const xyStage = body.querySelector("#xy-stage");
  if (xyStage) {
    initXYPreview(body, hostname);
  }

  /* processData がパネル生成前に到着済みの場合、
     キャッシュされた位置・モデル情報を DOM に反映する */
  replayPreviewState(hostname);

  // 回転ボタンのバインド
  const btnFlat = body.querySelector("#btn-stage-flat");
  const btn45 = body.querySelector("#btn-stage-45");
  const btnOblique = body.querySelector("#btn-stage-65-72");
  const btnSpin = body.querySelector("#btn-stage-spin");

  if (btnFlat) btnFlat.addEventListener("click", () => setFlatView(hostname));
  if (btn45) btn45.addEventListener("click", () => setTilt45View(hostname));
  if (btnOblique) btnOblique.addEventListener("click", () => setObliqueView(hostname));
  if (btnSpin) btnSpin.addEventListener("click", () => toggleZSpin(hostname));
}

/**
 * フィラメントプレビューパネルの初期化（プレビュー生成＋交換/一覧ボタンバインド）
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initFilamentPanel(body, hostname) {
  const container = body.querySelector("#filament-preview");
  if (!container) return;

  // フィラメントプレビューを生成（per-host・スプール情報反映）
  /** @type {ReturnType<typeof createFilamentPreview>|null} */
  let preview = null;
  try {
    const machine = monitorData.machines[hostname] || {};
    const spool = getCurrentSpool(hostname);
    // スプール未装着の場合はデフォルト満タン表示（0% 表示を防止）
    const defaultTotal = 330000;
    preview = createFilamentPreview(container, {
      filamentDiameter:         spool?.filamentDiameter ?? machine.settings?.filamentDiameterMm ?? 1.75,
      filamentTotalLength:      spool?.totalLengthMm ?? machine.settings?.filamentTotalLengthMm ?? defaultTotal,
      filamentCurrentLength:    spool?.remainingLengthMm ?? machine.settings?.filamentRemainingMm ?? defaultTotal,
      filamentColor:            spool?.filamentColor ?? machine.settings?.filamentColor ?? "#22C55E",
      reelOuterDiameter:        spool?.reelOuterDiameter ?? 200,
      reelThickness:            spool?.reelThickness ?? 68,
      reelWindingInnerDiameter: spool?.reelWindingInnerDiameter ?? 95,
      reelCenterHoleDiameter:   spool?.reelCenterHoleDiameter ?? 54,
      widthPx:                  264,
      heightPx:                 264,
      showSlider:               false,
      isFilamentPresent:        !!spool,
      showUsedUpIndicator:      true,
      blinkingLightColor:       "#0EA5E9",
      showInfoLength:           false,
      showInfoPercent:          false,
      showInfoLayers:           false,
      showResetButton:          false,
      showProfileViewButton:    true,
      showSideViewButton:       true,
      showFrontViewButton:      true,
      showAutoRotateButton:     true,
      enableDrag:               true,
      enableClick:              false,
      onClick:                  null,
      disableInteraction:       true,
      showOverlayLength:        true,
      showOverlayPercent:       true,
      showLengthKg:             false,
      showReelName:             true,
      showReelSubName:          true,
      showMaterialName:         true,
      showMaterialColorName:    true,
      showMaterialColorCode:    true,
      showManufacturerName:     true,
      showOverlayBar:           true,
      showPurchaseButton:       true,
      reelName:                 spool?.name || "",
      reelSubName:              spool?.reelSubName || "",
      materialName:             spool?.materialName || spool?.material || "",
      materialColorName:        spool?.colorName || "",
      materialColorCode:        spool?.filamentColor || "",
      manufacturerName:         spool?.manufacturerName || spool?.brand || "",
    });
    /* per-host Map で管理（グローバル window.filamentPreview は廃止） */
    if (!window._filamentPreviews) window._filamentPreviews = new Map();
    window._filamentPreviews.set(hostname, preview);
  } catch (e) {
    console.warn("[panel-init] filament preview 生成エラー:", e);
  }

  // パネルリサイズ時にプレビューを拡縮
  if (preview) {
    const area = body.querySelector(".filament-preview-area");
    if (area) {
      const ro = new ResizeObserver(entries => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          if (width > 0 && height > 0) preview.resize(width, height);
        }
      });
      ro.observe(area);
      // 初回サイズ適用
      requestAnimationFrame(() => {
        const rect = area.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) preview.resize(rect.width, rect.height);
      });
    }
  }

  // 交換・一覧ボタンのバインド
  const changeBtn = body.querySelector("#filament-change-btn");
  if (changeBtn) {
    changeBtn.addEventListener("click", async () => {
      try {
        await showFilamentChangeDialog(hostname);
      } catch (e) {
        console.error("[panel-init] filament change dialog エラー:", e);
      }
    });
  }
  const removeBtn = body.querySelector("#filament-remove-btn");
  if (removeBtn) {
    removeBtn.addEventListener("click", async () => {
      const spool = getCurrentSpool(hostname);
      if (!spool) {
        showAlert("スプールは装着されていません", "info");
        return;
      }
      const machineObj = monitorData.machines[hostname] || {};
      const displayHost = machineObj.storedData?.hostname?.rawValue
                       || machineObj.storedData?.model?.rawValue || hostname || "";
      const { showConfirmDialog } = await import("./dashboard_ui_confirm.js");
      const ok = await showConfirmDialog({
        level: "warn",
        title: "スプール取り外し",
        message: `${displayHost} から ${formatSpoolDisplayId(spool)} ${spool.name || ""} を取り外しますか？`,
        confirmText: "取り外す",
        cancelText: "キャンセル"
      });
      if (!ok) return;
      setCurrentSpoolId(null, hostname);
      // プレビューを未装着状態にリセット（全オーバーレイ属性をクリア）
      const hostPreview = window._filamentPreviews?.get(hostname);
      if (hostPreview) {
        hostPreview.setState({
          isFilamentPresent: false,
          filamentCurrentLength: spool.totalLengthMm || 330000,
          reelName: "", reelSubName: "",
          materialName: "", materialColorName: "",
          materialColorCode: "", manufacturerName: ""
        });
      }
    });
  }
  const listBtn = body.querySelector("#filament-list-btn");
  if (listBtn) {
    listBtn.addEventListener("click", () => {
      try { showFilamentManager(0, hostname); } catch (e) {
        console.warn("[panel-init] filament manager エラー:", e);
      }
    });
  }

  // 回転ボタンをフッターに統合 (CSS で dfv-controls を非表示にした代わり)
  // 操作ボタンと回転ボタンをそれぞれ nowrap グループに入れ、
  // セパレータは折り返し時に自動的に非表示になる
  if (preview) {
    const footer = body.querySelector(".filament-panel-footer");
    if (footer) {
      // 既存ボタンを操作グループで囲む
      const cmdGroup = document.createElement("span");
      cmdGroup.className = "fil-footer-group";
      while (footer.firstChild) cmdGroup.appendChild(footer.firstChild);
      footer.appendChild(cmdGroup);

      // セパレータ（折り返し時に CSS で非表示）
      const sep = document.createElement("span");
      sep.className = "fil-footer-sep";
      footer.appendChild(sep);

      // 回転ボタングループ
      const rotGroup = document.createElement("span");
      rotGroup.className = "fil-footer-group";
      const rotBtns = [
        { label: "⟲", title: "自動回転", action: () => preview.toggleAutoRotate?.() },
        { label: "◐", title: "正面", action: () => preview.setFrontView?.() },
        { label: "◑", title: "横", action: () => preview.setSideView?.() },
        { label: "◉", title: "斜め", action: () => preview.setProfileView?.() },
      ];
      for (const { label, title, action } of rotBtns) {
        const btn = document.createElement("button");
        btn.className = "btn";
        btn.textContent = label;
        btn.title = title;
        btn.style.cssText = "font-size:11px;padding:2px 5px;min-width:24px;min-height:24px";
        btn.addEventListener("click", action);
        rotGroup.appendChild(btn);
      }
      footer.appendChild(rotGroup);
    }
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
    initSendRawJson(body, hostname);
    initSendGcode(body, hostname);
    initTestRawJson(body, hostname);
    initPauseHome(body, hostname);
    initXYUnlock(body, hostname);
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
      const hn = hostname === "shared" ? "" : hostname;
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
 * パネルサイズに応じて横長/縦長レイアウトを切り替える。
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initCurrentPrintPanel(body, hostname) {
  const container = body.querySelector("#print-current-container");
  if (container) {
    printManager.renderPrintCurrent(container, hostname);
  }

  // パネルリサイズ時にコンテナに横長/縦長クラスを付与
  // （renderPrintCurrent で innerHTML が再生成されても維持される）
  const ro = new ResizeObserver(entries => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      const portrait = height > width || (width > 600 && height > width * 0.35);
      body.classList.toggle("cp-portrait", portrait);
    }
  });
  ro.observe(body);
}

/**
 * 印刷履歴パネルの初期化（独立パネル、タブなし）
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initHistoryPanel(body, hostname) {
  // 履歴再読み込みボタン
  const refreshBtn = body.querySelector("#history-refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      sendCommand("get", { reqHistory: 1 }, hostname);
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
 * ファイル一覧パネルの初期化（独立パネル）
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initFileListPanel(body, hostname) {
  // アップロードUIの初期化
  try {
    printManager.setupUploadUI(body, hostname);
  } catch (e) {
    console.warn("[panel-init] upload UI 初期化エラー:", e);
  }

  // キャッシュ済みファイル一覧を表示（パネル生成前にデータ受信済みの場合）
  try {
    const machine = monitorData.machines[hostname];
    if (machine?._cachedFileInfo) {
      const ip = getDeviceIp(hostname);
      const baseUrl = `http://${ip}:${getHttpPort(hostname)}`;
      printManager.renderFileList(machine._cachedFileInfo, baseUrl, hostname);
    }
  } catch (e) {
    console.warn("[panel-init] file list render エラー:", e);
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

/* initSettingsPanel は接続設定モーダルに統合済みのため削除 */

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
  registerPanelInit("file-list", initFileListPanel);
  registerPanelInit("production", initProductionPanel);
  /* settings パネルは接続設定モーダルに統合済み */

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
  registerPanelDestroy("head-preview", (body, hostname) => {
    destroyPreviewPanel(hostname);
  });
  registerPanelDestroy("temp-graph", (body, hostname) => {
    resetTemperatureGraph(hostname);
  });
  registerPanelDestroy("production", (body) => {
    if (body._productionTimer) {
      clearInterval(body._productionTimer);
      body._productionTimer = null;
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   生産管理パネル (Phase 3)
   ═══════════════════════════════════════════════════════════════ */

/**
 * 時間をHH:MM:SS形式にフォーマットする。
 * @param {number} sec - 秒
 * @returns {string}
 */
function _fmtTime(sec) {
  if (!sec || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * 生産管理パネルを初期化する。
 * フリート全体の稼働率、日次レポート、予定vs実績を表示。
 *
 * @param {HTMLElement} body - パネル本体の DOM 要素
 */
function initProductionPanel(body) {
  body.classList.add("production-panel");

  // 固定コンテナ（初回のみ作成、更新時は中身だけ差し替え）
  const summaryContainer = document.createElement("div");
  summaryContainer.className = "stat-cards";

  const hostContainer = document.createElement("div");
  hostContainer.className = "prod-host-section";

  const dailyContainer = document.createElement("div");
  dailyContainer.className = "prod-daily-section";

  const evaContainer = document.createElement("div");
  evaContainer.className = "prod-eva-section";

  // 空状態メッセージ
  const emptyMsg = document.createElement("div");
  emptyMsg.className = "fm-empty-msg";
  emptyMsg.textContent = "接続中のプリンタがありません";
  emptyMsg.style.display = "none";

  body.append(emptyMsg, summaryContainer, hostContainer, dailyContainer, evaContainer);

  /**
   * データ取得 → 各コンテナの中身を差し替え。
   * スクロール位置・フォーカスを保持するため body.innerHTML は使わない。
   */
  function update() {
    const fleet = buildFleetSummary();
    const daily = buildDailyProductionReport({ days: 7 });

    // 空状態チェック
    if (fleet.totalHosts === 0) {
      emptyMsg.style.display = "";
      summaryContainer.style.display = "none";
      hostContainer.style.display = "none";
      dailyContainer.style.display = "none";
      evaContainer.style.display = "none";
      return;
    }
    emptyMsg.style.display = "none";
    summaryContainer.style.display = "";
    hostContainer.style.display = "";

    // ── 1) フリートサマリーカード（中身だけ差し替え）──
    summaryContainer.innerHTML = "";
    [
      { label: "接続台数", value: `${fleet.activeHosts}/${fleet.totalHosts}台`, sub: `${fleet.printingHosts}台印刷中` },
      { label: "フリート稼働率", value: `${fleet.fleetUtilizationPct}%` },
      { label: "本日の印刷数", value: `${fleet.totalPrintCount}回`, sub: `成功${fleet.totalSuccessCount} / 失敗${fleet.totalFailCount}` },
      { label: "合計印刷時間", value: _fmtTime(fleet.totalPrintTimeMs / 1000) }
    ].forEach(c => {
      const card = document.createElement("div");
      card.className = "stat-card";
      card.innerHTML = `<div class="stat-card-label">${c.label}</div><div class="stat-card-value">${c.value}</div>${c.sub ? `<div class="stat-card-sub">${c.sub}</div>` : ""}`;
      summaryContainer.appendChild(card);
    });

    // ── 2) per-host 稼働率バー ──
    hostContainer.innerHTML = "";
    if (fleet.hosts.length > 0) {
      const hostTitle = document.createElement("div");
      hostTitle.className = "prod-section-title";
      hostTitle.textContent = "機器別稼働率 (24h)";
      hostContainer.appendChild(hostTitle);

      for (const h of fleet.hosts) {
        const row = document.createElement("div");
        row.className = "prod-host-row";
        const nameSpan = document.createElement("span");
        nameSpan.className = "prod-host-name";
        nameSpan.textContent = h.displayName;

        const barWrap = document.createElement("div");
        barWrap.className = "prod-util-bar-wrap";
        const bar = document.createElement("div");
        bar.className = "prod-util-bar";
        const fill = document.createElement("div");
        fill.className = `prod-util-bar-fill${h.isPrinting ? " printing" : ""}`;
        fill.style.width = `${h.utilizationPct}%`;
        bar.appendChild(fill);
        barWrap.appendChild(bar);

        const pctLabel = document.createElement("span");
        pctLabel.className = "prod-util-pct";
        pctLabel.textContent = `${h.utilizationPct}%`;

        const statusSpan = document.createElement("span");
        statusSpan.className = `prod-host-status${h.isPrinting ? " active" : ""}`;
        statusSpan.textContent = h.isPrinting
          ? `🖨 ${h.currentJobProgress}%`
          : `${h.printCount}回完了`;

        row.append(nameSpan, barWrap, pctLabel, statusSpan);
        hostContainer.appendChild(row);
      }
    }

    // ── 3) 日次生産テーブル（tbodyのみ差し替え）──
    if (daily.length > 0) {
      dailyContainer.style.display = "";
      // 初回のみヘッダ構築
      if (!dailyContainer.querySelector("table")) {
        const dailyTitle = document.createElement("div");
        dailyTitle.className = "prod-section-title";
        dailyTitle.textContent = "日次生産レポート (7日間)";
        const table = document.createElement("table");
        table.className = "registered-table prod-daily-table";
        table.innerHTML = `<thead><tr>
          <th>日付</th>
          <th class="text-right">印刷数</th>
          <th class="text-right">成功</th>
          <th class="text-right">失敗</th>
          <th class="text-right">合計時間</th>
          <th class="text-right">消費量</th>
        </tr></thead><tbody></tbody>`;
        dailyContainer.append(dailyTitle, table);
      }
      const tbody = dailyContainer.querySelector("tbody");
      tbody.innerHTML = "";
      for (const day of daily) {
        const tr = document.createElement("tr");
        const filFmt = day.totalFilamentMm > 0 ? `${(day.totalFilamentMm / 1000).toFixed(1)}m` : "—";
        tr.innerHTML =
          `<td>${day.date}</td>` +
          `<td class="text-right">${day.printCount}</td>` +
          `<td class="text-right">${day.successCount}</td>` +
          `<td class="text-right">${day.failCount > 0 ? `<span class="text-danger">${day.failCount}</span>` : "0"}</td>` +
          `<td class="text-right">${_fmtTime(day.totalPrintTimeSec)}</td>` +
          `<td class="text-right">${filFmt}</td>`;
        tbody.appendChild(tr);
      }
    } else {
      dailyContainer.style.display = "none";
    }

    // ── 4) 予定vs実績（tbodyのみ差し替え）──
    const allEstVsAct = [];
    for (const h of fleet.hosts) {
      const items = buildEstimateVsActual(h.hostname);
      items.forEach(i => { i._host = h.displayName; });
      allEstVsAct.push(...items);
    }
    allEstVsAct.sort((a, b) => b.printCount - a.printCount);
    const top10 = allEstVsAct.slice(0, 10);

    if (top10.length > 0) {
      evaContainer.style.display = "";
      // 初回のみヘッダ構築
      if (!evaContainer.querySelector("table")) {
        const evaTitle = document.createElement("div");
        evaTitle.className = "prod-section-title";
        evaTitle.textContent = "予定 vs 実績 (Top 10)";
        const evaTable = document.createElement("table");
        evaTable.className = "registered-table prod-eva-table";
        evaTable.innerHTML = `<thead><tr>
          <th>ファイル</th>
          <th class="text-right">回数</th>
          <th class="text-right">見積</th>
          <th class="text-right">実績平均</th>
          <th class="text-right">差異</th>
        </tr></thead><tbody></tbody>`;
        evaContainer.append(evaTitle, evaTable);
      }
      const evaTbody = evaContainer.querySelector("tbody");
      evaTbody.innerHTML = "";
      for (const item of top10) {
        const tr = document.createElement("tr");
        const diffClass = item.diffPct > 10 ? "text-danger" :
                          item.diffPct < -10 ? "text-success" : "";
        const diffSign = item.diffPct > 0 ? "+" : "";
        tr.innerHTML =
          `<td title="${item.filename}">${item.filename.length > 30 ? item.filename.slice(0, 27) + "…" : item.filename}</td>` +
          `<td class="text-right">${item.printCount}回</td>` +
          `<td class="text-right">${item.estimatedSec > 0 ? _fmtTime(item.estimatedSec) : "—"}</td>` +
          `<td class="text-right">${_fmtTime(item.actualAvgSec)}</td>` +
          `<td class="text-right ${diffClass}">${item.estimatedSec > 0 ? `${diffSign}${item.diffPct}%` : "—"}</td>`;
        evaTbody.appendChild(tr);
      }
    } else {
      evaContainer.style.display = "none";
    }
  }

  update();
  // 30秒ごとに差分更新（スクロール位置を維持）
  body._productionTimer = setInterval(update, 30000);
}
