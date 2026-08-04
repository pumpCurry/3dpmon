/**
 * dashboard_storage.js 移行/round-trip 安全性テスト（v2.2.1027 追加フィールド）
 *
 * 検証目的（ユーザ懸念の実証）:
 *  - 新フィールド（connectionTargets[].printerType / storedData.layer・TotalLayer・model）が
 *    保存→復元の往復で失われない（= 新版で保存し新版で読める＝追記運用できる）。
 *  - 旧形式データ（新フィールドなし）を読んでもクラッシュせず、既存データが壊れない。
 *  - 保存JSONは常に妥当（= 旧版が JSON.parse でき、未知フィールドを無視して落ちない）。
 *  - runtimeData（揮発）は永続化されない。
 *  - Web版/Electron版は同一コードパス（localStorage/IndexedDB）のため本テストで両者を代表。
 *
 * 実ストレージ層（saveUnifiedStorage / restoreUnifiedStorage）を localStorage スタブ上で
 * 実際に往復させて確認する（IndexedDB は無効化して localStorage 経路を通す）。
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
vi.mock('../../3dp_lib/dashboard_filament_ledger.js', () => ({ initLedgerAnchors: () => ({ seeded: 0 }), quarantineInvalidMountEvents: () => 0 }));
vi.mock('../../3dp_lib/dashboard_storage_idb.js', () => ({
  initIdb: vi.fn(), isIdbAvailable: () => false, getIdbCache: () => null,
  queueSharedWrite: vi.fn(), queueMachineWrite: vi.fn(), flushIdb: vi.fn(),
  exportAllIdb: vi.fn(), importAllIdb: vi.fn(),
}));

const { saveUnifiedStorage, restoreUnifiedStorage, importAllData } = await import('../../3dp_lib/dashboard_storage.js');

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
