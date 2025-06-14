/**
 * @fileoverview
 * 永続化とマイグレーション機能を提供するモジュール。
 *
 * - monitorData の localStorage 保存／復元
 * - レガシーキーからのデータ移行
 * - 印刷履歴管理用 I/O（printManager）
 * - 使用容量推定・クォータチェック
 *
 * @module dashboard_storage
 */

"use strict";

import { monitorData, currentHostname } from "./dashboard_data.js";
import { logManager } from "./dashboard_log_util.js";

let _enableStorageLog = false;
let _lastSavedJson    = null;

function applySpoolDefaults(sp) {
  sp.filamentDiameter ??= 1.75;
  sp.filamentColor ??= "#22C55E";
  sp.reelOuterDiameter ??= 200;
  sp.reelThickness ??= 68;
  sp.reelWindingInnerDiameter ??= 95;
  sp.reelCenterHoleDiameter ??= 54;
  sp.reelBodyColor ??= "#A1A1AA";
  sp.reelFlangeTransparency ??= 0.4;
  sp.manufacturerName ??= "";
  sp.materialName ??= sp.material ?? "";
  sp.materialSubName ??= "";
  sp.purchasePrice ??= 0;
  sp.density ??= 0;
  sp.reelSubName ??= "";
  return sp;
}

/**
 * ローカルストレージ保存時のデバッグログを有効／無効化する。
 *
 * @param {boolean} flag - true にすると saveUnifiedStorage 実行時にログを残す
 */
export function setStorageLogEnabled(flag) {
  _enableStorageLog = Boolean(flag);
}

/**
 * 内部用：簡易ログ出力ユーティリティ
 *
 * @param {string}  msg    - ログメッセージ
 * @param {boolean} [isErr=false] - true の場合 level="error"、false の場合 level="info"
 */
function pushLog(msg, isErr = false) {
  logManager.add({
    timestamp: new Date().toISOString(),
    level:     isErr ? "error" : "info",
    msg
  });
}

/** localStorage へ保存するキー名 */
const STORAGE_KEY = "3dp-monitor_1.400";
/** 印刷履歴の最大保持件数 */
const MAX_HISTORY = 150;

/**
 * monitorData 全体を JSON にシリアライズし、localStorage に保存する。
 * - 前回と同一データなら保存をスキップして不要な I/O を回避
 * - デバッグログを残すオプションあり
 *
 * @returns {void}
 */
export function saveUnifiedStorage() {
  try {
    const json = JSON.stringify(monitorData);
    if (json === _lastSavedJson) return;
    localStorage.setItem(STORAGE_KEY, json);
    _lastSavedJson = json;
    if (_enableStorageLog) {
      console.debug("[saveUnifiedStorage] monitorData を保存しました");
      logManager.add({ timestamp:new Date().toISOString(), level:"info", msg:"[saveUnifiedStorage] 設定と履歴を保存しました" });
    }
  } catch (e) {
    console.warn("[saveUnifiedStorage] 保存に失敗しました:", e);
    logManager.add({ timestamp:new Date().toISOString(), level:"error", msg:`[saveUnifiedStorage] エラー: ${e.message}` });
  }
}


/**
 * 古い（レガシー）localStorage キーを一括削除する。
 * 将来の廃止対応として一度のみ行う用途。
 *
 * @returns {number} 削除したキー数
 */
function cleanUpLegacyStorage() {
  const legacyKeys = [
    "wsDestV1p125",
    "cameraToggleV1p129",
    "autoConnectV1p129",
    "storedDataV1p125"
  ];
  let removed = 0;
  for (const key of legacyKeys) {
    if (localStorage.getItem(key) !== null) {
      localStorage.removeItem(key);
      removed++;
      pushLog(`旧ストレージキーを削除: ${key}`);
    }
  }
  if (removed > 0) {
    pushLog(`旧キー ${removed} 件を削除しました`);
  }
  return removed;
}

/**
 * localStorage から monitorData を復元する。
 * - 統一キー(STORAGE_KEY) があればそれを優先
 * - なければレガシーキーから移行を試みる
 *
 * @returns {void}
 */
export function restoreUnifiedStorage() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      const data = JSON.parse(saved);
      if (data.appSettings)    monitorData.appSettings    = data.appSettings;
      if (data.machines)       monitorData.machines       = data.machines;
      if (Array.isArray(data.filamentSpools))
        monitorData.filamentSpools = data.filamentSpools.map(sp => applySpoolDefaults(sp));
      if ("currentSpoolId" in data)
        monitorData.currentSpoolId = data.currentSpoolId;
      _lastSavedJson = saved;
      console.debug("[restoreUnifiedStorage] 統一キーから復元しました");
    } catch (e) {
      console.error("[restoreUnifiedStorage] パースエラー:", e);
      pushLog("[restoreUnifiedStorage] 復元中にパースエラー発生", true);
    }
  } else {
    // 統一キーなし → レガシーキーからマイグレーション
    monitorData.appSettings.wsDest       = localStorage.getItem("wsDestV1p125") || "";
    monitorData.appSettings.cameraToggle = localStorage.getItem("cameraToggleV1p129") === "true";
    const ac = localStorage.getItem("autoConnectV1p129");
    monitorData.appSettings.autoConnect = (ac === null ? true : ac === "true");
    console.debug("[restoreUnifiedStorage] レガシーキーから復元しました");
  }
}

/**
 * レガシー形式で保存された storedData を currentHostname の機器に復元する。
 *
 * @returns {void}
 */
