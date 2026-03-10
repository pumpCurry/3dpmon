/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 メッセージ処理モジュール
 * @file dashboard_msg_handler.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_msg_handler
 *
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
* @version 1.390.785 (PR #366)
* @since   1.390.214 (PR #95)
* @lastModified 2026-03-11 01:00:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

/** -----------------------------------------------------------
 * 改修履歴
 * | 日付 (JST)       | PR   | 概要                       |
 * |------------------|------|----------------------------|
 * | 2025-06-28       | #223 | タイマー処理ロジック改修   |
 * ----------------------------------------------------------- */
"use strict";

import errorMap from "./3dp_errorcode.js";
import {
  monitorData,
  currentHostname,
  setCurrentHostname,
  PLACEHOLDER_HOSTNAME,
  setNotificationSuppressed,
  setStoredDataForHost,
  scopedById,
} from "./dashboard_data.js";
import {
  restoreUnifiedStorage,
  restoreLegacyStoredData,
  cleanupLegacy,
} from "./dashboard_storage.js";
import { pushLog } from "./dashboard_log_util.js";
import { notificationManager } from "./dashboard_notification_manager.js";
import { handlePrintStateTransition } from "./dashboard_printstatus.js";
import { parseCurPosition, getCurrentTimestamp } from "./dashboard_utils.js";
import {
  updateXYPreview,
  updateZPreview,
  setPrinterModel
} from "./dashboard_stage_preview.js";
import { PRINT_STATE_CODE } from "./dashboard_ui_mapping.js";
import {
  ingestData,
  restoreAggregatorState,
  restartAggregatorTimer,
  persistAggregatorState,
  setHistoryPersistFunc,
  aggregatorUpdate,
  getCurrentPrintID,
} from "./dashboard_aggregator.js";
import { restorePrintResume, persistPrintResume } from "./3dp_dashboard_init.js";
import * as printManager from "./dashboard_printmanager.js";
import { getDeviceIp, getHttpPort } from "./dashboard_connection.js";

/**
 * WS受信データのうち storedData に格納すべきでないキーのセット。
 * - 配列型フィールド（printManager で別途処理）
 * - 内部プロトコルフィールド
 * - 別途パース・分解して格納済みのフィールド
 *
 * @constant {Set<string>}
 * @private
 */
const _WS_SKIP_KEYS = new Set([
  "hostname",         // ホスト識別用、storedData 不要
  "ModeCode",         // プロトコル種別（heart_beat 等）
  "err",              // 2.2 でエラー処理済み
  "historyList",      // 配列、printManager で処理
  "elapseVideoList",  // 配列、printManager で処理
  "curPosition",      // 2.7.1 で positionX/Y/Z に分解済み
  "gcodeFileList",    // 配列、printManager で処理
  "reqGcodeFileInfo", // リクエストフラグ、データではない
  "reqHistory",       // リクエストフラグ、データではない
]);

// ---------------------------------------------------------------------------
// per-host メッセージハンドラ状態
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} MsgHandlerHostState
 * @property {number|null} prepTimerId        準備タイマーID
 * @property {number|null} checkTimerId       セルフテストタイマーID
 * @property {number|null} pauseTimerId       一時停止タイマーID
 * @property {number|null} completionTimer    完了後タイマーID
 * @property {number|null} tsPrintStart       印刷開始タイムスタンプ
 * @property {number|null} tsPrepEnd          準備完了タイムスタンプ
 * @property {number|null} tsCheckStart       セルフテスト開始タイムスタンプ
 * @property {number|null} tsCheckEnd         セルフテスト完了タイムスタンプ
 * @property {number}      totalCheckSeconds  セルフテスト時間累計
 * @property {number|null} tsPauseStart       一時停止開始タイムスタンプ
 * @property {number|null} tsCompletion       完了タイムスタンプ
 * @property {number}      totalPauseSeconds  一時停止時間累計
 * @property {number|null} prevPrintState     前回印刷状態
 * @property {number|null} prevPrintStartTime 前回印刷開始時刻
 * @property {number|null} prevSelfTestPct    前回セルフテスト進捗
 */

/** @type {Map<string, MsgHandlerHostState>} */
const _msgHostStates = new Map();

/** 初期化済みホスト名セット（processData で per-host 初期化を1回だけ実行） */
const _initializedHosts = new Set();

/**
 * 空の MsgHandlerHostState を生成する。
 * @private
 * @returns {MsgHandlerHostState}
 */
function _createMsgHostState() {
  return {
    prepTimerId: null, checkTimerId: null, pauseTimerId: null, completionTimer: null,
    tsPrintStart: null, tsPrepEnd: null,
    tsCheckStart: null, tsCheckEnd: null, totalCheckSeconds: 0,
    tsPauseStart: null, tsCompletion: null, totalPauseSeconds: 0,
    prevPrintState: null, prevPrintStartTime: null, prevSelfTestPct: null
  };
}

/**
 * 指定ホストの MsgHandlerHostState を返す（無ければ作成）。
 * @private
 * @param {string} hostname
 * @returns {MsgHandlerHostState}
 */
function _getMsgState(hostname) {
  if (!_msgHostStates.has(hostname)) _msgHostStates.set(hostname, _createMsgHostState());
  return _msgHostStates.get(hostname);
}

/**
 * persistHistoryTimers:
 *   現在の印刷IDに対応する履歴エントリへタイマー情報をマージし、
 *   永続化を即時実行します。F5 リロードによる消失を防ぐ目的です。
 *   aggregator の内部状態も保存するため、次回復元時にタイマー進捗を
 *   失わないようにします。
 *
 * @private
 * @param {number} printId - 印刷開始時刻を元にしたジョブID
 * @returns {void}
 */
function persistHistoryTimers(printId, hostname) {
  if (!printId) return;
  const host = hostname || currentHostname;
  const machine = monitorData.machines[host];
  if (!machine) return;

  let entry = machine.historyData.find(h => h.id === printId);
  if (!entry) {
    entry = { id: printId };
    machine.historyData.push(entry);
  }
  [
    "preparationTime",
    "firstLayerCheckTime",
    "pauseTime",
    "actualStartTime",
  ].forEach(key => {
    const v = machine.storedData[key]?.rawValue;
    if (v != null) entry[key] = v;
  });
  const baseUrl = `http://${getDeviceIp(host)}:${getHttpPort(host)}`;
  if (
    entry.filename ||
    (Array.isArray(entry.filamentInfo) && entry.filamentInfo.length > 0)
  ) {
    printManager.updateHistoryList([entry], baseUrl, "print-current-container", host);
  }
  persistPrintResume();
  persistAggregatorState(host);
  // 値を保存したら即座に画面へ反映する
  try {
    aggregatorUpdate();
  } catch (e) {
    console.error("aggregatorUpdate error", e);
  }
}

// aggregator へ履歴永続化フックを登録
setHistoryPersistFunc(persistHistoryTimers);

/**
 * handleMessage:
 * (1) ハンドリング前準備
 *     - 初回受信で hostname を設定し、バッファをフラッシュ
 *     - 印刷再開情報を復元
 *     - 以降は processData() へ
 *     - hostname が変化した場合は即座に現在ホストを更新
 *
 * @param {object} data 受信データ
 */
export function handleMessage(data) {
  // (1a) 初回ホスト設定
  if ((currentHostname === null || currentHostname === PLACEHOLDER_HOSTNAME) && data.hostname) {

    // 初期化中は通知を抑制する
    setNotificationSuppressed(true);

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

    const baseUrl = `http://${getDeviceIp(initHost)}`;
    if (bufHistory.length) {
      printManager.updateHistoryList(bufHistory, baseUrl, "print-current-container", initHost);
    }
    if (bufVideos.length) {
      printManager.updateVideoList(bufVideos, baseUrl, initHost);
    }


    // restoreAggregatorState() のあとでキー初期化 → 以降は必ず storedData[key] が存在
    const initKeys = [
      "preparationTime","firstLayerCheckTime","pauseTime","completionElapsedTime",
      "actualStartTime","initialLeftTime","initialLeftAt",
      "predictedFinishEpoch","estimatedRemainingTime","estimatedCompletionTime"
    ];
    const initHost = data.hostname || currentHostname;
    const sd = monitorData.machines[initHost]?.storedData || {};
    initKeys.forEach(key => {
      // 既に復元済みの値がある場合は保持し、存在しないキーのみ初期化する
      if (!(key in sd)) {
        setStoredDataForHost(initHost, key, null, true);
        setStoredDataForHost(initHost, key, null, false);
      }
    });

    restartAggregatorTimer();
    const curId = Number(data.printStartTime || 0) || null;
    restorePrintResume(curId);

    // 保存済み履歴と現在印刷を表示（initHost は上で定義済み）
    const baseUrlStored = `http://${getDeviceIp(initHost)}:${getHttpPort(initHost)}`;
    const jobs = printManager.loadHistory(initHost);
    if (jobs.length) {
      const raw = printManager.jobsToRaw(jobs);
      printManager.renderHistoryTable(raw, baseUrlStored, initHost);
    }
    printManager.renderPrintCurrent(
      scopedById("print-current-container", initHost), initHost
    );

    // 初期化完了、通知抑制を解除
    setNotificationSuppressed(false);

  }

  // (1a-2) 既存ホスト名と異なる hostname を受信した場合は更新する
  if (data.hostname && data.hostname !== currentHostname) {
    setCurrentHostname(data.hostname);
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
 *   WebSocket から受信した JSON データを解析し、各種タイマー管理と
 *   UI 更新、履歴登録、通知発火を行う中心関数。
 *
 * 【詳細説明】
 * - heartbeat のみのデータを簡易更新
 * - エラー通知とログの出力
 * - 準備／セルフテスト／一時停止／完了経過 各タイマーの更新
 * - 進捗情報やプレビューの反映
 *
 * @function processData
 * @param {object} data - WebSocket 受信データオブジェクト
 * @returns {void}
 */
export function processData(data, hostname) {
  const host = hostname || currentHostname;
  const machine = monitorData.machines[host];
  if (!machine) return;
  machine.runtimeData ??= { lastError: null };
  if (!('lastError' in machine.runtimeData)) {
    machine.runtimeData.lastError = null;
  }

  // per-host 初期化（各ホスト初回のみ）: storedData キーの事前作成
  if (!_initializedHosts.has(host)) {
    _initializedHosts.add(host);
    const initKeys = [
      "preparationTime","firstLayerCheckTime","pauseTime","completionElapsedTime",
      "actualStartTime","initialLeftTime","initialLeftAt",
      "predictedFinishEpoch","estimatedRemainingTime","estimatedCompletionTime"
    ];
    const sd = machine.storedData || {};
    initKeys.forEach(key => {
      if (!(key in sd)) {
        setStoredDataForHost(host, key, null, true);
        setStoredDataForHost(host, key, null, false);
      }
    });
    restartAggregatorTimer();
  }

  const ms = _getMsgState(host);

  /** ホスト指定の setStoredData ラッパー */
  const _set = (key, value, isRaw = false, isFromEquipVal) => {
    setStoredDataForHost(host, key, value, isRaw, isFromEquipVal);
  };

  // ---- 完了後経過タイマーの復元処理 ------------------------------------
  if (ms.tsCompletion === null) {
    const storedPrev = Number(machine.storedData.prevPrintID?.rawValue ?? NaN);
    if (!isNaN(storedPrev)) {
      ms.prevPrintStartTime = storedPrev;
    }
    const last = machine.historyData[machine.historyData.length - 1];
    if (
      last &&
      ms.prevPrintStartTime !== null &&
      Number(last.id) === Number(ms.prevPrintStartTime) &&
      last.finishTime
    ) {
      const fin = Date.parse(last.finishTime);
      if (!isNaN(fin)) {
        ms.tsCompletion = fin;
        setStoredDataForHost(
          host,
          "completionElapsedTime",
          Math.floor((Date.now() - fin) / 1000),
          true
        );
      }
    }
  }

  // (2.1) heartbeat のみ処理
  if (data.ModeCode === "heart_beat") {
    machine.runtimeData.lastHeartbeat = getCurrentTimestamp();
    return;
  }

  // (2.2) エラー処理：常にログ出力 → 通知は設定に応じて
  if (data.err) {
    const { errcode, key } = data.err;
    const prev = machine.runtimeData.lastError;
    const isSame = prev && prev.errcode === errcode && prev.key === key;
    machine.runtimeData.lastError = { errcode, key };
    if (!isSame) {
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
  }

  // 数値化／前回値取得
  const st            = Number(data.state);
  const currStartTime = Number(
    data.printStartTime ?? getCurrentPrintID(host) ?? 0
  );
  const currJobTime   = Number(data.printJobTime     || 0);
  const currSelfPct   = Number(data.withSelfTest      || 0);
  const device        = Number(data.deviceState      || 0);

  // タイマー全クリアユーティリティ
  const clearAllTimers = () => {
    [ms.prepTimerId, ms.checkTimerId, ms.pauseTimerId, ms.completionTimer]
      .forEach(id => clearInterval(id));
  };
  // 個別リセット
  const resetPrep       = () => {
    clearInterval(ms.prepTimerId);
    ms.tsPrintStart = ms.tsPrepEnd = null;
    // 値の消失を防ぐため storedData は保持したままにする
    persistPrintResume();
    persistAggregatorState(host);
  };
  const resetCheck      = () => {
    clearInterval(ms.checkTimerId);
    ms.tsCheckStart = ms.tsCheckEnd = null;
    ms.totalCheckSeconds = 0;
    // storedData の値は aggregator 側で管理する
  };
  const resetPause      = () => {
    clearInterval(ms.pauseTimerId);
    ms.tsPauseStart = null;
    ms.totalPauseSeconds = 0;
    // storedData の値は保持し、新しい印刷時に aggregator がクリア
  };
  const resetCompletion = () => {
    clearInterval(ms.completionTimer);
    ms.tsCompletion = null;
    // 完了後経過時間は次の印刷開始まで保持
  };

  // (2.3) 準備時間タイマー
  // (2.3.1) 新規印刷開始検出
  const initialized = ms.prevPrintState !== null && ms.prevPrintStartTime !== null;

  if (
    st === PRINT_STATE_CODE.printStarted &&
    (ms.prevPrintState !== st || currStartTime !== ms.prevPrintStartTime)
  ) {
    console.debug(">>> (2.3.1) 印刷開始：準備タイマー起動");
    clearAllTimers();
    ms.tsPrintStart = Date.now();
    ms.totalPauseSeconds = 0;
    pushLog("印刷開始", "info");
    notificationManager.notify("printStarted");
    _set("preparationTime", 0, true);
    // 直ちに保存してリロード時の損失を防ぐ
    persistPrintResume();
    persistAggregatorState(host);
    ms.prepTimerId = setInterval(() => {
      const sec = Math.floor((Date.now() - ms.tsPrintStart)/1000);
      _set("preparationTime", sec, true);
    }, 1000);
  }
  // (2.3.2) 準備完了判定
  if (ms.tsPrintStart && !ms.tsPrepEnd && currJobTime >= 1) {
    console.debug(">>> (2.3.2) 準備完了：準備タイマー停止");
    ms.tsPrepEnd = Date.now();
    clearInterval(ms.prepTimerId);
    const sec = Math.floor((ms.tsPrepEnd - ms.tsPrintStart)/1000);
    _set("preparationTime", sec, true);
    persistHistoryTimers(currStartTime, host);
  }
  // (2.3.3) 中断時リセット
  if (
    ms.tsPrintStart && currJobTime < 1 &&
    [PRINT_STATE_CODE.printDone, PRINT_STATE_CODE.printFailed].includes(st)
  ) {
    console.debug(">>> (2.3.3) 準備中断：リセット");
    resetPrep();
  }
  // (2.3.4) 一時停止→再開でシフト調整
  if (
    ms.tsPrintStart && !ms.tsPrepEnd &&
    ms.prevPrintState === PRINT_STATE_CODE.printPaused &&
    st === PRINT_STATE_CODE.printStarted &&
    ms.tsPauseStart
  ) {
    console.debug(">>> (2.3.4) 一時停止後に準備継続");
    clearInterval(ms.pauseTimerId);
    const pausedSec = Math.floor((Date.now() - ms.tsPauseStart)/1000);
    ms.tsPrintStart += pausedSec * 1000;
    ms.tsPauseStart = null;
  }
  // (2.3.5) 新規印刷開始で強制リセット
  if (initialized && currStartTime !== ms.prevPrintStartTime) {
    resetPrep();
  }

  // (2.4) セルフテスト確認時間タイマー
  // (2.4.1) 開始判定
  if (
    ms.tsPrepEnd &&
    st === PRINT_STATE_CODE.printPaused &&
    currSelfPct >= 30 && currSelfPct <= 39 &&
    !ms.tsCheckStart
  ) {
    console.debug(">>> (2.4.1) セルフテストタイマー開始");
    ms.tsCheckStart = Date.now();
    ms.checkTimerId = setInterval(() => {
      const elapsed = ms.totalCheckSeconds + Math.floor((Date.now() - ms.tsCheckStart)/1000);
      _set("firstLayerCheckTime", elapsed, true);
    }, 1000);
    notificationManager.notify("printFirstLayerCheckStarted");
  }
  // (2.4.2) 完了判定
  if (
    ms.tsCheckStart &&
    (currSelfPct < 30 || currSelfPct > 39 || st !== PRINT_STATE_CODE.printPaused)
  ) {
    console.debug(">>> (2.4.2) セルフテストタイマー停止");
    ms.totalCheckSeconds += Math.floor((Date.now() - ms.tsCheckStart)/1000);
    clearInterval(ms.checkTimerId);
    _set("firstLayerCheckTime", ms.totalCheckSeconds, true);
    persistHistoryTimers(currStartTime, host);
    ms.tsCheckStart = null;
    ms.tsCheckEnd = Date.now();
    if (currSelfPct >= 100) {
      notificationManager.notify("printFirstLayerCheckCompleted");
    }
  }
  // (2.4.3) 新規印刷 or 再開でリセット
  if (initialized && currStartTime !== ms.prevPrintStartTime) {
    resetCheck();
  }

  // (2.5) 一時停止時間タイマー
  // (2.5.1) 停止開始
  if (
    ms.tsPrepEnd &&
    st === PRINT_STATE_CODE.printPaused &&
    (currSelfPct === 0 || currSelfPct === 100) &&
    !ms.tsPauseStart
  ) {
    console.debug(">>> (2.5.1) 一時停止タイマー開始");
    ms.tsPauseStart = Date.now();
    ms.pauseTimerId = setInterval(() => {
      const elapsed = ms.totalPauseSeconds + Math.floor((Date.now() - ms.tsPauseStart)/1000);
      _set("pauseTime", elapsed, true);
    }, 1000);
    notificationManager.notify("printPaused");
    persistHistoryTimers(currStartTime, host);
  }
  // (2.5.2) 停止解除
  if (
    ms.tsPauseStart &&
    (st !== PRINT_STATE_CODE.printPaused || (currSelfPct !== 0 && currSelfPct !== 100))
  ) {
    console.debug(">>> (2.5.2) 一時停止タイマー停止");
    ms.totalPauseSeconds += Math.floor((Date.now() - ms.tsPauseStart)/1000);
    clearInterval(ms.pauseTimerId);
    _set("pauseTime", ms.totalPauseSeconds, true);
    persistHistoryTimers(currStartTime, host);
    ms.tsPauseStart = null;
    notificationManager.notify("printResumed");
  }
  // (2.5.3) 新規印刷開始でリセット
  if (initialized && currStartTime !== ms.prevPrintStartTime) {
    resetPause();
  }

  // (2.6) 完了後経過時間タイマー
  const DONE = new Set([
    PRINT_STATE_CODE.printDone,
    PRINT_STATE_CODE.printFailed,
  ]);

  // (2.6.1) 完了 or 失敗 → 開始
  if (
    device === PRINT_STATE_CODE.printIdle &&
    DONE.has(st) &&
    !ms.tsCompletion
  ) {
    console.debug(">>> (2.6.1) 完了後経過タイマー開始");
    ms.tsCompletion = Date.now();
    _set("completionElapsedTime", 0, true);

    ms.completionTimer = setInterval(() => {
      _set(
        "completionElapsedTime",
        Math.floor((Date.now() - ms.tsCompletion)/1000),
        true
      );
    }, 1000);
    const evt = st === PRINT_STATE_CODE.printDone ? "printCompleted" : "printFailed";
    notificationManager.notify(evt);
    persistHistoryTimers(currStartTime, host);
  }
  // (2.6.2) Idle or 再開でリセット
  if (
    ms.tsCompletion &&
    (st === PRINT_STATE_CODE.printStarted ||
     (ms.prevPrintState === PRINT_STATE_CODE.printPaused && st !== PRINT_STATE_CODE.printPaused))
  ) {
    console.debug(">>> (2.6.2) 完了後経過タイマーリセット");
    resetCompletion();
  }

  // (2.7) 状態遷移通知・プレビュー更新・その他フィールド反映・履歴登録
  const prevState = machine.runtimeData.state;
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
      _set("positionX", { value: pos.x.toFixed(2), unit: "" });
      _set("positionY", { value: pos.y.toFixed(2), unit: "" });
      _set("positionZ", { value: pos.z.toFixed(2), unit: "" });
      updateXYPreview(pos.x, pos.y, host);
      updateZPreview(pos.z, host);
      machine.runtimeData.curPosition = data.curPosition;
    }
  }
  // (2.7.2) プリンタモデルに基づくプレビュー設定
  if (data.model) {
    setPrinterModel(String(data.model), host);
  }

  // (2.7.3) その他フィールド一括反映
  // 重要：ここで得られた値のみ、setStoredDataの第4フラグ(機器から得られる情報)をフラグONとする
  // _WS_SKIP_KEYS に含まれるキー（配列データ・内部プロトコル・パース済みフィールド）は
  // storedData に格納せず、dirty key への追加も回避する
  for (const [k, v] of Object.entries(data)) {
    if (_WS_SKIP_KEYS.has(k)) continue;
    // 配列・オブジェクト型（err以外）はスカラー値ではないため storedData に格納しない
    if (v !== null && typeof v === "object" && !Array.isArray(v) && k !== "err") continue;
    if (Array.isArray(v)) continue;
    _set(k, v, true, true);
  }

  // --- 新しい印刷情報が後から届いた場合の現在ジョブ更新処理 ----------------
  // fileName または printStartTime が受信された際、printManager が保持する
  // 現在印刷中ジョブ情報を更新して UI へ即反映させる。印刷開始直後に情報が
  // 遅延して届くケースで、ファイル名や開始時刻が不明のまま表示され続ける
  // 問題を解消する目的で追加。
  if (data.fileName || data.printStartTime) {
    const curJob = printManager.loadCurrent(host) || {};
    let changed = false;
    if (data.fileName) {
      curJob.filename = String(data.fileName).split("/").pop();
      curJob.rawFilename = String(data.fileName);
      changed = true;
    }
    if (data.printStartTime) {
      const start = Number(data.printStartTime);
      if (!isNaN(start) && start > 0) {
        curJob.id = start;
        curJob.startTime = new Date(start * 1000).toISOString();
        changed = true;
      }
    }
    if (changed) {
      printManager.saveCurrent(curJob, host);
      printManager.renderPrintCurrent(
        scopedById("print-current-container", host), host
      );
    }
  }

  // (2.7.4) 進捗100%以上で履歴登録（重複防止付き）
  if (Number(data.printProgress ?? 0) >= 100) {
    const entry = { ...data };
    entry.id = Number(data.printStartTime || 0);
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
    // 同一ジョブIDの重複登録を防止する
    if (!machine.historyData.find(h => h.id === entry.id)) {
      machine.historyData.push(entry);
      const baseUrl = `http://${getDeviceIp(host)}:${getHttpPort(host)}`;
      printManager.updateHistoryList([entry], baseUrl, "print-current-container", host);
      persistPrintResume();
    }
  }

  // 次回比較用に保存
  ms.prevPrintState     = st;
  ms.prevPrintStartTime = currStartTime;
  ms.prevSelfTestPct    = currSelfPct;

  // (2.8) 集約ロジックへ渡す
  ingestData(data, host);

  // runtimeData.state は ingestData 後に更新することで
  // aggregator 側が前回状態を正しく参照できるようにする
  machine.runtimeData.state = String(st);
}

/**
 * processError:
 * (3) errorMap 参照 → 日本語メッセージ生成
 *
 * @param {{errcode:number, key:number}} param
 * @returns {string} 日本語エラーメッセージ
 */
export function processError({ errcode, key }) {
  let msg = `エラー コード${errcode}, キー${key}: `;
  msg += typeof errorMap[errcode] === "function"
      ? errorMap[errcode]([errcode])
      : `不明なコード:${errcode}`;
  msg += " ";
  msg += typeof errorMap[key] === "function"
      ? errorMap[key]([key])
      : `不明なキー:${key}`;
  return msg.trim();
}
