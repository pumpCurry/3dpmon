/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 storage migration/round-trip 単体テスト
 * @file dashboard_storage_migration.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_storage_migration_test
 *
 * 【機能内容サマリ】
 * - 新旧ストレージデータの保存/復元/import互換性を検証
 * - runtimeDataを永続化しない境界を検証
 * - Gate 18.9H SpoolMount production storeをlegacy台帳へ投影しない境界を検証
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1644 (PR #441)
 * @since   1.390.1580 (PR #440)
 * @lastModified 2026-09-02 14:10:41
 * -----------------------------------------------------------
 * @todo
 * - none
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/* ── localStorage スタブ（node 環境用） ── */
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

/* ── 可変 monitorData モック（storage.js が参照を保持し破壊的に更新する） ── */
const monitorData = {
  appSettings: { connectionTargets: [], panelLayout: [] },
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
  pendingUnattributedUsage: [],
  pendingUnattributedUsageArchive: {},
  inferredCandidateStore: {},
  inferredDecisionRecoveryRequired: null,
  inferredRecoveryOperationRecoveryRequired: null,
  inferredRecoveryEvents: [],
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
  materialAccountingMigrationShadowStore: {
    schemaVersion: 1,
    authority: "migration-shadow-commit-store",
    materialSourceRegistrySnapshot: { sources: [], conflicts: [] },
    spoolMountRepositorySnapshot: { mounts: [], conflicts: [] },
    committedTransactionsById: {},
    committedOperationsById: {},
    lifecycleBySubject: {},
    events: [],
    retainedUnsupportedEntries: [],
    invariants: {
      ledgerWrites: false,
      legacyCutoverSealed: false,
      materialSourceRepositoryWrites: "shadow-only",
      spoolMountRepositoryWrites: "shadow-only",
    },
  },
  materialAccountingPrintBindingStore: {
    schemaVersion: 1,
    authority: "material-accounting-print-binding-shadow-store",
    printStartSnapshots: [],
    usageEvidence: [],
    jobMaterialSegments: [],
    ledgerEvents: [],
    unattributedUsage: [],
    operationsById: {},
    invariants: {
      legacyUsageHistoryWrites: false,
      legacySpoolRemainingWrites: false,
      materialSourceLedgerWrites: "shadow-only",
    },
  },
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
  physicalCommandRecoveryLatch: {
    schemaVersion: 1,
    authority: "physical-command-recovery-latch",
    unresolvedByCommandId: {},
    events: [],
    retainedUnsupportedEntries: [],
    invariants: {
      autoReplay: false,
      commandFramePersistence: false,
      physicalCommandAuthority: "recovery-latch-only",
    },
  },
  hostSpoolMap: {},
  hostCameraToggle: {},
  spoolSerialCounter: 0,
};

/** monitorData を初期状態へ戻す（参照は維持＝storage.js の束縛を壊さない） */
function resetMonitorData() {
  monitorData.appSettings = { connectionTargets: [], panelLayout: [] };
  monitorData.machines = {};
  monitorData.filamentSpools = [];
  monitorData.usageHistory = [];
  monitorData.filamentPresets = [];
  monitorData.userPresets = [];
  monitorData.hiddenPresets = [];
  monitorData.favoritePresets = [];
  monitorData.filamentInventory = [];
  monitorData.mountHistory = [];
  monitorData.filamentEventContext = {};
  monitorData.mountHistorySeq = 0;
  monitorData.pendingUnattributedUsage = [];
  monitorData.pendingUnattributedUsageArchive = {};
  monitorData.inferredCandidateStore = {};
  monitorData.inferredDecisionRecoveryRequired = null;
  monitorData.inferredRecoveryOperationRecoveryRequired = null;
  monitorData.inferredRecoveryEvents = [];
  monitorData.ledgerRepairRequired = {};
  monitorData.hostSpoolMap = {};
  monitorData.materialSourceObservations = { schemaVersion: 1, byDeviceId: {} };
  monitorData.materialAccountingMigrationJournal = {
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
  };
  monitorData.materialAccountingMigrationShadowStore = {
    schemaVersion: 1,
    authority: "migration-shadow-commit-store",
    materialSourceRegistrySnapshot: { sources: [], conflicts: [] },
    spoolMountRepositorySnapshot: { mounts: [], conflicts: [] },
    committedTransactionsById: {},
    committedOperationsById: {},
    lifecycleBySubject: {},
    events: [],
    retainedUnsupportedEntries: [],
    invariants: {
      ledgerWrites: false,
      legacyCutoverSealed: false,
      materialSourceRepositoryWrites: "shadow-only",
      spoolMountRepositoryWrites: "shadow-only",
    },
  };
  monitorData.materialAccountingPrintBindingStore = {
    schemaVersion: 1,
    authority: "material-accounting-print-binding-shadow-store",
    printStartSnapshots: [],
    usageEvidence: [],
    jobMaterialSegments: [],
    ledgerEvents: [],
    unattributedUsage: [],
    operationsById: {},
    invariants: {
      legacyUsageHistoryWrites: false,
      legacySpoolRemainingWrites: false,
      materialSourceLedgerWrites: "shadow-only",
    },
  };
  monitorData.materialAccountingSpoolMountStore = {
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
  };
  monitorData.physicalCommandRecoveryLatch = {
    schemaVersion: 1,
    authority: "physical-command-recovery-latch",
    unresolvedByCommandId: {},
    events: [],
    retainedUnsupportedEntries: [],
    invariants: {
      autoReplay: false,
      commandFramePersistence: false,
      physicalCommandAuthority: "recovery-latch-only",
    },
  };
  monitorData.hostCameraToggle = {};
  monitorData.spoolSerialCounter = 0;
}

vi.mock('../../3dp_lib/dashboard_data.js', () => ({
  monitorData,
  PLACEHOLDER_HOSTNAME: '_$_NO_MACHINE_$_',
  ensureMachineData: (host) => {
    if (!monitorData.machines[host]) {
      monitorData.machines[host] = { storedData: {}, printStore: { history: [], current: null, videos: {} }, runtimeData: {} };
    } else {
      const m = monitorData.machines[host];
      if (!m.storedData) m.storedData = {};
      if (!m.printStore) m.printStore = { history: [], current: null, videos: {} };
      if (!m.runtimeData) m.runtimeData = {};
    }
  },
}));
vi.mock('../../3dp_lib/dashboard_filament_presets.js', () => ({ FILAMENT_PRESETS: [] }));
vi.mock('../../3dp_lib/dashboard_log_util.js', () => ({ logManager: { add: vi.fn() } }));
vi.mock('../../3dp_lib/dashboard_utils.js', () => ({ getCurrentTimestamp: () => 0 }));
vi.mock('../../3dp_lib/dashboard_filament_ledger.js', () => ({
  attributedUsed: () => 0,
  getSpoolIntervals: () => [],
  initLedgerAnchors: () => ({ seeded: 0 }),
  quarantineInvalidMountEvents: () => 0
}));
vi.mock('../../3dp_lib/dashboard_storage_idb.js', () => ({
  initIdb: vi.fn(), isIdbAvailable: () => false, getIdbCache: () => null,
  queueSharedWrite: vi.fn(), queueMachineWrite: vi.fn(), flushIdb: vi.fn(),
  exportAllIdb: vi.fn(), importAllIdb: vi.fn(), compareAndSwapSharedValue: vi.fn(),
}));

const { saveUnifiedStorage, restoreUnifiedStorage, importAllData, exportAllData } = await import('../../3dp_lib/dashboard_storage.js');
const {
  deriveMaterialSourceObservationFreshness,
} = await import('../../3dp_lib/printer_core/dashboard_material_source_observation.js');
const {
  createMaterialAccountingMigrationDryRunPlan,
} = await import('../../3dp_lib/printer_core/dashboard_material_accounting_migration_planner.js');
const {
  recordMaterialAccountingMigrationDryRunPlan,
} = await import('../../3dp_lib/printer_core/dashboard_material_accounting_migration_journal.js');
const {
  PHYSICAL_COMMAND_RECOVERY_LATCH_STATUS,
  createPhysicalCommandRecoveryLatchRecord,
} = await import('../../3dp_lib/printer_core/dashboard_physical_command_recovery_latch.js');
const {
  MATERIAL_IDENTITY_STRENGTH,
  SPOOL_MOUNT_STATUS,
  SPOOL_MOUNT_VERIFICATION,
  createSpoolMountRecord,
} = await import('../../3dp_lib/printer_core/dashboard_material_accounting_contract.js');
const {
  createMaterialAccountingSpoolMountOperationPayloadDigest,
  normalizeStoredMaterialAccountingSpoolMountStore,
} = await import('../../3dp_lib/printer_core/dashboard_material_accounting_mount_store.js');

/**
 * storage round-tripで使用するREADYなUniversal MaterialSource移行dry-run planを生成する。
 *
 * 【詳細説明】
 * - legacy single-spool hostをUniversal MaterialSourceへ移行できる最小構成を作る。
 * - journalが保存・復元されても、hostSpoolMapやfilamentSpoolsへ追加投影されないことを検証する。
 *
 * @function createStorageReadyMaterialMigrationPlan
 * @param {string=} host - 移行対象のlegacy host。
 * @returns {Object} dry-run migration plan。
 */
function createStorageReadyMaterialMigrationPlan(host = "K1Max-4A1B") {
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
  }, { createdAt: "2026-08-31T03:50:00.000Z" });
}

