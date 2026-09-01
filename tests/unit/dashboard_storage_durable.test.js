/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 storage durable API 単体テスト
 * @file dashboard_storage_durable.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_storage_durable_test
 *
 * 【機能内容サマリ】
 * - IndexedDB flush完了を待つ耐久保存契約を検証
 * - Gate 18.9H SpoolMount production storeのCAS commit境界を検証
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1586 (PR #440)
 * @since   1.390.1580 (PR #440)
 * @lastModified 2026-09-01 17:02:15
 * -----------------------------------------------------------
 * @todo
 * - none
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  MATERIAL_IDENTITY_STRENGTH,
  MATERIAL_SOURCE_KIND,
  SPOOL_MOUNT_VERIFICATION,
  createMaterialSourceIdentity,
  createMaterialSourceLocator,
  createMaterialSourceRecord,
  createSpoolMountRecord,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_contract.js";
import {
  createEmptyMaterialAccountingSpoolMountStore,
  createMaterialAccountingSpoolMountOperationPayloadDigest,
  normalizeStoredMaterialAccountingSpoolMountStore,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_mount_store.js";
import {
  reserveUniversalSpoolAssignment,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_spool_assignment_guard.js";
import {
  createPrinterCoreV3DeterministicId,
  stableStringifyPrinterCoreV3Value,
} from "../../3dp_lib/printer_core/dashboard_data_schema_v3.js";

class LocalStorageStub {
  constructor() { this._m = new Map(); }
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }
  setItem(k, v) { this._m.set(String(k), String(v)); }
  removeItem(k) { this._m.delete(k); }
  clear() { this._m.clear(); }
  key(i) { return Array.from(this._m.keys())[i] ?? null; }
  get length() { return this._m.size; }
}
globalThis.localStorage = new LocalStorageStub();

const mocks = vi.hoisted(() => ({
  events: [],
  idbAvailable: true,
  monitorData: {
    appSettings: {},
    machines: {},
    filamentSpools: [],
    usageHistory: [],
    filamentPresets: [],
    userPresets: [],
    hiddenPresets: [],
    favoritePresets: [],
    filamentInventory: [],
    mountHistory: [],
    mountHistorySeq: 0,
    mountHistoryRejectedEvents: [],
    hostObservationWatermark: {},
    hostObservationCurrent: {},
    inferredCandidateStore: {},
    inferredDecisionRecoveryRequired: null,
    inferredRecoveryOperationRecoveryRequired: null,
    inferredRecoveryEvents: [],
    pendingUnattributedUsage: [],
    pendingUnattributedUsageArchive: {},
    ledgerRepairRequired: {},
    filamentEventContext: {},
    materialSourceObservations: { schemaVersion: 1, byDeviceId: {} },
    materialAccountingMigrationJournal: {
      schemaVersion: 1,
      authority: "migration-dry-run-journal",
      latestMigrationId: null,
      byMigrationId: {},
      events: [],
      retainedUnsupportedEntries: [],
      invariants: {
        activateUniversalWrites: false,
        materialSourceRepositoryWrites: false,
        spoolMountRepositoryWrites: false,
        migrationJournalIsEvidenceOnly: true,
      },
    },
    materialAccountingMigrationShadowStore: {},
    materialAccountingPrintBindingStore: {},
    materialAccountingSpoolMountStore: {
      schemaVersion: 1,
      authority: "material-accounting-spool-mount-store",
      storeRevision: 0,
      storeDigest: "",
      spoolMounts: [],
      events: [],
      conflicts: [],
      retainedUnsupportedEntries: [],
      invariants: {
        operatorManaged: true,
        deviceObservationWrites: false,
        physicalCommandWrites: false,
        legacyHostSpoolMapWrites: false,
        legacyUsageHistoryWrites: false,
        legacySpoolRemainingWrites: false,
        filamentLedgerWrites: false,
        printBindingWrites: false,
      },
    },
    physicalCommandRecoveryLatch: {},
    hostSpoolMap: {},
    hostCameraToggle: {},
    spoolSerialCounter: 0
  },
  queueSharedWrite: vi.fn((key) => { mocks.events.push(`queue:${key}`); }),
  queueMachineWrite: vi.fn((host) => { mocks.events.push(`machine:${host}`); }),
  flushIdb: vi.fn(async () => { mocks.events.push("flush"); }),
  compareAndSwapSharedValue: vi.fn(async () => ({
    ok: true,
    casApplied: true,
    backend: "indexedDB",
    key: "materialAccountingSpoolMountStore",
    reason: "cas-applied",
    currentDigest: "digest:base",
    nextDigest: "digest:next",
  }))
}));

vi.mock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: mocks.monitorData,
  PLACEHOLDER_HOSTNAME: "_$_NO_MACHINE_$_",
  ensureMachineData: vi.fn()
}));
vi.mock("../../3dp_lib/dashboard_filament_presets.js", () => ({ FILAMENT_PRESETS: [] }));
vi.mock("../../3dp_lib/dashboard_log_util.js", () => ({ logManager: { add: vi.fn() } }));
vi.mock("../../3dp_lib/dashboard_utils.js", () => ({ getCurrentTimestamp: () => 0 }));
vi.mock("../../3dp_lib/dashboard_filament_ledger.js", () => ({ initLedgerAnchors: vi.fn(), quarantineInvalidMountEvents: vi.fn(() => 0) }));
vi.mock("../../3dp_lib/dashboard_target_identity.js", () => ({ parseDest: vi.fn(), isIpLiteral: vi.fn(), extractHost: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_storage_idb.js", () => ({
  initIdb: vi.fn(),
  isIdbAvailable: () => mocks.idbAvailable,
  getIdbCache: () => null,
  queueSharedWrite: mocks.queueSharedWrite,
  queueMachineWrite: mocks.queueMachineWrite,
  flushIdb: mocks.flushIdb,
  exportAllIdb: vi.fn(),
  importAllIdb: vi.fn(),
  compareAndSwapSharedValue: mocks.compareAndSwapSharedValue,
  setIdbDbName: vi.fn()
}));

