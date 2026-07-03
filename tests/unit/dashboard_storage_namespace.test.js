/**
 * @file dashboard_storage_namespace.test.js
 * @description setStorageNamespace() がリレー子と standalone の永続データを
 *              localStorage / IndexedDB の両層で物理分離することを検証する。
 *
 * 背景: v2.2.1031 spec §6.7 の前提("ブラウザはオリジンが異なるため IDB が分離する")
 * は同一ブラウザ内の ?relay=standalone と readonly では成立しない(クエリ違いで
 * origin は同じ)。setStorageNamespace("relay") でリレー子側を別 DB / 別 LS キーへ
 * 切り替え、standalone の永続データを上書きから守る。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/* ── localStorage スタブ ── */
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

/* ── monitorData モック ── */
const monitorData = {
  appSettings: { connectionTargets: [], itemkeeper: {} },
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

function resetMonitorData() {
  monitorData.appSettings = { connectionTargets: [], itemkeeper: {} };
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
    }
  },
}));
vi.mock('../../3dp_lib/dashboard_filament_presets.js', () => ({ FILAMENT_PRESETS: [] }));
vi.mock('../../3dp_lib/dashboard_log_util.js', () => ({ logManager: { add: vi.fn() } }));
vi.mock('../../3dp_lib/dashboard_utils.js', () => ({ getCurrentTimestamp: () => 0 }));
vi.mock('../../3dp_lib/dashboard_filament_ledger.js', () => ({ initLedgerAnchors: () => ({ seeded: 0 }) }));

/* IDB は実装の setIdbDbName 呼び出しを spy できる本物のモジュールを使う(LS 経路は無効化) */
const _idbDbNameCalls = [];
vi.mock('../../3dp_lib/dashboard_storage_idb.js', () => ({
  initIdb: vi.fn(), isIdbAvailable: () => false, getIdbCache: () => null,
  queueSharedWrite: vi.fn(), queueMachineWrite: vi.fn(), flushIdb: vi.fn(),
  exportAllIdb: vi.fn(), importAllIdb: vi.fn(),
  setIdbDbName: vi.fn((name) => { _idbDbNameCalls.push(name); }),
  getIdbDbName: () => _idbDbNameCalls[_idbDbNameCalls.length - 1] || '3dpmon',
}));

const { saveUnifiedStorage, restoreUnifiedStorage, setStorageNamespace } =
  await import('../../3dp_lib/dashboard_storage.js');

beforeEach(() => {
  globalThis.localStorage.clear();
  _idbDbNameCalls.length = 0;
  resetMonitorData();
});

// =============================================================
// 既定 (standalone / 親) — 3dpmon-global / 3dpmon-host-* に保存
// =============================================================
describe('setStorageNamespace 既定(standalone/親)', () => {
  it('既定では LS キーは "3dpmon-global" / "3dpmon-host-*"、DB 名は "3dpmon"', () => {
    setStorageNamespace('');

    monitorData.appSettings.itemkeeper = { endpoint: 'https://standalone.example/' };
    monitorData.machines['HostA'] = {
      storedData: { x: { rawValue: 1 } },
      printStore: { history: [], current: null, videos: {} },
      runtimeData: {},
    };
    saveUnifiedStorage(true);

    expect(globalThis.localStorage.getItem('3dpmon-global')).toBeTruthy();
    expect(globalThis.localStorage.getItem('3dpmon-host-HostA')).toBeTruthy();
    // relay 系のキーは存在しない
    expect(globalThis.localStorage.getItem('3dpmon-relay-global')).toBeNull();
    expect(globalThis.localStorage.getItem('3dpmon-relay-host-HostA')).toBeNull();
    // IDB 名も既定
    expect(_idbDbNameCalls).toContain('3dpmon');
  });
});

