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
  ensureMachineData,
  isNotificationSuppressed,
  setNotificationSuppressed,
  setStoredDataForHost,
  scopedById,
} from "./dashboard_data.js";
import {
  restoreUnifiedStorage,
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
import { getCurrentSpool, formatFilamentAmount, formatSpoolDisplayId } from "./dashboard_spool.js";

/**
 * Webhook 通知用の共通ペイロードを構築する。
 *
 * storedData から印刷状況・スプール情報を取得し、
 * 外部連携に必要な構造化フィールドを生成する。
 *
 * @private
 * @param {string} host - ホスト名キー
 * @param {object} [machine] - monitorData.machines[host]
 * @param {object} [opts] - 追加オプション
 * @param {boolean} [opts.includeSpool=false] - スプール情報を含めるか
 * @param {boolean} [opts.includeMaterial=false] - 消費量情報を含めるか
 * @param {boolean} [opts.includeLayer=false] - レイヤー情報を含めるか
 * @param {boolean} [opts.includeProgress=false] - 進捗情報を含めるか
 * @param {boolean} [opts.includeDuration=false] - 所要時間を含めるか
 * @returns {object} notify() に渡すペイロードオブジェクト
 */
function _buildNotifyPayload(host, machine, opts = {}) {
  const payload = { hostname: host };
  const sd = machine?.storedData;
  if (!sd) return payload;

  // ファイル名（常に含める）
  const fname = sd.printFileName?.rawValue || sd.fileName?.rawValue;
  if (fname) payload.filename = String(fname).split("/").pop();

  // スプール情報
  if (opts.includeSpool) {
    const spool = getCurrentSpool(host);
    if (spool) {
      const remainFmt = formatFilamentAmount(spool.remainingLengthMm, spool);
      const remainPct = spool.totalLengthMm > 0
        ? Number(((spool.remainingLengthMm / spool.totalLengthMm) * 100).toFixed(1)) : null;
      payload.spoolName = `${formatSpoolDisplayId(spool)} ${spool.name || ""}`.trim();
      payload.spoolId = spool.id;
      payload.spoolSerial = spool.serialNo;
      payload.spoolRemain = `${remainFmt.display}${remainPct != null ? ` (${remainPct.toFixed(0)}%)` : ""}`;
      payload.spoolRemain_mm = spool.remainingLengthMm;
      payload.spoolRemain_pct = remainPct;
      if (remainFmt.g != null) payload.spoolRemain_g = Number(remainFmt.g);
      payload.material = spool.materialName || spool.material || "";
    }
  }

  // 消費量情報
  if (opts.includeMaterial) {
    const usedMm = Number(sd.usedMaterialLength?.rawValue ?? sd.usagematerial?.rawValue ?? 0);
    if (usedMm > 0) {
      const spool = opts.includeSpool ? null : getCurrentSpool(host);
      const fmt = formatFilamentAmount(usedMm, spool || getCurrentSpool(host));
      payload.materialUsed = fmt.display;
      payload.materialUsed_mm = usedMm;
      if (fmt.g != null) payload.materialUsed_g = Number(fmt.g);
      if (fmt.cost != null) payload.materialUsed_cost = Number(fmt.cost);
      payload.materialUsed_currency = fmt.currency;
    }
  }

  // レイヤー情報
  if (opts.includeLayer) {
    const layer = sd.layer?.rawValue;
    const totalLayer = sd.TotalLayer?.rawValue;
    if (layer != null) payload.layer = Number(layer);
    if (totalLayer != null) payload.totalLayer = Number(totalLayer);
  }

  // 進捗情報
  if (opts.includeProgress) {
    const progress = sd.printProgress?.rawValue;
    if (progress != null) payload.printProgress = Number(progress);
  }

  // 所要時間
  if (opts.includeDuration) {
    const startTimeRaw = sd.printStartTime?.rawValue;
    if (startTimeRaw) {
      const startEpoch = Number(startTimeRaw) * 1000;
      payload.printStartTime_epoch = startEpoch;
      payload.duration_sec = Math.floor((Date.now() - startEpoch) / 1000);
    }
  }

  return payload;
}

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
  if (!_msgHostStates.has(hostname)) {
    const ms = _createMsgHostState();
    // localStorage からリロード前の状態を復元（通知再発火防止）
    try {
      const p = `msg_${hostname}_`;
      const st = localStorage.getItem(p + "prevPrintState");
      const tm = localStorage.getItem(p + "prevPrintStartTime");
      const sp = localStorage.getItem(p + "prevSelfTestPct");
      if (st != null) ms.prevPrintState = JSON.parse(st);
      if (tm != null) ms.prevPrintStartTime = JSON.parse(tm);
      if (sp != null) ms.prevSelfTestPct = JSON.parse(sp);
      const rr = localStorage.getItem(p + "removalReminderSent");
      if (rr === "true") ms._removalReminderSent = true;
      // 完了後経過タイムスタンプの復元
      const tc = localStorage.getItem(p + "tsCompletion");
      if (tc != null) ms.tsCompletion = Number(tc);
    } catch { /* 復元失敗は無視 */ }
    _msgHostStates.set(hostname, ms);
  }
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
  const host = hostname;
  if (!host) return;
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
  persistPrintResume(host);
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
/**
 * @deprecated handleMessage は統一パス化により死にコード。
 * handleSocketMessage → processData の直接呼び出しが全データを処理する。
 * 互換性のため export は維持するが、内部は空実装。
 * temporaryBuffer も不要（handleSocketMessage が hostKey で振り分け済み）。
 *
 * @param {object} _data 受信データ（未使用）
 */
export function handleMessage(_data) {
  // ★ 統一パス化完了: handleSocketMessage → processData で全ホスト処理済み。
  // この関数は呼び出されない。万一呼ばれた場合のためのフォールバック:
  if (_data?.hostname) {
    ensureMachineData(_data.hostname);
    processData(_data, _data.hostname);
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
  const host = hostname;
  if (!host) return;
  const machine = monitorData.machines[host];
  if (!machine) return;
  machine.runtimeData ??= { lastError: null };
  if (!('lastError' in machine.runtimeData)) {
    machine.runtimeData.lastError = null;
  }

  // 初回ホスト初期化完了後は該当ホストの通知抑制を解除
  // (handleMessage の初期化パスを通らない2台目以降のホストにも対応)
  if (_initializedHosts.has(host) && isNotificationSuppressed(host)) {
    setNotificationSuppressed(false, host);
  }

  // per-host 初期化（各ホスト初回のみ）
  // ★ 1台目は handleMessage() の初期化ブロックで処理されるが、
  //    2台目以降はここが唯一の初期化パス。両方で同等の処理を実行する。
  if (!_initializedHosts.has(host)) {
    _initializedHosts.add(host);
    console.info(`[processData] per-host 初期化: ${host}`);

    // ★ 初期化ブロック全体を try/catch で保護
    //    ここで例外が出てもデータ書き込み（L784以降）は続行する
    try {
      // storedData.hostname を確実に設定
      if (!machine.storedData?.hostname?.rawValue) {
        setStoredDataForHost(host, "hostname", host, true);
      }

      // storedData キーの事前作成
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

      // aggregator 状態復元
      restoreAggregatorState(host);
      restartAggregatorTimer();

      // 初回データに historyList/elapseVideoList があればマージ
      const baseUrl = `http://${getDeviceIp(host)}:${getHttpPort(host)}`;
      if (Array.isArray(data.historyList) && data.historyList.length > 0) {
        printManager.updateHistoryList(data.historyList, baseUrl, "print-current-container", host);
      }
      if (Array.isArray(data.elapseVideoList) && data.elapseVideoList.length > 0) {
        printManager.updateVideoList(data.elapseVideoList, baseUrl, host);
      }

      // 印刷再開状態の復元
      const curId = Number(data.printStartTime || 0) || null;
      restorePrintResume(host, curId);

      // 保存済み履歴の描画
      try {
        const allJobs = printManager.loadHistory(host);
        if (allJobs.length > 0) {
          const rawJobs = printManager.jobsToRaw(allJobs);
          printManager.renderHistoryTable(rawJobs, baseUrl, host);
        }
        const curContainer = scopedById("print-current-container", host);
        if (curContainer) {
          printManager.renderPrintCurrent(curContainer, host);
        }
      } catch (e) {
        console.debug(`[processData] 保存済み履歴描画スキップ (${host}):`, e.message);
      }

      // 初期化完了、このホストの通知抑制を解除
      setNotificationSuppressed(false, host);
    } catch (e) {
      console.error(`[processData] per-host 初期化エラー (${host}):`, e);
      // ★ 初期化が失敗してもデータ書き込みは続行する
      setNotificationSuppressed(false, host);
    }
  }

  const ms = _getMsgState(host);

  /** ホスト指定の setStoredData ラッパー */
  const _set = (key, value, isRaw = false, isFromEquipVal) => {
    setStoredDataForHost(host, key, value, isRaw, isFromEquipVal);
  };

  // ---- 完了後経過タイマーの復元処理 ------------------------------------
  // ★ completionElapsedTime は aggregator セクション4-4 に一本化。
  //   ここでは tsCompletion の復元のみ行い、setInterval は起動しない。
  //   リマインダーも aggregator 側で処理。
  if (ms.tsCompletion === null) {
    const storedPrev = Number(machine.storedData.prevPrintID?.rawValue ?? NaN);
    if (!isNaN(storedPrev)) {
      ms.prevPrintStartTime = storedPrev;
    }
    // historyData は揮発性のため、永続化された printStore.history も検索する
    const historyData = machine.historyData || [];
    const persistedHistory = machine.printStore?.history || [];
    const last = historyData[historyData.length - 1]
      || persistedHistory.find(j =>
        ms.prevPrintStartTime !== null && Number(j.id) === Number(ms.prevPrintStartTime));
    if (
      last &&
      ms.prevPrintStartTime !== null &&
      Number(last.id) === Number(ms.prevPrintStartTime) &&
      (last.finishTime || last.endtime)
    ) {
      const finStr = last.finishTime || (last.endtime ? new Date(Number(last.endtime) * 1000).toISOString() : null);
      const fin = finStr ? Date.parse(finStr) : NaN;
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
        pushLog("エラーが解消しました。", "info", false, host);
        notificationManager.notify("errorResolved", { hostname: host });
      } else {
        const msg = processError(data.err);
        pushLog(msg, "error", false, host);
        notificationManager.notify("errorOccurred", {
          hostname: host, error_code: errcode,
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
    persistPrintResume(host);
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
    try { localStorage.removeItem(`msg_${host}_tsCompletion`); } catch { /* ignore */ }
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
    pushLog("印刷開始", "info", false, host);
    notificationManager.notify("printStarted", _buildNotifyPayload(host, machine, {
      includeSpool: true
    }));
    _set("preparationTime", 0, true);

    // 現在ジョブを即座に保存（printFileName/fileName が同一メッセージに含まれていれば反映）
    {
      const curJob = printManager.loadCurrent(host) || {};
      curJob.id = currStartTime;
      curJob.startTime = new Date(currStartTime * 1000).toISOString();
      const wsFileName = data.printFileName || data.fileName;
      if (wsFileName) {
        curJob.filename = String(wsFileName).split("/").pop();
        curJob.rawFilename = String(wsFileName);
      } else if (!curJob.filename) {
        // storedData に既にファイル名があればそれを使う（WS キーは printFileName）
        const fn = machine.storedData.printFileName?.rawValue
          ?? machine.storedData.fileName?.rawValue;
        if (fn) {
          curJob.filename = String(fn).split("/").pop();
          curJob.rawFilename = String(fn);
        }
      }
      curJob.printfinish = null;  // null = 未確定/印刷中（0 だと ✗ 失敗表示になるバグ修正）
      printManager.saveCurrent(curJob, host);
      printManager.renderPrintCurrent(
        scopedById("print-current-container", host), host
      );
    }

    // 直ちに保存してリロード時の損失を防ぐ
    persistPrintResume(host);
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
    notificationManager.notify("printFirstLayerCheckStarted", { hostname: host });
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
      notificationManager.notify("printFirstLayerCheckCompleted", { hostname: host });
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
    notificationManager.notify("printPaused", _buildNotifyPayload(host, machine, {
      includeProgress: true, includeLayer: true
    }));
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
    notificationManager.notify("printResumed", _buildNotifyPayload(host, machine, {
      includeProgress: true, includeLayer: true
    }));
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
    // ★ completionElapsedTime の計算は dashboard_aggregator.js セクション4-4に一本化。
    //   ここではタイムスタンプの保存のみ行い、setInterval による更新は廃止。
    //   リマインダー通知も aggregator 側に移設。
    ms.tsCompletion = Date.now();
    try { localStorage.setItem(`msg_${host}_tsCompletion`, String(ms.tsCompletion)); } catch { /* ignore */ }
    const evt = st === PRINT_STATE_CODE.printDone ? "printCompleted" : "printFailed";
    const notifPayload = _buildNotifyPayload(host, machine, {
      includeSpool: true, includeMaterial: true,
      includeLayer: true, includeDuration: true
    });
    notificationManager.notify(evt, notifPayload);
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
    (msg, level) => pushLog(msg, level, false, host),
    evt => notificationManager.notify(evt, { hostname: host }),
    host
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
  // printFileName / fileName / printStartTime が受信された際、printManager が
  // 保持する現在印刷中ジョブ情報を更新して UI へ即反映させる。
  // WS デバイスは printFileName キーでファイル名を送信する。
  const wsFileName = data.printFileName || data.fileName;
  if (wsFileName || data.printStartTime) {
    const curJob = printManager.loadCurrent(host) || {};
    let changed = false;
    if (wsFileName) {
      curJob.filename = String(wsFileName).split("/").pop();
      curJob.rawFilename = String(wsFileName);
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
    // ★ E1: フィラメント情報の消失防止 — 3段階フォールバック
    // printStore → historyData既存エントリ → 受信データ の優先順で復元
    const savedJobs = printManager.loadHistory(host);
    const savedJob = savedJobs.find(j => String(j.id) === String(entry.id));
    // historyData から最新の一致エントリを逆順検索
    let existingEntry = null;
    for (let i = machine.historyData.length - 1; i >= 0; i--) {
      if (machine.historyData[i].id === entry.id) {
        existingEntry = machine.historyData[i];
        break;
      }
    }
    if (savedJob?.filamentInfo?.length) {
      // 1) printStore に保存済み → 最優先
      entry.filamentInfo = savedJob.filamentInfo;
      entry.filamentId    = savedJob.filamentId;
      entry.filamentColor = savedJob.filamentColor;
      entry.filamentType  = savedJob.filamentType;
    } else if (existingEntry?.filamentInfo?.length) {
      // 2) historyData に既存エントリがある → そちらを保護
      entry.filamentInfo = existingEntry.filamentInfo;
      entry.filamentId    = existingEntry.filamentId;
      entry.filamentColor = existingEntry.filamentColor;
      entry.filamentType  = existingEntry.filamentType;
    } else {
      // 3) どちらにもない → 受信データから取得
      ["filamentId", "filamentColor", "filamentType"].forEach(k => {
        if (data[k] != null) entry[k] = data[k];
      });
    }
    // 同一ジョブIDの重複登録を防止する
    if (!machine.historyData.find(h => h.id === entry.id)) {
      machine.historyData.push(entry);
      const baseUrl = `http://${getDeviceIp(host)}:${getHttpPort(host)}`;
      printManager.updateHistoryList([entry], baseUrl, "print-current-container", host);
      persistPrintResume(host);
    }
  }

  // 次回比較用に保存（リロード時の再通知防止のため localStorage にも永続化）
  ms.prevPrintState     = st;
  ms.prevPrintStartTime = currStartTime;
  ms.prevSelfTestPct    = currSelfPct;
  try {
    const msPrefix = `msg_${host}_`;
    localStorage.setItem(msPrefix + "prevPrintState", JSON.stringify(st));
    localStorage.setItem(msPrefix + "prevPrintStartTime", JSON.stringify(currStartTime));
    localStorage.setItem(msPrefix + "prevSelfTestPct", JSON.stringify(currSelfPct));
  } catch { /* ストレージ書き込みエラーは無視 */ }

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
