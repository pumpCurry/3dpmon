/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 MaterialSource print binding repository 単体テスト
 * @file printer_core_material_accounting_print_binding.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_material_accounting_print_binding_test
 *
 * 【機能内容サマリ】
 * - Gate 18.9E の print-start material binding snapshot を検証
 * - CFS複数sourceのsource-specific usage attributionを検証
 * - completion時のcurrent mountではなくprint-start snapshotで帰属することを固定
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1516 (PR #438)
 * @since   1.390.1516 (PR #438)
 * @lastModified 2026-08-31 14:32:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  FILAMENT_UNIT_KIND,
  MATERIAL_IDENTITY_STRENGTH,
  MATERIAL_SOURCE_KIND,
  SPOOL_MOUNT_STATUS,
  SPOOL_MOUNT_VERIFICATION,
  createFilamentUnitRecord,
  createMaterialSourceIdentity,
  createMaterialSourceLocator,
  createMaterialSourceRecord,
  createSpoolMountRecord,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_contract.js";
import {
  createMaterialAccountingPrintBindingRepository,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_print_binding.js";
import {
  createMulticolorCfsPrintPlan,
} from "../../3dp_lib/printer_core/dashboard_print_plan.js";

/**
 * G-code assetをテスト用に生成する。
 *
 * 【詳細説明】
 * - 本テストはPrintPlanのupload authorityではなく、MaterialSource accountingのprint-start bindingを検証する。
 * - PrintPlan contractはasset.contentからanalysisを発行するため、caller-declared analysisは渡さない。
 *
 * @function createAsset
 * @param {string} fileName - G-codeファイル名。
 * @param {number[]} logicalTools - 論理tool ID一覧。
 * @returns {Object} G-code asset。
 */
function createAsset(fileName, logicalTools) {
  const content = logicalTools.map((toolId) => `T${toolId}\nG1 X${toolId}`).join("\n");
  const fileHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  return {
    path: `/mnt/UDISK/printer_data/gcodes/${fileName}`,
    fileName,
    content,
    analyzerVersion: "unit-gcode-analyzer",
    uploadReceipt: {
      receiptId: `upload:${fileName}`,
      deviceId: "serial:k2pro-69e7",
      remotePath: `/mnt/UDISK/printer_data/gcodes/${fileName}`,
      fileHash,
    },
  };
}

/**
 * CFS sourceとmountのfixtureを生成する。
 *
 * 【詳細説明】
 * - 1Aから1DまでのMaterialSourceと、それぞれにoperator-confirmed mount済みの3dpmon管理spoolを作る。
 * - `slotIndex`は0 origin、表示labelは1A形式として明示的に分ける。
 *
 * @function createCfsFixtures
 * @returns {{deviceId:string, materialSources:Object[], spoolMounts:Object[]}} CFS fixture。
 */
function createCfsFixtures() {
  const deviceId = "serial:k2pro-69e7";
  const unit = createFilamentUnitRecord({
    deviceId,
    kind: FILAMENT_UNIT_KIND.CFS,
    unitIndex: 1,
    identity: { namespace: "cfs-unit", parts: [deviceId, 1] },
    identityStrength: MATERIAL_IDENTITY_STRENGTH.STABLE,
    providerId: "k2-ws9999-boxsInfo",
  });
  const labels = ["1A", "1B", "1C", "1D"];
  const sources = labels.map((label, slotIndex) => createMaterialSourceRecord({
    deviceId,
    unitId: unit.unitId,
    kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
    locator: createMaterialSourceLocator({
      kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
      unitIndex: 1,
      slotIndex,
      protocolSlotId: label,
    }),
    identity: createMaterialSourceIdentity({
      deviceId,
      unitId: unit.unitId,
      kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
      slotIndex,
      protocolSlotId: label,
    }),
    identityStrength: MATERIAL_IDENTITY_STRENGTH.STABLE,
    displayLabel: label,
  }));
  const mounts = sources.map((source, index) => createSpoolMountRecord({
    materialSourceId: source.materialSourceId,
    spoolId: `spool:${labels[index].toLowerCase()}`,
    mountOperationId: `mount:${labels[index].toLowerCase()}`,
    openedAt: "2026-08-31T04:30:00.000Z",
    openedBy: "operator",
    status: SPOOL_MOUNT_STATUS.OPEN,
    verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
    sourceIdentityStrengthAtOpen: MATERIAL_IDENTITY_STRENGTH.STABLE,
  }));
  return { deviceId, materialSources: sources, spoolMounts: mounts };
}

/**
 * 4色CFS用PrintPlanを生成する。
 *
 * @function createPlan
 * @param {string} deviceId - Device ID。
 * @param {Object[]} sources - MaterialSource配列。
 * @param {Object[]} mounts - SpoolMount配列。
 * @returns {Object} PrintPlan。
 */
function createPlan(deviceId, sources, mounts) {
  return createMulticolorCfsPrintPlan({
    deviceId,
    asset: createAsset("4color_benchy.gcode", [0, 1, 2, 3]),
    toolAssignments: sources.map((source, index) => ({
      toolId: index,
      protocolToolAlias: ["T1A", "T1B", "T1C", "T1D"][index],
      materialSourceId: source.materialSourceId,
      spoolId: mounts[index].spoolId,
    })),
  });
}

describe("MaterialSource print binding repository", () => {
  it("CFS複数sourceのsource-specific usageを別々のspool mountへ帰属する", () => {
    const { deviceId, materialSources, spoolMounts } = createCfsFixtures();
    const printPlan = createPlan(deviceId, materialSources, spoolMounts);
    const repository = createMaterialAccountingPrintBindingRepository();
    const start = repository.recordPrintStartBindings({
      printPlan,
      printJobId: "job:4color-benchy",
      materialSources,
      spoolMounts,
      capturedAt: "2026-08-31T05:00:00.000Z",
      bindingOperationId: "binding:4color-benchy",
    });

    const completion = repository.recordUsageAttribution({
      printPlan,
      printJobId: "job:4color-benchy",
      completedAt: "2026-08-31T05:30:00.000Z",
      attributionOperationId: "usage:4color-benchy",
      resultSetCompleteness: "complete",
      materialUsages: [
        { protocolToolAlias: "T1A", materialSourceId: materialSources[0].materialSourceId, usedLengthMm: 3210 },
        { protocolToolAlias: "T1B", materialSourceId: materialSources[1].materialSourceId, usedLengthMm: 6543 },
        { protocolToolAlias: "T1D", materialSourceId: materialSources[3].materialSourceId, usedLengthMm: 1234 },
      ],
      continuityBySourceId: Object.fromEntries(materialSources.map((source) => [
        source.materialSourceId,
        { sourceContinuity: true, freshTopology: true },
      ])),
    });

    expect(start.ok).toBe(true);
    expect(completion.ok).toBe(true);
    expect(completion.segments.map((segment) => [
      segment.protocolToolAlias,
      segment.materialSourceId,
      segment.spoolId,
      segment.usedLengthMm,
      segment.usageState,
      segment.debit.canDebit,
    ])).toEqual([
      ["T1A", materialSources[0].materialSourceId, "spool:1a", 3210, "observed-used", true],
      ["T1B", materialSources[1].materialSourceId, "spool:1b", 6543, "observed-used", true],
      ["T1C", materialSources[2].materialSourceId, "spool:1c", 0, "confirmed-unused", false],
      ["T1D", materialSources[3].materialSourceId, "spool:1d", 1234, "observed-used", true],
    ]);
    expect(completion.unattributedUsage).toEqual([]);
  });

  it("incompleteなsource-specific result setでは未出現sourceをunknownに残す", () => {
    const { deviceId, materialSources, spoolMounts } = createCfsFixtures();
    const printPlan = createPlan(deviceId, materialSources, spoolMounts);
    const repository = createMaterialAccountingPrintBindingRepository();
    repository.recordPrintStartBindings({
      printPlan,
      printJobId: "job:partial",
      materialSources,
      spoolMounts,
      capturedAt: "2026-08-31T05:00:00.000Z",
      bindingOperationId: "binding:partial",
    });

    const completion = repository.recordUsageAttribution({
      printPlan,
      printJobId: "job:partial",
      completedAt: "2026-08-31T05:30:00.000Z",
      attributionOperationId: "usage:partial",
      resultSetCompleteness: "partial",
      materialUsages: [
        { protocolToolAlias: "T1A", materialSourceId: materialSources[0].materialSourceId, usedLengthMm: 3210 },
      ],
    });

    expect(completion.ok).toBe(true);
    expect(completion.segments.map((segment) => [segment.protocolToolAlias, segment.usedLengthMm, segment.usageState])).toEqual([
      ["T1A", 3210, "observed-used"],
      ["T1B", null, "unknown"],
      ["T1C", null, "unknown"],
      ["T1D", null, "unknown"],
    ]);
  });

  it("multi-sourceでtotal-only usageしか無い場合はpending unattributedとして隔離する", () => {
    const { deviceId, materialSources, spoolMounts } = createCfsFixtures();
    const printPlan = createPlan(deviceId, materialSources, spoolMounts);
    const repository = createMaterialAccountingPrintBindingRepository();
    repository.recordPrintStartBindings({
      printPlan,
      printJobId: "job:total-only",
      materialSources,
      spoolMounts,
      capturedAt: "2026-08-31T05:00:00.000Z",
      bindingOperationId: "binding:total-only",
    });

    const completion = repository.recordUsageAttribution({
      printPlan,
      printJobId: "job:total-only",
      completedAt: "2026-08-31T05:30:00.000Z",
      attributionOperationId: "usage:total-only",
      resultSetCompleteness: "partial",
      totalUsedLengthMm: 9999,
      materialUsages: [],
    });

    expect(completion.ok).toBe(false);
    expect(completion.status).toBe("pending");
    expect(completion.unattributedUsage).toEqual([
      {
        printJobId: "job:total-only",
        printPlanId: printPlan.printPlanId,
        deviceId,
        usedLengthMm: 9999,
        reason: "multi-source-total-only",
      },
    ]);
    expect(completion.segments.every((segment) => segment.debit.canDebit === false)).toBe(true);
  });

  it("completion時のcurrent mount変更ではなくprint-start snapshotのmountへ帰属する", () => {
    const { deviceId, materialSources, spoolMounts } = createCfsFixtures();
    const printPlan = createPlan(deviceId, materialSources, spoolMounts);
    const repository = createMaterialAccountingPrintBindingRepository();
    repository.recordPrintStartBindings({
      printPlan,
      printJobId: "job:snapshot",
      materialSources,
      spoolMounts,
      capturedAt: "2026-08-31T05:00:00.000Z",
      bindingOperationId: "binding:snapshot",
    });
    const changedMounts = [
      createSpoolMountRecord({
        ...spoolMounts[0],
        spoolId: "spool:replacement",
        mountOperationId: "mount:replacement",
        openedAt: "2026-08-31T05:10:00.000Z",
      }),
      ...spoolMounts.slice(1),
    ];

    const completion = repository.recordUsageAttribution({
      printPlan,
      printJobId: "job:snapshot",
      spoolMounts: changedMounts,
      completedAt: "2026-08-31T05:30:00.000Z",
      attributionOperationId: "usage:snapshot",
      resultSetCompleteness: "complete",
      materialUsages: [
        { protocolToolAlias: "T1A", materialSourceId: materialSources[0].materialSourceId, usedLengthMm: 3210 },
      ],
    });

    expect(completion.ok).toBe(true);
    expect(completion.segments[0]).toMatchObject({
      protocolToolAlias: "T1A",
      materialSourceId: materialSources[0].materialSourceId,
      spoolId: "spool:1a",
      mountId: spoolMounts[0].mountId,
      usedLengthMm: 3210,
    });
  });

  it("同じcompletion payloadのretryはidempotentでledger eventを重複させない", () => {
    const { deviceId, materialSources, spoolMounts } = createCfsFixtures();
    const printPlan = createPlan(deviceId, materialSources, spoolMounts);
    const repository = createMaterialAccountingPrintBindingRepository();
    repository.recordPrintStartBindings({
      printPlan,
      printJobId: "job:retry",
      materialSources,
      spoolMounts,
      capturedAt: "2026-08-31T05:00:00.000Z",
      bindingOperationId: "binding:retry",
    });
    const input = {
      printPlan,
      printJobId: "job:retry",
      completedAt: "2026-08-31T05:30:00.000Z",
      attributionOperationId: "usage:retry",
      resultSetCompleteness: "complete",
      materialUsages: [
        { protocolToolAlias: "T1A", materialSourceId: materialSources[0].materialSourceId, usedLengthMm: 3210 },
      ],
    };

    const first = repository.recordUsageAttribution(input);
    const second = repository.recordUsageAttribution(input);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.action).toBe("idempotent");
    expect(repository.toJSON().ledgerEvents).toHaveLength(first.ledgerEvents.length);
  });
});
