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
  normalizeJobId: vi.fn((v) => (Number(v) > 0 ? Math.floor(Number(v)) : null)),
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
  getDisplayBaseUrl: vi.fn(() => ''), getPrinterType: vi.fn(() => 'creality-k1'),
}));
vi.mock('../../3dp_lib/dashboard_video_player.js', () => ({ showVideoOverlay: vi.fn() }));
vi.mock('../../3dp_lib/dashboard_spool_ui.js', () => ({
  showSpoolDialog: vi.fn(), showSpoolSelectDialog: vi.fn(),
}));
vi.mock('../../3dp_lib/dashboard_filament_change.js', () => ({
  showHistoryFilamentDialog: vi.fn(), updatePreview: vi.fn(),
}));
vi.mock('../../3dp_lib/dashboard_ui_mapping.js', () => ({ PRINT_STATE_CODE: { printIdle: 0, printStarted: 1, printPaused: 2, printDone: 3 } }));
vi.mock('../../3dp_lib/dashboard_aggregator.js', () => ({ getCurrentPrintID: vi.fn() }));

const { registerGcodeMetaForHosts, resolveHistoryFinishStatus, _mergeFilamentInfo,
  parseRawHistoryEntry, jobsToRaw, updateHistoryList } =
  await import('../../3dp_lib/dashboard_printmanager.js');
const _storageMock = await import('../../3dp_lib/dashboard_storage.js');
const _dataMock = await import('../../3dp_lib/dashboard_data.js');
const _aggMock = await import('../../3dp_lib/dashboard_aggregator.js');

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

  it('★回帰: 非カレント + printfinish=null は ▶ にならず「…」未確定（成功/失敗へ誤確定しない）', () => {
    // 印刷中ジョブを再起動時に成功/失敗へ誤確定＝誤計上していたバグの回帰防止。
    // null=未確定 は ✗ にも ▶ にもせず中立の「…」(result-pending) にする。
    const r = resolveHistoryFinishStatus({ isCurrentJob: false, isPaused: false, printfinish: null });
    expect(r.finishCls).not.toBe('result-active');  // ▶ にならない（コンタミ防止は維持）
    expect(r.finish).toBe('…');                     // ✗ にしない（誤計上防止）
    expect(r.finishCls).toBe('result-pending');
  });

  it('★回帰: 非カレント + printfinish=undefined も同様に「…」未確定', () => {
    const r = resolveHistoryFinishStatus({ isCurrentJob: false, isPaused: false, printfinish: undefined });
    expect(r.finishCls).not.toBe('result-active');
    expect(r.finish).toBe('…');
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

  it('複数の非カレントジョブでも 印刷中(▶) は1つも生まれない（コンタミ防止）', () => {
    const jobs = [
      { isCurrentJob: false, isPaused: false, printfinish: 0 },     // ✗ 明示失敗
      { isCurrentJob: false, isPaused: false, printfinish: null },  // … 未確定
      { isCurrentJob: false, isPaused: false, printfinish: 0 },     // ✗ 明示失敗
    ];
    const results = jobs.map(resolveHistoryFinishStatus);
    const activeCount = results.filter(r => r.finishCls === 'result-active').length;
    expect(activeCount).toBe(0);  // 印刷中(▶)は0個
    // null は ✗ ではなく「…」(未確定) になる（誤計上防止）
    expect(results[1].finish).toBe('…');
  });

  it('★中止確定: 非カレント + printfinish=null + discontinued=true は「⏹」(result-aborted)', () => {
    // 非最新のまま放置＝後続印刷が開始済で継続されていない。…(無期限保留)ではなく中止を明示。
    const r = resolveHistoryFinishStatus({ isCurrentJob: false, isPaused: false, printfinish: null, discontinued: true });
    expect(r.finish).toBe('⏹');
    expect(r.finishCls).toBe('result-aborted');
  });

  it('★中止は printfinish==null 限定: 完了(1)/失敗(0)は discontinued でも本来の成否を優先', () => {
    // discontinued は「未確定のまま放置」のときのみ意味を持つ。成否が出ていれば本来の結果。
    const ok = resolveHistoryFinishStatus({ isCurrentJob: false, isPaused: false, printfinish: 1, discontinued: true });
    expect(ok.finishCls).toBe('result-ok');
    const ng = resolveHistoryFinishStatus({ isCurrentJob: false, isPaused: false, printfinish: 0, discontinued: true });
    expect(ng.finishCls).toBe('result-ng');
  });

  it('★中止より現在ジョブ優先: isCurrentJob なら discontinued でも ▶（保護対象）', () => {
    const r = resolveHistoryFinishStatus({ isCurrentJob: true, isPaused: false, printfinish: null, discontinued: true });
    expect(r.finish).toBe('▶');
    expect(r.finishCls).toBe('result-active');
  });

  it('★回帰: discontinued 未指定（既存呼び出し）は従来どおり「…」(誤動作しない)', () => {
    const r = resolveHistoryFinishStatus({ isCurrentJob: false, isPaused: false, printfinish: null });
    expect(r.finish).toBe('…');
    expect(r.finishCls).toBe('result-pending');
  });
});

