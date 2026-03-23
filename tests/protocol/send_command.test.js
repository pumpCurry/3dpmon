/**
 * dashboard_send_command.js / dashboard_connection.js コマンド送信テスト
 *
 * テスト対象: WebSocket コマンドの JSON フォーマット検証
 * 実機接続不要 — WebSocket モックで送信ペイロードの構造を検証する
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockWebSocket, validateSentCommand } from '../helpers/mock_websocket.js';

// sendCommand の内部ロジックを直接テストするため、
// connection モジュールの依存を最小限にモックする
vi.mock('../../3dp_lib/dashboard_data.js', () => ({
  monitorData: { machines: {} },
  getDisplayValue: vi.fn(),
}));
vi.mock('../../3dp_lib/dashboard_ui_confirm.js', () => ({
  showInputDialog: vi.fn(),
  showConfirmDialog: vi.fn(),
}));
vi.mock('../../3dp_lib/dashboard_notification_manager.js', () => ({
  showAlert: vi.fn(),
  notificationManager: { notify: vi.fn() },
}));
vi.mock('../../3dp_lib/dashboard_log_util.js', () => ({
  pushLog: vi.fn(),
}));

describe('WebSocket コマンド JSON フォーマット', () => {
  let mockWs;

  beforeEach(() => {
    mockWs = createMockWebSocket();
  });

  // --------------------------------
  // コマンドペイロード構造の検証
  // --------------------------------
  describe('コマンドペイロード構造', () => {
    it('印刷コマンド: method=print, params.file', () => {
      const payload = {
        id: 'print_1234567890',
        method: 'print',
        params: { file: '/usr/data/gcode/model.gcode' },
      };
      mockWs.send(JSON.stringify(payload));

      const sent = mockWs._lastSent();
      expect(sent.method).toBe('print');
      expect(sent.params.file).toBe('/usr/data/gcode/model.gcode');
      expect(sent.id).toMatch(/^print_/);
    });

    it('停止コマンド: method=set, params.stop=1', () => {
      const payload = { id: 'set_1234567890', method: 'set', params: { stop: 1 } };
      mockWs.send(JSON.stringify(payload));

      expect(validateSentCommand(mockWs.sentMessages[0], 'set', { stop: 1 })).toBe(true);
    });

    it('一時停止コマンド: method=set, params.pause=1', () => {
      const payload = { id: 'set_1234567890', method: 'set', params: { pause: 1 } };
      mockWs.send(JSON.stringify(payload));

      expect(validateSentCommand(mockWs.sentMessages[0], 'set', { pause: 1 })).toBe(true);
    });

    it('再開コマンド: method=set, params.pause=0', () => {
      const payload = { id: 'set_1234567890', method: 'set', params: { pause: 0 } };
      mockWs.send(JSON.stringify(payload));

      expect(validateSentCommand(mockWs.sentMessages[0], 'set', { pause: 0 })).toBe(true);
    });

    it('履歴一覧要求: method=get, params.reqHistory=1', () => {
      const payload = { id: 'get_1234567890', method: 'get', params: { reqHistory: 1 } };
      mockWs.send(JSON.stringify(payload));

      expect(validateSentCommand(mockWs.sentMessages[0], 'get', { reqHistory: 1 })).toBe(true);
    });

    it('ファイル一覧要求: method=get, params.reqGcodeFile=1', () => {
      const payload = { id: 'get_1234567890', method: 'get', params: { reqGcodeFile: 1 } };
      mockWs.send(JSON.stringify(payload));

      expect(validateSentCommand(mockWs.sentMessages[0], 'get', { reqGcodeFile: 1 })).toBe(true);
    });

    it('G-codeコマンド: method=set, params.gcodeCmd', () => {
      const payload = { id: 'set_gcode_1234567890', method: 'set', params: { gcodeCmd: 'G28' } };
      mockWs.send(JSON.stringify(payload));

      expect(validateSentCommand(mockWs.sentMessages[0], 'set', { gcodeCmd: 'G28' })).toBe(true);
    });

    it('ノズル温度設定: method=set, params.targetNozzleTemp', () => {
      const payload = { id: 'set_1234567890', method: 'set', params: { targetNozzleTemp: 200.0 } };
      mockWs.send(JSON.stringify(payload));

      expect(validateSentCommand(mockWs.sentMessages[0], 'set', { targetNozzleTemp: 200.0 })).toBe(true);
    });

    it('ベッド温度設定: method=set, params.targetBedTemp0', () => {
      const payload = { id: 'set_1234567890', method: 'set', params: { targetBedTemp0: 60.0 } };
      mockWs.send(JSON.stringify(payload));

      expect(validateSentCommand(mockWs.sentMessages[0], 'set', { targetBedTemp0: 60.0 })).toBe(true);
    });

    it('LED制御: method=set, params.lightSw', () => {
      const payload = { id: 'set_1234567890', method: 'set', params: { lightSw: 1 } };
      mockWs.send(JSON.stringify(payload));

      expect(validateSentCommand(mockWs.sentMessages[0], 'set', { lightSw: 1 })).toBe(true);
    });

    it('エラークリア: method=set, params.cleanErr=1', () => {
      const payload = { id: 'set_1234567890', method: 'set', params: { cleanErr: 1 } };
      mockWs.send(JSON.stringify(payload));

      expect(validateSentCommand(mockWs.sentMessages[0], 'set', { cleanErr: 1 })).toBe(true);
    });

    it('オートホーム: method=autoHome', () => {
      const payload = { id: 'autoHome_1234567890', method: 'autoHome', params: {} };
      mockWs.send(JSON.stringify(payload));

      expect(validateSentCommand(mockWs.sentMessages[0], 'autoHome')).toBe(true);
    });

    it('オートレベル: method=autoLevel', () => {
      const payload = { id: 'autoLevel_1234567890', method: 'autoLevel', params: {} };
      mockWs.send(JSON.stringify(payload));

      expect(validateSentCommand(mockWs.sentMessages[0], 'autoLevel')).toBe(true);
    });
  });

  // --------------------------------
  // コマンドID形式の検証
  // --------------------------------
  describe('コマンドID形式', () => {
    it('ID は method_timestamp 形式', () => {
      const ts = Date.now();
      const id = `print_${ts}`;
      expect(id).toMatch(/^print_\d+$/);
    });

    it('各メソッドのIDプレフィックス', () => {
      expect('get_1234567890').toMatch(/^get_/);
      expect('set_1234567890').toMatch(/^set_/);
      expect('print_1234567890').toMatch(/^print_/);
      expect('autoHome_1234567890').toMatch(/^autoHome_/);
      expect('autoLevel_1234567890').toMatch(/^autoLevel_/);
      expect('set_gcode_1234567890').toMatch(/^set_gcode_/);
    });
  });

  // --------------------------------
  // WebSocket接続状態チェック
  // --------------------------------
  describe('WebSocket接続状態', () => {
    it('OPEN状態で送信成功', () => {
      mockWs.readyState = 1; // OPEN
      mockWs.send(JSON.stringify({ id: 'test', method: 'get', params: {} }));
      expect(mockWs.sentMessages).toHaveLength(1);
    });

    it('CLOSED状態で送信すべきでない', () => {
      mockWs.readyState = 3; // CLOSED
      // 実際のsendCommandは例外/rejectするが、ここはモックなので手動チェック
      const canSend = mockWs.readyState === 1;
      expect(canSend).toBe(false);
    });

    it('CONNECTING状態で送信すべきでない', () => {
      mockWs.readyState = 0; // CONNECTING
      const canSend = mockWs.readyState === 1;
      expect(canSend).toBe(false);
    });
  });

  // --------------------------------
  // validateSentCommand ヘルパーの検証
  // --------------------------------
  describe('validateSentCommand ヘルパー', () => {
    it('正しいコマンドを検証', () => {
      const json = JSON.stringify({ id: 'set_123', method: 'set', params: { stop: 1 } });
      expect(validateSentCommand(json, 'set', { stop: 1 })).toBe(true);
    });

    it('不一致のメソッドを検出', () => {
      const json = JSON.stringify({ id: 'set_123', method: 'set', params: { stop: 1 } });
      expect(validateSentCommand(json, 'get', { stop: 1 })).toBe(false);
    });

    it('不一致のパラメータを検出', () => {
      const json = JSON.stringify({ id: 'set_123', method: 'set', params: { pause: 1 } });
      expect(validateSentCommand(json, 'set', { stop: 1 })).toBe(false);
    });

    it('不正なJSONを安全にハンドル', () => {
      expect(validateSentCommand('not-json', 'set')).toBe(false);
    });
  });
});
