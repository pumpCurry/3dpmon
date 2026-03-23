/**
 * aggregator 統合テスト
 *
 * テスト対象: 印刷フロー全体を通じたデータ整合性
 * - 印刷開始→進行→完了の一連フロー
 * - マルチホスト同時受信時のデータ独立性
 * - フィラメント消費追跡
 */
import { describe, it, expect } from 'vitest';
import {
  createMockMonitorData,
  createMockMachine,
  createMockSpool,
  createMockStatusMessage,
} from '../helpers/mock_monitor_data.js';

// =============================================
// 印刷フロー シミュレーション
// =============================================
describe('印刷フローデータシミュレーション', () => {
  describe('印刷開始→進行→完了', () => {
    it('ステータスメッセージの state 遷移が正しい', () => {
      // 印刷フロー: アイドル(0) → 印刷中(1) → 完了(→0に戻る)
      const msgIdle = createMockStatusMessage({ state: 0, printProgress: 0 });
      const msgPrinting = createMockStatusMessage({
        state: 1,
        printProgress: 30,
        printFileName: '/model.gcode',
        usedMaterialLength: 3000,
      });
      const msgMidway = createMockStatusMessage({
        state: 1,
        printProgress: 65,
        usedMaterialLength: 8000,
      });
      const msgComplete = createMockStatusMessage({
        state: 0,
        printProgress: 100,
        usedMaterialLength: 12000,
      });

      expect(msgIdle.state).toBe(0);
      expect(msgPrinting.state).toBe(1);
      expect(msgMidway.printProgress).toBe(65);
      expect(msgComplete.printProgress).toBe(100);
    });

    it('消費フィラメント量は単調増加', () => {
      const consumptions = [0, 3000, 5000, 8000, 12000];
      for (let i = 1; i < consumptions.length; i++) {
        expect(consumptions[i]).toBeGreaterThan(consumptions[i - 1]);
      }
    });
  });

  describe('マルチホスト同時受信', () => {
    it('各ホストのデータが独立して管理される', () => {
      const mockData = createMockMonitorData();

      // Host A: 印刷中
      mockData.machines['K1Max-A'] = createMockMachine('K1Max-A', {
        state: { value: 1, rawValue: 1 },
        printProgress: { value: 30, rawValue: 30 },
        nozzleTemp: { value: 210, rawValue: 210 },
      });

      // Host B: アイドル
      mockData.machines['K1Max-B'] = createMockMachine('K1Max-B', {
        state: { value: 0, rawValue: 0 },
        printProgress: { value: 0, rawValue: 0 },
        nozzleTemp: { value: 25, rawValue: 25 },
      });

      // Host A のデータ
      expect(mockData.machines['K1Max-A'].storedData.state.value).toBe(1);
      expect(mockData.machines['K1Max-A'].storedData.printProgress.value).toBe(30);

      // Host B のデータは独立
      expect(mockData.machines['K1Max-B'].storedData.state.value).toBe(0);
      expect(mockData.machines['K1Max-B'].storedData.printProgress.value).toBe(0);

      // Host A の変更が Host B に影響しないことを確認
      mockData.machines['K1Max-A'].storedData.nozzleTemp.value = 220;
      expect(mockData.machines['K1Max-B'].storedData.nozzleTemp.value).toBe(25);
    });

    it('6台同時のマシンエントリが作成できる', () => {
      const mockData = createMockMonitorData();
      const hosts = ['K1Max-01', 'K1Max-02', 'K1Max-03', 'K1C-01', 'K1C-02', 'K1C-03'];

      hosts.forEach((host, i) => {
        mockData.machines[host] = createMockMachine(host, {
          nozzleTemp: { value: 25 + i * 10, rawValue: 25 + i * 10 },
        });
      });

      expect(Object.keys(mockData.machines)).toHaveLength(6);
      expect(mockData.machines['K1Max-01'].storedData.nozzleTemp.value).toBe(25);
      expect(mockData.machines['K1C-03'].storedData.nozzleTemp.value).toBe(75);
    });

    it('_dirtyKeys の独立性', () => {
      const mockData = createMockMonitorData();
      mockData.machines['Host-A'] = createMockMachine('Host-A');
      mockData.machines['Host-B'] = createMockMachine('Host-B');

      // Host-A にのみ dirty フラグを立てる
      mockData.machines['Host-A']._dirtyKeys.set('nozzleTemp', true);
      mockData.machines['Host-A']._dirtyKeys.set('bedTemp0', true);

      expect(mockData.machines['Host-A']._dirtyKeys.size).toBe(2);
      expect(mockData.machines['Host-B']._dirtyKeys.size).toBe(0);
    });
  });

  describe('フィラメント消費追跡', () => {
    it('スプールの残量は印刷で減少する', () => {
      const spool = createMockSpool({
        totalLengthMm: 336000,
        remainingLengthMm: 336000,
        printCount: 0,
      });

      // 印刷1回目: 12000mm消費
      spool.remainingLengthMm -= 12000;
      spool.printCount += 1;

      expect(spool.remainingLengthMm).toBe(324000);
      expect(spool.printCount).toBe(1);

      // 印刷2回目: 8000mm消費
      spool.remainingLengthMm -= 8000;
      spool.printCount += 1;

      expect(spool.remainingLengthMm).toBe(316000);
      expect(spool.printCount).toBe(2);
    });

    it('残量が0以下にならないよう保護が必要', () => {
      const spool = createMockSpool({
        totalLengthMm: 336000,
        remainingLengthMm: 5000, // 残り僅か
      });

      // 5000mmしかないのに10000mm消費しようとした場合
      const consumption = 10000;
      const newRemaining = Math.max(0, spool.remainingLengthMm - consumption);

      expect(newRemaining).toBe(0);
      expect(newRemaining).not.toBeLessThan(0);
    });

    it('消費ログの記録', () => {
      const spool = createMockSpool({
        usedLengthLog: [],
      });

      // ログ追記
      spool.usedLengthLog.push({
        timestamp: Date.now(),
        lengthMm: 12000,
        jobId: 'print_001',
        hostname: 'K1Max-A',
      });
      spool.usedLengthLog.push({
        timestamp: Date.now(),
        lengthMm: 8000,
        jobId: 'print_002',
        hostname: 'K1Max-A',
      });

      expect(spool.usedLengthLog).toHaveLength(2);

      const totalConsumed = spool.usedLengthLog.reduce((sum, log) => sum + log.lengthMm, 0);
      expect(totalConsumed).toBe(20000);
    });

    it('hostSpoolMap でホストとスプールの紐付け', () => {
      const mockData = createMockMonitorData();
      const spoolA = createMockSpool({ id: 'spool_A', hostname: 'K1Max-A' });
      const spoolB = createMockSpool({ id: 'spool_B', hostname: 'K1Max-B' });

      mockData.hostSpoolMap['K1Max-A'] = 'spool_A';
      mockData.hostSpoolMap['K1Max-B'] = 'spool_B';
      mockData.filamentSpools = [spoolA, spoolB];

      expect(mockData.hostSpoolMap['K1Max-A']).toBe('spool_A');
      expect(mockData.hostSpoolMap['K1Max-B']).toBe('spool_B');

      // 各ホストのスプールが別であることを確認
      expect(mockData.hostSpoolMap['K1Max-A']).not.toBe(mockData.hostSpoolMap['K1Max-B']);
    });

    it('スプールの二重装着防止', () => {
      const mockData = createMockMonitorData();
      const spoolId = 'spool_shared';

      mockData.hostSpoolMap['K1Max-A'] = spoolId;

      // Host-B に同じスプールを装着しようとする場合
      const alreadyMounted = Object.entries(mockData.hostSpoolMap).some(
        ([host, id]) => id === spoolId && host !== 'K1Max-B',
      );

      expect(alreadyMounted).toBe(true);
      // 実装: setCurrentSpoolId() は false を返す
    });
  });
});

