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
 * @version 1.390.1510 (PR #438)
 * @since   1.390.1502 (PR #438)
 * @lastModified 2026-08-31 13:22:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { describe, expect, it } from "vitest";

import {
  MATERIAL_ACCOUNTING_MIGRATION_BLOCKER,
  MATERIAL_ACCOUNTING_MIGRATION_STATUS,
  MATERIAL_SOURCE_KIND,
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
    materialAccounting: overrides.materialAccounting || undefined,
  };
}

/**
 * migration専用のsingle-spool確認fixtureを生成する。
 *
 * 【詳細説明】
 * - Gate18.9では通常設定の`materialSystem.mode`ではなく、migration subject/revisionへ
 *   紐づいた明示確認だけをREADY昇格の根拠にする。
 *
 * @function createSingleSpoolConfirmation
 * @param {Object=} overrides - 上書きする確認field。
 * @returns {Object} migration topology confirmation。
 */
function createSingleSpoolConfirmation(overrides = {}) {
  return {
    confirmationId: "confirmation:k1max-4a1b-single-spool",
    deviceId: "serial:k1max-4a1b",
    mode: "single-spool",
    confirmedBy: "operator",
    confirmedAt: "2026-08-31T03:24:00.000Z",
    ...overrides,
  };
}

/**
 * migration subject/evidenceへbindしたsingle-spool確認つきfixtureを生成する。
 *
 * 【詳細説明】
 * - confirmationはplan revisionそのものではなく、confirmation前のdecision evidenceへbindする。
 * - これにより、confirmationがchecksumに含まれても循環参照を作らず、証拠が変わった場合は再確認が必要になる。
 *
 * @function createConfirmedSingleSpoolFixture
 * @param {Object=} overrides - legacy fixture上書き。
 * @param {Object=} planOptions - dry-run plan生成option。
 * @param {Object=} confirmationOverrides - confirmation上書き。
 * @returns {Object} migration confirmationを含むlegacy fixture。
 */
function createConfirmedSingleSpoolFixture(overrides = {}, planOptions = {}, confirmationOverrides = {}) {
  const preview = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture(overrides), planOptions);
  const firstEntry = preview.entries[0] || {};
  const existingAccounting = overrides.materialAccounting && typeof overrides.materialAccounting === "object"
    ? overrides.materialAccounting
    : {};
  const existingConfirmations = Array.isArray(existingAccounting.migrationTopologyConfirmations)
    ? existingAccounting.migrationTopologyConfirmations
    : [];
  return createLegacyFixture({
    ...overrides,
    materialAccounting: {
      ...existingAccounting,
      migrationTopologyConfirmations: [
        createSingleSpoolConfirmation({
          deviceId: firstEntry.deviceId,
          host: firstEntry.host,
          migrationSubjectId: firstEntry.migrationSubjectId,
          evidenceChecksum: firstEntry.confirmationEvidenceChecksum,
          planRevisionId: firstEntry.confirmationRevisionId,
          ...confirmationOverrides,
        }),
        ...existingConfirmations,
      ],
    },
  });
}

