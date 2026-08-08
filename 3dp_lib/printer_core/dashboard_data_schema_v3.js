/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 Data Schema モジュール
 * @file dashboard_data_schema_v3.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_data_schema_v3
 *
 * 【機能内容サマリ】
 * - Printer Core v3 の IndexedDB store 定義を純粋データとして提供
 * - 旧 monitorData から v3 migration dry-run plan を生成
 * - migration checksum と deterministic ID の境界を固定
 *
 * 【公開関数一覧】
 * - {@link getPrinterCoreV3StoreDefinitions}：v3 store 定義一覧を返す
 * - {@link getPrinterCoreV3StoreNames}：v3 store 名一覧を返す
 * - {@link createPrinterCoreV3DeterministicId}：migration 用 deterministic ID を生成
 * - {@link stableStringifyPrinterCoreV3Value}：checksum 用 canonical JSON を生成
 * - {@link createPrinterCoreV3MigrationPlan}：旧 monitorData の migration dry-run plan を生成
 * - {@link validatePrinterCoreV3MigrationPlan}：migration dry-run plan の整合性を検査
 *
 * @version 1.390.1348 (PR #432)
 * @since   1.390.1341 (PR #432)
 * @lastModified 2026-08-09 08:15:00
 * -----------------------------------------------------------
 * @todo
 * - dashboard_storage_idb.js の version upgrade と v3 repository 実装へ接続する
 */

"use strict";

/**
 * Printer Core v3 Data Schema version。
 *
 * 【詳細説明】
 * - IndexedDB の物理 DB_VERSION とは分け、Printer Core v3 側の永続 schema 契約として管理する。
 *
 * @constant {number}
 */
export const PRINTER_CORE_V3_DATA_SCHEMA_VERSION = 3;

/**
 * Printer Core v3 migration plan の schema version。
 *
 * 【詳細説明】
 * - dry-run report の shape を versioning し、後続 Gate の migration journal と互換確認できるようにする。
 *
 * @constant {number}
 */
export const PRINTER_CORE_V3_MIGRATION_PLAN_SCHEMA_VERSION = 1;

/**
 * Printer Core v3 IndexedDB store 定義。
 *
 * 【詳細説明】
 * - ADR-0007 の planned stores を code contract として固定する。
 * - この module はまだ IndexedDB を開かず、store 定義を純粋データとして返すだけにする。
 *
 * @constant {Array<object>}
 */
const PRINTER_CORE_V3_STORE_DEFINITIONS = Object.freeze([
  Object.freeze({ name: "meta", keyPath: "key", indexes: Object.freeze([]) }),
  Object.freeze({ name: "devices", keyPath: "deviceId", indexes: Object.freeze(["reportedModel", "serialNumber"]) }),
  Object.freeze({ name: "deviceEndpoints", keyPath: "endpointId", indexes: Object.freeze(["deviceId", "dest", "macAddress"]) }),
  Object.freeze({ name: "capabilitySnapshots", keyPath: "snapshotId", indexes: Object.freeze(["deviceId", "capturedAt"]) }),
  Object.freeze({ name: "printJobs", keyPath: "printJobId", indexes: Object.freeze(["deviceId", "startedAt"]) }),
  Object.freeze({ name: "gcodeAssets", keyPath: "assetId", indexes: Object.freeze(["fileName", "fileMd5"]) }),
  Object.freeze({ name: "printPlans", keyPath: "printPlanId", indexes: Object.freeze(["printJobId", "createdAt"]) }),
  Object.freeze({ name: "filamentUnits", keyPath: "unitId", indexes: Object.freeze(["deviceId", "providerId"]) }),
  Object.freeze({ name: "materialSources", keyPath: "materialSourceId", indexes: Object.freeze(["unitId", "kind"]) }),
  Object.freeze({ name: "spools", keyPath: "spoolId", indexes: Object.freeze(["serialNo", "name"]) }),
  Object.freeze({ name: "spoolMounts", keyPath: "mountId", indexes: Object.freeze(["spoolId", "materialSourceId", "closedAt"]) }),
  Object.freeze({ name: "jobMaterialSegments", keyPath: "segmentId", indexes: Object.freeze(["printJobId", "spoolId", "confidence"]) }),
  Object.freeze({ name: "filamentLedger", keyPath: "ledgerEventId", indexes: Object.freeze(["spoolId", "printJobId", "createdAt"]) }),
  Object.freeze({ name: "settings", keyPath: "key", indexes: Object.freeze([]) }),
  Object.freeze({ name: "migrationJournal", keyPath: "migrationId", indexes: Object.freeze(["status", "createdAt"]) }),
  Object.freeze({ name: "protocolCaptures", keyPath: "captureId", indexes: Object.freeze(["deviceId", "scenario", "capturedAt"]) }),
]);

/**
 * JSON 互換値を deep clone する。
 *
 * 【詳細説明】
 * - schema 定義や migration plan を呼び出し側 mutation から守るために使う。
 *
 * @private
 * @param {*} value - clone 対象
 * @returns {*} clone 済み値
 */
function cloneJsonValue(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * ID prefix へ使える短い label 文字列へ正規化する。
 *
 * 【詳細説明】
 * - この値は可読 prefix 専用であり、同一性判定や digest 入力には使わない。
 * - `/` と `?` のような重要な違いを潰さないよう、hash 入力は別途 canonical JSON を使う。
 *
 * @private
 * @param {*} value - ID 構成要素
 * @returns {string} 正規化済み label
 */
function normalizeIdLabel(value) {
  const raw = value === null || value === undefined ? "null" : String(value);
  const normalized = raw.trim().toLowerCase().replace(/[^a-z0-9._:-]+/giu, "-");
  return normalized || "empty";
}

/**
 * deterministic ID の digest 入力を lossless に正規化する。
 *
 * 【詳細説明】
 * - 文字列は byte/Unicode 内容をそのまま JSON として保持する。
 * - serial/hostname など意味上 case-insensitive な値は、呼び出し側で明示的に正規化してから渡す。
 * - object/array は stable stringify に通し、同じ論理値が同じ digest になるようにする。
 *
 * @private
 * @param {*} value - ID 構成要素
 * @returns {*} canonical digest input
 */
function canonicalizeIdPart(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalizeIdPart);
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalizeIdPart(value[key]);
    }
    return result;
  }
  return value === undefined ? null : value;
}

