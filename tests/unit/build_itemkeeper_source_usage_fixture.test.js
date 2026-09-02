/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 ItemKeeper source usage fixture builder 単体テスト
 * @file build_itemkeeper_source_usage_fixture.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module build_itemkeeper_source_usage_fixture_test
 *
 * 【機能内容サマリ】
 * - Gate 18.9J-2 capture前のread-only fixture builderがexportからJ-1 receiptを生成することを検証
 * - 生成artifactがproduction issuerやregistryを開かないことを検証
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1643 (PR #440)
 * @since   1.390.1639 (PR #440)
 * @lastModified 2026-09-02 15:11:47
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildItemKeeperSourceUsageFixture,
  parseArgs,
  runItemKeeperSourceUsageFixtureBuilder,
} from "../../scripts/build_itemkeeper_source_usage_fixture.mjs";

/**
 * builder test用の共通CLI optionsを生成する。
 *
 * @function createOptions
 * @param {Object=} overrides - 上書き値。
 * @returns {Object} CLI options互換object。
 */
function createOptions(overrides = {}) {
  return {
    exportPath: "",
    certificationPath: "",
    deviceId: "serial:k2-pro-69e7",
    printJobId: "job:k2-source-aware-001",
    reviewedCommit: "0123456789abcdef0123456789abcdef01234567",
    operatorActionId: "operator:j2-capture-001",
    outputDir: "",
    hostname: "K2Pro-69E7",
    model: "",
    firmwareVersion: "",
    printerType: "creality-k2",
    fixtureId: "",
    captureId: "",
    capturedAt: "2026-09-02T01:30:00.000Z",
    pretty: false,
    help: false,
    ...overrides,
  };
}

/**
 * builder test用のexport payloadを生成する。
 *
 * @function createExportPayload
 * @returns {Object} 3DPmon export互換payload。
 */
function createExportPayload() {
  return {
    appSettings: {
      connectionTargets: [
        {
          hostname: "K2Pro-69E7",
          printerType: "creality-k2",
          printerCoreV3Identity: {
            deviceIdSeed: "serial:k2-pro-69e7",
            reportedModel: "F012",
          },
        },
      ],
    },
    machines: {
      "K2Pro-69E7": {
        storedData: {
          model: { rawValue: "F012" },
          firmwareVersion: { rawValue: "1.1.6.7" },
        },
        printStore: {
          history: [
            {
              printJobId: "job:k2-source-aware-001",
              printPlanId: "plan:k2-source-aware-001",
              materialUsed: "3210,0",
              historyObservedReceivedAt: "2026-09-02T01:25:00.000Z",
            },
          ],
        },
      },
    },
    materialAccountingPrintBindingStore: {
      printStartSnapshots: [
        {
          snapshotId: "snap:1a",
          deviceId: "serial:k2-pro-69e7",
          printJobId: "job:k2-source-aware-001",
          printPlanId: "plan:k2-source-aware-001",
          materialSourceId: "source:k2:1a",
          mountId: "mount:1a",
          spoolId: "spool:a",
          bindingAuthorityDigest: "fnv1a128:snap-digest-1a",
          bindingAuthority: {
            tool: { toolId: 0, protocolToolAlias: "T1A", order: 0 },
            source: {
              materialSourceId: "source:k2:1a",
              locator: { unitIndex: 1, slotIndex: 0, protocolSlotId: 0 },
            },
            mount: { mountId: "mount:1a", spoolId: "spool:a" },
          },
        },
        {
          snapshotId: "snap:1b",
          deviceId: "serial:k2-pro-69e7",
          printJobId: "job:k2-source-aware-001",
          printPlanId: "plan:k2-source-aware-001",
          materialSourceId: "source:k2:1b",
          mountId: "mount:1b",
          spoolId: "spool:b",
          bindingAuthorityDigest: "fnv1a128:snap-digest-1b",
          bindingAuthority: {
            tool: { toolId: 1, protocolToolAlias: "T1B", order: 1 },
            source: {
              materialSourceId: "source:k2:1b",
              locator: { unitIndex: 1, slotIndex: 1, protocolSlotId: 1 },
            },
            mount: { mountId: "mount:1b", spoolId: "spool:b" },
          },
        },
      ],
      jobMaterialSegments: [
        {
          segmentId: "seg:1a",
          deviceId: "serial:k2-pro-69e7",
          printJobId: "job:k2-source-aware-001",
          printPlanId: "plan:k2-source-aware-001",
          toolId: 0,
          protocolToolAlias: "T1A",
          order: 0,
          materialSourceId: "source:k2:1a",
          mountId: "mount:1a",
          spoolId: "spool:a",
          usedLengthMm: 3210,
          usageState: "observed-used",
          confidence: "high",
          debit: { status: "eligible", canDebit: true, reasons: [] },
        },
        {
          segmentId: "seg:1b",
          deviceId: "serial:k2-pro-69e7",
          printJobId: "job:k2-source-aware-001",
          printPlanId: "plan:k2-source-aware-001",
          toolId: 1,
          protocolToolAlias: "T1B",
          order: 1,
          materialSourceId: "source:k2:1b",
          mountId: "mount:1b",
          spoolId: "spool:b",
          usedLengthMm: 0,
          usageState: "confirmed-unused",
          confidence: "high",
          debit: { status: "eligible", canDebit: false, reasons: [] },
        },
      ],
    },
  };
}

describe("build_itemkeeper_source_usage_fixture", () => {
  it("post-exportからfixture evidence/receipt/projection digestをread-only生成する", () => {
    const result = buildItemKeeperSourceUsageFixture({
      exportPayload: createExportPayload(),
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          generatedAt: "2026-09-02T01:29:00.000Z",
          printer: {
            model: "F012",
            firmwareVersion: "1.1.6.7",
          },
        },
      },
      options: createOptions(),
      inputHashes: {
        export: { path: "post-export.json", sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        certification: { path: "certification.json", sha256: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      },
    });

    expect(result.status).toBe("fixture-accepted");
    expect(result.fixtureReceipt).toMatchObject({
      ok: true,
      status: "fixture-accepted",
      capability: {
        canRegisterProjection: false,
        canProjectItemKeeper: false,
      },
      rawMaterialUsed: "3210,0",
      parsedUsedLengthMm: [3210, 0],
    });
    expect(result.fixtureEvidence).toMatchObject({
      reviewedCommit: "0123456789abcdef0123456789abcdef01234567",
      parser: {
        parserVersion: "k2-material-used-csv:v1",
        sourceOrderingProfile: "print-start-binding-authority-order:v1",
      },
      device: {
        deviceId: "serial:k2-pro-69e7",
        printerType: "creality-k2",
        model: "F012",
        firmwareVersion: "1.1.6.7",
      },
      print: {
        printJobId: "job:k2-source-aware-001",
        printPlanId: "plan:k2-source-aware-001",
      },
    });
    expect(result.fixtureEvidence.expectedSourceOrder.map((entry) => [
      entry.order,
      entry.protocolToolAlias,
      entry.materialSourceId,
      entry.mountId,
      entry.spoolId,
      entry.usedLengthMm,
      entry.usageState,
    ])).toEqual([
      [0, "T1A", "source:k2:1a", "mount:1a", "spool:a", 3210, "observed-used"],
      [1, "T1B", "source:k2:1b", "mount:1b", "spool:b", 0, "confirmed-unused"],
    ]);
    expect(result.projectionDigests).toHaveLength(2);
    expect(result.projectionDigests[0].projectionDigest).toMatch(/^fnv1a128:/u);
  });

  it("certification sessionがあるfixtureは対象jobのsession provenanceをevidenceへ明示する", () => {
    const payload = createExportPayload();
    for (const snapshot of payload.materialAccountingPrintBindingStore.printStartSnapshots) {
      snapshot.issuanceEvidence = { sessionId: "session:k2-a" };
    }
    const result = buildItemKeeperSourceUsageFixture({
      exportPayload: payload,
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          generatedAt: "2026-09-02T01:29:00.000Z",
          printer: {
            model: "F012",
            firmwareVersion: "1.1.6.7",
            sessionId: "session:k2-a",
          },
        },
      },
      options: createOptions(),
      inputHashes: {},
    });

    expect(result.status).toBe("fixture-accepted");
    expect(result.fixtureEvidence.print).toMatchObject({
      printJobId: "job:k2-source-aware-001",
      printPlanId: "plan:k2-source-aware-001",
      sessionId: "session:k2-a",
    });
    expect(result.fixtureEvidence.print.sessionIds).toEqual(["session:k2-a"]);
    expect(result.captureBundle.print.sessionId).toBe("session:k2-a");
    expect(result.reviewBlockers).toEqual([]);
  });

  it("certification sessionがあるfixtureは対象jobのsession provenance欠落をreview不可にする", () => {
    const result = buildItemKeeperSourceUsageFixture({
      exportPayload: createExportPayload(),
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          printer: {
            model: "F012",
            firmwareVersion: "1.1.6.7",
            sessionId: "session:k2-a",
          },
        },
      },
      options: createOptions(),
      inputHashes: {},
    });

    expect(result.status).toBe("fixture-review-not-ready");
    expect(result.fixtureEvidence.print.sessionIds).toEqual([]);
    expect(result.reviewBlockers).toContain("certification-session-id-missing");
  });

  it("certification sessionがあるfixtureは対象jobのmixed session provenanceをreview不可にする", () => {
    const payload = createExportPayload();
    payload.materialAccountingPrintBindingStore.printStartSnapshots[0].issuanceEvidence = { sessionId: "session:k2-a" };
    payload.materialAccountingPrintBindingStore.printStartSnapshots[1].issuanceEvidence = { sessionId: "session:old" };

    const result = buildItemKeeperSourceUsageFixture({
      exportPayload: payload,
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          printer: {
            model: "F012",
            firmwareVersion: "1.1.6.7",
            sessionId: "session:k2-a",
          },
        },
      },
      options: createOptions(),
      inputHashes: {},
    });

    expect(result.status).toBe("fixture-review-not-ready");
    expect(result.fixtureEvidence.print.sessionIds).toEqual(["session:k2-a", "session:old"]);
    expect(result.reviewBlockers).toContain("candidate-session-id-ambiguous");
  });

  it("CLIからartifact一式を書き出す", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "3dpmon-j2-fixture-builder-"));
    const exportPath = path.join(tempDir, "post-export.json");
    const certificationPath = path.join(tempDir, "certification.json");
    const outputDir = path.join(tempDir, "fixture");
    try {
      await writeFile(exportPath, JSON.stringify(createExportPayload()), "utf8");
      await writeFile(certificationPath, JSON.stringify({
        manifest: {
          panel: "cfs-debug-certification",
          printer: { model: "F012", firmwareVersion: "1.1.6.7" },
        },
      }), "utf8");

      const summary = await runItemKeeperSourceUsageFixtureBuilder(parseArgs([
        "--export",
        exportPath,
        "--certification",
        certificationPath,
        "--device-id",
        "serial:k2-pro-69e7",
        "--print-job-id",
        "job:k2-source-aware-001",
        "--reviewed-commit",
        "0123456789abcdef0123456789abcdef01234567",
        "--operator-action-id",
        "operator:j2-capture-001",
        "--output-dir",
        outputDir,
      ]));
      const evidence = JSON.parse(await readFile(path.join(outputDir, "fixture-evidence.json"), "utf8"));
      const receipt = JSON.parse(await readFile(path.join(outputDir, "fixture-receipt.json"), "utf8"));
      const manifest = JSON.parse(await readFile(path.join(outputDir, "capture-manifest.json"), "utf8"));

      expect(summary).toMatchObject({
        status: "fixture-accepted",
        fixtureAccepted: true,
      });
      expect(evidence.artifact.captureSha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(receipt.status).toBe("fixture-accepted");
      expect(manifest.generatedArtifacts.fixtureEvidence.sha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(manifest.errors).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("target deviceのmachine履歴だけからraw materialUsedを採用する", () => {
    const payload = createExportPayload();
    payload.appSettings.connectionTargets.unshift({
      hostname: "K2Pro-Other",
      printerType: "creality-k2",
      printerCoreV3Identity: {
        deviceIdSeed: "serial:k2-other",
        reportedModel: "F012",
      },
    });
    payload.machines = {
      "K2Pro-Other": {
        storedData: {
          model: { rawValue: "F012" },
          firmwareVersion: { rawValue: "1.1.6.7" },
        },
        printStore: {
          history: [
            {
              printJobId: "job:k2-source-aware-001",
              printPlanId: "plan:k2-source-aware-001",
              materialUsed: "999,999",
            },
          ],
        },
      },
      ...payload.machines,
    };

    const result = buildItemKeeperSourceUsageFixture({
      exportPayload: payload,
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          printer: { model: "F012", firmwareVersion: "1.1.6.7" },
        },
      },
      options: createOptions(),
      inputHashes: {},
    });

    expect(result.status).toBe("fixture-accepted");
    expect(result.captureBundle.rawMaterialUsed).toBe("3210,0");
    expect(result.fixtureReceipt.parsedUsedLengthMm).toEqual([3210, 0]);
  });

  it("certification identityがexport targetと矛盾する場合はreview不可として扱う", () => {
    const result = buildItemKeeperSourceUsageFixture({
      exportPayload: createExportPayload(),
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          printer: {
            deviceId: "serial:k2-pro-69e7",
            model: "K2 Plus",
            firmwareVersion: "9.9.9.9",
          },
        },
      },
      options: createOptions({ model: "", firmwareVersion: "" }),
      inputHashes: {},
    });

    expect(result.status).toBe("fixture-review-not-ready");
    expect(result.reviewBlockers).toEqual([
      "certification-model-mismatch",
      "certification-firmware-version-mismatch",
    ]);
    expect(result.fixtureReceipt.ok).toBe(true);
    expect(result.fixtureEvidence.device).toMatchObject({
      deviceId: "serial:k2-pro-69e7",
      model: "F012",
      firmwareVersion: "1.1.6.7",
    });
  });

  it("必須引数とfull SHAをfail-fastで検査する", () => {
    expect(() => parseArgs(["--export", "post-export.json"])).toThrow("--device-id is required");
    expect(() => parseArgs([
      "--export",
      "post-export.json",
      "--device-id",
      "serial:k2",
      "--print-job-id",
      "job:1",
      "--reviewed-commit",
      "short",
      "--operator-action-id",
      "operator:1",
      "--output-dir",
      "out",
    ])).toThrow("--reviewed-commit must be a full 40-character SHA");
  });
});
