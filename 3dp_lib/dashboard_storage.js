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
  let data;
  if (_idbInitialized) {
    data = await exportAllIdb();
  } else {
    // フォールバック: localStorage（per-host 分割形式対応）
    const globalRaw = localStorage.getItem(LS_KEY_GLOBAL);
    if (globalRaw) {
      data = JSON.parse(globalRaw);
      data.machines = {};
      const hostKeys = _discoverHostKeysInLocalStorage();
      for (const host of hostKeys) {
        const hostRaw = localStorage.getItem(LS_KEY_HOST_PREFIX + _encodeHostKey(host));
        if (hostRaw) data.machines[host] = JSON.parse(hostRaw);
      }
    } else {
      const raw = localStorage.getItem(STORAGE_KEY);
      data = raw ? JSON.parse(raw) : {};
    }
  }

  // パネルレイアウトをエクスポートデータに含める
  try {
    const { getCurrentLayoutData } = await import("./dashboard_panel_factory.js");
    const layout = getCurrentLayoutData();
    if (layout) data.panelLayout = layout;
  } catch { /* パネルモジュール未初期化でも続行 */ }

  return data;
}

/**
 * JSON オブジェクトから全データをマージインポートする（UI 用）。
 *
 * 既存データを削除せず、インポートデータの新規分のみ追加する。
 * 同一IDのデータが存在する場合は新しい方を採用する。
 *
 * @param {Object} data - インポートするデータ
 * @returns {{ spools: number, history: number, presets: number, inventory: number, machines: number, panels: number }}
 *          各カテゴリの追加件数
 */
