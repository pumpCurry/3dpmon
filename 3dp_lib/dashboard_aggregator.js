/** 2025-07-13 03:12:56
 * @description 3Dプリンタ監視ツール 3dpmon 用 集計管理モジュール
 * @file dashboard_aggregator.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_aggregator
 *
 * 【機能内容サマリ】
 * - 印刷ワークフローの各種タイマーを集計
 * - 実印刷開始時刻や終了予測を計算
 * - 状態更新時に UI 反映と通知を発火
 *
 * 【公開関数一覧】
 * - {@link ingestData}：受信データの集約処理
 * - {@link aggregatorUpdate}：UI 更新と永続化
 * - {@link restoreAggregatorState}：状態の復元
 * - {@link persistAggregatorState}：状態の保存
 * - {@link restartAggregatorTimer}：集約ループ再開
 * - {@link stopAggregatorTimer}：集約ループ停止
 * - {@link setHistoryPersistFunc}：履歴永続化関数の登録
 * - {@link getCurrentPrintID}：現在の印刷IDを取得
 *
* @version 1.390.787 (PR #367)
* @since   1.390.193 (PR #86)
* @lastModified 2026-03-12
 * -----------------------------------------------------------
 * @todo
 * - none
 */
"use strict";

import { monitorData, setStoredDataForHost } from "./dashboard_data.js";
import { clearNewClasses, updateStoredDataToDOM } from "./dashboard_ui.js";
import { saveUnifiedStorage, loadPrintCurrent } from "./dashboard_storage.js";
import { updateTemperatureGraphFromStoredData, switchChartHost } from "./dashboard_chart.js";
import { checkUpdatedFields, formatDuration } from "./dashboard_utils.js";
import { notificationManager } from "./dashboard_notification_manager.js";
import { formatDurationSimple } from "./dashboard_utils.js";
import { PRINT_STATE_CODE } from "./dashboard_ui_mapping.js";
import { PLACEHOLDER_HOSTNAME } from "./dashboard_data.js";
import { showFilamentChangeDialog } from "./dashboard_filament_change.js";
import {
  getCurrentSpool,
  reserveFilament,
  finalizeFilamentUsage,
  autoCorrectCurrentSpool,
  addUsageSnapshot,
  beginExternalPrint,
  formatFilamentAmount,
  formatSpoolDisplayId
} from "./dashboard_spool.js";
import { getConnectionState } from "./dashboard_connection.js";

// ---------------------------------------------------------------------------
// 状態変数／タイムスタンプ定義（per-host 管理）
// ---------------------------------------------------------------------------

/** aggregatorUpdate 用タイマー ID */
let aggregatorTimer = null;

/** 履歴永続化用フック */
let historyPersistFunc = null;

/**
 * setHistoryPersistFunc:
 *   履歴永続化関数を登録します。
 *   dashboard_msg_handler からセットされます。
 *
 * @param {(printId:number)=>void} fn - 永続化関数
 */
export function setHistoryPersistFunc(fn) {
  historyPersistFunc = typeof fn === "function" ? fn : null;
}

// 通知閾値定数（全ホスト共通）
const PROGRESS_MILESTONES    = [25, 50, 75, 80, 90, 95, 98];
const TIME_THRESHOLDS        = [10, 5, 3, 1];
const TEMP_MILESTONES        = [0.8, 0.9, 0.95, 0.98, 1.0];
/** スナップショット記録間隔 [秒] */
const USAGE_SNAPSHOT_INTERVAL = 30;
/** ステータス Webhook 送信間隔 [秒] (デフォルト30秒) */
const STATUS_SNAPSHOT_INTERVAL_SEC = 30;
/** 最終ステータス Webhook 送信時刻 */
let _lastStatusSnapshotEpoch = 0;

// ---------------------------------------------------------------------------
// per-host 状態オブジェクト
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AggregatorHostState
 * @property {number|null} tsPrepStart       準備開始タイムスタンプ
 * @property {number}      totalPrepSec      準備時間累計 [秒]
 * @property {number|null} tsCheckStart      自己テスト開始タイムスタンプ
 * @property {number}      totalCheckSec     自己テスト時間累計 [秒]
 * @property {number|null} tsPauseStart      一時停止開始タイムスタンプ
 * @property {number}      totalPauseSec     一時停止時間累計 [秒]
 * @property {number|null} tsCompleteStart   完了開始タイムスタンプ
 * @property {number|null} actualStartEpoch  実印刷開始エポック
 * @property {number|null} initialLeftSec    初回残り時間 [秒]
 * @property {number|null} initialLeftEpoch  初回残り時間取得エポック
 * @property {number|null} prevPrintID       前回印刷ID
 * @property {number}      lastPrintState    最後の印刷状態コード
 * @property {number}      prevProgress      前回進捗率
 * @property {number}      lastProgressTimestamp  最終進捗タイムスタンプ
 * @property {Set<number>} notifiedProgressMilestones  通知済み進捗マイルストーン
 * @property {number|null} prevRemainingSec  前回残り時間
 * @property {Set<number>} notifiedTimeThresholds  通知済み残り時間閾値
 * @property {Set<number>} notifiedTempMilestones  通知済み温度マイルストーン
 * @property {number|null} prevMaterialStatus  前回フィラメント状態
 * @property {number|null} currentMaterialStatus  現在フィラメント状態
 * @property {number|null} filamentOutTimer  フィラメント切れタイマーID
 * @property {boolean}     filamentLowWarned  フィラメント残量警告済み
 * @property {number}      lastUsageSnapshotSec  最終スナップショット時刻
 * @property {string|null} snapshotPrintId  スナップショット対象印刷ID
 * @property {number|null} prevUsedMaterialLength  前回フィラメント使用長
 * @property {number}      prevUsageProgress  前回使用量進捗
 * @property {number}      accumulatedUsedMaterial  累積フィラメント使用量
 */

/**
 * ホスト別に集約状態を保持する Map。
 * @type {Map<string, AggregatorHostState>}
 * @private
 */
const _hostStates = new Map();

/**
 * 空の AggregatorHostState を生成する。
 * @private
 * @returns {AggregatorHostState}
 */
function _createHostState() {
  return {
    tsPrepStart: null, totalPrepSec: 0,
    tsCheckStart: null, totalCheckSec: 0,
    tsPauseStart: null, totalPauseSec: 0,
    tsCompleteStart: null,
    actualStartEpoch: null,
    initialLeftSec: null, initialLeftEpoch: null,
    prevPrintID: null,
    lastPrintState: PRINT_STATE_CODE.printIdle,
    prevProgress: 0,
    lastProgressTimestamp: Date.now(),
    notifiedProgressMilestones: new Set(),
    prevRemainingSec: null,
    notifiedTimeThresholds: new Set(),
    notifiedTempMilestones: new Set(),
    prevMaterialStatus: null,
    currentMaterialStatus: null,
    filamentOutTimer: null,
    filamentLowWarned: false,
    lastUsageSnapshotSec: 0,
    snapshotPrintId: null,
    prevUsedMaterialLength: null,
    prevUsageProgress: 0,
    accumulatedUsedMaterial: 0
  };
}

/**
 * 指定ホストの AggregatorHostState を返す（無ければ作成）。
 * @private
 * @param {string} hostname - ホスト名
 * @returns {AggregatorHostState}
 */
function _getState(hostname) {
  const host = hostname;
  if (!host) { return _createHostState(); }
  if (!_hostStates.has(host)) _hostStates.set(host, _createHostState());
  return _hostStates.get(host);
}

// ---------------------------------------------------------------------------
// _resetNotificationState: 通知状態リセット（共通化）
// ---------------------------------------------------------------------------
/**
 * 新しい印刷ジョブ開始時に、進捗・残り時間・温度関連の通知履歴を初期化する。
 * 前ジョブで一度発火した閾値を再度通知できるようにする。
 *
 * @private
 * @param {number} nowMs - 現在時刻（ミリ秒）
 * @returns {void}
 */
/**
 * @private
 * @param {AggregatorHostState} s - ホスト状態
 * @param {number} nowMs - 現在時刻（ミリ秒）
 */
