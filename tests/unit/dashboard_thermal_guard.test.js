/**
 * dashboard_thermal_guard.js 純ロジックテスト
 *
 * 検証観点:
 * - 熱フェーズ(加熱=heating/放熱=cooling/安定=stable)と強度・方向
 * - 絶対上限(error)・機器報告 max 優先
 * - 急変化(error) … 連続2サンプル・初回不発・緩慢昇温で不発
 * - 目標乖離(warn)・オーバーシュート(error)・昇温不良(warn)の継続判定
 * - 新規/解除アラートの差分(ワンショット通知・自動復帰)
 * - err(0,0)・fan(0/1ビット)を渡しても温度検知に影響しない
 * - 目標0(待機)で誤発報しない / disabled で全不発 / マルチホスト独立
 *
 * 依存ゼロの純関数のためモック不要。now は引数で与え決定的に検証する。
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_THERMAL_CONFIG,
  createThermalState,
  evaluateThermal,
  thermalArrowGlyph,
  thermalArrowColor,
} from '../../3dp_lib/dashboard_thermal_guard.js';

/** 既定 reading(全温度=室温・目標0・エラー/ファンはダミー) */
function baseReading(over = {}) {
  return {
    nozzleTemp: 25,
    targetNozzleTemp: 0,
    bedTemp0: 25,
    targetBedTemp0: 0,
    boxTemp: 25,
    maxNozzleTemp: 300,
    maxBedTemp: 120,
    // ↓ 検知対象外。渡しても無視されることの確認用
    err: { errcode: 0, key: 0 },
    fan: 0,
    fanAuxiliary: 1,
    fanCase: 0,
    ...over,
  };
}

describe('熱フェーズ判定', () => {
  it('目標より低ければ heating(黄緑)・差で強度が増す', () => {
    const s = createThermalState();
    const r = evaluateThermal(baseReading({ nozzleTemp: 180, targetNozzleTemp: 220 }), s, 1000);
    expect(r.cells.nozzle.phase).toBe('heating');
    expect(r.cells.nozzle.intensity).toBeCloseTo(40 / DEFAULT_THERMAL_CONFIG.colorSpanC, 5);
    expect(r.cells.nozzle.level).toBeNull();
  });

  it('目標到達(帯域内)は stable・強度0', () => {
    const s = createThermalState();
    const r = evaluateThermal(baseReading({ nozzleTemp: 220, targetNozzleTemp: 220 }), s, 1000);
    expect(r.cells.nozzle.phase).toBe('stable');
    expect(r.cells.nozzle.intensity).toBe(0);
  });

  it('目標0で高温なら室温基準で cooling(放熱/水色)', () => {
    const s = createThermalState();
    const r = evaluateThermal(baseReading({ bedTemp0: 60, targetBedTemp0: 0 }), s, 1000);
    expect(r.cells.bed.phase).toBe('cooling');
    expect(r.cells.bed.intensity).toBeGreaterThan(0);
  });

  it('明確な変化は ±2(▲▼)、微増微減は ±1(△▽)、安定は 0', () => {
    const cfg = { arrowStrongRateCps: 0.5 };
    // 明確な上昇: 0.5s で +4℃ = 8℃/s → +2
    let s = createThermalState();
    evaluateThermal(baseReading({ nozzleTemp: 100, targetNozzleTemp: 220 }), s, 1000, cfg);
    const strongUp = evaluateThermal(baseReading({ nozzleTemp: 104, targetNozzleTemp: 220 }), s, 1500, cfg);
    expect(strongUp.cells.nozzle.direction).toBe(2);
    // 明確な下降: -6℃/s → -2
    const strongDown = evaluateThermal(baseReading({ nozzleTemp: 101, targetNozzleTemp: 220 }), s, 2000, cfg);
    expect(strongDown.cells.nozzle.direction).toBe(-2);

    // 微増(ベッドのバンバン制御相当): 0.5s で +0.15℃ = 0.3℃/s → +1(△)
    s = createThermalState();
    evaluateThermal(baseReading({ bedTemp0: 60.0, targetBedTemp0: 60 }), s, 1000, cfg);
    const slightUp = evaluateThermal(baseReading({ bedTemp0: 60.15, targetBedTemp0: 60 }), s, 1500, cfg);
    expect(slightUp.cells.bed.direction).toBe(1);
    // 微減: -0.3℃/s → -1(▽)
    const slightDown = evaluateThermal(baseReading({ bedTemp0: 60.0, targetBedTemp0: 60 }), s, 2000, cfg);
    expect(slightDown.cells.bed.direction).toBe(-1);

    // 安定(不感帯内): 0.5s で +0.01℃ = 0.02℃/s < 0.05 → 0
    s = createThermalState();
    evaluateThermal(baseReading({ bedTemp0: 60.0, targetBedTemp0: 60 }), s, 1000, cfg);
    const steady = evaluateThermal(baseReading({ bedTemp0: 60.01, targetBedTemp0: 60 }), s, 1500, cfg);
    expect(steady.cells.bed.direction).toBe(0);
  });
});

