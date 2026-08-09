/**
 * @fileoverview Printer Core v3 UI cutover readiness の単体テスト
 * @description
 * - Gate 18 で UI authority cutover を fail-closed に保つことを検証する。
 *
 * @version 1.390.1350 (PR #432)
 * @since 1.390.1346 (PR #432)
 * @lastModified 2026-08-09 09:25:00
 */

import { describe, expect, it } from "vitest";
import {
  assertPrinterCoreV3UiCutoverAllowed,
  createPrinterCoreV3CutoverReadinessReport,
  createPrinterCoreV3UiCutoverPlan,
} from "../../3dp_lib/printer_core/dashboard_ui_cutover_readiness.js";

/**
 * ready風の plain source snapshot を返す。
 *
 * 【詳細説明】
 * - 個別テストで一部を落として blocker が期待通り出るか確認するための土台。
 *
 * @function createPlainReadySources
 * @returns {object} plain source snapshot
 */
function createPlainReadySources() {
  return {
    schemaV3WritesActive: {
      source: "schema-v3-repository",
      writesActive: true,
      migrationJournalAvailable: true,
    },
    normalizedStateCertified: {
      source: "normalized-state-certification-registry",
      certified: true,
    },
    k2PrintSemanticsCertified: {
      source: "k2-print-semantics-certification-registry",
      certified: true,
    },
    commandAuthorityCanSend: {
      source: "command-dispatcher-authority",
      canSend: true,
    },
    printPlanCanStart: {
      source: "print-plan-authority",
      canStart: true,
    },
    materialProviderCanDriveLedger: {
      source: "material-provider-authority",
      canDriveLedger: true,
    },
    filamentLedgerCanAppend: {
      source: "filament-ledger-repository",
      canAppend: true,
    },
    legacyFallbackAvailable: {
      source: "legacy-fallback-registry",
      available: true,
    },
  };
}

describe("Printer Core v3 UI cutover readiness", () => {
  it("現Gateのcontract-only状態ではcutoverをブロックする", () => {
    const report = createPrinterCoreV3CutoverReadinessReport({
      sources: {
        ...createPlainReadySources(),
        schemaV3WritesActive: {
          source: "schema-v3-repository",
          writesActive: false,
          migrationJournalAvailable: true,
        },
        commandAuthorityCanSend: {
          source: "command-dispatcher-authority",
          canSend: false,
        },
        k2PrintSemanticsCertified: {
          source: "k2-print-semantics-certification-registry",
          certified: false,
        },
        printPlanCanStart: {
          source: "print-plan-authority",
          canStart: false,
        },
        materialProviderCanDriveLedger: {
          source: "material-provider-authority",
          canDriveLedger: false,
        },
        filamentLedgerCanAppend: {
          source: "filament-ledger-repository",
          canAppend: false,
        },
      },
      createdAt: "2026-08-09T01:50:25.000+09:00",
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
    expect(report.authority).toEqual({
      mode: "cutover-blocked",
      canSwitchUiAuthority: false,
      canRetireLegacyPaths: false,
    });
    expect(() => assertPrinterCoreV3UiCutoverAllowed(report)).toThrow("schema-v3-writes-not-active");
  });

  it("live shadow recordからdiff cleanを導出できる", () => {
    const report = createPrinterCoreV3CutoverReadinessReport({
      sources: createPlainReadySources(),
      shadowRecords: [
        { printerFamily: "k1", differentialCompared: true, observedFrames: 12, diffCount: 0, state: "matched" },
        { printerFamily: "k1", differentialCompared: true, observedFrames: 8, diffCount: 0, state: "observing" },
      ],
    });

    expect(report.ready).toBe(false);
    expect(report.evidence.liveShadowDiffsClean).toEqual({
      value: true,
      source: "live-shadow-runtime",
      trusted: true,
    });
    expect(() => assertPrinterCoreV3UiCutoverAllowed({
      sources: createPlainReadySources(),
      shadowRecords: [
        { printerFamily: "k1", differentialCompared: true, observedFrames: 12, diffCount: 0, state: "matched" },
      ],
    })).toThrow("schema-v3-writes-not-active");
  });

  it("shadow diffが残る場合はreadyにならない", () => {
    const report = createPrinterCoreV3CutoverReadinessReport({
      sources: createPlainReadySources(),
      shadowRecords: [
        { printerFamily: "k1", differentialCompared: true, observedFrames: 12, diffCount: 1, state: "matched" },
      ],
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

  it("plain source snapshotではmanual cutover planにならない", () => {
    const readinessInput = {
      sources: createPlainReadySources(),
      shadowRecords: [
        { printerFamily: "k1", differentialCompared: true, observedFrames: 12, diffCount: 0, state: "matched" },
      ],
    };
    const report = createPrinterCoreV3CutoverReadinessReport(readinessInput);
    const plan = createPrinterCoreV3UiCutoverPlan(report, {
      operator: "codex-test",
    });
    const recomputedPlan = createPrinterCoreV3UiCutoverPlan(readinessInput, {
      operator: "codex-test",
    });

    expect(report.ready).toBe(false);
    expect(plan.status).toBe("blocked");
    expect(recomputedPlan).toMatchObject({
      planKind: "ui-authority-cutover",
      status: "blocked",
      blockers: expect.arrayContaining([
        "schema-v3-writes-not-active",
        "legacy-fallback-not-available",
      ]),
      operator: "codex-test",
      authority: {
        mode: "cutover-blocked",
        canSwitchUiAuthority: false,
        canRetireLegacyPaths: false,
      },
    });
    expect(recomputedPlan.steps.map((step) => [step.step, step.required, step.completed])).toEqual([
      ["keep-legacy-authority", true, true],
      ["switch-ui-to-normalized-state", false, false],
      ["switch-command-route-to-printer-core", false, false],
      ["switch-ledger-route-to-printer-core", false, false],
      ["retire-legacy-raw-json-ui-paths", false, false],
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

  it("K2 read-only観測recordはliveShadowDiffsCleanの証跡にしない", () => {
    const report = createPrinterCoreV3CutoverReadinessReport({
      sources: createPlainReadySources(),
      shadowRecords: [
        {
          printerFamily: "k2",
          differentialCompared: false,
          observedFrames: 20,
          diffCount: 0,
          state: "closed",
        },
      ],
    });

    expect(report.evidence.liveShadowDiffsClean).toEqual({
      value: false,
      source: "live-shadow-runtime",
      trusted: true,
    });
    expect(report.blockers).toContain("live-shadow-diffs-not-clean");
  });
});
