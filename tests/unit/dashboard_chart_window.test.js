/**
 * dashboard_chart.js setChartWindowMinutes クランプテスト
 *
 * 温度グラフの保持/表示時間枠（メモリ無制限化の防止）が安全範囲にクランプされ、
 * 不正値は既定15分にフォールバックすることを確認する。
 */
import { describe, it, expect } from 'vitest';
import { setChartWindowMinutes } from '../../3dp_lib/dashboard_chart.js';

describe('setChartWindowMinutes', () => {
  it('通常値はそのまま適用', () => {
    expect(setChartWindowMinutes(30)).toBe(30);
    expect(setChartWindowMinutes(15)).toBe(15);
    expect(setChartWindowMinutes(60)).toBe(60);
  });
  it('小数は四捨五入', () => {
    expect(setChartWindowMinutes(15.7)).toBe(16);
  });
  it('下限未満(1分未満)は既定15分へフォールバック', () => {
    expect(setChartWindowMinutes(0)).toBe(15);
    expect(setChartWindowMinutes(-5)).toBe(15);
  });
  it('上限(720分)を超えたらクランプ', () => {
    expect(setChartWindowMinutes(1000)).toBe(720);
  });
  it('非数値は既定15分', () => {
    expect(setChartWindowMinutes('abc')).toBe(15);
    expect(setChartWindowMinutes(NaN)).toBe(15);
    expect(setChartWindowMinutes(undefined)).toBe(15);
  });
});
