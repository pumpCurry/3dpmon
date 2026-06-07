/**
 * @fileoverview ADR-0005 状態認識つきフィラメント帰属の結合テスト
 *
 * 実際の setCurrentSpoolId（dashboard_spool.js）＋実際の台帳（dashboard_filament_ledger.js）を
 * 共有 monitorData 上で駆動し、稼働中=ジョブ全体／一時停止=分割、B1（0張り付き解消）の
 * 再ベースライン、イベント文脈の解決、冪等性、マルチホスト対称を検証する。
 *
 * 重い DOM/ストレージ依存はモックする。aggregator の rebaselineHostUsage は
 * registerRebaselineHostUsage でスパイを注入し、呼び出し引数を検証する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockMonitorData = {
  machines: {},
  filamentSpools: [],
  usageHistory: [],
  mountHistory: [],
  hostSpoolMap: {},
  filamentEventContext: {},
  spoolSerialCounter: 0,
};

vi.mock('../../3dp_lib/dashboard_data.js', () => ({
  monitorData: mockMonitorData,
  setStoredDataForHost: vi.fn(),
  PLACEHOLDER_HOSTNAME: '_$_NO_MACHINE_$_',
}));
vi.mock('../../3dp_lib/dashboard_storage.js', () => ({
  saveUnifiedStorage: vi.fn(),
  trimUsageHistory: vi.fn(),
}));
vi.mock('../../3dp_lib/dashboard_filament_inventory.js', () => ({ consumeInventory: vi.fn() }));
vi.mock('../../3dp_lib/dashboard_ui.js', () => ({ updateStoredDataToDOM: vi.fn() }));
vi.mock('../../3dp_lib/dashboard_printmanager.js', () => ({
  updateHistoryList: vi.fn(),
  loadHistory: vi.fn(() => []),
  saveHistory: vi.fn(),
}));
vi.mock('../../3dp_lib/dashboard_connection.js', () => ({ getDisplayBaseUrl: vi.fn(() => 'http://t') }));

const ledger = await import('../../3dp_lib/dashboard_filament_ledger.js');
const {
  setCurrentSpoolId,
  registerRebaselineHostUsage,
  finalizeFilamentUsage,
  addInferredSpool,
  confirmInferredSpool,
  revertInferredSpool,
} = await import('../../3dp_lib/dashboard_spool.js');
const { consumeInventory } = await import('../../3dp_lib/dashboard_filament_inventory.js');

let rebaselineSpy;

function reset() {
  mockMonitorData.machines = {};
  mockMonitorData.filamentSpools = [];
  mockMonitorData.usageHistory = [];
  mockMonitorData.mountHistory = [];
  mockMonitorData.hostSpoolMap = {};
  mockMonitorData.filamentEventContext = {};
  mockMonitorData.spoolSerialCounter = 0;
  vi.clearAllMocks();
  rebaselineSpy = vi.fn();
  registerRebaselineHostUsage(rebaselineSpy);
}

function job(id, usedMm, extra = {}) {
  return { id, materialUsedMm: usedMm, printfinish: extra.printfinish ?? (usedMm > 0 ? 1 : 0), ...extra };
}

function setupHost(host, { history = [], currentId = '', used = NaN, state = 1 } = {}) {
  mockMonitorData.machines[host] = {
    printStore: { current: currentId ? { id: currentId } : null, history },
    storedData: {
      usedMaterialLength: Number.isFinite(used) ? { rawValue: used } : undefined,
      state: { rawValue: state },
    },
    runtimeData: { state },
    historyData: [],
  };
}

function addSpool(sp) { mockMonitorData.filamentSpools.push(sp); return sp; }
function ev(type, spoolId) { return mockMonitorData.mountHistory.find(e => e.type === type && e.spoolId === spoolId); }
function histJob(host, id) { return mockMonitorData.machines[host].printStore.history.find(h => String(h.id) === String(id)); }

// =====================================================================
// 1. 稼働中スプール交換 → ジョブ全体を新スプールへ（B2是正・B1解消）
// =====================================================================
describe('稼働中（printing）スプール交換 = ジョブ全体→新', () => {
  beforeEach(reset);

  it('旧の当該ジョブ debit は計上せず、新が J 全体を取得。0張り付きしない', () => {
    setupHost('h', { history: [job(100, 5000), job(200, 6000)], currentId: '300', used: 8000, state: 1 });
    const OLD = addSpool({
      id: 'OLD', totalLengthMm: 330000, remainingLengthMm: 290000,
      currentPrintID: '300', currentJobStartLength: 300000, isActive: true, hostname: 'h',
    });
    const NEW = addSpool({ id: 'NEW', totalLengthMm: 330000, remainingLengthMm: 330000 });
    mockMonitorData.hostSpoolMap = { h: 'OLD' };
    // OLD は印刷開始前から装着（since=200, anchor=300000）
    ledger.appendMountEvent({ host: 'h', spoolId: 'OLD', anchorRemainingMm: 300000, sinceJobId: 200, ts: 1 });

    expect(setCurrentSpoolId('NEW', 'h')).toBe(true);
    expect(mockMonitorData.hostSpoolMap.h).toBe('NEW');

    // 旧 unmount until=Lc=200（J=300 を除外）
    expect(ev('unmount', 'OLD').untilJobId).toBe(200);
    // 新 mount since=200, anchor=330000+8000=338000
    expect(ev('mount', 'NEW').sinceJobId).toBe(200);
    expect(ev('mount', 'NEW').anchorRemainingMm).toBe(338000);

    // B1: ライブ基点 = remaining + usedAtSwap、rebaseline(accumulated=usedAtSwap)
    expect(NEW.currentJobStartLength).toBe(338000);
    expect(rebaselineSpy).toHaveBeenCalledWith('h', { accumulated: 8000, prevUsed: 8000 });
    // → remain = 338000 - 8000 = 330000 > 0（旧累積を引き継がない＝0に張り付かない）

    // 旧は J を除外して復元（live 290000 → 300000）
    expect(OLD.remainingLengthMm).toBe(300000);
    // 旧は当該ジョブを finalize していない
    expect(OLD.lastCompletedPrintID).toBeUndefined();

    // 完了シミュレート: J=300 プリンタ確定（単一スプール 40000）→ live==authority
    mockMonitorData.machines.h.printStore.history.push(job(300, 40000));
    expect(ledger.deriveSpoolRemaining('NEW').remainingMm).toBe(298000); // 338000-40000
    expect(ledger.deriveSpoolRemaining('OLD').remainingMm).toBe(300000); // J除外維持
  });

  it('イベント文脈なし＋ライブ printing でも whole（フォールバック）', () => {
    setupHost('h', { history: [job(200, 6000)], currentId: '300', used: 5000, state: 1 });
    addSpool({ id: 'OLD', totalLengthMm: 330000, remainingLengthMm: 295000,
      currentPrintID: '300', currentJobStartLength: 300000, isActive: true, hostname: 'h' });
    addSpool({ id: 'NEW', totalLengthMm: 330000, remainingLengthMm: 330000 });
    mockMonitorData.hostSpoolMap = { h: 'OLD' };
    ledger.appendMountEvent({ host: 'h', spoolId: 'OLD', anchorRemainingMm: 300000, sinceJobId: 200, ts: 1 });

    setCurrentSpoolId('NEW', 'h');
    expect(ev('unmount', 'OLD').untilJobId).toBe(200);          // until=Lc（whole）
    expect(ev('mount', 'NEW').anchorRemainingMm).toBe(335000);  // 330000+5000
  });
});

// =====================================================================
// 2. 一時停止中スプール交換 → 分割（旧→切れで0, 新→再開後）
// =====================================================================
describe('一時停止（paused）スプール交換 = 分割', () => {
  beforeEach(reset);

  it('旧 until=J・切れ確定で0、新は再開後のみ。完了で per-reel 帰属', () => {
    setupHost('h', { history: [job(100, 5000), job(200, 6000)], currentId: '300', used: 15000, state: 5 });
    const OLD = addSpool({
      id: 'OLD', totalLengthMm: 330000, remainingLengthMm: 285000,
      currentPrintID: '300', currentJobStartLength: 300000, isActive: true, hostname: 'h',
    });
    const NEW = addSpool({ id: 'NEW', totalLengthMm: 330000, remainingLengthMm: 330000 });
    mockMonitorData.hostSpoolMap = { h: 'OLD' };
    ledger.appendMountEvent({ host: 'h', spoolId: 'OLD', anchorRemainingMm: 300000, sinceJobId: 200, ts: 1 });
    // aggregator が記録した一時停止イベント（runout 確定）
    ledger.recordFilamentEvent({ host: 'h', ts: 50, stateAtEvent: 5, oldSpoolId: 'OLD', runout: true });

    setCurrentSpoolId('NEW', 'h');

    // mode=split: 旧 unmount until=J=300、新 mount since=200 anchor=330000（usedAtSwap 加算しない）
    expect(ev('unmount', 'OLD').untilJobId).toBe(300);
    expect(ev('mount', 'NEW').sinceJobId).toBe(200);
    expect(ev('mount', 'NEW').anchorRemainingMm).toBe(330000);

    // 旧は切れ確定 → 0 へ。printStore.history[300] に旧リール usedMm=300000
    expect(OLD.remainingLengthMm).toBe(0);
    expect(histJob('h', 300).filamentInfo.find(fi => fi.spoolId === 'OLD').usedMm).toBe(300000);

    // B1（分割）: 新は accumulated=0, prevUsed=usedAtResume(15000)
    expect(NEW.currentJobStartLength).toBe(330000);
    expect(rebaselineSpy).toHaveBeenCalledWith('h', { accumulated: 0, prevUsed: 15000 });

    // イベント解決（split）
    expect(ledger.getOpenFilamentEvent('h')).toBeNull();
    expect(mockMonitorData.filamentEventContext.h.resolution).toBe('split');

    // 完了シミュレート: 新が 25000 消費 → finalize(NEW, 25000)
    finalizeFilamentUsage(25000, '300', 'h');
    expect(histJob('h', 300).filamentInfo.find(fi => fi.spoolId === 'NEW').usedMm).toBe(25000);
    expect(ledger.deriveSpoolRemaining('NEW').remainingMm).toBe(305000); // 330000-25000
    expect(ledger.deriveSpoolRemaining('OLD').remainingMm).toBe(0);      // 切れ維持
  });
});

// =====================================================================
// 3. 冪等性 / マルチホスト対称
// =====================================================================
describe('冪等性・マルチホスト', () => {
  beforeEach(reset);

  it('同一スプールへの再交換は早期 return（mount を二重追記しない）', () => {
    setupHost('h', { history: [job(200, 6000)], currentId: '300', used: 4000, state: 1 });
    addSpool({ id: 'OLD', totalLengthMm: 330000, remainingLengthMm: 296000,
      currentPrintID: '300', currentJobStartLength: 300000, isActive: true, hostname: 'h' });
    addSpool({ id: 'NEW', totalLengthMm: 330000, remainingLengthMm: 330000 });
    mockMonitorData.hostSpoolMap = { h: 'OLD' };
    ledger.appendMountEvent({ host: 'h', spoolId: 'OLD', anchorRemainingMm: 300000, sinceJobId: 200, ts: 1 });

    setCurrentSpoolId('NEW', 'h');
    setCurrentSpoolId('NEW', 'h'); // 2回目（prevId===id 早期 return）
    const newMounts = mockMonitorData.mountHistory.filter(e => e.type === 'mount' && e.spoolId === 'NEW');
    expect(newMounts).toHaveLength(1);
  });

  it('2ホストの交換が互いに干渉しない（mountHistory/文脈が host 独立）', () => {
    for (const [h, oldId, newId] of [['h1', 'A1', 'B1'], ['h2', 'A2', 'B2']]) {
      setupHost(h, { history: [job(200, 6000)], currentId: '300', used: 7000, state: 1 });
      addSpool({ id: oldId, totalLengthMm: 330000, remainingLengthMm: 293000,
        currentPrintID: '300', currentJobStartLength: 300000, isActive: true, hostname: h });
      addSpool({ id: newId, totalLengthMm: 330000, remainingLengthMm: 330000 });
      mockMonitorData.hostSpoolMap[h] = oldId;
      ledger.appendMountEvent({ host: h, spoolId: oldId, anchorRemainingMm: 300000, sinceJobId: 200, ts: 1 });
    }
    setCurrentSpoolId('B1', 'h1');
    setCurrentSpoolId('B2', 'h2');

    expect(mockMonitorData.hostSpoolMap).toEqual({ h1: 'B1', h2: 'B2' });
    expect(ev('mount', 'B1').host).toBe('h1');
    expect(ev('mount', 'B2').host).toBe('h2');
    expect(rebaselineSpy).toHaveBeenCalledWith('h1', { accumulated: 7000, prevUsed: 7000 });
    expect(rebaselineSpy).toHaveBeenCalledWith('h2', { accumulated: 7000, prevUsed: 7000 });
  });
});

// =====================================================================
// 4. P6 inferred スプールのライフサイクル（R1: 在庫汚染防止）
// =====================================================================
describe('P6 inferred スプールのライフサイクル（R1）', () => {
  beforeEach(reset);

  it('addInferredSpool は serialCounter / inventory を消費せず inferred:true・満タン', () => {
    mockMonitorData.spoolSerialCounter = 5;
    const sp = addInferredSpool({ presetId: 'pre1', totalLengthMm: 330000, material: 'PLA', name: 'X' });
    expect(sp.inferred).toBe(true);
    expect(sp.serialNo).toBeNull();
    expect(sp.totalLengthMm).toBe(330000);
    expect(sp.remainingLengthMm).toBe(330000);          // 満タン仮定(R2)
    expect(mockMonitorData.spoolSerialCounter).toBe(5); // 不変（R1）
    expect(consumeInventory).not.toHaveBeenCalled();    // 在庫非消費（R1）
  });

  it('confirmInferredSpool で採番＋在庫消費＋inferred解除', () => {
    mockMonitorData.spoolSerialCounter = 5;
    const sp = addInferredSpool({ presetId: 'pre1', totalLengthMm: 330000 });
    const r = confirmInferredSpool(sp.id);
    expect(r.inferred).toBe(false);
    expect(r.serialNo).toBe(6);                          // ++counter
    expect(mockMonitorData.spoolSerialCounter).toBe(6);
    expect(consumeInventory).toHaveBeenCalledWith('pre1', 1);
  });

  it('confirmInferredSpool consumePreset:false は在庫消費しない', () => {
    const sp = addInferredSpool({ presetId: 'pre1', totalLengthMm: 330000 });
    confirmInferredSpool(sp.id, { consumePreset: false });
    expect(consumeInventory).not.toHaveBeenCalled();
  });

  it('非 inferred への confirm は no-op（null）', () => {
    const sp = addInferredSpool({ totalLengthMm: 330000 });
    sp.inferred = false; // 既に確定済み相当
    expect(confirmInferredSpool(sp.id)).toBeNull();
  });

  it('#3 投入: paused runout(ゲート成立) → 旧→0 / inferred(満)を分割装着、完了で per-reel', () => {
    setupHost('h', { history: [job(200, 6000)], currentId: '300', used: 12000, state: 5 });
    const OLD = addSpool({
      id: 'OLD', totalLengthMm: 330000, remainingLengthMm: 290000,
      currentPrintID: '300', currentJobStartLength: 300000, isActive: true, hostname: 'h',
    });
    mockMonitorData.hostSpoolMap = { h: 'OLD' };
    ledger.appendMountEvent({ host: 'h', spoolId: 'OLD', anchorRemainingMm: 300000, sinceJobId: 200, ts: 1 });
    ledger.recordFilamentEvent({ host: 'h', ts: 50, stateAtEvent: 5, oldSpoolId: 'OLD', oldRemainingPct: 3, runout: true });

    // _resolveRunoutOnReplace #3 のコア動作を再現（同プリセット新品を inferred 推定投入→split装着）
    const inferred = addInferredSpool(OLD);
    expect(inferred.inferred).toBe(true);
    expect(mockMonitorData.spoolSerialCounter).toBe(0); // 採番していない
    setCurrentSpoolId(inferred.id, 'h'); // paused → split

    expect(mockMonitorData.hostSpoolMap.h).toBe(inferred.id);
    expect(OLD.remainingLengthMm).toBe(0);               // 切れ確定 → 0
    expect(inferred.currentJobStartLength).toBe(330000); // 新満タン基点

    finalizeFilamentUsage(20000, '300', 'h');
    expect(ledger.deriveSpoolRemaining(inferred.id).remainingMm).toBe(310000); // 330000-20000
    expect(ledger.deriveSpoolRemaining('OLD').remainingMm).toBe(0);
  });

  it('多重登録: inferred 装着中に実スプール登録 → inferred を破棄（phantom 残さない）', () => {
    setupHost('h', { history: [job(200, 6000)], currentId: '300', used: 5000, state: 1 });
    const inferred = addInferredSpool({ totalLengthMm: 330000 });
    inferred.isActive = true; inferred.hostname = 'h';
    inferred.currentPrintID = '300'; inferred.currentJobStartLength = 330000;
    addSpool({ id: 'REAL', totalLengthMm: 330000, remainingLengthMm: 330000 });
    mockMonitorData.hostSpoolMap = { h: inferred.id };
    ledger.appendMountEvent({ host: 'h', spoolId: inferred.id, anchorRemainingMm: 330000, sinceJobId: 200, ts: 1 });

    setCurrentSpoolId('REAL', 'h');
    expect(mockMonitorData.hostSpoolMap.h).toBe('REAL');
    expect(inferred.deleted).toBe(true);   // phantom 破棄
    expect(inferred.isDeleted).toBe(true);
  });
});

// =====================================================================
// 5. P6 #3 完全可逆（revertInferredSpool, F-A: 同一リール戻し）
// =====================================================================
describe('P6 #3 完全可逆（revertInferredSpool）', () => {
  beforeEach(reset);

  // #3 のコア（aggregator _resolveRunoutOnReplace 相当）を再現して inferred 装着状態を作る
  function setupInferredMounted() {
    setupHost('h', { history: [job(200, 6000)], currentId: '300', used: 18000, state: 5 });
    const OLD = addSpool({
      id: 'OLD', totalLengthMm: 330000, remainingLengthMm: 23100, // ~7%
      currentPrintID: '300', currentJobStartLength: 300000, isActive: true, hostname: 'h',
    });
    mockMonitorData.hostSpoolMap = { h: 'OLD' };
    ledger.appendMountEvent({ host: 'h', spoolId: 'OLD', anchorRemainingMm: 300000, sinceJobId: 200, ts: 1 });
    ledger.recordFilamentEvent({ host: 'h', ts: 50, stateAtEvent: 5, oldSpoolId: 'OLD', oldRemainingMm: 23100, oldRemainingPct: 7, runout: true });
    const inferred = addInferredSpool(OLD);
    inferred._supersedes = { spoolId: 'OLD', host: 'h', prevRemaining: 23100, printID: '300' };
    setCurrentSpoolId(inferred.id, 'h'); // paused → split, OLD→0
    return { OLD, inferred };
  }

  it('即取消（消費0）→ 旧を残量込みで復元（OLD→23100, inferred 削除）', () => {
    const { OLD, inferred } = setupInferredMounted();
    expect(OLD.remainingLengthMm).toBe(0);                  // #3 で 0 化
    expect(mockMonitorData.hostSpoolMap.h).toBe(inferred.id);

    const restored = revertInferredSpool(inferred.id);
    expect(restored).toBe(OLD);
    expect(mockMonitorData.hostSpoolMap.h).toBe('OLD');     // 旧を再装着
    expect(OLD.isActive).toBe(true);
    expect(OLD.remainingLengthMm).toBe(23100);             // prevRemaining − 0
    expect(inferred.deleted).toBe(true);
    expect(inferred.isDeleted).toBe(true);
  });

  it('inferred 期間に消費があれば旧から差し引いて復元', () => {
    const { OLD, inferred } = setupInferredMounted();
    // inferred で新ジョブ 301 を 10000 消費して完了（inferredUsed=10000）
    mockMonitorData.machines.h.printStore.history.push(job(301, 10000));
    expect(ledger.deriveSpoolRemaining(inferred.id).remainingMm).toBe(320000); // 330000-10000

    const restored = revertInferredSpool(inferred.id);
    expect(restored.remainingLengthMm).toBe(13100);        // 23100 − 10000
  });
});
