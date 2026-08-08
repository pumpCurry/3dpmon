/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 フィラメントレジャー契約モジュール
 * @file dashboard_filament_ledger_v3.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_filament_ledger_v3
 *
 * 【機能内容サマリ】
 * - PrintPlan と印刷完了観測から JobMaterialSegment 候補を生成する
 * - append-only filamentLedger event 候補を生成する
 * - exact/high/estimated/unknown の confidence 境界を固定する
 *
 * 【公開関数一覧】
 * - {@link createJobMaterialSegmentsFromPrintPlan}：PrintPlan から material segment 候補を生成
 * - {@link createFilamentLedgerEventsFromSegments}：segment から ledger event 候補を生成
 * - {@link createFilamentLedgerCorrectionEvent}：既存 consumption event の correction 候補を生成
 * - {@link validateJobMaterialSegments}：segment 配列の整合性を検査
 *
 * @version 1.390.1348 (PR #432)
 * @since   1.390.1345 (PR #432)
 * @lastModified 2026-08-09 08:15:00
 * -----------------------------------------------------------
 * @todo
 * - Data Schema v3 repository activation 後に append-only store へ接続する
 */

"use strict";

import { createPrinterCoreV3DeterministicId } from "./dashboard_data_schema_v3.js";
import { validatePrintPlan } from "./dashboard_print_plan.js";

/**
 * Printer Core v3 filament ledger contract schema version。
 *
 * 【詳細説明】
 * - v3 Data Schema の物理 version とは別に、segment/event shape の互換性を管理する。
 *
 * @constant {number}
 */
export const PRINTER_CORE_V3_FILAMENT_LEDGER_CONTRACT_VERSION = 1;

/**
 * segment confidence の許可値。
 *
 * 【詳細説明】
 * - `unknown` は消費を勝手に配分してはいけない状態を表す。
 *
 * @constant {ReadonlySet<string>}
 */
const SEGMENT_CONFIDENCE_VALUES = Object.freeze(new Set(["exact", "high", "estimated", "unknown"]));

/**
 * JSON 互換値を deep clone する。
 *
 * 【詳細説明】
 * - segment/event は監査用 plain data として扱い、呼び出し側 mutation から守る。
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
 * 必須文字列を正規化する。
 *
 * 【詳細説明】
 * - segment/event の参照 ID が空だと後続 migration で孤立するため拒否する。
 *
 * @private
 * @param {*} value - 文字列候補
 * @param {string} name - エラー表示用の名前
 * @returns {string} 正規化済み文字列
 * @throws {TypeError} 空文字の場合
 */
function requireNonEmptyString(value, name) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new TypeError(`Filament ledger v3 requires a non-empty ${name}.`);
  }
  return text;
}

/**
 * mm値を正規化する。
 *
 * 【詳細説明】
 * - 使用量は0以上の有限数だけを採用し、それ以外は null として未確定にする。
 *
 * @private
 * @param {*} value - mm 候補
 * @returns {number|null} 正規化済み mm
 */
function normalizeUsedLengthMm(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : null;
}

/**
 * confidence を正規化する。
 *
 * 【詳細説明】
 * - 不明な値は安全側で `unknown` とする。
 *
 * @private
 * @param {*} value - confidence 候補
 * @param {string} fallback - fallback confidence
 * @returns {string} 正規化済み confidence
 */
function normalizeConfidence(value, fallback = "unknown") {
  const text = String(value || fallback).trim();
  return SEGMENT_CONFIDENCE_VALUES.has(text) ? text : "unknown";
}

/**
 * 観測 usage entry から used length を読む。
 *
 * 【詳細説明】
 * - 実機・fixture・将来 provider で field 名が揺れても、意味が同じ値を拾えるようにする。
 *
 * @private
 * @param {object} entry - material usage entry
 * @returns {number|null} 使用量 mm
 */
function readUsageEntryLength(entry) {
  return normalizeUsedLengthMm(
    entry?.usedLengthMm ??
    entry?.usedMm ??
    entry?.materialUsedMm ??
    entry?.deltaUsedMm
  );
}

/**
 * assignment に対応する usage entry を探す。
 *
 * 【詳細説明】
 * - logical toolId を優先し、無い場合は protocolToolAlias / materialSourceId で照合する。
 *
 * @private
 * @param {object} assignment - PrintPlan tool assignment
 * @param {object[]} materialUsages - material usage 観測配列
 * @returns {object|null} 対応 usage entry
 */