function _resetNotificationState(s, nowMs) {
  s.notifiedProgressMilestones.clear();
  s.notifiedTimeThresholds.clear();
  s.notifiedTempMilestones.clear();
  s.prevProgress = 0;
  s.lastProgressTimestamp = nowMs;
  s.prevRemainingSec = null;
}

// ---------------------------------------------------------------------------
// _readRaw: storedData の rawValue を安全に読み取る
// ---------------------------------------------------------------------------
/**
 * processData の (2.7.3) で全フィールドが storedData に格納済みであることを前提に、
 * storedData から rawValue を直接読み取る。getMergedValueWithSource の代替として
 * 使用し、data オブジェクトの二重走査を回避する。
 *
 * @private
 * @param {string} key - storedData のキー
 * @returns {*} rawValue の値、未設定時は null
 */
/**
 * @private
 * @param {string} key - storedData のキー
 * @param {string} hostname - ホスト名
 * @returns {*} rawValue の値、未設定時は null
 */
function _readRaw(key, hostname) {
  const machine = monitorData.machines[hostname];
  return machine?.storedData?.[key]?.rawValue ?? null;
}

// ---------------------------------------------------------------------------
// ingestData: WebSocket 生データ受領時の集計＆通知発火
// ---------------------------------------------------------------------------
/**
 * ingestData:
 *   processData の (2.7.3) で storedData に格納済みの値を読み取り、
 *   通知判定・タイマー逆算・フィラメント管理を行う。
 *
 *   A. 進捗関連通知
 *   B. 残り時間閾値通知
 *   C. 温度近接アラート
 *   D. フィラメント切れ／交換
 *   E. 実印刷開始時刻 を逆算
 *   F. 初回残り時間 を逆算
 *   G. タイマー集計＆予測フェーズへ aggregateTimersAndPredictions() 呼び出し
 *
 * @param {object} data  - WebSocket で受信した生データ（互換性のため保持、内部では storedData から直接読み取り）
 */