const {
  initStorage,
  importAllData,
  saveUnifiedStorageDurably,
  commitMaterialAccountingSpoolMountStoreDurably,
} = await import("../../3dp_lib/dashboard_storage.js");

beforeEach(async () => {
  mocks.events.length = 0;
  mocks.idbAvailable = true;
  mocks.monitorData.machines = { k1: { storedData: {}, printStore: { history: [] }, runtimeData: { transient: true } } };
  mocks.monitorData.inferredCandidateStore = { "ic-a": { candidateHash: "ic-a", usedMm: 1200 } };
  mocks.monitorData.inferredDecisionRecoveryRequired = { candidateHash: "ic-a", reason: "rollback_durable_save_failed" };
  mocks.monitorData.inferredRecoveryOperationRecoveryRequired = { operation: "clearLedgerRepairRequired", reason: "rollback_durable_save_failed" };
  mocks.monitorData.inferredRecoveryEvents = [{ eventId: "ir-a", type: "recovery-durable-save-retried" }];
  mocks.monitorData.hostObservationWatermark = { k1: { observationSequence: 1 } };
  mocks.monitorData.materialSourceObservations = {
    schemaVersion: 1,
    byDeviceId: { "serial:test": { deviceId: "serial:test", authority: "observation-only" } },
  };
  mocks.monitorData.materialAccountingMigrationJournal = {
    schemaVersion: 1,
    authority: "migration-dry-run-journal",
    latestMigrationId: "migration:test",
    byMigrationId: { "migration:test": { migrationId: "migration:test", sourceChecksum: "checksum:test" } },
    events: [{ eventId: "event:test", type: "migration-dry-run-recorded", migrationId: "migration:test" }],
    retainedUnsupportedEntries: [],
    invariants: {
      activateUniversalWrites: false,
      materialSourceRepositoryWrites: false,
      spoolMountRepositoryWrites: false,
      migrationJournalIsEvidenceOnly: true,
    },
  };
  mocks.monitorData.materialAccountingMigrationShadowStore = {};
  mocks.monitorData.materialAccountingPrintBindingStore = {};
  mocks.monitorData.materialAccountingSpoolMountStore = createEmptyMaterialAccountingSpoolMountStore();
  mocks.monitorData.physicalCommandRecoveryLatch = {};
  mocks.monitorData.hostSpoolMap = {};
  mocks.monitorData.usageHistory = [];
  mocks.monitorData.filamentSpools = [];
  mocks.queueSharedWrite.mockClear();
  mocks.queueMachineWrite.mockClear();
  mocks.flushIdb.mockClear();
  mocks.flushIdb.mockImplementation(async () => { mocks.events.push("flush"); });
  mocks.compareAndSwapSharedValue.mockClear();
  mocks.compareAndSwapSharedValue.mockResolvedValue({
    ok: true,
    casApplied: true,
    backend: "indexedDB",
    key: "materialAccountingSpoolMountStore",
    reason: "cas-applied",
    currentDigest: "digest:base",
    nextDigest: "digest:next",
  });
  await initStorage();
});

