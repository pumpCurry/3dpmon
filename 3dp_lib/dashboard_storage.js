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
 * - レガシーキーからのデータ移行（最小サポート移行元: v1.40）
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
* @version 1.390.787 (PR #367)
* @since   1.390.193 (PR #86)
* @lastModified 2026-03-12
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

import { monitorData, currentHostname, ensureMachineData, PLACEHOLDER_HOSTNAME } from "./dashboard_data.js";
import { FILAMENT_PRESETS } from "./dashboard_filament_presets.js";
import { logManager } from "./dashboard_log_util.js";
import { getCurrentTimestamp } from "./dashboard_utils.js";
import {
  initIdb,
  isIdbAvailable,
  getIdbCache,
  queueSharedWrite,
  queueMachineWrite,
  flushIdb,
  exportAllIdb,
  importAllIdb
} from "./dashboard_storage_idb.js";

let _enableStorageLog = false;
let _lastSavedJson    = null;
/** localStorage バックアップの最終書き出し時刻 */
let _lastLsBackupEpoch = 0;

/** 書き込みスロットリング用 */
let _saveTimer     = null;
let _savePending   = false;
const SAVE_THROTTLE_MS = 2000;

/**
 * 印刷動画マップの最大保持件数
 * @constant {number}
 */
const MAX_VIDEOS = 500;

/** IndexedDB 初期化済みフラグ */
let _idbInitialized = false;

/**
 * ストレージバックエンドを初期化する。
 * IndexedDB を開き、既存データをキャッシュへ読み込む。
 * localStorage からの自動マイグレーションも行う。
 * アプリ起動時に restoreUnifiedStorage() より前に呼ぶこと。
 *
 * @returns {Promise<void>}
 */
export async function initStorage() {
  await initIdb();
  _idbInitialized = isIdbAvailable();
  if (_idbInitialized) {
    console.info("[initStorage] IndexedDB バックエンド有効");
  } else {
    console.info("[initStorage] localStorage フォールバック");
  }
}

/**
 * IndexedDB からの全データエクスポート（UI 用）。
 * monitorData 互換の JSON オブジェクトを返す。
 *
 * @returns {Promise<Object>}
 */
export async function exportAllData() {
  if (_idbInitialized) {
    return exportAllIdb();
  }
  // フォールバック: localStorage
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? JSON.parse(raw) : {};
}

/**
 * JSON オブジェクトから全データをインポートする（UI 用）。
 *
 * @param {Object} data - インポートするデータ
 * @returns {Promise<void>}
 */
export async function importAllData(data) {
  if (_idbInitialized) {
    await importAllIdb(data);
    return;
  }
  // フォールバック: localStorage
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

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

/**
 * localStorage へ保存するキー名。
 * v1.40 以降の統一ストレージキー。
 * ※ v1.25/v1.29 の個別キーからの移行は廃止済み。
 *   最小サポート移行元バージョン: v1.40
 */
const STORAGE_KEY = "3dp-monitor_1.400";
/**
 * 印刷履歴の最大保持件数
 *
 * localStorage に保存する印刷履歴配列の上限を定める。
 * これまでは 250 件までの保持であったが、過去の履歴を
 * より多く参照できるよう 1500 件まで保存できるようにする。
 *
 * @constant {number}
 */
export const MAX_PRINT_HISTORY = 1500;

/**
 * フィラメント使用履歴の最大保持件数
 *
 * 1 印刷で最大 2 リールまで使用する想定のため、
 * 4500 件を上限として保持する。
 *
 * @constant {number}
 */
export const MAX_USAGE_HISTORY = 4500;

/**
 * フィラメント使用履歴配列が上限を超えた場合に古い記録を削除する。
 *
 * @returns {void}
 */
export function trimUsageHistory() {
  if (monitorData.usageHistory.length > MAX_USAGE_HISTORY) {
    monitorData.usageHistory = monitorData.usageHistory.slice(-MAX_USAGE_HISTORY);
  }
}

/**
 * monitorData 全体を JSON にシリアライズし、localStorage に保存する。
 * - スロットリングにより最短 {@link SAVE_THROTTLE_MS} 間隔で書き込む
 * - 前回と同一データなら保存をスキップして不要な I/O を回避
 * - デバッグログを残すオプションあり
 *
 * @param {boolean} [immediate=false] - true なら即時書き込み（アプリ終了時等）
 * @returns {void}
 */
export function saveUnifiedStorage(immediate = false) {
  if (immediate) {
    _flushStorage();
    return;
  }
  // スロットリング: タイマー実行中はフラグだけ立てて次回に委ねる
  _savePending = true;
  if (_saveTimer !== null) return;
  _flushStorage();
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    if (_savePending) _flushStorage();
  }, SAVE_THROTTLE_MS);
}

/**
 * 実際のストレージ書き込みを行う内部関数。
 * IndexedDB が有効な場合はキューに追加し、無効な場合は localStorage へ書き込む。
 * @private
 */
function _flushStorage() {
  _savePending = false;
  try {
    if (_idbInitialized) {
      // IndexedDB: shared データをキューに追加
      queueSharedWrite("appSettings",        monitorData.appSettings);
      queueSharedWrite("filamentSpools",     monitorData.filamentSpools);
      queueSharedWrite("usageHistory",       monitorData.usageHistory);
      queueSharedWrite("filamentPresets",    monitorData.filamentPresets);
      queueSharedWrite("filamentInventory",  monitorData.filamentInventory);
      queueSharedWrite("currentSpoolId",     monitorData.currentSpoolId);
      queueSharedWrite("hostSpoolMap",       monitorData.hostSpoolMap);
      queueSharedWrite("hostCameraToggle",  monitorData.hostCameraToggle);
      queueSharedWrite("spoolSerialCounter", monitorData.spoolSerialCounter);

      // machines データをキューに追加（per-host 独立書き込み）
      for (const [host, machine] of Object.entries(monitorData.machines)) {
        if (host === PLACEHOLDER_HOSTNAME) continue;
        queueMachineWrite(host, machine);
      }

      // IndexedDB 障害時のリカバリ用に localStorage にもバックアップを定期書き出し
      // (毎回ではなく60秒に1回、サイズ制限エラーも吸収)
      const now = Date.now();
      if (!_lastLsBackupEpoch || now - _lastLsBackupEpoch > 60000) {
        _lastLsBackupEpoch = now;
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(monitorData));
        } catch (e) {
          console.warn("[saveUnifiedStorage] localStorage バックアップ失敗:", e.message);
        }
      }

      if (_enableStorageLog) {
        console.debug("[saveUnifiedStorage] IndexedDB キューに追加しました");
      }
    } else {
      // フォールバック: localStorage
      const json = JSON.stringify(monitorData);
      if (json === _lastSavedJson) return;
      localStorage.setItem(STORAGE_KEY, json);
      _lastSavedJson = json;

      if (_enableStorageLog) {
        console.debug("[saveUnifiedStorage] localStorage に保存しました");
      }
    }
  } catch (e) {
    console.warn("[saveUnifiedStorage] 保存に失敗しました:", e);
    logManager.add({ timestamp:getCurrentTimestamp(), level:"error", msg:`[saveUnifiedStorage] エラー: ${e.message}` });
  }
}


