/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Universal MaterialSource migration planner モジュール
 * @file dashboard_material_accounting_migration_planner.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_accounting_migration_planner
 *
 * 【機能内容サマリ】
 * - legacy hostSpoolMap を Universal MaterialSource accounting へ移す前のdry-run planを生成
 * - K1 direct-onlyとK2/CFS multi-sourceをprinterTypeではなくsource数と観測証跡で分類
 * - multi-source機器へlegacy 1本スプールをblind migrationしないfail-closed境界を提供
 *
 * 【公開関数一覧】
 * - {@link createMaterialAccountingMigrationDryRunPlan}：legacy dataからdry-run planを生成
 * - {@link validateMaterialAccountingMigrationDryRunPlan}：dry-run planを検証
 *
 * @version 1.390.1504 (PR #438)
 * @since   1.390.1502 (PR #438)
 * @lastModified 2026-08-31 11:58:00
 * -----------------------------------------------------------
 * @todo
 * - Gate 18.9A review後にIndexedDB backed migration journalへ接続する
 */

"use strict";

import {
  FILAMENT_UNIT_KIND,
  MATERIAL_ACCOUNTING_MIGRATION_BLOCKER,
  MATERIAL_ACCOUNTING_MIGRATION_STATUS,
  MATERIAL_IDENTITY_STRENGTH,
  MATERIAL_SOURCE_KIND,
  SPOOL_MOUNT_STATUS,
  SPOOL_MOUNT_VERIFICATION,
  createDirectFeedUnitIdentity,
  createFilamentUnitRecord,
  createMaterialSourceIdentity,
  createMaterialSourceLocator,
  createMaterialSourceRecord,
  createSpoolMountRecord,
  validateMaterialSource,
  validateSpoolMount,
} from "./dashboard_material_accounting_contract.js";
import {
  createPrinterCoreV3DeterministicId,
  stableStringifyPrinterCoreV3Value,
} from "./dashboard_data_schema_v3.js";

/**
 * Material accounting migration dry-run plan のschema version。
 *
 * @constant {number}
 */
export const MATERIAL_ACCOUNTING_MIGRATION_PLAN_SCHEMA_VERSION = 1;

/**
 * dry-run plannerが直接返してよいmigration status集合。
 *
 * 【詳細説明】
 * - `SHADOW` / `FAILED` / `SEALED` は実行transactionやrepository failureの結果であり、dry-run分析だけでは発行しない。
 *
 * @constant {ReadonlySet<string>}
 */
const DRY_RUN_DECISION_STATUSES = Object.freeze(new Set([
  MATERIAL_ACCOUNTING_MIGRATION_STATUS.PLANNED,
  MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE,
  MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY,
  MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
]));

/**
 * migration plannerがfresh topologyとして扱う既定TTL。
 *
 * @constant {number}
 */
const DEFAULT_MIGRATION_TOPOLOGY_FRESH_TTL_MS = 60_000;

/**
 * JSON互換値をcloneする。
 *
 * 【詳細説明】
 * - dry-run planは呼び出し側mutationで意味が変わると危険なため、返却前にclone/freezeする。
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
 * JSON互換値を再帰freezeする。
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
 * 空でない文字列へ正規化する。
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
 * optional ISO日時へ正規化する。
 *
 * @private
 * @function normalizeOptionalIsoTime
 * @param {*} value - 日時候補。
 * @returns {?string} ISO日時、またはnull。
 */
function normalizeOptionalIsoTime(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * 有限数へ正規化する。
 *
 * @private
 * @function toFiniteNumber
 * @param {*} value - 数値候補。
 * @param {?number} fallback - fallback値。
 * @returns {?number} 有限数、またはfallback。
 */
function toFiniteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

/**
 * object mapらしい値を返す。
 *
 * @private
 * @function asPlainObject
 * @param {*} value - object候補。
 * @returns {Object} plain object、または空object。
 */
function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * enum値集合を生成する。
 *
 * @private
 * @function enumValues
 * @param {Object} value - enum object。
 * @returns {Set<string>} enum値集合。
 */
function enumValues(value) {
  return new Set(Object.values(value));
}

/**
 * printerTypeを小文字へ正規化する。
 *
 * @private
 * @function normalizePrinterType
 * @param {*} value - printerType候補。
 * @returns {string} 正規化済みprinterType。
 */
function normalizePrinterType(value) {
  return toTrimmedString(value).toLowerCase();
}

/**
 * legacy connectionTargetsを安全な配列へ正規化する。
 *
 * @private
 * @function getConnectionTargets
 * @param {Object} legacyData - legacy monitorData。
 * @returns {Array<Object>} connection target配列。
 */
function getConnectionTargets(legacyData) {
  const targets = legacyData?.appSettings?.connectionTargets;
  return Array.isArray(targets) ? targets : [];
}

/**
 * hostに対応するlegacy connection targetを探す。
 *
 * 【詳細説明】
 * - hostname key移行前後のデータを拾うため、hostnameとdest prefixの両方を見る。
 *
 * @private
 * @function findConnectionTargetForHost
 * @param {Array<Object>} targets - connection target配列。
 * @param {string} host - legacy host key。
 * @returns {?Object} connection target、またはnull。
 */
function findConnectionTargetForHost(targets, host) {
  return targets.find((target) => {
    const hostname = toTrimmedString(target?.hostname);
    const dest = toTrimmedString(target?.dest);
    return hostname === host || dest === host || dest.startsWith(`${host}:`);
  }) || null;
}

/**
 * target/machineからdeviceIdを解決する。
 *
 * 【詳細説明】
 * - Printer Core v3 identityがある場合はそれを優先する。
 * - legacy-only K1ではhost keyをprovisional deviceとして使い、migration dry-runを止めない。
 *
 * @private
 * @function resolveDeviceId
 * @param {string} host - legacy host key。
 * @param {?Object} target - connection target。
 * @returns {string} device ID。
 */
function resolveDeviceId(host, target) {
  return toTrimmedString(target?.printerCoreV3Identity?.deviceIdSeed) ||
    toTrimmedString(target?.printerCoreV3Identity?.deviceId) ||
    `legacy-host:${host}`;
}

/**
 * host/deviceIdに対応するmaterial source observation recordを探す。
 *
 * @private
 * @function findObservationRecord
 * @param {Object} legacyData - legacy monitorData。
 * @param {string} host - legacy host key。
 * @param {string} deviceId - device ID。
 * @returns {?Object} 観測record、またはnull。
 */
function findObservationRecord(legacyData, host, deviceId) {
  const byDeviceId = asPlainObject(legacyData?.materialSourceObservations?.byDeviceId);
  if (byDeviceId[deviceId]) {
    return byDeviceId[deviceId];
  }
  return Object.values(byDeviceId).find((record) => {
    return record && typeof record === "object" &&
      (record.deviceId === deviceId || record.host === host);
  }) || null;
}

/**
 * legacy spool IDが現在のspool一覧に存在するか判定する。
 *
 * @private
 * @function hasLegacySpoolRecord
 * @param {Object} legacyData - legacy monitorData。
 * @param {string} spoolId - spool ID。
 * @returns {boolean} spool実体が存在する場合true。
 */
function hasLegacySpoolRecord(legacyData, spoolId) {
  const spools = Array.isArray(legacyData?.filamentSpools) ? legacyData.filamentSpools : [];
  return spools.some((spool) => toTrimmedString(spool?.id) === spoolId);
}

/**
 * target/machineが明示的にsingle-spool構成を宣言しているか判定する。
 *
 * @private
 * @function hasExplicitSingleSpoolConfiguration
 * @param {?Object} target - connection target。
 * @param {Object} machine - machine record。
 * @returns {boolean} 明示single-spoolならtrue。
 */
function hasExplicitSingleSpoolConfiguration(target, machine) {
  const targetMode = toTrimmedString(target?.materialSystem?.mode);
  const machineMode = toTrimmedString(machine?.materialSystem?.mode);
  return targetMode === "single-spool" || machineMode === "single-spool";
}

/**
 * observation recordがREADY判定に使えるfresh complete topologyか判定する。
 *
 * 【詳細説明】
 * - partial delta、復元済みlast-known、provider切断、TTL切れは現在の物理topology証拠として扱わない。
 * - READYは後続repositoryへ適用可能な候補なので、単一source観測であってもfresh completeでなければBLOCKEDにする。
 *
 * @private
 * @function isFreshCompleteTopologyObservation
 * @param {?Object} observationRecord - material source observation record。
 * @param {Object} input - 判定入力。
 * @param {string} input.createdAt - plan作成日時。
 * @param {number} input.freshTtlMs - fresh扱いTTL。
 * @returns {boolean} fresh complete observationならtrue。
 */
function isFreshCompleteTopologyObservation(observationRecord, input) {
  if (!observationRecord || typeof observationRecord !== "object") {
    return false;
  }
  if (observationRecord.restoredFromStorage === true || observationRecord.providerDisconnectedAt) {
    return false;
  }
  if (observationRecord.snapshotCompleteness !== "complete") {
    return false;
  }
  const observedMs = Date.parse(observationRecord.lastObservedAt || "");
  const createdMs = Date.parse(input.createdAt || "");
  if (!Number.isFinite(observedMs) || !Number.isFinite(createdMs)) {
    return false;
  }
  const ttl = Math.max(1, Math.floor(toFiniteNumber(input.freshTtlMs, DEFAULT_MIGRATION_TOPOLOGY_FRESH_TTL_MS) ?? DEFAULT_MIGRATION_TOPOLOGY_FRESH_TTL_MS));
  return Math.max(0, createdMs - observedMs) <= ttl;
}

/**
 * observation recordからsource一覧を抽出する。
 *
 * @private
 * @function listObservedSources
 * @param {?Object} observationRecord - material source observation record。
 * @returns {Array<Object>} source snapshot配列。
 */
function listObservedSources(observationRecord) {
  return Object.values(asPlainObject(observationRecord?.latestBySourceId))
    .filter((source) => source && typeof source === "object")
    .map((source) => cloneJsonValue(source));
}

/**
 * source kindが単一direct扱いできるかを判定する。
 *
 * @private
 * @function isSingleDirectLikeSourceKind
 * @param {*} kind - source kind候補。
 * @returns {boolean} direct/externalならtrue。
 */
function isSingleDirectLikeSourceKind(kind) {
  return kind === MATERIAL_SOURCE_KIND.DIRECT_FEED ||
    kind === MATERIAL_SOURCE_KIND.EXTERNAL_SPOOL ||
    kind === "direct" ||
    kind === "external";
}

/**
 * observed sourceからMaterialSource kindを解決する。
 *
 * @private
 * @function resolveObservedSourceKind
 * @param {?Object} source - observed source snapshot。
 * @returns {string} MaterialSource kind。
 */
function resolveObservedSourceKind(source) {
  if (source?.kind === MATERIAL_SOURCE_KIND.EXTERNAL_SPOOL || source?.type === "external") {
    return MATERIAL_SOURCE_KIND.EXTERNAL_SPOOL;
  }
  if (source?.kind === MATERIAL_SOURCE_KIND.CFS_C_SLOT || source?.providerKind === "cfs-c") {
    return MATERIAL_SOURCE_KIND.CFS_C_SLOT;
  }
  if (source?.kind === MATERIAL_SOURCE_KIND.CFS_SLOT) {
    return MATERIAL_SOURCE_KIND.CFS_SLOT;
  }
  return MATERIAL_SOURCE_KIND.DIRECT_FEED;
}

/**
 * directまたはexternal source用のplanned recordsを生成する。
 *
 * @private
 * @function createSingleSourcePlannedRecords
 * @param {Object} input - 生成入力。
 * @param {string} input.deviceId - device ID。
 * @param {string} input.spoolId - managed spool ID。
 * @param {string} input.host - legacy host key。
 * @param {string} input.createdAt - migration作成時刻。
 * @param {?Object} input.observedSource - 単一source観測。
 * @returns {Object} plannedWrites object。
 */
function createSingleSourcePlannedRecords(input) {
  const observedSource = input.observedSource || null;
  const sourceKind = observedSource ? resolveObservedSourceKind(observedSource) : MATERIAL_SOURCE_KIND.DIRECT_FEED;
  const unit = createFilamentUnitRecord({
    deviceId: input.deviceId,
    kind: FILAMENT_UNIT_KIND.PRINTER_DIRECT,
    identity: createDirectFeedUnitIdentity({ deviceId: input.deviceId }),
    identityStrength: MATERIAL_IDENTITY_STRENGTH.STABLE,
    providerId: observedSource?.providerId || "legacy-host-spool-map",
  });
  const source = createMaterialSourceRecord({
    deviceId: input.deviceId,
    unitId: unit.unitId,
    kind: sourceKind,
    locator: createMaterialSourceLocator({ kind: sourceKind, index: 0 }),
    identity: createMaterialSourceIdentity({
      deviceId: input.deviceId,
      unitId: unit.unitId,
      kind: sourceKind,
      index: 0,
    }),
    identityStrength: MATERIAL_IDENTITY_STRENGTH.STABLE,
    displayLabel: observedSource?.displayLabel || (sourceKind === MATERIAL_SOURCE_KIND.EXTERNAL_SPOOL ? "外部スプール" : "通常スプール"),
    aliases: observedSource?.sourceId ? [observedSource.sourceId] : [],
  });
  const mount = createSpoolMountRecord({
    materialSourceId: source.materialSourceId,
    spoolId: input.spoolId,
    status: SPOOL_MOUNT_STATUS.OPEN,
    verification: SPOOL_MOUNT_VERIFICATION.MIGRATED,
    sourceIdentityStrengthAtOpen: source.identityStrength,
    mountOperationId: createPrinterCoreV3DeterministicId("material-migration-mount-operation", [
      input.deviceId,
      input.host,
      input.spoolId,
      source.materialSourceId,
    ]),
    openedAt: input.createdAt,
    openedBy: "migration-dry-run",
  });
  return {
    filamentUnits: [unit],
    materialSources: [source],
    spoolMounts: [mount],
  };
}

/**
 * plannedWritesの空shapeを生成する。
 *
 * @private
 * @function createEmptyPlannedWrites
 * @returns {Object} 空のplannedWrites。
 */
function createEmptyPlannedWrites() {
  return {
    filamentUnits: [],
    materialSources: [],
    spoolMounts: [],
  };
}

/**
 * 単一hostのlegacy spool割当をmigration分類する。
 *
 * @private
 * @function createHostMigrationEntry
 * @param {Object} input - entry生成入力。
 * @param {Object} input.legacyData - legacy monitorData。
 * @param {string} input.host - legacy host key。
 * @param {string} input.spoolId - spool ID。
 * @param {string} input.createdAt - migration作成時刻。
 * @param {number=} input.freshTtlMs - fresh扱いTTL。
 * @returns {Object} migration entry。
 */
function createHostMigrationEntry(input) {
  const targets = getConnectionTargets(input.legacyData);
  const target = findConnectionTargetForHost(targets, input.host);
  const machines = asPlainObject(input.legacyData?.machines);
  const machine = machines[input.host] || {};
  const deviceId = resolveDeviceId(input.host, target);
  const observation = findObservationRecord(input.legacyData, input.host, deviceId);
  const observedSources = listObservedSources(observation);
  const hasFreshCompleteObservation = isFreshCompleteTopologyObservation(observation, {
    createdAt: input.createdAt,
    freshTtlMs: input.freshTtlMs,
  });
  const printerType = normalizePrinterType(target?.printerType || machine?.printerType);
  const isK2Like = printerType === "k2" || printerType.includes("k2");
  const isExplicitSingleSpool = hasExplicitSingleSpoolConfiguration(target, machine);

  if (!hasLegacySpoolRecord(input.legacyData, input.spoolId)) {
    return {
      host: input.host,
      deviceId,
      spoolId: input.spoolId,
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.LEGACY_SPOOL_MISSING],
      candidateSources: observedSources,
      plannedWrites: createEmptyPlannedWrites(),
    };
  }

  if (observedSources.length > 0 && !hasFreshCompleteObservation) {
    return {
      host: input.host,
      deviceId,
      spoolId: input.spoolId,
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.MATERIAL_TOPOLOGY_OBSERVATION_REQUIRED],
      candidateSources: observedSources,
      plannedWrites: createEmptyPlannedWrites(),
    };
  }

  if (observedSources.length > 1) {
    return {
      host: input.host,
      deviceId,
      spoolId: input.spoolId,
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.LEGACY_SPOOL_MAP_AMBIGUOUS_FOR_MULTI_SOURCE],
      candidateSources: observedSources,
      plannedWrites: createEmptyPlannedWrites(),
    };
  }

  if (observedSources.length === 1 && !isSingleDirectLikeSourceKind(observedSources[0].kind)) {
    return {
      host: input.host,
      deviceId,
      spoolId: input.spoolId,
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.LEGACY_SPOOL_MAP_REQUIRES_SOURCE_CONFIRMATION],
      candidateSources: observedSources,
      plannedWrites: createEmptyPlannedWrites(),
    };
  }

  if (observedSources.length === 0 && isK2Like) {
    return {
      host: input.host,
      deviceId,
      spoolId: input.spoolId,
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.MATERIAL_TOPOLOGY_OBSERVATION_REQUIRED],
      candidateSources: [],
      plannedWrites: createEmptyPlannedWrites(),
    };
  }

  if (observedSources.length === 0 && !isExplicitSingleSpool) {
    return {
      host: input.host,
      deviceId,
      spoolId: input.spoolId,
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.MATERIAL_TOPOLOGY_OBSERVATION_REQUIRED],
      candidateSources: [],
      plannedWrites: createEmptyPlannedWrites(),
    };
  }

  return {
    host: input.host,
    deviceId,
    spoolId: input.spoolId,
    migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY,
    reasons: [],
    candidateSources: observedSources,
    plannedWrites: createSingleSourcePlannedRecords({
      deviceId,
      spoolId: input.spoolId,
      host: input.host,
      createdAt: input.createdAt,
      observedSource: observedSources[0] || null,
    }),
  };
}