describe("saveUnifiedStorageDurably", () => {
  it("IndexedDB 使用時は queueSharedWrite 後に flushIdb 完了を待つ", async () => {
    const result = await saveUnifiedStorageDurably();

    expect(result).toEqual({ ok: true, backend: "indexedDB", reason: "flushed" });
    expect(mocks.queueSharedWrite).toHaveBeenCalledWith("inferredCandidateStore", mocks.monitorData.inferredCandidateStore);
    expect(mocks.queueSharedWrite).toHaveBeenCalledWith("inferredDecisionRecoveryRequired", mocks.monitorData.inferredDecisionRecoveryRequired);
    expect(mocks.queueSharedWrite).toHaveBeenCalledWith("inferredRecoveryOperationRecoveryRequired", mocks.monitorData.inferredRecoveryOperationRecoveryRequired);
    expect(mocks.queueSharedWrite).toHaveBeenCalledWith("inferredRecoveryEvents", mocks.monitorData.inferredRecoveryEvents);
    expect(mocks.queueSharedWrite).toHaveBeenCalledWith("hostObservationWatermark", mocks.monitorData.hostObservationWatermark);
    expect(mocks.queueSharedWrite).toHaveBeenCalledWith("materialSourceObservations", mocks.monitorData.materialSourceObservations);
    expect(mocks.queueSharedWrite).toHaveBeenCalledWith("materialAccountingMigrationJournal", mocks.monitorData.materialAccountingMigrationJournal);
    expect(mocks.queueSharedWrite).not.toHaveBeenCalledWith("materialAccountingSpoolMountStore", mocks.monitorData.materialAccountingSpoolMountStore);
    expect(mocks.events.indexOf("queue:inferredCandidateStore")).toBeGreaterThanOrEqual(0);
    expect(mocks.events[mocks.events.length - 1]).toBe("flush");
  });

  it("flush 中に IndexedDB が無効化された場合は失敗として返す", async () => {
    mocks.flushIdb.mockImplementation(async () => {
      mocks.events.push("flush");
      mocks.idbAvailable = false;
    });

    const result = await saveUnifiedStorageDurably();

    expect(result).toEqual({ ok: false, backend: "indexedDB", reason: "idb_flush_failed" });
  });

  it("localStorage.setItem が例外なら ok=false を返す", async () => {
    mocks.idbAvailable = false;
    await initStorage();
    const originalSetItem = globalThis.localStorage.setItem;
    globalThis.localStorage.clear();
    mocks.monitorData.machines.k1.storedData = { forceWrite: "quota-case" };
    globalThis.localStorage.setItem = () => {
      const error = new Error("quota");
      error.name = "QuotaExceededError";
      throw error;
    };

    try {
      const result = await saveUnifiedStorageDurably();

      expect(result.ok).toBe(false);
      expect(result.backend).toBe("localStorage");
      expect(result.reason).toBe("local_storage_write_failed");
      expect(result.error).toContain("quota");
    } finally {
      globalThis.localStorage.setItem = originalSetItem;
    }
  });

  it("SpoolMount production commitはCAS成功後だけmonitorDataを更新する", async () => {
    const baseStore = createEmptyMaterialAccountingSpoolMountStore();
    const mount = createDurableMountFixture();
    const operation = createMountOperationEvent({ recordRefs: [mount.mountId, mount.mountOperationId] });
    const nextStore = normalizeStoredMaterialAccountingSpoolMountStore({
      ...baseStore,
      storeRevision: 1,
      spoolMounts: [mount],
      events: [operation],
    });
    mocks.monitorData.materialAccountingSpoolMountStore = baseStore;
    mocks.monitorData.filamentSpools = [{ id: "spool:a" }];
    mocks.monitorData.materialSourceObservations = createMaterialSourceObservationFixture();

    const result = await commitMaterialAccountingSpoolMountStoreDurably({
      baseStoreDigest: baseStore.storeDigest,
      nextStore,
      operation,
      preconditions: createDurablePreconditions(),
    });

    expect(result).toMatchObject({ ok: true, casApplied: true, reason: "cas-applied" });
    expect(mocks.compareAndSwapSharedValue).toHaveBeenCalledWith(expect.objectContaining({
      key: "materialAccountingSpoolMountStore",
      expectedDigest: baseStore.storeDigest,
      nextValue: nextStore,
    }));
    expect(mocks.monitorData.materialAccountingSpoolMountStore).toEqual(nextStore);
    expect(mocks.monitorData.hostSpoolMap).toEqual({});
    expect(mocks.monitorData.usageHistory).toEqual([]);
    expect(mocks.monitorData.filamentSpools).toEqual([{ id: "spool:a" }]);
  });

  it("SpoolMount production commitはmanaged spool preconditionが変わったらCAS前に拒否する", async () => {
    const baseStore = createEmptyMaterialAccountingSpoolMountStore();
    const mount = createDurableMountFixture();
    const operation = createMountOperationEvent({ recordRefs: [mount.mountId, mount.mountOperationId] });
    const nextStore = normalizeStoredMaterialAccountingSpoolMountStore({
      ...baseStore,
      storeRevision: 1,
      spoolMounts: [mount],
      events: [operation],
    });
    mocks.monitorData.materialAccountingSpoolMountStore = baseStore;
    mocks.monitorData.filamentSpools = [{ id: "spool:a", isDeleted: true }];
    mocks.monitorData.materialSourceObservations = createMaterialSourceObservationFixture();

    const result = await commitMaterialAccountingSpoolMountStoreDurably({
      baseStoreDigest: baseStore.storeDigest,
      nextStore,
      operation,
      preconditions: {
        ...createDurablePreconditions(),
        managedSpool: {
          spoolId: "spool:a",
          digest: "fnv1a128:stale-managed-spool",
          deleted: false,
        },
      },
    });

    expect(result).toMatchObject({ ok: false, casApplied: false, reason: "managed-spool-precondition-changed" });
    expect(mocks.compareAndSwapSharedValue).not.toHaveBeenCalled();
    expect(mocks.monitorData.materialAccountingSpoolMountStore).toEqual(baseStore);
  });

  it("SpoolMount production commitはlegacy occupancy preconditionが変わったらCAS前に拒否する", async () => {
    const baseStore = createEmptyMaterialAccountingSpoolMountStore();
    const mount = createDurableMountFixture();
    const operation = createMountOperationEvent({ recordRefs: [mount.mountId, mount.mountOperationId] });
    const nextStore = normalizeStoredMaterialAccountingSpoolMountStore({
      ...baseStore,
      storeRevision: 1,
      spoolMounts: [mount],
      events: [operation],
    });
    mocks.monitorData.materialAccountingSpoolMountStore = baseStore;
    mocks.monitorData.hostSpoolMap = { "K1Max-4A1B": "spool:a" };
    mocks.monitorData.filamentSpools = [{ id: "spool:a" }];
    mocks.monitorData.materialSourceObservations = createMaterialSourceObservationFixture();

    const result = await commitMaterialAccountingSpoolMountStoreDurably({
      baseStoreDigest: baseStore.storeDigest,
      nextStore,
      operation,
      preconditions: {
        ...createDurablePreconditions(),
        legacyOccupancy: {
          spoolId: "spool:a",
          expectedDeviceId: "device:k2",
          occupied: false,
          digest: "fnv1a128:no-legacy-occupancy",
        },
      },
    });

    expect(result).toMatchObject({ ok: false, casApplied: false, reason: "legacy-occupancy-precondition-changed" });
    expect(mocks.compareAndSwapSharedValue).not.toHaveBeenCalled();
    expect(mocks.monitorData.materialAccountingSpoolMountStore).toEqual(baseStore);
  });

  it("SpoolMount production commitはCAS不一致ならメモリを更新しない", async () => {
    const baseStore = createEmptyMaterialAccountingSpoolMountStore();
    const mount = createDurableMountFixture();
    const operation = createMountOperationEvent({ recordRefs: [mount.mountId, mount.mountOperationId] });
    const nextStore = normalizeStoredMaterialAccountingSpoolMountStore({
      ...baseStore,
      storeRevision: 1,
      spoolMounts: [mount],
      events: [operation],
    });
    mocks.monitorData.materialAccountingSpoolMountStore = baseStore;
    mocks.monitorData.filamentSpools = [{ id: "spool:a" }];
    mocks.monitorData.materialSourceObservations = createMaterialSourceObservationFixture();
    mocks.compareAndSwapSharedValue.mockResolvedValueOnce({
      ok: false,
      casApplied: false,
      backend: "indexedDB",
      key: "materialAccountingSpoolMountStore",
      reason: "cas-mismatch",
      currentDigest: "digest:other",
      nextDigest: nextStore.storeDigest,
    });

    const result = await commitMaterialAccountingSpoolMountStoreDurably({
      baseStoreDigest: baseStore.storeDigest,
      nextStore,
      operation,
      preconditions: createDurablePreconditions(),
    });

    expect(result).toMatchObject({ ok: false, casApplied: false, reason: "cas-mismatch" });
    expect(mocks.monitorData.materialAccountingSpoolMountStore).toEqual(baseStore);
  });

  it("SpoolMount production commitはlocalStorage fallbackでは成功扱いにしない", async () => {
    mocks.idbAvailable = false;
    const baseStore = createEmptyMaterialAccountingSpoolMountStore();
    const operation = createMountOperationEvent();

    const result = await commitMaterialAccountingSpoolMountStoreDurably({
      baseStoreDigest: baseStore.storeDigest,
      nextStore: normalizeStoredMaterialAccountingSpoolMountStore({ events: [operation] }),
      operation,
    });

    expect(result).toMatchObject({
      ok: false,
      casApplied: false,
      reason: "production-cas-unavailable",
    });
    expect(mocks.compareAndSwapSharedValue).not.toHaveBeenCalled();
  });

  it("SpoolMount production commitはmount/replace operationのprecondition欠落を拒否する", async () => {
    const baseStore = createEmptyMaterialAccountingSpoolMountStore();
    const mount = createDurableMountFixture();
    const operation = createMountOperationEvent({ recordRefs: [mount.mountId, mount.mountOperationId] });
    const nextStore = normalizeStoredMaterialAccountingSpoolMountStore({
      ...baseStore,
      storeRevision: 1,
      spoolMounts: [mount],
      events: [operation],
    });
    mocks.monitorData.materialAccountingSpoolMountStore = baseStore;

    const result = await commitMaterialAccountingSpoolMountStoreDurably({
      baseStoreDigest: baseStore.storeDigest,
      nextStore,
      operation,
    });

    expect(result).toMatchObject({ ok: false, casApplied: false, reason: "operation-preconditions-required" });
    expect(mocks.compareAndSwapSharedValue).not.toHaveBeenCalled();
  });

  it("SpoolMount production commitはoperationがactive nextStoreから復元できない場合に拒否する", async () => {
    const baseStore = createEmptyMaterialAccountingSpoolMountStore();
    const mount = createDurableMountFixture();
    const operation = createMountOperationEvent({ recordRefs: [mount.mountId, mount.mountOperationId] });
    const nextStore = normalizeStoredMaterialAccountingSpoolMountStore({
      ...baseStore,
      storeRevision: 1,
      spoolMounts: [mount],
      events: [{ ...operation, recordRefs: [] }],
    });
    mocks.monitorData.materialAccountingSpoolMountStore = baseStore;
    mocks.monitorData.filamentSpools = [{ id: "spool:a" }];
    mocks.monitorData.materialSourceObservations = createMaterialSourceObservationFixture();

    const result = await commitMaterialAccountingSpoolMountStoreDurably({
      baseStoreDigest: baseStore.storeDigest,
      nextStore,
      operation,
      preconditions: createDurablePreconditions(),
    });

    expect(result).toMatchObject({ ok: false, casApplied: false, reason: "operation-not-active-in-next-store" });
    expect(mocks.compareAndSwapSharedValue).not.toHaveBeenCalled();
  });

  it("SpoolMount production commitはmaterial source preconditionが変わったらCAS前に拒否する", async () => {
    const baseStore = createEmptyMaterialAccountingSpoolMountStore();
    const mount = createDurableMountFixture();
    const operation = createMountOperationEvent({ recordRefs: [mount.mountId, mount.mountOperationId] });
    const nextStore = normalizeStoredMaterialAccountingSpoolMountStore({
      ...baseStore,
      storeRevision: 1,
      spoolMounts: [mount],
      events: [operation],
    });
    mocks.monitorData.materialAccountingSpoolMountStore = baseStore;
    mocks.monitorData.filamentSpools = [{ id: "spool:a" }];
    mocks.monitorData.materialSourceObservations = createMaterialSourceObservationFixture({ identityStrength: "stable" });

    const result = await commitMaterialAccountingSpoolMountStoreDurably({
      baseStoreDigest: baseStore.storeDigest,
      nextStore,
      operation,
      preconditions: createDurablePreconditions(),
    });

    expect(result).toMatchObject({ ok: false, casApplied: false, reason: "material-source-precondition-changed" });
    expect(mocks.compareAndSwapSharedValue).not.toHaveBeenCalled();
  });

  it("restore済みlegacy hostSpoolMapとのcross-backend reconcile結果はCAS保護storeへ専用書き戻しする", async () => {
    const openMountStore = normalizeStoredMaterialAccountingSpoolMountStore({
      spoolMounts: [createDurableMountFixture()],
      events: [],
    });
    mocks.monitorData.materialAccountingSpoolMountStore = openMountStore;
    mocks.monitorData.filamentSpools = [{ id: "spool:a" }];
    mocks.monitorData.hostSpoolMap = { "K1Max-4A1B": "spool:a" };

    await importAllData({
      filamentSpools: [{ id: "spool:a" }],
    });

    expect(mocks.monitorData.materialAccountingSpoolMountStore.spoolMounts).toEqual([]);
    expect(mocks.monitorData.materialAccountingSpoolMountStore.retainedUnsupportedEntries).toEqual([
      expect.objectContaining({
        kind: "spoolMount",
        reason: "legacy-spool-backend-conflict",
      }),
    ]);
    expect(mocks.compareAndSwapSharedValue).toHaveBeenCalledWith(expect.objectContaining({
      key: "materialAccountingSpoolMountStore",
      expectedDigest: openMountStore.storeDigest,
      nextValue: mocks.monitorData.materialAccountingSpoolMountStore,
    }));
    expect(mocks.queueSharedWrite).not.toHaveBeenCalledWith(
      "materialAccountingSpoolMountStore",
      expect.anything()
    );
  });

  it("Universal OPEN mount中のspoolはhostSpoolMap importでlegacy側へ二重装着しない", async () => {
    const openMountStore = normalizeStoredMaterialAccountingSpoolMountStore({
      spoolMounts: [createDurableMountFixture()],
      events: [],
    });
    mocks.monitorData.materialAccountingSpoolMountStore = openMountStore;
    mocks.monitorData.filamentSpools = [{ id: "spool:a" }];
    mocks.monitorData.hostSpoolMap = {};

    await importAllData({
      filamentSpools: [{ id: "spool:a" }],
      hostSpoolMap: { "K1Max-4A1B": "spool:a" },
    });

    expect(mocks.monitorData.hostSpoolMap).toEqual({});
    expect(mocks.monitorData.materialAccountingSpoolMountStore.spoolMounts).toHaveLength(1);
    expect(mocks.compareAndSwapSharedValue).not.toHaveBeenCalledWith(expect.objectContaining({
      key: "materialAccountingSpoolMountStore",
      nextValue: expect.objectContaining({ spoolMounts: [] }),
    }));
  });

  it("Universal reservation中のspoolはhostSpoolMap importでlegacy側へ二重装着しない", async () => {
    mocks.monitorData.materialAccountingSpoolMountStore = createEmptyMaterialAccountingSpoolMountStore();
    mocks.monitorData.filamentSpools = [{ id: "spool:a" }];
    mocks.monitorData.hostSpoolMap = {};
    const reservation = reserveUniversalSpoolAssignment({
      spoolId: "spool:a",
      ownerId: "operation:k2:1a",
      materialSourceId: "material-source:serial-k2:cfs-1:slot-0",
    });
    expect(reservation.ok).toBe(true);

    try {
      await importAllData({
        filamentSpools: [{ id: "spool:a" }],
        hostSpoolMap: { "K1Max-4A1B": "spool:a" },
      });
    } finally {
      reservation.release();
    }

    expect(mocks.monitorData.hostSpoolMap).toEqual({});
    expect(mocks.monitorData.materialAccountingSpoolMountStore.spoolMounts).toEqual([]);
  });

  it("SpoolMount importはCAS成功前にruntime storeへ反映しない", async () => {
    const baseStore = createEmptyMaterialAccountingSpoolMountStore();
    const importedMountStore = normalizeStoredMaterialAccountingSpoolMountStore({
      spoolMounts: [createDurableMountFixture()],
      events: [],
    });
    mocks.monitorData.materialAccountingSpoolMountStore = baseStore;
    mocks.monitorData.filamentSpools = [{ id: "spool:a" }];
    mocks.compareAndSwapSharedValue.mockImplementationOnce(async ({ expectedDigest, nextValue }) => {
      expect(expectedDigest).toBe(baseStore.storeDigest);
      expect(mocks.monitorData.materialAccountingSpoolMountStore).toEqual(baseStore);
      expect(nextValue.spoolMounts).toHaveLength(1);
      return {
        ok: true,
        casApplied: true,
        backend: "indexedDB",
        key: "materialAccountingSpoolMountStore",
        reason: "cas-applied",
        currentDigest: baseStore.storeDigest,
        nextDigest: nextValue.storeDigest,
      };
    });

    await importAllData({
      filamentSpools: [{ id: "spool:a" }],
      materialAccountingSpoolMountStore: importedMountStore,
    });

    expect(mocks.compareAndSwapSharedValue).toHaveBeenCalledWith(expect.objectContaining({
      key: "materialAccountingSpoolMountStore",
      expectedDigest: baseStore.storeDigest,
    }));
    expect(mocks.monitorData.materialAccountingSpoolMountStore.spoolMounts).toHaveLength(1);
  });

  it("incoming Universal OPEN mountだけではlegacy hostSpoolMap importを黙って捨てない", async () => {
    const importedMountStore = normalizeStoredMaterialAccountingSpoolMountStore({
      spoolMounts: [createDurableMountFixture()],
      events: [],
    });
    mocks.monitorData.materialAccountingSpoolMountStore = createEmptyMaterialAccountingSpoolMountStore();
    mocks.monitorData.filamentSpools = [{ id: "spool:a" }];
    mocks.monitorData.hostSpoolMap = {};

    await importAllData({
      filamentSpools: [{ id: "spool:a" }],
      hostSpoolMap: { "K1Max-4A1B": "spool:a" },
      materialAccountingSpoolMountStore: importedMountStore,
    });

    expect(mocks.monitorData.hostSpoolMap).toEqual({ "K1Max-4A1B": "spool:a" });
    expect(mocks.monitorData.materialAccountingSpoolMountStore.spoolMounts).toEqual([]);
    expect(mocks.monitorData.materialAccountingSpoolMountStore.retainedUnsupportedEntries).toEqual([
      expect.objectContaining({
        kind: "spoolMount",
        reason: "legacy-spool-backend-conflict",
      }),
    ]);
  });
});

