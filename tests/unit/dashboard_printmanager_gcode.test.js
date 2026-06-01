/**
 * dashboard_printmanager.js gcode メタ マルチホスト登録テスト
 *
 * テスト対象: registerGcodeMetaForHosts (純粋関数)
 *
 * 回帰防止対象バグ:
 *   gcode アップロード時、印刷予定秒数(平均時間)が「1番目の機器のみ」に
 *   登録され、2番目以降の機器では平均時間が "—" になる
 *   マルチホスト・コンタミネーション欠陥。
 *   アップロード先の全ホストへ `${host}:${filename}` キーで登録されること。
 */
import { describe, it, expect, beforeEach } from 'vitest';

// printmanager の重い依存グラフを切り離す（pure 関数のみ検証するため）
import { vi } from 'vitest';
vi.mock('../../3dp_lib/dashboard_storage.js', () => ({
  loadPrintCurrent: vi.fn(), savePrintCurrent: vi.fn(),
  loadPrintHistory: vi.fn(() => []), savePrintHistory: vi.fn(),
  loadPrintVideos: vi.fn(() => []), savePrintVideos: vi.fn(),
  MAX_PRINT_HISTORY: 100,
}));
vi.mock('../../3dp_lib/dashboard_utils.js', () => ({
  formatEpochToDateTime: vi.fn(), formatDuration: vi.fn(),
}));
vi.mock('../../3dp_lib/dashboard_log_util.js', () => ({ pushLog: vi.fn() }));
vi.mock('../../3dp_lib/dashboard_ui_confirm.js', () => ({
  showConfirmDialog: vi.fn(), showInputDialog: vi.fn(),
}));
vi.mock('../../3dp_lib/dashboard_data.js', () => ({
  monitorData: { machines: {} }, scopedById: vi.fn(), setStoredDataForHost: vi.fn(),
}));
vi.mock('../../3dp_lib/dashboard_spool.js', () => ({
  getCurrentSpool: vi.fn(), getCurrentSpoolId: vi.fn(), setCurrentSpoolId: vi.fn(),
  useFilament: vi.fn(), getSpoolById: vi.fn(), updateSpool: vi.fn(),
  formatFilamentAmount: vi.fn(), formatSpoolDisplayId: vi.fn(),
  buildFilamentRecommendations: vi.fn(),
}));
vi.mock('../../3dp_lib/dashboard_connection.js', () => ({
  sendCommand: vi.fn(), fetchStoredData: vi.fn(),
  getDeviceIp: vi.fn(), getConnectionState: vi.fn(),
}));
vi.mock('../../3dp_lib/dashboard_video_player.js', () => ({ showVideoOverlay: vi.fn() }));
vi.mock('../../3dp_lib/dashboard_spool_ui.js', () => ({
  showSpoolDialog: vi.fn(), showSpoolSelectDialog: vi.fn(),
}));
vi.mock('../../3dp_lib/dashboard_filament_change.js', () => ({
  showHistoryFilamentDialog: vi.fn(), updatePreview: vi.fn(),
}));
vi.mock('../../3dp_lib/dashboard_ui_mapping.js', () => ({ PRINT_STATE_CODE: {} }));
vi.mock('../../3dp_lib/dashboard_aggregator.js', () => ({ getCurrentPrintID: vi.fn() }));

const { registerGcodeMetaForHosts, resolveHistoryFinishStatus } =
  await import('../../3dp_lib/dashboard_printmanager.js');