function findUsageForAssignment(assignment, materialUsages) {
  const toolId = Number(assignment?.toolId);
  const protocolToolAlias = String(assignment?.protocolToolAlias || assignment?.toolAlias || "").trim();
  const materialSourceId = String(assignment?.materialSourceId || "").trim();
  return materialUsages.find((entry) => Number(entry?.toolId) === toolId) ||
    materialUsages.find((entry) => String(entry?.protocolToolAlias || entry?.toolAlias || "").trim() === protocolToolAlias) ||
    materialUsages.find((entry) => String(entry?.materialSourceId || "").trim() === materialSourceId) ||
    null;
}

/**
 * segment の使用量と confidence を解決する。
 *
 * 【詳細説明】
 * - per-tool/per-source 観測があればそれを採用する。
 * - 単色は総消費量をその1 sourceへ紐付けられる。
 * - マルチカラーで総消費量しか無い場合は、誤配分を防ぐため unknown にする。
 *
 * @private
 * @param {object} plan - PrintPlan
 * @param {object} assignment - tool assignment
 * @param {object} observation - 印刷完了観測
 * @returns {{usedLengthMm: number|null, confidence: string, allocationMode: string, evidence: object}} 使用量解決結果
 */
function resolveSegmentUsage(plan, assignment, observation) {
  const materialUsages = Array.isArray(observation.materialUsages) ? observation.materialUsages : [];
  const usageEntry = findUsageForAssignment(assignment, materialUsages);
  const entryUsed = readUsageEntryLength(usageEntry);
  if (entryUsed !== null) {
    return {
      usedLengthMm: entryUsed,
      confidence: normalizeConfidence(usageEntry?.confidence, "exact"),
      allocationMode: "observed-per-material",
      evidence: cloneJsonValue(usageEntry),
    };
  }
  const totalUsed = normalizeUsedLengthMm(
    observation.totalUsedLengthMm ??
    observation.totalUsedMm ??
    observation.materialUsedMm
  );
  if (plan.planKind === "single-color" && totalUsed !== null) {
    return {
      usedLengthMm: totalUsed,
      confidence: normalizeConfidence(observation.confidence, "high"),
      allocationMode: "single-source-total",
      evidence: { totalUsedLengthMm: totalUsed },
    };
  }
  const estimatedUsed = normalizeUsedLengthMm(assignment?.estimatedUsedLengthMm);
  if (estimatedUsed !== null) {
    return {
      usedLengthMm: estimatedUsed,
      confidence: "estimated",
      allocationMode: "plan-estimated",
      evidence: { estimatedUsedLengthMm: estimatedUsed },
    };
  }
  return {
    usedLengthMm: null,
    confidence: "unknown",
    allocationMode: totalUsed !== null ? "unallocated-total" : "no-usage-observation",
    evidence: totalUsed !== null ? { totalUsedLengthMm: totalUsed } : {},
  };
}

/**
 * PrintPlan と印刷完了観測から JobMaterialSegment 候補を生成する。
 *
 * 【詳細説明】
 * - 返す segment は Data Schema v3 の `jobMaterialSegments` に対応する候補であり、まだ永続化しない。
 * - マルチカラーで per-tool usage が無い場合は unknown segment にし、4色へ等分配しない。
 *
 * @function createJobMaterialSegmentsFromPrintPlan
 * @param {object} plan - PrintPlan
 * @param {object} observation - 印刷完了観測
 * @param {string} observation.printJobId - print job ID
 * @param {string=} observation.completedAt - 完了時刻
 * @returns {object[]} JobMaterialSegment 候補配列
 * @example
 * const segments = createJobMaterialSegmentsFromPrintPlan(plan, { printJobId, materialUsages });
 */
