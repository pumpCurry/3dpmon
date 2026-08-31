/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Universal MaterialSource migration shadow transaction 単体テスト
 * @file printer_core_material_accounting_migration_shadow_transaction.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_material_accounting_migration_shadow_transaction_test
 *
 * 【機能内容サマリ】
 * - Gate 18.9D のshadow transaction準備がpreflight resultだけを入力権威にすることを検証
 * - production保存へ直書きせず、staged repository snapshotとしてatomic候補を作る境界を固定
 * - mountOperationId/openedAtの実行時採番とrepository conflict時のfail-closedを検証
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1513 (PR #438)
 * @since   1.390.1513 (PR #438)
 * @lastModified 2026-08-31 14:55:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { describe, expect, it } from "vitest";

import {
  MATERIAL_ACCOUNTING_MIGRATION_STATUS,
  MATERIAL_SOURCE_KIND,
  SPOOL_MOUNT_STATUS,
  createSpoolMountRecord,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_contract.js";
import {
  createMaterialAccountingMigrationDryRunPlan,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_migration_planner.js";
import {
  recordMaterialAccountingMigrationDryRunPlan,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_migration_journal.js";
import {
  evaluateMaterialAccountingMigrationShadowPreflight,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_migration_shadow_executor.js";
import {
  prepareMaterialAccountingMigrationShadowTransaction,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_migration_shadow_transaction.js";

/**
 * observed direct sourceを持つlegacy fixtureを生成する。
 *
 * @function createObservedDirectFixture
 * @param {Object=} overrides - legacy data上書き。
 * @returns {Object} legacy monitorData互換fixture。
 */
function createObservedDirectFixture(overrides = {}) {
  const host = overrides.host || "K1Max-4A1B";
  const deviceId = overrides.deviceId || "serial:k1max-4a1b";
  const spoolId = overrides.spoolId || "spool-031";
  return {
    appSettings: {
      connectionTargets: [
        {
          hostname: host,
          printerType: "k1",
          printerCoreV3Identity: { deviceIdSeed: deviceId, identityStrength: "serial" },
        },
      ],
    },
    machines: { [host]: { printerType: "k1" } },
    filamentSpools: [{ id: spoolId, name: "CC3D Sand Color", remainingLengthMm: 336000 }],
    hostSpoolMap: { [host]: spoolId },
    materialSourceObservations: overrides.materialSourceObservations || {
      schemaVersion: 1,
      byDeviceId: {
        [deviceId]: {
          deviceId,
          snapshotCompleteness: "complete",
          lastObservedAt: "2026-08-31T03:00:00.000Z",
          latestBySourceId: {
            "direct:0": {
              sourceId: "direct:0",
              kind: MATERIAL_SOURCE_KIND.DIRECT_FEED,
              index: 0,
              sourceIdentityStrength: "stable",
            },
          },
        },
      },
    },
  };
}

/**
 * READY preflight fixtureを生成する。
 *
 * @function createReadyPreflight
 * @returns {Object} preflight fixture。
 */
function createReadyPreflight() {
  const plan = createMaterialAccountingMigrationDryRunPlan(createObservedDirectFixture(), {
    createdAt: "2026-08-31T03:00:30.000Z",
    freshTtlMs: 60_000,
  });
  const recorded = recordMaterialAccountingMigrationDryRunPlan(null, plan, {
    recordedAt: "2026-08-31T03:01:00.000Z",
  });
  expect(plan.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY);
  return {
    plan,
    preflight: evaluateMaterialAccountingMigrationShadowPreflight({
      journal: recorded.journal,
      migrationSubjectId: plan.entries[0].migrationSubjectId,
      currentPlan: plan,
    }),
  };
}

describe("Material accounting migration shadow transaction", () => {
  it("READY preflightからstaged source/mount transactionを生成する", () => {
    const { plan, preflight } = createReadyPreflight();

    const result = prepareMaterialAccountingMigrationShadowTransaction({
      preflightResult: preflight,
      shadowOperationId: "shadow-op:001",
      executedAt: "2026-08-31T03:02:00.000Z",
      executedBy: "operator",
    });

    expect(result).toMatchObject({
      ok: true,
      status: "prepared",
      transaction: {
        migrationSubjectId: plan.entries[0].migrationSubjectId,
        derivedFromPlanRevisionId: plan.planRevisionId,
        executedAt: "2026-08-31T03:02:00.000Z",
        records: {
          spoolMounts: [
            {
              status: SPOOL_MOUNT_STATUS.OPEN,
              spoolId: "spool-031",
              openedAt: "2026-08-31T03:02:00.000Z",
              openedBy: "operator",
            },
          ],
        },
        invariants: {
          productionAuthority: false,
          stagedRepositoryOnly: true,
          ledgerWrites: false,
        },
      },
    });
    expect(result.transaction.records.spoolMounts[0].mountOperationId).toMatch(/^material-accounting-shadow-mount:/);
    expect(result.transaction.repositorySnapshots.materialSources.sources).toHaveLength(1);
    expect(result.transaction.repositorySnapshots.spoolMounts.mounts).toHaveLength(1);
  });

  it("同じshadowOperationIdと同じpayloadは同じtransactionとmountOperationIdを生成する", () => {
    const { preflight } = createReadyPreflight();
    const first = prepareMaterialAccountingMigrationShadowTransaction({
      preflightResult: preflight,
      shadowOperationId: "shadow-op:retry",
      executedAt: "2026-08-31T03:02:00.000Z",
    });
    const second = prepareMaterialAccountingMigrationShadowTransaction({
      preflightResult: preflight,
      shadowOperationId: "shadow-op:retry",
      executedAt: "2026-08-31T03:02:00.000Z",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.transaction.transactionId).toBe(first.transaction.transactionId);
    expect(second.transaction.records.spoolMounts[0].mountOperationId).toBe(first.transaction.records.spoolMounts[0].mountOperationId);
  });

  it("blocked preflightはtransactionへ昇格しない", () => {
    const { preflight } = createReadyPreflight();
    const result = prepareMaterialAccountingMigrationShadowTransaction({
      preflightResult: { ...preflight, ok: false, status: "blocked", reasons: ["evaluated-entry-not-ready"] },
      shadowOperationId: "shadow-op:blocked",
      executedAt: "2026-08-31T03:02:00.000Z",
    });

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      reasons: ["preflight-not-ready"],
      transaction: null,
    });
  });

  it("staged MaterialSource registry conflictがあればmountを作らずblockedにする", () => {
    const { plan, preflight } = createReadyPreflight();
    const source = plan.entries[0].plannedWrites.materialSources[0];
    const result = prepareMaterialAccountingMigrationShadowTransaction({
      preflightResult: preflight,
      shadowOperationId: "shadow-op:source-conflict",
      executedAt: "2026-08-31T03:02:00.000Z",
      materialSourceRegistrySnapshot: {
        sources: [{ ...source, materialSourceId: "material-source:other" }],
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      reasons: ["material-source-registry-conflict"],
      transaction: null,
    });
  });

  it("staged SpoolMount repository conflictがあればpartial transactionを返さない", () => {
    const { plan, preflight } = createReadyPreflight();
    const candidate = plan.entries[0].plannedWrites.mountCandidates[0];
    const existingMount = createSpoolMountRecord({
      materialSourceId: candidate.materialSourceId,
      spoolId: "spool-other",
      mountOperationId: "mount:existing",
      openedAt: "2026-08-31T02:59:00.000Z",
    });

    const result = prepareMaterialAccountingMigrationShadowTransaction({
      preflightResult: preflight,
      shadowOperationId: "shadow-op:mount-conflict",
      executedAt: "2026-08-31T03:02:00.000Z",
      spoolMountRepositorySnapshot: {
        mounts: [existingMount],
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      reasons: ["spool-mount-repository-conflict"],
      transaction: null,
    });
  });

  it("invalid executedAtやoperation id不足はblockedとして扱う", () => {
    const { preflight } = createReadyPreflight();

    expect(prepareMaterialAccountingMigrationShadowTransaction({
      preflightResult: preflight,
      executedAt: "bad-date",
    })).toMatchObject({
      ok: false,
      status: "blocked",
      reasons: ["shadowOperationId-required", "executedAt-invalid"],
      transaction: null,
    });
  });
});