/**
 * plan全体のmigration statusを集約する。
 *
 * @private
 * @function summarizeMigrationStatus
 * @param {Array<Object>} entries - migration entry配列。
 * @returns {string} 集約migration status。
 */
function summarizeMigrationStatus(entries) {
  if (entries.some((entry) => entry.migrationStatus === MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED)) {
    return MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED;
  }
  if (entries.some((entry) => entry.migrationStatus === MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE)) {
    return MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE;
  }
  if (entries.some((entry) => entry.migrationStatus === MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY)) {
    return MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY;
  }
  return MATERIAL_ACCOUNTING_MIGRATION_STATUS.PLANNED;
}

/**
 * migration entryを集計する。
 *
 * @private
 * @function summarizeEntries
 * @param {Array<Object>} entries - migration entry配列。
 * @returns {Object} 集計結果。
 */
function summarizeEntries(entries) {
  return entries.reduce((summary, entry) => {
    if (entry.migrationStatus === MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY) {
      summary.ready += 1;
    } else if (entry.migrationStatus === MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE) {
      summary.candidate += 1;
    } else if (entry.migrationStatus === MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED) {
      summary.blocked += 1;
    }
    summary.plannedWrites.filamentUnits += entry.plannedWrites.filamentUnits.length;
    summary.plannedWrites.materialSources += entry.plannedWrites.materialSources.length;
    summary.plannedWrites.spoolMounts += entry.plannedWrites.spoolMounts.length;
    return summary;
  }, {
    ready: 0,
    candidate: 0,
    blocked: 0,
    plannedWrites: {
      filamentUnits: 0,
      materialSources: 0,
      spoolMounts: 0,
    },
  });
}