/**
 * テスト用SpoolMount operation eventを生成する。
 *
 * @function createMountOperationEvent
 * @param {Object} overrides - 上書き値。
 * @returns {Object} operation event。
 */
function createMountOperationEvent(overrides = {}) {
  const operationId = overrides.operationId || "operation:mount:test";
  const payload = overrides.payload || {
    kind: "operator-mount",
    operatorActionId: "action:mount:test",
    operationId,
    materialSourceId: "source:k2:cfs:1a",
    spoolId: "spool:a",
  };
  return {
    eventId: overrides.eventId || "event:mount:test",
    kind: overrides.kind || "operator-mount",
    operatorActionId: overrides.operatorActionId || "action:mount:test",
    operationId,
    payload,
    payloadDigest: overrides.payloadDigest || createMaterialAccountingSpoolMountOperationPayloadDigest(payload),
    recordRefs: overrides.recordRefs || [],
    createdAt: overrides.createdAt || "2026-09-01T04:40:00.000Z",
    actor: overrides.actor || "operator",
  };
}

/**
 * durable commit test用のSpoolMount recordを生成する。
 *
 * @function createDurableMountFixture
 * @returns {Object} SpoolMount record。
 */
function createDurableMountFixture() {
  return createSpoolMountRecord({
    mountId: "mount:k2:1a:spool-a",
    materialSourceId: "source:k2:cfs:1a",
    spoolId: "spool:a",
    mountOperationId: "operation:mount:test",
    openedAt: "2026-09-01T04:40:00.000Z",
    openedBy: "operator",
    verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
    sourceIdentityStrengthAtOpen: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
  });
}

