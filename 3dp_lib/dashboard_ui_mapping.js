/**
 * @fileoverview
 * dashboard_ui_mapping.js (ver.1.324)
 * 
 * ダッシュボード上に表示するフィールド名（storedDataのキー）に対して、
 * - DOM上の要素キー（elementKey）
 * - 値変換関数（process）
 * を定義するマッピングテーブル。
 *
 * このファイルは UI 表示の制御ロジックを centralized に管理するものであり、
 * 表示に必要な単位付き文字列変換などを一元化している。
 */

"use strict";

import * as utils from "./dashboard_utils.js";
import { showAlert } from "./dashboard_notification_manager.js";

/* ==========================================================================
 * 変換ユーティリティ関数群
 * ========================================================================== */

/**
 * 値に対応するラベルと単位を取得するためのマッピング関数。
 * 
 * - 値が存在しない場合は v をそのまま文字列化して返す。
 * - map の値が関数であれば `v` を引数に実行し、結果を使う。
 * - map の値が文字列や数値であれば `{ value: entry, unit: "" }` に変換する。
 * - map の値がオブジェクトであれば `{ value, unit }` として使う。
 *
 * @param {Object<string|number, string|number|{value: string, unit: string}|Function>} map
 * @param {string|number} v
 * @returns {{value: string, unit: string}}
 */
function mapValue(map, v) {
  let entry = map[v];

  // 該当なし → キー自体を文字列化して返す
  if (entry === undefined) {
    return { value: String(v), unit: "" };
  }

  // 関数であれば評価
  if (typeof entry === "function") {
    try {
      entry = entry(v);
    } catch (e) {
      console.warn(`mapValue: 関数評価失敗 (key=${v})`, e);
      return { value: String(v), unit: "" };
    }
  }

  // 文字列または数値はラベルとして返す
  if (typeof entry === "string" || typeof entry === "number") {
    return { value: String(entry), unit: "" };
  }

  // 既に {value, unit} 形式
  if (
    typeof entry === "object" &&
    entry !== null &&
    "value" in entry &&
    "unit" in entry
  ) {
    return {
      value: String(entry.value),
      unit: String(entry.unit)
    };
  }

  // 予期せぬ型：警告を出してフォールバック
  console.warn(`mapValue: 予期しない型を検出 (key=${v})`, entry);
  return { value: String(v), unit: "" };
}


/** エラー状況 (code, key の組み合わせ) → 表示 */
function formatErrorStatus(v) {
  if (!v || (v.errcode == null && v.key == null)) {
    return { value: "---XXX", unit: "" };
  }
  return {
    value: `コード${v.errcode}, キー${v.key}`,
    unit: ""
  };
}


/**
 * デフォルトの処理関数。
 * 値をそのまま文字列として返し、単位は空文字とする。
 */
const NO_PROCESSING = v => ({ value: String(v), unit: "" });

/**
 * 終了見込み表示共通：エポック秒 → 日時文字列
 */
const toExpectedEnd = v => ({
  value: utils.formatExpectedEndTime(new Date(v * 1000)),
  unit: ""
});

/* ==========================================================================
 * 表示定義マップ（文字列化用）
 * ========================================================================== */

/** 印刷状態コードから表示ラベルへのマッピング */
export const PRINT_STATE_MAP = {
  0: "0:停止中",
  1: "1:印刷中",
  2: "2:正常終了",
  3: "3:機器チェック実施中",
  4: "4:印刷失敗",
  5: "5:一時停止中"
};

/** Klipper と同じ文字列キー → ダッシュボード上の数値コードマッピング */
export const PRINT_STATE_CODE = {
  printIdle:     0,  // 停止中
  printStarted:  1,  // 印刷中
  printDone:     2,  // 正常終了
  printFailed:   4,  // 印刷失敗
  printPaused:   5   // 一時停止中
};

/** 通知マネージャや handlePrintStateTransition のイベント名との対応例 */
export const PRINT_STATE_EVENT = {
  [PRINT_STATE_CODE.printStarted]:  "printStarted",
  [PRINT_STATE_CODE.printPaused]:   "printPaused",
  //[PRINT_STATE_CODE.printStarted]:  "printResumed",        // 再開
  [PRINT_STATE_CODE.printDone]:     "printCompleted",
  [PRINT_STATE_CODE.printFailed]:   "printFailed"
};

/** enableSelfTest（自己診断モード）の表示マップ */
const SELF_TEST_MODE_MAP = {
  0: "0:実施しない",
  1: "1:常時実施"
};

