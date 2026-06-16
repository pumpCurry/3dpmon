/**
 * dashboard_moonraker.js 純粋関数テスト
 *
 * テスト対象: Moonraker(Fluidd/Klipper)→ K1 形 翻訳ロジック
 * - mapMoonrakerState
 * - mergeMoonrakerStatus
 * - translateMoonrakerStatus
 *
 * フィクスチャは実機 Ideaformer IR3 v2 (Klipper v2.0.1 / Moonraker v0.9.2,
 * 192.168.54.15) から取得した実データを使用する。
 */
import { describe, it, expect } from 'vitest';

// --- モジュールモック ---
// dashboard_moonraker.js → dashboard_ui_mapping.js → dashboard_notification_manager.js
//   → dashboard_audio_manager.js の依存チェーンが document を参照するためモック化。
import { vi } from 'vitest';
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
  mapMoonrakerState,
  mergeMoonrakerStatus,
  translateMoonrakerStatus,
  pickLargestThumbnail,
  buildMoonrakerThumbUrl,
  moonrakerHistoryToK1,
  moonrakerFilesToEntries,
  MOONRAKER_DEFAULT_MAX_NOZZLE,
  MOONRAKER_DEFAULT_MAX_BED,
} from '../../3dp_lib/dashboard_moonraker.js';

// =============================================================
// 実機フィクスチャ(印刷中スナップショット, 51%)
// =============================================================
const FIXTURE_PRINTING = {
  extruder: { temperature: 209.92, target: 210.0, power: 0.557 },
  heater_bed: { temperature: 64.99, target: 65.0, power: 0.877 },
  print_stats: {
    filename: '3DBenchy-PLA.gcode',
    total_duration: 1533.88,
    print_duration: 1470.22,
    filament_used: 2043.1535,
    state: 'printing',
    message: '',
  },
  display_status: { progress: 0.5110396898362702, message: 'ENABLING the Filament Motion Sensor' },
  virtual_sdcard: { progress: 0.5110396898362702, is_active: true, file_position: 2396862, file_size: 4690168 },
  toolhead: { homed_axes: 'xyz', position: [119.199, 40.428, 68.627, 4308.58] },
  gcode_move: { speed_factor: 1.0, extrude_factor: 0.98, gcode_position: [119.199, 40.472, 48.227, 1968.15] },
  fan: { speed: 1.0, rpm: null },
  idle_timeout: { state: 'Printing' },
  webhooks: { state: 'ready', state_message: 'Printer is ready' },
  'filament_motion_sensor encoder_sensor': { enabled: false, filament_detected: true },
};

// =============================================================
// 実機フィクスチャ(完了スナップショット)
// =============================================================
const FIXTURE_COMPLETE = {
  extruder: { temperature: 26.53, target: 0.0, power: 0.0 },
  heater_bed: { temperature: 27.34, target: 0.0, power: 0.0 },
  print_stats: {
    filename: '3DBenchy-PLA.gcode',
    total_duration: 2779.22,
    print_duration: 2715.55,
    filament_used: 3777.516,
    state: 'complete',
    message: '',
  },
  display_status: { progress: 1.0, message: 'DISABLING the Filament Motion Sensor' },
  virtual_sdcard: { progress: 1.0, is_active: false, file_position: 4690168, file_size: 4690168 },
  toolhead: { homed_axes: '', position: [0.0, 49.97, 0.0, 6008.25] },
  gcode_move: { gcode_position: [0.0, 49.97, 0.0, 5891.0] },
  fan: { speed: 0.0 },
  webhooks: { state: 'ready' },
  'filament_motion_sensor encoder_sensor': { enabled: false, filament_detected: true },
};

/** ジョブコンテキスト生成ヘルパ */
const mkCtx = (over = {}) => ({
  hostname: 'Ideaformer',
  maxNozzleTemp: 310,
  maxBedTemp: 90,
  job: { startEpoch: null, filename: null },
  ...over,
});

