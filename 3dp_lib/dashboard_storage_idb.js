/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 IndexedDB ストレージバックエンド
 * @file dashboard_storage_idb.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_storage_idb
 *
 * 【機能内容サマリ】
 * - IndexedDB を用いた per-host 分離ストレージ
 * - 書き込みキューによるバッチ書き込み
 * - localStorage からの自動マイグレーション
 * - エクスポート/インポート用の全データ一括読み書き
 *
 * 【公開関数一覧】
 * - {@link initIdb}：DB を開き既存データをキャッシュへ読み込む
 * - {@link isIdbAvailable}：IndexedDB が使用可能か返す
 * - {@link getIdbCache}：起動時キャッシュを返す（1回限り）
 * - {@link queueSharedWrite}：shared ストアへの書き込みをキューに追加
 * - {@link queueMachineWrite}：machines ストアへの書き込みをキューに追加
 * - {@link flushIdb}：キューを即時書き込み
 * - {@link exportAllIdb}：全データを単一オブジェクトとして読み出し
 * - {@link importAllIdb}：単一オブジェクトから全データを書き込み
 *
 * @version 1.390.787 (PR #366)
 * @since   1.390.787 (PR #366)
 * @lastModified 2026-03-11 01:00:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

// ==============================
// 定数
// ==============================

const DB_NAME    = "3dpmon";
const DB_VERSION = 1;
const STORE_SHARED   = "shared";
const STORE_MACHINES = "machines";

/** localStorage からのマイグレーション元キー */
const LS_KEY = "3dp-monitor_1.400";

/**
 * shared ストアに保存するキー一覧
 * @type {string[]}
 */
const SHARED_KEYS = [
  "appSettings",
  "filamentSpools",
  "usageHistory",
  "filamentPresets",
  "userPresets",
  "hiddenPresets",
  "filamentInventory",
  "currentSpoolId",
  "hostSpoolMap",
  "hostCameraToggle",
  "spoolSerialCounter"
];

/**
 * storedData 内で永続化不要な揮発性フィールド。
 * プリンタ再接続時に全フィールドが送信されるため、
 * 高頻度更新される温度・ファン等は保存対象から除外する。
 * @type {Set<string>}
 */
const VOLATILE_FIELDS = new Set([
  "nozzleTemp", "targetNozzleTemp",
  "bedTemp0", "targetBedTemp0",
  "boxTemp",
  "fan_gear", "heatbreak_fan_speed",
  "printProgress", "printLeftTime",
  "curPosition"
]);

// ==============================
// 内部状態
// ==============================

/** @type {IDBDatabase|null} */
let _db = null;

/** IndexedDB が利用可能か */
let _useIdb = true;

/** 起動時キャッシュ（1回消費） */
let _cache = null;

/** 書き込みキュー */
const _pendingShared   = new Map();
const _pendingMachines = new Map();
let _flushScheduled = false;

// ==============================
// DB 初期化
// ==============================

/**
 * IndexedDB を開き、既存データをキャッシュへ読み込む。
 * localStorage に旧データがあれば自動マイグレーションを行う。
 *
 * @returns {Promise<void>}
 */
export async function initIdb() {
  try {
    _db = await _openDatabase();
    const shared   = await _readAll(STORE_SHARED);
    const machines = await _readAll(STORE_MACHINES);

    const hasIdbData = Object.keys(shared).length > 0 || Object.keys(machines).length > 0;

    if (hasIdbData) {
      _cache = { shared, machines };
      return;
    }

    // IndexedDB にデータなし → localStorage からマイグレーション
    const lsData = localStorage.getItem(LS_KEY);
    if (lsData) {
      const parsed = JSON.parse(lsData);
      await importAllIdb(parsed);
      _cache = {
        shared:   await _readAll(STORE_SHARED),
        machines: await _readAll(STORE_MACHINES)
      };
      console.info("[initIdb] localStorage → IndexedDB マイグレーション完了");
    }
  } catch (e) {
    console.warn("[initIdb] IndexedDB 初期化失敗、localStorage にフォールバック:", e);
    _useIdb = false;
    _db = null;
  }
}

/**
 * IndexedDB が使用可能かどうかを返す。
 * @returns {boolean}
 */
export function isIdbAvailable() {
  return _useIdb && _db !== null;
}

/**
 * 起動時キャッシュを返す。呼び出しは1回限り（2回目以降は null）。
 * @returns {{ shared: Record<string, any>, machines: Record<string, any> } | null}
 */
export function getIdbCache() {
  const c = _cache;
  _cache = null;
  return c;
}

// ==============================
// 書き込みキュー
// ==============================

/**
 * shared ストアへの書き込みをキューに追加する。
 * @param {string} key - 保存キー
 * @param {any} value - 保存する値
 */
export function queueSharedWrite(key, value) {
  _pendingShared.set(key, value);
  _scheduleFlush();
}

/**
 * machines ストアへの書き込みをキューに追加する。
 * storedData 内の揮発性フィールドは除外される。
 *
 * @param {string} hostname - ホスト名
 * @param {Object} machineData - マシンデータオブジェクト
 */
export function queueMachineWrite(hostname, machineData) {
  // 揮発性データを除外した浅いコピーを作成
  const filtered = { ...machineData };

  // runtimeData は揮発性のため除外
  delete filtered.runtimeData;

  // storedData 内の高頻度更新フィールドを除外
  if (filtered.storedData) {
    const sd = { ...filtered.storedData };
    for (const key of VOLATILE_FIELDS) {
      delete sd[key];
    }
    filtered.storedData = sd;
  }

  _pendingMachines.set(hostname, filtered);
  _scheduleFlush();
}

/**
 * キューに溜まった書き込みを即座に実行する。
 * @returns {Promise<void>}
 */
export async function flushIdb() {
  if (_pendingShared.size === 0 && _pendingMachines.size === 0) return;
  if (!_db) return;

  // キューを取得してクリア
  const sharedEntries  = [..._pendingShared.entries()];
  const machineEntries = [..._pendingMachines.entries()];
  _pendingShared.clear();
  _pendingMachines.clear();

  try {
    const tx = _db.transaction([STORE_SHARED, STORE_MACHINES], "readwrite");
    const sharedStore  = tx.objectStore(STORE_SHARED);
    const machineStore = tx.objectStore(STORE_MACHINES);

    for (const [key, value] of sharedEntries) {
      sharedStore.put({ key, value });
    }
    for (const [hostname, data] of machineEntries) {
      machineStore.put({ hostname, ...data });
    }

    await _txComplete(tx);
  } catch (e) {
    console.error("[flushIdb] IndexedDB 書き込み失敗:", e);
    // フォールバック: localStorage に書き込み
    _fallbackToLocalStorage();
  }
}

// ==============================
// エクスポート / インポート
// ==============================

/**
 * 全データを読み出し、monitorData 互換のオブジェクトとして返す。
 * @returns {Promise<Object>}
 */
export async function exportAllIdb() {
  if (!_db) throw new Error("IndexedDB not available");

  const shared   = await _readAll(STORE_SHARED);
  const machines = await _readAll(STORE_MACHINES);

  // monitorData 互換形式に再構築
  const result = {};
  for (const [key, value] of Object.entries(shared)) {
    result[key] = value;
  }
  result.machines = machines;
  return result;
}

/**
 * monitorData 互換のオブジェクトから全データを書き込む。
 * 既存データはクリアされる。
 *
 * @param {Object} data - インポートするデータ
 * @returns {Promise<void>}
 */
export async function importAllIdb(data) {
  if (!_db) throw new Error("IndexedDB not available");

  const tx = _db.transaction([STORE_SHARED, STORE_MACHINES], "readwrite");
  const sharedStore  = tx.objectStore(STORE_SHARED);
  const machineStore = tx.objectStore(STORE_MACHINES);

  // 既存データをクリア
  sharedStore.clear();
  machineStore.clear();

  // shared データを書き込み
  for (const key of SHARED_KEYS) {
    if (key in data) {
      sharedStore.put({ key, value: data[key] });
    }
  }

  // machines データを書き込み
  if (data.machines && typeof data.machines === "object") {
    for (const [hostname, machineData] of Object.entries(data.machines)) {
      const filtered = { ...machineData };
      delete filtered.runtimeData;
      machineStore.put({ hostname, ...filtered });
    }
  }

  await _txComplete(tx);
}

// ==============================
// 内部ヘルパー
// ==============================

/**
 * IndexedDB を開く（またはアップグレード）。
 * @private
 * @returns {Promise<IDBDatabase>}
 */
function _openDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_SHARED)) {
        db.createObjectStore(STORE_SHARED, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(STORE_MACHINES)) {
        db.createObjectStore(STORE_MACHINES, { keyPath: "hostname" });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * 指定ストアの全レコードを読み出す。
 * @private
 * @param {string} storeName
 * @returns {Promise<Record<string, any>>}
 */
function _readAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx    = _db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req   = store.getAll();

    req.onsuccess = () => {
      const result = {};
      for (const record of req.result) {
        if (storeName === STORE_SHARED) {
          result[record.key] = record.value;
        } else {
          const { hostname, ...rest } = record;
          result[hostname] = rest;
        }
      }
      resolve(result);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * トランザクションの完了を待つ。
 * @private
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
function _txComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(tx.error || new Error("Transaction aborted"));
  });
}

/**
 * 次のマイクロタスクで flushIdb を実行するようスケジュールする。
 * @private
 */
function _scheduleFlush() {
  if (_flushScheduled) return;
  _flushScheduled = true;
  queueMicrotask(async () => {
    _flushScheduled = false;
    try {
      await flushIdb();
    } catch (e) {
      console.error("[_scheduleFlush] flush 失敗:", e);
    }
  });
}

/**
 * IndexedDB 書き込み失敗時の localStorage フォールバック。
 * @private
 */
function _fallbackToLocalStorage() {
  try {
    // monitorData は呼び出し元のスコープにないため、
    // ここでは空実装。dashboard_storage.js 側でフォールバックを処理する。
    console.warn("[flushIdb] localStorage フォールバックは dashboard_storage.js で処理");
  } catch (e) {
    console.error("[_fallbackToLocalStorage] フォールバックも失敗:", e);
  }
}
