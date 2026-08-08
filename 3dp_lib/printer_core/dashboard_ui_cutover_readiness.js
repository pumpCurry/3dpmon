/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 UI cutover readiness モジュール
 * @file dashboard_ui_cutover_readiness.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_ui_cutover_readiness
 *
 * 【機能内容サマリ】
 * - Printer Core v3 へ UI authority を切り替える前提条件を機械的に評価する
 * - legacy UI/command/ledger retirement を未達条件つきでブロックする
 * - Gate 18 時点の cutover plan を dry-run contract として生成する
 *
 * 【公開関数一覧】
 * - {@link createPrinterCoreV3CutoverReadinessReport}：cutover readiness report を生成
 * - {@link createPrinterCoreV3UiCutoverPlan}：UI cutover plan を生成
 * - {@link assertPrinterCoreV3UiCutoverAllowed}：cutover 許可条件を検査
 *
 * @version 1.390.1347 (PR #432)
 * @since   1.390.1346 (PR #432)
 * @lastModified 2026-08-09 06:52:36
 * -----------------------------------------------------------
 * @todo
 * - 実 UI の raw JSON 参照を NormalizedState 参照へ段階的に差し替える
 */

"use strict";

/**
 * UI cutover readiness contract version。
 *
 * 【詳細説明】
 * - Data Schema v3 や command contract とは別に、cutover report の shape を固定する。
 *
 * @constant {number}
 */
export const PRINTER_CORE_V3_UI_CUTOVER_CONTRACT_VERSION = 1;

/**
 * UI cutover の必須チェック定義。
 *
 * 【詳細説明】
 * - ここに列挙された項目がすべて true になるまで legacy UI authority は維持する。
 *
 * @constant {Array<object>}
 */
const REQUIRED_CUTOVER_CHECKS = Object.freeze([
  Object.freeze({
    key: "schemaV3WritesActive",
    blocker: "schema-v3-writes-not-active",
    description: "Data Schema v3 writes are active and migration journal is available.",
  }),
  Object.freeze({
    key: "normalizedStateCertified",
    blocker: "normalized-state-not-certified",
    description: "NormalizedState is certified for the target printer family.",
  }),
  Object.freeze({
    key: "k2PrintSemanticsCertified",
    blocker: "k2-print-semantics-not-certified",
    description: "K2 state/deviceState mapping is certified when K2 devices are in scope.",
  }),
  Object.freeze({
    key: "commandAuthorityCanSend",
    blocker: "command-authority-send-disabled",
    description: "Printer Core command authority can send vetted commands.",
  }),
  Object.freeze({
    key: "printPlanCanStart",
    blocker: "print-plan-start-disabled",
    description: "PrintPlan authority can start print jobs only after preflight.",
  }),
  Object.freeze({
    key: "materialProviderCanDriveLedger",
    blocker: "material-provider-ledger-disabled",
    description: "MaterialProvider observations can drive ledger only after source/spool authority.",
  }),
  Object.freeze({
    key: "filamentLedgerCanAppend",
    blocker: "filament-ledger-append-disabled",
    description: "Filament ledger can append authoritative v3 events.",
  }),
  Object.freeze({
    key: "liveShadowDiffsClean",
    blocker: "live-shadow-diffs-not-clean",
    description: "Live shadow differential is clean for required device families.",
  }),
  Object.freeze({
    key: "legacyFallbackAvailable",
    blocker: "legacy-fallback-not-available",
    description: "Legacy fallback remains available for rollback during cutover.",
  }),
]);

/**
 * readiness evidence の信頼済み source 定義。
 *
 * 【詳細説明】
 * - arbitrary boolean injection で ready にならないよう、各 evidence は authority source を明示する。
 *
 * @constant {object}
 */
const TRUSTED_EVIDENCE_SOURCES = Object.freeze({
  schemaV3WritesActive: "schema-v3-repository",
  normalizedStateCertified: "normalized-state-certification-registry",
  k2PrintSemanticsCertified: "k2-print-semantics-certification-registry",
  commandAuthorityCanSend: "command-dispatcher-authority",
  printPlanCanStart: "print-plan-authority",
  materialProviderCanDriveLedger: "material-provider-authority",
  filamentLedgerCanAppend: "filament-ledger-repository",
  liveShadowDiffsClean: "live-shadow-runtime",
  legacyFallbackAvailable: "legacy-fallback-registry",
});

/**
 * trusted readiness evidence を安全に読む。
 *
 * 【詳細説明】
 * - evidence entry は `{ value: true, source, trusted: true }` の形だけを合格にする。
 * - boolean の `true` は review memo としては読めても authority 昇格証拠にはしない。
 *
 * @private
 * @param {object} evidence - readiness evidence
 * @param {string} key - check key
 * @returns {boolean} true の場合だけ合格
 */
function evidenceIsTrustedTrue(evidence, key) {
  const entry = evidence?.[key];
  const expectedSource = TRUSTED_EVIDENCE_SOURCES[key];
  return Boolean(
    entry &&
    typeof entry === "object" &&
    entry.value === true &&
    entry.trusted === true &&
    entry.source === expectedSource
  );
}

/**
 * JSON 互換値を deep clone する。
 *
 * 【詳細説明】
 * - report/plan の evidence を呼び出し側 mutation から守る。
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
 * live shadow runtime record から clean 判定を作る。
 *
 * 【詳細説明】
 * - diffCount が0で、少なくとも1 frame を観測している record だけを clean とみなす。
 * - K1/K2を複数台見る場合は、呼び出し側が必須対象の record だけを渡す。
 *
 * @private
 * @param {Array<object>} shadowRecords - live shadow runtime record 配列
 * @returns {boolean} required shadow が clean の場合 true
 */
function deriveLiveShadowDiffsClean(shadowRecords) {
  if (!Array.isArray(shadowRecords) || shadowRecords.length === 0) {
    return false;
  }
  return shadowRecords.every((record) => {
    const observedFrames = Number(record?.observedFrames);
    const diffCount = Number(record?.diffCount);
    const state = String(record?.state || "");
    return observedFrames > 0 && diffCount === 0 && (state === "matched" || state === "observing" || state === "closed");
  });
}

/**
 * cutover readiness evidence を正規化する。
 *
 * 【詳細説明】
 * - live shadow だけは runtime record から導出可能にし、他のauthorityは明示 evidence を要求する。
 *
 * @private
 * @param {object} options - readiness report 生成オプション
 * @returns {object} 正規化済み evidence
 */
function normalizeCutoverEvidence(options = {}) {
  const evidence = cloneJsonValue(options.evidence || {});
  if (!evidenceIsTrustedTrue(evidence, "liveShadowDiffsClean") && Array.isArray(options.shadowRecords)) {
    evidence.liveShadowDiffsClean = {
      value: deriveLiveShadowDiffsClean(options.shadowRecords),
      source: TRUSTED_EVIDENCE_SOURCES.liveShadowDiffsClean,
      trusted: true,
    };
  }
  return evidence;
}

/**
 * Printer Core v3 UI cutover readiness report を生成する。
 *
 * 【詳細説明】
 * - すべての必須チェックが true の場合だけ `ready` を true にする。
 * - Gate 18 dry-run では command/ledger/UI はまだ authority ではないため、blocker が残るのが正常。
 *
 * @function createPrinterCoreV3CutoverReadinessReport
 * @param {object=} options - report 生成オプション
 * @param {object=} options.evidence - authority readiness evidence。各値は `{value, source, trusted}` 形式
 * @param {Array<object>=} options.shadowRecords - live shadow runtime record 配列
 * @param {string=} options.createdAt - report 作成時刻
 * @returns {object} cutover readiness report
 * @example
 * const report = createPrinterCoreV3CutoverReadinessReport({ evidence });
 */
export function createPrinterCoreV3CutoverReadinessReport(options = {}) {
  const evidence = normalizeCutoverEvidence(options);
  const checks = REQUIRED_CUTOVER_CHECKS.map((definition) => ({
    key: definition.key,
    passed: evidenceIsTrustedTrue(evidence, definition.key),
    blocker: definition.blocker,
    description: definition.description,
  }));
  const blockers = checks.filter((check) => !check.passed).map((check) => check.blocker);
  return {
    schemaVersion: PRINTER_CORE_V3_UI_CUTOVER_CONTRACT_VERSION,
    ready: blockers.length === 0,
    blockers,
    checks,
    evidence,
    createdAt: options.createdAt || null,
    authority: {
      mode: blockers.length === 0 ? "ready-for-explicit-cutover" : "cutover-blocked",
      canSwitchUiAuthority: blockers.length === 0,
      canRetireLegacyPaths: false,
    },
  };
}

/**
 * UI cutover plan を生成する。
 *
 * 【詳細説明】
 * - report が未readyなら plan も blocked になり、legacy authority を維持する。
 * - ready でも Gate 18 contract では legacy retirement を自動実行せず、明示操作を要求する。
 *
 * @function createPrinterCoreV3UiCutoverPlan
 * @param {object} report - readiness report
 * @param {object=} options - plan 生成オプション
 * @param {string=} options.operator - 操作者
 * @returns {object} UI cutover plan
 * @example
 * const plan = createPrinterCoreV3UiCutoverPlan(report);
 */
export function createPrinterCoreV3UiCutoverPlan(report, options = {}) {
  const ready = report?.ready === true;
  return {
    schemaVersion: PRINTER_CORE_V3_UI_CUTOVER_CONTRACT_VERSION,
    planKind: "ui-authority-cutover",
    status: ready ? "ready" : "blocked",
    blockers: Array.isArray(report?.blockers) ? [...report.blockers] : ["missing-readiness-report"],
    operator: options.operator || null,
    steps: [
      {
        step: "keep-legacy-authority",
        required: !ready,
        completed: !ready,
      },
      {
        step: "switch-ui-to-normalized-state",
        required: ready,
        completed: false,
      },
      {
        step: "switch-command-route-to-printer-core",
        required: ready,
        completed: false,
      },
      {
        step: "switch-ledger-route-to-printer-core",
        required: ready,
        completed: false,
      },
      {
        step: "retire-legacy-raw-json-ui-paths",
        required: ready,
        completed: false,
      },
    ],
    authority: {
      mode: ready ? "manual-cutover-required" : "cutover-blocked",
      canSwitchUiAuthority: ready,
      canRetireLegacyPaths: false,
    },
  };
}

/**
 * UI cutover が許可される状態か検査する。
 *
 * 【詳細説明】
 * - 自動切替・誤配線・feature flag 誤設定から legacy authority を守るための fail-closed guard。
 *
 * @function assertPrinterCoreV3UiCutoverAllowed
 * @param {object} report - readiness report
 * @returns {true} cutover 可能な場合 true
 * @throws {Error} 未readyの場合
 * @example
 * assertPrinterCoreV3UiCutoverAllowed(report);
 */
export function assertPrinterCoreV3UiCutoverAllowed(report) {
  if (report?.ready === true) {
    return true;
  }
  const blockers = Array.isArray(report?.blockers) && report.blockers.length
    ? report.blockers.join(",")
    : "missing-readiness-report";
  throw new Error(`Printer Core v3 UI cutover is blocked: ${blockers}`);
}