const NOW_MS = 1_700_000_000_000; // 固定時刻(テスト決定性のため)

// =============================================================
// mapMoonrakerState
// =============================================================
describe('mapMoonrakerState', () => {
  it('printing → 1(印刷中)', () => {
    expect(mapMoonrakerState('printing', 'ready')).toBe(1);
  });
  it('paused → 5(一時停止)', () => {
    expect(mapMoonrakerState('paused', 'ready')).toBe(5);
  });
  it('complete → 2(正常終了)', () => {
    expect(mapMoonrakerState('complete', 'ready')).toBe(2);
  });
  it('cancelled → 4(失敗扱い)', () => {
    expect(mapMoonrakerState('cancelled', 'ready')).toBe(4);
  });
  it('error → 4(失敗)', () => {
    expect(mapMoonrakerState('error', 'ready')).toBe(4);
  });
  it('standby → 0(停止)', () => {
    expect(mapMoonrakerState('standby', 'ready')).toBe(0);
  });
  it('Klippy が ready 以外なら印刷状態に関わらず 4(異常)', () => {
    expect(mapMoonrakerState('printing', 'shutdown')).toBe(4);
    expect(mapMoonrakerState('standby', 'error')).toBe(4);
  });
});

// =============================================================
// mergeMoonrakerStatus
// =============================================================
describe('mergeMoonrakerStatus', () => {
  it('オブジェクト単位で浅くマージする(差分push合成)', () => {
    const acc = {};
    mergeMoonrakerStatus(acc, { extruder: { temperature: 200 } });
    mergeMoonrakerStatus(acc, { extruder: { target: 210 } });
    expect(acc.extruder).toEqual({ temperature: 200, target: 210 });
  });
  it('同一フィールドは後勝ちで上書きする', () => {
    const acc = { extruder: { temperature: 200 } };
    mergeMoonrakerStatus(acc, { extruder: { temperature: 205 } });
    expect(acc.extruder.temperature).toBe(205);
  });
  it('null/非オブジェクトは安全に無視する', () => {
    const acc = { a: 1 };
    expect(mergeMoonrakerStatus(acc, null)).toBe(acc);
    expect(acc).toEqual({ a: 1 });
  });
});

// =============================================================
// translateMoonrakerStatus(印刷中)
// =============================================================
describe('translateMoonrakerStatus(印刷中)', () => {
  const out = translateMoonrakerStatus(FIXTURE_PRINTING, mkCtx(), NOW_MS);

  it('hostname を引き継ぐ', () => {
    expect(out.hostname).toBe('Ideaformer');
  });
  it('状態コード=1(印刷中)', () => {
    expect(out.state).toBe(1);
    expect(out.printState).toBe(1);
  });
  it('温度を小数2桁で正規化する', () => {
    expect(out.nozzleTemp).toBe(209.92);
    expect(out.targetNozzleTemp).toBe(210);
    expect(out.bedTemp0).toBe(64.99);
    expect(out.targetBedTemp0).toBe(65);
  });
  it('温度上限は ctx(config)由来を使う', () => {
    expect(out.maxNozzleTemp).toBe(310);
    expect(out.maxBedTemp).toBe(90);
  });
  it('進捗は 0-100 へ変換する', () => {
    expect(out.printProgress).toBe(51);
  });
  it('経過時間と使用フィラメントを整数 mm/秒へ', () => {
    expect(out.printJobTime).toBe(1470);
    expect(out.usedMaterialLength).toBe(2043);
  });
  it('printFileName を引き継ぐ', () => {
    expect(out.printFileName).toBe('3DBenchy-PLA.gcode');
  });
  it('座標は parseCurPosition 互換文字列', () => {
    // gcode_position 優先(119.199, 40.472, 48.227)
    expect(out.curPosition).toBe('X: 119.20 Y: 40.47 Z: 48.23');
  });
  it('残時間をファイル進捗から線形推定する', () => {
    // total ≈ 1470.22 / 0.51104 ≈ 2876.8 → left ≈ 2877 - 1470 = 1407 付近
    expect(out.printLeftTime).toBeGreaterThan(1300);
    expect(out.printLeftTime).toBeLessThan(1500);
  });
  it('printStartTime = now - 経過(安定ジョブID)', () => {
    expect(out.printStartTime).toBe(Math.floor(NOW_MS / 1000) - 1470);
  });
  it('ファン速度を ON/OFF と % に', () => {
    expect(out.fan).toBe(1);
    expect(out.modelFanPct).toBe(100);
  });
  it('エンコーダ無効時は materialStatus を付けない', () => {
    expect('materialStatus' in out).toBe(false);
  });
});