/**
 * Gate 18.9Hのstorage round-tripで使うSpoolMount store fixtureを生成する。
 *
 * 【詳細説明】
 * - K2/CFSの2 sourceへ別々の管理スプールをoperator confirmedでmountした状態を作る。
 * - event payload digestも実装側と同じhelperで生成し、復元時にeventが隔離されないようにする。
 *
 * @function createSpoolMountStorageFixture
 * @returns {Object} 正規化済みSpoolMount store。
 */
function createSpoolMountStorageFixture() {
  const firstMount = createSpoolMountRecord({
    mountId: "mount:k2:1a:031",
    materialSourceId: "source:k2:cfs:1a",
    spoolId: "spool-031",
    mountOperationId: "operation:mount:k2:1a:031",
    openedAt: "2026-09-01T04:00:00.000Z",
    openedBy: "operator",
    verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
    sourceIdentityStrengthAtOpen: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
  });
  const secondMount = createSpoolMountRecord({
    mountId: "mount:k2:1b:002",
    materialSourceId: "source:k2:cfs:1b",
    spoolId: "spool-002",
    mountOperationId: "operation:mount:k2:1b:002",
    openedAt: "2026-09-01T04:01:00.000Z",
    openedBy: "operator",
    verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
    sourceIdentityStrengthAtOpen: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
  });
  const firstPayload = {
    kind: "operator-mount",
    operatorActionId: "action:k2:1a:031",
    operationId: firstMount.mountOperationId,
    materialSourceId: "source:k2:cfs:1a",
    spoolId: "spool-031",
  };
  const secondPayload = {
    kind: "operator-mount",
    operatorActionId: "action:k2:1b:002",
    operationId: secondMount.mountOperationId,
    materialSourceId: "source:k2:cfs:1b",
    spoolId: "spool-002",
  };

  return normalizeStoredMaterialAccountingSpoolMountStore({
    schemaVersion: 1,
    authority: "material-accounting-spool-mount-store",
    storeRevision: 2,
    spoolMounts: [firstMount, secondMount],
    events: [
      {
        eventId: "event:k2:1a:031",
        kind: "operator-mount",
        operatorActionId: "action:k2:1a:031",
        operationId: firstMount.mountOperationId,
        payload: firstPayload,
        payloadDigest: createMaterialAccountingSpoolMountOperationPayloadDigest(firstPayload),
        recordRefs: [firstMount.mountId, firstMount.mountOperationId],
        createdAt: "2026-09-01T04:00:00.000Z",
        actor: "operator",
      },
      {
        eventId: "event:k2:1b:002",
        kind: "operator-mount",
        operatorActionId: "action:k2:1b:002",
        operationId: secondMount.mountOperationId,
        payload: secondPayload,
        payloadDigest: createMaterialAccountingSpoolMountOperationPayloadDigest(secondPayload),
        recordRefs: [secondMount.mountId, secondMount.mountOperationId],
        createdAt: "2026-09-01T04:01:00.000Z",
        actor: "operator",
      },
    ],
  });
}

beforeEach(() => {
  globalThis.localStorage.clear();
  resetMonitorData();
});

