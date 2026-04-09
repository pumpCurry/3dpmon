/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 ダッシュボード初期化処理 モジュール
 * @file 3dp_dashboard_init.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module 3dp_dashboard_init
 *
 * 【機能内容サマリ】
 * - ストレージ復元・マイグレーション・デフォルトスプール作成
 * - 自動接続・自動保存のセットアップ
 * - 印刷再開用データの復元と永続化（per-host）
 *
 * ※ UI要素のバインド・温度グラフ・コマンド送信・ファイルマネージャ等の
 *   初期化はパネルシステム (dashboard_panel_factory / dashboard_panel_boot) が
 *   per-host で実行するため、このモジュールでは行わない。
 *
 * 【公開関数一覧】
 * - {@link initializeDashboard}：ダッシュボードを初期化
 * - {@link restorePrintResume}：印刷再開用データを復元（per-host）
 * - {@link persistPrintResume}：印刷再開用データを保存（per-host）
 * - {@link initializeAutoSave}：自動保存タイマーを開始
 *
* @version 1.390.652 (PR #366)
* @since   1.390.193 (PR #86)
* @lastModified 2026-03-12
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

import {
  initStorage,
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
  setStoredDataForHost
} from "./dashboard_data.js";
import { connectAllSavedTargets } from "./dashboard_connection.js";
import { addSpoolFromPreset, getCurrentSpool, getCurrentSpoolId, setCurrentSpoolId } from "./dashboard_spool.js";
import { FILAMENT_PRESETS } from "./dashboard_filament_presets.js";
import { notificationManager } from "./dashboard_notification_manager.js";
import { showAlert } from "./dashboard_notification_manager.js";
import {
  persistAggregatorState,
  stopAggregatorTimer,
  aggregatorUpdate
} from "./dashboard_aggregator.js";

/**
 * ダッシュボードを初期化します。
 *
 * ストレージの復元・デフォルトスプール作成・自動接続・自動保存を行います。
 * UI要素のバインドやグラフ初期化はパネルシステムが per-host で担当するため、
 * ここでは実行しません。
 */
export async function initializeDashboard() {
  // (1) ホスト未定義ならプレースホルダ設定（ストレージ復元より先に必要）
  if (!currentHostname) {
    setCurrentHostname(PLACEHOLDER_HOSTNAME);
  }

  // (2) ストレージ復元／マイグレーション
  await initStorage();            // IndexedDB 初期化（localStorage からの自動マイグレーション含む）
  restoreUnifiedStorage();
  // ★ restoreLegacyStoredData / cleanupLegacy は handleMessage の初回ホスト確定後に実行
  //    （PLACEHOLDER 状態で呼ぶとキーが消失するため）
  // 読み込んだストレージ内容を通知マネージャへ反映
  notificationManager.loadSettings();
  if (!monitorData.filamentSpools.length) {
    const preset = FILAMENT_PRESETS.find(
      p => p.presetId === "preset-unknown-somename-somecolor"
    );
    if (preset) {
      // 初回起動時はホストが未確定なので登録のみ（装着はしない）
      addSpoolFromPreset(preset);
      saveUnifiedStorage();
    }
  }

  // (3) 通知コンテナ初期化（notificationManager 用）
  if (!document.querySelector(".notification-container")) {
    const container = document.createElement("div");
    container.className = "notification-container";
    document.body.appendChild(container);
  }

  // (4) リレーモード検出 + ページロード時の自動接続
  let isRelayChild = false;
  try {
    const { initClientSync } = await import("./dashboard_client_sync.js");
    isRelayChild = initClientSync();
    if (isRelayChild) {
      window._3dpmonRelayChild = true; // グローバルフラグ（connectWs/sendCommand でチェック）
    }
  } catch (e) {
    console.debug("[init] client_sync 読み込みスキップ:", e.message);
  }

  // ★ 旧接続/切断ボタン (connect-button, disconnect-button) はシングルホスト時代の遺物。
  //   マルチホスト環境では全台一括 ON/OFF しかできず危険なため、リスナーを設定しない。
  //   per-host 接続トグルは接続設定モーダル内に実装予定。
  //   → 詳細: docs/LEGACY_UI.md

  // 子モードでなければ通常のプリンタ直接接続
  if (!isRelayChild) {
    const hasTargets = monitorData.appSettings.wsDest
      || (monitorData.appSettings.connectionTargets?.length > 0);
    if (monitorData.appSettings.autoConnect && hasTargets) {
      setTimeout(() => {
        connectAllSavedTargets();
      }, 1500);
    } else {
      showAlert("接続先欄に機器アドレスを入力して、接続を押すと監視がはじまります","warn");
    }
  }

  // (5) 自動保存タイマー＆beforeunload 登録
  initializeAutoSave();
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
  "printFinishTime",
  "prevPrintID"
];

// 印刷再開用に保存したいスプール関連キー
const spoolKeys = [
  "currentSpoolId",
  "currentPrintID",
  "currentJobStartLength",
  "currentJobExpectedLength",
  "remainingLengthMm"
];

/**
 * @function restorePrintResume
 * @description
 *  localStorage に保存された印刷再開データを読み出し、
 *  storedData の computedValue として復元します。
 *
 * @param {string} hostname - 対象ホスト名
 * @param {number|null} currentPrintId -
 *   現在進行中の印刷ID。null の場合は ID 照合を行わず復元します。
 */
export function restorePrintResume(hostname, currentPrintId = null) {
  if (!hostname) return;

  let savedId = null;
  try {
    const rawId = localStorage.getItem(`pd_${hostname}_prevPrintID`);
    if (rawId != null) savedId = JSON.parse(rawId);
  } catch (e) {
    console.warn("restorePrintResume: prevPrintID パース失敗", e);
  }

  if (currentPrintId !== null && savedId !== null && currentPrintId !== savedId) {
    console.debug("restorePrintResume: 印刷ID不一致のため復元をスキップ");
    return;
  }

  persistKeys.forEach(key => {
    const raw = localStorage.getItem(`pd_${hostname}_${key}`);
    if (raw == null) return;  // データなし

    try {
      // JSON パースして storedData にセット（rawValue／computedValue 両方に流し込む）
      const value = JSON.parse(raw);

      // 第4引数 true を渡すことで rawValue にもセットします
      setStoredDataForHost(hostname, key, value, true);

    } catch (e) {
      console.warn(`restorePrintResume: '${key}' の JSON パースに失敗しました`, e);
    }
  });

  const spool = getCurrentSpool(hostname);
  if (spool) {
    spoolKeys.forEach(k => {
      const raw = localStorage.getItem(`pd_${hostname}_${k}`);
      if (raw == null) return;
      try {
        const val = JSON.parse(raw);
        switch (k) {
          case 'currentSpoolId':
            setCurrentSpoolId(val, hostname);
            break;
          case 'currentPrintID':
            spool.currentPrintID = val;
            break;
          case 'currentJobStartLength':
            spool.currentJobStartLength = val;
            break;
          case 'currentJobExpectedLength':
            spool.currentJobExpectedLength = val;
            break;
          case 'remainingLengthMm':
            spool.remainingLengthMm = val;
            break;
        }
      } catch (e) { console.debug("[restorePrintResume] スプール復元エラー:", e.message); }
    });
  }
}

/**
 * @function persistPrintResume
 * @description
 *  現在の storedData から印刷再開データを抽出し、
 *  localStorage に個別保存または削除します。
 *
 * @param {string} hostname - 対象ホスト名
 */
export function persistPrintResume(hostname) {
  if (!hostname || !monitorData.machines[hostname]) return;

  const machineSD = monitorData.machines[hostname].storedData;
  persistKeys.forEach(key => {
    const entry = machineSD[key];
    const storageKey = `pd_${hostname}_${key}`;
    if (entry?.rawValue != null) {
      localStorage.setItem(storageKey, JSON.stringify(entry.rawValue));
    } else {
      // 該当データがない場合はキーを消しておく
      localStorage.removeItem(`pd_${hostname}_${key}`);
    }
  });

  const spool = getCurrentSpool(hostname);
  if (spool) {
    spoolKeys.forEach(k => {
      const val = (() => {
        switch (k) {
          case 'currentSpoolId':
            return getCurrentSpoolId(hostname);
          case 'currentPrintID':
            return spool.currentPrintID;
          case 'currentJobStartLength':
            return spool.currentJobStartLength;
          case 'currentJobExpectedLength':
            return spool.currentJobExpectedLength;
          case 'remainingLengthMm':
            return spool.remainingLengthMm;
          default:
            return null;
        }
      })();
      const key = `pd_${hostname}_${k}`;
      if (val != null) {
        localStorage.setItem(key, JSON.stringify(val));
      } else {
        localStorage.removeItem(key);
      }
    });
  }
}


/** 自動保存間隔（ミリ秒） */
const AUTO_SAVE_INTERVAL_MS = 3 * 60 * 1000; // 3分

/**
 * autoSaveAll:
 *   - 全接続ホストの印刷再開用データを localStorage に保存
 *   - 統一ストレージ（dashboard_storage）を保存
 *   - aggregator の内部状態を localStorage に保存
 *   - 保存前に {@link aggregatorUpdate} を実行しタイマー値を確定
 *
 * @returns {void}
 */
function autoSaveAll() {
  try {
    // 現在のタイマー値を確定させてから保存処理を実行
    aggregatorUpdate();
  } catch (e) {
    console.warn("autoSaveAll: aggregatorUpdate 実行中にエラーが発生しました", e);
  }

  try {
    /* 全接続ホストの印刷再開データと aggregator 状態を保存 */
    for (const host of Object.keys(monitorData.machines)) {
      if (host === PLACEHOLDER_HOSTNAME) continue;
      persistPrintResume(host);
      persistAggregatorState(host);
    }
    saveUnifiedStorage(true);   // 即時書き込み（スロットリングバイパス）
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
  // ページを離脱するときにも保存
  window.addEventListener("beforeunload", autoSaveAll);

  //aggrigatorを停止
  stopAggregatorTimer();

  // 一定間隔で定期保存
  setInterval(autoSaveAll, AUTO_SAVE_INTERVAL_MS);
}