// =============================================================
// translateMoonrakerStatus(完了)
// =============================================================
describe('translateMoonrakerStatus(完了)', () => {
  const out = translateMoonrakerStatus(FIXTURE_COMPLETE, mkCtx(), NOW_MS);

  it('状態コード=2(正常終了)', () => {
    expect(out.state).toBe(2);
  });
  it('進捗=100', () => {
    expect(out.printProgress).toBe(100);
  });
  it('完了時刻(epoch秒)を付与する', () => {
    expect(out.printFinishTime).toBe(Math.floor(NOW_MS / 1000));
  });
  it('使用フィラメントを反映する', () => {
    expect(out.usedMaterialLength).toBe(3778);
  });
});

// =============================================================
// ジョブID 安定性
// =============================================================
describe('ジョブID(printStartTime)安定性', () => {
  it('同一ファイルの連続更新では開始時刻を維持する', () => {
    const ctx = mkCtx();
    const a = translateMoonrakerStatus(FIXTURE_PRINTING, ctx, NOW_MS);
    // 30秒後・経過も30秒進んだ状態でも startEpoch は維持される
    const later = { ...FIXTURE_PRINTING, print_stats: { ...FIXTURE_PRINTING.print_stats, print_duration: 1500.22 } };
    const b = translateMoonrakerStatus(later, ctx, NOW_MS + 30_000);
    expect(b.printStartTime).toBe(a.printStartTime);
  });
  it('ファイル名が変わると新しいジョブIDを確定する', () => {
    const ctx = mkCtx();
    const a = translateMoonrakerStatus(FIXTURE_PRINTING, ctx, NOW_MS);
    const other = { ...FIXTURE_PRINTING, print_stats: { ...FIXTURE_PRINTING.print_stats, filename: 'Cube-PLA.gcode', print_duration: 10 } };
    const b = translateMoonrakerStatus(other, ctx, NOW_MS + 60_000);
    expect(b.printStartTime).not.toBe(a.printStartTime);
    expect(b.printStartTime).toBe(Math.floor((NOW_MS + 60_000) / 1000) - 10);
  });
});

// =============================================================
// 進捗ソース優先順位
// =============================================================
describe('進捗ソース優先順位', () => {
  it('virtual_sdcard.progress を display_status より優先する(ベルト機配慮)', () => {
    const status = {
      print_stats: { state: 'printing', print_duration: 100, filename: 'x.gcode' },
      virtual_sdcard: { progress: 0.30 },
      display_status: { progress: 0.99 },
      webhooks: { state: 'ready' },
    };
    const out = translateMoonrakerStatus(status, mkCtx(), NOW_MS);
    expect(out.printProgress).toBe(30);
  });
  it('virtual_sdcard が無ければ display_status を使う', () => {
    const status = {
      print_stats: { state: 'printing', print_duration: 100, filename: 'x.gcode' },
      display_status: { progress: 0.42 },
      webhooks: { state: 'ready' },
    };
    const out = translateMoonrakerStatus(status, mkCtx(), NOW_MS);
    expect(out.printProgress).toBe(42);
  });
});