/**
 * pre-v1.40 のレガシー localStorage キーを一括削除する。
 * v1.40 以降のデータ移行が完了した後に呼び出す。
 *
 * ※ v1.25/v1.29 の個別キー（wsDestV1p125, cameraToggleV1p129, autoConnectV1p129）は
 *   v1.40 統一キーへの移行時点で既に吸収済みのため、ここでは扱わない。
 *
 * @returns {number} 削除したキー数
 */
function cleanUpLegacyStorage() {
  const legacyKeys = [
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
  // IndexedDB キャッシュがあればそこから復元
  const idbCache = getIdbCache();
  if (idbCache) {
    _restoreFromData(idbCache.shared, idbCache.machines);
    console.debug("[restoreUnifiedStorage] IndexedDB から復元しました");
    Object.keys(monitorData.machines).forEach(host => ensureMachineData(host));
    return;
  }

  // フォールバック: localStorage
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      const data = JSON.parse(saved);
      _restoreFromData(data, data.machines);
      _lastSavedJson = saved;
      console.debug("[restoreUnifiedStorage] localStorage から復元しました");
    } catch (e) {
      console.error("[restoreUnifiedStorage] パースエラー:", e);
      pushLog("[restoreUnifiedStorage] 復元中にパースエラー発生", true);
    }
  } else {
    // v1.40 (STORAGE_KEY = "3dp-monitor_1.400") 以降のデータのみ公式サポート。
    // v1.25/v1.29 の個別キー移行は廃止済み。
    console.debug("[restoreUnifiedStorage] 保存データなし。初回起動として扱います");
  }

  Object.keys(monitorData.machines).forEach(host => ensureMachineData(host));
}

/**
 * データソースから monitorData を復元する内部ヘルパー。
 * IndexedDB と localStorage の両方から使用される。
 *
 * @private
 * @param {Object} shared - shared データ（appSettings, filamentSpools 等）
 * @param {Object} [machines] - per-host マシンデータ
 */
