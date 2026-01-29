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
* @version 1.390.781 (PR #358)
* @since   1.390.193 (PR #86)
* @lastModified 2026-01-29 08:01:39
 * -----------------------------------------------------------
 * @todo
 * - none
 */
"use strict";

import { monitorData, currentHostname, setStoredData } from "./dashboard_data.js";
import { clearNewClasses, updateStoredDataToDOM } from "./dashboard_ui.js";
import { saveUnifiedStorage, loadPrintCurrent } from "./dashboard_storage.js";
import { updateTemperatureGraphFromStoredData } from "./dashboard_chart.js";
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
  beginExternalPrint
} from "./dashboard_spool.js";

// ---------------------------------------------------------------------------
// 状態変数／タイムスタンプ定義
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

// タイマー計測用
let tsPrepStart       = null, totalPrepSec       = 0;
let tsCheckStart      = null, totalCheckSec      = 0;
let tsPauseStart      = null, totalPauseSec      = 0;
let tsCompleteStart   = null;
let actualStartEpoch  = null;
let initialLeftSec    = null, initialLeftEpoch = null;
let prevPrintID       = null;
let lastPrintState    = PRINT_STATE_CODE.printIdle;

// 通知履歴 A～E 用
const PROGRESS_MILESTONES        = [50, 80, 90, 95, 98];
let prevProgress                 = 0;
let lastProgressTimestamp        = Date.now();
const notifiedProgressMilestones = new Set();

const TIME_THRESHOLDS            = [10, 5, 3, 1];
let prevRemainingSec             = null;
const notifiedTimeThresholds     = new Set();

const TEMP_MILESTONES            = [0.8, 0.9, 0.95, 0.98, 1.0];
const notifiedTempMilestones     = new Set();

let prevMaterialStatus           = null;
let currentMaterialStatus        = null;
let filamentOutTimer             = null;
let filamentLowWarned            = false;

/** スナップショット記録間隔 [秒] */
const USAGE_SNAPSHOT_INTERVAL = 30;
let lastUsageSnapshotSec = 0;
let snapshotPrintId = null;

// ---------------------------------------------------------------------------
// フィラメント使用量の追跡用変数
// ---------------------------------------------------------------------------
/** 前回受信した usedMaterialLength [mm] を保持 */
let prevUsedMaterialLength = null;
/** 前回処理した進捗率 [%]。進捗から使用量を推定する際に利用 */
let prevUsageProgress = 0;
/** セッション中に累積した実使用フィラメント長 [mm] */
let accumulatedUsedMaterial = 0;

// ---------------------------------------------------------------------------
// ingestData: WebSocket 生データ受領時の集計＆通知発火
// ---------------------------------------------------------------------------
/**
 * ingestData:
 *   - WebSocket 受信データ (`data`) と既存 storedData をマージしつつ、
 *     A. 進捗関連通知
 *     B. 残り時間閾値通知
 *     C. 温度近接アラート
 *     D. フィラメント切れ／交換
 *     E. 実印刷開始時刻 を逆算 
 *     F. 初回残り時間 を逆算
 *     G. タイマー集計＆予測フェーズへ aggregateTimersAndPredictions() 呼び出し
 *
 * @param {object} data  - WebSocket で受信した生データ
 *
 *   - WebSocket で受信した生データオブジェクト。  
 *     各フィールドは undefined, null, 数値, 文字列など多様。
 */
export function ingestData(data) {
  const nowMs  = Date.now();
  const nowSec = nowMs / 1000;

  // —— 値のマージ ——  
  // data に明示的なプロパティがあればそちらを優先、null は data 側 null と判定
  const { value: id,      source: srcId      } = getMergedValueWithSource("printStartTime", data);
  const { value: progRaw                   } = getMergedValueWithSource("printProgress",   data);
  const { value: jobRaw                    } = getMergedValueWithSource("printJobTime",    data);
  const { value: leftRaw                   } = getMergedValueWithSource("printLeftTime",   data);
  const { value: selfRaw                   } = getMergedValueWithSource("withSelfTest",    data);
  const { value: nozzleRaw                 } = getMergedValueWithSource("nozzleTemp",      data);
  const { value: maxNozzRaw                } = getMergedValueWithSource("maxNozzleTemp",   data);
  const { value: bedRaw                    } = getMergedValueWithSource("bedTemp0",        data);
  const { value: maxBedRaw                 } = getMergedValueWithSource("maxBedTemp",      data);
  const { value: matStatRaw                } = getMergedValueWithSource("materialStatus",  data);
  // "usedMaterialLength" が送られてくる場合があるため、まずはこちらを優先的に取得し、
  // なければ旧形式の "usagematerial" を参照する
  let   { value: matLenRaw, source: matSrc } =
    getMergedValueWithSource("materialLength", data, "usedMaterialLength");
  if (matSrc === "none") {
    ({ value: matLenRaw, source: matSrc } =
      getMergedValueWithSource("materialLength", data, "usagematerial"));
  }

  // —— キー初期化 ——  
  // まだ storedData に存在しないフィールドは rawValue=null で準備
  // printStartTime が未送信の場合は値を保持し、明示的な null のみクリアする
  if (srcId === "data-null") setStoredData("printStartTime",  null, true);
  if (jobRaw === null)    setStoredData("printJobTime",     null, true);
  if (leftRaw === null)   setStoredData("printLeftTime",    null, true);
  if (selfRaw === null)   setStoredData("withSelfTest",     null, true);
  if (matLenRaw === null) {
    const machine = monitorData.machines[currentHostname];
    if (machine && !("usedMaterialLength" in machine.storedData)) {
      setStoredData("usedMaterialLength", null, true);
    }
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
    // 実際に消費した長さとして usedMaterialLength に保存
    // 第4引数はJSON受信時以外では使用しない
    setStoredData("usedMaterialLength", matLen, true);
    // 後続処理用の推定値として materialLengthFallback に保持
    setStoredData("materialLengthFallback", matLen, true);
  }

  // (0) 新しい PrintID 検出 → 全リセット
  const validId = Number.isFinite(id) && id > 0;
  if (validId && id !== prevPrintID) {
    // 新しいジョブ開始時点でフィラメント使用量関連の変数を初期化
    accumulatedUsedMaterial = !isNaN(matLen) ? matLen : 0;
    prevUsedMaterialLength = !isNaN(matLen) ? matLen : null;
    prevUsageProgress = prog;

    if (prevPrintID === null && actualStartEpoch !== null) {
      // printJobTime から開始済みのジョブに ID が後から届いた場合
      const spool = getCurrentSpool();
      if (spool && spool.currentPrintID !== String(id)) {
        if (spool.currentJobExpectedLength == null) {
          // 予定使用量が未登録の場合は 0 で仮登録してIDのみ確定
          reserveFilament(0, String(id));
        } else {
          spool.currentPrintID = String(id);
        }
      }
      prevPrintID = id;
      // ---- 通知状態のリセット ----------------------------------------------
      // 新しい印刷ジョブ開始時点で、進捗・残り時間・温度関連の通知履歴を
      // 初期化しないと、前ジョブで一度発火した閾値を再度通知できなく
      // なるため、各種 Set と直近の値をリセットする
      notifiedProgressMilestones.clear();
      notifiedTimeThresholds.clear();
      notifiedTempMilestones.clear();
      prevProgress = 0;
      lastProgressTimestamp = nowMs;
      prevRemainingSec = null;
      if (historyPersistFunc) {
        try {
          historyPersistFunc(id);
        } catch (e) {
          console.error("historyPersistFunc error", e);
        }
      }
    } else {

      tsPrepStart = tsCheckStart = tsPauseStart = tsCompleteStart = null;
      totalPrepSec = totalCheckSec = totalPauseSec = 0;
      actualStartEpoch = initialLeftSec = initialLeftEpoch = null;
      [
        "preparationTime","firstLayerCheckTime","pauseTime","completionElapsedTime",
        "actualStartTime","initialLeftTime","initialLeftAt",
        "estimatedRemainingTime","estimatedCompletionTime"
      ].forEach(f => {
        // rawValue, computedValue 両方クリア
        setStoredData(f, null, true);
        setStoredData(f, null, false);
      });
    }

    const spool = getCurrentSpool();
    if (spool && spool.currentPrintID !== String(id)) {
      if (spool.currentJobExpectedLength == null) {
        // 予定使用量が未登録の場合は 0 で仮登録してIDのみ確定
        reserveFilament(0, String(id));
      } else {
        spool.currentPrintID = String(id);
      }
    }
    prevPrintID = id;
    if (historyPersistFunc) {
      try {
        historyPersistFunc(id);
      } catch (e) {
        console.error("historyPersistFunc error", e);
      }

      prevPrintID = id;
      // ---- 通知状態のリセット ----------------------------------------------
      // 新しい印刷ジョブ開始時点で、進捗・残り時間・温度関連の通知履歴を
      // 初期化しないと、前ジョブで一度発火した閾値を再度通知できなく
      // なるため、各種 Set と直近の値をリセットする
      notifiedProgressMilestones.clear();
      notifiedTimeThresholds.clear();
      notifiedTempMilestones.clear();
      prevProgress = 0;
      lastProgressTimestamp = nowMs;
      prevRemainingSec = null;

    }
  }

  // A. プリント進捗通知 ------------------------------------------------------
  if (prog !== prevProgress) {
    notificationManager.notify("printProgressUpdated", { previous: prevProgress, current: prog });
    lastProgressTimestamp = nowMs;
  }
  PROGRESS_MILESTONES.forEach(ms => {
    if (prog >= ms && !notifiedProgressMilestones.has(ms)) {
      notifiedProgressMilestones.add(ms);
      notificationManager.notify("printProgressMilestone", { milestone: ms });
    }
  });
  // 長時間停滞検知 (10分)
  if (prog === prevProgress && nowMs - lastProgressTimestamp > 10 * 60 * 1000) {
    notificationManager.notify("printProgressStalled", {
      progress: prog,
      stalledFor: formatDurationSimple((nowMs - lastProgressTimestamp) / 1000)
    });
    lastProgressTimestamp = nowMs;
  }
  // 完了通知
  if (prevProgress < 100 && prog >= 100) {
    notificationManager.notify("printProgressComplete");
  }
  prevProgress = prog;

  // B. 残り時間閾値通知 ------------------------------------------------------
  if (!isNaN(left)) {
    if (prevRemainingSec === null) {
      prevRemainingSec = left;
    } else {
      TIME_THRESHOLDS.forEach(mins => {
        const thr = mins * 60;
        if (prevRemainingSec > thr && left <= thr && !notifiedTimeThresholds.has(mins)) {
          notifiedTimeThresholds.add(mins);
          notificationManager.notify(`timeLeft${mins}`, {
            thresholdMin: mins,
            remainingSec: left,
            remainingPretty: formatDurationSimple(left)
          });
        }
      });
      prevRemainingSec = left;
    }
  }

  // C. 温度近接アラート ------------------------------------------------------
  if (!isNaN(nozzle) && !isNaN(maxNozz) && maxNozz > 0) {
    TEMP_MILESTONES.forEach(r => {
      const key = Math.round(r * 100);
      if (nozzle >= maxNozz * r && !notifiedTempMilestones.has(`nozzle${key}`)) {
        notifiedTempMilestones.add(`nozzle${key}`);
        notificationManager.notify(`tempNearNozzle${key}`, {
          ratio: r,
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
      if (bed >= maxBed * r && !notifiedTempMilestones.has(`bed${key}`)) {
        notifiedTempMilestones.add(`bed${key}`);
        notificationManager.notify(`tempNearBed${key}`, {
          ratio: r,
          ratioPct: Math.round(r * 100),
          currentTemp: bed,
          maxTemp: maxBed
        });
      }
    });
  }

  // D. フィラメント切れ／交換 ------------------------------------------------
  currentMaterialStatus = matStat;
  if (prevMaterialStatus !== null) {
    if (prevMaterialStatus === 0 && matStat === 1) {
      notificationManager.notify("filamentOut");
      if (filamentOutTimer) clearTimeout(filamentOutTimer);
      filamentOutTimer = setTimeout(() => {
        if (currentMaterialStatus === 1) {
          showFilamentChangeDialog();
        }
      }, 2000);
    }
    if (prevMaterialStatus === 1 && matStat === 0) {
      notificationManager.notify("filamentReplaced");
      if (filamentOutTimer) {
        clearTimeout(filamentOutTimer);
        filamentOutTimer = null;
      }
    }
  }
  prevMaterialStatus = matStat;

  // E. —— 実印刷開始時刻 を必ず逆算 ------------------------------------------------
  if (actualStartEpoch === null && jobTime >= 1) {
    // ジョブタイムが増え始めた瞬間を actualStartEpoch の元に
    actualStartEpoch = nowSec - jobTime;
    setStoredData("actualStartTime", actualStartEpoch, true);

    // ---- 新規印刷スタート時の通知状態リセット ------------------------------
    // printStartTime がまだ届いていないケースでも、jobTime が進み始めた
    // 時点で前回ジョブの残り時間通知などを初期化する。これにより長時間
    // ジョブを中断後に短時間ジョブを開始した際、残りn分通知が一斉発火
    // してしまう問題を防ぐ。
    notifiedProgressMilestones.clear();
    notifiedTimeThresholds.clear();
    notifiedTempMilestones.clear();
    prevProgress = 0;
    lastProgressTimestamp = nowMs;
    prevRemainingSec = null;

    if (historyPersistFunc && id) {
      try {
        historyPersistFunc(id);
      } catch (e) {
        console.error("historyPersistFunc error", e);
      }
    }

    // ----- 印刷前準備時間の確定 -----
    if (tsPrepStart !== null) {
      const diff = Math.floor((actualStartEpoch * 1000 - tsPrepStart) / 1000);
      if (diff > 0) totalPrepSec += diff;
      tsPrepStart = null;
      setStoredData("preparationTime", totalPrepSec, true);
    } else if (totalPrepSec === 0 && id) {
      const diff = Math.floor(actualStartEpoch - id);
      if (diff > 0) {
        totalPrepSec = diff;
        setStoredData("preparationTime", totalPrepSec, true);
      }
    }

  }

  // F. —— 初回残り時間 を必ず逆算 ------------------------------------------------
  if (initialLeftSec === null && left >= 0 && actualStartEpoch !== null) {
    initialLeftSec   = left;
    initialLeftEpoch = actualStartEpoch + left;

    // rawValue に秒数／エポックをセット
    setStoredData("initialLeftTime", initialLeftSec, true);
    setStoredData("initialLeftAt",   initialLeftEpoch, true);

  }

  // G. タイマー集計＆予測フェーズへ ------------------------------------------------
  aggregateTimersAndPredictions(data);

  // --- 印刷完了時のフィラメント使用量確定処理 -----------------------------
  const st_agg = Number(data.state);
  const prog_agg = Number(data.printProgress ?? 0);
  const prevPrintState_agg = Number(
    monitorData.machines[currentHostname]?.runtimeData?.state ?? 0
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
    const spool = getCurrentSpool();
    // ジョブIDが未確定の場合は、利用可能な情報から補完して確定処理に備える
    if (spool && !spool.currentPrintID) {
      const machine = monitorData.machines[currentHostname];
      const resolvedJobId = resolveFilamentJobId(
        machine?.storedData,
        machine?.printStore?.current ?? null
      );
      if (resolvedJobId) {
        spool.currentPrintID = resolvedJobId;
      }
    }
    if (!isNaN(Number(data.usedMaterialLength))) {
      const cur = Number(data.usedMaterialLength);
      if (prevUsedMaterialLength != null) {
        const d = cur - prevUsedMaterialLength;
        if (d > 0) accumulatedUsedMaterial += d;
      } else {
        // これが初回値の場合はそのまま累積値とする
        accumulatedUsedMaterial += cur;
      }
      prevUsedMaterialLength = cur;
      prevUsageProgress = prog_agg;
    } else {
      let est = spool?.currentJobExpectedLength ?? NaN;
      if ((isNaN(est) || est <= 0) && data.fileName) {
        est = guessExpectedLength(String(data.fileName));
      }
      if (!isNaN(est) && est > 0) {
        // 進捗率ベースの推定は常に絶対値で算出し、
        // 推定値が途中で判明した場合でも正しい使用量に補正する
        accumulatedUsedMaterial = (est * prog_agg) / 100;
      }
      // 進捗の基準値は常に最新を保持しておく
      prevUsageProgress = prog_agg;
    }
    let length = accumulatedUsedMaterial;
    const jobId_agg = spool?.currentPrintID || String(data.printStartTime || "");
    if (jobId_agg) {
      if (length <= 0) {
        // usedMaterialLength が得られない場合は進捗とファイル情報から推定
        let est = spool?.currentJobExpectedLength ?? NaN;
        if ((isNaN(est) || est <= 0) && data.fileName) {
          est = guessExpectedLength(String(data.fileName));
        }
        if (!isNaN(est) && prog_agg > 0) {
          length = (est * prog_agg) / 100;
        }
      }
      finalizeFilamentUsage(length, jobId_agg);
      saveUnifiedStorage();
      accumulatedUsedMaterial = 0;
      prevUsedMaterialLength = null;
      prevUsageProgress = 0;
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
 * - getMergedValueWithSource で data と storedData をマージ取得
 * - PrintID 切替や一時停止の再開処理を反映
 * - 各種タイマー値を算出し storedData へ保存
 * - 予想終了時刻等の計算結果も合わせて反映する
 *
 * @function aggregateTimersAndPredictions
 * @param {object} data - 最新の受信データ
 * @returns {void}
 */
function aggregateTimersAndPredictions(data) {
  const nowMs  = Date.now();
  const nowSec = nowMs / 1000;

  const machine = monitorData.machines[currentHostname];
  const storedData = machine?.storedData || {};

  // ---- 完了後経過タイマーの復元処理 ------------------------------
  if (tsCompleteStart === null) {
    const machine = monitorData.machines[currentHostname];
    const last = machine?.historyData?.[machine.historyData.length - 1];
    if (
      last &&
      prevPrintID !== null &&
      Number(last.id) === Number(prevPrintID) &&
      last.finishTime
    ) {
      const fin = Date.parse(last.finishTime);
      if (!isNaN(fin)) {
        tsCompleteStart = fin;
        setStoredData(
          "completionElapsedTime",
          Math.floor((nowMs - fin) / 1000),
          true
        );
      }
    }
  }

  // ── 1) data と storedData のマージ取得 ────────────────────────────────
  const { value: idRaw   } = getMergedValueWithSource("printStartTime", data);
  const { value: stRaw   } = getMergedValueWithSource("state",          data);
  const { value: jobRaw  } = getMergedValueWithSource("printJobTime",   data);
  const { value: selfRaw } = getMergedValueWithSource("withSelfTest",   data);
  const { value: progRaw } = getMergedValueWithSource("printProgress",  data);
  const { value: leftRaw } = getMergedValueWithSource("printLeftTime",  data);
  const { value: deviceRaw } = getMergedValueWithSource("deviceState", data);
  const { value: finishRaw } = getMergedValueWithSource("printFinishTime", data);

  const id      = Number(idRaw)   || null;
  const st      = Number(stRaw)   || 0;
  const job     = Number(jobRaw)  || 0;
  const selfPct = Number(selfRaw) || 0;
  const progPct = (Number(progRaw) || 0) / 100;
  const left    = Number(leftRaw) || 0;
  const device  = Number(deviceRaw) || 0;
  const finish  = Number(finishRaw) || 0;

  // ── 2) PrintID 切替検出 → 各種リセット ────────────────────────────────────
  const validId_ap = Number.isFinite(id) && id > 0;
  if (prevPrintID !== null && validId_ap && id !== prevPrintID) {
    {
      tsPrepStart   = tsCheckStart   = tsPauseStart   = tsCompleteStart   = null;
      totalPrepSec  = totalCheckSec  = totalPauseSec                      = 0;
      prevPrintID   = id;
    }
  }
  else if (prevPrintID === null && validId_ap) {
    // 初回読み込み時だけは prevPrintID をセットして、次回以降の切替検出に備える
    prevPrintID = id;
  }

  // ── 3) 一時停止→再開 のシフト補正 ─────────────────────────────────
  const prevState = Number(monitorData.machines[currentHostname].runtimeData.state) || 0;
  if (
    prevState === PRINT_STATE_CODE.printPaused &&
    st        === PRINT_STATE_CODE.printStarted &&
    tsPauseStart
  ) {
    totalPauseSec += Math.floor((nowMs - tsPauseStart) / 1000);
    tsPauseStart   = null;
  }

  // ── 4) タイマー集計／表示用セット ─────────────────────────────────
  // 4-1. 印刷前準備時間
  if (
    st === PRINT_STATE_CODE.printStarted &&
    job === 0 &&
    selfPct >= 0 && selfPct <= 9 &&
    !tsCheckStart &&
    !tsPauseStart
  ) {
    if (!tsPrepStart) {
      // ----- 再読み込み時にタイマーがリセットされないよう印刷開始時刻を基準に補正
      // printStartTime(id) が取得できていればそこからの経過秒を算出する
      // まだ得られていない場合は現在時刻から計測を開始する
      tsPrepStart = id ? id * 1000 : nowMs;
    }
    const sec = totalPrepSec + Math.floor((nowMs - tsPrepStart) / 1000);
    // internal
    setStoredData("preparationTime", sec, true);
  } else if (tsPrepStart) {
    totalPrepSec += Math.floor((nowMs - tsPrepStart) / 1000);
    tsPrepStart   = null;
    setStoredData("preparationTime", totalPrepSec, true);
  }

  // 4-2. ファーストレイヤー確認時間
  if (
    tsPrepStart === null &&
    tsPauseStart === null &&
    actualStartEpoch !== null &&
    (st === PRINT_STATE_CODE.printStarted || st === PRINT_STATE_CODE.printPaused || st === 3) &&
    selfPct >= 30 && selfPct <= 39
  ) {
    if (!tsCheckStart) tsCheckStart = nowMs;
    const sec = totalCheckSec + Math.floor((nowMs - tsCheckStart) / 1000);
    setStoredData("firstLayerCheckTime", sec, true);
  } else if (
    tsCheckStart &&
    (
      (
        st !== PRINT_STATE_CODE.printStarted &&
        st !== PRINT_STATE_CODE.printPaused &&
        st !== 3
      ) ||
      selfPct < 30 ||
      selfPct > 39 ||
      tsPrepStart !== null ||
      tsPauseStart !== null
    )
  ) {
    totalCheckSec += Math.floor((nowMs - tsCheckStart) / 1000);
    tsCheckStart   = null;
    setStoredData("firstLayerCheckTime", totalCheckSec, true);
  }

  // 4-3. 一時停止時間
  if (
    tsPrepStart === null &&
    tsCheckStart === null &&
    (st === PRINT_STATE_CODE.printPaused || st === 3) &&
    job >= 1 &&
    (
      selfPct === 0 ||
      (selfPct >= 10 && selfPct <= 29) ||
      (selfPct >= 40 && selfPct <= 100)
    )
  ) {
    if (!tsPauseStart) tsPauseStart = nowMs;
    const sec = totalPauseSec + Math.floor((nowMs - tsPauseStart) / 1000);
    setStoredData("pauseTime", sec, true);
    setStoredData("pauseTime", { value: formatDuration(sec), unit: "" }, false);
  } else if (
    tsPauseStart &&
    (
      (st !== PRINT_STATE_CODE.printPaused && st !== 3) ||
      job < 1 ||
      (
        selfPct !== 0 &&
        !(selfPct >= 10 && selfPct <= 29) &&
        !(selfPct >= 40 && selfPct <= 100)
      ) ||
      tsPrepStart !== null ||
      tsCheckStart !== null
    )
  ) {
    totalPauseSec += Math.floor((nowMs - tsPauseStart) / 1000);
    tsPauseStart   = null;
    setStoredData("pauseTime", totalPauseSec, true);
  }

  // 4-4. 完了後経過時間
  const doneStates = new Set([
    PRINT_STATE_CODE.printDone,
    PRINT_STATE_CODE.printFailed
  ]);
  const isIdle = device === PRINT_STATE_CODE.printIdle;
  if (isIdle && doneStates.has(st)) {
    if (!tsCompleteStart) {
      tsCompleteStart = nowMs;
      setStoredData("completionElapsedTime", 0, true);
    }
    const sec = Math.floor((nowMs - tsCompleteStart) / 1000);
    setStoredData("completionElapsedTime", sec, true);
  } else if (
    tsCompleteStart &&
    (st === PRINT_STATE_CODE.printStarted ||
     (prevState === PRINT_STATE_CODE.printPaused && st !== PRINT_STATE_CODE.printPaused))
  ) {
    tsCompleteStart = null;
    setStoredData("completionElapsedTime", null, true);
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
      setStoredData("predictedFinishEpoch",    null, true);
      setStoredData("estimatedRemainingTime",  null, true);
      setStoredData("estimatedCompletionTime", null, true);
    } else if (actualStartEpoch !== null && progPct > 0) {
      const elapsed  = (nowSec - actualStartEpoch) - (totalCheckSec + totalPauseSec);
      const totalEst = elapsed / progPct;
      const remSec   = totalEst - elapsed;
      const finishE  = nowSec + remSec;
      // raw epoch
      setStoredData("predictedFinishEpoch",    Math.floor(finishE), true);
      // display datetime
      setStoredData("estimatedRemainingTime",  Math.floor(remSec),   true);
      setStoredData("estimatedCompletionTime", Math.floor(finishE), true);
    }
    // フォールバック：初回残り時間ベース
    else if (
      actualStartEpoch   !== null &&
      initialLeftSec     !== null &&
      initialLeftEpoch   !== null
    ) {
      setStoredData("predictedFinishEpoch",    initialLeftEpoch, true);
      setStoredData("estimatedRemainingTime",  initialLeftSec,   true);
      setStoredData("estimatedCompletionTime", initialLeftEpoch, true);
    }
  }, storedData);

  // ── 6) 状態永続化 ─────────────────────────────────────────────
  persistAggregatorState();
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

  //まだ機器選定されてない場合はスキップ
  if (!currentHostname || currentHostname === PLACEHOLDER_HOSTNAME) return;
  
  const machine = monitorData.machines[currentHostname];
  if (!machine) return;
  const storedData = machine.storedData;

  // --- ここでタイマー／予測用フィールド群が揃っているか確認 ---
  const needed = ["preparationTime","firstLayerCheckTime","pauseTime","completionElapsedTime",
                  "actualStartTime","initialLeftTime","initialLeftAt",
                  "predictedFinishEpoch","estimatedRemainingTime","estimatedCompletionTime",
                  "expectedEndTime"];
  needed.forEach(key => {
    if (!(key in storedData)) { //キーが無い場合
      // rawValueを「未定義(null)」で作っておく
      setStoredData(key, null, true);
    }
  });

  //const allReady = needed.every(key =>
  //  storedData[key] && storedData[key].rawValue !== null && storedData[key].rawValue !== undefined
  //);
  // 必要なキーがすべて storedData に定義されていればOK （rawValue の中身は問わない）
  const allReady = needed.every(key => key in storedData);


  if (!allReady) {
    // まだ必要な値が揃っていないので UI 更新をスキップ
    return;
  }

  // init完了しているので以下を実行できる状態：

  clearNewClasses();

  // state→printState
  checkUpdatedFields(["state"], () => {
    const raw = storedData.state?.rawValue;
    if (raw !== undefined) {
      setStoredData("printState", raw, true);
      setStoredData("printState", { value: String(raw), unit: "" });
    }
  }, storedData);

  // fileName 表示抽出
  checkUpdatedFields(["fileName"], () => {
    const raw = storedData.fileName?.rawValue;
    if (raw) {
      const name = String(raw).split("/").pop();
      setStoredData("fileName", raw, true);
      setStoredData("fileName", { value: name, unit: "" });
    }
  }, storedData);

  // nozzleDiff / bedDiff
  checkUpdatedFields(["nozzleTemp","targetNozzleTemp"], () => {
    const c = parseFloat(storedData.nozzleTemp?.rawValue||0);
    const t = parseFloat(storedData.targetNozzleTemp?.rawValue||0);
    if (!isNaN(c)&&!isNaN(t)) {
      const d = (c - t).toFixed(2);
      setStoredData("nozzleDiff",{ value:`${d>0?"+":""}${d} ℃`, unit:"" });
    }
  }, storedData);
  checkUpdatedFields(["bedTemp0","targetBedTemp0"], () => {
    const c = parseFloat(storedData.bedTemp0?.rawValue||0);
    const t = parseFloat(storedData.targetBedTemp0?.rawValue||0);
    if (!isNaN(c)&&!isNaN(t)) {
      const d = (c - t).toFixed(2);
      setStoredData("bedDiff",{ value:`${d>0?"+":""}${d} ℃`, unit:"" });
    }
  }, storedData);

  updateTemperatureGraphFromStoredData(storedData);

  // printFinishTime 再計算
  checkUpdatedFields(["printStartTime","printLeftTime"], () => {
    const s = parseInt(storedData.printStartTime?.rawValue,10)||0;
    const l = parseInt(storedData.printLeftTime?.rawValue,10);
    if (s>0 && !isNaN(l)&&l>=0) {
      const e = Math.floor(Date.now()/1000) + l;
      setStoredData("printFinishTime", e, true);
      setStoredData("printFinishTime", {
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
    setStoredData("expectedEndTime", val, true);
  }, storedData);

  // --- フィラメント残量の動的計算 ---
  const spool = getCurrentSpool();
  if (spool) autoCorrectCurrentSpool();
  const st   = Number(storedData.state?.rawValue || 0);
  const isPrinting =
    st === PRINT_STATE_CODE.printStarted ||
    st === PRINT_STATE_CODE.printPaused;
  // フィラメント残量計算に入る前に、未確定のジョブIDを補完して紐付け漏れを防ぐ
  if (spool && !spool.currentPrintID) {
    const resolvedJobId = resolveFilamentJobId(
      storedData,
      machine?.printStore?.current ?? null
    );
    if (resolvedJobId) {
      spool.currentPrintID = resolvedJobId;
    }
  }

  // アイドル状態から印刷開始へ遷移し、useFilament() が未実行の場合の初期化
  if (
    spool &&
    lastPrintState === PRINT_STATE_CODE.printIdle &&
    st === PRINT_STATE_CODE.printStarted &&
    spool.currentJobStartLength == null
  ) {
    let est = Number(storedData.materialLength?.rawValue ?? NaN);
    if (isNaN(est)) {
      est = Number(storedData.materialLengthFallback?.rawValue ?? NaN);
    }
    const job = loadPrintCurrent();
    const jobId = job?.id ?? "";
    if ((isNaN(est) || est <= 0) && storedData.fileName?.rawValue) {
      est = guessExpectedLength(storedData.fileName.rawValue);
    }
    beginExternalPrint(spool, isNaN(est) ? 0 : est, jobId);
    accumulatedUsedMaterial = 0;
    prevUsedMaterialLength = Number(storedData.usedMaterialLength?.rawValue);
    prevUsageProgress = parseInt(storedData.printProgress?.rawValue || 0, 10);
  }
  // usedMaterialLength 受信時、または復元直後に currentJobStartLength が未設定の
  // 状態で印刷が進行中の場合に残量計算を開始
  // usedMaterialLength が送られてこない場合でも印刷中は残量計算と保存を継続する
  if (spool && (isPrinting || spool.currentJobStartLength != null)) {
    if (spool.currentJobStartLength == null) {
      // 印刷開始直後にスプール残量を記録し、使用量カウンタを初期化
      spool.currentJobStartLength = spool.remainingLengthMm;
      accumulatedUsedMaterial = 0;
      prevUsedMaterialLength = Number(storedData.usedMaterialLength?.rawValue);
      prevUsageProgress = parseInt(storedData.printProgress?.rawValue || 0, 10);
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
      const job = loadPrintCurrent();
      let len   = Number(job?.materialUsedMm ?? NaN);
      const jobId = job?.id ?? "";
      if (isNaN(len) || len <= 0) {
        len = est;
      }
      if ((isNaN(len) || len <= 0) && storedData.fileName?.rawValue) {
        len = guessExpectedLength(storedData.fileName.rawValue);
      }
      if (spool.currentJobExpectedLength == null || spool.currentPrintID !== jobId) {
        // フィラメントIDのみ先に確定し、使用量が判明してから予約する
        const machine = monitorData.machines[currentHostname];
        if (machine?.printStore?.current) {
          machine.printStore.current.filamentId = spool.id;
        }
        if (!isNaN(len) && len > 0) {
          beginExternalPrint(spool, len, jobId);
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
        if (prevUsedMaterialLength != null) {
          delta = used - prevUsedMaterialLength;
          if (delta < 0) delta = 0; // マイナス値は無視
        } else {
          // 初回受信時はそのまま累積値として扱う
          delta = used;
        }
        prevUsedMaterialLength = used;
        // usedMaterialLength が得られた場合でも進捗基準を同期しておく
        prevUsageProgress = prog;
      } else if (!isNaN(est) && est > 0) {
        // 推定値が途中で判明しても正しい値に補正できるよう、
        // 差分ではなく絶対値で使用量を算出する
        accumulatedUsedMaterial = (est * prog) / 100;
        delta = 0;
        prevUsageProgress = prog;
      }
      accumulatedUsedMaterial += delta;
      remain = spool.currentJobStartLength - accumulatedUsedMaterial;
      // 印刷途中にページを更新しても残量が巻き戻らないよう、
      // 計算値をスプールオブジェクトへ反映しておく
      spool.remainingLengthMm = Math.max(0, remain);
    } else if (
      spool.currentJobStartLength != null &&
      (Number(monitorData.machines[currentHostname]?.runtimeData?.state) ===
        PRINT_STATE_CODE.printStarted ||
        Number(monitorData.machines[currentHostname]?.runtimeData?.state) ===
          PRINT_STATE_CODE.printPaused) &&
      st !== PRINT_STATE_CODE.printStarted &&
      st !== PRINT_STATE_CODE.printPaused
    ) {
      // 状態が完了・失敗等へ遷移した場合は累積使用量で確定
      if (spool && !spool.currentPrintID) {
        const resolvedJobId = resolveFilamentJobId(
          storedData,
          machine?.printStore?.current ?? null
        );
        if (resolvedJobId) {
          spool.currentPrintID = resolvedJobId;
        }
      }
      finalizeFilamentUsage(accumulatedUsedMaterial, spool.currentPrintID);
      saveUnifiedStorage();
      accumulatedUsedMaterial = 0;
      prevUsedMaterialLength = null;
      prevUsageProgress = 0;
      remain = spool.remainingLengthMm;
    }

    // 小数点以下2桁に丸めて保持
    remain = Math.round(remain * 100) / 100;
    setStoredData("filamentRemainingMm", remain, true);

    if (spool.currentPrintID) {
      if (snapshotPrintId !== spool.currentPrintID) {
        snapshotPrintId = spool.currentPrintID;
        lastUsageSnapshotSec = 0;
      }
      if (
        (st === PRINT_STATE_CODE.printStarted || st === PRINT_STATE_CODE.printPaused) &&
        (!lastUsageSnapshotSec || Date.now() / 1000 - lastUsageSnapshotSec >= USAGE_SNAPSHOT_INTERVAL)
      ) {
        addUsageSnapshot(spool, spool.currentPrintID, remain);
        lastUsageSnapshotSec = Date.now() / 1000;
      }
    } else {
      snapshotPrintId = null;
      lastUsageSnapshotSec = 0;
    }

    const thr = notificationManager.getFilamentLowThreshold?.() ?? 0.1;
    if (spool.totalLengthMm > 0) {
      const ratio = remain / spool.totalLengthMm;
      if (ratio <= thr && !filamentLowWarned) {
        filamentLowWarned = true;
        notificationManager.notify("filamentLow", {
          remaining: remain,
          thresholdPct: Math.round(thr * 100),
          spoolName: spool.name
        });
      } else if (ratio > thr) {
        filamentLowWarned = false;
      }
    }
  }

    updateStoredDataToDOM();
    lastPrintState = st;
    persistAggregatorState();
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
function guessExpectedLength(filePath) {
  const machine = monitorData.machines[currentHostname];
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
export function restoreAggregatorState() {
  const host = currentHostname;
  if (!host) return;
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
    // rawValue と computedValue 両方クリア
    setStoredData(k, null, true);
    setStoredData(k, null, false);
  });
  // localStorage から読み出し
  keys.forEach(k => {
    const raw = localStorage.getItem(prefix + k);
    if (raw == null) return;
    let v;
    try { v = JSON.parse(raw); } catch { return; }
    // 内部変数にセット
    switch (k) {
      case "tsPrepStart":      tsPrepStart      = v; break;
      case "totalPrepSec":     totalPrepSec     = v; break;
      case "tsCheckStart":     tsCheckStart     = v; break;
      case "totalCheckSec":    totalCheckSec    = v; break;
      case "tsPauseStart":     tsPauseStart     = v; break;
      case "totalPauseSec":    totalPauseSec    = v; break;
      case "tsCompleteStart":  tsCompleteStart  = v; break;
      case "actualStartEpoch": actualStartEpoch = v; break;
      case "initialLeftSec":   initialLeftSec   = v; break;
      case "initialLeftEpoch": initialLeftEpoch = v; break;
      case "prevPrintID":      prevPrintID      = v; break;
      case "accumulatedUsedMaterial": accumulatedUsedMaterial = v; break;
      case "prevUsedMaterialLength": prevUsedMaterialLength = v; break;
      case "prevUsageProgress": prevUsageProgress = v; break;
    }
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
    setStoredData(field, v, true);
  });

  // 復元後に actualStartTime が存在し印刷ID も分かっている場合は
  // 履歴に反映して UI を即時更新する
  if (historyPersistFunc && prevPrintID && actualStartEpoch != null) {
    try {
      historyPersistFunc(prevPrintID);
    } catch (e) {
      console.error("historyPersistFunc error", e);
    }
  }
}

/**
 * persistAggregatorState:
 *   現在の集約状態を localStorage に保存します。
 */
export function persistAggregatorState() {
  const host = currentHostname;
  if (!host) {
    console.warn("persistAggregatorState: ホスト未設定");
    return;
  }
  const prefix = `aggr_${host}_`;
  const toSave = {
    tsPrepStart, totalPrepSec,
    tsCheckStart, totalCheckSec,
    tsPauseStart, totalPauseSec,
    tsCompleteStart,
    actualStartEpoch,
    initialLeftSec, initialLeftEpoch,
    prevPrintID,
    accumulatedUsedMaterial,
    prevUsedMaterialLength,
    prevUsageProgress
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

    persistAggregatorState();
  }
}

/**
 * getCurrentPrintID:
 *   集約モジュールが保持する現在の印刷IDを返します。
 *   初期化前や未検出時は `null` を返します。
 *
 * @returns {number|null} 現在の印刷ID
 */
export function getCurrentPrintID() {
  return prevPrintID;
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
function getMergedValueWithSource(key, data, dataFieldName = key) {
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
  const machine = monitorData.machines[currentHostname];
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
 * @returns {string} 推定されたジョブID。未解決の場合は空文字列
 */
function resolveFilamentJobId(storedData, job) {
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