describe('printfinish 確定: 印刷中ジョブを成功/失敗へ誤確定しない（再起動時 誤計上防止）', () => {
  it('parseRawHistoryEntry: 実印刷時間なし(usagetime=0)・終了時刻なし＝印刷中 → null（K1の早すぎるresult=0も無視）', () => {
    // ★ K1 は履歴再取得で印刷中エントリに printfinish=0 を付けて寄越す。完了シグナル
    //   (usagetime>0 / endtime>0) が無ければ、明示 0 でも信頼せず null(未確定)にする。
    const e = parseRawHistoryEntry({ id: 1781000002, filename: '/x/a.gcode', starttime: 1781000002, usagetime: 0, printfinish: 0 }, '', 'K1Max');
    expect(e.printfinish).toBeNull();
  });

  it('parseRawHistoryEntry: 実印刷時間あり(usagetime>0)・終了時刻なし＝K1完了とみなし成否確定（明示なし→1）', () => {
    // K1 完了ジョブは endtime を持たず usagetime>0。これは未完了ではなく完了扱い。
    const e = parseRawHistoryEntry({ id: 1781000001, filename: 'a', starttime: 1781000001, usagetime: 600 }, '', 'K1Max');
    expect(e.printfinish).toBe(1);
  });

  it('parseRawHistoryEntry: 終了済み(endtime>0)で明示printfinishなし → usagetimeから成否推測', () => {
    const ok = parseRawHistoryEntry({ id: 3, filename: 'a', starttime: 100, endtime: 700, usagetime: 600 }, '', 'h');
    expect(ok.printfinish).toBe(1);
  });

  it('parseRawHistoryEntry: 明示printfinishは最優先（0=失敗を保持）', () => {
    const ng = parseRawHistoryEntry({ id: 4, filename: 'a', starttime: 100, endtime: 700, usagetime: 600, printfinish: 0 }, '', 'h');
    expect(ng.printfinish).toBe(0);
  });

  it('jobsToRaw: printfinish=null のジョブは finishTime があっても null のまま（成功へ昇格しない）', () => {
    const raw = jobsToRaw([{
      id: 5, filename: 'a', startTime: new Date(1781000001 * 1000).toISOString(),
      finishTime: new Date(1781000601 * 1000).toISOString(), // 派生終了時刻があっても
      printfinish: null,
    }])[0];
    expect(raw.printfinish).toBeNull();
  });

  it('jobsToRaw: 明示printfinish=1/0(終了時刻あり) はそのまま', () => {
    const fin = new Date(1e12 + 3600000).toISOString();
    const r1 = jobsToRaw([{ id: 6, filename: 'a', startTime: new Date(1e12).toISOString(), finishTime: fin, printfinish: 1 }])[0];
    const r0 = jobsToRaw([{ id: 7, filename: 'a', startTime: new Date(1e12).toISOString(), finishTime: fin, printfinish: 0 }])[0];
    expect(r1.printfinish).toBe(1);
    expect(r0.printfinish).toBe(0);
  });

  it('jobsToRaw: 終了時刻なし(印刷中)は保存値が0/1でも表示で null へ矯正', () => {
    // ストアに誤って printfinish=0 が残っていても、finishTime が無ければ描画で未確定にする
    const raw = jobsToRaw([{ id: 8, filename: 'a', startTime: new Date(1e12).toISOString(), finishTime: null, printfinish: 0 }])[0];
    expect(raw.printfinish).toBeNull();
  });

  it('★jobsToRaw: discontinued=true を描画用 raw へ引き継ぐ（中止表示の前提）', () => {
    const raw = jobsToRaw([{ id: 8, filename: 'a', startTime: new Date(1e12).toISOString(), finishTime: null, discontinued: true }])[0];
    expect(raw.discontinued).toBe(true);
    expect(raw.printfinish, '中止でも printfinish は破壊しない=null のまま').toBeNull();
  });

  it('★jobsToRaw: discontinued でないジョブには discontinued キーを付けない', () => {
    const raw = jobsToRaw([{ id: 8, filename: 'a', startTime: new Date(1e12).toISOString(), finishTime: null }])[0];
    expect('discontinued' in raw).toBe(false);
  });

  it('updateHistoryList: 終了時刻なしの印刷中ジョブは履歴に0/1が来てもnullへ正規化（K1誤計上の根治・タイミング非依存）', () => {
    const HOST = 'K1Max-INPROG';
    const CURID = 1781739950;
    _dataMock.monitorData.machines[HOST] = {
      runtimeData: { state: 1 }, historyData: [], printStore: { history: [] }, storedData: {},
    };
    // ★ 既存ストアに誤確定済みの印刷中エントリ(printfinish=0, finishTime=null)が残っている状況
    _storageMock.loadPrintHistory.mockReturnValue([
      { id: CURID, filename: '/x/cur.gcode', startTime: new Date(CURID * 1000).toISOString(), finishTime: null, printfinish: 0 },
    ]);
    _storageMock.loadPrintVideos.mockReturnValue([]);
    _storageMock.loadPrintCurrent.mockReturnValue(null);
    _storageMock.savePrintHistory.mockClear();

    // K1 が印刷中エントリに早すぎる printfinish=0 / usagetime=0 を寄越し、マージが旧0を復元しても…
    updateHistoryList(
      [{ id: CURID, filename: '/x/cur.gcode', starttime: CURID, usagetime: 0, printfinish: 0 }],
      'http://127.0.0.1', 'print-current-container', HOST
    );

    const saved = _storageMock.savePrintHistory.mock.calls.at(-1)?.[0] || [];
    const cur = saved.find(j => String(j.id) === String(CURID));
    expect(cur, '現在ジョブが保存されている').toBeTruthy();
    expect(cur.finishTime == null, '終了時刻なし(印刷中)').toBe(true);
    expect(cur.printfinish, '終了時刻なし=未完了 → null へ正規化（誤計上しない）').toBeNull();
  });

  it('★T-FIL-06(P1-2): updateHistoryList は色のみ incoming で既存 spoolId/usedMm を消さない', () => {
    const HOST = 'K1Max-FIL';
    const JID = 1700009999;
    _dataMock.monitorData.machines[HOST] = {
      runtimeData: { state: 0 }, historyData: [], printStore: { history: [] }, storedData: {},
    };
    // 既存ストア: 分割済み per-reel（OLD/NEW の usedMm 付き）
    _storageMock.loadPrintHistory.mockReturnValue([
      {
        id: JID, filename: '/x/split.gcode',
        startTime: new Date(JID * 1000).toISOString(),
        finishTime: new Date((JID + 3600) * 1000).toISOString(), printfinish: 1,
        filamentInfo: [{ spoolId: 'OLD', usedMm: 300000 }, { spoolId: 'NEW', usedMm: 25000 }],
      },
    ]);
    _storageMock.loadPrintVideos.mockReturnValue([]);
    _storageMock.loadPrintCurrent.mockReturnValue(null);
    _storageMock.savePrintHistory.mockClear();

    // プリンタ由来の薄い履歴（色のみ・spoolId なし）が同一IDで再取得される
    updateHistoryList(
      [{
        id: JID, filename: '/x/split.gcode', starttime: JID, usagetime: 3600, printfinish: 1,
        filamentInfo: [{ filamentColor: '#fff' }],
      }],
      'http://127.0.0.1', 'print-current-container', HOST
    );

    const saved = _storageMock.savePrintHistory.mock.calls.at(-1)?.[0] || [];
    const j = saved.find(x => String(x.id) === String(JID));
    const byId = Object.fromEntries((j.filamentInfo || []).filter(e => e.spoolId).map(e => [e.spoolId, e]));
    expect(byId.OLD?.usedMm, 'OLD の usedMm は保持').toBe(300000);
    expect(byId.NEW?.usedMm, 'NEW の usedMm は保持').toBe(25000);
  });
});

