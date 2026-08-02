/**
 * @fileoverview dashboard_storage.js の耐久保存 API テスト
 * O4 candidate 保存後に baseline commit へ進む前、IndexedDB flush 完了を待つ契約を検証する。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

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
    inferredRecoveryEvents: [],
    pendingUnattributedUsage: [],
    pendingUnattributedUsageArchive: {},
    ledgerRepairRequired: {},
    filamentEventContext: {},
    hostSpoolMap: {},
    hostCameraToggle: {},
    spoolSerialCounter: 0
  },
  queueSharedWrite: vi.fn((key) => { mocks.events.push(`queue:${key}`); }),
  queueMachineWrite: vi.fn((host) => { mocks.events.push(`machine:${host}`); }),
  flushIdb: vi.fn(async () => { mocks.events.push("flush"); })
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
  setIdbDbName: vi.fn()
}));

const { initStorage, saveUnifiedStorageDurably } = await import("../../3dp_lib/dashboard_storage.js");

beforeEach(async () => {
  mocks.events.length = 0;
  mocks.idbAvailable = true;
  mocks.monitorData.machines = { k1: { storedData: {}, printStore: { history: [] }, runtimeData: { transient: true } } };
  mocks.monitorData.inferredCandidateStore = { "ic-a": { candidateHash: "ic-a", usedMm: 1200 } };
  mocks.monitorData.inferredDecisionRecoveryRequired = { candidateHash: "ic-a", reason: "rollback_durable_save_failed" };
  mocks.monitorData.inferredRecoveryEvents = [{ eventId: "ir-a", type: "recovery-durable-save-retried" }];
  mocks.monitorData.hostObservationWatermark = { k1: { observationSequence: 1 } };
  mocks.queueSharedWrite.mockClear();
  mocks.queueMachineWrite.mockClear();
  mocks.flushIdb.mockClear();
  mocks.flushIdb.mockImplementation(async () => { mocks.events.push("flush"); });
  await initStorage();
});

describe("saveUnifiedStorageDurably", () => {
  it("IndexedDB 使用時は queueSharedWrite 後に flushIdb 完了を待つ", async () => {
    const result = await saveUnifiedStorageDurably();

    expect(result).toEqual({ ok: true, backend: "indexedDB", reason: "flushed" });
    expect(mocks.queueSharedWrite).toHaveBeenCalledWith("inferredCandidateStore", mocks.monitorData.inferredCandidateStore);
    expect(mocks.queueSharedWrite).toHaveBeenCalledWith("inferredDecisionRecoveryRequired", mocks.monitorData.inferredDecisionRecoveryRequired);
    expect(mocks.queueSharedWrite).toHaveBeenCalledWith("inferredRecoveryEvents", mocks.monitorData.inferredRecoveryEvents);
    expect(mocks.queueSharedWrite).toHaveBeenCalledWith("hostObservationWatermark", mocks.monitorData.hostObservationWatermark);
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
      throw new DOMException("quota", "QuotaExceededError");
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
});