export function createJobMaterialSegmentsFromPrintPlan(plan, observation = {}) {
  const validation = validatePrintPlan(plan);
  if (!validation.ok) {
    throw new TypeError(`Invalid PrintPlan: ${validation.errors.join(",")}`);
  }
  const printJobId = requireNonEmptyString(observation.printJobId, "printJobId");
  return plan.toolAssignments.map((assignment, index) => {
    const usage = resolveSegmentUsage(plan, assignment, observation);
    const spoolId = String(assignment.spoolId || usage.evidence?.spoolId || "").trim() || null;
    const segmentId = createPrinterCoreV3DeterministicId("job-material-segment", [
      printJobId,
      plan.printPlanId,
      assignment.toolId,
      assignment.materialSourceId,
    ]);
    return {
      schemaVersion: PRINTER_CORE_V3_FILAMENT_LEDGER_CONTRACT_VERSION,
      segmentId,
      printJobId,
      printPlanId: plan.printPlanId,
      deviceId: plan.deviceId,
      planKind: plan.planKind,
      toolId: assignment.toolId,
      protocolToolAlias: assignment.protocolToolAlias,
      toolAlias: assignment.protocolToolAlias,
      materialSourceId: assignment.materialSourceId,
      spoolId,
      order: Number.isFinite(Number(assignment.order)) ? Number(assignment.order) : index,
      usedLengthMm: usage.usedLengthMm,
      confidence: usage.confidence,
      allocationMode: usage.allocationMode,
      evidence: usage.evidence,
      completedAt: observation.completedAt || null,
      authority: {
        mode: "candidate-only",
        canDebitRemaining: false,
      },
    };
  });
}

/**
 * JobMaterialSegment 配列の整合性を検査する。
 *
 * 【詳細説明】
 * - ledger event へ進める前に、必須参照と confidence の妥当性を確認する。
 *
 * @function validateJobMaterialSegments
 * @param {object[]} segments - segment 候補配列
 * @returns {{ok: boolean, errors: string[]}} 検査結果
 * @example
 * const validation = validateJobMaterialSegments(segments);
 */
