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
 * - CFS/マルチカラー印刷の tool assignment を command 前に固定する
 * - G-code logical toolId と Creality protocol alias を分離する
 * - G-code asset と material source の対応を command 前に固定する
 * - PrintPlan から contract-only print-start command request を生成する
 *
 * 【公開関数一覧】
 * - {@link createSingleColorPrintPlan}：単色 PrintPlan を生成
 * - {@link createMulticolorCfsPrintPlan}：CFS/マルチカラー PrintPlan を生成
 * - {@link validatePrintPlan}：PrintPlan の整合性を検査
 * - {@link createPrintStartCommandRequestFromPlan}：PrintPlan から print-start command request を生成
 *
 * @version 1.390.1350 (PR #432)
 * @since   1.390.1343 (PR #432)
 * @lastModified 2026-08-09 09:25:00
 * -----------------------------------------------------------
 * @todo
 * - 実送信 protocol 生成へ拡張する
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
 * logical tool ID を正規化する。
 *
 * 【詳細説明】
 * - G-code 内の tool は数値 ID として扱い、Creality protocol の `T1A` などとは分離する。
 *
 * @private
 * @param {*} value - tool ID 候補
 * @param {number} fallback - fallback tool ID
 * @returns {number} 正規化済み tool ID
 * @throws {TypeError} 不正な tool ID の場合
 */
function normalizeToolId(value, fallback = 0) {
  const raw = value === undefined || value === null ? fallback : value;
  if (typeof raw === "boolean" || Array.isArray(raw)) {
    throw new TypeError("PrintPlan requires a non-negative integer toolId.");
  }
  if (typeof raw === "string" && raw.trim() === "") {
    throw new TypeError("PrintPlan requires a non-negative integer toolId.");
  }
  const text = typeof raw === "string" ? raw.trim() : raw;
  if (typeof text === "string" && !/^(0|[1-9]\d*)$/u.test(text)) {
    throw new TypeError("PrintPlan requires a non-negative integer toolId.");
  }
  const toolId = typeof text === "number" ? text : Number(text);
  if (!Number.isInteger(toolId) || toolId < 0) {
    throw new TypeError("PrintPlan requires a non-negative integer toolId.");
  }
  return toolId;
}

/**
 * analysis payload から logical tool ID 候補を取り出す。
 *
 * 【詳細説明】
 * - analyzer の実装差で `logicalTools` / `tools` のどちらを返しても同じ意味として読む。
 * - `toolCount` だけから `0..N-1` を生成する fallback は authority PrintPlan では行わない。
 *
 * @private
 * @param {object} analysis - G-code analysis 候補
 * @returns {Array<*>|null} logical tool 候補配列
 */
function readAnalysisLogicalToolCandidates(analysis) {
  if (Array.isArray(analysis?.logicalTools)) {
    return analysis.logicalTools;
  }
  if (Array.isArray(analysis?.tools)) {
    return analysis.tools;
  }
  return null;
}

/**
 * G-code analysis evidence を正規化する。
 *
 * 【詳細説明】
 * - PrintPlan authority では、G-code analyzer が確定した logical tool list だけを採用する。
 * - `toolCount` や caller 指定 `asset.tools` だけでは、multicolor file を単色扱いできてしまうため拒否する。
 *
 * @private
 * @param {object} asset - G-code asset 候補
 * @returns {object} 正規化済み analysis evidence
 * @throws {TypeError} analysis evidence が不足している場合
 */
function normalizeGcodeAnalysis(asset) {
  const analysis = asset?.analysis;
  if (!analysis || typeof analysis !== "object" || analysis.analyzed !== true) {
    throw new TypeError("PrintPlan requires analyzed G-code logical tools.");
  }
  const analyzerVersion = requireNonEmptyString(
    analysis.analyzerVersion || analysis.source,
    "asset.analysis.analyzerVersion"
  );
  const fileHash = requireNonEmptyString(
    analysis.fileHash || analysis.sha256 || asset?.fileSha256 || asset?.fileMd5,
    "asset.analysis.fileHash"
  );
  const logicalToolCandidates = readAnalysisLogicalToolCandidates(analysis);
  if (!logicalToolCandidates || logicalToolCandidates.length === 0) {
    throw new TypeError("PrintPlan requires analyzed G-code logical tools.");
  }
  const logicalTools = logicalToolCandidates.map((tool, index) => normalizeToolId(tool?.toolId ?? tool, index));
  if (new Set(logicalTools).size !== logicalTools.length) {
    throw new TypeError("PrintPlan asset logical tools must be unique.");
  }
  return {
    analyzed: true,
    analyzerVersion,
    fileHash,
    logicalTools,
    toolCount: logicalTools.length,
    analyzedAt: analysis.analyzedAt || null,
  };
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
  const analysis = normalizeGcodeAnalysis(asset);
  return {
    assetId: asset?.assetId || createPrinterCoreV3DeterministicId("gcode-asset", [path, fileName]),
    path,
    fileName,
    fileMd5: asset?.fileMd5 || null,
    fileHash: analysis.fileHash,
    toolCount: analysis.toolCount,
    logicalTools: analysis.logicalTools,
    analysis,
  };
}

/**
 * マルチカラーCFS用 colorMatch policy を正規化する。
 *
 * 【詳細説明】
 * - caller が `requireObservedSelectedSource:false` を渡しても、authority前提条件を弱めない。
 * - 追加の source/protocol note は保持するが、安全に関わる2項目は固定する。
 *
 * @private
 * @param {object|null|undefined} policy - caller 指定 policy
 * @returns {object} 正規化済み policy
 */
function normalizeMulticolorColorMatchPolicy(policy) {
  const sourcePolicy = policy && typeof policy === "object" ? cloneJsonValue(policy) : {};
  return {
    ...sourcePolicy,
    mode: "explicit-tool-assignment",
    requireObservedSelectedSource: true,
  };
}

/**
 * tool assignment を生成する。
 *
 * 【詳細説明】
 * - materialSourceId を必須にし、外部リール/CFS slot/将来の spool mount を command 前に明示する。
 * - Creality 側の `colorMatch`/assignment を後で検証できるように、任意の protocol evidence も保持する。
 *
 * @private
 * @param {object} options - assignment 生成オプション
 * @param {number|string} options.toolId - G-code logical tool ID
 * @param {string=} options.protocolToolAlias - Creality protocol/source alias
 * @param {string} options.materialSourceId - material source ID
 * @param {string=} options.spoolId - material source に装着済みの spool ID
 * @param {number=} index - assignment index
 * @returns {object} tool assignment
 */
function createToolAssignment(options, index = 0) {
  const toolId = normalizeToolId(options.toolId, index);
  const protocolToolAlias = requireNonEmptyString(options.protocolToolAlias || options.toolAlias, "protocolToolAlias");
  const materialSourceId = requireNonEmptyString(options.materialSourceId, "materialSourceId");
  const spoolId = String(options.spoolId || "").trim() || null;
  return {
    assignmentId: createPrinterCoreV3DeterministicId("tool-assignment", [toolId, protocolToolAlias, materialSourceId]),
    toolId,
    protocolToolAlias,
    toolAlias: protocolToolAlias,
    materialSourceId,
    spoolId,
    confidence: options.confidence || "operator-confirmed",
    order: Number.isFinite(Number(options.order)) ? Number(options.order) : index,
    protocol: cloneJsonValue(options.protocol || {}),
  };
}

/**
 * material source ID の一覧を assignment から生成する。
 *
 * 【詳細説明】
 * - 複数 tool が同じ material source を指す可能性は残しつつ、PrintPlan 上の source 集合は重複を除く。
 *
 * @private
 * @param {object[]} assignments - tool assignment 配列
 * @returns {string[]} material source ID 配列
 */
function collectMaterialSourceIds(assignments) {
  return [...new Set(assignments.map((assignment) => assignment.materialSourceId))];
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
  const assignment = createToolAssignment({
    toolId: options.toolId ?? 0,
    protocolToolAlias: options.protocolToolAlias || options.toolAlias || "T1A",
    materialSourceId: options.materialSourceId,
    spoolId: options.spoolId,
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
    materialSourceIds: collectMaterialSourceIds([assignment]),
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
 * CFS/マルチカラー PrintPlan を生成する。
 *
 * 【詳細説明】
 * - 4色 benchy のような multi tool G-code では、各 tool alias と CFS material source の対応を必須にする。
 * - `selected` なしの dry-run 的な印刷を防ぐため、assignment 未確定の tool を含む plan は作らない。
 * - Gate 16 時点では command authority へ渡す契約だけを作り、プリンタへの送信権限は付与しない。
 *
 * @function createMulticolorCfsPrintPlan
 * @param {object} options - PrintPlan 生成オプション
 * @param {string} options.deviceId - 物理 device ID
 * @param {object} options.asset - G-code asset
 * @param {object[]} options.toolAssignments - logical tool ID と material source ID の対応
 * @param {string=} options.createdAt - 作成時刻 ISO 文字列
 * @param {object=} options.preflight - preflight evidence
 * @param {object=} options.colorMatchPolicy - colorMatch/assignment 方針
 * @returns {object} CFS/マルチカラー PrintPlan
 * @example
 * const plan = createMulticolorCfsPrintPlan({ deviceId, asset, toolAssignments });
 */
export function createMulticolorCfsPrintPlan(options = {}) {
  const deviceId = requireNonEmptyString(options.deviceId, "deviceId");
  const inputAssignments = Array.isArray(options.toolAssignments) ? options.toolAssignments : [];
  if (inputAssignments.length < 2) {
    throw new TypeError("Multicolor CFS PrintPlan requires at least two toolAssignments.");
  }
  const assignments = inputAssignments.map((assignment, index) => createToolAssignment(assignment, index));
  const asset = normalizeGcodeAsset(options.asset || {});
  const materialSourceIds = collectMaterialSourceIds(assignments);
  const printPlanId = options.printPlanId || createPrinterCoreV3DeterministicId("print-plan", [
    deviceId,
    asset.assetId,
    ...assignments.map((assignment) => assignment.assignmentId),
  ]);
  const plan = {
    schemaVersion: PRINT_PLAN_SCHEMA_VERSION,
    printPlanId,
    planKind: "multicolor-cfs",
    deviceId,
    asset,
    toolAssignments: assignments,
    materialSourceIds,
    colorMatchPolicy: normalizeMulticolorColorMatchPolicy(options.colorMatchPolicy),
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
 * - 単色では assignment 1件、CFS/マルチカラーでは assignment 2件以上を要求する。
 * - 各 logical tool ID は重複を拒否し、material source ID は必ず command 前に明示させる。
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
  const supportedPlanKind = plan.planKind === "single-color" || plan.planKind === "multicolor-cfs";
  if (!supportedPlanKind) {
    errors.push("unsupported-plan-kind");
  }
  if (!plan.asset || typeof plan.asset !== "object" || !String(plan.asset.path || "").trim()) {
    errors.push("missing-asset-path");
  }
  const assignments = Array.isArray(plan.toolAssignments) ? plan.toolAssignments : [];
  if (plan.planKind === "single-color" && assignments.length !== 1) {
    errors.push("single-color-tool-assignment-count-invalid");
  }
  if (plan.planKind === "multicolor-cfs" && assignments.length < 2) {
    errors.push("multicolor-tool-assignment-count-invalid");
  }
  const toolIds = new Set();
  for (const assignment of assignments) {
    let toolId = null;
    try {
      if (assignment?.toolId === undefined || assignment?.toolId === null) {
        throw new TypeError("missing toolId");
      }
      toolId = normalizeToolId(assignment.toolId);
    } catch {
      toolId = null;
    }
    const protocolToolAlias = String(assignment?.protocolToolAlias || assignment?.toolAlias || "").trim();
    const materialSourceId = String(assignment?.materialSourceId || "").trim();
    if (toolId === null) {
      errors.push("missing-tool-id");
    } else if (toolIds.has(toolId)) {
      errors.push("duplicate-tool-id");
    } else {
      toolIds.add(toolId);
    }
    if (!protocolToolAlias) {
      errors.push("missing-protocol-tool-alias");
    }
    if (!materialSourceId) {
      errors.push("missing-material-source-id");
    }
  }
  if (plan.planKind === "multicolor-cfs") {
    if (!plan.colorMatchPolicy || typeof plan.colorMatchPolicy !== "object") {
      errors.push("missing-color-match-policy");
    } else {
      if (plan.colorMatchPolicy.mode !== "explicit-tool-assignment") {
        errors.push("unsafe-color-match-policy");
      }
      if (plan.colorMatchPolicy.requireObservedSelectedSource !== true) {
        errors.push("missing-observed-selected-source-policy");
      }
    }
  }
  let assetLogicalTools = [];
  try {
    const analysis = normalizeGcodeAnalysis(plan.asset || {});
    assetLogicalTools = analysis.logicalTools;
    if (Array.isArray(plan.asset?.logicalTools) && plan.asset.logicalTools.length > 0) {
      const topLevelLogicalTools = plan.asset.logicalTools.map((toolId) => normalizeToolId(toolId));
      if (
        topLevelLogicalTools.length !== assetLogicalTools.length ||
        topLevelLogicalTools.some((toolId, index) => toolId !== assetLogicalTools[index])
      ) {
        errors.push("asset-analysis-logical-tool-mismatch");
      }
    }
  } catch (error) {
    if (error instanceof TypeError && /must be unique/u.test(error.message)) {
      errors.push("duplicate-asset-logical-tool");
    } else if (error instanceof TypeError && /requires analyzed G-code logical tools/u.test(error.message)) {
      errors.push("missing-gcode-analysis");
    } else {
      errors.push("invalid-gcode-analysis");
    }
  }
  if (new Set(assetLogicalTools).size !== assetLogicalTools.length) {
    errors.push("duplicate-asset-logical-tool");
  }
  if (plan.asset?.toolCount && assignments.length > 0 && Number(plan.asset.toolCount) !== assignments.length) {
    errors.push("asset-tool-count-assignment-mismatch");
  }
  for (const toolId of assetLogicalTools) {
    if (!toolIds.has(toolId)) {
      errors.push("missing-gcode-tool-assignment");
    }
  }
  const expectedMaterialSourceIds = collectMaterialSourceIds(assignments);
  if (plan.planKind === "single-color" && (!Array.isArray(plan.materialSourceIds) || plan.materialSourceIds.length !== 1)) {
    errors.push("single-color-material-source-count-invalid");
  }
  if (!Array.isArray(plan.materialSourceIds) || plan.materialSourceIds.length !== expectedMaterialSourceIds.length) {
    errors.push("material-source-assignment-mismatch");
  } else if (expectedMaterialSourceIds.some((materialSourceId) => !plan.materialSourceIds.includes(materialSourceId))) {
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
      planKind: plan.planKind,
      asset: cloneJsonValue(plan.asset),
      toolAssignments: cloneJsonValue(plan.toolAssignments),
      materialSourceIds: cloneJsonValue(plan.materialSourceIds),
      colorMatchPolicy: cloneJsonValue(plan.colorMatchPolicy || null),
      multiColorPrint: plan.planKind === "multicolor-cfs",
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
