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
 * - {@link compareAndSwapSharedValue}：shared keyを同一transaction内でCAS更新する
 *
 * @version 1.390.1592 (PR #440)
 * @since   1.390.787 (PR #366)
 * @lastModified 2026-09-01 18:47:47
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

// ==============================
// 定数
// ==============================

/**
 * 既定の IndexedDB 名。
 *
 * 親(Electron file://) と standalone(?relay=standalone) は同一オリジン上では
 * このDBを使う(file:// と http:// はブラウザの origin 規則で自動分離されるため、
 * 同名でも互いの DB は物理的に別)。一方、同一ブラウザ内の readonly/satellite は
 * クエリ違いでオリジンが同じため、setIdbDbName() で別名("3dpmon-relay")へ
 * 切り替えてリレー子の永続データを standalone と物理分離する。
 *
 * 旧仕様では DB 名固定 ("3dpmon") のため、ブラウザで readonly を一度開くと
 * 親由来の relay-snapshot で上書きされた monitorData が autoSave で同じDBに
 * 書き戻され、後で ?relay=standalone を開くと standalone の永続データが
 * 物理的に破壊される問題があった(v2.2.1031 spec §6.7 の前提が崩れていた)。
 *
 * @constant {string}
 */
const DEFAULT_DB_NAME = "3dpmon";

/** 現在の IndexedDB 名 (setIdbDbName で初期化前に切替可能) */
let _dbName = DEFAULT_DB_NAME;

const DB_VERSION = 1;
const STORE_SHARED   = "shared";
const STORE_MACHINES = "machines";

/**
 * IndexedDB の DB 名を設定する。**必ず {@link initIdb} の前に呼ぶこと**。
 *
 * リレー子(readonly/satellite)では "3dpmon-relay" 等を渡して standalone と
 * 物理分離する。空文字/undefined を渡すと既定値("3dpmon")へ戻る。
 *
 * @param {string} name - DB 名(例: "3dpmon" / "3dpmon-relay")
 * @returns {void}
 */
export function setIdbDbName(name) {
  _dbName = (typeof name === "string" && name.length > 0) ? name : DEFAULT_DB_NAME;
}

/**
 * 現在設定されている IndexedDB 名を返す。
 * @returns {string}
 */
export function getIdbDbName() {
  return _dbName;
}

// ★ LS_KEY ("3dp-monitor_1.400") は v2.2.0 で削除。マイグレーション不要。

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
  "favoritePresets",
  "filamentInventory",
  // ★ ADR-0004: フィラメント装着履歴（残量導出の権威）＋ watermark(seq)
  "mountHistory",
  "mountHistorySeq",
  // ★ #410-9: 参照不整合で隔離した mount イベント
  "mountHistoryRejectedEvents",
  // ★ #411-O1: オフライン推定の観測 watermark（baseline）＋現セッション観測
  "hostObservationWatermark",
  "hostObservationCurrent",
  // #412-O4: candidate store は baseline commit 前の耐久保存対象。
  "inferredCandidateStore",
  // #420/O6A: recovery blocker と復旧操作 audit event。
  "inferredDecisionRecoveryRequired",
  "inferredRecoveryOperationRecoveryRequired",
  "inferredRecoveryEvents",
  // ★ P0-1: 未帰属消費の隔離領域とアーカイブ（再起動後も失わない）
  "pendingUnattributedUsage",
  "pendingUnattributedUsageArchive",
  // ★ RR-2: 台帳修復要求フラグ
  "ledgerRepairRequired",
  // ★ Gate 18.7: 機器観測フィラメントはread-only evidenceとしてsharedに保存する。
  "materialSourceObservations",
  // ★ Gate 18.9B: Universal MaterialSource移行dry-run journalはauthority書き込みなしの証跡として保存する。
  "materialAccountingMigrationJournal",
  // ★ Gate 18.9D-2: durable shadow commit storeをshadow evidenceとして保存する。
  "materialAccountingMigrationShadowStore",
  // ★ Gate 18.9E: print-start binding / source-aware usage shadow storeを保存する。
  "materialAccountingPrintBindingStore",
  // ★ Gate 18.9H: operator-managed MaterialSource SpoolMount production storeを保存する。
  "materialAccountingSpoolMountStore",
  // ★ "currentSpoolId" は廃止済み。hostSpoolMap が唯一の権威。
  "hostSpoolMap",
  "hostCameraToggle",
  "spoolSerialCounter"
];

/**
 * 通常flush queueでは保存せず、専用CASだけを成功境界にするshared key集合。
 *
 * 【詳細説明】
 * - PrintBinding storeとoperator-managed SpoolMount storeはsource-aware accounting authorityの根拠なので、
 *   throttled saveで古いsnapshotを後から書き込むとCAS成功値を壊す危険がある。
 * - export/import対象としてはSHARED_KEYSへ残しつつ、通常queueだけを拒否する。
 *
 * @constant {ReadonlySet<string>}
 */
const CAS_PROTECTED_SHARED_KEYS = Object.freeze(new Set([
  "materialAccountingPrintBindingStore",
  "materialAccountingSpoolMountStore",
]));

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

    // ★ v2.2.0: 旧 localStorage → IndexedDB マイグレーションは削除。
    //   v2.1.017 LTS が最終移行ポイント。
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
  if (CAS_PROTECTED_SHARED_KEYS.has(String(key || "").trim())) {
    return;
  }
  _pendingShared.set(key, _cloneForStorageQueue(value));
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

  _pendingMachines.set(hostname, _cloneForStorageQueue(filtered));
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
  const sharedEntries  = [..._pendingShared.entries()]
    .filter(([key]) => !CAS_PROTECTED_SHARED_KEYS.has(String(key || "").trim()));
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
    // ★ キューを復元して次回フラッシュで再試行できるようにする
    for (const [key, value] of sharedEntries) {
      if (!_pendingShared.has(key)) _pendingShared.set(key, value);
    }
    for (const [hostname, data] of machineEntries) {
      if (!_pendingMachines.has(hostname)) _pendingMachines.set(hostname, data);
    }
    // ★ IndexedDB を無効化して localStorage フォールバックに切り替え
    _useIdb = false;
    _db = null;
    console.warn("[flushIdb] IndexedDB を無効化、以降 localStorage で動作");
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

/**
 * shared store内の単一keyをcompare-and-swapで更新する。
 *
 * 【詳細説明】
 * - side-effectを伴うproduction authority storeは、通常の非同期キュー保存では成功境界にできない。
 * - 本関数は同一IndexedDB transaction内で現在値を読み、呼び出し元が渡したdigestと一致した場合だけ
 *   次値を書き込む。digest不一致の場合は値を書き換えず`casApplied:false`を返す。
 * - 同一keyに未flushのキュー書き込みが残っているとCAS直後に古い値で上書きされ得るため、
 *   CAS開始時にそのkeyのpending shared writeを破棄する。
 *
 * @function compareAndSwapSharedValue
 * @param {Object} input - CAS入力。
 * @param {string} input.key - shared store key。
 * @param {string} input.expectedDigest - 期待する現在値digest。
 * @param {Function} input.createDigest - 値からdigestを生成する関数。
 * @param {*} input.nextValue - 書き込む次値。
 * @returns {Promise<{ok:boolean, casApplied:boolean, backend:string, key:string, reason:string, currentDigest?:string, nextDigest?:string, error?:string}>} CAS結果。
 * @example
 * const result = await compareAndSwapSharedValue({ key, expectedDigest, createDigest, nextValue });
 */
export async function compareAndSwapSharedValue(input = {}) {
  const key = String(input.key || "").trim();
  const expectedDigest = String(input.expectedDigest || "").trim();
  const createDigest = input.createDigest;
  if (!key || !SHARED_KEYS.includes(key)) {
    return { ok: false, casApplied: false, backend: "indexedDB", key, reason: "invalid-shared-key" };
  }
  if (!expectedDigest || typeof createDigest !== "function") {
    return { ok: false, casApplied: false, backend: "indexedDB", key, reason: "invalid-cas-input" };
  }
  if (!_useIdb || !_db) {
    return { ok: false, casApplied: false, backend: "indexedDB", key, reason: "indexeddb-unavailable" };
  }

  _pendingShared.delete(key);

  try {
    const nextValue = _cloneForStorageQueue(input.nextValue);
    const nextDigest = createDigest(nextValue);
    return await new Promise((resolve) => {
      let settledResult = null;
      const tx = _db.transaction([STORE_SHARED], "readwrite");
      const sharedStore = tx.objectStore(STORE_SHARED);
      const req = sharedStore.get(key);

      req.onsuccess = () => {
        try {
          const currentValue = req.result ? req.result.value : undefined;
          const currentDigest = createDigest(currentValue);
          if (currentDigest !== expectedDigest) {
            settledResult = {
              ok: false,
              casApplied: false,
              backend: "indexedDB",
              key,
              reason: "cas-mismatch",
              currentDigest,
              nextDigest,
            };
            return;
          }
          sharedStore.put({ key, value: nextValue });
          settledResult = {
            ok: true,
            casApplied: true,
            backend: "indexedDB",
            key,
            reason: "cas-applied",
            currentDigest,
            nextDigest,
          };
        } catch (error) {
          settledResult = {
            ok: false,
            casApplied: false,
            backend: "indexedDB",
            key,
            reason: "digest-or-write-failed",
            error: error?.message || String(error),
          };
          try { tx.abort(); } catch { /* transaction may already be finishing */ }
        }
      };
      req.onerror = () => {
        settledResult = {
          ok: false,
          casApplied: false,
          backend: "indexedDB",
          key,
          reason: "indexeddb-read-failed",
          error: req.error?.message || String(req.error || ""),
        };
      };
      tx.oncomplete = () => {
        resolve(settledResult || {
          ok: false,
          casApplied: false,
          backend: "indexedDB",
          key,
          reason: "indexeddb-write-failed",
        });
      };
      tx.onerror = () => {
        resolve({
          ok: false,
          casApplied: false,
          backend: "indexedDB",
          key,
          reason: "indexeddb-write-failed",
          error: tx.error?.message || String(tx.error || ""),
        });
      };
      tx.onabort = () => {
        resolve({
          ok: false,
          casApplied: false,
          backend: "indexedDB",
          key,
          reason: "indexeddb-write-failed",
          error: tx.error?.message || String(tx.error || ""),
        });
      };
    });
  } catch (error) {
    return {
      ok: false,
      casApplied: false,
      backend: "indexedDB",
      key,
      reason: "digest-or-write-failed",
      error: error?.message || String(error),
    };
  }
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
    const req = indexedDB.open(_dbName, DB_VERSION);

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
 * IndexedDB キューへ積む値を保存時点のスナップショットへ複製する。
 *
 * 【詳細説明】
 * - queueSharedWrite/queueMachineWrite は非同期 flush まで値を保持するため、参照をそのまま積むと
 *   flush 前の monitorData 更新が「過去に積んだはずの保存境界」へ混入する。
 * - candidate 保存後 baseline commit 前に耐久境界を作るには、キュー投入時点の値を clone する必要がある。
 * - IndexedDB に保存する値は JSON 互換データが前提なので、structuredClone が使えない環境では
 *   JSON round-trip で代替する。clone 不能な値は最後の安全策として元値を返す。
 *
 * @private
 * @function _cloneForStorageQueue
 * @param {*} value - キューへ積む保存値。
 * @returns {*} キュー投入時点のスナップショット。
 */
function _cloneForStorageQueue(value) {
  if (value == null) return value;
  try {
    if (typeof structuredClone === "function") return structuredClone(value);
  } catch { /* JSON fallback へ進む */ }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
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