describe('絶対上限(error)', () => {
  it('機器報告 max に到達で error', () => {
    const s = createThermalState();
    const r = evaluateThermal(baseReading({ nozzleTemp: 305, targetNozzleTemp: 220, maxNozzleTemp: 300 }), s, 1000);
    expect(r.cells.nozzle.level).toBe('error');
    expect(r.alerts.find(a => a.category === 'over')).toBeTruthy();
    expect(r.counts.error).toBe(1);
  });

  it('機器報告 max は既定値より優先される', () => {
    const s = createThermalState();
    // 既定280…ではなく機器報告 260 を上限として使う
    const r = evaluateThermal(baseReading({ nozzleTemp: 270, targetNozzleTemp: 250, maxNozzleTemp: 260 }), s, 1000);
    expect(r.alerts.find(a => a.category === 'over')).toBeTruthy();
  });

  it('上限未満では発報しない', () => {
    const s = createThermalState();
    const r = evaluateThermal(baseReading({ nozzleTemp: 220, targetNozzleTemp: 220, maxNozzleTemp: 300 }), s, 1000);
    expect(r.counts.error).toBe(0);
  });
});

describe('急変化(error)', () => {
  it('連続サンプルで閾値超の変化を検知', () => {
    const s = createThermalState();
    evaluateThermal(baseReading({ nozzleTemp: 100, targetNozzleTemp: 220 }), s, 1000);
    // 0.5s で +20℃ → 40℃/s > 15
    const r = evaluateThermal(baseReading({ nozzleTemp: 120, targetNozzleTemp: 220 }), s, 1500);
    expect(r.alerts.find(a => a.category === 'rate')).toBeTruthy();
    expect(r.cells.nozzle.level).toBe('error');
  });

  it('初回サンプルでは急変化を出さない', () => {
    const s = createThermalState();
    const r = evaluateThermal(baseReading({ nozzleTemp: 300, targetNozzleTemp: 220, maxNozzleTemp: 350 }), s, 1000);
    expect(r.alerts.find(a => a.category === 'rate')).toBeFalsy();
  });

  it('緩慢な正常昇温では発報しない', () => {
    const s = createThermalState();
    evaluateThermal(baseReading({ nozzleTemp: 100, targetNozzleTemp: 220 }), s, 1000);
    // 0.5s で +3℃ → 6℃/s < 15
    const r = evaluateThermal(baseReading({ nozzleTemp: 103, targetNozzleTemp: 220 }), s, 1500);
    expect(r.alerts.find(a => a.category === 'rate')).toBeFalsy();
  });
});

describe('継続判定(乖離/オーバーシュート/昇温不良)', () => {
  it('乖離が継続時間を超えると warn', () => {
    const s = createThermalState();
    const cfg = { deviationLimitC: 20, deviationDurationMs: 10000 };
    // 乖離開始
    let r = evaluateThermal(baseReading({ nozzleTemp: 150, targetNozzleTemp: 220 }), s, 1000, cfg);
    expect(r.alerts.find(a => a.category === 'deviation')).toBeFalsy();
    // 11秒後も乖離継続 → warn
    r = evaluateThermal(baseReading({ nozzleTemp: 150, targetNozzleTemp: 220 }), s, 12000, cfg);
    expect(r.alerts.find(a => a.category === 'deviation')?.level).toBe('warn');
  });

  it('オーバーシュートが継続するとerror', () => {
    const s = createThermalState();
    const cfg = { overshootLimitC: 15, overshootDurationMs: 5000, nozzleMaxC: 400 };
    let r = evaluateThermal(baseReading({ nozzleTemp: 240, targetNozzleTemp: 220, maxNozzleTemp: 400 }), s, 1000, cfg);
    expect(r.alerts.find(a => a.category === 'overshoot')).toBeFalsy();
    r = evaluateThermal(baseReading({ nozzleTemp: 240, targetNozzleTemp: 220, maxNozzleTemp: 400 }), s, 7000, cfg);
    expect(r.alerts.find(a => a.category === 'overshoot')?.level).toBe('error');
  });

  it('昇温不良(加熱指令中に上がらない)はwarn', () => {
    const s = createThermalState();
    const cfg = { noRiseWindowMs: 30000, noRiseMinC: 2 };
    // 加熱指令中(100℃ << 目標220)で開始
    evaluateThermal(baseReading({ nozzleTemp: 100, targetNozzleTemp: 220 }), s, 1000, cfg);
    // 31秒後もほぼ上がらず(+1℃) → warn
    const r = evaluateThermal(baseReading({ nozzleTemp: 101, targetNozzleTemp: 220 }), s, 32000, cfg);
    expect(r.alerts.find(a => a.category === 'norise')?.level).toBe('warn');
  });
});