export function ingestData(data, hostname) {
  const host = hostname;
  if (!host) return;
  const nowMs  = Date.now();
  const nowSec = nowMs / 1000;

  const machine = monitorData.machines[host];
  if (!machine) return;
  const storedData = machine.storedData;
  const s = _getState(host);

  /** ホスト指定の setStoredData ラッパー */
  const _set = (key, value, isRaw = false) => setStoredDataForHost(host, key, value, isRaw);

  // —— storedData から一括読み取り ——
  // processData (2.7.3) で data→storedData への格納が完了しているため、
  // storedData.rawValue を直接参照する（getMergedValueWithSource の二重走査を回避）
  const id       = _readRaw("printStartTime", host);
  const progRaw  = _readRaw("printProgress", host);
  const jobRaw   = _readRaw("printJobTime", host);
  const leftRaw  = _readRaw("printLeftTime", host);
  const selfRaw  = _readRaw("withSelfTest", host);
  const nozzleRaw = _readRaw("nozzleTemp", host);
  const maxNozzRaw = _readRaw("maxNozzleTemp", host);
  const bedRaw   = _readRaw("bedTemp0", host);
  const maxBedRaw = _readRaw("maxBedTemp", host);
  const matStatRaw = _readRaw("materialStatus", host);
  // usedMaterialLength → materialLength エイリアス処理
  // usedMaterialLength を優先、なければ旧形式 usagematerial、最後に materialLength
  let matLenRaw = _readRaw("usedMaterialLength", host);
  if (matLenRaw == null) {
    matLenRaw = _readRaw("usagematerial", host) ?? _readRaw("materialLength", host) ?? null;
  }

  // —— 型変換 ——
  const prog    = Number(progRaw   ?? 0);
  const jobTime = Number(jobRaw    ?? 0);
  const left    = Number(leftRaw   ?? NaN);
  const selfPct = Number(selfRaw   ?? 0);
  const nozzle  = parseFloat(nozzleRaw)  || NaN;
  const maxNozz = parseFloat(maxNozzRaw) || NaN;
  const bed     = parseFloat(bedRaw)     || NaN;
  const maxBed  = parseFloat(maxBedRaw)  || NaN;
  const matStat = Number(matStatRaw ?? 0);
  const matLen  = Number(matLenRaw  ?? NaN);

  if (!isNaN(matLen)) {
    _set("usedMaterialLength", matLen, true);
    _set("materialLengthFallback", matLen, true);
  }

  // (0) 新しい PrintID 検出 → 全リセット
  const validId = Number.isFinite(id) && id > 0;
  if (validId && id !== s.prevPrintID) {
    // 新しいジョブ開始時点でフィラメント使用量関連の変数を初期化
    s.accumulatedUsedMaterial = !isNaN(matLen) ? matLen : 0;
    s.prevUsedMaterialLength = !isNaN(matLen) ? matLen : null;
    s.prevUsageProgress = prog;

    if (s.prevPrintID === null && s.actualStartEpoch !== null) {
      // printJobTime から開始済みのジョブに ID が後から届いた場合
      const spool = getCurrentSpool(host);
      if (spool && spool.currentPrintID !== String(id)) {
        if (spool.currentJobExpectedLength == null) {
          reserveFilament(0, String(id), host);
        } else {
          spool.currentPrintID = String(id);
        }
      }
      s.prevPrintID = id;
      _resetNotificationState(s, nowMs);
      if (historyPersistFunc) {
        try {
          historyPersistFunc(id, host);
        } catch (e) {
          console.error("historyPersistFunc error", e);
        }
      }
    } else {

      s.tsPrepStart = s.tsCheckStart = s.tsPauseStart = s.tsCompleteStart = null;
      s.totalPrepSec = s.totalCheckSec = s.totalPauseSec = 0;
      s.actualStartEpoch = s.initialLeftSec = s.initialLeftEpoch = null;
      [
        "preparationTime","firstLayerCheckTime","pauseTime","completionElapsedTime",
        "actualStartTime","initialLeftTime","initialLeftAt",
        "estimatedRemainingTime","estimatedCompletionTime"
      ].forEach(f => {
        _set(f, null, true);
        _set(f, null, false);
      });
    }

    const spool = getCurrentSpool(host);
    if (spool && spool.currentPrintID !== String(id)) {
      if (spool.currentJobExpectedLength == null) {
        reserveFilament(0, String(id), host);
      } else {
        spool.currentPrintID = String(id);
      }
    }
    s.prevPrintID = id;
    if (historyPersistFunc) {
      try {
        historyPersistFunc(id, host);
      } catch (e) {
        console.error("historyPersistFunc error", e);
      }
    }
    _resetNotificationState(s, nowMs);
  }

  // A. プリント進捗通知 ------------------------------------------------------
  if (prog !== s.prevProgress) {
    notificationManager.notify("printProgressUpdated", { hostname: host, previous: s.prevProgress, current: prog });
    s.lastProgressTimestamp = nowMs;
  }
  PROGRESS_MILESTONES.forEach(ms => {
    if (prog >= ms && !s.notifiedProgressMilestones.has(ms)) {
      s.notifiedProgressMilestones.add(ms);
      const layer = Number(storedData.layer?.rawValue ?? 0);
      const totalLayer = Number(storedData.TotalLayer?.rawValue ?? 0);
      const remainSec = Number(storedData.printLeftTime?.rawValue ?? 0);
      const estEnd = remainSec > 0 ? Date.now() + remainSec * 1000 : null;
      const fname = storedData.printFileName?.rawValue || storedData.fileName?.rawValue;
      notificationManager.notify("printProgressMilestone", {
        hostname: host, milestone: ms,
        filename: fname ? String(fname).split("/").pop() : "",
        layer, totalLayer,
        remainingSec: remainSec,
        estimatedEndTime_epoch: estEnd
      });
    }
  });
  // 長時間停滞検知 (10分)
  if (prog === s.prevProgress && nowMs - s.lastProgressTimestamp > 10 * 60 * 1000) {
    notificationManager.notify("printProgressStalled", {
      hostname: host, progress: prog,
      stalledFor: formatDurationSimple((nowMs - s.lastProgressTimestamp) / 1000)
    });
    s.lastProgressTimestamp = nowMs;
  }
  // 完了通知
  if (s.prevProgress < 100 && prog >= 100) {
    notificationManager.notify("printProgressComplete", { hostname: host });
  }
  s.prevProgress = prog;

  // B. 残り時間閾値通知 ------------------------------------------------------
  if (!isNaN(left)) {
    if (s.prevRemainingSec === null) {
      s.prevRemainingSec = left;
    } else {
      TIME_THRESHOLDS.forEach(mins => {
        const thr = mins * 60;
        if (s.prevRemainingSec > thr && left <= thr && !s.notifiedTimeThresholds.has(mins)) {
          s.notifiedTimeThresholds.add(mins);
          notificationManager.notify(`timeLeft${mins}`, {
            hostname: host, thresholdMin: mins,
            remainingSec: left,
            remainingPretty: formatDurationSimple(left)
          });
        }
      });
      s.prevRemainingSec = left;
    }
  }

  // C. 温度近接アラート ------------------------------------------------------
  if (!isNaN(nozzle) && !isNaN(maxNozz) && maxNozz > 0) {
    TEMP_MILESTONES.forEach(r => {
      const key = Math.round(r * 100);
      if (nozzle >= maxNozz * r && !s.notifiedTempMilestones.has(`nozzle${key}`)) {
        s.notifiedTempMilestones.add(`nozzle${key}`);
        notificationManager.notify(`tempNearNozzle${key}`, {
          hostname: host, ratio: r,
          ratioPct: Math.round(r * 100),
          currentTemp: nozzle,
          maxTemp: maxNozz
        });
      }
    });
  }
  if (!isNaN(bed) && !isNaN(maxBed) && maxBed > 0) {
    TEMP_MILESTONES.forEach(r => {
      const key = Math.round(r * 100);
      if (bed >= maxBed * r && !s.notifiedTempMilestones.has(`bed${key}`)) {
        s.notifiedTempMilestones.add(`bed${key}`);
        notificationManager.notify(`tempNearBed${key}`, {
          hostname: host, ratio: r,
          ratioPct: Math.round(r * 100),
          currentTemp: bed,
          maxTemp: maxBed
        });
      }
    });
  }

  // D. フィラメント切れ／交換 ------------------------------------------------
  s.currentMaterialStatus = matStat;
  if (s.prevMaterialStatus !== null) {
    if (s.prevMaterialStatus === 0 && matStat === 1) {
      notificationManager.notify("filamentOut", { hostname: host });
      if (s.filamentOutTimer) clearTimeout(s.filamentOutTimer);
      s.filamentOutTimer = setTimeout(() => {
        if (s.currentMaterialStatus === 1) {
          showFilamentChangeDialog(host);
        }
      }, 2000);
    }
    if (s.prevMaterialStatus === 1 && matStat === 0) {
      notificationManager.notify("filamentReplaced", { hostname: host });
      if (s.filamentOutTimer) {
        clearTimeout(s.filamentOutTimer);
        s.filamentOutTimer = null;
      }
    }
  }
  s.prevMaterialStatus = matStat;

  // E. —— 実印刷開始時刻 を必ず逆算 ------------------------------------------------
  if (s.actualStartEpoch === null && jobTime >= 1) {
    // ジョブタイムが増え始めた瞬間を s.actualStartEpoch の元に
    s.actualStartEpoch = nowSec - jobTime;
    _set("actualStartTime", s.actualStartEpoch, true);

    // ---- 新規印刷スタート時の通知状態リセット ------------------------------
    // printStartTime がまだ届いていないケースでも、jobTime が進み始めた
    // 時点で前回ジョブの残り時間通知などを初期化する。
    _resetNotificationState(s, nowMs);

    if (historyPersistFunc && id) {
      try {
        historyPersistFunc(id, host);
      } catch (e) {
        console.error("historyPersistFunc error", e);
      }
    }

    // ----- 印刷前準備時間の確定 -----
    if (s.tsPrepStart !== null) {
      const diff = Math.floor((s.actualStartEpoch * 1000 - s.tsPrepStart) / 1000);
      if (diff > 0) s.totalPrepSec += diff;
      s.tsPrepStart = null;
      _set("preparationTime", s.totalPrepSec, true);
    } else if (s.totalPrepSec === 0 && id) {
      const diff = Math.floor(s.actualStartEpoch - id);
      if (diff > 0) {
        s.totalPrepSec = diff;
        _set("preparationTime", s.totalPrepSec, true);
      }
    }

  }

  // F. —— 初回残り時間 を必ず逆算 ------------------------------------------------
  if (s.initialLeftSec === null && left >= 0 && s.actualStartEpoch !== null) {
    s.initialLeftSec   = left;
    s.initialLeftEpoch = s.actualStartEpoch + left;

    // rawValue に秒数／エポックをセット
    _set("initialLeftTime", s.initialLeftSec, true);
    _set("initialLeftAt",   s.initialLeftEpoch, true);

  }

  // G. タイマー集計＆予測フェーズへ ------------------------------------------------
  // ingestData で抽出済みの数値を渡し、aggregateTimersAndPredictions での
  // getMergedValueWithSource 再呼び出し（二重抽出）を回避する
  aggregateTimersAndPredictions({
    id, st: Number(_readRaw("state", host) ?? 0),
    jobTime, selfPct, prog, left,
    device: Number(_readRaw("deviceState", host) ?? 0),
    finish: Number(_readRaw("printFinishTime", host) ?? 0),
  }, host);

  // --- 印刷完了時のフィラメント使用量確定処理 -----------------------------
  // ingestData 冒頭で抽出済みの値を再利用（data オブジェクトへの再アクセスを回避）
  const st_agg = Number(_readRaw("state", host) ?? 0);
  const prog_agg = prog;
  const prevPrintState_agg = Number(
    machine?.runtimeData?.state ?? 0
  );
  // 直前まで印刷中もしくは一時停止中で、現在の状態が完了・失敗・アイドルに
  // 遷移した場合は使用フィラメント量を確定する。進捗率が100%未満でも処理
  // を行い、キャンセルや電源断による中断を検出する。
  if (
    (prevPrintState_agg === PRINT_STATE_CODE.printStarted ||
      prevPrintState_agg === PRINT_STATE_CODE.printPaused) &&
    (st_agg === PRINT_STATE_CODE.printDone ||
      st_agg === PRINT_STATE_CODE.printFailed ||
      st_agg === PRINT_STATE_CODE.printIdle)
  ) {
    // 状態遷移を検知したら、直近の使用量を積算した上で確定する
    const spool = getCurrentSpool(host);
    // ジョブIDが未確定の場合は、利用可能な情報から補完して確定処理に備える
    if (spool && !spool.currentPrintID) {
      const resolvedJobId = resolveFilamentJobId(
        storedData,
        machine?.printStore?.current ?? null,
        s.prevPrintID
      );
      if (resolvedJobId) {
        spool.currentPrintID = resolvedJobId;
      }
    }
    const usedMatRaw = _readRaw("usedMaterialLength", host);
    if (!isNaN(Number(usedMatRaw))) {
      const cur = Number(usedMatRaw);
      if (s.prevUsedMaterialLength != null) {
        const d = cur - s.prevUsedMaterialLength;
        if (d > 0) s.accumulatedUsedMaterial += d;
      } else {
        s.accumulatedUsedMaterial += cur;
      }
      s.prevUsedMaterialLength = cur;
      s.prevUsageProgress = prog_agg;
    } else {
      let est = spool?.currentJobExpectedLength ?? NaN;
      const fileNameRaw = _readRaw("fileName", host);
      if ((isNaN(est) || est <= 0) && fileNameRaw) {
        est = guessExpectedLength(String(fileNameRaw), host);
      }
      if (!isNaN(est) && est > 0) {
        s.accumulatedUsedMaterial = (est * prog_agg) / 100;
      }
      s.prevUsageProgress = prog_agg;
    }
    let length = s.accumulatedUsedMaterial;
    const jobId_agg = spool?.currentPrintID || String(id || "");
    if (jobId_agg) {
      if (length <= 0) {
        let est = spool?.currentJobExpectedLength ?? NaN;
        const fileNameRaw = _readRaw("fileName", host);
        if ((isNaN(est) || est <= 0) && fileNameRaw) {
          est = guessExpectedLength(String(fileNameRaw), host);
        }
        if (!isNaN(est) && prog_agg > 0) {
          length = (est * prog_agg) / 100;
        }
      }
      finalizeFilamentUsage(length, jobId_agg, host);
      saveUnifiedStorage();
      s.accumulatedUsedMaterial = 0;
      s.prevUsedMaterialLength = null;
      s.prevUsageProgress = 0;
    }
  }

/*  // H. エラー検知
  // ① 生データ中に errorCode があれば拾う
  const { value: errCode } = getMergedValueWithSource("err", data);
  // ② storedData にセット（rawValue=false なので「表示用 computedValue」に流し込み）
  if (errCode != null) {
    // 例: コード123 の場合は "コード123"
    setStoredData("errorStatus", `コード${errCode.errcode},キー${errCode.key}`, false);
  } else {
    // エラーなしなら '---'
    setStoredData("errorStatus", null, false);
  }
*/
}


