/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Universal MaterialSource migration shadow transaction モジュール
 * @file dashboard_material_accounting_migration_shadow_transaction.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_accounting_migration_shadow_transaction
 *
 * 【機能内容サマリ】
 * - Gate 18.9D のshadow migration transaction候補をstaged repository上で準備
 * - preflight通過済みmount intentから実行時SpoolMount recordを生成
 * - production保存やledger debitへ直結しないatomic候補snapshotを返す
 *
 * 【公開関数一覧】
 * - {@link prepareMaterialAccountingMigrationShadowTransaction}：shadow transaction候補を準備
 * - {@link isTrustedMaterialAccountingMigrationShadowTransaction}：trusted transactionかを判定
 *
 * @version 1.390.1515 (PR #438)
 * @since   1.390.1513 (PR #438)
 * @lastModified 2026-08-31 14:10:00
 * -----------------------------------------------------------
 * @todo
 * - Gate 18.9D 後続でstaged snapshotをIndexedDB transactionへ接続し、commit/rollback境界を実装する
 */

"use strict";

import { createPrinterCoreV3DeterministicId } from "./dashboard_data_schema_v3.js";
import {
  MATERIAL_ACCOUNTING_MIGRATION_STATUS,
  SPOOL_MOUNT_STATUS,
  createSpoolMountRecord,
} from "./dashboard_material_accounting_contract.js";
import {
  MATERIAL_ACCOUNTING_SHADOW_PREFLIGHT_STATUS,
  isTrustedMaterialAccountingMigrationShadowPreflightResult,
} from "./dashboard_material_accounting_migration_shadow_executor.js";
import { createMaterialSourceRegistry } from "./dashboard_material_source_registry.js";
import { createSpoolMountRepository } from "./dashboard_spool_mount_repository.js";

/**
 * trusted shadow transaction の参照集合。
 *
 * @constant {WeakSet<object>}
 */
const TRUSTED_SHADOW_TRANSACTIONS = new WeakSet();

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
  if (!value || typeof value !== "object") {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreezeJson(child);
  }
  return value;
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
  return value === null || value === undefined ? "" : String(value).trim();
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
 * ISO日時文字列をmillisecondsへ変換する。
 *
 * @private
 * @function toTimeMs
 * @param {?string} value - ISO日時。
 * @returns {?number} milliseconds。無効な場合はnull。
 */
function toTimeMs(value) {
  if (!value) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * transaction resultを生成する。
 *
 * @private
 * @function createTransactionResult
 * @param {Object} input - result入力。
 * @param {boolean} input.ok - 成功可否。
 * @param {string} input.status - prepared/blocked。
 * @param {string[]} input.reasons - block理由。
 * @param {?Object=} input.transaction - transaction候補。
 * @returns {Object} transaction result。
 */
function createTransactionResult({
  ok,
  status,
  reasons,
  transaction = null,
}) {
  const result = deepFreezeJson({
    ok,
    status,
    reasons: [...new Set((reasons || []).map((reason) => toTrimmedString(reason)).filter(Boolean))],
    transaction: transaction ? cloneJsonValue(transaction) : null,
    invariants: {
      productionAuthority: false,
      stagedRepositoryOnly: true,
      materialSourceRepositoryWrites: false,
      spoolMountRepositoryWrites: false,
      ledgerWrites: false,
    },
  });
  if (result.ok === true && result.status === "prepared" && result.transaction) {
    TRUSTED_SHADOW_TRANSACTIONS.add(result.transaction);
  }
  return result;
}

/**
 * transactionがこのモジュールで発行されたtrusted prepared resultかを判定する。
 *
 * 【詳細説明】
 * - plain objectやcloneされたtransactionをcommit境界へ進ませないため、runtime-only WeakSetで参照同一性を確認する。
 * - restart/reconnect後はpreflightとstagingを再実行する前提なので、永続transaction attestationは発行しない。
 *
 * @function isTrustedMaterialAccountingMigrationShadowTransaction
 * @param {*} value - transaction候補。
 * @returns {boolean} trusted prepared transactionならtrue。
 * @example
 * const trusted = isTrustedMaterialAccountingMigrationShadowTransaction(transaction);
 */
export function isTrustedMaterialAccountingMigrationShadowTransaction(value) {
  return !!value &&
    typeof value === "object" &&
    TRUSTED_SHADOW_TRANSACTIONS.has(value) &&
    value.transactionStatus === "prepared" &&
    value.proposedMigrationStatus === MATERIAL_ACCOUNTING_MIGRATION_STATUS.SHADOW;
}

/**
 * snapshotからMaterialSource配列を取り出す。
 *
 * @private
 * @function listSnapshotSources
 * @param {?Object} snapshot - registry snapshot候補。
 * @returns {Object[]} source配列。
 */
function listSnapshotSources(snapshot) {
  return Array.isArray(snapshot?.sources)
    ? snapshot.sources.map((source) => cloneJsonValue(source))
    : [];
}

/**
 * snapshotからSpoolMount配列を取り出す。
 *
 * @private
 * @function listSnapshotMounts
 * @param {?Object} snapshot - repository snapshot候補。
 * @returns {Object[]} mount配列。
 */
function listSnapshotMounts(snapshot) {
  return Array.isArray(snapshot?.mounts)
    ? snapshot.mounts.map((mount) => cloneJsonValue(mount))
    : [];
}

/**
 * repository snapshotの外形と既存conflictを検査する。
 *
 * 【詳細説明】
 * - transaction層はproduction commit直前の候補であり、snapshot未指定を「空の本番状態」と解釈しない。
 * - 既存conflict evidenceがsnapshotに残っている場合、staged repository生成で消える前にblockedへ落とす。
 *
 * @private
 * @function collectSnapshotReasons
 * @param {Object} input - 検査入力。
 * @param {*} input.materialSourceRegistrySnapshot - MaterialSource registry snapshot。
 * @param {*} input.spoolMountRepositorySnapshot - SpoolMount repository snapshot。
 * @returns {string[]} block理由。
 */
function collectSnapshotReasons({
  materialSourceRegistrySnapshot,
  spoolMountRepositorySnapshot,
}) {
  const reasons = [];
  if (!materialSourceRegistrySnapshot || typeof materialSourceRegistrySnapshot !== "object") {
    reasons.push("materialSourceRegistrySnapshot-required");
  } else {
    if (!Array.isArray(materialSourceRegistrySnapshot.sources)) {
      reasons.push("materialSourceRegistrySnapshot-sources-required");
    }
    if (!Array.isArray(materialSourceRegistrySnapshot.conflicts)) {
      reasons.push("materialSourceRegistrySnapshot-conflicts-required");
    } else if (materialSourceRegistrySnapshot.conflicts.length > 0) {
      reasons.push("materialSourceRegistrySnapshot-conflicts-present");
    }
  }

  if (!spoolMountRepositorySnapshot || typeof spoolMountRepositorySnapshot !== "object") {
    reasons.push("spoolMountRepositorySnapshot-required");
  } else {
    if (!Array.isArray(spoolMountRepositorySnapshot.mounts)) {
      reasons.push("spoolMountRepositorySnapshot-mounts-required");
    }
    if (!Array.isArray(spoolMountRepositorySnapshot.conflicts)) {
      reasons.push("spoolMountRepositorySnapshot-conflicts-required");
    } else if (spoolMountRepositorySnapshot.conflicts.length > 0) {
      reasons.push("spoolMountRepositorySnapshot-conflicts-present");
    }
  }
  return reasons;
}

/**
 * preflight resultがtransaction準備可能かを検査する。
 *
 * @private
 * @function collectPreflightReasons
 * @param {?Object} preflightResult - preflight result候補。
 * @returns {string[]} block理由。
 */
function collectPreflightReasons(preflightResult) {
  const reasons = [];
  if (!preflightResult || typeof preflightResult !== "object") {
    return ["preflight-not-ready"];
  }
  if (preflightResult.ok !== true ||
      preflightResult.status !== MATERIAL_ACCOUNTING_SHADOW_PREFLIGHT_STATUS.READY ||
      !preflightResult.shadowExecutionPlan) {
    reasons.push("preflight-not-ready");
  }
  if (preflightResult.ok === true &&
      preflightResult.status === MATERIAL_ACCOUNTING_SHADOW_PREFLIGHT_STATUS.READY &&
      preflightResult.shadowExecutionPlan &&
      !isTrustedMaterialAccountingMigrationShadowPreflightResult(preflightResult)) {
    reasons.push("preflight-result-untrusted");
  }
  const executionPlan = preflightResult.shadowExecutionPlan;
  if (executionPlan?.authority?.canWriteRepositories !== false ||
      executionPlan?.authority?.canDebitLedger !== false) {
    reasons.push("preflight-authority-invalid");
  }
  if (!toTrimmedString(executionPlan?.migrationSubjectId) ||
      !toTrimmedString(executionPlan?.migrationId) ||
      !toTrimmedString(executionPlan?.derivedFromPlanRevisionId) ||
      !toTrimmedString(executionPlan?.evaluatedPlanRevisionId)) {
    reasons.push("preflight-revision-fields-required");
  }
  return reasons;
}

/**
 * shadow mount operation IDを生成する。
 *
 * @private
 * @function createShadowMountOperationId
 * @param {Object} input - ID入力。
 * @param {string} input.shadowOperationId - shadow operation ID。
 * @param {Object} input.candidate - mount intent。
 * @returns {string} mount operation ID。
 */
function createShadowMountOperationId({ shadowOperationId, candidate }) {
  return createPrinterCoreV3DeterministicId("material-accounting-shadow-mount", [
    shadowOperationId,
    candidate.materialSourceId,
    candidate.spoolId,
  ]);
}

/**
 * shadow transaction IDを生成する。
 *
 * @private
 * @function createShadowTransactionId
 * @param {Object} input - ID入力。
 * @param {Object} input.executionPlan - preflight execution plan。
 * @param {string} input.shadowOperationId - shadow operation ID。
 * @param {string} input.executedAt - 実行日時。
 * @param {Object[]} input.spoolMounts - staged SpoolMount配列。
 * @returns {string} transaction ID。
 */
function createShadowTransactionId({ executionPlan, shadowOperationId, executedAt, spoolMounts }) {
  return createPrinterCoreV3DeterministicId("material-accounting-shadow-transaction", [
    executionPlan.shadowExecutionId,
    shadowOperationId,
    executedAt,
    spoolMounts.map((mount) => mount.mountId),
  ]);
}

/**
 * mount intentから実行時SpoolMount recordを生成する。
 *
 * 【詳細説明】
 * - dry-run plannerやpreflightでは禁止していた`openedAt`と`mountOperationId`を、このtransaction準備層で初めて採番する。
 * - 返したrecordはまだproduction storeへcommitされておらず、staged repository検査対象に留まる。
 *
 * @private
 * @function createShadowSpoolMountRecord
 * @param {Object} input - mount生成入力。
 * @param {Object} input.candidate - mount intent。
 * @param {string} input.shadowOperationId - shadow operation ID。
 * @param {string} input.executedAt - 実行日時。
 * @param {string} input.executedBy - 実行者。
 * @returns {Object} SpoolMount record。
 */
function createShadowSpoolMountRecord({ candidate, shadowOperationId, executedAt, executedBy }) {
  return createSpoolMountRecord({
    materialSourceId: candidate.materialSourceId,
    spoolId: candidate.spoolId,
    status: SPOOL_MOUNT_STATUS.OPEN,
    verification: candidate.verification,
    sourceIdentityStrengthAtOpen: candidate.sourceIdentityStrengthAtOpen,
    expectedRfid: candidate.expectedRfid,
    openedAt: executedAt,
    openedBy: executedBy || candidate.openedBy || "migration-shadow-executor",
    mountOperationId: createShadowMountOperationId({ shadowOperationId, candidate }),
  });
}

/**
 * sourceをstaged registryへ投入する。
 *
 * @private
 * @function stageMaterialSources
 * @param {Object} registry - staged registry API。
 * @param {Object[]} materialSources - MaterialSource配列。
 * @returns {{ok:boolean,reasons:string[],snapshot:?Object}} staged結果。
 */
function stageMaterialSources(registry, materialSources) {
  for (const source of materialSources) {
    const result = registry.upsertSource(source);
    if (!result.ok) {
      return {
        ok: false,
        reasons: ["material-source-registry-conflict"],
        snapshot: null,
      };
    }
  }
  return {
    ok: true,
    reasons: [],
    snapshot: registry.toJSON(),
  };
}

/**
 * mountをstaged repositoryへ投入する。
 *
 * @private
 * @function stageSpoolMounts
 * @param {Object} repository - staged repository API。
 * @param {Object[]} spoolMounts - SpoolMount配列。
 * @returns {{ok:boolean,reasons:string[],snapshot:?Object}} staged結果。
 */
function stageSpoolMounts(repository, spoolMounts) {
  for (const mount of spoolMounts) {
    const result = repository.recordMount(mount);
    if (!result.ok) {
      return {
        ok: false,
        reasons: ["spool-mount-repository-conflict"],
        snapshot: null,
      };
    }
  }
  return {
    ok: true,
    reasons: [],
    snapshot: repository.toJSON(),
  };
}

/**
 * staged MaterialSource registryを安全に生成する。
 *
 * @private
 * @function createStagedMaterialSourceRegistryResult
 * @param {Object} snapshot - MaterialSource registry snapshot。
 * @returns {{ok:boolean,reasons:string[],registry:?Object}} 生成結果。
 */
function createStagedMaterialSourceRegistryResult(snapshot) {
  try {
    return {
      ok: true,
      reasons: [],
      registry: createMaterialSourceRegistry(listSnapshotSources(snapshot)),
    };
  } catch (error) {
    return {
      ok: false,
      reasons: ["materialSourceRegistrySnapshot-invalid"],
      registry: null,
    };
  }
}

/**
 * staged SpoolMount repositoryを安全に生成する。
 *
 * @private
 * @function createStagedSpoolMountRepositoryResult
 * @param {Object} snapshot - SpoolMount repository snapshot。
 * @returns {{ok:boolean,reasons:string[],repository:?Object}} 生成結果。
 */
function createStagedSpoolMountRepositoryResult(snapshot) {
  try {
    return {
      ok: true,
      reasons: [],
      repository: createSpoolMountRepository(listSnapshotMounts(snapshot)),
    };
  } catch (error) {
    return {
      ok: false,
      reasons: ["spoolMountRepositorySnapshot-invalid"],
      repository: null,
    };
  }
}

/**
 * shadow transaction候補を準備する。
 *
 * 【詳細説明】
 * - preflight済みのshadowExecutionPlanだけを入力権威として扱う。
 * - 既存repository snapshotからstaged repositoryを作り、source登録とmount登録を順番に検証する。
 * - 途中で失敗した場合はpartial transactionを返さず、呼び出し側がproduction storeへ書けない形でblockedを返す。
 *
 * @function prepareMaterialAccountingMigrationShadowTransaction
 * @param {Object} input - transaction準備入力。
 * @param {Object} input.preflightResult - READY preflight result。
 * @param {string} input.shadowOperationId - operator/session由来の冪等operation ID。
 * @param {string} input.executedAt - transaction準備日時。
 * @param {string=} input.executedBy - 実行者。
 * @param {Object} input.materialSourceRegistrySnapshot - 既存MaterialSource registry snapshot。
 * @param {Object} input.spoolMountRepositorySnapshot - 既存SpoolMount repository snapshot。
 * @returns {Object} prepared/blocked result。
 * @example
 * const result = prepareMaterialAccountingMigrationShadowTransaction({ preflightResult, shadowOperationId, executedAt });
 */
export function prepareMaterialAccountingMigrationShadowTransaction(input = {}) {
  const shadowOperationId = toTrimmedString(input.shadowOperationId);
  const executedAt = normalizeRequiredIsoTime(input.executedAt);
  const preflightEvaluatedAt = normalizeRequiredIsoTime(input.preflightResult?.evaluatedAt);
  const preflightReasons = collectPreflightReasons(input.preflightResult);
  const inputReasons = [];
  if (!shadowOperationId) {
    inputReasons.push("shadowOperationId-required");
  }
  if (!executedAt) {
    inputReasons.push("executedAt-invalid");
  }
  if (!preflightEvaluatedAt) {
    inputReasons.push("preflight-evaluatedAt-required");
  } else if (executedAt && toTimeMs(executedAt) < toTimeMs(preflightEvaluatedAt)) {
    inputReasons.push("executedAt-before-preflight-evaluatedAt");
  }
  const preflightPlan = input.preflightResult?.shadowExecutionPlan || null;
  const materialSources = Array.isArray(preflightPlan?.plannedWrites?.materialSources)
    ? preflightPlan.plannedWrites.materialSources.map((source) => cloneJsonValue(source))
    : [];
  const mountIntents = Array.isArray(preflightPlan?.plannedWrites?.mountIntents)
    ? preflightPlan.plannedWrites.mountIntents.map((candidate) => cloneJsonValue(candidate))
    : [];
  if (materialSources.length < 1) {
    inputReasons.push("materialSources-required");
  }
  if (mountIntents.length < 1) {
    inputReasons.push("mountIntents-required");
  }

  const snapshotReasons = collectSnapshotReasons({
    materialSourceRegistrySnapshot: input.materialSourceRegistrySnapshot,
    spoolMountRepositorySnapshot: input.spoolMountRepositorySnapshot,
  });
  const reasons = [...preflightReasons, ...inputReasons, ...snapshotReasons];
  if (reasons.length > 0) {
    return createTransactionResult({
      ok: false,
      status: "blocked",
      reasons,
      transaction: null,
    });
  }

  const stagedSourceRegistry = createStagedMaterialSourceRegistryResult(input.materialSourceRegistrySnapshot);
  const stagedMountRepository = createStagedSpoolMountRepositoryResult(input.spoolMountRepositorySnapshot);
  if (!stagedSourceRegistry.ok || !stagedMountRepository.ok) {
    return createTransactionResult({
      ok: false,
      status: "blocked",
      reasons: [
        ...stagedSourceRegistry.reasons,
        ...stagedMountRepository.reasons,
      ],
      transaction: null,
    });
  }

  const sourceStage = stageMaterialSources(stagedSourceRegistry.registry, materialSources);
  if (!sourceStage.ok) {
    return createTransactionResult({
      ok: false,
      status: "blocked",
      reasons: sourceStage.reasons,
      transaction: null,
    });
  }

  const spoolMounts = mountIntents.map((candidate) => createShadowSpoolMountRecord({
    candidate,
    shadowOperationId,
    executedAt,
    executedBy: toTrimmedString(input.executedBy) || "migration-shadow-executor",
  }));
  const mountStage = stageSpoolMounts(stagedMountRepository.repository, spoolMounts);
  if (!mountStage.ok) {
    return createTransactionResult({
      ok: false,
      status: "blocked",
      reasons: mountStage.reasons,
      transaction: null,
    });
  }

  const transaction = {
    schemaVersion: 1,
    transactionId: createShadowTransactionId({
      executionPlan: preflightPlan,
      shadowOperationId,
      executedAt,
      spoolMounts,
    }),
    shadowOperationId,
    shadowExecutionId: preflightPlan.shadowExecutionId,
    migrationSubjectId: preflightPlan.migrationSubjectId,
    migrationId: preflightPlan.migrationId,
    derivedFromPlanRevisionId: preflightPlan.derivedFromPlanRevisionId,
    evaluatedPlanRevisionId: preflightPlan.evaluatedPlanRevisionId,
    transactionStatus: "prepared",
    proposedMigrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.SHADOW,
    deviceId: preflightPlan.deviceId,
    spoolId: preflightPlan.spoolId,
    executedAt,
    executedBy: toTrimmedString(input.executedBy) || "migration-shadow-executor",
    records: {
      filamentUnits: cloneJsonValue(preflightPlan.plannedWrites.filamentUnits || []),
      materialSources,
      spoolMounts,
    },
    repositorySnapshots: {
      materialSources: sourceStage.snapshot,
      spoolMounts: mountStage.snapshot,
    },
    invariants: {
      productionAuthority: false,
      stagedRepositoryOnly: true,
      materialSourceRepositoryWrites: false,
      spoolMountRepositoryWrites: false,
      ledgerWrites: false,
    },
  };

  return createTransactionResult({
    ok: true,
    status: "prepared",
    reasons: [],
    transaction,
  });
}
