/**
 * @fileoverview
 *  @description 3Dプリンタ監視ツール 3dpmon 用 メッセージ処理 モジュール
 * @file dashboard_msg_handler.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_msg_handler
 * 【機能内容サマリ】
 * - WebSocket 受信データの解釈とUI更新
 * - 各種タイマーのリセット／再開
 * - 通知マネージャを介したログ／トースト／サウンド制御
 *
 * 【公開関数一覧】
 * - {@link handleMessage}：生JSONを処理
 * - {@link processData}：データ部処理
 * - {@link processError}：エラー処理
 *
 * @version 1.390.315 (PR #143)
 * @since   1.390.214 (PR #95)
 * @lastModified 2025-06-19 22:01:15
 * -----------------------------------------------------------
 * @todo
 * - なし
 */
"use strict";

import errorMap from "./3dp_errorcode.js";
import {
  monitorData,
  currentHostname,
  setCurrentHostname,
  PLACEHOLDER_HOSTNAME,
  setStoredData,
} from "./dashboard_data.js";
import {
  restoreUnifiedStorage,
  restoreLegacyStoredData,
  cleanupLegacy,
} from "./dashboard_storage.js";
import { pushLog } from "./dashboard_log_util.js";
import { notificationManager } from "./dashboard_notification_manager.js";
import { handlePrintStateTransition } from "./dashboard_printstatus.js";
import { parseCurPosition } from "./dashboard_utils.js";
import {
  updateXYPreview,
  updateZPreview,
  setPrinterModel
} from "./dashboard_stage_preview.js";
import { PRINT_STATE_CODE } from "./dashboard_ui_mapping.js";
import { ingestData, restoreAggregatorState, restartAggregatorTimer } from "./dashboard_aggregator.js";
import { restorePrintResume } from "./3dp_dashboard_init.js";
import * as printManager from "./dashboard_printmanager.js";
import { getDeviceIp } from "./dashboard_connection.js";

/** タイマーID／タイムスタンプ／累積値 */
let prepTimerId, checkTimerId, pauseTimerId, completionTimer;
let tsPrintStart      = null;
let tsPrepEnd         = null;
let tsCheckStart      = null;
let tsCheckEnd        = null;
let tsPauseStart      = null;
let tsCompletion      = null;
let totalPauseSeconds = 0;

/** 前回状態（比較用） */
let prevPrintState     = null;
let prevPrintStartTime = null;
let prevSelfTestPct    = null;

/**
 * handleMessage:
 * (1) ハンドリング前準備
 *     - 初回受信で hostname を設定し、バッファをフラッシュ
 *     - 印刷再開情報を復元
 *     - 以降は processData() へ
 *
 * @param {object} data 受信データ
 */
export function handleMessage(data) {
  // (1a) 初回ホスト設定
  if ((currentHostname === null || currentHostname === PLACEHOLDER_HOSTNAME) && data.hostname) {

    // --- ストレージ＆ホスト初期化 ---
    restoreUnifiedStorage();
    setCurrentHostname(data.hostname);
    restoreLegacyStoredData();
    cleanupLegacy();

    // 接続前に溜めていた分を一気に処理
    // historyList / elapseVideoList を保持していた場合は
    // このタイミングでまとめてマージするため一時配列へ収集
    const bufHistory = [];
    const bufVideos  = [];
    monitorData.temporaryBuffer.forEach(d => {
      if (Array.isArray(d.historyList)) {
        bufHistory.push(...d.historyList);
      }
      if (Array.isArray(d.elapseVideoList)) {
        bufVideos.push(...d.elapseVideoList);
      }
      processData(d); // 既存データ処理も実行
    });
    monitorData.temporaryBuffer = [];

    // 印刷再開用データの復元
    restoreAggregatorState();

    // ── (1.a) 直接受信した履歴データも含めてマージ処理 ──
    if (Array.isArray(data.historyList)) {
      bufHistory.push(...data.historyList);
    }
    if (Array.isArray(data.elapseVideoList)) {
      bufVideos.push(...data.elapseVideoList);
    }

    const baseUrl = `http://${getDeviceIp()}`;
    if (bufHistory.length) {
      printManager.updateHistoryList(bufHistory, baseUrl);
    }
    if (bufVideos.length) {
      printManager.updateVideoList(bufVideos, baseUrl);
    }


    // restoreAggregatorState() のあとでキー初期化 → 以降は必ず storedData[key] が存在
    const initKeys = [
      "preparationTime","firstLayerCheckTime","pauseTime","completionElapsedTime",
      "actualStartTime","initialLeftTime","initialLeftAt",
      "predictedFinishEpoch","estimatedRemainingTime","estimatedCompletionTime"
    ];
    initKeys.forEach(key => {
      setStoredData(key, null, true);
      setStoredData(key, null, false);
    });

    restartAggregatorTimer();
    restorePrintResume();

    // 保存済み履歴と現在印刷を表示
    const baseUrlStored = `http://${getDeviceIp()}:80`;
    const jobs = printManager.loadHistory();
    if (jobs.length) {
      const raw = printManager.jobsToRaw(jobs);
      printManager.renderHistoryTable(raw, baseUrlStored);
    }
    printManager.renderPrintCurrent(
      document.getElementById("print-current-container")
    );

  }

  // (1b) ホスト未設定時はバッファリング、設定後は直接処理
  if (!currentHostname || currentHostname === PLACEHOLDER_HOSTNAME) {
    monitorData.temporaryBuffer.push(data);
  } else {
    processData(data);
  }
}