// =====================================================================
// 中止検知: 非最新のまま放置された印刷中(未確定)ジョブへ discontinued を付与
//   - printfinish は破壊しない（null のまま＝stats 集計対象外）＝非破壊
//   - 後続(より新しい id)が存在するジョブのみ中止扱い＝最新/稼働中は保護
// =====================================================================
describe('updateHistoryList — 放置印刷中ジョブの中止検知(discontinued, 非破壊)', () => {
  beforeEach(() => {
    _aggMock.getCurrentPrintID.mockReset();
    _storageMock.savePrintHistory.mockClear();
    _storageMock.loadPrintVideos.mockReturnValue([]);
    _storageMock.loadPrintCurrent.mockReturnValue(null);
  });

  /** 共通: ホストを用意し、与えた既存履歴で updateHistoryList を一巡させて保存結果を返す */
  function runMerge(host, oldHistory, incomingRaw = [], curId = null) {
    _dataMock.monitorData.machines[host] = {
      runtimeData: { state: 0 }, historyData: [], printStore: { history: [] }, storedData: {},
    };
    _storageMock.loadPrintHistory.mockReturnValue(oldHistory);
    _aggMock.getCurrentPrintID.mockReturnValue(curId);
    updateHistoryList(incomingRaw, 'http://127.0.0.1', 'print-current-container', host);
    return _storageMock.savePrintHistory.mock.calls.at(-1)?.[0] || [];
  }

  it('★非最新の印刷中(未確定)ジョブに discontinued=true を付与（printfinish は null のまま）', () => {
    const HOST = 'K1-ABORT-1';
    // 旧(100): 印刷中のまま放置 / 新(200): 完了済み → 旧は継続されていない＝中止確定
    const saved = runMerge(HOST, [
      { id: 100, filename: '/x/old.gcode', startTime: new Date(100e3).toISOString(), finishTime: null, printfinish: null },
      { id: 200, filename: '/x/new.gcode', startTime: new Date(200e3).toISOString(), finishTime: new Date(260e3).toISOString(), printfinish: 1 },
    ]);
    const old = saved.find(j => String(j.id) === '100');
    expect(old.discontinued, '非最新の放置印刷中 → 中止確定').toBe(true);
    expect(old.printfinish, '破壊的に 0(失敗) へ書き換えない（非破壊・null 維持）').toBeNull();
    expect(old.finishTime, '終了時刻も捏造しない').toBeNull();
  });

  it('★最新(=id 最大)の印刷中ジョブは保護＝中止にしない（再開報告待ちの可能性）', () => {
    const HOST = 'K1-ABORT-2';
    const saved = runMerge(HOST, [
      { id: 300, filename: '/x/latest.gcode', startTime: new Date(300e3).toISOString(), finishTime: null, printfinish: null },
      { id: 100, filename: '/x/old.gcode', startTime: new Date(100e3).toISOString(), finishTime: new Date(160e3).toISOString(), printfinish: 1 },
    ]);
    const latest = saved.find(j => String(j.id) === '300');
    expect(latest.discontinued, '最新ジョブは中止にしない').toBeFalsy();
  });

  it('★稼働中ジョブ(currentPrintID 一致)は非最新でも保護＝中止にしない', () => {
    const HOST = 'K1-ABORT-3';
    // currentPrintID=100（稼働中）かつ後続 200 が存在しても、稼働中ジョブは守る
    const saved = runMerge(HOST, [
      { id: 100, filename: '/x/cur.gcode', startTime: new Date(100e3).toISOString(), finishTime: null, printfinish: null },
      { id: 200, filename: '/x/new.gcode', startTime: new Date(200e3).toISOString(), finishTime: null, printfinish: null },
    ], [], 100);
    const cur = saved.find(j => String(j.id) === '100');
    expect(cur.discontinued, '稼働中(currentPrintID)は保護').toBeFalsy();
  });

  it('★完了済みジョブは中止対象外（finishTime あり=未確定ではない）', () => {
    const HOST = 'K1-ABORT-4';
    const saved = runMerge(HOST, [
      { id: 100, filename: '/x/done.gcode', startTime: new Date(100e3).toISOString(), finishTime: new Date(160e3).toISOString(), printfinish: 1 },
      { id: 200, filename: '/x/new.gcode', startTime: new Date(200e3).toISOString(), finishTime: new Date(260e3).toISOString(), printfinish: 1 },
    ]);
    const done = saved.find(j => String(j.id) === '100');
    expect(done.discontinued, '完了済みは中止扱いしない').toBeFalsy();
  });

  it('★自己修復: 一度 discontinued でも後から完了報告(finishTime)が来れば自動解除', () => {
    const HOST = 'K1-ABORT-5';
    // 旧ストアに discontinued=true が残るが、今回 finishTime が確定 → 解除される
    const saved = runMerge(HOST, [
      { id: 100, filename: '/x/late.gcode', startTime: new Date(100e3).toISOString(),
        finishTime: new Date(160e3).toISOString(), printfinish: 1, discontinued: true },
      { id: 200, filename: '/x/new.gcode', startTime: new Date(200e3).toISOString(),
        finishTime: new Date(260e3).toISOString(), printfinish: 1 },
    ]);
    const healed = saved.find(j => String(j.id) === '100');
    expect('discontinued' in healed, '完了報告で discontinued は除去される').toBe(false);
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
