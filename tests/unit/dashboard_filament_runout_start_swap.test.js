/**
 * @fileoverview ADR-0005 回帰: 残量0/要交換のスプールで印刷開始 → 印刷中のフィラメント交換
 *
 * 前提条件(従来テストで未カバー): OLD スプールが印刷開始時点で残量0
 *   = currentJobStartLength=0、かつ beginExternalPrint が設定する currentJobExpectedLength>0。
 *
 * バグ: setCurrentSpoolId(split) 内の per-reel finalize が _Uold=0 を渡すと、
 *   finalizeFilamentUsage の「used<=0 → 見積り長フォールバック」が発火し、
 *   空スプールにジョブ全体の見積り長(=架空消費)を記録、進行中ジョブを早期完了マーク、
 *   printCount を水増し。結果、実際に印刷した新スプールが未帰属(=満タン100%)になり記録消失。
 *
 * 修正: per-reel finalize は { exact:true } で見積りフォールバックを抑止（根本）＋
 *   消費0の旧リールは split filamentInfo に載せない（防御 → 新スプールが正しく帰属）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockMonitorData = {
  machines: {}, filamentSpools: [], usageHistory: [], mountHistory: [],
  hostSpoolMap: {}, filamentEventContext: {}, spoolSerialCounter: 0,
};

vi.mock('../../3dp_lib/dashboard_data.js', () => ({
  monitorData: mockMonitorData,
  setStoredDataForHost: vi.fn(),
  PLACEHOLDER_HOSTNAME: '_$_NO_MACHINE_$_',
}));
vi.mock('../../3dp_lib/dashboard_storage.js', () => ({ saveUnifiedStorage: vi.fn(), trimUsageHistory: vi.fn() }));
vi.mock('../../3dp_lib/dashboard_filament_inventory.js', () => ({ consumeInventory: vi.fn() }));
vi.mock('../../3dp_lib/dashboard_ui.js', () => ({ updateStoredDataToDOM: vi.fn() }));
vi.mock('../../3dp_lib/dashboard_printmanager.js', () => ({
  updateHistoryList: vi.fn(), loadHistory: vi.fn(() => []), saveHistory: vi.fn(),
}));
vi.mock('../../3dp_lib/dashboard_connection.js', () => ({ getDisplayBaseUrl: vi.fn(() => 'http://t') }));

const ledger = await import('../../3dp_lib/dashboard_filament_ledger.js');
const { setCurrentSpoolId, registerRebaselineHostUsage, finalizeFilamentUsage } =
  await import('../../3dp_lib/dashboard_spool.js');

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
function addSpool(sp) { mockMonitorData.filamentSpools.push(sp); return sp; }
function histJob(host, id) { return mockMonitorData.machines[host].printStore.history.find(h => String(h.id) === String(id)); }

/** 残量0で印刷開始した OLD（startLen=0, expected=50000）＋一時停止中の切れ文脈をセットアップ */
function setupEmptyStartPaused({ usedAtSwap = 2000 } = {}) {
  mockMonitorData.machines['h'] = {
    printStore: { current: { id: '300' }, history: [job(100, 5000), job(200, 6000)] },
    storedData: { usedMaterialLength: { rawValue: usedAtSwap }, state: { rawValue: 5 } },
    runtimeData: { state: 5 },
    historyData: [],
  };
  const OLD = addSpool({
    id: 'OLD', totalLengthMm: 330000, remainingLengthMm: 0,
    currentPrintID: '300', currentJobStartLength: 0, currentJobExpectedLength: 50000,
    isActive: true, hostname: 'h', printCount: 0, usedLengthLog: [],
  });
  const NEW = addSpool({ id: 'NEW', totalLengthMm: 330000, remainingLengthMm: 330000 });
  mockMonitorData.hostSpoolMap = { h: 'OLD' };
  ledger.appendMountEvent({ host: 'h', spoolId: 'OLD', anchorRemainingMm: 0, sinceJobId: 200, ts: 1 });
  ledger.recordFilamentEvent({ host: 'h', ts: 50, stateAtEvent: 5, oldSpoolId: 'OLD', oldRemainingMm: 0, oldRemainingPct: 0, runout: true });
  return { OLD, NEW };
}