// ---------------------------------------------------------------------------
// aggregateTimersAndPredictions: タイマー集計＆予測
// ---------------------------------------------------------------------------
/**
 * aggregateTimersAndPredictions: タイマー集計＆予測
 *
 * 【詳細説明】
 * - ingestData で抽出済みの数値を受け取る（getMergedValueWithSource の二重呼び出しを回避）
 * - PrintID 切替や一時停止の再開処理を反映
 * - 各種タイマー値を算出し storedData へ保存
 * - 予想終了時刻等の計算結果も合わせて反映する
 *
 * @function aggregateTimersAndPredictions
 * @param {object} vals - ingestData で抽出済みの数値オブジェクト
 * @param {number|null} vals.id      - printStartTime
 * @param {number}      vals.st      - state
 * @param {number}      vals.jobTime - printJobTime
 * @param {number}      vals.selfPct - withSelfTest
 * @param {number}      vals.prog    - printProgress (0-100)
 * @param {number}      vals.left    - printLeftTime (秒)
 * @param {number}      vals.device  - deviceState
 * @param {number}      vals.finish  - printFinishTime
 * @returns {void}
 */
function aggregateTimersAndPredictions(vals, hostname) {
  const host = hostname;
  if (!host) return;
  const nowMs  = Date.now();
  const nowSec = nowMs / 1000;
  const s = _getState(host);

  const machine = monitorData.machines[host];
  const storedData = machine?.storedData || {};

  /** ホスト指定の setStoredData ラッパー */
  const _set = (key, value, isRaw = false) => setStoredDataForHost(host, key, value, isRaw);

  // ── ingestData から受け取った数値を展開 ────────────────────────────────
  const { id, st, jobTime: job, selfPct, prog, left, device, finish } = vals;
  const progPct = prog / 100;

  // ---- 完了後経過タイマーの復元処理 ------------------------------
  if (s.tsCompleteStart === null) {
    const last = machine?.historyData?.[machine.historyData.length - 1];
    if (
      last &&
      s.prevPrintID !== null &&
      Number(last.id) === Number(s.prevPrintID) &&
      last.finishTime
    ) {
      const fin = Date.parse(last.finishTime);
      if (!isNaN(fin)) {
        s.tsCompleteStart = fin;
        _set(
          "completionElapsedTime",
          Math.floor((nowMs - fin) / 1000),
          true
        );
      }
    }
  }

  // ── 2) PrintID 切替検出 → 各種リセット ────────────────────────────────────
  const numId = Number(id) || null;
  const validId_ap = Number.isFinite(numId) && numId > 0;
  if (s.prevPrintID !== null && validId_ap && numId !== s.prevPrintID) {
    {
      s.tsPrepStart   = s.tsCheckStart   = s.tsPauseStart   = s.tsCompleteStart   = null;
      s.totalPrepSec  = s.totalCheckSec  = s.totalPauseSec                      = 0;
      s.prevPrintID   = numId;
    }
  }
  else if (s.prevPrintID === null && validId_ap) {
    // 初回読み込み時だけは s.prevPrintID をセットして、次回以降の切替検出に備える
    s.prevPrintID = numId;
  }

  // ── 3) 一時停止→再開 のシフト補正 ─────────────────────────────────
  const prevState = Number(monitorData.machines[host]?.runtimeData?.state) || 0;
  if (
    prevState === PRINT_STATE_CODE.printPaused &&
    st        === PRINT_STATE_CODE.printStarted &&
    s.tsPauseStart
  ) {
    s.totalPauseSec += Math.floor((nowMs - s.tsPauseStart) / 1000);
    s.tsPauseStart   = null;
  }

  // ── 4) タイマー集計／表示用セット ─────────────────────────────────
  // 4-1. 印刷前準備時間
  if (
    st === PRINT_STATE_CODE.printStarted &&
    job === 0 &&
    selfPct >= 0 && selfPct <= 9 &&
    !s.tsCheckStart &&
    !s.tsPauseStart
  ) {
    if (!s.tsPrepStart) {
      // ----- 再読み込み時にタイマーがリセットされないよう印刷開始時刻を基準に補正
      // printStartTime(id) が取得できていればそこからの経過秒を算出する
      // まだ得られていない場合は現在時刻から計測を開始する
      s.tsPrepStart = numId ? numId * 1000 : nowMs;
    }
    const sec = s.totalPrepSec + Math.floor((nowMs - s.tsPrepStart) / 1000);
    // internal
    _set("preparationTime", sec, true);
  } else if (s.tsPrepStart) {
    s.totalPrepSec += Math.floor((nowMs - s.tsPrepStart) / 1000);
    s.tsPrepStart   = null;
    _set("preparationTime", s.totalPrepSec, true);
  }

  // 4-2. ファーストレイヤー確認時間
  if (
    s.tsPrepStart === null &&
    s.tsPauseStart === null &&
    s.actualStartEpoch !== null &&
    (st === PRINT_STATE_CODE.printStarted || st === PRINT_STATE_CODE.printPaused || st === 3) &&
    selfPct >= 30 && selfPct <= 39
  ) {
    if (!s.tsCheckStart) s.tsCheckStart = nowMs;
    const sec = s.totalCheckSec + Math.floor((nowMs - s.tsCheckStart) / 1000);
    _set("firstLayerCheckTime", sec, true);
  } else if (
    s.tsCheckStart &&
    (
      (
        st !== PRINT_STATE_CODE.printStarted &&
        st !== PRINT_STATE_CODE.printPaused &&
        st !== 3
      ) ||
      selfPct < 30 ||
      selfPct > 39 ||
      s.tsPrepStart !== null ||
      s.tsPauseStart !== null
    )
  ) {
    s.totalCheckSec += Math.floor((nowMs - s.tsCheckStart) / 1000);
    s.tsCheckStart   = null;
    _set("firstLayerCheckTime", s.totalCheckSec, true);
  }

  // 4-3. 一時停止時間
  if (
    s.tsPrepStart === null &&
    s.tsCheckStart === null &&
    (st === PRINT_STATE_CODE.printPaused || st === 3) &&
    job >= 1 &&
    (
      selfPct === 0 ||
      (selfPct >= 10 && selfPct <= 29) ||
      (selfPct >= 40 && selfPct <= 100)
    )
  ) {
    if (!s.tsPauseStart) s.tsPauseStart = nowMs;
    const sec = s.totalPauseSec + Math.floor((nowMs - s.tsPauseStart) / 1000);
    _set("pauseTime", sec, true);
    _set("pauseTime", { value: formatDuration(sec), unit: "" }, false);
  } else if (
    s.tsPauseStart &&
    (
      (st !== PRINT_STATE_CODE.printPaused && st !== 3) ||
      job < 1 ||
      (
        selfPct !== 0 &&
        !(selfPct >= 10 && selfPct <= 29) &&
        !(selfPct >= 40 && selfPct <= 100)
      ) ||
      s.tsPrepStart !== null ||
      s.tsCheckStart !== null
    )
  ) {
    s.totalPauseSec += Math.floor((nowMs - s.tsPauseStart) / 1000);
    s.tsPauseStart   = null;
    _set("pauseTime", s.totalPauseSec, true);
  }

  // 4-4. 完了後経過時間
  const doneStates = new Set([
    PRINT_STATE_CODE.printDone,
    PRINT_STATE_CODE.printFailed
  ]);
  const isIdle = device === PRINT_STATE_CODE.printIdle;
  if (isIdle && doneStates.has(st)) {
    if (!s.tsCompleteStart) {
      s.tsCompleteStart = nowMs;
      _set("completionElapsedTime", 0, true);
    }
    const sec = Math.floor((nowMs - s.tsCompleteStart) / 1000);
    _set("completionElapsedTime", sec, true);
  } else if (
    s.tsCompleteStart &&
    (st === PRINT_STATE_CODE.printStarted ||
     (prevState === PRINT_STATE_CODE.printPaused && st !== PRINT_STATE_CODE.printPaused))
  ) {
    s.tsCompleteStart = null;
    _set("completionElapsedTime", null, true);
  }

  // ── 5) 予想残り時間／予想終了時刻 ────────────────────────────────
  checkUpdatedFields([
    "printProgress",
    "state",
    "printStartTime",
    "printLeftTime"
  ], () => {
    if (doneStates.has(st)) {
      // 印刷終了または失敗時は予測値をリセット
      _set("predictedFinishEpoch",    null, true);
      _set("estimatedRemainingTime",  null, true);
      _set("estimatedCompletionTime", null, true);
    } else if (s.actualStartEpoch !== null && progPct > 0) {
      const elapsed  = (nowSec - s.actualStartEpoch) - (s.totalCheckSec + s.totalPauseSec);
      const totalEst = elapsed / progPct;
      const remSec   = totalEst - elapsed;
      const finishE  = nowSec + remSec;
      // raw epoch
      _set("predictedFinishEpoch",    Math.floor(finishE), true);
      // display datetime
      _set("estimatedRemainingTime",  Math.floor(remSec),   true);
      _set("estimatedCompletionTime", Math.floor(finishE), true);
    }
    // フォールバック：初回残り時間ベース
    else if (
      s.actualStartEpoch   !== null &&
      s.initialLeftSec     !== null &&
      s.initialLeftEpoch   !== null
    ) {
      _set("predictedFinishEpoch",    s.initialLeftEpoch, true);
      _set("estimatedRemainingTime",  s.initialLeftSec,   true);
      _set("estimatedCompletionTime", s.initialLeftEpoch, true);
    }
  }, storedData);

  // ── 6) 状態永続化 ─────────────────────────────────────────────
  persistAggregatorState(host);
}