export async function importAllData(data) {
  const stats = { spools: 0, history: 0, presets: 0, inventory: 0, machines: 0, panels: 0 };

  // ── スプール: id ベースでマージ ──
  if (Array.isArray(data.filamentSpools)) {
    const existingIds = new Set(monitorData.filamentSpools.map(s => s.id));
    for (const sp of data.filamentSpools) {
      if (!sp.id) continue;
      if (existingIds.has(sp.id)) {
        // 既存スプール: 新しい方で更新 (startedAt が大きい = 新しい)
        const existing = monitorData.filamentSpools.find(s => s.id === sp.id);
        if (existing && (sp.startedAt || 0) > (existing.startedAt || 0)) {
          Object.assign(existing, sp);
          stats.spools++;
        }
      } else {
        applySpoolDefaults(sp);
        monitorData.filamentSpools.push(sp);
        existingIds.add(sp.id);
        stats.spools++;
      }
    }
  }

  // ── 使用履歴: usageId ベースで重複排除追加 ──
  if (Array.isArray(data.usageHistory)) {
    const existingIds = new Set(
      (monitorData.usageHistory || []).map(u => u.usageId)
    );
    for (const u of data.usageHistory) {
      if (u.usageId && !existingIds.has(u.usageId)) {
        monitorData.usageHistory.push(u);
        existingIds.add(u.usageId);
        stats.history++;
      }
    }
    // 時系列順にソート
    monitorData.usageHistory.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    trimUsageHistory();
  }

  // ── プリセット: presetId ベースで新規のみ追加 (ユーザー編集版を保持) ──
  if (Array.isArray(data.filamentPresets)) {
    const existingIds = new Set(
      (monitorData.filamentPresets || []).map(p => p.presetId)
    );
    for (const p of data.filamentPresets) {
      if (p.presetId && !existingIds.has(p.presetId)) {
        monitorData.filamentPresets.push(p);
        existingIds.add(p.presetId);
        stats.presets++;
      }
    }
  }

  // ── 在庫: modelId ベースでマージ ──
  if (Array.isArray(data.filamentInventory)) {
    const existingMap = new Map(
      (monitorData.filamentInventory || []).map(inv => [inv.modelId, inv])
    );
    for (const inv of data.filamentInventory) {
      if (!inv.modelId) continue;
      if (existingMap.has(inv.modelId)) {
        // 既存: quantity は大きい方を採用
        const existing = existingMap.get(inv.modelId);
        if ((inv.quantity || 0) > (existing.quantity || 0)) {
          existing.quantity = inv.quantity;
          stats.inventory++;
        }
      } else {
        monitorData.filamentInventory.push(inv);
        existingMap.set(inv.modelId, inv);
        stats.inventory++;
      }
    }
  }

  // ── spoolSerialCounter: 大きい方を採用 ──
  if (typeof data.spoolSerialCounter === "number" &&
      data.spoolSerialCounter > monitorData.spoolSerialCounter) {
    monitorData.spoolSerialCounter = data.spoolSerialCounter;
  }

  // ── hostSpoolMap: 既存を保持、新規ホストのみ追加 ──
  if (data.hostSpoolMap && typeof data.hostSpoolMap === "object") {
    for (const [host, spoolId] of Object.entries(data.hostSpoolMap)) {
      if (!(host in monitorData.hostSpoolMap)) {
        monitorData.hostSpoolMap[host] = spoolId;
      }
    }
  }

  // ── machines: 印刷履歴をマージ ──
  if (data.machines && typeof data.machines === "object") {
    for (const [host, machineData] of Object.entries(data.machines)) {
      if (!monitorData.machines[host]) {
        // 新規ホスト: そのまま追加
        monitorData.machines[host] = machineData;
        stats.machines++;
      } else {
        // 既存ホスト: printStore.history をマージ
        const existing = monitorData.machines[host];
        if (Array.isArray(machineData.printStore?.history)) {
          if (!existing.printStore) existing.printStore = {};
          if (!Array.isArray(existing.printStore.history)) existing.printStore.history = [];
          const existingJobIds = new Set(existing.printStore.history.map(j => j.id));
          for (const job of machineData.printStore.history) {
            if (job.id && !existingJobIds.has(job.id)) {
              existing.printStore.history.push(job);
              existingJobIds.add(job.id);
              stats.machines++;
            }
          }
        }
      }
    }
  }

  // ── appSettings: インポートでは上書きしない (既存設定を保持) ──
  // 接続先だけはマージ (新規のみ追加)
  if (Array.isArray(data.appSettings?.connectionTargets)) {
    const existingDests = new Set(
      (monitorData.appSettings.connectionTargets || []).map(t => t.dest)
    );
    for (const t of data.appSettings.connectionTargets) {
      if (t.dest && !existingDests.has(t.dest)) {
        monitorData.appSettings.connectionTargets.push(t);
        existingDests.add(t.dest);
      }
    }
  }

  // ── パネルレイアウト: panelLayout が含まれていれば適用 ──
  if (Array.isArray(data.panelLayout) && data.panelLayout.length > 0) {
    try {
      const { importLayoutData } = await import("./dashboard_panel_factory.js");
      stats.panels = importLayoutData(data.panelLayout, { remapHosts: false });
    } catch {
      // パネルモジュール未初期化（ブラウザ版等）ではスキップ
      stats.panels = 0;
    }
  }

  // ── 保存 ──
  saveUnifiedStorage(true);

  return stats;
}

/**
 * 印刷履歴のみをインポートする（名寄せモード）。
 *
 * 機器ごとの印刷履歴を ID 重複排除で追加し、
 * 既存ジョブと同一ファイル (rawFilename or filename) の
 * MD5・動画URL・フィラメント情報を名寄せで補完する。
 * フィラメント使用実績 (usageHistory) は既存に同一 spoolId + jobId が
 * なく、かつ消費量に矛盾がない場合のみ追加する。
 *
 * @param {Object} data - インポートするデータ (monitorData 互換)
 * @returns {{ added: number, enriched: number, usageAdded: number, skippedHosts: string[] }}
 */
