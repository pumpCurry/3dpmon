/**
 * @fileoverview
 * dashboard_aggregator.js (Ver.1.331)
 * - 印刷ワークフローの集計（準備時間・セルフテスト時間・一時停止時間・完了後経過時間）
 * - 実印刷開始時刻 & 予想残り時間／予想終了時刻 の計算
 * - ingestData(): ビジネスロジック集中、A～E の通知発火
 * - aggregateTimersAndPredictions(): タイマー集計＆予測
 * - aggregatorUpdate(): UI 更新と永続化
 * - restoreAggregatorState(), persistAggregatorState(): 状態の永続化／復元
 * - restartAggregatorTimer(), stopAggregatorTimer(): 集約ループの制御
 */

"use strict";

import { monitorData, currentHostname, setStoredData } from "./dashboard_data.js";
import { clearNewClasses, updateStoredDataToDOM } from "./dashboard_ui.js";
import { saveUnifiedStorage } from "./dashboard_storage.js";
import { updateTemperatureGraphFromStoredData } from "./dashboard_chart.js";
import { checkUpdatedFields, formatDuration } from "./dashboard_utils.js";
import { notificationManager } from "./dashboard_notification_manager.js";
import { formatDurationSimple } from "./dashboard_utils.js";
import { PRINT_STATE_CODE } from "./dashboard_ui_mapping.js";
import { PLACEHOLDER_HOSTNAME } from "./dashboard_data.js";

// ---------------------------------------------------------------------------
// 状態変数／タイムスタンプ定義
// ---------------------------------------------------------------------------

/** aggregatorUpdate 用タイマー ID */
let aggregatorTimer = null;


// aggrigateタイマー開始検知
let hasStartedAggregator = false;

