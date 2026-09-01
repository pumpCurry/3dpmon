/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 MaterialBindingPlan 契約モジュール
 * @file dashboard_material_binding_plan.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_binding_plan
 *
 * 【機能内容サマリ】
 * - 既存リモートG-code印刷時に、PrintPlanとは別に材料割当だけを固定する
 * - CFS slot と3DPmon managed spoolの対応候補をprint-start観測へ渡す
 * - caller plain objectがMaterialBindingPlanを偽装しないようmodule-local attestationを付与する
 *
 * 【公開関数一覧】
 * - {@link createMaterialBindingPlan}：材料割当専用planを生成
 * - {@link validateMaterialBindingPlan}：MaterialBindingPlanのattestationを検証
 *
 * @version 1.390.1597 (PR #440)
 * @since   1.390.1597 (PR #440)
 * @lastModified 2026-09-01 19:56:42
 * -----------------------------------------------------------
 * @todo
 * - Gate 20 restart recoveryでprocess-local secret依存ではない再認証registryへ移行する
 */

"use strict";

import {
  createPrinterCoreV3DeterministicId,
  stableStringifyPrinterCoreV3Value,
} from "./dashboard_data_schema_v3.js";

/**
 * MaterialBindingPlan schema version。
 *
 * @constant {number}
 */
export const MATERIAL_BINDING_PLAN_SCHEMA_VERSION = 1;

/**
 * MaterialBindingPlan attestation用のprocess-local secret。
 *
 * 【詳細説明】
 * - UI/runtimeの同一process内で生成されたplanだけをrepositoryが受け取るための軽量境界。
 * - restart後の再認証はこのsecretでは成立しないため、永続trustはGate20の責務に残す。
 *
 * @constant {string}
 */
const MATERIAL_BINDING_PLAN_ATTESTATION_SECRET =
  `printer-core-material-binding-plan:${Date.now()}:${Math.random()}`;

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
  for (const child of Object.values(value)) {
    deepFreezeJson(child);
  }
  return Object.freeze(value);
}

/**
 * 値をtrim済み文字列へ変換する。
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
 * 非空文字列を必須値として取得する。
 *
 * @private
 * @function requireNonEmptyString
 * @param {*} value - 文字列候補。
 * @param {string} name - エラー表示用フィールド名。
 * @returns {string} trim済み文字列。
 * @throws {TypeError} 空文字の場合。
 */
function requireNonEmptyString(value, name) {
  const text = toTrimmedString(value);
  if (!text) {
    throw new TypeError(`MaterialBindingPlan requires a non-empty ${name}.`);
  }
  return text;
}

/**
 * tool IDを0以上の整数へ正規化する。
 *
 * @private
 * @function normalizeToolId
 * @param {*} value - tool ID候補。
 * @returns {number|null} 正規化済みtool ID。
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
 * ISO時刻候補を正規化する。
 *
 * @private
 * @function normalizeOptionalIsoTime
 * @param {*} value - 時刻候補。
 * @returns {string|null} ISO文字列、またはnull。
 */
function normalizeOptionalIsoTime(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * connectionGenerationを正の数値へ正規化する。
 *
 * @private
 * @function normalizeConnectionGeneration
 * @param {*} value - 世代番号候補。
 * @returns {number|null} 正規化済み世代番号。
 */
function normalizeConnectionGeneration(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

/**
 * MaterialBindingPlan assignmentを正規化する。
 *
 * @private
 * @function normalizeAssignment
 * @param {Object} assignment - assignment候補。
 * @param {number} index - fallback order。
 * @returns {Object} 正規化済みassignment。
 * @throws {TypeError} 必須値が不足する場合。
 */
function normalizeAssignment(assignment, index) {
  const toolId = normalizeToolId(assignment?.toolId ?? index);
  if (toolId === null) {
    throw new TypeError("MaterialBindingPlan requires a valid assignment.toolId.");
  }
  return {
    assignmentId: toTrimmedString(assignment?.assignmentId) ||
      createPrinterCoreV3DeterministicId("material-binding-assignment", [
        toolId,
        assignment?.protocolToolAlias || assignment?.toolAlias,
        assignment?.materialSourceId,
        assignment?.spoolId || null,
      ]),
    toolId,
    protocolToolAlias: requireNonEmptyString(
      assignment?.protocolToolAlias || assignment?.toolAlias,
      "assignment.protocolToolAlias",
    ),
    materialSourceId: requireNonEmptyString(assignment?.materialSourceId, "assignment.materialSourceId"),
    spoolId: toTrimmedString(assignment?.spoolId) || null,
    order: Number.isFinite(Number(assignment?.order)) ? Number(assignment.order) : index,
    protocol: cloneJsonValue(assignment?.protocol || null),
    material: cloneJsonValue(assignment?.material || null),
  };
}

/**
 * MaterialBindingPlanの署名対象payloadを生成する。
 *
 * @private
 * @function createAttestationPayload
 * @param {Object} plan - MaterialBindingPlan候補。
 * @returns {Object} 署名対象payload。
 */
function createAttestationPayload(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    bindingPlanId: plan.bindingPlanId,
    printPlanId: plan.printPlanId,
    planKind: plan.planKind,
    deviceId: plan.deviceId,
    asset: plan.asset,
    toolAssignments: plan.toolAssignments,
    materialSourceIds: plan.materialSourceIds,
    startContext: plan.startContext,
  };
}

/**
 * MaterialBindingPlan attestationを生成する。
 *
 * @private
 * @function createMaterialBindingPlanAttestation
 * @param {Object} plan - MaterialBindingPlan候補。
 * @returns {string} attestation文字列。
 */
function createMaterialBindingPlanAttestation(plan) {
  return createPrinterCoreV3DeterministicId("material-binding-plan-attestation", [
    MATERIAL_BINDING_PLAN_ATTESTATION_SECRET,
    stableStringifyPrinterCoreV3Value(createAttestationPayload(plan)),
  ]);
}

/**
 * 材料割当専用のMaterialBindingPlanを生成する。
 *
 * 【詳細説明】
 * - 既存remote G-codeはPrintPlan用のG-code content/upload receiptを持たない場合がある。
 * - そのためPrintPlanを偽装せず、印刷開始時に必要なsource/spool/tool対応だけを別contractとして固定する。
 *
 * @function createMaterialBindingPlan
 * @param {Object} options - 生成オプション。
 * @param {string} options.deviceId - Printer Core v3 Device ID。
 * @param {string=} options.bindingPlanId - 明示MaterialBindingPlan ID。
 * @param {Object} options.asset - 印刷対象remote asset。
 * @param {Object[]} options.toolAssignments - tool/source/spool assignment配列。
 * @param {Object=} options.startContext - session/generation/uploadGeneration文脈。
 * @param {string=} options.createdAt - 生成時刻。
 * @returns {Object} frozen MaterialBindingPlan。
 * @example
 * const plan = createMaterialBindingPlan({ deviceId, asset, toolAssignments });
 */
export function createMaterialBindingPlan(options = {}) {
  const deviceId = requireNonEmptyString(options.deviceId, "deviceId");
  const assignments = (Array.isArray(options.toolAssignments) ? options.toolAssignments : [])
    .map((assignment, index) => normalizeAssignment(assignment, index));
  if (assignments.length === 0) {
    throw new TypeError("MaterialBindingPlan requires at least one toolAssignment.");
  }
  const materialSourceIds = [...new Set(assignments.map((assignment) => assignment.materialSourceId))];
  const asset = {
    path: requireNonEmptyString(options.asset?.path || options.asset?.remotePath || options.asset?.filename, "asset.path"),
    fileName: toTrimmedString(options.asset?.fileName || options.asset?.name) || null,
    fileHash: toTrimmedString(options.asset?.fileHash || options.asset?.contentHash || options.asset?.sha256) || null,
    uploadGeneration: toTrimmedString(options.asset?.uploadGeneration) || null,
  };
  const startContext = {
    sessionId: toTrimmedString(options.startContext?.sessionId) || null,
    connectionGeneration: normalizeConnectionGeneration(options.startContext?.connectionGeneration),
    uploadGeneration: toTrimmedString(options.startContext?.uploadGeneration) || asset.uploadGeneration,
  };
  const bindingPlanId = toTrimmedString(options.bindingPlanId || options.printPlanId) ||
    createPrinterCoreV3DeterministicId("material-binding-plan", [
      deviceId,
      asset.path,
      asset.fileHash || "",
      ...assignments.map((assignment) => assignment.assignmentId),
    ]);
  const plan = {
    schemaVersion: MATERIAL_BINDING_PLAN_SCHEMA_VERSION,
    bindingPlanId,
    printPlanId: bindingPlanId,
    planKind: "material-binding-plan",
    deviceId,
    asset,
    toolAssignments: assignments,
    materialSourceIds,
    startContext,
    createdAt: normalizeOptionalIsoTime(options.createdAt) || null,
    authority: {
      mode: "material-binding-plan",
      canStartPrint: false,
      canBindMaterialUsage: true,
      requiresObservedPrintStart: true,
      requiresCommandSubmission: true,
    },
    provenance: {
      source: "printer-core-material-binding-plan-authority",
      attestation: null,
    },
  };
  plan.provenance.attestation = createMaterialBindingPlanAttestation(plan);
  return deepFreezeJson(plan);
}

/**
 * MaterialBindingPlanを検証する。
 *
 * 【詳細説明】
 * - `validatePrintPlan()`とは別の材料割当専用検証であり、G-code content/upload receiptは要求しない。
 * - module-local attestationが一致しないplain objectは拒否し、caller supplied planの偽装を防ぐ。
 *
 * @function validateMaterialBindingPlan
 * @param {Object|null|undefined} plan - MaterialBindingPlan候補。
 * @returns {{ok:boolean,errors:string[]}} 検証結果。
 * @example
 * const validation = validateMaterialBindingPlan(plan);
 */
export function validateMaterialBindingPlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return { ok: false, errors: ["material-binding-plan-not-object"] };
  }
  if (plan.schemaVersion !== MATERIAL_BINDING_PLAN_SCHEMA_VERSION) {
    errors.push("material-binding-plan-schema-mismatch");
  }
  if (plan.planKind !== "material-binding-plan") {
    errors.push("material-binding-plan-kind-invalid");
  }
  for (const key of ["bindingPlanId", "printPlanId", "deviceId"]) {
    if (!toTrimmedString(plan[key])) {
      errors.push(`missing-${key}`);
    }
  }
  if (!toTrimmedString(plan.asset?.path)) {
    errors.push("missing-asset-path");
  }
  const assignments = Array.isArray(plan.toolAssignments) ? plan.toolAssignments : [];
  if (assignments.length === 0) {
    errors.push("material-binding-assignment-required");
  }
  const toolIds = new Set();
  for (const assignment of assignments) {
    const toolId = normalizeToolId(assignment?.toolId);
    if (toolId === null) {
      errors.push("missing-tool-id");
    } else if (toolIds.has(toolId)) {
      errors.push("duplicate-tool-id");
    } else {
      toolIds.add(toolId);
    }
    if (!toTrimmedString(assignment?.protocolToolAlias || assignment?.toolAlias)) {
      errors.push("missing-protocol-tool-alias");
    }
    if (!toTrimmedString(assignment?.materialSourceId)) {
      errors.push("missing-material-source-id");
    }
  }
  const materialSourceIds = Array.isArray(plan.materialSourceIds)
    ? plan.materialSourceIds.map(toTrimmedString).filter(Boolean)
    : [];
  for (const assignment of assignments) {
    const sourceId = toTrimmedString(assignment?.materialSourceId);
    if (sourceId && !materialSourceIds.includes(sourceId)) {
      errors.push("material-source-ids-missing-assignment-source");
    }
  }
  const expectedAttestation = createMaterialBindingPlanAttestation(plan);
  if (
    plan.provenance?.source !== "printer-core-material-binding-plan-authority" ||
    plan.provenance?.attestation !== expectedAttestation
  ) {
    errors.push("untrusted-material-binding-plan");
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}
