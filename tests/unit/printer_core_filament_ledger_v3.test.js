/**
 * @fileoverview Printer Core v3 フィラメントレジャー契約の単体テスト
 * @description
 * - Gate 17 で PrintPlan 由来の material segment と ledger event 候補を dry-run 検証する。
 *
 * @version 1.390.1348 (PR #432)
 * @since 1.390.1345 (PR #432)
 * @lastModified 2026-08-09 08:15:00
 */

import { describe, expect, it } from "vitest";
import {
  createFilamentLedgerEventsFromSegments,
  createFilamentLedgerCorrectionEvent,
  createJobMaterialSegmentsFromPrintPlan,
  validateJobMaterialSegments,
} from "../../3dp_lib/printer_core/dashboard_filament_ledger_v3.js";
import {
  createMulticolorCfsPrintPlan,
  createSingleColorPrintPlan,
} from "../../3dp_lib/printer_core/dashboard_print_plan.js";

/**
 * テスト用 G-code asset を生成する。
 *
 * 【詳細説明】
 * - path だけで PrintPlan が assetId を deterministic に生成することを前提にする。
 *
 * @function createAsset
 * @param {string} fileName - file name
 * @returns {object} G-code asset
 */
function createAsset(fileName) {
  return {
    path: `/mnt/UDISK/printer_data/gcodes/${fileName}`,
    fileName,
  };
}