/**
 * legacy hostSpoolMap から Universal MaterialSource migration dry-run planを生成する。
 *
 * 【詳細説明】
 * - この関数はmonitorData、IndexedDB、legacy hostSpoolMapを書き換えない。
 * - multi-source観測があるhostでは、legacy 1本スプールをどのsourceへ載せるかを自動決定しない。
 * - K2系でtopologyが未観測の場合もdirect-onlyとは仮定せず、再観測が必要なblocked entryとして返す。
 *
 * @function createMaterialAccountingMigrationDryRunPlan
 * @param {Object|null|undefined} legacyData - legacy monitorData互換データ。
 * @param {Object=} options - plan生成オプション。
 * @param {string=} options.createdAt - plan作成日時。
 * @param {number=} options.freshTtlMs - fresh扱いTTL。
 * @returns {Object} dry-run migration plan。
 * @example
 * const plan = createMaterialAccountingMigrationDryRunPlan(monitorData, { createdAt: new Date().toISOString() });
 */
export function createMaterialAccountingMigrationDryRunPlan(legacyData, options = {}) {
  const source = legacyData && typeof legacyData === "object" ? legacyData : {};
  const createdAt = normalizeOptionalIsoTime(options.createdAt) || new Date().toISOString();
  const freshTtlMs = Math.max(1, Math.floor(toFiniteNumber(options.freshTtlMs, DEFAULT_MIGRATION_TOPOLOGY_FRESH_TTL_MS) ?? DEFAULT_MIGRATION_TOPOLOGY_FRESH_TTL_MS));
  const hostSpoolMap = asPlainObject(source.hostSpoolMap);
  const entries = Object.entries(hostSpoolMap)
    .filter(([host, spoolId]) => toTrimmedString(host) && toTrimmedString(spoolId))
    .map(([host, spoolId]) => createHostMigrationEntry({
      legacyData: source,
      host: toTrimmedString(host),
      spoolId: toTrimmedString(spoolId),
      createdAt,
      freshTtlMs,
    }));
  const sourceChecksum = `fnv1a128:${createPrinterCoreV3DeterministicId("legacy-material-accounting-source", [
    stableStringifyPrinterCoreV3Value({
      hostSpoolMap,
      connectionTargets: getConnectionTargets(source),
      machines: asPlainObject(source.machines),
      materialSourceObservations: source.materialSourceObservations || null,
    }),
  ]).split(":")[1]}`;
  return deepFreezeJson({
    schemaVersion: MATERIAL_ACCOUNTING_MIGRATION_PLAN_SCHEMA_VERSION,
    status: "dry-run",
    migrationStatus: summarizeMigrationStatus(entries),
    migrationId: createPrinterCoreV3DeterministicId("material-accounting-migration", [sourceChecksum]),
    createdAt,
    source: {
      schema: "legacy-monitorData-v2",
      checksum: sourceChecksum,
    },
    entries,
    summary: summarizeEntries(entries),
    invariants: {
      activateUniversalWrites: false,
      preserveLegacyData: true,
      preserveHostSpoolMap: true,
      hostSpoolMapIsCompatibilityProjection: true,
      materialObservationIsReadOnly: true,
      migrationIsDryRunOnly: true,
    },
  });
}

