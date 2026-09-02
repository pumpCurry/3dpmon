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
 * @version 1.390.1658 (PR #440)
 * @since   1.390.1641 (PR #441)
 * @lastModified 2026-09-02 18:32:30
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
  idbAvailable: false,
  queueSharedWrite: vi.fn(),
  queueMachineWrite: vi.fn(),
  protectedIntervals: [],
  attributedUsed: vi.fn(() => 0),
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
vi.mock("../../3dp_lib/dashboard_filament_ledger.js", () => ({
  initLedgerAnchors: vi.fn(),
  quarantineInvalidMountEvents: vi.fn(() => 0),
  getSpoolIntervals: vi.fn(() => mocks.protectedIntervals),
  attributedUsed: mocks.attributedUsed
}));
vi.mock("../../3dp_lib/dashboard_target_identity.js", () => ({ parseDest: vi.fn(), isIpLiteral: vi.fn(), extractHost: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_storage_idb.js", () => ({
  initIdb: vi.fn(),
  isIdbAvailable: () => mocks.idbAvailable,
  getIdbCache: () => null,
  queueSharedWrite: mocks.queueSharedWrite,
  queueMachineWrite: mocks.queueMachineWrite,
  flushIdb: vi.fn(async () => {}),
  exportAllIdb: vi.fn(),
  importAllIdb: vi.fn(),
  compareAndSwapSharedValue: vi.fn(),
  setIdbDbName: vi.fn()
}));

const {
  applyPrintHistoryRetention,
  applyConfiguredPrintHistoryRetentionToAllMachines,
  initStorage,
  recordPrintHistoryFetchCoverage,
  resolvePrintHistoryRetentionLimit,
  resolveUsageHistoryRetentionLimit,
  restoreUnifiedStorage,
  savePrintHistory,
  saveUnifiedStorage,
  trimUsageHistory
} = await import("../../3dp_lib/dashboard_storage.js");

function makeHistory(count) {
  return Array.from({ length: count }, (_, index) => ({ id: count - index, filename: `job-${count - index}.gcode` }));
}

function makePrintBindingStoreRecordArray(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({ [`${prefix}Id`]: `${prefix}:${index}` }));
}

beforeEach(() => {
  globalThis.localStorage = new LocalStorageStub();
  mocks.monitorData.appSettings = { printHistoryMaxEntries: 0 };
  mocks.monitorData.machines = {};
  mocks.monitorData.usageHistory = [];
  mocks.monitorData.usageHistoryRev = 0;
  mocks.monitorData.materialAccountingPrintBindingStore = {};
  mocks.idbAvailable = false;
  mocks.queueSharedWrite.mockClear();
  mocks.queueMachineWrite.mockClear();
  mocks.protectedIntervals = [];
  mocks.attributedUsed.mockReset();
  mocks.attributedUsed.mockReturnValue(0);
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

  it("保持上限は十進整数だけを受理し、booleanや指数表記などの暗黙変換を拒否する", () => {
    expect(resolvePrintHistoryRetentionLimit({ printHistoryMaxEntries: true })).toBe(0);
    expect(resolvePrintHistoryRetentionLimit({ printHistoryMaxEntries: "0x10" })).toBe(0);
    expect(resolvePrintHistoryRetentionLimit({ printHistoryMaxEntries: "1e3" })).toBe(0);
    expect(resolvePrintHistoryRetentionLimit({ printHistoryMaxEntries: [10] })).toBe(0);
    expect(resolvePrintHistoryRetentionLimit({ printHistoryMaxEntries: "1500" })).toBe(1500);
    expect(resolveUsageHistoryRetentionLimit({ usageHistoryMaxEntries: "4500" })).toBe(4500);
    expect(resolveUsageHistoryRetentionLimit({ usageHistoryMaxEntries: false })).toBe(0);
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
    expect(mocks.monitorData.machines.K1Max.printStore.historyCoverage).toMatchObject({
      activeAnchorComplete: true,
      totalLifetimeComplete: false,
      source: "print-history-retention",
      sourceLength: 3,
      retainedLength: 2,
      limit: 2
    });
  });

  it("保持上限適用時も台帳残量導出に必要な装着区間内の消費ジョブを削除しない", () => {
    mocks.monitorData.appSettings.printHistoryMaxEntries = 1;
    mocks.monitorData.filamentSpools = [{ id: "spool-a", deleted: false }];
    mocks.protectedIntervals = [
      { spoolId: "spool-a", host: "K1Max", sinceJobId: 100, untilJobId: null, open: true }
    ];
    mocks.attributedUsed.mockImplementation((job, spoolId) => (
      spoolId === "spool-a" && Number(job?.materialUsedMm) > 0 ? Number(job.materialUsedMm) : 0
    ));
    mocks.monitorData.machines = {
      K1Max: {
        printStore: {
          history: [
            { id: 103, filename: "third.gcode", materialUsedMm: 1000 },
            { id: 102, filename: "second.gcode", materialUsedMm: 1000 },
            { id: 101, filename: "first.gcode", materialUsedMm: 1000 },
            { id: 99, filename: "before-anchor.gcode", materialUsedMm: 1000 }
          ],
          current: null,
          videos: {}
        }
      }
    };

    const result = applyConfiguredPrintHistoryRetentionToAllMachines();

    expect(result.changedHosts).toEqual(["K1Max"]);
    expect(result.removedJobs).toBe(1);
    expect(mocks.monitorData.machines.K1Max.printStore.history.map((job) => job.id)).toEqual([103, 102, 101]);
  });

  it("保持上限適用時はanchor直後の数値sentinelをcoverage証明として扱わない", () => {
    mocks.monitorData.appSettings.printHistoryMaxEntries = 1;
    mocks.monitorData.filamentSpools = [{ id: "spool-a", deleted: false }];
    mocks.protectedIntervals = [
      { spoolId: "spool-a", host: "K1Max", sinceJobId: 100, untilJobId: null, open: true }
    ];
    mocks.attributedUsed.mockImplementation((job, spoolId) => (
      spoolId === "spool-a" && Number(job?.materialUsedMm) > 0 ? Number(job.materialUsedMm) : 0
    ));
    mocks.monitorData.machines = {
      K1Max: {
        printStore: {
          history: [
            { id: 103, filename: "third.gcode", materialUsedMm: 1000 },
            { id: 102, filename: "second.gcode", materialUsedMm: 1000 },
            { id: 101, filename: "anchor-plus-one.gcode", materialUsedMm: 0 },
            { id: 99, filename: "before-anchor.gcode", materialUsedMm: 1000 }
          ],
          current: null,
          videos: {}
        }
      }
    };

    const result = applyConfiguredPrintHistoryRetentionToAllMachines();

    expect(result.changedHosts).toEqual(["K1Max"]);
    expect(result.removedJobs).toBe(2);
    expect(mocks.monitorData.machines.K1Max.printStore.history.map((job) => job.id)).toEqual([103, 102]);
    expect(mocks.monitorData.machines.K1Max.printStore.historyCoverage).toMatchObject({
      activeAnchorComplete: false,
      totalLifetimeComplete: false,
      source: "print-history-retention"
    });
  });

  it("fetch windowがactive anchorを跨がない場合はactive anchor coverageを未完了にする", () => {
    mocks.monitorData.filamentSpools = [{ id: "spool-a", deleted: false }];
    mocks.protectedIntervals = [
      { spoolId: "spool-a", host: "K1Max", sinceJobId: 1700000000, untilJobId: null, open: true }
    ];
    mocks.monitorData.machines = {
      K1Max: {
        printStore: {
          history: [],
          current: null,
          videos: {}
        }
      }
    };

    const result = recordPrintHistoryFetchCoverage("K1Max", [
      { id: 1700000600, filename: "new.gcode" },
      { id: 1700000500, filename: "oldest-window.gcode" }
    ]);

    expect(result).toMatchObject({
      recorded: true,
      activeAnchorComplete: false,
      oldestPrintJobId: 1700000500,
      newestPrintJobId: 1700000600,
      anchorSinceJobIds: [1700000000]
    });
    expect(mocks.monitorData.machines.K1Max.printStore.historyCoverage).toMatchObject({
      activeAnchorComplete: false,
      source: "print-history-fetch",
      coverageProof: "fetch-window-crosses-active-anchor"
    });
  });

  it("fetch windowがactive anchorを跨ぐ場合はactive anchor coverageを完了にする", () => {
    mocks.monitorData.filamentSpools = [{ id: "spool-a", deleted: false }];
    mocks.protectedIntervals = [
      { spoolId: "spool-a", host: "K1Max", sinceJobId: 1700000000, untilJobId: null, open: true }
    ];

    const result = recordPrintHistoryFetchCoverage("K1Max", [
      { id: 1700000600, filename: "new.gcode" },
      { id: 1699999900, filename: "before-anchor.gcode" }
    ]);

    expect(result).toMatchObject({
      recorded: true,
      activeAnchorComplete: true,
      oldestPrintJobId: 1699999900,
      newestPrintJobId: 1700000600,
      anchorSinceJobIds: [1700000000]
    });
    expect(mocks.monitorData.machines.K1Max.printStore.historyCoverage).toMatchObject({
      activeAnchorComplete: true,
      source: "print-history-fetch",
      coverageProof: "fetch-window-crosses-active-anchor"
    });
  });

  it("復元されたfetch coverageは再probe前にactive anchor証明として扱わない", () => {
    globalThis.localStorage.setItem("3dpmon-global", JSON.stringify({
      appSettings: { printHistoryMaxEntries: 2 }
    }));
    globalThis.localStorage.setItem("3dpmon-host-K1Max", JSON.stringify({
      printStore: {
        history: [
          { id: 1700000600, filename: "latest.gcode" },
          { id: 1699999900, filename: "before-anchor.gcode" }
        ],
        historyCoverage: {
          activeAnchorComplete: true,
          totalLifetimeComplete: false,
          source: "print-history-fetch",
          observedAt: 1700000700,
          oldestPrintJobId: 1699999900,
          newestPrintJobId: 1700000600,
          anchorSinceJobIds: [1700000000],
          coverageProof: "fetch-window-crosses-active-anchor"
        },
        current: null,
        videos: {}
      }
    }));

    restoreUnifiedStorage();

    expect(mocks.monitorData.machines.K1Max.printStore.historyCoverage).toMatchObject({
      activeAnchorComplete: false,
      totalLifetimeComplete: false,
      source: "print-history-fetch-restore-reprobe-required",
      staleSource: "print-history-fetch"
    });
  });

  it("保持上限適用時はPrintBinding完了証跡が未commitのjob履歴を削除しない", () => {
    mocks.monitorData.appSettings.printHistoryMaxEntries = 1;
    mocks.monitorData.materialAccountingPrintBindingStore = {
      printStartSnapshots: [
        {
          snapshotId: "snapshot:pending-a",
          printJobId: "job:pending",
          printPlanId: "plan:pending",
          deviceId: "serial:k2"
        }
      ],
      jobMaterialSegments: []
    };
    mocks.monitorData.machines = {
      K2Pro: {
        printStore: {
          history: [
            { id: 103, printJobId: "job:new", filename: "new.gcode" },
            { id: 102, printJobId: "job:pending", filename: "pending.gcode" },
            { id: 101, printJobId: "job:old", filename: "old.gcode" }
          ],
          current: null,
          videos: {}
        }
      }
    };

    const result = applyConfiguredPrintHistoryRetentionToAllMachines();

    expect(result.changedHosts).toEqual(["K2Pro"]);
    expect(result.removedJobs).toBe(1);
    expect(mocks.monitorData.machines.K2Pro.printStore.history.map((job) => job.id)).toEqual([103, 102]);
  });

  it("保持上限適用時は別deviceの同一printJobId完了segmentでpending PrintBindingを完了扱いしない", () => {
    mocks.monitorData.appSettings.printHistoryMaxEntries = 1;
    mocks.monitorData.materialAccountingPrintBindingStore = {
      printStartSnapshots: [
        {
          snapshotId: "snapshot:pending-b",
          printJobId: "job:shared-epoch",
          printPlanId: "plan:k2-b",
          deviceId: "serial:k2-b"
        }
      ],
      jobMaterialSegments: [
        {
          segmentId: "segment:completed-a",
          printJobId: "job:shared-epoch",
          printPlanId: "plan:k2-a",
          deviceId: "serial:k2-a",
          usedLengthMm: 1234,
          usageState: "observed-used"
        }
      ]
    };
    mocks.monitorData.machines = {
      K2ProB: {
        printStore: {
          history: [
            { id: 103, printJobId: "job:new", printPlanId: "plan:k2-b-new", filename: "new.gcode" },
            { id: 102, printJobId: "job:shared-epoch", printPlanId: "plan:k2-b", filename: "pending-b.gcode" },
            { id: 101, printJobId: "job:old", printPlanId: "plan:k2-b-old", filename: "old.gcode" }
          ],
          current: null,
          videos: {}
        }
      }
    };

    const result = applyConfiguredPrintHistoryRetentionToAllMachines();

    expect(result.changedHosts).toEqual(["K2ProB"]);
    expect(result.removedJobs).toBe(1);
    expect(mocks.monitorData.machines.K2ProB.printStore.history.map((job) => job.id)).toEqual([103, 102]);
  });

  it("保存前にapplyPrintHistoryRetentionされた履歴でも明示retention coverageを記録する", () => {
    mocks.monitorData.appSettings.printHistoryMaxEntries = 2;
    mocks.monitorData.machines = {
      K2Pro: {
        printStore: {
          history: [
            { id: 104, printJobId: "job:4", filename: "fourth.gcode" },
            { id: 103, printJobId: "job:3", filename: "third.gcode" },
            { id: 102, printJobId: "job:2", filename: "second.gcode" },
            { id: 101, printJobId: "job:1", filename: "first.gcode" }
          ],
          current: null,
          videos: {}
        }
      }
    };

    const retained = applyPrintHistoryRetention(
      mocks.monitorData.machines.K2Pro.printStore.history,
      mocks.monitorData.appSettings,
      { host: "K2Pro" }
    );

    expect(retained.map((job) => job.id)).toEqual([104, 103]);
    expect(mocks.monitorData.machines.K2Pro.printStore.historyCoverage).toMatchObject({
      activeAnchorComplete: true,
      totalLifetimeComplete: false,
      source: "print-history-retention",
      sourceLength: 4,
      retainedLength: 2,
      limit: 2
    });
  });

  it("IndexedDB利用時のlocalStorage回復バックアップは無制限設定でも履歴をbounded snapshotとして保存する", async () => {
    mocks.idbAvailable = true;
    mocks.monitorData.appSettings.printHistoryMaxEntries = 0;
    mocks.monitorData.appSettings.usageHistoryMaxEntries = 0;
    mocks.monitorData.usageHistory = Array.from({ length: 4502 }, (_, index) => ({ usageId: `u-${index}` }));
    mocks.monitorData.materialAccountingPrintBindingStore = {
      schemaVersion: 1,
      authority: "material-accounting-print-binding-shadow-store",
      printStartSnapshots: makePrintBindingStoreRecordArray("snapshot", 1502),
      usageEvidence: makePrintBindingStoreRecordArray("evidence", 1502),
      jobMaterialSegments: makePrintBindingStoreRecordArray("segment", 1502),
      ledgerEvents: makePrintBindingStoreRecordArray("ledgerEvent", 1502),
      unattributedUsage: makePrintBindingStoreRecordArray("unattributedUsage", 1502),
      retainedUnsupportedEntries: makePrintBindingStoreRecordArray("retainedUnsupportedEntry", 1502)
    };
    mocks.monitorData.machines = {
      "K2Pro-69E7": {
        storedData: {},
        runtimeData: { socket: "not-serializable" },
        historyData: [],
        printStore: { history: makeHistory(1502), current: null, videos: {} }
      }
    };

    await initStorage();
    saveUnifiedStorage(true);

    const hostBackup = JSON.parse(globalThis.localStorage.getItem("3dpmon-host-K2Pro-69E7"));
    const globalBackup = JSON.parse(globalThis.localStorage.getItem("3dpmon-global"));
    expect(hostBackup.printStore.history).toHaveLength(1500);
    expect(hostBackup.printStore.historyBackupTruncated).toBe(true);
    expect(hostBackup.runtimeData).toBeUndefined();
    expect(globalBackup.usageHistory).toHaveLength(4500);
    expect(globalBackup.storageRecoveryBackup?.usageHistoryTruncated).toBe(true);
    expect(globalBackup.materialAccountingPrintBindingStore.printStartSnapshots).toHaveLength(1500);
    expect(globalBackup.materialAccountingPrintBindingStore.usageEvidence).toHaveLength(1500);
    expect(globalBackup.materialAccountingPrintBindingStore.jobMaterialSegments).toHaveLength(1500);
    expect(globalBackup.materialAccountingPrintBindingStore.ledgerEvents).toHaveLength(1500);
    expect(globalBackup.materialAccountingPrintBindingStore.unattributedUsage).toHaveLength(1500);
    expect(globalBackup.materialAccountingPrintBindingStore.retainedUnsupportedEntries).toHaveLength(1500);
    expect(globalBackup.storageRecoveryBackup?.materialAccountingPrintBindingStore).toMatchObject({
      truncated: true,
      backupLimit: 1500,
      printStartSnapshotsSourceLength: 1502,
      usageEvidenceSourceLength: 1502,
      jobMaterialSegmentsSourceLength: 1502,
      ledgerEventsSourceLength: 1502,
      unattributedUsageSourceLength: 1502,
      retainedUnsupportedEntriesSourceLength: 1502
    });
    expect(mocks.queueMachineWrite.mock.calls[0][1].printStore.history).toHaveLength(1502);
  });

  it("truncatedされたlocalStorage回復バックアップのPrintBinding storeはauthorityとして復元しない", () => {
    globalThis.localStorage.setItem("3dpmon-global", JSON.stringify({
      appSettings: { printHistoryMaxEntries: 0 },
      materialAccountingPrintBindingStore: {
        retainedUnsupportedEntries: [{ reason: "would-be-restored-if-not-truncated" }]
      },
      storageRecoveryBackup: {
        materialAccountingPrintBindingStore: {
          truncated: true,
          backupLimit: 1500,
          retainedUnsupportedEntriesSourceLength: 1502
        }
      }
    }));

    restoreUnifiedStorage();

    expect(mocks.monitorData.materialAccountingPrintBindingStore.retainedUnsupportedEntries).toEqual([]);
  });

  it("localStorage回復バックアップがtruncatedなら復元後の履歴を台帳authority不完全として印付けする", () => {
    globalThis.localStorage.setItem("3dpmon-global", JSON.stringify({
      appSettings: { printHistoryMaxEntries: 0 },
      filamentSpools: [{ id: "spool-a", remainingLengthMm: 1000, totalLengthMm: 1000 }]
    }));
    globalThis.localStorage.setItem("3dpmon-host-K2Pro-69E7", JSON.stringify({
      storedData: {},
      printStore: {
        history: makeHistory(1500),
        current: null,
        videos: {},
        historyBackupTruncated: true,
        historyBackupSourceLength: 1502,
        historyBackupLimit: 1500
      }
    }));

    restoreUnifiedStorage();

    expect(mocks.monitorData.machines["K2Pro-69E7"].printStore).toMatchObject({
      historyAuthorityIncomplete: true,
      historyAuthoritySource: "localStorage-bounded-recovery-backup",
      historyAuthoritySourceLength: 1502,
      historyAuthorityLimit: 1500
    });
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
