/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 MaterialSource accounting export analyzer 単体テスト
 * @file analyze_material_accounting_export.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module analyze_material_accounting_export_test
 *
 * 【機能内容サマリ】
 * - 3DPmon export JSONをread-onlyで解析し、K2/CFSのsource別mount不足を診断することを検証
 * - JobMaterialSegmentがある場合にsource別usage evidenceとしてsummaryへ出ることを検証
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1620 (PR #440)
 * @since   1.390.1620 (PR #440)
 * @lastModified 2026-09-02 01:58:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeMaterialAccountingExport,
  parseArgs,
  runMaterialAccountingExportAnalyzer,
} from "../../scripts/analyze_material_accounting_export.mjs";

/**
 * K2/CFSを含む最小export payloadを生成する。
 *
 * 【詳細説明】
 * - K2に外部1 + CFS 1A/1Bを観測させ、legacy hostSpoolMapだけが1本残る状態を作る。
 *
 * @function createExportPayload
 * @param {Object=} options - 生成オプション。
 * @param {boolean=} options.includeMountStore - Universal SpoolMount storeを含める場合true。
 * @param {boolean=} options.includeSegments - JobMaterialSegmentを含める場合true。
 * @returns {Object} export JSON payload。
 */
function createExportPayload(options = {}) {
  const mountStore = options.includeMountStore
    ? {
        spoolMounts: [
          {
            mountId: "mount:1a",
            materialSourceId: "source:k2:cfs:1a",
            spoolId: "spool:a",
            status: "open",
            openedAt: "2026-09-01T07:30:00.000Z",
            verification: "operator-confirmed",
          },
          {
            mountId: "mount:1b",
            materialSourceId: "source:k2:cfs:1b",
            spoolId: "spool:b",
            status: "open",
            openedAt: "2026-09-01T07:31:00.000Z",
            verification: "operator-confirmed",
          },
        ],
      }
    : undefined;
  const printBindingStore = {
    printStartSnapshots: options.includeSegments ? [{ snapshotId: "snap:1" }] : [],
    jobMaterialSegments: options.includeSegments
      ? [
          {
            segmentId: "seg:t1a",
            deviceId: "serial:k2",
            printJobId: "job:1",
            spoolId: "spool:a",
            mountId: "mount:1a",
            materialSourceId: "source:k2:cfs:1a",
            protocolToolAlias: "T1A",
            usedLengthMm: 3210,
            usageState: "observed-used",
            confidence: "high",
            order: 0,
          },
          {
            segmentId: "seg:t1b",
            deviceId: "serial:k2",
            printJobId: "job:1",
            spoolId: "spool:b",
            mountId: "mount:1b",
            materialSourceId: "source:k2:cfs:1b",
            protocolToolAlias: "T1B",
            usedLengthMm: 6543,
            usageState: "observed-used",
            confidence: "high",
            order: 1,
          },
        ]
      : [],
    unattributedUsage: [],
  };
  return {
    appSettings: {
      connectionTargets: [
        {
          dest: "192.168.54.153:9999",
          hostname: "K2Pro-69E7",
          printerType: "creality-k2",
          printerCoreV3Identity: {
            deviceIdSeed: "serial:k2",
            reportedModel: "F012",
          },
        },
      ],
    },
    machines: {
      "K2Pro-69E7": {
        storedData: { model: { rawValue: "F012" } },
        printStore: { history: [] },
      },
    },
    hostSpoolMap: {
      "K2Pro-69E7": "legacy:spool",
    },
    filamentSpools: {
      "spool:a": { id: "spool:a" },
      "spool:b": { id: "spool:b" },
    },
    materialSourceObservations: {
      byDeviceId: {
        "serial:k2": {
          lastObservedAt: "2026-09-01T08:00:00.000Z",
          eventCoverageStartedAt: "2026-09-01T07:00:00.000Z",
          latestBySourceId: {
            "external:0:slot:0": {
              sourceId: "external:0:slot:0",
              kind: "external-spool",
              displayLabel: "external",
              presence: "empty",
              selected: false,
              lastObservedAt: "2026-09-01T08:00:00.000Z",
            },
            "source:k2:cfs:1a": {
              sourceId: "source:k2:cfs:1a",
              kind: "cfs-slot",
              displayLabel: "1A",
              presence: "loaded",
              selected: true,
              remaining: { normalizedPercent: 70, valid: true },
              material: { type: "PLA", name: "Generic PLA", color: { cssColor: "#f4e076" } },
              lastObservedAt: "2026-09-01T08:00:00.000Z",
            },
            "source:k2:cfs:1b": {
              sourceId: "source:k2:cfs:1b",
              kind: "cfs-slot",
              displayLabel: "1B",
              presence: "loaded",
              selected: false,
              remaining: { rawPercent: 88, valid: true },
              material: { type: "PLA", name: "Generic PLA", color: { cssColor: "#ffa800" } },
              lastObservedAt: "2026-09-01T08:00:00.000Z",
            },
          },
        },
      },
    },
    materialAccountingPrintBindingStore: printBindingStore,
    ...(mountStore ? { materialAccountingSpoolMountStore: mountStore } : {}),
  };
}

describe("analyze_material_accounting_export", () => {
  it("K2/CFSでlegacy 1本割当だけがある場合はsource別mount不足として診断する", () => {
    const report = analyzeMaterialAccountingExport(createExportPayload());
    const device = report.devices[0];

    expect(report.stores).toMatchObject({
      spoolMountStorePresent: false,
      openSpoolMountCount: 0,
      jobMaterialSegmentCount: 0,
    });
    expect(device.sourceCounts).toMatchObject({
      total: 3,
      cfs: 2,
      loaded: 2,
      managedMounted: 0,
      loadedWithoutManagedMount: 2,
    });
    expect(device.multiSourceExpected).toBe(true);
    expect(device.legacyCompatibility).toEqual({
      hostSpoolMapSpoolId: "legacy:spool",
      isSourceAware: false,
    });
    expect(device.certificationReadiness).toMatchObject({
      canRunGate18_9IShadowAccounting: false,
      canProjectItemKeeperSourceUsage: false,
      managedRemainingDebitAllowed: false,
      reasons: [
        "loaded-source-managed-mount-missing",
        "legacy-single-spool-map-present-for-multi-source-device",
      ],
    });
    expect(report.warnings.map((warning) => warning.reason)).toContain("material-accounting-spool-mount-store-missing");
  });

  it("source別mountとJobMaterialSegmentがある場合はGate18.9I evidence presentとしてsummary化する", () => {
    const report = analyzeMaterialAccountingExport(createExportPayload({
      includeMountStore: true,
      includeSegments: true,
    }));
    const device = report.devices[0];

    expect(report.stores).toMatchObject({
      spoolMountStorePresent: true,
      openSpoolMountCount: 2,
      printStartSnapshotCount: 1,
      jobMaterialSegmentCount: 2,
    });
    expect(report.gate18_9I).toMatchObject({
      status: "evidence-present",
      canDebitManagedRemaining: false,
      canUsePhysicalCfsSend: false,
    });
    expect(device.certificationReadiness).toMatchObject({
      canRunGate18_9IShadowAccounting: true,
      canProjectItemKeeperSourceUsage: true,
      managedRemainingDebitAllowed: false,
      reasons: [],
    });
    expect(device.printBinding).toMatchObject({
      printStartSnapshotCount: 1,
      jobMaterialSegmentCount: 2,
    });
    expect(device.sources.map((source) => [
      source.displayLabel,
      source.managedMountCount,
      source.sourceSpecificUsageCount,
      source.sourceSpecificUsedLengthMm,
      source.deviceReportedRemainingPercent,
    ])).toEqual([
      ["1A", 1, 1, 3210, 70],
      ["1B", 1, 1, 6543, 88],
      ["external", 0, 0, 0, null],
    ]);
  });

  it("certification panel exportを添付してread-only preflight状態を同じreportへ入れる", () => {
    const report = analyzeMaterialAccountingExport(createExportPayload(), {
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          generatedAt: "2026-09-01T02:00:47.786Z",
          printer: { model: "F012" },
          sourceId: "cfs:1:slot:0",
          displaySlot: "1A",
          commandKind: "cfs-load",
          dryRunStatus: "ok",
          liveSendEnabled: false,
        },
        summary: {
          material: {
            targetSource: { presence: "loaded", selected: false },
            summary: { loadedSourceCount: 2, selectedSourceCount: 0 },
          },
        },
        preflight: [
          { key: "target-loaded", state: "ok", detail: "1A loaded" },
          { key: "certification-status", state: "fail", detail: "未認証" },
        ],
      },
    });

    expect(report.certification).toMatchObject({
      panel: "cfs-debug-certification",
      printerModel: "F012",
      sourceId: "cfs:1:slot:0",
      displaySlot: "1A",
      commandKind: "cfs-load",
      dryRunStatus: "ok",
      liveSendEnabled: false,
      targetPresence: "loaded",
      targetSelected: false,
      loadedSourceCount: 2,
      selectedSourceCount: 0,
      preflight: [
        { key: "target-loaded", state: "ok", detail: "1A loaded" },
        { key: "certification-status", state: "fail", detail: "未認証" },
      ],
    });
  });

  it("legacy K1はMaterialSource未観測でもGate18.9I warning扱いにしない", () => {
    const report = analyzeMaterialAccountingExport({
      appSettings: {
        connectionTargets: [
          {
            dest: "192.168.54.151:9999",
            hostname: "K1Max-4A1B",
            printerCoreV3Identity: {
              deviceIdSeed: "provisional:k1-max:192.168.54.151",
              reportedModel: "K1 Max",
            },
          },
        ],
      },
      machines: {
        "K1Max-4A1B": {
          storedData: { model: { rawValue: "K1 Max" } },
          printStore: { history: [] },
        },
      },
      hostSpoolMap: {
        "K1Max-4A1B": "legacy:spool",
      },
    });

    expect(report.devices[0]).toMatchObject({
      hostname: "K1Max-4A1B",
      multiSourceExpected: false,
      certificationReadiness: {
        reasons: [],
      },
    });
    expect(report.warnings).toEqual([]);
  });

  it("CLIからexport/certificationを読み、outputにもreportを書き出す", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "3dpmon-material-export-analyzer-"));
    const exportPath = path.join(tempDir, "export.json");
    const certificationPath = path.join(tempDir, "certification.json");
    const outputPath = path.join(tempDir, "report.json");
    try {
      await writeFile(exportPath, JSON.stringify(createExportPayload({ includeMountStore: true })), "utf8");
      await writeFile(certificationPath, JSON.stringify({ manifest: { panel: "cfs-debug-certification" } }), "utf8");

      const report = await runMaterialAccountingExportAnalyzer(parseArgs([
        "--export",
        exportPath,
        "--certification",
        certificationPath,
        "--output",
        outputPath,
      ]));
      const saved = JSON.parse(await readFile(outputPath, "utf8"));

      expect(report.devices[0].hostname).toBe("K2Pro-69E7");
      expect(saved.devices[0].hostname).toBe("K2Pro-69E7");
      expect(saved.certification.panel).toBe("cfs-debug-certification");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