describe('残量0で印刷開始 → 印刷中(paused)交換: 架空消費を作らない（根本修正）', () => {
  beforeEach(reset);

  it('交換直後: 空OLDに架空消費を記録せず、進行中ジョブを早期完了マークしない', () => {
    const { OLD } = setupEmptyStartPaused();
    setCurrentSpoolId('NEW', 'h');

    const h300 = histJob('h', 300);
    // 架空消費(見積り50000)が OLD/履歴に書かれていないこと
    expect(OLD.usedLengthLog.find(l => String(l.jobId) === '300')?.used ?? 0).not.toBe(50000);
    expect(OLD.printCount, '空スプールで printCount を水増ししない').toBe(0);
    expect(OLD.remainingLengthMm, 'OLD は 0 のまま').toBe(0);
    // 進行中ジョブ300を materialUsedMm=50000/printfinish=1 で早期完了マークしない
    expect(h300?.materialUsedMm ?? 0, '進行中ジョブに架空 materialUsedMm を書かない').not.toBe(50000);
  });

  it('完了: NEW が残りを印刷 → NEW が正しく帰属（満タン100%に戻らない）', () => {
    const { NEW } = setupEmptyStartPaused({ usedAtSwap: 2000 });
    setCurrentSpoolId('NEW', 'h');

    // NEW が交換後に残り 48000 を印刷して完了（実測 48000）
    finalizeFilamentUsage(48000, '300', 'h', true);

    const remNew = ledger.deriveSpoolRemaining('NEW').remainingMm;
    expect(remNew, 'NEW は実際に印刷した分だけ減る（満タン330000=記録消失ではない）').toBeLessThan(330000);
    expect(remNew).toBe(282000);                                  // 330000 - 48000
    expect(ledger.deriveSpoolRemaining('OLD').remainingMm).toBe(0); // 空OLDは0維持
    expect(histJob('h', 300).materialUsedMm).toBe(48000);          // 実値（架空50000ではない）
  });

  it('完了: NEW実測が取得できなくても（accumulated≒0）NEWは単一スプール帰属で満タンに戻らない', () => {
    const { NEW } = setupEmptyStartPaused({ usedAtSwap: 0 });
    setCurrentSpoolId('NEW', 'h');

    // ライブ追跡が 0 で完了 → その後プリンタ確定値(reqHistory 相当)が入る
    finalizeFilamentUsage(0, '300', 'h', true);
    // プリンタ報告の総消費が後から入る（単一スプールジョブ）
    const h300 = histJob('h', 300) || (mockMonitorData.machines.h.printStore.history.push(job(300, 50000)), histJob('h', 300));
    h300.materialUsedMm = 50000;

    const remNew = ledger.deriveSpoolRemaining('NEW').remainingMm;
    expect(remNew, 'NEW は単一スプール materialUsedMm 帰属で減る（100%固定にならない）').toBeLessThan(330000);
  });
});

describe('対照: 残量ありの genuine split は従来どおり（回帰防止）', () => {
  beforeEach(reset);

  it('OLD残量あり(startLen=300000)の paused 交換は per-reel 分割を維持し OLD→0', () => {
    mockMonitorData.machines['h'] = {
      printStore: { current: { id: '300' }, history: [job(100, 5000), job(200, 6000)] },
      storedData: { usedMaterialLength: { rawValue: 15000 }, state: { rawValue: 5 } },
      runtimeData: { state: 5 },
      historyData: [],
    };
    const OLD = addSpool({
      id: 'OLD', totalLengthMm: 330000, remainingLengthMm: 285000,
      currentPrintID: '300', currentJobStartLength: 300000, currentJobExpectedLength: 50000,
      isActive: true, hostname: 'h', printCount: 0, usedLengthLog: [],
    });
    addSpool({ id: 'NEW', totalLengthMm: 330000, remainingLengthMm: 330000 });
    mockMonitorData.hostSpoolMap = { h: 'OLD' };
    ledger.appendMountEvent({ host: 'h', spoolId: 'OLD', anchorRemainingMm: 300000, sinceJobId: 200, ts: 1 });
    ledger.recordFilamentEvent({ host: 'h', ts: 50, stateAtEvent: 5, oldSpoolId: 'OLD', oldRemainingMm: 285000, oldRemainingPct: 86, runout: true });

    setCurrentSpoolId('NEW', 'h');

    // genuine split: 旧リールの per-reel(300000) は維持、OLD は切れ確定で 0
    expect(OLD.remainingLengthMm).toBe(0);
    expect(histJob('h', 300).filamentInfo.find(fi => fi.spoolId === 'OLD').usedMm).toBe(300000);

    finalizeFilamentUsage(25000, '300', 'h');
    expect(ledger.deriveSpoolRemaining('NEW').remainingMm).toBe(305000); // 330000-25000
    expect(ledger.deriveSpoolRemaining('OLD').remainingMm).toBe(0);
  });
});
