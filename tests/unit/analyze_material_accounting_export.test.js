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
 * @version 1.390.1653 (PR #440)
 * @since   1.390.1620 (PR #440)
 * @lastModified 2026-09-02 16:45:11
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
import {
  createPrinterCoreV3DeterministicId,
  stableStringifyPrinterCoreV3Value,
} from "../../3dp_lib/printer_core/dashboard_data_schema_v3.js";
import {
  createCfsDeviceCorrelationEvidence,
  createCfsSessionCorrelationEvidence,
} from "../../3dp_lib/printer_core/dashboard_cfs_session_correlation.js";
import {
  createCfsCertificationExportBundle,
  createCfsCertificationPanelViewModel,
} from "../../3dp_lib/printer_core/dashboard_cfs_certification_panel.js";

/**
 * ItemKeeper source-aware projectionのmodule-owned認証authority名。
 *
 * @constant {string}
 */
const ITEMKEEPER_SOURCE_USAGE_PROJECTION_AUTHORITY = "module-owned-live-certification-registry";

/**
 * analyzer fixture用のItemKeeper projection使用量をdigest向けに正規化する。
 *
 * @function normalizeItemKeeperProjectionUsedLengthForDigest
 * @param {*} value - JobMaterialSegment.usedLengthMm のraw値。
 * @returns {{kind:string,value?:number,raw?:string}} digestへ入れる正規化値。
 */
function normalizeItemKeeperProjectionUsedLengthForDigest(value) {
  if (value === undefined) {
    return Object.freeze({ kind: "missing" });
  }
  if (value === null) {
    return Object.freeze({ kind: "null" });
  }
  if (typeof value === "string" && value.trim() === "") {
    return Object.freeze({ kind: "empty-string" });
  }
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return Object.freeze({ kind: "invalid", raw: String(value) });
  }
  return Object.freeze({ kind: "finite", value: numericValue });
}

/**
 * analyzer fixture用のItemKeeper projection digestを生成する。
 *
 * @function createItemKeeperProjectionDigest
 * @param {Object} segment - JobMaterialSegment fixture。
 * @returns {string} projection digest。
 */
function createItemKeeperProjectionDigest(segment) {
  return `fnv1a128:${createPrinterCoreV3DeterministicId(
    "itemkeeper-source-usage-projection-certification",
    [stableStringifyPrinterCoreV3Value({
      segmentId: String(segment?.segmentId || "").trim(),
      printJobId: String(segment?.printJobId || segment?.jobId || segment?.printId || segment?.id || "").trim(),
      printPlanId: String(segment?.printPlanId || "").trim(),
      deviceId: String(segment?.deviceId || "").trim(),
      spoolId: String(segment?.spoolId || "").trim(),
      mountId: String(segment?.mountId || "").trim(),
      materialSourceId: String(segment?.materialSourceId || "").trim(),
      protocolToolAlias: String(segment?.protocolToolAlias || "").trim(),
      usedLengthMm: normalizeItemKeeperProjectionUsedLengthForDigest(segment?.usedLengthMm),
      usageState: String(segment?.usageState || "").trim(),
      confidence: String(segment?.confidence || "").trim(),
      order: Number.isFinite(Number(segment?.order)) ? Number(segment.order) : 0,
      debitStatus: String(segment?.debit?.status || "").trim(),
    })]
  )}`;
}

/**
 * analyzer fixture用JobMaterialSegmentへItemKeeper projection証跡を付与する。
 *
 * @function certifyItemKeeperProjectionSegment
 * @param {Object} segment - JobMaterialSegment fixture。
 * @returns {Object} 認証証跡つきsegment。
 */
function certifyItemKeeperProjectionSegment(segment) {
  const certified = { ...segment };
  certified.itemKeeperProjection = {
    status: "certified",
    authority: ITEMKEEPER_SOURCE_USAGE_PROJECTION_AUTHORITY,
    digest: createItemKeeperProjectionDigest(certified),
  };
  return certified;
}

it("analyzer fixtureのItemKeeper projection digestはnull/空文字と明示0mmを区別する", () => {
  const baseSegment = {
    segmentId: "seg:analyzer-zero-identity",
    printJobId: "job:zero",
    printPlanId: "plan:zero",
    deviceId: "serial:k2",
    spoolId: "spool:a",
    mountId: "mount:a",
    materialSourceId: "source:a",
    protocolToolAlias: "T1A",
    usageState: "confirmed-unused",
    confidence: "high",
    debit: { status: "eligible", canDebit: true, reasons: [] },
    order: 0,
  };
  const zeroDigest = createItemKeeperProjectionDigest({ ...baseSegment, usedLengthMm: 0 });
  const nullDigest = createItemKeeperProjectionDigest({ ...baseSegment, usedLengthMm: null });
  const emptyDigest = createItemKeeperProjectionDigest({ ...baseSegment, usedLengthMm: "" });

  expect(nullDigest).not.toBe(zeroDigest);
  expect(emptyDigest).not.toBe(zeroDigest);
});

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
            sourceBindingAtOpen: {
              deviceId: "serial:k2",
              materialSourceId: "source:k2:cfs:1a",
              sourceId: "source:k2:cfs:1a",
              aliases: ["cfs:1:slot:0", "T1A"],
            },
          },
          {
            mountId: "mount:1b",
            materialSourceId: "source:k2:cfs:1b",
            spoolId: "spool:b",
            status: "open",
            openedAt: "2026-09-01T07:31:00.000Z",
            verification: "operator-confirmed",
            sourceBindingAtOpen: {
              deviceId: "serial:k2",
              materialSourceId: "source:k2:cfs:1b",
              sourceId: "source:k2:cfs:1b",
              aliases: ["cfs:1:slot:1", "T1B"],
            },
          },
        ],
      }
    : undefined;
  const printBindingStore = {
    printStartSnapshots: options.includeSegments
      ? [{
          snapshotId: "snap:1",
          deviceId: "serial:k2",
          printJobId: "job:1",
          materialSourceSnapshots: [],
        }]
      : [],
    jobMaterialSegments: options.includeSegments
      ? [
          certifyItemKeeperProjectionSegment({
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
            debit: { status: "eligible", canDebit: true, reasons: [] },
            order: 0,
          }),
          certifyItemKeeperProjectionSegment({
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
            debit: { status: "eligible", canDebit: true, reasons: [] },
            order: 1,
          }),
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
              materialSourceId: "source:k2:cfs:1a",
              deviceId: "serial:k2",
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
              materialSourceId: "source:k2:cfs:1b",
              deviceId: "serial:k2",
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

/**
 * Gate 18.9J-2 readiness用のsource/result-setが揃ったpayloadを生成する。
 *
 * 【詳細説明】
 * - 2本のobserved-used sourceと1本のconfirmed-unused source、3要素raw CSVを同一jobへ揃える。
 * - このfixtureを崩すことで、analyzerが「ready風の寄せ集め」を拒否できるか確認する。
 *
 * @function createGate18_9J2ReadyPayload
 * @returns {Object} Gate 18.9J-2 ready候補payload。
 */
function createGate18_9J2ReadyPayload() {
  const payload = createExportPayload({
    includeMountStore: true,
    includeSegments: true,
  });
  payload.machines["K2Pro-69E7"].printStore.history = [{
    printJobId: "job:1",
    printPlanId: "plan:1",
    materialUsed: "3210,6543,0",
  }];
  payload.materialAccountingPrintBindingStore.printStartSnapshots = [
    {
      snapshotId: "snap:1a",
      deviceId: "serial:k2",
      printJobId: "job:1",
      printPlanId: "plan:1",
      materialSourceId: "source:k2:cfs:1a",
      mountId: "mount:1a",
      spoolId: "spool:a",
      bindingAuthorityDigest: "fnv1a128:snap-digest-1a",
      bindingAuthority: {
        tool: { toolId: 0, protocolToolAlias: "T1A", order: 0 },
        source: { materialSourceId: "source:k2:cfs:1a" },
        mount: { mountId: "mount:1a", spoolId: "spool:a" },
      },
      sessionId: "session:k2-a",
    },
    {
      snapshotId: "snap:1b",
      deviceId: "serial:k2",
      printJobId: "job:1",
      printPlanId: "plan:1",
      materialSourceId: "source:k2:cfs:1b",
      mountId: "mount:1b",
      spoolId: "spool:b",
      bindingAuthorityDigest: "fnv1a128:snap-digest-1b",
      bindingAuthority: {
        tool: { toolId: 1, protocolToolAlias: "T1B", order: 1 },
        source: { materialSourceId: "source:k2:cfs:1b" },
        mount: { mountId: "mount:1b", spoolId: "spool:b" },
      },
      sessionId: "session:k2-a",
    },
    {
      snapshotId: "snap:1c",
      deviceId: "serial:k2",
      printJobId: "job:1",
      printPlanId: "plan:1",
      materialSourceId: "source:k2:cfs:1c",
      mountId: "mount:1c",
      spoolId: "spool:c",
      bindingAuthorityDigest: "fnv1a128:snap-digest-1c",
      bindingAuthority: {
        tool: { toolId: 2, protocolToolAlias: "T1C", order: 2 },
        source: { materialSourceId: "source:k2:cfs:1c" },
        mount: { mountId: "mount:1c", spoolId: "spool:c" },
      },
      sessionId: "session:k2-a",
    },
  ];
  payload.materialAccountingPrintBindingStore.jobMaterialSegments = [
    {
      segmentId: "seg:t1a",
      deviceId: "serial:k2",
      printJobId: "job:1",
      printPlanId: "plan:1",
      spoolId: "spool:a",
      mountId: "mount:1a",
      materialSourceId: "source:k2:cfs:1a",
      protocolToolAlias: "T1A",
      usedLengthMm: 3210,
      usageState: "observed-used",
      confidence: "high",
      debit: { status: "eligible", canDebit: true, reasons: [] },
      order: 0,
    },
    {
      segmentId: "seg:t1b",
      deviceId: "serial:k2",
      printJobId: "job:1",
      printPlanId: "plan:1",
      spoolId: "spool:b",
      mountId: "mount:1b",
      materialSourceId: "source:k2:cfs:1b",
      protocolToolAlias: "T1B",
      usedLengthMm: 6543,
      usageState: "observed-used",
      confidence: "high",
      debit: { status: "eligible", canDebit: true, reasons: [] },
      order: 1,
    },
    {
      segmentId: "seg:t1c",
      deviceId: "serial:k2",
      printJobId: "job:1",
      printPlanId: "plan:1",
      spoolId: "spool:c",
      mountId: "mount:1c",
      materialSourceId: "source:k2:cfs:1c",
      protocolToolAlias: "T1C",
      usedLengthMm: 0,
      usageState: "confirmed-unused",
      confidence: "high",
      debit: { status: "eligible", canDebit: false, reasons: [] },
      order: 2,
    },
  ];
  payload.materialSourceObservations.byDeviceId["serial:k2"].latestBySourceId["source:k2:cfs:1c"] = {
    sourceId: "source:k2:cfs:1c",
    materialSourceId: "source:k2:cfs:1c",
    deviceId: "serial:k2",
    kind: "cfs-slot",
    displayLabel: "1C",
    presence: "loaded",
    selected: false,
    remaining: { normalizedPercent: 100, valid: true },
    material: { type: "PLA", name: "Generic PLA", color: { cssColor: "#cccccc" } },
    lastObservedAt: "2026-09-01T08:00:00.000Z",
  };
  payload.materialAccountingSpoolMountStore.spoolMounts.push({
    mountId: "mount:1c",
    materialSourceId: "source:k2:cfs:1c",
    spoolId: "spool:c",
    status: "open",
    openedAt: "2026-09-01T07:32:00.000Z",
    verification: "operator-confirmed",
    sourceBindingAtOpen: {
      deviceId: "serial:k2",
      materialSourceId: "source:k2:cfs:1c",
      sourceId: "source:k2:cfs:1c",
      aliases: ["cfs:1:slot:2", "T1C"],
    },
  });
  return payload;
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
      canProjectItemKeeperSourceUsage: false,
      itemKeeperProjectionEvidenceStatus: "digest-consistent-only",
      managedRemainingDebitAllowed: false,
      reasons: [],
    });
    expect(device.printBinding).toMatchObject({
      printStartSnapshotCount: 1,
      jobMaterialSegmentCount: 2,
      observedUsedSegmentCount: 2,
      confirmedUnusedSegmentCount: 0,
      itemKeeperDigestConsistentSegmentCount: 2,
      itemKeeperDigestConsistentUsedLengthMm: 9753,
      itemKeeperRuntimeCertifiedSegmentCount: 0,
      itemKeeperRuntimeCertifiedUsedLengthMm: 0,
      itemKeeperEligibleSegmentCount: 0,
      itemKeeperEligibleUsedLengthMm: 0,
    });
    expect(device.sources.map((source) => [
      source.displayLabel,
      source.managedMountCount,
      source.sourceSpecificUsageCount,
      source.sourceSpecificUsedLengthMm,
      source.itemKeeperDigestConsistentUsageCount,
      source.itemKeeperDigestConsistentUsedLengthMm,
      source.itemKeeperRuntimeCertifiedUsageCount,
      source.itemKeeperRuntimeCertifiedUsedLengthMm,
      source.itemKeeperEligibleUsageCount,
      source.itemKeeperEligibleUsedLengthMm,
      source.deviceReportedRemainingPercent,
    ])).toEqual([
      ["1A", 1, 1, 3210, 1, 3210, 0, 0, 0, 0, 70],
      ["1B", 1, 1, 6543, 1, 6543, 0, 0, 0, 0, 88],
      ["external", 0, 0, 0, 0, 0, 0, 0, 0, 0, null],
    ]);
  });

  it("J-2 live fixture候補は使用sourceと明示0mm未使用sourceとcertification exportを要求する", () => {
    const payload = createExportPayload({
      includeMountStore: true,
      includeSegments: true,
    });
    payload.materialAccountingPrintBindingStore.printStartSnapshots = [
      {
        snapshotId: "snap:1a",
        deviceId: "serial:k2",
        printJobId: "job:1",
        printPlanId: "plan:1",
        materialSourceId: "source:k2:cfs:1a",
        mountId: "mount:1a",
        spoolId: "spool:a",
        bindingAuthorityDigest: "fnv1a128:snap-digest-1a",
        bindingAuthority: {
          tool: { toolId: 0, protocolToolAlias: "T1A", order: 0 },
          source: { materialSourceId: "source:k2:cfs:1a" },
          mount: { mountId: "mount:1a", spoolId: "spool:a" },
        },
      },
      {
        snapshotId: "snap:1b",
        deviceId: "serial:k2",
        printJobId: "job:1",
        printPlanId: "plan:1",
        materialSourceId: "source:k2:cfs:1b",
        mountId: "mount:1b",
        spoolId: "spool:b",
        bindingAuthorityDigest: "fnv1a128:snap-digest-1b",
        bindingAuthority: {
          tool: { toolId: 1, protocolToolAlias: "T1B", order: 1 },
          source: { materialSourceId: "source:k2:cfs:1b" },
          mount: { mountId: "mount:1b", spoolId: "spool:b" },
        },
      },
      {
        snapshotId: "snap:1c",
        deviceId: "serial:k2",
        printJobId: "job:1",
        printPlanId: "plan:1",
        materialSourceId: "source:k2:cfs:1c",
        mountId: "mount:1c",
        spoolId: "spool:c",
        bindingAuthorityDigest: "fnv1a128:snap-digest-1c",
        bindingAuthority: {
          tool: { toolId: 2, protocolToolAlias: "T1C", order: 2 },
          source: { materialSourceId: "source:k2:cfs:1c" },
          mount: { mountId: "mount:1c", spoolId: "spool:c" },
        },
      },
    ];
    payload.materialAccountingPrintBindingStore.jobMaterialSegments = payload.materialAccountingPrintBindingStore.jobMaterialSegments.map((segment) => {
      const copy = { ...segment, printPlanId: "plan:1" };
      delete copy.itemKeeperProjection;
      return copy;
    });
    payload.materialSourceObservations.byDeviceId["serial:k2"].latestBySourceId["source:k2:cfs:1c"] = {
      sourceId: "source:k2:cfs:1c",
      materialSourceId: "source:k2:cfs:1c",
      deviceId: "serial:k2",
      kind: "cfs-slot",
      displayLabel: "1C",
      presence: "loaded",
      selected: false,
      remaining: { normalizedPercent: 100, valid: true },
      material: { type: "PLA", name: "Generic PLA", color: { cssColor: "#cccccc" } },
      lastObservedAt: "2026-09-01T08:00:00.000Z",
    };
    payload.materialAccountingSpoolMountStore.spoolMounts.push({
      mountId: "mount:1c",
      materialSourceId: "source:k2:cfs:1c",
      spoolId: "spool:c",
      status: "open",
      openedAt: "2026-09-01T07:32:00.000Z",
      verification: "operator-confirmed",
      sourceBindingAtOpen: {
        deviceId: "serial:k2",
        materialSourceId: "source:k2:cfs:1c",
        sourceId: "source:k2:cfs:1c",
        aliases: ["cfs:1:slot:2", "T1C"],
      },
    });
    payload.materialAccountingPrintBindingStore.jobMaterialSegments.push({
      segmentId: "seg:t1c",
      deviceId: "serial:k2",
      printJobId: "job:1",
      printPlanId: "plan:1",
      spoolId: "spool:c",
      mountId: "mount:1c",
      materialSourceId: "source:k2:cfs:1c",
      protocolToolAlias: "T1C",
      usedLengthMm: 0,
      usageState: "confirmed-unused",
      confidence: "high",
      debit: { status: "eligible", canDebit: false, reasons: [] },
      order: 2,
    });
    payload.machines["K2Pro-69E7"].printStore.history = [{
      printJobId: "job:1",
      printPlanId: "plan:1",
      materialUsed: "3210,6543,0",
    }];

    const missingCertification = analyzeMaterialAccountingExport(payload);
    expect(missingCertification.gate18_9J2).toMatchObject({
      status: "waiting-live-fixture-capture",
      readyForFixtureReview: false,
      canRegisterReviewedFixtureEntry: false,
      canProjectItemKeeperSourceUsage: false,
    });
    expect(missingCertification.gate18_9J2.reasons).toContain("cfs-certification-panel-export-missing");

    const ready = analyzeMaterialAccountingExport(payload, {
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          liveSendEnabled: false,
        },
        summary: {
          material: {
            summary: { loadedSourceCount: 3 },
          },
        },
      },
    });
    expect(ready.gate18_9J2).toMatchObject({
      status: "candidate-ready-for-fixture-review",
      readyForFixtureReview: true,
      canRegisterReviewedFixtureEntry: false,
      canProjectItemKeeperSourceUsage: false,
      reasons: [],
    });
    expect(ready.gate18_9J2.devices[0]).toMatchObject({
      readyForFixtureReview: true,
      printBinding: {
        observedUsedSegmentCount: 2,
        confirmedUnusedSegmentCount: 1,
        reviewableProjectionCandidateSegmentCount: 3,
        itemKeeperDigestConsistentSegmentCount: 0,
      },
    });
  });

  it("J-2 readinessは別jobのused/unused証跡を寄せ集めてreadyにしない", () => {
    const payload = createExportPayload({
      includeMountStore: true,
      includeSegments: true,
    });
    payload.materialAccountingPrintBindingStore.printStartSnapshots = [
      {
        snapshotId: "snap:job-a",
        deviceId: "serial:k2",
        printJobId: "job:a",
        printPlanId: "plan:a",
        materialSourceId: "source:k2:cfs:1a",
        mountId: "mount:1a",
        spoolId: "spool:a",
        bindingAuthority: {
          tool: { toolId: 0, protocolToolAlias: "T1A", order: 0 },
          source: { materialSourceId: "source:k2:cfs:1a" },
          mount: { mountId: "mount:1a", spoolId: "spool:a" },
        },
      },
      {
        snapshotId: "snap:job-b",
        deviceId: "serial:k2",
        printJobId: "job:b",
        printPlanId: "plan:b",
        materialSourceId: "source:k2:cfs:1b",
        mountId: "mount:1b",
        spoolId: "spool:b",
        bindingAuthority: {
          tool: { toolId: 1, protocolToolAlias: "T1B", order: 1 },
          source: { materialSourceId: "source:k2:cfs:1b" },
          mount: { mountId: "mount:1b", spoolId: "spool:b" },
        },
      },
    ];
    payload.materialAccountingPrintBindingStore.jobMaterialSegments = [
      {
        segmentId: "seg:job-a",
        deviceId: "serial:k2",
        printJobId: "job:a",
        printPlanId: "plan:a",
        spoolId: "spool:a",
        mountId: "mount:1a",
        materialSourceId: "source:k2:cfs:1a",
        protocolToolAlias: "T1A",
        order: 0,
        usedLengthMm: 3210,
        usageState: "observed-used",
        debit: { status: "eligible", canDebit: true, reasons: [] },
      },
      {
        segmentId: "seg:job-b",
        deviceId: "serial:k2",
        printJobId: "job:b",
        printPlanId: "plan:b",
        spoolId: "spool:b",
        mountId: "mount:1b",
        materialSourceId: "source:k2:cfs:1b",
        protocolToolAlias: "T1B",
        order: 1,
        usedLengthMm: 0,
        usageState: "confirmed-unused",
        debit: { status: "eligible", canDebit: false, reasons: [] },
      },
    ];

    const report = analyzeMaterialAccountingExport(payload, {
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          liveSendEnabled: false,
          printer: { model: "F012" },
        },
        summary: { material: { summary: { loadedSourceCount: 2 } } },
      },
    });

    expect(report.gate18_9J2.readyForFixtureReview).toBe(false);
    expect(report.gate18_9J2.reasons).toContain("K2Pro-69E7:ready-candidate-print-result-set-missing");
    expect(report.gate18_9J2.devices[0].candidateJobs.map((job) => [
      job.printJobId,
      job.readyForFixtureReview,
      job.observedUsedSegmentCount,
      job.confirmedUnusedSegmentCount,
    ])).toEqual([
      ["job:a", false, 1, 0],
      ["job:b", false, 0, 1],
    ]);
  });

  it("J-2 readinessはraw materialUsed CSVがない同一jobをreadyにしない", () => {
    const payload = createGate18_9J2ReadyPayload();
    payload.machines["K2Pro-69E7"].printStore.history = [{
      printJobId: "job:1",
      printPlanId: "plan:1",
    }];

    const report = analyzeMaterialAccountingExport(payload, {
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          liveSendEnabled: false,
          printer: { model: "F012", deviceId: "serial:k2", sessionId: "session:k2-a" },
        },
        summary: { material: { summary: { loadedSourceCount: 3 } } },
      },
    });
    const job = report.gate18_9J2.devices[0].candidateJobs[0];

    expect(report.gate18_9J2.readyForFixtureReview).toBe(false);
    expect(job).toMatchObject({
      rawMaterialUsedPresent: false,
      rawMaterialUsedSourceCount: 0,
      readyForFixtureReview: false,
    });
    expect(job.reasons).toContain("raw-material-used-source-csv-missing");
  });

  it("J-2 readinessは履歴保持上限でprint historyが消えてもsegment完了証拠からraw CSVを検証する", () => {
    const payload = createGate18_9J2ReadyPayload();
    payload.machines["K2Pro-69E7"].printStore.history = [];
    for (const segment of payload.materialAccountingPrintBindingStore.jobMaterialSegments) {
      segment.evidence = {
        ...(segment.evidence || {}),
        completionEvidence: {
          rawMaterialUsed: "3210,6543,0",
          parserVersion: "k2-material-used-csv:v1",
          sourceOrderingProfile: "print-start-binding-authority-order:v1",
          sourceCount: 3,
          partCount: 3,
        },
      };
    }

    const report = analyzeMaterialAccountingExport(payload, {
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          liveSendEnabled: false,
          printer: { model: "F012", deviceId: "serial:k2", sessionId: "session:k2-a" },
        },
        summary: { material: { summary: { loadedSourceCount: 3 } } },
      },
    });
    const job = report.gate18_9J2.devices[0].candidateJobs[0];

    expect(report.gate18_9J2.readyForFixtureReview).toBe(true);
    expect(job).toMatchObject({
      rawMaterialUsedPresent: true,
      rawMaterialUsedSourceCount: 3,
      readyForFixtureReview: true,
    });
    expect(job.reasons).not.toContain("raw-material-used-source-csv-missing");
  });

  it("J-2 readinessはsnapshot/segment/raw CSVのsource数が一致しない同一jobをreadyにしない", () => {
    const payload = createGate18_9J2ReadyPayload();
    payload.materialAccountingPrintBindingStore.jobMaterialSegments.pop();

    const report = analyzeMaterialAccountingExport(payload, {
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          liveSendEnabled: false,
          printer: { model: "F012", deviceId: "serial:k2", sessionId: "session:k2-a" },
        },
        summary: { material: { summary: { loadedSourceCount: 3 } } },
      },
    });
    const job = report.gate18_9J2.devices[0].candidateJobs[0];

    expect(report.gate18_9J2.readyForFixtureReview).toBe(false);
    expect(job).toMatchObject({
      printStartSnapshotCount: 3,
      jobMaterialSegmentCount: 2,
      rawMaterialUsedSourceCount: 3,
      readyForFixtureReview: false,
    });
    expect(job.reasons).toContain("source-result-set-count-mismatch");
  });

  it("J-2 readinessはcertification sessionが一致しない同一device候補をreadyにしない", () => {
    const payload = createGate18_9J2ReadyPayload();

    const report = analyzeMaterialAccountingExport(payload, {
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          liveSendEnabled: false,
          printer: { model: "F012", deviceId: "serial:k2", sessionId: "session:other" },
        },
        summary: { material: { summary: { loadedSourceCount: 3 } } },
      },
    });

    expect(report.gate18_9J2.readyForFixtureReview).toBe(false);
    expect(report.gate18_9J2.reasons).toContain("K2Pro-69E7:certification-session-id-mismatch");
  });

  it("J-2 readinessはcertification targetに一致するK2だけでoverall readyを判定する", () => {
    const payload = createGate18_9J2ReadyPayload();
    payload.appSettings.connectionTargets.push({
      dest: "192.168.54.154:9999",
      hostname: "K2Pro-Other",
      printerType: "creality-k2",
      printerCoreV3Identity: {
        deviceIdSeed: "serial:k2-other",
        reportedModel: "F012",
      },
    });
    payload.machines["K2Pro-Other"] = {
      storedData: { model: { rawValue: "F012" } },
      printStore: { history: [] },
    };

    const report = analyzeMaterialAccountingExport(payload, {
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          liveSendEnabled: false,
          printer: { model: "F012", deviceId: "serial:k2", sessionId: "session:k2-a" },
        },
        summary: { material: { summary: { loadedSourceCount: 3 } } },
      },
    });

    expect(report.gate18_9J2.readyForFixtureReview).toBe(true);
    expect(report.gate18_9J2.devices.map((device) => device.deviceId)).toEqual(["serial:k2"]);
    expect(report.gate18_9J2.reasons).toEqual([]);
  });

  it("J-2 readinessはobserved-used 0mmを使用source証跡としてreadyにしない", () => {
    const payload = createGate18_9J2ReadyPayload();
    payload.materialAccountingPrintBindingStore.jobMaterialSegments[0].usedLengthMm = 0;

    const report = analyzeMaterialAccountingExport(payload, {
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          liveSendEnabled: false,
          printer: { model: "F012", deviceId: "serial:k2", sessionId: "session:k2-a" },
        },
        summary: { material: { summary: { loadedSourceCount: 3 } } },
      },
    });
    const job = report.gate18_9J2.devices[0].candidateJobs[0];

    expect(report.gate18_9J2.readyForFixtureReview).toBe(false);
    expect(job.reasons).toContain("observed-used-zero-segment-invalid");
  });

  it("J-2 readinessはconfirmed-unusedの正の使用量を未使用source証跡としてreadyにしない", () => {
    const payload = createGate18_9J2ReadyPayload();
    payload.machines["K2Pro-69E7"].printStore.history[0].materialUsed = "3210,6543,1234,0";
    payload.materialAccountingPrintBindingStore.printStartSnapshots.push({
      snapshotId: "snap:1d",
      deviceId: "serial:k2",
      printJobId: "job:1",
      printPlanId: "plan:1",
      materialSourceId: "source:k2:cfs:1d",
      mountId: "mount:1d",
      spoolId: "spool:d",
      bindingAuthorityDigest: "fnv1a128:snap-digest-1d",
      bindingAuthority: {
        tool: { toolId: 3, protocolToolAlias: "T1D", order: 3 },
        source: { materialSourceId: "source:k2:cfs:1d" },
        mount: { mountId: "mount:1d", spoolId: "spool:d" },
      },
      sessionId: "session:k2-a",
    });
    payload.materialAccountingPrintBindingStore.jobMaterialSegments[2].usedLengthMm = 1234;
    payload.materialAccountingPrintBindingStore.jobMaterialSegments.push({
      segmentId: "seg:t1d",
      deviceId: "serial:k2",
      printJobId: "job:1",
      printPlanId: "plan:1",
      spoolId: "spool:d",
      mountId: "mount:1d",
      materialSourceId: "source:k2:cfs:1d",
      protocolToolAlias: "T1D",
      usedLengthMm: 0,
      usageState: "confirmed-unused",
      confidence: "high",
      debit: { status: "eligible", canDebit: false, reasons: [] },
      order: 3,
    });
    payload.materialSourceObservations.byDeviceId["serial:k2"].latestBySourceId["source:k2:cfs:1d"] = {
      sourceId: "source:k2:cfs:1d",
      materialSourceId: "source:k2:cfs:1d",
      deviceId: "serial:k2",
      kind: "cfs-slot",
      displayLabel: "1D",
      presence: "loaded",
      selected: false,
      remaining: { normalizedPercent: 100, valid: true },
      material: { type: "PLA", name: "Generic PLA", color: { cssColor: "#ffffff" } },
      lastObservedAt: "2026-09-01T08:00:00.000Z",
    };
    payload.materialAccountingSpoolMountStore.spoolMounts.push({
      mountId: "mount:1d",
      materialSourceId: "source:k2:cfs:1d",
      spoolId: "spool:d",
      status: "open",
      openedAt: "2026-09-01T07:33:00.000Z",
      verification: "operator-confirmed",
      sourceBindingAtOpen: {
        deviceId: "serial:k2",
        materialSourceId: "source:k2:cfs:1d",
        sourceId: "source:k2:cfs:1d",
        aliases: ["cfs:1:slot:3", "T1D"],
      },
    });

    const report = analyzeMaterialAccountingExport(payload, {
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          liveSendEnabled: false,
          printer: { model: "F012", deviceId: "serial:k2", sessionId: "session:k2-a" },
        },
        summary: { material: { summary: { loadedSourceCount: 4 } } },
      },
    });
    const job = report.gate18_9J2.devices[0].candidateJobs[0];

    expect(report.gate18_9J2.readyForFixtureReview).toBe(false);
    expect(job).toMatchObject({
      confirmedUnusedSegmentCount: 1,
      reviewableProjectionCandidateSegmentCount: 3,
      readyForFixtureReview: false,
    });
    expect(job.reasons).toContain("confirmed-unused-positive-usage-invalid");
  });

  it("J-2 readinessはraw materialUsed CSV parser reasonが残る同一jobをreadyにしない", () => {
    const payload = createGate18_9J2ReadyPayload();
    payload.machines["K2Pro-69E7"].printStore.history[0].materialUsed = "3210,,0";

    const report = analyzeMaterialAccountingExport(payload, {
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          liveSendEnabled: false,
          printer: { model: "F012", deviceId: "serial:k2", sessionId: "session:k2-a" },
        },
        summary: { material: { summary: { loadedSourceCount: 3 } } },
      },
    });
    const job = report.gate18_9J2.devices[0].candidateJobs[0];

    expect(report.gate18_9J2.readyForFixtureReview).toBe(false);
    expect(job.rawMaterialUsedParserReasons).toContain("material-used-source-empty-field");
    expect(job.reasons).toContain("raw-material-used-parser-reasons-present");
  });

  it("J-2 readinessはissuanceEvidence.sessionIdを同一jobのsession証跡として取り込む", () => {
    const payload = createGate18_9J2ReadyPayload();
    for (const snapshot of payload.materialAccountingPrintBindingStore.printStartSnapshots) {
      delete snapshot.sessionId;
      snapshot.issuanceEvidence = { sessionId: "session:k2-a" };
    }

    const report = analyzeMaterialAccountingExport(payload, {
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          liveSendEnabled: false,
          printer: { model: "F012", deviceId: "serial:k2", sessionId: "session:k2-a" },
        },
        summary: { material: { summary: { loadedSourceCount: 3 } } },
      },
    });
    const job = report.gate18_9J2.devices[0].candidateJobs[0];

    expect(report.gate18_9J2.readyForFixtureReview).toBe(true);
    expect(job.sessionIds).toEqual(["session:k2-a"]);
  });

  it("J-2 readinessはcertification sessionがある場合に同一jobのsession証跡欠落をreadyにしない", () => {
    const payload = createGate18_9J2ReadyPayload();
    for (const snapshot of payload.materialAccountingPrintBindingStore.printStartSnapshots) {
      delete snapshot.sessionId;
    }
    for (const segment of payload.materialAccountingPrintBindingStore.jobMaterialSegments) {
      delete segment.sessionId;
      delete segment.issuanceEvidence;
      delete segment.startContext;
      delete segment.uploadReceipt;
    }
    for (const history of payload.machines["K2Pro-69E7"].printStore.history) {
      delete history.sessionId;
      delete history.startContext;
      delete history.uploadReceipt;
      delete history.issuanceEvidence;
    }

    const report = analyzeMaterialAccountingExport(payload, {
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          liveSendEnabled: false,
          printer: { model: "F012", deviceId: "serial:k2", sessionId: "session:k2-a" },
        },
        summary: { material: { summary: { loadedSourceCount: 3 } } },
      },
    });
    const job = report.gate18_9J2.devices[0].candidateJobs[0];

    expect(report.gate18_9J2.readyForFixtureReview).toBe(false);
    expect(job.sessionIds).toEqual([]);
    expect(job.reasons).toContain("certification-session-id-missing");
  });

  it("J-2 readinessはredacted certification sessionをcorrelation evidenceで照合する", () => {
    const payload = createGate18_9J2ReadyPayload();

    const report = analyzeMaterialAccountingExport(payload, {
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          liveSendEnabled: false,
          printer: { model: "F012", deviceId: "serial:k2", sessionId: "<ID_001>" },
          sessionCorrelation: createCfsSessionCorrelationEvidence("session:k2-a", { salt: "test-session-salt" }),
        },
        summary: { material: { summary: { loadedSourceCount: 3 } } },
      },
    });
    const job = report.gate18_9J2.devices[0].candidateJobs[0];

    expect(report.gate18_9J2.readyForFixtureReview).toBe(true);
    expect(job.sessionIds).toEqual(["session:k2-a"]);
    expect(job.reasons).not.toContain("certification-session-id-mismatch");
  });

  it("J-2 readinessはCertification panelのredacted export bundleをcorrelationで照合する", () => {
    const payload = createGate18_9J2ReadyPayload();
    const certificationPayload = createCfsCertificationExportBundle(createCfsCertificationPanelViewModel({
      printer: {
        model: "F012",
        deviceId: "serial:k2",
        sessionId: "session:k2-a",
        active: true,
      },
      materialViewModel: {
        summary: {
          loadedSourceCount: 3,
          selectedSourceCount: 1,
        },
      },
      export: {
        sessionCorrelationSalt: "test-session-salt",
      },
    }));

    const report = analyzeMaterialAccountingExport(payload, { certificationPayload });
    const job = report.gate18_9J2.devices[0].candidateJobs[0];

    expect(certificationPayload.manifest.printer.sessionId).toMatch(/^<ID_\d+>$/u);
    expect(certificationPayload.manifest.printer.deviceId).toMatch(/^<ID_\d+>$/u);
    expect(certificationPayload.manifest.sessionCorrelation.value).toBe(
      createCfsSessionCorrelationEvidence("session:k2-a", { salt: "test-session-salt" }).value
    );
    expect(certificationPayload.manifest.deviceCorrelation.value).toBe(
      createCfsDeviceCorrelationEvidence("serial:k2", { salt: "test-session-salt" }).value
    );
    expect(report.gate18_9J2.readyForFixtureReview).toBe(true);
    expect(job.reasons).not.toContain("certification-session-id-mismatch");
  });

  it("J-2 readinessはredacted certification sessionのcorrelation欠落をreadyにしない", () => {
    const payload = createGate18_9J2ReadyPayload();

    const report = analyzeMaterialAccountingExport(payload, {
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          liveSendEnabled: false,
          printer: { model: "F012", deviceId: "serial:k2", sessionId: "<ID_001>" },
        },
        summary: { material: { summary: { loadedSourceCount: 3 } } },
      },
    });
    const job = report.gate18_9J2.devices[0].candidateJobs[0];

    expect(report.gate18_9J2.readyForFixtureReview).toBe(false);
    expect(job.reasons).toContain("certification-session-correlation-missing");
  });

  it("J-2 readinessはredacted certification deviceのcorrelation欠落をreadyにしない", () => {
    const payload = createGate18_9J2ReadyPayload();

    const report = analyzeMaterialAccountingExport(payload, {
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          liveSendEnabled: false,
          printer: { model: "F012", deviceId: "<ID_001>", sessionId: "session:k2-a" },
        },
        summary: { material: { summary: { loadedSourceCount: 3 } } },
      },
    });

    expect(report.gate18_9J2.readyForFixtureReview).toBe(false);
    expect(report.gate18_9J2.reasons).toContain("certification-device-correlation-missing");
  });

  it("J-2 readinessはredacted certification deviceをcorrelationでmulti-K2 exportの対象へ絞る", () => {
    const payload = createGate18_9J2ReadyPayload();
    payload.appSettings.connectionTargets.push({
      dest: "192.168.54.154:9999",
      hostname: "K2Pro-Other",
      printerType: "creality-k2",
      printerCoreV3Identity: {
        deviceIdSeed: "serial:k2-other",
        reportedModel: "F012",
      },
    });
    payload.machines["K2Pro-Other"] = {
      storedData: { model: { rawValue: "F012" } },
      printStore: { history: [] },
    };

    const report = analyzeMaterialAccountingExport(payload, {
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          liveSendEnabled: false,
          printer: { model: "F012", deviceId: "<ID_001>", sessionId: "session:k2-a" },
          deviceCorrelation: createCfsDeviceCorrelationEvidence("serial:k2", { salt: "test-device-salt" }),
        },
        summary: { material: { summary: { loadedSourceCount: 3 } } },
      },
    });

    expect(report.gate18_9J2.readyForFixtureReview).toBe(true);
    expect(report.gate18_9J2.devices.map((device) => device.deviceId)).toEqual(["serial:k2"]);
    expect(report.gate18_9J2.reasons).toEqual([]);
  });

  it("J-2 readinessはsegment/historyだけのsession証跡でsnapshot欠落を補完しない", () => {
    const payload = createGate18_9J2ReadyPayload();
    for (const snapshot of payload.materialAccountingPrintBindingStore.printStartSnapshots) {
      delete snapshot.sessionId;
      delete snapshot.issuanceEvidence;
      delete snapshot.startContext;
      delete snapshot.uploadReceipt;
    }
    for (const segment of payload.materialAccountingPrintBindingStore.jobMaterialSegments) {
      segment.issuanceEvidence = { sessionId: "session:k2-a" };
    }
    for (const history of payload.machines["K2Pro-69E7"].printStore.history) {
      history.sessionId = "session:k2-a";
    }

    const report = analyzeMaterialAccountingExport(payload, {
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          liveSendEnabled: false,
          printer: { model: "F012", deviceId: "serial:k2", sessionId: "session:k2-a" },
        },
        summary: { material: { summary: { loadedSourceCount: 3 } } },
      },
    });
    const job = report.gate18_9J2.devices[0].candidateJobs[0];

    expect(report.gate18_9J2.readyForFixtureReview).toBe(false);
    expect(job.sessionIds).toEqual([]);
    expect(job.observedOtherSessionIds).toEqual(["session:k2-a"]);
    expect(job.reasons).toContain("certification-session-id-missing");
  });

  it("J-2 readinessはcertification sessionをready候補job単位で照合する", () => {
    const payload = createGate18_9J2ReadyPayload();
    for (const snapshot of payload.materialAccountingPrintBindingStore.printStartSnapshots) {
      snapshot.sessionId = "session:wrong-ready-job";
    }
    payload.materialAccountingPrintBindingStore.printStartSnapshots.push({
      snapshotId: "snap:other-session-only",
      deviceId: "serial:k2",
      printJobId: "job:other",
      printPlanId: "plan:other",
      materialSourceId: "source:k2:cfs:1a",
      mountId: "mount:1a",
      spoolId: "spool:a",
      sessionId: "session:k2-a",
      bindingAuthority: {
        tool: { toolId: 0, protocolToolAlias: "T1A", order: 0 },
        source: { materialSourceId: "source:k2:cfs:1a" },
        mount: { mountId: "mount:1a", spoolId: "spool:a" },
      },
    });

    const report = analyzeMaterialAccountingExport(payload, {
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          liveSendEnabled: false,
          printer: { model: "F012", deviceId: "serial:k2", sessionId: "session:k2-a" },
        },
        summary: { material: { summary: { loadedSourceCount: 3 } } },
      },
    });
    const job = report.gate18_9J2.devices[0].candidateJobs.find((entry) => entry.printJobId === "job:1");

    expect(report.gate18_9J2.readyForFixtureReview).toBe(false);
    expect(job.reasons).toContain("certification-session-id-mismatch");
    expect(report.gate18_9J2.reasons).toContain("K2Pro-69E7:ready-candidate-print-result-set-missing");
  });

  it("J-2 readinessは同一jobに複数sessionが混在する場合にambiguousとしてreadyにしない", () => {
    const payload = createGate18_9J2ReadyPayload();
    payload.materialAccountingPrintBindingStore.printStartSnapshots[0].sessionId = "session:k2-a";
    payload.materialAccountingPrintBindingStore.printStartSnapshots[1].sessionId = "session:old";

    const report = analyzeMaterialAccountingExport(payload, {
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          liveSendEnabled: false,
          printer: { model: "F012", deviceId: "serial:k2", sessionId: "session:k2-a" },
        },
        summary: { material: { summary: { loadedSourceCount: 3 } } },
      },
    });
    const job = report.gate18_9J2.devices[0].candidateJobs.find((entry) => entry.printJobId === "job:1");

    expect(report.gate18_9J2.readyForFixtureReview).toBe(false);
    expect(job.sessionIds).toEqual(["session:k2-a", "session:old"]);
    expect(job.reasons).toContain("candidate-session-id-ambiguous");
    expect(report.gate18_9J2.reasons).toContain("K2Pro-69E7:candidate-session-id-ambiguous");
  });

  it("J-2 readinessは別jobのsession mismatchで同一deviceの正しいready jobを落とさない", () => {
    const payload = createGate18_9J2ReadyPayload();
    payload.machines["K2Pro-69E7"].printStore.history.push({
      printJobId: "job:old",
      printPlanId: "plan:old",
      materialUsed: "3210,6543,0",
      sessionId: "session:old",
    });
    const originalSnapshots = [...payload.materialAccountingPrintBindingStore.printStartSnapshots];
    for (const snapshot of originalSnapshots) {
      payload.materialAccountingPrintBindingStore.printStartSnapshots.push({
        ...snapshot,
        snapshotId: `${snapshot.snapshotId}:old`,
        printJobId: "job:old",
        printPlanId: "plan:old",
        sessionId: "session:old",
      });
    }
    const originalSegments = [...payload.materialAccountingPrintBindingStore.jobMaterialSegments];
    for (const segment of originalSegments) {
      payload.materialAccountingPrintBindingStore.jobMaterialSegments.push({
        ...segment,
        segmentId: `${segment.segmentId}:old`,
        printJobId: "job:old",
        printPlanId: "plan:old",
        issuanceEvidence: { sessionId: "session:old" },
      });
    }

    const report = analyzeMaterialAccountingExport(payload, {
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          liveSendEnabled: false,
          printer: { model: "F012", deviceId: "serial:k2", sessionId: "session:k2-a" },
        },
        summary: { material: { summary: { loadedSourceCount: 3 } } },
      },
    });
    const readyJob = report.gate18_9J2.devices[0].candidateJobs.find((entry) => entry.printJobId === "job:1");
    const oldJob = report.gate18_9J2.devices[0].candidateJobs.find((entry) => entry.printJobId === "job:old");

    expect(readyJob.readyForFixtureReview).toBe(true);
    expect(oldJob.readyForFixtureReview).toBe(false);
    expect(oldJob.reasons).toContain("certification-session-id-mismatch");
    expect(report.gate18_9J2.readyForFixtureReview).toBe(true);
    expect(report.gate18_9J2.devices[0].reasons).not.toContain("certification-session-id-mismatch");
  });

  it("J-2 readinessは外部loaded + CFS 1本を2 loaded CFSとして扱わない", () => {
    const payload = createExportPayload({
      includeMountStore: true,
      includeSegments: false,
    });
    payload.materialSourceObservations.byDeviceId["serial:k2"].latestBySourceId["external:0:slot:0"].presence = "loaded";
    payload.materialSourceObservations.byDeviceId["serial:k2"].latestBySourceId["source:k2:cfs:1b"].presence = "empty";

    const report = analyzeMaterialAccountingExport(payload, {
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          liveSendEnabled: false,
          printer: { model: "F012" },
        },
        summary: { material: { summary: { loadedSourceCount: 2 } } },
      },
    });

    expect(report.devices[0].sourceCounts).toMatchObject({
      loaded: 2,
      loadedCfs: 1,
    });
    expect(report.gate18_9J2.reasons).toContain("K2Pro-69E7:loaded-cfs-source-count-less-than-two");
  });

  it("J-2 readinessは別printerのcertification panel exportを同一capture扱いしない", () => {
    const payload = createExportPayload({
      includeMountStore: true,
      includeSegments: true,
    });

    const report = analyzeMaterialAccountingExport(payload, {
      certificationPayload: {
        manifest: {
          panel: "cfs-debug-certification",
          liveSendEnabled: false,
          printer: { model: "K2 Plus", deviceId: "serial:other" },
        },
        summary: { material: { summary: { loadedSourceCount: 2 } } },
      },
    });

    expect(report.gate18_9J2.reasons).toContain("K2Pro-69E7:certification-device-id-mismatch");
    expect(report.gate18_9J2.reasons).toContain("K2Pro-69E7:certification-model-mismatch");
    expect(report.gate18_9J2.readyForFixtureReview).toBe(false);
  });

  it("raw source aliasとcanonical MaterialSource IDが分かれていてもmountとsegmentをsourceへ紐付ける", () => {
    const payload = createExportPayload({
      includeMountStore: true,
      includeSegments: true,
    });
    const source = payload.materialSourceObservations.byDeviceId["serial:k2"].latestBySourceId["source:k2:cfs:1a"];
    source.sourceId = "cfs:1:slot:0";
    source.materialSourceId = "material-source:k2:f012:cfs:1:0";
    source.aliases = ["source:k2:cfs:1a", "T1A"];
    payload.materialAccountingSpoolMountStore.spoolMounts[0] = {
      ...payload.materialAccountingSpoolMountStore.spoolMounts[0],
      materialSourceId: "material-source:k2:f012:cfs:1:0",
      sourceBindingAtOpen: {
        deviceId: "serial:k2",
        materialSourceId: "material-source:k2:f012:cfs:1:0",
        sourceId: "cfs:1:slot:0",
        aliases: ["source:k2:cfs:1a", "T1A"],
      },
    };
    payload.materialAccountingPrintBindingStore.jobMaterialSegments[0] = certifyItemKeeperProjectionSegment({
      ...payload.materialAccountingPrintBindingStore.jobMaterialSegments[0],
      materialSourceId: "material-source:k2:f012:cfs:1:0",
      sourceId: "cfs:1:slot:0",
      materialSourceSnapshot: {
        deviceId: "serial:k2",
        materialSourceId: "material-source:k2:f012:cfs:1:0",
        sourceId: "cfs:1:slot:0",
        aliases: ["source:k2:cfs:1a", "T1A"],
      },
    });
    payload.appSettings.connectionTargets.push({
      dest: "192.168.54.154:9999",
      hostname: "K2Pro-Other",
      printerType: "creality-k2",
      printerCoreV3Identity: {
        deviceIdSeed: "serial:k2-other",
        reportedModel: "F012",
      },
    });
    payload.machines["K2Pro-Other"] = {
      storedData: { model: { rawValue: "F012" } },
      printStore: { history: [] },
    };
    payload.materialSourceObservations.byDeviceId["serial:k2-other"] = {
      lastObservedAt: "2026-09-01T08:02:00.000Z",
      latestBySourceId: {
        "cfs:1:slot:0": {
          sourceId: "cfs:1:slot:0",
          materialSourceId: "material-source:k2-other:f012:cfs:1:0",
          kind: "cfs-slot",
          displayLabel: "1A",
          presence: "loaded",
          aliases: ["T1A"],
          lastObservedAt: "2026-09-01T08:02:00.000Z",
        },
      },
    };
    payload.materialAccountingSpoolMountStore.spoolMounts.push({
      mountId: "mount:other",
      materialSourceId: "material-source:k2-other:f012:cfs:1:0",
      spoolId: "spool:other",
      status: "open",
      openedAt: "2026-09-01T07:35:00.000Z",
      verification: "operator-confirmed",
      sourceBindingAtOpen: {
        deviceId: "serial:k2-other",
        materialSourceId: "material-source:k2-other:f012:cfs:1:0",
        sourceId: "cfs:1:slot:0",
        aliases: ["source:k2:cfs:1a", "T1A"],
      },
    });

    const report = analyzeMaterialAccountingExport(payload);
    const device = report.devices.find((entry) => entry.hostname === "K2Pro-69E7");
    const sourceSummary = device.sources.find((entry) => entry.displayLabel === "1A");

    expect(sourceSummary).toMatchObject({
      sourceId: "cfs:1:slot:0",
      materialSourceId: "material-source:k2:f012:cfs:1:0",
      managedMountCount: 1,
      sourceSpecificUsageCount: 1,
      sourceSpecificUsedLengthMm: 3210,
      itemKeeperDigestConsistentUsageCount: 1,
      itemKeeperDigestConsistentUsedLengthMm: 3210,
      itemKeeperEligibleUsageCount: 0,
      itemKeeperEligibleUsedLengthMm: 0,
    });
    expect(sourceSummary.managedMounts.map((mount) => mount.spoolId)).toEqual(["spool:a"]);
    expect(device.certificationReadiness.reasons).toEqual([]);
  });

  it("pendingやinvalidなJobMaterialSegmentはItemKeeper projection evidenceとして扱わない", () => {
    const payload = createExportPayload({
      includeMountStore: true,
      includeSegments: true,
    });
    payload.materialAccountingPrintBindingStore.jobMaterialSegments = [
      {
        segmentId: "seg:pending",
        deviceId: "serial:k2",
        printJobId: "job:1",
        spoolId: "spool:a",
        materialSourceId: "source:k2:cfs:1a",
        usageState: "pending",
        usedLengthMm: 3210,
      },
      {
        segmentId: "seg:no-spool",
        deviceId: "serial:k2",
        printJobId: "job:1",
        materialSourceId: "source:k2:cfs:1b",
        usageState: "observed-used",
        usedLengthMm: 6543,
      },
      {
        segmentId: "seg:invalid-length",
        deviceId: "serial:k2",
        printJobId: "job:1",
        spoolId: "spool:b",
        materialSourceId: "source:k2:cfs:1b",
        usageState: "observed-used",
        usedLengthMm: -1,
      },
    ];

    const report = analyzeMaterialAccountingExport(payload);
    const device = report.devices[0];

    expect(device.printBinding).toMatchObject({
      jobMaterialSegmentCount: 3,
      sourceSpecificUsageCount: 3,
      itemKeeperDigestConsistentSegmentCount: 0,
      itemKeeperRuntimeCertifiedSegmentCount: 0,
      itemKeeperEligibleSegmentCount: 0,
      itemKeeperEligibleUsedLengthMm: 0,
    });
    expect(device.certificationReadiness.canProjectItemKeeperSourceUsage).toBe(false);
    expect(report.gate18_9I.status).toBe("waiting-live-shadow-accounting");
  });

  it("confirmed-unusedかつ0mmのJobMaterialSegmentはdigest-consistent evidenceとして扱うがruntime projection可とは扱わない", () => {
    const payload = createExportPayload({
      includeMountStore: true,
      includeSegments: true,
    });
    payload.materialAccountingPrintBindingStore.jobMaterialSegments[0] = certifyItemKeeperProjectionSegment({
      ...payload.materialAccountingPrintBindingStore.jobMaterialSegments[0],
      usageState: "confirmed-unused",
      usedLengthMm: 0,
      debit: { status: "eligible", canDebit: false, reasons: [] },
    });

    const report = analyzeMaterialAccountingExport(payload);
    const sourceSummary = report.devices[0].sources.find((entry) => entry.displayLabel === "1A");

    expect(sourceSummary).toMatchObject({
      sourceSpecificUsageCount: 1,
      sourceSpecificUsedLengthMm: 0,
      itemKeeperDigestConsistentUsageCount: 1,
      itemKeeperDigestConsistentUsedLengthMm: 0,
      itemKeeperRuntimeCertifiedUsageCount: 0,
      itemKeeperEligibleUsageCount: 0,
    });
    expect(report.devices[0].certificationReadiness).toMatchObject({
      canProjectItemKeeperSourceUsage: false,
      itemKeeperProjectionEvidenceStatus: "digest-consistent-only",
    });
    expect(report.gate18_9I.status).toBe("evidence-present");
  });

  it("fixture-accepted receiptをsegment projectionへ誤用してもruntime projection可能とは扱わない", () => {
    const payload = createExportPayload({
      includeMountStore: true,
      includeSegments: true,
    });
    payload.materialAccountingPrintBindingStore.jobMaterialSegments[0] = {
      ...payload.materialAccountingPrintBindingStore.jobMaterialSegments[0],
      itemKeeperProjection: {
        status: "fixture-accepted",
        authority: "itemkeeper-source-usage-live-fixture-evidence",
        fixtureDigest: "fnv1a128:fixture",
      },
    };

    const report = analyzeMaterialAccountingExport(payload);
    const sourceSummary = report.devices[0].sources.find((entry) => entry.displayLabel === "1A");

    expect(sourceSummary).toMatchObject({
      sourceSpecificUsageCount: 1,
      itemKeeperFixtureAcceptedUsageCount: 1,
      itemKeeperDigestConsistentUsageCount: 0,
      itemKeeperRuntimeCertifiedUsageCount: 0,
      itemKeeperEligibleUsageCount: 0,
    });
    expect(report.devices[0].certificationReadiness).toMatchObject({
      canProjectItemKeeperSourceUsage: false,
      itemKeeperProjectionEvidenceStatus: "digest-consistent-only",
    });
    expect(report.devices[0].printBinding).toMatchObject({
      itemKeeperFixtureAcceptedSegmentCount: 1,
      itemKeeperRuntimeCertifiedSegmentCount: 0,
      itemKeeperEligibleSegmentCount: 0,
    });
  });

  it("別deviceのeligible segmentだけではGate18.9I evidence-presentにしない", () => {
    const payload = createExportPayload({
      includeMountStore: true,
      includeSegments: false,
    });
    payload.materialAccountingPrintBindingStore.printStartSnapshots = [{
      snapshotId: "snap:k2",
      deviceId: "serial:k2",
      printJobId: "job:k2",
    }];
    payload.materialAccountingPrintBindingStore.jobMaterialSegments = [{
      segmentId: "seg:k1",
      deviceId: "serial:k1",
      printJobId: "job:k1",
      spoolId: "spool:k1",
      materialSourceId: "source:k1:external",
      usageState: "observed-used",
      usedLengthMm: 100,
    }];

    const report = analyzeMaterialAccountingExport(payload);

    expect(report.devices[0].printBinding).toMatchObject({
      printStartSnapshotCount: 1,
      jobMaterialSegmentCount: 0,
      itemKeeperEligibleSegmentCount: 0,
    });
    expect(report.gate18_9I.status).toBe("waiting-live-shadow-accounting");
  });

  it("debit eligibleでないJobMaterialSegmentはItemKeeper projection readyとして扱わない", () => {
    const payload = createExportPayload({
      includeMountStore: true,
      includeSegments: true,
    });
    payload.materialAccountingPrintBindingStore.jobMaterialSegments[0] = {
      ...payload.materialAccountingPrintBindingStore.jobMaterialSegments[0],
      debit: { status: "blocked", canDebit: false, reasons: ["physical-discontinuity"] },
    };

    const report = analyzeMaterialAccountingExport(payload);
    const sourceSummary = report.devices[0].sources.find((entry) => entry.displayLabel === "1A");

    expect(sourceSummary).toMatchObject({
      sourceSpecificUsageCount: 1,
      itemKeeperDigestConsistentUsageCount: 0,
      itemKeeperEligibleUsageCount: 0,
      itemKeeperEligibleUsedLengthMm: 0,
    });
    expect(report.gate18_9I.status).toBe("evidence-present");
  });

  it("null使用量のJobMaterialSegmentを0mmのItemKeeper projection readyとして扱わない", () => {
    const payload = createExportPayload({
      includeMountStore: true,
      includeSegments: true,
    });
    payload.materialAccountingPrintBindingStore.jobMaterialSegments[0] = {
      ...payload.materialAccountingPrintBindingStore.jobMaterialSegments[0],
      usageState: "confirmed-unused",
      usedLengthMm: null,
      debit: { status: "eligible", canDebit: false, reasons: [] },
    };

    const report = analyzeMaterialAccountingExport(payload);
    const sourceSummary = report.devices[0].sources.find((entry) => entry.displayLabel === "1A");

    expect(sourceSummary).toMatchObject({
      itemKeeperEligibleUsageCount: 0,
      itemKeeperEligibleUsedLengthMm: 0,
    });
  });

  it("plain certifiedだけのJobMaterialSegmentはItemKeeper projection readyとして扱わない", () => {
    const payload = createExportPayload({
      includeMountStore: true,
      includeSegments: true,
    });
    payload.materialAccountingPrintBindingStore.jobMaterialSegments[0] = {
      ...payload.materialAccountingPrintBindingStore.jobMaterialSegments[0],
      itemKeeperProjection: { status: "certified", evidence: "imported-json" },
    };

    const report = analyzeMaterialAccountingExport(payload);
    const sourceSummary = report.devices[0].sources.find((entry) => entry.displayLabel === "1A");

    expect(sourceSummary).toMatchObject({
      sourceSpecificUsageCount: 1,
      itemKeeperEligibleUsageCount: 0,
      itemKeeperEligibleUsedLengthMm: 0,
    });
  });

  it("live certificationが無いJobMaterialSegmentはItemKeeper projection readyとして扱わない", () => {
    const payload = createExportPayload({
      includeMountStore: true,
      includeSegments: true,
    });
    delete payload.materialAccountingPrintBindingStore.jobMaterialSegments[0].itemKeeperProjection;

    const report = analyzeMaterialAccountingExport(payload);
    const sourceSummary = report.devices[0].sources.find((entry) => entry.displayLabel === "1A");

    expect(sourceSummary).toMatchObject({
      sourceSpecificUsageCount: 1,
      itemKeeperEligibleUsageCount: 0,
      itemKeeperEligibleUsedLengthMm: 0,
    });
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