describe('registerGcodeMetaForHosts — マルチホスト gcode メタ登録', () => {
  let cache;
  const meta = { timeSec: 3600, layers: '120', material: 'PLA' };

  beforeEach(() => { cache = new Map(); });

  it('複数ホスト全てに `${host}:${filename}` キーで登録される', () => {
    const targets = ['K1Max-4A1B', 'K1Max-03FA', 'K1C-1234'];
    const n = registerGcodeMetaForHosts(cache, targets, 'test.gcode', meta);

    expect(n).toBe(3);
    expect(cache.get('K1Max-4A1B:test.gcode')).toBe(meta);
    expect(cache.get('K1Max-03FA:test.gcode')).toBe(meta);
    expect(cache.get('K1C-1234:test.gcode')).toBe(meta);
  });

  it('★回帰: 1番目だけでなく2番目以降の機器にも確実に登録される', () => {
    const targets = ['hostA', 'hostB'];
    registerGcodeMetaForHosts(cache, targets, 'cube.gcode', meta);

    // 2番目のホストが取得できることがこのバグの核心
    const second = cache.get('hostB:cube.gcode');
    expect(second).toBeDefined();
    expect(second.timeSec).toBe(3600);
  });

  it('単一ホストでも正しく登録される', () => {
    const n = registerGcodeMetaForHosts(cache, ['solo'], 'a.gcode', meta);
    expect(n).toBe(1);
    expect(cache.get('solo:a.gcode')).toBe(meta);
  });

  it('空メタは登録しない（0件）', () => {
    const n = registerGcodeMetaForHosts(cache, ['hostA', 'hostB'], 'a.gcode', {});
    expect(n).toBe(0);
    expect(cache.size).toBe(0);
  });

  it('targets 空配列は0件', () => {
    const n = registerGcodeMetaForHosts(cache, [], 'a.gcode', meta);
    expect(n).toBe(0);
    expect(cache.size).toBe(0);
  });

  it('falsy なホスト名はスキップする', () => {
    const n = registerGcodeMetaForHosts(cache, ['hostA', '', null, 'hostB'], 'a.gcode', meta);
    expect(n).toBe(2);
    expect(cache.has('hostA:a.gcode')).toBe(true);
    expect(cache.has('hostB:a.gcode')).toBe(true);
  });

  it('不正引数は安全に0を返す', () => {
    expect(registerGcodeMetaForHosts(null, ['h'], 'f', meta)).toBe(0);
    expect(registerGcodeMetaForHosts(cache, 'notarray', 'f', meta)).toBe(0);
    expect(registerGcodeMetaForHosts(cache, ['h'], '', meta)).toBe(0);
    expect(registerGcodeMetaForHosts(cache, ['h'], 'f', null)).toBe(0);
  });

  it('各ホストが独立して同じメタを参照（汚染なし）', () => {
    const targets = ['h1', 'h2'];
    registerGcodeMetaForHosts(cache, targets, 'x.gcode', meta);
    // h1 のキーを書き換えても h2 に影響しないキー独立性
    expect(cache.get('h1:x.gcode')).toBe(cache.get('h2:x.gcode'));
    // キーは別物
    expect(cache.has('h1:x.gcode')).toBe(true);
    expect(cache.has('h2:x.gcode')).toBe(true);
    expect(cache.size).toBe(2);
  });
});

describe('resolveHistoryFinishStatus — 印刷中は currentPrintID 一致のみ', () => {
  it('現在の印刷ジョブ(isCurrentJob)のみ ▶ 印刷中表示', () => {
    const r = resolveHistoryFinishStatus({ isCurrentJob: true, isPaused: false, printfinish: 0 });
    expect(r.finish).toBe('▶');
    expect(r.finishCls).toBe('result-active');
  });

  it('現在の印刷ジョブが一時停止中なら ⏸', () => {
    const r = resolveHistoryFinishStatus({ isCurrentJob: true, isPaused: true, printfinish: null });
    expect(r.finish).toBe('⏸');
    expect(r.finishCls).toBe('result-active');
  });

  it('★回帰: 非カレントジョブは printfinish=0 でも決して印刷中にならない', () => {
    // かつては endtime 未設定 + printfinish=0 で ▶ になり、再取得時に
    // currentPrintID と無関係な複数行が「印刷中」になっていた
    const r = resolveHistoryFinishStatus({ isCurrentJob: false, isPaused: false, printfinish: 0 });
    expect(r.finish).toBe('✗');
    expect(r.finishCls).toBe('result-ng');
  });

  it('★回帰: 非カレント + printfinish=null も印刷中にならない', () => {
    const r = resolveHistoryFinishStatus({ isCurrentJob: false, isPaused: false, printfinish: null });
    expect(r.finish).toBe('✗');
  });

  it('★回帰: 非カレント + printfinish=undefined も印刷中にならない', () => {
    const r = resolveHistoryFinishStatus({ isCurrentJob: false, isPaused: false, printfinish: undefined });
    expect(r.finish).toBe('✗');
  });

  it('printfinish=1 は成功 ✔（非カレント時）', () => {
    const r = resolveHistoryFinishStatus({ isCurrentJob: false, isPaused: false, printfinish: 1 });
    expect(r.finish).toBe('✔');
    expect(r.finishCls).toBe('result-ok');
  });

  it('printfinish=-1(明示的失敗)は ✗', () => {
    const r = resolveHistoryFinishStatus({ isCurrentJob: false, isPaused: false, printfinish: -1 });
    expect(r.finish).toBe('✗');
  });

  it('複数の非カレント未完了ジョブは全て ✗（印刷中は1つも生まれない）', () => {
    const jobs = [
      { isCurrentJob: false, isPaused: false, printfinish: 0 },
      { isCurrentJob: false, isPaused: false, printfinish: null },
      { isCurrentJob: false, isPaused: false, printfinish: 0 },
    ];
    const results = jobs.map(resolveHistoryFinishStatus);
    const activeCount = results.filter(r => r.finishCls === 'result-active').length;
    expect(activeCount).toBe(0);  // 印刷中は0個
  });
});
