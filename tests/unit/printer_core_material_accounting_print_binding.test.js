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
 * @version 1.390.1628 (PR #440)
 * @since   1.390.1516 (PR #438)
 * @lastModified 2026-09-02 08:18:40
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
  createTrustedMaterialResultSetCompletenessRegistry,
  createMaterialSourceIdentity,
  createMaterialSourceLocator,
  createMaterialSourceRecord,
  createSpoolMountRecord,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_contract.js";
import {
  createMaterialAccountingPrintBindingRepository,
  normalizeStoredMaterialAccountingPrintBindingStore,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_print_binding.js";
import {
  createSingleColorPrintPlan,
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
        { protocolToolAlias: "T1C", materialSourceId: materialSources[2].materialSourceId, usedLengthMm: 0 },
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
      segment.authority.mode,
    ])).toEqual([
      ["T1A", materialSources[0].materialSourceId, "spool:1a", 3210, "observed-used", false, "shadow-attribution-read-only"],
      ["T1B", materialSources[1].materialSourceId, "spool:1b", 6543, "observed-used", false, "shadow-attribution-read-only"],
      ["T1C", materialSources[2].materialSourceId, "spool:1c", 0, "confirmed-unused", false, "shadow-attribution-read-only"],
      ["T1D", materialSources[3].materialSourceId, "spool:1d", 1234, "observed-used", false, "shadow-attribution-read-only"],
    ]);
    expect(completion.usageEvidence.every((evidence) => evidence.trusted === false)).toBe(true);
    expect(completion.ledgerEvents.every((event) => event.authority.canDebitRemaining === false)).toBe(true);
    expect(completion.unattributedUsage).toEqual([]);
  });

  it("public repositoryのprint-start snapshotはtrusted debit authorityを持たない", () => {
    const { deviceId, materialSources, spoolMounts } = createCfsFixtures();
    const printPlan = createPlan(deviceId, materialSources, spoolMounts);
    const repository = createMaterialAccountingPrintBindingRepository();

    const start = repository.recordPrintStartBindings({
      printPlan,
      printJobId: "job:shadow-snapshot",
      materialSources,
      spoolMounts,
      capturedAt: "2026-08-31T05:00:00.000Z",
      bindingOperationId: "binding:shadow-snapshot",
    });

    expect(start.ok).toBe(true);
    expect(start.snapshots).toHaveLength(4);
    expect(start.snapshots.every((snapshot) => snapshot.trusted === false)).toBe(true);
    expect(start.snapshots.every((snapshot) => snapshot.authority.canBindUsage === false)).toBe(true);
    expect(start.snapshots.map((snapshot) => snapshot.authority.mode)).toEqual([
      "shadow-print-start-material-snapshot",
      "shadow-print-start-material-snapshot",
      "shadow-print-start-material-snapshot",
      "shadow-print-start-material-snapshot",
    ]);
  });

  it("print-start snapshotはmount open時刻をtop-levelのsemantic fieldとして保存する", () => {
    const { deviceId, materialSources, spoolMounts } = createCfsFixtures();
    const printPlan = createPlan(deviceId, materialSources, spoolMounts);
    const repository = createMaterialAccountingPrintBindingRepository();

    const start = repository.recordPrintStartBindings({
      printPlan,
      printJobId: "job:snapshot-mount-opened-at",
      materialSources,
      spoolMounts,
      capturedAt: "2026-08-31T05:00:00.000Z",
      bindingOperationId: "binding:snapshot-mount-opened-at",
    });

    expect(start.ok).toBe(true);
    expect(start.snapshots.map((snapshot) => snapshot.mountOpenedAt)).toEqual([
      "2026-08-31T04:30:00.000Z",
      "2026-08-31T04:30:00.000Z",
      "2026-08-31T04:30:00.000Z",
      "2026-08-31T04:30:00.000Z",
    ]);
    expect(repository.toJSON().printStartSnapshots.map((snapshot) => snapshot.mountOpenedAt)).toEqual([
      "2026-08-31T04:30:00.000Z",
      "2026-08-31T04:30:00.000Z",
      "2026-08-31T04:30:00.000Z",
      "2026-08-31T04:30:00.000Z",
    ]);
  });

  it("print-start時にMaterialSourceがPrintPlanと別deviceならbindingを拒否する", () => {
    const { deviceId, materialSources, spoolMounts } = createCfsFixtures();
    const printPlan = createPlan(deviceId, materialSources, spoolMounts);
    const repository = createMaterialAccountingPrintBindingRepository();
    const mismatchedSources = materialSources.map((source, index) => (
      index === 0
        ? { ...source, deviceId: "serial:other-printer" }
        : source
    ));

    const start = repository.recordPrintStartBindings({
      printPlan,
      printJobId: "job:source-device-mismatch",
      materialSources: mismatchedSources,
      spoolMounts,
      capturedAt: "2026-08-31T05:00:00.000Z",
      bindingOperationId: "binding:source-device-mismatch",
    });

    expect(start).toMatchObject({
      ok: false,
      status: "blocked",
      reasons: ["material-source-device-mismatch"],
    });
    expect(repository.toJSON().printStartSnapshots).toEqual([]);
  });

  it("print-start時刻でactiveなopen mountが複数あるsourceはambiguousとして拒否する", () => {
    const { deviceId, materialSources, spoolMounts } = createCfsFixtures();
    const printPlan = createPlan(deviceId, materialSources, spoolMounts);
    const repository = createMaterialAccountingPrintBindingRepository();
    const duplicateMount = createSpoolMountRecord({
      materialSourceId: materialSources[0].materialSourceId,
      spoolId: spoolMounts[0].spoolId,
      mountOperationId: "mount:1a-duplicate",
      openedAt: "2026-08-31T04:45:00.000Z",
      openedBy: "operator",
      status: SPOOL_MOUNT_STATUS.OPEN,
      verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
      sourceIdentityStrengthAtOpen: MATERIAL_IDENTITY_STRENGTH.STABLE,
    });

    const start = repository.recordPrintStartBindings({
      printPlan,
      printJobId: "job:ambiguous-mount",
      materialSources,
      spoolMounts: [duplicateMount, ...spoolMounts],
      capturedAt: "2026-08-31T05:00:00.000Z",
      bindingOperationId: "binding:ambiguous-mount",
    });

    expect(start).toMatchObject({
      ok: false,
      status: "blocked",
      reasons: ["spool-mount-ambiguous-at-print-start"],
    });
    expect(repository.toJSON().printStartSnapshots).toEqual([]);
  });

  it("MaterialSource aliasが複数canonical sourceへ衝突する場合は履歴順に依存せずbindingを拒否する", () => {
    const { deviceId, materialSources, spoolMounts } = createCfsFixtures();
    const sharedAlias = "source:k2:cfs:shared-1a";
    const ambiguousSources = materialSources.map((source, index) => (
      index === 0 || index === 1
        ? createMaterialSourceRecord({
          deviceId: source.deviceId,
          unitId: source.unitId,
          kind: source.kind,
          locator: source.locator,
          identity: source.identity,
          identityStrength: source.identityStrength,
          displayLabel: source.displayLabel,
          aliases: [sharedAlias],
        })
        : source
    ));
    const printPlan = createMulticolorCfsPrintPlan({
      deviceId,
      asset: createAsset("alias_collision.gcode", [0, 1]),
      toolAssignments: [
        {
          toolId: 0,
          protocolToolAlias: "T1A",
          materialSourceId: sharedAlias,
          spoolId: spoolMounts[0].spoolId,
        },
        {
          toolId: 1,
          protocolToolAlias: "T1B",
          materialSourceId: materialSources[1].materialSourceId,
          spoolId: spoolMounts[1].spoolId,
        },
      ],
    });
    const repository = createMaterialAccountingPrintBindingRepository();

    const start = repository.recordPrintStartBindings({
      printPlan,
      printJobId: "job:alias-collision",
      materialSources: ambiguousSources,
      spoolMounts,
      capturedAt: "2026-08-31T05:00:00.000Z",
      bindingOperationId: "binding:alias-collision",
    });

    expect(start).toMatchObject({
      ok: false,
      status: "blocked",
      reasons: ["ambiguous-material-source-alias"],
    });
    expect(repository.toJSON().printStartSnapshots).toEqual([]);
  });

  it("print-start時刻でactiveではないopen mountはbindingに使わない", () => {
    const { deviceId, materialSources, spoolMounts } = createCfsFixtures();
    const printPlan = createPlan(deviceId, materialSources, spoolMounts);
    const repository = createMaterialAccountingPrintBindingRepository();
    const futureMounts = spoolMounts.map((mount, index) => (
      index === 0
        ? createSpoolMountRecord({
          ...mount,
          mountOperationId: "mount:1a-future",
          openedAt: "2026-08-31T05:10:00.000Z",
        })
        : mount
    ));

    const start = repository.recordPrintStartBindings({
      printPlan,
      printJobId: "job:inactive-mount",
      materialSources,
      spoolMounts: futureMounts,
      capturedAt: "2026-08-31T05:00:00.000Z",
      bindingOperationId: "binding:inactive-mount",
    });

    expect(start).toMatchObject({
      ok: false,
      status: "blocked",
      reasons: ["spool-mount-not-active-at-print-start"],
    });
    expect(repository.toJSON().printStartSnapshots).toEqual([]);
  });

  it("callerのcomplete宣言だけでは未出現sourceをconfirmed-unusedにしない", () => {
    const { deviceId, materialSources, spoolMounts } = createCfsFixtures();
    const printPlan = createPlan(deviceId, materialSources, spoolMounts);
    const repository = createMaterialAccountingPrintBindingRepository();
    repository.recordPrintStartBindings({
      printPlan,
      printJobId: "job:untrusted-complete",
      materialSources,
      spoolMounts,
      capturedAt: "2026-08-31T05:00:00.000Z",
      bindingOperationId: "binding:untrusted-complete",
    });

    const completion = repository.recordUsageAttribution({
      printPlan,
      printJobId: "job:untrusted-complete",
      completedAt: "2026-08-31T05:30:00.000Z",
      attributionOperationId: "usage:untrusted-complete",
      resultSetCompleteness: "complete",
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

  it("callerがtrusted complete flagを直接渡しても未出現sourceをconfirmed-unusedにしない", () => {
    const { deviceId, materialSources, spoolMounts } = createCfsFixtures();
    const printPlan = createPlan(deviceId, materialSources, spoolMounts);
    const repository = createMaterialAccountingPrintBindingRepository();
    repository.recordPrintStartBindings({
      printPlan,
      printJobId: "job:forged-trusted-complete",
      materialSources,
      spoolMounts,
      capturedAt: "2026-08-31T05:00:00.000Z",
      bindingOperationId: "binding:forged-trusted-complete",
    });

    const completion = repository.recordUsageAttribution({
      printPlan,
      printJobId: "job:forged-trusted-complete",
      completedAt: "2026-08-31T05:30:00.000Z",
      attributionOperationId: "usage:forged-trusted-complete",
      resultSetCompleteness: "complete",
      trustedResultSetCompleteness: true,
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

  it("別source集合で発行されたcomplete evidenceでは未出現sourceをconfirmed-unusedにしない", () => {
    const { deviceId, materialSources, spoolMounts } = createCfsFixtures();
    const printPlan = createPlan(deviceId, materialSources, spoolMounts);
    const repository = createMaterialAccountingPrintBindingRepository();
    const registry = createTrustedMaterialResultSetCompletenessRegistry();
    repository.recordPrintStartBindings({
      printPlan,
      printJobId: "job:subset-complete",
      materialSources,
      spoolMounts,
      capturedAt: "2026-08-31T05:00:00.000Z",
      bindingOperationId: "binding:subset-complete",
    });
    const subsetEvidence = registry.certifyCompleteResultSet({
      deviceId,
      printJobId: "job:subset-complete",
      printPlanId: printPlan.printPlanId,
      materialSourceIds: [materialSources[0].materialSourceId],
      observedSourceIds: [materialSources[0].materialSourceId],
      observedAt: "2026-08-31T05:30:00.000Z",
      source: "trusted-source-specific-result-registry",
    });

    const completion = repository.recordUsageAttribution({
      printPlan,
      printJobId: "job:subset-complete",
      completedAt: "2026-08-31T05:30:00.000Z",
      attributionOperationId: "usage:subset-complete",
      resultSetCompleteness: "complete",
      resultSetCompletenessEvidence: subsetEvidence,
      materialUsages: [
        { materialSourceId: materialSources[0].materialSourceId, usedLengthMm: 3210 },
      ],
    });

    expect(completion.ok).toBe(true);
    expect(completion.segments.find((segment) => (
      segment.materialSourceId === materialSources[1].materialSourceId
    ))?.usageState).toBe("unknown");
  });

  it("public registryのblocked complete evidenceでは未出現sourceをunknownに残す", () => {
    const { deviceId, materialSources, spoolMounts } = createCfsFixtures();
    const printPlan = createPlan(deviceId, materialSources, spoolMounts);
    const repository = createMaterialAccountingPrintBindingRepository();
    const registry = createTrustedMaterialResultSetCompletenessRegistry();
    repository.recordPrintStartBindings({
      printPlan,
      printJobId: "job:public-registry-blocked",
      materialSources,
      spoolMounts,
      capturedAt: "2026-08-31T05:00:00.000Z",
      bindingOperationId: "binding:public-registry-blocked",
    });
    const blockedEvidence = registry.certifyCompleteResultSet({
      deviceId,
      printJobId: "job:public-registry-blocked",
      printPlanId: printPlan.printPlanId,
      materialSourceIds: materialSources.map((source) => source.materialSourceId),
      observedSourceIds: materialSources.map((source) => source.materialSourceId),
      observedAt: "2026-08-31T05:30:00.000Z",
      source: "trusted-source-specific-result-registry",
    });

    const completion = repository.recordUsageAttribution({
      printPlan,
      printJobId: "job:public-registry-blocked",
      completedAt: "2026-08-31T05:30:00.000Z",
      attributionOperationId: "usage:public-registry-blocked",
      resultSetCompleteness: "complete",
      resultSetCompletenessEvidence: blockedEvidence,
      materialUsages: [
        { materialSourceId: materialSources[0].materialSourceId, usedLengthMm: 3210 },
      ],
    });

    expect(blockedEvidence).toMatchObject({
      ok: false,
      reasons: ["trusted-result-set-issuer-unavailable"],
    });
    expect(completion.ok).toBe(true);
    expect(completion.segments.map((segment) => [segment.materialSourceId, segment.usageState])).toEqual([
      [materialSources[0].materialSourceId, "observed-used"],
      [materialSources[1].materialSourceId, "unknown"],
      [materialSources[2].materialSourceId, "unknown"],
      [materialSources[3].materialSourceId, "unknown"],
    ]);
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

  it("single-sourceのtotal-only usageはread-only segmentとしてsourceへ帰属する", () => {
    const { deviceId, materialSources, spoolMounts } = createCfsFixtures();
    const printPlan = createSingleColorPrintPlan({
      deviceId,
      asset: createAsset("single_source.gcode", [0]),
      toolId: 0,
      protocolToolAlias: "T1A",
      materialSourceId: materialSources[0].materialSourceId,
      spoolId: spoolMounts[0].spoolId,
    });
    const repository = createMaterialAccountingPrintBindingRepository();
    repository.recordPrintStartBindings({
      printPlan,
      printJobId: "job:single-total",
      materialSources,
      spoolMounts,
      capturedAt: "2026-08-31T05:00:00.000Z",
      bindingOperationId: "binding:single-total",
    });

    const completion = repository.recordUsageAttribution({
      printPlan,
      printJobId: "job:single-total",
      completedAt: "2026-08-31T05:30:00.000Z",
      attributionOperationId: "usage:single-total",
      totalUsedLengthMm: 777,
      materialUsages: [],
    });

    expect(completion.ok).toBe(true);
    expect(completion.segments).toHaveLength(1);
    expect(completion.segments[0]).toMatchObject({
      materialSourceId: materialSources[0].materialSourceId,
      spoolId: "spool:1a",
      usedLengthMm: 777,
      usageState: "observed-used",
      debit: {
        canDebit: false,
        reasons: ["shadow-only-attribution-not-debit-authority"],
      },
    });
    expect(completion.unattributedUsage).toEqual([]);
  });

  it("multi-sourceのsource-specific usageとtotal usageが混在した場合は未帰属残差を保持する", () => {
    const { deviceId, materialSources, spoolMounts } = createCfsFixtures();
    const printPlan = createPlan(deviceId, materialSources, spoolMounts);
    const repository = createMaterialAccountingPrintBindingRepository();
    repository.recordPrintStartBindings({
      printPlan,
      printJobId: "job:residual",
      materialSources,
      spoolMounts,
      capturedAt: "2026-08-31T05:00:00.000Z",
      bindingOperationId: "binding:residual",
    });

    const completion = repository.recordUsageAttribution({
      printPlan,
      printJobId: "job:residual",
      completedAt: "2026-08-31T05:30:00.000Z",
      attributionOperationId: "usage:residual",
      resultSetCompleteness: "partial",
      totalUsedLengthMm: 5000,
      materialUsages: [
        { protocolToolAlias: "T1A", materialSourceId: materialSources[0].materialSourceId, usedLengthMm: 3210 },
      ],
    });

    expect(completion.ok).toBe(false);
    expect(completion.status).toBe("pending");
    expect(completion.unattributedUsage).toEqual([
      {
        printJobId: "job:residual",
        printPlanId: printPlan.printPlanId,
        deviceId,
        usedLengthMm: 1790,
        reason: "multi-source-total-residual",
      },
    ]);
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

  it("同じprint-start snapshot IDでpayloadが変わる場合は保存済みsnapshotを上書きしない", () => {
    const { deviceId, materialSources, spoolMounts } = createCfsFixtures();
    const printPlan = createPlan(deviceId, materialSources, spoolMounts);
    const repository = createMaterialAccountingPrintBindingRepository();
    const first = repository.recordPrintStartBindings({
      printPlan,
      printJobId: "job:snapshot-conflict",
      materialSources,
      spoolMounts,
      capturedAt: "2026-08-31T05:00:00.000Z",
      bindingOperationId: "binding:snapshot-conflict-a",
    });
    const changedSources = [
      {
        ...materialSources[0],
        displayLabel: "changed-1A",
      },
      ...materialSources.slice(1),
    ];

    const second = repository.recordPrintStartBindings({
      printPlan,
      printJobId: "job:snapshot-conflict",
      materialSources: changedSources,
      spoolMounts,
      capturedAt: "2026-08-31T05:00:00.000Z",
      bindingOperationId: "binding:snapshot-conflict-b",
    });

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({
      ok: false,
      status: "blocked",
      reasons: ["print-start-snapshot-payload-conflict"],
    });
    expect(repository.toJSON().printStartSnapshots).toHaveLength(first.snapshots.length);
  });

  it("completion時のPrintPlan差し替えではなくprint-start時点のtool/source bindingへ帰属する", () => {
    const { deviceId, materialSources, spoolMounts } = createCfsFixtures();
    const printPlan = createPlan(deviceId, materialSources, spoolMounts);
    const repository = createMaterialAccountingPrintBindingRepository();
    repository.recordPrintStartBindings({
      printPlan,
      printJobId: "job:plan-swap",
      materialSources,
      spoolMounts,
      capturedAt: "2026-08-31T05:00:00.000Z",
      bindingOperationId: "binding:plan-swap",
    });
    const swappedPlan = {
      ...printPlan,
      toolAssignments: printPlan.toolAssignments.map((assignment, index) => ({
        ...assignment,
        materialSourceId: index === 0
          ? materialSources[1].materialSourceId
          : assignment.materialSourceId,
      })),
    };

    const completion = repository.recordUsageAttribution({
      printPlan: swappedPlan,
      printJobId: "job:plan-swap",
      completedAt: "2026-08-31T05:30:00.000Z",
      attributionOperationId: "usage:plan-swap",
      materialUsages: [
        { toolId: 0, protocolToolAlias: "T1A", materialSourceId: materialSources[0].materialSourceId, usedLengthMm: 3210 },
      ],
    });

    expect(completion.ok).toBe(true);
    expect(completion.segments[0]).toMatchObject({
      toolId: 0,
      protocolToolAlias: "T1A",
      materialSourceId: materialSources[0].materialSourceId,
      spoolId: "spool:1a",
      usedLengthMm: 3210,
    });
  });

  it("completion時のPrintPlan deviceId差し替えではprint-start snapshotを別deviceへ帰属しない", () => {
    const { deviceId, materialSources, spoolMounts } = createCfsFixtures();
    const printPlan = createPlan(deviceId, materialSources, spoolMounts);
    const repository = createMaterialAccountingPrintBindingRepository();
    repository.recordPrintStartBindings({
      printPlan,
      printJobId: "job:device-swap",
      materialSources,
      spoolMounts,
      capturedAt: "2026-08-31T05:00:00.000Z",
      bindingOperationId: "binding:device-swap",
    });
    const swappedDevicePlan = {
      ...printPlan,
      deviceId: "serial:other-printer",
    };

    const completion = repository.recordUsageAttribution({
      printPlan: swappedDevicePlan,
      printJobId: "job:device-swap",
      completedAt: "2026-08-31T05:30:00.000Z",
      attributionOperationId: "usage:device-swap",
      materialUsages: [
        { toolId: 0, protocolToolAlias: "T1A", materialSourceId: materialSources[0].materialSourceId, usedLengthMm: 3210 },
      ],
    });

    expect(completion).toMatchObject({
      ok: false,
      status: "blocked",
      reasons: ["print-plan-device-mismatch"],
    });
    expect(repository.toJSON().jobMaterialSegments).toEqual([]);
    expect(repository.toJSON().ledgerEvents).toEqual([]);
  });

  it("usage entryのtool/alias/source識別子が矛盾する場合は帰属を止める", () => {
    const { deviceId, materialSources, spoolMounts } = createCfsFixtures();
    const printPlan = createPlan(deviceId, materialSources, spoolMounts);
    const repository = createMaterialAccountingPrintBindingRepository();
    repository.recordPrintStartBindings({
      printPlan,
      printJobId: "job:identifier-conflict",
      materialSources,
      spoolMounts,
      capturedAt: "2026-08-31T05:00:00.000Z",
      bindingOperationId: "binding:identifier-conflict",
    });

    const completion = repository.recordUsageAttribution({
      printPlan,
      printJobId: "job:identifier-conflict",
      completedAt: "2026-08-31T05:30:00.000Z",
      attributionOperationId: "usage:identifier-conflict",
      materialUsages: [
        { toolId: 0, protocolToolAlias: "T1A", materialSourceId: materialSources[1].materialSourceId, usedLengthMm: 3210 },
      ],
    });

    expect(completion).toMatchObject({
      ok: false,
      status: "blocked",
      reasons: ["usage-identifier-conflict"],
    });
  });

  it("空文字toolIdだけのusage entryをtool 0として誤帰属しない", () => {
    const { deviceId, materialSources, spoolMounts } = createCfsFixtures();
    const printPlan = createPlan(deviceId, materialSources, spoolMounts);
    const repository = createMaterialAccountingPrintBindingRepository();
    repository.recordPrintStartBindings({
      printPlan,
      printJobId: "job:blank-tool",
      materialSources,
      spoolMounts,
      capturedAt: "2026-08-31T05:00:00.000Z",
      bindingOperationId: "binding:blank-tool",
    });

    const completion = repository.recordUsageAttribution({
      printPlan,
      printJobId: "job:blank-tool",
      completedAt: "2026-08-31T05:30:00.000Z",
      attributionOperationId: "usage:blank-tool",
      materialUsages: [
        { toolId: "", usedLengthMm: 3210 },
      ],
    });

    expect(completion).toMatchObject({
      ok: false,
      status: "blocked",
      reasons: ["usage-entry-unmatched"],
    });
    expect(repository.toJSON().jobMaterialSegments).toEqual([]);
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

  it("同じsemantic completionはattributionOperationIdが変わってもledger eventを重複させない", () => {
    const { deviceId, materialSources, spoolMounts } = createCfsFixtures();
    const printPlan = createPlan(deviceId, materialSources, spoolMounts);
    const repository = createMaterialAccountingPrintBindingRepository();
    repository.recordPrintStartBindings({
      printPlan,
      printJobId: "job:semantic-retry",
      materialSources,
      spoolMounts,
      capturedAt: "2026-08-31T05:00:00.000Z",
      bindingOperationId: "binding:semantic-retry",
    });

    const first = repository.recordUsageAttribution({
      printPlan,
      printJobId: "job:semantic-retry",
      completedAt: "2026-08-31T05:30:00.000Z",
      attributionOperationId: "usage:semantic-retry-a",
      materialUsages: [
        { protocolToolAlias: "T1A", materialSourceId: materialSources[0].materialSourceId, usedLengthMm: 3210 },
      ],
    });
    const second = repository.recordUsageAttribution({
      printPlan,
      printJobId: "job:semantic-retry",
      completedAt: "2026-08-31T05:30:00.000Z",
      attributionOperationId: "usage:semantic-retry-b",
      materialUsages: [
        { protocolToolAlias: "T1A", materialSourceId: materialSources[0].materialSourceId, usedLengthMm: 3210 },
      ],
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.action).toBe("idempotent");
    expect(repository.toJSON().ledgerEvents).toHaveLength(first.ledgerEvents.length);
  });

  it("保存済みstore復元時に壊れたsnapshot/segment/ledger evidenceをauthorityへ戻さない", () => {
    const restored = normalizeStoredMaterialAccountingPrintBindingStore({
      printStartSnapshots: [
        { snapshotId: "", printJobId: "job:bad" },
        {
          snapshotId: "snapshot:valid",
          deviceId: "serial:k2pro-69e7",
          printJobId: "job:valid",
          printPlanId: "plan:valid",
          materialSourceId: "source:1a",
          mountId: "mount:1a",
          spoolId: "spool:1a",
          capturedAt: "2026-08-31T05:00:00.000Z",
        },
      ],
      jobMaterialSegments: [
        { segmentId: "", usedLengthMm: -1 },
        {
          segmentId: "segment:valid",
          printJobId: "job:valid",
          printPlanId: "plan:valid",
          deviceId: "serial:k2pro-69e7",
          materialSourceId: "source:1a",
          usedLengthMm: 3210,
          usageState: "observed-used",
        },
      ],
      ledgerEvents: [
        { ledgerEventId: "", eventType: "material-consumption" },
        {
          ledgerEventId: "ledger:valid",
          eventType: "material-consumption",
          segmentId: "segment:valid",
          printJobId: "job:valid",
          deviceId: "serial:k2pro-69e7",
          materialSourceId: "source:1a",
          usedLengthMm: 3210,
          createdAt: "2026-08-31T05:30:00.000Z",
        },
      ],
      usageEvidence: [
        { evidenceId: "", usedLengthMm: 1 },
        {
          evidenceId: "evidence:valid",
          materialSourceId: "source:1a",
          mountId: "mount:1a",
          snapshotId: "snapshot:valid",
          printJobId: "job:valid",
          deviceId: "serial:k2pro-69e7",
          usedLengthMm: 3210,
          attribution: "source-specific",
        },
      ],
    });

    expect(restored.printStartSnapshots).toHaveLength(1);
    expect(restored.jobMaterialSegments).toHaveLength(1);
    expect(restored.ledgerEvents).toHaveLength(1);
    expect(restored.usageEvidence).toHaveLength(1);
    expect(restored.retainedUnsupportedEntries).toHaveLength(4);
  });

  it("保存済みstore復元時にcross-record不整合をauthority配列へ戻さない", () => {
    const restored = normalizeStoredMaterialAccountingPrintBindingStore({
      printStartSnapshots: [
        {
          snapshotId: "snapshot:valid",
          deviceId: "serial:k2pro-69e7",
          printJobId: "job:valid",
          printPlanId: "plan:valid",
          materialSourceId: "source:1a",
          mountId: "mount:1a",
          spoolId: "spool:1a",
          capturedAt: "2026-08-31T05:00:00.000Z",
        },
      ],
      usageEvidence: [
        {
          evidenceId: "evidence:valid",
          materialSourceId: "source:1a",
          mountId: "mount:1a",
          snapshotId: "snapshot:valid",
          printJobId: "job:valid",
          deviceId: "serial:k2pro-69e7",
          usedLengthMm: 3210,
          attribution: "source-specific",
        },
        {
          evidenceId: "evidence:orphan",
          materialSourceId: "source:1a",
          mountId: "mount:1a",
          snapshotId: "snapshot:missing",
          printJobId: "job:valid",
          deviceId: "serial:k2pro-69e7",
          usedLengthMm: 3210,
          attribution: "source-specific",
        },
      ],
      jobMaterialSegments: [
        {
          segmentId: "segment:valid",
          printJobId: "job:valid",
          printPlanId: "plan:valid",
          deviceId: "serial:k2pro-69e7",
          materialSourceId: "source:1a",
          spoolId: "spool:1a",
          usedLengthMm: 3210,
          usageState: "observed-used",
          sourceSnapshotId: "snapshot:valid",
          evidence: { usageEvidenceId: "evidence:valid" },
        },
        {
          segmentId: "segment:orphan",
          printJobId: "job:valid",
          printPlanId: "plan:valid",
          deviceId: "serial:k2pro-69e7",
          materialSourceId: "source:1a",
          spoolId: "spool:1a",
          usedLengthMm: 3210,
          usageState: "observed-used",
          sourceSnapshotId: "snapshot:missing",
        },
      ],
      ledgerEvents: [
        {
          ledgerEventId: "ledger:valid",
          eventType: "material-consumption",
          segmentId: "segment:valid",
          printJobId: "job:valid",
          deviceId: "serial:k2pro-69e7",
          materialSourceId: "source:1a",
          spoolId: "spool:1a",
          usedLengthMm: 3210,
          usageState: "observed-used",
          createdAt: "2026-08-31T05:30:00.000Z",
        },
        {
          ledgerEventId: "ledger:orphan",
          eventType: "material-consumption",
          segmentId: "segment:missing",
          printJobId: "job:valid",
          deviceId: "serial:k2pro-69e7",
          materialSourceId: "source:1a",
          spoolId: "spool:1a",
          usedLengthMm: 3210,
          usageState: "observed-used",
          createdAt: "2026-08-31T05:30:00.000Z",
        },
      ],
    });

    expect(restored.usageEvidence).toEqual([expect.objectContaining({ evidenceId: "evidence:valid" })]);
    expect(restored.jobMaterialSegments).toEqual([expect.objectContaining({ segmentId: "segment:valid" })]);
    expect(restored.ledgerEvents).toEqual([expect.objectContaining({ ledgerEventId: "ledger:valid" })]);
    expect(restored.retainedUnsupportedEntries.map((entry) => [entry.recordType, entry.reason])).toEqual([
      ["usageEvidence", "cross-record-mismatch"],
      ["jobMaterialSegment", "cross-record-mismatch"],
      ["ledgerEvent", "cross-record-mismatch"],
    ]);
  });

  it("保存済みstore復元時にduplicate semantic IDのpayload conflictがあれば同ID全recordをauthorityから除外する", () => {
    const snapshot = {
      snapshotId: "snapshot:duplicate",
      deviceId: "serial:k2pro-69e7",
      printJobId: "job:duplicate",
      printPlanId: "plan:duplicate",
      materialSourceId: "source:1a",
      mountId: "mount:1a",
      spoolId: "spool:1a",
      capturedAt: "2026-08-31T05:00:00.000Z",
    };
    const conflictingSnapshot = {
      ...snapshot,
      materialSourceId: "source:1b",
    };

    const restored = normalizeStoredMaterialAccountingPrintBindingStore({
      printStartSnapshots: [snapshot, { ...snapshot }, conflictingSnapshot],
    });

    expect(restored.printStartSnapshots).toEqual([]);
    expect(restored.retainedUnsupportedEntries.map((entry) => [
      entry.recordType,
      entry.reason,
      entry.record.materialSourceId,
    ])).toEqual([
      ["printStartSnapshot", "duplicate-semantic-id-conflict", "source:1a"],
      ["printStartSnapshot", "duplicate-semantic-id-conflict", "source:1a"],
      ["printStartSnapshot", "duplicate-semantic-id-conflict", "source:1b"],
    ]);
  });

  it("保存済みoperation cacheはrestart後のidempotent shortcutに使わず全件隔離する", () => {
    const snapshot = {
      snapshotId: "snapshot:operation-valid",
      deviceId: "serial:k2pro-69e7",
      printJobId: "job:operation",
      printPlanId: "plan:operation",
      materialSourceId: "source:1a",
      mountId: "mount:1a",
      spoolId: "spool:1a",
      capturedAt: "2026-08-31T05:00:00.000Z",
    };
    const restored = normalizeStoredMaterialAccountingPrintBindingStore({
      printStartSnapshots: [snapshot],
      operationsById: {
        "operation:valid": {
          operationId: "operation:valid",
          digest: "digest:valid",
          result: {
            ok: true,
            status: "recorded",
            snapshots: [{ snapshotId: "snapshot:operation-valid" }],
          },
        },
        "operation:orphan": {
          operationId: "operation:orphan",
          digest: "digest:orphan",
          result: {
            ok: true,
            status: "recorded",
            snapshots: [{ snapshotId: "snapshot:missing" }],
          },
        },
      },
    });

    expect(Object.keys(restored.operationsById)).toEqual([]);
    expect(restored.retainedUnsupportedEntries.map((entry) => [entry.recordType, entry.reason])).toEqual([
      ["operationRecord", "operation-cache-dropped-on-restore"],
      ["operationRecord", "operation-cache-dropped-on-restore"],
    ]);
  });
});
