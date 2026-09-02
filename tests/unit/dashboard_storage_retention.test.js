/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 ストレージ保持設定単体テスト
 * @file dashboard_storage_retention.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_storage_retention_test
 *
 * 【機能内容サマリ】
 * - 印刷履歴の自動削除設定が既定OFFであることを検証
 * - 明示された上限設定だけが印刷履歴を古い順に削除することを検証
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1641 (PR #441)
 * @since   1.390.1641 (PR #441)
 * @lastModified 2026-09-02 13:38:32
 * -----------------------------------------------------------
 * @todo
 * - none
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

class LocalStorageStub {
  constructor() { this._m = new Map(); }
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }
  setItem(k, v) { this._m.set(String(k), String(v)); }
  removeItem(k) { this._m.delete(k); }
  clear() { this._m.clear(); }
  key(i) { return Array.from(this._m.keys())[i] ?? null; }
  get length() { return this._m.size; }
}

const mocks = vi.hoisted(() => ({
  monitorData: {
    appSettings: {
      printHistoryMaxEntries: 0
    },
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
    materialAccountingMigrationJournal: {},
    materialAccountingMigrationShadowStore: {},
    materialAccountingPrintBindingStore: {},
    materialAccountingSpoolMountStore: {},
    physicalCommandRecoveryLatch: {},
    hostSpoolMap: {},
    hostCameraToggle: {},
    spoolSerialCounter: 0
  }
}));

vi.mock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: mocks.monitorData,
  PLACEHOLDER_HOSTNAME: "_$_NO_MACHINE_$_",
  ensureMachineData: vi.fn((host) => {
    mocks.monitorData.machines[host] ??= {
      storedData: {},
      runtimeData: {},
      historyData: [],
      printStore: { current: null, history: [], videos: {} }
    };
  })
}));
vi.mock("../../3dp_lib/dashboard_filament_presets.js", () => ({ FILAMENT_PRESETS: [] }));
vi.mock("../../3dp_lib/dashboard_log_util.js", () => ({ logManager: { add: vi.fn() } }));
vi.mock("../../3dp_lib/dashboard_utils.js", () => ({ getCurrentTimestamp: () => 0 }));
vi.mock("../../3dp_lib/dashboard_filament_ledger.js", () => ({ initLedgerAnchors: vi.fn(), quarantineInvalidMountEvents: vi.fn(() => 0) }));
vi.mock("../../3dp_lib/dashboard_target_identity.js", () => ({ parseDest: vi.fn(), isIpLiteral: vi.fn(), extractHost: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_storage_idb.js", () => ({
  initIdb: vi.fn(),
  isIdbAvailable: () => false,
  getIdbCache: () => null,
  queueSharedWrite: vi.fn(),
  queueMachineWrite: vi.fn(),
  flushIdb: vi.fn(async () => {}),
  exportAllIdb: vi.fn(),
  importAllIdb: vi.fn(),
  compareAndSwapSharedValue: vi.fn(),
  setIdbDbName: vi.fn()
}));

const {
  applyPrintHistoryRetention,
  applyConfiguredPrintHistoryRetentionToAllMachines,
  resolvePrintHistoryRetentionLimit,
  savePrintHistory,
  trimUsageHistory
} = await import("../../3dp_lib/dashboard_storage.js");

function makeHistory(count) {
  return Array.from({ length: count }, (_, index) => ({ id: count - index, filename: `job-${count - index}.gcode` }));
}

beforeEach(() => {
  globalThis.localStorage = new LocalStorageStub();
  mocks.monitorData.appSettings = { printHistoryMaxEntries: 0 };
  mocks.monitorData.machines = {};
  mocks.monitorData.usageHistory = [];
  mocks.monitorData.usageHistoryRev = 0;
});

describe("印刷履歴保持設定", () => {
  it("既定では印刷履歴を件数上限で自動削除しない", () => {
    const history = makeHistory(1502);

    savePrintHistory(history, "K2Pro-69E7");

    expect(mocks.monitorData.machines["K2Pro-69E7"].printStore.history).toHaveLength(1502);
  });

  it("明示された上限がある場合だけ古い印刷履歴を削除する", () => {
    mocks.monitorData.appSettings.printHistoryMaxEntries = 3;
    const history = makeHistory(5);

    savePrintHistory(history, "K2Pro-69E7");

    expect(mocks.monitorData.machines["K2Pro-69E7"].printStore.history.map((job) => job.id)).toEqual([5, 4, 3]);
  });

  it("保持上限は0または未設定なら無制限として解釈する", () => {
    expect(resolvePrintHistoryRetentionLimit({ printHistoryMaxEntries: 0 })).toBe(0);
    expect(resolvePrintHistoryRetentionLimit({})).toBe(0);
    expect(applyPrintHistoryRetention(makeHistory(4), { printHistoryMaxEntries: 0 })).toHaveLength(4);
  });

  it("設定変更時に全ホストの既存印刷履歴へ保持上限を適用できる", () => {
    mocks.monitorData.appSettings.printHistoryMaxEntries = 2;
    mocks.monitorData.machines = {
      K1Max: { printStore: { history: makeHistory(3), current: null, videos: {} } },
      K2Pro: { printStore: { history: makeHistory(4), current: null, videos: {} } },
      Empty: { printStore: { history: makeHistory(1), current: null, videos: {} } }
    };

    const result = applyConfiguredPrintHistoryRetentionToAllMachines();

    expect(result).toEqual({ changedHosts: ["K1Max", "K2Pro"], removedJobs: 3, limit: 2 });
    expect(mocks.monitorData.machines.K1Max.printStore.history.map((job) => job.id)).toEqual([3, 2]);
    expect(mocks.monitorData.machines.K2Pro.printStore.history.map((job) => job.id)).toEqual([4, 3]);
    expect(mocks.monitorData.machines.Empty.printStore.history.map((job) => job.id)).toEqual([1]);
  });
});

describe("フィラメント使用履歴保持設定", () => {
  it("既定では使用履歴を件数上限で自動削除しない", () => {
    mocks.monitorData.usageHistory = Array.from({ length: 4502 }, (_, index) => ({ usedLength: index + 1 }));

    trimUsageHistory();

    expect(mocks.monitorData.usageHistory).toHaveLength(4502);
    expect(mocks.monitorData.usageHistoryRev).toBe(0);
  });

  it("明示された使用履歴上限がある場合だけ古い記録を削除する", () => {
    mocks.monitorData.appSettings.usageHistoryMaxEntries = 3;
    mocks.monitorData.usageHistory = [
      { spoolId: "a", usedLength: 1 },
      { spoolId: "a", startLength: 100 },
      { spoolId: "a", usedLength: 2 },
      { spoolId: "b", startLength: 200 },
      { spoolId: "b", usedLength: 3 }
    ];

    trimUsageHistory();

    expect(mocks.monitorData.usageHistory).toEqual([
      { spoolId: "a", startLength: 100 },
      { spoolId: "a", usedLength: 2 },
      { spoolId: "b", startLength: 200 },
      { spoolId: "b", usedLength: 3 }
    ]);
    expect(mocks.monitorData.usageHistoryRev).toBe(1);
  });
});
