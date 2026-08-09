/**
 * @fileoverview Printer Core v3 PrintPlan の単体テスト
 * @description
 * - Gate 15 で単色印刷も PrintPlan を通し、material source と command contract を明示することを検証する。
 *
 * @version 1.390.1357 (PR #432)
 * @since 1.390.1343 (PR #432)
 * @lastModified 2026-08-09 13:32:08
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createMulticolorCfsPrintPlan,
  createPrintStartCommandRequestFromPlan,
  createSingleColorPrintPlan,
  validatePrintPlan,
  validatePrintPlanForStart,
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
 * @param {object=} uploadContext - upload receipt context
 * @param {string=} uploadContext.sessionId - upload session ID
 * @param {string=} uploadContext.uploadGeneration - upload generation
 * @returns {object} テスト用 G-code asset
 */
function createSampleAsset(fileName = "benchy.gcode", logicalTools = [0], uploadContext = {}) {
  const content = logicalTools.map((toolId) => `T${toolId}\nG1 X${toolId}`).join("\n");
  const path = `/mnt/UDISK/printer_data/gcodes/${fileName}`;
  const fileHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  return {
    path,
    fileName,
    fileMd5: "md5-demo",
    content,
    analyzerVersion: "unit-gcode-analyzer",
    uploadReceipt: {
      receiptId: `upload:${fileName}`,
      deviceId: "serial:k2pro",
      remotePath: path,
      fileHash,
      sessionId: uploadContext.sessionId,
      uploadGeneration: uploadContext.uploadGeneration,
    },
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
          fileHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
          logicalTools: [0],
        },
        toolCount: 1,
        uploadReceipt: {
          trusted: false,
          provenance: {
            source: "caller-declared",
            attestation: null,
          },
        },
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
        uploadReceiptTrusted: false,
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

  it("trusted upload receiptが無いPrintPlanからprint-start command requestを生成しない", () => {
    const plan = createSingleColorPrintPlan({
      deviceId: "serial:k2pro",
      asset: createSampleAsset(),
      protocolToolAlias: "T1A",
      materialSourceId: "cfs:1:slot:2",
    });
    const commandOptions = {
      sessionId: "session:1",
      transportKind: "ws9999",
      entropySource: () => "unit",
    };

    expect(validatePrintPlanForStart(plan, commandOptions).errors).toEqual(expect.arrayContaining([
      "missing-start-upload-generation",
      "upload-receipt-session-missing",
      "upload-receipt-generation-missing",
      "untrusted-upload-receipt",
    ]));
    expect(() => createPrintStartCommandRequestFromPlan(plan, commandOptions))
      .toThrow("untrusted-upload-receipt");
  });

  it("trusted upload receiptが無いPrintPlanはtimeout/retry判定へ進まない", () => {
    const plan = createSingleColorPrintPlan({
      deviceId: "serial:k2pro",
      asset: createSampleAsset(),
      protocolToolAlias: "T1A",
      materialSourceId: "external:0:slot:0",
    });
    expect(() => createPrintStartCommandRequestFromPlan(plan, {
      sessionId: "session:1",
      uploadGeneration: "upload-generation:1",
      entropySource: () => "unit",
    })).toThrow("untrusted-upload-receipt");
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
        path: "/mnt/UDISK/printer_data/gcodes/benchy.gcode",
        fileName: "benchy.gcode",
        analysis: {
          analyzed: true,
          analyzerVersion: "unit-gcode-analyzer",
          fileHash: "sha256:duplicate",
          logicalTools: [0, 0],
          provenance: {
            source: "printer-core-gcode-analyzer",
            analysisId: "manual-duplicate",
            attestation: "manual-duplicate",
          },
        },
      },
      toolAssignments: [
        { toolId: 0, protocolToolAlias: "T1A", materialSourceId: "cfs:1:slot:0" },
        { toolId: 1, protocolToolAlias: "T1B", materialSourceId: "cfs:1:slot:1" },
      ],
    })).toThrow("derives G-code analysis from asset.content");
  });

  it("CFSマルチカラーPrintPlanもtrusted upload receipt無しではcommand化しない", () => {
    const plan = createMulticolorCfsPrintPlan({
      deviceId: "serial:k2pro",
      asset: createSampleAsset("4color_benchy.gcode", [0, 1]),
      toolAssignments: [
        { toolId: 0, protocolToolAlias: "T1A", materialSourceId: "cfs:1:slot:3" },
        { toolId: 1, protocolToolAlias: "T1B", materialSourceId: "cfs:1:slot:2" },
      ],
    });
    expect(() => createPrintStartCommandRequestFromPlan(plan, {
      sessionId: "session:multi",
      uploadGeneration: "upload-generation:1",
      transportKind: "ws9999",
      entropySource: () => "unit",
    })).toThrow("untrusted-upload-receipt");
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
        "missing-upload-receipt",
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
    })).toThrow("asset.content");

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
    })).toThrow("derives G-code analysis from asset.content");
  });

  it("caller supplied assetIdでcontent hash bindingを迂回できない", () => {
    expect(() => createSingleColorPrintPlan({
      deviceId: "serial:k2pro",
      asset: {
        ...createSampleAsset("benchy.gcode"),
        assetId: "old-asset-id",
      },
      protocolToolAlias: "T1A",
      materialSourceId: "cfs:1:slot:2",
    })).toThrow("assetId must match analyzed content hash");
  });

  it("upload receiptがcontent hashやremote pathと一致しないassetは拒否する", () => {
    expect(() => createSingleColorPrintPlan({
      deviceId: "serial:k2pro",
      asset: {
        ...createSampleAsset("benchy.gcode"),
        uploadReceipt: {
          receiptId: "upload:bad-hash",
          deviceId: "serial:k2pro",
          remotePath: "/mnt/UDISK/printer_data/gcodes/benchy.gcode",
          fileHash: "sha256:bad",
        },
      },
      protocolToolAlias: "T1A",
      materialSourceId: "cfs:1:slot:2",
    })).toThrow("upload receipt fileHash must match analyzed content hash");

    expect(() => createSingleColorPrintPlan({
      deviceId: "serial:k2pro",
      asset: {
        ...createSampleAsset("benchy.gcode"),
        uploadReceipt: {
          receiptId: "upload:bad-path",
          deviceId: "serial:k2pro",
          remotePath: "/mnt/UDISK/printer_data/gcodes/other.gcode",
          fileHash: createSampleAsset("benchy.gcode").uploadReceipt.fileHash,
        },
      },
      protocolToolAlias: "T1A",
      materialSourceId: "cfs:1:slot:2",
    })).toThrow("upload receipt remotePath must match asset.path");

    expect(() => createSingleColorPrintPlan({
      deviceId: "serial:k2pro",
      asset: {
        ...createSampleAsset("benchy.gcode"),
        uploadReceipt: {
          receiptId: "upload:missing-device",
          remotePath: "/mnt/UDISK/printer_data/gcodes/benchy.gcode",
          fileHash: createSampleAsset("benchy.gcode").uploadReceipt.fileHash,
        },
      },
      protocolToolAlias: "T1A",
      materialSourceId: "cfs:1:slot:2",
    })).toThrow("uploadReceipt.deviceId");
  });

  it("caller-declared upload receiptは整合していてもtrusted authorityにはならない", () => {
    const plan = createSingleColorPrintPlan({
      deviceId: "serial:k2pro",
      asset: createSampleAsset("benchy.gcode"),
      protocolToolAlias: "T1A",
      materialSourceId: "cfs:1:slot:2",
    });

    expect(plan.asset.uploadReceipt).toMatchObject({
      trusted: false,
      provenance: {
        source: "caller-declared",
        attestation: null,
      },
    });
    expect(plan.authority.uploadReceiptTrusted).toBe(false);
    expect(validatePrintPlan({
      ...plan,
      authority: {
        ...plan.authority,
        uploadReceiptTrusted: true,
      },
    }).errors).toEqual(expect.arrayContaining(["untrusted-upload-receipt"]));
  });

  it("print-start検証はupload receiptのactive sessionとgenerationを要求する", () => {
    const plan = createSingleColorPrintPlan({
      deviceId: "serial:k2pro",
      asset: createSampleAsset("benchy.gcode", [0], {
        sessionId: "session:upload-a",
        uploadGeneration: "generation:7",
      }),
      protocolToolAlias: "T1A",
      materialSourceId: "cfs:1:slot:2",
    });

    expect(validatePrintPlan(plan)).toEqual({ ok: true, errors: [] });
    expect(validatePrintPlanForStart(plan, {
      sessionId: "session:upload-a",
      uploadGeneration: "generation:7",
    }).errors).toEqual(expect.arrayContaining(["untrusted-upload-receipt"]));
    expect(validatePrintPlanForStart(plan, {
      sessionId: "session:other",
      uploadGeneration: "generation:7",
    }).errors).toEqual(expect.arrayContaining([
      "upload-receipt-session-mismatch",
      "untrusted-upload-receipt",
    ]));
    expect(validatePrintPlanForStart(plan, {
      sessionId: "session:upload-a",
      uploadGeneration: "generation:8",
    }).errors).toEqual(expect.arrayContaining([
      "upload-receipt-generation-mismatch",
      "untrusted-upload-receipt",
    ]));
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
