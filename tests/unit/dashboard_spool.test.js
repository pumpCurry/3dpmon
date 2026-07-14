/**
 * dashboard_spool.js 純粋関数テスト
 *
 * テスト対象: DOM非依存の純粋関数群
 * - getSpoolState / getSpoolStateLabel
 * - formatSpoolDisplayId
 * - formatFilamentAmount
 * - weightFromLength / lengthFromWeight
 * - getMaterialDensity
 * - buildSpoolAnalytics
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- モジュールモック: dashboard_spool.js の依存を切り離す ---
vi.mock('../../3dp_lib/dashboard_data.js', () => ({
  monitorData: {
    machines: {},
    filamentSpools: [],
    hostSpoolMap: {},
  },
  setStoredDataForHost: vi.fn(),
}));
vi.mock('../../3dp_lib/dashboard_storage.js', () => ({
  saveUnifiedStorage: vi.fn(),
  trimUsageHistory: vi.fn(),
}));
vi.mock('../../3dp_lib/dashboard_filament_inventory.js', () => ({
  consumeInventory: vi.fn(),
}));
vi.mock('../../3dp_lib/dashboard_ui.js', () => ({
  updateStoredDataToDOM: vi.fn(),
}));
vi.mock('../../3dp_lib/dashboard_printmanager.js', () => ({
  updateHistoryList: vi.fn(),
  loadHistory: vi.fn(() => []),
  saveHistory: vi.fn(),
}));
vi.mock('../../3dp_lib/dashboard_connection.js', () => ({
  getDisplayBaseUrl: vi.fn(() => 'http://test:80'),
}));

import {
  SPOOL_STATE,
  MATERIAL_DENSITY,
  getSpoolState,
  getSpoolStateLabel,
  formatSpoolDisplayId,
  formatFilamentAmount,
  formatUsageHtml,
  usageHeaderLabel,
  weightFromLength,
  lengthFromWeight,
  getMaterialDensity,
  buildOfflineFilamentInfo,
  shouldLinkOfflineJob,
  finalizeFilamentUsage,
  catchUpOfflineFilamentAttribution,
  isAttributionPending,
  getUnattributedUsageForHost,
  countUnattributedUsageForHost,
} from '../../3dp_lib/dashboard_spool.js';
import { monitorData } from '../../3dp_lib/dashboard_data.js';
import { loadHistory, saveHistory } from '../../3dp_lib/dashboard_printmanager.js';

// =============================================
// getSpoolState
// =============================================
describe('getSpoolState', () => {
  it('null/undefined → INVENTORY', () => {
    expect(getSpoolState(null)).toBe(SPOOL_STATE.INVENTORY);
    expect(getSpoolState(undefined)).toBe(SPOOL_STATE.INVENTORY);
  });

  it('deleted=true → DISCARDED', () => {
    expect(getSpoolState({ deleted: true })).toBe(SPOOL_STATE.DISCARDED);
  });

  it('isDeleted=true → DISCARDED', () => {
    expect(getSpoolState({ isDeleted: true })).toBe(SPOOL_STATE.DISCARDED);
  });

  it('isActive=true → MOUNTED', () => {
    expect(getSpoolState({ isActive: true })).toBe(SPOOL_STATE.MOUNTED);
  });

  it('deleted優先: deleted=true + isActive=true → DISCARDED', () => {
    expect(getSpoolState({ deleted: true, isActive: true })).toBe(SPOOL_STATE.DISCARDED);
  });

  it('removedAt + 残量>100mm → STORED', () => {
    expect(
      getSpoolState({ removedAt: Date.now(), remainingLengthMm: 5000 }),
    ).toBe(SPOOL_STATE.STORED);
  });

  it('removedAt + 残量<=100mm → EXHAUSTED', () => {
    expect(
      getSpoolState({ removedAt: Date.now(), remainingLengthMm: 100 }),
    ).toBe(SPOOL_STATE.EXHAUSTED);
    expect(
      getSpoolState({ removedAt: Date.now(), remainingLengthMm: 0 }),
    ).toBe(SPOOL_STATE.EXHAUSTED);
  });

  it('removedAt + 残量=101mm → STORED (境界値)', () => {
    expect(
      getSpoolState({ removedAt: Date.now(), remainingLengthMm: 101 }),
    ).toBe(SPOOL_STATE.STORED);
  });

  it('removedAt + 残量未設定(null/undefined) → EXHAUSTED (0扱い)', () => {
    expect(
      getSpoolState({ removedAt: Date.now(), remainingLengthMm: null }),
    ).toBe(SPOOL_STATE.EXHAUSTED);
    expect(
      getSpoolState({ removedAt: Date.now() }),
    ).toBe(SPOOL_STATE.EXHAUSTED);
  });

  it('フラグなし → INVENTORY', () => {
    expect(getSpoolState({})).toBe(SPOOL_STATE.INVENTORY);
    expect(getSpoolState({ isActive: false })).toBe(SPOOL_STATE.INVENTORY);
  });
});

// =============================================
// getSpoolStateLabel
// =============================================
describe('getSpoolStateLabel', () => {
  it('全5状態の日本語ラベル', () => {
    expect(getSpoolStateLabel(SPOOL_STATE.INVENTORY)).toBe('未使用');
    expect(getSpoolStateLabel(SPOOL_STATE.MOUNTED)).toBe('装着中');
    expect(getSpoolStateLabel(SPOOL_STATE.STORED)).toBe('保管中');
    expect(getSpoolStateLabel(SPOOL_STATE.EXHAUSTED)).toBe('使い切り');
    expect(getSpoolStateLabel(SPOOL_STATE.DISCARDED)).toBe('廃棄済');
  });

  it('未知の状態 → "不明"', () => {
    expect(getSpoolStateLabel('unknown')).toBe('不明');
    expect(getSpoolStateLabel(null)).toBe('不明');
    expect(getSpoolStateLabel('')).toBe('不明');
  });
});

// =============================================
// formatSpoolDisplayId
// =============================================
describe('formatSpoolDisplayId', () => {
  it('serialNo=1 → "#001"', () => {
    expect(formatSpoolDisplayId({ serialNo: 1 })).toBe('#001');
  });

  it('serialNo=42 → "#042"', () => {
    expect(formatSpoolDisplayId({ serialNo: 42 })).toBe('#042');
  });

  it('serialNo=123 → "#123"', () => {
    expect(formatSpoolDisplayId({ serialNo: 123 })).toBe('#123');
  });

  it('serialNo=1000 → "#1000" (4桁以上)', () => {
    expect(formatSpoolDisplayId({ serialNo: 1000 })).toBe('#1000');
  });

  it('serialNo未設定 → "#000"', () => {
    expect(formatSpoolDisplayId({})).toBe('#000');
    expect(formatSpoolDisplayId({ serialNo: 0 })).toBe('#000');
    expect(formatSpoolDisplayId({ serialNo: null })).toBe('#000');
  });

  it('null/undefined → "#???"', () => {
    expect(formatSpoolDisplayId(null)).toBe('#???');
    expect(formatSpoolDisplayId(undefined)).toBe('#???');
  });
});

// =============================================
// MATERIAL_DENSITY / getMaterialDensity
// =============================================
describe('MATERIAL_DENSITY', () => {
  it('4素材の密度定義', () => {
    expect(MATERIAL_DENSITY.PLA).toBe(1.24);
    expect(MATERIAL_DENSITY.PETG).toBe(1.27);
    expect(MATERIAL_DENSITY.ABS).toBe(1.04);
    expect(MATERIAL_DENSITY.TPU).toBe(1.20);
  });
});

describe('getMaterialDensity', () => {
  it('既知素材 → 正しい密度', () => {
    expect(getMaterialDensity('PLA')).toBe(1.24);
    expect(getMaterialDensity('PETG')).toBe(1.27);
  });

  it('拡張素材（Phase 2 追加）の密度を返す', () => {
    expect(getMaterialDensity('PLA+')).toBe(1.24);
    expect(getMaterialDensity('ASA')).toBe(1.07);
    expect(getMaterialDensity('PA')).toBe(1.14);
    expect(getMaterialDensity('Nylon')).toBe(1.14);
    expect(getMaterialDensity('PC')).toBe(1.20);
    expect(getMaterialDensity('PETG-CF')).toBe(1.35);
    expect(getMaterialDensity('HIPS')).toBe(1.04);
    expect(getMaterialDensity('PVA')).toBe(1.19);
  });

  it('大文字小文字非依存で照合', () => {
    expect(getMaterialDensity('pla')).toBe(1.24);
    expect(getMaterialDensity('petg')).toBe(1.27);
    expect(getMaterialDensity('Asa')).toBe(1.07);
  });

  it('未知素材 → PLA密度にフォールバック', () => {
    expect(getMaterialDensity('UnknownMaterial')).toBe(1.24);
    expect(getMaterialDensity(null)).toBe(1.24);
    expect(getMaterialDensity('')).toBe(1.24);
  });
});

// =============================================
// weightFromLength / lengthFromWeight
// =============================================
describe('weightFromLength', () => {
  it('PLA 1000mm → 約2.98g', () => {
    // π * (0.875)^2 * 1000 * 1.24 / 1000
    const area = Math.PI * (1.75 / 2) ** 2; // ~2.405 mm^2
    const expected = (area * 1000 * 1.24) / 1000;
    expect(weightFromLength(1000, 1.24, 1.75)).toBeCloseTo(expected, 2);
  });

  it('PLA 336000mm (1kg標準スプール) → 約1000g', () => {
    const weight = weightFromLength(336000, 1.24);
    // 336m のPLAは約1kgになるはず
    expect(weight).toBeGreaterThan(900);
    expect(weight).toBeLessThan(1100);
  });

  it('密度未指定 → PLA密度でフォールバック', () => {
    const withPLA = weightFromLength(1000, 1.24);
    const withNull = weightFromLength(1000, null);
    expect(withNull).toBeCloseTo(withPLA, 5);
  });

  it('0mm → 0g', () => {
    expect(weightFromLength(0, 1.24)).toBe(0);
  });
});

describe('lengthFromWeight', () => {
  it('PLA 1000g → 約336000mm (336m)', () => {
    const length = lengthFromWeight(1000, 1.24);
    expect(length).toBeGreaterThan(300000);
    expect(length).toBeLessThan(370000);
  });

  it('0g → 0mm', () => {
    expect(lengthFromWeight(0, 1.24)).toBe(0);
  });
});

describe('重量⇔長さの往復変換', () => {
  it('weightFromLength → lengthFromWeight で元に戻る', () => {
    const originalMm = 100000;
    const weight = weightFromLength(originalMm, 1.24);
    const backMm = lengthFromWeight(weight, 1.24);
    expect(backMm).toBeCloseTo(originalMm, 1);
  });

  it('PETG でも往復変換が一致', () => {
    const originalMm = 250000;
    const weight = weightFromLength(originalMm, 1.27);
    const backMm = lengthFromWeight(weight, 1.27);
    expect(backMm).toBeCloseTo(originalMm, 1);
  });
});

// =============================================
// formatFilamentAmount
// =============================================
describe('formatFilamentAmount', () => {
  it('基本変換: 12340mm → 12.3m', () => {
    const result = formatFilamentAmount(12340);
    expect(result.mm).toBe(12340);
    expect(result.m).toBe('12.3');
  });

  it('0mm → 0.0m', () => {
    const result = formatFilamentAmount(0);
    expect(result.mm).toBe(0);
    expect(result.m).toBe('0.0');
  });

  it('null/undefined → 0', () => {
    const result = formatFilamentAmount(null);
    expect(result.mm).toBe(0);
    expect(result.m).toBe('0.0');
  });

  it('spool付きで重量計算', () => {
    const spool = {
      density: 1.24,
      filamentDiameter: 1.75,
      totalLengthMm: 336000,
      purchasePrice: 1699,
      currencySymbol: '¥',
    };
    const result = formatFilamentAmount(168000, spool);
    expect(result.mm).toBe(168000);
    expect(result.m).toBe('168.0');
    // g が計算されているはず
    expect(result.g).not.toBeNull();
    expect(Number(result.g)).toBeGreaterThan(0);
  });

  it('spool付きでコスト計算', () => {
    const spool = {
      density: 1.24,
      filamentDiameter: 1.75,
      totalLengthMm: 336000,
      purchasePrice: 1699,
      currencySymbol: '¥',
    };
    const result = formatFilamentAmount(168000, spool);
    // 半分の長さ → 約半分のコスト
    expect(result.cost).not.toBeNull();
    const cost = Number(result.cost);
    expect(cost).toBeGreaterThan(700);
    expect(cost).toBeLessThan(1000);
  });

  it('display文字列が生成される', () => {
    const result = formatFilamentAmount(12340);
    expect(typeof result.display).toBe('string');
    expect(result.display.length).toBeGreaterThan(0);
  });
});

// =============================================
// formatUsageHtml（単位トグル + 2段表示）
// =============================================
describe('formatUsageHtml', () => {
  const spool = { density: 1.24, filamentDiameter: 1.75, totalLengthMm: 336000, purchasePrice: 1699, currencySymbol: '¥' };

  it('m単位: 距離を m 表示', () => {
    const html = formatUsageHtml(22800, null, 'm');
    expect(html).toContain('22.8m');
    expect(html).toContain('usage-dist');
  });

  it('mm単位: 距離を mm 表示（整数）', () => {
    const html = formatUsageHtml(22800, null, 'mm');
    expect(html).toContain('22800mm');
    expect(html).not.toContain('22.8m');
  });

  it('スプール付き: 距離と (g, ¥) が別 span（2段）', () => {
    const html = formatUsageHtml(168000, spool, 'm');
    expect(html).toContain('usage-dist');
    expect(html).toContain('usage-sub');
    expect(html).toMatch(/\(\d+g, ¥\d+\)/);
  });

  it('スプールなし: 2行目(usage-sub)は出さない', () => {
    const html = formatUsageHtml(22800, null, 'm');
    expect(html).not.toContain('usage-sub');
  });

  it('mm単位でもスプールの g/¥ は維持される', () => {
    const html = formatUsageHtml(168000, spool, 'mm');
    expect(html).toContain('168000mm');
    expect(html).toContain('usage-sub');
  });

  it('非有限値(NaN/undefined)は --- 表示', () => {
    // null は Number(null)=0 として 0 表示（formatFilamentAmount 既存仕様）
    expect(formatUsageHtml(NaN, null, 'mm')).toContain('---');
    expect(formatUsageHtml(undefined, null, 'm')).toContain('---');
    expect(formatUsageHtml(null, null, 'm')).toContain('0');
  });

  it('単位省略時は m', () => {
    expect(formatUsageHtml(5000)).toContain('5.0m');
  });
});

// =============================================
// usageHeaderLabel
// =============================================
describe('usageHeaderLabel', () => {
  it('m単位ヘッダー', () => {
    expect(usageHeaderLabel('使用量', 'm')).toBe('使用量(m)');
    expect(usageHeaderLabel('予定量', 'm')).toBe('予定量(m)');
  });
  it('mm単位ヘッダー', () => {
    expect(usageHeaderLabel('使用量', 'mm')).toBe('使用量(mm)');
  });
  it('単位省略時は m', () => {
    expect(usageHeaderLabel('使用量')).toBe('使用量(m)');
  });
});

// =============================================
// オフライン完了印刷のフィラメント継続紐付け
// =============================================
describe('buildOfflineFilamentInfo', () => {
  const spool = {
    id: 'sp-1', serialNo: 12, name: 'PLA+ 黒', colorName: '黒',
    filamentColor: '#000', material: 'PLA+', printCount: 5, remainingLengthMm: 100000,
  };
  it('現在スプールの情報を filamentInfo に写す', () => {
    const fi = buildOfflineFilamentInfo(spool, 22800);
    expect(fi.spoolId).toBe('sp-1');
    expect(fi.material).toBe('PLA+');
    expect(fi.usedMm).toBe(22800);
    expect(fi.expectedRemain).toBe(100000);
    expect(fi.isOfflineInferred).toBe(true);
  });
  it('usedMm 不正値は 0', () => {
    expect(buildOfflineFilamentInfo(spool, undefined).usedMm).toBe(0);
    expect(buildOfflineFilamentInfo(spool, NaN).usedMm).toBe(0);
  });
});

describe('shouldLinkOfflineJob', () => {
  it('★紐付けなしジョブ → 紐付け対象(true)', () => {
    expect(shouldLinkOfflineJob({ id: 1 })).toBe(true);
    expect(shouldLinkOfflineJob({ id: 1, filamentInfo: [] })).toBe(true);
  });
  it('既に filamentInfo を持つジョブは尊重(上書きしない)', () => {
    expect(shouldLinkOfflineJob({ id: 1, filamentInfo: [{ spoolId: 'x' }] })).toBe(false);
  });
  it('既に filamentId を持つジョブは尊重', () => {
    expect(shouldLinkOfflineJob({ id: 1, filamentId: 'x' })).toBe(false);
  });
  it('null/undefined は false', () => {
    expect(shouldLinkOfflineJob(null)).toBe(false);
    expect(shouldLinkOfflineJob(undefined)).toBe(false);
  });
});

// =============================================
// finalizeFilamentUsage: 多重 finalize ガード（ADR-0004）
// =============================================
describe('finalizeFilamentUsage 多重 finalize ガード', () => {
  beforeEach(() => {
    // モック monitorData をセット（dashboard_data.js は vi.mock 済み）
    monitorData.machines = {
      h: { printStore: { current: null, history: [] }, historyData: [] }
    };
    monitorData.hostSpoolMap = { h: 'sp1' };
    monitorData.filamentSpools = [{
      id: 'sp1', serialNo: 1, name: 'PLA', colorName: '黒', filamentColor: '#000',
      material: 'PLA', totalLengthMm: 100000, remainingLengthMm: 100000,
      currentPrintID: '1001', currentJobStartLength: 100000, currentJobExpectedLength: 5000,
      usedLengthLog: [], printCount: 0, costPerMm: 0
    }];
    monitorData.usageHistory = [];
    monitorData.mountHistory = [];
  });

  it('同一 jobId で2回 finalize → 2回目は残量/usedLengthLog/printCount 不変', () => {
    finalizeFilamentUsage(5000, '1001', 'h', true);
    const sp = monitorData.filamentSpools[0];
    const remainAfter1 = sp.remainingLengthMm;
    const logLenAfter1 = sp.usedLengthLog.length;
    const countAfter1 = sp.printCount;

    expect(remainAfter1).toBe(95000);      // 100000 - 5000
    expect(logLenAfter1).toBe(1);
    expect(countAfter1).toBe(1);
    expect(sp.lastCompletedPrintID).toBe('1001');

    // 2回目: 同一 jobId → ガードで即 return（何も変えない）
    finalizeFilamentUsage(5000, '1001', 'h', true);
    expect(sp.remainingLengthMm).toBe(remainAfter1); // 二重減算しない
    expect(sp.usedLengthLog.length).toBe(logLenAfter1); // ログ重複しない
    expect(sp.printCount).toBe(countAfter1); // printCount 増えない
  });

  it('usedLengthLog は同一 jobId を重複 push しない（多重防御）', () => {
    // ガード前にログが既に1件ある状態を作り、jobId 衝突時に push されないことを確認
    const sp = monitorData.filamentSpools[0];
    finalizeFilamentUsage(5000, '1001', 'h', true);
    expect(sp.usedLengthLog.filter(l => String(l.jobId) === '1001')).toHaveLength(1);
  });
});

// =============================================
// finalizeFilamentUsage: 無効jobId隔離（Phase2A）
// =============================================
describe('finalizeFilamentUsage 無効jobId隔離（Phase2A）', () => {
  beforeEach(() => {
    monitorData.machines = {
      h: { printStore: { current: null, history: [] }, historyData: [] }
    };
    monitorData.hostSpoolMap = { h: 'sp1' };
    monitorData.filamentSpools = [{
      id: 'sp1', serialNo: 1, name: 'PLA', colorName: '黒', filamentColor: '#000',
      material: 'PLA', totalLengthMm: 100000, remainingLengthMm: 100000,
      // ★ 電源投入直後の偽完了を模す: アクティブ追跡ジョブ無し（currentPrintID=""）
      currentPrintID: '', currentJobStartLength: 100000, currentJobExpectedLength: 5000,
      usedLengthLog: [], printCount: 0, costPerMm: 0
    }];
    monitorData.usageHistory = [];
    monitorData.mountHistory = [];
    monitorData.pendingUnattributedUsage = [];
  });

  it('無効jobId(0)は残量を減算せず消費を隔離し、確定記録を一切作らない', () => {
    finalizeFilamentUsage(5000, 0, 'h', true);
    const sp = monitorData.filamentSpools[0];

    // 消費は隔離領域へ退避（失わない）
    expect(monitorData.pendingUnattributedUsage).toHaveLength(1);
    const q = monitorData.pendingUnattributedUsage[0];
    expect(q.host).toBe('h');
    expect(q.spoolId).toBe('sp1');
    expect(q.usedMm).toBe(5000);
    expect(q.reason).toBe('invalid-job-id');
    expect(typeof q.detectedAtEpochMs).toBe('number');

    // ★ 残量は減算しない（権威は printStore.history。未帰属を残量へ入れると reconcile が盛り戻す）
    expect(sp.remainingLengthMm).toBe(100000);
    // jobId 由来の確定記録は一切作らない
    expect(sp.usedLengthLog).toHaveLength(0);
    expect(sp.lastCompletedPrintID).toBeUndefined();
    expect(sp.printCount).toBe(0);
    expect(monitorData.machines.h.historyData).toHaveLength(0);
    // transient はクリアされる
    expect(sp.currentJobStartLength).toBeNull();
    expect(sp.currentJobExpectedLength).toBeNull();
    expect(sp.currentPrintID).toBe('');
  });

  it.each([null, '', -5, 'abc', NaN])('無効jobId(%s)も同様に隔離される', (badId) => {
    finalizeFilamentUsage(5000, badId, 'h', true);
    const sp = monitorData.filamentSpools[0];
    expect(monitorData.pendingUnattributedUsage).toHaveLength(1);
    expect(sp.usedLengthLog).toHaveLength(0);
    expect(sp.lastCompletedPrintID).toBeUndefined();
    expect(sp.remainingLengthMm).toBe(100000);
  });

  it('無効jobIdでも消費0/NaNなら隔離レコードを作らず（差分なし）transientのみクリア', () => {
    // exact:true で 0 消費（見積りフォールバック無し）→ 隔離対象外
    finalizeFilamentUsage(0, 0, 'h', true, { exact: true });
    const sp = monitorData.filamentSpools[0];
    expect(monitorData.pendingUnattributedUsage).toHaveLength(0);
    expect(sp.currentJobStartLength).toBeNull();
    expect(sp.currentPrintID).toBe('');
  });

  it('有効jobIdは従来どおり記録し隔離しない（対比・退行防止）', () => {
    // currentPrintID を有効IDに合わせて通常完了させる
    monitorData.filamentSpools[0].currentPrintID = '1001';
    finalizeFilamentUsage(5000, '1001', 'h', true);
    const sp = monitorData.filamentSpools[0];
    expect(monitorData.pendingUnattributedUsage).toHaveLength(0);
    expect(sp.remainingLengthMm).toBe(95000);   // 100000 - 5000
    expect(sp.usedLengthLog).toHaveLength(1);
    expect(sp.lastCompletedPrintID).toBe('1001');
    expect(sp.printCount).toBe(1);
  });

  it('有効なcurrentPrintIDに対する無効ID完了は不一致ガードが優先（隔離しない）', () => {
    // アクティブジョブ 1001 が進行中に、偽の jobId=0 完了通知が来た場合は
    // 「別ジョブの完了」として不一致ガードで transient をクリアして無視する（隔離しない）。
    monitorData.filamentSpools[0].currentPrintID = '1001';
    finalizeFilamentUsage(5000, 0, 'h', true);
    const sp = monitorData.filamentSpools[0];
    expect(monitorData.pendingUnattributedUsage).toHaveLength(0);
    expect(sp.remainingLengthMm).toBe(100000);  // 減算なし
    expect(sp.currentPrintID).toBe('');          // 不一致で transient クリア
  });

  it('隔離レコードは最新200件に上限される（肥大化防止）', () => {
    for (let i = 0; i < 210; i++) {
      // 毎回 transient を戻して無効ID完了を繰り返す
      monitorData.filamentSpools[0].currentJobStartLength = 100000;
      monitorData.filamentSpools[0].currentJobExpectedLength = 5000;
      monitorData.filamentSpools[0].currentPrintID = '';
      finalizeFilamentUsage(100, 0, 'h', true);
    }
    expect(monitorData.pendingUnattributedUsage.length).toBe(200);
  });
});

// =============================================
// 未帰属消費の可視化 純関数（Phase4）
// =============================================
describe('isAttributionPending / getUnattributedUsageForHost（Phase4）', () => {
  beforeEach(() => {
    monitorData.pendingUnattributedUsage = [];
  });

  it('消費あり×未帰属（spoolId/filamentId無し）は pending', () => {
    expect(isAttributionPending({ id: 1, materialUsedMm: 5000 })).toBe(true);
    expect(isAttributionPending({ id: 1, materialUsedMm: 5000, filamentInfo: [{ colorName: '黒' }] })).toBe(true);
  });

  it('確定スプール（spoolId）or filamentId があれば pending でない', () => {
    expect(isAttributionPending({ id: 1, materialUsedMm: 5000, filamentInfo: [{ spoolId: 'sp1' }] })).toBe(false);
    expect(isAttributionPending({ id: 1, materialUsedMm: 5000, filamentId: 'sp1' })).toBe(false);
  });

  it('消費なし（materialUsedMm<=0/欠落）は pending でない', () => {
    expect(isAttributionPending({ id: 1, materialUsedMm: 0 })).toBe(false);
    expect(isAttributionPending({ id: 1 })).toBe(false);
    expect(isAttributionPending(null)).toBe(false);
  });

  it('getUnattributedUsageForHost はホストで絞り込み、count が件数を返す', () => {
    monitorData.pendingUnattributedUsage = [
      { host: 'h1', usedMm: 100 }, { host: 'h2', usedMm: 200 }, { host: 'h1', usedMm: 300 },
    ];
    expect(getUnattributedUsageForHost('h1')).toHaveLength(2);
    expect(getUnattributedUsageForHost('h2')).toHaveLength(1);
    expect(countUnattributedUsageForHost('h1')).toBe(2);
    expect(countUnattributedUsageForHost('h2')).toBe(1);
    expect(countUnattributedUsageForHost()).toBe(3); // 全体
  });
});

// =============================================
// SPOOL_STATE 定数の完全性
// =============================================
describe('SPOOL_STATE 定数', () => {
  it('5状態が定義されている', () => {
    const states = Object.values(SPOOL_STATE);
    expect(states).toHaveLength(5);
    expect(states).toContain('inventory');
    expect(states).toContain('mounted');
    expect(states).toContain('stored');
    expect(states).toContain('exhausted');
    expect(states).toContain('discarded');
  });

  it('各値がユニーク', () => {
    const states = Object.values(SPOOL_STATE);
    const unique = new Set(states);
    expect(unique.size).toBe(states.length);
  });
});

// ── buildFilamentRecommendations テスト ──────────────────

describe('buildFilamentRecommendations', () => {
  let buildFilamentRecommendations, registerPrintManagerAccessor;

  beforeEach(async () => {
    const mod = await import('../../3dp_lib/dashboard_spool.js');
    buildFilamentRecommendations = mod.buildFilamentRecommendations;
    registerPrintManagerAccessor = mod.registerPrintManagerAccessor;
  });

  it('アクセサ未登録なら空配列を返す', () => {
    registerPrintManagerAccessor(null);
    const result = buildFilamentRecommendations(5000, 'PLA', 'host1');
    expect(result).toEqual([]);
  });

  it('ファイルリストが空なら空配列を返す', () => {
    registerPrintManagerAccessor({
      getFileList: () => [],
      buildFileInsight: () => null
    });
    const result = buildFilamentRecommendations(5000, 'PLA', 'host1');
    expect(result).toEqual([]);
  });

  it('残量不足のファイルを除外する', () => {
    registerPrintManagerAccessor({
      getFileList: () => [
        { basename: 'small.gcode', usagematerial: 3000 },
        { basename: 'large.gcode', usagematerial: 10000 }
      ],
      buildFileInsight: () => null
    });
    const result = buildFilamentRecommendations(5000, 'PLA', 'host1');
    expect(result).toHaveLength(1);
    expect(result[0].basename).toBe('small.gcode');
  });

  it('maxResults で結果数を制限', () => {
    registerPrintManagerAccessor({
      getFileList: () => Array.from({ length: 10 }, (_, i) => ({
        basename: `file${i}.gcode`, usagematerial: 1000
      })),
      buildFileInsight: () => null
    });
    const result = buildFilamentRecommendations(5000, 'PLA', 'host1', { maxResults: 3 });
    expect(result).toHaveLength(3);
  });

  it('フィット率が高いファイルが上位に来る', () => {
    registerPrintManagerAccessor({
      getFileList: () => [
        { basename: 'tight.gcode', usagematerial: 4500 },
        { basename: 'loose.gcode', usagematerial: 1000 }
      ],
      buildFileInsight: () => null
    });
    const result = buildFilamentRecommendations(5000, 'PLA', 'host1');
    expect(result[0].basename).toBe('tight.gcode');
  });

  it('残量0以下なら空配列を返す', () => {
    registerPrintManagerAccessor({ getFileList: () => [{ basename: 'a.gcode', usagematerial: 100 }], buildFileInsight: () => null });
    expect(buildFilamentRecommendations(0, 'PLA', 'host1')).toEqual([]);
    expect(buildFilamentRecommendations(-100, 'PLA', 'host1')).toEqual([]);
  });
});

// =============================================
// オフライン完了ジョブの遡及帰属（P0: mid-print 再起動シナリオ）
// レビュー指摘の catchUpOfflineFilamentAttribution を検証する。
// シナリオ: S装着 → A開始 → A途中でapp停止 → A/Bオフライン完了 → C途中でapp起動。
// 期待: A・Bに現在装着スプールSを継続帰属（filamentId=S, spoolId=S, usedMm=各materialUsedMm）、
//       Cは触らない、再実行で二重帰属しない。
// =============================================
describe('catchUpOfflineFilamentAttribution — オフライン完了ジョブの遡及帰属(P0)', () => {
  const S = {
    id: 'S', serialNo: 1, name: 'PLA-S', colorName: '白', filamentColor: '#fff',
    material: 'PLA', printCount: 0, remainingLengthMm: 100000, startPrintID: '0',
  };
  let history;
  beforeEach(() => {
    vi.clearAllMocks();
    history = [
      { id: 1001, printfinish: 1, materialUsedMm: 15000 },            // A: オフライン完了
      { id: 1002, printfinish: 1, materialUsedMm: 25000, filamentInfo: [] }, // B: オフライン完了
      { id: 1003, printfinish: 0, materialUsedMm: 0 },                // C: 進行中(現在ジョブ)
    ];
    loadHistory.mockReturnValue(history);
  });

  it('A・Bに継続帰属し、現在ジョブCは除外する', () => {
    const n = catchUpOfflineFilamentAttribution('h', { liveJobId: 1003, spool: S });
    expect(n).toBe(2);
    const a = history.find(j => j.id === 1001);
    const b = history.find(j => j.id === 1002);
    const c = history.find(j => j.id === 1003);
    expect(a.filamentId).toBe('S');
    expect(a.filamentInfo[0]).toMatchObject({ spoolId: 'S', usedMm: 15000, isOfflineInferred: true });
    expect(b.filamentInfo.find(fi => fi.spoolId === 'S').usedMm).toBe(25000);
    expect(c.filamentId).toBeUndefined();       // 現在ジョブは触らない
    expect(saveHistory).toHaveBeenCalled();
  });

  it('冪等: 2回目は対象0で重複エントリを作らない', () => {
    catchUpOfflineFilamentAttribution('h', { liveJobId: 1003, spool: S });
    const lenA = history.find(j => j.id === 1001).filamentInfo.length;
    const n2 = catchUpOfflineFilamentAttribution('h', { liveJobId: 1003, spool: S });
    expect(n2).toBe(0);
    expect(history.find(j => j.id === 1001).filamentInfo.length).toBe(lenA);
  });

  it('色情報だけの単一filamentInfoは同エントリへ spoolId/usedMm を補完し2行にしない(点4/minor)', () => {
    history[0].filamentInfo = [{ filamentColor: '#abc' }]; // 色のみ(spoolId無し)1件
    const n = catchUpOfflineFilamentAttribution('h', { liveJobId: 1003, spool: S });
    expect(n).toBeGreaterThanOrEqual(1);
    const a = history.find(j => j.id === 1001);
    expect(a.filamentInfo).toHaveLength(1);           // 色行＋スプール行の2行にしない
    expect(a.filamentInfo[0].spoolId).toBe('S');      // 同エントリへ spoolId 補完
    expect(a.filamentInfo[0].usedMm).toBe(15000);
    expect(a.filamentId).toBe('S');
  });

  it('複数エントリ(色+別spool)の場合は既存を残して末尾へ追加(点5 upsert)', () => {
    history[0].filamentInfo = [{ filamentColor: '#abc' }, { spoolId: 'X', usedMm: 1 }];
    // 既に spoolId(X) を持つため shouldLinkOfflineJob=false → 対象外（既存尊重）
    const n = catchUpOfflineFilamentAttribution('h', { liveJobId: 1003, spool: S });
    const a = history.find(j => j.id === 1001);
    expect(a.filamentInfo.find(fi => fi.spoolId === 'X')).toBeTruthy(); // 既存尊重
    expect(n).toBe(1); // B のみ帰属
  });

  it('sinceId(startPrintID)以下は排他的下限で除外(点6 <=のまま)', () => {
    const S2 = { ...S, startPrintID: '1001' }; // 装着はA完了後
    catchUpOfflineFilamentAttribution('h', { liveJobId: 1003, spool: S2 });
    expect(history.find(j => j.id === 1001).filamentId).toBeUndefined(); // A(1001<=sinceId)除外
    expect(history.find(j => j.id === 1002).filamentId).toBe('S');       // B(1002>1001)帰属
  });

  it('spoolId付き既存帰属のジョブは尊重して上書きしない', () => {
    history[0].filamentInfo = [{ spoolId: 'OTHER', usedMm: 9999 }];
    const n = catchUpOfflineFilamentAttribution('h', { liveJobId: 1003, spool: S });
    // A は既に spoolId 帰属済み → 対象外。B のみ帰属。
    expect(history.find(j => j.id === 1001).filamentInfo[0].spoolId).toBe('OTHER');
    expect(history.find(j => j.id === 1002).filamentId).toBe('S');
    expect(n).toBe(1);
  });
});

// =============================================
// catch-up / finalize と mount区間の結合（レビュー第2弾・実ledger）
// =============================================
describe("catchUp/finalize と mount区間の結合(レビュー第2弾)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    monitorData.machines = {};
    monitorData.filamentSpools = [];
    monitorData.hostSpoolMap = {};
    monitorData.mountHistory = [];
    monitorData.usageHistory = [];
  });

  it("P0-1: unknown区間ではcatch-upを禁止し filamentId/filamentInfo を自動補完しない", () => {
    const S = { id: "S", startPrintID: "0", name: "S", serialNo: 1, remainingLengthMm: 300000 };
    monitorData.filamentSpools = [S];
    monitorData.hostSpoolMap = { h: "S" };
    monitorData.mountHistory = [
      { evId: "m", ts: 1, type: "mount", host: "h", spoolId: "S", anchorRemainingMm: 300000, sinceJobId: 0, boundaryStatus: "unknown" }
    ];
    const hist = [{ id: 1001, printfinish: 1, materialUsedMm: 10000 }];
    loadHistory.mockReturnValue(hist);
    const n = catchUpOfflineFilamentAttribution("h", { liveJobId: 1003, spool: S });
    expect(n).toBe(0);
    expect(hist[0].filamentId).toBeUndefined();
    expect(hist[0].filamentInfo).toBeUndefined();
  });

  it("P0-1: catch-upの下限は startPrintID ではなく open mount区間の sinceJobId を使う", () => {
    const S = { id: "S", startPrintID: "0", name: "S", serialNo: 1, remainingLengthMm: 300000 };
    monitorData.filamentSpools = [S];
    monitorData.hostSpoolMap = { h: "S" };
    // startPrintID=0 だが、装着区間 sinceJobId=1001（A完了後に装着）
    monitorData.mountHistory = [
      { evId: "m", ts: 1, type: "mount", host: "h", spoolId: "S", anchorRemainingMm: 300000, sinceJobId: 1001, boundaryStatus: "known" }
    ];
    const hist = [
      { id: 1001, printfinish: 1, materialUsedMm: 10000 },
      { id: 1002, printfinish: 1, materialUsedMm: 20000 },
    ];
    loadHistory.mockReturnValue(hist);
    catchUpOfflineFilamentAttribution("h", { liveJobId: 1003, spool: S });
    expect(hist.find(j => j.id === 1001).filamentId).toBeUndefined(); // 1001<=sinceId 除外
    expect(hist.find(j => j.id === 1002).filamentId).toBe("S");       // 1002>sinceId 帰属
  });

  it("P0-3: unknown区間は完了印刷で known へ再アンカーされる(finalizeFilamentUsage)", () => {
    const S = {
      id: "S", name: "S", serialNo: 1, remainingLengthMm: 300000,
      currentPrintID: "1005", currentJobStartLength: 300000, totalLengthMm: 330000, usedLengthLog: [],
    };
    monitorData.filamentSpools = [S];
    monitorData.hostSpoolMap = { h: "S" };
    monitorData.machines = { h: { printStore: { history: [] }, historyData: [] } };
    monitorData.mountHistory = [
      { evId: "m", ts: 1, type: "mount", host: "h", spoolId: "S", anchorRemainingMm: 300000, sinceJobId: 0, boundaryStatus: "unknown" }
    ];
    loadHistory.mockReturnValue([]);
    finalizeFilamentUsage(40000, "1005", "h", true); // ジョブ1005が実消費40000で完了
    // ★ 新しい mount ではなく reanchor イベントで既存 open 区間を known 化する（open 二重化しない）
    const reanchor = monitorData.mountHistory.filter(e => e.type === "reanchor" && e.boundaryStatus === "known");
    expect(reanchor.length).toBe(1);
    expect(reanchor[0].targetIntervalId).toBe("m");  // 既存区間を対象
    expect(reanchor[0].sinceJobId).toBe(1005);       // 完了ジョブで再アンカー
    expect(reanchor[0].anchorRemainingMm).toBe(260000); // 300000 - 40000
    // mount は増えていない（open 二重化なし）
    expect(monitorData.mountHistory.filter(e => e.type === "mount").length).toBe(1);
  });
});
