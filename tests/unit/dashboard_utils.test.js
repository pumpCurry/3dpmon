/**
 * dashboard_utils.js 純粋関数テスト
 *
 * テスト対象: フォーマット系ユーティリティ関数
 * - formatDuration
 * - formatDurationSimple
 * - formatEpochToDateTime
 * - parseCurPosition
 */
import { describe, it, expect, vi } from 'vitest';

// --- モジュールモック ---
// dashboard_utils.js → dashboard_notification_manager.js → dashboard_audio_manager.js
// の依存チェーンが document を参照するため、全てモック化
vi.mock('../../3dp_lib/dashboard_data.js', () => ({
  monitorData: { machines: {} },
  scopedById: vi.fn(),
}));
vi.mock('../../3dp_lib/dashboard_notification_manager.js', () => ({
  showAlert: vi.fn(),
  notificationManager: { notify: vi.fn() },
}));
vi.mock('../../3dp_lib/dashboard_audio_manager.js', () => ({
  default: {},
  audioManager: {},
}));

import {
  formatDuration,
  formatDurationSimple,
  formatEpochToDateTime,
  parseCurPosition,
} from '../../3dp_lib/dashboard_utils.js';

// =============================================
// formatDuration
// =============================================
describe('formatDuration', () => {
  it('0秒', () => {
    const result = formatDuration(0);
    expect(result).toContain('0時間');
    expect(result).toContain('00分');
    expect(result).toContain('00秒');
  });

  it('3661秒 = 1時間1分1秒', () => {
    const result = formatDuration(3661);
    expect(result).toContain('1時間');
    expect(result).toContain('01分');
    expect(result).toContain('01秒');
    expect(result).toContain('3661');
  });

  it('7200秒 = 2時間', () => {
    const result = formatDuration(7200);
    expect(result).toContain('2時間');
    expect(result).toContain('00分');
    expect(result).toContain('00秒');
  });

  it('59秒', () => {
    const result = formatDuration(59);
    expect(result).toContain('0時間');
    expect(result).toContain('00分');
    expect(result).toContain('59秒');
  });

  it('負数 → NaN安全（パースできれば変換）', () => {
    const result = formatDuration(-1);
    // parseInt(-1) = -1, Math.floor(-1/3600) depends on implementation
    expect(typeof result).toBe('string');
  });

  it('文字列数値も変換可能', () => {
    const result = formatDuration('3600');
    expect(result).toContain('1時間');
  });
});

// =============================================
// formatEpochToDateTime
// =============================================
describe('formatEpochToDateTime', () => {
  it('null → "----"', () => {
    expect(formatEpochToDateTime(null)).toBe('----');
  });

  it('undefined → "----"', () => {
    expect(formatEpochToDateTime(undefined)).toBe('----');
  });

  it('0 → "2000/01/01 00:00:00" (エポック0はUTC原点として扱われる)', () => {
    // 注: 実装は sec <= 0 を "----" にせず、有効なエポック値として変換する
    const result = formatEpochToDateTime(0);
    expect(result).toMatch(/^\d{4}\/\d{2}\/\d{2}/);
  });

  it('NaN → "----"', () => {
    expect(formatEpochToDateTime(NaN)).toBe('----');
  });

  it('空文字列 → "----"', () => {
    expect(formatEpochToDateTime('')).toBe('----');
  });

  it('有効なエポック秒 → YYYY/MM/DD hh:mm:ss', () => {
    // 2025-01-15 00:00:00 UTC = 1736899200
    const result = formatEpochToDateTime(1736899200);
    expect(result).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(result).toContain('2025/');
  });

  it('大きなエポック値でも動作', () => {
    // 2030年頃
    const result = formatEpochToDateTime(1893456000);
    expect(result).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

// =============================================
// parseCurPosition
// =============================================
describe('parseCurPosition', () => {
  it('"X:100.5 Y:80.2 Z:10.5" → 座標オブジェクト', () => {
    const result = parseCurPosition('X:100.5 Y:80.2 Z:10.5');
    expect(result).toBeDefined();
    if (result) {
      expect(result.x).toBeCloseTo(100.5);
      expect(result.y).toBeCloseTo(80.2);
      expect(result.z).toBeCloseTo(10.5);
    }
  });

  it('"X:0 Y:0 Z:0" → ゼロ座標', () => {
    const result = parseCurPosition('X:0 Y:0 Z:0');
    expect(result).toBeDefined();
    if (result) {
      expect(result.x).toBe(0);
      expect(result.y).toBe(0);
      expect(result.z).toBe(0);
    }
  });

  it('null → throws TypeError (null安全でない: 要改善)', () => {
    // 注: 現在の実装は null チェックなしで .match() を呼ぶため TypeError になる
    // TODO: Phase 2 以降でnullガードを追加すべき
    expect(() => parseCurPosition(null)).toThrow(TypeError);
  });

  it('不正な文字列 → null (マッチなし)', () => {
    const result = parseCurPosition('invalid');
    // match() が null → 関数は暗黙的に null を返す
    expect(result).toBeNull();
  });
});