// =============================================================
// 残時間の線形推定(決定的ケース)
// =============================================================
describe('残時間の線形推定', () => {
  it('進捗0.5・経過1000秒 → 残り1000秒', () => {
    const status = {
      print_stats: { state: 'printing', print_duration: 1000, filename: 'x.gcode' },
      virtual_sdcard: { progress: 0.5 },
      webhooks: { state: 'ready' },
    };
    const out = translateMoonrakerStatus(status, mkCtx(), NOW_MS);
    expect(out.printLeftTime).toBe(1000);
  });
  it('進捗0なら算出不能(null)', () => {
    const status = {
      print_stats: { state: 'printing', print_duration: 0, filename: 'x.gcode' },
      virtual_sdcard: { progress: 0 },
      webhooks: { state: 'ready' },
    };
    const out = translateMoonrakerStatus(status, mkCtx(), NOW_MS);
    expect(out.printLeftTime).toBeNull();
  });
});

// =============================================================
// 材料検知センサ(エンコーダ)
// =============================================================
describe('材料検知センサ(エンコーダ)', () => {
  it('有効かつ未検知 → materialStatus=1(切れ)', () => {
    const status = {
      print_stats: { state: 'printing', print_duration: 10, filename: 'x.gcode' },
      virtual_sdcard: { progress: 0.1 },
      webhooks: { state: 'ready' },
      'filament_motion_sensor encoder_sensor': { enabled: true, filament_detected: false },
    };
    const out = translateMoonrakerStatus(status, mkCtx(), NOW_MS);
    expect(out.materialStatus).toBe(1);
  });
  it('有効かつ検知 → materialStatus=0(OK)', () => {
    const status = {
      print_stats: { state: 'printing', print_duration: 10, filename: 'x.gcode' },
      virtual_sdcard: { progress: 0.1 },
      webhooks: { state: 'ready' },
      'filament_motion_sensor encoder_sensor': { enabled: true, filament_detected: true },
    };
    const out = translateMoonrakerStatus(status, mkCtx(), NOW_MS);
    expect(out.materialStatus).toBe(0);
  });
});

// =============================================================
// Klippy 異常
// =============================================================
describe('Klippy 異常', () => {
  it('shutdown → 状態4 + err 付与', () => {
    const status = {
      print_stats: { state: 'printing', print_duration: 10, filename: 'x.gcode' },
      webhooks: { state: 'shutdown', state_message: 'Klipper has shutdown' },
    };
    const out = translateMoonrakerStatus(status, mkCtx(), NOW_MS);
    expect(out.state).toBe(4);
    expect(out.err).toEqual({ errcode: 1, key: 0 });
  });
});

// =============================================================
// フォールバック(config 未取得)
// =============================================================
describe('温度上限フォールバック', () => {
  it('ctx に上限が無ければ既定値を使う', () => {
    const ctx = { hostname: 'h', job: { startEpoch: null, filename: null } };
    const out = translateMoonrakerStatus(FIXTURE_PRINTING, ctx, NOW_MS);
    expect(out.maxNozzleTemp).toBe(MOONRAKER_DEFAULT_MAX_NOZZLE);
    expect(out.maxBedTemp).toBe(MOONRAKER_DEFAULT_MAX_BED);
  });
});