function _restoreFromData(shared, machines) {
  if (shared?.appSettings || shared?.appSettings === null) {
    Object.assign(monitorData.appSettings, shared.appSettings);
  }
  if (machines) monitorData.machines = machines;
  if (Array.isArray(shared?.filamentSpools)) {
    monitorData.filamentSpools = shared.filamentSpools.map(sp => applySpoolDefaults(sp));
  }
  if (Array.isArray(shared?.usageHistory)) {
    monitorData.usageHistory = shared.usageHistory;
  }
  trimUsageHistory();
  if (Array.isArray(shared?.filamentInventory)) {
    monitorData.filamentInventory = shared.filamentInventory;
  }
  // プリセット: ストレージのユーザー編集済みデータとコード側の新規追加をマージ
  if (Array.isArray(shared?.filamentPresets)) {
    const storedIds = new Set(shared.filamentPresets.map(p => p.presetId));
    // コード側にあってストレージにないプリセットを追加
    const newPresets = FILAMENT_PRESETS.filter(p => !storedIds.has(p.presetId));
    monitorData.filamentPresets = [...shared.filamentPresets, ...newPresets];
    if (newPresets.length > 0) {
      console.info(`[_restoreFromData] 新規プリセット ${newPresets.length} 件をマージ`);
    }
  }
  if (shared && "currentSpoolId" in shared) {
    monitorData.currentSpoolId = shared.currentSpoolId;
  }
  // per-host スプールマップの復元（レガシー移行対応）
  if (shared?.hostSpoolMap && typeof shared.hostSpoolMap === "object") {
    monitorData.hostSpoolMap = shared.hostSpoolMap;
  } else if (shared && "currentSpoolId" in shared && shared.currentSpoolId) {
    // レガシー移行: グローバル currentSpoolId からスプールの hostname を使って推定
    const spool = monitorData.filamentSpools.find(
      s => s.id === shared.currentSpoolId && !s.deleted
    );
    if (spool && spool.hostname) {
      monitorData.hostSpoolMap = { [spool.hostname]: shared.currentSpoolId };
    } else {
      monitorData.hostSpoolMap = {};
    }
  }
  // per-host カメラトグルの復元
  if (shared?.hostCameraToggle && typeof shared.hostCameraToggle === "object") {
    monitorData.hostCameraToggle = shared.hostCameraToggle;
  }
  if (shared && "spoolSerialCounter" in shared) {
    monitorData.spoolSerialCounter = Number(shared.spoolSerialCounter) || 0;
  }
  const maxSerial = monitorData.filamentSpools.reduce(
    (m, s) => Math.max(m, Number(s.serialNo) || 0),
    0
  );
  if (monitorData.spoolSerialCounter < maxSerial) {
    monitorData.spoolSerialCounter = maxSerial;
  }
}

/**
 * レガシー形式（storedDataV1p125）で保存された storedData を指定ホストに復元する。
 * v1.40 以降では公式サポート対象外だが、互換性のため移行処理は維持する。
 * 復元時に isFromEquipVal フラグが存在しない場合は true を設定する。
 *
 * @returns {void}
 */
export function restoreLegacyStoredData() {
  if (!currentHostname || currentHostname === PLACEHOLDER_HOSTNAME) {
    console.warn("[restoreLegacyStoredData] 有効なホスト名が未設定のためスキップ");
    return;
  }
  const machine = monitorData.machines[currentHostname];
  if (!machine) {
    console.warn("[restoreLegacyStoredData] ホストのマシンデータが存在しないためスキップ");
    return;
  }
  const raw = localStorage.getItem("storedDataV1p125");
  if (!raw) return;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") {
      console.warn("[restoreLegacyStoredData] パースデータが不正です");
      return;
    }
    for (const [key, val] of Object.entries(obj)) {
      if (val != null && typeof val === "object" && "rawValue" in val) {
        machine.storedData[key] = val;
        machine.storedData[key].isFromEquipVal ??= true;
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
    pushLog("旧 storedData を復元しました（非公式互換移行）");
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
  saveUnifiedStorage(true);
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
export function loadPrintCurrent(hostname) {
  const host = hostname;
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
export function savePrintCurrent(job, hostname) {
  const host = hostname;
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
export function loadPrintHistory(hostname) {
  const host = hostname;
  if (!host) return [];
  ensureMachineData(host);
  return monitorData.machines[host].printStore.history;
}

/**
 * 印刷履歴を保存する（過去データは古いものから削除）。
 *
 * @param {Array<Object>} history - 保存対象の履歴配列
 */
export function savePrintHistory(history, hostname) {
  const host = hostname;
  if (!host) return;
  ensureMachineData(host);
  monitorData.machines[host].printStore.history =
    history.slice(0, MAX_PRINT_HISTORY);
  saveUnifiedStorage();
}

/**
 * 印刷動画マップを取得する。
 * 取得と同時に件数をログへ出力し、デバッグ用に現在の内容をコンソールへ表示します。
 * @returns {Record<string, string>} id をキーとした動画 URL マップ
 */
export function loadPrintVideos(hostname) {
  const host = hostname;
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
export function savePrintVideos(map, hostname) {
  const host = hostname;
  if (!host) return;
  ensureMachineData(host);
  // 上限超過時は古いエントリから削除
  const keys = Object.keys(map);
  if (keys.length > MAX_VIDEOS) {
    const excess = keys.slice(0, keys.length - MAX_VIDEOS);
    excess.forEach(k => delete map[k]);
    pushLog(`[savePrintVideos] 上限超過のため ${excess.length} 件を削除`);
  }
  monitorData.machines[host].printStore.videos = map;
  // デバッグ用: 保存する動画マップの件数をログに記録
  pushLog(`[savePrintVideos] マップ保存件数: ${Object.keys(map).length}`);
  console.debug("[savePrintVideos] map", map);
  saveUnifiedStorage();
}