/**
 * durable commit test用のMaterialSource観測storeを生成する。
 *
 * @function createMaterialSourceObservationFixture
 * @param {Object=} overrides - 上書き値。
 * @returns {Object} materialSourceObservations store。
 */
function createMaterialSourceObservationFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    byDeviceId: {
      "device:k2": {
        deviceId: "device:k2",
        latestBySourceId: {
          "source:k2:cfs:1a": {
            sourceId: "source:k2:cfs:1a",
            materialSourceId: "source:k2:cfs:1a",
            kind: "cfs-slot",
            unitId: "unit:k2:cfs:1",
            unitIndex: 1,
            boxId: 1,
            slotId: 0,
            identityStrength: overrides.identityStrength || "provisional",
            materialSourceIdentityStrength: overrides.identityStrength || "provisional",
          },
        },
      },
    },
  };
}

/**
 * durable commit test用のprecondition群を生成する。
 *
 * @function createDurablePreconditions
 * @returns {Object} precondition群。
 */
function createDurablePreconditions() {
  const spool = { id: "spool:a" };
  const noLegacyOccupancy = null;
  const locator = createMaterialSourceLocator({
    kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
    index: null,
    unitIndex: 1,
    boxId: 1,
    slotIndex: 0,
    protocolSlotId: "0",
  });
  const sourceIdentity = createMaterialSourceIdentity({
    deviceId: "device:k2",
    unitId: "unit:k2:cfs:1",
    kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
    slotIndex: locator.slotIndex,
    index: locator.index,
  });
  const sourceBinding = createMaterialSourceRecord({
    deviceId: "device:k2",
    unitId: "unit:k2:cfs:1",
    kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
    locator,
    identity: sourceIdentity,
    identityStrength: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
    displayLabel: "1A",
    aliases: ["source:k2:cfs:1a"],
  });
  return {
    materialSource: {
      deviceId: "device:k2",
      materialSourceId: sourceBinding.materialSourceId,
      sourceIdentityDigest: createPrinterCoreV3DeterministicId("material-source-binding", [
        sourceBinding.deviceId,
        sourceBinding.materialSourceId,
        sourceBinding.unitId,
        sourceBinding.kind,
        sourceBinding.identityStrength,
        sourceBinding.identity,
        sourceBinding.locator,
      ]),
    },
    managedSpool: {
      spoolId: "spool:a",
      digest: `fnv1a128:${createPrinterCoreV3DeterministicId("material-accounting-managed-spool-precondition", [
        stableStringifyPrinterCoreV3Value(spool),
      ])}`,
      deleted: false,
    },
    legacyOccupancy: {
      spoolId: "spool:a",
      expectedDeviceId: "device:k2",
      occupied: false,
      digest: `fnv1a128:${createPrinterCoreV3DeterministicId("material-accounting-legacy-occupancy-precondition", [
        stableStringifyPrinterCoreV3Value(noLegacyOccupancy),
      ])}`,
    },
  };
}