/**
 * 32bit FNV-1a hash を16進文字列として返す。
 *
 * 【詳細説明】
 * - 128bit digest の lane として使う非暗号 hash。秘匿や署名には使わない。
 *
 * @private
 * @param {string} text - hash 対象文字列
 * @param {number} seed - lane 用 seed
 * @returns {string} 8桁16進 hash
 */
function hashString32(text, seed = 0x811c9dc5) {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * 128bit相当の deterministic digest を16進文字列として返す。
 *
 * 【詳細説明】
 * - 4つの異なる seed の FNV-1a lane を連結し、32bit単独より birthday collision risk を下げる。
 * - crypto 依存を避けるため非暗号 hash のままだが、Data Schema v3 の deterministic key には十分保守的な幅にする。
 *
 * @private
 * @param {string} text - hash 対象文字列
 * @returns {string} 32桁16進 digest
 */
function hashString128(text) {
  return [
    hashString32(text, 0x811c9dc5),
    hashString32(`1:${text}`, 0x9e3779b9),
    hashString32(`2:${text}`, 0x85ebca6b),
    hashString32(`3:${text}`, 0xc2b2ae35),
  ].join("");
}

/**
 * object key を安定順に並べた canonical JSON を生成する。
 *
 * 【詳細説明】
 * - JSON.stringify の挿入順依存を避け、同じ legacy payload から同じ checksum を得る。
 * - undefined は IndexedDB/JSON 保存対象外として null に寄せる。
 *
 * @function stableStringifyPrinterCoreV3Value
 * @param {*} value - JSON 互換値
 * @returns {string} canonical JSON 文字列
 * @example
 * const canonical = stableStringifyPrinterCoreV3Value({ b: 2, a: 1 });
 */
export function stableStringifyPrinterCoreV3Value(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringifyPrinterCoreV3Value(entry)).join(",")}]`;
  }
  const entries = Object.keys(value).sort().map((key) => {
    return `${JSON.stringify(key)}:${stableStringifyPrinterCoreV3Value(value[key])}`;
  });
  return `{${entries.join(",")}}`;
}

/**
 * migration 用 deterministic ID を生成する。
 *
 * 【詳細説明】
 * - 旧 v2 データを複数回 dry-run / migration しても同じ logical record が同じ ID になるようにする。
 * - ID 全体には短い hash suffix を付け、長い file name や device name をそのまま保存 key にしない。
 *
 * @function createPrinterCoreV3DeterministicId
 * @param {string} namespace - ID namespace
 * @param {Array<*>} parts - ID 構成要素
 * @returns {string} deterministic ID
 * @example
 * const id = createPrinterCoreV3DeterministicId("device", ["serial", "SN001"]);
 */
export function createPrinterCoreV3DeterministicId(namespace, parts = []) {
  const normalizedNamespace = normalizeIdLabel(namespace);
  const canonicalNamespace = canonicalizeIdPart(namespace);
  const canonicalParts = (Array.isArray(parts) ? parts : [parts]).map(canonicalizeIdPart);
  const source = stableStringifyPrinterCoreV3Value([canonicalNamespace, ...canonicalParts]);
  return `${normalizedNamespace}:${hashString128(source)}`;
}

/**
 * Printer Core v3 store 定義一覧を返す。
 *
 * 【詳細説明】
 * - 呼び出し側が変更しても module 内の定義が壊れないよう deep clone して返す。
 *
 * @function getPrinterCoreV3StoreDefinitions
 * @returns {Array<object>} store 定義一覧
 * @example
 * const stores = getPrinterCoreV3StoreDefinitions();
 */
export function getPrinterCoreV3StoreDefinitions() {
  return cloneJsonValue(PRINTER_CORE_V3_STORE_DEFINITIONS);
}

/**
 * Printer Core v3 store 名一覧を返す。
 *
 * 【詳細説明】
 * - IndexedDB upgrade や migration journal validation が ADR-0007 の store set とずれないようにする。
 *
 * @function getPrinterCoreV3StoreNames
 * @returns {string[]} store 名一覧
 * @example
 * const storeNames = getPrinterCoreV3StoreNames();
 */
export function getPrinterCoreV3StoreNames() {
  return PRINTER_CORE_V3_STORE_DEFINITIONS.map((store) => store.name);
}

/**
 * legacy machines の印刷履歴件数を数える。
 *
 * 【詳細説明】
 * - Data Schema v3 の printJobs dry-run count は host ごとの `printStore.history` を合算する。
 *
 * @private
 * @param {object|null|undefined} machines - legacy machines object
 * @returns {number} 印刷履歴件数
 */
function countLegacyPrintHistory(machines) {
  if (!machines || typeof machines !== "object") {
    return 0;
  }
  return Object.values(machines).reduce((count, machine) => {
    const history = Array.isArray(machine?.printStore?.history) ? machine.printStore.history : [];
    return count + history.length;
  }, 0);
}

/**
 * legacy connectionTargets から endpoint 件数を数える。
 *
 * 【詳細説明】
 * - `dest` がある target だけを Data Schema v3 `deviceEndpoints` 候補にする。
 *
 * @private
 * @param {Array<object>} targets - legacy connectionTargets
 * @returns {number} endpoint 候補件数
 */
function countLegacyDeviceEndpoints(targets) {
  return (Array.isArray(targets) ? targets : []).filter((target) => !!target?.dest).length;
}

/**
 * 旧 monitorData から v3 migration dry-run plan を生成する。
 *
 * 【詳細説明】
 * - この関数は IndexedDB や monitorData を変更しない。
 * - migration 前に legacy export checksum、予定 store、予定 record counts、警告を固定するために使う。
 * - protocolCaptures はまだ fixture/recorder 側の証跡であり、legacy monitorData からは0件として扱う。
 *
 * @function createPrinterCoreV3MigrationPlan
 * @param {object|null|undefined} legacyData - 旧 monitorData 互換データ
 * @param {object=} options - plan 生成オプション
 * @param {string=} options.createdAt - migration plan 作成時刻 ISO 文字列
 * @returns {object} migration dry-run plan
 * @example
 * const plan = createPrinterCoreV3MigrationPlan(monitorData);
 */
export function createPrinterCoreV3MigrationPlan(legacyData, options = {}) {
  const source = legacyData && typeof legacyData === "object" ? legacyData : {};
  const canonicalSource = stableStringifyPrinterCoreV3Value(source);
  const sourceChecksum = `fnv1a128:${hashString128(canonicalSource)}`;
  const machines = source.machines && typeof source.machines === "object" ? source.machines : {};
  const connectionTargets = Array.isArray(source.appSettings?.connectionTargets)
    ? source.appSettings.connectionTargets
    : [];
  const filamentSpools = Array.isArray(source.filamentSpools) ? source.filamentSpools : [];
  const mountHistory = Array.isArray(source.mountHistory) ? source.mountHistory : [];
  const usageHistory = Array.isArray(source.usageHistory) ? source.usageHistory : [];
  const deviceEndpointCount = countLegacyDeviceEndpoints(connectionTargets);
  const machineCount = Object.keys(machines).length;
  const warnings = [];
  if (!source.appSettings || typeof source.appSettings !== "object") {
    warnings.push("legacy-app-settings-missing");
  }
  if (machineCount === 0) {
    warnings.push("legacy-machines-empty");
  }
  if (deviceEndpointCount === 0) {
    warnings.push("legacy-device-endpoints-empty");
  }

  return {
    schemaVersion: PRINTER_CORE_V3_MIGRATION_PLAN_SCHEMA_VERSION,
    dataSchemaVersion: PRINTER_CORE_V3_DATA_SCHEMA_VERSION,
    migrationId: createPrinterCoreV3DeterministicId("migration", [sourceChecksum]),
    status: "dry-run",
    createdAt: options.createdAt || null,
    source: {
      schema: "legacy-monitorData-v2",
      checksum: sourceChecksum,
      byteLength: canonicalSource.length,
    },
    stores: getPrinterCoreV3StoreDefinitions(),
    legacyCounts: {
      connectionTargets: connectionTargets.length,
      deviceEndpoints: deviceEndpointCount,
      machines: machineCount,
      printHistoryJobs: countLegacyPrintHistory(machines),
      filamentSpools: filamentSpools.length,
      mountHistory: mountHistory.length,
      usageHistory: usageHistory.length,
    },
    plannedWrites: {
      meta: 1,
      devices: Math.max(machineCount, deviceEndpointCount),
      deviceEndpoints: deviceEndpointCount,
      capabilitySnapshots: 0,
      printJobs: countLegacyPrintHistory(machines),
      gcodeAssets: 0,
      printPlans: 0,
      filamentUnits: 0,
      materialSources: 0,
      spools: filamentSpools.length,
      spoolMounts: mountHistory.length,
      jobMaterialSegments: 0,
      filamentLedger: usageHistory.length,
      settings: source.appSettings && typeof source.appSettings === "object" ? 1 : 0,
      migrationJournal: 1,
      protocolCaptures: 0,
    },
    invariants: {
      dualWriteAllowed: false,
      developmentDualRouteAllowed: true,
      activateV3Writes: false,
      preserveLegacyData: true,
      migrationIsDeterministic: true,
      requiresJournalBeforeActivation: true,
    },
    warnings,
  };
}

/**
 * migration dry-run plan の整合性を検査する。
 *
 * 【詳細説明】
 * - Gate 13 では「実 migration はまだしない」が前提のため、plan が dry-run であり、全 store の予定件数が
 *   store 定義と対応していることを確認する。
 *
 * @function validatePrinterCoreV3MigrationPlan
 * @param {object|null|undefined} plan - migration dry-run plan
 * @returns {{ok: boolean, errors: string[]}} 検査結果
 * @example
 * const validation = validatePrinterCoreV3MigrationPlan(plan);
 */
export function validatePrinterCoreV3MigrationPlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== "object") {
    return { ok: false, errors: ["plan-not-object"] };
  }
  if (plan.schemaVersion !== PRINTER_CORE_V3_MIGRATION_PLAN_SCHEMA_VERSION) {
    errors.push("unexpected-plan-schema-version");
  }
  if (plan.dataSchemaVersion !== PRINTER_CORE_V3_DATA_SCHEMA_VERSION) {
    errors.push("unexpected-data-schema-version");
  }
  if (plan.status !== "dry-run") {
    errors.push("plan-status-not-dry-run");
  }
  if (plan.invariants?.activateV3Writes !== false) {
    errors.push("plan-activates-v3-writes");
  }
  if (plan.invariants?.dualWriteAllowed !== false) {
    errors.push("plan-allows-production-dual-write");
  }
  const storeNames = new Set(getPrinterCoreV3StoreNames());
  const plannedWriteNames = new Set(Object.keys(plan.plannedWrites || {}));
  for (const storeName of storeNames) {
    if (!plannedWriteNames.has(storeName)) {
      errors.push(`planned-write-missing:${storeName}`);
    }
  }
  for (const plannedWriteName of plannedWriteNames) {
    if (!storeNames.has(plannedWriteName)) {
      errors.push(`planned-write-unknown:${plannedWriteName}`);
    }
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}
