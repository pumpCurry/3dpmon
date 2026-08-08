/**
 * @fileoverview Printer Core v3 PrintPlan の単体テスト
 * @description
 * - Gate 15 で単色印刷も PrintPlan を通し、material source と command contract を明示することを検証する。
 *
 * @version 1.390.1343 (PR #432)
 * @since 1.390.1343 (PR #432)
 * @lastModified 2026-08-09 01:38:47
 */

import { describe, expect, it } from "vitest";
import { createPrinterCommandResult, shouldRetryPrinterCommand } from "../../3dp_lib/printer_core/dashboard_command_authority.js";
import {
  createPrintStartCommandRequestFromPlan,
  createSingleColorPrintPlan,
  validatePrintPlan,
} from "../../3dp_lib/printer_core/dashboard_print_plan.js";

/**
 * 単色 PrintPlan 用の最小 asset を返す。
 *
 * 【詳細説明】
 * - 実機 path は redaction 済み fixture に近い形を使い、path/name/fileMd5 の基本 field を確認する。
 *
 * @function createSampleAsset
 * @returns {object} テスト用 G-code asset
 */
function createSampleAsset() {
  return {
    path: "/mnt/UDISK/printer_data/gcodes/benchy.gcode",
    fileName: "benchy.gcode",
    fileMd5: "md5-demo",
  };
}

describe("Printer Core v3 PrintPlan", () => {
  it("単色PrintPlanでもassetとmaterialSourceを明示する", () => {
    const plan = createSingleColorPrintPlan({
      deviceId: "serial:k2pro",
      asset: createSampleAsset(),
      toolAlias: "T1C",
      materialSourceId: "cfs:1:slot:2",
      createdAt: "2026-08-09T01:38:47.000+09:00",
      preflight: {
        selectedSourceObserved: true,
      },
    });

    expect(plan).toMatchObject({
      schemaVersion: 1,
      planKind: "single-color",
      deviceId: "serial:k2pro",
      asset: {
        path: "/mnt/UDISK/printer_data/gcodes/benchy.gcode",
        fileName: "benchy.gcode",
        fileMd5: "md5-demo",
        toolCount: 1,
      },
      toolAssignments: [
        {
          toolAlias: "T1C",
          materialSourceId: "cfs:1:slot:2",
          confidence: "operator-confirmed",
        },
      ],
      materialSourceIds: ["cfs:1:slot:2"],
      authority: {
        mode: "plan-only",
        canStartPrint: false,
        requiresCommandAuthority: true,
        requiresExpectedStateConfirmation: true,
      },
    });
    expect(validatePrintPlan(plan)).toEqual({ ok: true, errors: [] });
  });

  it("materialSourceId無しの単色PrintPlanは作成時に拒否する", () => {
    expect(() => createSingleColorPrintPlan({
      deviceId: "serial:k2pro",
      asset: createSampleAsset(),
    })).toThrow("materialSourceId");
  });

  it("PrintPlanからcontract-only print-start command requestを生成する", () => {
    const plan = createSingleColorPrintPlan({
      deviceId: "serial:k2pro",
      asset: createSampleAsset(),
      materialSourceId: "cfs:1:slot:2",
    });
    const request = createPrintStartCommandRequestFromPlan(plan, {
      sessionId: "session:1",
      transportKind: "ws9999",
      entropySource: () => "unit",
    });

    expect(request).toMatchObject({
      commandKind: "print-start",
      deviceId: "serial:k2pro",
      sessionId: "session:1",
      transportKind: "ws9999",
      sideEffect: true,
      idempotent: false,
      expectedStateRequired: true,
      idempotencyKey: plan.printPlanId,
      authority: {
        mode: "contract-only",
        canSend: false,
        canBlindRetry: false,
      },
      payload: {
        printPlanId: plan.printPlanId,
        materialSourceIds: ["cfs:1:slot:2"],
        toolAssignments: [
          {
            toolAlias: "T1A",
            materialSourceId: "cfs:1:slot:2",
          },
        ],
      },
    });
    expect(request.expectedState).toEqual([
      {
        path: "print.stateLabel",
        operator: "oneOf",
        expected: ["printing", "checking"],
      },
    ]);
  });

  it("PrintPlan由来のprint-start commandはtimeoutでもblind retryしない", () => {
    const plan = createSingleColorPrintPlan({
      deviceId: "serial:k2pro",
      asset: createSampleAsset(),
      materialSourceId: "external:0:slot:0",
    });
    const request = createPrintStartCommandRequestFromPlan(plan, {
      sessionId: "session:1",
      entropySource: () => "unit",
    });
    const result = createPrinterCommandResult(request, { status: "timeout" });

    expect(result.completed).toBe(false);
    expect(shouldRetryPrinterCommand(request, result)).toBe(false);
  });

  it("壊れたPrintPlanはvalidationで拒否する", () => {
    expect(validatePrintPlan({
      schemaVersion: 999,
      printPlanId: "",
      planKind: "multi-color",
      deviceId: "",
      asset: {},
      toolAssignments: [],
      materialSourceIds: ["cfs:1:slot:0"],
      authority: {
        canStartPrint: true,
      },
    })).toEqual({
      ok: false,
      errors: [
        "missing-printPlanId",
        "missing-deviceId",
        "unexpected-schema-version",
        "unsupported-plan-kind",
        "missing-asset-path",
        "single-color-tool-assignment-count-invalid",
        "missing-tool-alias",
        "missing-material-source-id",
        "material-source-assignment-mismatch",
        "plan-can-start-print",
      ],
    });
  });
});