/**
 * processData:
 * (2) 各種イベント処理
 *     2.1) heartbeat
 *     2.2) エラー
 *     2.3) 準備時間タイマー
 *     2.4) セルフテスト確認時間タイマー
 *     2.5) 一時停止時間タイマー
 *     2.6) 完了後経過時間タイマー
 *     2.7) 状態遷移通知・プレビュー更新・その他フィールド反映
 *
 * @param {object} data 受信データ
 */
export function processData(data) {
  const machine = monitorData.machines[currentHostname];
  if (!machine) return;

  // (2.1) heartbeat のみ処理
  if (data.ModeCode === "heart_beat") {
    machine.runtimeData.lastHeartbeat = new Date().toISOString();
    return;
  }

  // (2.2) エラー処理：常にログ出力 → 通知は設定に応じて
  if (data.err) {
    const { errcode, key } = data.err;
    if (errcode === 0 && key === 0) {
      pushLog("エラーが解消しました。", "info");
      notificationManager.notify("errorResolved");
    } else {
      const msg = processError(data.err);
      pushLog(msg, "error");
      notificationManager.notify("errorOccurred", {
        error_code: errcode,
        error_key:  key,
        error_msg:  msg,
      });
    }
  }

  // 数値化／前回値取得
  const st            = Number(data.state);
  const currStartTime = Number(data.printStartTime   || 0);
  const currJobTime   = Number(data.printJobTime     || 0);
  const currSelfPct   = Number(data.withSelfTest      || 0);

  // タイマー全クリアユーティリティ
  const clearAllTimers = () => {
    [prepTimerId, checkTimerId, pauseTimerId, completionTimer]
      .forEach(id => clearInterval(id));
  };
  // 個別リセット
  const resetPrep       = () => { clearInterval(prepTimerId);    tsPrintStart = tsPrepEnd = null;           setStoredData("preparationTime",       null, true); };
  const resetCheck      = () => { clearInterval(checkTimerId);      tsCheckStart=tsCheckEnd=null; setStoredData("firstLayerCheckTime", null, true); };
  const resetPause      = () => { clearInterval(pauseTimerId);      tsPauseStart=null; totalPauseSeconds=0;  setStoredData("pauseTime",             null, true); };
  const resetCompletion = () => { clearInterval(completionTimer);  tsCompletion=null;         setStoredData("completionElapsedTime", null, true); };

  // (2.3) 準備時間タイマー
  // (2.3.1) 新規印刷開始検出
  if (
    st === PRINT_STATE_CODE.printStarted &&
    (prevPrintState !== st || currStartTime !== prevPrintStartTime)
  ) {
    console.debug(">>> (2.3.1) 印刷開始：準備タイマー起動");
    clearAllTimers();
    tsPrintStart = Date.now();
    totalPauseSeconds = 0;
    pushLog("印刷開始", "info");
    notificationManager.notify("printStarted");
    setStoredData("preparationTime", 0, true);
    prepTimerId = setInterval(() => {
      const sec = Math.floor((Date.now() - tsPrintStart)/1000);
      setStoredData("preparationTime", sec, true);
    }, 1000);
  }
  // (2.3.2) 準備完了判定
  if (tsPrintStart && !tsPrepEnd && currJobTime >= 1) {
    console.debug(">>> (2.3.2) 準備完了：準備タイマー停止");
    tsPrepEnd = Date.now();
    clearInterval(prepTimerId);
    const sec = Math.floor((tsPrepEnd - tsPrintStart)/1000);
    setStoredData("preparationTime", sec, true);
  }
  // (2.3.3) 中断時リセット
  if (
    tsPrintStart && currJobTime < 1 &&
    [PRINT_STATE_CODE.printDone, PRINT_STATE_CODE.printFailed].includes(st)
  ) {
    console.debug(">>> (2.3.3) 準備中断：リセット");
    resetPrep();
  }
  // (2.3.4) 一時停止→再開でシフト調整
  if (
    tsPrintStart && !tsPrepEnd &&
    prevPrintState === PRINT_STATE_CODE.printPaused &&
    st === PRINT_STATE_CODE.printStarted &&
    tsPauseStart
  ) {
    console.debug(">>> (2.3.4) 一時停止後に準備継続");
    clearInterval(pauseTimerId);
    const pausedSec = Math.floor((Date.now() - tsPauseStart)/1000);
    tsPrintStart += pausedSec * 1000;
    tsPauseStart = null;
  }
  // (2.3.5) 新規印刷開始で強制リセット
  if (currStartTime !== prevPrintStartTime) {
    resetPrep();
  }

  // (2.4) セルフテスト確認時間タイマー
  // (2.4.1) 開始判定
  if (
    tsPrepEnd && !tsCheckStart &&
    st === PRINT_STATE_CODE.printPaused &&
    currSelfPct > 0 && currSelfPct < 100
  ) {
    console.debug(">>> (2.4.1) セルフテストタイマー開始");
    tsCheckStart = Date.now();
    setStoredData("firstLayerCheckTime", 0, true);
    checkTimerId = setInterval(() => {
      setStoredData(
        "firstLayerCheckTime",
        Math.floor((Date.now() - tsCheckStart)/1000),
        true
      );
    }, 1000);
    notificationManager.notify("printFirstLayerCheckStarted");
  }
  // (2.4.2) 完了判定
  if (tsCheckStart && !tsCheckEnd && currSelfPct === 100) {
    console.debug(">>> (2.4.2) セルフテストタイマー停止");
    tsCheckEnd = Date.now();
    clearInterval(checkTimerId);
    setStoredData(
      "firstLayerCheckTime",
      Math.floor((tsCheckEnd - tsCheckStart)/1000),
      true
    );
    notificationManager.notify("printFirstLayerCheckCompleted");
  }
  // (2.4.3) 新規印刷 or 再開でリセット
  if (
    currStartTime !== prevPrintStartTime ||
    st === PRINT_STATE_CODE.printStarted
  ) {
    resetCheck();
  }

  // (2.5) 一時停止時間タイマー
  // (2.5.1) 停止開始
  if (st === PRINT_STATE_CODE.printPaused && !tsPauseStart) {
    console.debug(">>> (2.5.1) 一時停止タイマー開始");
    tsPauseStart = Date.now();
    setStoredData("pauseTime", 0, true);
    pauseTimerId = setInterval(() => {
      const elapsed = totalPauseSeconds + Math.floor((Date.now() - tsPauseStart)/1000);
      setStoredData("pauseTime", elapsed, true);
    }, 1000);
    notificationManager.notify("printPaused");
  }
  // (2.5.2) 停止解除
  if (
    tsPauseStart &&
    st !== PRINT_STATE_CODE.printPaused &&
    !(currSelfPct > 0 && currSelfPct < 100)
  ) {
    console.debug(">>> (2.5.2) 一時停止タイマー停止");
    totalPauseSeconds += Math.floor((Date.now() - tsPauseStart)/1000);
    clearInterval(pauseTimerId);
    setStoredData("pauseTime", totalPauseSeconds, true);
    tsPauseStart = null;
    notificationManager.notify("printResumed");
  }
  // (2.5.3) 新規印刷開始でリセット
  if (currStartTime !== prevPrintStartTime) {
    resetPause();
  }

  // (2.6) 完了後経過時間タイマー
  const DONE = new Set([
    PRINT_STATE_CODE.printDone,
    PRINT_STATE_CODE.printFailed,
  ]);

  // (2.6.1) 完了 or 失敗 → 開始
  if (DONE.has(st) && !tsCompletion) {
    console.debug(">>> (2.6.1) 完了後経過タイマー開始");
    tsCompletion = Date.now();
    setStoredData("completionElapsedTime", 0, true);

    completionTimer = setInterval(() => {
      setStoredData(
        "completionElapsedTime",
        Math.floor((Date.now() - tsCompletion)/1000),
        true
      );
    }, 1000);
    const evt = st === PRINT_STATE_CODE.printDone ? "printCompleted" : "printFailed";
    notificationManager.notify(evt);
  }
  // (2.6.2) Idle or 再開でリセット
  if (tsCompletion && !DONE.has(st)) {
    console.debug(">>> (2.6.2) 完了後経過タイマーリセット");
    resetCompletion();
  }

  // (2.7) 状態遷移通知・プレビュー更新・その他フィールド反映・履歴登録
  const prevState = machine.runtimeData.state;
  machine.runtimeData.state = String(st);
  handlePrintStateTransition(
    Number(prevState),
    st,
    pushLog,
    evt => notificationManager.notify(evt)
  );

  // (2.7.1) プレビュー X/Y/Z
  if (data.curPosition) {
    const pos = parseCurPosition(data.curPosition);
    if (pos) {
      setStoredData("positionX", { value: pos.x.toFixed(2), unit: "" });
      setStoredData("positionY", { value: pos.y.toFixed(2), unit: "" });
      setStoredData("positionZ", { value: pos.z.toFixed(2), unit: "" });
      updateXYPreview(pos.x, pos.y);
      updateZPreview(pos.z);
      machine.runtimeData.curPosition = data.curPosition;
    }
  }
  // (2.7.1b) プリンタモデルに基づくプレビュー設定
  if (data.model) {
    setPrinterModel(String(data.model));
  }
  // (2.7.2) その他フィールド一括反映
  Object.entries(data).forEach(([k, v]) => setStoredData(k, v, true));
  // (2.7.3) 進捗100%以上で履歴登録
  if (Number(data.printProgress ?? 0) >= 100) {
    const entry = { ...data };
    const extraKeys = [
      "preparationTime",
      "firstLayerCheckTime",
      "pauseTime",
      "completionElapsedTime",
      "actualStartTime",
      "initialLeftTime",
      "initialLeftAt",
      "predictedFinishEpoch",
      "estimatedRemainingTime",
      "estimatedCompletionTime"
    ];
    extraKeys.forEach(k => {
      const v = machine.storedData[k]?.rawValue;
      if (v !== undefined) entry[k] = v;
    });
    ["filamentId", "filamentColor", "filamentType"].forEach(k => {
      if (data[k] != null) entry[k] = data[k];
    });
    machine.historyData.push(entry);
  }

  // 次回比較用に保存
  prevPrintState     = st;
  prevPrintStartTime = currStartTime;
  prevSelfTestPct    = currSelfPct;

  // (2.8) 集約ロジックへ渡す
  ingestData(data);
}

/**
 * processError:
 * (3) errorMap 参照 → 日本語メッセージ生成
 *
 * @param {{errcode:number, key:number}} param
 * @returns {string} 日本語エラーメッセージ
 */
export function processError({ errcode, key }) {
  let msg = `エラー コード${errcode}, キー${key}:\n`;
  msg += typeof errorMap[errcode] === "function"
      ? errorMap[errcode]([errcode])
      : `不明なコード:${errcode}`;
  msg += "\n";
  msg += typeof errorMap[key] === "function"
      ? errorMap[key]([key])
      : `不明なキー:${key}`;
  return msg;
}