// ---------------------------------------------------------------------------
// aggregatorUpdate: UI 更新＆永続化
// ---------------------------------------------------------------------------
/**
 * aggregatorUpdate:
 *   - storedData → DOM 反映
 *   - 差分主導で再計算／表示更新
 *   - 温度グラフ更新
 *   - 永続化
 *   - 一定間隔で残量スナップショットを記録
 */
export function aggregatorUpdate() {

  // 接続中の全ホストを対象にする（PLACEHOLDER は除外）
  const hosts = Object.keys(monitorData.machines).filter(
    h => h && h !== PLACEHOLDER_HOSTNAME
  );
  if (hosts.length === 0) return;

  // --- ここでタイマー／予測用フィールド群が揃っているか確認 ---
  const needed = ["preparationTime","firstLayerCheckTime","pauseTime","completionElapsedTime",
                  "actualStartTime","initialLeftTime","initialLeftAt",
                  "predictedFinishEpoch","estimatedRemainingTime","estimatedCompletionTime",
                  "expectedEndTime"];

  for (const host of hosts) {
    const machine = monitorData.machines[host];
    if (!machine) continue;
    const storedData = machine.storedData;
    const s = _getState(host);

    /** ホスト指定の setStoredData ラッパー */
    const _set = (key, value, isRaw = false) => setStoredDataForHost(host, key, value, isRaw);

    needed.forEach(key => {
      if (!(key in storedData)) {
        // rawValueを「未定義(null)」で作っておく
        setStoredDataForHost(host, key, null);
      }
    });

    const allReady = needed.every(key => key in storedData);
    if (!allReady) continue;

    // state→printState
    checkUpdatedFields(["state"], () => {
      const raw = storedData.state?.rawValue;
      if (raw !== undefined) {
        _set("printState", raw, true);
        _set("printState", { value: String(raw), unit: "" });
      }
    }, storedData);

    // fileName / printFileName 表示抽出（タイトルバー用 printFileName も同期更新）
    // WS デバイスは printFileName キーでファイル名を送信するため両方を監視する
    checkUpdatedFields(["fileName", "printFileName"], () => {
      const raw = storedData.printFileName?.rawValue || storedData.fileName?.rawValue;
      if (raw) {
        const name = String(raw).split("/").pop();
        _set("fileName", raw, true);
        _set("fileName", { value: name, unit: "" });
        _set("printFileName", name, true);
        _set("printFileName", { value: name, unit: "" });
      }
    }, storedData);

    // nozzleDiff / bedDiff
    checkUpdatedFields(["nozzleTemp","targetNozzleTemp"], () => {
      const c = parseFloat(storedData.nozzleTemp?.rawValue||0);
      const t = parseFloat(storedData.targetNozzleTemp?.rawValue||0);
      if (!isNaN(c)&&!isNaN(t)) {
        const d = (c - t).toFixed(2);
        _set("nozzleDiff",{ value:`${d>0?"+":""}${d} ℃`, unit:"" });
      }
    }, storedData);
    checkUpdatedFields(["bedTemp0","targetBedTemp0"], () => {
      const c = parseFloat(storedData.bedTemp0?.rawValue||0);
      const t = parseFloat(storedData.targetBedTemp0?.rawValue||0);
      if (!isNaN(c)&&!isNaN(t)) {
        const d = (c - t).toFixed(2);
        _set("bedDiff",{ value:`${d>0?"+":""}${d} ℃`, unit:"" });
      }
    }, storedData);

    // マシン切替時はグラフデータをリセットしてから更新
    switchChartHost(host);
    updateTemperatureGraphFromStoredData(storedData, host);

    // printFinishTime 再計算
    checkUpdatedFields(["printStartTime","printLeftTime"], () => {
      const sv = parseInt(storedData.printStartTime?.rawValue,10)||0;
      const l = parseInt(storedData.printLeftTime?.rawValue,10);
      if (sv>0 && !isNaN(l)&&l>=0) {
        const e = Math.floor(Date.now()/1000) + l;
        _set("printFinishTime", e, true);
        _set("printFinishTime", {
          value: new Date(e*1000).toLocaleString(),
          unit: ""
        });
      }
    }, storedData);

    // expectedEndTime update
    checkUpdatedFields([
      "printFinishTime",
      "predictedFinishEpoch"
    ], () => {
      const fin = parseInt(storedData.printFinishTime?.rawValue, 10);
      const pred = parseInt(storedData.predictedFinishEpoch?.rawValue, 10);
      const val = (!isNaN(fin) && fin > 0)
        ? fin
        : (!isNaN(pred) && pred > 0)
          ? pred
          : null;
      _set("expectedEndTime", val, true);
    }, storedData);

    // --- フィラメント残量の動的計算 ---
    const spool = getCurrentSpool(host);
    if (spool) autoCorrectCurrentSpool(host);
    const st   = Number(storedData.state?.rawValue || 0);
    const isPrinting =
      st === PRINT_STATE_CODE.printStarted ||
      st === PRINT_STATE_CODE.printPaused;
    // フィラメント残量計算に入る前に、未確定のジョブIDを補完して紐付け漏れを防ぐ
    if (spool && !spool.currentPrintID) {
      const resolvedJobId = resolveFilamentJobId(
        storedData,
        machine?.printStore?.current ?? null,
        s.prevPrintID
      );
      if (resolvedJobId) {
        spool.currentPrintID = resolvedJobId;
      }
    }

    // アイドル状態から印刷開始へ遷移し、useFilament() が未実行の場合の初期化
    if (
      spool &&
      s.lastPrintState === PRINT_STATE_CODE.printIdle &&
      st === PRINT_STATE_CODE.printStarted &&
      spool.currentJobStartLength == null
    ) {
      let est = Number(storedData.materialLength?.rawValue ?? NaN);
      if (isNaN(est)) {
        est = Number(storedData.materialLengthFallback?.rawValue ?? NaN);
      }
      const job = loadPrintCurrent(host);
      const jobId = job?.id ?? "";
      const fnForGuess = storedData.printFileName?.rawValue || storedData.fileName?.rawValue;
      if ((isNaN(est) || est <= 0) && fnForGuess) {
        est = guessExpectedLength(fnForGuess, host);
      }
      beginExternalPrint(spool, isNaN(est) ? 0 : est, jobId, host);
      s.accumulatedUsedMaterial = 0;
      s.prevUsedMaterialLength = Number(storedData.usedMaterialLength?.rawValue);
      s.prevUsageProgress = parseInt(storedData.printProgress?.rawValue || 0, 10);
    }
    // usedMaterialLength 受信時、または復元直後に currentJobStartLength が未設定の
    // 状態で印刷が進行中の場合に残量計算を開始
    // usedMaterialLength が送られてこない場合でも印刷中は残量計算と保存を継続する
    if (spool && (isPrinting || spool.currentJobStartLength != null)) {
      if (spool.currentJobStartLength == null) {
        // 印刷開始直後にスプール残量を記録し、使用量カウンタを初期化
        spool.currentJobStartLength = spool.remainingLengthMm;
        s.accumulatedUsedMaterial = 0;
        s.prevUsedMaterialLength = Number(storedData.usedMaterialLength?.rawValue);
        s.prevUsageProgress = parseInt(storedData.printProgress?.rawValue || 0, 10);
      }
      const prog = parseInt(storedData.printProgress?.rawValue || 0, 10);
      const used = Number(storedData.usedMaterialLength?.rawValue);
      let est  = Number(storedData.materialLength?.rawValue ?? NaN);
      if (isNaN(est)) {
        est = Number(storedData.materialLengthFallback?.rawValue ?? NaN);
      }
      let remain = spool.remainingLengthMm;

      // 外部から印刷が開始された場合、reserveFilament() 相当の初期化を行う
      if (
        (st === PRINT_STATE_CODE.printStarted || st === PRINT_STATE_CODE.printPaused) &&
        spool.currentJobExpectedLength == null
      ) {
        const job = loadPrintCurrent(host);
        let len   = Number(job?.materialUsedMm ?? NaN);
        const jobId = job?.id ?? "";
        if (isNaN(len) || len <= 0) {
          len = est;
        }
        const fnForLen = storedData.printFileName?.rawValue || storedData.fileName?.rawValue;
        if ((isNaN(len) || len <= 0) && fnForLen) {
          len = guessExpectedLength(fnForLen, host);
        }
        if (spool.currentJobExpectedLength == null || spool.currentPrintID !== jobId) {
          // フィラメントIDのみ先に確定し、使用量が判明してから予約する
          if (machine?.printStore?.current) {
            machine.printStore.current.filamentId = spool.id;
          }
          if (!isNaN(len) && len > 0) {
            beginExternalPrint(spool, len, jobId, host);
          } else {
            // 予定使用量が不明の場合は予約を遅延させる
            spool.currentPrintID = jobId;
          }
        }
      }
      if (spool.currentJobStartLength != null && isPrinting) {
        // 実際に使用した長さをデルタで積算
        let delta = 0;
        if (!isNaN(used)) {
          if (s.prevUsedMaterialLength != null) {
            delta = used - s.prevUsedMaterialLength;
            if (delta < 0) delta = 0; // マイナス値は無視
          } else {
            // 初回受信時はそのまま累積値として扱う
            delta = used;
          }
          s.prevUsedMaterialLength = used;
          // usedMaterialLength が得られた場合でも進捗基準を同期しておく
          s.prevUsageProgress = prog;
        } else if (!isNaN(est) && est > 0) {
          // 推定値が途中で判明しても正しい値に補正できるよう、
          // 差分ではなく絶対値で使用量を算出する
          s.accumulatedUsedMaterial = (est * prog) / 100;
          delta = 0;
          s.prevUsageProgress = prog;
        }
        s.accumulatedUsedMaterial += delta;
        remain = spool.currentJobStartLength - s.accumulatedUsedMaterial;
        // 印刷途中にページを更新しても残量が巻き戻らないよう、
        // 計算値をスプールオブジェクトへ反映しておく
        spool.remainingLengthMm = Math.max(0, remain);
      } else if (
        spool.currentJobStartLength != null &&
        (Number(machine?.runtimeData?.state) ===
          PRINT_STATE_CODE.printStarted ||
          Number(machine?.runtimeData?.state) ===
            PRINT_STATE_CODE.printPaused) &&
        st !== PRINT_STATE_CODE.printStarted &&
        st !== PRINT_STATE_CODE.printPaused
      ) {
        // 状態が完了・失敗等へ遷移した場合は累積使用量で確定
        if (spool && !spool.currentPrintID) {
          const resolvedJobId = resolveFilamentJobId(
            storedData,
            machine?.printStore?.current ?? null,
            s.prevPrintID
          );
          if (resolvedJobId) {
            spool.currentPrintID = resolvedJobId;
          }
        }
        finalizeFilamentUsage(s.accumulatedUsedMaterial, spool.currentPrintID, host);
        saveUnifiedStorage();
        s.accumulatedUsedMaterial = 0;
        s.prevUsedMaterialLength = null;
        s.prevUsageProgress = 0;
        remain = spool.remainingLengthMm;
      }

      // 機器報告値の精度をそのまま保持（丸めない）
      _set("filamentRemainingMm", remain, true);

      if (spool.currentPrintID) {
        if (s.snapshotPrintId !== spool.currentPrintID) {
          s.snapshotPrintId = spool.currentPrintID;
          s.lastUsageSnapshotSec = 0;
        }
        if (
          (st === PRINT_STATE_CODE.printStarted || st === PRINT_STATE_CODE.printPaused) &&
          (!s.lastUsageSnapshotSec || Date.now() / 1000 - s.lastUsageSnapshotSec >= USAGE_SNAPSHOT_INTERVAL)
        ) {
          addUsageSnapshot(spool, spool.currentPrintID, remain);
          s.lastUsageSnapshotSec = Date.now() / 1000;
        }
      } else {
        s.snapshotPrintId = null;
        s.lastUsageSnapshotSec = 0;
      }

      const thr = notificationManager.getFilamentLowThreshold?.() ?? 0.1;
      if (spool.totalLengthMm > 0) {
        const ratio = remain / spool.totalLengthMm;
        if (ratio <= thr && !s.filamentLowWarned) {
          s.filamentLowWarned = true;
          notificationManager.notify("filamentLow", {
            hostname: host, remaining: remain,
            thresholdPct: Math.round(thr * 100),
            spoolName: spool.name
          });
        } else if (ratio > thr) {
          s.filamentLowWarned = false;
        }
      }
    }

    // 温度範囲チェック: 印刷中にスプールの推奨温度範囲外なら警告
    if (
      (st === PRINT_STATE_CODE.printStarted || st === PRINT_STATE_CODE.printPaused) &&
      spool && !s._tempRangeWarned
    ) {
      const nozzle = Number(storedData.nozzleTemp?.rawValue ?? NaN);
      const bed = Number(storedData.bedTemp0?.rawValue ?? NaN);
      const warnings = [];
      if (!isNaN(nozzle) && nozzle > 0) {
        if (spool.printTempMin != null && nozzle < spool.printTempMin) {
          warnings.push(`ノズル ${nozzle}℃ < 推奨下限 ${spool.printTempMin}℃`);
        }
        if (spool.printTempMax != null && nozzle > spool.printTempMax) {
          warnings.push(`ノズル ${nozzle}℃ > 推奨上限 ${spool.printTempMax}℃`);
        }
      }
      if (!isNaN(bed) && bed > 0) {
        if (spool.bedTempMin != null && bed < spool.bedTempMin) {
          warnings.push(`ベッド ${bed}℃ < 推奨下限 ${spool.bedTempMin}℃`);
        }
        if (spool.bedTempMax != null && bed > spool.bedTempMax) {
          warnings.push(`ベッド ${bed}℃ > 推奨上限 ${spool.bedTempMax}℃`);
        }
      }
      if (warnings.length > 0) {
        s._tempRangeWarned = true;
        notificationManager.notify("tempOutOfRange", {
          hostname: host,
          detail: warnings.join(", "),
          spoolName: spool.name || "",
          material: spool.materialName || spool.material || ""
        });
      }
    }
    // 印刷終了でリセット
    if (st !== PRINT_STATE_CODE.printStarted && st !== PRINT_STATE_CODE.printPaused) {
      s._tempRangeWarned = false;
    }

    s.lastPrintState = st;
    persistAggregatorState(host);
  } // end for hosts

  // ── ステータス Webhook 定期送信 ──
  _pushStatusSnapshotIfDue();

  clearNewClasses();
  console.debug("[aggregatorUpdate] updateStoredDataToDOM 呼び出し");
  updateStoredDataToDOM();
  saveUnifiedStorage();

  }

