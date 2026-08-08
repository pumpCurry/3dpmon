/**
 * @fileoverview Printer Core v3 UI cutover readiness の単体テスト
 * @description
 * - Gate 18 で UI authority cutover を fail-closed に保つことを検証する。
 *
 * @version 1.390.1346 (PR #432)
 * @since 1.390.1346 (PR #432)
 * @lastModified 2026-08-09 01:50:25
 */

import { describe, expect, it } from "vitest";
import {
  assertPrinterCoreV3UiCutoverAllowed,
  createPrinterCoreV3CutoverReadinessReport,
  createPrinterCoreV3UiCutoverPlan,
} from "../../3dp_lib/printer_core/dashboard_ui_cutover_readiness.js";

/**
 * cutover ready に必要な evidence を返す。
 *
 * 【詳細説明】
 * - 個別テストで一部を落として blocker が期待通り出るか確認するための土台。
 *
 * @function createReadyEvidence
 * @returns {object} ready evidence
 */
function createReadyEvidence() {
  return {
    schemaV3WritesActive: true,
    normalizedStateCertified: true,
    k2PrintSemanticsCertified: true,
    commandAuthorityCanSend: true,
    printPlanCanStart: true,
    materialProviderCanDriveLedger: true,
    filamentLedgerCanAppend: true,
    liveShadowDiffsClean: true,
    legacyFallbackAvailable: true,
  };
}

describe("Printer Core v3 UI cutover readiness", () => {
  it("現Gateのcontract-only状態ではcutoverをブロックする", () => {
    const report = createPrinterCoreV3CutoverReadinessReport({
      evidence: {
        schemaV3WritesActive: false,
        normalizedStateCertified: true,
        commandAuthorityCanSend: false,
        printPlanCanStart: false,
        filamentLedgerCanAppend: false,
        legacyFallbackAvailable: true,
      },
      createdAt: "2026-08-09T01:50:25.000+09:00",
    });

    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual([
      "schema-v3-writes-not-active",
      "k2-print-semantics-not-certified",
      "command-authority-send-disabled",
      "print-plan-start-disabled",
      "material-provider-ledger-disabled",
      "filament-ledger-append-disabled",
      "live-shadow-diffs-not-clean",
    ]);
    expect(report.authority).toEqual({
      mode: "cutover-blocked",
      canSwitchUiAuthority: false,
      canRetireLegacyPaths: false,
    });
    expect(() => assertPrinterCoreV3UiCutoverAllowed(report)).toThrow("schema-v3-writes-not-active");
  });

  it("live shadow recordからdiff cleanを導出できる", () => {
    const report = createPrinterCoreV3CutoverReadinessReport({
      evidence: {
        ...createReadyEvidence(),
        liveShadowDiffsClean: false,
      },
      shadowRecords: [
        { observedFrames: 12, diffCount: 0, state: "matched" },
        { observedFrames: 8, diffCount: 0, state: "observing" },
      ],
    });

    expect(report.ready).toBe(true);
    expect(report.evidence.liveShadowDiffsClean).toBe(true);
    expect(assertPrinterCoreV3UiCutoverAllowed(report)).toBe(true);
  });

  it("shadow diffが残る場合はreadyにならない", () => {
    const report = createPrinterCoreV3CutoverReadinessReport({
      evidence: {
        ...createReadyEvidence(),
        liveShadowDiffsClean: false,
      },
      shadowRecords: [
        { observedFrames: 12, diffCount: 1, state: "matched" },
      ],
    });

    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual(["live-shadow-diffs-not-clean"]);
  });

  it("全evidenceが揃った場合だけmanual cutover planになる", () => {
    const report = createPrinterCoreV3CutoverReadinessReport({
      evidence: createReadyEvidence(),
    });
    const plan = createPrinterCoreV3UiCutoverPlan(report, {
      operator: "codex-test",
    });

    expect(report.ready).toBe(true);
    expect(plan).toMatchObject({
      planKind: "ui-authority-cutover",
      status: "ready",
      blockers: [],
      operator: "codex-test",
      authority: {
        mode: "manual-cutover-required",
        canSwitchUiAuthority: true,
        canRetireLegacyPaths: false,
      },
    });
    expect(plan.steps.map((step) => [step.step, step.required, step.completed])).toEqual([
      ["keep-legacy-authority", false, false],
      ["switch-ui-to-normalized-state", true, false],
      ["switch-command-route-to-printer-core", true, false],
      ["switch-ledger-route-to-printer-core", true, false],
      ["retire-legacy-raw-json-ui-paths", true, false],
    ]);
  });

  it("readiness reportが無いcutover planはblockedになる", () => {
    const plan = createPrinterCoreV3UiCutoverPlan(null);

    expect(plan).toMatchObject({
      status: "blocked",
      blockers: ["missing-readiness-report"],
      authority: {
        mode: "cutover-blocked",
        canSwitchUiAuthority: false,
        canRetireLegacyPaths: false,
      },
    });
  });
});
