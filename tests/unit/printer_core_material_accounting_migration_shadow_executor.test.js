/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Universal MaterialSource migration shadow preflight 単体テスト
 * @file printer_core_material_accounting_migration_shadow_executor.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_material_accounting_migration_shadow_executor_test
 *
 * 【機能内容サマリ】
 * - Gate 18.9C のshadow preflightがjournal READYをblind trustしないことを検証
 * - current dry-run planとrepository状態を再評価してからshadow候補を返す境界を固定
 * - preflightがrepository/ledger writeやexecution field採番を行わないことを検証
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1514 (PR #438)
 * @since   1.390.1512 (PR #438)
 * @lastModified 2026-08-31 13:59:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { describe, expect, it } from "vitest";

import {
  MATERIAL_ACCOUNTING_MIGRATION_STATUS,
  MATERIAL_SOURCE_KIND,
  SPOOL_MOUNT_VERIFICATION,
  createSpoolMountRecord,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_contract.js";
import {
  createMaterialAccountingMigrationDryRunPlan,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_migration_planner.js";
import {
  recordMaterialAccountingMigrationDryRunPlan,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_migration_journal.js";
import {
  MATERIAL_ACCOUNTING_SHADOW_PREFLIGHT_STATUS,
  evaluateMaterialAccountingMigrationShadowPreflight,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_migration_shadow_executor.js";
import { createMaterialSourceRegistry } from "../../3dp_lib/printer_core/dashboard_material_source_registry.js";
import { createSpoolMountRepository } from "../../3dp_lib/printer_core/dashboard_spool_mount_repository.js";

/**
 * observed direct sourceを持つlegacy fixtureを生成する。
 *
 * 【詳細説明】
 * - operator confirmationに依存しないREADY planを作るため、fresh/completeなsource観測をfixture化する。
 * - createdAtを変えるテストでも同じhost-to-spool subjectがREADYのまま再評価できる。
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
      ...(overrides.appSettings || {}),
    },
    machines: {
      [host]: { printerType: "k1" },
      ...(overrides.machines || {}),
    },
    filamentSpools: [
      { id: spoolId, name: "CC3D Sand Color", remainingLengthMm: 336000 },
      ...(overrides.filamentSpools || []),
    ],
    hostSpoolMap: {
      [host]: spoolId,
      ...(overrides.hostSpoolMap || {}),
    },
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
    materialAccounting: overrides.materialAccounting || undefined,
  };
}

/**
 * READY planをjournalへ保存する。
 *
 * @function recordReadyPlan
 * @param {Object} plan - READY dry-run plan。
 * @param {string=} recordedAt - journal記録日時。
 * @param {Object|null=} journal - 既存journal。
 * @returns {Object} journal記録result。
 */
function recordReadyPlan(plan, recordedAt = "2026-08-31T03:01:00.000Z", journal = null) {
  expect(plan.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY);
  return recordMaterialAccountingMigrationDryRunPlan(journal, plan, { recordedAt });
}

/**
 * 空だが明示済みのrepository facadeを生成する。
 *
 * @function createEmptyRepositories
 * @returns {{materialSourceRegistry:Object,spoolMountRepository:Object}} repository facade群。
 */
function createEmptyRepositories() {
  return {
    materialSourceRegistry: createMaterialSourceRegistry([]),
    spoolMountRepository: createSpoolMountRepository([]),
  };
}

/**
 * READY entryとBLOCKED entryが混在するdry-run plan fixtureを生成する。
 *
 * @function createMixedStatusPlan
 * @returns {Object} mixed status migration dry-run plan。
 */
function createMixedStatusPlan() {
  return createMaterialAccountingMigrationDryRunPlan({
    appSettings: {
      connectionTargets: [
        {
          hostname: "K1Max-4A1B",
          printerType: "k1",
          printerCoreV3Identity: {
            deviceIdSeed: "serial:k1max-4a1b",
            identityStrength: "serial",
          },
        },
        {
          hostname: "K2Pro-69E7",
          printerType: "creality-k2",
          printerCoreV3Identity: {
            deviceIdSeed: "serial:k2pro-69e7",
            identityStrength: "serial",
          },
        },
      ],
    },
    machines: {
      "K1Max-4A1B": { printerType: "k1" },
      "K2Pro-69E7": { printerType: "creality-k2" },
    },
    filamentSpools: [
      { id: "spool-031", name: "CC3D Sand Color", remainingLengthMm: 336000 },
      { id: "spool-032", name: "CC3D Silver", remainingLengthMm: 280000 },
    ],
    hostSpoolMap: {
      "K1Max-4A1B": "spool-031",
      "K2Pro-69E7": "spool-032",
    },
    materialSourceObservations: {
      schemaVersion: 1,
      byDeviceId: {
        "serial:k1max-4a1b": {
          deviceId: "serial:k1max-4a1b",
          snapshotCompleteness: "complete",
          lastObservedAt: "2026-08-31T03:40:00.000Z",
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
  }, {
    createdAt: "2026-08-31T03:40:30.000Z",
    freshTtlMs: 60_000,
  });
}

describe("Material accounting migration shadow preflight", () => {
  it("latest READY journalとcurrent READY planが同じentry mappingならshadow planを返す", () => {
    const journalPlan = createMaterialAccountingMigrationDryRunPlan(createObservedDirectFixture(), {
      createdAt: "2026-08-31T03:00:30.000Z",
      freshTtlMs: 60_000,
    });
    const currentPlan = createMaterialAccountingMigrationDryRunPlan(createObservedDirectFixture(), {
      createdAt: "2026-08-31T03:00:45.000Z",
      freshTtlMs: 60_000,
    });
    const recorded = recordReadyPlan(journalPlan);
    const migrationSubjectId = journalPlan.entries[0].migrationSubjectId;

    const result = evaluateMaterialAccountingMigrationShadowPreflight({
      journal: recorded.journal,
      migrationSubjectId,
      currentPlan,
      evaluatedAt: "2026-08-31T03:00:46.000Z",
      ...createEmptyRepositories(),
    });

    expect(result).toMatchObject({
      ok: true,
      status: MATERIAL_ACCOUNTING_SHADOW_PREFLIGHT_STATUS.READY,
      evaluatedAt: "2026-08-31T03:00:46.000Z",
      reasons: [],
      requested: {
        migrationSubjectId,
        migrationId: journalPlan.migrationId,
        planRevisionId: journalPlan.planRevisionId,
      },
      evaluated: {
        migrationSubjectId,
        migrationId: currentPlan.migrationId,
        planRevisionId: currentPlan.planRevisionId,
      },
      invariants: {
        materialSourceRepositoryWrites: false,
        spoolMountRepositoryWrites: false,
        ledgerWrites: false,
        executionFieldsMinted: false,
      },
    });
    expect(result.shadowExecutionPlan).toMatchObject({
      migrationSubjectId,
      derivedFromPlanRevisionId: journalPlan.planRevisionId,
      evaluatedPlanRevisionId: currentPlan.planRevisionId,
      authority: {
        mode: "shadow-preflight-only",
        canWriteRepositories: false,
        canDebitLedger: false,
      },
    });
    expect(result.shadowExecutionPlan.plannedWrites.spoolMounts).toEqual([]);
    expect(result.shadowExecutionPlan.plannedWrites.mountIntents[0]).toMatchObject({
      verification: SPOOL_MOUNT_VERIFICATION.MIGRATED,
      openedAtPolicy: "shadow-execution-time",
      operationIdPolicy: "shadow-execution-time",
    });
    expect(result.shadowExecutionPlan.plannedWrites.mountIntents[0]).not.toHaveProperty("openedAt");
    expect(result.shadowExecutionPlan.plannedWrites.mountIntents[0]).not.toHaveProperty("mountOperationId");
  });

  it("mixed planでは対象entryがREADYならaggregate BLOCKEDでもpreflight READYにする", () => {
    const plan = createMixedStatusPlan();
    const readyEntry = plan.entries.find((entry) => entry.host === "K1Max-4A1B");
    const recorded = recordMaterialAccountingMigrationDryRunPlan(null, plan, {
      recordedAt: "2026-08-31T03:41:00.000Z",
    });

    const result = evaluateMaterialAccountingMigrationShadowPreflight({
      journal: recorded.journal,
      migrationSubjectId: readyEntry.migrationSubjectId,
      currentPlan: plan,
      evaluatedAt: "2026-08-31T03:40:31.000Z",
      ...createEmptyRepositories(),
    });

    expect(plan.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED);
    expect(result).toMatchObject({
      ok: true,
      status: MATERIAL_ACCOUNTING_SHADOW_PREFLIGHT_STATUS.READY,
      requested: {
        migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY,
      },
      evaluated: {
        migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY,
      },
    });
  });

  it("currentPlan.createdAtがpreflight evaluatedAtから離れすぎている場合は古いplan再利用としてblockedにする", () => {
    const journalPlan = createMaterialAccountingMigrationDryRunPlan(createObservedDirectFixture(), {
      createdAt: "2026-08-31T03:00:30.000Z",
      freshTtlMs: 60_000,
    });
    const currentPlan = createMaterialAccountingMigrationDryRunPlan(createObservedDirectFixture(), {
      createdAt: "2026-08-31T03:00:45.000Z",
      freshTtlMs: 60_000,
    });
    const recorded = recordReadyPlan(journalPlan);

    const result = evaluateMaterialAccountingMigrationShadowPreflight({
      journal: recorded.journal,
      migrationSubjectId: journalPlan.entries[0].migrationSubjectId,
      currentPlan,
      evaluatedAt: "2026-08-31T03:10:00.000Z",
      ...createEmptyRepositories(),
    });

    expect(result).toMatchObject({
      ok: false,
      status: MATERIAL_ACCOUNTING_SHADOW_PREFLIGHT_STATUS.BLOCKED,
    });
    expect(result.reasons).toContain("current-plan-not-fresh-for-preflight");
  });

  it("repository facade未指定ではconflict未検査としてblockedにする", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createObservedDirectFixture(), {
      createdAt: "2026-08-31T03:00:30.000Z",
      freshTtlMs: 60_000,
    });
    const recorded = recordReadyPlan(plan);

    const result = evaluateMaterialAccountingMigrationShadowPreflight({
      journal: recorded.journal,
      migrationSubjectId: plan.entries[0].migrationSubjectId,
      currentPlan: plan,
      evaluatedAt: "2026-08-31T03:00:31.000Z",
    });

    expect(result).toMatchObject({
      ok: false,
      status: MATERIAL_ACCOUNTING_SHADOW_PREFLIGHT_STATUS.BLOCKED,
      reasons: [
        "materialSourceRegistry-required",
        "spoolMountRepository-required",
      ],
    });
  });

  it("requested migrationがsubject最新でなければ古いjournal entryをshadowへ進めない", () => {
    const firstPlan = createMaterialAccountingMigrationDryRunPlan(createObservedDirectFixture(), {
      createdAt: "2026-08-31T03:00:30.000Z",
      freshTtlMs: 60_000,
    });
    const secondPlan = createMaterialAccountingMigrationDryRunPlan(createObservedDirectFixture(), {
      createdAt: "2026-08-31T03:00:45.000Z",
      freshTtlMs: 60_000,
    });
    const firstRecord = recordReadyPlan(firstPlan, "2026-08-31T03:01:00.000Z");
    const secondRecord = recordReadyPlan(secondPlan, "2026-08-31T03:01:05.000Z", firstRecord.journal);

    const result = evaluateMaterialAccountingMigrationShadowPreflight({
      journal: secondRecord.journal,
      migrationSubjectId: firstPlan.entries[0].migrationSubjectId,
      requestedMigrationId: firstPlan.migrationId,
      currentPlan: secondPlan,
      evaluatedAt: "2026-08-31T03:00:46.000Z",
      ...createEmptyRepositories(),
    });

    expect(result).toMatchObject({
      ok: false,
      status: MATERIAL_ACCOUNTING_SHADOW_PREFLIGHT_STATUS.BLOCKED,
      reasons: ["requested-revision-not-latest"],
    });
  });

  it("current re-planがREADYでなくなった場合はjournal READYを信用しない", () => {
    const journalPlan = createMaterialAccountingMigrationDryRunPlan(createObservedDirectFixture(), {
      createdAt: "2026-08-31T03:00:30.000Z",
      freshTtlMs: 60_000,
    });
    const currentPlan = createMaterialAccountingMigrationDryRunPlan(createObservedDirectFixture(), {
      createdAt: "2026-08-31T03:02:30.000Z",
      freshTtlMs: 60_000,
    });
    const recorded = recordReadyPlan(journalPlan);

    const result = evaluateMaterialAccountingMigrationShadowPreflight({
      journal: recorded.journal,
      migrationSubjectId: journalPlan.entries[0].migrationSubjectId,
      currentPlan,
      evaluatedAt: "2026-08-31T03:02:31.000Z",
      ...createEmptyRepositories(),
    });

    expect(currentPlan.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED);
    expect(result).toMatchObject({
      ok: false,
      status: MATERIAL_ACCOUNTING_SHADOW_PREFLIGHT_STATUS.BLOCKED,
    });
    expect(result.reasons).toContain("evaluated-entry-not-ready");
  });

  it("同じhost/spool subjectでもDevice identityが変わった場合はshadowへ進めない", () => {
    const journalPlan = createMaterialAccountingMigrationDryRunPlan(createObservedDirectFixture(), {
      createdAt: "2026-08-31T03:00:30.000Z",
      freshTtlMs: 60_000,
    });
    const currentPlan = createMaterialAccountingMigrationDryRunPlan(createObservedDirectFixture({
      deviceId: "serial:k1max-replaced",
    }), {
      createdAt: "2026-08-31T03:00:45.000Z",
      freshTtlMs: 60_000,
    });
    const recorded = recordReadyPlan(journalPlan);

    const result = evaluateMaterialAccountingMigrationShadowPreflight({
      journal: recorded.journal,
      migrationSubjectId: journalPlan.entries[0].migrationSubjectId,
      currentPlan,
      evaluatedAt: "2026-08-31T03:00:46.000Z",
      ...createEmptyRepositories(),
    });

    expect(result.reasons).toContain("entry-device-mismatch");
    expect(result.reasons).toContain("entry-materialSourceId-mismatch");
  });

  it("repository上にopen mount conflictがある場合はwrite前preflightで止める", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createObservedDirectFixture(), {
      createdAt: "2026-08-31T03:00:30.000Z",
      freshTtlMs: 60_000,
    });
    const recorded = recordReadyPlan(plan);
    const candidate = plan.entries[0].plannedWrites.mountCandidates[0];
    const repository = createSpoolMountRepository([
      createSpoolMountRecord({
        materialSourceId: candidate.materialSourceId,
        spoolId: "spool-other",
        mountOperationId: "mount:existing",
        openedAt: "2026-08-31T02:55:00.000Z",
      }),
    ]);

    const result = evaluateMaterialAccountingMigrationShadowPreflight({
      journal: recorded.journal,
      migrationSubjectId: plan.entries[0].migrationSubjectId,
      currentPlan: plan,
      evaluatedAt: "2026-08-31T03:00:31.000Z",
      materialSourceRegistry: createMaterialSourceRegistry([]),
      spoolMountRepository: repository,
    });

    expect(result).toMatchObject({
      ok: false,
      status: MATERIAL_ACCOUNTING_SHADOW_PREFLIGHT_STATUS.BLOCKED,
    });
    expect(result.reasons).toContain("material-source-open-mount-conflict");
  });

  it("registry上に同じlocatorの別sourceがある場合はsource write前preflightで止める", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createObservedDirectFixture(), {
      createdAt: "2026-08-31T03:00:30.000Z",
      freshTtlMs: 60_000,
    });
    const recorded = recordReadyPlan(plan);
    const source = plan.entries[0].plannedWrites.materialSources[0];
    const registry = createMaterialSourceRegistry([
      {
        ...source,
        materialSourceId: "material-source:other",
      },
    ]);

    const result = evaluateMaterialAccountingMigrationShadowPreflight({
      journal: recorded.journal,
      migrationSubjectId: plan.entries[0].migrationSubjectId,
      currentPlan: plan,
      evaluatedAt: "2026-08-31T03:00:31.000Z",
      materialSourceRegistry: registry,
      spoolMountRepository: createSpoolMountRepository([]),
    });

    expect(result).toMatchObject({
      ok: false,
      status: MATERIAL_ACCOUNTING_SHADOW_PREFLIGHT_STATUS.BLOCKED,
    });
    expect(result.reasons).toContain("material-source-registry-locator-conflict");
  });
});