// ---------------------------------------------------------------------------
// guessExpectedLength: 履歴から予定使用量を推測
// ---------------------------------------------------------------------------
/**
 * 過去の履歴や保存済みファイル情報から予定フィラメント長を推測する。
 *
 * @private
 * @param {string} filePath - G-code ファイルのフルパスまたはファイル名
 * @returns {number} 推定された使用長 [mm]。不明な場合は NaN
 */
function guessExpectedLength(filePath, hostname) {
  const machine = monitorData.machines[hostname];
  if (!machine) return NaN;
  const base = filePath.split("/").pop();
  // 1) printStore.history から検索
  for (const job of machine.printStore?.history || []) {
    if (job.rawFilename === filePath || job.filename === base) {
      const v = Number(job.materialUsedMm);
      if (!isNaN(v) && v > 0) return v;
    }
  }
  // 2) machine.historyData から検索
  for (const entry of machine.historyData || []) {
    const fn = entry.filename || "";
    if (fn === filePath || fn.split("/").pop() === base) {
      const v = Number(entry.usedMaterialLength ?? entry.usagematerial ?? NaN);
      if (!isNaN(v) && v > 0) return v;
    }
  }
  return NaN;
}

// ---------------------------------------------------------------------------
// restoreAggregatorState / persistAggregatorState
// ---------------------------------------------------------------------------
/**
 * restoreAggregatorState:
 *   localStorage に保存された集約状態を読み出し、
 *   内部タイマー変数と storedData を復元します。
 */