// =============================================================
// 座標ソース優先順位(実位置 motion_report 最優先)
// =============================================================
describe('座標ソース優先順位', () => {
  it('motion_report.live_position を gcode_move/toolhead より優先する', () => {
    const status = {
      print_stats: { state: 'printing', print_duration: 100, filename: 'x.gcode' },
      virtual_sdcard: { progress: 0.5 },
      webhooks: { state: 'ready' },
      motion_report: { live_position: [10.5, 20.25, 34.95, 999] }, // 実位置(ベルトZ)
      gcode_move: { gcode_position: [99, 99, 14.55, 0] },           // スライサZ(無視されるべき)
      toolhead: { position: [1, 2, 3, 0] },
    };
    const out = translateMoonrakerStatus(status, mkCtx(), NOW_MS);
    expect(out.curPosition).toBe('X: 10.50 Y: 20.25 Z: 34.95');
  });
  it('motion_report が無ければ gcode_move.gcode_position を使う', () => {
    const status = {
      print_stats: { state: 'printing', print_duration: 100, filename: 'x.gcode' },
      virtual_sdcard: { progress: 0.5 },
      webhooks: { state: 'ready' },
      gcode_move: { gcode_position: [5, 6, 7, 0] },
    };
    const out = translateMoonrakerStatus(status, mkCtx(), NOW_MS);
    expect(out.curPosition).toBe('X: 5.00 Y: 6.00 Z: 7.00');
  });
});

// =============================================================
// レイヤー導出(Fluidd 互換: metadata + スライサZ)
// =============================================================
describe('レイヤー導出', () => {
  // 実機 Piggy-PLA-3.gcode のメタ(Fluidd の 499 と一致することを実機で確認済)
  const PIGGY_META = { estimatedTime: 5380, objectHeight: 141.233, layerHeight: 0.283, firstLayerHeight: 0.4, layerCount: null };

  it('総レイヤー = ceil((object_height - first)/layer)+1 = 499(実機一致)', () => {
    const status = {
      print_stats: { state: 'printing', print_duration: 1000, filename: 'Piggy-PLA-3.gcode' },
      virtual_sdcard: { progress: 0.1 },
      gcode_move: { gcode_position: [0, 0, 14.55, 0] }, // スライサZ
      webhooks: { state: 'ready' },
    };
    const out = translateMoonrakerStatus(status, mkCtx({ meta: PIGGY_META }), NOW_MS);
    expect(out.TotalLayer).toBe(499);
    // 現在レイヤー = ceil((14.55-0.4)/0.283)+1 = 51
    expect(out.layer).toBe(51);
  });

  it('現在レイヤーは [0, total] にクランプされる', () => {
    const status = {
      print_stats: { state: 'printing', print_duration: 1, filename: 'Piggy-PLA-3.gcode' },
      gcode_move: { gcode_position: [0, 0, 9999, 0] }, // 高さ超過
      webhooks: { state: 'ready' },
    };
    const out = translateMoonrakerStatus(status, mkCtx({ meta: PIGGY_META }), NOW_MS);
    expect(out.layer).toBe(out.TotalLayer);
  });

  it('layer_count があれば総レイヤーに最優先', () => {
    const status = {
      print_stats: { state: 'printing', print_duration: 1, filename: 'x.gcode' },
      gcode_move: { gcode_position: [0, 0, 5, 0] },
      webhooks: { state: 'ready' },
    };
    const out = translateMoonrakerStatus(status, mkCtx({ meta: { ...PIGGY_META, layerCount: 250 } }), NOW_MS);
    expect(out.TotalLayer).toBe(250);
  });

  it('print_stats.info が将来埋まればそれを最優先する', () => {
    const status = {
      print_stats: { state: 'printing', print_duration: 1, filename: 'x.gcode', info: { current_layer: 42, total_layer: 300 } },
      gcode_move: { gcode_position: [0, 0, 5, 0] },
      webhooks: { state: 'ready' },
    };
    const out = translateMoonrakerStatus(status, mkCtx({ meta: PIGGY_META }), NOW_MS);
    expect(out.TotalLayer).toBe(300);
    expect(out.layer).toBe(42);
  });

  it('メタが無ければレイヤーを出力しない', () => {
    const out = translateMoonrakerStatus(FIXTURE_PRINTING, mkCtx(), NOW_MS);
    expect('TotalLayer' in out).toBe(false);
    expect('layer' in out).toBe(false);
  });
});

