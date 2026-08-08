/**
 * @fileoverview Printer Core v3 UI cutover readiness の単体テスト
 * @description
 * - Gate 18 で UI authority cutover を fail-closed に保つことを検証する。
 *
 * @version 1.390.1348 (PR #432)
 * @since 1.390.1346 (PR #432)
 * @lastModified 2026-08-09 08:15:00
 */

import { describe, expect, it } from "vitest";
import {
  assertPrinterCoreV3UiCutoverAllowed,
  createPrinterCoreV3CutoverReadinessReport,
  createPrinterCoreV3UiCutoverPlan,
} from "../../3dp_lib/printer_core/dashboard_ui_cutover_readiness.js";

/**
 * cutover ready に必要な source snapshot を返す。
 *
 * 【詳細説明】
 * - 個別テストで一部を落として blocker が期待通り出るか確認するための土台。
 *
 * @function createReadySources
 * @returns {object} ready source snapshot
 */
function createReadySources() {
  return {
    schemaV3WritesActive: {
      source: "schema-v3-repository",
      trusted: true,
      writesActive: true,
      migrationJournalAvailable: true,
    },
    normalizedStateCertified: {
      source: "normalized-state-certification-registry",
      trusted: true,
      certified: true,
    },
    k2PrintSemanticsCertified: {
      source: "k2-print-semantics-certification-registry",
      trusted: true,
      certified: true,
    },
    commandAuthorityCanSend: {
      source: "command-dispatcher-authority",
      trusted: true,
      canSend: true,
    },
    printPlanCanStart: {
      source: "print-plan-authority",
      trusted: true,
      canStart: true,
    },
    materialProviderCanDriveLedger: {
      source: "material-provider-authority",
      trusted: true,
      canDriveLedger: true,
    },
    filamentLedgerCanAppend: {
      source: "filament-ledger-repository",
      trusted: true,
      canAppend: true,
    },
    legacyFallbackAvailable: {
      source: "legacy-fallback-registry",
      trusted: true,
      available: true,
    },
  };
}