export function validateJobMaterialSegments(segments) {
  const errors = [];
  if (!Array.isArray(segments) || segments.length === 0) {
    return { ok: false, errors: ["segments-empty"] };
  }
  const ids = new Set();
  for (const segment of segments) {
    for (const key of ["segmentId", "printJobId", "printPlanId", "deviceId", "materialSourceId"]) {
      if (!String(segment?.[key] || "").trim()) {
        errors.push(`missing-${key}`);
      }
    }
    if (!Number.isInteger(Number(segment?.toolId)) || Number(segment.toolId) < 0) {
      errors.push("missing-toolId");
    }
    if (!String(segment?.protocolToolAlias || segment?.toolAlias || "").trim()) {
      errors.push("missing-protocolToolAlias");
    }
    if (ids.has(segment?.segmentId)) {
      errors.push("duplicate-segmentId");
    } else if (segment?.segmentId) {
      ids.add(segment.segmentId);
    }
    if (!SEGMENT_CONFIDENCE_VALUES.has(segment?.confidence)) {
      errors.push("invalid-confidence");
    }
    if (segment?.usedLengthMm !== null && normalizeUsedLengthMm(segment?.usedLengthMm) === null) {
      errors.push("invalid-usedLengthMm");
    }
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

/**
 * segment から append-only filament ledger event 候補を生成する。
 *
 * 【詳細説明】
 * - unknown segment も監査 event として残せるが、`canDebitRemaining` は false のままにする。
 * - spoolId が無い場合も debit 不能として記録し、source だけを根拠に残量を減らさない。
 *
 * @function createFilamentLedgerEventsFromSegments
 * @param {object[]} segments - JobMaterialSegment 候補配列
 * @param {object} options - event 生成オプション
 * @param {string=} options.createdAt - 作成時刻
 * @returns {object[]} filamentLedger event 候補配列
 * @example
 * const events = createFilamentLedgerEventsFromSegments(segments);
 */
export function createFilamentLedgerEventsFromSegments(segments, options = {}) {
  const validation = validateJobMaterialSegments(segments);
  if (!validation.ok) {
    throw new TypeError(`Invalid JobMaterialSegments: ${validation.errors.join(",")}`);
  }
  return segments.map((segment) => {
    const hasDebitAmount = normalizeUsedLengthMm(segment.usedLengthMm) !== null && Number(segment.usedLengthMm) > 0;
    const canDebitRemaining = Boolean(segment.spoolId) && hasDebitAmount && segment.confidence !== "unknown";
    return {
      schemaVersion: PRINTER_CORE_V3_FILAMENT_LEDGER_CONTRACT_VERSION,
      ledgerEventId: createPrinterCoreV3DeterministicId("filament-ledger-event", [
        segment.segmentId,
        "consumption",
        1,
      ]),
      consumptionIdentity: createPrinterCoreV3DeterministicId("filament-consumption", [
        segment.segmentId,
      ]),
      eventRevision: 1,
      eventType: "material-consumption",
      printJobId: segment.printJobId,
      printPlanId: segment.printPlanId,
      segmentId: segment.segmentId,
      deviceId: segment.deviceId,
      materialSourceId: segment.materialSourceId,
      spoolId: segment.spoolId,
      usedLengthMm: segment.usedLengthMm,
      confidence: segment.confidence,
      allocationMode: segment.allocationMode,
      supersedesLedgerEventId: null,
      correctsLedgerEventId: null,
      deltaUsedLengthMm: null,
      createdAt: options.createdAt || segment.completedAt || null,
      authority: {
        mode: "candidate-only",
        canAppend: false,
        canDebitRemaining,
      },
    };
  });
}

/**
 * 既存 consumption event の correction event 候補を生成する。
 *
 * 【詳細説明】
 * - estimated から exact へ更新する場合など、元 event を二重debitせず append-only に補正差分を表現する。
 * - correction は元の `consumptionIdentity` を継承し、`deltaUsedLengthMm` に差分だけを持つ。
 *
 * @function createFilamentLedgerCorrectionEvent
 * @param {object} originalEvent - 既存 consumption event
 * @param {object} correctedSegment - 補正後の JobMaterialSegment
 * @param {object=} options - correction 生成オプション
 * @param {string=} options.createdAt - 作成時刻
 * @returns {object} correction ledger event 候補
 * @example
 * const correction = createFilamentLedgerCorrectionEvent(originalEvent, correctedSegment);
 */
export function createFilamentLedgerCorrectionEvent(originalEvent, correctedSegment, options = {}) {
  const validation = validateJobMaterialSegments([correctedSegment]);
  if (!validation.ok) {
    throw new TypeError(`Invalid corrected JobMaterialSegment: ${validation.errors.join(",")}`);
  }
  const identityKeys = ["segmentId", "printJobId", "deviceId", "materialSourceId", "spoolId"];
  const mismatch = identityKeys.find((key) => String(originalEvent?.[key] || "") !== String(correctedSegment?.[key] || ""));
  if (mismatch) {
    throw new TypeError(`Filament ledger correction identity mismatch: ${mismatch}`);
  }
  const originalUsed = normalizeUsedLengthMm(originalEvent?.usedLengthMm) ?? 0;
  const correctedUsed = normalizeUsedLengthMm(correctedSegment.usedLengthMm) ?? 0;
  const consumptionIdentity = originalEvent?.consumptionIdentity ||
    createPrinterCoreV3DeterministicId("filament-consumption", [correctedSegment.segmentId]);
  const revision = Math.max(2, Number(originalEvent?.eventRevision || 1) + 1);
  return {
    schemaVersion: PRINTER_CORE_V3_FILAMENT_LEDGER_CONTRACT_VERSION,
    ledgerEventId: createPrinterCoreV3DeterministicId("filament-ledger-event", [
      consumptionIdentity,
      revision,
    ]),
    consumptionIdentity,
    eventRevision: revision,
    eventType: "material-consumption-correction",
    printJobId: correctedSegment.printJobId,
    printPlanId: correctedSegment.printPlanId,
    segmentId: correctedSegment.segmentId,
    deviceId: correctedSegment.deviceId,
    materialSourceId: correctedSegment.materialSourceId,
    spoolId: correctedSegment.spoolId,
    usedLengthMm: correctedUsed,
    confidence: correctedSegment.confidence,
    allocationMode: correctedSegment.allocationMode,
    supersedesLedgerEventId: originalEvent?.ledgerEventId || null,
    correctsLedgerEventId: originalEvent?.ledgerEventId || null,
    deltaUsedLengthMm: correctedUsed - originalUsed,
    createdAt: options.createdAt || correctedSegment.completedAt || null,
    authority: {
      mode: "candidate-only",
      canAppend: false,
      canDebitRemaining: Boolean(correctedSegment.spoolId) && correctedSegment.confidence !== "unknown",
    },
  };
}
