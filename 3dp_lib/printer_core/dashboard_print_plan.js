/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 PrintPlan モジュール
 * @file dashboard_print_plan.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_print_plan
 *
 * 【機能内容サマリ】
 * - 単色印刷でも明示 PrintPlan を生成する
 * - G-code asset と material source の対応を command 前に固定する
 * - PrintPlan から contract-only print-start command request を生成する
 *
 * 【公開関数一覧】
 * - {@link createSingleColorPrintPlan}：単色 PrintPlan を生成
 * - {@link validatePrintPlan}：PrintPlan の整合性を検査
 * - {@link createPrintStartCommandRequestFromPlan}：PrintPlan から print-start command request を生成
 *
 * @version 1.390.1343 (PR #432)
 * @since   1.390.1343 (PR #432)
 * @lastModified 2026-08-09 01:38:47
 * -----------------------------------------------------------
 * @todo
 * - multicolor/CFS assignment と実送信 protocol 生成へ拡張する
 */

"use strict";

import { createPrinterCommandRequest } from "./dashboard_command_authority.js";
import { createPrinterCoreV3DeterministicId } from "./dashboard_data_schema_v3.js";

/**
 * PrintPlan schema version。
 *
 * 【詳細説明】
 * - Data Schema v3 の `printPlans` store へ将来保存する logical schema version。
 *
 * @constant {number}
 */
export const PRINT_PLAN_SCHEMA_VERSION = 1;

/**
 * JSON 互換値を deep clone する。
 *
 * 【詳細説明】
 * - PrintPlan は command/result と同じく監査可能な plain data として扱う。
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
 * - 空文字の asset/source/tool を PrintPlan に入れると command authority が推測へ逃げるため拒否する。
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
    throw new TypeError(`PrintPlan requires a non-empty ${name}.`);
  }
  return text;
}

/**
 * G-code asset 情報を正規化する。
 *
 * 【詳細説明】
 * - path/name/fileName のうち少なくとも path が必要。assetId が無い場合は deterministic ID を生成する。
 *
 * @private
 * @param {object} asset - G-code asset 候補
 * @returns {object} 正規化済み asset
 */
function normalizeGcodeAsset(asset) {
  const path = requireNonEmptyString(asset?.path || asset?.filePath || asset?.filename, "asset.path");
  const fileName = String(asset?.fileName || asset?.name || path.split(/[\\/]/u).pop() || path).trim();
  return {
    assetId: asset?.assetId || createPrinterCoreV3DeterministicId("gcode-asset", [path, fileName]),
    path,
    fileName,
    fileMd5: asset?.fileMd5 || null,
    toolCount: 1,
  };
}

/**
 * 単色 tool assignment を生成する。
 *
 * 【詳細説明】
 * - 単色でも materialSourceId を必須にし、外部リール/CFS slot/将来の spool mount を command 前に明示する。
 *
 * @private
 * @param {object} options - assignment 生成オプション
 * @param {string} options.toolAlias - G-code tool alias
 * @param {string} options.materialSourceId - material source ID
 * @returns {object} tool assignment
 */
function createSingleToolAssignment(options) {
  const toolAlias = requireNonEmptyString(options.toolAlias || "T1A", "toolAlias");
  const materialSourceId = requireNonEmptyString(options.materialSourceId, "materialSourceId");
  return {
    assignmentId: createPrinterCoreV3DeterministicId("tool-assignment", [toolAlias, materialSourceId]),
    toolAlias,
    materialSourceId,
    confidence: options.confidence || "operator-confirmed",
  };
}

/**
 * 単色 PrintPlan を生成する。
 *
 * 【詳細説明】
 * - 1色印刷でも PrintPlan を通すことで、`opGcodeFile` 直投げと material source 未選択を避ける。
 * - CFS/外部リールのどちらでも materialSourceId を必須にし、後続 command が推測に依存しないようにする。
 *
 * @function createSingleColorPrintPlan
 * @param {object} options - PrintPlan 生成オプション
 * @param {string} options.deviceId - 物理 device ID
 * @param {object} options.asset - G-code asset
 * @param {string} options.materialSourceId - material source ID
 * @param {string=} options.toolAlias - G-code tool alias
 * @param {string=} options.createdAt - 作成時刻 ISO 文字列
 * @param {object=} options.preflight - preflight evidence
 * @returns {object} 単色 PrintPlan
 * @example
 * const plan = createSingleColorPrintPlan({ deviceId, asset, materialSourceId });
 */
export function createSingleColorPrintPlan(options = {}) {
  const deviceId = requireNonEmptyString(options.deviceId, "deviceId");
  const asset = normalizeGcodeAsset(options.asset || {});
  const assignment = createSingleToolAssignment({
    toolAlias: options.toolAlias || "T1A",
    materialSourceId: options.materialSourceId,
    confidence: options.confidence,
  });
  const printPlanId = options.printPlanId || createPrinterCoreV3DeterministicId("print-plan", [
    deviceId,
    asset.assetId,
    assignment.assignmentId,
  ]);
  const plan = {
    schemaVersion: PRINT_PLAN_SCHEMA_VERSION,
    printPlanId,
    planKind: "single-color",
    deviceId,
    asset,
    toolAssignments: [assignment],
    materialSourceIds: [assignment.materialSourceId],
    preflight: cloneJsonValue(options.preflight || {}),
    createdAt: options.createdAt || null,
    authority: {
      mode: "plan-only",
      canStartPrint: false,
      requiresCommandAuthority: true,
      requiresExpectedStateConfirmation: true,
    },
  };
  const validation = validatePrintPlan(plan);
  if (!validation.ok) {
    throw new TypeError(`Invalid PrintPlan: ${validation.errors.join(",")}`);
  }
  return plan;
}

/**
 * PrintPlan の整合性を検査する。
 *
 * 【詳細説明】
 * - Gate 15 では単色だけを許可し、tool assignment が1件で materialSourceId と対応していることを確認する。
 *
 * @function validatePrintPlan
 * @param {object|null|undefined} plan - PrintPlan
 * @returns {{ok: boolean, errors: string[]}} 検査結果
 * @example
 * const validation = validatePrintPlan(plan);
 */
export function validatePrintPlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== "object") {
    return { ok: false, errors: ["plan-not-object"] };
  }
  for (const key of ["printPlanId", "planKind", "deviceId"]) {
    if (!String(plan[key] || "").trim()) {
      errors.push(`missing-${key}`);
    }
  }
  if (plan.schemaVersion !== PRINT_PLAN_SCHEMA_VERSION) {
    errors.push("unexpected-schema-version");
  }
  if (plan.planKind !== "single-color") {
    errors.push("unsupported-plan-kind");
  }
  if (!plan.asset || typeof plan.asset !== "object" || !String(plan.asset.path || "").trim()) {
    errors.push("missing-asset-path");
  }
  if (!Array.isArray(plan.toolAssignments) || plan.toolAssignments.length !== 1) {
    errors.push("single-color-tool-assignment-count-invalid");
  }
  const assignment = Array.isArray(plan.toolAssignments) ? plan.toolAssignments[0] : null;
  if (!assignment || !String(assignment.toolAlias || "").trim()) {
    errors.push("missing-tool-alias");
  }
  if (!assignment || !String(assignment.materialSourceId || "").trim()) {
    errors.push("missing-material-source-id");
  }
  if (!Array.isArray(plan.materialSourceIds) || plan.materialSourceIds.length !== 1) {
    errors.push("single-color-material-source-count-invalid");
  } else if (assignment?.materialSourceId !== plan.materialSourceIds[0]) {
    errors.push("material-source-assignment-mismatch");
  }
  if (plan.authority?.canStartPrint === true) {
    errors.push("plan-can-start-print");
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

/**
 * PrintPlan から print-start command request を生成する。
 *
 * 【詳細説明】
 * - request は `contract-only` であり、この関数もプリンタへ送信しない。
 * - command payload には PrintPlan ID、asset path、tool assignment を含め、送信 adapter が推測しなくてよい形にする。
 *
 * @function createPrintStartCommandRequestFromPlan
 * @param {object} plan - PrintPlan
 * @param {object} options - command request 生成オプション
 * @param {string} options.sessionId - active session ID
 * @param {string=} options.transportKind - 送信 transport 種別
 * @param {Function=} options.entropySource - command ID entropy source
 * @returns {object} print-start command request
 * @example
 * const request = createPrintStartCommandRequestFromPlan(plan, { sessionId });
 */
export function createPrintStartCommandRequestFromPlan(plan, options = {}) {
  const validation = validatePrintPlan(plan);
  if (!validation.ok) {
    throw new TypeError(`Invalid PrintPlan: ${validation.errors.join(",")}`);
  }
  return createPrinterCommandRequest({
    deviceId: plan.deviceId,
    sessionId: options.sessionId,
    commandKind: "print-start",
    transportKind: options.transportKind || "pending-adapter",
    payload: {
      printPlanId: plan.printPlanId,
      asset: cloneJsonValue(plan.asset),
      toolAssignments: cloneJsonValue(plan.toolAssignments),
      materialSourceIds: cloneJsonValue(plan.materialSourceIds),
    },
    expectedState: [
      {
        path: "print.stateLabel",
        operator: "oneOf",
        expected: ["printing", "checking"],
      },
    ],
    timeoutMs: options.timeoutMs,
    idempotencyKey: plan.printPlanId,
    entropySource: options.entropySource,
    createdAt: options.createdAt || null,
  });
}