export function importHistoryOnly(data) {
  const stats = { added: 0, enriched: 0, usageAdded: 0, skippedHosts: [] };
  if (!data.machines || typeof data.machines !== "object") return stats;

  for (const [host, machineData] of Object.entries(data.machines)) {
    const history = machineData.printStore?.history;
    if (!Array.isArray(history) || history.length === 0) continue;

    // 既存ホストがなければ作成
    if (!monitorData.machines[host]) {
      monitorData.machines[host] = { storedData: {}, runtimeData: {}, historyData: [] };
    }
    const existing = monitorData.machines[host];
    if (!existing.printStore) existing.printStore = {};
    if (!Array.isArray(existing.printStore.history)) existing.printStore.history = [];

    const existingJobIds = new Set(existing.printStore.history.map(j => j.id));

    // ── ファイル名 → MD5/動画URL のマッピングを構築（名寄せ用）──
    const fileToMeta = new Map();
    for (const job of history) {
      const fname = job.rawFilename || job.filename || "";
      if (!fname) continue;
      const entry = fileToMeta.get(fname) || {};
      if (job.filemd5 && !entry.filemd5) entry.filemd5 = job.filemd5;
      if (job.videoUrl && !entry.videoUrl) entry.videoUrl = job.videoUrl;
      if (Array.isArray(job.filamentInfo) && job.filamentInfo.length > 0 && !entry.filamentInfo) {
        entry.filamentInfo = job.filamentInfo;
      }
      if (job.filamentId && !entry.filamentId) entry.filamentId = job.filamentId;
      if (job.filamentColor && !entry.filamentColor) entry.filamentColor = job.filamentColor;
      if (job.filamentType && !entry.filamentType) entry.filamentType = job.filamentType;
      fileToMeta.set(fname, entry);
    }

    // ── 新規ジョブの追加 ──
    for (const job of history) {
      if (!job.id) continue;
      if (!existingJobIds.has(job.id)) {
        existing.printStore.history.push(job);
        existingJobIds.add(job.id);
        stats.added++;
      }
    }

    // ── 既存ジョブの名寄せ補完 ──
    for (const existingJob of existing.printStore.history) {
      const fname = existingJob.rawFilename || existingJob.filename || "";
      if (!fname) continue;
      const meta = fileToMeta.get(fname);
      if (!meta) continue;

      let enriched = false;
      // MD5 補完
      if (!existingJob.filemd5 && meta.filemd5) {
        existingJob.filemd5 = meta.filemd5;
        enriched = true;
      }
      // 動画URL 補完
      if (!existingJob.videoUrl && meta.videoUrl) {
        existingJob.videoUrl = meta.videoUrl;
        enriched = true;
      }
      // フィラメント情報補完
      if (!existingJob.filamentId && meta.filamentId) {
        existingJob.filamentId = meta.filamentId;
        enriched = true;
      }
      if (!existingJob.filamentColor && meta.filamentColor) {
        existingJob.filamentColor = meta.filamentColor;
        enriched = true;
      }
      if (!existingJob.filamentType && meta.filamentType) {
        existingJob.filamentType = meta.filamentType;
        enriched = true;
      }
      if ((!existingJob.filamentInfo || existingJob.filamentInfo.length === 0) && meta.filamentInfo) {
        existingJob.filamentInfo = meta.filamentInfo;
        enriched = true;
      }
      if (enriched) stats.enriched++;
    }

    // 履歴を時系列順にソート (starttime 降順 = 新しい順)
    existing.printStore.history.sort((a, b) => {
      const ta = Number(a.starttime || a.id || 0);
      const tb = Number(b.starttime || b.id || 0);
      return tb - ta;
    });
  }

  // ── フィラメント使用実績 (usageHistory): 不整合チェック付きマージ ──
  if (Array.isArray(data.usageHistory)) {
    const existingIds = new Set(
      (monitorData.usageHistory || []).map(u => u.usageId)
    );
    // 既存スプールIDセット (不整合チェック用)
    const existingSpoolIds = new Set(
      monitorData.filamentSpools.map(s => s.id)
    );

    for (const u of data.usageHistory) {
      if (!u.usageId || existingIds.has(u.usageId)) continue;
      // 不整合チェック: spoolId が既存スプールに存在するか
      if (u.spoolId && !existingSpoolIds.has(u.spoolId)) continue;
      monitorData.usageHistory.push(u);
      existingIds.add(u.usageId);
      stats.usageAdded++;
    }
    if (stats.usageAdded > 0) {
      monitorData.usageHistory.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
      trimUsageHistory();
    }
  }

  return stats;
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
 * v1.40 以降の統一ストレージキー（レガシー、v2.1.007 で分割に移行）。
 * ※ v1.25/v1.29 の個別キーからの移行は廃止済み。
 *   最小サポート移行元バージョン: v1.40
 */
const STORAGE_KEY = "3dp-monitor_1.400";

/** per-host localStorage 分割キー: グローバルデータ用 */
const LS_KEY_GLOBAL = "3dpmon-global";
/** per-host localStorage 分割キー: ホスト別データの接頭辞 */
const LS_KEY_HOST_PREFIX = "3dpmon-host-";

/** localStorage 用に保存可能なグローバルフィールド名一覧 */
const LS_GLOBAL_FIELDS = [
  "appSettings", "filamentSpools", "usageHistory", "filamentPresets",
  "userPresets", "hiddenPresets", "filamentInventory", "currentSpoolId",
  "hostSpoolMap", "hostCameraToggle", "spoolSerialCounter"
];

/**
 * ホスト名を localStorage キーに安全にエンコードする。
 * encodeURIComponent でエスケープし、全ての特殊文字を安全に保存。
 * ハイフンを含むホスト名（k1max-abcd.local:9999）でも可逆。
 *
 * @param {string} host - ホスト名
 * @returns {string} エンコード済みキー文字列
 */
function _encodeHostKey(host) {
  return encodeURIComponent(host || "");
}

/**
 * エンコード済みキーをホスト名にデコードする。
 *
 * @param {string} encoded - エンコード済み文字列
 * @returns {string} 元のホスト名
 */
function _decodeHostKey(encoded) {
  try {
    return decodeURIComponent(encoded || "");
  } catch {
    return encoded || "";
  }
}

/**
 * localStorage から per-host 分割キーをスキャンし、全ホスト名を返す。
 *
 * @returns {Set<string>} 発見されたホスト名のセット
 */
function _discoverHostKeysInLocalStorage() {
  const hosts = new Set();
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(LS_KEY_HOST_PREFIX)) {
      hosts.add(_decodeHostKey(key.substring(LS_KEY_HOST_PREFIX.length)));
    }
  }
  return hosts;
}
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
 * monitorData を per-host 分割形式で localStorage に書き込む。
 * グローバルデータは LS_KEY_GLOBAL に、per-host データは LS_KEY_HOST_PREFIX+hostname に書き込む。
 * 前回書き込みと同一ならスキップする。
 *
 * @private
 * @returns {void}
 */