export function restoreAggregatorState(hostname) {
  const host = hostname;
  if (!host) return;
  const s = _getState(host);
  const prefix = `aggr_${host}_`;
  const keys = [
    "tsPrepStart", "totalPrepSec",
    "tsCheckStart","totalCheckSec",
    "tsPauseStart","totalPauseSec",
    "tsCompleteStart",
    "actualStartEpoch",
    "initialLeftSec","initialLeftEpoch",
    "prevPrintID",
    "accumulatedUsedMaterial",
    "prevUsedMaterialLength",
    "prevUsageProgress"
  ];
  // まず storedData 側をクリア
  keys.forEach(k => {
    setStoredDataForHost(host, k, null, true);
    setStoredDataForHost(host, k, null, false);
  });
  // localStorage から読み出し
  keys.forEach(k => {
    const raw = localStorage.getItem(prefix + k);
    if (raw == null) return;
    let v;
    try { v = JSON.parse(raw); } catch { return; }
    // per-host 状態オブジェクトにセット
    if (k in s) s[k] = v;
    // storedData にも復元
    let field = k;
    if (k === "totalPrepSec")      field = "preparationTime";
    if (k === "totalCheckSec")     field = "firstLayerCheckTime";
    if (k === "totalPauseSec")     field = "pauseTime";
    if (k === "tsCompleteStart")   field = "completionElapsedTime";
    if (k === "actualStartEpoch")  field = "actualStartTime";
    if (k === "initialLeftSec")    field = "initialLeftTime";
    if (k === "initialLeftEpoch")  field = "initialLeftAt";
    if (k === "prevPrintID")      field = "prevPrintID";
    setStoredDataForHost(host, field, v, true);
  });

  // 復元後に actualStartTime が存在し印刷ID も分かっている場合は
  // 履歴に反映して UI を即時更新する
  if (historyPersistFunc && s.prevPrintID && s.actualStartEpoch != null) {
    try {
      historyPersistFunc(s.prevPrintID);
    } catch (e) {
      console.error("historyPersistFunc error", e);
    }
  }
}

/**
 * persistAggregatorState:
 *   現在の集約状態を localStorage に保存します。
 */
export function persistAggregatorState(hostname) {
  const host = hostname;
  if (!host) {
    console.warn("persistAggregatorState: ホスト未設定");
    return;
  }
  const s = _getState(host);
  const prefix = `aggr_${host}_`;
  const toSave = {
    tsPrepStart: s.tsPrepStart, totalPrepSec: s.totalPrepSec,
    tsCheckStart: s.tsCheckStart, totalCheckSec: s.totalCheckSec,
    tsPauseStart: s.tsPauseStart, totalPauseSec: s.totalPauseSec,
    tsCompleteStart: s.tsCompleteStart,
    actualStartEpoch: s.actualStartEpoch,
    initialLeftSec: s.initialLeftSec, initialLeftEpoch: s.initialLeftEpoch,
    prevPrintID: s.prevPrintID,
    accumulatedUsedMaterial: s.accumulatedUsedMaterial,
    prevUsedMaterialLength: s.prevUsedMaterialLength,
    prevUsageProgress: s.prevUsageProgress
  };
  Object.entries(toSave).forEach(([k, v]) => {
    const key = prefix + k;
    if (v != null) {
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch (e) {
        console.error(`persistAggregatorState: 保存失敗 ${key}`, e);
      }
    } else {
      localStorage.removeItem(key);
    }
  });
}

// ---------------------------------------------------------------------------
// restartAggregatorTimer / stopAggregatorTimer
// ---------------------------------------------------------------------------
/**
 * restartAggregatorTimer:
 *   - 既存タイマーをクリア（後勝ち）
 *   - monitorData.appSettings.updateInterval を
 *     1000ms 以上に補正して集約ループを開始
 */
export function restartAggregatorTimer() {
  if (aggregatorTimer !== null) clearInterval(aggregatorTimer);

  let intervalMs = Number(monitorData.appSettings.updateInterval);
  if (isNaN(intervalMs) || intervalMs < 100) {
    console.warn(
      `updateInterval が不正または 100ms 未満 (${intervalMs}ms)、500ms に設定`
    );
    intervalMs = 500;
  }

  aggregatorTimer = setInterval(() => {
    try {
      aggregatorUpdate();
    } catch (e) {
      console.error("aggregatorUpdate エラー:", e);
    }
  }, intervalMs);
}

/**
 * stopAggregatorTimer:
 *   - 集約ループを停止
 *   - 停止直前に {@link aggregatorUpdate} を実行し最終状態を保存
 */
export function stopAggregatorTimer() {
  if (aggregatorTimer !== null) {
    clearInterval(aggregatorTimer);
    aggregatorTimer = null;
    console.debug("aggregatorUpdate タイマー停止");

    try {
      aggregatorUpdate();
    } catch (e) {
      console.error("aggregatorUpdate エラー:", e);
    }

    // 全ホストの状態を保存
    for (const [host] of _hostStates) {
      persistAggregatorState(host);
    }
  }
}