describe("Printer Core v3 filament ledger contract", () => {
  it("単色PrintPlanでは総消費を単一sourceのsegmentへ紐付ける", () => {
    const plan = createSingleColorPrintPlan({
      deviceId: "serial:k2pro",
      asset: createAsset("benchy.gcode"),
      toolId: 0,
      protocolToolAlias: "T1C",
      materialSourceId: "cfs:1:slot:2",
      spoolId: "spool:silver",
    });
    const segments = createJobMaterialSegmentsFromPrintPlan(plan, {
      printJobId: "job:benchy",
      totalUsedLengthMm: 1234.5,
      confidence: "high",
      completedAt: "2026-08-09T01:46:31.000+09:00",
    });

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      printJobId: "job:benchy",
      printPlanId: plan.printPlanId,
      toolId: 0,
      protocolToolAlias: "T1C",
      materialSourceId: "cfs:1:slot:2",
      spoolId: "spool:silver",
      usedLengthMm: 1234.5,
      confidence: "high",
      allocationMode: "single-source-total",
      authority: {
        mode: "candidate-only",
        canDebitRemaining: false,
      },
    });
    expect(validateJobMaterialSegments(segments)).toEqual({ ok: true, errors: [] });
  });

  it("CFSマルチカラーではper-tool実測を各segmentへ反映する", () => {
    const plan = createMulticolorCfsPrintPlan({
      deviceId: "serial:k2pro",
      asset: {
        ...createAsset("4color_benchy.gcode"),
        toolCount: 4,
      },
      toolAssignments: [
        { toolId: 0, protocolToolAlias: "T1A", materialSourceId: "cfs:1:slot:3", spoolId: "spool:red" },
        { toolId: 1, protocolToolAlias: "T1B", materialSourceId: "cfs:1:slot:2", spoolId: "spool:green" },
        { toolId: 2, protocolToolAlias: "T1C", materialSourceId: "cfs:1:slot:1", spoolId: "spool:silver" },
        { toolId: 3, protocolToolAlias: "T1D", materialSourceId: "cfs:1:slot:0", spoolId: "spool:black" },
      ],
    });
    const segments = createJobMaterialSegmentsFromPrintPlan(plan, {
      printJobId: "job:4color",
      materialUsages: [
        { toolId: 0, protocolToolAlias: "T1A", usedLengthMm: 100, confidence: "exact" },
        { toolId: 1, protocolToolAlias: "T1B", usedLengthMm: 200, confidence: "exact" },
        { toolId: 2, protocolToolAlias: "T1C", usedLengthMm: 300, confidence: "exact" },
        { toolId: 3, protocolToolAlias: "T1D", usedLengthMm: 400, confidence: "exact" },
      ],
    });

    expect(segments.map((segment) => [
      segment.toolId,
      segment.protocolToolAlias,
      segment.materialSourceId,
      segment.spoolId,
      segment.usedLengthMm,
      segment.confidence,
      segment.allocationMode,
    ])).toEqual([
      [0, "T1A", "cfs:1:slot:3", "spool:red", 100, "exact", "observed-per-material"],
      [1, "T1B", "cfs:1:slot:2", "spool:green", 200, "exact", "observed-per-material"],
      [2, "T1C", "cfs:1:slot:1", "spool:silver", 300, "exact", "observed-per-material"],
      [3, "T1D", "cfs:1:slot:0", "spool:black", 400, "exact", "observed-per-material"],
    ]);
  });

  it("CFSマルチカラーで総消費しか無い場合はunknownにして等分配しない", () => {
    const plan = createMulticolorCfsPrintPlan({
      deviceId: "serial:k2pro",
      asset: {
        ...createAsset("4color_benchy.gcode"),
        toolCount: 4,
      },
      toolAssignments: [
        { toolId: 0, protocolToolAlias: "T1A", materialSourceId: "cfs:1:slot:3" },
        { toolId: 1, protocolToolAlias: "T1B", materialSourceId: "cfs:1:slot:2" },
        { toolId: 2, protocolToolAlias: "T1C", materialSourceId: "cfs:1:slot:1" },
        { toolId: 3, protocolToolAlias: "T1D", materialSourceId: "cfs:1:slot:0" },
      ],
    });
    const segments = createJobMaterialSegmentsFromPrintPlan(plan, {
      printJobId: "job:unallocated",
      totalUsedLengthMm: 1000,
    });

    expect(segments.map((segment) => [
      segment.usedLengthMm,
      segment.confidence,
      segment.allocationMode,
      segment.evidence,
    ])).toEqual([
      [null, "unknown", "unallocated-total", { totalUsedLengthMm: 1000 }],
      [null, "unknown", "unallocated-total", { totalUsedLengthMm: 1000 }],
      [null, "unknown", "unallocated-total", { totalUsedLengthMm: 1000 }],
      [null, "unknown", "unallocated-total", { totalUsedLengthMm: 1000 }],
    ]);
  });

  it("ledger event候補はappend不可だがspool付き確定segmentだけdebit可能性を示す", () => {
    const plan = createSingleColorPrintPlan({
      deviceId: "serial:k2pro",
      asset: createAsset("benchy.gcode"),
      materialSourceId: "cfs:1:slot:2",
      spoolId: "spool:silver",
    });
    const segments = createJobMaterialSegmentsFromPrintPlan(plan, {
      printJobId: "job:benchy",
      totalUsedLengthMm: 1234.5,
      confidence: "exact",
    });
    const events = createFilamentLedgerEventsFromSegments(segments, {
      createdAt: "2026-08-09T01:46:31.000+09:00",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "material-consumption",
      printJobId: "job:benchy",
      printPlanId: plan.printPlanId,
      materialSourceId: "cfs:1:slot:2",
      spoolId: "spool:silver",
      usedLengthMm: 1234.5,
      confidence: "exact",
      authority: {
        mode: "candidate-only",
        canAppend: false,
        canDebitRemaining: true,
      },
    });
  });

  it("同じsegmentのestimatedからexactへの更新はcorrection eventで表現する", () => {
    const plan = createSingleColorPrintPlan({
      deviceId: "serial:k2pro",
      asset: createAsset("benchy.gcode"),
      materialSourceId: "cfs:1:slot:2",
      spoolId: "spool:silver",
    });
    const estimated = createJobMaterialSegmentsFromPrintPlan(plan, {
      printJobId: "job:correction",
    });
    estimated[0].usedLengthMm = 1000;
    estimated[0].confidence = "estimated";
    estimated[0].allocationMode = "plan-estimated";
    const exact = createJobMaterialSegmentsFromPrintPlan(plan, {
      printJobId: "job:correction",
      totalUsedLengthMm: 1032,
      confidence: "exact",
    });
    const originalEvent = createFilamentLedgerEventsFromSegments(estimated)[0];
    const correction = createFilamentLedgerCorrectionEvent(originalEvent, exact[0]);

    expect(createFilamentLedgerEventsFromSegments(exact)[0].ledgerEventId).toBe(originalEvent.ledgerEventId);
    expect(correction).toMatchObject({
      eventType: "material-consumption-correction",
      consumptionIdentity: originalEvent.consumptionIdentity,
      eventRevision: 2,
      supersedesLedgerEventId: originalEvent.ledgerEventId,
      correctsLedgerEventId: originalEvent.ledgerEventId,
      usedLengthMm: 1032,
      deltaUsedLengthMm: 32,
      confidence: "exact",
      authority: {
        mode: "candidate-only",
        canAppend: false,
        canDebitRemaining: true,
      },
    });
    const revisedExact = {
      ...exact[0],
      usedLengthMm: 1040,
    };
    const sameRevisionCorrection = createFilamentLedgerCorrectionEvent(originalEvent, revisedExact);
    expect(sameRevisionCorrection.ledgerEventId).toBe(correction.ledgerEventId);
    expect(sameRevisionCorrection.deltaUsedLengthMm).toBe(40);
  });

  it("別identityのsegmentでは既存ledger eventを補正できない", () => {
    const plan = createSingleColorPrintPlan({
      deviceId: "serial:k2pro",
      asset: createAsset("benchy.gcode"),
      materialSourceId: "cfs:1:slot:2",
      spoolId: "spool:silver",
    });
    const segments = createJobMaterialSegmentsFromPrintPlan(plan, {
      printJobId: "job:correction-mismatch",
      totalUsedLengthMm: 100,
      confidence: "estimated",
    });
    const originalEvent = createFilamentLedgerEventsFromSegments(segments)[0];
    const corrected = {
      ...segments[0],
      materialSourceId: "cfs:1:slot:3",
      usedLengthMm: 120,
      confidence: "exact",
    };

    expect(() => createFilamentLedgerCorrectionEvent(originalEvent, corrected))
      .toThrow("materialSourceId");
  });

  it("spoolIdが無いsegmentやunknown segmentは残量debit不可のまま残す", () => {
    const plan = createMulticolorCfsPrintPlan({
      deviceId: "serial:k2pro",
      asset: {
        ...createAsset("4color_benchy.gcode"),
        toolCount: 2,
      },
      toolAssignments: [
        { toolId: 0, protocolToolAlias: "T1A", materialSourceId: "cfs:1:slot:3" },
        { toolId: 1, protocolToolAlias: "T1B", materialSourceId: "cfs:1:slot:2" },
      ],
    });
    const segments = createJobMaterialSegmentsFromPrintPlan(plan, {
      printJobId: "job:unknown",
      totalUsedLengthMm: 500,
    });
    const events = createFilamentLedgerEventsFromSegments(segments);

    expect(events.map((event) => event.authority.canDebitRemaining)).toEqual([false, false]);
    expect(events.map((event) => event.confidence)).toEqual(["unknown", "unknown"]);
  });

  it("壊れたsegment配列はvalidationで拒否する", () => {
    expect(validateJobMaterialSegments([
      {
        segmentId: "",
        printJobId: "",
        printPlanId: "",
        deviceId: "",
        toolId: -1,
        protocolToolAlias: "",
        materialSourceId: "",
        confidence: "certain",
        usedLengthMm: -1,
      },
    ])).toEqual({
      ok: false,
      errors: [
        "missing-segmentId",
        "missing-printJobId",
        "missing-printPlanId",
        "missing-deviceId",
        "missing-materialSourceId",
        "missing-toolId",
        "missing-protocolToolAlias",
        "invalid-confidence",
        "invalid-usedLengthMm",
      ],
    });
  });
});
