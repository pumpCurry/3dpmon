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
 * @version 1.390.1516 (PR #438)
 * @since   1.390.1516 (PR #438)
 * @lastModified 2026-08-31 14:36:00
 * -----------------------------------------------------------
 * @todo
 * - Gate 18.9F でsource-aware残量read model/UIへ接続する
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
 * tool assignmentに対応するusage entryを探す。
 *
 * @private
 * @function findUsageEntryForAssignment
 * @param {Object} assignment - PrintPlan tool assignment。
 * @param {Object[]} materialUsages - usage entry配列。
 * @returns {Object|null} 対応usage entry。
 */
function findUsageEntryForAssignment(assignment, materialUsages) {
  const toolId = Number(assignment?.toolId);
  const protocolToolAlias = toTrimmedString(assignment?.protocolToolAlias || assignment?.toolAlias);
  const materialSourceId = toTrimmedString(assignment?.materialSourceId);
  const entries = Array.isArray(materialUsages) ? materialUsages : [];
  return entries.find((entry) => Number(entry?.toolId) === toolId) ||
    entries.find((entry) => protocolToolAlias && toTrimmedString(entry?.protocolToolAlias || entry?.toolAlias) === protocolToolAlias) ||
    entries.find((entry) => materialSourceId && toTrimmedString(entry?.materialSourceId) === materialSourceId) ||
    null;
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
  return {
    schemaVersion: MATERIAL_ACCOUNTING_PRINT_BINDING_SCHEMA_VERSION,
    authority: "material-accounting-print-binding-shadow-store",
    printStartSnapshots: Array.isArray(source.printStartSnapshots)
      ? source.printStartSnapshots.map((snapshot) => cloneJsonValue(snapshot))
      : [],
    usageEvidence: Array.isArray(source.usageEvidence)
      ? source.usageEvidence.map((evidence) => cloneJsonValue(evidence))
      : [],
    jobMaterialSegments: Array.isArray(source.jobMaterialSegments)
      ? source.jobMaterialSegments.map((segment) => cloneJsonValue(segment))
      : [],
    ledgerEvents: Array.isArray(source.ledgerEvents)
      ? source.ledgerEvents.map((event) => cloneJsonValue(event))
      : [],
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
  const operationRecords = new Map(Object.entries(store.operationsById));

  for (const snapshot of store.printStartSnapshots) {
    snapshotsByPlanSource.set(
      `${snapshot.printJobId}:${snapshot.printPlanId}:${snapshot.materialSourceId}`,
      snapshot,
    );
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
    const resultSetCompleteness = input.resultSetCompleteness === "complete" ? "complete" : "partial";
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

    const planValidation = validatePrintPlan(printPlan);
    const reasons = [];
    if (!planValidation.ok) {
      reasons.push(...planValidation.errors);
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
    const hasSourceSpecificUsage = materialUsages.some((entry) => normalizeNonNegativeMm(
      entry?.usedLengthMm ?? entry?.usedMm ?? entry?.materialUsedMm ?? entry?.deltaUsedMm
    ) !== null);
    const unattributedUsage = [];
    if (printPlan?.materialSourceIds?.length > 1 && totalUsedLengthMm !== null && !hasSourceSpecificUsage) {
      unattributedUsage.push({
        printJobId,
        printPlanId: printPlan.printPlanId,
        deviceId: printPlan.deviceId,
        usedLengthMm: totalUsedLengthMm,
        reason: "multi-source-total-only",
      });
    }
    if (reasons.length > 0) {
      return createResult({
        ok: false,
        status: MATERIAL_ACCOUNTING_PRINT_BINDING_STATUS.BLOCKED,
        reasons,
        unattributedUsage,
      });
    }

    const usageEvidence = [];
    const segments = printPlan.toolAssignments.map((assignment, index) => {
      const snapshot = snapshotsByPlanSource.get(`${printJobId}:${printPlan.printPlanId}:${assignment.materialSourceId}`);
      const usageEntry = findUsageEntryForAssignment(assignment, materialUsages);
      const entryLength = normalizeNonNegativeMm(
        usageEntry?.usedLengthMm ?? usageEntry?.usedMm ?? usageEntry?.materialUsedMm ?? usageEntry?.deltaUsedMm
      );
      const usageState = entryLength !== null
        ? (entryLength > 0 ? "observed-used" : "confirmed-unused")
        : (resultSetCompleteness === "complete" ? "confirmed-unused" : "unknown");
      const usedLengthMm = entryLength !== null
        ? entryLength
        : (usageState === "confirmed-unused" ? 0 : null);
      const source = snapshot?.materialSource || null;
      const mount = snapshot?.spoolMount || null;
      const evidence = usedLengthMm !== null && snapshot
        ? createTrustedSourceSpecificMaterialUsageEvidence({
          materialSourceId: snapshot.materialSourceId,
          mountId: snapshot.mountId,
          snapshotId: snapshot.snapshotId,
          printJobId,
          deviceId: printPlan.deviceId,
          usageSegmentId: `segment:${assignment.toolId}`,
          usedLengthMm,
          source: "firmware-source-specific",
          measurementMethod: "firmware-source",
          observedAt: completedAt,
          idempotencyKey: createPrinterCoreV3DeterministicId("material-usage-attribution", [
            operationId,
            assignment.toolId,
            snapshot.snapshotId,
          ]),
        })
        : null;
      const debit = evidence && snapshot
        ? evaluateMaterialDebitEligibility({
          mount,
          materialSource: source,
          usageEvidence: evidence,
          printStartSnapshot: snapshot,
          continuity: input.continuityBySourceId?.[snapshot.materialSourceId] || {},
        })
        : { status: "blocked", canDebit: false, reasons: ["print-start-snapshot-required"] };
      if (evidence) {
        usageEvidence.push(evidence);
      }
      return {
        schemaVersion: MATERIAL_ACCOUNTING_PRINT_BINDING_SCHEMA_VERSION,
        segmentId: createPrinterCoreV3DeterministicId("material-accounting-job-segment", [
          printJobId,
          printPlan.printPlanId,
          assignment.toolId,
          assignment.materialSourceId,
        ]),
        printJobId,
        printPlanId: printPlan.printPlanId,
        deviceId: printPlan.deviceId,
        toolId: assignment.toolId,
        protocolToolAlias: assignment.protocolToolAlias,
        materialSourceId: snapshot?.materialSourceId || assignment.materialSourceId,
        mountId: snapshot?.mountId || null,
        spoolId: snapshot?.spoolId || assignment.spoolId || null,
        usedLengthMm,
        usageState,
        confidence: evidence?.confidence || "unknown",
        sourceSnapshotId: snapshot?.snapshotId || null,
        order: Number.isFinite(Number(assignment.order)) ? Number(assignment.order) : index,
        evidence: evidence ? { usageEvidenceId: evidence.evidenceId } : {},
        debit: {
          status: debit.status,
          canDebit: Boolean(debit.canDebit && usedLengthMm > 0),
          reasons: debit.reasons,
        },
        authority: {
          mode: "shadow-attribution",
          canDebitLegacyInventory: false,
        },
      };
    });
    const ledgerEvents = segments.map((segment) => createLedgerEvent(segment, completedAt));
    store.usageEvidence.push(...usageEvidence.map((evidence) => cloneJsonValue(evidence)));
    store.jobMaterialSegments.push(...segments.map((segment) => cloneJsonValue(segment)));
    store.ledgerEvents.push(...ledgerEvents.map((event) => cloneJsonValue(event)));
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