// =============================================================
// 新フィールドの保存→復元 往復
// =============================================================
describe('v2.2.1027 追加フィールドの round-trip', () => {
  it('printerType / storedData.layer・TotalLayer・model が往復で保持される', () => {
    // 新版で保存する状態を構築
    monitorData.appSettings.connectionTargets = [
      { dest: '192.168.54.15:80', hostname: 'Ideaformer', color: '', label: '', printerType: 'moonraker' },
      { dest: '192.168.54.151:9999', hostname: 'K1Max-A', color: '', label: '' }, // 旧型(printerTypeなし)も混在
    ];
    monitorData.machines['Ideaformer'] = {
      storedData: {
        nozzleTemp: { rawValue: 209.9, isFromEquipVal: true },
        layer: { rawValue: 51, isFromEquipVal: true },
        TotalLayer: { rawValue: 499, isFromEquipVal: true },
        model: { rawValue: 'Klipper (belt)', isFromEquipVal: true },
      },
      printStore: { history: [{ id: 1700000000, filename: 'Benchy.gcode' }], current: null, videos: {} },
      runtimeData: { lastError: { errcode: 9 } }, // 揮発：永続化されないはず
    };

    saveUnifiedStorage(true);

    // 復元前にメモリを空へ（実際のリロードを模擬）
    resetMonitorData();
    restoreUnifiedStorage();

    // 接続先 printerType が往復で保持
    const tgt = monitorData.appSettings.connectionTargets.find(t => t.dest === '192.168.54.15:80');
    expect(tgt).toBeTruthy();
    expect(tgt.printerType).toBe('moonraker');
    // 旧型エントリも維持（printerType は未定義のまま壊れない）
    const k1 = monitorData.appSettings.connectionTargets.find(t => t.dest === '192.168.54.151:9999');
    expect(k1).toBeTruthy();
    expect(k1.printerType).toBeUndefined();

    // storedData の新キーが往復で保持
    const sd = monitorData.machines['Ideaformer'].storedData;
    expect(sd.layer.rawValue).toBe(51);
    expect(sd.TotalLayer.rawValue).toBe(499);
    expect(sd.model.rawValue).toBe('Klipper (belt)');
    expect(sd.nozzleTemp.rawValue).toBe(209.9);

    // printStore.history が保持
    expect(monitorData.machines['Ideaformer'].printStore.history).toHaveLength(1);
    expect(monitorData.machines['Ideaformer'].printStore.history[0].id).toBe(1700000000);

    // runtimeData は永続化されない（復元後は ensureMachineData の空 {} 相当）
    expect(monitorData.machines['Ideaformer'].runtimeData?.lastError).toBeUndefined();
  });

  it('Gate18.9I: exportAllData は未保存のCAS保護storeもread-only exportへ補完する', async () => {
    const exported = await exportAllData();

    expect(exported.materialAccountingPrintBindingStore).toMatchObject({
      authority: 'material-accounting-print-binding-shadow-store',
      printStartSnapshots: [],
      jobMaterialSegments: [],
      invariants: {
        legacyUsageHistoryWrites: false,
      },
    });
    expect(exported.materialAccountingSpoolMountStore).toMatchObject({
      authority: 'material-accounting-spool-mount-store',
      spoolMounts: [],
      events: [],
      invariants: {
        operatorManaged: true,
        physicalCommandWrites: false,
      },
    });
    expect(globalThis.localStorage.length).toBe(0);
  });

  it('P0-1: pendingUnattributedUsage / archive / mountHistorySeq が往復で保持される', () => {
    monitorData.pendingUnattributedUsage = [
      { pendingUsageId: 'q1', completionFingerprint: 'fp1', host: 'h', usedMm: 5000,
        estimatedUsedMm: 0, usedSource: 'measured', confidence: 'confirmed', reason: 'invalid-job-id' },
    ];
    monitorData.pendingUnattributedUsageArchive = {
      h: { count: 3, totalUsedMm: 300, totalEstimatedMm: 0, firstAtEpochMs: 111, lastAtEpochMs: 222 },
    };
    monitorData.mountHistorySeq = 42;
    monitorData.ledgerRepairRequired = { h: { spoolId: "S", status: "ambiguous", detectedAtEpochMs: 99 } };
    monitorData.inferredCandidateStore = {
      "ic-a": { candidateHash: "ic-a", host: "h", windowId: "w1", candidateSpoolId: "S", usedMm: 1234, status: "pending", updatedAt: 111 },
    };
    monitorData.inferredDecisionRecoveryRequired = {
      candidateHash: "ic-a",
      action: "confirmInferredCandidate",
      reason: "rollback_durable_save_failed",
      createdAt: 120,
    };
    monitorData.inferredRecoveryOperationRecoveryRequired = {
      operation: "clearLedgerRepairRequired",
      reason: "rollback_durable_save_failed",
      createdAt: 125,
    };
    monitorData.inferredRecoveryEvents = [
      { eventId: "ir-a", type: "decision-recovery-cleared", createdAt: 130, actor: "operator" },
    ];

    saveUnifiedStorage(true);
    resetMonitorData(); // リロード模擬（隔離・アーカイブ・seq・修復要求を空へ）
    restoreUnifiedStorage();

    // 隔離レコードが復元される（再起動で消えない）
    expect(monitorData.pendingUnattributedUsage).toHaveLength(1);
    expect(monitorData.pendingUnattributedUsage[0].pendingUsageId).toBe('q1');
    expect(monitorData.pendingUnattributedUsage[0].usedMm).toBe(5000);
    // アーカイブ（総量・件数）が復元される
    expect(monitorData.pendingUnattributedUsageArchive.h.count).toBe(3);
    expect(monitorData.pendingUnattributedUsageArchive.h.totalUsedMm).toBe(300);
    // watermark(seq) は後退しない
    expect(monitorData.mountHistorySeq).toBe(42);
    // RR-2: 台帳修復要求フラグも往復で保持
    expect(monitorData.ledgerRepairRequired.h.status).toBe("ambiguous");
    // #412-O4: 推定 candidate store も往復で保持
    expect(monitorData.inferredCandidateStore["ic-a"].usedMm).toBe(1234);
    // #420/O6A: recovery flag と audit event も往復で保持
    expect(monitorData.inferredDecisionRecoveryRequired.reason).toBe("rollback_durable_save_failed");
    expect(monitorData.inferredRecoveryOperationRecoveryRequired.operation).toBe("clearLedgerRepairRequired");
    expect(monitorData.inferredRecoveryEvents).toEqual([
      { eventId: "ir-a", type: "decision-recovery-cleared", createdAt: 130, actor: "operator" },
    ]);
  });

  it('Gate18.7: materialSourceObservations はread-only最終観測として往復しhostSpoolMapへ混ざらない', () => {
    monitorData.filamentSpools = [{ id: "managed-spool-031", remainingLengthMm: 336000, updatedAt: 100 }];
    monitorData.hostSpoolMap = { "K2Pro-69E7": "managed-spool-031" };
    monitorData.materialSourceObservations = {
      schemaVersion: 1,
      byDeviceId: {
        "serial:905251280E69E7": {
          schemaVersion: 1,
          deviceId: "serial:905251280E69E7",
          identityStrength: "stable",
          host: "K2Pro-69E7",
          authority: "observation-only",
          lastObservedAt: "2026-08-27T12:00:00.000Z",
          providerDisconnectedAt: "2026-08-27T12:05:00.000Z",
          latestBySourceId: {
            "external:0:slot:0": {
              sourceId: "external:0:slot:0",
              kind: "external-spool",
              presence: "empty",
              selected: false,
              authority: "observation-only",
              remaining: { rawPercent: null, normalizedPercent: null, valid: null, authority: "observation-only" },
            },
            "cfs:1:slot:2": {
              sourceId: "cfs:1:slot:2",
              kind: "cfs-slot",
              presence: "loaded",
              selected: true,
              authority: "observation-only",
              material: {
                rfid: "",
                color: { raw: "#09ea7ae", normalized: "09ea7ae", displayHex: "9ea7ae", cssColor: "#9ea7ae" },
              },
              remaining: { rawPercent: -5, normalizedPercent: 0, valid: false, authority: "observation-only" },
              assignments: [{ assignmentId: "T1A", namespace: "creality-tool", resolution: "observed" }],
            },
          },
          events: [
            { observationId: "mso:1", changeKind: "source-observed", sourceId: "cfs:1:slot:2", authority: "observation-only" },
          ],
        },
        "serial:fresh-before-restore": {
          schemaVersion: 1,
          deviceId: "serial:fresh-before-restore",
          identityStrength: "stable",
          host: "K2Pro-FreshBeforeRestore",
          authority: "observation-only",
          lastObservedAt: "2026-08-27T12:00:00.000Z",
          providerDisconnectedAt: null,
          latestBySourceId: {
            "cfs:1:slot:0": {
              sourceId: "cfs:1:slot:0",
              kind: "cfs-slot",
              presence: "loaded",
              selected: true,
              authority: "observation-only",
              remaining: { rawPercent: 100, normalizedPercent: 100, valid: true, authority: "observation-only" },
            },
          },
          events: [],
        },
      },
    };

    saveUnifiedStorage(true);
    resetMonitorData();
    restoreUnifiedStorage();

    expect(monitorData.hostSpoolMap).toEqual({ "K2Pro-69E7": "managed-spool-031" });
    expect(monitorData.materialSourceObservations.byDeviceId["serial:905251280E69E7"]).toMatchObject({
      authority: "observation-only",
      restoredFromStorage: true,
      restoredAt: expect.any(String),
      providerDisconnectedAt: "2026-08-27T12:05:00.000Z",
      latestBySourceId: {
        "cfs:1:slot:2": {
          selected: true,
          authority: "observation-only",
          restoredFromStorage: true,
          material: {
            rfid: "",
            color: { raw: "#09ea7ae", displayHex: "9ea7ae", cssColor: "#9ea7ae" },
          },
          remaining: { rawPercent: -5, normalizedPercent: 0, valid: false },
        },
      },
    });
    expect(deriveMaterialSourceObservationFreshness(
      monitorData.materialSourceObservations.byDeviceId["serial:905251280E69E7"],
      { now: "2026-08-27T12:00:10.000Z", freshTtlMs: 60_000 }
    )).toMatchObject({ state: "stale", reason: "provider-disconnected" });
    expect(deriveMaterialSourceObservationFreshness(
      monitorData.materialSourceObservations.byDeviceId["serial:fresh-before-restore"],
      { now: "2026-08-27T12:00:10.000Z", freshTtlMs: 60_000 }
    )).toMatchObject({ state: "stale", reason: "restored-last-known" });
  });

  it('Gate18.7: importAllData はmaterialSourceObservationsをread-only evidenceとしてマージする', async () => {
    monitorData.hostSpoolMap = { "K2Pro-69E7": "managed-spool-031" };
    await importAllData({
      materialSourceObservations: {
        schemaVersion: 1,
        byDeviceId: {
          "serial:905251280E69E7": {
            schemaVersion: 1,
            deviceId: "serial:905251280E69E7",
            identityStrength: "stable",
            host: "K2Pro-69E7",
            authority: "observation-only",
            lastObservedAt: "2026-08-27T12:00:00.000Z",
            latestBySourceId: {
              "cfs:1:slot:2": {
                sourceId: "cfs:1:slot:2",
                kind: "cfs-slot",
                presence: "loaded",
                selected: true,
                authority: "observation-only",
                remaining: { rawPercent: 54, normalizedPercent: 54, valid: true, authority: "observation-only" },
              },
            },
            events: [
              { observationId: "mso:slot2", changeKind: "source-observed", sourceId: "cfs:1:slot:2", authority: "observation-only" },
            ],
          },
        },
      },
    });

    expect(monitorData.hostSpoolMap).toEqual({ "K2Pro-69E7": "managed-spool-031" });
    expect(monitorData.materialSourceObservations.byDeviceId["serial:905251280E69E7"]).toMatchObject({
      authority: "observation-only",
      restoredFromStorage: true,
      latestBySourceId: {
        "cfs:1:slot:2": {
          selected: true,
          authority: "observation-only",
        },
      },
    });
  });

  it('Gate18.9B: materialAccountingMigrationJournal はdry-run evidenceとして往復し台帳へ投影しない', () => {
    monitorData.filamentSpools = [{ id: "spool-031", remainingLengthMm: 336000, updatedAt: 100 }];
    monitorData.hostSpoolMap = { "K1Max-4A1B": "spool-031" };
    const plan = createStorageReadyMaterialMigrationPlan();
    const recorded = recordMaterialAccountingMigrationDryRunPlan(null, plan, {
      recordedAt: "2026-08-31T03:51:00.000Z",
    });
    monitorData.materialAccountingMigrationJournal = recorded.journal;

    saveUnifiedStorage(true);
    resetMonitorData();
    restoreUnifiedStorage();

    expect(monitorData.materialAccountingMigrationJournal).toMatchObject({
      authority: "migration-dry-run-journal",
      latestMigrationId: plan.migrationId,
      invariants: {
        activateUniversalWrites: false,
        materialSourceRepositoryWrites: false,
        spoolMountRepositoryWrites: false,
      },
    });
    expect(monitorData.materialAccountingMigrationJournal.byMigrationId[plan.migrationId].plan).toMatchObject({
      status: "dry-run",
      invariants: { activateUniversalWrites: false },
    });
    expect(monitorData.hostSpoolMap).toEqual({ "K1Max-4A1B": "spool-031" });
    expect(monitorData.filamentSpools).toHaveLength(1);
    expect(monitorData.filamentSpools[0]).toMatchObject({
      id: "spool-031",
      remainingLengthMm: 336000,
      updatedAt: 100,
    });
    expect(monitorData.materialSourceObservations).toMatchObject({
      schemaVersion: 1,
      authority: "observation-only",
      byDeviceId: {},
    });
  });

  it('Gate18.9B: importAllData はmaterialAccountingMigrationJournalを正規化してdry-run evidenceとして保持する', async () => {
    const plan = createStorageReadyMaterialMigrationPlan();
    const recorded = recordMaterialAccountingMigrationDryRunPlan(null, plan, {
      recordedAt: "2026-08-31T03:51:00.000Z",
    });

    await importAllData({
      materialAccountingMigrationJournal: recorded.journal,
    });

    expect(monitorData.materialAccountingMigrationJournal.latestMigrationId).toBe(plan.migrationId);
    expect(monitorData.materialAccountingMigrationJournal.events).toEqual([
      expect.objectContaining({
        type: "migration-dry-run-recorded",
        migrationId: plan.migrationId,
      }),
    ]);
    expect(monitorData.materialAccountingMigrationJournal.invariants).toMatchObject({
      activateUniversalWrites: false,
      materialSourceRepositoryWrites: false,
      spoolMountRepositoryWrites: false,
      migrationJournalIsEvidenceOnly: true,
    });
    expect(monitorData.hostSpoolMap).toEqual({});
  });

  it('Gate18.9D-2: materialAccountingMigrationShadowStore はshadow evidenceとして往復しlegacy装着へ投影しない', () => {
    monitorData.filamentSpools = [{ id: "legacy-spool-031", remainingLengthMm: 336000, updatedAt: 100 }];
    monitorData.hostSpoolMap = { "K1Max-4A1B": "legacy-spool-031" };
    monitorData.materialAccountingMigrationShadowStore = {
      schemaVersion: 1,
      authority: "migration-shadow-commit-store",
      materialSourceRegistrySnapshot: {
        sources: [
          {
            materialSourceId: "material-source:direct-0",
            deviceId: "serial:k1max-4a1b",
            unitId: "filament-unit:direct",
            kind: "direct-feed",
            locator: { kind: "direct-feed", index: 0, unitIndex: null, boxId: null, slotIndex: null, protocolSlotId: null },
            identityStrength: "stable",
          },
        ],
        conflicts: [],
      },
      spoolMountRepositorySnapshot: {
        mounts: [
          {
            mountId: "spool-mount:031",
            mountOperationId: "shadow-mount:031",
            materialSourceId: "material-source:direct-0",
            spoolId: "spool-031",
            status: "open",
            verification: "migrated",
            sourceIdentityStrengthAtOpen: "stable",
            expectedRfid: null,
            openedAt: "2026-08-31T03:02:00.000Z",
            openedBy: "operator",
            closedAt: null,
            closedBy: null,
            closeOperationId: null,
            closeReason: null,
          },
        ],
        conflicts: [],
      },
      committedTransactionsById: {
        "shadow-tx:031": {
          transactionId: "shadow-tx:031",
          shadowOperationId: "shadow-op:031",
          transactionDigest: "fnv1a128:031",
          committedAt: "2026-08-31T03:02:01.000Z",
        },
      },
      committedOperationsById: {
        "shadow-op:031": {
          shadowOperationId: "shadow-op:031",
          transactionId: "shadow-tx:031",
          transactionDigest: "fnv1a128:031",
          committedAt: "2026-08-31T03:02:01.000Z",
        },
      },
      lifecycleBySubject: {
        "migration-subject:k1max-4a1b": {
          migrationSubjectId: "migration-subject:k1max-4a1b",
          migrationId: "migration:031",
          transactionId: "shadow-tx:031",
          migrationStatus: "shadow",
          committedAt: "2026-08-31T03:02:01.000Z",
        },
      },
      events: [
        {
          eventId: "shadow-event:031",
          type: "material-accounting-shadow-committed",
          transactionId: "shadow-tx:031",
          shadowOperationId: "shadow-op:031",
          migrationSubjectId: "migration-subject:k1max-4a1b",
          migrationId: "migration:031",
          transactionDigest: "fnv1a128:031",
          committedAt: "2026-08-31T03:02:01.000Z",
          migrationStatus: "shadow",
        },
      ],
      retainedUnsupportedEntries: [],
      invariants: {
        ledgerWrites: false,
        legacyCutoverSealed: false,
        materialSourceRepositoryWrites: "shadow-only",
        spoolMountRepositoryWrites: "shadow-only",
      },
    };

    saveUnifiedStorage(true);
    resetMonitorData();
    restoreUnifiedStorage();

    expect(monitorData.materialAccountingMigrationShadowStore).toMatchObject({
      authority: "migration-shadow-commit-store",
      materialSourceRegistrySnapshot: { sources: [expect.any(Object)], conflicts: [] },
      spoolMountRepositorySnapshot: { mounts: [expect.any(Object)], conflicts: [] },
      lifecycleBySubject: {
        "migration-subject:k1max-4a1b": {
          migrationStatus: "shadow",
        },
      },
      invariants: {
        ledgerWrites: false,
        legacyCutoverSealed: false,
      },
    });
    expect(monitorData.materialAccountingMigrationShadowStore.events).toHaveLength(1);
    expect(monitorData.hostSpoolMap).toEqual({ "K1Max-4A1B": "legacy-spool-031" });
    expect(monitorData.usageHistory).toEqual([]);
  });

  it('Gate18.9E: materialAccountingPrintBindingStore はsource-aware shadow usageとして往復しlegacy usageへ投影しない', () => {
    monitorData.filamentSpools = [{ id: "legacy-single-spool", remainingLengthMm: 1000, updatedAt: 100 }];
    monitorData.hostSpoolMap = { "K2Pro-69E7": "legacy-single-spool" };
    monitorData.usageHistory = [{ host: "K2Pro-69E7", spoolId: "legacy-single-spool", usedMm: 10 }];
    monitorData.materialAccountingPrintBindingStore = {
      schemaVersion: 1,
      authority: "material-accounting-print-binding-shadow-store",
      printStartSnapshots: [
        {
          snapshotId: "snapshot:1a",
          deviceId: "serial:k2pro-69e7",
          printJobId: "job:4color",
          printPlanId: "plan:4color",
          materialSourceId: "source:1a",
          mountId: "mount:1a",
          spoolId: "spool:1a",
          capturedAt: "2026-08-31T05:00:00.000Z",
        },
      ],
      usageEvidence: [
        {
          evidenceId: "usage:1a",
          materialSourceId: "source:1a",
          mountId: "mount:1a",
          snapshotId: "snapshot:1a",
          printJobId: "job:4color",
          deviceId: "serial:k2pro-69e7",
          usedLengthMm: 3210,
          attribution: "source-specific",
        },
      ],
      jobMaterialSegments: [
        {
          segmentId: "segment:1a",
          printJobId: "job:4color",
          printPlanId: "plan:4color",
          deviceId: "serial:k2pro-69e7",
          materialSourceId: "source:1a",
          spoolId: "spool:1a",
          usedLengthMm: 3210,
          usageState: "observed-used",
        },
      ],
      ledgerEvents: [
        {
          ledgerEventId: "ledger:1a",
          eventType: "material-consumption",
          segmentId: "segment:1a",
          printJobId: "job:4color",
          deviceId: "serial:k2pro-69e7",
          materialSourceId: "source:1a",
          spoolId: "spool:1a",
          usedLengthMm: 3210,
          createdAt: "2026-08-31T05:30:00.000Z",
        },
      ],
      unattributedUsage: [],
      operationsById: {
        "usage:4color": { operationId: "usage:4color", digest: "digest:4color" },
      },
      invariants: {
        legacyUsageHistoryWrites: false,
        legacySpoolRemainingWrites: false,
        materialSourceLedgerWrites: "shadow-only",
      },
    };

    saveUnifiedStorage(true);
    resetMonitorData();
    restoreUnifiedStorage();

    expect(monitorData.materialAccountingPrintBindingStore).toMatchObject({
      authority: "material-accounting-print-binding-shadow-store",
      printStartSnapshots: [{ snapshotId: "snapshot:1a", materialSourceId: "source:1a" }],
      jobMaterialSegments: [{ segmentId: "segment:1a", usedLengthMm: 3210 }],
      ledgerEvents: [{ ledgerEventId: "ledger:1a", usedLengthMm: 3210 }],
      invariants: {
        legacyUsageHistoryWrites: false,
        legacySpoolRemainingWrites: false,
        materialSourceLedgerWrites: "shadow-only",
      },
    });
    expect(monitorData.hostSpoolMap).toEqual({ "K2Pro-69E7": "legacy-single-spool" });
    expect(monitorData.usageHistory).toEqual([{ host: "K2Pro-69E7", spoolId: "legacy-single-spool", usedMm: 10 }]);
  });

  it('Gate18.9H: localStorage fallback restoreはSpoolMount storeをactive authorityへ復元しない', () => {
    monitorData.filamentSpools = [
      { id: "legacy-spool", remainingLengthMm: 100000, updatedAt: 100 },
      { id: "spool-031", remainingLengthMm: 235800, updatedAt: 100 },
      { id: "spool-002", remainingLengthMm: 330000, updatedAt: 100 },
    ];
    monitorData.hostSpoolMap = { "K1Max-4A1B": "legacy-spool" };
    monitorData.usageHistory = [{ usageId: "legacy-usage", host: "K1Max-4A1B", spoolId: "legacy-spool", usedMm: 120 }];
    monitorData.materialAccountingPrintBindingStore = {
      schemaVersion: 1,
      authority: "material-accounting-print-binding-shadow-store",
      printStartSnapshots: [],
      usageEvidence: [],
      jobMaterialSegments: [],
      ledgerEvents: [],
      unattributedUsage: [],
      operationsById: {},
      invariants: {
        legacyUsageHistoryWrites: false,
        legacySpoolRemainingWrites: false,
        materialSourceLedgerWrites: "shadow-only",
      },
    };
    monitorData.physicalCommandRecoveryLatch = {
      schemaVersion: 1,
      authority: "physical-command-recovery-latch",
      unresolvedByCommandId: {},
      events: [],
      retainedUnsupportedEntries: [],
      invariants: {
        autoReplay: false,
        commandFramePersistence: false,
        physicalCommandAuthority: "recovery-latch-only",
      },
    };
    monitorData.materialAccountingSpoolMountStore = createSpoolMountStorageFixture();

    saveUnifiedStorage(true);
    resetMonitorData();
    restoreUnifiedStorage();

    expect(monitorData.materialAccountingSpoolMountStore).toMatchObject({
      authority: "material-accounting-spool-mount-store",
      spoolMounts: [],
      events: [],
      invariants: {
        legacyHostSpoolMapWrites: false,
        legacyUsageHistoryWrites: false,
        legacySpoolRemainingWrites: false,
        printBindingWrites: false,
      },
    });
    expect(monitorData.hostSpoolMap).toEqual({ "K1Max-4A1B": "legacy-spool" });
    expect(monitorData.usageHistory).toEqual([{ usageId: "legacy-usage", host: "K1Max-4A1B", spoolId: "legacy-spool", usedMm: 120 }]);
    expect(monitorData.filamentSpools.map((spool) => [spool.id, spool.remainingLengthMm])).toEqual([
      ["legacy-spool", 100000],
      ["spool-031", 235800],
      ["spool-002", 330000],
    ]);
    expect(monitorData.materialAccountingPrintBindingStore.printStartSnapshots).toEqual([]);
    expect(monitorData.physicalCommandRecoveryLatch.unresolvedByCommandId).toEqual({});
  });

  it('Gate18.9H: localStorage fallback importはdivergent SpoolMount storeをactive authorityへ反映しない', async () => {
    monitorData.filamentSpools = [
      { id: "spool-031", remainingLengthMm: 235800 },
      { id: "spool-002", remainingLengthMm: 330000 },
      { id: "spool-006", remainingLengthMm: 198000 },
    ];
    monitorData.materialAccountingSpoolMountStore = createSpoolMountStorageFixture();
    const incomingStore = normalizeStoredMaterialAccountingSpoolMountStore({
      ...createSpoolMountStorageFixture(),
      storeRevision: 3,
      spoolMounts: [
        createSpoolMountRecord({
          mountId: "mount:k2:1c:006",
          materialSourceId: "source:k2:cfs:1c",
          spoolId: "spool-006",
          mountOperationId: "operation:mount:k2:1c:006",
          openedAt: "2026-09-01T04:02:00.000Z",
          openedBy: "operator",
          verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
          sourceIdentityStrengthAtOpen: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
        }),
      ],
      events: [],
    });

    await importAllData({
      materialAccountingSpoolMountStore: incomingStore,
    });

    expect(monitorData.materialAccountingSpoolMountStore.spoolMounts.map((mount) => mount.materialSourceId)).toEqual([
      "source:k2:cfs:1a",
      "source:k2:cfs:1b",
    ]);
    expect(monitorData.materialAccountingSpoolMountStore.conflicts).toEqual([]);
    expect(monitorData.materialAccountingSpoolMountStore.retainedUnsupportedEntries).toEqual([]);
    expect(monitorData.hostSpoolMap).toEqual({});
    expect(monitorData.usageHistory).toEqual([]);
  });

  it('Gate18.9H: localStorage fallback importはlegacy hostSpoolMapと衝突するUniversal mountをactive authorityへ反映しない', async () => {
    monitorData.hostSpoolMap = { "K1Max-4A1B": "spool-031" };
    monitorData.filamentSpools = [
      { id: "spool-031", remainingLengthMm: 235800 },
      { id: "spool-002", remainingLengthMm: 330000 },
    ];

    await importAllData({
      materialAccountingSpoolMountStore: createSpoolMountStorageFixture(),
    });

    expect(monitorData.materialAccountingSpoolMountStore.spoolMounts).toEqual([]);
    expect(monitorData.materialAccountingSpoolMountStore.events).toEqual([]);
    expect(monitorData.materialAccountingSpoolMountStore.conflicts).toEqual([]);
    expect(monitorData.materialAccountingSpoolMountStore.retainedUnsupportedEntries).toEqual([]);
    expect(monitorData.hostSpoolMap).toEqual({ "K1Max-4A1B": "spool-031" });
  });

  it('Gate18.9H: localStorage fallback importはCLOSED Universal mount履歴もactive authorityへ反映しない', async () => {
    const closedMount = createSpoolMountRecord({
      mountId: "mount:k2:closed:031",
      materialSourceId: "source:k2:cfs:closed",
      spoolId: "spool-031",
      mountOperationId: "operation:mount:k2:closed:031",
      openedAt: "2026-09-01T03:00:00.000Z",
      closedAt: "2026-09-01T03:30:00.000Z",
      closedByOperationId: "operation:unmount:k2:closed:031",
      openedBy: "operator",
      closedBy: "operator",
      status: SPOOL_MOUNT_STATUS.CLOSED,
      verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
      sourceIdentityStrengthAtOpen: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
    });
    monitorData.hostSpoolMap = { "K1Max-4A1B": "spool-031" };
    monitorData.filamentSpools = [{ id: "spool-031", remainingLengthMm: 235800 }];

    await importAllData({
      materialAccountingSpoolMountStore: normalizeStoredMaterialAccountingSpoolMountStore({
        schemaVersion: 1,
        authority: "material-accounting-spool-mount-store",
        spoolMounts: [closedMount],
        events: [],
      }),
    });

    expect(monitorData.materialAccountingSpoolMountStore.spoolMounts).toEqual([]);
    expect(monitorData.materialAccountingSpoolMountStore.conflicts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        reason: "legacy-spool-backend-conflict",
        spoolId: "spool-031",
      }),
    ]));
  });

  it('Gate18.9H: importAllData は既存current Universal OPEN mountと衝突するhostSpoolMapを取り込まない', async () => {
    monitorData.filamentSpools = [{ id: "spool-031", remainingLengthMm: 235800 }];
    monitorData.materialAccountingSpoolMountStore = normalizeStoredMaterialAccountingSpoolMountStore({
      ...createSpoolMountStorageFixture(),
      spoolMounts: [createSpoolMountStorageFixture().spoolMounts[0]],
      events: [createSpoolMountStorageFixture().events[0]],
    });

    await importAllData({
      hostSpoolMap: { "K1Max-4A1B": "spool-031" },
    });

    expect(monitorData.hostSpoolMap).toEqual({});
    expect(monitorData.materialAccountingSpoolMountStore.spoolMounts).toEqual([
      expect.objectContaining({
        spoolId: "spool-031",
      }),
    ]);
    expect(monitorData.materialAccountingSpoolMountStore.conflicts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "spool-mount-cross-backend-conflict",
        reason: "legacy-spool-backend-conflict",
        spoolId: "spool-031",
      }),
    ]));
  });

  it('Gate19 prep: physicalCommandRecoveryLatch は再起動後も未解決証跡を保持し自動再送材料を保存しない', () => {
    monitorData.physicalCommandRecoveryLatch = {
      schemaVersion: 1,
      authority: "physical-command-recovery-latch",
      unresolvedByCommandId: {
        "command:k2-select-1a": createPhysicalCommandRecoveryLatchRecord({
          commandId: "command:k2-select-1a",
          commandKind: "cfs-slot-select",
          deviceId: "serial:k2pro-69e7",
          sessionId: "session:live-001",
          connectionGeneration: 42,
          status: PHYSICAL_COMMAND_RECOVERY_LATCH_STATUS.UNKNOWN,
          sentAt: "2026-08-31T09:20:00.000Z",
          materialSourceId: "material-source:k2pro-69e7:cfs-1:slot-a",
          certificationId: "cert:k2-slot-control-f012",
          preObservation: {
            sequence: 128,
            digest: "fnv1a128:before",
            observedAt: "2026-08-31T09:19:59.000Z",
          },
        }),
      },
      events: [],
      retainedUnsupportedEntries: [],
      invariants: {
        autoReplay: false,
        commandFramePersistence: false,
        physicalCommandAuthority: "recovery-latch-only",
      },
    };

    saveUnifiedStorage(true);
    const savedJson = localStorage.getItem("3dpmon-global") || "";
    resetMonitorData();
    restoreUnifiedStorage();

    expect(savedJson).not.toContain("multi.machine.material_box.select");
    expect(monitorData.physicalCommandRecoveryLatch).toMatchObject({
      authority: "physical-command-recovery-latch",
      unresolvedByCommandId: {
        "command:k2-select-1a": {
          commandKind: "cfs-slot-select",
          status: "unknown",
          materialSourceId: "material-source:k2pro-69e7:cfs-1:slot-a",
        },
      },
      invariants: {
        autoReplay: false,
        commandFramePersistence: false,
      },
    });
    expect(monitorData.usageHistory).toEqual([]);
  });

  it('Gate19 prep: importAllData はphysicalCommandRecoveryLatchを正規化しlegacy ledgerへ投影しない', async () => {
    await importAllData({
      physicalCommandRecoveryLatch: {
        schemaVersion: 999,
        unresolvedByCommandId: {
          "command:k2-load-1a": createPhysicalCommandRecoveryLatchRecord({
            commandId: "command:k2-load-1a",
            commandKind: "cfs-slot-load",
            deviceId: "serial:k2pro-69e7",
            sessionId: "session:live-002",
            connectionGeneration: 43,
            status: PHYSICAL_COMMAND_RECOVERY_LATCH_STATUS.SUBMITTED,
            sentAt: "2026-08-31T09:30:00.000Z",
            materialSourceId: "material-source:k2pro-69e7:cfs-1:slot-a",
            preObservation: {
              sequence: 180,
              digest: "fnv1a128:before-load",
            },
          }),
          "command:k2-load-1b": createPhysicalCommandRecoveryLatchRecord({
            commandId: "command:k2-load-1b",
            commandKind: "cfs-slot-load",
            deviceId: "serial:k2pro-69e7",
            sessionId: "session:live-003",
            connectionGeneration: 44,
            status: PHYSICAL_COMMAND_RECOVERY_LATCH_STATUS.POST_OBSERVED,
            sentAt: "2026-08-31T09:35:00.000Z",
            materialSourceId: "material-source:k2pro-69e7:cfs-1:slot-b",
            preObservation: {
              sequence: 181,
              digest: "fnv1a128:before-load-b",
            },
          }),
          "command:broken": {
            commandId: "command:broken",
            commandKind: "",
            status: "unknown",
          },
        },
        invariants: {
          autoReplay: true,
          commandFramePersistence: true,
        },
      },
    });

    expect(Object.keys(monitorData.physicalCommandRecoveryLatch.unresolvedByCommandId)).toEqual([
      "command:k2-load-1a",
      "command:k2-load-1b",
    ]);
    expect(monitorData.physicalCommandRecoveryLatch.invariants).toMatchObject({
      autoReplay: false,
      commandFramePersistence: false,
    });
    expect(monitorData.physicalCommandRecoveryLatch.retainedUnsupportedEntries).toEqual([
      expect.objectContaining({
        commandId: "command:broken",
        reason: "invalid-recovery-record",
      }),
    ]);
    expect(monitorData.hostSpoolMap).toEqual({});
    expect(monitorData.usageHistory).toEqual([]);
  });

  it('Gate19 prep: importAllData は同一commandIdのdigest衝突を全て隔離し未解決authorityへ残さない', async () => {
    monitorData.physicalCommandRecoveryLatch = {
      schemaVersion: 1,
      authority: "physical-command-recovery-latch",
      unresolvedByCommandId: {
        "command:k2-load-1a": createPhysicalCommandRecoveryLatchRecord({
          commandId: "command:k2-load-1a",
          commandKind: "cfs-slot-load",
          deviceId: "serial:k2pro-69e7",
          sessionId: "session:live-002",
          connectionGeneration: 43,
          status: PHYSICAL_COMMAND_RECOVERY_LATCH_STATUS.SUBMITTED,
          sentAt: "2026-08-31T09:30:00.000Z",
          materialSourceId: "material-source:k2pro-69e7:cfs-1:slot-a",
          preObservation: {
            sequence: 180,
            digest: "fnv1a128:before-load",
          },
        }),
      },
      events: [],
      retainedUnsupportedEntries: [],
      invariants: {
        autoReplay: false,
        commandFramePersistence: false,
        physicalCommandAuthority: "recovery-latch-only",
      },
    };

    await importAllData({
      physicalCommandRecoveryLatch: {
        schemaVersion: 1,
        unresolvedByCommandId: {
          "command:k2-load-1a": createPhysicalCommandRecoveryLatchRecord({
            commandId: "command:k2-load-1a",
            commandKind: "cfs-slot-load",
            deviceId: "serial:k2pro-69e7",
            sessionId: "session:live-003",
            connectionGeneration: 44,
            status: PHYSICAL_COMMAND_RECOVERY_LATCH_STATUS.UNKNOWN,
            sentAt: "2026-08-31T09:31:00.000Z",
            materialSourceId: "material-source:k2pro-69e7:cfs-1:slot-a",
            preObservation: {
              sequence: 181,
              digest: "fnv1a128:before-load-conflict",
            },
          }),
        },
      },
    });

    expect(monitorData.physicalCommandRecoveryLatch.unresolvedByCommandId).toEqual({});
    expect(monitorData.physicalCommandRecoveryLatch.conflictedCommandIds).toEqual(["command:k2-load-1a"]);
    expect(monitorData.physicalCommandRecoveryLatch.retainedUnsupportedEntries).toEqual([
      expect.objectContaining({
        commandId: "command:k2-load-1a",
        reason: "command-id-digest-conflict",
      }),
      expect.objectContaining({
        commandId: "command:k2-load-1a",
        reason: "command-id-digest-conflict",
      }),
    ]);
    expect(monitorData.usageHistory).toEqual([]);
  });

  it('#412-O4: import は candidateHash 単位で冪等マージし updatedAt が新しい方を採用する', async () => {
    monitorData.inferredCandidateStore = {
      "ic-a": { candidateHash: "ic-a", status: "pending", usedMm: 100, updatedAt: 20 },
      "ic-old": { candidateHash: "ic-old", status: "pending", usedMm: 50, updatedAt: 100 },
    };
    await importAllData({
      inferredCandidateStore: {
        "ic-a": { candidateHash: "ic-a", status: "confirmed", usedMm: 100, updatedAt: 30 },
        "ic-old": { candidateHash: "ic-old", status: "rejected", usedMm: 50, updatedAt: 10 },
        "ic-b": { candidateHash: "ic-b", status: "pending", usedMm: 200, updatedAt: 40 },
      },
    });
    expect(monitorData.inferredCandidateStore["ic-a"].status).toBe("confirmed");
    expect(monitorData.inferredCandidateStore["ic-old"].status).toBe("pending");
    expect(monitorData.inferredCandidateStore["ic-b"].usedMm).toBe(200);
  });

  it('#420/O6A: import は recovery flag と audit event を安全にマージする', async () => {
    monitorData.inferredDecisionRecoveryRequired = {
      candidateHash: "ic-old",
      reason: "old",
      createdAt: 10,
    };
    monitorData.inferredRecoveryOperationRecoveryRequired = {
      operation: "old-operation",
      reason: "old",
      createdAt: 10,
    };
    monitorData.inferredRecoveryEvents = [
      { eventId: "ir-a", type: "recovery-durable-save-retried", createdAt: 20 },
    ];

    await importAllData({
      inferredDecisionRecoveryRequired: {
        candidateHash: "ic-new",
        reason: "rollback_durable_save_failed",
        createdAt: 30,
      },
      inferredRecoveryOperationRecoveryRequired: {
        operation: "clearLedgerRepairRequired",
        reason: "rollback_durable_save_failed",
        createdAt: 35,
      },
      inferredRecoveryEvents: [
        { eventId: "ir-a", type: "recovery-durable-save-retried", createdAt: 20 },
        { eventId: "ir-b", type: "decision-recovery-cleared", createdAt: 40 },
      ],
    });

    expect(monitorData.inferredDecisionRecoveryRequired.candidateHash).toBe("ic-new");
    expect(monitorData.inferredRecoveryOperationRecoveryRequired.operation).toBe("clearLedgerRepairRequired");
    expect(monitorData.inferredRecoveryEvents.map(event => event.eventId)).toEqual(["ir-a", "ir-b"]);
  });

  it('#426 signed remaining: import は負残量と表示モード互換名を保持する', async () => {
    monitorData.filamentSpools = [
      { id: 'sp-neg', remainingLengthMm: 500, updatedAt: 10 },
    ];
    monitorData.appSettings = { connectionTargets: [], panelLayout: [] };

    await importAllData({
      appSettings: {
        connectionTargets: [],
        panelLayout: [],
        filamentRemainingDisplayMode: 'signed',
      },
      filamentSpools: [
        { id: 'sp-neg', remainingLengthMm: -1250, updatedAt: 20 },
        { id: 'sp-new-neg', remainingLengthMm: -300, updatedAt: 30 },
      ],
    });

    expect(monitorData.filamentSpools.find(sp => sp.id === 'sp-neg').remainingLengthMm).toBe(-1250);
    expect(monitorData.filamentSpools.find(sp => sp.id === 'sp-new-neg').remainingLengthMm).toBe(-300);
    expect(monitorData.appSettings.negativeRemainingDisplayMode).toBe('show-negative');
  });

  it('P1-1: import は同一 opId(別evId)の mount を1件に畳む', async () => {
    monitorData.mountHistory = [{ opId: 'op1', evId: 'A', type: 'mount', spoolId: 's', ts: 1 }];
    await importAllData({
      mountHistory: [
        { opId: 'op1', evId: 'B', type: 'mount', spoolId: 's', ts: 2 }, // 同一opId・別evId → 畳む
        { opId: 'op2', evId: 'C', type: 'mount', spoolId: 's', ts: 3 }, // 別opId → 追加
      ],
    });
    const opIds = monitorData.mountHistory.map(e => e.opId);
    expect(opIds.filter(x => x === 'op1')).toHaveLength(1); // op1 は再送されても1件
    expect(opIds).toContain('op2');
  });

  it('P0-1: 復元は pendingUsageId で冪等（二重復元でも増えない）', () => {
    monitorData.pendingUnattributedUsage = [
      { pendingUsageId: 'q1', completionFingerprint: 'fp1', host: 'h', usedMm: 5000 },
    ];
    saveUnifiedStorage(true);
    // メモリを消さずに二重復元 → 同一 pendingUsageId は重複追加されない
    restoreUnifiedStorage();
    restoreUnifiedStorage();
    expect(monitorData.pendingUnattributedUsage.filter(r => r.pendingUsageId === 'q1')).toHaveLength(1);
  });

  it('保存された per-host JSON は妥当で、未知フィールドを含んでも JSON.parse 可能（旧版が落ちない）', () => {
    monitorData.appSettings.connectionTargets = [
      { dest: '192.168.54.15:80', hostname: 'Ideaformer', printerType: 'moonraker' },
    ];
    monitorData.machines['Ideaformer'] = {
      storedData: { layer: { rawValue: 5 }, TotalLayer: { rawValue: 499 } },
      printStore: { history: [], current: null, videos: {} },
      runtimeData: {},
    };
    saveUnifiedStorage(true);

    // 旧版を模擬：生 JSON を素朴に parse して未知フィールドを無視できること
    const globalRaw = globalThis.localStorage.getItem('3dpmon-global');
    expect(() => JSON.parse(globalRaw)).not.toThrow();
    const parsed = JSON.parse(globalRaw);
    // 旧版は printerType を知らないが、JSON 上は単なる無視できる文字列フィールド
    expect(parsed.appSettings.connectionTargets[0].printerType).toBe('moonraker');

    const hostRaw = globalThis.localStorage.getItem('3dpmon-host-Ideaformer');
    expect(() => JSON.parse(hostRaw)).not.toThrow();
    // runtimeData は保存されない
    expect(JSON.parse(hostRaw).runtimeData).toBeUndefined();
  });
});