describe("Printer Core v3 UI cutover readiness", () => {
  it("現Gateのcontract-only状態ではcutoverをブロックする", () => {
    const report = createPrinterCoreV3CutoverReadinessReport({
      sources: {
        ...createReadySources(),
        schemaV3WritesActive: {
          source: "schema-v3-repository",
          trusted: true,
          writesActive: false,
          migrationJournalAvailable: true,
        },
        commandAuthorityCanSend: {
          source: "command-dispatcher-authority",
          trusted: true,
          canSend: false,
        },
        k2PrintSemanticsCertified: {
          source: "k2-print-semantics-certification-registry",
          trusted: true,
          certified: false,
        },
        printPlanCanStart: {
          source: "print-plan-authority",
          trusted: true,
          canStart: false,
        },
        materialProviderCanDriveLedger: {
          source: "material-provider-authority",
          trusted: true,
          canDriveLedger: false,
        },
        filamentLedgerCanAppend: {
          source: "filament-ledger-repository",
          trusted: true,
          canAppend: false,
        },
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
      sources: createReadySources(),
      shadowRecords: [
        { observedFrames: 12, diffCount: 0, state: "matched" },
        { observedFrames: 8, diffCount: 0, state: "observing" },
      ],
    });

    expect(report.ready).toBe(true);
    expect(report.evidence.liveShadowDiffsClean).toEqual({
      value: true,
      source: "live-shadow-runtime",
      trusted: true,
    });
    expect(assertPrinterCoreV3UiCutoverAllowed({
      sources: createReadySources(),
      shadowRecords: [
        { observedFrames: 12, diffCount: 0, state: "matched" },
      ],
    })).toBe(true);
  });

  it("shadow diffが残る場合はreadyにならない", () => {
    const report = createPrinterCoreV3CutoverReadinessReport({
      sources: createReadySources(),
      shadowRecords: [
        { observedFrames: 12, diffCount: 1, state: "matched" },
      ],
    });

    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual(["live-shadow-diffs-not-clean"]);
  });

  it("全evidenceが揃った場合だけmanual cutover planになる", () => {
    const readinessInput = {
      sources: createReadySources(),
      shadowRecords: [
        { observedFrames: 12, diffCount: 0, state: "matched" },
      ],
    };
    const report = createPrinterCoreV3CutoverReadinessReport(readinessInput);
    const plan = createPrinterCoreV3UiCutoverPlan(report, {
      operator: "codex-test",
    });
    const recomputedPlan = createPrinterCoreV3UiCutoverPlan(readinessInput, {
      operator: "codex-test",
    });

    expect(report.ready).toBe(true);
    expect(plan.status).toBe("blocked");
    expect(recomputedPlan).toMatchObject({
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
    expect(recomputedPlan.steps.map((step) => [step.step, step.required, step.completed])).toEqual([
      ["keep-legacy-authority", false, false],
      ["switch-ui-to-normalized-state", true, false],
      ["switch-command-route-to-printer-core", true, false],
      ["switch-ledger-route-to-printer-core", true, false],
      ["retire-legacy-raw-json-ui-paths", true, false],
    ]);
  });

  it("caller supplied booleanだけではtrusted readinessにならない", () => {
    const report = createPrinterCoreV3CutoverReadinessReport({
      evidence: {
        schemaV3WritesActive: true,
        normalizedStateCertified: true,
        k2PrintSemanticsCertified: true,
        commandAuthorityCanSend: true,
        printPlanCanStart: true,
        materialProviderCanDriveLedger: true,
        filamentLedgerCanAppend: true,
        liveShadowDiffsClean: true,
        legacyFallbackAvailable: true,
      },
    });

    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual([
      "schema-v3-writes-not-active",
      "normalized-state-not-certified",
      "k2-print-semantics-not-certified",
      "command-authority-send-disabled",
      "print-plan-start-disabled",
      "material-provider-ledger-disabled",
      "filament-ledger-append-disabled",
      "live-shadow-diffs-not-clean",
      "legacy-fallback-not-available",
    ]);
  });

  it("caller supplied trusted風objectだけではreadinessにならずassertも通らない", () => {
    const fakeEvidence = {
      schemaV3WritesActive: { value: true, source: "schema-v3-repository", trusted: true },
      normalizedStateCertified: { value: true, source: "normalized-state-certification-registry", trusted: true },
      k2PrintSemanticsCertified: { value: true, source: "k2-print-semantics-certification-registry", trusted: true },
      commandAuthorityCanSend: { value: true, source: "command-dispatcher-authority", trusted: true },
      printPlanCanStart: { value: true, source: "print-plan-authority", trusted: true },
      materialProviderCanDriveLedger: { value: true, source: "material-provider-authority", trusted: true },
      filamentLedgerCanAppend: { value: true, source: "filament-ledger-repository", trusted: true },
      liveShadowDiffsClean: { value: true, source: "live-shadow-runtime", trusted: true },
      legacyFallbackAvailable: { value: true, source: "legacy-fallback-registry", trusted: true },
    };
    const report = createPrinterCoreV3CutoverReadinessReport({
      evidence: fakeEvidence,
    });

    expect(report.ready).toBe(false);
    expect(() => assertPrinterCoreV3UiCutoverAllowed({ ready: true })).toThrow("schema-v3-writes-not-active");
    expect(() => assertPrinterCoreV3UiCutoverAllowed({ evidence: fakeEvidence })).toThrow("schema-v3-writes-not-active");
  });

  it("readiness reportが無いcutover planはblockedになる", () => {
    const plan = createPrinterCoreV3UiCutoverPlan(null);

    expect(plan).toMatchObject({
      status: "blocked",
      authority: {
        mode: "cutover-blocked",
        canSwitchUiAuthority: false,
        canRetireLegacyPaths: false,
      },
    });
    expect(plan.blockers).toContain("schema-v3-writes-not-active");
    expect(plan.blockers).toContain("legacy-fallback-not-available");
  });
});
