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

const { registerGcodeMetaForHosts, resolveHistoryFinishStatus, _mergeFilamentInfo } =
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

// =====================================================================
// ADR-0005: filamentInfo を spoolId 単位で upsert（分割の per-reel usedMm 保持）
// =====================================================================
describe('_mergeFilamentInfo — spoolId 単位 upsert（ADR-0005 分割保持）', () => {
  it('cur が空なら incoming を取り込む', () => {
    const r = _mergeFilamentInfo([], [{ spoolId: 'A', usedMm: 100 }]);
    expect(r).toEqual([{ spoolId: 'A', usedMm: 100 }]);
  });

  it('incoming が空/未定義なら cur をそのまま返す', () => {
    const cur = [{ spoolId: 'A', usedMm: 100 }];
    expect(_mergeFilamentInfo(cur, [])).toBe(cur);
    expect(_mergeFilamentInfo(cur, undefined)).toBe(cur);
  });

  it('★分割保持: 色のみ(cur)に旧の per-reel(usedMm)を脱落させず追加', () => {
    // reqHistory 由来は色のみ（spoolId 無し）。権威(oldJobs)の per-reel を upsert。
    const cur = [{ filamentColor: '#fff' }];
    const incoming = [
      { spoolId: 'OLD', usedMm: 300000 },
      { spoolId: 'NEW', usedMm: 25000 },
    ];
    const r = _mergeFilamentInfo(cur, incoming);
    expect(r.find(e => e.spoolId === 'OLD').usedMm).toBe(300000);
    expect(r.find(e => e.spoolId === 'NEW').usedMm).toBe(25000);
    // 色のみエントリは保持（spoolId 無し1件）
    expect(r.filter(e => e.spoolId == null)).toHaveLength(1);
  });

  it('既存リールには欠落 usedMm のみ補完（新側に usedMm があれば尊重）', () => {
    const cur = [{ spoolId: 'A', usedMm: 0, spoolName: 'a' }, { spoolId: 'B', usedMm: 50 }];
    const incoming = [{ spoolId: 'A', usedMm: 999 }, { spoolId: 'B', usedMm: 77 }];
    const r = _mergeFilamentInfo(cur, incoming);
    expect(r.find(e => e.spoolId === 'A').usedMm).toBe(999); // cur が 0 → 補完
    expect(r.find(e => e.spoolId === 'B').usedMm).toBe(50);  // cur が >0 → 尊重
  });

  it('未知リールは追加（重複追加しない＝冪等）', () => {
    const cur = [{ spoolId: 'A', usedMm: 100 }];
    const incoming = [{ spoolId: 'A', usedMm: 100 }, { spoolId: 'C', usedMm: 30 }];
    const r = _mergeFilamentInfo(cur, incoming);
    expect(r.filter(e => e.spoolId === 'A')).toHaveLength(1);
    expect(r.find(e => e.spoolId === 'C').usedMm).toBe(30);
  });
});