/**
 * getCurrentPrintID:
 *   集約モジュールが保持する現在の印刷IDを返します。
 *   初期化前や未検出時は `null` を返します。
 *
 * @returns {number|null} 現在の印刷ID
 */
export function getCurrentPrintID(hostname) {
  const s = _getState(hostname);
  return s.prevPrintID;
}

/**
 * getMergedValueWithSource:
 * 指定キーについて、最新の受信データ (`data`) と storedData の生の値を
 * マージしつつ、値の「出どころ」を返します。
 *
 * @param {string} key                  - storedData のキー名
 * @param {object} data                 - 最新の受信オブジェクト
 * @param {string} [dataFieldName=key]  - data オブジェクト上のフィールド名
 * @returns {{ value: any, source: string }}
 *   - value: 取得した値（文字列・数値・null）
 *   - source:  
 *       - `"data"`: data[dataFieldName] に値（`!== undefined`）があった  
 *       - `"data-null"`: data[dataFieldName] に明示的に `null` が渡された  
 *       - `"stored"`: storedData に生の値があった  
 *       - `"none"`: どちらにも値がなかった
 */
function getMergedValueWithSource(key, data, dataFieldName = key, hostname) {
  // 1) data 側の判定
  if (Object.prototype.hasOwnProperty.call(data, dataFieldName)) {
    if (data[dataFieldName] === null) {
      return { value: null, source: "data-null" };
    }
    // undefined でなければ「data の値」
    if (data[dataFieldName] !== undefined) {
      return { value: data[dataFieldName], source: "data" };
    }
    // ここでは data[dataFieldName] が undefined（未送信扱い）なのでフォールバック
  }

  // 2) storedData の rawValue を取得
  const host = hostname;
  const machine = monitorData.machines[host];
  const entry = machine?.storedData?.[key];
  if (entry) {
    if (entry.rawValue === null) {
      return { value: null, source: "stored-null" };
    }
    if (entry.rawValue !== undefined) {
      return { value: entry.rawValue, source: "stored" };
    }
  }

  // 3) どちらにも値がない
  return { value: null, source: "none" };
}

// ---------------------------------------------------------------------------
// resolveFilamentJobId: フィラメント残量計算用のジョブID推定
// ---------------------------------------------------------------------------
/**
 * resolveFilamentJobId:
 *   フィラメント残量計算の紐付けに使うジョブIDを、複数ソースから優先順位付きで推定する。
 *
 * 【詳細説明】
 * - 1) printStore.current.id を最優先で採用する
 * - 2) storedData.printStartTime.rawValue から開始時刻IDを採用する
 * - 3) 直前の印刷ID (prevPrintID) を最後のフォールバックとして採用する
 * - いずれかで解決できた場合は、解決元とIDを console.debug で出力する
 * - 引数が未定義でも落ちないようにオプショナルチェーンで安全に参照する
 *
 * @function resolveFilamentJobId
 * @param {object} storedData - 現在の storedData オブジェクト
 * @param {object|null} job - printStore.current のジョブ情報
 * @param {string|null} prevPrintID - 直前の印刷ID（per-host state から取得）
 * @returns {string} 推定されたジョブID。未解決の場合は空文字列
 */
function resolveFilamentJobId(storedData, job, prevPrintID) {
  // 1) printStore.current.id を優先して解決する
  const jobId = job?.id ?? "";
  if (jobId !== "" && jobId != null) {
    const resolved = String(jobId);
    console.debug("resolveFilamentJobId: printStore.current.id", resolved);
    return resolved;
  }

  // 2) storedData.printStartTime.rawValue を開始時刻IDとして利用する
  const storedId = storedData?.printStartTime?.rawValue ?? "";
  if (storedId !== "" && storedId != null) {
    const resolved = String(storedId);
    console.debug("resolveFilamentJobId: storedData.printStartTime", resolved);
    return resolved;
  }

  // 3) 直前のID (prevPrintID) を最後のフォールバックとして利用する
  if (typeof prevPrintID !== "undefined" && prevPrintID != null) {
    const resolved = String(prevPrintID);
    console.debug("resolveFilamentJobId: prevPrintID", resolved);
    return resolved;
  }

  return "";
}

// ---------------------------------------------------------------------------
// ステータス Webhook 定期送信
// ---------------------------------------------------------------------------

/**
 * 接続中の全プリンタのステータスを Webhook で定期送信する。
 *
 * aggregatorUpdate() のループ末尾から呼び出される。
 * STATUS_SNAPSHOT_INTERVAL_SEC ごとに1回、全プリンタの現在状態を
 * `statusSnapshot` イベントとして Webhook に送信する。
 *
 * @private
 */
function _pushStatusSnapshotIfDue() {
  // スナップショット送信が無効、または Webhook URL が未設定なら何もしない
  if (!notificationManager.statusSnapshotEnabled) return;
  if (!notificationManager.getWebhookUrls ||
      notificationManager.getWebhookUrls().length === 0) return;

  const intervalSec = notificationManager.statusSnapshotIntervalSec || STATUS_SNAPSHOT_INTERVAL_SEC;
  const now = Date.now();
  if (now - _lastStatusSnapshotEpoch < intervalSec * 1000) return;
  _lastStatusSnapshotEpoch = now;

  const machines = {};
  let anyConnected = false;

  for (const [host, machine] of Object.entries(monitorData.machines)) {
    if (host === PLACEHOLDER_HOSTNAME) continue;
    const connState = getConnectionState(host);
    if (connState !== "connected") continue;
    anyConnected = true;

    const sd = machine.storedData || {};
    const spool = getCurrentSpool(host);

    const entry = {
      state:         Number(sd.state?.rawValue ?? 0),
      printProgress: Number(sd.printProgress?.rawValue ?? 0),
      filename:      (sd.printFileName?.rawValue || sd.fileName?.rawValue || "").split("/").pop() || "",
      layer:         Number(sd.layer?.rawValue ?? 0),
      totalLayer:    Number(sd.TotalLayer?.rawValue ?? 0),
      remainingSec:  Number(sd.printLeftTime?.rawValue ?? 0),
      nozzleTemp:    Number(sd.nozzleTemp?.rawValue ?? 0),
      bedTemp:       Number(sd.bedTemp0?.rawValue ?? 0),
    };

    if (spool) {
      const remainFmt = formatFilamentAmount(spool.remainingLengthMm, spool);
      entry.spoolId       = spool.id;
      entry.spoolName     = `${formatSpoolDisplayId(spool)} ${spool.name || ""}`.trim();
      entry.spoolRemain_mm  = spool.remainingLengthMm;
      entry.spoolRemain_pct = spool.totalLengthMm > 0
        ? Number(((spool.remainingLengthMm / spool.totalLengthMm) * 100).toFixed(1)) : null;
      if (remainFmt.g != null) entry.spoolRemain_g = Number(remainFmt.g);
      entry.material = spool.materialName || spool.material || "";
    }

    // 表示名解決
    const displayName = sd.hostname?.rawValue || sd.model?.rawValue || host;
    machines[displayName] = entry;
  }

  if (!anyConnected) return;

  // notify ではなく _sendWebHook を直接呼ぶ（通知UIに表示しない）
  const nowDate = new Date();
  const payload = {
    text: `3dpmon ステータス (${Object.keys(machines).length}台接続中)`,
    event: "statusSnapshot",
    hostname: "3dpmon",
    timestamp: nowDate.toISOString(),
    timestamp_epoch: nowDate.getTime(),
    timestamp_local: nowDate.toLocaleString(),
    timezone_offset_min: nowDate.getTimezoneOffset(),
    data: { machines }
  };

  const json = JSON.stringify(payload);
  notificationManager.getWebhookUrls().forEach(url => {
    try {
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: json
      }).catch(e => console.warn("[statusSnapshot] fetch failed:", url, e.message));
    } catch (e) {
      console.error("[statusSnapshot]", e);
    }
  });
}
