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
vi.mock('../../3dp_lib/dashboard_filament_ledger.js', () => ({ initLedgerAnchors: () => ({ seeded: 0 }) }));
vi.mock('../../3dp_lib/dashboard_storage_idb.js', () => ({
  initIdb: vi.fn(), isIdbAvailable: () => false, getIdbCache: () => null,
  queueSharedWrite: vi.fn(), queueMachineWrite: vi.fn(), flushIdb: vi.fn(),
  exportAllIdb: vi.fn(), importAllIdb: vi.fn(),
}));

const { saveUnifiedStorage, restoreUnifiedStorage } = await import('../../3dp_lib/dashboard_storage.js');

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