/**
 * migration entryのplanned recordsを検証する。
 *
 * @private
 * @function validatePlannedWrites
 * @param {Object} entry - migration entry。
 * @returns {Array<string>} validation error一覧。
 */
function validatePlannedWrites(entry) {
  const errors = [];
  for (const source of entry.plannedWrites?.materialSources || []) {
    const validation = validateMaterialSource(source);
    if (!validation.ok) {
      errors.push(...validation.errors.map((error) => `materialSource:${error}`));
    }
  }
  for (const mount of entry.plannedWrites?.spoolMounts || []) {
    const validation = validateSpoolMount(mount);
    if (!validation.ok) {
      errors.push(...validation.errors.map((error) => `spoolMount:${error}`));
    }
  }
  return errors;
}

/**
 * Universal MaterialSource migration dry-run planを検証する。
 *
 * 【詳細説明】
 * - planがdry-runであり、production writeを有効化しないことを確認する。
 * - READY entryについてはplanned MaterialSource/SpoolMount/Cutoverの契約検証も行う。
 *
 * @function validateMaterialAccountingMigrationDryRunPlan
 * @param {Object|null|undefined} plan - migration dry-run plan。
 * @returns {{ok:boolean, errors:string[]}} validation結果。
 * @example
 * const validation = validateMaterialAccountingMigrationDryRunPlan(plan);
 */
