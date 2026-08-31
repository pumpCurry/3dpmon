/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Universal MaterialSource migration journal 単体テスト
 * @file printer_core_material_accounting_migration_journal.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_material_accounting_migration_journal_test
 *
 * 【機能内容サマリ】
 * - Gate 18.9B のdry-run migration journalがauthority writeを持たないことを検証
 * - valid planだけを保存し、同一plan再保存を冪等化する境界を固定
 * - 破損済み保存値をUniversal repositoryへ投影せず隔離する境界を固定
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1509 (PR #438)
 * @since   1.390.1506 (PR #438)
 * @lastModified 2026-08-31 15:35:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { describe, expect, it } from "vitest";

import {
  createMaterialAccountingMigrationDryRunPlan,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_migration_planner.js";
import {
  createMaterialAccountingMigrationJournal,
  normalizeStoredMaterialAccountingMigrationJournal,
  recordMaterialAccountingMigrationDryRunPlan,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_migration_journal.js";

/**
 * READYなdry-run plan fixtureを生成する。
 *
 * @function createReadyPlan
 * @param {string=} host - legacy host key。
 * @returns {Object} migration dry-run plan。
 */
function createReadyPlan(host = "K1Max-4A1B") {
  return createMaterialAccountingMigrationDryRunPlan({
    appSettings: {
      connectionTargets: [
        {
          hostname: host,
          printerType: "k1",
          materialSystem: { mode: "single-spool", unitLimit: 0, accountingTopologyConfirmed: true },
          printerCoreV3Identity: { deviceIdSeed: `serial:${host.toLowerCase()}` },
        },
      ],
    },
    machines: { [host]: { printerType: "k1" } },
    filamentSpools: [
      { id: "spool-031", name: "CC3D Sand Color", remainingLengthMm: 336000 },
    ],
    hostSpoolMap: { [host]: "spool-031" },
    materialSourceObservations: { schemaVersion: 1, byDeviceId: {} },
  }, { createdAt: "2026-08-31T03:40:00.000Z" });
}

describe("Material accounting migration journal", () => {
  it("valid dry-run planをjournalへ保存し、authority writeを有効化しない", () => {
    const plan = createReadyPlan();
    const result = recordMaterialAccountingMigrationDryRunPlan(null, plan, {
      recordedAt: "2026-08-31T03:41:00.000Z",
    });

    expect(result).toMatchObject({ ok: true, action: "insert" });
    expect(result.journal).toMatchObject({
      schemaVersion: 1,
      authority: "migration-dry-run-journal",
      latestMigrationId: plan.migrationId,
      invariants: {
        activateUniversalWrites: false,
        materialSourceRepositoryWrites: false,
        spoolMountRepositoryWrites: false,
      },
    });
    expect(result.journal.byMigrationId[plan.migrationId].plan).toMatchObject({
      migrationId: plan.migrationId,
      status: "dry-run",
      invariants: { activateUniversalWrites: false },
    });
    expect(result.journal.events).toEqual([
      expect.objectContaining({
        type: "migration-dry-run-recorded",
        migrationId: plan.migrationId,
        recordedAt: "2026-08-31T03:41:00.000Z",
      }),
    ]);
  });

  it("同一migrationIdかつ同一checksumの再保存はeventを重複させず冪等に扱う", () => {
    const plan = createReadyPlan();
    const first = recordMaterialAccountingMigrationDryRunPlan(null, plan, {
      recordedAt: "2026-08-31T03:41:00.000Z",
    });
    const second = recordMaterialAccountingMigrationDryRunPlan(first.journal, plan, {
      recordedAt: "2026-08-31T03:42:00.000Z",
    });

    expect(second).toMatchObject({ ok: true, action: "noop" });
    expect(second.journal.events).toHaveLength(1);
    expect(second.journal.byMigrationId[plan.migrationId].recordedAt).toBe("2026-08-31T03:41:00.000Z");
  });

  it("invalid planはjournalへ保存しない", () => {
    const plan = createReadyPlan();
    const invalid = { ...plan, status: "apply" };
    const result = recordMaterialAccountingMigrationDryRunPlan(null, invalid, {
      recordedAt: "2026-08-31T03:41:00.000Z",
    });

    expect(result).toMatchObject({
      ok: false,
      action: "invalid-plan",
      reason: "plan-status-not-dry-run",
    });
    expect(result.journal.byMigrationId).toEqual({});
  });

  it("migrationIdとrevision bindingが壊れたplanはjournal conflict前にinvalidとして拒否する", () => {
    const plan = createReadyPlan();
    const first = recordMaterialAccountingMigrationDryRunPlan(null, plan, {
      recordedAt: "2026-08-31T03:41:00.000Z",
    });
    const conflicting = {
      ...createReadyPlan("K1Max-Other"),
      migrationId: plan.migrationId,
    };
    const result = recordMaterialAccountingMigrationDryRunPlan(first.journal, conflicting, {
      recordedAt: "2026-08-31T03:42:00.000Z",
    });

    expect(result).toMatchObject({
      ok: false,
      action: "invalid-plan",
      reason: "migrationId-planRevisionId-mismatch",
    });
    expect(result.journal.events).toHaveLength(1);
    expect(result.journal.byMigrationId[plan.migrationId].plan.source.checksum).toBe(plan.source.checksum);
  });

  it("保存済みjournalの壊れたentryはretainedUnsupportedEntriesへ隔離する", () => {
    const plan = createReadyPlan();
    const validRecorded = recordMaterialAccountingMigrationDryRunPlan(null, plan, {
      recordedAt: "2026-08-31T03:41:00.000Z",
    });
    const stored = {
      schemaVersion: 1,
      authority: "migration-dry-run-journal",
      latestMigrationId: "broken",
      byMigrationId: {
        [plan.migrationId]: validRecorded.journal.byMigrationId[plan.migrationId],
        broken: { migrationId: "broken", sourceChecksum: "x", plan: { status: "apply" } },
      },
      events: [
        validRecorded.journal.events[0],
        { eventId: "bad", type: "migration-dry-run-recorded", migrationId: "broken" },
      ],
    };

    const journal = normalizeStoredMaterialAccountingMigrationJournal(stored);

    expect(Object.keys(journal.byMigrationId)).toEqual([plan.migrationId]);
    expect(journal.latestMigrationId).toBe(plan.migrationId);
    expect(journal.retainedUnsupportedEntries).toEqual([
      expect.objectContaining({ migrationId: "broken", reason: "plan-not-object-or-invalid" }),
    ]);
    expect(journal.events).toEqual([
      expect.objectContaining({ eventId: validRecorded.journal.events[0].eventId, migrationId: plan.migrationId }),
    ]);
  });

  it("保存済みjournalのmalformed entryはthrowせずretainedUnsupportedEntriesへ隔離する", () => {
    const stored = {
      schemaVersion: 1,
      byMigrationId: {
        nullEntry: null,
        emptyEntry: {},
        missingWrites: {
          migrationId: "missingWrites",
          sourceChecksum: "fnv1a128:missing",
          migrationStatus: "ready",
          recordedAt: "2026-08-31T03:41:00.000Z",
          plan: {
            schemaVersion: 1,
            status: "dry-run",
            migrationStatus: "ready",
            migrationId: "missingWrites",
            createdAt: "2026-08-31T03:40:00.000Z",
            source: { checksum: "fnv1a128:missing" },
            entries: [
              {
                host: "K1Max-Broken",
                spoolId: "spool-031",
                deviceId: "serial:k1max-broken",
                migrationStatus: "ready",
                plannedWrites: null,
              },
            ],
            summary: { ready: 1, candidate: 0, blocked: 0, plannedWrites: {} },
            invariants: { activateUniversalWrites: false, preserveHostSpoolMap: true },
          },
        },
        brokenCandidates: {
          migrationId: "brokenCandidates",
          sourceChecksum: "fnv1a128:broken-candidates",
          migrationStatus: "ready",
          recordedAt: "2026-08-31T03:41:00.000Z",
          plan: {
            schemaVersion: 1,
            status: "dry-run",
            migrationStatus: "ready",
            migrationId: "brokenCandidates",
            createdAt: "2026-08-31T03:40:00.000Z",
            source: { checksum: "fnv1a128:broken-candidates" },
            entries: [
              {
                host: "K1Max-Broken",
                spoolId: "spool-031",
                deviceId: "serial:k1max-broken",
                migrationStatus: "ready",
                plannedWrites: { filamentUnits: [], materialSources: [], spoolMounts: [], mountCandidates: "broken" },
              },
            ],
            summary: { ready: 1, candidate: 0, blocked: 0, plannedWrites: { filamentUnits: 0, materialSources: 0, spoolMounts: 0, mountCandidates: 1 } },
            invariants: { activateUniversalWrites: false, preserveHostSpoolMap: true },
          },
        },
      },
      events: [],
    };

    const journal = normalizeStoredMaterialAccountingMigrationJournal(stored);

    expect(journal.byMigrationId).toEqual({});
    expect(journal.retainedUnsupportedEntries).toEqual([
      expect.objectContaining({ migrationId: "nullEntry", reason: "plan-not-object-or-invalid" }),
      expect.objectContaining({ migrationId: "emptyEntry", reason: "plan-not-object-or-invalid" }),
      expect.objectContaining({ migrationId: "missingWrites", reason: "plan-not-object-or-invalid" }),
      expect.objectContaining({ migrationId: "brokenCandidates", reason: "plan-not-object-or-invalid" }),
    ]);
  });

  it("保存済みjournal entryのchecksum/statusがplanと食い違う場合は隔離する", () => {
    const plan = createReadyPlan();
    const stored = {
      schemaVersion: 1,
      authority: "migration-dry-run-journal",
      latestMigrationId: plan.migrationId,
      byMigrationId: {
        [plan.migrationId]: {
          migrationId: plan.migrationId,
          sourceChecksum: "fnv1a128:tampered",
          migrationStatus: "blocked",
          recordedAt: "2026-08-31T03:41:00.000Z",
          plan,
        },
      },
      events: [
        {
          eventId: "event-for-tampered-entry",
          type: "migration-dry-run-recorded",
          migrationId: plan.migrationId,
          sourceChecksum: "fnv1a128:tampered",
          recordedAt: "2026-08-31T03:41:00.000Z",
        },
      ],
    };

    const journal = normalizeStoredMaterialAccountingMigrationJournal(stored);

    expect(journal.byMigrationId).toEqual({});
    expect(journal.latestMigrationId).toBeNull();
    expect(journal.events).toEqual([]);
    expect(journal.retainedUnsupportedEntries).toEqual([
      expect.objectContaining({
        migrationId: plan.migrationId,
        reason: "entry-plan-cross-binding-mismatch",
        errors: expect.arrayContaining([
          "entry-sourceChecksum-plan-mismatch",
          "entry-migrationStatus-plan-mismatch",
        ]),
      }),
    ]);
  });

  it("保存済みjournal eventはentryのchecksum/recordedAt/eventIdと一致する場合だけ復元する", () => {
    const plan = createReadyPlan();
    const result = recordMaterialAccountingMigrationDryRunPlan(null, plan, {
      recordedAt: "2026-08-31T03:41:00.000Z",
    });
    const stored = {
      ...result.journal,
      events: [
        result.journal.events[0],
        {
          ...result.journal.events[0],
          eventId: "wrong-checksum-event",
          sourceChecksum: "fnv1a128:tampered",
        },
        {
          ...result.journal.events[0],
          eventId: "wrong-time-event",
          recordedAt: "2026-08-31T03:42:00.000Z",
        },
      ],
    };

    const journal = normalizeStoredMaterialAccountingMigrationJournal(stored);

    expect(journal.events).toEqual([result.journal.events[0]]);
    expect(journal.latestMigrationId).toBe(plan.migrationId);
    expect(journal.retainedUnsupportedEntries).toEqual([]);
  });

  it("createMaterialAccountingMigrationJournalは呼び出し側mutationから内部snapshotを守る", () => {
    const plan = createReadyPlan();
    const journal = createMaterialAccountingMigrationJournal();
    const result = recordMaterialAccountingMigrationDryRunPlan(journal, plan, {
      recordedAt: "2026-08-31T03:41:00.000Z",
    });

    expect(() => {
      result.journal.latestMigrationId = "mutated";
    }).toThrow();
    expect(result.journal.latestMigrationId).toBe(plan.migrationId);
  });
});