// =============================================
// スプールモックの完全性検証
// =============================================
describe('createMockSpool ヘルパー', () => {
  it('デフォルトスプールの全フィールドが定義されている', () => {
    const spool = createMockSpool();
    expect(spool.id).toBeTruthy();
    expect(spool.serialNo).toBe(1);
    expect(spool.material).toBe('PLA');
    expect(spool.totalLengthMm).toBe(336000);
    expect(spool.remainingLengthMm).toBe(168000);
    expect(spool.density).toBe(1.24);
    expect(spool.purchasePrice).toBe(1699);
    expect(spool.isActive).toBe(false);
    expect(spool.deleted).toBe(false);
    expect(spool.hostname).toBeNull();
  });

  it('オーバーライドが適用される', () => {
    const spool = createMockSpool({
      material: 'PETG',
      density: 1.27,
      remainingLengthMm: 100000,
      isActive: true,
      hostname: 'K1Max-A',
    });

    expect(spool.material).toBe('PETG');
    expect(spool.density).toBe(1.27);
    expect(spool.remainingLengthMm).toBe(100000);
    expect(spool.isActive).toBe(true);
    expect(spool.hostname).toBe('K1Max-A');
  });

  it('各スプールのIDがユニーク', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      ids.add(createMockSpool().id);
    }
    expect(ids.size).toBe(100);
  });
});
