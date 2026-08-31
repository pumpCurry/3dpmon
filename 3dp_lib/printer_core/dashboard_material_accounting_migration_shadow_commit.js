/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Universal MaterialSource migration shadow commit モジュール
 * @file dashboard_material_accounting_migration_shadow_commit.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_accounting_migration_shadow_commit
 *
 * 【機能内容サマリ】
 * - Gate 18.9D-2 のpersistent shadow commit境界を提供
 * - prepared shadow transactionをbase snapshot CASで検査してから永続store候補へ反映
 * - durable write成功後だけSHADOW lifecycleを返し、ledger debitやlegacy cutover sealは行わない
 *
 * 【公開関数一覧】
 * - {@link normalizeStoredMaterialAccountingMigrationShadowCommitStore}：保存済みshadow commit storeを正規化
 * - {@link commitMaterialAccountingMigrationShadowTransaction}：prepared transactionをshadow storeへcommit
 *
 * @version 1.390.1517 (PR #438)
 * @since   1.390.1515 (PR #438)
 * @lastModified 2026-08-31 23:05:00
 * -----------------------------------------------------------
 * @todo
 * - Gate 18.9D-2後続でdashboard_storageの実IndexedDB transaction adapterへ接続する
 */

"use strict";

import {
  createPrinterCoreV3DeterministicId,
  stableStringifyPrinterCoreV3Value,
} from "./dashboard_data_schema_v3.js";
import {
  MATERIAL_ACCOUNTING_MIGRATION_STATUS,
} from "./dashboard_material_accounting_contract.js";
import { isTrustedMaterialAccountingMigrationShadowTransaction } from "./dashboard_material_accounting_migration_shadow_transaction.js";

/**
 * shadow commit store schema version。
 *
 * @constant {number}
 */
export const MATERIAL_ACCOUNTING_SHADOW_COMMIT_STORE_SCHEMA_VERSION = 1;

/**
 * shadow commit result status。
 *
 * @constant {Readonly<object>}
 */
export const MATERIAL_ACCOUNTING_SHADOW_COMMIT_STATUS = Object.freeze({
  COMMITTED: "committed",
  IDEMPOTENT: "idempotent",
  BLOCKED: "blocked",
});

/**
 * JSON互換値をcloneする。
 *
 * @private
 * @function cloneJsonValue
 * @param {*} value - clone対象。
 * @returns {*} clone済み値。
 */
function cloneJsonValue(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * JSON互換値をdeep freezeする。
 *
 * @private
 * @function deepFreezeJson
 * @param {*} value - freeze対象。
 * @returns {*} freeze済み値。
 */
function deepFreezeJson(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreezeJson(child);
  }
  return Object.freeze(value);
}

/**
 * 任意値をtrim済み文字列へ変換する。
 *
 * @private
 * @function toTrimmedString
 * @param {*} value - 文字列候補。
 * @returns {string} trim済み文字列。
 */
function toTrimmedString(value) {
  return String(value ?? "").trim();
}

/**
 * ISO日時文字列を厳密に正規化する。
 *
 * @private
 * @function normalizeRequiredIsoTime
 * @param {*} value - 日時候補。
 * @returns {?string} 有効なISO日時、またはnull。
 */
function normalizeRequiredIsoTime(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * snapshot digestを生成する。
 *
 * 【詳細説明】
 * - CAS境界では参照同一性ではなくcanonical JSON digestでbase/currentを比較する。
 * - これはIndexedDBやlocalStorage復元後でも同じ意味のsnapshotを同じbaseとして扱うため。
 *
 * @private
 * @function createSnapshotDigest
 * @param {string} namespace - digest namespace。
 * @param {*} snapshot - digest対象snapshot。
 * @returns {string} snapshot digest。
 */
function createSnapshotDigest(namespace, snapshot) {
  return `fnv1a128:${createPrinterCoreV3DeterministicId(namespace, [
    stableStringifyPrinterCoreV3Value(snapshot ?? null),
  ]).split(":")[1]}`;
}

/**
 * transaction payload digestを生成する。
 *
 * @private
 * @function createTransactionDigest
 * @param {Object} transaction - shadow transaction。
 * @returns {string} transaction digest。
 */
function createTransactionDigest(transaction) {
  return createSnapshotDigest("material-accounting-shadow-transaction-payload", transaction);
}

/**
 * commit event IDを生成する。
 *
 * @private
 * @function createCommitEventId
 * @param {Object} input - event ID入力。
 * @param {string} input.transactionId - transaction ID。
 * @param {string} input.shadowOperationId - shadow operation ID。
 * @param {string} input.committedAt - commit日時。
 * @returns {string} event ID。
 */
function createCommitEventId(input) {
  return createPrinterCoreV3DeterministicId("material-accounting-shadow-commit-event", [
    input.transactionId,
    input.shadowOperationId,
    input.committedAt,
  ]);
}

/**
 * 空のshadow commit storeを生成する。
 *
 * @private
 * @function createEmptyStore
 * @returns {Object} 空store。
 */
function createEmptyStore() {
  return {
    schemaVersion: MATERIAL_ACCOUNTING_SHADOW_COMMIT_STORE_SCHEMA_VERSION,
    authority: "migration-shadow-commit-store",
    materialSourceRegistrySnapshot: { sources: [], conflicts: [] },
    spoolMountRepositorySnapshot: { mounts: [], conflicts: [] },
    committedTransactionsById: {},
    committedOperationsById: {},
    lifecycleBySubject: {},
    events: [],
    retainedUnsupportedEntries: [],
    invariants: {
      ledgerWrites: false,
      legacyCutoverSealed: false,
      materialSourceRepositoryWrites: "shadow-only",
      spoolMountRepositoryWrites: "shadow-only",
    },
  };
}

/**
 * commit resultを生成する。
 *
 * @private
 * @function createCommitResult
 * @param {Object} input - result入力。
 * @param {boolean} input.ok - 成功可否。
 * @param {string} input.status - committed/idempotent/blocked。
 * @param {string[]} input.reasons - block理由。
 * @param {Object} input.store - store snapshot。
 * @param {?Object=} input.event - commit event。
 * @returns {Object} commit result。
 */
function createCommitResult({
  ok,
  status,
  reasons,
  store,
  event = null,
}) {
  return deepFreezeJson({
    ok,
    status,
    reasons: [...new Set((reasons || []).map((reason) => toTrimmedString(reason)).filter(Boolean))],
    store: cloneJsonValue(store),
    event: event ? cloneJsonValue(event) : null,
    invariants: {
      ledgerWrites: false,
      legacyCutoverSealed: false,
    },
  });
}

/**
 * repository snapshotを正規化する。
 *
 * @private
 * @function normalizeRepositorySnapshot
 * @param {*} snapshot - snapshot候補。
 * @param {string} recordKey - records配列key。
 * @returns {Object} 正規化snapshot。
 */
function normalizeRepositorySnapshot(snapshot, recordKey) {
  const source = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot
    : {};
  return {
    [recordKey]: Array.isArray(source[recordKey])
      ? source[recordKey].map((record) => cloneJsonValue(record))
      : [],
    conflicts: Array.isArray(source.conflicts)
      ? source.conflicts.map((conflict) => cloneJsonValue(conflict))
      : [],
  };
}

/**
 * 保存済みshadow commit storeを正規化する。
 *
 * 【詳細説明】
 * - 保存値に未知フィールドがあってもauthorityへは投影せず、既知shapeだけを復元する。
 * - committed transaction / operation index / lifecycle は再起動後の冪等retry判定に必要なため保持する。
 *
 * @function normalizeStoredMaterialAccountingMigrationShadowCommitStore
 * @param {Object|null|undefined} stored - 保存済みstore候補。
 * @returns {Object} 正規化済みstore。
 * @example
 * const store = normalizeStoredMaterialAccountingMigrationShadowCommitStore(saved);
 */
export function normalizeStoredMaterialAccountingMigrationShadowCommitStore(stored) {
  const source = stored && typeof stored === "object" && !Array.isArray(stored)
    ? stored
    : {};
  const store = createEmptyStore();
  store.materialSourceRegistrySnapshot = normalizeRepositorySnapshot(
    source.materialSourceRegistrySnapshot,
    "sources",
  );
  store.spoolMountRepositorySnapshot = normalizeRepositorySnapshot(
    source.spoolMountRepositorySnapshot,
    "mounts",
  );
  store.committedTransactionsById = source.committedTransactionsById &&
    typeof source.committedTransactionsById === "object" &&
    !Array.isArray(source.committedTransactionsById)
    ? cloneJsonValue(source.committedTransactionsById)
    : {};
  store.committedOperationsById = source.committedOperationsById &&
    typeof source.committedOperationsById === "object" &&
    !Array.isArray(source.committedOperationsById)
    ? cloneJsonValue(source.committedOperationsById)
    : {};
  store.lifecycleBySubject = source.lifecycleBySubject &&
    typeof source.lifecycleBySubject === "object" &&
    !Array.isArray(source.lifecycleBySubject)
    ? cloneJsonValue(source.lifecycleBySubject)
    : {};
  store.events = Array.isArray(source.events)
    ? source.events
      .filter((event) => event && typeof event === "object" && event.type === "material-accounting-shadow-committed")
      .map((event) => cloneJsonValue(event))
    : [];
  store.retainedUnsupportedEntries = Array.isArray(source.retainedUnsupportedEntries)
    ? source.retainedUnsupportedEntries.map((entry) => cloneJsonValue(entry))
    : [];
  return deepFreezeJson(store);
}

/**
 * shadow transactionの最低限のcommit可能shapeを検査する。
 *
 * @private
 * @function collectTransactionReasons
 * @param {*} transaction - transaction候補。
 * @returns {string[]} block理由。
 */
function collectTransactionReasons(transaction) {
  const reasons = [];
  if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) {
    return ["transaction-required"];
  }
  if (transaction.transactionStatus !== "prepared") {
    reasons.push("transaction-not-prepared");
  }
  if (transaction.proposedMigrationStatus !== MATERIAL_ACCOUNTING_MIGRATION_STATUS.SHADOW) {
    reasons.push("transaction-proposed-status-not-shadow");
  }
  if (transaction.transactionStatus === "prepared" &&
      transaction.proposedMigrationStatus === MATERIAL_ACCOUNTING_MIGRATION_STATUS.SHADOW &&
      !isTrustedMaterialAccountingMigrationShadowTransaction(transaction)) {
    reasons.push("transaction-result-untrusted");
  }
  for (const key of [
    "transactionId",
    "shadowOperationId",
    "shadowExecutionId",
    "migrationSubjectId",
    "migrationId",
    "executedAt",
  ]) {
    if (!toTrimmedString(transaction[key])) {
      reasons.push(`transaction-${key}-required`);
    }
  }
  if (!Array.isArray(transaction.records?.materialSources) ||
      transaction.records.materialSources.length < 1) {
    reasons.push("transaction-materialSources-required");
  }
  if (!Array.isArray(transaction.records?.spoolMounts) ||
      transaction.records.spoolMounts.length < 1) {
    reasons.push("transaction-spoolMounts-required");
  }
  if (!Array.isArray(transaction.repositorySnapshots?.materialSources?.sources) ||
      !Array.isArray(transaction.repositorySnapshots?.materialSources?.conflicts)) {
    reasons.push("transaction-materialSourceRepositorySnapshot-required");
  }
  if (!Array.isArray(transaction.repositorySnapshots?.spoolMounts?.mounts) ||
      !Array.isArray(transaction.repositorySnapshots?.spoolMounts?.conflicts)) {
    reasons.push("transaction-spoolMountRepositorySnapshot-required");
  }
  if (!transaction.baseRepositoryDigests ||
      typeof transaction.baseRepositoryDigests !== "object" ||
      !toTrimmedString(transaction.baseRepositoryDigests.materialSourceRegistry) ||
      !toTrimmedString(transaction.baseRepositoryDigests.spoolMountRepository)) {
    reasons.push("transaction-baseRepositoryDigests-required");
  }
  if (!Array.isArray(transaction.baseRepositorySnapshots?.materialSources?.sources) ||
      !Array.isArray(transaction.baseRepositorySnapshots?.materialSources?.conflicts)) {
    reasons.push("transaction-baseMaterialSourceRepositorySnapshot-required");
  }
  if (!Array.isArray(transaction.baseRepositorySnapshots?.spoolMounts?.mounts) ||
      !Array.isArray(transaction.baseRepositorySnapshots?.spoolMounts?.conflicts)) {
    reasons.push("transaction-baseSpoolMountRepositorySnapshot-required");
  }
  return reasons;
}

/**
 * store current snapshotに対するCAS理由を収集する。
 *
 * @private
 * @function collectCasReasons
 * @param {Object} store - 正規化済みshadow commit store。
 * @param {Object} transaction - trusted prepared transaction。
 * @returns {string[]} block理由。
 */
function collectCasReasons(store, transaction) {
  const reasons = [];
  const expectedMaterialSourceDigest = toTrimmedString(transaction?.baseRepositoryDigests?.materialSourceRegistry);
  const expectedSpoolMountDigest = toTrimmedString(transaction?.baseRepositoryDigests?.spoolMountRepository);
  const currentMaterialSourceDigest = createSnapshotDigest(
    "material-source-registry-base",
    store.materialSourceRegistrySnapshot,
  );
  const currentSpoolMountDigest = createSnapshotDigest(
    "spool-mount-repository-base",
    store.spoolMountRepositorySnapshot,
  );
  if (!expectedMaterialSourceDigest || expectedMaterialSourceDigest !== currentMaterialSourceDigest) {
    reasons.push("base-material-source-snapshot-changed");
  }
  if (!expectedSpoolMountDigest || expectedSpoolMountDigest !== currentSpoolMountDigest) {
    reasons.push("base-spool-mount-snapshot-changed");
  }
  return reasons;
}

/**
 * operation retryとして同一payloadかを検査する。
 *
 * @private
 * @function getExistingOperationConflictReason
 * @param {Object} store - 正規化済みstore。
 * @param {Object} transaction - transaction候補。
 * @returns {?string} conflict理由。衝突なしならnull。
 */
function getExistingOperationConflictReason(store, transaction) {
  const operationId = toTrimmedString(transaction?.shadowOperationId);
  const existing = operationId ? store.committedOperationsById[operationId] : null;
  if (!existing) {
    return null;
  }
  if (existing.transactionId !== transaction.transactionId ||
      existing.transactionDigest !== createTransactionDigest(transaction)) {
    return "shadow-operation-payload-conflict";
  }
  return null;
}

/**
 * commit済みtransactionの再送か判定する。
 *
 * @private
 * @function isIdempotentCommittedTransaction
 * @param {Object} store - 正規化済みstore。
 * @param {Object} transaction - transaction候補。
 * @returns {boolean} 同一commit済みtransactionならtrue。
 */
function isIdempotentCommittedTransaction(store, transaction) {
  const existing = store.committedTransactionsById[toTrimmedString(transaction?.transactionId)];
  return !!existing &&
    existing.transactionDigest === createTransactionDigest(transaction) &&
    existing.shadowOperationId === transaction.shadowOperationId;
}

/**
 * commit後storeを構築する。
 *
 * @private
 * @function createCommittedStore
 * @param {Object} input - commit入力。
 * @param {Object} input.store - 現store。
 * @param {Object} input.transaction - prepared transaction。
 * @param {string} input.committedAt - commit日時。
 * @returns {{store:Object,event:Object}} commit後storeとevent。
 */
function createCommittedStore({ store, transaction, committedAt }) {
  const transactionDigest = createTransactionDigest(transaction);
  const event = {
    eventId: createCommitEventId({
      transactionId: transaction.transactionId,
      shadowOperationId: transaction.shadowOperationId,
      committedAt,
    }),
    type: "material-accounting-shadow-committed",
    transactionId: transaction.transactionId,
    shadowOperationId: transaction.shadowOperationId,
    migrationSubjectId: transaction.migrationSubjectId,
    migrationId: transaction.migrationId,
    transactionDigest,
    committedAt,
    migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.SHADOW,
  };
  const nextStore = cloneJsonValue(store);
  nextStore.materialSourceRegistrySnapshot = cloneJsonValue(transaction.repositorySnapshots.materialSources);
  nextStore.spoolMountRepositorySnapshot = cloneJsonValue(transaction.repositorySnapshots.spoolMounts);
  nextStore.committedTransactionsById[transaction.transactionId] = {
    transactionId: transaction.transactionId,
    shadowOperationId: transaction.shadowOperationId,
    migrationSubjectId: transaction.migrationSubjectId,
    migrationId: transaction.migrationId,
    transactionDigest,
    committedAt,
    repositoryDigests: {
      materialSourceRegistry: createSnapshotDigest(
        "material-source-registry-committed",
        nextStore.materialSourceRegistrySnapshot,
      ),
      spoolMountRepository: createSnapshotDigest(
        "spool-mount-repository-committed",
        nextStore.spoolMountRepositorySnapshot,
      ),
    },
  };
  nextStore.committedOperationsById[transaction.shadowOperationId] = {
    shadowOperationId: transaction.shadowOperationId,
    transactionId: transaction.transactionId,
    transactionDigest,
    committedAt,
  };
  nextStore.lifecycleBySubject[transaction.migrationSubjectId] = {
    migrationSubjectId: transaction.migrationSubjectId,
    migrationId: transaction.migrationId,
    transactionId: transaction.transactionId,
    migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.SHADOW,
    committedAt,
  };
  nextStore.events.push(event);
  return {
    store: deepFreezeJson(nextStore),
    event,
  };
}

/**
 * prepared shadow transactionを永続shadow storeへcommitする。
 *
 * 【詳細説明】
 * - transactionに固定済みのbase digestとstore current snapshotを比較し、stale baseなら保存前に止める。
 * - durable writerには同一transaction内でCASを適用したことを`casApplied:true`で返すことを要求する。
 * - 同じ`shadowOperationId`/transaction payloadの再送はidempotentとして既存storeを返す。
 * - `persist(nextStore)`が成功を返した場合だけ、返却resultでもSHADOW lifecycleへ進める。
 * - ledger debitやlegacy cutover sealはこのGateでは行わない。
 *
 * @function commitMaterialAccountingMigrationShadowTransaction
 * @param {Object} input - commit入力。
 * @param {Object|null|undefined} input.store - 既存shadow commit store。
 * @param {Object} input.transaction - prepared shadow transaction。
 * @param {string|Date} input.committedAt - commit日時。
 * @param {Function} input.persist - durable write callback。同一永続transactionでCASを行い`casApplied:true`を返す。
 * @returns {Promise<Object>} commit result。
 * @example
 * const result = await commitMaterialAccountingMigrationShadowTransaction({ store, transaction, persist });
 */
export async function commitMaterialAccountingMigrationShadowTransaction(input = {}) {
  const store = normalizeStoredMaterialAccountingMigrationShadowCommitStore(input.store);
  const transaction = input.transaction || null;
  const committedAt = normalizeRequiredIsoTime(input.committedAt);
  const reasons = [
    ...collectTransactionReasons(transaction),
  ];
  if (!committedAt) {
    reasons.push("committedAt-invalid");
  }
  if (typeof input.persist !== "function") {
    reasons.push("persist-required");
  }
  if (transaction && typeof transaction === "object") {
    const operationConflictReason = getExistingOperationConflictReason(store, transaction);
    if (operationConflictReason) {
      return createCommitResult({
        ok: false,
        status: MATERIAL_ACCOUNTING_SHADOW_COMMIT_STATUS.BLOCKED,
        reasons: [operationConflictReason],
        store,
        event: null,
      });
    }
    if (isIdempotentCommittedTransaction(store, transaction)) {
      return createCommitResult({
        ok: true,
        status: MATERIAL_ACCOUNTING_SHADOW_COMMIT_STATUS.IDEMPOTENT,
        reasons: [],
        store,
        event: null,
      });
    }
  }
  reasons.push(...collectCasReasons(store, transaction));
  if (reasons.length > 0) {
    return createCommitResult({
      ok: false,
      status: MATERIAL_ACCOUNTING_SHADOW_COMMIT_STATUS.BLOCKED,
      reasons,
      store,
      event: null,
    });
  }

  const committed = createCommittedStore({
    store,
    transaction,
    committedAt,
  });

  try {
    const durable = await input.persist(committed.store, {
      requireAtomicCompareAndSwap: true,
      expectedCurrentRepositoryDigests: cloneJsonValue(transaction.baseRepositoryDigests),
      transactionId: transaction.transactionId,
      shadowOperationId: transaction.shadowOperationId,
    });
    if (!durable || durable.ok !== true) {
      return createCommitResult({
        ok: false,
        status: MATERIAL_ACCOUNTING_SHADOW_COMMIT_STATUS.BLOCKED,
        reasons: ["durable-write-failed"],
        store,
        event: null,
      });
    }
    if (durable.casApplied !== true) {
      return createCommitResult({
        ok: false,
        status: MATERIAL_ACCOUNTING_SHADOW_COMMIT_STATUS.BLOCKED,
        reasons: ["durable-cas-not-applied"],
        store,
        event: null,
      });
    }
  } catch (error) {
    return createCommitResult({
      ok: false,
      status: MATERIAL_ACCOUNTING_SHADOW_COMMIT_STATUS.BLOCKED,
      reasons: ["durable-write-failed"],
      store,
      event: null,
    });
  }

  return createCommitResult({
    ok: true,
    status: MATERIAL_ACCOUNTING_SHADOW_COMMIT_STATUS.COMMITTED,
    reasons: [],
    store: committed.store,
    event: committed.event,
  });
}