describe('誤発報の抑止', () => {
  it('目標0(待機)では乖離/オーバーシュート/昇温不良を出さない', () => {
    const s = createThermalState();
    // 室温で待機。時間を大きく進めても継続系は発火しない
    let r = evaluateThermal(baseReading({ nozzleTemp: 25, targetNozzleTemp: 0 }), s, 1000);
    r = evaluateThermal(baseReading({ nozzleTemp: 25, targetNozzleTemp: 0 }), s, 60000);
    expect(r.alerts.length).toBe(0);
  });

  it('err(0,0)・fan(0/1)を渡しても温度検知に影響しない', () => {
    const s = createThermalState();
    const r = evaluateThermal(
      baseReading({ nozzleTemp: 220, targetNozzleTemp: 220, err: { errcode: 0, key: 0 }, fan: 1, fanCase: 0 }),
      s, 1000
    );
    expect(r.alerts.length).toBe(0);
    expect(r.counts).toEqual({ error: 0, warn: 0 });
  });

  it('disabled では一切評価しない', () => {
    const s = createThermalState();
    const r = evaluateThermal(baseReading({ nozzleTemp: 999, targetNozzleTemp: 220 }), s, 1000, { enabled: false });
    expect(r.alerts.length).toBe(0);
    expect(Object.keys(r.cells).length).toBe(0);
  });
});

describe('新規/解除アラートの差分(ワンショット/自動復帰)', () => {
  it('新規発生は newAlerts、継続は newAlerts に出ない、解消で clearedAlerts', () => {
    const s = createThermalState();
    // 正常
    let r = evaluateThermal(baseReading({ nozzleTemp: 220, targetNozzleTemp: 220, maxNozzleTemp: 300 }), s, 1000);
    expect(r.newAlerts.length).toBe(0);
    // 上限到達 → 新規 error 1件
    r = evaluateThermal(baseReading({ nozzleTemp: 305, targetNozzleTemp: 220, maxNozzleTemp: 300 }), s, 1500);
    expect(r.newAlerts.find(a => a.category === 'over')).toBeTruthy();
    // 継続中 → newAlerts には出ない(連打しない)
    r = evaluateThermal(baseReading({ nozzleTemp: 306, targetNozzleTemp: 220, maxNozzleTemp: 300 }), s, 2000);
    expect(r.newAlerts.length).toBe(0);
    expect(r.alerts.find(a => a.category === 'over')).toBeTruthy();
    // 復帰(レート窓外の十分後・上限未満) → clearedAlerts に出て、セルは通常へ
    // ※ now を rateMaxDtMs より後にして、降温そのものを急変化と誤検知しないようにする
    r = evaluateThermal(baseReading({ nozzleTemp: 220, targetNozzleTemp: 220, maxNozzleTemp: 300 }), s, 9000);
    expect(r.clearedAlerts.find(a => a.category === 'over')).toBeTruthy();
    expect(r.cells.nozzle.level).toBeNull();
  });
});

describe('方向矢印の字形と色', () => {
  it('方向値→字形マッピング', () => {
    expect(thermalArrowGlyph(2)).toBe('▲');
    expect(thermalArrowGlyph(1)).toBe('△');
    expect(thermalArrowGlyph(-1)).toBe('▽');
    expect(thermalArrowGlyph(-2)).toBe('▼');
    expect(thermalArrowGlyph(0)).toBe('');
  });
  it('色は向き基準(上昇=緑/下降=青/安定=淡色)', () => {
    expect(thermalArrowColor({ direction: 2 })).toBe('#639922');
    expect(thermalArrowColor({ direction: 1 })).toBe('#639922');
    expect(thermalArrowColor({ direction: -2 })).toBe('#378ADD');
    expect(thermalArrowColor({ direction: 0 })).toBe('var(--color-text-tertiary)');
  });
});

describe('マルチホスト独立性', () => {
  it('別ホストの状態は混ざらない', () => {
    const a = createThermalState();
    const b = createThermalState();
    // ホストAだけ急変化を仕込む
    evaluateThermal(baseReading({ nozzleTemp: 100, targetNozzleTemp: 220 }), a, 1000);
    const ra = evaluateThermal(baseReading({ nozzleTemp: 130, targetNozzleTemp: 220 }), a, 1500);
    // ホストBは初回のみ → 急変化なし
    const rb = evaluateThermal(baseReading({ nozzleTemp: 130, targetNozzleTemp: 220 }), b, 1500);
    expect(ra.alerts.find(x => x.category === 'rate')).toBeTruthy();
    expect(rb.alerts.find(x => x.category === 'rate')).toBeFalsy();
  });
});