/** withSelfTest（自己診断の進捗ステータス）の表示マップ */
const SELF_TEST_STATUS_MAP = {
  0: "0:未実施",
  1: "1:障害物検出中",
  2: "2:原点復帰中(Z軸確認中)",
  3: "3:ノズルクリーニング中",
  4: "4:原点復帰中(レベリング中)",
  5: "5:原点復帰中(外周位置最終確認中)",
  6: "6:LiDER センサー確認中",
  7: "7:???",
  30: "30:初層印刷前プレート面確認中",
  31: "31:初層印刷中",
  32: "32:ノズル降温中",
  33: "33:初層走査中",
  34: "34:計算中/次層印刷開始待機中",
  35: "35:ノズル再昇温・次層印刷準備",
  100: "100:完了"
};

const MATERIAL_STATUS_MAP = {
    0: "0:材料OK",
    1: "1:材料切れNG"
};

const NO_VAL = { value: "---", unit: "" };


/* ==========================================================================
 * dashboardMapping 本体定義
 * ========================================================================== */

export const dashboardMapping = {
  // --- 基本情報 ---
  hostname:        { elementKey: "hostname",        process: NO_PROCESSING },
  fileName:        { elementKey: "fileName",        process: NO_PROCESSING },
  deviceState:     { elementKey: "deviceState",     process: v => mapValue(PRINT_STATE_MAP, v) },

  // --- 印刷ステータス ---
  state:                  { elementKey: "state",                  process: v => mapValue(PRINT_STATE_MAP, v) },
  printState:             { elementKey: "printState",             process: v => mapValue(PRINT_STATE_MAP, v) },
  printProgress:          { elementKey: "printProgress",          process: v => ({ value: parseInt(v, 10), unit: "%" }) },
  printJobTime:           { elementKey: "printJobTime",           process: v => (v=== null) ? NO_VAL :({ value: utils.formatDuration(v), unit: "" }) },
  printLeftTime:          { elementKey: "printLeftTime",          process: v => (v=== null) ? NO_VAL :({ value: utils.formatDuration(v), unit: "" }) },
  estimatedRemainingTime: { elementKey: "estimatedRemainingTime", process: v => (v=== null) ? NO_VAL :({ value: utils.formatDuration(v), unit: "" }) },
  printStartTime:         { elementKey: "printStartTime",         process: v => (v === 0 || v=== null) ? NO_VAL :({ value: utils.formatEpochToDateTime(v), unit: "" }) },
  printFinishTime:        { elementKey: "printFinishTime",        process: v => (v === 0 || v=== null) ? NO_VAL :({ value: utils.formatEpochToDateTime(v), unit: "" }) },

  err:                    { elementKey: "errorStatus",            process: v =>(formatErrorStatus(v)) },

  // --- 予測関連 ---
  expectedEndTime:       { elementKey: "expectedEndTime",         process: v => v != null ? { value: utils.formatEpochToDateTime(v), unit: "" } : NO_VAL },
  actualStartTime:       { elementKey: "actualStartTime",         process: v => v != null ? { value: utils.formatEpochToDateTime(v), unit: "" } : NO_VAL },
  initialLeftTime:       { elementKey: "initialLeftTime",         process: v => v != null ? { value: utils.formatDuration(v), unit: "" } : NO_VAL },
  initialLeftAt:         { elementKey: "initialLeftAt",           process: v => v != null ? { value: utils.formatEpochToDateTime(v), unit: "" } : NO_VAL },
  predictedFinishEpoch:  { elementKey: "predictedFinishEpoch",    process: v => v != null ? { value: utils.formatEpochToDateTime(v), unit: "" } : NO_VAL },
  estimatedRemainingTime:{ elementKey: "estimatedRemainingTime",  process: v => v != null ? { value: utils.formatDuration(v), unit: "" } : NO_VAL },
  estimatedCompletionTime:{elementKey:"estimatedCompletionTime",  process: v => v != null ? { value: utils.formatEpochToDateTime(v), unit: "" } : NO_VAL },

  // --- タイマー経過 ---
  preparationTime:       { elementKey: "preparationTime",         process: v => v != null ? { value: utils.formatDuration(v), unit: "" } : NO_VAL },
  firstLayerCheckTime:   { elementKey: "firstLayerCheckTime",     process: v => v != null ? { value: utils.formatDuration(v), unit: "" } : NO_VAL },
  pauseTime:             { elementKey: "pauseTime",               process: v => v != null ? { value: utils.formatDuration(v), unit: "" } : NO_VAL },
  completionElapsedTime: { elementKey: "completionElapsedTime",   process: v => v != null ? { value: utils.formatDuration(v), unit: "" } : NO_VAL },

  // --- 材料関連 ---
  usedMaterialLength:    { elementKey: "materialLength",          process: v => ({ value: v.toLocaleString(), unit: "mm" }) },
  materialDetect:        { elementKey: "materialDetect",          process: v => ({ value: utils.formatBinary(v), unit: "" }) },
  materialStatus:        { elementKey: "materialStatus",          process: v => mapValue(MATERIAL_STATUS_MAP, v) },

  // --- 温度系 ---
  nozzleTemp:            { elementKey: "nozzleTemp",              process: v => ({ value: parseFloat(v).toFixed(2), unit: "℃" }) },
  targetNozzleTemp:      { elementKey: "targetNozzleTemp",        process: v => ({ value: parseFloat(v).toFixed(2), unit: "℃" }) },
  maxNozzleTemp:         { elementKey: "maxNozzleTemp",           process: v => ({ value: parseFloat(v).toFixed(2), unit: "℃" }) , domProps: [ { id: "nozzleTempSlider", prop: "max" },{ id: "nozzleTempInput" , prop: "max" }] },
  bedTemp0:              { elementKey: "bedTemp0",                process: v => ({ value: parseFloat(v).toFixed(2), unit: "℃" }) },
  targetBedTemp0:        { elementKey: "targetBedTemp0",          process: v => ({ value: parseFloat(v).toFixed(2), unit: "℃" }) },
  maxBedTemp:            { elementKey: "maxBedTemp",              process: v => ({ value: parseFloat(v).toFixed(2), unit: "℃" })  , domProps: [ { id: "bedTempSlider", prop: "max" },{ id: "bedTempInput" , prop: "max" }] },
  boxTemp:               { elementKey: "boxTemp",                 process: v => ({ value: parseFloat(v).toFixed(1), unit: "℃" }) },

  // --- FAN/LED ON/OFF状態 ---
  fan:                   { elementKey: "fan",                  process: v => ({ value: utils.formatBinary(v), unit: "" }) },
  fanAuxiliary:          { elementKey: "fanAuxiliary",         process: v => ({ value: utils.formatBinary(v), unit: "" }) },
  fanCase:               { elementKey: "fanCase",              process: v => ({ value: utils.formatBinary(v), unit: "" }) },
  lightSw:               { elementKey: "lightSw",              process: v => ({ value: utils.formatBinary(v), unit: "" }) },

  // --- FAN 風量強度 % ---
  modelFanPct:           { elementKey: "modelFanPct",          process: v => ({ value: parseInt(v,10), unit: "%" }) },
  auxiliaryFanPct:       { elementKey: "auxiliaryFanPct",      process: v => ({ value: parseInt(v,10), unit: "%" }) },
  caseFanPct:            { elementKey: "caseFanPct",           process: v => ({ value: parseInt(v,10), unit: "%" }) },

  // --- 速度 % ---
  curFeedratePct:        { elementKey: "curFeedratePct",       process: v => ({ value: parseInt(v,10), unit: "%" }) },

  // --- 自己診断 ---
  enableSelfTest:        { elementKey: "selfTest",             process: v => mapValue(SELF_TEST_MODE_MAP, v) },
  withSelfTest:          { elementKey: "withSelfTest",         process: v => mapValue(SELF_TEST_STATUS_MAP, v) },

  // --- 履歴取得 ---
  totalJob:              { elementKey: "totalJob",             process: v => (v=== null) ? NO_VAL :({ value: v.toLocaleString(), unit: "個" }) },
  totalUsageTime:        { elementKey: "totalUsageTime",       process: v => (v=== null) ? NO_VAL :({ value: utils.formatDuration(v), unit: "" }) },
  totalUsageMaterial:    { elementKey: "totalUsageMaterial",   process: v => ({ value: v.toLocaleString(), unit: "mm" }) },

  // --- その他パラメータ ---
  accelerationLimits:    { elementKey: "accelerationLimits",   process: NO_PROCESSING },
  velocityLimits:        { elementKey: "velocityLimits",       process: NO_PROCESSING },
  cornerVelocityLimits:  { elementKey: "cornerVelocityLimits", process: NO_PROCESSING },
  pressureAdvance:       { elementKey: "pressureAdvance",      process: NO_PROCESSING },
  accelToDecelLimits:    { elementKey: "accelToDecelLimits",   process: NO_PROCESSING },
  autohome:              { elementKey: "autohome",             process: NO_PROCESSING },
  realTimeFlow:          { elementKey: "realTimeFlow",         process: NO_PROCESSING },
  realTimeSpeed:         { elementKey: "realTimeSpeed",        process: NO_PROCESSING },
  sysConnection:         { elementKey: "sysConnection",        process: NO_PROCESSING },
  model:                 { elementKey: "model",                process: NO_PROCESSING },
  modelVersion:          { elementKey: "modelVersion",         process: NO_PROCESSING }

};
