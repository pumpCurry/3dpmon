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
    usageHistory: [],
    mountHistory: [],
    mountHistorySeq: 0,
    filamentEventContext: {},
    hostSpoolMap: {},
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
  SPOOL_BALANCE_STATE,
  MATERIAL_DENSITY,
  getSpoolState,
  getSpoolStateLabel,
  getSpoolBalanceState,
  getSpoolBalanceStateLabel,
  formatSpoolDisplayId,
  formatFilamentAmount,
  formatRemainingFilamentAmount,
  displayRemainingLengthMm,
  getNegativeRemainingDisplayMode,
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
  getAttributionPresentation,
  getAttributionIssueIdsForHost,
  countAttributionIssuesForHost,
  updateSpool,
  addSpool,
  deleteSpool,
  setCurrentSpoolId,
  getSpoolMountedLocationLabels,
} from '../../3dp_lib/dashboard_spool.js';
import { monitorData } from '../../3dp_lib/dashboard_data.js';
import { loadHistory, saveHistory } from '../../3dp_lib/dashboard_printmanager.js';

const {
  buildInferredLedgerReconciliationReport
} = await import('../../3dp_lib/dashboard_inferred_reconciliation.js');
const {
  createSpoolMountRecord,
  SPOOL_MOUNT_STATUS,
  SPOOL_MOUNT_VERIFICATION,
  MATERIAL_IDENTITY_STRENGTH,
} = await import('../../3dp_lib/printer_core/dashboard_material_accounting_contract.js');
const {
  reserveUniversalSpoolAssignment,
} = await import('../../3dp_lib/printer_core/dashboard_material_accounting_spool_assignment_guard.js');

