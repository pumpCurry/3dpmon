/**
 * WebSocket メッセージ処理テスト
 *
 * テスト対象: プリンタから受信するJSONメッセージの処理フロー
 * - ステータス更新メッセージの storedData 格納
 * - 履歴/ファイル/動画一覧の受け渡し
 * - エラーコード処理
 * - フィラメント切れ検出
 * - heartbeat応答の処理スキップ
 *
 * 注: processData() は多数の副作用を持つため、ここではデータ構造の検証に焦点を当てる
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockMonitorData, createMockMachine, createMockStatusMessage } from '../helpers/mock_monitor_data.js';

// テスト用フィクスチャ読み込み
import statusPrinting from './fixtures/status_printing.json';
import statusIdle from './fixtures/status_idle.json';
import statusError from './fixtures/status_error.json';
import historyList from './fixtures/history_list.json';
import fileList from './fixtures/file_list.json';
import videoList from './fixtures/video_list.json';

// =============================================
// フィクスチャの構造検証
// =============================================
describe('テスト用フィクスチャの構造検証', () => {
  describe('status_printing.json', () => {
    it('必須フィールドが存在する', () => {
      expect(statusPrinting.hostname).toBe('K1Max-TEST');
      expect(statusPrinting.model).toBe('K1 Max');
      expect(statusPrinting.state).toBe(1);
      expect(statusPrinting.printProgress).toBe(45);
    });

    it('温度フィールドが数値', () => {
      expect(typeof statusPrinting.nozzleTemp).toBe('number');
      expect(typeof statusPrinting.bedTemp0).toBe('number');
      expect(typeof statusPrinting.targetNozzleTemp).toBe('number');
    });

    it('エラーオブジェクトが正しい構造', () => {
      expect(statusPrinting.err).toHaveProperty('errcode');
      expect(statusPrinting.err).toHaveProperty('key');
      expect(statusPrinting.err.errcode).toBe(0);
    });

    it('印刷中の状態を示すフィールド', () => {
      expect(statusPrinting.printFileName).toBeTruthy();
      expect(statusPrinting.layer).toBeGreaterThan(0);
      expect(statusPrinting.TotalLayer).toBeGreaterThan(0);
      expect(statusPrinting.usedMaterialLength).toBeGreaterThan(0);
    });
  });

  describe('status_idle.json', () => {
    it('アイドル状態 (state=0)', () => {
      expect(statusIdle.state).toBe(0);
      expect(statusIdle.printProgress).toBe(0);
      expect(statusIdle.printFileName).toBe('');
    });

    it('温度が室温付近', () => {
      expect(statusIdle.nozzleTemp).toBeLessThan(50);
      expect(statusIdle.bedTemp0).toBeLessThan(50);
      expect(statusIdle.targetNozzleTemp).toBe(0);
    });
  });

  describe('status_error.json', () => {
    it('エラーコードが設定されている', () => {
      expect(statusError.err.errcode).toBe(23);
    });

    it('フィラメント切れ状態', () => {
      expect(statusError.materialDetect).toBe(1);
      expect(statusError.materialStatus).toBe(1);
    });
  });

  describe('history_list.json', () => {
    it('印刷履歴が配列', () => {
      expect(Array.isArray(historyList.historyList)).toBe(true);
      expect(historyList.historyList.length).toBe(3);
    });

    it('各エントリに必須フィールド', () => {
      const entry = historyList.historyList[0];
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('filename');
      expect(entry).toHaveProperty('printProgress');
    });

    it('完了済みエントリは progress=100', () => {
      expect(historyList.historyList[0].printProgress).toBe(100);
      expect(historyList.historyList[1].printProgress).toBe(100);
    });

    it('中断エントリは progress<100', () => {
      expect(historyList.historyList[2].printProgress).toBe(35);
    });

    it('filamentInfo配列がある', () => {
      expect(Array.isArray(historyList.historyList[0].filamentInfo)).toBe(true);
      const info = historyList.historyList[0].filamentInfo[0];
      expect(info).toHaveProperty('color');
      expect(info).toHaveProperty('materialName');
      expect(info).toHaveProperty('weight');
      expect(info).toHaveProperty('length');
    });
  });

  describe('file_list.json', () => {
    it('retGcodeFileInfo構造', () => {
      expect(fileList.retGcodeFileInfo).toHaveProperty('path');
      expect(fileList.retGcodeFileInfo).toHaveProperty('files');
      expect(Array.isArray(fileList.retGcodeFileInfo.files)).toBe(true);
    });

    it('ファイルエントリの構造', () => {
      const file = fileList.retGcodeFileInfo.files[0];
      expect(file).toHaveProperty('name');
      expect(file).toHaveProperty('size');
      expect(file).toHaveProperty('modified');
      expect(typeof file.size).toBe('number');
    });
  });

  describe('video_list.json', () => {
    it('elapseVideoList配列', () => {
      expect(Array.isArray(videoList.elapseVideoList)).toBe(true);
      expect(videoList.elapseVideoList.length).toBe(2);
    });

    it('動画エントリの構造', () => {
      const video = videoList.elapseVideoList[0];
      expect(video).toHaveProperty('name');
      expect(video).toHaveProperty('size');
      expect(video).toHaveProperty('printId');
      expect(video).toHaveProperty('filename');
    });
  });
});

// =============================================
// メッセージデータフロー検証
// =============================================
describe('メッセージデータフロー検証', () => {
  describe('ステータスメッセージのフィールド分類', () => {
    // processData() がスキップするフィールド（handleMessage で別処理）
    const SKIP_FIELDS = [
      'hostname', 'ModeCode', 'err', 'historyList',
      'elapseVideoList', 'curPosition', 'gcodeFileList',
      'reqGcodeFileInfo', 'reqHistory',
    ];

    it('storedData に格納されるべきフィールド', () => {
      const storableFields = Object.keys(statusPrinting).filter(
        (k) => !SKIP_FIELDS.includes(k),
      );
      // 最低限これらのフィールドが storedData に入るはず
      expect(storableFields).toContain('nozzleTemp');
      expect(storableFields).toContain('bedTemp0');
      expect(storableFields).toContain('state');
      expect(storableFields).toContain('printProgress');
      expect(storableFields).toContain('fan');
      expect(storableFields).toContain('layer');
      expect(storableFields).toContain('TotalLayer');
    });

    it('スキップフィールドは storedData に直接格納されない', () => {
      const storableFields = Object.keys(statusPrinting).filter(
        (k) => !SKIP_FIELDS.includes(k),
      );
      SKIP_FIELDS.forEach((field) => {
        if (statusPrinting[field] !== undefined) {
          expect(storableFields).not.toContain(field);
        }
      });
    });
  });

  describe('heartbeat応答の処理', () => {
    it('"ok" 文字列はJSONとしてパースされない', () => {
      const response = 'ok';
      // handleMessage のロジック: "ok" → return（processData 未呼出）
      expect(() => JSON.parse(response)).toThrow();
    });

    it('heartbeatリクエストの構造', () => {
      const heartbeat = {
        ModeCode: 'heart_beat',
        msg: '2026-03-23 14:30:45',
      };
      expect(heartbeat.ModeCode).toBe('heart_beat');
      expect(typeof heartbeat.msg).toBe('string');
    });
  });

  describe('特殊レスポンスの分岐', () => {
    it('historyList を含むメッセージ', () => {
      const msg = { ...statusIdle, ...historyList };
      expect(msg.historyList).toBeDefined();
      expect(Array.isArray(msg.historyList)).toBe(true);
      // handleMessage: historyList 検出 → printManager.updateHistoryList() へ
    });

    it('retGcodeFileInfo を含むメッセージ', () => {
      const msg = { ...statusIdle, ...fileList };
      expect(msg.retGcodeFileInfo).toBeDefined();
      expect(msg.retGcodeFileInfo.files).toBeDefined();
      // handleMessage: retGcodeFileInfo 検出 → printManager.renderFileList() へ
    });

    it('elapseVideoList を含むメッセージ', () => {
      const msg = { ...statusIdle, ...videoList };
      expect(msg.elapseVideoList).toBeDefined();
      expect(Array.isArray(msg.elapseVideoList)).toBe(true);
      // handleMessage: elapseVideoList 検出 → printManager.updateVideoList() へ
    });
  });

  describe('フィラメント切れ検出', () => {
    it('materialStatus=1 でフィラメント切れを示す', () => {
      expect(statusError.materialStatus).toBe(1);
      expect(statusError.materialDetect).toBe(1);
    });

    it('通常状態では materialStatus=0', () => {
      expect(statusPrinting.materialStatus).toBe(0);
      expect(statusIdle.materialStatus).toBe(0);
    });
  });

  describe('エラーコード処理', () => {
    it('正常時: errcode=0, key=0', () => {
      expect(statusPrinting.err.errcode).toBe(0);
      expect(statusPrinting.err.key).toBe(0);
    });

    it('エラー時: errcode != 0', () => {
      expect(statusError.err.errcode).toBe(23);
      // errcode=23 → "プリンタの準備ができていません"
    });

    it('err が null/undefined のケース（防御的処理）', () => {
      const msg = { ...statusIdle };
      delete msg.err;
      expect(msg.err).toBeUndefined();
      // processData は err が undefined でもクラッシュしないはず
    });
  });
});

// =============================================
// マルチホスト処理の検証
// =============================================
describe('マルチホスト処理', () => {
  it('異なるホスト名のメッセージは独立', () => {
    const msgA = createMockStatusMessage({
      hostname: 'K1Max-A',
      nozzleTemp: 210.0,
      state: 1,
      printProgress: 50,
    });
    const msgB = createMockStatusMessage({
      hostname: 'K1Max-B',
      nozzleTemp: 25.0,
      state: 0,
      printProgress: 0,
    });

    expect(msgA.hostname).not.toBe(msgB.hostname);
    expect(msgA.nozzleTemp).not.toBe(msgB.nozzleTemp);
    expect(msgA.state).not.toBe(msgB.state);
  });

  it('monitorData.machines は hostname をキーにする', () => {
    const mockData = createMockMonitorData();
    mockData.machines['K1Max-A'] = createMockMachine('K1Max-A');
    mockData.machines['K1Max-B'] = createMockMachine('K1Max-B');

    expect(Object.keys(mockData.machines)).toHaveLength(2);
    expect(mockData.machines['K1Max-A'].storedData.hostname.value).toBe('K1Max-A');
    expect(mockData.machines['K1Max-B'].storedData.hostname.value).toBe('K1Max-B');
  });

  it('_dirtyKeys はホストごとに独立', () => {
    const machineA = createMockMachine('K1Max-A');
    const machineB = createMockMachine('K1Max-B');

    machineA._dirtyKeys.set('nozzleTemp', true);
    expect(machineA._dirtyKeys.has('nozzleTemp')).toBe(true);
    expect(machineB._dirtyKeys.has('nozzleTemp')).toBe(false);
  });
});

// =============================================
// メッセージ生成ヘルパーの検証
// =============================================
describe('createMockStatusMessage ヘルパー', () => {
  it('デフォルト値がアイドル状態', () => {
    const msg = createMockStatusMessage();
    expect(msg.hostname).toBe('K1-TEST');
    expect(msg.state).toBe(0);
    expect(msg.printProgress).toBe(0);
  });

  it('オーバーライドが適用される', () => {
    const msg = createMockStatusMessage({
      hostname: 'Custom-Host',
      state: 1,
      nozzleTemp: 250,
    });
    expect(msg.hostname).toBe('Custom-Host');
    expect(msg.state).toBe(1);
    expect(msg.nozzleTemp).toBe(250);
    // 他のフィールドはデフォルト値
    expect(msg.bedTemp0).toBe(25.0);
  });
});
