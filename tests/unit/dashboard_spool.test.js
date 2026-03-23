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
}));
vi.mock('../../3dp_lib/dashboard_connection.js', () => ({
  getDeviceIp: vi.fn(),
  getHttpPort: vi.fn(),
}));

import {
  SPOOL_STATE,
  MATERIAL_DENSITY,
  getSpoolState,
  getSpoolStateLabel,
  formatSpoolDisplayId,
  formatFilamentAmount,
  weightFromLength,
  lengthFromWeight,
  getMaterialDensity,
} from '../../3dp_lib/dashboard_spool.js';

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

  it('未知素材 → PLA密度にフォールバック', () => {
    expect(getMaterialDensity('Nylon')).toBe(1.24);
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