export function restoreLegacyStoredData() {
  if (!currentHostname || !monitorData.machines[currentHostname]) {
    console.warn("[restoreLegacyStoredData] currentHostname 未設定のためスキップ");
    return;
  }
  const raw = localStorage.getItem("storedDataV1p125");
  if (!raw) return;
  try {
    const obj     = JSON.parse(raw);
    const machine = monitorData.machines[currentHostname];
    for (const [key, val] of Object.entries(obj)) {
      machine.storedData[key] = (val && val.rawValue !== undefined)
        ? val
        : { rawValue: val, computedValue: null, isNew: true };
    }
    console.debug("[restoreLegacyStoredData] storedData を復元しました");
    pushLog("旧 storedData を復元しました");
  } catch (e) {
    console.warn("[restoreLegacyStoredData] パースエラー:", e);
    pushLog("旧 storedData の読み込みに失敗しました", true);
  }
}

/**
 * cleanUpLegacyStorage() を実行し、その結果をカスタムイベントで通知する。
 *
 * @returns {number} 削除したレガシーキーの件数
 */
export function cleanupLegacy() {
  const count = cleanUpLegacyStorage();
  window.dispatchEvent(new CustomEvent("storage:legacyCleaned", {
    detail: { removed: count }
  }));
  return count;
}

/**
 * localStorage 使用量とクォータを推定する。
 *
 * @returns {Promise<{usage: number, quota: number}>}
 */
export async function estimateStorageQuota() {
  if (navigator.storage?.estimate) {
    try {
      const { usage, quota } = await navigator.storage.estimate();
      if (!usage) {
        const fallback = estimateLocalStorageUsageBytes();
        pushLog(`フォールバック使用量: ${fallback} bytes`);
        return { usage: fallback, quota: quota ?? 5 * 1024 * 1024 };
      }
      return { usage, quota };
    } catch (e) {
      const fallback = estimateLocalStorageUsageBytes();
      pushLog(`estimate() 失敗→フォールバック: ${fallback} bytes`, true);
      return { usage: fallback, quota: 5 * 1024 * 1024 };
    }
  } else {
    const fallback = estimateLocalStorageUsageBytes();
    return { usage: fallback, quota: 5 * 1024 * 1024 };
  }
}

/**
 * 即時に saveUnifiedStorage を実行し、"storage:sync" イベントを発火する。
 *
 * @returns {void}
 */
export function syncStorageNow() {
  const when = Date.now();
  saveUnifiedStorage();
  window.dispatchEvent(new CustomEvent("storage:sync", { detail: { when } }));
}

/**
 * 書き込み可能な最大 localStorage 容量をバイナリサーチで調査する。
 *
 * @returns {Promise<number>} 推定可能バイト数
 */
export async function testMaxLocalStorageQuota() {
  const testKey = "__quota_test__";
  const used = estimateLocalStorageUsageBytes();
  let quota = used + 5 * 1024 * 1024;
  if (navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      quota = est.quota || quota;
    } catch {}
  }
  let low = 0, high = Math.max(0, quota - used), best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    try {
      localStorage.setItem(testKey, "0".repeat(mid));
      best = mid;
      low = mid + 1;
    } catch {
      high = mid - 1;
    }
  }
  localStorage.removeItem(testKey);
  const writable = best * 2; // UTF-16: 1文字2バイト
  pushLog(`追加可能容量: 約 ${writable} bytes`);
  return writable;
}

/**
 * 現在の localStorage 使用量を概算する。
 *
 * @returns {number} 使用バイト数
 */
export function estimateLocalStorageUsageBytes() {
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key   = localStorage.key(i);
    const value = localStorage.getItem(key) || "";
    total += (key.length + value.length) * 2;
  }
  return total;
}

// ---- printManager 用 I/O ----

/**
 * 現在印刷中のジョブ情報を取得する。
 *
 * @returns {Object|null} ジョブオブジェクト、未設定時は null
 */
export function loadPrintCurrent() {
  return monitorData.appSettings.printManager?.current || null;
}

/**
 * 現在印刷中のジョブ情報を保存する。
 *
 * @param {Object|null} job - 保存するジョブオブジェクト（null 許容）
 */
export function savePrintCurrent(job) {
  monitorData.appSettings.printManager ??= {};
  monitorData.appSettings.printManager.current = job;
  saveUnifiedStorage();
}

/**
 * 保存済みの印刷履歴一覧を取得する。
 *
 * @returns {Array<Object>} 履歴配列
 */
export function loadPrintHistory() {
  return monitorData.appSettings.printManager?.history || [];
}

/**
 * 印刷履歴を保存する（過去データは古いものから削除）。
 *
 * @param {Array<Object>} history - 保存対象の履歴配列
 */
export function savePrintHistory(history) {
  monitorData.appSettings.printManager ??= {};
  monitorData.appSettings.printManager.history =
    history.slice(0, MAX_HISTORY);
  saveUnifiedStorage();
}

/**
 * 印刷動画マップを取得する。
 *
 * @returns {Record<string, string>} id をキーとした動画 URL マップ
 */
export function loadPrintVideos() {
  return monitorData.appSettings.printManager?.videos || {};
}

/**
 * 印刷動画マップを保存する。
 *
 * @param {Record<string, string>} map - id をキーとした動画 URL マップ
 */
export function savePrintVideos(map) {
  monitorData.appSettings.printManager ??= {};
  monitorData.appSettings.printManager.videos = map;
  saveUnifiedStorage();
}
