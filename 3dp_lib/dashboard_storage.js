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
 * - {@link saveUnifiedStorageDurably}：全データを耐久保存完了まで待つ
 * - {@link commitMaterialAccountingSpoolMountStoreDurably}：SpoolMount storeをCAS境界で耐久保存
 * - {@link commitMaterialAccountingPrintBindingStoreDurably}：PrintBinding storeをCAS境界で耐久保存
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
 * @version 1.390.1653 (PR #440)
 * @since   1.390.193 (PR #86)
 * @lastModified 2026-09-02 16:50:21
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

import { monitorData, ensureMachineData, PLACEHOLDER_HOSTNAME } from "./dashboard_data.js";
import { FILAMENT_PRESETS } from "./dashboard_filament_presets.js";
import { logManager } from "./dashboard_log_util.js";
import { getCurrentTimestamp } from "./dashboard_utils.js";
import {
  attributedUsed,
  getSpoolIntervals,
  initLedgerAnchors,
  quarantineInvalidMountEvents
} from "./dashboard_filament_ledger.js";
import { parseDest, isIpLiteral, extractHost } from "./dashboard_target_identity.js";
import { normalizeStoredMaterialSourceObservations } from "./printer_core/dashboard_material_source_observation.js";
import { normalizeStoredMaterialAccountingMigrationJournal } from "./printer_core/dashboard_material_accounting_migration_journal.js";
import { normalizeStoredMaterialAccountingMigrationShadowCommitStore } from "./printer_core/dashboard_material_accounting_migration_shadow_commit.js";
import {
  createMaterialAccountingPrintBindingStoreDigest,
  normalizeStoredMaterialAccountingPrintBindingStore,
} from "./printer_core/dashboard_material_accounting_print_binding.js";
import {
  createMaterialAccountingSpoolMountStoreDigest,
  normalizeStoredMaterialAccountingSpoolMountStore,
} from "./printer_core/dashboard_material_accounting_mount_store.js";
import {
  findUniversalSpoolAssignmentConflict,
  reconcileCurrentOpenUniversalSpoolMountsAgainstBackends,
} from "./printer_core/dashboard_material_accounting_spool_assignment_guard.js";
import {
  createPrinterCoreV3DeterministicId,
  stableStringifyPrinterCoreV3Value,
} from "./printer_core/dashboard_data_schema_v3.js";
import { normalizeStoredPhysicalCommandRecoveryLatchStore } from "./printer_core/dashboard_physical_command_recovery_latch.js";
import {
  FILAMENT_UNIT_KIND,
  MATERIAL_IDENTITY_STRENGTH,
  MATERIAL_SOURCE_KIND,
  createMaterialSourceIdentity,
  createMaterialSourceLocator,
  createMaterialSourceRecord,
} from "./printer_core/dashboard_material_accounting_contract.js";
import {
  initIdb,
  isIdbAvailable,
  getIdbCache,
  queueSharedWrite,
  queueMachineWrite,
  flushIdb,
  exportAllIdb,
  importAllIdb,
  compareAndSwapSharedValue,
  setIdbDbName
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

/** SpoolMount production commit直列化用mutex */
let _spoolMountCommitMutex = Promise.resolve();
/** PrintBinding shadow commit直列化用mutex */
let _printBindingCommitMutex = Promise.resolve();

/**
 * Universal MaterialSource移行dry-run journalを現在のmonitorDataへ安全にマージする。
 *
 * 【詳細説明】
 * - journalはGate 18.9B時点ではdry-run evidenceであり、本番MaterialSource/SpoolMountへ投影しない。
 * - 既存journalと復元/importされたjournalをmigrationId単位でマージし、同一migrationIdでchecksumが違う
 *   entryは破棄せずretainedUnsupportedEntriesへ隔離する。
 * - eventsはmigrationIdが有効なentryだけを保持し、同一eventIdは重複登録しない。
 *
 * @private
 * @function _mergeMaterialAccountingMigrationJournal
 * @param {Object|null|undefined} incomingJournal - 復元またはimportされたjournal候補。
 * @returns {boolean} 有効なjournal候補を処理した場合はtrue。
 */
function _mergeMaterialAccountingMigrationJournal(incomingJournal) {
  if (!incomingJournal || typeof incomingJournal !== "object" || Array.isArray(incomingJournal)) {
    return false;
  }

  const currentJournal = normalizeStoredMaterialAccountingMigrationJournal(
    monitorData.materialAccountingMigrationJournal
  );
  const restoredJournal = normalizeStoredMaterialAccountingMigrationJournal(incomingJournal);
  const mergedByMigrationId = { ...currentJournal.byMigrationId };
  const retainedUnsupportedEntries = [
    ...(currentJournal.retainedUnsupportedEntries || []),
    ...(restoredJournal.retainedUnsupportedEntries || []),
  ];

  for (const [migrationId, entry] of Object.entries(restoredJournal.byMigrationId || {})) {
    const existing = mergedByMigrationId[migrationId];
    if (!existing) {
      mergedByMigrationId[migrationId] = entry;
      continue;
    }
    if (existing.sourceChecksum !== entry.sourceChecksum) {
      retainedUnsupportedEntries.push({
        migrationId,
        reason: "migration-journal-plan-conflict",
        currentSourceChecksum: existing.sourceChecksum,
        incomingSourceChecksum: entry.sourceChecksum,
      });
    }
  }

  const validMigrationIds = new Set(Object.keys(mergedByMigrationId));
  const mergedEvents = [];
  const seenEventIds = new Set();
  for (const event of [
    ...(currentJournal.events || []),
    ...(restoredJournal.events || []),
  ]) {
    if (!event || typeof event !== "object") continue;
    if (!validMigrationIds.has(event.migrationId)) continue;
    const eventId = event.eventId || `${event.type}:${event.migrationId}:${event.recordedAt || ""}`;
    if (seenEventIds.has(eventId)) continue;
    seenEventIds.add(eventId);
    mergedEvents.push(event);
  }

  const latestMigrationId = validMigrationIds.has(restoredJournal.latestMigrationId)
    ? restoredJournal.latestMigrationId
    : (validMigrationIds.has(currentJournal.latestMigrationId)
      ? currentJournal.latestMigrationId
      : (mergedEvents[mergedEvents.length - 1]?.migrationId || null));

  monitorData.materialAccountingMigrationJournal = normalizeStoredMaterialAccountingMigrationJournal({
    schemaVersion: 1,
    authority: "migration-dry-run-journal",
    latestMigrationId,
    byMigrationId: mergedByMigrationId,
    events: mergedEvents,
    retainedUnsupportedEntries,
    invariants: {
      activateUniversalWrites: false,
      materialSourceRepositoryWrites: false,
      spoolMountRepositoryWrites: false,
      migrationJournalIsEvidenceOnly: true,
    },
  });

  return true;
}

/**
 * Universal MaterialSource移行shadow commit storeを現在のmonitorDataへ安全にマージする。
 *
 * 【詳細説明】
 * - shadow commit storeはGate 18.9D-2のdurable shadow evidenceであり、legacy hostSpoolMapや
 *   使用量ledgerへ自動投影しない。
 * - import/restore時は正規化されたstoreだけを保持し、壊れた未知shapeをauthorityとして扱わない。
 * - 既存storeとincoming storeが両方ある場合は、commit event数が多い方を採用する。完全な双方向
 *   merge/CASは後続のpersistent adapterで扱うため、ここでは復元時の単純な情報喪失を避ける。
 *
 * @private
 * @function _mergeMaterialAccountingMigrationShadowStore
 * @param {Object|null|undefined} incomingStore - 復元またはimportされたshadow commit store候補。
 * @returns {boolean} 有効なstore候補を処理した場合はtrue。
 */
function _mergeMaterialAccountingMigrationShadowStore(incomingStore) {
  if (!incomingStore || typeof incomingStore !== "object" || Array.isArray(incomingStore)) {
    return false;
  }
  const currentStore = normalizeStoredMaterialAccountingMigrationShadowCommitStore(
    monitorData.materialAccountingMigrationShadowStore
  );
  const restoredStore = normalizeStoredMaterialAccountingMigrationShadowCommitStore(incomingStore);
  monitorData.materialAccountingMigrationShadowStore =
    (restoredStore.events || []).length >= (currentStore.events || []).length
      ? restoredStore
      : currentStore;
  return true;
}

/**
 * MaterialSource print binding shadow storeを現在のmonitorDataへ安全にマージする。
 *
 * 【詳細説明】
 * - print binding storeはGate 18.9E時点ではsource-aware attribution evidenceであり、
 *   legacy usageHistoryやspool残量へ自動投影しない。
 * - 既存storeとincoming storeが両方ある場合はledger event数が多い方を採用し、復元時の単純な情報喪失を避ける。
 *
 * @private
 * @function _mergeMaterialAccountingPrintBindingStore
 * @param {Object|null|undefined} incomingStore - 復元またはimportされたprint binding store候補。
 * @returns {boolean} 有効なstore候補を処理した場合はtrue。
 */
function _mergeMaterialAccountingPrintBindingStore(incomingStore) {
  if (!incomingStore || typeof incomingStore !== "object" || Array.isArray(incomingStore)) {
    return false;
  }
  const currentStore = normalizeStoredMaterialAccountingPrintBindingStore(
    monitorData.materialAccountingPrintBindingStore
  );
  monitorData.materialAccountingPrintBindingStore =
    _createMergedMaterialAccountingPrintBindingStoreTarget(currentStore, incomingStore);
  return true;
}

/**
 * PrintBinding storeが空かどうかを判定する。
 *
 * @private
 * @function _isEmptyMaterialAccountingPrintBindingStore
 * @param {Object} store - 正規化済みPrintBinding store。
 * @returns {boolean} authority recordを含まない場合true。
 */
function _isEmptyMaterialAccountingPrintBindingStore(store) {
  return (store.printStartSnapshots || []).length === 0 &&
    (store.usageEvidence || []).length === 0 &&
    (store.jobMaterialSegments || []).length === 0 &&
    (store.ledgerEvents || []).length === 0 &&
    (store.unattributedUsage || []).length === 0 &&
    (store.retainedUnsupportedEntries || []).length === 0;
}

/**
 * 2つのJSON互換recordが同一か判定する。
 *
 * @private
 * @function _isSameJsonRecord
 * @param {*} left - 比較対象。
 * @param {*} right - 比較対象。
 * @returns {boolean} stable JSONとして一致する場合true。
 */
function _isSameJsonRecord(left, right) {
  return stableStringifyPrinterCoreV3Value(left) === stableStringifyPrinterCoreV3Value(right);
}

/**
 * storage merge用にJSON互換値をcloneする。
 *
 * @private
 * @function _cloneStorageJsonValue
 * @param {*} value - clone対象。
 * @returns {*} clone済み値。
 */
function _cloneStorageJsonValue(value) {
  if (value === null || value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * ID付きPrintBinding record配列を衝突隔離しながらmergeする。
 *
 * @private
 * @function _mergePrintBindingRecordArrayById
 * @param {Object[]} currentRecords - 現在record配列。
 * @param {Object[]} incomingRecords - incoming record配列。
 * @param {string} idKey - record ID key。
 * @param {string} recordType - 隔離記録用record type。
 * @param {Object[]} retainedUnsupportedEntries - 隔離entry配列。
 * @returns {Object[]} merge済みrecord配列。
 */
function _mergePrintBindingRecordArrayById(currentRecords, incomingRecords, idKey, recordType, retainedUnsupportedEntries) {
  const merged = Array.isArray(currentRecords) ? currentRecords.map((record) => _cloneStorageJsonValue(record)) : [];
  const byId = new Map();
  for (const record of merged) {
    const id = String(record?.[idKey] || "").trim();
    if (id) {
      byId.set(id, record);
    }
  }
  for (const incomingRecord of Array.isArray(incomingRecords) ? incomingRecords : []) {
    const id = String(incomingRecord?.[idKey] || "").trim();
    if (!id) {
      continue;
    }
    const existing = byId.get(id);
    if (!existing) {
      const clonedRecord = _cloneStorageJsonValue(incomingRecord);
      merged.push(clonedRecord);
      byId.set(id, clonedRecord);
      continue;
    }
    if (!_isSameJsonRecord(existing, incomingRecord)) {
      retainedUnsupportedEntries.push({
        recordType,
        index: id,
        reason: "print-binding-record-id-conflict",
        currentDigest: createPrinterCoreV3DeterministicId("print-binding-current-record", [
          stableStringifyPrinterCoreV3Value(existing),
        ]),
        incomingDigest: createPrinterCoreV3DeterministicId("print-binding-incoming-record", [
          stableStringifyPrinterCoreV3Value(incomingRecord),
        ]),
        record: _cloneStorageJsonValue(incomingRecord),
      });
    }
  }
  return merged;
}

/**
 * IDを持たない未帰属使用量recordを重複排除しながらmergeする。
 *
 * @private
 * @function _mergePrintBindingUnattributedUsage
 * @param {Object[]} currentRecords - 現在record配列。
 * @param {Object[]} incomingRecords - incoming record配列。
 * @returns {Object[]} merge済みrecord配列。
 */
function _mergePrintBindingUnattributedUsage(currentRecords, incomingRecords) {
  const merged = Array.isArray(currentRecords) ? currentRecords.map((record) => _cloneStorageJsonValue(record)) : [];
  const fingerprints = new Set(merged.map((record) => stableStringifyPrinterCoreV3Value(record)));
  for (const incomingRecord of Array.isArray(incomingRecords) ? incomingRecords : []) {
    const fingerprint = stableStringifyPrinterCoreV3Value(incomingRecord);
    if (fingerprints.has(fingerprint)) {
      continue;
    }
    fingerprints.add(fingerprint);
    merged.push(_cloneStorageJsonValue(incomingRecord));
  }
  return merged;
}

/**
 * 現在storeとincoming storeからPrintBinding import/restore後の候補storeを作成する。
 *
 * 【詳細説明】
 * - empty restoreは保存済みstoreをそのまま採用する。
 * - 既存storeとincoming storeの両方にrecordがある場合、semantic ID単位で同一recordをdedupeし、
 *   同一IDかつ内容が異なるrecordは勝者を作らずretainedUnsupportedEntriesへ隔離する。
 * - import時はこの候補storeをIndexedDB CASへ渡し、CAS成功後だけruntimeへ反映する。
 *
 * @private
 * @function _createMergedMaterialAccountingPrintBindingStoreTarget
 * @param {Object} currentStore - 現在の正規化済みPrintBinding store。
 * @param {Object|null|undefined} incomingStore - import/restore候補store。
 * @returns {Object} merge候補store。
 */
function _createMergedMaterialAccountingPrintBindingStoreTarget(currentStore, incomingStore) {
  const normalizedCurrentStore = normalizeStoredMaterialAccountingPrintBindingStore(currentStore);
  const restoredStore = normalizeStoredMaterialAccountingPrintBindingStore(incomingStore);
  const currentDigest = createMaterialAccountingPrintBindingStoreDigest(normalizedCurrentStore);
  const restoredDigest = createMaterialAccountingPrintBindingStoreDigest(restoredStore);
  if (_isEmptyMaterialAccountingPrintBindingStore(normalizedCurrentStore) || currentDigest === restoredDigest) {
    return restoredStore;
  }
  const retainedUnsupportedEntries = [
    ...(normalizedCurrentStore.retainedUnsupportedEntries || []).map((entry) => _cloneStorageJsonValue(entry)),
    ...(restoredStore.retainedUnsupportedEntries || []).map((entry) => _cloneStorageJsonValue(entry)),
  ];
  return normalizeStoredMaterialAccountingPrintBindingStore({
    ...normalizedCurrentStore,
    printStartSnapshots: _mergePrintBindingRecordArrayById(
      normalizedCurrentStore.printStartSnapshots,
      restoredStore.printStartSnapshots,
      "snapshotId",
      "printStartSnapshot",
      retainedUnsupportedEntries,
    ),
    usageEvidence: _mergePrintBindingRecordArrayById(
      normalizedCurrentStore.usageEvidence,
      restoredStore.usageEvidence,
      "evidenceId",
      "usageEvidence",
      retainedUnsupportedEntries,
    ),
    jobMaterialSegments: _mergePrintBindingRecordArrayById(
      normalizedCurrentStore.jobMaterialSegments,
      restoredStore.jobMaterialSegments,
      "segmentId",
      "jobMaterialSegment",
      retainedUnsupportedEntries,
    ),
    ledgerEvents: _mergePrintBindingRecordArrayById(
      normalizedCurrentStore.ledgerEvents,
      restoredStore.ledgerEvents,
      "ledgerEventId",
      "ledgerEvent",
      retainedUnsupportedEntries,
    ),
    unattributedUsage: _mergePrintBindingUnattributedUsage(
      normalizedCurrentStore.unattributedUsage,
      restoredStore.unattributedUsage,
    ),
    operationsById: {},
    retainedUnsupportedEntries,
  });
}

/**
 * 現在のlegacy/managed spool backendとSpoolMount storeのactive mountを照合する。
 *
 * 【詳細説明】
 * - restore/importではUniversal SpoolMount storeをlegacy hostSpoolMapへ投影しない。
 * - その代わり、同じmanaged spoolがlegacy hostSpoolMapで既に装着中ならUniversal側をactive authorityから隔離する。
 * - 管理spoolが存在しない、または削除済みの場合もactiveに戻さず、後続UIで人間が修復できる証跡として保持する。
 *
 * @private
 * @function _reconcileSpoolMountStoreWithCurrentBackends
 * @param {Object} store - 正規化対象SpoolMount store。
 * @returns {Object} backend整合性を反映した正規化済みstore。
 */
function _reconcileSpoolMountStoreWithCurrentBackends(store) {
  return reconcileCurrentOpenUniversalSpoolMountsAgainstBackends({
    store,
    managedSpools: monitorData.filamentSpools,
    hostSpoolMap: monitorData.hostSpoolMap,
  });
}

/**
 * reconcile済みSpoolMount storeをCAS保護shared keyへ書き戻す。
 *
 * 【詳細説明】
 * - operator-managed SpoolMount storeは通常flush対象外なので、restore/import後にreconcileで
 *   active authorityが変わった場合だけ専用CASでIndexedDBへ反映する。
 * - CAS mismatch時は値を書き換えず、次回operator操作もfail-closedするため、古い値でsilent overwriteしない。
 *
 * @private
 * @function _persistReconciledMaterialAccountingSpoolMountStoreIfChanged
 * @param {Object} previousStore - reconcile前の正規化候補store。
 * @param {Object} nextStore - reconcile後の正規化候補store。
 * @returns {Promise<Object|null>} CAS実行結果。変更なしまたはIndexedDB不可ならnull。
 */
async function _persistReconciledMaterialAccountingSpoolMountStoreIfChanged(previousStore, nextStore) {
  const normalizedPrevious = normalizeStoredMaterialAccountingSpoolMountStore(previousStore);
  const normalizedNext = normalizeStoredMaterialAccountingSpoolMountStore(nextStore);
  const previousDigest = createMaterialAccountingSpoolMountStoreDigest(normalizedPrevious);
  const nextDigest = createMaterialAccountingSpoolMountStoreDigest(normalizedNext);
  if (previousDigest === nextDigest || !_idbInitialized || !isIdbAvailable()) {
    return null;
  }
  return compareAndSwapSharedValue({
    key: "materialAccountingSpoolMountStore",
    expectedDigest: previousDigest,
    createDigest: createMaterialAccountingSpoolMountStoreDigest,
    nextValue: normalizedNext,
  });
}

/**
 * monitorData上の現在Universal SpoolMount authorityをbackend状態へ再照合し、必要ならCAS保護storeへ反映する。
 *
 * 【詳細説明】
 * - SpoolMount storeは通常flushから除外されるため、restore/import後の隔離結果は専用CASで書き戻す。
 * - importでは呼び出し元がawaitし、restoreでは起動を止めずに非同期で書き戻す。書き戻し完了前の
 *   operator操作はCAS mismatchでfail-closedする。
 *
 * @private
 * @function _reconcileCurrentMaterialAccountingSpoolMountStoreWithCurrentBackends
 * @param {Object=} options - 照合オプション。
 * @param {boolean=} options.awaitDurable - CAS保護storeへの反映完了を待つ場合true。
 * @returns {Promise<Object|null>|null} durable書き戻し結果、または非同期書き戻しを待たない場合null。
 */
function _reconcileCurrentMaterialAccountingSpoolMountStoreWithCurrentBackends(options = {}) {
  const previousStore = normalizeStoredMaterialAccountingSpoolMountStore(
    monitorData.materialAccountingSpoolMountStore
  );
  const reconciledStore = _reconcileSpoolMountStoreWithCurrentBackends(previousStore);
  monitorData.materialAccountingSpoolMountStore = reconciledStore;
  const persistPromise = _persistReconciledMaterialAccountingSpoolMountStoreIfChanged(previousStore, reconciledStore)
    .catch((error) => {
      console.warn("[SpoolMount reconcile] CAS保護storeへの書き戻しに失敗:", error?.message || error);
      return {
        ok: false,
        casApplied: false,
        backend: "indexedDB",
        key: "materialAccountingSpoolMountStore",
        reason: "reconcile-persist-threw",
        error: error?.message || String(error),
      };
    });
  if (options.awaitDurable === true) {
    return persistPromise;
  }
  persistPromise.then((result) => {
    if (result && result.ok !== true) {
      console.warn("[SpoolMount reconcile] CAS保護storeへの書き戻しが未適用:", result.reason || result.error || result);
    }
  });
  return null;
}

/**
 * legacy hostSpoolMapのimport/restore割当をUniversal SpoolMount authorityに対して検査する。
 *
 * 【詳細説明】
 * - import/restoreはlegacy `hostSpoolMap`を直接増やし得るため、通常UIの
 *   `setCurrentSpoolId()` と同じくUniversal `OPEN` mount / in-flight reservationを尊重する。
 * - まだCASで確定していないincoming Universal storeはここではlegacy割当を奪うauthorityにしない。
 *
 * @private
 * @function _canImportLegacyHostSpoolAssignment
 * @param {Object} input - 検査入力。
 * @param {string} input.host - legacy host名。
 * @param {string|null|undefined} input.spoolId - import/restoreされるspool ID。
 * @param {Set<string>} input.validSpoolIds - 現在有効なmanaged spool ID集合。
 * @param {string} input.contextLabel - ログ用context名。
 * @returns {boolean} hostSpoolMapへ取り込んでよい場合はtrue。
 */
function _canImportLegacyHostSpoolAssignment(input = {}) {
  const host = String(input.host || "").trim();
  const spoolId = String(input.spoolId || "").trim();
  const validSpoolIds = input.validSpoolIds instanceof Set ? input.validSpoolIds : new Set();
  const contextLabel = String(input.contextLabel || "storage").trim();
  if (!spoolId) {
    return true;
  }
  if (!validSpoolIds.has(spoolId)) {
    console.warn(`[${contextLabel}] hostSpoolMap["${host}"]: スプール "${spoolId}" が存在しないためスキップ`);
    return false;
  }
  const currentConflict = findUniversalSpoolAssignmentConflict({
    spoolId,
    store: monitorData.materialAccountingSpoolMountStore,
  });
  const conflict = currentConflict;
  if (conflict) {
    console.warn(
      `[${contextLabel}] hostSpoolMap["${host}"]: スプール "${spoolId}" はUniversal MaterialSourceで` +
      `装着中または予約中のためlegacy割当をスキップします (${conflict.reason || conflict.type || "conflict"})`
    );
    return false;
  }
  return true;
}

/**
 * operator-managed SpoolMount production storeを現在のmonitorDataへ安全にマージする。
 *
 * 【詳細説明】
 * - このstoreはGate 18.9Hで初めてproduction authorityになるが、restore/import時に
 *   legacy `hostSpoolMap`、`usageHistory`、管理スプール残量、print binding storeへ投影しない。
 * - 起動時の空storeへ保存済みstoreを復元する場合は正規化済みstoreをそのまま採用する。
 * - 既に別の非空storeが存在する状態で異なるstoreをimportした場合はfirst-winせず、
 *   incoming store全体をretainedUnsupportedEntriesへ隔離して既存authorityを維持する。
 *
 * @private
 * @function _mergeMaterialAccountingSpoolMountStore
 * @param {Object|null|undefined} incomingStore - 復元またはimportされたSpoolMount store候補。
 * @returns {boolean} 有効なstore候補を処理した場合はtrue。
 */
function _mergeMaterialAccountingSpoolMountStore(incomingStore) {
  if (!incomingStore || typeof incomingStore !== "object" || Array.isArray(incomingStore)) {
    return false;
  }
  const currentStore = normalizeStoredMaterialAccountingSpoolMountStore(
    monitorData.materialAccountingSpoolMountStore
  );
  monitorData.materialAccountingSpoolMountStore = _createMergedMaterialAccountingSpoolMountStoreTarget(
    currentStore,
    incomingStore,
  );
  return true;
}

/**
 * 現在storeとincoming storeからSpoolMount import/restore後の候補storeを作成する。
 *
 * 【詳細説明】
 * - このhelperはmonitorDataを直接更新しない。
 * - import時は、この候補storeをIndexedDB CASへ渡し、CAS成功後だけruntimeへ反映する。
 * - restore時は既存動作どおり候補をruntimeへ反映し、その後にbest-effort CASでshared keyへ戻す。
 *
 * @private
 * @function _createMergedMaterialAccountingSpoolMountStoreTarget
 * @param {Object} currentStore - 現在の正規化済みSpoolMount store。
 * @param {Object|null|undefined} incomingStore - import/restore候補store。
 * @returns {Object} merge候補store。
 */
function _createMergedMaterialAccountingSpoolMountStoreTarget(currentStore, incomingStore) {
  const normalizedCurrentStore = normalizeStoredMaterialAccountingSpoolMountStore(currentStore);
  const restoredStore = _reconcileSpoolMountStoreWithCurrentBackends(incomingStore);
  const currentDigest = createMaterialAccountingSpoolMountStoreDigest(normalizedCurrentStore);
  const restoredDigest = createMaterialAccountingSpoolMountStoreDigest(restoredStore);
  const currentIsEmpty = (normalizedCurrentStore.spoolMounts || []).length === 0
    && (normalizedCurrentStore.events || []).length === 0
    && (normalizedCurrentStore.conflicts || []).length === 0
    && (normalizedCurrentStore.retainedUnsupportedEntries || []).length === 0;

  if (currentIsEmpty || currentDigest === restoredDigest) {
    return restoredStore;
  }

  return normalizeStoredMaterialAccountingSpoolMountStore({
    ...normalizedCurrentStore,
    conflicts: [
      ...(normalizedCurrentStore.conflicts || []),
      {
        type: "spool-mount-store-import-conflict",
        reason: "divergent-non-empty-spool-mount-store",
        currentDigest,
        incomingDigest: restoredDigest,
      },
    ],
    retainedUnsupportedEntries: [
      ...(normalizedCurrentStore.retainedUnsupportedEntries || []),
      {
        kind: "spoolMountStore",
        reason: "divergent-non-empty-spool-mount-store",
        record: restoredStore,
      },
    ],
  });
}

/**
 * importされたSpoolMount production storeをCAS成功後だけruntimeへ反映する。
 *
 * 【詳細説明】
 * - import payloadは外部入力であり、incoming Universal `OPEN` mountだけでlegacy割当を黙って破棄しない。
 * - 現在runtime storeをbase `C`、incomingをmergeした結果をtarget `R`として構築し、
 *   IndexedDB shared keyがまだ`C`であることをCASで確認できた場合だけ`monitorData`へ反映する。
 * - IndexedDB CASが使えない環境ではsuccess扱いせず、既存runtime storeを維持する。
 *
 * @private
 * @function _importMaterialAccountingSpoolMountStoreDurably
 * @param {Object|null|undefined} incomingStore - import候補SpoolMount store。
 * @returns {Promise<Object|null>} CAS結果、または処理対象外ならnull。
 */
async function _importMaterialAccountingSpoolMountStoreDurably(incomingStore) {
  if (!incomingStore || typeof incomingStore !== "object" || Array.isArray(incomingStore)) {
    return null;
  }
  const baseStore = normalizeStoredMaterialAccountingSpoolMountStore(
    monitorData.materialAccountingSpoolMountStore
  );
  const targetStore = _createMergedMaterialAccountingSpoolMountStoreTarget(baseStore, incomingStore);
  const baseDigest = createMaterialAccountingSpoolMountStoreDigest(baseStore);
  const targetDigest = createMaterialAccountingSpoolMountStoreDigest(targetStore);
  if (baseDigest === targetDigest) {
    monitorData.materialAccountingSpoolMountStore = targetStore;
    return { ok: true, casApplied: false, backend: "indexedDB", key: "materialAccountingSpoolMountStore", reason: "unchanged" };
  }
  if (!_idbInitialized || !isIdbAvailable()) {
    console.warn("[importAllData] SpoolMount store import skipped: IndexedDB CAS is unavailable.");
    return {
      ok: false,
      casApplied: false,
      backend: "indexedDB",
      key: "materialAccountingSpoolMountStore",
      reason: "production-cas-unavailable",
    };
  }
  const result = await compareAndSwapSharedValue({
    key: "materialAccountingSpoolMountStore",
    expectedDigest: baseDigest,
    createDigest: createMaterialAccountingSpoolMountStoreDigest,
    nextValue: targetStore,
  });
  if (result?.ok === true && result.casApplied === true) {
    monitorData.materialAccountingSpoolMountStore = targetStore;
    return result;
  }
  console.warn(
    `[importAllData] SpoolMount store import CASが未適用: ${result?.reason || result?.error || "unknown"}`
  );
  return result || { ok: false, casApplied: false, backend: "indexedDB", key: "materialAccountingSpoolMountStore", reason: "durable-cas-not-applied" };
}

/**
 * 物理コマンド復旧ラッチstoreを現在のmonitorDataへ安全にマージする。
 *
 * 【詳細説明】
 * - 復旧ラッチはGate 19 production command activation前の安全装置であり、submitted/post-observed/unknownの
 *   未解決証跡だけを保持する。
 * - 復元/import時もcommand frameやRPC payloadは保存せず、自動再送は行わない。
 * - 同一commandIdで異なるdigestが来た場合は勝者を作らず、両recordを隔離して人間確認へ回す。
 *
 * @private
 * @function _mergePhysicalCommandRecoveryLatchStore
 * @param {Object|null|undefined} incomingStore - 復元またはimportされた復旧ラッチstore候補。
 * @returns {boolean} 有効なstore候補を処理した場合はtrue。
 */
function _mergePhysicalCommandRecoveryLatchStore(incomingStore) {
  if (!incomingStore || typeof incomingStore !== "object" || Array.isArray(incomingStore)) {
    return false;
  }
  const currentStore = normalizeStoredPhysicalCommandRecoveryLatchStore(
    monitorData.physicalCommandRecoveryLatch
  );
  const restoredStore = normalizeStoredPhysicalCommandRecoveryLatchStore(incomingStore);
  const unresolvedByCommandId = { ...currentStore.unresolvedByCommandId };
  const conflictedCommandIds = new Set([
    ...(currentStore.conflictedCommandIds || []),
    ...(restoredStore.conflictedCommandIds || []),
  ]);
  const retainedUnsupportedEntries = [
    ...(currentStore.retainedUnsupportedEntries || []),
    ...(restoredStore.retainedUnsupportedEntries || []),
  ];

  for (const [commandId, record] of Object.entries(restoredStore.unresolvedByCommandId || {})) {
    const existing = unresolvedByCommandId[commandId];
    if (!existing) {
      unresolvedByCommandId[commandId] = record;
      continue;
    }
    if (existing.digest !== record.digest) {
      delete unresolvedByCommandId[commandId];
      conflictedCommandIds.add(commandId);
      retainedUnsupportedEntries.push({
        commandId,
        reason: "command-id-digest-conflict",
        conflictedDigest: existing.digest,
        status: existing.status,
      });
      retainedUnsupportedEntries.push({
        commandId,
        reason: "command-id-digest-conflict",
        conflictedDigest: record.digest,
        status: record.status,
      });
    }
  }

  const events = [];
  const seenEventIds = new Set();
  for (const event of [
    ...(currentStore.events || []),
    ...(restoredStore.events || []),
  ]) {
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const eventId = event.eventId || `${event.type || "event"}:${event.commandId || ""}:${event.recordedAt || event.resolvedAt || ""}`;
    if (seenEventIds.has(eventId)) continue;
    seenEventIds.add(eventId);
    events.push(event);
  }

  monitorData.physicalCommandRecoveryLatch = normalizeStoredPhysicalCommandRecoveryLatchStore({
    schemaVersion: 1,
    authority: "physical-command-recovery-latch",
    unresolvedByCommandId,
    conflictedCommandIds: [...conflictedCommandIds].sort(),
    events,
    retainedUnsupportedEntries,
    invariants: {
      autoReplay: false,
      commandFramePersistence: false,
      physicalCommandAuthority: "recovery-latch-only",
    },
  });
  return true;
}

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
      // ★ v2.2.0: 旧 STORAGE_KEY フォールバックは削除
      data = {};
    }
  }

  // Gate 18.9H/I のCAS保護storeは通常flush queueへ載せないため、旧データや未操作環境では
  // IndexedDB shared keyとしてまだ存在しない場合がある。exportはread-only可視化なので、
  // 永続storeへ書き込まず、現在runtimeが保持する正規化済み空storeをJSONへ補完する。
  if (!data.materialAccountingPrintBindingStore || typeof data.materialAccountingPrintBindingStore !== "object") {
    data.materialAccountingPrintBindingStore = normalizeStoredMaterialAccountingPrintBindingStore(
      monitorData.materialAccountingPrintBindingStore
    );
  }
  if (!data.materialAccountingSpoolMountStore || typeof data.materialAccountingSpoolMountStore !== "object") {
    data.materialAccountingSpoolMountStore = normalizeStoredMaterialAccountingSpoolMountStore(
      monitorData.materialAccountingSpoolMountStore
    );
  }

  // パネルレイアウトをエクスポートデータに含める
  try {
    const { getCurrentLayoutData } = await import("./dashboard_panel_factory.js");
    const layout = getCurrentLayoutData();
    if (layout) data.panelLayout = layout;
  } catch { /* パネルモジュール未初期化でも続行 */ }

  // ★ v2.2.0: エクスポートメタデータ
  data._exportVersion = "2.20";
  data._exportDate = new Date().toISOString();

  return data;
}

/**
 * JSON オブジェクトから全データをマージインポートする（UI 用）。
 *
 * 既存データを削除せず、インポートデータの新規分のみ追加する。
 * 同一IDのデータが存在する場合は新しい方を採用する。
 *
 * @param {Object} data - インポートするデータ
 * @returns {{ spools: number, history: number, presets: number, inventory: number, machines: number, panels: number, observations: number }}
 *          各カテゴリの追加件数
 */
export async function importAllData(data) {
  const stats = { spools: 0, history: 0, presets: 0, inventory: 0, machines: 0, panels: 0, observations: 0 };

  // ── スプール: id ベースでマージ ──
  if (Array.isArray(data.filamentSpools)) {
    const existingIds = new Set(monitorData.filamentSpools.map(s => s.id));
    for (const sp of data.filamentSpools) {
      if (!sp.id) continue;
      if (existingIds.has(sp.id)) {
        // ★ C3: 既存スプール — updatedAt 時系列判定でマージ（Math.min 廃止）
        const existing = monitorData.filamentSpools.find(s => s.id === sp.id);
        if (existing) {
          const prevRemain = existing.remainingLengthMm;
          const prevUpdatedAt = existing.updatedAt ?? 0;
          const prevActive = existing.isActive;
          const prevInUse = existing.isInUse;
          const prevHostname = existing.hostname;
          Object.assign(existing, sp);
          // ★ remainingLengthMm は updatedAt で判定（新しい方が勝つ）
          const importRemain = existing.remainingLengthMm;
          const importTime = existing.updatedAt ?? 0;
          const prevValid = Number.isFinite(prevRemain);
          const importValid = Number.isFinite(importRemain);
          if (prevValid && importValid) {
            if (prevUpdatedAt >= importTime) {
              existing.remainingLengthMm = prevRemain;
              existing.updatedAt = prevUpdatedAt;
            }
            // else: import の方が新しい → import 値を維持（Object.assign 済み）
          } else if (prevValid) {
            existing.remainingLengthMm = prevRemain;
            existing.updatedAt = prevUpdatedAt;
          }
          // ★ 装着状態はランタイム値を優先
          existing.isActive = prevActive || existing.isActive;
          existing.isInUse = prevInUse || existing.isInUse;
          existing.hostname = prevHostname || existing.hostname;
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
    // ★ レビュー指摘#4: 一括インポートは中間レコードの順序/内容を変え得る（件数＋末尾署名では
    //   捕捉しきれない）。rev を加算してリレーの変更検出を確実にする。
    monitorData.usageHistoryRev = (monitorData.usageHistoryRev || 0) + 1;
  }

  // ── ADR-0004 mountHistory: 装着履歴を (opId||evId) ベースで重複排除追加 ──
  //   ★ P1-1(レビュー): 同一操作が再送で別 evId(UUID) になっても opId で1件に畳む。
  if (Array.isArray(data.mountHistory)) {
    if (!Array.isArray(monitorData.mountHistory)) monitorData.mountHistory = [];
    const existingIds = new Set(monitorData.mountHistory.map(e => e?.opId || e?.evId));
    for (const ev of data.mountHistory) {
      const key = ev?.opId || ev?.evId;
      if (ev && key != null && !existingIds.has(key)) {
        monitorData.mountHistory.push(ev);
        existingIds.add(key);
      }
    }
    monitorData.mountHistory.sort((a, b) => (Number(a?.ts) || 0) - (Number(b?.ts) || 0));
  }

  // ── ★ P0-1(レビュー): mountHistorySeq(watermark) を最大値へ引き上げ（後退させない） ──
  if (data.mountHistorySeq != null) {
    monitorData.mountHistorySeq = Math.max(
      Number(monitorData.mountHistorySeq) || 0, Number(data.mountHistorySeq) || 0
    );
  }

  // ── ★ P0-1: pendingUnattributedUsage を pendingUsageId(無ければ completionFingerprint)で
  //   重複排除しつつ追加。再起動/再import後も未帰属消費と未確認バッジ・通知集合が失われない。──
  if (Array.isArray(data.pendingUnattributedUsage)) {
    if (!Array.isArray(monitorData.pendingUnattributedUsage)) monitorData.pendingUnattributedUsage = [];
    const seen = new Set(
      monitorData.pendingUnattributedUsage.map(e => e?.pendingUsageId ?? e?.completionFingerprint)
    );
    for (const r of data.pendingUnattributedUsage) {
      const key = r?.pendingUsageId ?? r?.completionFingerprint;
      if (r && key != null && !seen.has(key)) {
        monitorData.pendingUnattributedUsage.push(r);
        seen.add(key);
      }
    }
  }

  // ── ★ P0-1: 隔離アーカイブ（per-host 集約）は未保持ホストのみ取り込む（二重集計回避） ──
  if (data.pendingUnattributedUsageArchive && typeof data.pendingUnattributedUsageArchive === "object") {
    if (!monitorData.pendingUnattributedUsageArchive
        || typeof monitorData.pendingUnattributedUsageArchive !== "object") {
      monitorData.pendingUnattributedUsageArchive = {};
    }
    for (const [h, a] of Object.entries(data.pendingUnattributedUsageArchive)) {
      if (a && !monitorData.pendingUnattributedUsageArchive[h]) {
        monitorData.pendingUnattributedUsageArchive[h] = { ...a };
      }
    }
  }

  // ── ★ #412-O4: inferredCandidateStore は candidateHash 単位でマージ ──
  //   同一 window/candidate の二重処理を避け、既存候補と import 候補が衝突した場合は
  //   updatedAt が新しい方を採用する。削除ではなく状態遷移で監査する前提のため、未知状態も保持する。
  if (data.inferredCandidateStore && typeof data.inferredCandidateStore === "object") {
    if (!monitorData.inferredCandidateStore || typeof monitorData.inferredCandidateStore !== "object") {
      monitorData.inferredCandidateStore = {};
    }
    for (const [hash, value] of Object.entries(data.inferredCandidateStore)) {
      if (!value || typeof value !== "object") continue;
      const current = monitorData.inferredCandidateStore[hash];
      if (!current || (Number(value.updatedAt) || 0) >= (Number(current.updatedAt) || 0)) {
        monitorData.inferredCandidateStore[hash] = { ...value };
      }
    }
  }

  // ── ★ #420/O6A: O5 recovery flag と recovery 操作 audit event をインポート ──
  //   recovery flag は未解決 blocker なので、既存より新しい createdAt を持つ場合だけ採用する。
  if (Object.prototype.hasOwnProperty.call(data, "inferredDecisionRecoveryRequired")) {
    const incoming = data.inferredDecisionRecoveryRequired;
    if (incoming && typeof incoming === "object") {
      const current = monitorData.inferredDecisionRecoveryRequired;
      if (!current || (Number(incoming.createdAt) || 0) >= (Number(current.createdAt) || 0)) {
        monitorData.inferredDecisionRecoveryRequired = { ...incoming };
      }
    } else if (!monitorData.inferredDecisionRecoveryRequired) {
      monitorData.inferredDecisionRecoveryRequired = null;
    }
  }
  if (Object.prototype.hasOwnProperty.call(data, "inferredRecoveryOperationRecoveryRequired")) {
    const incoming = data.inferredRecoveryOperationRecoveryRequired;
    if (incoming && typeof incoming === "object") {
      const current = monitorData.inferredRecoveryOperationRecoveryRequired;
      if (!current || (Number(incoming.createdAt) || 0) >= (Number(current.createdAt) || 0)) {
        monitorData.inferredRecoveryOperationRecoveryRequired = { ...incoming };
      }
    } else if (!monitorData.inferredRecoveryOperationRecoveryRequired) {
      monitorData.inferredRecoveryOperationRecoveryRequired = null;
    }
  }
  if (Array.isArray(data.inferredRecoveryEvents)) {
    if (!Array.isArray(monitorData.inferredRecoveryEvents)) monitorData.inferredRecoveryEvents = [];
    const seen = new Set(monitorData.inferredRecoveryEvents.map(event => event?.eventId));
    for (const event of data.inferredRecoveryEvents) {
      const key = event?.eventId;
      if (event && key != null && !seen.has(key)) {
        monitorData.inferredRecoveryEvents.push({ ...event });
        seen.add(key);
      }
    }
    monitorData.inferredRecoveryEvents.sort((a, b) => (Number(a?.createdAt) || 0) - (Number(b?.createdAt) || 0));
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

  // ── hostSpoolMap: 既存を保持、新規ホストのみ追加（参照整合性チェック付き） ──
  if (data.hostSpoolMap && typeof data.hostSpoolMap === "object") {
    const validIds = new Set(monitorData.filamentSpools.filter(s => !s.deleted && !s.isDeleted).map(s => s.id));
    for (const [host, spoolId] of Object.entries(data.hostSpoolMap)) {
      if (!(host in monitorData.hostSpoolMap)) {
        if (_canImportLegacyHostSpoolAssignment({
          host,
          spoolId,
          validSpoolIds: validIds,
          contextLabel: "importAllData",
        })) {
          monitorData.hostSpoolMap[host] = spoolId;
        }
      }
    }
  }

  // ── Gate 18.7: materialSourceObservations はread-only evidenceとしてimportする ──
  //   管理スプール装着・使用履歴・台帳へ投影せず、機器観測の最後の状態としてだけ復元する。
  if (data.materialSourceObservations && typeof data.materialSourceObservations === "object") {
    const restored = normalizeStoredMaterialSourceObservations(data.materialSourceObservations, {
      restoredAt: new Date().toISOString(),
    });
    if (!monitorData.materialSourceObservations
        || typeof monitorData.materialSourceObservations !== "object"
        || Array.isArray(monitorData.materialSourceObservations)) {
      monitorData.materialSourceObservations = { schemaVersion: 1, byDeviceId: {} };
    }
    if (!monitorData.materialSourceObservations.byDeviceId
        || typeof monitorData.materialSourceObservations.byDeviceId !== "object"
        || Array.isArray(monitorData.materialSourceObservations.byDeviceId)) {
      monitorData.materialSourceObservations.byDeviceId = {};
    }
    if (restored.retainedUnsupportedStore) {
      monitorData.materialSourceObservations.retainedUnsupportedStore = restored.retainedUnsupportedStore;
      monitorData.materialSourceObservations.migrationStatus = restored.migrationStatus;
    }
    for (const [deviceId, record] of Object.entries(restored.byDeviceId || {})) {
      const existing = monitorData.materialSourceObservations.byDeviceId[deviceId];
      const existingMs = new Date(existing?.lastObservedAt || 0).getTime();
      const incomingMs = new Date(record?.lastObservedAt || 0).getTime();
      if (!existing || !Number.isFinite(existingMs) || (Number.isFinite(incomingMs) && incomingMs >= existingMs)) {
        monitorData.materialSourceObservations.byDeviceId[deviceId] = record;
        stats.observations++;
      }
    }
    monitorData.materialSourceObservations.schemaVersion = 1;
    monitorData.materialSourceObservations.authority = "observation-only";
  }

  // ── Gate 18.9B: Universal MaterialSource移行dry-run journalをimportする ──
  //   移行計画の証跡だけを保持し、管理スプール装着・使用履歴・台帳へは投影しない。
  if (data.materialAccountingMigrationJournal && typeof data.materialAccountingMigrationJournal === "object") {
    _mergeMaterialAccountingMigrationJournal(data.materialAccountingMigrationJournal);
  }

  // ── Gate 18.9D-2: Universal MaterialSource移行shadow commit storeをimportする ──
  //   durable shadow evidenceだけを保持し、legacy装着やledger debitへは投影しない。
  if (data.materialAccountingMigrationShadowStore && typeof data.materialAccountingMigrationShadowStore === "object") {
    _mergeMaterialAccountingMigrationShadowStore(data.materialAccountingMigrationShadowStore);
  }

  // ── Gate 18.9E: print-start binding / source-aware usage shadow storeをimportする ──
  //    importしてもlegacy usageHistoryやspool残量へは投影しない。
  if (data.materialAccountingPrintBindingStore && typeof data.materialAccountingPrintBindingStore === "object") {
    await _importMaterialAccountingPrintBindingStoreDurably(data.materialAccountingPrintBindingStore);
  }

  // ── Gate 18.9H: operator-managed SpoolMount production storeをimportする ──
  //    importしてもlegacy hostSpoolMap / usageHistory / spool残量 / print bindingへは投影しない。
  if (data.materialAccountingSpoolMountStore && typeof data.materialAccountingSpoolMountStore === "object") {
    await _importMaterialAccountingSpoolMountStoreDurably(data.materialAccountingSpoolMountStore);
  }
  await _reconcileCurrentMaterialAccountingSpoolMountStoreWithCurrentBackends({ awaitDurable: true });

  // ── Gate 19 prep: 物理コマンド復旧ラッチをimportする ──
  //    submitted/post-observed/unknownの未解決証跡だけを保持し、コマンド再送・legacy ledger投影は行わない。
  if (data.physicalCommandRecoveryLatch && typeof data.physicalCommandRecoveryLatch === "object") {
    _mergePhysicalCommandRecoveryLatchStore(data.physicalCommandRecoveryLatch);
  }

  // ── machines: 印刷履歴をマージ ──
  // ★ PLACEHOLDER とIPキー（hostnameが解決済みなら不要）を除外
  if (data.machines && typeof data.machines === "object") {
    const _isIpLike = (s) => isIpLiteral(s);
    const importTargets = data.appSettings?.connectionTargets || [];
    const resolvedHosts = new Set(importTargets.filter(t => t.hostname).map(t => t.hostname));
    const resolvedIps = new Set(importTargets.filter(t => t.hostname).map(t => extractHost(t.dest)));

    for (const [host, machineData] of Object.entries(data.machines)) {
      // PLACEHOLDER は常にスキップ
      if (host === PLACEHOLDER_HOSTNAME || host === "_$_NO_MACHINE_$_") continue;
      // IPキーで同じIPのhostname解決済みエントリがあればスキップ
      if (_isIpLike(host) && resolvedIps.has(host)) continue;

      if (!monitorData.machines[host]) {
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
  // ★ ポートなしエントリ、hostname解決済みIPの重複を除外
  if (Array.isArray(data.appSettings?.connectionTargets)) {
    const existingDests = new Set(
      (monitorData.appSettings.connectionTargets || []).map(t => t.dest)
    );
    const existingIps = new Set(
      (monitorData.appSettings.connectionTargets || []).map(t => extractHost(t.dest))
    );
    for (const t of data.appSettings.connectionTargets) {
      if (!t.dest) continue;
      // ポートなしエントリはスキップ（ポート付きが既にあるか追加される）
      if (!parseDest(t.dest).hasPort) continue;
      // 同一 dest は重複スキップ
      if (existingDests.has(t.dest)) continue;
      // 同一 IP で既存エントリがあればスキップ（hostname違いのゴミ防止）
      const ip = extractHost(t.dest);
      if (existingIps.has(ip) && !t.hostname) continue;
      monitorData.appSettings.connectionTargets.push(t);
      existingDests.add(t.dest);
      existingIps.add(ip);
    }
  }
  if (data.appSettings && typeof data.appSettings === "object") {
    const importedNegativeMode = data.appSettings.negativeRemainingDisplayMode
      ?? data.appSettings.negativeRemainingDisplay
      ?? data.appSettings.filamentRemainingDisplayMode;
    if (importedNegativeMode === "clamp-zero") {
      monitorData.appSettings.negativeRemainingDisplayMode = "clamp-zero";
    } else if (
      importedNegativeMode === "show-negative"
      || importedNegativeMode === "show"
      || importedNegativeMode === "signed"
    ) {
      monitorData.appSettings.negativeRemainingDisplayMode = "show-negative";
    }
  }

  // ── パネルレイアウト: panelLayout が含まれていれば appSettings + localStorage に保存 ──
  // ★ 常にインポートデータのレイアウトを保存する（リロード後に restoreLayout で適用される）
  //    既存レイアウトがあっても上書き — ユーザーが明示的にインポートしたデータを尊重
  if (Array.isArray(data.panelLayout) && data.panelLayout.length > 0) {
    monitorData.appSettings.panelLayout = data.panelLayout;
    stats.panels = data.panelLayout.length;
    // ★ localStorage にも直接書き込む（restoreLayout が localStorage を優先するため）
    try {
      localStorage.setItem("3dpmon_panel_layout_v5", JSON.stringify(data.panelLayout));
    } catch (e) {
      console.warn("[importAllData] panelLayout の localStorage 保存に失敗:", e);
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
    const retained = applyPrintHistoryRetention(existing.printStore.history, monitorData.appSettings, { host });
    if (retained.length !== existing.printStore.history.length) {
      const sourceLength = existing.printStore.history.length;
      existing.printStore.history = retained;
      _markExplicitPrintHistoryRetentionCoverage(existing.printStore, sourceLength, retained.length, resolvePrintHistoryRetentionLimit(monitorData.appSettings));
      existing.printStore._historyRev = (Number(existing.printStore._historyRev) || 0) + 1;
    }
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
  // ★ C4: remainingLengthMm の正規化（0にしない — null で「不明」を保持）
  if (sp.remainingLengthMm == null || !Number.isFinite(Number(sp.remainingLengthMm))) {
    const fallback = Number(sp.totalLengthMm ?? sp.filamentTotalLength ?? NaN);
    sp.remainingLengthMm = Number.isFinite(fallback) ? fallback : null;
  } else {
    sp.remainingLengthMm = Number(sp.remainingLengthMm);
  }
  if (sp.startLength == null || !Number.isFinite(Number(sp.startLength))) {
    sp.startLength = sp.remainingLengthMm ?? 0;
  }
  // ★ C1: updatedAt タイムスタンプ（復元/インポート時の時系列判定に使用）
  if (sp.updatedAt == null || !Number.isFinite(Number(sp.updatedAt))) {
    sp.updatedAt = Date.now();
  } else {
    sp.updatedAt = Number(sp.updatedAt);
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
// ★ STORAGE_KEY ("3dp-monitor_1.400") は v2.2.0 で削除。v2.1.017 LTS が最終移行ポイント。

/**
 * per-host localStorage 分割キー: グローバルデータ用 (既定値)。
 *
 * リレー子(readonly/satellite)では setStorageNamespace() により
 * "3dpmon-relay-global" 等へ切り替わる。
 *
 * @type {string}
 */
let LS_KEY_GLOBAL = "3dpmon-global";

/**
 * per-host localStorage 分割キー: ホスト別データの接頭辞 (既定値)。
 * setStorageNamespace() で "3dpmon-relay-host-" 等へ切り替わる。
 *
 * @type {string}
 */
let LS_KEY_HOST_PREFIX = "3dpmon-host-";

/**
 * ストレージの名前空間を設定する。**必ず {@link initStorage} の前に呼ぶこと**。
 *
 * 【背景】
 * v2.2.1031 spec §6.7 は「親(file://) と ブラウザ(http://) はオリジン差で
 * IndexedDB が分離される」前提だったが、同一ブラウザ内の readonly と
 * ?relay=standalone はクエリ違いで origin が同じため IDB/LS を共有してしまう。
 * その結果、readonly が relay-snapshot で受けた親由来データを autoSave で
 * 共有ストレージに書き戻し、後から開く standalone の永続データを破壊する。
 *
 * 【挙動】
 * - 既定 (空文字 / "") : DB="3dpmon", LS="3dpmon-global"/"3dpmon-host-"
 *   → 親(file://) と standalone(http://) で従来通り。
 * - "relay" : DB="3dpmon-relay", LS="3dpmon-relay-global"/"3dpmon-relay-host-"
 *   → readonly/satellite 専用。同一ブラウザ内の standalone と物理分離される。
 *
 * @param {string} ns - 名前空間("" | "relay" 等)
 * @returns {void}
 */
export function setStorageNamespace(ns) {
  const prefix = (typeof ns === "string" && ns.length > 0) ? `3dpmon-${ns}` : "3dpmon";
  LS_KEY_GLOBAL = `${prefix}-global`;
  LS_KEY_HOST_PREFIX = `${prefix}-host-`;
  setIdbDbName(prefix);
}

/** localStorage 用に保存可能なグローバルフィールド名一覧 */
const LS_GLOBAL_FIELDS = [
  "appSettings", "filamentSpools", "usageHistory", "filamentPresets",
  "userPresets", "hiddenPresets", "favoritePresets", "filamentInventory",
  // ★ ADR-0004: フィラメント装着履歴 ＋ watermark(seq)
  "mountHistory", "mountHistorySeq",
  // ★ #410-9: 参照不整合で隔離した mount イベント（元データを失わない）
  "mountHistoryRejectedEvents",
  // ★ #411-O1: オフライン推定の観測 watermark（baseline＝再起動後の差分基準）＋現セッション観測
  "hostObservationWatermark", "hostObservationCurrent",
  // ★ #412-O4: オフライン継続推定 candidate（親権威・状態遷移つき）
  "inferredCandidateStore",
  // ★ #420/O6A: O5 recovery blocker と復旧操作 audit event
  "inferredDecisionRecoveryRequired", "inferredRecoveryOperationRecoveryRequired", "inferredRecoveryEvents",
  // ★ P0-1: 未帰属消費の隔離領域とアーカイブ（再起動後も失わない）
  "pendingUnattributedUsage", "pendingUnattributedUsageArchive",
  // ★ RR-2: 台帳修復要求フラグ（破損時に暗黙クローズせず可視化）
  "ledgerRepairRequired",
  // ★ ADR-0005: フィラメント切れ/一時停止イベント文脈（状態認識つき帰属の遡及判定用）
  "filamentEventContext",
  // ★ Gate 18.7: CFS/CFS-C/外部スプールのread-only機器観測フィラメント履歴。
  "materialSourceObservations",
  "materialAccountingMigrationJournal",
  "materialAccountingMigrationShadowStore",
  "materialAccountingPrintBindingStore",
  "materialAccountingSpoolMountStore",
  "physicalCommandRecoveryLatch",
  // ★ "currentSpoolId" は廃止済み。hostSpoolMap が唯一の権威。
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
 * 印刷履歴のレガシー最大保持件数
 *
 * 旧バージョンで固定上限として使っていた値。現在の既定動作は
 * `monitorData.appSettings.printHistoryMaxEntries === 0` による無制限保持で、
 * この値はユーザーが明示的に自動削除をONにする際の初期候補として扱う。
 *
 * @constant {number}
 */
export const MAX_PRINT_HISTORY = 1500;

/**
 * フィラメント使用履歴の最大保持件数
 *
 * 旧バージョンで固定上限として使っていた値。現在の既定動作は
 * `monitorData.appSettings.usageHistoryMaxEntries === 0` による無制限保持で、
 * 明示的に上限を指定する場合の初期候補として扱う。
 *
 * @constant {number}
 */
export const MAX_USAGE_HISTORY = 4500;

/**
 * IndexedDB利用時にlocalStorageへ書き出す回復用印刷履歴バックアップ件数。
 *
 * 【詳細説明】
 * - IndexedDBが正本である場合、localStorageは緊急復元用の近傍snapshotに限定する。
 * - 正本の無制限履歴はIndexedDB側に残し、localStorage quotaで保存全体が失敗することを避ける。
 *
 * @constant {number}
 */
const LOCAL_STORAGE_PRINT_HISTORY_BACKUP_LIMIT = MAX_PRINT_HISTORY;

/**
 * IndexedDB利用時にlocalStorageへ書き出す回復用使用履歴バックアップ件数。
 *
 * @constant {number}
 */
const LOCAL_STORAGE_USAGE_HISTORY_BACKUP_LIMIT = MAX_USAGE_HISTORY;

/**
 * IndexedDB利用時にlocalStorageへ書き出すPrintBinding回復バックアップの配列別上限。
 *
 * @constant {number}
 */
const LOCAL_STORAGE_PRINT_BINDING_BACKUP_LIMIT = MAX_PRINT_HISTORY;

/**
 * PrintBinding store内でbounded recovery backup対象にする配列フィールド。
 *
 * @constant {ReadonlyArray<string>}
 */
const PRINT_BINDING_RECOVERY_ARRAY_FIELDS = Object.freeze([
  "printStartSnapshots",
  "usageEvidence",
  "jobMaterialSegments",
  "ledgerEvents",
  "unattributedUsage",
  "retainedUnsupportedEntries"
]);

/**
 * 履歴保持件数設定を厳格な十進整数として正規化する。
 *
 * 【詳細説明】
 * - boolean、配列、指数表記、16進表記など、JavaScriptの暗黙Number変換で別の意味になる値は拒否する。
 * - 設定値は「履歴を削除する権限」なので、意図が明確な正の整数だけを採用する。
 *
 * @private
 * @function _resolveRetentionLimitStrict
 * @param {*} raw - appSettingsから読んだ未検証値。
 * @returns {number} 0または1以上の安全な整数。0は無制限。
 */
function _resolveRetentionLimitStrict(raw) {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!/^[0-9]+$/.test(trimmed)) return 0;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  }
  return 0;
}

/**
 * 印刷履歴の自動削除上限を正規化する。
 *
 * 【詳細説明】
 * - 0は「自動削除しない」を表す明示値として扱う。
 * - 未設定、null、負数、不正値も安全側で0へ倒し、Electron版では容量由来の履歴欠落を起こさない。
 * - 1以上の有限数だけを件数上限として採用し、小数は切り捨てる。
 *
 * @function resolvePrintHistoryRetentionLimit
 * @param  {Object|null|undefined} settings - monitorData.appSettings相当の設定オブジェクト。
 * @returns {number} 0または1以上の整数。0は無制限を示す。
 */
export function resolvePrintHistoryRetentionLimit(settings = monitorData.appSettings) {
  return _resolveRetentionLimitStrict(settings?.printHistoryMaxEntries);
}

/**
 * 指定ホストのprintStore.historyから削除してはいけない台帳根拠ジョブIDを収集する。
 *
 * 【詳細説明】
 * - `deriveSpoolRemaining()` は装着区間の `host/sinceJobId/untilJobId` と
 *   printStore.history の消費ジョブを使って残量を冪等に導出する。
 * - 自動削除がこの根拠ジョブを落とすと、次回reconcileで残量が増えたように見えるため、
 *   retention limitより優先して保持対象に加える。
 *
 * @private
 * @function _collectLedgerProtectedPrintJobIds
 * @param {string} host - 対象ホスト名。
 * @param {Array<Object>} history - 新しい順に並ぶprintStore.history。
 * @returns {Set<number>} 保護対象の数値job id集合。
 */
function _collectLedgerProtectedPrintJobIds(host, history) {
  const protectedIds = new Set();
  if (!host || !Array.isArray(history) || history.length === 0) return protectedIds;
  const spools = Array.isArray(monitorData.filamentSpools) ? monitorData.filamentSpools : [];
  for (const spool of spools) {
    const spoolId = spool?.id;
    if (!spoolId) continue;
    let intervals = [];
    try {
      intervals = getSpoolIntervals(spoolId) || [];
    } catch {
      intervals = [];
    }
    const activeIntervals = intervals.filter((interval) => interval && !interval.superseded && interval.host === host);
    const openIntervals = activeIntervals.filter((interval) => interval.untilJobId == null);
    if (activeIntervals.length === 0 || openIntervals.length >= 2) continue;
    const interval = openIntervals[0] || activeIntervals[activeIntervals.length - 1];
    if (!interval || interval.boundaryStatus === "unknown") continue;
    const sinceJobId = Number(interval.sinceJobId) || 0;
    const untilJobId = interval.untilJobId == null ? null : Number(interval.untilJobId);
    const coverageSentinelId = sinceJobId + 1;
    for (const job of history) {
      const jobId = Number(job?.id);
      if (!Number.isFinite(jobId)) continue;
      if (
        sinceJobId >= 0 &&
        jobId === coverageSentinelId &&
        (untilJobId == null || !Number.isFinite(untilJobId) || jobId <= untilJobId)
      ) {
        protectedIds.add(jobId);
      }
      if (jobId <= sinceJobId) continue;
      if (untilJobId != null && Number.isFinite(untilJobId) && jobId > untilJobId) continue;
      const used = Number(attributedUsed(job, spoolId));
      if (Number.isFinite(used) && used > 0) protectedIds.add(jobId);
    }
  }
  return protectedIds;
}

/**
 * 履歴jobの識別子候補を文字列集合として生成する。
 *
 * 【詳細説明】
 * - K2/PrintBinding側では`printJobId`がprotocol/job文字列で保持され、従来K1履歴では
 *   数値`id`が主キーとして使われるため、retention保護では両方を照合候補にする。
 *
 * @private
 * @function _collectHistoryJobIdentityKeys
 * @param {Object|null|undefined} job - printStore.history entry。
 * @returns {Set<string>} job identity候補。
 */
function _collectHistoryJobIdentityKeys(job) {
  return new Set([
    job?.printJobId,
    job?.jobId,
    job?.id,
    job?.starttime
  ].map((value) => String(value ?? "").trim()).filter(Boolean));
}

/**
 * completion attributionが未commitのPrintBinding jobをretention保護対象として収集する。
 *
 * 【詳細説明】
 * - print-start snapshotだけがCAS保存済みでcompletion segmentがまだ無いjobでは、
 *   後続retryが`printStore.history`のraw materialUsed CSVを再読する。
 * - その履歴をretentionで削除すると、authorityはfail-closedするがsource-aware accountingを
 *   後から完成できなくなるため、segmentが揃うまではjob履歴を保持する。
 *
 * @private
 * @function _collectPrintBindingProtectedPrintJobIds
 * @param {Array<Object>} history - 新しい順に並ぶprintStore.history。
 * @returns {Set<number>} 保護対象の数値job id集合。
 */
function _collectPrintBindingProtectedPrintJobIds(history) {
  const protectedIds = new Set();
  const store = monitorData.materialAccountingPrintBindingStore;
  if (!store || typeof store !== "object" || !Array.isArray(history) || history.length === 0) {
    return protectedIds;
  }
  const snapshotsByJobId = new Map();
  for (const snapshot of Array.isArray(store.printStartSnapshots) ? store.printStartSnapshots : []) {
    const printJobId = String(snapshot?.printJobId ?? "").trim();
    if (!printJobId) continue;
    snapshotsByJobId.set(printJobId, (snapshotsByJobId.get(printJobId) || 0) + 1);
  }
  if (snapshotsByJobId.size === 0) {
    return protectedIds;
  }
  const segmentsByJobId = new Map();
  for (const segment of Array.isArray(store.jobMaterialSegments) ? store.jobMaterialSegments : []) {
    const printJobId = String(segment?.printJobId ?? "").trim();
    if (!printJobId) continue;
    segmentsByJobId.set(printJobId, (segmentsByJobId.get(printJobId) || 0) + 1);
  }
  const pendingJobIds = new Set();
  for (const [printJobId, snapshotCount] of snapshotsByJobId.entries()) {
    if ((segmentsByJobId.get(printJobId) || 0) < snapshotCount) {
      pendingJobIds.add(printJobId);
    }
  }
  if (pendingJobIds.size === 0) {
    return protectedIds;
  }
  for (const job of history) {
    const numericJobId = Number(job?.id);
    if (!Number.isFinite(numericJobId)) continue;
    const keys = _collectHistoryJobIdentityKeys(job);
    if ([...keys].some((key) => pendingJobIds.has(key))) {
      protectedIds.add(numericJobId);
    }
  }
  return protectedIds;
}

/**
 * 明示retentionにより履歴全体の総量再計算authorityが不完全になったことを記録する。
 *
 * 【詳細説明】
 * - ユーザー設定による保持上限は正常な操作なので、bounded recoveryのように
 *   active anchor deriveまで停止する必要はない。
 * - 一方で履歴全体を合算するmanual recomputeは成立しないため、totalLifetimeCompleteだけを
 *   falseにし、ledger側が総量再計算だけfail-closedできるようにする。
 *
 * @private
 * @function _markExplicitPrintHistoryRetentionCoverage
 * @param {Object|null|undefined} printStore - 対象printStore。
 * @param {number} sourceLength - retention適用前の履歴件数。
 * @param {number} retainedLength - retention適用後の履歴件数。
 * @param {number} limit - 設定保持上限。
 * @returns {void}
 */
function _markExplicitPrintHistoryRetentionCoverage(printStore, sourceLength, retainedLength, limit) {
  if (!printStore || typeof printStore !== "object" || !(sourceLength > retainedLength)) {
    return;
  }
  printStore.historyCoverage = {
    ...(printStore.historyCoverage && typeof printStore.historyCoverage === "object" ? printStore.historyCoverage : {}),
    activeAnchorComplete: printStore.historyAuthorityIncomplete === true ? false : true,
    totalLifetimeComplete: false,
    source: "print-history-retention",
    sourceLength,
    retainedLength,
    limit
  };
}

/**
 * 印刷履歴配列へ設定済みの自動削除上限を適用する。
 *
 * 【詳細説明】
 * - 履歴配列は既存のprintmanager契約どおり「新しい順」に並んでいる前提で扱う。
 * - 上限0の場合は配列をコピーして返すだけで、古い履歴を削除しない。
 * - 上限1以上の場合は先頭側の新しい履歴だけを保持し、末尾側の古い履歴を削除する。
 *
 * @function applyPrintHistoryRetention
 * @param  {Array<Object>} history - 新しい順に並んだ印刷履歴配列。
 * @param  {Object|null|undefined} settings - monitorData.appSettings相当の設定オブジェクト。
 * @param  {Object} [options={}] - retention補助オプション。
 * @param  {string} [options.host] - 台帳保護ジョブを判定する対象ホスト名。
 * @returns {Array<Object>} 保持設定を反映した新しい配列。
 */
export function applyPrintHistoryRetention(history, settings = monitorData.appSettings, options = {}) {
  const list = Array.isArray(history) ? history : [];
  const limit = resolvePrintHistoryRetentionLimit(settings);
  if (limit <= 0) return list.slice();
  const retained = list.slice(0, limit);
  const seen = new Set(retained.map((job) => Number(job?.id)).filter(Number.isFinite));
  const protectedIds = new Set([
    ..._collectLedgerProtectedPrintJobIds(options.host, list),
    ..._collectPrintBindingProtectedPrintJobIds(list)
  ]);
  if (protectedIds.size === 0) return retained;
  for (const job of list.slice(limit)) {
    const jobId = Number(job?.id);
    if (!Number.isFinite(jobId) || seen.has(jobId) || !protectedIds.has(jobId)) continue;
    retained.push(job);
    seen.add(jobId);
  }
  return retained;
}

/**
 * 現在の保持設定を全ホストの保存済み印刷履歴へ即時適用する。
 *
 * 【詳細説明】
 * - ストレージ設定UIで自動削除をON/OFFした直後、既存履歴にも同じ契約を反映するための
 *   明示的なチョークポイント。
 * - 上限0の場合は削除を行わず、結果だけを返す。
 * - 1件以上の削除があったホストでは `_historyRev` を加算し、relay差分検出が履歴短縮を
 *   見落とさないようにする。保存自体は呼び出し元が行う。
 *
 * @function applyConfiguredPrintHistoryRetentionToAllMachines
 * @returns {{changedHosts:Array<string>, removedJobs:number, limit:number}} 適用結果。
 */
export function applyConfiguredPrintHistoryRetentionToAllMachines() {
  const limit = resolvePrintHistoryRetentionLimit(monitorData.appSettings);
  const changedHosts = [];
  let removedJobs = 0;
  if (limit <= 0) return { changedHosts, removedJobs, limit };

  for (const [host, machine] of Object.entries(monitorData.machines || {})) {
    if (host === PLACEHOLDER_HOSTNAME) continue;
    const history = machine?.printStore?.history;
    if (!Array.isArray(history) || history.length <= limit) continue;
    const retained = applyPrintHistoryRetention(history, monitorData.appSettings, { host });
    machine.printStore.history = retained;
    _markExplicitPrintHistoryRetentionCoverage(machine.printStore, history.length, retained.length, limit);
    machine.printStore._historyRev = (Number(machine.printStore._historyRev) || 0) + 1;
    changedHosts.push(host);
    removedJobs += history.length - retained.length;
  }

  return { changedHosts, removedJobs, limit };
}

/**
 * フィラメント使用履歴の自動削除上限を正規化する。
 *
 * 【詳細説明】
 * - 0は「自動削除しない」を表す。
 * - 未設定、null、負数、不正値も0へ倒し、CFS/ItemKeeper連携で必要な過去履歴を
 *   既定では失わない。
 * - 1以上の有限数だけを件数上限として採用する。
 *
 * @function resolveUsageHistoryRetentionLimit
 * @param  {Object|null|undefined} settings - monitorData.appSettings相当の設定オブジェクト。
 * @returns {number} 0または1以上の整数。0は無制限を示す。
 */
export function resolveUsageHistoryRetentionLimit(settings = monitorData.appSettings) {
  return _resolveRetentionLimitStrict(settings?.usageHistoryMaxEntries);
}

/**
 * フィラメント使用履歴配列が上限を超えた場合に古い記録を削除する。
 *
 * @returns {void}
 */
export function trimUsageHistory() {
  const logs = monitorData.usageHistory;
  const limit = resolveUsageHistoryRetentionLimit(monitorData.appSettings);
  if (limit <= 0 || logs.length <= limit) return;

  // 各スプールの最新の startLength エントリ（装着記録）を保護
  // これが失われると autoCorrectCurrentSpool が残量を再計算できなくなる
  const protectedIdx = new Set();
  const seenSpools = new Set();
  for (let i = logs.length - 1; i >= 0; i--) {
    if (logs[i].startLength != null && !seenSpools.has(logs[i].spoolId)) {
      protectedIdx.add(i);
      seenSpools.add(logs[i].spoolId);
    }
  }

  const cutoff = logs.length - limit;
  const trimmed = logs.filter((_, i) => i >= cutoff || protectedIdx.has(i));
  // ★ レビュー指摘#8: トリム（先頭側の中間削除）でも rev を加算し変更検出を確実にする。
  if (trimmed.length !== logs.length) {
    monitorData.usageHistoryRev = (monitorData.usageHistoryRev || 0) + 1;
  }
  monitorData.usageHistory = trimmed;
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
 * monitorData 全体を保存し、IndexedDB 利用時は transaction 完了まで待機する。
 *
 * 【詳細説明】
 * - `saveUnifiedStorage(true)` は IndexedDB パスでは queue へ積むだけで即時復帰する。
 * - candidate 保存後に observation baseline を進める経路では、candidate が実際に耐久保存されたことを
 *   確認してから commit しないと、クラッシュ時に baseline だけ進む可能性がある。
 * - IndexedDB が無効または未初期化の場合は localStorage 同期保存が完了した時点で成功とみなす。
 * - IndexedDB flush 中にフォールバックへ切り替わった場合は、呼び出し元に失敗を返し、baseline commit を止める。
 *
 * @function saveUnifiedStorageDurably
 * @returns {Promise<{ok:boolean, backend:string, reason:string}>} 耐久保存結果。
 * @example
 * const saved = await saveUnifiedStorageDurably();
 */
export async function saveUnifiedStorageDurably() {
  const expectedIdb = _idbInitialized && isIdbAvailable();
  const queued = _flushStorage();
  if (queued?.ok === false) return queued;
  if (!expectedIdb) {
    return queued || { ok: true, backend: "localStorage", reason: "saved" };
  }
  await flushIdb();
  if (!isIdbAvailable()) {
    return { ok: false, backend: "indexedDB", reason: "idb_flush_failed" };
  }
  return { ok: true, backend: "indexedDB", reason: "flushed" };
}

/**
 * MaterialAccounting PrintBinding shadow storeをCAS境界で耐久保存する。
 *
 * 【詳細説明】
 * - print binding storeはまだ残量debit権威ではないが、後続のsource-specific usage attributionの
 *   根拠になるため、print-start snapshotをqueue投入だけで成功扱いしない。
 * - IndexedDB shared store上の現在digestが`baseStoreDigest`と一致した場合だけ`nextStore`を書き込み、
 *   transaction完了後に初めて`monitorData.materialAccountingPrintBindingStore`を更新する。
 * - IndexedDB未使用、CAS不一致、保存失敗ではメモリ上のstoreも進めない。
 *
 * @function commitMaterialAccountingPrintBindingStoreDurably
 * @param {Object} input - commit入力。
 * @param {string} input.baseStoreDigest - runtimeが準備時に見たbase store digest。
 * @param {Object} input.nextStore - CAS成功時に保存する次store。
 * @returns {Promise<{ok:boolean,casApplied:boolean,backend:string,key:string,reason:string,currentDigest?:string,nextDigest?:string,error?:string}>} commit結果。
 * @example
 * const result = await commitMaterialAccountingPrintBindingStoreDurably({ baseStoreDigest, nextStore });
 */
export async function commitMaterialAccountingPrintBindingStoreDurably(input = {}) {
  const commitPromise = _printBindingCommitMutex.then(() => _commitMaterialAccountingPrintBindingStoreDurably(input));
  _printBindingCommitMutex = commitPromise.catch(() => {});
  return commitPromise;
}

/**
 * PrintBinding store commitの実処理を行う。
 *
 * @private
 * @function _commitMaterialAccountingPrintBindingStoreDurably
 * @param {Object} input - commit入力。
 * @returns {Promise<{ok:boolean,casApplied:boolean,backend:string,key:string,reason:string,currentDigest?:string,nextDigest?:string,error?:string}>} commit結果。
 */
async function _commitMaterialAccountingPrintBindingStoreDurably(input = {}) {
  const key = "materialAccountingPrintBindingStore";
  const baseStoreDigest = String(input.baseStoreDigest || "").trim();
  if (!baseStoreDigest) {
    return { ok: false, casApplied: false, backend: "indexedDB", key, reason: "base-store-digest-required" };
  }
  if (!_idbInitialized || !isIdbAvailable()) {
    return { ok: false, casApplied: false, backend: "indexedDB", key, reason: "production-cas-unavailable" };
  }

  const normalizedNextStore = normalizeStoredMaterialAccountingPrintBindingStore(input.nextStore);
  const result = await compareAndSwapSharedValue({
    key,
    expectedDigest: baseStoreDigest,
    createDigest: createMaterialAccountingPrintBindingStoreDigest,
    nextValue: normalizedNextStore,
  });
  if (!result || result.ok !== true || result.casApplied !== true) {
    return {
      ok: false,
      casApplied: false,
      backend: "indexedDB",
      key,
      reason: result?.reason || "durable-cas-not-applied",
      currentDigest: result?.currentDigest,
      nextDigest: result?.nextDigest,
      error: result?.error,
    };
  }

  monitorData.materialAccountingPrintBindingStore = normalizedNextStore;
  return {
    ok: true,
    casApplied: true,
    backend: "indexedDB",
    key,
    reason: "cas-applied",
    currentDigest: result.currentDigest,
    nextDigest: result.nextDigest,
  };
}

/**
 * importされたPrintBinding shadow storeをCAS成功後だけruntimeへ反映する。
 *
 * 【詳細説明】
 * - import payloadは外部入力なので、source-specific usage/debit根拠を通常mergeだけで現在authorityへ昇格しない。
 * - 現在runtime storeをbase `C`、incomingをmergeした結果をtarget `R`として構築し、
 *   IndexedDB shared keyがまだ`C`であることをCASで確認できた場合だけ`monitorData`へ反映する。
 * - IndexedDB CASが使えない環境では成功扱いせず、既存runtime storeを維持する。
 *
 * @private
 * @function _importMaterialAccountingPrintBindingStoreDurably
 * @param {Object|null|undefined} incomingStore - import候補PrintBinding store。
 * @returns {Promise<Object|null>} CAS結果、または処理対象外ならnull。
 */
async function _importMaterialAccountingPrintBindingStoreDurably(incomingStore) {
  if (!incomingStore || typeof incomingStore !== "object" || Array.isArray(incomingStore)) {
    return null;
  }
  const baseStore = normalizeStoredMaterialAccountingPrintBindingStore(
    monitorData.materialAccountingPrintBindingStore
  );
  const targetStore = _createMergedMaterialAccountingPrintBindingStoreTarget(baseStore, incomingStore);
  const baseDigest = createMaterialAccountingPrintBindingStoreDigest(baseStore);
  const targetDigest = createMaterialAccountingPrintBindingStoreDigest(targetStore);
  if (baseDigest === targetDigest) {
    monitorData.materialAccountingPrintBindingStore = targetStore;
    return {
      ok: true,
      casApplied: false,
      backend: "indexedDB",
      key: "materialAccountingPrintBindingStore",
      reason: "unchanged",
    };
  }
  if (!_idbInitialized || !isIdbAvailable()) {
    console.warn("[importAllData] PrintBinding store import skipped: IndexedDB CAS is unavailable.");
    return {
      ok: false,
      casApplied: false,
      backend: "indexedDB",
      key: "materialAccountingPrintBindingStore",
      reason: "production-cas-unavailable",
    };
  }
  const result = await compareAndSwapSharedValue({
    key: "materialAccountingPrintBindingStore",
    expectedDigest: baseDigest,
    createDigest: createMaterialAccountingPrintBindingStoreDigest,
    nextValue: targetStore,
  });
  if (result?.ok === true && result.casApplied === true) {
    monitorData.materialAccountingPrintBindingStore = targetStore;
    return result;
  }
  console.warn(
    `[importAllData] PrintBinding store import CASが未適用: ${result?.reason || result?.error || "unknown"}`
  );
  return result || {
    ok: false,
    casApplied: false,
    backend: "indexedDB",
    key: "materialAccountingPrintBindingStore",
    reason: "durable-cas-not-applied",
  };
}

/**
 * SpoolMount authority precondition用digestを生成する。
 *
 * @private
 * @function _createSpoolMountAuthorityPreconditionDigest
 * @param {string} namespace - digest namespace。
 * @param {*} value - digest対象値。
 * @returns {string} deterministic digest。
 */
function _createSpoolMountAuthorityPreconditionDigest(namespace, value) {
  return `fnv1a128:${createPrinterCoreV3DeterministicId(namespace, [
    stableStringifyPrinterCoreV3Value(value ?? null),
  ])}`;
}

/**
 * 現在の3DPmon管理spoolを取得する。
 *
 * @private
 * @function _findCurrentManagedSpoolForPrecondition
 * @param {string} spoolId - managed spool ID。
 * @returns {?Object} managed spool。
 */
function _findCurrentManagedSpoolForPrecondition(spoolId) {
  const target = String(spoolId || "").trim();
  return (Array.isArray(monitorData.filamentSpools) ? monitorData.filamentSpools : [])
    .find((spool) => String(spool?.id || spool?.spoolId || "").trim() === target) || null;
}

/**
 * 現在のlegacy hostSpoolMap占有を取得する。
 *
 * @private
 * @function _findCurrentLegacyOccupancyForPrecondition
 * @param {string} spoolId - managed spool ID。
 * @param {string} expectedDeviceId - 期待device ID。
 * @returns {?Object} legacy占有。未占有ならnull。
 */
function _findCurrentLegacyOccupancyForPrecondition(spoolId, expectedDeviceId) {
  const target = String(spoolId || "").trim();
  const expected = String(expectedDeviceId || "").trim();
  const hostSpoolMap = monitorData.hostSpoolMap && typeof monitorData.hostSpoolMap === "object"
    ? monitorData.hostSpoolMap
    : {};
  for (const [host, mountedSpoolId] of Object.entries(hostSpoolMap)) {
    if (String(mountedSpoolId || "").trim() !== target) {
      continue;
    }
    return {
      host,
      spoolId: target,
      reason: String(host || "").trim() === expected
        ? "legacy-spool-occupancy-requires-migration"
        : "legacy-spool-already-mounted",
    };
  }
  return null;
}

/**
 * MaterialSource kindからFilamentUnit kindを推定する。
 *
 * @private
 * @function _resolveSpoolMountPreconditionUnitKind
 * @param {string} sourceKind - MaterialSource kind。
 * @returns {string} FilamentUnit kind。
 */
function _resolveSpoolMountPreconditionUnitKind(sourceKind) {
  if (sourceKind === MATERIAL_SOURCE_KIND.CFS_C_SLOT) {
    return FILAMENT_UNIT_KIND.CFS_C;
  }
  if (sourceKind === MATERIAL_SOURCE_KIND.CFS_SLOT) {
    return FILAMENT_UNIT_KIND.CFS;
  }
  return FILAMENT_UNIT_KIND.PRINTER_DIRECT;
}

/**
 * 現在観測snapshotからMaterialSource kindを解決する。
 *
 * @private
 * @function _resolveSpoolMountPreconditionSourceKind
 * @param {Object} snapshot - read-only source snapshot。
 * @returns {?string} MaterialSource kind。
 */
function _resolveSpoolMountPreconditionSourceKind(snapshot) {
  const kind = String(snapshot?.kind || "").trim();
  if (kind === MATERIAL_SOURCE_KIND.CFS_SLOT ||
      kind === MATERIAL_SOURCE_KIND.CFS_C_SLOT ||
      kind === MATERIAL_SOURCE_KIND.EXTERNAL_SPOOL ||
      kind === MATERIAL_SOURCE_KIND.DIRECT_FEED) {
    return kind;
  }
  if (String(snapshot?.providerKind || "").trim() === "cfs-c") {
    return MATERIAL_SOURCE_KIND.CFS_C_SLOT;
  }
  if (String(snapshot?.type || "").trim() === "external") {
    return MATERIAL_SOURCE_KIND.EXTERNAL_SPOOL;
  }
  return null;
}

/**
 * 現在観測snapshotからidentity strengthを解決する。
 *
 * @private
 * @function _resolveSpoolMountPreconditionIdentityStrength
 * @param {Object} snapshot - read-only source snapshot。
 * @param {Object} deviceRecord - device observation record。
 * @returns {?string} identity strength。
 */
function _resolveSpoolMountPreconditionIdentityStrength(snapshot, deviceRecord) {
  const allowed = new Set(Object.values(MATERIAL_IDENTITY_STRENGTH));
  const candidates = [
    snapshot?.materialSourceIdentityStrength,
    snapshot?.identityStrength,
    deviceRecord?.identityStrength,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (!value) {
      continue;
    }
    return allowed.has(value) ? value : null;
  }
  return MATERIAL_IDENTITY_STRENGTH.UNKNOWN;
}

/**
 * 観測snapshotから現在CAS precondition用MaterialSource recordを再構築する。
 *
 * 【詳細説明】
 * - 観測storeのキーはtransport-local aliasであり、永続IDとして扱わない。
 * - storage CASではruntime resolverと同じdevice-scoped MaterialSource IDを再生成し、aliasとcanonical IDの
 *   どちらでpreconditionが来ても同じbinding digestへ解決できるようにする。
 *
 * @private
 * @function _createSpoolMountPreconditionMaterialSourceRecord
 * @param {Object} snapshot - read-only source snapshot。
 * @param {Object} deviceRecord - device observation record。
 * @param {string} deviceId - Device ID。
 * @param {string} sourceLookupId - latestBySourceId内の検索キー。
 * @returns {?Object} MaterialSource record。
 */
function _createSpoolMountPreconditionMaterialSourceRecord(snapshot, deviceRecord, deviceId, sourceLookupId) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  const kind = _resolveSpoolMountPreconditionSourceKind(snapshot);
  const identityStrength = _resolveSpoolMountPreconditionIdentityStrength(snapshot, deviceRecord);
  if (!kind || !identityStrength) {
    return null;
  }

  const rawLocator = snapshot.locator && typeof snapshot.locator === "object" ? snapshot.locator : {};
  const locator = createMaterialSourceLocator({
    kind,
    index: rawLocator.index ?? snapshot.index ?? (kind === MATERIAL_SOURCE_KIND.EXTERNAL_SPOOL ? 0 : null),
    unitIndex: rawLocator.unitIndex ?? snapshot.unitIndex ?? snapshot.boxIndex ?? snapshot.boxId ?? null,
    boxId: rawLocator.boxId ?? snapshot.boxId ?? null,
    slotIndex: rawLocator.slotIndex ?? snapshot.slotIndex ?? snapshot.slotId ?? snapshot.protocolSlotId ?? null,
    protocolSlotId: rawLocator.protocolSlotId ?? snapshot.protocolSlotId ?? snapshot.slotId ?? null,
  });
  const unitKind = _resolveSpoolMountPreconditionUnitKind(kind);
  const unitId = String(snapshot.unitId || "").trim() ||
    String(snapshot.providerId || "").trim() ||
    `material-unit:${deviceId}:${unitKind}:${locator.unitIndex ?? locator.index ?? 0}`;
  const identity = createMaterialSourceIdentity({
    deviceId,
    unitId,
    kind,
    slotIndex: locator.slotIndex,
    index: locator.index,
  });

  return createMaterialSourceRecord({
    deviceId,
    unitId,
    kind,
    locator,
    identity,
    identityStrength,
    displayLabel: snapshot.displayLabel || snapshot.label || sourceLookupId,
    aliases: [sourceLookupId, snapshot.sourceId, snapshot.materialSourceId, snapshot.id]
      .map((value) => String(value ?? "").trim())
      .filter((value, index, list) => value && list.indexOf(value) === index),
  });
}

/**
 * CAS precondition用MaterialSource recordからbinding digestを生成する。
 *
 * @private
 * @function _createSpoolMountPreconditionSourceBindingDigest
 * @param {Object} source - MaterialSource record。
 * @returns {string} source identity digest。
 */
function _createSpoolMountPreconditionSourceBindingDigest(source) {
  return createPrinterCoreV3DeterministicId("material-source-binding", [
    source.deviceId,
    source.materialSourceId,
    source.unitId,
    source.kind,
    source.identityStrength,
    source.identity,
    source.locator,
  ]);
}

/**
 * 現在観測storeからMaterialSource binding digestを再計算する。
 *
 * @private
 * @function _createCurrentMaterialSourceBindingDigestForPrecondition
 * @param {Object} precondition - materialSource precondition。
 * @returns {?string} source identity digest。再計算不能ならnull。
 */
function _createCurrentMaterialSourceBindingDigestForPrecondition(precondition) {
  const deviceId = String(precondition?.deviceId || "").trim();
  const materialSourceId = String(precondition?.materialSourceId || "").trim();
  const expectedDigest = String(precondition?.sourceIdentityDigest || "").trim();
  const byDeviceId = monitorData.materialSourceObservations?.byDeviceId &&
    typeof monitorData.materialSourceObservations.byDeviceId === "object"
      ? monitorData.materialSourceObservations.byDeviceId
      : {};
  const deviceRecord = byDeviceId[deviceId];
  const latestBySourceId = deviceRecord?.latestBySourceId && typeof deviceRecord.latestBySourceId === "object"
    ? deviceRecord.latestBySourceId
    : {};
  if (!deviceRecord || !materialSourceId) {
    return null;
  }

  const candidates = [];
  if (latestBySourceId[materialSourceId]) {
    candidates.push([materialSourceId, latestBySourceId[materialSourceId]]);
  }
  for (const entry of Object.entries(latestBySourceId)) {
    if (entry[0] !== materialSourceId) {
      candidates.push(entry);
    }
  }

  for (const [lookupId, snapshot] of candidates) {
    const source = _createSpoolMountPreconditionMaterialSourceRecord(snapshot, deviceRecord, deviceId, lookupId);
    if (!source) {
      continue;
    }
    const digest = _createSpoolMountPreconditionSourceBindingDigest(source);
    const aliases = Array.isArray(source.aliases) ? source.aliases : [];
    if (source.materialSourceId === materialSourceId || aliases.includes(materialSourceId) || digest === expectedDigest) {
      return digest;
    }
  }
  return null;
}

/**
 * operation eventがprecondition必須のoperator operationか判定する。
 *
 * @private
 * @function _isSpoolMountPreconditionRequiredOperation
 * @param {Object} operation - operation event。
 * @returns {boolean} precondition必須ならtrue。
 */
function _isSpoolMountPreconditionRequiredOperation(operation) {
  return ["operator-mount", "operator-replace"].includes(String(operation?.kind || "").trim());
}

/**
 * 正規化済みnextStoreにoperationがactive evidenceとして残っているか検証する。
 *
 * @private
 * @function _validateSpoolMountOperationInNextStore
 * @param {Object} normalizedNextStore - 正規化済みnext store。
 * @param {Object} operation - serviceが送信時に生成したoperation event。
 * @returns {{ok:boolean, reason:string}} 検証結果。
 */
function _validateSpoolMountOperationInNextStore(normalizedNextStore, operation) {
  const targetEventId = String(operation?.eventId || "").trim();
  const activeEvent = (normalizedNextStore.events || [])
    .find((event) => String(event?.eventId || "").trim() === targetEventId);
  if (!activeEvent) {
    return { ok: false, reason: "operation-not-active-in-next-store" };
  }
  for (const key of ["kind", "operatorActionId", "operationId", "payloadDigest"]) {
    if (String(activeEvent[key] || "").trim() !== String(operation[key] || "").trim()) {
      return { ok: false, reason: "operation-evidence-mismatch" };
    }
  }
  const activePayloadDigest = _createSpoolMountAuthorityPreconditionDigest(
    "material-accounting-spool-mount-operation-payload",
    operation.payload || {},
  );
  if (String(operation.payloadDigest || "").trim() !== activePayloadDigest) {
    return { ok: false, reason: "operation-payload-digest-mismatch" };
  }
  const recordRefs = Array.isArray(activeEvent.recordRefs)
    ? activeEvent.recordRefs.map((ref) => String(ref || "").trim()).filter(Boolean)
    : [];
  if (["operator-mount", "operator-unmount", "operator-replace"].includes(String(activeEvent.kind || "").trim()) &&
      recordRefs.length === 0) {
    return { ok: false, reason: "operation-record-refs-required" };
  }
  return { ok: true, reason: "" };
}

/**
 * SpoolMount production commitの現在値preconditionを検証する。
 *
 * @private
 * @function _validateSpoolMountCommitPreconditions
 * @param {Object|null} preconditions - serviceが送信時に束縛したprecondition群。
 * @returns {{ok:boolean, reason:string, currentDigest?:string, expectedDigest?:string}} 検証結果。
 */
function _validateSpoolMountCommitPreconditions(preconditions) {
  if (!preconditions || typeof preconditions !== "object") {
    return { ok: false, reason: "operation-preconditions-required" };
  }

  const materialSource = preconditions.materialSource && typeof preconditions.materialSource === "object"
    ? preconditions.materialSource
    : null;
  if (!materialSource ||
      !String(materialSource.deviceId || "").trim() ||
      !String(materialSource.materialSourceId || "").trim() ||
      !String(materialSource.sourceIdentityDigest || "").trim()) {
    return { ok: false, reason: "operation-preconditions-required" };
  }
  const currentSourceDigest = _createCurrentMaterialSourceBindingDigestForPrecondition(materialSource);
  if (!currentSourceDigest) {
    return {
      ok: false,
      reason: "material-source-precondition-missing",
      currentDigest: null,
      expectedDigest: materialSource.sourceIdentityDigest,
    };
  }
  if (currentSourceDigest !== materialSource.sourceIdentityDigest) {
    return {
      ok: false,
      reason: "material-source-precondition-changed",
      currentDigest: currentSourceDigest,
      expectedDigest: materialSource.sourceIdentityDigest,
    };
  }

  const managedSpool = preconditions.managedSpool && typeof preconditions.managedSpool === "object"
    ? preconditions.managedSpool
    : null;
  if (!managedSpool || !String(managedSpool.spoolId || "").trim() || !String(managedSpool.digest || "").trim()) {
    return { ok: false, reason: "operation-preconditions-required" };
  }
  if (managedSpool) {
    const currentSpool = _findCurrentManagedSpoolForPrecondition(managedSpool.spoolId);
    const currentDigest = _createSpoolMountAuthorityPreconditionDigest(
      "material-accounting-managed-spool-precondition",
      currentSpool,
    );
    if (!currentSpool) {
      return {
        ok: false,
        reason: "managed-spool-precondition-missing",
        currentDigest,
        expectedDigest: managedSpool.digest,
      };
    }
    if (currentDigest !== managedSpool.digest) {
      return {
        ok: false,
        reason: "managed-spool-precondition-changed",
        currentDigest,
        expectedDigest: managedSpool.digest,
      };
    }
  }

  const legacyOccupancy = preconditions.legacyOccupancy && typeof preconditions.legacyOccupancy === "object"
    ? preconditions.legacyOccupancy
    : null;
  if (!legacyOccupancy || !String(legacyOccupancy.spoolId || "").trim() || !String(legacyOccupancy.digest || "").trim()) {
    return { ok: false, reason: "operation-preconditions-required" };
  }
  if (legacyOccupancy) {
    const currentOccupancy = _findCurrentLegacyOccupancyForPrecondition(
      legacyOccupancy.spoolId,
      legacyOccupancy.expectedDeviceId,
    );
    const currentDigest = _createSpoolMountAuthorityPreconditionDigest(
      "material-accounting-legacy-occupancy-precondition",
      currentOccupancy,
    );
    if (currentDigest !== legacyOccupancy.digest) {
      return {
        ok: false,
        reason: "legacy-occupancy-precondition-changed",
        currentDigest,
        expectedDigest: legacyOccupancy.digest,
      };
    }
  }

  return { ok: true, reason: "" };
}

/**
 * MaterialAccounting SpoolMount storeをproduction CAS境界で耐久保存する。
 *
 * 【詳細説明】
 * - operator mount/unmount/replaceは物理運用上の権威操作なので、通常のthrottled saveや
 *   localStorage fallbackを成功境界として扱わない。
 * - IndexedDB shared store上の現在digestが`baseStoreDigest`と一致した場合だけ`nextStore`を書き込み、
 *   transaction完了後に初めて`monitorData.materialAccountingSpoolMountStore`を更新する。
 * - CAS不一致、IndexedDB未使用、operation証跡欠落、保存失敗ではメモリ上のstoreも変更しない。
 *
 * @function commitMaterialAccountingSpoolMountStoreDurably
 * @param {Object} input - commit入力。
 * @param {string} input.baseStoreDigest - serviceが準備時に見たbase store digest。
 * @param {Object} input.nextStore - CAS成功時に保存する次store。
 * @param {Object} input.operation - mount/unmount/replace operation event証跡。
 * @param {Object|null=} input.preconditions - managed spool / legacy occupancy の送信時precondition群。
 * @returns {Promise<{ok:boolean, casApplied:boolean, backend:string, reason:string, key:string, currentDigest?:string, nextDigest?:string, error?:string}>} commit結果。
 * @example
 * const result = await commitMaterialAccountingSpoolMountStoreDurably({ baseStoreDigest, nextStore, operation });
 */
export async function commitMaterialAccountingSpoolMountStoreDurably(input = {}) {
  const commitPromise = _spoolMountCommitMutex.then(() => _commitMaterialAccountingSpoolMountStoreDurably(input));
  _spoolMountCommitMutex = commitPromise.catch(() => {});
  return commitPromise;
}

/**
 * SpoolMount store commitの実処理を行う。
 *
 * @private
 * @function _commitMaterialAccountingSpoolMountStoreDurably
 * @param {Object} input - commit入力。
 * @returns {Promise<{ok:boolean, casApplied:boolean, backend:string, reason:string, key:string, currentDigest?:string, nextDigest?:string, error?:string}>} commit結果。
 */
async function _commitMaterialAccountingSpoolMountStoreDurably(input = {}) {
  const key = "materialAccountingSpoolMountStore";
  const baseStoreDigest = String(input.baseStoreDigest || "").trim();
  const operation = input.operation && typeof input.operation === "object" ? input.operation : null;
  if (!baseStoreDigest) {
    return { ok: false, casApplied: false, backend: "indexedDB", key, reason: "base-store-digest-required" };
  }
  if (!operation || !String(operation.eventId || "").trim() || !String(operation.payloadDigest || "").trim()) {
    return { ok: false, casApplied: false, backend: "indexedDB", key, reason: "operation-evidence-required" };
  }
  if (!_idbInitialized || !isIdbAvailable()) {
    return { ok: false, casApplied: false, backend: "indexedDB", key, reason: "production-cas-unavailable" };
  }

  const normalizedNextStore = normalizeStoredMaterialAccountingSpoolMountStore(input.nextStore);
  const operationValidation = _validateSpoolMountOperationInNextStore(normalizedNextStore, operation);
  if (!operationValidation.ok) {
    return {
      ok: false,
      casApplied: false,
      backend: "indexedDB",
      key,
      reason: operationValidation.reason,
    };
  }
  const preconditionValidation = _isSpoolMountPreconditionRequiredOperation(operation) || input.preconditions
    ? _validateSpoolMountCommitPreconditions(input.preconditions)
    : { ok: true, reason: "" };
  if (!preconditionValidation.ok) {
    return {
      ok: false,
      casApplied: false,
      backend: "indexedDB",
      key,
      reason: preconditionValidation.reason,
      currentDigest: preconditionValidation.currentDigest,
      expectedDigest: preconditionValidation.expectedDigest,
    };
  }
  const result = await compareAndSwapSharedValue({
    key,
    expectedDigest: baseStoreDigest,
    createDigest: createMaterialAccountingSpoolMountStoreDigest,
    nextValue: normalizedNextStore,
  });
  if (!result || result.ok !== true || result.casApplied !== true) {
    return {
      ok: false,
      casApplied: false,
      backend: "indexedDB",
      key,
      reason: result?.reason || "durable-cas-not-applied",
      currentDigest: result?.currentDigest,
      nextDigest: result?.nextDigest,
      error: result?.error,
    };
  }

  monitorData.materialAccountingSpoolMountStore = normalizedNextStore;
  return {
    ok: true,
    casApplied: true,
    backend: "indexedDB",
    key,
    reason: "cas-applied",
    currentDigest: result.currentDigest,
    nextDigest: result.nextDigest,
  };
}

/**
 * localStorage回復バックアップ用に履歴配列を近傍snapshotへ制限する。
 *
 * 【詳細説明】
 * - 正本がIndexedDBにある場合でも、障害時復元用にlocalStorageへ定期バックアップする。
 * - ただし全履歴をlocalStorageへ書くとquotaで保存全体が失敗し得るため、バックアップだけを
 *   既存の安全上限に制限し、切り詰めた事実をmetadataとして残す。
 *
 * @private
 * @function _boundedRecoveryArray
 * @param {Array<Object>} list - 保存候補の履歴配列。
 * @param {number} limit - バックアップ上限件数。
 * @param {"head"|"tail"} direction - headは先頭側、tailは末尾側を保持する。
 * @returns {{items:Array<Object>, truncated:boolean,totalCount:number,limit:number}} 制限後の配列とmetadata。
 */
function _boundedRecoveryArray(list, limit, direction) {
  const source = Array.isArray(list) ? list : [];
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : source.length;
  if (source.length <= safeLimit) {
    return { items: source.slice(), truncated: false, totalCount: source.length, limit: safeLimit };
  }
  const items = direction === "tail" ? source.slice(-safeLimit) : source.slice(0, safeLimit);
  return { items, truncated: true, totalCount: source.length, limit: safeLimit };
}

/**
 * PrintBinding storeのlocalStorage回復バックアップ用bounded snapshotを生成する。
 *
 * 【詳細説明】
 * - PrintBinding storeはsource-aware使用量証跡として長期運用で増え続けるため、IndexedDB利用時の
 *   localStorage回復バックアップへ丸ごと複製するとquotaを圧迫する。
 * - 正本は専用CAS/IndexedDBに残し、localStorageには直近側のbounded snapshotだけを置く。
 * - truncation metadataを`storageRecoveryBackup`へ返し、復元時に不完全なbackupをauthorityとして
 *   扱わないための判定材料にする。
 *
 * @private
 * @function _createPrintBindingLocalStorageRecoverySnapshot
 * @param {Object|null|undefined} store - PrintBinding store候補。
 * @returns {{store:Object,metadata:Object}} bounded backup storeとmetadata。
 */
function _createPrintBindingLocalStorageRecoverySnapshot(store) {
  const source = store && typeof store === "object" && !Array.isArray(store)
    ? store
    : {};
  const result = _cloneStorageJsonValue(source);
  const metadata = {
    truncated: false,
    backupLimit: LOCAL_STORAGE_PRINT_BINDING_BACKUP_LIMIT,
  };
  for (const field of PRINT_BINDING_RECOVERY_ARRAY_FIELDS) {
    const bounded = _boundedRecoveryArray(
      Array.isArray(source[field]) ? source[field] : [],
      LOCAL_STORAGE_PRINT_BINDING_BACKUP_LIMIT,
      "tail"
    );
    result[field] = bounded.items.map((entry) => _cloneStorageJsonValue(entry));
    metadata[`${field}Truncated`] = bounded.truncated;
    metadata[`${field}SourceLength`] = bounded.totalCount;
    if (bounded.truncated) {
      metadata.truncated = true;
    }
  }
  // process-local operation cacheはrestart後のauthorityに使わないため、回復バックアップでも落とす。
  result.operationsById = {};
  return { store: result, metadata };
}

/**
 * per-host localStorageへ保存するmachine snapshotを生成する。
 *
 * 【詳細説明】
 * - runtimeDataは常に除外する。
 * - IndexedDB利用時の回復バックアップではprintStore.historyだけを近傍snapshotへ制限し、
 *   正本の無制限履歴はIndexedDBに任せる。
 *
 * @private
 * @function _createLocalStorageMachineSnapshot
 * @param {Object} machine - monitorData.machines配下のmachine。
 * @param {Object} options - 保存オプション。
 * @param {boolean} [options.boundedRecoveryBackup=false] - trueなら回復バックアップ上限を適用する。
 * @returns {Object} JSON保存用machine snapshot。
 */
function _createLocalStorageMachineSnapshot(machine, options = {}) {
  const { runtimeData: _omit, ...serializableMachine } = machine || {};
  if (options.boundedRecoveryBackup && Array.isArray(serializableMachine.printStore?.history)) {
    const bounded = _boundedRecoveryArray(
      serializableMachine.printStore.history,
      LOCAL_STORAGE_PRINT_HISTORY_BACKUP_LIMIT,
      "head"
    );
    serializableMachine.printStore = {
      ...serializableMachine.printStore,
      history: bounded.items,
      historyBackupTruncated: bounded.truncated,
      historyBackupSourceLength: bounded.totalCount,
      historyBackupLimit: bounded.limit
    };
  }
  return serializableMachine;
}

/**
 * localStorage回復バックアップ由来のmachine snapshotに履歴authority不完全フラグを付ける。
 *
 * 【詳細説明】
 * - IndexedDBが正本の環境では、localStorage側の履歴はquota回避のためbounded backupになり得る。
 * - そのbackupから復元した履歴を完全な台帳根拠として扱うと、欠落した古い消費が消えたぶんだけ
 *   残量が巻き戻るため、復元時点でprintStoreへ明示フラグを残す。
 * - 画面表示や履歴閲覧は維持しつつ、ledger側はこのフラグを見て自動derive/recomputeを停止する。
 *
 * @private
 * @function _markLocalStorageRecoveryHistoryAuthority
 * @param {Object|null|undefined} machineData - localStorageから読んだmachine snapshot。
 * @param {Object} options - 復元オプション。
 * @param {string=} options.source - 復元元名。
 * @returns {Object|null|undefined} 必要ならprintStoreへauthority不完全metadataを付けたsnapshot。
 */
function _markLocalStorageRecoveryHistoryAuthority(machineData, options = {}) {
  if (
    options.source !== "localStorage" ||
    !machineData ||
    typeof machineData !== "object" ||
    machineData.printStore?.historyBackupTruncated !== true
  ) {
    return machineData;
  }
  const sourceLength = Number(machineData.printStore.historyBackupSourceLength);
  const limit = Number(machineData.printStore.historyBackupLimit);
  machineData.printStore = {
    ...machineData.printStore,
    historyAuthorityIncomplete: true,
    historyAuthoritySource: "localStorage-bounded-recovery-backup",
    historyCoverage: {
      ...(machineData.printStore.historyCoverage && typeof machineData.printStore.historyCoverage === "object"
        ? machineData.printStore.historyCoverage
        : {}),
      activeAnchorComplete: false,
      totalLifetimeComplete: false,
      source: "localStorage-bounded-recovery-backup",
      sourceLength: Number.isSafeInteger(sourceLength) && sourceLength >= 0
        ? sourceLength
        : null,
      retainedLength: Array.isArray(machineData.printStore.history)
        ? machineData.printStore.history.length
        : null,
      limit: Number.isSafeInteger(limit) && limit >= 0
        ? limit
        : null
    },
    historyAuthoritySourceLength: Number.isSafeInteger(sourceLength) && sourceLength >= 0
      ? sourceLength
      : null,
    historyAuthorityLimit: Number.isSafeInteger(limit) && limit >= 0
      ? limit
      : null
  };
  return machineData;
}

/**
 * monitorData を per-host 分割形式で localStorage に書き込む。
 * グローバルデータは LS_KEY_GLOBAL に、per-host データは LS_KEY_HOST_PREFIX+hostname に書き込む。
 * 前回書き込みと同一ならスキップする。
 *
 * @private
 * @param {Object} [options={}] - 保存オプション。
 * @param {boolean} [options.boundedRecoveryBackup=false] - trueならlocalStorageを回復用bounded snapshotにする。
 * @returns {void}
 */
function _writePerHostLocalStorage(options = {}) {
  // グローバルデータ
  const globalData = {};
  for (const field of LS_GLOBAL_FIELDS) {
    if (field in monitorData) globalData[field] = monitorData[field];
  }
  if (options.boundedRecoveryBackup && Array.isArray(globalData.usageHistory)) {
    const boundedUsage = _boundedRecoveryArray(
      globalData.usageHistory,
      LOCAL_STORAGE_USAGE_HISTORY_BACKUP_LIMIT,
      "tail"
    );
    globalData.usageHistory = boundedUsage.items;
    globalData.storageRecoveryBackup = {
      ...(globalData.storageRecoveryBackup || {}),
      usageHistoryTruncated: boundedUsage.truncated,
      usageHistorySourceLength: boundedUsage.totalCount,
      usageHistoryBackupLimit: boundedUsage.limit
    };
  }
  if (
    options.boundedRecoveryBackup &&
    globalData.materialAccountingPrintBindingStore &&
    typeof globalData.materialAccountingPrintBindingStore === "object" &&
    !Array.isArray(globalData.materialAccountingPrintBindingStore)
  ) {
    const boundedPrintBinding = _createPrintBindingLocalStorageRecoverySnapshot(
      globalData.materialAccountingPrintBindingStore
    );
    globalData.materialAccountingPrintBindingStore = boundedPrintBinding.store;
    globalData.storageRecoveryBackup = {
      ...(globalData.storageRecoveryBackup || {}),
      materialAccountingPrintBindingStore: boundedPrintBinding.metadata,
    };
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
    /* ★ runtimeData は揮発状態のため永続化から除外
       (IndexedDB パスでは queueMachineWrite が除外済み、localStorage パスは未対応だった) */
    const serializableMachine = _createLocalStorageMachineSnapshot(machine, options);
    const hostJson = JSON.stringify(serializableMachine);
    // per-host のデデュープは簡易チェック（サイズ比較）
    const prev = localStorage.getItem(hostKey);
    if (prev && prev.length === hostJson.length && prev === hostJson) continue;
    localStorage.setItem(hostKey, hostJson);
  }

  // 孤児ホストキーの掃除は「データを持たない空キーのみ」に限定する。
  // ★ かつては machines に無いホストキーを無条件 removeItem しており、
  //   一時的に machines から外れた(IP変化/mDNS障害/未復元タイミング等)機器の
  //   印刷履歴・フィラメント履歴ごと消去する破壊的バグだった。
  //   = 実質「現在アクティブな1ホスト群だけ生存、他は消去」という
  //     優先ホスト・アンチパターン。データ損失は許容しない。
  //   IP→ホスト名移行に伴う旧IPキー削除は updateConnectionHost が明示的に行う。
  const storedHosts = _discoverHostKeysInLocalStorage();
  for (const host of storedHosts) {
    if (activeHosts.has(host)) continue;
    try {
      const key = LS_KEY_HOST_PREFIX + _encodeHostKey(host);
      const rawJson = localStorage.getItem(key);
      if (!rawJson) continue;
      const parsed = JSON.parse(rawJson);
      // データを持つ孤児キーは決して自動削除しない（保持して手動削除に委ねる）
      if (isEmptyHostShell(parsed)) {
        localStorage.removeItem(key);  // 空シェルのみ掃除
      }
    } catch { /* パース不能なキーは触らない（安全側） */ }
  }

  // ★ 旧統一キー STORAGE_KEY は v2.2.0 で削除済み。
}

/**
 * 保存済みホストデータが「掃除してよい空シェル」かを判定する純関数。
 * 印刷履歴(printStore.history) も storedData も持たない場合のみ true。
 * データを持つ孤児ホストキーの自動削除を防ぎ、データ損失を回避するために使う。
 *
 * @param {Object|null|undefined} parsed - localStorage から復元したホストデータ
 * @returns {boolean} 空シェル（削除可）なら true
 */
export function isEmptyHostShell(parsed) {
  const hasHistory = (parsed?.printStore?.history?.length || 0) > 0;
  const hasStored  = parsed?.storedData && Object.keys(parsed.storedData).length > 0;
  return !hasHistory && !hasStored;
}

/**
 * 実際のストレージ書き込みを行う内部関数。
 * IndexedDB が有効な場合はキューに追加し、無効な場合は localStorage へ書き込む。
 * @private
 * @returns {{ok:boolean, backend:string, reason:string, error?:string}} 保存またはキュー投入の結果。
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
      queueSharedWrite("userPresets",        monitorData.userPresets);
      queueSharedWrite("hiddenPresets",      monitorData.hiddenPresets);
      queueSharedWrite("favoritePresets",    monitorData.favoritePresets);
      queueSharedWrite("filamentInventory",  monitorData.filamentInventory);
      // ★ ADR-0004: フィラメント装着履歴（残量導出の権威）＋ watermark(seq)
      queueSharedWrite("mountHistory",       monitorData.mountHistory);
      queueSharedWrite("mountHistorySeq",    monitorData.mountHistorySeq);
      queueSharedWrite("mountHistoryRejectedEvents", monitorData.mountHistoryRejectedEvents);
      queueSharedWrite("hostObservationWatermark", monitorData.hostObservationWatermark);
      queueSharedWrite("hostObservationCurrent",   monitorData.hostObservationCurrent);
      queueSharedWrite("inferredCandidateStore",   monitorData.inferredCandidateStore);
      queueSharedWrite("inferredDecisionRecoveryRequired", monitorData.inferredDecisionRecoveryRequired || null);
      queueSharedWrite("inferredRecoveryOperationRecoveryRequired", monitorData.inferredRecoveryOperationRecoveryRequired || null);
      queueSharedWrite("inferredRecoveryEvents", monitorData.inferredRecoveryEvents || []);
      // ★ P0-1: 未帰属消費の隔離領域とアーカイブ（再起動後も失わない・子へも配信）
      queueSharedWrite("pendingUnattributedUsage",        monitorData.pendingUnattributedUsage);
      queueSharedWrite("pendingUnattributedUsageArchive", monitorData.pendingUnattributedUsageArchive);
      queueSharedWrite("ledgerRepairRequired",            monitorData.ledgerRepairRequired);
      // ★ ADR-0005: フィラメントイベント文脈（per-host・遡及帰属判定用）
      queueSharedWrite("filamentEventContext", monitorData.filamentEventContext);
      // ★ Gate 18.7: 機器観測フィラメントはread-only evidenceとして保存し、台帳権威へは混ぜない。
      queueSharedWrite("materialSourceObservations", monitorData.materialSourceObservations);
      // ★ Gate 18.9B: Universal MaterialSource移行dry-run journalを証跡として保存する。
      queueSharedWrite("materialAccountingMigrationJournal", monitorData.materialAccountingMigrationJournal);
      // ★ Gate 18.9D-2: durable shadow commit storeを証跡として保存する。
      queueSharedWrite("materialAccountingMigrationShadowStore", monitorData.materialAccountingMigrationShadowStore);
      // ★ Gate 18.9I: PrintBinding storeはsource-specific debit rootになるため通常queueへ積まない。
      //   runtime/importの成功判定とIndexedDB書き込みは専用CASだけで行い、localStorage backup/exportで可視性だけ維持する。
      // ★ Gate 18.9H: operator-managed SpoolMount storeは通常queueへ積まない。
      //   production成功判定とIndexedDB書き込みは専用CASだけで行い、localStorage backup/exportで可視性だけ維持する。
      // ★ Gate 19 prep: 物理コマンド復旧ラッチは未解決確認の証跡のみ保存し、自動再送材料は保存しない。
      queueSharedWrite("physicalCommandRecoveryLatch", monitorData.physicalCommandRecoveryLatch);
      // ★ currentSpoolId は廃止済み。保存しない。hostSpoolMap のみが権威。
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
          _writePerHostLocalStorage({ boundedRecoveryBackup: true });
        } catch (e) {
          console.warn("[saveUnifiedStorage] localStorage バックアップ失敗:", e.message);
        }
      }

      if (_enableStorageLog) {
        console.debug("[saveUnifiedStorage] IndexedDB キューに追加しました");
      }
      return { ok: true, backend: "indexedDB", reason: "queued" };
    } else {
      // フォールバック: localStorage（per-host 分割形式）
      _writePerHostLocalStorage();

      if (_enableStorageLog) {
        console.debug("[saveUnifiedStorage] localStorage (per-host) に保存しました");
      }
      return { ok: true, backend: "localStorage", reason: "saved" };
    }
  } catch (e) {
    console.warn("[saveUnifiedStorage] 保存に失敗しました:", e);
    logManager.add({ timestamp:getCurrentTimestamp(), level:"error", msg:`[saveUnifiedStorage] エラー: ${e.message}` });
    return {
      ok: false,
      backend: (_idbInitialized && isIdbAvailable()) ? "indexedDB" : "localStorage",
      reason: "local_storage_write_failed",
      error: e?.message || String(e)
    };
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
// ★ cleanUpLegacyStorage は v2.2.0 で削除。v2.1.017 で最終掃除済み。

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
    _restoreFromData(idbCache.shared, idbCache.machines, { source: "indexedDB" });
    console.debug("[restoreUnifiedStorage] IndexedDB から復元しました");
    Object.keys(monitorData.machines).forEach(host => ensureMachineData(host));
    _reconcileAfterRestore();
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
      _restoreFromData(shared, machines, { source: "localStorage" });
      _lastSavedJson = globalSaved;
      console.debug(`[restoreUnifiedStorage] localStorage (per-host) から復元: ${hostKeys.size}ホスト`);
    } catch (e) {
      console.error("[restoreUnifiedStorage] per-host パースエラー:", e);
      pushLog("[restoreUnifiedStorage] per-host 復元中にパースエラー発生", true);
    }
  } else {
    // ★ v2.2.0: 旧統一キー(STORAGE_KEY)からのマイグレーションは削除。
    //   v2.1.017 LTS が最終移行ポイント。
    console.debug("[restoreUnifiedStorage] 保存データなし。初回起動として扱います");
  }

  Object.keys(monitorData.machines).forEach(host => ensureMachineData(host));
  _reconcileAfterRestore();
}

/**
 * 復元完了後にフィラメント残量レジャーのアンカーを初期化する（ADR-0004 是正版）。
 *
 * 過去を再計算せず、装着中スプール（hostSpoolMap 掲載）で mount イベント未種付けの
 * ものに「現在値（または現在ジョブ開始時残量）」を基点とする mount イベントを1回だけ
 * 種付けする。以後の残量は最新区間のアンカーから冪等に導出される。
 * 取り外し済みスプールには触れない（残量を維持）。
 * テスト容易性のため失敗してもアプリ起動は妨げない（時刻は呼び出し側の Date.now を渡す）。
 *
 * @private
 * @returns {void}
 */
function _reconcileAfterRestore() {
  // ★ 監査 P0-1(第1報): リレー子（satellite/readonly）は台帳の権威を持たない。
  //   親スナップショットが唯一の正であり、復元したローカルデータから mount イベントや
  //   推定アンカーを再生成すると親と分岐する（＝残量乖離が再起動でも直らない主因）。
  //   フラグは init 側でストレージ復元前に確定済み。
  if (typeof window !== "undefined" && window._3dpmonRelayChild === true) {
    console.debug("[restoreUnifiedStorage] リレー子: 台帳アンカー種付けをスキップ（親が権威）");
    return;
  }
  // ★ #410-9: 種付け前に、import/復元された参照不整合イベントを隔離する（projection の corrupt 化防止）。
  try { quarantineInvalidMountEvents(); }
  catch (e) { console.warn("[restoreUnifiedStorage] quarantineInvalidMountEvents 失敗:", e?.message || e); }
  try {
    const report = initLedgerAnchors({ nowMs: Date.now() });
    if (report && report.seeded > 0) {
      console.info(
        `[restoreUnifiedStorage] フィラメント残量アンカー種付け: ${report.seeded}件`
      );
    }
  } catch (e) {
    console.warn("[restoreUnifiedStorage] initLedgerAnchors 失敗:", e?.message || e);
  }
}

/**
 * データソースから monitorData を復元する内部ヘルパー。
 * IndexedDB と localStorage の両方から使用される。
 *
 * @private
 * @param {Object} shared - shared データ（appSettings, filamentSpools 等）
 * @param {Object} [machines] - per-host マシンデータ
 * @param {{source?:string}=} options - 復元元情報。
 */
function _restoreFromData(shared, machines, options = {}) {
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
    // IP→ホスト名の重複除外: connectionTargets でホスト名が解決済みのIPキーをスキップ
    const targets = shared?.appSettings?.connectionTargets
      || monitorData.appSettings?.connectionTargets || [];
    const ipToHostname = new Map();
    for (const t of targets) {
      if (t.hostname && t.dest) {
        const ip = extractHost(t.dest);
        ipToHostname.set(ip, t.hostname);
      }
    }
    const hostnameKeys = new Set(Object.keys(machines));
    for (const [host, rawMachineData] of Object.entries(machines)) {
      const machineData = _markLocalStorageRecoveryHistoryAuthority(rawMachineData, options);
      // IPキーで、かつ同一プリンタのホスト名キーが存在する場合はスキップ
      const resolvedHostname = ipToHostname.get(host);
      if (resolvedHostname && hostnameKeys.has(resolvedHostname) && host !== resolvedHostname) {
        console.debug(`[_restoreFromData] IPキー "${host}" はホスト名 "${resolvedHostname}" に統合済み — スキップ`);
        continue;
      }
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
        // 既存スプール: ストレージ値でマージ
        const existing = monitorData.filamentSpools.find(s => s.id === sp.id);
        if (existing) {
          const restored = applySpoolDefaults(sp);
          // ★ C2: remainingLengthMm — updatedAt 時系列判定（Math.min 廃止）
          const existRemain = existing.remainingLengthMm;
          const restoredRemain = restored.remainingLengthMm;
          const existValid = Number.isFinite(existRemain);
          const restoredValid = Number.isFinite(restoredRemain);

          let mergedRemain;
          if (existValid && restoredValid) {
            // 両方有効 → updatedAt が新しい方を採用
            const existTime = existing.updatedAt ?? 0;
            const restoredTime = restored.updatedAt ?? 0;
            if (restoredTime > existTime) {
              mergedRemain = restoredRemain;
            } else if (existTime > restoredTime) {
              mergedRemain = existRemain;
            } else {
              // タイムスタンプ同一 → 小さい方（互換フォールバック）
              mergedRemain = Math.min(existRemain, restoredRemain);
            }
            console.debug(`[restore] spool ${existing.id}: exist=${existRemain}(t=${existing.updatedAt}) restored=${restoredRemain}(t=${restored.updatedAt}) → ${mergedRemain}`);
          } else if (restoredValid) {
            mergedRemain = restoredRemain;
          } else if (existValid) {
            mergedRemain = existRemain;
          } else {
            // 両方無効 → totalLengthMm フォールバック（0にしない）
            mergedRemain = restored.totalLengthMm ?? restored.filamentTotalLength ?? null;
          }
          // ★ isActive/isInUse/hostname はランタイム値を優先
          const mergedUpdatedAt = Math.max(existing.updatedAt ?? 0, restored.updatedAt ?? 0);
          const protectedFields = {
            remainingLengthMm: mergedRemain,
            updatedAt: mergedUpdatedAt,
            isActive: existing.isActive || restored.isActive,
            isInUse: existing.isInUse || restored.isInUse,
            hostname: existing.hostname || restored.hostname
          };
          Object.assign(existing, restored, protectedFields);
        }
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

  // ★ ADR-0004/P1-1 mountHistory: (opId||evId) ベースでマージ（追記専用ログ・全クリアしない）
  if (Array.isArray(shared?.mountHistory)) {
    if (!Array.isArray(monitorData.mountHistory)) monitorData.mountHistory = [];
    if (monitorData.mountHistory.length === 0) {
      monitorData.mountHistory = shared.mountHistory.slice();
    } else {
      const existingIds = new Set(monitorData.mountHistory.map(e => e?.opId || e?.evId));
      for (const ev of shared.mountHistory) {
        const key = ev?.opId || ev?.evId;
        if (ev && key != null && !existingIds.has(key)) {
          monitorData.mountHistory.push(ev);
          existingIds.add(key);
        }
      }
    }
    monitorData.mountHistory.sort((a, b) => (Number(a?.ts) || 0) - (Number(b?.ts) || 0));
  }

  // ★ P0-1(レビュー): mountHistorySeq(watermark) を最大値へ引き上げ（後退させない）
  if (shared && shared.mountHistorySeq != null) {
    monitorData.mountHistorySeq = Math.max(
      Number(monitorData.mountHistorySeq) || 0, Number(shared.mountHistorySeq) || 0
    );
  }

  // ★ P0-1: pendingUnattributedUsage を pendingUsageId(無ければ fingerprint)で重複排除追加。
  //   再起動後も未帰属消費・未確認バッジ・通知集合が失われないようにする。
  if (Array.isArray(shared?.pendingUnattributedUsage)) {
    if (!Array.isArray(monitorData.pendingUnattributedUsage)) monitorData.pendingUnattributedUsage = [];
    const seen = new Set(
      monitorData.pendingUnattributedUsage.map(e => e?.pendingUsageId ?? e?.completionFingerprint)
    );
    for (const r of shared.pendingUnattributedUsage) {
      const key = r?.pendingUsageId ?? r?.completionFingerprint;
      if (r && key != null && !seen.has(key)) {
        monitorData.pendingUnattributedUsage.push(r);
        seen.add(key);
      }
    }
  }

  // ★ P0-1: 隔離アーカイブ（per-host 集約）は未保持ホストのみ取り込む（二重集計回避）。
  if (shared?.pendingUnattributedUsageArchive && typeof shared.pendingUnattributedUsageArchive === "object") {
    if (!monitorData.pendingUnattributedUsageArchive
        || typeof monitorData.pendingUnattributedUsageArchive !== "object") {
      monitorData.pendingUnattributedUsageArchive = {};
    }
    for (const [h, a] of Object.entries(shared.pendingUnattributedUsageArchive)) {
      if (a && !monitorData.pendingUnattributedUsageArchive[h]) {
        monitorData.pendingUnattributedUsageArchive[h] = { ...a };
      }
    }
  }

  // ★ RR-2: 台帳修復要求フラグ（per-host）は未保持ホストのみ取り込む。
  if (shared?.ledgerRepairRequired && typeof shared.ledgerRepairRequired === "object") {
    if (!monitorData.ledgerRepairRequired || typeof monitorData.ledgerRepairRequired !== "object") {
      monitorData.ledgerRepairRequired = {};
    }
    for (const [h, v] of Object.entries(shared.ledgerRepairRequired)) {
      if (v && !monitorData.ledgerRepairRequired[h]) monitorData.ledgerRepairRequired[h] = { ...v };
    }
  }

  // ★ #411-O1: オフライン推定の観測 watermark（baseline・per-host）は未保持ホストのみ取り込む
  //   （再起動後の差分基準＝停止直前の観測状態を復元。起動直後の record は baseline を上書きしない）。
  if (shared?.hostObservationWatermark && typeof shared.hostObservationWatermark === "object") {
    if (!monitorData.hostObservationWatermark || typeof monitorData.hostObservationWatermark !== "object") {
      monitorData.hostObservationWatermark = {};
    }
    for (const [h, v] of Object.entries(shared.hostObservationWatermark)) {
      if (v && !monitorData.hostObservationWatermark[h]) monitorData.hostObservationWatermark[h] = { ...v };
    }
  }
  // ★ #411-O1: 現セッション観測（crash 耐性用）。record が上書きするため未保持のみ取り込む。
  if (shared?.hostObservationCurrent && typeof shared.hostObservationCurrent === "object") {
    if (!monitorData.hostObservationCurrent || typeof monitorData.hostObservationCurrent !== "object") {
      monitorData.hostObservationCurrent = {};
    }
    for (const [h, v] of Object.entries(shared.hostObservationCurrent)) {
      if (v && !monitorData.hostObservationCurrent[h]) monitorData.hostObservationCurrent[h] = { ...v };
    }
  }

  // ★ #412-O4: inferredCandidateStore は candidateHash 単位でマージする。
  //   既存候補がある場合は updatedAt が新しい方を採用し、同一 window の二重処理を避ける。
  if (shared?.inferredCandidateStore && typeof shared.inferredCandidateStore === "object") {
    if (!monitorData.inferredCandidateStore || typeof monitorData.inferredCandidateStore !== "object") {
      monitorData.inferredCandidateStore = {};
    }
    for (const [hash, value] of Object.entries(shared.inferredCandidateStore)) {
      if (!value || typeof value !== "object") continue;
      const current = monitorData.inferredCandidateStore[hash];
      if (!current || (Number(value.updatedAt) || 0) >= (Number(current.updatedAt) || 0)) {
        monitorData.inferredCandidateStore[hash] = { ...value };
      }
    }
  }

  // ★ #420/O6A: O5 recovery flag と復旧操作 audit event を復元する。
  //   recovery flag は blocker なので、ストレージ値が明示 null の場合も状態を消す。
  if (shared && Object.prototype.hasOwnProperty.call(shared, "inferredDecisionRecoveryRequired")) {
    monitorData.inferredDecisionRecoveryRequired =
      shared.inferredDecisionRecoveryRequired && typeof shared.inferredDecisionRecoveryRequired === "object"
        ? { ...shared.inferredDecisionRecoveryRequired }
        : null;
  }
  if (shared && Object.prototype.hasOwnProperty.call(shared, "inferredRecoveryOperationRecoveryRequired")) {
    monitorData.inferredRecoveryOperationRecoveryRequired =
      shared.inferredRecoveryOperationRecoveryRequired && typeof shared.inferredRecoveryOperationRecoveryRequired === "object"
        ? { ...shared.inferredRecoveryOperationRecoveryRequired }
        : null;
  }
  if (Array.isArray(shared?.inferredRecoveryEvents)) {
    if (!Array.isArray(monitorData.inferredRecoveryEvents)) monitorData.inferredRecoveryEvents = [];
    const seen = new Set(monitorData.inferredRecoveryEvents.map(event => event?.eventId));
    for (const event of shared.inferredRecoveryEvents) {
      const key = event?.eventId;
      if (event && key != null && !seen.has(key)) {
        monitorData.inferredRecoveryEvents.push({ ...event });
        seen.add(key);
      }
    }
    monitorData.inferredRecoveryEvents.sort((a, b) => (Number(a?.createdAt) || 0) - (Number(b?.createdAt) || 0));
  }

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

  // ★ currentSpoolId は廃止済み。復元しない。hostSpoolMap のみが権威。

  // ★ hostSpoolMap: マージ（既存の装着情報を保護、全クリアしない）
  // ★ 参照整合性チェック: filamentSpools に存在するスプールのみ復元
  if (shared?.hostSpoolMap && typeof shared.hostSpoolMap === "object") {
    const validSpoolIds = new Set(
      monitorData.filamentSpools.filter(s => !s.deleted && !s.isDeleted).map(s => s.id)
    );
    for (const [host, spoolId] of Object.entries(shared.hostSpoolMap)) {
      if (spoolId && !monitorData.hostSpoolMap[host]) {
        if (_canImportLegacyHostSpoolAssignment({
          host,
          spoolId,
          validSpoolIds,
          contextLabel: "_restoreFromData",
        })) {
          monitorData.hostSpoolMap[host] = spoolId;
        }
      }
    }
  }
  // ★ レガシー currentSpoolId → hostSpoolMap 移行は削除済み（マイグレーション完了）

  // ★ ADR-0005: フィラメントイベント文脈（per-host）。既存（このセッションで記録済み）を
  //   優先し、未保持のホストのみ保存値で補完（再起動を跨いだ遡及帰属判定を維持）。
  if (shared?.filamentEventContext && typeof shared.filamentEventContext === "object") {
    if (!monitorData.filamentEventContext || typeof monitorData.filamentEventContext !== "object") {
      monitorData.filamentEventContext = {};
    }
    for (const [host, ctx] of Object.entries(shared.filamentEventContext)) {
      if (ctx && !monitorData.filamentEventContext[host]) {
        monitorData.filamentEventContext[host] = ctx;
      }
    }
  }

  // ★ Gate 18.7: CFS/CFS-C/外部スプールの機器観測フィラメントを復元する。
  //   これは「最後に観測したread-only evidence」であり、復元時にhostSpoolMapや台帳へ投影しない。
  if (shared?.materialSourceObservations && typeof shared.materialSourceObservations === "object") {
    const restoredStore = normalizeStoredMaterialSourceObservations(shared.materialSourceObservations, {
      restoredAt: new Date().toISOString(),
    });
    if (!monitorData.materialSourceObservations
        || typeof monitorData.materialSourceObservations !== "object"
        || Array.isArray(monitorData.materialSourceObservations)) {
      monitorData.materialSourceObservations = { schemaVersion: 1, byDeviceId: {} };
    }
    if (!monitorData.materialSourceObservations.byDeviceId
        || typeof monitorData.materialSourceObservations.byDeviceId !== "object"
        || Array.isArray(monitorData.materialSourceObservations.byDeviceId)) {
      monitorData.materialSourceObservations.byDeviceId = {};
    }
    if (restoredStore.retainedUnsupportedStore) {
      monitorData.materialSourceObservations.retainedUnsupportedStore = restoredStore.retainedUnsupportedStore;
      monitorData.materialSourceObservations.migrationStatus = restoredStore.migrationStatus;
    }
    const restoredByDevice = restoredStore.byDeviceId;
    if (restoredByDevice && typeof restoredByDevice === "object" && !Array.isArray(restoredByDevice)) {
      for (const [deviceId, record] of Object.entries(restoredByDevice)) {
        if (record && typeof record === "object" && !monitorData.materialSourceObservations.byDeviceId[deviceId]) {
          monitorData.materialSourceObservations.byDeviceId[deviceId] = record;
        }
      }
    }
    monitorData.materialSourceObservations.schemaVersion = 1;
    monitorData.materialSourceObservations.authority = "observation-only";
  }

  // ★ Gate 18.9B: Universal MaterialSource移行dry-run journalを復元する。
  //   復元してもMaterialSource/SpoolMount/usage ledgerへの本番書き込みは有効化しない。
  if (shared?.materialAccountingMigrationJournal && typeof shared.materialAccountingMigrationJournal === "object") {
    _mergeMaterialAccountingMigrationJournal(shared.materialAccountingMigrationJournal);
  } else {
    monitorData.materialAccountingMigrationJournal = normalizeStoredMaterialAccountingMigrationJournal(
      monitorData.materialAccountingMigrationJournal
    );
  }

  // ★ Gate 18.9D-2: Universal MaterialSource移行shadow commit storeを復元する。
  //   これはcommit済みshadow evidenceの復元であり、復元時にlegacy装着やledgerへ投影しない。
  if (shared?.materialAccountingMigrationShadowStore && typeof shared.materialAccountingMigrationShadowStore === "object") {
    _mergeMaterialAccountingMigrationShadowStore(shared.materialAccountingMigrationShadowStore);
  } else {
    monitorData.materialAccountingMigrationShadowStore = normalizeStoredMaterialAccountingMigrationShadowCommitStore(
      monitorData.materialAccountingMigrationShadowStore
    );
  }

  // ★ Gate 18.9E: print-start binding / source-aware usage shadow storeを復元する。
  //   復元してもlegacy usageHistoryやspool残量へは投影しない。
  if (
    options.source === "localStorage" &&
    shared?.storageRecoveryBackup?.materialAccountingPrintBindingStore?.truncated === true
  ) {
    console.warn("[restoreUnifiedStorage] PrintBinding store restore skipped: localStorage recovery backup is truncated.");
    monitorData.materialAccountingPrintBindingStore = normalizeStoredMaterialAccountingPrintBindingStore(
      monitorData.materialAccountingPrintBindingStore
    );
  } else if (shared?.materialAccountingPrintBindingStore && typeof shared.materialAccountingPrintBindingStore === "object") {
    _mergeMaterialAccountingPrintBindingStore(shared.materialAccountingPrintBindingStore);
  } else {
    monitorData.materialAccountingPrintBindingStore = normalizeStoredMaterialAccountingPrintBindingStore(
      monitorData.materialAccountingPrintBindingStore
    );
  }

  // ★ Gate 18.9H: operator-managed SpoolMount production storeを復元する。
  //   復元してもlegacy hostSpoolMapやusage ledgerへは投影せず、専用storeとしてだけ保持する。
  if (
    shared?.materialAccountingSpoolMountStore &&
    typeof shared.materialAccountingSpoolMountStore === "object" &&
    options.source === "indexedDB" &&
    _idbInitialized &&
    isIdbAvailable()
  ) {
    _mergeMaterialAccountingSpoolMountStore(shared.materialAccountingSpoolMountStore);
  } else if (shared?.materialAccountingSpoolMountStore && typeof shared.materialAccountingSpoolMountStore === "object") {
    console.warn("[restoreUnifiedStorage] SpoolMount store restore skipped: IndexedDB CAS authority is unavailable.");
    monitorData.materialAccountingSpoolMountStore = normalizeStoredMaterialAccountingSpoolMountStore(
      monitorData.materialAccountingSpoolMountStore
    );
  } else {
    monitorData.materialAccountingSpoolMountStore = normalizeStoredMaterialAccountingSpoolMountStore(
      monitorData.materialAccountingSpoolMountStore
    );
  }
  _reconcileCurrentMaterialAccountingSpoolMountStoreWithCurrentBackends();

  // ★ Gate 19 prep: 物理コマンド復旧ラッチを復元する。
  //   復元してもcommand frame再送・CFS操作・legacy ledger投影は行わず、人間確認が必要な証跡だけを残す。
  if (shared?.physicalCommandRecoveryLatch && typeof shared.physicalCommandRecoveryLatch === "object") {
    _mergePhysicalCommandRecoveryLatchStore(shared.physicalCommandRecoveryLatch);
  } else {
    monitorData.physicalCommandRecoveryLatch = normalizeStoredPhysicalCommandRecoveryLatchStore(
      monitorData.physicalCommandRecoveryLatch
    );
  }

  // ★ userPresets / hiddenPresets の復元（Phase 2 で追加したが restore が漏れていた）
  if (Array.isArray(shared?.userPresets) && shared.userPresets.length > 0) {
    monitorData.userPresets = shared.userPresets;
  }
  if (Array.isArray(shared?.hiddenPresets)) {
    monitorData.hiddenPresets = shared.hiddenPresets;
  }
  if (Array.isArray(shared?.favoritePresets)) {
    monitorData.favoritePresets = shared.favoritePresets;
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

// ★ restoreLegacyStoredData は v2.2.0 で完全削除済み。

/**
 * cleanUpLegacyStorage() を実行し、その結果をカスタムイベントで通知する。
 *
 * @returns {number} 削除したレガシーキーの件数
 */
// ★ cleanupLegacy は v2.2.0 で完全削除済み。

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
 * 印刷履歴を保存する。
 *
 * 【詳細説明】
 * - 既定では印刷履歴を自動削除しない。
 * - `appSettings.printHistoryMaxEntries` が1以上の場合だけ、既存契約どおり新しい順の
 *   配列先頭を保持し、末尾側の古い履歴を削除する。
 *
 * @param {Array<Object>} history - 保存対象の履歴配列
 */
export function savePrintHistory(history, hostname) {
  const host = hostname;
  if (!host) return;
  ensureMachineData(host);
  const ps = monitorData.machines[host].printStore;
  const sourceLength = Array.isArray(history) ? history.length : 0;
  ps.history = applyPrintHistoryRetention(history, monitorData.appSettings, { host });
  _markExplicitPrintHistoryRetentionCoverage(ps, sourceLength, ps.history.length, resolvePrintHistoryRetentionLimit(monitorData.appSettings));
  // ★ 監査§6: 履歴 revision を単調インクリメント。relay delta の変更検出署名は
  //   O(1) の軽量サンプル（末尾ジョブ＋現在ジョブ）で、履歴中間の filamentInfo 編集・
  //   分割 upsert・reconcile 等（件数・末尾不変）を取りこぼしうる。履歴を実際に書き換える
  //   単一チョークポイント（saveHistory の JSON 差分ガード経由のみ）で rev を上げ、
  //   署名に含めることで子（readonly/satellite）へ確実に伝播させる。
  ps._historyRev = (Number(ps._historyRev) || 0) + 1;
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
  // ★ bg-cpu/ログ汚染対策: loadPrintVideos は履歴/現在ジョブ描画ごと（印刷中は毎秒複数回）
  //   呼ばれるため、毎回 pushLog するとログパネルを「マップ読込件数:0」で埋め尽くし、
  //   (行数)×(パネル数) の DOM 処理で CPU も浪費していた。debug 時のみ出力する。
  if (monitorData.appSettings?.logLevel === "debug") {
    pushLog(`[loadPrintVideos] マップ読込件数: ${Object.keys(map).length}`);
  }
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
  // デバッグ用: 保存件数（debug 時のみ。ログ汚染/CPU 浪費防止）
  if (monitorData.appSettings?.logLevel === "debug") {
    pushLog(`[savePrintVideos] マップ保存件数: ${Object.keys(map).length}`);
  }
  console.debug("[savePrintVideos] map", map);
  saveUnifiedStorage();
}