function _writePerHostLocalStorage() {
  // グローバルデータ
  const globalData = {};
  for (const field of LS_GLOBAL_FIELDS) {
    if (field in monitorData) globalData[field] = monitorData[field];
  }
  const globalJson = JSON.stringify(globalData);
  if (globalJson !== _lastSavedJson) {
    localStorage.setItem(LS_KEY_GLOBAL, globalJson);
    _lastSavedJson = globalJson;
  }

  // per-host データ
  const activeHosts = new Set();
  for (const [host, machine] of Object.entries(monitorData.machines)) {
    if (host === PLACEHOLDER_HOSTNAME) continue;
    activeHosts.add(host);
    const hostKey = LS_KEY_HOST_PREFIX + _encodeHostKey(host);
    const hostJson = JSON.stringify(machine);
    // per-host のデデュープは簡易チェック（サイズ比較）
    const prev = localStorage.getItem(hostKey);
    if (prev && prev.length === hostJson.length && prev === hostJson) continue;
    localStorage.setItem(hostKey, hostJson);
  }

  // 孤児ホストキーの削除（machines に存在しないホスト）
  const storedHosts = _discoverHostKeysInLocalStorage();
  for (const host of storedHosts) {
    if (!activeHosts.has(host)) {
      localStorage.removeItem(LS_KEY_HOST_PREFIX + _encodeHostKey(host));
    }
  }

  // 旧統一キーが残っていれば削除（マイグレーション完了）
  if (localStorage.getItem(STORAGE_KEY)) {
    localStorage.removeItem(STORAGE_KEY);
  }
}

/**
 * 実際のストレージ書き込みを行う内部関数。
 * IndexedDB が有効な場合はキューに追加し、無効な場合は localStorage へ書き込む。
 * @private
 */
