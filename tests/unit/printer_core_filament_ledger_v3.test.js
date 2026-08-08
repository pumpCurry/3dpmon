/**
 * @fileoverview Printer Core v3 フィラメントレジャー契約の単体テスト
 * @description
 * - Gate 17 で PrintPlan 由来の material segment と ledger event 候補を dry-run 検証する。
 *
 * @version 1.390.1345 (PR #432)
 * @since 1.390.1345 (PR #432)
 * @lastModified 2026-08-09 01:46:31
 */

import { describe, expect, it } from "vitest";
import {
  createFilamentLedgerEventsFromSegments,
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
      toolAlias: "T1C",
      materialSourceId: "cfs:1:slot:2",
    });
    plan.toolAssignments[0].spoolId = "spool:silver";
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
      toolAlias: "T1C",
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
      asset: createAsset("4color_benchy.gcode"),
      toolAssignments: [
        { toolAlias: "T1A", materialSourceId: "cfs:1:slot:3", spoolId: "spool:red" },
        { toolAlias: "T1B", materialSourceId: "cfs:1:slot:2", spoolId: "spool:green" },
        { toolAlias: "T1C", materialSourceId: "cfs:1:slot:1", spoolId: "spool:silver" },
        { toolAlias: "T1D", materialSourceId: "cfs:1:slot:0", spoolId: "spool:black" },
      ],
    });
    const segments = createJobMaterialSegmentsFromPrintPlan(plan, {
      printJobId: "job:4color",
      materialUsages: [
        { toolAlias: "T1A", usedLengthMm: 100, confidence: "exact" },
        { toolAlias: "T1B", usedLengthMm: 200, confidence: "exact" },
        { toolAlias: "T1C", usedLengthMm: 300, confidence: "exact" },
        { toolAlias: "T1D", usedLengthMm: 400, confidence: "exact" },
      ],
    });

    expect(segments.map((segment) => [
      segment.toolAlias,
      segment.materialSourceId,
      segment.spoolId,
      segment.usedLengthMm,
      segment.confidence,
      segment.allocationMode,
    ])).toEqual([
      ["T1A", "cfs:1:slot:3", "spool:red", 100, "exact", "observed-per-material"],
      ["T1B", "cfs:1:slot:2", "spool:green", 200, "exact", "observed-per-material"],
      ["T1C", "cfs:1:slot:1", "spool:silver", 300, "exact", "observed-per-material"],
      ["T1D", "cfs:1:slot:0", "spool:black", 400, "exact", "observed-per-material"],
    ]);
  });

  it("CFSマルチカラーで総消費しか無い場合はunknownにして等分配しない", () => {
    const plan = createMulticolorCfsPrintPlan({
      deviceId: "serial:k2pro",
      asset: createAsset("4color_benchy.gcode"),
      toolAssignments: [
        { toolAlias: "T1A", materialSourceId: "cfs:1:slot:3" },
        { toolAlias: "T1B", materialSourceId: "cfs:1:slot:2" },
        { toolAlias: "T1C", materialSourceId: "cfs:1:slot:1" },
        { toolAlias: "T1D", materialSourceId: "cfs:1:slot:0" },
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
    });
    plan.toolAssignments[0].spoolId = "spool:silver";
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

  it("spoolIdが無いsegmentやunknown segmentは残量debit不可のまま残す", () => {
    const plan = createMulticolorCfsPrintPlan({
      deviceId: "serial:k2pro",
      asset: createAsset("4color_benchy.gcode"),
      toolAssignments: [
        { toolAlias: "T1A", materialSourceId: "cfs:1:slot:3" },
        { toolAlias: "T1B", materialSourceId: "cfs:1:slot:2" },
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
        toolAlias: "",
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
        "missing-toolAlias",
        "missing-materialSourceId",
        "invalid-confidence",
        "invalid-usedLengthMm",
      ],
    });
  });
});