describe("Material accounting migration dry-run planner", () => {
  it("K1 direct-only hostSpoolMapは1つのdirect sourceとmigrated mountへREADY分類する", () => {
    const planOptions = { createdAt: "2026-08-31T03:25:00.000Z" };
    const plan = createMaterialAccountingMigrationDryRunPlan(createConfirmedSingleSpoolFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-4A1B",
            printerType: "k1",
            materialSystem: { mode: "single-spool", unitLimit: 0 },
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-4a1b", identityStrength: "serial" },
          },
        ],
      },
      machines: { "K1Max-4A1B": { printerType: "k1" } },
      hostSpoolMap: { "K1Max-4A1B": "spool-031" },
    }, planOptions), planOptions);

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
    expect(plan.entries[0].plannedWrites.spoolMounts).toEqual([]);
    expect(plan.entries[0].plannedWrites.mountCandidates[0]).toMatchObject({
      spoolId: "spool-031",
      verification: SPOOL_MOUNT_VERIFICATION.MIGRATED,
      openedAtPolicy: "shadow-execution-time",
      operationIdPolicy: "shadow-execution-time",
    });
    expect(plan.entries[0].plannedWrites.mountCandidates[0]).not.toHaveProperty("openedAt");
    expect(plan.entries[0].plannedWrites.mountCandidates[0]).not.toHaveProperty("mountOperationId");
    expect(Object.keys(plan.entries[0].plannedWrites)).toEqual([
      "filamentUnits",
      "materialSources",
      "spoolMounts",
      "mountCandidates",
    ]);
    expect(validateMaterialAccountingMigrationDryRunPlan(plan)).toEqual({ ok: true, errors: [] });
  });

  it("同じsubjectでもcreatedAtでfreshness decisionが変わるplanは別revisionとして記録する", () => {
    const legacyData = createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-4A1B",
            printerType: "k1",
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-4a1b", identityStrength: "serial" },
          },
        ],
      },
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
    });
    const fresh = createMaterialAccountingMigrationDryRunPlan(legacyData, {
      createdAt: "2026-08-31T03:00:30.000Z",
      freshTtlMs: 60_000,
    });
    const stale = createMaterialAccountingMigrationDryRunPlan(legacyData, {
      createdAt: "2026-08-31T03:02:00.000Z",
      freshTtlMs: 60_000,
    });

    expect(fresh.migrationSubjectId).toBe(stale.migrationSubjectId);
    expect(fresh.planRevisionId).not.toBe(stale.planRevisionId);
    expect(fresh.migrationId).not.toBe(stale.migrationId);
    expect(fresh.source.checksum).not.toBe(stale.source.checksum);
    expect(fresh.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY);
    expect(stale.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED);
  });

  it("同一evidenceの再planではmountCandidateを返し、openedAt/mountOperationIdをdry-runで固定しない", () => {
    const planOptions = { createdAt: "2026-08-31T03:25:00.000Z" };
    const legacyData = createConfirmedSingleSpoolFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-4A1B",
            printerType: "k1",
            materialSystem: { mode: "single-spool", unitLimit: 0 },
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-4a1b", identityStrength: "serial" },
          },
        ],
      },
      hostSpoolMap: { "K1Max-4A1B": "spool-031" },
    }, planOptions);
    const first = createMaterialAccountingMigrationDryRunPlan(legacyData, {
      createdAt: "2026-08-31T03:25:00.000Z",
    });
    const second = createMaterialAccountingMigrationDryRunPlan(legacyData, {
      createdAt: "2026-08-31T03:25:00.000Z",
    });

    expect(first.migrationSubjectId).toBe(second.migrationSubjectId);
    expect(first.migrationId).toBe(second.migrationId);
    expect(first.entries[0].plannedWrites.spoolMounts).toEqual([]);
    expect(second.entries[0].plannedWrites.spoolMounts).toEqual([]);
    expect(first.entries[0].plannedWrites.mountCandidates[0]).toMatchObject({
      spoolId: "spool-031",
      openedAtPolicy: "shadow-execution-time",
      operationIdPolicy: "shadow-execution-time",
    });
    expect(second.entries[0].plannedWrites.mountCandidates[0]).toEqual(first.entries[0].plannedWrites.mountCandidates[0]);
    expect(validateMaterialAccountingMigrationDryRunPlan(first)).toEqual({ ok: true, errors: [] });
    expect(validateMaterialAccountingMigrationDryRunPlan(second)).toEqual({ ok: true, errors: [] });
  });

  it("migration subject/evidenceへbindされていないsingle-spool確認はREADYにしない", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-4A1B",
            printerType: "k1",
            materialSystem: { mode: "single-spool", unitLimit: 0 },
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-4a1b", identityStrength: "serial" },
          },
        ],
      },
      hostSpoolMap: { "K1Max-4A1B": "spool-031" },
      materialAccounting: {
        migrationTopologyConfirmations: [createSingleSpoolConfirmation()],
      },
    }), { createdAt: "2026-08-31T03:25:00.000Z" });

    expect(plan).toMatchObject({
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE,
      source: {
        confirmationEvidenceChecksum: expect.stringMatching(/^fnv1a128:/),
      },
    });
    expect(plan.entries[0]).toMatchObject({
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.LEGACY_SPOOL_MAP_REQUIRES_SOURCE_CONFIRMATION],
    });
  });

  it("証拠snapshotが変わったsingle-spool確認は再利用せず再確認を要求する", () => {
    const firstOptions = { createdAt: "2026-08-31T03:25:00.000Z" };
    const staleOptions = { createdAt: "2026-08-31T03:30:00.000Z" };
    const legacyData = createConfirmedSingleSpoolFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-4A1B",
            printerType: "k1",
            materialSystem: { mode: "single-spool", unitLimit: 0 },
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-4a1b", identityStrength: "serial" },
          },
        ],
      },
      hostSpoolMap: { "K1Max-4A1B": "spool-031" },
    }, firstOptions);

    const first = createMaterialAccountingMigrationDryRunPlan(legacyData, firstOptions);
    const stale = createMaterialAccountingMigrationDryRunPlan(legacyData, staleOptions);

    expect(first.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY);
    expect(stale.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE);
    expect(first.migrationSubjectId).toBe(stale.migrationSubjectId);
    expect(first.source.confirmationEvidenceChecksum).not.toBe(stale.source.confirmationEvidenceChecksum);
  });

  it("entry migration subjectはplan全体ではなくhost-to-spool単位で安定する", () => {
    const baseData = createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-4A1B",
            printerType: "k1",
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-4a1b", identityStrength: "serial" },
          },
          {
            hostname: "K1Max-03FA",
            printerType: "k1",
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-03fa", identityStrength: "serial" },
          },
        ],
      },
      filamentSpools: [
        { id: "spool-031", name: "CC3D Sand Color", remainingLengthMm: 336000 },
        { id: "spool-032", name: "CC3D Bone Color", remainingLengthMm: 300000 },
        { id: "spool-033", name: "CC3D Silver", remainingLengthMm: 280000 },
      ],
      hostSpoolMap: {
        "K1Max-4A1B": "spool-031",
        "K1Max-03FA": "spool-032",
      },
      materialSourceObservations: {
        schemaVersion: 1,
        byDeviceId: {
          "serial:k1max-4a1b": {
            deviceId: "serial:k1max-4a1b",
            snapshotCompleteness: "complete",
            lastObservedAt: "2026-08-31T03:37:00.000Z",
            latestBySourceId: {
              "direct:0": {
                sourceId: "direct:0",
                kind: MATERIAL_SOURCE_KIND.DIRECT_FEED,
                index: 0,
                sourceIdentityStrength: "stable",
              },
            },
          },
          "serial:k1max-03fa": {
            deviceId: "serial:k1max-03fa",
            snapshotCompleteness: "complete",
            lastObservedAt: "2026-08-31T03:37:00.000Z",
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
    });
    const changedData = {
      ...baseData,
      hostSpoolMap: {
        "K1Max-4A1B": "spool-031",
        "K1Max-03FA": "spool-033",
      },
    };

    const base = createMaterialAccountingMigrationDryRunPlan(baseData, { createdAt: "2026-08-31T03:37:30.000Z" });
    const changed = createMaterialAccountingMigrationDryRunPlan(changedData, { createdAt: "2026-08-31T03:37:30.000Z" });
    const baseA = base.entries.find((entry) => entry.host === "K1Max-4A1B");
    const changedA = changed.entries.find((entry) => entry.host === "K1Max-4A1B");
    const baseB = base.entries.find((entry) => entry.host === "K1Max-03FA");
    const changedB = changed.entries.find((entry) => entry.host === "K1Max-03FA");

    expect(base.migrationBatchId).not.toBe(changed.migrationBatchId);
    expect(baseA.migrationSubjectId).toBe(changedA.migrationSubjectId);
    expect(baseB.migrationSubjectId).not.toBe(changedB.migrationSubjectId);
  });

  it("serial prefixだけのdeviceIdはstable proofとしてREADYにしない", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-PrefixOnly",
            printerType: "k1",
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-prefix-only" },
          },
        ],
      },
      hostSpoolMap: { "K1Max-PrefixOnly": "spool-031" },
      materialSourceObservations: {
        schemaVersion: 1,
        byDeviceId: {
          "serial:k1max-prefix-only": {
            deviceId: "serial:k1max-prefix-only",
            snapshotCompleteness: "complete",
            lastObservedAt: "2026-08-31T03:37:00.000Z",
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
    }), { createdAt: "2026-08-31T03:37:30.000Z" });

    expect(plan.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED);
    expect(plan.entries[0]).toMatchObject({
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.DEVICE_IDENTITY_INSUFFICIENT],
    });
  });

  it("保存済みsingle-spool設定でもoperator確認が無ければREADYにしない", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-UnconfirmedSingle",
            printerType: "k1",
            materialSystem: { mode: "single-spool", unitLimit: 0 },
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-unconfirmed-single", identityStrength: "serial" },
          },
        ],
      },
      hostSpoolMap: { "K1Max-UnconfirmedSingle": "spool-031" },
    }), { createdAt: "2026-08-31T03:25:00.000Z" });

    expect(plan.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE);
    expect(plan.entries[0]).toMatchObject({
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.LEGACY_SPOOL_MAP_REQUIRES_SOURCE_CONFIRMATION],
      plannedWrites: {
        filamentUnits: [],
        materialSources: [],
        spoolMounts: [],
        mountCandidates: [],
      },
    });
  });

  it("materialSystem内の旧boolean確認だけではsingle-spool migrationをREADYにしない", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-LegacyBoolean",
            printerType: "k1",
            materialSystem: { mode: "single-spool", unitLimit: 0 },
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-legacy-boolean", identityStrength: "serial" },
          },
        ],
      },
      hostSpoolMap: { "K1Max-LegacyBoolean": "spool-031" },
    }), { createdAt: "2026-08-31T03:25:00.000Z" });

    expect(plan.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE);
    expect(plan.entries[0]).toMatchObject({
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.LEGACY_SPOOL_MAP_REQUIRES_SOURCE_CONFIRMATION],
      plannedWrites: {
        filamentUnits: [],
        materialSources: [],
        spoolMounts: [],
        mountCandidates: [],
      },
    });
  });

  it("同一hostに複数のstrong device identity候補がある場合はfirst-matchせずBLOCKEDにする", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-Ambiguous",
            dest: "K1Max-Ambiguous:9999",
            printerType: "k1",
            materialSystem: { mode: "single-spool", unitLimit: 0 },
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-ambiguous-a", identityStrength: "serial" },
          },
          {
            hostname: "K1Max-Ambiguous",
            dest: "K1Max-Ambiguous:9999",
            printerType: "k1",
            materialSystem: { mode: "single-spool", unitLimit: 0 },
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-ambiguous-b", identityStrength: "serial" },
          },
        ],
      },
      hostSpoolMap: { "K1Max-Ambiguous": "spool-031" },
      materialAccounting: {
        migrationTopologyConfirmations: [
          createSingleSpoolConfirmation({ deviceId: "serial:k1max-ambiguous-a" }),
        ],
      },
    }), { createdAt: "2026-08-31T03:25:00.000Z" });

    expect(plan.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED);
    expect(plan.entries[0]).toMatchObject({
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.LEGACY_HOST_DEVICE_AMBIGUOUS],
      deviceCandidates: [
        expect.objectContaining({ deviceId: "serial:k1max-ambiguous-a" }),
        expect.objectContaining({ deviceId: "serial:k1max-ambiguous-b" }),
      ],
      plannedWrites: {
        filamentUnits: [],
        materialSources: [],
        spoolMounts: [],
        mountCandidates: [],
      },
    });
  });

  it("connection targetにopen device identity conflictが残る場合はREADYにしない", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-DeviceConflict",
            printerType: "k1",
            materialSystem: { mode: "single-spool", unitLimit: 0 },
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-device-conflict", identityStrength: "serial" },
            printerCoreV3IdentityConflicts: [
              { status: "open", candidateIdentity: { deviceIdSeed: "serial:k1max-other" } },
            ],
          },
        ],
      },
      hostSpoolMap: { "K1Max-DeviceConflict": "spool-031" },
      materialAccounting: {
        migrationTopologyConfirmations: [
          createSingleSpoolConfirmation({ deviceId: "serial:k1max-device-conflict" }),
        ],
      },
    }), { createdAt: "2026-08-31T03:25:00.000Z" });

    expect(plan.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED);
    expect(plan.entries[0]).toMatchObject({
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.SOURCE_IDENTITY_CONFLICT],
      plannedWrites: {
        filamentUnits: [],
        materialSources: [],
        spoolMounts: [],
        mountCandidates: [],
      },
    });
  });

  it("hostSpoolMapのspoolId実体が無い場合はREADYにせずBLOCKEDにする", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-4A1B",
            printerType: "k1",
            materialSystem: { mode: "single-spool", unitLimit: 0, accountingTopologyConfirmed: true },
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-4a1b", identityStrength: "serial" },
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
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-4a1b", identityStrength: "serial" },
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

  it("provisional device identityでは明示single-spoolでもREADYにしない", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-Provisional",
            printerType: "k1",
            materialSystem: { mode: "single-spool", unitLimit: 0, accountingTopologyConfirmed: true },
            printerCoreV3Identity: {
              deviceIdSeed: "provisional:k1%20max:k1max-provisional",
              identityStrength: "provisional",
            },
          },
        ],
      },
      hostSpoolMap: { "K1Max-Provisional": "spool-031" },
    }), { createdAt: "2026-08-31T03:30:30.000Z" });

    expect(plan.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED);
    expect(plan.entries[0]).toMatchObject({
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.DEVICE_IDENTITY_INSUFFICIENT],
      plannedWrites: {
        filamentUnits: [],
        materialSources: [],
        spoolMounts: [],
      },
    });
  });

  it("K2/CFSの複数source観測があるhostSpoolMapはblind migrationせずCANDIDATEに留める", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K2Pro-69E7",
            printerType: "k2",
            printerCoreV3Identity: { deviceIdSeed: "serial:905251280E69E7", identityStrength: "serial" },
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
            printerCoreV3Identity: { deviceIdSeed: "serial:905251280E69E7", identityStrength: "serial" },
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
              printerCoreV3Identity: { deviceIdSeed: `serial:k2-${label}`, identityStrength: "serial" },
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

  it("fresh completeな単一sourceでもsource identityがprovisionalならREADYにしない", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K2Pro-External",
            printerType: "k2",
            printerCoreV3Identity: {
              deviceIdSeed: "serial:k2pro-external",
              identityStrength: "serial",
            },
          },
        ],
      },
      hostSpoolMap: { "K2Pro-External": "spool-031" },
      materialSourceObservations: {
        schemaVersion: 1,
        byDeviceId: {
          "serial:k2pro-external": {
            deviceId: "serial:k2pro-external",
            host: "K2Pro-External",
            snapshotCompleteness: "complete",
            lastObservedAt: "2026-08-31T03:34:00.000Z",
            restoredFromStorage: false,
            latestBySourceId: {
              "external:0": {
                sourceId: "external:0",
                kind: "external-spool",
                sourceIdentityStrength: "provisional",
                locator: { kind: "external-spool", index: 0 },
                displayLabel: "外部スプール",
              },
            },
          },
        },
      },
    }), { createdAt: "2026-08-31T03:34:10.000Z" });

    expect(plan.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED);
    expect(plan.entries[0]).toMatchObject({
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.SOURCE_IDENTITY_INSUFFICIENT],
      plannedWrites: {
        filamentUnits: [],
        materialSources: [],
        spoolMounts: [],
      },
    });
  });

  it("host一致で見つかった観測recordのdeviceIdが現在identityと異なる場合はREADYにしない", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K2Pro-ReusedHost",
            printerType: "k2",
            printerCoreV3Identity: {
              deviceIdSeed: "serial:new-device",
              identityStrength: "serial",
            },
          },
        ],
      },
      hostSpoolMap: { "K2Pro-ReusedHost": "spool-031" },
      materialSourceObservations: {
        schemaVersion: 1,
        byDeviceId: {
          "serial:old-device": {
            deviceId: "serial:old-device",
            host: "K2Pro-ReusedHost",
            snapshotCompleteness: "complete",
            lastObservedAt: "2026-08-31T03:34:00.000Z",
            restoredFromStorage: false,
            latestBySourceId: {
              "external:0": {
                sourceId: "external:0",
                kind: "external-spool",
                sourceIdentityStrength: "stable",
                locator: { kind: "external-spool", index: 0 },
              },
            },
          },
        },
      },
    }), { createdAt: "2026-08-31T03:34:10.000Z" });

    expect(plan.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED);
    expect(plan.entries[0]).toMatchObject({
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.SOURCE_IDENTITY_CONFLICT],
      plannedWrites: {
        filamentUnits: [],
        materialSources: [],
        spoolMounts: [],
        mountCandidates: [],
      },
    });
  });

  it("未来時刻のmaterial topology observationはfresh扱いにしない", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K2Pro-FutureObservation",
            printerType: "k2",
            printerCoreV3Identity: {
              deviceIdSeed: "serial:k2pro-future-observation",
              identityStrength: "serial",
            },
          },
        ],
      },
      hostSpoolMap: { "K2Pro-FutureObservation": "spool-031" },
      materialSourceObservations: {
        schemaVersion: 1,
        byDeviceId: {
          "serial:k2pro-future-observation": {
            deviceId: "serial:k2pro-future-observation",
            host: "K2Pro-FutureObservation",
            snapshotCompleteness: "complete",
            lastObservedAt: "2026-08-31T03:36:10.000Z",
            restoredFromStorage: false,
            latestBySourceId: {
              "external:0": {
                sourceId: "external:0",
                kind: "external-spool",
                sourceIdentityStrength: "stable",
                locator: { kind: "external-spool", index: 0 },
              },
            },
          },
        },
      },
    }), {
      createdAt: "2026-08-31T03:36:00.000Z",
      allowedClockSkewMs: 1000,
    });

    expect(plan.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED);
    expect(plan.entries[0]).toMatchObject({
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.MATERIAL_TOPOLOGY_OBSERVATION_REQUIRED],
      plannedWrites: {
        filamentUnits: [],
        materialSources: [],
        spoolMounts: [],
        mountCandidates: [],
      },
    });
  });

  it("fresh completeな単一sourceでもlocatorが不完全ならREADYにしない", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K2Pro-NoLocator",
            printerType: "k2",
            printerCoreV3Identity: {
              deviceIdSeed: "serial:k2pro-no-locator",
              identityStrength: "serial",
            },
          },
        ],
      },
      hostSpoolMap: { "K2Pro-NoLocator": "spool-031" },
      materialSourceObservations: {
        schemaVersion: 1,
        byDeviceId: {
          "serial:k2pro-no-locator": {
            deviceId: "serial:k2pro-no-locator",
            host: "K2Pro-NoLocator",
            snapshotCompleteness: "complete",
            lastObservedAt: "2026-08-31T03:34:00.000Z",
            restoredFromStorage: false,
            latestBySourceId: {
              "external:unknown": {
                sourceId: "external:unknown",
                kind: "external-spool",
                sourceIdentityStrength: "stable",
                displayLabel: "外部スプール",
              },
            },
          },
        },
      },
    }), { createdAt: "2026-08-31T03:34:10.000Z" });

    expect(plan.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED);
    expect(plan.entries[0]).toMatchObject({
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.MATERIAL_SOURCE_LOCATOR_INCOMPLETE],
      plannedWrites: {
        filamentUnits: [],
        materialSources: [],
        spoolMounts: [],
      },
    });
  });

  it("fresh completeな単一external sourceのlocatorをplanned MaterialSourceへ保持する", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K2Pro-External-1",
            printerType: "k2",
            printerCoreV3Identity: {
              deviceIdSeed: "serial:k2pro-external-1",
              identityStrength: "serial",
            },
          },
        ],
      },
      hostSpoolMap: { "K2Pro-External-1": "spool-031" },
      materialSourceObservations: {
        schemaVersion: 1,
        byDeviceId: {
          "serial:k2pro-external-1": {
            deviceId: "serial:k2pro-external-1",
            host: "K2Pro-External-1",
            snapshotCompleteness: "complete",
            lastObservedAt: "2026-08-31T03:34:00.000Z",
            restoredFromStorage: false,
            latestBySourceId: {
              "external:1": {
                sourceId: "external:1",
                kind: "external-spool",
                sourceIdentityStrength: "stable",
                locator: { kind: "external-spool", index: 1 },
                displayLabel: "外部スプール 2",
              },
            },
          },
        },
      },
    }), { createdAt: "2026-08-31T03:34:10.000Z" });

    expect(plan.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY);
    expect(plan.entries[0].plannedWrites.materialSources[0]).toMatchObject({
      kind: MATERIAL_SOURCE_KIND.EXTERNAL_SPOOL,
      locator: {
        kind: MATERIAL_SOURCE_KIND.EXTERNAL_SPOOL,
        index: 1,
      },
      identity: {
        parts: [
          "serial:k2pro-external-1",
          expect.any(String),
          MATERIAL_SOURCE_KIND.EXTERNAL_SPOOL,
          null,
          1,
        ],
      },
    });
  });

  it("Observation Store実shapeのboxId/slotIdをlocatorとして使い、source固有identityだけでREADYにする", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K2Pro-ObservedExternal",
            printerType: "k2",
            printerCoreV3Identity: {
              deviceIdSeed: "serial:k2pro-observed-external",
              identityStrength: "serial",
            },
          },
        ],
      },
      hostSpoolMap: { "K2Pro-ObservedExternal": "spool-031" },
      materialSourceObservations: {
        schemaVersion: 1,
        byDeviceId: {
          "serial:k2pro-observed-external": {
            deviceId: "serial:k2pro-observed-external",
            host: "K2Pro-ObservedExternal",
            snapshotCompleteness: "complete",
            lastObservedAt: "2026-08-31T03:36:00.000Z",
            restoredFromStorage: false,
            latestBySourceId: {
              "external:1": {
                sourceId: "external:1",
                kind: "external-spool",
                identityStrength: "stable",
                sourceIdentityStrength: "stable",
                boxId: 0,
                slotId: 1,
                protocolSlotId: "1",
                displayLabel: "外部スプール 2",
              },
            },
          },
        },
      },
    }), { createdAt: "2026-08-31T03:36:10.000Z" });

    expect(plan.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY);
    expect(plan.entries[0].plannedWrites.materialSources[0]).toMatchObject({
      kind: MATERIAL_SOURCE_KIND.EXTERNAL_SPOOL,
      locator: {
        kind: MATERIAL_SOURCE_KIND.EXTERNAL_SPOOL,
        index: 1,
        boxId: 0,
        protocolSlotId: "1",
      },
    });
  });

  it("tombstone/unobserved sourceはmigration cardinalityに数えない", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K2Pro-Tombstone",
            printerType: "k2",
            printerCoreV3Identity: {
              deviceIdSeed: "serial:k2pro-tombstone",
              identityStrength: "serial",
            },
          },
        ],
      },
      hostSpoolMap: { "K2Pro-Tombstone": "spool-031" },
      materialSourceObservations: {
        schemaVersion: 1,
        byDeviceId: {
          "serial:k2pro-tombstone": {
            deviceId: "serial:k2pro-tombstone",
            host: "K2Pro-Tombstone",
            snapshotCompleteness: "complete",
            lastObservedAt: "2026-08-31T03:36:00.000Z",
            restoredFromStorage: false,
            latestBySourceId: {
              "external:0": {
                sourceId: "external:0",
                kind: "external-spool",
                sourceIdentityStrength: "stable",
                locator: { kind: "external-spool", index: 0 },
              },
              "cfs:1:slot:0": {
                sourceId: "cfs:1:slot:0",
                kind: "cfs-slot",
                presence: "unobserved",
                tombstoneAt: "2026-08-31T03:35:00.000Z",
                boxId: 1,
                slotId: 0,
              },
            },
          },
        },
      },
    }), { createdAt: "2026-08-31T03:36:10.000Z" });

    expect(plan.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY);
    expect(plan.entries[0].candidateSources.map((source) => source.sourceId)).toEqual(["external:0"]);
  });

  it("Observation Store由来のdevice identityStrengthだけではsource identity証拠としてREADYにしない", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K2Pro-DeviceOnlyIdentity",
            printerType: "k2",
            printerCoreV3Identity: {
              deviceIdSeed: "serial:k2pro-device-only-identity",
              identityStrength: "serial",
            },
          },
        ],
      },
      hostSpoolMap: { "K2Pro-DeviceOnlyIdentity": "spool-031" },
      materialSourceObservations: {
        schemaVersion: 1,
        byDeviceId: {
          "serial:k2pro-device-only-identity": {
            deviceId: "serial:k2pro-device-only-identity",
            host: "K2Pro-DeviceOnlyIdentity",
            snapshotCompleteness: "complete",
            lastObservedAt: "2026-08-31T03:36:00.000Z",
            restoredFromStorage: false,
            latestBySourceId: {
              "external:1": {
                sourceId: "external:1",
                kind: "external-spool",
                identityStrength: "stable",
                boxId: 0,
                slotId: 1,
                protocolSlotId: "1",
                displayLabel: "外部スプール 2",
              },
            },
          },
        },
      },
    }), { createdAt: "2026-08-31T03:36:10.000Z" });

    expect(plan.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED);
    expect(plan.entries[0]).toMatchObject({
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.SOURCE_IDENTITY_INSUFFICIENT],
      plannedWrites: {
        filamentUnits: [],
        materialSources: [],
        spoolMounts: [],
      },
    });
  });


  it("既存Universal registry conflictがあるhostはmigration READYにしない", () => {
    const plan = createMaterialAccountingMigrationDryRunPlan(createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-Conflict",
            printerType: "k1",
            materialSystem: { mode: "single-spool", unitLimit: 0, accountingTopologyConfirmed: true },
            printerCoreV3Identity: {
              deviceIdSeed: "serial:k1max-conflict",
              identityStrength: "serial",
            },
          },
        ],
      },
      hostSpoolMap: { "K1Max-Conflict": "spool-031" },
      materialAccounting: {
        materialSourceRegistry: {
          conflicts: [
            {
              type: "identity-conflict",
              reason: "same-stable-identity-different-source",
              deviceId: "serial:k1max-conflict",
              status: "open",
            },
          ],
        },
      },
    }), { createdAt: "2026-08-31T03:35:00.000Z" });

    expect(plan.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED);
    expect(plan.entries[0]).toMatchObject({
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.SOURCE_IDENTITY_CONFLICT],
      plannedWrites: {
        filamentUnits: [],
        materialSources: [],
        spoolMounts: [],
      },
    });
  });

  it("既存Universal SpoolMount repositoryにopen mount conflictがあるhostはmigration READYにしない", () => {
    const planOptions = { createdAt: "2026-08-31T03:37:00.000Z" };
    const plan = createMaterialAccountingMigrationDryRunPlan(createConfirmedSingleSpoolFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-MountConflict",
            printerType: "k1",
            materialSystem: { mode: "single-spool", unitLimit: 0, accountingTopologyConfirmed: true },
            printerCoreV3Identity: {
              deviceIdSeed: "serial:k1max-mount-conflict",
              identityStrength: "serial",
            },
          },
        ],
      },
      hostSpoolMap: { "K1Max-MountConflict": "spool-031" },
      materialAccounting: {
        spoolMountRepository: {
          mounts: [
            {
              mountId: "existing-open",
              materialSourceId: "material-source:existing",
              spoolId: "spool-031",
              status: "open",
            },
          ],
        },
      },
    }, planOptions), planOptions);

    expect(plan.migrationStatus).toBe(MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED);
    expect(plan.entries[0]).toMatchObject({
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.OPEN_MOUNT_CONFLICT],
      plannedWrites: {
        filamentUnits: [],
        materialSources: [],
        spoolMounts: [],
        mountCandidates: [],
      },
    });
  });

  it("source checksumはconnectionTargetsとmachinesのidentity証拠変更も反映する", () => {
    const base = createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-4A1B",
            printerType: "k1",
            materialSystem: { mode: "single-spool", unitLimit: 0 },
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-4a1b", identityStrength: "serial" },
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
            materialSystem: { mode: "single-spool", unitLimit: 0, accountingTopologyConfirmed: true },
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-4a1b", identityStrength: "serial" },
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

  it("source checksumはplanner入力依存のfilamentSpools/materialAccounting/freshTtlMsを含める", () => {
    const base = createLegacyFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-Checksum",
            printerType: "k1",
            materialSystem: { mode: "single-spool", unitLimit: 0, accountingTopologyConfirmed: true },
            printerCoreV3Identity: {
              deviceIdSeed: "serial:k1max-checksum",
              identityStrength: "serial",
            },
          },
        ],
      },
      hostSpoolMap: { "K1Max-Checksum": "spool-031" },
    });
    const basePlan = createMaterialAccountingMigrationDryRunPlan(base, {
      createdAt: "2026-08-31T03:37:00.000Z",
      freshTtlMs: 60_000,
    });
    const changedSpoolPlan = createMaterialAccountingMigrationDryRunPlan({
      ...base,
      filamentSpools: [{ id: "spool-031", remainingLengthMm: 100 }],
    }, {
      createdAt: "2026-08-31T03:37:00.000Z",
      freshTtlMs: 60_000,
    });
    const changedRegistryPlan = createMaterialAccountingMigrationDryRunPlan({
      ...base,
      materialAccounting: {
        materialSourceRegistry: {
          conflicts: [{ status: "open", deviceId: "serial:k1max-checksum" }],
        },
      },
    }, {
      createdAt: "2026-08-31T03:37:00.000Z",
      freshTtlMs: 60_000,
    });
    const changedTtlPlan = createMaterialAccountingMigrationDryRunPlan(base, {
      createdAt: "2026-08-31T03:37:00.000Z",
      freshTtlMs: 30_000,
    });

    expect(changedSpoolPlan.source.checksum).not.toBe(basePlan.source.checksum);
    expect(changedRegistryPlan.source.checksum).not.toBe(basePlan.source.checksum);
    expect(changedTtlPlan.source.checksum).not.toBe(basePlan.source.checksum);
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

  it("validatorはsummaryとentry statusの不一致を拒否する", () => {
    const planOptions = { createdAt: "2026-08-31T03:36:00.000Z" };
    const plan = createMaterialAccountingMigrationDryRunPlan(createConfirmedSingleSpoolFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-4A1B",
            printerType: "k1",
            materialSystem: { mode: "single-spool", unitLimit: 0, accountingTopologyConfirmed: true },
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-4a1b", identityStrength: "serial" },
          },
        ],
      },
      hostSpoolMap: { "K1Max-4A1B": "spool-031" },
    }, planOptions), planOptions);
    const invalid = {
      ...plan,
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE,
      summary: {
        ...plan.summary,
        ready: 0,
        candidate: 1,
      },
    };

    expect(validateMaterialAccountingMigrationDryRunPlan(invalid)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "migrationStatus-summary-mismatch",
        "summary-ready-count-mismatch",
        "summary-candidate-count-mismatch",
      ]),
    });
  });

  it("validatorは非READY entryのplannedWrites混入を拒否する", () => {
    const planOptions = { createdAt: "2026-08-31T03:37:00.000Z" };
    const plan = createMaterialAccountingMigrationDryRunPlan(createConfirmedSingleSpoolFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-4A1B",
            printerType: "k1",
            materialSystem: { mode: "single-spool", unitLimit: 0 },
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-4a1b", identityStrength: "serial" },
          },
        ],
      },
      hostSpoolMap: { "K1Max-4A1B": "spool-031" },
    }, planOptions), planOptions);
    const invalid = {
      ...plan,
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      entries: [
        {
          ...plan.entries[0],
          migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
          reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.MATERIAL_TOPOLOGY_OBSERVATION_REQUIRED],
          plannedWrites: {
            filamentUnits: plan.entries[0].plannedWrites.filamentUnits,
            materialSources: plan.entries[0].plannedWrites.materialSources,
            spoolMounts: [],
            mountCandidates: plan.entries[0].plannedWrites.mountCandidates,
          },
        },
      ],
    };

    expect(validateMaterialAccountingMigrationDryRunPlan(invalid)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "non-ready-entry-has-filamentUnit-write",
        "non-ready-entry-has-materialSource-write",
        "non-ready-entry-has-mountCandidate-write",
        "summary-blocked-count-mismatch",
      ]),
    });
  });

  it("READY entry内のmountCandidateはentry spoolとplanned MaterialSourceにbindされる", () => {
    const planOptions = { createdAt: "2026-08-31T03:37:00.000Z" };
    const plan = createMaterialAccountingMigrationDryRunPlan(createConfirmedSingleSpoolFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-4A1B",
            printerType: "k1",
            materialSystem: { mode: "single-spool", unitLimit: 0 },
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-4a1b", identityStrength: "serial" },
          },
        ],
      },
      hostSpoolMap: { "K1Max-4A1B": "spool-031" },
    }, planOptions), planOptions);
    const invalid = {
      ...plan,
      entries: [
        {
          ...plan.entries[0],
          plannedWrites: {
            ...plan.entries[0].plannedWrites,
            mountCandidates: [
              {
                ...plan.entries[0].plannedWrites.mountCandidates[0],
                spoolId: "spool-other",
                materialSourceId: "material-source-other",
              },
            ],
          },
        },
      ],
    };

    expect(validateMaterialAccountingMigrationDryRunPlan(invalid)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "mountCandidate:spoolId-entry-mismatch",
        "mountCandidate:materialSourceId-not-planned",
      ]),
    });
  });

  it("READY entryは単一unit/source/candidate graphとしてentry deviceへbindされる", () => {
    const planOptions = { createdAt: "2026-08-31T03:37:00.000Z" };
    const plan = createMaterialAccountingMigrationDryRunPlan(createConfirmedSingleSpoolFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-4A1B",
            printerType: "k1",
            materialSystem: { mode: "single-spool", unitLimit: 0 },
            printerCoreV3Identity: {
              deviceIdSeed: "serial:k1max-4a1b",
              identityStrength: "serial",
            },
          },
        ],
      },
      hostSpoolMap: { "K1Max-4A1B": "spool-031" },
    }, planOptions), planOptions);
    const readyEntry = plan.entries[0];
    const invalid = {
      ...plan,
      entries: [
        {
          ...readyEntry,
          plannedWrites: {
            ...readyEntry.plannedWrites,
            filamentUnits: [
              ...readyEntry.plannedWrites.filamentUnits,
              {
                ...readyEntry.plannedWrites.filamentUnits[0],
                unitId: "filament-unit:extra",
                deviceId: "serial:other-device",
              },
            ],
            materialSources: [
              {
                ...readyEntry.plannedWrites.materialSources[0],
                deviceId: "serial:other-device",
                unitId: "filament-unit:not-planned",
              },
            ],
          },
        },
      ],
    };

    expect(validateMaterialAccountingMigrationDryRunPlan(invalid)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "ready-entry-filamentUnit-count-invalid",
        "filamentUnit:deviceId-entry-mismatch",
        "materialSource:deviceId-entry-mismatch",
        "materialSource:unitId-not-planned",
      ]),
    });
  });

  it("validatorはplan revision/source/migrationIdのcross-binding不一致を拒否する", () => {
    const planOptions = { createdAt: "2026-08-31T03:37:00.000Z" };
    const plan = createMaterialAccountingMigrationDryRunPlan(createConfirmedSingleSpoolFixture({
      appSettings: {
        connectionTargets: [
          {
            hostname: "K1Max-4A1B",
            printerType: "k1",
            materialSystem: { mode: "single-spool", unitLimit: 0 },
            printerCoreV3Identity: { deviceIdSeed: "serial:k1max-4a1b", identityStrength: "serial" },
          },
        ],
      },
      hostSpoolMap: { "K1Max-4A1B": "spool-031" },
    }, planOptions), planOptions);
    const invalid = {
      ...plan,
      migrationSubjectId: "material-accounting-migration-subject:tampered",
      planRevisionId: "material-accounting-plan-revision:tampered",
      migrationId: "material-accounting-migration:tampered",
      source: {
        ...plan.source,
        migrationSubjectId: "material-accounting-migration-subject:other",
        planRevisionId: "material-accounting-plan-revision:other",
      },
    };

    expect(validateMaterialAccountingMigrationDryRunPlan(invalid)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "source-migrationSubjectId-plan-mismatch",
        "source-planRevisionId-plan-mismatch",
        "migrationId-planRevisionId-mismatch",
      ]),
    });
  });
});
