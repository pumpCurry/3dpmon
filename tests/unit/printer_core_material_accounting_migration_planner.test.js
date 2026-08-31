/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Universal MaterialSource migration planner 単体テスト
 * @file printer_core_material_accounting_migration_planner.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_material_accounting_migration_planner_test
 *
 * 【機能内容サマリ】
 * - legacy hostSpoolMap を Universal MaterialSource へdry-run分類するpure plannerを検証
 * - K1 direct-only と K2/CFS multi-source を同じplanner入口で扱う境界を固定
 * - multi-source機器へlegacy 1本スプールをblind migrationしないことを固定
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1504 (PR #438)
 * @since   1.390.1502 (PR #438)
 * @lastModified 2026-08-31 11:58:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { describe, expect, it } from "vitest";

import {
  MATERIAL_ACCOUNTING_MIGRATION_BLOCKER,
  MATERIAL_ACCOUNTING_MIGRATION_STATUS,
  MATERIAL_SOURCE_KIND,
  SPOOL_MOUNT_STATUS,
  SPOOL_MOUNT_VERIFICATION,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_contract.js";
import {
  createMaterialAccountingMigrationDryRunPlan,
  validateMaterialAccountingMigrationDryRunPlan,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_migration_planner.js";

/**
 * legacy monitorData互換fixtureを生成する。
 *
 * 【詳細説明】
 * - 各テストが対象host/topologyだけを差し替えられるよう、最小構成を返す。
 *
 * @function createLegacyFixture
 * @param {Object=} overrides - 上書きするlegacy data。
 * @returns {Object} legacy monitorData互換fixture。
 */
function createLegacyFixture(overrides = {}) {
  return {
    appSettings: {
      connectionTargets: [],
      ...(overrides.appSettings || {}),
    },
    machines: {
      ...(overrides.machines || {}),
    },
    filamentSpools: [
      { id: "spool-031", name: "CC3D Sand Color", remainingLengthMm: 336000 },
    ],
    hostSpoolMap: {
      ...(overrides.hostSpoolMap || {}),
    },
    materialSourceObservations: overrides.materialSourceObservations || {
      schemaVersion: 1,
      byDeviceId: {},
    },
  };
}

describe("Material accounting migration dry-run planner", () => {
  it("K1 direct-only hostSpoolMapは1つのdirect sourceとmigrated mountへREADY分類する", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-4A1B",
            printerType: "k1",
            materialSystem: { mode: "single-spool", unitLimit: 0 },
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-4a1b" },
          },
        ],
      },
      machines: { "K1Max-4A1B": { printerType: "k1" } },
      hostSpoolMap: { "K1Max-4A1B": "spool-031" },
    }), { createdAt: "2026-08-31T03:25:00.000Z" });

    expect(plan).toMatchObject({
      status: "dry-run",
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY,
      summary: {
        ready: 1,
        candidate: 0,
        blocked: 0,
      },
      invariants: {
        activateUniversalWrites: false,
        preserveHostSpoolMap: true,
        hostSpoolMapIsCompatibilityProjection: true,
      },
    });
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({
      host: "K1Max-4A1B",
      spoolId: "spool-031",
      deviceId: "serial:k1max-4a1b",
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY,
      reasons: [],
    });
    expect(plan.entries[0].plannedWrites.filamentUnits).toHaveLength(1);
    expect(plan.entries[0].plannedWrites.materialSources).toHaveLength(1);
    expect(plan.entries[0].plannedWrites.materialSources[0]).toMatchObject({
      kind: MATERIAL_SOURCE_KIND.DIRECT_FEED,
      displayLabel: "通常スプール",
    });
    expect(plan.entries[0].plannedWrites.spoolMounts[0]).toMatchObject({
      spoolId: "spool-031",
      status: SPOOL_MOUNT_STATUS.OPEN,
      verification: SPOOL_MOUNT_VERIFICATION.MIGRATED,
    });
    expect(Object.keys(plan.entries[0].plannedWrites)).toEqual([
      "filamentUnits",
      "materialSources",
      "spoolMounts",
    ]);
    expect(validateMaterialAccountingMigrationDryRunPlan(plan)).toEqual({ ok: true, errors: [] });
  });

  it("createdAt省略時もREADY mountにrepository適用可能なopenedAtを入れる", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-4A1B",
            printerType: "k1",
            materialSystem: { mode: "single-spool", unitLimit: 0 },
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-4a1b" },
          },
        ],
      },
      hostSpoolMap: { "K1Max-4A1B": "spool-031" },
    }));

    expect(plan.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(plan.entries[0].plannedWrites.spoolMounts[0].openedAt).toBe(plan.createdAt);
    expect(validateMaterialAccountingMigrationDryRunPlan(plan)).toEqual({ ok: true, errors: [] });
  });

  it("hostSpoolMapのspoolId実体が無い場合はREADYにせずBLOCKEDにする", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-4A1B",
            printerType: "k1",
            materialSystem: { mode: "single-spool", unitLimit: 0 },
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-4a1b" },
          },
        ],
      },
      hostSpoolMap: { "K1Max-4A1B": "spool-missing" },
    }), { createdAt: "2026-08-31T03:29:00.000Z" });

    expect(plan.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED);
    expect(plan.entries[0]).toMatchObject({
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.LEGACY_SPOOL_MISSING],
      plannedWrites: {
        filamentUnits: [],
        materialSources: [],
        spoolMounts: [],
      },
    });
    expect(validateMaterialAccountingMigrationDryRunPlan(plan)).toEqual({ ok: true, errors: [] });
  });

  it("明示single-spool設定もfresh complete観測も無いK1をdirect-onlyと仮定しない", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-4A1B",
            printerType: "k1",
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-4a1b" },
          },
        ],
      },
      hostSpoolMap: { "K1Max-4A1B": "spool-031" },
    }), { createdAt: "2026-08-31T03:30:00.000Z" });

    expect(plan.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED);
    expect(plan.entries[0]).toMatchObject({
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.MATERIAL_TOPOLOGY_OBSERVATION_REQUIRED],
    });
    expect(plan.entries[0].plannedWrites.spoolMounts).toEqual([]);
  });

  it("K2/CFSの複数source観測があるhostSpoolMapはblind migrationせずCANDIDATEに留める", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K2Pro-69E7",
            printerType: "k2",
            printerCoreV3Identity: { deviceIdSeed: "serial:905251280E69E7" },
          },
        ],
      },
      hostSpoolMap: { "K2Pro-69E7": "spool-031" },
      materialSourceObservations: {
        schemaVersion: 1,
        byDeviceId: {
          "serial:905251280E69E7": {
            deviceId: "serial:905251280E69E7",
            host: "K2Pro-69E7",
            snapshotCompleteness: "complete",
            lastObservedAt: "2026-08-31T03:26:00.000Z",
            restoredFromStorage: false,
            latestBySourceId: {
              "external:0": { sourceId: "external:0", kind: "external-spool", displayLabel: "外部スプール" },
              "cfs:1:slot:0": { sourceId: "cfs:1:slot:0", kind: "cfs-slot", displayLabel: "1A" },
              "cfs:1:slot:1": { sourceId: "cfs:1:slot:1", kind: "cfs-slot", displayLabel: "1B" },
            },
          },
        },
      },
    }), { createdAt: "2026-08-31T03:26:00.000Z" });

    expect(plan.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE);
    expect(plan.entries[0]).toMatchObject({
      host: "K2Pro-69E7",
      spoolId: "spool-031",
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.LEGACY_SPOOL_MAP_AMBIGUOUS_FOR_MULTI_SOURCE],
    });
    expect(plan.entries[0].candidateSources.map((source) => source.sourceId)).toEqual([
      "external:0",
      "cfs:1:slot:0",
      "cfs:1:slot:1",
    ]);
    expect(plan.entries[0].plannedWrites.spoolMounts).toEqual([]);
    expect(validateMaterialAccountingMigrationDryRunPlan(plan)).toEqual({ ok: true, errors: [] });
  });

  it("K2として登録済みだがmaterial topology未観測ならdirect-onlyへ仮定せずBLOCKEDにする", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K2Pro-69E7",
            printerType: "k2",
            printerCoreV3Identity: { deviceIdSeed: "serial:905251280E69E7" },
          },
        ],
      },
      hostSpoolMap: { "K2Pro-69E7": "spool-031" },
    }), { createdAt: "2026-08-31T03:27:00.000Z" });

    expect(plan.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED);
    expect(plan.entries[0]).toMatchObject({
      host: "K2Pro-69E7",
      spoolId: "spool-031",
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.MATERIAL_TOPOLOGY_OBSERVATION_REQUIRED],
    });
    expect(plan.entries[0].plannedWrites.filamentUnits).toEqual([]);
    expect(plan.entries[0].plannedWrites.materialSources).toEqual([]);
    expect(plan.entries[0].plannedWrites.spoolMounts).toEqual([]);
    expect(validateMaterialAccountingMigrationDryRunPlan(plan)).toEqual({ ok: true, errors: [] });
  });

  it("単一source観測でもpartial/stale/restoredならREADYにしない", () => {
    for (const [label, observationPatch] of [
      ["partial", { snapshotCompleteness: "partial", lastObservedAt: "2026-08-31T03:31:00.000Z" }],
      ["stale", { snapshotCompleteness: "complete", lastObservedAt: "2026-08-31T03:00:00.000Z" }],
      ["restored", { snapshotCompleteness: "complete", lastObservedAt: "2026-08-31T03:31:00.000Z", restoredFromStorage: true }],
    ]) {
      const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
        appSettings: {
          connectionTargets: [
            {
              hostname: `K2Pro-${label}`,
              printerType: "k2",
              printerCoreV3Identity: { deviceIdSeed: `serial:k2-${label}` },
            },
          ],
        },
        hostSpoolMap: { [`K2Pro-${label}`]: "spool-031" },
        materialSourceObservations: {
          schemaVersion: 1,
          byDeviceId: {
            [`serial:k2-${label}`]: {
              deviceId: `serial:k2-${label}`,
              host: `K2Pro-${label}`,
              ...observationPatch,
              latestBySourceId: {
                "external:0": { sourceId: "external:0", kind: "external-spool", displayLabel: "外部スプール" },
              },
            },
          },
        },
      }), { createdAt: "2026-08-31T03:32:00.000Z", freshTtlMs: 45_000 });

      expect(plan.entries[0]).toMatchObject({
        migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
        reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.MATERIAL_TOPOLOGY_OBSERVATION_REQUIRED],
      });
      expect(plan.entries[0].plannedWrites.spoolMounts).toEqual([]);
    }
  });

  it("source checksumはconnectionTargetsとmachinesのidentity証拠変更も反映する", () => {
    const base = createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-4A1B",
            printerType: "k1",
            materialSystem: { mode: "single-spool", unitLimit: 0 },
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-4a1b" },
          },
        ],
      },
      machines: { "K1Max-4A1B": { printerType: "k1" } },
      hostSpoolMap: { "K1Max-4A1B": "spool-031" },
    });
    const changed = createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-4A1B",
            printerType: "k2",
            materialSystem: { mode: "single-spool", unitLimit: 0 },
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-4a1b" },
          },
        ],
      },
      machines: { "K1Max-4A1B": { printerType: "k2" } },
      hostSpoolMap: { "K1Max-4A1B": "spool-031" },
    });

    const basePlan = createMaterialAccountingMigrationDryRunPlan(base, { createdAt: "2026-08-31T03:33:00.000Z" });
    const changedPlan = createMaterialAccountingMigrationDryRunPlan(changed, { createdAt: "2026-08-31T03:33:00.000Z" });

    expect(basePlan.source.checksum).not.toBe(changedPlan.source.checksum);
    expect(basePlan.migrationId).not.toBe(changedPlan.migrationId);
  });

  it("dry-run plannerはshadow/failed/sealedの実行結果statusをvalidにしない", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      hostSpoolMap: { "K1Max-4A1B": "spool-031" },
    }), { createdAt: "2026-08-31T03:28:00.000Z" });
    const invalid = {
      ...plan,
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.SHADOW,
      entries: [
        {
          ...plan.entries[0],
          migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.SEALED,
        },
      ],
    };

    expect(validateMaterialAccountingMigrationDryRunPlan(invalid)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "plan-status-not-dry-run-decision",
        "entry-status-not-dry-run-decision",
      ]),
    });
  });
});