// =============================================================
// "relay" 名前空間 — 3dpmon-relay-global / 3dpmon-relay-host-* に保存
// =============================================================
describe('setStorageNamespace("relay") リレー子', () => {
  it('LS キーは "3dpmon-relay-global" / "3dpmon-relay-host-*"、DB 名は "3dpmon-relay"', () => {
    setStorageNamespace('relay');

    monitorData.appSettings.itemkeeper = { endpoint: 'https://parent.example/' };
    monitorData.machines['HostA'] = {
      storedData: { y: { rawValue: 2 } },
      printStore: { history: [], current: null, videos: {} },
      runtimeData: {},
    };
    saveUnifiedStorage(true);

    expect(globalThis.localStorage.getItem('3dpmon-relay-global')).toBeTruthy();
    expect(globalThis.localStorage.getItem('3dpmon-relay-host-HostA')).toBeTruthy();
    // 既定キーは触られない
    expect(globalThis.localStorage.getItem('3dpmon-global')).toBeNull();
    expect(globalThis.localStorage.getItem('3dpmon-host-HostA')).toBeNull();
    // IDB 名も relay
    expect(_idbDbNameCalls).toContain('3dpmon-relay');
  });
});

// =============================================================
// ★ 本丸: standalone が書いたデータをリレー子が上書きしないこと
// =============================================================
describe('standalone と relay の物理分離(上書き耐性)', () => {
  it('standalone で保存 → relay モードへ切替 → relay で別データを保存しても、standalone のデータは残る', () => {
    // (1) standalone として保存
    setStorageNamespace('');
    monitorData.appSettings.itemkeeper = { endpoint: 'https://standalone.example/', clientId: 'sa' };
    monitorData.appSettings.connectionTargets = [{ dest: '192.168.1.1:9999', hostname: 'StandaloneHost' }];
    saveUnifiedStorage(true);

    const standaloneGlobalRaw = globalThis.localStorage.getItem('3dpmon-global');
    expect(standaloneGlobalRaw).toBeTruthy();
    const standaloneSnapshot = JSON.parse(standaloneGlobalRaw);
    expect(standaloneSnapshot.appSettings.itemkeeper.endpoint).toBe('https://standalone.example/');
    expect(standaloneSnapshot.appSettings.connectionTargets[0].dest).toBe('192.168.1.1:9999');

    // (2) relay モードに切替 → 別の(親由来の)データを保存
    setStorageNamespace('relay');
    resetMonitorData();
    monitorData.appSettings.itemkeeper = { endpoint: 'https://parent.example/', clientId: 'parent' };
    monitorData.appSettings.connectionTargets = [{ dest: '10.0.0.1:9999', hostname: 'ParentHost' }];
    saveUnifiedStorage(true);

    // (3) standalone 側のキーは無傷
    const reread = globalThis.localStorage.getItem('3dpmon-global');
    expect(reread).toBe(standaloneGlobalRaw); // バイト同一
    const stillStandalone = JSON.parse(reread);
    expect(stillStandalone.appSettings.itemkeeper.endpoint).toBe('https://standalone.example/');
    expect(stillStandalone.appSettings.connectionTargets[0].dest).toBe('192.168.1.1:9999');

    // relay 側にはちゃんと parent データが入っている
    const relayRaw = globalThis.localStorage.getItem('3dpmon-relay-global');
    const relaySnap = JSON.parse(relayRaw);
    expect(relaySnap.appSettings.itemkeeper.endpoint).toBe('https://parent.example/');
    expect(relaySnap.appSettings.connectionTargets[0].dest).toBe('10.0.0.1:9999');
  });

  it('relay 側で復元しても standalone の monitorData は読まれない(逆も同様)', () => {
    // standalone 保存
    setStorageNamespace('');
    monitorData.appSettings.itemkeeper = { endpoint: 'https://standalone.example/' };
    saveUnifiedStorage(true);

    // relay 側で復元 → relay の LS は空なので何も復元されない
    setStorageNamespace('relay');
    resetMonitorData();
    restoreUnifiedStorage();
    // 既定値のまま(standalone の endpoint は混ざらない)
    expect(monitorData.appSettings.itemkeeper?.endpoint).toBeUndefined();

    // standalone 側で復元 → 元の値が戻る
    setStorageNamespace('');
    resetMonitorData();
    restoreUnifiedStorage();
    expect(monitorData.appSettings.itemkeeper?.endpoint).toBe('https://standalone.example/');
  });
});
