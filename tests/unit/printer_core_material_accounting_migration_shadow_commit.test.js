/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Universal MaterialSource migration shadow commit 単体テスト
 * @file printer_core_material_accounting_migration_shadow_commit.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_material_accounting_migration_shadow_commit_test
 *
 * 【機能内容サマリ】
 * - Gate 18.9D-2 のpersistent shadow commit境界を検証
 * - base snapshot CASとoperation retry冪等性を固定
 * - durable commit成功前にSHADOW lifecycleへ進まないことを検証
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1517 (PR #438)
 * @since   1.390.1515 (PR #438)
 * @lastModified 2026-08-31 22:54:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { describe, expect, it, vi } from "vitest";

import {
  MATERIAL_ACCOUNTING_MIGRATION_STATUS,
  MATERIAL_SOURCE_KIND,
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
import {
  commitMaterialAccountingMigrationShadowTransaction,
  normalizeStoredMaterialAccountingMigrationShadowCommitStore,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_migration_shadow_commit.js";
import { createMaterialSourceRegistry } from "../../3dp_lib/printer_core/dashboard_material_source_registry.js";
import { createSpoolMountRepository } from "../../3dp_lib/printer_core/dashboard_spool_mount_repository.js";

/**
 * D-2 commit用のREADY transaction fixtureを生成する。
 *
 * @function createReadyShadowTransaction
 * @returns {{transaction:Object, baseMaterialSourceRegistrySnapshot:Object, baseSpoolMountRepositorySnapshot:Object}} transaction fixture。
 */
function createReadyShadowTransaction() {
  const legacyData = {
    appSettings: {
      connectionTargets: [
        {
          hostname: "K1Max-4A1B",
          printerType: "k1",
          materialSystem: { mode: "single-spool", unitLimit: 0, accountingTopologyConfirmed: true },
          printerCoreV3Identity: {
            deviceIdSeed: "serial:k1max-4a1b",
            identityStrength: "serial",
          },
        },
      ],
    },
    machines: { "K1Max-4A1B": { printerType: "k1" } },
    filamentSpools: [{ id: "spool-031", name: "CC3D Sand Color", remainingLengthMm: 336000 }],
    hostSpoolMap: { "K1Max-4A1B": "spool-031" },
    materialSourceObservations: {
      schemaVersion: 1,
      byDeviceId: {
        "serial:k1max-4a1b": {
          deviceId: "serial:k1max-4a1b",
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
  const plan = createMaterialAccountingMigrationDryRunPlan(legacyData, {
    createdAt: "2026-08-31T03:00:30.000Z",
    freshTtlMs: 60_000,
  });
  const recorded = recordMaterialAccountingMigrationDryRunPlan(null, plan, {
    recordedAt: "2026-08-31T03:01:00.000Z",
  });
  const baseMaterialSourceRegistrySnapshot = { sources: [], conflicts: [] };
  const baseSpoolMountRepositorySnapshot = { mounts: [], conflicts: [] };
  const preflight = evaluateMaterialAccountingMigrationShadowPreflight({
    journal: recorded.journal,
    migrationSubjectId: plan.entries[0].migrationSubjectId,
    currentPlan: plan,
    evaluatedAt: "2026-08-31T03:00:31.000Z",
    materialSourceRegistry: createMaterialSourceRegistry(baseMaterialSourceRegistrySnapshot.sources),
    spoolMountRepository: createSpoolMountRepository(baseSpoolMountRepositorySnapshot.mounts),
  });
  const prepared = prepareMaterialAccountingMigrationShadowTransaction({
    preflightResult: preflight,
    shadowOperationId: "shadow-op:001",
    executedAt: "2026-08-31T03:02:00.000Z",
    executedBy: "operator",
    materialSourceRegistrySnapshot: baseMaterialSourceRegistrySnapshot,
    spoolMountRepositorySnapshot: baseSpoolMountRepositorySnapshot,
  });
  expect(preflight.ok).toBe(true);
  expect(prepared.ok).toBe(true);
  return {
    transaction: prepared.transaction,
    baseMaterialSourceRegistrySnapshot,
    baseSpoolMountRepositorySnapshot,
  };
}

describe("Material accounting migration shadow commit", () => {
  it("durable write成功後だけshadow storeへcommitし、migration lifecycleをSHADOWへ進める", async () => {
    const fixture = createReadyShadowTransaction();
    const persist = vi.fn(async () => ({ ok: true, backend: "indexedDB", reason: "saved", casApplied: true }));

    const result = await commitMaterialAccountingMigrationShadowTransaction({
      store: null,
      transaction: fixture.transaction,
      committedAt: "2026-08-31T03:02:01.000Z",
      persist,
    });

    expect(result).toMatchObject({
      ok: true,
      status: "committed",
      reasons: [],
      store: {
        authority: "migration-shadow-commit-store",
        materialSourceRegistrySnapshot: { sources: expect.any(Array), conflicts: [] },
        spoolMountRepositorySnapshot: { mounts: expect.any(Array), conflicts: [] },
        lifecycleBySubject: {
          [fixture.transaction.migrationSubjectId]: {
            migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.SHADOW,
          },
        },
        invariants: {
          ledgerWrites: false,
          legacyCutoverSealed: false,
        },
      },
    });
    expect(result.store.materialSourceRegistrySnapshot.sources).toHaveLength(1);
    expect(result.store.spoolMountRepositorySnapshot.mounts).toHaveLength(1);
    expect(result.store.events).toHaveLength(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0].lifecycleBySubject[fixture.transaction.migrationSubjectId].migrationStatus)
      .toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.SHADOW);
    expect(persist.mock.calls[0][1]).toMatchObject({
      requireAtomicCompareAndSwap: true,
      expectedCurrentRepositoryDigests: fixture.transaction.baseRepositoryDigests,
    });
  });

  it("store上のcurrent durable snapshotがbaseから変化していればcaller currentに関係なくCASでcommitを止める", async () => {
    const fixture = createReadyShadowTransaction();
    const persist = vi.fn(async () => ({ ok: true }));
    const staleStore = normalizeStoredMaterialAccountingMigrationShadowCommitStore({
      materialSourceRegistrySnapshot: {
        sources: fixture.transaction.records.materialSources,
        conflicts: [],
      },
      spoolMountRepositorySnapshot: fixture.baseSpoolMountRepositorySnapshot,
    });

    const result = await commitMaterialAccountingMigrationShadowTransaction({
      store: staleStore,
      transaction: fixture.transaction,
      currentMaterialSourceRegistrySnapshot: {
        sources: [],
        conflicts: [],
      },
      currentSpoolMountRepositorySnapshot: fixture.baseSpoolMountRepositorySnapshot,
      committedAt: "2026-08-31T03:02:01.000Z",
      persist,
    });

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      reasons: ["base-material-source-snapshot-changed"],
    });
    expect(result.store.lifecycleBySubject).toEqual({});
    expect(persist).not.toHaveBeenCalled();
  });

  it("durable writerがatomic CAS適用を返さない場合はcommitを止める", async () => {
    const fixture = createReadyShadowTransaction();
    const persist = vi.fn(async () => ({ ok: true, backend: "indexedDB" }));

    const result = await commitMaterialAccountingMigrationShadowTransaction({
      store: null,
      transaction: fixture.transaction,
      committedAt: "2026-08-31T03:02:01.000Z",
      persist,
    });

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      reasons: ["durable-cas-not-applied"],
    });
    expect(result.store.lifecycleBySubject).toEqual({});
  });

  it("plain objectへcloneされたprepared transactionはcommit authorityとして扱わない", async () => {
    const fixture = createReadyShadowTransaction();
    const persist = vi.fn(async () => ({ ok: true }));

    const result = await commitMaterialAccountingMigrationShadowTransaction({
      store: null,
      transaction: { ...fixture.transaction },
      committedAt: "2026-08-31T03:02:01.000Z",
      persist,
    });

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      reasons: ["transaction-result-untrusted"],
    });
    expect(result.store.lifecycleBySubject).toEqual({});
    expect(persist).not.toHaveBeenCalled();
  });

  it("durable write失敗時はSHADOW lifecycleへ進まず、入力storeを保持する", async () => {
    const fixture = createReadyShadowTransaction();
    const persist = vi.fn(async () => ({ ok: false, backend: "indexedDB", reason: "quota", casApplied: true }));

    const result = await commitMaterialAccountingMigrationShadowTransaction({
      store: null,
      transaction: fixture.transaction,
      committedAt: "2026-08-31T03:02:01.000Z",
      persist,
    });

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      reasons: ["durable-write-failed"],
      store: {
        lifecycleBySubject: {},
        events: [],
      },
    });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("同じtransaction retryはeventを増やさずidempotentに復元する", async () => {
    const fixture = createReadyShadowTransaction();
    const first = await commitMaterialAccountingMigrationShadowTransaction({
      store: null,
      transaction: fixture.transaction,
      committedAt: "2026-08-31T03:02:01.000Z",
      persist: async () => ({ ok: true, casApplied: true }),
    });
    const retryPersist = vi.fn(async () => ({ ok: true }));

    const second = await commitMaterialAccountingMigrationShadowTransaction({
      store: first.store,
      transaction: fixture.transaction,
      committedAt: "2026-08-31T03:05:01.000Z",
      persist: retryPersist,
    });

    expect(second).toMatchObject({
      ok: true,
      status: "idempotent",
      reasons: [],
    });
    expect(second.store.events).toHaveLength(1);
    expect(retryPersist).not.toHaveBeenCalled();
  });

  it("同じshadowOperationIdで異なるtransaction payloadはblockedにする", async () => {
    const fixture = createReadyShadowTransaction();
    const first = await commitMaterialAccountingMigrationShadowTransaction({
      store: null,
      transaction: fixture.transaction,
      committedAt: "2026-08-31T03:02:01.000Z",
      persist: async () => ({ ok: true, casApplied: true }),
    });
    const conflicting = {
      ...fixture.transaction,
      transactionId: "material-accounting-shadow-transaction:conflict",
      records: {
        ...fixture.transaction.records,
        spoolMounts: [
          {
            ...fixture.transaction.records.spoolMounts[0],
            spoolId: "spool-other",
          },
        ],
      },
    };

    const second = await commitMaterialAccountingMigrationShadowTransaction({
      store: first.store,
      transaction: conflicting,
      committedAt: "2026-08-31T03:05:01.000Z",
      persist: async () => ({ ok: true }),
    });

    expect(second).toMatchObject({
      ok: false,
      status: "blocked",
      reasons: ["shadow-operation-payload-conflict"],
    });
  });

  it("保存済みshadow commit storeを再起動後に正規化復元できる", async () => {
    const fixture = createReadyShadowTransaction();
    const committed = await commitMaterialAccountingMigrationShadowTransaction({
      store: null,
      transaction: fixture.transaction,
      committedAt: "2026-08-31T03:02:01.000Z",
      persist: async () => ({ ok: true, casApplied: true }),
    });

    const restored = normalizeStoredMaterialAccountingMigrationShadowCommitStore({
      ...committed.store,
      unsupportedFutureField: true,
    });

    expect(restored).toMatchObject({
      schemaVersion: 1,
      lifecycleBySubject: {
        [fixture.transaction.migrationSubjectId]: {
          migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.SHADOW,
        },
      },
      invariants: {
        ledgerWrites: false,
        legacyCutoverSealed: false,
      },
    });
    expect(restored.materialSourceRegistrySnapshot.sources).toHaveLength(1);
    expect(restored.spoolMountRepositorySnapshot.mounts).toHaveLength(1);
    expect(restored.events).toHaveLength(1);
  });
});