// =============================================================
// 残時間(スライサ見積り優先)
// =============================================================
describe('残時間(metadata.estimated_time 優先)', () => {
  it('estimated_time があれば estimated_time - 経過 を使う', () => {
    const status = {
      print_stats: { state: 'printing', print_duration: 1380, filename: 'x.gcode' },
      virtual_sdcard: { progress: 0.5 }, // 線形なら残1380になるが、見積り優先で 4000 になる
      webhooks: { state: 'ready' },
    };
    const out = translateMoonrakerStatus(status, mkCtx({ meta: { estimatedTime: 5380 } }), NOW_MS);
    expect(out.printLeftTime).toBe(4000); // 5380 - 1380
  });
  it('見積り超過(残≤0)時はファイル進捗の線形推定にフォールバック', () => {
    const status = {
      print_stats: { state: 'printing', print_duration: 6000, filename: 'x.gcode' },
      virtual_sdcard: { progress: 0.8 },
      webhooks: { state: 'ready' },
    };
    const out = translateMoonrakerStatus(status, mkCtx({ meta: { estimatedTime: 5380 } }), NOW_MS);
    // 5380-6000<0 → 線形: total=6000/0.8=7500 → 残=1500
    expect(out.printLeftTime).toBe(1500);
  });
});

// =============================================================
// サムネイルURL
// =============================================================
describe('pickLargestThumbnail / buildMoonrakerThumbUrl', () => {
  const THUMBS = [
    { width: 32, height: 32, relative_path: '.thumbs/foo-32x32.png' },
    { width: 200, height: 200, relative_path: '.thumbs/foo-200x200.png' },
  ];
  it('最大サイズのサムネを選ぶ', () => {
    expect(pickLargestThumbnail(THUMBS).width).toBe(200);
  });
  it('空配列/未定義は null', () => {
    expect(pickLargestThumbnail([])).toBeNull();
    expect(pickLargestThumbnail(undefined)).toBeNull();
  });
  it('ルート直下ファイルのサムネURL', () => {
    const u = buildMoonrakerThumbUrl('http://192.168.54.15:80', 'foo.gcode', '.thumbs/foo-200x200.png');
    expect(u).toBe('http://192.168.54.15:80/server/files/gcodes/.thumbs/foo-200x200.png');
  });
  it('サブフォルダ内ファイルは相対パスにディレクトリを前置する', () => {
    const u = buildMoonrakerThumbUrl('http://h:80', 'sub/dir/foo.gcode', '.thumbs/foo-200x200.png');
    expect(u).toBe('http://h:80/server/files/gcodes/sub/dir/.thumbs/foo-200x200.png');
  });
});

