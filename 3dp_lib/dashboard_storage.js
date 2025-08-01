/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 ストレージ管理モジュール
 * @file dashboard_storage.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_storage
 *
 * 【機能内容サマリ】
 * - monitorData の保存・復元
 * - レガシーキーからのデータ移行
 * - 印刷履歴管理との I/O
 * - クォータ計測と容量推定
 *
 * 【公開関数一覧】
 * - {@link setStorageLogEnabled}：ログ出力有効化
 * - {@link saveUnifiedStorage}：全データ保存
 * - {@link restoreUnifiedStorage}：全データ復元
 * - {@link restoreLegacyStoredData}：レガシーデータ読込
 * - {@link cleanupLegacy}：レガシー削除
 * - {@link estimateStorageQuota}：容量取得
 * - {@link syncStorageNow}：即時同期
 * - {@link testMaxLocalStorageQuota}：書き込みテスト
 * - {@link estimateLocalStorageUsageBytes}：使用量推定
 * - {@link loadPrintCurrent}：現ジョブ読込
 * - {@link savePrintCurrent}：現ジョブ保存
 *
* @version 1.390.756 (PR #344)
* @since   1.390.193 (PR #86)
* @lastModified 2025-07-21 16:37:31
 * -----------------------------------------------------------
 * @todo
 * - none
*/

"use strict";

import { monitorData, currentHostname, ensureMachineData } from "./dashboard_data.js";
import { logManager } from "./dashboard_log_util.js";
import { getCurrentTimestamp } from "./dashboard_utils.js";

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
  sp.currencySymbol ??= "\u00A5";
  sp.density ??= 0;
  sp.reelSubName ??= "";
  sp.isPending ??= false;
  if (!Number.isFinite(Number(sp.serialNo)) || Number(sp.serialNo) <= 0) {
    monitorData.spoolSerialCounter += 1;
    sp.serialNo = monitorData.spoolSerialCounter;
  } else {
    sp.serialNo = Number(sp.serialNo);
    if (sp.serialNo > monitorData.spoolSerialCounter) {
      monitorData.spoolSerialCounter = sp.serialNo;
    }
  }
  // 数値項目の正規化: NaN または null の場合は 0 をセット
  if (sp.remainingLengthMm != null) {
    const rem = Number(sp.remainingLengthMm);
    sp.remainingLengthMm = Number.isFinite(rem) ? rem : 0;
  }
  if (sp.startLength == null || !Number.isFinite(Number(sp.startLength))) {
    sp.startLength = sp.remainingLengthMm ?? 0;
  }
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
    timestamp: getCurrentTimestamp(),
    level:     isErr ? "error" : "info",
    msg
  });
}

/** localStorage へ保存するキー名 */
const STORAGE_KEY = "3dp-monitor_1.400";
/** 印刷履歴の最大保持件数 */
const MAX_HISTORY = 250;

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
      logManager.add({ timestamp:getCurrentTimestamp(), level:"info", msg:"[saveUnifiedStorage] 設定と履歴を保存しました" });
    }
  } catch (e) {
    console.warn("[saveUnifiedStorage] 保存に失敗しました:", e);
    logManager.add({ timestamp:getCurrentTimestamp(), level:"error", msg:`[saveUnifiedStorage] エラー: ${e.message}` });
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
 * - monitorData.machines 配下の storedData は保存時の isFromEquipVal を保持
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
      if (Array.isArray(data.usageHistory))
        monitorData.usageHistory = data.usageHistory;
      if (Array.isArray(data.filamentInventory))
        monitorData.filamentInventory = data.filamentInventory;
      if (Array.isArray(data.filamentPresets))
        monitorData.filamentPresets = data.filamentPresets;
      if ("currentSpoolId" in data)
        monitorData.currentSpoolId = data.currentSpoolId;
      if ("spoolSerialCounter" in data)
        monitorData.spoolSerialCounter = Number(data.spoolSerialCounter) || 0;
      const maxSerial = monitorData.filamentSpools.reduce(
        (m, s) => Math.max(m, Number(s.serialNo) || 0),
        0
      );
      if (monitorData.spoolSerialCounter < maxSerial) {
        monitorData.spoolSerialCounter = maxSerial;
      }
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

  // 保存データに欠損がある場合に備え、各機器データを正規化する
  Object.keys(monitorData.machines).forEach(host => ensureMachineData(host));
}

/**
 * レガシー形式で保存された storedData を currentHostname の機器に復元する。
 * 復元時に isFromEquipVal フラグが存在しない場合は true を設定する。
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
      if (val && val.rawValue !== undefined) {
        machine.storedData[key] = val;
        if (machine.storedData[key].isFromEquipVal === undefined) {
          machine.storedData[key].isFromEquipVal = true;
        }
      } else {
        machine.storedData[key] = {
          rawValue: val,
          computedValue: null,
          isNew: true,
          isFromEquipVal: true
        };
      }
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
  const host = currentHostname;
  if (!host) return null;
  ensureMachineData(host);
  const machine = monitorData.machines[host];
  return machine.printStore.current || null;
}

/**
 * 現在印刷中のジョブ情報を保存する。
 *
 * @param {Object|null} job - 保存するジョブオブジェクト（null 許容）
 */
export function savePrintCurrent(job) {
  const host = currentHostname;
  if (!host) return;
  ensureMachineData(host);
  monitorData.machines[host].printStore.current = job;
  saveUnifiedStorage();
}

/**
 * 保存済みの印刷履歴一覧を取得する。
 *
 * @returns {Array<Object>} 履歴配列
 */
export function loadPrintHistory() {
  const host = currentHostname;
  if (!host) return [];
  ensureMachineData(host);
  return monitorData.machines[host].printStore.history;
}

/**
 * 印刷履歴を保存する（過去データは古いものから削除）。
 *
 * @param {Array<Object>} history - 保存対象の履歴配列
 */
export function savePrintHistory(history) {
  const host = currentHostname;
  if (!host) return;
  ensureMachineData(host);
  monitorData.machines[host].printStore.history =
    history.slice(0, MAX_HISTORY);
  saveUnifiedStorage();
}

/**
 * 印刷動画マップを取得する。
 * 取得と同時に件数をログへ出力し、デバッグ用に現在の内容をコンソールへ表示します。
 * @returns {Record<string, string>} id をキーとした動画 URL マップ
 */
export function loadPrintVideos() {
  const host = currentHostname;
  if (!host) return {};
  ensureMachineData(host);
  const map = monitorData.machines[host].printStore.videos;
  // デバッグ用: 現在保持している動画マップ件数をログに残す
  pushLog(`[loadPrintVideos] マップ読込件数: ${Object.keys(map).length}`);
  console.debug("[loadPrintVideos] map", map);
  return map;
}

/**
 * 印刷動画マップを保存する。
 * 保存件数をログに出力し、保存内容もコンソールへ出力して調査を容易にします。
 * @param {Record<string, string>} map - id をキーとした動画 URL マップ
 */
export function savePrintVideos(map) {
  const host = currentHostname;
  if (!host) return;
  ensureMachineData(host);
  monitorData.machines[host].printStore.videos = map;
  // デバッグ用: 保存する動画マップの件数をログに記録
  pushLog(`[savePrintVideos] マップ保存件数: ${Object.keys(map).length}`);
  console.debug("[savePrintVideos] map", map);
  saveUnifiedStorage();
}