export function validateMaterialAccountingMigrationDryRunPlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== "object") {
    return { ok: false, errors: ["plan-not-object"] };
  }
  if (plan.schemaVersion !== MATERIAL_ACCOUNTING_MIGRATION_PLAN_SCHEMA_VERSION) {
    errors.push("unexpected-plan-schema-version");
  }
  if (plan.status !== "dry-run") {
    errors.push("plan-status-not-dry-run");
  }
  if (!enumValues(MATERIAL_ACCOUNTING_MIGRATION_STATUS).has(plan.migrationStatus)) {
    errors.push("invalid-migrationStatus");
  } else if (!DRY_RUN_DECISION_STATUSES.has(plan.migrationStatus)) {
    errors.push("plan-status-not-dry-run-decision");
  }
  if (plan.invariants?.activateUniversalWrites !== false) {
    errors.push("plan-activates-universal-writes");
  }
  if (plan.invariants?.preserveHostSpoolMap !== true) {
    errors.push("plan-does-not-preserve-hostSpoolMap");
  }
  if (!Array.isArray(plan.entries)) {
    errors.push("entries-not-array");
  } else {
    for (const entry of plan.entries) {
      if (!enumValues(MATERIAL_ACCOUNTING_MIGRATION_STATUS).has(entry?.migrationStatus)) {
        errors.push("entry-invalid-migrationStatus");
      } else if (!DRY_RUN_DECISION_STATUSES.has(entry.migrationStatus)) {
        errors.push("entry-status-not-dry-run-decision");
      }
      if (entry?.migrationStatus !== MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY &&
          (entry?.plannedWrites?.spoolMounts || []).length > 0) {
        errors.push("non-ready-entry-has-spoolMount-write");
      }
      errors.push(...validatePlannedWrites(entry));
    }
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}