// =============================================================
// 履歴変換(Moonraker server.history.list → K1 raw)
// =============================================================
describe('moonrakerHistoryToK1', () => {
  // 実機 server.history.list の形(3DBenchy)
  const JOBS = [
    {
      job_id: '000004', status: 'in_progress', filename: '3DBenchy-PLA.gcode',
      start_time: 1781591339.67, print_duration: 0, filament_used: 0,
      metadata: { size: 4690168, thumbnails: [{ width: 200, relative_path: '.thumbs/3DBenchy-PLA-200x200.png' }], filament_type: 'PLA' },
    },
    {
      job_id: '000003', status: 'cancelled', filename: '3DBenchy-PLA.gcode',
      start_time: 1744784914.42, print_duration: 1614.62, filament_used: 2251.31,
      metadata: { size: 4690168, thumbnails: [{ width: 32, relative_path: '.thumbs/a-32x32.png' }, { width: 200, relative_path: '.thumbs/a-200x200.png' }], filament_type: 'PLA' },
    },
    {
      job_id: '000002', status: 'completed', filename: 'Cube-PLA.gcode',
      start_time: 1744000000.0, print_duration: 600.4, filament_used: 800.9,
      metadata: { thumbnails: [] },
    },
  ];
  const out = moonrakerHistoryToK1(JOBS, 'http://h:80');

  it('in_progress は除外する(現在ジョブはライブ側)', () => {
    expect(out.length).toBe(2);
    expect(out.some((e) => e.id === Math.floor(1781591339.67))).toBe(false);
  });
  it('id/starttime は start_time の floor', () => {
    const j = out.find((e) => e.id === 1744784914);
    expect(j).toBeTruthy();
    expect(j.starttime).toBe(1744784914);
  });
  it('使用時間/材料は整数化', () => {
    const j = out.find((e) => e.id === 1744784914);
    expect(j.usagetime).toBe(1615);
    expect(j.usagematerial).toBe(2251);
  });
  it('printfinish: completed→1 / それ以外→0', () => {
    expect(out.find((e) => e.filename === 'Cube-PLA.gcode').printfinish).toBe(1);
    expect(out.find((e) => e.id === 1744784914).printfinish).toBe(0); // cancelled
  });
  it('thumbUrl は最大サムネから組む / 無ければ空', () => {
    expect(out.find((e) => e.id === 1744784914).thumbUrl)
      .toBe('http://h:80/server/files/gcodes/.thumbs/a-200x200.png');
    expect(out.find((e) => e.filename === 'Cube-PLA.gcode').thumbUrl).toBe('');
  });
  it('非配列は空配列', () => {
    expect(moonrakerHistoryToK1(null, 'http://h')).toEqual([]);
  });
});

// =============================================================
// ファイル一覧変換(Moonraker server.files.list + metadata → entries)
// =============================================================
describe('moonrakerFilesToEntries', () => {
  const FILES = [
    { path: '3DBenchy-PLA.gcode', size: 4690168, modified: 1732008962 },
    { path: 'sub/Piggy.gcode', size: 9975038, modified: 1732008957 },
  ];
  const METAS = {
    '3DBenchy-PLA.gcode': {
      object_height: 140.502, layer_height: 0.283, first_layer_height: 0.4,
      estimated_time: 2720, filament_total: 3633.7,
      thumbnails: [{ width: 200, relative_path: '.thumbs/3DBenchy-PLA-200x200.png' }],
    },
    'sub/Piggy.gcode': { layer_count: 250, estimated_time: 5380, filament_total: 7030.9, thumbnails: [] },
  };
  const out = moonrakerFilesToEntries(FILES, METAS, 'http://h:80');

  it('basename / size(数値) / number', () => {
    expect(out[0].basename).toBe('3DBenchy-PLA.gcode');
    expect(out[0].size).toBe(4690168);
    expect(typeof out[0].size).toBe('number');
    expect(out[0].number).toBe(1);
  });
  it('mtime は Date オブジェクト(JSON非経由で直接渡す前提)', () => {
    expect(out[0].mtime instanceof Date).toBe(true);
    expect(out[0].mtime.getTime()).toBe(1732008962 * 1000);
  });
  it('layer: 高さ/層厚から導出', () => {
    // ceil((140.502-0.4)/0.283)+1
    expect(out[0].layer).toBe(Math.ceil((140.502 - 0.4) / 0.283) + 1);
  });
  it('layer: layer_count があれば優先', () => {
    expect(out[1].layer).toBe(250);
  });
  it('expect=filament_total, usagetime=estimated_time', () => {
    expect(out[0].expect).toBe(3633.7);
    expect(out[0].usagetime).toBe(2720);
  });
  it('サブフォルダのファイルは filename にパスを保持し thumb 無しは空', () => {
    expect(out[1].filename).toBe('sub/Piggy.gcode');
    expect(out[1].thumbUrl).toBe('');
  });
  it('サムネURL(ルート)', () => {
    expect(out[0].thumbUrl).toBe('http://h:80/server/files/gcodes/.thumbs/3DBenchy-PLA-200x200.png');
  });
});
