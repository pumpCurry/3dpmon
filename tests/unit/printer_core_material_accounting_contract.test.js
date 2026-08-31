/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Universal MaterialSource accounting 契約単体テスト
 * @file printer_core_material_accounting_contract.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_material_accounting_contract_test
 *
 * 【機能内容サマリ】
 * - Gate 18.9A の FilamentUnit / MaterialSource / SpoolMount 純粋契約を検証
 * - K1 direct spool と K2/CFS multi-source を同一domain modelとして扱う不変条件を固定
 * - SpoolMount継続とdebit eligibilityを混同しない境界を固定
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1492 (PR #438)
 * @since   1.390.1490 (PR #438)
 * @lastModified 2026-08-31 09:53:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { describe, expect, it } from "vitest";

import {
  DEBIT_ELIGIBILITY_STATUS,
  FILAMENT_UNIT_KIND,
  MATERIAL_ACCOUNTING_BACKEND,
  MATERIAL_IDENTITY_STRENGTH,
  MATERIAL_SOURCE_KIND,
  SPOOL_MOUNT_STATUS,
  SPOOL_MOUNT_VERIFICATION,
  createDirectFeedUnitIdentity,
  createFilamentUnitRecord,
  createMaterialAccountingCutoverRecord,
  createMaterialSourceAccountingView,
  createMaterialSourceIdentity,
  createMaterialSourceLocator,
  createMaterialSourceRecord,
  createSpoolMountRecord,
  evaluateMaterialDebitEligibility,
  validateFilamentUnit,
  validateMaterialAccountingCutover,
  validateMaterialSource,
  validateSpoolMount,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_contract.js";

describe("Universal MaterialSource accounting contract", () => {
  it("K1 direct spoolを1つのprinter-direct unitと1つのsourceとして表現する", () => {
    const unitIdentity = createDirectFeedUnitIdentity({
      deviceId: "serial:k1max-4a1b",
      protocolFamily: "creality-k1",
    });
    const unit = createFilamentUnitRecord({
      deviceId: "serial:k1max-4a1b",
      kind: FILAMENT_UNIT_KIND.PRINTER_DIRECT,
      identity: unitIdentity,
      identityStrength: MATERIAL_IDENTITY_STRENGTH.STABLE,
      providerId: "legacy-k1-direct",
    });
    const source = createMaterialSourceRecord({
      deviceId: "serial:k1max-4a1b",
      unitId: unit.unitId,
      kind: MATERIAL_SOURCE_KIND.DIRECT_FEED,
      locator: createMaterialSourceLocator({ kind: MATERIAL_SOURCE_KIND.DIRECT_FEED, index: 0 }),
      identity: createMaterialSourceIdentity({
        deviceId: "serial:k1max-4a1b",
        unitId: unit.unitId,
        kind: MATERIAL_SOURCE_KIND.DIRECT_FEED,
        slotIndex: 0,
      }),
      identityStrength: MATERIAL_IDENTITY_STRENGTH.STABLE,
      displayLabel: "通常スプール",
    });

    expect(unit).toMatchObject({
      deviceId: "serial:k1max-4a1b",
      kind: "printer-direct",
      identityStrength: "stable",
      authority: { mode: "contract-only", canDriveLedger: false },
    });
    expect(source).toMatchObject({
      deviceId: "serial:k1max-4a1b",
      unitId: unit.unitId,
      kind: "direct-feed",
      displayLabel: "通常スプール",
      locator: { kind: "direct-feed", index: 0 },
      authority: { mode: "contract-only", canDriveLedger: false },
    });
    expect(validateFilamentUnit(unit)).toEqual({ ok: true, errors: [] });
    expect(validateMaterialSource(source)).toEqual({ ok: true, errors: [] });
  });

  it("K2 external + CFS 4台を17 sourceとして表現できる", () => {
    const deviceId = "serial:k2pro-69e7";
    const directUnit = createFilamentUnitRecord({
      deviceId,
      kind: FILAMENT_UNIT_KIND.PRINTER_DIRECT,
      identityStrength: MATERIAL_IDENTITY_STRENGTH.STABLE,
      identity: createDirectFeedUnitIdentity({ deviceId, protocolFamily: "creality-k2" }),
      providerId: "k2-external",
    });
    const cfsUnits = [1, 2, 3, 4].map((unitIndex) => createFilamentUnitRecord({
      deviceId,
      kind: FILAMENT_UNIT_KIND.CFS,
      unitIndex,
      identityStrength: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
      identity: { namespace: "cfs-unit", parts: [deviceId, unitIndex] },
      providerId: "k2-ws9999-boxsInfo",
    }));
    const sources = [
      createMaterialSourceRecord({
        deviceId,
        unitId: directUnit.unitId,
        kind: MATERIAL_SOURCE_KIND.EXTERNAL_SPOOL,
        locator: createMaterialSourceLocator({ kind: MATERIAL_SOURCE_KIND.EXTERNAL_SPOOL, index: 0 }),
        identity: createMaterialSourceIdentity({
          deviceId,
          unitId: directUnit.unitId,
          kind: MATERIAL_SOURCE_KIND.EXTERNAL_SPOOL,
          slotIndex: 0,
        }),
        identityStrength: MATERIAL_IDENTITY_STRENGTH.STABLE,
        displayLabel: "外部スプール",
      }),
      ...cfsUnits.flatMap((unit, unitOffset) => [0, 1, 2, 3].map((slotIndex) => createMaterialSourceRecord({
        deviceId,
        unitId: unit.unitId,
        kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
        locator: createMaterialSourceLocator({
          kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
          unitIndex: unitOffset + 1,
          boxId: unitOffset + 1,
          slotIndex,
        }),
        identity: createMaterialSourceIdentity({
          deviceId,
          unitId: unit.unitId,
          kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
          slotIndex,
        }),
        identityStrength: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
        displayLabel: `${unitOffset + 1}${String.fromCharCode(65 + slotIndex)}`,
      }))),
    ];

    expect(sources).toHaveLength(17);
    expect(new Set(sources.map((source) => source.materialSourceId)).size).toBe(17);
    expect(sources.map((source) => source.displayLabel)).toEqual([
      "外部スプール",
      "1A",
      "1B",
      "1C",
      "1D",
      "2A",
      "2B",
      "2C",
      "2D",
      "3A",
      "3B",
      "3C",
      "3D",
      "4A",
      "4B",
      "4C",
      "4D",
    ]);
    expect(sources.every((source) => validateMaterialSource(source).ok)).toBe(true);
  });

  it("MaterialSource identityと物理locatorや表示labelを分離する", () => {
    const source = createMaterialSourceRecord({
      deviceId: "serial:k2pro-69e7",
      unitId: "filament-unit:cfs-1",
      kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
      locator: createMaterialSourceLocator({
        kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
        unitIndex: 1,
        boxId: 1,
        slotIndex: 0,
      }),
      identity: createMaterialSourceIdentity({
        deviceId: "serial:k2pro-69e7",
        unitId: "filament-unit:cfs-1",
        kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
        slotIndex: 0,
      }),
      identityStrength: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
      displayLabel: "1A",
      aliases: ["T1A"],
    });

    expect(source.materialSourceId).toMatch(/^material-source:[0-9a-f]{32}$/u);
    expect(source.materialSourceId).not.toBe("1A");
    expect(source.materialSourceId).not.toBe("cfs:1:slot:0");
    expect(source.locator).toMatchObject({
      kind: "cfs-slot",
      unitIndex: 1,
      boxId: 1,
      slotIndex: 0,
    });
    expect(source.displayLabel).toBe("1A");
    expect(source.aliases).toEqual(["T1A"]);
  });

  it("provisional sourceへのmanual SpoolMountは許可し、fresh continuityなしのdebitはpendingにする", () => {
    const mount = createSpoolMountRecord({
      materialSourceId: "material-source:cfs-1a",
      spoolId: "spool:silver",
      status: SPOOL_MOUNT_STATUS.OPEN,
      verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
      sourceIdentityStrengthAtOpen: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
      openedAt: "2026-08-31T00:45:00.000Z",
      openedBy: "operator",
    });
    const pending = evaluateMaterialDebitEligibility({
      mount,
      materialSource: { materialSourceId: "material-source:cfs-1a", identityStrength: "provisional" },
      usageEvidence: {
        materialSourceId: "material-source:cfs-1a",
        mountId: mount.mountId,
        usedLengthMm: 3210,
        attribution: "source-specific",
        idempotencyKey: "usage:1",
      },
      printStartSnapshot: {
        snapshotId: "snapshot:1",
        materialSourceId: "material-source:cfs-1a",
        mountId: mount.mountId,
        spoolId: "spool:silver",
      },
      continuity: { freshTopology: false, sourceContinuity: true },
    });
    const accepted = evaluateMaterialDebitEligibility({
      mount,
      materialSource: { materialSourceId: "material-source:cfs-1a", identityStrength: "provisional" },
      usageEvidence: {
        materialSourceId: "material-source:cfs-1a",
        mountId: mount.mountId,
        usedLengthMm: 3210,
        attribution: "source-specific",
        idempotencyKey: "usage:1",
      },
      printStartSnapshot: {
        snapshotId: "snapshot:1",
        materialSourceId: "material-source:cfs-1a",
        mountId: mount.mountId,
        spoolId: "spool:silver",
      },
      continuity: { freshTopology: true, sourceContinuity: true },
    });

    expect(validateSpoolMount(mount)).toEqual({ ok: true, errors: [] });
    expect(pending).toMatchObject({
      status: DEBIT_ELIGIBILITY_STATUS.PENDING,
      canDebit: false,
      reasons: ["fresh-topology-required"],
    });
    expect(accepted).toMatchObject({
      status: DEBIT_ELIGIBILITY_STATUS.ELIGIBLE,
      canDebit: true,
      reasons: [],
    });
  });

  it("明示empty/unloadedはmountを閉じずにdebitだけをoperator再確認まで止める", () => {
    const mount = createSpoolMountRecord({
      materialSourceId: "material-source:cfs-1c",
      spoolId: "spool:silk",
      status: SPOOL_MOUNT_STATUS.OPEN,
      verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
      sourceIdentityStrengthAtOpen: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
      openedAt: "2026-08-31T00:50:00.000Z",
      openedBy: "operator",
    });
    const blocked = evaluateMaterialDebitEligibility({
      mount,
      materialSource: { materialSourceId: "material-source:cfs-1c", identityStrength: "provisional" },
      usageEvidence: {
        materialSourceId: "material-source:cfs-1c",
        mountId: mount.mountId,
        usedLengthMm: 1200,
        attribution: "source-specific",
        idempotencyKey: "usage:2",
      },
      printStartSnapshot: {
        snapshotId: "snapshot:2",
        materialSourceId: "material-source:cfs-1c",
        mountId: mount.mountId,
        spoolId: "spool:silk",
      },
      continuity: { freshTopology: true, sourceContinuity: true, physicalDiscontinuity: "explicit-empty" },
    });

    expect(mount.status).toBe("open");
    expect(mount.closedAt).toBeNull();
    expect(blocked).toMatchObject({
      status: DEBIT_ELIGIBILITY_STATUS.BLOCKED,
      canDebit: false,
      reasons: ["physical-discontinuity"],
    });
  });

  it("RFID未取得はcontinuityを壊さず、stable RFID mismatchはdebitを止める", () => {
    const mount = createSpoolMountRecord({
      materialSourceId: "material-source:cfs-1b",
      spoolId: "spool:rfid",
      status: SPOOL_MOUNT_STATUS.OPEN,
      verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
      sourceIdentityStrengthAtOpen: MATERIAL_IDENTITY_STRENGTH.STABLE,
      expectedRfid: "rfid-A",
      openedAt: "2026-08-31T00:55:00.000Z",
      openedBy: "operator",
    });
    const missing = evaluateMaterialDebitEligibility({
      mount,
      materialSource: { materialSourceId: "material-source:cfs-1b", identityStrength: "stable" },
      usageEvidence: {
        materialSourceId: "material-source:cfs-1b",
        mountId: mount.mountId,
        usedLengthMm: 6543,
        attribution: "source-specific",
        idempotencyKey: "usage:3",
      },
      printStartSnapshot: {
        snapshotId: "snapshot:3",
        materialSourceId: "material-source:cfs-1b",
        mountId: mount.mountId,
        spoolId: "spool:rfid",
      },
      continuity: { freshTopology: true, sourceContinuity: true, observedRfid: null },
    });
    const mismatch = evaluateMaterialDebitEligibility({
      mount,
      materialSource: { materialSourceId: "material-source:cfs-1b", identityStrength: "stable" },
      usageEvidence: {
        materialSourceId: "material-source:cfs-1b",
        mountId: mount.mountId,
        usedLengthMm: 6543,
        attribution: "source-specific",
        idempotencyKey: "usage:4",
      },
      printStartSnapshot: {
        snapshotId: "snapshot:4",
        materialSourceId: "material-source:cfs-1b",
        mountId: mount.mountId,
        spoolId: "spool:rfid",
      },
      continuity: { freshTopology: true, sourceContinuity: true, observedRfid: "rfid-B" },
    });

    expect(missing).toMatchObject({ status: "eligible", canDebit: true, reasons: [] });
    expect(mismatch).toMatchObject({ status: "blocked", canDebit: false, reasons: ["rfid-mismatch"] });
  });

  it("未確認mountやunknown identityではsource-aware debitを許可しない", () => {
    const unverifiedMount = createSpoolMountRecord({
      materialSourceId: "material-source:cfs-1a",
      spoolId: "spool:silver",
      status: SPOOL_MOUNT_STATUS.OPEN,
      verification: SPOOL_MOUNT_VERIFICATION.UNVERIFIED,
      sourceIdentityStrengthAtOpen: MATERIAL_IDENTITY_STRENGTH.UNKNOWN,
      openedAt: "2026-08-31T01:05:00.000Z",
    });
    const result = evaluateMaterialDebitEligibility({
      mount: unverifiedMount,
      materialSource: {
        materialSourceId: "material-source:cfs-1a",
        identityStrength: MATERIAL_IDENTITY_STRENGTH.UNKNOWN,
      },
      usageEvidence: {
        materialSourceId: "material-source:cfs-1a",
        mountId: unverifiedMount.mountId,
        usedLengthMm: 1000,
        attribution: "source-specific",
        idempotencyKey: "usage:unverified",
      },
      printStartSnapshot: {
        snapshotId: "snapshot:unverified",
        materialSourceId: "material-source:cfs-1a",
        mountId: unverifiedMount.mountId,
        spoolId: "spool:silver",
      },
      continuity: { freshTopology: true, sourceContinuity: true },
    });

    expect(result).toMatchObject({
      status: DEBIT_ELIGIBILITY_STATUS.BLOCKED,
      canDebit: false,
      reasons: ["mount-verification-required", "source-identity-required"],
    });
  });

  it("print-start snapshotとusage evidenceがmount/sourceへbindされていない場合はdebitを拒否する", () => {
    const mount = createSpoolMountRecord({
      materialSourceId: "material-source:cfs-1d",
      spoolId: "spool:yellow",
      status: SPOOL_MOUNT_STATUS.OPEN,
      verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
      sourceIdentityStrengthAtOpen: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
      openedAt: "2026-08-31T01:10:00.000Z",
      openedBy: "operator",
    });
    const missingBindings = evaluateMaterialDebitEligibility({
      mount,
      materialSource: {
        materialSourceId: "material-source:cfs-1d",
        identityStrength: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
      },
      usageEvidence: {
        usedLengthMm: 1234,
        attribution: "source-specific",
        idempotencyKey: "usage:missing-bindings",
      },
      printStartSnapshot: { snapshotId: "snapshot:missing-bindings" },
      continuity: { freshTopology: true, sourceContinuity: true },
    });
    const mismatchedBindings = evaluateMaterialDebitEligibility({
      mount,
      materialSource: {
        materialSourceId: "material-source:cfs-1d",
        identityStrength: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
      },
      usageEvidence: {
        materialSourceId: "material-source:cfs-1c",
        mountId: "spool-mount:other",
        usedLengthMm: 1234,
        attribution: "source-specific",
        idempotencyKey: "usage:mismatched-bindings",
      },
      printStartSnapshot: {
        snapshotId: "snapshot:mismatched-bindings",
        materialSourceId: "material-source:cfs-1c",
        mountId: "spool-mount:other",
        spoolId: "spool:other",
      },
      continuity: { freshTopology: true, sourceContinuity: true },
    });

    expect(missingBindings).toMatchObject({
      status: DEBIT_ELIGIBILITY_STATUS.BLOCKED,
      canDebit: false,
      reasons: [
        "print-start-snapshot-mount-required",
        "print-start-snapshot-source-required",
        "print-start-snapshot-spool-required",
        "usage-evidence-source-required",
        "usage-evidence-mount-required",
      ],
    });
    expect(mismatchedBindings).toMatchObject({
      status: DEBIT_ELIGIBILITY_STATUS.BLOCKED,
      canDebit: false,
      reasons: [
        "print-start-snapshot-mount-mismatch",
        "print-start-snapshot-source-mismatch",
        "print-start-snapshot-spool-mismatch",
        "usage-evidence-source-mismatch",
        "usage-evidence-mount-mismatch",
      ],
    });
  });

  it("legacy accounting cutover recordは旧intervalを最終legacy jobで封印する", () => {
    const cutover = createMaterialAccountingCutoverRecord({
      deviceId: "serial:k2pro-69e7",
      cutoverAt: "2026-08-31T01:00:00.000Z",
      cutoverPrintId: "print:legacy-last",
      fromBackend: MATERIAL_ACCOUNTING_BACKEND.LEGACY_SINGLE_SOURCE,
      toBackend: MATERIAL_ACCOUNTING_BACKEND.UNIVERSAL_SHADOW,
      migrationStatus: "sealed",
      reason: "universal-accounting-cutover",
    });

    expect(cutover).toMatchObject({
      deviceId: "serial:k2pro-69e7",
      cutoverPrintId: "print:legacy-last",
      fromBackend: "legacy-single-source",
      toBackend: "universal-shadow",
      migrationStatus: "sealed",
      authority: { mode: "contract-only", canActivateWrites: false },
    });
    expect(validateMaterialAccountingCutover(cutover)).toEqual({ ok: true, errors: [] });
  });

  it("MaterialSourceAccountingViewはconfirmed-unusedの0mmとunknownを分離する", () => {
    const view = createMaterialSourceAccountingView({
      deviceId: "serial:k2pro-69e7",
      backend: MATERIAL_ACCOUNTING_BACKEND.UNIVERSAL_SHADOW,
      sources: [
        {
          materialSourceId: "material-source:cfs-1a",
          displayLabel: "1A",
          usage: { state: "confirmed-used", usedLengthMm: 3210, confidence: "high" },
        },
        {
          materialSourceId: "material-source:cfs-1c",
          displayLabel: "1C",
          usage: { state: "confirmed-unused", usedLengthMm: 0, confidence: "exact" },
        },
        {
          materialSourceId: "material-source:cfs-1d",
          displayLabel: "1D",
          usage: { state: "unknown", usedLengthMm: null, confidence: "unknown" },
        },
      ],
      warnings: ["device-ledger-remaining-differs"],
    });

    expect(view.sources.map((source) => [source.displayLabel, source.usage.state, source.usage.usedLengthMm])).toEqual([
      ["1A", "confirmed-used", 3210],
      ["1C", "confirmed-unused", 0],
      ["1D", "unknown", null],
    ]);
    expect(view.warnings).toEqual(["device-ledger-remaining-differs"]);
  });
});