// =============================================
// legacy hostSpoolMap と Universal SpoolMount の排他
// =============================================
describe('legacy hostSpoolMap と Universal SpoolMount の排他', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    monitorData.machines = {};
    monitorData.filamentSpools = [
      { id: 'S1', name: 'Spool 1', remainingLengthMm: 300000, totalLengthMm: 330000 },
    ];
    monitorData.usageHistory = [];
    monitorData.mountHistory = [];
    monitorData.mountHistorySeq = 0;
    monitorData.filamentEventContext = {};
    monitorData.hostSpoolMap = {};
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
  });

  it('Universal OPEN mount済みspoolはlegacy setCurrentSpoolIdで二重装着しない', () => {
    monitorData.materialAccountingSpoolMountStore.spoolMounts = [{
      ...createSpoolMountRecord({
        mountId: 'mount:k2:1a:S1',
        materialSourceId: 'source:k2:cfs:1a',
        spoolId: 'S1',
        status: SPOOL_MOUNT_STATUS.OPEN,
        openedAt: '2026-09-01T04:00:00.000Z',
        mountOperationId: 'operation:k2:1a:S1',
        verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
        sourceIdentityStrengthAtOpen: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
      }),
    }];

    const ok = setCurrentSpoolId('S1', 'K1Max-4A1B');

    expect(ok).toBe(false);
    expect(monitorData.hostSpoolMap).toEqual({});
  });

  it('Universal CLOSED mount履歴だけならlegacy setCurrentSpoolIdを妨げない', () => {
    monitorData.materialAccountingSpoolMountStore.spoolMounts = [{
      ...createSpoolMountRecord({
        mountId: 'mount:k2:closed:S1',
        materialSourceId: 'source:k2:cfs:1a',
        spoolId: 'S1',
        status: SPOOL_MOUNT_STATUS.CLOSED,
        openedAt: '2026-09-01T03:00:00.000Z',
        closedAt: '2026-09-01T03:30:00.000Z',
        mountOperationId: 'operation:k2:1a:S1',
        closeOperationId: 'operation:k2:1a:S1:close',
        verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
        sourceIdentityStrengthAtOpen: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
      }),
    }];

    const ok = setCurrentSpoolId('S1', 'K1Max-4A1B');

    expect(ok).toBe(true);
    expect(monitorData.hostSpoolMap).toEqual({ 'K1Max-4A1B': 'S1' });
  });

  it('Universal OPEN mount済みspoolはdeleteSpoolで廃棄しない', () => {
    monitorData.materialAccountingSpoolMountStore.spoolMounts = [createSpoolMountRecord({
      mountId: 'mount:k2:1a:S1',
      materialSourceId: 'source:k2:cfs:1a',
      spoolId: 'S1',
      status: SPOOL_MOUNT_STATUS.OPEN,
      openedAt: '2026-09-01T04:00:00.000Z',
      mountOperationId: 'operation:k2:1a:S1',
      verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
      sourceIdentityStrengthAtOpen: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
    })];

    deleteSpool('S1');

    expect(monitorData.filamentSpools[0].deleted).toBeFalsy();
    expect(monitorData.filamentSpools[0].isDeleted).toBeFalsy();
  });

  it('Universal reservation中のspoolはdeleteSpoolで廃棄しない', () => {
    const reservation = reserveUniversalSpoolAssignment({
      spoolId: 'S1',
      ownerId: 'operation:k2:pending',
      materialSourceId: 'source:k2:cfs:1a',
    });
    expect(reservation.ok).toBe(true);

    try {
      deleteSpool('S1');
    } finally {
      reservation.release();
    }

    expect(monitorData.filamentSpools[0].deleted).toBeFalsy();
    expect(monitorData.filamentSpools[0].isDeleted).toBeFalsy();
  });
});

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

  it('Universal OPEN mount中のスプールは装着中として扱う', () => {
    monitorData.machines = {
      'K2Pro-69E7': {
        storedData: { hostname: { rawValue: 'K2Pro-69E7' } },
        runtimeData: {
          printerCoreV3Shadow: {
            deviceId: 'serial:k2pro-69e7',
          },
        },
      },
    };
    monitorData.materialAccountingSpoolMountStore.spoolMounts = [{
      ...createSpoolMountRecord({
        mountId: 'mount:k2:1a:S1',
        materialSourceId: 'cfs:1:slot:0',
        spoolId: 'S1',
        status: SPOOL_MOUNT_STATUS.OPEN,
        openedAt: '2026-09-01T04:00:00.000Z',
        mountOperationId: 'operation:k2:1a:S1',
        verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
        sourceIdentityStrengthAtOpen: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
      }),
      sourceBindingAtOpen: {
        deviceId: 'serial:k2pro-69e7',
        materialSourceId: 'cfs:1:slot:0',
        locator: { kind: 'cfs-slot', boxId: 1, slotIndex: 0, protocolSlotId: '1A' },
      },
    }];

    expect(getSpoolState({ id: 'S1', remainingLengthMm: 300000 })).toBe(SPOOL_STATE.MOUNTED);
    expect(getSpoolMountedLocationLabels({ id: 'S1' })).toEqual(['K2Pro-69E7 / 1A']);
  });

  it('負残量でも装着中ライフサイクル状態は MOUNTED のまま保持する', () => {
    expect(getSpoolState({ isActive: true, remainingLengthMm: -1 })).toBe(SPOOL_STATE.MOUNTED);
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

describe('getSpoolBalanceState / getSpoolBalanceStateLabel', () => {
  it('signed remaining の残量状態をライフサイクルとは別軸で返す', () => {
    expect(getSpoolBalanceState({ isActive: true, remainingLengthMm: -300 })).toBe(SPOOL_BALANCE_STATE.OVERDRAWN);
    expect(getSpoolBalanceState({ remainingLengthMm: 0 })).toBe(SPOOL_BALANCE_STATE.ZERO);
    expect(getSpoolBalanceState({ remainingLengthMm: 1 })).toBe(SPOOL_BALANCE_STATE.POSITIVE);
    expect(getSpoolBalanceState({ remainingLengthMm: null })).toBe(SPOOL_BALANCE_STATE.UNKNOWN);
  });

  it('残量状態ラベルを返す', () => {
    expect(getSpoolBalanceStateLabel(SPOOL_BALANCE_STATE.OVERDRAWN)).toBe('超過使用');
    expect(getSpoolBalanceStateLabel(SPOOL_BALANCE_STATE.ZERO)).toBe('残量0');
    expect(getSpoolBalanceStateLabel(SPOOL_BALANCE_STATE.POSITIVE)).toBe('残量あり');
    expect(getSpoolBalanceStateLabel(SPOOL_BALANCE_STATE.UNKNOWN)).toBe('残量不明');
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

  it('負残量は既定でマイナス表示を保持する', () => {
    monitorData.appSettings = { negativeRemainingDisplayMode: 'show' };
    const result = formatRemainingFilamentAmount(-2500);

    expect(getNegativeRemainingDisplayMode()).toBe('show-negative');
    expect(displayRemainingLengthMm(-2500)).toBe(-2500);
    expect(result.rawMm).toBe(-2500);
    expect(result.mm).toBe(-2500);
    expect(result.display).toContain('-2.5m');
    expect(result.isDisplayClamped).toBe(false);
  });

  it('負残量の0クロップ設定は表示値だけを丸める', () => {
    monitorData.appSettings = { negativeRemainingDisplayMode: 'clamp-zero' };
    const result = formatRemainingFilamentAmount(-2500);

    expect(getNegativeRemainingDisplayMode()).toBe('clamp-zero');
    expect(displayRemainingLengthMm(-2500)).toBe(0);
    expect(result.rawMm).toBe(-2500);
    expect(result.mm).toBe(0);
    expect(result.display).toContain('0.0m');
    expect(result.isDisplayClamped).toBe(true);
  });

  it('負残量表示モードは提案仕様名と旧値を show-negative へ正規化する', () => {
    expect(getNegativeRemainingDisplayMode({ negativeRemainingDisplay: 'show-negative' })).toBe('show-negative');
    expect(getNegativeRemainingDisplayMode({ negativeRemainingDisplayMode: 'show' })).toBe('show-negative');
    expect(getNegativeRemainingDisplayMode({ filamentRemainingDisplayMode: 'signed' })).toBe('show-negative');
    expect(getNegativeRemainingDisplayMode({ filamentRemainingDisplayMode: 'clamp-zero' })).toBe('clamp-zero');
  });
});

describe('updateSpool — signed remaining manual baseline', () => {
  beforeEach(() => {
    monitorData.filamentSpools = [];
    monitorData.usageHistory = [];
    monitorData.usageHistoryRev = 0;
    monitorData.hostSpoolMap = {};
  });

  it('手動残量補正は負値からの復帰も監査し、O7 baseline を補正位置へ更新する', () => {
    monitorData.filamentSpools.push({
      id: 'S-manual',
      serialNo: 'SER-1',
      hostname: 'k1',
      remainingLengthMm: -2350,
      usedLengthLog: [{ jobId: 'before-remount', used: 1000 }],
    });

    updateSpool('S-manual', {
      expectedRemainingLengthMm: -2350,
      remainingLengthMm: 420,
      remainingAdjustmentReason: 'weighed-spool',
      remainingAdjustmentActor: 'operator',
    });

    const spool = monitorData.filamentSpools[0];
    expect(spool.remainingLengthMm).toBe(420);
    expect(monitorData.usageHistory).toHaveLength(1);
    expect(monitorData.usageHistory[0]).toMatchObject({
      type: 'manual-remaining-adjustment',
      spoolId: 'S-manual',
      beforeMm: -2350,
      afterMm: 420,
      deltaMm: 2770,
      reason: 'weighed-spool',
      actor: 'operator',
    });
    expect(monitorData.usageHistoryRev).toBe(1);
    expect(spool.remainingLedgerBaseline).toMatchObject({
      remainingLengthMm: 420,
      usedLengthLogIndex: 1,
      source: 'manual-remaining-adjustment',
      eventId: monitorData.usageHistory[0].usageId,
    });
  });
});

describe('addSpool — O7 remaining baseline', () => {
  beforeEach(() => {
    monitorData.filamentSpools = [];
    monitorData.spoolSerialCounter = 0;
  });

  it('新規スプール作成時に signed 残量照合 baseline を初期化する', () => {
    const spool = addSpool({
      name: 'Baseline spool',
      totalLengthMm: 10000,
      remainingLengthMm: 10000,
      usedLengthLog: [],
    });

    expect(spool.remainingLedgerBaseline).toMatchObject({
      remainingLengthMm: 10000,
      usedLengthLogIndex: 0,
      source: 'spool-created',
    });
    expect(Number.isFinite(spool.remainingLedgerBaseline.createdAt)).toBe(true);
  });

  it('addSpool 作成baseline以降の通常使用量を O7 が ok として照合する', () => {
    const spool = addSpool({
      name: 'O7 baseline spool',
      totalLengthMm: 10000,
      remainingLengthMm: 10000,
      usedLengthLog: [],
    });
    spool.usedLengthLog.push({ jobId: 'job-1', used: 500 });
    spool.remainingLengthMm = 9500;

    const report = buildInferredLedgerReconciliationReport({ nowMs: 9000 });

    expect(report.remainingBalanceOkCount).toBe(1);
    expect(report.remainingBalanceUnverifiableCount).toBe(0);
    expect(report.remainingBalances[0]).toMatchObject({
      spoolId: spool.id,
      baselineRemainingMm: 10000,
      usedLengthLogStartIndex: 0,
      netUsedMm: 500,
      expectedRemainingMm: 9500,
      remainingLengthMm: 9500,
      status: 'ok',
    });
    expect(report.issues).not.toContainEqual(expect.objectContaining({
      reason: 'remaining_baseline_boundary_unknown',
      spoolId: spool.id,
    }));
  });

  it('明示済み baseline がある場合は上書きせず保持する', () => {
    const existingBaseline = {
      remainingLengthMm: -500,
      usedLengthLogIndex: 2,
      createdAt: 111,
      source: 'imported-baseline',
    };

    const spool = addSpool({
      name: 'Imported baseline spool',
      remainingLengthMm: -500,
      remainingLedgerBaseline: existingBaseline,
    });

    expect(spool.remainingLedgerBaseline).toEqual(existingBaseline);
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
    monitorData.pendingUnattributedUsageArchive = {};
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

  it('P0-3: 有効な進行中ジョブへの無効ID完了通知は無視し、現在ジョブ追跡を維持する', () => {
    // アクティブジョブ 1001 が進行中に、偽の jobId=0 完了通知が来ても、受信側が低信頼なので
    // 現在ジョブ追跡を壊さず単に無視する（隔離もしない）。stale クリアは有効ID同士の不一致時のみ。
    monitorData.filamentSpools[0].currentPrintID = '1001';
    finalizeFilamentUsage(5000, 0, 'h', true);
    const sp = monitorData.filamentSpools[0];
    expect(monitorData.pendingUnattributedUsage).toHaveLength(0); // 隔離しない
    expect(sp.remainingLengthMm).toBe(100000);      // 減算なし
    expect(sp.currentPrintID).toBe('1001');          // ★ 現在ジョブを維持（クリアしない）
    expect(sp.currentJobStartLength).toBe(100000);   // 開始基準も維持
  });

  it('P0-3: 有効ID同士の不一致（別ジョブ完了）では従来どおり stale transient をクリア', () => {
    monitorData.filamentSpools[0].currentPrintID = '1001';
    finalizeFilamentUsage(5000, 2002, 'h', true); // 有効な別ID
    const sp = monitorData.filamentSpools[0];
    expect(sp.currentPrintID).toBe('');              // 不一致で transient クリア
  });

  it('RR-1: completionOpId で冪等（同一IDは1件／別IDは同一payloadでも別レコード）', () => {
    finalizeFilamentUsage(5000, 0, 'h', true, { completionOpId: 'h:completion:1' });
    // 同一 completionOpId の再送 → 増えない（未確認件数を水増ししない）
    monitorData.filamentSpools[0].currentJobStartLength = 100000;
    monitorData.filamentSpools[0].currentPrintID = '';
    finalizeFilamentUsage(5000, 0, 'h', true, { completionOpId: 'h:completion:1' });
    expect(monitorData.pendingUnattributedUsage).toHaveLength(1);
    // ★ 別の印刷(別 completionOpId)は「同一 payload」でも別レコード（payload衝突で捨てない）
    monitorData.filamentSpools[0].currentJobStartLength = 100000;
    monitorData.filamentSpools[0].currentPrintID = '';
    finalizeFilamentUsage(5000, 0, 'h', true, { completionOpId: 'h:completion:2' });
    expect(monitorData.pendingUnattributedUsage).toHaveLength(2);
    expect(monitorData.pendingUnattributedUsage[0].completionOpId).toBe('h:completion:1');
    expect(monitorData.pendingUnattributedUsage[1].completionOpId).toBe('h:completion:2');
  });

  it('RR-1: completionOpId 無しは短い再送窓のみ抑制（窓外の同一payloadは別登録）', () => {
    finalizeFilamentUsage(5000, 0, 'h', true); // opId 無し
    expect(monitorData.pendingUnattributedUsage).toHaveLength(1);
    // 直近（窓内）の同一 payload 再送 → 抑制
    monitorData.filamentSpools[0].currentJobStartLength = 100000;
    monitorData.filamentSpools[0].currentPrintID = '';
    finalizeFilamentUsage(5000, 0, 'h', true);
    expect(monitorData.pendingUnattributedUsage).toHaveLength(1);
    // 窓外（detectedAtEpochMs を過去へ）にすると別の正当消費として登録される
    monitorData.pendingUnattributedUsage[0].detectedAtEpochMs = 1; // 遥か過去
    monitorData.filamentSpools[0].currentJobStartLength = 100000;
    monitorData.filamentSpools[0].currentPrintID = '';
    finalizeFilamentUsage(5000, 0, 'h', true);
    expect(monitorData.pendingUnattributedUsage).toHaveLength(2);
  });

  it('P1-2: 実測は usedMm/confirmed、見積りフォールバックは estimatedUsedMm/estimated に分離', () => {
    // used=5000 実測
    finalizeFilamentUsage(5000, 0, 'h', true);
    const meas = monitorData.pendingUnattributedUsage[0];
    expect(meas.usedSource).toBe('measured');
    expect(meas.confidence).toBe('confirmed');
    expect(meas.usedMm).toBe(5000);
    expect(meas.estimatedUsedMm).toBe(0);
    // used=0 だが expected=5000 → フォールバック（見積り）
    monitorData.pendingUnattributedUsage = [];
    monitorData.filamentSpools[0].currentJobStartLength = 100000;
    monitorData.filamentSpools[0].currentJobExpectedLength = 5000;
    monitorData.filamentSpools[0].currentPrintID = '';
    finalizeFilamentUsage(0, 0, 'h', true);
    const est = monitorData.pendingUnattributedUsage[0];
    expect(est.usedSource).toBe('expected-fallback');
    expect(est.confidence).toBe('estimated');
    expect(est.usedMm).toBe(0);            // 予定値を実消費にしない
    expect(est.estimatedUsedMm).toBe(5000);
  });

  it('P0-2: 上限超過分は黙って捨てず per-host アーカイブへ集約（総量・件数保持）', () => {
    monitorData.pendingUnattributedUsageArchive = {};
    for (let i = 1; i <= 210; i++) {
      monitorData.filamentSpools[0].currentJobStartLength = 100000;
      monitorData.filamentSpools[0].currentJobExpectedLength = 5000;
      monitorData.filamentSpools[0].currentPrintID = '';
      finalizeFilamentUsage(i, 0, 'h', true); // used=i で distinct fingerprint
    }
    expect(monitorData.pendingUnattributedUsage.length).toBe(200); // 詳細は最新200
    const arch = monitorData.pendingUnattributedUsageArchive.h;
    expect(arch.count).toBe(10);                       // 溢れた古い10件は集約（捨てない）
    expect(arch.totalUsedMm).toBe(55);                 // used 1..10 の合計
    expect(countAttributionIssuesForHost('h')).toBe(210); // バッジ=詳細200＋アーカイブ10
  });

  it('P1-3: 隔離追加で attribution-changed イベントを発火（冪等dupでは発火しない）', () => {
    const disp = vi.fn();
    const origWin = globalThis.window;
    const origCE = globalThis.CustomEvent;
    globalThis.window = { dispatchEvent: disp };
    globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
    try {
      finalizeFilamentUsage(5000, 0, 'h', true);
      expect(disp).toHaveBeenCalledTimes(1);
      expect(disp.mock.calls[0][0].type).toBe('3dpmon:attribution-changed');
      expect(disp.mock.calls[0][0].detail.host).toBe('h');
      // 同一完了の再送 → 冪等 skip → イベント発火しない
      monitorData.filamentSpools[0].currentJobStartLength = 100000;
      monitorData.filamentSpools[0].currentPrintID = '';
      finalizeFilamentUsage(5000, 0, 'h', true);
      expect(disp).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.window = origWin;
      globalThis.CustomEvent = origCE;
    }
  });

  it('U4連携: 無効ID隔離→pendingUsageId付与→getAttributionIssueIdsForHostに出現（実コード経路）', () => {
    finalizeFilamentUsage(5000, 0, 'h', true);
    const q = monitorData.pendingUnattributedUsage[0];
    expect(typeof q.pendingUsageId).toBe('string');
    expect(q.pendingUsageId.length).toBeGreaterThan(0);
    // 実際の隔離レコードが U1 セレクタの課題ID集合へ安定キーで現れる
    const ids = getAttributionIssueIdsForHost('h');
    expect(ids.has(`quarantine:h:${q.pendingUsageId}`)).toBe(true);
    expect(countAttributionIssuesForHost('h')).toBe(1);
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
    expect(isAttributionPending({ id: 1, materialUsedMm: 5000, printfinish: 1 })).toBe(true);
    expect(isAttributionPending({ id: 1, materialUsedMm: 5000, printfinish: 0, filamentInfo: [{ colorName: '黒' }] })).toBe(true);
  });

  it('確定スプール（spoolId）or filamentId があれば pending でない', () => {
    expect(isAttributionPending({ id: 1, materialUsedMm: 5000, printfinish: 1, filamentInfo: [{ spoolId: 'sp1' }] })).toBe(false);
    expect(isAttributionPending({ id: 1, materialUsedMm: 5000, printfinish: 1, filamentId: 'sp1' })).toBe(false);
  });

  it('消費なし（materialUsedMm<=0/欠落）は pending でない', () => {
    expect(isAttributionPending({ id: 1, materialUsedMm: 0, printfinish: 1 })).toBe(false);
    expect(isAttributionPending({ id: 1, printfinish: 1 })).toBe(false);
    expect(isAttributionPending(null)).toBe(false);
  });

  it('P1-5: 印刷中/未確定（printfinish=null かつ完了証拠なし）は消費ありでも pending でない', () => {
    expect(isAttributionPending({ id: 1, materialUsedMm: 5000, printfinish: null })).toBe(false);
    expect(isAttributionPending({ id: 1, materialUsedMm: 5000 })).toBe(false); // printfinish 欠落=未確定
  });

  it('#410-8: 旧保存データ(printfinish欠落だが finishTime/endtime あり)は完了扱いで pending 判定', () => {
    // printfinish が無くても完了証拠（finishTime/endtime/usagetime）があれば完了→未帰属なら pending
    expect(isAttributionPending({ id: 1, materialUsedMm: 5000, finishTime: 1784000000 })).toBe(true);
    expect(isAttributionPending({ id: 1, materialUsedMm: 5000, endtime: 1784000000 })).toBe(true);
    expect(isAttributionPending({ id: 1, materialUsedMm: 5000, usagetime: 3600 })).toBe(true);
    // 完了証拠が一切なければ非完了
    expect(isAttributionPending({ id: 1, materialUsedMm: 5000, finishTime: 0, endtime: 0 })).toBe(false);
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
// 帰属表示セレクタ（Phase5 U1）
// =============================================
describe('getAttributionPresentation / getAttributionIssueIdsForHost（Phase5 U1）', () => {
  beforeEach(() => {
    monitorData.machines = {};
    monitorData.pendingUnattributedUsage = [];
  });

  it('pending ジョブは state=pending / label=未確認 / severity=warning', () => {
    const p = getAttributionPresentation({ id: 1, materialUsedMm: 5000, printfinish: 1 });
    expect(p).toEqual({ state: 'pending', label: '未確認', reason: 'unattributed', severity: 'warning' });
  });

  it('確定ジョブ（spoolId あり）は state=known / label なし / severity=none', () => {
    const p = getAttributionPresentation({ id: 1, materialUsedMm: 5000, printfinish: 1, filamentInfo: [{ spoolId: 'sp1' }] });
    expect(p).toEqual({ state: 'known', label: null, reason: null, severity: 'none' });
  });

  it('課題ID集合は履歴pendingと隔離消費を安定キーで統合する', () => {
    monitorData.machines = {
      h1: { printStore: { history: [
        { id: 100, materialUsedMm: 5000, printfinish: 1 },      // pending（完了・未帰属）
        { id: 101, materialUsedMm: 5000, printfinish: 1, filamentInfo: [{ spoolId: 'sp1' }] }, // 確定
        { id: 102, materialUsedMm: 0, printfinish: 1 },          // 消費なし→対象外
        { id: 103, materialUsedMm: 5000, printfinish: null },    // 印刷中→対象外（P1-5）
      ] } },
    };
    monitorData.pendingUnattributedUsage = [
      { pendingUsageId: 'q-abc', host: 'h1', usedMm: 100 },
      { pendingUsageId: 'q-def', host: 'h2', usedMm: 200 },   // 別ホスト
    ];
    const ids = getAttributionIssueIdsForHost('h1');
    expect(ids).toEqual(new Set(['pending:h1:100', 'quarantine:h1:q-abc']));
    expect(countAttributionIssuesForHost('h1')).toBe(2);
    expect(countAttributionIssuesForHost('h2')).toBe(1); // 隔離のみ
  });

  it('同一集合は安定（差分判定の基盤＝再計算で増減しない）', () => {
    monitorData.machines = { h1: { printStore: { history: [{ id: 100, materialUsedMm: 5000, printfinish: 1 }] } } };
    const a = getAttributionIssueIdsForHost('h1');
    const b = getAttributionIssueIdsForHost('h1');
    expect([...a].sort()).toEqual([...b].sort());
  });

  it('pendingUsageId 欠落の旧隔離レコードは detectedAtEpochMs で代替キー化', () => {
    monitorData.pendingUnattributedUsage = [{ host: 'h1', usedMm: 100, detectedAtEpochMs: 1784000000000 }];
    const ids = getAttributionIssueIdsForHost('h1');
    expect(ids.has('quarantine:h1:1784000000000')).toBe(true);
  });

  it('host 未指定は空集合', () => {
    expect(getAttributionIssueIdsForHost().size).toBe(0);
    expect(countAttributionIssuesForHost('')).toBe(0);
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

  it("RR-3: 見積りフォールバック(実測なし)では unknown→known へ昇格しない", () => {
    const S = {
      id: "S", name: "S", serialNo: 1, remainingLengthMm: 300000,
      currentPrintID: "1005", currentJobStartLength: 300000, currentJobExpectedLength: 40000,
      totalLengthMm: 330000, usedLengthLog: [],
    };
    monitorData.filamentSpools = [S];
    monitorData.hostSpoolMap = { h: "S" };
    monitorData.machines = { h: { printStore: { history: [] }, historyData: [] } };
    monitorData.mountHistory = [
      { evId: "m", intervalId: "m", ts: 1, type: "mount", host: "h", spoolId: "S", anchorRemainingMm: 300000, sinceJobId: 0, boundaryStatus: "unknown" }
    ];
    loadHistory.mockReturnValue([]);
    finalizeFilamentUsage(0, "1005", "h", true); // 実測0 → 見積り40000へフォールバック
    // 見積り消費では known 昇格しない（後から実測が判明したとき再計算対象外にしない）
    const reanchorKnown = monitorData.mountHistory.filter(e => e.type === "reanchor" && e.boundaryStatus === "known");
    expect(reanchorKnown.length).toBe(0);
  });
});
