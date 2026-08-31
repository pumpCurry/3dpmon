/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Universal MaterialSource migration shadow preflight モジュール
 * @file dashboard_material_accounting_migration_shadow_executor.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_accounting_migration_shadow_executor
 *
 * 【機能内容サマリ】
 * - Gate 18.9C のdry-run journalからshadow execution候補をpureに評価
 * - 保存済みREADY planを信用せず、実行直前のcurrent planとrepository状態を再検証
 * - MaterialSource/SpoolMount repositoryへ書き込まないpreflight境界を提供
 *
 * 【公開関数一覧】
 * - {@link evaluateMaterialAccountingMigrationShadowPreflight}：migration shadow preflightを評価
 *
 * @version 1.390.1514 (PR #438)
 * @since   1.390.1512 (PR #438)
 * @lastModified 2026-08-31 13:59:00
 * -----------------------------------------------------------
 * @todo
 * - Gate 18.9C 後続でpersistent transaction adapterへ接続し、ここでは生成しないopenedAt/mountOperationIdを実行時に採番する
 */

"use strict";

import { createPrinterCoreV3DeterministicId } from "./dashboard_data_schema_v3.js";
import {
  MATERIAL_ACCOUNTING_MIGRATION_STATUS,
  MATERIAL_IDENTITY_STRENGTH,
} from "./dashboard_material_accounting_contract.js";
import { normalizeStoredMaterialAccountingMigrationJournal } from "./dashboard_material_accounting_migration_journal.js";
import { validateMaterialAccountingMigrationDryRunPlan } from "./dashboard_material_accounting_migration_planner.js";

/**
 * migration shadow preflight status。
 *
 * @constant {Readonly<object>}
 */
export const MATERIAL_ACCOUNTING_SHADOW_PREFLIGHT_STATUS = Object.freeze({
  READY: "ready",
  BLOCKED: "blocked",
});

/**
 * trusted shadow preflight result の参照集合。
 *
 * @constant {WeakSet<object>}
 */
const TRUSTED_SHADOW_PREFLIGHT_RESULTS = new WeakSet();

/**
 * current plan作成時刻とpreflight評価時刻の許容差。
 *
 * @constant {number}
 */
const DEFAULT_CURRENT_PLAN_MAX_AGE_MS = 5_000;

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
 * ISO日時文字列を正規化する。
 *
 * @private
 * @function normalizeOptionalIsoTime
 * @param {*} value - 日時候補。
 * @returns {?string} 有効なISO日時、またはnull。
 */
function normalizeOptionalIsoTime(value) {
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
 * JSON objectのkey順を安定化してstringifyする。
 *
 * @private
 * @function stableStringify
 * @param {*} value - stringify対象。
 * @returns {string} 安定化されたJSON文字列。
 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * migration entryから安全にplannedWritesを取り出す。
 *
 * @private
 * @function getSafePlannedWrites
 * @param {?Object} entry - migration entry候補。
 * @returns {Object} plannedWrites配列群。
 */
function getSafePlannedWrites(entry) {
  const writes = entry?.plannedWrites && typeof entry.plannedWrites === "object"
    ? entry.plannedWrites
    : {};
  return {
    filamentUnits: Array.isArray(writes.filamentUnits) ? writes.filamentUnits : [],
    materialSources: Array.isArray(writes.materialSources) ? writes.materialSources : [],
    spoolMounts: Array.isArray(writes.spoolMounts) ? writes.spoolMounts : [],
    mountCandidates: Array.isArray(writes.mountCandidates) ? writes.mountCandidates : [],
  };
}

/**
 * preflight resultを生成する。
 *
 * @private
 * @function createPreflightResult
 * @param {Object} input - result入力。
 * @param {boolean} input.ok - 成功可否。
 * @param {string} input.status - preflight status。
 * @param {string[]} input.reasons - block理由。
 * @param {?Object=} input.requested - 要求revision情報。
 * @param {?Object=} input.evaluated - 評価revision情報。
 * @param {?Object=} input.shadowExecutionPlan - shadow execution候補。
 * @param {?string=} input.evaluatedAt - preflight評価日時。
 * @returns {Object} preflight result。
 */
function createPreflightResult({
  ok,
  status,
  reasons,
  requested = null,
  evaluated = null,
  shadowExecutionPlan = null,
  evaluatedAt = null,
}) {
  const result = deepFreezeJson({
    ok,
    status,
    evaluatedAt: normalizeOptionalIsoTime(evaluatedAt),
    reasons: [...new Set(reasons.map((reason) => toTrimmedString(reason)).filter(Boolean))],
    requested: requested ? cloneJsonValue(requested) : null,
    evaluated: evaluated ? cloneJsonValue(evaluated) : null,
    shadowExecutionPlan: shadowExecutionPlan ? cloneJsonValue(shadowExecutionPlan) : null,
    invariants: {
      purePreflightOnly: true,
      materialSourceRepositoryWrites: false,
      spoolMountRepositoryWrites: false,
      ledgerWrites: false,
      executionFieldsMinted: false,
    },
  });
  if (result.ok === true &&
      result.status === MATERIAL_ACCOUNTING_SHADOW_PREFLIGHT_STATUS.READY &&
      result.shadowExecutionPlan) {
    TRUSTED_SHADOW_PREFLIGHT_RESULTS.add(result);
  }
  return result;
}

/**
 * preflight resultがこのモジュールで発行されたtrusted READY resultかを判定する。
 *
 * 【詳細説明】
 * - plain objectやcloneされたresultをauthority chainへ進めないため、runtime-only WeakSetで参照同一性を確認する。
 * - restart/reconnect後はpreflightを再実行する前提なので、永続attestationはここでは発行しない。
 *
 * @function isTrustedMaterialAccountingMigrationShadowPreflightResult
 * @param {*} value - preflight result候補。
 * @returns {boolean} trusted READY resultならtrue。
 * @example
 * const trusted = isTrustedMaterialAccountingMigrationShadowPreflightResult(result);
 */
export function isTrustedMaterialAccountingMigrationShadowPreflightResult(value) {
  return !!value &&
    typeof value === "object" &&
    TRUSTED_SHADOW_PREFLIGHT_RESULTS.has(value) &&
    value.ok === true &&
    value.status === MATERIAL_ACCOUNTING_SHADOW_PREFLIGHT_STATUS.READY;
}

/**
 * plan内のsubject entryを取得する。
 *
 * @private
 * @function findEntryBySubject
 * @param {?Object} plan - migration dry-run plan。
 * @param {string} migrationSubjectId - entry migration subject ID。
 * @returns {?Object} 該当entry。
 */
function findEntryBySubject(plan, migrationSubjectId) {
  const subject = toTrimmedString(migrationSubjectId);
  return (Array.isArray(plan?.entries) ? plan.entries : [])
    .find((entry) => toTrimmedString(entry?.migrationSubjectId) === subject) || null;
}

/**
 * entryのshadow mount候補を取得する。
 *
 * @private
 * @function getSingleMountCandidate
 * @param {?Object} entry - migration entry。
 * @returns {?Object} mount candidate。
 */
function getSingleMountCandidate(entry) {
  return getSafePlannedWrites(entry).mountCandidates[0] || null;
}

/**
 * entryのMaterialSource候補を取得する。
 *
 * @private
 * @function getSingleMaterialSource
 * @param {?Object} entry - migration entry。
 * @returns {?Object} MaterialSource候補。
 */
function getSingleMaterialSource(entry) {
  return getSafePlannedWrites(entry).materialSources[0] || null;
}

/**
 * entryのFilamentUnit候補を取得する。
 *
 * @private
 * @function getSingleFilamentUnit
 * @param {?Object} entry - migration entry。
 * @returns {?Object} FilamentUnit候補。
 */
function getSingleFilamentUnit(entry) {
  return getSafePlannedWrites(entry).filamentUnits[0] || null;
}

/**
 * repository APIがある場合にMaterialSource競合をpureに検査する。
 *
 * 【詳細説明】
 * - `upsertSource()`は呼ばず、get/resolve系APIだけを使って既存衝突を調べる。
 * - registryが渡されていない場合は、conflict未検査としてblockedへ落とす。
 *
 * @private
 * @function collectMaterialSourceRegistryReasons
 * @param {?Object} registry - MaterialSource registry API。
 * @param {Object} materialSource - 評価対象MaterialSource。
 * @returns {string[]} block理由。
 */
function collectMaterialSourceRegistryReasons(registry, materialSource) {
  const reasons = [];
  if (!registry || typeof registry !== "object") {
    return ["materialSourceRegistry-required"];
  }
  if (typeof registry.getSource !== "function" ||
      typeof registry.resolveByLocator !== "function" ||
      typeof registry.resolveByIdentity !== "function") {
    return ["materialSourceRegistry-api-invalid"];
  }
  if (!materialSource) {
    return reasons;
  }

  const existingById = registry.getSource(materialSource.materialSourceId);
  if (existingById && stableStringify(existingById) !== stableStringify(materialSource)) {
    reasons.push("material-source-registry-id-conflict");
  }

  const existingByLocator = registry.resolveByLocator(materialSource.deviceId, materialSource.locator);
  if (existingByLocator && existingByLocator.materialSourceId !== materialSource.materialSourceId) {
    reasons.push("material-source-registry-locator-conflict");
  }

  const existingByIdentity = materialSource.identityStrength === MATERIAL_IDENTITY_STRENGTH.STABLE
    ? registry.resolveByIdentity(materialSource.deviceId, materialSource.identity)
    : null;
  if (existingByIdentity && existingByIdentity.materialSourceId !== materialSource.materialSourceId) {
    reasons.push("material-source-registry-identity-conflict");
  }

  return reasons;
}

/**
 * repository APIがある場合にSpoolMount競合をpureに検査する。
 *
 * @private
 * @function collectSpoolMountRepositoryReasons
 * @param {?Object} repository - SpoolMount repository API。
 * @param {Object} candidate - mount candidate。
 * @returns {string[]} block理由。
 */
function collectSpoolMountRepositoryReasons(repository, candidate) {
  const reasons = [];
  if (!repository || typeof repository !== "object") {
    return ["spoolMountRepository-required"];
  }
  if (typeof repository.getOpenMountForSource !== "function" ||
      typeof repository.getOpenMountForSpool !== "function") {
    return ["spoolMountRepository-api-invalid"];
  }
  if (!candidate) {
    return reasons;
  }

  const openBySource = repository.getOpenMountForSource(candidate.materialSourceId);
  if (openBySource && openBySource.spoolId !== candidate.spoolId) {
    reasons.push("material-source-open-mount-conflict");
  }

  const openBySpool = repository.getOpenMountForSpool(candidate.spoolId);
  if (openBySpool && openBySpool.materialSourceId !== candidate.materialSourceId) {
    reasons.push("spool-open-mount-conflict");
  }

  return reasons;
}

/**
 * 保存journal entryとlatest subject indexの整合を検査する。
 *
 * @private
 * @function collectLatestRevisionReasons
 * @param {Object} input - 検査入力。
 * @param {Object} input.latest - subject index entry。
 * @param {Object} input.journalEntry - journal entry。
 * @param {?Object} input.requestedEntry - journal内の対象subject entry。
 * @param {?string=} input.requestedMigrationId - 呼び出し側が指定したmigration ID。
 * @returns {string[]} block理由。
 */
function collectLatestRevisionReasons({
  latest,
  journalEntry,
  requestedEntry,
  requestedMigrationId = null,
}) {
  const reasons = [];
  const requested = toTrimmedString(requestedMigrationId);
  if (requested && requested !== latest.migrationId) {
    reasons.push("requested-revision-not-latest");
  }
  if (latest.migrationId !== journalEntry.migrationId) {
    reasons.push("latest-revision-migrationId-mismatch");
  }
  if (latest.planRevisionId !== journalEntry.plan?.planRevisionId) {
    reasons.push("latest-revision-planRevisionId-mismatch");
  }
  if (latest.sourceChecksum !== journalEntry.sourceChecksum) {
    reasons.push("latest-revision-sourceChecksum-mismatch");
  }
  if (latest.planDigest !== journalEntry.planDigest) {
    reasons.push("latest-revision-planDigest-mismatch");
  }
  if (latest.migrationStatus !== requestedEntry?.migrationStatus) {
    reasons.push("latest-revision-status-mismatch");
  }
  return reasons;
}

/**
 * current planがpreflight評価時点に近いかを検査する。
 *
 * @private
 * @function collectCurrentPlanTimeReasons
 * @param {Object} input - 検査入力。
 * @param {?Object} input.currentPlan - current plan候補。
 * @param {?string} input.evaluatedAt - preflight評価日時。
 * @param {number=} input.maxCurrentPlanAgeMs - 許容差。
 * @returns {string[]} block理由。
 */
function collectCurrentPlanTimeReasons({
  currentPlan,
  evaluatedAt,
  maxCurrentPlanAgeMs = DEFAULT_CURRENT_PLAN_MAX_AGE_MS,
}) {
  const reasons = [];
  const evaluatedMs = toTimeMs(evaluatedAt);
  const createdMs = toTimeMs(currentPlan?.createdAt);
  if (evaluatedMs === null) {
    reasons.push("evaluatedAt-required");
  }
  if (createdMs === null) {
    reasons.push("current-plan-createdAt-required");
  }
  if (evaluatedMs !== null && createdMs !== null) {
    const ageMs = evaluatedMs - createdMs;
    if (ageMs < 0 || ageMs > maxCurrentPlanAgeMs) {
      reasons.push("current-plan-not-fresh-for-preflight");
    }
  }
  return reasons;
}

/**
 * requested entryとcurrent evaluated entryの同一性を検査する。
 *
 * 【詳細説明】
 * - createdAtを含むrevision IDは実行直前re-planで変わり得るため一致を要求しない。
 * - 代わりにentry subject、device/source/spool mapping、planned source graphが同じことを要求する。
 *
 * @private
 * @function collectEntryContinuityReasons
 * @param {?Object} requestedEntry - journal上のREADY entry。
 * @param {?Object} evaluatedEntry - current plan上のREADY entry。
 * @returns {string[]} block理由。
 */
function collectEntryContinuityReasons(requestedEntry, evaluatedEntry) {
  const reasons = [];
  const requestedSource = getSingleMaterialSource(requestedEntry);
  const evaluatedSource = getSingleMaterialSource(evaluatedEntry);
  const requestedUnit = getSingleFilamentUnit(requestedEntry);
  const evaluatedUnit = getSingleFilamentUnit(evaluatedEntry);
  const requestedCandidate = getSingleMountCandidate(requestedEntry);
  const evaluatedCandidate = getSingleMountCandidate(evaluatedEntry);

  if (!requestedEntry || requestedEntry.migrationStatus !== MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY) {
    reasons.push("requested-entry-not-ready");
  }
  if (!evaluatedEntry || evaluatedEntry.migrationStatus !== MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY) {
    reasons.push("evaluated-entry-not-ready");
  }
  if (toTrimmedString(requestedEntry?.deviceId) !== toTrimmedString(evaluatedEntry?.deviceId)) {
    reasons.push("entry-device-mismatch");
  }
  if (toTrimmedString(requestedEntry?.spoolId) !== toTrimmedString(evaluatedEntry?.spoolId)) {
    reasons.push("entry-spool-mismatch");
  }
  if (!evaluatedSource || evaluatedSource.identityStrength !== MATERIAL_IDENTITY_STRENGTH.STABLE) {
    reasons.push("evaluated-source-identity-not-stable");
  }
  if (toTrimmedString(requestedSource?.materialSourceId) !== toTrimmedString(evaluatedSource?.materialSourceId)) {
    reasons.push("entry-materialSourceId-mismatch");
  }
  if (toTrimmedString(requestedUnit?.unitId) !== toTrimmedString(evaluatedUnit?.unitId)) {
    reasons.push("entry-filamentUnitId-mismatch");
  }
  if (toTrimmedString(requestedCandidate?.materialSourceId) !== toTrimmedString(evaluatedCandidate?.materialSourceId)) {
    reasons.push("entry-mountCandidate-source-mismatch");
  }
  if (toTrimmedString(requestedCandidate?.spoolId) !== toTrimmedString(evaluatedCandidate?.spoolId)) {
    reasons.push("entry-mountCandidate-spool-mismatch");
  }
  if (evaluatedCandidate?.openedAt !== undefined || evaluatedCandidate?.mountOperationId !== undefined) {
    reasons.push("entry-mountCandidate-execution-fields-present");
  }
  return reasons;
}

/**
 * shadow execution planをpureに生成する。
 *
 * @private
 * @function createShadowExecutionPlan
 * @param {Object} input - execution plan入力。
 * @param {string} input.migrationSubjectId - entry subject ID。
 * @param {Object} input.journalEntry - journal entry。
 * @param {Object} input.currentPlan - current dry-run plan。
 * @param {Object} input.currentEntry - current READY entry。
 * @returns {Object} shadow execution plan。
 */
function createShadowExecutionPlan({ migrationSubjectId, journalEntry, currentPlan, currentEntry }) {
  const plannedWrites = getSafePlannedWrites(currentEntry);
  return {
    schemaVersion: 1,
    shadowExecutionId: createPrinterCoreV3DeterministicId("material-accounting-shadow-preflight", [
      migrationSubjectId,
      journalEntry.migrationId,
      currentPlan.planRevisionId,
      currentEntry.deviceId,
      currentEntry.spoolId,
      plannedWrites.materialSources[0]?.materialSourceId || null,
    ]),
    migrationSubjectId,
    migrationId: journalEntry.migrationId,
    derivedFromPlanRevisionId: journalEntry.plan?.planRevisionId || null,
    evaluatedPlanRevisionId: currentPlan.planRevisionId,
    deviceId: currentEntry.deviceId,
    spoolId: currentEntry.spoolId,
    plannedWrites: {
      filamentUnits: plannedWrites.filamentUnits.map((unit) => cloneJsonValue(unit)),
      materialSources: plannedWrites.materialSources.map((source) => cloneJsonValue(source)),
      spoolMounts: [],
      mountIntents: plannedWrites.mountCandidates.map((candidate) => cloneJsonValue(candidate)),
    },
    authority: {
      mode: "shadow-preflight-only",
      canWriteRepositories: false,
      canDebitLedger: false,
    },
  };
}

/**
 * migration shadow preflightを評価する。
 *
 * 【詳細説明】
 * - dry-run journalのlatest subject indexから要求entryを解決する。
 * - current dry-run planを再検証し、同じentry subjectが今もREADYか確認する。
 * - repositoryはread-only APIだけを参照し、Source/Mount衝突が見えた場合はblockedにする。
 * - この関数はopenedAtやmountOperationIdを採番せず、repository/ledgerへ一切書き込まない。
 *
 * @function evaluateMaterialAccountingMigrationShadowPreflight
 * @param {Object} input - preflight入力。
 * @param {Object} input.journal - migration dry-run journal。
 * @param {string} input.migrationSubjectId - entry migration subject ID。
 * @param {Object} input.currentPlan - 実行直前に再生成したdry-run plan。
 * @param {string=} input.requestedMigrationId - 明示要求されたmigration ID。
 * @param {Object} input.materialSourceRegistry - read-only参照するMaterialSource registry API。
 * @param {Object} input.spoolMountRepository - read-only参照するSpoolMount repository API。
 * @param {string|Date} input.evaluatedAt - preflight評価日時。
 * @param {number=} input.maxCurrentPlanAgeMs - current plan作成時刻とpreflight評価時刻の許容差。
 * @returns {Object} preflight result。
 * @example
 * const result = evaluateMaterialAccountingMigrationShadowPreflight({ journal, migrationSubjectId, currentPlan });
 */
export function evaluateMaterialAccountingMigrationShadowPreflight(input = {}) {
  const evaluatedAt = normalizeOptionalIsoTime(input.evaluatedAt);
  const migrationSubjectId = toTrimmedString(input.migrationSubjectId);
  if (!migrationSubjectId) {
    return createPreflightResult({
      ok: false,
      status: MATERIAL_ACCOUNTING_SHADOW_PREFLIGHT_STATUS.BLOCKED,
      reasons: ["migrationSubjectId-required"],
      evaluatedAt,
    });
  }

  const journal = normalizeStoredMaterialAccountingMigrationJournal(input.journal);
  const latest = journal.latestRevisionBySubject?.[migrationSubjectId] || null;
  if (!latest) {
    return createPreflightResult({
      ok: false,
      status: MATERIAL_ACCOUNTING_SHADOW_PREFLIGHT_STATUS.BLOCKED,
      reasons: ["journal-subject-revision-not-found"],
      requested: { migrationSubjectId },
      evaluatedAt,
    });
  }

  const journalEntry = journal.byMigrationId?.[latest.migrationId] || null;
  if (!journalEntry) {
    return createPreflightResult({
      ok: false,
      status: MATERIAL_ACCOUNTING_SHADOW_PREFLIGHT_STATUS.BLOCKED,
      reasons: ["journal-entry-not-found"],
      requested: { migrationSubjectId, ...cloneJsonValue(latest) },
      evaluatedAt,
    });
  }

  const currentValidation = validateMaterialAccountingMigrationDryRunPlan(input.currentPlan);
  const currentEntry = findEntryBySubject(input.currentPlan, migrationSubjectId);
  const requestedEntry = findEntryBySubject(journalEntry.plan, migrationSubjectId);
  const latestReasons = collectLatestRevisionReasons({
    latest,
    journalEntry,
    requestedEntry,
    requestedMigrationId: input.requestedMigrationId,
  });
  const continuityReasons = collectEntryContinuityReasons(requestedEntry, currentEntry);
  const timeReasons = collectCurrentPlanTimeReasons({
    currentPlan: input.currentPlan,
    evaluatedAt,
    maxCurrentPlanAgeMs: input.maxCurrentPlanAgeMs,
  });
  const materialSourceReasons = collectMaterialSourceRegistryReasons(
    input.materialSourceRegistry,
    getSingleMaterialSource(currentEntry),
  );
  const spoolMountReasons = collectSpoolMountRepositoryReasons(
    input.spoolMountRepository,
    getSingleMountCandidate(currentEntry),
  );
  const reasons = [
    ...latestReasons,
    ...(!currentValidation.ok ? currentValidation.errors.map((error) => `current-plan:${error}`) : []),
    ...timeReasons,
    ...continuityReasons,
    ...materialSourceReasons,
    ...spoolMountReasons,
  ];

  const requested = {
    migrationSubjectId,
    migrationId: journalEntry.migrationId,
    planRevisionId: journalEntry.plan?.planRevisionId || null,
    sourceChecksum: journalEntry.sourceChecksum,
    planDigest: journalEntry.planDigest,
    migrationStatus: requestedEntry?.migrationStatus || null,
  };
  const evaluated = {
    migrationSubjectId,
    migrationId: input.currentPlan?.migrationId || null,
    planRevisionId: input.currentPlan?.planRevisionId || null,
    migrationStatus: currentEntry?.migrationStatus || null,
  };

  if (reasons.length > 0) {
    return createPreflightResult({
      ok: false,
      status: MATERIAL_ACCOUNTING_SHADOW_PREFLIGHT_STATUS.BLOCKED,
      reasons,
      requested,
      evaluated,
      evaluatedAt,
    });
  }

  return createPreflightResult({
    ok: true,
    status: MATERIAL_ACCOUNTING_SHADOW_PREFLIGHT_STATUS.READY,
    reasons: [],
    requested,
    evaluated,
    evaluatedAt,
    shadowExecutionPlan: createShadowExecutionPlan({
      migrationSubjectId,
      journalEntry,
      currentPlan: input.currentPlan,
      currentEntry,
    }),
  });
}
