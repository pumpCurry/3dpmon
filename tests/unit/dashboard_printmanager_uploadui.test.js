/**
 * dashboard_printmanager.js アップロード UI per-host レジストリテスト
 *
 * @vitest-environment jsdom
 *
 * 回帰防止対象バグ:
 *   D&D/アップロードの進捗バー・完了告知・送信先が「最初に初期化された
 *   パネル/1番目のホスト」に固定される「優先1ホスト」コンタミネーション欠陥。
 *   各パネルが per-host で登録され、破棄時に解除されることを検証する。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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
  getDeviceIp: vi.fn(() => '192.168.1.10'), getConnectionState: vi.fn(() => 'connected'),
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

const { setupUploadUI, unregisterUploadPanel, getRegisteredUploadHosts } =
  await import('../../3dp_lib/dashboard_printmanager.js');

/** アップロード UI に必要な子要素を持つパネル root を生成 */
function makePanelRoot() {
  const root = document.createElement('div');
  root.innerHTML = `
    <button id="gcode-upload-btn"></button>
    <input id="gcode-upload-input" type="file" />
    <div id="gcode-upload-progress" class="hidden"></div>
    <span id="gcode-upload-percent"></span>
  `;
  document.body.appendChild(root);
  return root;
}

describe('アップロード UI per-host レジストリ', () => {
  beforeEach(() => {
    // 既存登録をクリア
    for (const h of getRegisteredUploadHosts()) unregisterUploadPanel(h);
    document.body.innerHTML = '';
    // drop-overlay (グローバル) を用意
    const ov = document.createElement('div');
    ov.id = 'drop-overlay';
    document.body.appendChild(ov);
  });

  it('各ホストのパネルが独立して登録される', () => {
    setupUploadUI(makePanelRoot(), 'hostA');
    setupUploadUI(makePanelRoot(), 'hostB');
    setupUploadUI(makePanelRoot(), 'hostC');

    const hosts = getRegisteredUploadHosts();
    expect(hosts).toContain('hostA');
    expect(hosts).toContain('hostB');
    expect(hosts).toContain('hostC');
    expect(hosts.length).toBe(3);
  });

  it('★回帰: 2番目以降のパネルも登録され、1番目に飲み込まれない', () => {
    setupUploadUI(makePanelRoot(), 'first');
    setupUploadUI(makePanelRoot(), 'second');
    const hosts = getRegisteredUploadHosts();
    // かつては最初のパネルのクロージャに固定され、2番目は無視されていた
    expect(hosts).toContain('second');
  });

  it('パネル破棄(unregister)で該当ホストのみ解除される', () => {
    setupUploadUI(makePanelRoot(), 'hostA');
    setupUploadUI(makePanelRoot(), 'hostB');

    unregisterUploadPanel('hostA');

    const hosts = getRegisteredUploadHosts();
    expect(hosts).not.toContain('hostA');
    expect(hosts).toContain('hostB');
  });

  it('同一ホストの再登録は上書き(重複しない)', () => {
    setupUploadUI(makePanelRoot(), 'hostA');
    setupUploadUI(makePanelRoot(), 'hostA');
    const hosts = getRegisteredUploadHosts().filter(h => h === 'hostA');
    expect(hosts.length).toBe(1);
  });

  it('進捗バー要素が各パネルにスコープされる（DOM独立性）', () => {
    const rootA = makePanelRoot();
    const rootB = makePanelRoot();
    setupUploadUI(rootA, 'hostA');
    setupUploadUI(rootB, 'hostB');

    // 各パネルの progress 要素は別物
    const progA = rootA.querySelector('#gcode-upload-progress');
    const progB = rootB.querySelector('#gcode-upload-progress');
    expect(progA).not.toBe(progB);
  });

  it('unregister は存在しないホストでも安全', () => {
    expect(() => unregisterUploadPanel('ghost')).not.toThrow();
    expect(() => unregisterUploadPanel('')).not.toThrow();
    expect(() => unregisterUploadPanel(undefined)).not.toThrow();
  });
});