function _flushStorage() {
  _savePending = false;
  try {
    if (_idbInitialized && isIdbAvailable()) {
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
      // ★ per-host 分割形式で書き出す
      const now = Date.now();
      if (!_lastLsBackupEpoch || now - _lastLsBackupEpoch > 60000) {
        _lastLsBackupEpoch = now;
        try {
          _writePerHostLocalStorage();
        } catch (e) {
          console.warn("[saveUnifiedStorage] localStorage バックアップ失敗:", e.message);
        }
      }

      if (_enableStorageLog) {
        console.debug("[saveUnifiedStorage] IndexedDB キューに追加しました");
      }
    } else {
      // フォールバック: localStorage（per-host 分割形式）
      _writePerHostLocalStorage();

      if (_enableStorageLog) {
        console.debug("[saveUnifiedStorage] localStorage (per-host) に保存しました");
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

  // フォールバック: localStorage（per-host 分割形式を優先）
  const globalSaved = localStorage.getItem(LS_KEY_GLOBAL);
  if (globalSaved) {
    try {
      const shared = JSON.parse(globalSaved);
      // per-host キーをスキャンして machines を構築
      const machines = {};
      const hostKeys = _discoverHostKeysInLocalStorage();
      for (const host of hostKeys) {
        const hostKey = LS_KEY_HOST_PREFIX + _encodeHostKey(host);
        const hostData = localStorage.getItem(hostKey);
        if (hostData) {
          machines[host] = JSON.parse(hostData);
        }
      }
      _restoreFromData(shared, machines);
      _lastSavedJson = globalSaved;
      console.debug(`[restoreUnifiedStorage] localStorage (per-host) から復元: ${hostKeys.size}ホスト`);
    } catch (e) {
      console.error("[restoreUnifiedStorage] per-host パースエラー:", e);
      pushLog("[restoreUnifiedStorage] per-host 復元中にパースエラー発生", true);
    }
  } else {
    // レガシー: 旧統一キーからマイグレーション
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const data = JSON.parse(saved);
        _restoreFromData(data, data.machines);
        _lastSavedJson = null; // 分割形式と異なるので null にして次回書き込みを促す
        console.debug("[restoreUnifiedStorage] localStorage (旧統一キー) から復元 → 分割形式にマイグレーション");
        // マイグレーション: 次の _flushStorage() で分割キーが書き込まれ、旧キーが削除される
      } catch (e) {
        console.error("[restoreUnifiedStorage] パースエラー:", e);
        pushLog("[restoreUnifiedStorage] 復元中にパースエラー発生", true);
      }
    } else {
      console.debug("[restoreUnifiedStorage] 保存データなし。初回起動として扱います");
    }
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
  if (shared?.appSettings && typeof shared.appSettings === "object") {
    // ★ deep merge: connectionTargets等のネスト配列を保護
    for (const [key, val] of Object.entries(shared.appSettings)) {
      if (val === null || val === undefined) continue;
      if (Array.isArray(val)) {
        // 配列: 既存が空なら復元値を使用、既存があればそのまま
        if (!monitorData.appSettings[key]?.length) {
          monitorData.appSettings[key] = val;
        }
      } else if (typeof val === "object") {
        // オブジェクト: 再帰マージ
        monitorData.appSettings[key] = Object.assign(monitorData.appSettings[key] || {}, val);
      } else {
        // プリミティブ: 上書き
        monitorData.appSettings[key] = val;
      }
    }
  }

  // ★ machines: 全置換ではなくマージ（既存ランタイムデータを保護）
  if (machines && typeof machines === "object") {
    for (const [host, machineData] of Object.entries(machines)) {
      if (!monitorData.machines[host]) {
        // 新規ホスト: そのまま追加
        monitorData.machines[host] = machineData;
      } else {
        // 既存ホスト: storedData をマージ（ランタイムデータを保護）
        const existing = monitorData.machines[host];
        if (machineData.storedData) {
          if (!existing.storedData) existing.storedData = {};
          for (const [key, val] of Object.entries(machineData.storedData)) {
            // 既存値がなければ復元値を適用
            if (!(key in existing.storedData) || existing.storedData[key]?.rawValue == null) {
              existing.storedData[key] = val;
            }
          }
        }
        // printStore, historyData: 既存が空なら復元値を適用
        if (machineData.printStore && (!existing.printStore?.history?.length)) {
          existing.printStore = machineData.printStore;
        }
        if (machineData.historyData?.length && !existing.historyData?.length) {
          existing.historyData = machineData.historyData;
        }
      }
    }
  }

  // ★ filamentSpools: IDベースマージ（既存を優先、新規のみ追加）
  if (Array.isArray(shared?.filamentSpools)) {
    const existingIds = new Set(monitorData.filamentSpools.map(s => s.id));
    for (const sp of shared.filamentSpools) {
      if (!sp.id) continue;
      if (existingIds.has(sp.id)) {
        // 既存スプール: ★ アクティブ（印刷中/装着中）ならランタイム状態を保護
        const existing = monitorData.filamentSpools.find(s => s.id === sp.id);
        if (existing && !existing.isActive && !existing.isInUse) {
          Object.assign(existing, applySpoolDefaults(sp));
        }
        // else: ランタイム状態が権威 — ストレージ値で上書きしない
      } else {
        // 新規スプール: 追加
        monitorData.filamentSpools.push(applySpoolDefaults(sp));
      }
    }
  }

  // ★ usageHistory: 既存が空の時のみ復元（ランタイム追加分を保護）
  if (Array.isArray(shared?.usageHistory)) {
    if (monitorData.usageHistory.length === 0) {
      monitorData.usageHistory = shared.usageHistory;
    } else {
      // 既存あり: 新しいエントリのみ追記（usageId優先、fallbackでspoolId+startedAt）
      const _usageKey = (u) => u.usageId || `${u.spoolId || ""}_${u.startedAt || ""}_${u.usedLength || 0}`;
      const existingIds = new Set(monitorData.usageHistory.map(_usageKey));
      for (const entry of shared.usageHistory) {
        const key = _usageKey(entry);
        if (!existingIds.has(key)) {
          monitorData.usageHistory.push(entry);
        }
      }
    }
  }
  trimUsageHistory();

  // ★ filamentInventory: IDベースマージ
  if (Array.isArray(shared?.filamentInventory)) {
    if (monitorData.filamentInventory.length === 0) {
      monitorData.filamentInventory = shared.filamentInventory;
    } else {
      const existingIds = new Set(monitorData.filamentInventory.map(i => i.modelId));
      for (const inv of shared.filamentInventory) {
        if (!inv.modelId) continue;
        if (existingIds.has(inv.modelId)) {
          const existing = monitorData.filamentInventory.find(i => i.modelId === inv.modelId);
          if (existing) Object.assign(existing, inv);
        } else {
          monitorData.filamentInventory.push(inv);
        }
      }
    }
  }

  // プリセット: ストレージのユーザー編集済みデータとコード側の新規追加をマージ
  if (Array.isArray(shared?.filamentPresets)) {
    const storedIds = new Set(shared.filamentPresets.map(p => p.presetId));
    const newPresets = FILAMENT_PRESETS.filter(p => !storedIds.has(p.presetId));
    monitorData.filamentPresets = [...shared.filamentPresets, ...newPresets];
    if (newPresets.length > 0) {
      console.info(`[_restoreFromData] 新規プリセット ${newPresets.length} 件をマージ`);
    }
  }

  if (shared && "currentSpoolId" in shared) {
    monitorData.currentSpoolId = shared.currentSpoolId;
  }

  // ★ hostSpoolMap: マージ（既存の装着情報を保護、全クリアしない）
  if (shared?.hostSpoolMap && typeof shared.hostSpoolMap === "object") {
    for (const [host, spoolId] of Object.entries(shared.hostSpoolMap)) {
      if (spoolId && !monitorData.hostSpoolMap[host]) {
        monitorData.hostSpoolMap[host] = spoolId;
      }
    }
  } else if (shared && "currentSpoolId" in shared && shared.currentSpoolId) {
    // レガシー移行: グローバル currentSpoolId からスプールの hostname を使って推定
    const spool = monitorData.filamentSpools.find(
      s => s.id === shared.currentSpoolId && !s.deleted
    );
    if (spool && spool.hostname && !monitorData.hostSpoolMap[spool.hostname]) {
      monitorData.hostSpoolMap[spool.hostname] = shared.currentSpoolId;
    }
    // ★ 全クリア（= {}）は行わない — 既存の装着情報を保護
  }

  // per-host カメラトグルの復元（マージ）
  if (shared?.hostCameraToggle && typeof shared.hostCameraToggle === "object") {
    Object.assign(monitorData.hostCameraToggle, shared.hostCameraToggle);
  }

  if (shared && "spoolSerialCounter" in shared) {
    const restored = Number(shared.spoolSerialCounter);
    if (Number.isFinite(restored) && restored > monitorData.spoolSerialCounter) {
      monitorData.spoolSerialCounter = restored;
    }
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
