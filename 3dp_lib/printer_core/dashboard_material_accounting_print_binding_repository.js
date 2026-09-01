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
 * - Gate 18.9E の shadow print-start material binding snapshot を保持する内部実装を提供
 * - source-specific usage observation をMaterialSource/SpoolMount単位へ帰属
 * - total-only multi-source usageをpending/unattributedとして隔離
 *
 * 【公開関数一覧】
 * - {@link normalizeStoredMaterialAccountingPrintBindingStore}：保存済みprint binding storeを正規化
 * - {@link createMaterialAccountingPrintBindingRepositoryWithIssuer}：issuer注入済みprint binding repositoryを生成
 *
 * @version 1.390.1595 (PR #440)
 * @since   1.390.1516 (PR #438)
 * @lastModified 2026-09-01 19:17:01
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
 * logical tool IDを厳密に正規化する。
 *
 * 【詳細説明】
 * - `Number("") === 0` のJavaScript暗黙変換で、未指定toolがT0へ誤帰属することを防ぐ。
 * - 空値は未指定としてnullにし、0以上の整数だけをtool IDとして扱う。
 *
 * @private
 * @function normalizeToolId
 * @param {*} value - tool ID候補。
 * @returns {number|null} 正規化済みtool ID。不正または未指定の場合null。
 */
function normalizeToolId(value) {
  if (value === undefined || value === null || typeof value === "boolean" || Array.isArray(value) ||
      (typeof value === "object" && value !== null)) {
    return null;
  }
  if (typeof value === "string" && value.trim() === "") {
    return null;
  }
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue >= 0 ? numberValue : null;
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
 * sourceに対応するprint-start時点のactive open mountを解決する。
 *
 * @private
 * @function findMountForAssignment
 * @param {Object} assignment - PrintPlan tool assignment。
 * @param {Object[]} spoolMounts - SpoolMount配列。
 * @param {string} capturedAt - print-start時刻。
 * @returns {{mount:Object|null,reason:string|null}} 対応mountと失敗理由。
 */
function findMountForAssignment(assignment, spoolMounts, capturedAt) {
  const sourceId = toTrimmedString(assignment?.materialSourceId);
  const assignmentSpoolId = toTrimmedString(assignment?.spoolId);
  const capturedEpoch = Date.parse(capturedAt);
  const candidateMounts = (Array.isArray(spoolMounts) ? spoolMounts : []).filter((mount) => {
    if (toTrimmedString(mount?.materialSourceId) !== sourceId) {
      return false;
    }
    if (assignmentSpoolId && toTrimmedString(mount?.spoolId) !== assignmentSpoolId) {
      return false;
    }
    return mount?.status === "open";
  });
  if (candidateMounts.length === 0) {
    return { mount: null, reason: "spool-mount-required" };
  }
  const activeMounts = candidateMounts.filter((mount) => {
    const openedAt = normalizeIsoTime(mount?.openedAt);
    const closedAt = normalizeIsoTime(mount?.closedAt);
    const openedEpoch = openedAt ? Date.parse(openedAt) : Number.NEGATIVE_INFINITY;
    const closedEpoch = closedAt ? Date.parse(closedAt) : Number.POSITIVE_INFINITY;
    return openedEpoch <= capturedEpoch && capturedEpoch < closedEpoch;
  });
  if (activeMounts.length === 0) {
    return { mount: null, reason: "spool-mount-not-active-at-print-start" };
  }
  if (activeMounts.length > 1) {
    return { mount: null, reason: "spool-mount-ambiguous-at-print-start" };
  }
  return { mount: activeMounts[0], reason: null };
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
  return {
    toolId: normalizeToolId(entry?.toolId),
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
  return {
    toolId: normalizeToolId(snapshot?.toolId),
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
 * read-only print-start material snapshotを生成する。
 *
 * 【詳細説明】
 * - public print binding repositoryがtrusted debit authorityをmintしないためのshadow snapshot。
 * - completion時のsource/mount/spool/tool対応を固定するが、debit eligibilityのtrusted snapshotとしては扱わない。
 *
 * @private
 * @function createShadowPrintStartMaterialSnapshot
 * @param {Object} input - snapshot入力。
 * @returns {Object} read-only shadow print-start snapshot。
 */
function createShadowPrintStartMaterialSnapshot(input = {}) {
  const deviceId = toTrimmedString(input.deviceId);
  const printJobId = toTrimmedString(input.printJobId);
  const printPlanId = toTrimmedString(input.printPlanId);
  const materialSourceId = toTrimmedString(input.materialSourceId);
  const mountId = toTrimmedString(input.mountId);
  const snapshotId = toTrimmedString(input.snapshotId) ||
    createPrinterCoreV3DeterministicId("material-print-start-snapshot-shadow", [
      deviceId,
      printJobId,
      printPlanId,
      materialSourceId,
      mountId,
    ]);
  return deepFreezeJson({
    schemaVersion: MATERIAL_ACCOUNTING_PRINT_BINDING_SCHEMA_VERSION,
    snapshotId,
    deviceId,
    printJobId,
    printPlanId,
    materialSourceId,
    mountId,
    spoolId: toTrimmedString(input.spoolId),
    toolId: normalizeToolId(input.toolId),
    protocolToolAlias: toTrimmedString(input.protocolToolAlias || input.toolAlias) || null,
    order: normalizeToolId(input.order),
    capturedAt: normalizeIsoTime(input.capturedAt),
    materialSource: cloneJsonValue(input.materialSource || null),
    spoolMount: cloneJsonValue(input.spoolMount || null),
    bindingOperationId: toTrimmedString(input.bindingOperationId) || null,
    trusted: false,
    authority: {
      mode: "shadow-print-start-material-snapshot",
      canBindUsage: false,
    },
    provenance: {
      source: "material-print-binding-shadow-repository",
      attestation: null,
    },
  });
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
 * 【詳細説明】
 * - 同じsemantic IDかつ同じpayloadの重複は1件へ畳み込む。
 * - 同じsemantic IDでpayloadが異なる場合は、入力順でどちらかを勝者にせず、そのIDの全recordを隔離する。
 * - persisted/imported corruptionでは配列順に意味が無いため、first-record survivalを避けてfail-closedにする。
 *
 * @private
 * @function restoreRecordArray
 * @param {Object} input - 復元入力。
 * @param {Object[]} input.records - record候補配列。
 * @param {string} input.recordType - record種別。
 * @param {Function} input.predicate - 復元可否判定。
 * @param {string} input.idKey - semantic ID field。
 * @param {Object[]} input.retainedUnsupportedEntries - unsupported退避先。
 * @returns {Object[]} 復元可能record配列。
 */
function restoreRecordArray({ records, recordType, predicate, idKey, retainedUnsupportedEntries }) {
  const restored = [];
  const entriesById = new Map();
  for (const [index, record] of (Array.isArray(records) ? records : []).entries()) {
    if (predicate(record)) {
      const candidate = cloneJsonValue(record);
      const recordId = toTrimmedString(candidate?.[idKey]);
      const serialized = stableStringifyPrinterCoreV3Value(candidate);
      if (!entriesById.has(recordId)) {
        entriesById.set(recordId, []);
      }
      entriesById.get(recordId).push({ index, record: candidate, serialized });
    } else {
      retainedUnsupportedEntries.push({
        recordType,
        index,
        record: cloneJsonValue(record),
        reason: "invalid-stored-record",
      });
    }
  }
  for (const entries of entriesById.values()) {
    const payloads = new Set(entries.map((entry) => entry.serialized));
    if (payloads.size === 1) {
      restored.push(entries[0].record);
      continue;
    }
    for (const entry of entries) {
      retainedUnsupportedEntries.push({
        recordType,
        index: entry.index,
        record: entry.record,
        reason: "duplicate-semantic-id-conflict",
      });
    }
  }
  return restored;
}

/**
 * cross-record不整合recordをunsupported evidenceへ退避する。
 *
 * 【詳細説明】
 * - 保存済みstoreでは個別recordのshapeが正しくても、参照先snapshot/segmentが欠落している場合がある。
 * - authority配列へ戻す前に、参照整合性を失ったrecordを隔離してrestart後の誤debitを防ぐ。
 *
 * @private
 * @function retainCrossRecordMismatch
 * @param {Object[]} retainedUnsupportedEntries - unsupported退避先。
 * @param {string} recordType - record種別。
 * @param {number} index - 元配列上のindex。
 * @param {Object} record - 退避対象record。
 * @returns {void}
 */
function retainCrossRecordMismatch(retainedUnsupportedEntries, recordType, index, record) {
  retainedUnsupportedEntries.push({
    recordType,
    index,
    record: cloneJsonValue(record),
    reason: "cross-record-mismatch",
  });
}

/**
 * 文字列fieldが一致するかを検査する。
 *
 * 【詳細説明】
 * - 欠落値を空文字へ正規化し、明示field同士のsemantic一致だけを見る。
 *
 * @private
 * @function hasMatchingStringField
 * @param {Object} left - 比較元record。
 * @param {Object} right - 比較先record。
 * @param {string} key - field名。
 * @returns {boolean} 正規化後の文字列が一致する場合true。
 */
function hasMatchingStringField(left, right, key) {
  return toTrimmedString(left?.[key]) === toTrimmedString(right?.[key]);
}

/**
 * 使用量数値が一致するかを検査する。
 *
 * 【詳細説明】
 * - unknown usageでは数値確定していないため比較対象外にする。
 * - observed/confirmedな使用量はmm単位で一致していることを要求する。
 *
 * @private
 * @function hasMatchingUsageLength
 * @param {Object} left - 比較元record。
 * @param {Object} right - 比較先record。
 * @returns {boolean} 使用量が一致、または比較不要ならtrue。
 */
function hasMatchingUsageLength(left, right) {
  const leftLength = normalizeNonNegativeMm(left?.usedLengthMm);
  const rightLength = normalizeNonNegativeMm(right?.usedLengthMm);
  if (leftLength === null || rightLength === null) {
    return true;
  }
  return leftLength === rightLength;
}

/**
 * usage evidenceが参照するsnapshotと一致するかを検査する。
 *
 * 【詳細説明】
 * - evidence単体がsource-specificでも、snapshot参照が失われている場合はdebit根拠へ戻さない。
 *
 * @private
 * @function isUsageEvidenceCrossRecordConsistent
 * @param {Object} evidence - 復元済みusage evidence。
 * @param {Map<string, Object>} snapshotsById - snapshotId別snapshot map。
 * @returns {boolean} 参照整合性がある場合true。
 */
function isUsageEvidenceCrossRecordConsistent(evidence, snapshotsById) {
  const snapshot = snapshotsById.get(toTrimmedString(evidence?.snapshotId));
  return !!snapshot &&
    hasMatchingStringField(evidence, snapshot, "deviceId") &&
    hasMatchingStringField(evidence, snapshot, "printJobId") &&
    hasMatchingStringField(evidence, snapshot, "materialSourceId") &&
    hasMatchingStringField(evidence, snapshot, "mountId");
}

/**
 * segmentに対応するsnapshotを探す。
 *
 * 【詳細説明】
 * - 新形式はsourceSnapshotIdで直接参照する。
 * - 旧形式や移行途中recordではsourceSnapshotIdが無い場合があるため、device/job/plan/source/spool/mountで照合する。
 *
 * @private
 * @function resolveSnapshotForSegment
 * @param {Object} segment - 復元済みJobMaterialSegment。
 * @param {Map<string, Object>} snapshotsById - snapshotId別snapshot map。
 * @param {Object[]} snapshots - 復元済みsnapshot配列。
 * @returns {Object|null} 対応snapshot、またはnull。
 */
function resolveSnapshotForSegment(segment, snapshotsById, snapshots) {
  const sourceSnapshotId = toTrimmedString(segment?.sourceSnapshotId);
  if (sourceSnapshotId) {
    return snapshotsById.get(sourceSnapshotId) || null;
  }
  return snapshots.find((snapshot) => {
    const spoolId = toTrimmedString(segment?.spoolId);
    const mountId = toTrimmedString(segment?.mountId);
    return hasMatchingStringField(segment, snapshot, "deviceId") &&
      hasMatchingStringField(segment, snapshot, "printJobId") &&
      hasMatchingStringField(segment, snapshot, "printPlanId") &&
      hasMatchingStringField(segment, snapshot, "materialSourceId") &&
      (!spoolId || hasMatchingStringField(segment, snapshot, "spoolId")) &&
      (!mountId || hasMatchingStringField(segment, snapshot, "mountId"));
  }) || null;
}

/**
 * JobMaterialSegmentがsnapshot/evidenceと一致するかを検査する。
 *
 * 【詳細説明】
 * - segmentは最終的にledgerへつながるため、復元時点でsource/mount/spool境界を再検査する。
 * - evidence参照がある場合は、先に整合性確認済みのusage evidence配列に存在することも要求する。
 *
 * @private
 * @function isJobMaterialSegmentCrossRecordConsistent
 * @param {Object} segment - 復元済みJobMaterialSegment。
 * @param {Map<string, Object>} snapshotsById - snapshotId別snapshot map。
 * @param {Object[]} snapshots - 復元済みsnapshot配列。
 * @param {Map<string, Object>} usageEvidenceById - evidenceId別usage evidence map。
 * @returns {boolean} 参照整合性がある場合true。
 */
function isJobMaterialSegmentCrossRecordConsistent(segment, snapshotsById, snapshots, usageEvidenceById) {
  const snapshot = resolveSnapshotForSegment(segment, snapshotsById, snapshots);
  if (!snapshot ||
      !hasMatchingStringField(segment, snapshot, "deviceId") ||
      !hasMatchingStringField(segment, snapshot, "printJobId") ||
      !hasMatchingStringField(segment, snapshot, "printPlanId") ||
      !hasMatchingStringField(segment, snapshot, "materialSourceId")) {
    return false;
  }
  const spoolId = toTrimmedString(segment?.spoolId);
  const mountId = toTrimmedString(segment?.mountId);
  if ((spoolId && !hasMatchingStringField(segment, snapshot, "spoolId")) ||
      (mountId && !hasMatchingStringField(segment, snapshot, "mountId"))) {
    return false;
  }
  const usageEvidenceId = toTrimmedString(segment?.evidence?.usageEvidenceId);
  if (!usageEvidenceId) {
    return true;
  }
  const evidence = usageEvidenceById.get(usageEvidenceId);
  return !!evidence &&
    hasMatchingStringField(evidence, segment, "deviceId") &&
    hasMatchingStringField(evidence, segment, "printJobId") &&
    hasMatchingStringField(evidence, segment, "materialSourceId") &&
    (!mountId || hasMatchingStringField(evidence, segment, "mountId")) &&
    (!toTrimmedString(evidence.snapshotId) || toTrimmedString(evidence.snapshotId) === toTrimmedString(snapshot.snapshotId)) &&
    hasMatchingUsageLength(evidence, segment);
}

/**
 * ledger eventがsegmentと一致するかを検査する。
 *
 * 【詳細説明】
 * - ledger eventはappend-only候補なので、孤立eventや別sourceへつながるeventを復元しない。
 *
 * @private
 * @function isLedgerEventCrossRecordConsistent
 * @param {Object} event - 復元済みledger event。
 * @param {Map<string, Object>} segmentsById - segmentId別JobMaterialSegment map。
 * @returns {boolean} 参照整合性がある場合true。
 */
function isLedgerEventCrossRecordConsistent(event, segmentsById) {
  const segment = segmentsById.get(toTrimmedString(event?.segmentId));
  const spoolId = toTrimmedString(event?.spoolId);
  return !!segment &&
    hasMatchingStringField(event, segment, "deviceId") &&
    hasMatchingStringField(event, segment, "printJobId") &&
    hasMatchingStringField(event, segment, "materialSourceId") &&
    (!spoolId || hasMatchingStringField(event, segment, "spoolId")) &&
    hasMatchingUsageLength(event, segment);
}

/**
 * 復元済みstoreのcross-record参照を検査する。
 *
 * 【詳細説明】
 * - 個別shape検査を通ったrecordだけを対象に、authority配列として再利用できる参照関係かを確認する。
 * - 不整合recordはretainedUnsupportedEntriesへ退避し、以後のdebit/表示集計から除外する。
 *
 * @private
 * @function validateRestoredStoreCrossRecords
 * @param {Object} restored - shape検査後のstore。
 * @param {Object[]} retainedUnsupportedEntries - unsupported退避先。
 * @returns {Object} cross-record検査後のauthority配列。
 */
function validateRestoredStoreCrossRecords(restored, retainedUnsupportedEntries) {
  const snapshotsById = new Map(restored.printStartSnapshots.map((snapshot) => [
    toTrimmedString(snapshot.snapshotId),
    snapshot,
  ]));
  const usageEvidence = [];
  for (const [index, evidence] of restored.usageEvidence.entries()) {
    if (isUsageEvidenceCrossRecordConsistent(evidence, snapshotsById)) {
      usageEvidence.push(evidence);
    } else {
      retainCrossRecordMismatch(retainedUnsupportedEntries, "usageEvidence", index, evidence);
    }
  }
  const usageEvidenceById = new Map(usageEvidence.map((evidence) => [
    toTrimmedString(evidence.evidenceId),
    evidence,
  ]));
  const jobMaterialSegments = [];
  for (const [index, segment] of restored.jobMaterialSegments.entries()) {
    if (isJobMaterialSegmentCrossRecordConsistent(
      segment,
      snapshotsById,
      restored.printStartSnapshots,
      usageEvidenceById
    )) {
      jobMaterialSegments.push(segment);
    } else {
      retainCrossRecordMismatch(retainedUnsupportedEntries, "jobMaterialSegment", index, segment);
    }
  }
  const segmentsById = new Map(jobMaterialSegments.map((segment) => [
    toTrimmedString(segment.segmentId),
    segment,
  ]));
  const ledgerEvents = [];
  for (const [index, event] of restored.ledgerEvents.entries()) {
    if (isLedgerEventCrossRecordConsistent(event, segmentsById)) {
      ledgerEvents.push(event);
    } else {
      retainCrossRecordMismatch(retainedUnsupportedEntries, "ledgerEvent", index, event);
    }
  }
  return {
    printStartSnapshots: restored.printStartSnapshots,
    usageEvidence,
    jobMaterialSegments,
    ledgerEvents,
  };
}

/**
 * 保存済みoperation cacheをrestart後のauthorityから隔離する。
 *
 * 【詳細説明】
 * - operationsByIdはprocess lifetime内の冪等shortcutとしてのみ扱い、永続storeからは復元しない。
 * - snapshot/usage/segment/ledger本体はdeterministic semantic IDで復元されるため、operation result全文を再利用する必要は無い。
 * - Gate20でrestart replayが必要になった場合は、result全文ではなくtyped OperationReplayRecordとして再設計する。
 *
 * @private
 * @function restoreOperationRecords
 * @param {*} operationsById - 保存済みoperation map候補。
 * @param {Object} validatedRecords - 復元済みauthority record群。
 * @param {Object[]} retainedUnsupportedEntries - unsupported退避先。
 * @returns {Object} 空のoperation cache。
 */
function restoreOperationRecords(operationsById, validatedRecords, retainedUnsupportedEntries) {
  void validatedRecords;
  if (!operationsById || typeof operationsById !== "object" || Array.isArray(operationsById)) {
    return {};
  }
  for (const [key, record] of Object.entries(operationsById)) {
    retainedUnsupportedEntries.push({
      recordType: "operationRecord",
      index: key,
      record: cloneJsonValue(record),
      reason: "operation-cache-dropped-on-restore",
    });
  }
  return {};
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
  const restoredRecords = {
    printStartSnapshots: restoreRecordArray({
      records: source.printStartSnapshots,
      recordType: "printStartSnapshot",
      predicate: isRestorablePrintStartSnapshot,
      idKey: "snapshotId",
      retainedUnsupportedEntries,
    }),
    usageEvidence: restoreRecordArray({
      records: source.usageEvidence,
      recordType: "usageEvidence",
      predicate: isRestorableUsageEvidence,
      idKey: "evidenceId",
      retainedUnsupportedEntries,
    }),
    jobMaterialSegments: restoreRecordArray({
      records: source.jobMaterialSegments,
      recordType: "jobMaterialSegment",
      predicate: isRestorableJobMaterialSegment,
      idKey: "segmentId",
      retainedUnsupportedEntries,
    }),
    ledgerEvents: restoreRecordArray({
      records: source.ledgerEvents,
      recordType: "ledgerEvent",
      predicate: isRestorableLedgerEvent,
      idKey: "ledgerEventId",
      retainedUnsupportedEntries,
    }),
  };
  const validatedRecords = validateRestoredStoreCrossRecords(restoredRecords, retainedUnsupportedEntries);
  const operationsById = restoreOperationRecords(source.operationsById, validatedRecords, retainedUnsupportedEntries);
  return {
    schemaVersion: MATERIAL_ACCOUNTING_PRINT_BINDING_SCHEMA_VERSION,
    authority: "material-accounting-print-binding-shadow-store",
    printStartSnapshots: validatedRecords.printStartSnapshots,
    usageEvidence: validatedRecords.usageEvidence,
    jobMaterialSegments: validatedRecords.jobMaterialSegments,
    ledgerEvents: validatedRecords.ledgerEvents,
    unattributedUsage: Array.isArray(source.unattributedUsage)
      ? source.unattributedUsage.map((usage) => cloneJsonValue(usage))
      : [],
    operationsById,
    invariants: {
      legacyUsageHistoryWrites: false,
      legacySpoolRemainingWrites: false,
      materialSourceLedgerWrites: "shadow-only",
    },
    retainedUnsupportedEntries,
  };
}

/**
 * MaterialAccounting PrintBinding store digestを生成する。
 *
 * 【詳細説明】
 * - IndexedDB CASでprint-start snapshot / source-specific usage shadow storeを安全に更新するための
 *   安定digestを作る。
 * - operation cacheは正規化時に永続authorityから落とされるため、retry用一時cache差分で
 *   store authority digestが揺れない。
 *
 * @function createMaterialAccountingPrintBindingStoreDigest
 * @param {*} store - digest対象store候補。
 * @returns {string} deterministic digest。
 * @example
 * const digest = createMaterialAccountingPrintBindingStoreDigest(store);
 */
export function createMaterialAccountingPrintBindingStoreDigest(store) {
  const normalizedStore = normalizeStoredMaterialAccountingPrintBindingStore(store);
  return `fnv1a128:${createPrinterCoreV3DeterministicId("material-accounting-print-binding-store", [
    stableStringifyPrinterCoreV3Value(normalizedStore),
  ])}`;
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
    snapshots: Array.isArray(input.snapshots) ? input.snapshots.map((snapshot) => deepFreezeJson(snapshot)) : [],
    usageEvidence: Array.isArray(input.usageEvidence) ? input.usageEvidence.map((evidence) => deepFreezeJson(evidence)) : [],
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
 * @param {Function=} dependencies.createSourceSpecificMaterialUsageEvidence - public shadow usage issuer。
 * @param {Function=} dependencies.createTrustedSourceSpecificMaterialUsageEvidence - trusted usage issuer。
 * @param {Function=} dependencies.createPrintStartMaterialSnapshot - print-start snapshot issuer。
 * @param {Function=} dependencies.createTrustedResultSetCompletenessEvidence - trusted result-set completeness issuer。
 * @param {Function} dependencies.validateTrustedResultSetCompletenessEvidence - trusted result-set completeness validator。
 * @param {Function} dependencies.evaluateMaterialDebitEligibility - debit eligibility evaluator。
 * @param {Function} dependencies.validateMaterialSource - MaterialSource validator。
 * @param {Function} dependencies.validateSpoolMount - SpoolMount validator。
 * @param {Object=} initialStore - 復元用store。
 * @returns {Object} repository API。
 * @example
 * const repository = createMaterialAccountingPrintBindingRepositoryWithIssuer(dependencies);
 */
export function createMaterialAccountingPrintBindingRepositoryWithIssuer(dependencies = {}, initialStore = {}) {
  const createSourceSpecificUsageEvidence = typeof dependencies.createTrustedSourceSpecificMaterialUsageEvidence === "function"
    ? dependencies.createTrustedSourceSpecificMaterialUsageEvidence
    : (typeof dependencies.createSourceSpecificMaterialUsageEvidence === "function"
        ? dependencies.createSourceSpecificMaterialUsageEvidence
        : createShadowSourceSpecificMaterialUsageEvidence);
  const createPrintStartMaterialSnapshot = typeof dependencies.createPrintStartMaterialSnapshot === "function"
    ? dependencies.createPrintStartMaterialSnapshot
    : createShadowPrintStartMaterialSnapshot;
  const createTrustedResultSetCompletenessEvidence = typeof dependencies.createTrustedResultSetCompletenessEvidence === "function"
    ? dependencies.createTrustedResultSetCompletenessEvidence
    : null;
  const validateTrustedResultSetCompletenessEvidence = dependencies.validateTrustedResultSetCompletenessEvidence;
  const evaluateMaterialDebitEligibility = dependencies.evaluateMaterialDebitEligibility;
  const validateMaterialSource = dependencies.validateMaterialSource;
  const validateSpoolMount = dependencies.validateSpoolMount;
  if (typeof createSourceSpecificUsageEvidence !== "function" ||
      typeof validateTrustedResultSetCompletenessEvidence !== "function" ||
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
   * @param {Object=} input.issuanceEvidence - runtimeが観測した発行文脈。
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
        const mountResolution = findMountForAssignment(assignment, input.spoolMounts, capturedAt);
        const mount = mountResolution.mount;
        if (!source || !validateMaterialSource(source).ok) {
          reasons.push("material-source-required");
          continue;
        }
        if (toTrimmedString(source.deviceId) !== toTrimmedString(printPlan.deviceId)) {
          reasons.push("material-source-device-mismatch");
          continue;
        }
        if (!mount || !validateSpoolMount(mount).ok) {
          reasons.push(mountResolution.reason || "spool-mount-required");
          continue;
        }
        plannedSnapshots.push(createPrintStartMaterialSnapshot({
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
          issuanceEvidence: input.issuanceEvidence || null,
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
    const allSnapshotsAlreadyRecorded = plannedSnapshots.length > 0 &&
      plannedSnapshots.every((snapshot) => {
        const existingSnapshot = snapshotsById.get(snapshot.snapshotId);
        return existingSnapshot &&
          stableStringifyPrinterCoreV3Value(existingSnapshot) === stableStringifyPrinterCoreV3Value(snapshot);
      });
    if (allSnapshotsAlreadyRecorded) {
      const result = createResult({
        ok: true,
        status: MATERIAL_ACCOUNTING_PRINT_BINDING_STATUS.IDEMPOTENT,
        action: "idempotent",
        snapshots: plannedSnapshots,
      });
      recordOperation(operationId, digest, result);
      return result;
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
   * @param {Object=} input.resultSetCompletenessEvidence - module-owned result-set completeness evidence。
   * @param {Object<string,Object>=} input.continuityBySourceId - source continuity evidence。
   * @returns {Object} repository result。
   */
  function recordUsageAttribution(input = {}) {
    const printPlan = input.printPlan;
    const printJobId = toTrimmedString(input.printJobId);
    const completedAt = normalizeIsoTime(input.completedAt);
    const operationId = toTrimmedString(input.attributionOperationId);
    const materialUsages = Array.isArray(input.materialUsages) ? input.materialUsages : [];
    const requestedResultSetCompleteness = input.resultSetCompleteness === "complete" ? "complete" : "partial";
    const planKey = `${printJobId}:${printPlan?.printPlanId || ""}`;
    const plannedSnapshots = (snapshotsByPlanKey.get(planKey) || [])
      .map((snapshot) => snapshot)
      .sort((a, b) => {
        const orderA = Number.isFinite(Number(a.order)) ? Number(a.order) : 0;
        const orderB = Number.isFinite(Number(b.order)) ? Number(b.order) : 0;
        return orderA - orderB;
      });
    const totalUsedLengthMm = normalizeNonNegativeMm(input.totalUsedLengthMm);
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
    if (plannedSnapshots.some((snapshot) => toTrimmedString(snapshot.deviceId) !== toTrimmedString(printPlan?.deviceId))) {
      reasons.push("print-plan-device-mismatch");
    }
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
    const completenessScope = {
      deviceId: printPlan?.deviceId,
      printJobId,
      printPlanId: printPlan?.printPlanId,
      materialSourceIds: plannedSnapshots.map((snapshot) => snapshot.materialSourceId),
    };
    let resultSetCompletenessEvidence = input.resultSetCompletenessEvidence;
    if (requestedResultSetCompleteness === "complete" &&
        createTrustedResultSetCompletenessEvidence &&
        !validateTrustedResultSetCompletenessEvidence(resultSetCompletenessEvidence, completenessScope)) {
      const observedSourceIds = plannedSnapshots
        .filter((snapshot) => usageResolution.entriesBySnapshotId.has(snapshot.snapshotId))
        .map((snapshot) => snapshot.materialSourceId);
      try {
        resultSetCompletenessEvidence = createTrustedResultSetCompletenessEvidence({
          ...completenessScope,
          observedSourceIds,
          observedAt: completedAt,
          source: "trusted-runtime-source-specific-result-set",
        });
      } catch {
        resultSetCompletenessEvidence = input.resultSetCompletenessEvidence;
      }
    }
    const resultSetCompleteness = requestedResultSetCompleteness === "complete" &&
      validateTrustedResultSetCompletenessEvidence(resultSetCompletenessEvidence, completenessScope)
      ? "complete"
      : "partial";
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
      const toolId = normalizeToolId(snapshot.toolId) ?? index;
      const usageState = entryLength !== null
        ? (entryLength > 0 ? "observed-used" : "confirmed-unused")
        : (resultSetCompleteness === "complete" ? "confirmed-unused" : "unknown");
      const usedLengthMm = entryLength !== null
        ? entryLength
        : (usageState === "confirmed-unused" ? 0 : null);
      const evidence = usedLengthMm !== null && snapshot
        ? createSourceSpecificUsageEvidence({
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
            toolId,
            snapshot.snapshotId,
          ]),
        })
        : null;
      let debit = {
        status: "blocked",
        canDebit: false,
        reasons: ["shadow-only-attribution-not-debit-authority"],
      };
      if (evidence?.trusted === true && snapshot?.trusted === true) {
        debit = evaluateMaterialDebitEligibility({
          mount: snapshot.spoolMount,
          materialSource: snapshot.materialSource,
          usageEvidence: evidence,
          printStartSnapshot: snapshot,
          continuity: input.continuityBySourceId?.[snapshot.materialSourceId] || {},
        });
      }
      if (evidence) {
        usageEvidence.push(evidence);
      }
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