// =============================================================
// 旧形式データの読み込み（新版が旧データを壊さない/落ちない）
// =============================================================
describe('旧形式データの後方互換', () => {
  it('printerType も新storedDataキーも無い旧データを読んでもクラッシュせず保持される', () => {
    // 旧版が書いたであろう localStorage を直接用意
    const oldGlobal = {
      appSettings: { connectionTargets: [{ dest: '192.168.54.151:9999', hostname: 'K1Max-A', color: '#abc', label: 'L' }] },
      filamentSpools: [{ id: 'sp1', remainingLengthMm: 1000 }],
      spoolSerialCounter: 3,
    };
    const oldHost = {
      storedData: { nozzleTemp: { rawValue: 200 }, bedTemp0: { rawValue: 60 } },
      printStore: { history: [{ id: 111, filename: 'old.gcode' }], current: null, videos: {} },
    };
    globalThis.localStorage.setItem('3dpmon-global', JSON.stringify(oldGlobal));
    globalThis.localStorage.setItem('3dpmon-host-K1Max-A', JSON.stringify(oldHost));

    expect(() => restoreUnifiedStorage()).not.toThrow();

    // 旧設定が保持され、printerType は単に未定義（新版は getPrinterType で creality-k1 既定）
    const t = monitorData.appSettings.connectionTargets.find(x => x.dest === '192.168.54.151:9999');
    expect(t).toBeTruthy();
    expect(t.color).toBe('#abc');
    expect(t.printerType).toBeUndefined();

    // 旧データ（履歴/スプール）が壊れず保持
    expect(monitorData.machines['K1Max-A'].printStore.history[0].id).toBe(111);
    expect(monitorData.filamentSpools.find(s => s.id === 'sp1')).toBeTruthy();
    expect(monitorData.spoolSerialCounter).toBe(3);
  });
});

// =============================================================
// 追記・修正（運用）の往復
// =============================================================
describe('追記・修正の運用', () => {
  it('復元後に履歴を追記して再保存→再復元で両エントリが残る', () => {
    monitorData.appSettings.connectionTargets = [{ dest: '192.168.54.15:80', hostname: 'Ideaformer', printerType: 'moonraker' }];
    monitorData.machines['Ideaformer'] = {
      storedData: { layer: { rawValue: 1 } },
      printStore: { history: [{ id: 1 }], current: null, videos: {} },
      runtimeData: {},
    };
    saveUnifiedStorage(true);
    resetMonitorData();
    restoreUnifiedStorage();

    // 追記（新ジョブ）＋修正（layer更新）
    monitorData.machines['Ideaformer'].printStore.history.push({ id: 2 });
    monitorData.machines['Ideaformer'].storedData.layer = { rawValue: 250 };
    saveUnifiedStorage(true);
    resetMonitorData();
    restoreUnifiedStorage();

    const hist = monitorData.machines['Ideaformer'].printStore.history.map(j => j.id).sort((a, b) => a - b);
    expect(hist).toEqual([1, 2]);
    expect(monitorData.machines['Ideaformer'].storedData.layer.rawValue).toBe(250);
  });
});
