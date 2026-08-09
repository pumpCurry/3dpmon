/**
 * @fileoverview Printer Core v3 PrintPlan の単体テスト
 * @description
 * - Gate 15 で単色印刷も PrintPlan を通し、material source と command contract を明示することを検証する。
 *
 * @version 1.390.1350 (PR #432)
 * @since 1.390.1343 (PR #432)
 * @lastModified 2026-08-09 09:25:00
 */

import { describe, expect, it } from "vitest";
import { createPrinterCommandResult, shouldRetryPrinterCommand } from "../../3dp_lib/printer_core/dashboard_command_authority.js";
import {
  createGcodeAnalysisAttestation,
  createMulticolorCfsPrintPlan,
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
 * @param {string} fileName - file name
 * @param {number[]} logicalTools - analyzer が検出した logical tool ID 配列
 * @returns {object} テスト用 G-code asset
 */
function createSampleAsset(fileName = "benchy.gcode", logicalTools = [0]) {
  return {
    path: `/mnt/UDISK/printer_data/gcodes/${fileName}`,
    fileName,
    fileMd5: "md5-demo",
    analysis: createGcodeAnalysisAttestation({
      fileHash: `sha256:${fileName}`,
      analyzerVersion: "unit-gcode-analyzer",
      logicalTools,
    }),
  };
}

describe("Printer Core v3 PrintPlan", () => {
  it("単色PrintPlanでもassetとmaterialSourceを明示する", () => {
    const plan = createSingleColorPrintPlan({
      deviceId: "serial:k2pro",
      asset: createSampleAsset(),
      toolId: 0,
      protocolToolAlias: "T1C",
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
        analysis: {
          analyzed: true,
          analyzerVersion: "unit-gcode-analyzer",
          fileHash: "sha256:benchy.gcode",
          logicalTools: [0],
        },
        toolCount: 1,
      },
      toolAssignments: [
        {
          toolId: 0,
          protocolToolAlias: "T1C",
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
      protocolToolAlias: "T1A",
    })).toThrow("materialSourceId");
  });

  it("単色PrintPlanでもprotocolToolAliasを推測しない", () => {
    expect(() => createSingleColorPrintPlan({
      deviceId: "serial:k2pro",
      asset: createSampleAsset(),
      materialSourceId: "cfs:1:slot:2",
    })).toThrow("protocolToolAlias");
  });

  it("PrintPlanからcontract-only print-start command requestを生成する", () => {
    const plan = createSingleColorPrintPlan({
      deviceId: "serial:k2pro",
      asset: createSampleAsset(),
      protocolToolAlias: "T1A",
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
            toolId: 0,
            protocolToolAlias: "T1A",
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
      protocolToolAlias: "T1A",
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

  it("CFSマルチカラーPrintPlanは各toolのmaterialSourceを明示する", () => {
    const plan = createMulticolorCfsPrintPlan({
      deviceId: "serial:k2pro",
      asset: createSampleAsset("4color_benchy.gcode", [0, 1, 2, 3]),
      toolAssignments: [
        { toolId: 0, protocolToolAlias: "T1A", materialSourceId: "cfs:1:slot:3", protocol: { colorMatch: "T1A" } },
        { toolId: 1, protocolToolAlias: "T1B", materialSourceId: "cfs:1:slot:2", protocol: { colorMatch: "T1B" } },
        { toolId: 2, protocolToolAlias: "T1C", materialSourceId: "cfs:1:slot:1", protocol: { colorMatch: "T1C" } },
        { toolId: 3, protocolToolAlias: "T1D", materialSourceId: "cfs:1:slot:0", protocol: { colorMatch: "T1D" } },
      ],
      colorMatchPolicy: {
        mode: "explicit-tool-assignment",
        requireObservedSelectedSource: true,
        source: "operator-confirmed",
      },
    });

    expect(plan).toMatchObject({
      planKind: "multicolor-cfs",
      asset: {
        toolCount: 4,
      },
      materialSourceIds: [
        "cfs:1:slot:3",
        "cfs:1:slot:2",
        "cfs:1:slot:1",
        "cfs:1:slot:0",
      ],
      colorMatchPolicy: {
        mode: "explicit-tool-assignment",
        requireObservedSelectedSource: true,
        source: "operator-confirmed",
      },
      authority: {
        mode: "plan-only",
        canStartPrint: false,
      },
    });
    expect(plan.toolAssignments.map((assignment) => [
      assignment.toolId,
      assignment.protocolToolAlias,
      assignment.materialSourceId,
      assignment.order,
    ])).toEqual([
      [0, "T1A", "cfs:1:slot:3", 0],
      [1, "T1B", "cfs:1:slot:2", 1],
      [2, "T1C", "cfs:1:slot:1", 2],
      [3, "T1D", "cfs:1:slot:0", 3],
    ]);
    expect(validatePrintPlan(plan)).toEqual({ ok: true, errors: [] });
  });

  it("CFSマルチカラーPrintPlanは未割当toolと重複toolを拒否する", () => {
    expect(() => createMulticolorCfsPrintPlan({
      deviceId: "serial:k2pro",
      asset: createSampleAsset(),
      toolAssignments: [
        { toolId: 0, protocolToolAlias: "T1A", materialSourceId: "cfs:1:slot:0" },
        { toolId: 1, protocolToolAlias: "T1B", materialSourceId: "" },
      ],
    })).toThrow("materialSourceId");
    expect(() => createMulticolorCfsPrintPlan({
      deviceId: "serial:k2pro",
      asset: createSampleAsset(),
      toolAssignments: [
        { toolId: 0, protocolToolAlias: "T1A", materialSourceId: "cfs:1:slot:0" },
        { toolId: 0, protocolToolAlias: "T1B", materialSourceId: "cfs:1:slot:1" },
      ],
    })).toThrow("duplicate-tool-id");
    expect(() => createMulticolorCfsPrintPlan({
      deviceId: "serial:k2pro",
      asset: {
        ...createSampleAsset("benchy.gcode", [0, 1, 2, 3]),
      },
      toolAssignments: [
        { toolId: 0, protocolToolAlias: "T1A", materialSourceId: "cfs:1:slot:0" },
        { toolId: 1, protocolToolAlias: "T1B", materialSourceId: "cfs:1:slot:1" },
      ],
    })).toThrow("asset-tool-count-assignment-mismatch");
    expect(() => createMulticolorCfsPrintPlan({
      deviceId: "serial:k2pro",
      asset: {
        ...createSampleAsset("benchy.gcode", [0, 1]),
      },
      toolAssignments: [
        { toolId: 0, protocolToolAlias: "T1A", materialSourceId: "cfs:1:slot:0" },
        { toolId: 1, materialSourceId: "cfs:1:slot:1" },
      ],
    })).toThrow("protocolToolAlias");
    expect(() => createMulticolorCfsPrintPlan({
      deviceId: "serial:k2pro",
      asset: {
        ...createSampleAsset("benchy.gcode", [0, 1]),
      },
      toolAssignments: [
        { toolId: false, protocolToolAlias: "T1A", materialSourceId: "cfs:1:slot:0" },
        { toolId: 1, protocolToolAlias: "T1B", materialSourceId: "cfs:1:slot:1" },
      ],
    })).toThrow("toolId");
    expect(() => createMulticolorCfsPrintPlan({
      deviceId: "serial:k2pro",
      asset: {
        ...createSampleAsset("benchy.gcode", [0, 0]),
      },
      toolAssignments: [
        { toolId: 0, protocolToolAlias: "T1A", materialSourceId: "cfs:1:slot:0" },
        { toolId: 1, protocolToolAlias: "T1B", materialSourceId: "cfs:1:slot:1" },
      ],
    })).toThrow("logical tools");
  });

  it("CFSマルチカラーPrintPlan由来のcommandもcontract-onlyで送信しない", () => {
    const plan = createMulticolorCfsPrintPlan({
      deviceId: "serial:k2pro",
      asset: createSampleAsset("4color_benchy.gcode", [0, 1]),
      toolAssignments: [
        { toolId: 0, protocolToolAlias: "T1A", materialSourceId: "cfs:1:slot:3" },
        { toolId: 1, protocolToolAlias: "T1B", materialSourceId: "cfs:1:slot:2" },
      ],
    });
    const request = createPrintStartCommandRequestFromPlan(plan, {
      sessionId: "session:multi",
      transportKind: "ws9999",
      entropySource: () => "unit",
    });
    const result = createPrinterCommandResult(request, { status: "timeout" });

    expect(request).toMatchObject({
      commandKind: "print-start",
      sideEffect: true,
      idempotent: false,
      expectedStateRequired: true,
      authority: {
        mode: "contract-only",
        canSend: false,
        canBlindRetry: false,
      },
      payload: {
        planKind: "multicolor-cfs",
        multiColorPrint: true,
        materialSourceIds: ["cfs:1:slot:3", "cfs:1:slot:2"],
      },
    });
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
        "missing-gcode-analysis",
        "material-source-assignment-mismatch",
        "plan-can-start-print",
      ],
    });
    expect(validatePrintPlan({
      schemaVersion: 1,
      printPlanId: "plan:bad-tool",
      planKind: "single-color",
      deviceId: "serial:k2pro",
      asset: {
        path: "/mnt/UDISK/printer_data/gcodes/benchy.gcode",
        toolCount: 1,
        logicalTools: [0, 0],
        analysis: {
          analyzed: true,
          analyzerVersion: "unit-gcode-analyzer",
          fileHash: "sha256:bad-tool",
          logicalTools: [0, 0],
          provenance: {
            source: "printer-core-gcode-analyzer",
            analysisId: "manual-duplicate",
            attestation: "manual-duplicate",
          },
        },
      },
      toolAssignments: [
        { toolId: false, protocolToolAlias: "", materialSourceId: "cfs:1:slot:0" },
      ],
      materialSourceIds: ["cfs:1:slot:0"],
      authority: {
        canStartPrint: false,
      },
    }).errors).toEqual(expect.arrayContaining([
      "missing-tool-id",
      "missing-protocol-tool-alias",
      "duplicate-asset-logical-tool",
    ]));
  });

  it("解析済みlogical toolが無いG-code assetはPrintPlanに昇格しない", () => {
    expect(() => createSingleColorPrintPlan({
      deviceId: "serial:k2pro",
      asset: {
        path: "/mnt/UDISK/printer_data/gcodes/unknown.gcode",
        fileName: "unknown.gcode",
        toolCount: 1,
      },
      protocolToolAlias: "T1A",
      materialSourceId: "cfs:1:slot:2",
    })).toThrow("analyzed G-code logical tools");

    expect(() => createSingleColorPrintPlan({
      deviceId: "serial:k2pro",
      asset: createSampleAsset("4color_benchy.gcode", [0, 1, 2, 3]),
      protocolToolAlias: "T1A",
      materialSourceId: "cfs:1:slot:2",
    })).toThrow("missing-gcode-tool-assignment");
  });

  it("caller-declaredなanalysis provenanceではPrintPlanに昇格しない", () => {
    expect(() => createSingleColorPrintPlan({
      deviceId: "serial:k2pro",
      asset: {
        path: "/mnt/UDISK/printer_data/gcodes/fake.gcode",
        fileName: "fake.gcode",
        analysis: {
          analyzed: true,
          analyzerVersion: "caller",
          fileHash: "sha256:fake",
          logicalTools: [0],
          provenance: {
            source: "printer-core-gcode-analyzer",
            analysisId: "caller-analysis",
            attestation: "caller-attestation",
          },
        },
      },
      protocolToolAlias: "T1A",
      materialSourceId: "cfs:1:slot:2",
    })).toThrow("attested G-code analysis provenance");
  });

  it("callerが弱いcolorMatchPolicyを渡しても安全条件は維持される", () => {
    const plan = createMulticolorCfsPrintPlan({
      deviceId: "serial:k2pro",
      asset: createSampleAsset("4color_benchy.gcode", [0, 1]),
      toolAssignments: [
        { toolId: 0, protocolToolAlias: "T1A", materialSourceId: "cfs:1:slot:0" },
        { toolId: 1, protocolToolAlias: "T1B", materialSourceId: "cfs:1:slot:1" },
      ],
      colorMatchPolicy: {
        mode: "best-effort",
        requireObservedSelectedSource: false,
        source: "unsafe-caller",
      },
    });

    expect(plan.colorMatchPolicy).toEqual({
      mode: "explicit-tool-assignment",
      requireObservedSelectedSource: true,
      source: "unsafe-caller",
    });
    expect(validatePrintPlan({
      ...plan,
      colorMatchPolicy: {
        mode: "best-effort",
        requireObservedSelectedSource: false,
      },
    }).errors).toEqual(expect.arrayContaining([
      "unsafe-color-match-policy",
      "missing-observed-selected-source-policy",
    ]));
  });
});
