/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 MaterialSource print binding repository implementation モジュール
 * @file dashboard_material_accounting_print_binding_repository.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_accounting_print_binding_repository
 *
 * 【機能内容サマリ】
 * - Gate 18.9E の trusted print-start material binding snapshot を保持する内部実装を提供
 * - source-specific usage observation をMaterialSource/SpoolMount単位へ帰属
 * - total-only multi-source usageをpending/unattributedとして隔離
 *
 * 【公開関数一覧】
 * - {@link normalizeStoredMaterialAccountingPrintBindingStore}：保存済みprint binding storeを正規化
 * - {@link createMaterialAccountingPrintBindingRepositoryWithIssuer}：issuer注入済みprint binding repositoryを生成
 *
 * @version 1.390.1517 (PR #438)
 * @since   1.390.1516 (PR #438)
 * @lastModified 2026-08-31 23:14:00
 * -----------------------------------------------------------
 * @todo
 * - Gate 19以降でtrusted source-specific result registryを接続してから残量debitを有効化する
 */

"use strict";

import {
  createPrinterCoreV3DeterministicId,
  stableStringifyPrinterCoreV3Value,
} from "./dashboard_data_schema_v3.js";
import { validatePrintPlan } from "./dashboard_print_plan.js";

/**
 * print binding repository schema version。
 *
 * @constant {number}
 */
export const MATERIAL_ACCOUNTING_PRINT_BINDING_SCHEMA_VERSION = 1;

/**
 * print binding repository action/status。
 *
 * @constant {Readonly<object>}
 */
export const MATERIAL_ACCOUNTING_PRINT_BINDING_STATUS = Object.freeze({
  RECORDED: "recorded",
  IDEMPOTENT: "idempotent",
  PENDING: "pending",
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
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreezeJson(child);
  }
  return value;
}

/**
 * 文字列を正規化する。
 *
 * @private
 * @function toTrimmedString
 * @param {*} value - 文字列候補。
 * @returns {string} 正規化文字列。
 */
function toTrimmedString(value) {
  return String(value ?? "").trim();
}

/**
 * 非負mm値を正規化する。
 *
 * @private
 * @function normalizeNonNegativeMm
 * @param {*} value - mm値候補。
 * @returns {number|null} 正規化済みmm。不正な場合null。
 */
function normalizeNonNegativeMm(value) {
  if (value === undefined || value === null || typeof value === "boolean" || Array.isArray(value)) {
    return null;
  }
  if (typeof value === "string" && !/^(0|[1-9]\d*)(\.\d+)?$/u.test(value.trim())) {
    return null;
  }
  const numberValue = typeof value === "string" ? Number(value.trim()) : value;
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : null;
}

/**
 * ISO時刻を正規化する。
 *
 * @private
 * @function normalizeIsoTime
 * @param {*} value - ISO時刻候補。
 * @returns {string|null} 正規化済みISO時刻。
 */
function normalizeIsoTime(value) {
  if (!value) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/**
 * repository operation digestを生成する。
 *
 * @private
 * @function createOperationDigest
 * @param {string} namespace - digest namespace。
 * @param {Object} payload - semantic payload。
 * @returns {string} digest。
 */
function createOperationDigest(namespace, payload) {
  return createPrinterCoreV3DeterministicId(namespace, [
    stableStringifyPrinterCoreV3Value(payload),
  ]);
}

/**
 * 配列をID mapへ変換する。
 *
 * @private
 * @function mapById
 * @param {Object[]} records - record配列。
 * @param {string} key - ID key。
 * @returns {Map<string,Object>} ID map。
 */
function mapById(records, key) {
  const map = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const id = toTrimmedString(record?.[key]);
    if (id && !map.has(id)) {
      map.set(id, record);
    }
  }
  return map;
}

/**
 * sourceに対応するopen mountを探す。
 *
 * @private
 * @function findMountForAssignment
 * @param {Object} assignment - PrintPlan tool assignment。
 * @param {Object[]} spoolMounts - SpoolMount配列。
 * @returns {Object|null} 対応mount。
 */
function findMountForAssignment(assignment, spoolMounts) {
  const sourceId = toTrimmedString(assignment?.materialSourceId);
  const assignmentSpoolId = toTrimmedString(assignment?.spoolId);
  return (Array.isArray(spoolMounts) ? spoolMounts : []).find((mount) => {
    if (toTrimmedString(mount?.materialSourceId) !== sourceId) {
      return false;
    }
    if (assignmentSpoolId && toTrimmedString(mount?.spoolId) !== assignmentSpoolId) {
      return false;
    }
    return mount?.status === "open";
  }) || null;
}

/**
 * usage entryのmm値を正規化する。
 *
 * @private
 * @function getUsageEntryLengthMm
 * @param {Object|null|undefined} entry - usage entry候補。
 * @returns {number|null} 正規化済みmm。
 */
function getUsageEntryLengthMm(entry) {
  return normalizeNonNegativeMm(
    entry?.usedLengthMm ?? entry?.usedMm ?? entry?.materialUsedMm ?? entry?.deltaUsedMm
  );
}

/**
 * usage entryの識別子を正規化する。
 *
 * 【詳細説明】
 * - toolId / protocolToolAlias / materialSourceId は同じMaterialSource snapshotを指して初めて帰属可能とする。
 * - 一部だけ一致し、別の識別子が別sourceを指すpayloadは、誤帰属を防ぐためblockedにする。
 *
 * @private
 * @function normalizeUsageEntryIdentifiers
 * @param {Object|null|undefined} entry - usage entry候補。
 * @returns {{toolId:?number,protocolToolAlias:string,materialSourceId:string}} 正規化済み識別子。
 */
function normalizeUsageEntryIdentifiers(entry) {
  const toolId = Number(entry?.toolId);
  return {
    toolId: Number.isFinite(toolId) ? toolId : null,
    protocolToolAlias: toTrimmedString(entry?.protocolToolAlias || entry?.toolAlias),
    materialSourceId: toTrimmedString(entry?.materialSourceId),
  };
}

/**
 * snapshotに保存されたprint-start assignment識別子を正規化する。
 *
 * @private
 * @function normalizeSnapshotAssignmentIdentifiers
 * @param {Object|null|undefined} snapshot - print-start snapshot。
 * @returns {{toolId:?number,protocolToolAlias:string,materialSourceId:string}} 正規化済み識別子。
 */
function normalizeSnapshotAssignmentIdentifiers(snapshot) {
  const toolId = Number(snapshot?.toolId);
  return {
    toolId: Number.isFinite(toolId) ? toolId : null,
    protocolToolAlias: toTrimmedString(snapshot?.protocolToolAlias || snapshot?.toolAlias),
    materialSourceId: toTrimmedString(snapshot?.materialSourceId),
  };
}

/**
 * usage entryがsnapshot識別子と矛盾しないかを判定する。
 *
 * @private
 * @function compareUsageEntryToSnapshot
 * @param {Object} entryIdentifiers - usage entry識別子。
 * @param {Object} snapshotIdentifiers - snapshot識別子。
 * @returns {{matches:boolean,conflicts:boolean,hasIdentifier:boolean}} 比較結果。
 */
function compareUsageEntryToSnapshot(entryIdentifiers, snapshotIdentifiers) {
  const checks = [
    ["toolId", entryIdentifiers.toolId, snapshotIdentifiers.toolId],
    ["protocolToolAlias", entryIdentifiers.protocolToolAlias, snapshotIdentifiers.protocolToolAlias],
    ["materialSourceId", entryIdentifiers.materialSourceId, snapshotIdentifiers.materialSourceId],
  ];
  let matched = false;
  let hasIdentifier = false;
  let conflicts = false;
  for (const [, entryValue, snapshotValue] of checks) {
    if (entryValue === null || entryValue === "") {
      continue;
    }
    hasIdentifier = true;
    if (snapshotValue === null || snapshotValue === "" || entryValue !== snapshotValue) {
      conflicts = true;
    } else {
      matched = true;
    }
  }
  return {
    matches: hasIdentifier && matched && !conflicts,
    conflicts,
    hasIdentifier,
  };
}

/**
 * print-start snapshot配列に対してusage entryを厳密に対応付ける。
 *
 * 【詳細説明】
 * - completion時のPrintPlanではなく、保存済みsnapshotのtool/source bindingを基準にする。
 * - 1つのentryが複数snapshotに一致する、または同一snapshotに複数entryが来る場合はblockedにする。
 *
 * @private
 * @function resolveUsageEntriesForSnapshots
 * @param {Object[]} snapshots - print-start snapshot配列。
 * @param {Object[]} materialUsages - source-specific usage観測。
 * @returns {{reasons:string[],entriesBySnapshotId:Map<string,Object>,sourceSpecificTotalMm:number}} 解決結果。
 */
function resolveUsageEntriesForSnapshots(snapshots, materialUsages) {
  const reasons = [];
  const entriesBySnapshotId = new Map();
  let sourceSpecificTotalMm = 0;
  for (const entry of Array.isArray(materialUsages) ? materialUsages : []) {
    const entryIdentifiers = normalizeUsageEntryIdentifiers(entry);
    const usedLengthMm = getUsageEntryLengthMm(entry);
    if (usedLengthMm === null) {
      reasons.push("usage-length-invalid");
      continue;
    }
    const matches = [];
    let sawConflict = false;
    for (const snapshot of snapshots) {
      const comparison = compareUsageEntryToSnapshot(
        entryIdentifiers,
        normalizeSnapshotAssignmentIdentifiers(snapshot),
      );
      if (comparison.conflicts && comparison.hasIdentifier && comparison.matches === false) {
        sawConflict = true;
      }
      if (comparison.matches) {
        matches.push(snapshot);
      }
    }
    if (matches.length !== 1) {
      reasons.push(sawConflict ? "usage-identifier-conflict" : "usage-entry-unmatched");
      continue;
    }
    const snapshotId = matches[0].snapshotId;
    if (entriesBySnapshotId.has(snapshotId)) {
      reasons.push("usage-entry-duplicate");
      continue;
    }
    entriesBySnapshotId.set(snapshotId, entry);
    sourceSpecificTotalMm += usedLengthMm;
  }
  return { reasons: [...new Set(reasons)], entriesBySnapshotId, sourceSpecificTotalMm };
}

/**
 * read-only shadow usage evidenceを生成する。
 *
 * 【詳細説明】
 * - public repository APIからtrusted usage evidenceを発行しないためのplain evidence。
 * - UIのsource-aware表示やfixture比較には使えるが、残量debit authorityとしては常に無効にする。
 *
 * @private
 * @function createShadowSourceSpecificMaterialUsageEvidence
 * @param {Object} input - usage evidence入力。
 * @returns {Object} shadow usage evidence。
 */
function createShadowSourceSpecificMaterialUsageEvidence(input = {}) {
  const evidence = {
    schemaVersion: 1,
    evidenceId: toTrimmedString(input.evidenceId) ||
      createPrinterCoreV3DeterministicId("material-source-usage-evidence-shadow", [
        input.materialSourceId,
        input.snapshotId,
        input.printJobId,
        input.idempotencyKey,
      ]),
    materialSourceId: toTrimmedString(input.materialSourceId),
    mountId: toTrimmedString(input.mountId),
    snapshotId: toTrimmedString(input.snapshotId),
    printJobId: toTrimmedString(input.printJobId),
    deviceId: toTrimmedString(input.deviceId),
    usageSegmentId: toTrimmedString(input.usageSegmentId) || "segment:0",
    usedLengthMm: normalizeNonNegativeMm(input.usedLengthMm),
    attribution: "source-specific",
    confidence: toTrimmedString(input.confidence) || "shadow-observed",
    source: toTrimmedString(input.source) || "firmware-source-specific",
    measurementMethod: toTrimmedString(input.measurementMethod) || "firmware-source",
    observedAt: normalizeIsoTime(input.observedAt),
    idempotencyKey: toTrimmedString(input.idempotencyKey),
    trusted: false,
    authority: {
      mode: "shadow-normalized-evidence-only",
      canDebit: false,
    },
    attestation: null,
  };
  return deepFreezeJson(evidence);
}

/**
 * 非空文字列フィールドを持つかを判定する。
 *
 * @private
 * @function hasRecordString
 * @param {Object|null|undefined} record - record候補。
 * @param {string} key - field名。
 * @returns {boolean} 非空文字列ならtrue。
 */
function hasRecordString(record, key) {
  return toTrimmedString(record?.[key]) !== "";
}

/**
 * print-start snapshot recordを復元してよいか検査する。
 *
 * @private
 * @function isRestorablePrintStartSnapshot
 * @param {Object|null|undefined} snapshot - snapshot候補。
 * @returns {boolean} 復元可能ならtrue。
 */
function isRestorablePrintStartSnapshot(snapshot) {
  return !!snapshot &&
    typeof snapshot === "object" &&
    !Array.isArray(snapshot) &&
    hasRecordString(snapshot, "snapshotId") &&
    hasRecordString(snapshot, "deviceId") &&
    hasRecordString(snapshot, "printJobId") &&
    hasRecordString(snapshot, "printPlanId") &&
    hasRecordString(snapshot, "materialSourceId") &&
    hasRecordString(snapshot, "mountId") &&
    hasRecordString(snapshot, "spoolId") &&
    normalizeIsoTime(snapshot.capturedAt) !== null;
}

/**
 * usage evidence recordを復元してよいか検査する。
 *
 * @private
 * @function isRestorableUsageEvidence
 * @param {Object|null|undefined} evidence - usage evidence候補。
 * @returns {boolean} 復元可能ならtrue。
 */
function isRestorableUsageEvidence(evidence) {
  return !!evidence &&
    typeof evidence === "object" &&
    !Array.isArray(evidence) &&
    hasRecordString(evidence, "evidenceId") &&
    hasRecordString(evidence, "materialSourceId") &&
    hasRecordString(evidence, "mountId") &&
    hasRecordString(evidence, "snapshotId") &&
    hasRecordString(evidence, "printJobId") &&
    hasRecordString(evidence, "deviceId") &&
    evidence.attribution === "source-specific" &&
    normalizeNonNegativeMm(evidence.usedLengthMm) !== null;
}

/**
 * JobMaterialSegment recordを復元してよいか検査する。
 *
 * @private
 * @function isRestorableJobMaterialSegment
 * @param {Object|null|undefined} segment - segment候補。
 * @returns {boolean} 復元可能ならtrue。
 */
function isRestorableJobMaterialSegment(segment) {
  const usageState = toTrimmedString(segment?.usageState);
  return !!segment &&
    typeof segment === "object" &&
    !Array.isArray(segment) &&
    hasRecordString(segment, "segmentId") &&
    hasRecordString(segment, "printJobId") &&
    hasRecordString(segment, "printPlanId") &&
    hasRecordString(segment, "deviceId") &&
    hasRecordString(segment, "materialSourceId") &&
    ["observed-used", "confirmed-unused", "unknown"].includes(usageState) &&
    (usageState === "unknown" || normalizeNonNegativeMm(segment.usedLengthMm) !== null);
}

/**
 * ledger event recordを復元してよいか検査する。
 *
 * @private
 * @function isRestorableLedgerEvent
 * @param {Object|null|undefined} event - ledger event候補。
 * @returns {boolean} 復元可能ならtrue。
 */
function isRestorableLedgerEvent(event) {
  const usageState = toTrimmedString(event?.usageState);
  return !!event &&
    typeof event === "object" &&
    !Array.isArray(event) &&
    hasRecordString(event, "ledgerEventId") &&
    event.eventType === "material-consumption" &&
    hasRecordString(event, "segmentId") &&
    hasRecordString(event, "printJobId") &&
    hasRecordString(event, "deviceId") &&
    hasRecordString(event, "materialSourceId") &&
    (usageState === "unknown" || normalizeNonNegativeMm(event.usedLengthMm) !== null) &&
    normalizeIsoTime(event.createdAt) !== null;
}

/**
 * 保存済みrecord配列を検査し、壊れたrecordをunsupported evidenceへ退避する。
 *
 * @private
 * @function restoreRecordArray
 * @param {Object} input - 復元入力。
 * @param {Object[]} input.records - record候補配列。
 * @param {string} input.recordType - record種別。
 * @param {Function} input.predicate - 復元可否判定。
 * @param {Object[]} input.retainedUnsupportedEntries - unsupported退避先。
 * @returns {Object[]} 復元可能record配列。
 */
function restoreRecordArray({ records, recordType, predicate, retainedUnsupportedEntries }) {
  const restored = [];
  for (const [index, record] of (Array.isArray(records) ? records : []).entries()) {
    if (predicate(record)) {
      restored.push(cloneJsonValue(record));
    } else {
      retainedUnsupportedEntries.push({
        recordType,
        index,
        record: cloneJsonValue(record),
        reason: "invalid-stored-record",
      });
    }
  }
  return restored;
}

/**
 * stored repositoryを正規化する。
 *
 * @function normalizeStoredMaterialAccountingPrintBindingStore
 * @param {*} stored - 保存済みstore候補。
 * @returns {Object} 正規化済みstore。
 */
export function normalizeStoredMaterialAccountingPrintBindingStore(stored) {
  const source = stored && typeof stored === "object" && !Array.isArray(stored)
    ? stored
    : {};
  const retainedUnsupportedEntries = Array.isArray(source.retainedUnsupportedEntries)
    ? source.retainedUnsupportedEntries.map((entry) => cloneJsonValue(entry))
    : [];
  return {
    schemaVersion: MATERIAL_ACCOUNTING_PRINT_BINDING_SCHEMA_VERSION,
    authority: "material-accounting-print-binding-shadow-store",
    printStartSnapshots: restoreRecordArray({
      records: source.printStartSnapshots,
      recordType: "printStartSnapshot",
      predicate: isRestorablePrintStartSnapshot,
      retainedUnsupportedEntries,
    }),
    usageEvidence: restoreRecordArray({
      records: source.usageEvidence,
      recordType: "usageEvidence",
      predicate: isRestorableUsageEvidence,
      retainedUnsupportedEntries,
    }),
    jobMaterialSegments: restoreRecordArray({
      records: source.jobMaterialSegments,
      recordType: "jobMaterialSegment",
      predicate: isRestorableJobMaterialSegment,
      retainedUnsupportedEntries,
    }),
    ledgerEvents: restoreRecordArray({
      records: source.ledgerEvents,
      recordType: "ledgerEvent",
      predicate: isRestorableLedgerEvent,
      retainedUnsupportedEntries,
    }),
    unattributedUsage: Array.isArray(source.unattributedUsage)
      ? source.unattributedUsage.map((usage) => cloneJsonValue(usage))
      : [],
    operationsById: source.operationsById && typeof source.operationsById === "object"
      ? cloneJsonValue(source.operationsById)
      : {},
    invariants: {
      legacyUsageHistoryWrites: false,
      legacySpoolRemainingWrites: false,
      materialSourceLedgerWrites: "shadow-only",
    },
    retainedUnsupportedEntries,
  };
}

/**
 * repository resultを生成する。
 *
 * @private
 * @function createResult
 * @param {Object} input - result入力。
 * @returns {Object} freeze済みresult。
 */
function createResult(input) {
  return deepFreezeJson({
    ok: input.ok === true,
    status: input.status || (input.ok ? MATERIAL_ACCOUNTING_PRINT_BINDING_STATUS.RECORDED : MATERIAL_ACCOUNTING_PRINT_BINDING_STATUS.BLOCKED),
    action: input.action || input.status || null,
    reasons: Array.isArray(input.reasons) ? [...new Set(input.reasons)] : [],
    snapshots: Array.isArray(input.snapshots) ? input.snapshots.map((snapshot) => cloneJsonValue(snapshot)) : [],
    usageEvidence: Array.isArray(input.usageEvidence) ? input.usageEvidence.map((evidence) => cloneJsonValue(evidence)) : [],
    segments: Array.isArray(input.segments) ? input.segments.map((segment) => cloneJsonValue(segment)) : [],
    ledgerEvents: Array.isArray(input.ledgerEvents) ? input.ledgerEvents.map((event) => cloneJsonValue(event)) : [],
    unattributedUsage: Array.isArray(input.unattributedUsage) ? input.unattributedUsage.map((usage) => cloneJsonValue(usage)) : [],
  });
}

/**
 * ledger event候補を生成する。
 *
 * @private
 * @function createLedgerEvent
 * @param {Object} segment - JobMaterialSegment候補。
 * @param {string} createdAt - 作成時刻。
 * @returns {Object} shadow ledger event。
 */
function createLedgerEvent(segment, createdAt) {
  const hasDebitAmount = segment.usedLengthMm !== null && segment.usedLengthMm > 0;
  const canDebitRemaining = Boolean(segment.debit?.canDebit && hasDebitAmount);
  return {
    schemaVersion: 1,
    ledgerEventId: createPrinterCoreV3DeterministicId("material-accounting-shadow-ledger-event", [
      segment.segmentId,
      "consumption",
      1,
    ]),
    consumptionIdentity: createPrinterCoreV3DeterministicId("material-accounting-shadow-consumption", [
      segment.segmentId,
    ]),
    eventRevision: 1,
    eventType: "material-consumption",
    printJobId: segment.printJobId,
    printPlanId: segment.printPlanId,
    segmentId: segment.segmentId,
    deviceId: segment.deviceId,
    materialSourceId: segment.materialSourceId,
    mountId: segment.mountId,
    spoolId: segment.spoolId,
    usedLengthMm: segment.usedLengthMm,
    usageState: segment.usageState,
    confidence: segment.confidence,
    createdAt,
    authority: {
      mode: "shadow-ledger-candidate",
      canAppend: true,
      canDebitRemaining,
      appliesToLegacyInventory: false,
    },
  };
}

/**
 * MaterialSource print binding repositoryをissuer注入で生成する。
 *
 * 【詳細説明】
 * - trusted evidence issuerは契約モジュール側のprivate関数から注入される。
 * - このimplementation単体ではtrusted objectを発行できず、偽issuerではdebit評価を通過できない。
 * - completion時は保存済みsnapshotへusageを帰属し、現在mountへ後付け帰属しない。
 *
 * @function createMaterialAccountingPrintBindingRepositoryWithIssuer
 * @param {Object} dependencies - 契約モジュールから注入されるissuer/validator。
 * @param {Function} dependencies.createTrustedPrintStartMaterialSnapshot - trusted snapshot issuer。
 * @param {Function} dependencies.createTrustedSourceSpecificMaterialUsageEvidence - trusted usage issuer。
 * @param {Function} dependencies.evaluateMaterialDebitEligibility - debit eligibility evaluator。
 * @param {Function} dependencies.validateMaterialSource - MaterialSource validator。
 * @param {Function} dependencies.validateSpoolMount - SpoolMount validator。
 * @param {Object=} initialStore - 復元用store。
 * @returns {Object} repository API。
 * @example
 * const repository = createMaterialAccountingPrintBindingRepositoryWithIssuer(dependencies);
 */
export function createMaterialAccountingPrintBindingRepositoryWithIssuer(dependencies = {}, initialStore = {}) {
  const createTrustedPrintStartMaterialSnapshot = dependencies.createTrustedPrintStartMaterialSnapshot;
  const createTrustedSourceSpecificMaterialUsageEvidence = dependencies.createTrustedSourceSpecificMaterialUsageEvidence;
  const evaluateMaterialDebitEligibility = dependencies.evaluateMaterialDebitEligibility;
  const validateMaterialSource = dependencies.validateMaterialSource;
  const validateSpoolMount = dependencies.validateSpoolMount;
  if (typeof createTrustedPrintStartMaterialSnapshot !== "function" ||
      typeof createTrustedSourceSpecificMaterialUsageEvidence !== "function" ||
      typeof evaluateMaterialDebitEligibility !== "function" ||
      typeof validateMaterialSource !== "function" ||
      typeof validateSpoolMount !== "function") {
    throw new TypeError("Material print binding repository requires contract-owned issuer dependencies.");
  }
  const store = normalizeStoredMaterialAccountingPrintBindingStore(initialStore);
  const snapshotsById = mapById(store.printStartSnapshots, "snapshotId");
  const snapshotsByPlanSource = new Map();
  const snapshotsByPlanKey = new Map();
  const operationRecords = new Map(Object.entries(store.operationsById));

  for (const snapshot of store.printStartSnapshots) {
    snapshotsByPlanSource.set(
      `${snapshot.printJobId}:${snapshot.printPlanId}:${snapshot.materialSourceId}`,
      snapshot,
    );
    const planKey = `${snapshot.printJobId}:${snapshot.printPlanId}`;
    const snapshots = snapshotsByPlanKey.get(planKey) || [];
    snapshots.push(snapshot);
    snapshotsByPlanKey.set(planKey, snapshots);
  }

  /**
   * repository storeへoperationを記録する。
   *
   * @private
   * @function recordOperation
   * @param {string} operationId - operation ID。
   * @param {string} digest - semantic digest。
   * @param {Object} result - operation result。
   * @returns {void}
   */
  function recordOperation(operationId, digest, result) {
    const record = {
      operationId,
      digest,
      result: cloneJsonValue(result),
    };
    operationRecords.set(operationId, record);
    store.operationsById[operationId] = cloneJsonValue(record);
  }

  /**
   * print-start時点のMaterialSource bindingを記録する。
   *
   * @function recordPrintStartBindings
   * @param {Object} input - binding入力。
   * @param {Object} input.printPlan - PrintPlan。
   * @param {string} input.printJobId - PrintJob ID。
   * @param {Object[]} input.materialSources - MaterialSource配列。
   * @param {Object[]} input.spoolMounts - SpoolMount配列。
   * @param {string} input.capturedAt - print-start時刻。
   * @param {string} input.bindingOperationId - binding operation ID。
   * @returns {Object} repository result。
   */
  function recordPrintStartBindings(input = {}) {
    const printPlan = input.printPlan;
    const printJobId = toTrimmedString(input.printJobId);
    const capturedAt = normalizeIsoTime(input.capturedAt);
    const operationId = toTrimmedString(input.bindingOperationId);
    const planValidation = validatePrintPlan(printPlan);
    const sourceMap = mapById(input.materialSources, "materialSourceId");
    const reasons = [];
    if (!planValidation.ok) {
      reasons.push(...planValidation.errors);
    }
    if (!printJobId) {
      reasons.push("print-job-id-required");
    }
    if (!capturedAt) {
      reasons.push("captured-at-required");
    }
    if (!operationId) {
      reasons.push("binding-operation-id-required");
    }
    const plannedSnapshots = [];
    if (reasons.length === 0) {
      for (const assignment of printPlan.toolAssignments) {
        const source = sourceMap.get(assignment.materialSourceId);
        const mount = findMountForAssignment(assignment, input.spoolMounts);
        if (!source || !validateMaterialSource(source).ok) {
          reasons.push("material-source-required");
          continue;
        }
        if (!mount || !validateSpoolMount(mount).ok) {
          reasons.push("spool-mount-required");
          continue;
        }
        plannedSnapshots.push(createTrustedPrintStartMaterialSnapshot({
          deviceId: printPlan.deviceId,
          printJobId,
          printPlanId: printPlan.printPlanId,
          materialSourceId: source.materialSourceId,
          mountId: mount.mountId,
          spoolId: mount.spoolId,
          toolId: assignment.toolId,
          protocolToolAlias: assignment.protocolToolAlias || assignment.toolAlias,
          order: Number.isFinite(Number(assignment.order)) ? Number(assignment.order) : plannedSnapshots.length,
          capturedAt,
          materialSource: source,
          spoolMount: mount,
          bindingOperationId: operationId,
        }));
      }
    }
    const digest = createOperationDigest("material-print-start-binding-operation", {
      printJobId,
      printPlanId: printPlan?.printPlanId || null,
      capturedAt,
      snapshotIds: plannedSnapshots.map((snapshot) => snapshot.snapshotId),
    });
    const hasSnapshotPayloadConflict = plannedSnapshots.some((snapshot) => {
      const existing = snapshotsById.get(snapshot.snapshotId);
      return existing && stableStringifyPrinterCoreV3Value(existing) !== stableStringifyPrinterCoreV3Value(snapshot);
    });
    if (hasSnapshotPayloadConflict) {
      return createResult({
        ok: false,
        status: MATERIAL_ACCOUNTING_PRINT_BINDING_STATUS.BLOCKED,
        action: "conflict",
        reasons: ["print-start-snapshot-payload-conflict"],
      });
    }
    const existing = operationRecords.get(operationId);
    if (existing && existing.digest !== digest) {
      return createResult({
        ok: false,
        status: MATERIAL_ACCOUNTING_PRINT_BINDING_STATUS.BLOCKED,
        action: "conflict",
        reasons: ["binding-operation-payload-conflict"],
      });
    }
    if (existing && existing.digest === digest) {
      return createResult({
        ...existing.result,
        ok: true,
        status: MATERIAL_ACCOUNTING_PRINT_BINDING_STATUS.IDEMPOTENT,
        action: "idempotent",
      });
    }
    if (reasons.length > 0) {
      return createResult({
        ok: false,
        status: MATERIAL_ACCOUNTING_PRINT_BINDING_STATUS.BLOCKED,
        reasons,
      });
    }
    for (const snapshot of plannedSnapshots) {
      if (!snapshotsById.has(snapshot.snapshotId)) {
        store.printStartSnapshots.push(cloneJsonValue(snapshot));
      }
      snapshotsById.set(snapshot.snapshotId, snapshot);
      snapshotsByPlanSource.set(
        `${snapshot.printJobId}:${snapshot.printPlanId}:${snapshot.materialSourceId}`,
        snapshot,
      );
      const planKey = `${snapshot.printJobId}:${snapshot.printPlanId}`;
      const snapshots = snapshotsByPlanKey.get(planKey) || [];
      if (!snapshots.some((entry) => entry.snapshotId === snapshot.snapshotId)) {
        snapshots.push(snapshot);
      }
      snapshotsByPlanKey.set(planKey, snapshots);
    }
    const result = createResult({
      ok: true,
      status: MATERIAL_ACCOUNTING_PRINT_BINDING_STATUS.RECORDED,
      action: "recorded",
      snapshots: plannedSnapshots,
    });
    recordOperation(operationId, digest, result);
    return result;
  }

  /**
   * completion observationをMaterialSource単位へ帰属する。
   *
   * @function recordUsageAttribution
   * @param {Object} input - usage attribution入力。
   * @param {Object} input.printPlan - PrintPlan。
   * @param {string} input.printJobId - PrintJob ID。
   * @param {string} input.completedAt - completion時刻。
   * @param {string} input.attributionOperationId - attribution operation ID。
   * @param {Object[]} input.materialUsages - source-specific usage観測。
   * @param {number=} input.totalUsedLengthMm - total-only usage観測。
   * @param {"complete"|"partial"=} input.resultSetCompleteness - source-specific結果集合の完全性。
   * @param {Object<string,Object>=} input.continuityBySourceId - source continuity evidence。
   * @returns {Object} repository result。
   */
  function recordUsageAttribution(input = {}) {
    const printPlan = input.printPlan;
    const printJobId = toTrimmedString(input.printJobId);
    const completedAt = normalizeIsoTime(input.completedAt);
    const operationId = toTrimmedString(input.attributionOperationId);
    const materialUsages = Array.isArray(input.materialUsages) ? input.materialUsages : [];
    const resultSetCompleteness = input.trustedResultSetCompleteness === true &&
      input.resultSetCompleteness === "complete"
      ? "complete"
      : "partial";
    const totalUsedLengthMm = normalizeNonNegativeMm(input.totalUsedLengthMm);
    const digest = createOperationDigest("material-usage-attribution-operation", {
      printJobId,
      printPlanId: printPlan?.printPlanId || null,
      completedAt,
      resultSetCompleteness,
      materialUsages,
      totalUsedLengthMm,
    });
    const existing = operationRecords.get(operationId);
    if (existing && existing.digest !== digest) {
      return createResult({
        ok: false,
        status: MATERIAL_ACCOUNTING_PRINT_BINDING_STATUS.BLOCKED,
        action: "conflict",
        reasons: ["usage-attribution-operation-payload-conflict"],
      });
    }
    if (existing && existing.digest === digest) {
      return createResult({
        ...existing.result,
        ok: true,
        status: MATERIAL_ACCOUNTING_PRINT_BINDING_STATUS.IDEMPOTENT,
        action: "idempotent",
      });
    }

    const reasons = [];
    if (!printPlan || typeof printPlan !== "object" || Array.isArray(printPlan)) {
      reasons.push("print-plan-required");
    }
    if (!toTrimmedString(printPlan?.printPlanId)) {
      reasons.push("print-plan-id-required");
    }
    if (!toTrimmedString(printPlan?.deviceId)) {
      reasons.push("print-plan-device-required");
    }
    if (!printJobId) {
      reasons.push("print-job-id-required");
    }
    if (!completedAt) {
      reasons.push("completed-at-required");
    }
    if (!operationId) {
      reasons.push("attribution-operation-id-required");
    }
    const planKey = `${printJobId}:${printPlan?.printPlanId || ""}`;
    const plannedSnapshots = (snapshotsByPlanKey.get(planKey) || [])
      .map((snapshot) => snapshot)
      .sort((a, b) => {
        const orderA = Number.isFinite(Number(a.order)) ? Number(a.order) : 0;
        const orderB = Number.isFinite(Number(b.order)) ? Number(b.order) : 0;
        return orderA - orderB;
      });
    const usageResolution = resolveUsageEntriesForSnapshots(plannedSnapshots, materialUsages);
    if (plannedSnapshots.length === 1 &&
        totalUsedLengthMm !== null &&
        usageResolution.entriesBySnapshotId.size === 0 &&
        usageResolution.reasons.length === 0) {
      const snapshot = plannedSnapshots[0];
      usageResolution.entriesBySnapshotId.set(snapshot.snapshotId, {
        toolId: snapshot.toolId,
        protocolToolAlias: snapshot.protocolToolAlias,
        materialSourceId: snapshot.materialSourceId,
        usedLengthMm: totalUsedLengthMm,
        source: "firmware-total-single-source",
      });
      usageResolution.sourceSpecificTotalMm = totalUsedLengthMm;
    }
    const hasSourceSpecificUsage = usageResolution.entriesBySnapshotId.size > 0;
    const unattributedUsage = [];
    if (plannedSnapshots.length > 1 && totalUsedLengthMm !== null && !hasSourceSpecificUsage) {
      unattributedUsage.push({
        printJobId,
        printPlanId: printPlan.printPlanId,
        deviceId: printPlan.deviceId,
        usedLengthMm: totalUsedLengthMm,
        reason: "multi-source-total-only",
      });
    }
    if (plannedSnapshots.length > 1 &&
        totalUsedLengthMm !== null &&
        hasSourceSpecificUsage &&
        totalUsedLengthMm > usageResolution.sourceSpecificTotalMm) {
      unattributedUsage.push({
        printJobId,
        printPlanId: printPlan.printPlanId,
        deviceId: printPlan.deviceId,
        usedLengthMm: totalUsedLengthMm - usageResolution.sourceSpecificTotalMm,
        reason: "multi-source-total-residual",
      });
    }
    if (plannedSnapshots.length > 1 &&
        totalUsedLengthMm !== null &&
        hasSourceSpecificUsage &&
        totalUsedLengthMm < usageResolution.sourceSpecificTotalMm) {
      reasons.push("total-usage-less-than-source-specific");
    }
    if (plannedSnapshots.length === 0) {
      reasons.push("print-start-snapshots-required");
    }
    reasons.push(...usageResolution.reasons);
    if (reasons.length > 0) {
      return createResult({
        ok: false,
        status: MATERIAL_ACCOUNTING_PRINT_BINDING_STATUS.BLOCKED,
        reasons,
        unattributedUsage,
      });
    }

    const usageEvidence = [];
    const segments = plannedSnapshots.map((snapshot, index) => {
      const usageEntry = usageResolution.entriesBySnapshotId.get(snapshot.snapshotId) || null;
      const entryLength = getUsageEntryLengthMm(usageEntry);
      const usageState = entryLength !== null
        ? (entryLength > 0 ? "observed-used" : "confirmed-unused")
        : (resultSetCompleteness === "complete" ? "confirmed-unused" : "unknown");
      const usedLengthMm = entryLength !== null
        ? entryLength
        : (usageState === "confirmed-unused" ? 0 : null);
      const evidence = usedLengthMm !== null && snapshot
        ? createShadowSourceSpecificMaterialUsageEvidence({
          materialSourceId: snapshot.materialSourceId,
          mountId: snapshot.mountId,
          snapshotId: snapshot.snapshotId,
          printJobId,
          deviceId: printPlan.deviceId,
          usageSegmentId: `segment:${snapshot.toolId}`,
          usedLengthMm,
          source: "firmware-source-specific",
          measurementMethod: "firmware-source",
          observedAt: completedAt,
          idempotencyKey: createPrinterCoreV3DeterministicId("material-usage-attribution", [
            printJobId,
            printPlan.printPlanId,
            snapshot.toolId,
            snapshot.snapshotId,
          ]),
        })
        : null;
      const debit = {
        status: "blocked",
        canDebit: false,
        reasons: ["shadow-only-attribution-not-debit-authority"],
      };
      if (evidence) {
        usageEvidence.push(evidence);
      }
      const toolId = Number.isFinite(Number(snapshot.toolId)) ? Number(snapshot.toolId) : index;
      return {
        schemaVersion: MATERIAL_ACCOUNTING_PRINT_BINDING_SCHEMA_VERSION,
        segmentId: createPrinterCoreV3DeterministicId("material-accounting-job-segment", [
          printJobId,
          printPlan.printPlanId,
          toolId,
          snapshot.materialSourceId,
        ]),
        printJobId,
        printPlanId: printPlan.printPlanId,
        deviceId: printPlan.deviceId,
        toolId,
        protocolToolAlias: snapshot.protocolToolAlias,
        materialSourceId: snapshot?.materialSourceId || null,
        mountId: snapshot?.mountId || null,
        spoolId: snapshot?.spoolId || null,
        usedLengthMm,
        usageState,
        confidence: evidence?.confidence || "unknown",
        sourceSnapshotId: snapshot?.snapshotId || null,
        order: Number.isFinite(Number(snapshot.order)) ? Number(snapshot.order) : index,
        evidence: evidence ? { usageEvidenceId: evidence.evidenceId } : {},
        debit: {
          status: debit.status,
          canDebit: Boolean(debit.canDebit && usedLengthMm > 0),
          reasons: debit.reasons,
        },
        authority: {
          mode: "shadow-attribution-read-only",
          canDebitLegacyInventory: false,
        },
      };
    });
    const ledgerEvents = segments.map((segment) => createLedgerEvent(segment, completedAt));

    const existingSegmentsById = mapById(store.jobMaterialSegments, "segmentId");
    const existingLedgerEventsById = mapById(store.ledgerEvents, "ledgerEventId");
    const hasExistingDifferentSegment = segments.some((segment) => {
      const existing = existingSegmentsById.get(segment.segmentId);
      return existing && stableStringifyPrinterCoreV3Value(existing) !== stableStringifyPrinterCoreV3Value(segment);
    });
    const allSegmentsAlreadyRecorded = segments.length > 0 &&
      segments.every((segment) => {
        const existing = existingSegmentsById.get(segment.segmentId);
        return existing && stableStringifyPrinterCoreV3Value(existing) === stableStringifyPrinterCoreV3Value(segment);
      }) &&
      ledgerEvents.every((event) => existingLedgerEventsById.has(event.ledgerEventId));
    if (hasExistingDifferentSegment) {
      return createResult({
        ok: false,
        status: MATERIAL_ACCOUNTING_PRINT_BINDING_STATUS.BLOCKED,
        action: "conflict",
        reasons: ["usage-segment-payload-conflict"],
      });
    }
    if (allSegmentsAlreadyRecorded) {
      const result = createResult({
        ok: true,
        status: MATERIAL_ACCOUNTING_PRINT_BINDING_STATUS.IDEMPOTENT,
        action: "idempotent",
        segments,
        usageEvidence,
        ledgerEvents,
        unattributedUsage,
      });
      recordOperation(operationId, digest, result);
      return result;
    }

    store.usageEvidence.push(...usageEvidence.map((evidence) => cloneJsonValue(evidence)));
    store.jobMaterialSegments.push(...segments
      .filter((segment) => !existingSegmentsById.has(segment.segmentId))
      .map((segment) => cloneJsonValue(segment)));
    store.ledgerEvents.push(...ledgerEvents
      .filter((event) => !existingLedgerEventsById.has(event.ledgerEventId))
      .map((event) => cloneJsonValue(event)));
    store.unattributedUsage.push(...unattributedUsage.map((usage) => cloneJsonValue(usage)));

    const result = createResult({
      ok: unattributedUsage.length === 0,
      status: unattributedUsage.length === 0
        ? MATERIAL_ACCOUNTING_PRINT_BINDING_STATUS.RECORDED
        : MATERIAL_ACCOUNTING_PRINT_BINDING_STATUS.PENDING,
      action: unattributedUsage.length === 0 ? "recorded" : "pending",
      segments,
      usageEvidence,
      ledgerEvents,
      unattributedUsage,
    });
    recordOperation(operationId, digest, result);
    return result;
  }

  /**
   * repository snapshotを返す。
   *
   * @function toJSON
   * @returns {Object} repository snapshot。
   */
  function toJSON() {
    return deepFreezeJson(normalizeStoredMaterialAccountingPrintBindingStore(store));
  }

  return Object.freeze({
    recordPrintStartBindings,
    recordUsageAttribution,
    toJSON,
  });
}