// タイマー計測用
let tsPrepStart       = null, totalPrepSec       = 0;
let tsCheckStart      = null, totalCheckSec      = 0;
let tsPauseStart      = null, totalPauseSec      = 0;
let tsCompleteStart   = null;
let actualStartEpoch  = null;
let initialLeftSec    = null, initialLeftEpoch = null;
let prevPrintID       = null;

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

  // —— キー初期化 ——  
  // まだ storedData に存在しないフィールドは rawValue=null で準備
  if (srcId === "none")  setStoredData("printStartTime",  null, true);
  if (jobRaw === null)    setStoredData("printJobTime",     null, true);
  if (leftRaw === null)   setStoredData("printLeftTime",    null, true);
  if (selfRaw === null)   setStoredData("withSelfTest",     null, true);

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

  // (0) 新しい PrintID 検出 → 全リセット
  if (id !== prevPrintID) {
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
    prevPrintID = id;
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
        notificationManager.notify(`tempNearNozzle${key}`, { ratio: r, currentTemp: nozzle, maxTemp: maxNozz });
      }
    });
  }
  if (!isNaN(bed) && !isNaN(maxBed) && maxBed > 0) {
    TEMP_MILESTONES.forEach(r => {
      const key = Math.round(r * 100);
      if (bed >= maxBed * r && !notifiedTempMilestones.has(`bed${key}`)) {
        notifiedTempMilestones.add(`bed${key}`);
        notificationManager.notify(`tempNearBed${key}`, { ratio: r, currentTemp: bed, maxTemp: maxBed });
      }
    });
  }

  // D. フィラメント切れ／交換 ------------------------------------------------
  if (prevMaterialStatus !== null) {
    if (prevMaterialStatus === 0 && matStat === 1) {
      notificationManager.notify("filamentOut");
    }
    if (prevMaterialStatus === 1 && matStat === 0) {
      notificationManager.notify("filamentReplaced");
    }
  }
  prevMaterialStatus = matStat;

  // E. —— 実印刷開始時刻 を必ず逆算 ------------------------------------------------
  if (actualStartEpoch === null && jobTime >= 1) {
    // ジョブタイムが増え始めた瞬間を actualStartEpoch の元に
    actualStartEpoch = nowSec - jobTime;
    setStoredData("actualStartTime", actualStartEpoch, true);

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
 * - getMergedValueWithSource で data と storedData をマージ取得
 * - PrintID 切替／一時停止→再開 のリセット処理を追加
 * - 準備時間／セルフテスト時間／一時停止時間／完了後経過時間 は
 *   formatDuration() で「hh:mm:ss(秒)」表記
 * - 予想終了時刻など epoch 値は formatEpochToDateTime() で日付文字列化
 * - rawValue=true （内部計算用）と rawValue=false（表示用 computedValue）を両方セット
 */
function aggregateTimersAndPredictions(data) {
  const nowMs  = Date.now();
  const nowSec = nowMs / 1000;

  // ── 1) data と storedData のマージ取得 ────────────────────────────────
  const { value: idRaw   } = getMergedValueWithSource("printStartTime", data);
  const { value: stRaw   } = getMergedValueWithSource("state",          data);
  const { value: jobRaw  } = getMergedValueWithSource("printJobTime",   data);
  const { value: selfRaw } = getMergedValueWithSource("withSelfTest",   data);
  const { value: progRaw } = getMergedValueWithSource("printProgress",  data);
  const { value: leftRaw } = getMergedValueWithSource("printLeftTime",  data);

  const id      = Number(idRaw)   || null;
  const st      = Number(stRaw)   || 0;
  const job     = Number(jobRaw)  || 0;
  const selfPct = Number(selfRaw) || 0;
  const progPct = (Number(progRaw) || 0) / 100;
  const left    = Number(leftRaw) || 0;

  // ── 2) PrintID 切替検出 → 各種リセット ────────────────────────────────────
  if (prevPrintID !== null && id !== prevPrintID) {
    {
      tsPrepStart   = tsCheckStart   = tsPauseStart   = tsCompleteStart   = null;
      totalPrepSec  = totalCheckSec  = totalPauseSec                      = 0;
      prevPrintID   = id;
    }
  }
  else if (prevPrintID === null) {
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
  if (st === PRINT_STATE_CODE.printStarted && job === 0 && selfPct > 0 && selfPct < 100) {
    if (!tsPrepStart) tsPrepStart = nowMs;
    const sec = totalPrepSec + Math.floor((nowMs - tsPrepStart) / 1000);
    // internal
    setStoredData("preparationTime", sec, true);
    // display
  } else if (tsPrepStart) {
    totalPrepSec += Math.floor((nowMs - tsPrepStart) / 1000);
    tsPrepStart   = null;
    setStoredData("preparationTime", totalPrepSec, true);
  }

  // 4-2. ファーストレイヤー確認時間
  if (st === PRINT_STATE_CODE.printStarted && job >= 1 && selfPct > 0 && selfPct < 100) {
    if (!tsCheckStart) tsCheckStart = nowMs;
    const sec = totalCheckSec + Math.floor((nowMs - tsCheckStart) / 1000);
    setStoredData("firstLayerCheckTime", sec, true);
  } else if (tsCheckStart) {
    totalCheckSec += Math.floor((nowMs - tsCheckStart) / 1000);
    tsCheckStart   = null;
    setStoredData("firstLayerCheckTime", totalCheckSec, true);
  }

  // 4-3. 一時停止時間
  if (st === PRINT_STATE_CODE.printPaused) {
    if (!tsPauseStart) tsPauseStart = nowMs;
    const sec = totalPauseSec + Math.floor((nowMs - tsPauseStart) / 1000);
    setStoredData("pauseTime", sec, true);
    setStoredData("pauseTime", { value: formatDuration(sec), unit: "" }, false);
  } else if (tsPauseStart) {
    totalPauseSec += Math.floor((nowMs - tsPauseStart) / 1000);
    tsPauseStart   = null;
    setStoredData("pauseTime", totalPauseSec, true);
  }

  // 4-4. 完了後経過時間
  const doneStates = new Set([
    PRINT_STATE_CODE.printDone,
    PRINT_STATE_CODE.printFailed
  ]);
  if (doneStates.has(st)) {
    if (!tsCompleteStart) {
      tsCompleteStart = nowMs;
      setStoredData("completionElapsedTime", 0, true);
    } else {
      const sec = Math.floor((nowMs - tsCompleteStart) / 1000);
      setStoredData("completionElapsedTime", sec, true);
    }
  } else if (tsCompleteStart) {
    tsCompleteStart = null;
    setStoredData("completionElapsedTime", null, true);
  }

  // ── 5) 予想残り時間／予想終了時刻 ────────────────────────────────
  if (actualStartEpoch !== null && progPct > 0) {
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
                  "predictedFinishEpoch","estimatedRemainingTime","estimatedCompletionTime"];
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

  updateStoredDataToDOM();
  persistAggregatorState();
  saveUnifiedStorage();

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
    "initialLeftSec","initialLeftEpoch"
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
    setStoredData(field, v, true);
  });
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
    initialLeftSec, initialLeftEpoch
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
 */
export function stopAggregatorTimer() {
  if (aggregatorTimer !== null) {
    clearInterval(aggregatorTimer);
    aggregatorTimer = null;
    console.debug("aggregatorUpdate タイマー停止");
  }
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
