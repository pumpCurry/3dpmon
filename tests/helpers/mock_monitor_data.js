/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 monitorData mock helper モジュール
 * @file mock_monitor_data.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module mock_monitor_data
 *
 * 【機能内容サマリ】
 * - テスト用にmonitorData構造を再現する
 * - テスト用machine / spool / status message fixtureを生成する
 *
 * 【公開関数一覧】
 * - {@link createMockMonitorData}：monitorData mockを生成
 * - {@link createMockMachine}：machine entry mockを生成
 * - {@link createMockSpool}：spool mockを生成
 * - {@link createMockStatusMessage}：WebSocket status message mockを生成
 *
 * @version 1.390.1582 (PR #440)
 * @since   1.390.0 (Initial)
 * @lastModified 2026-09-01 15:42:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

let mockSpoolSequence = 0;

/**
 * テスト用 monitorData を生成
 * @param {Object} [overrides] - 上書きするプロパティ
 * @returns {Object} monitorData モック
 */
export function createMockMonitorData(overrides = {}) {
  return {
    machines: {},
    filamentSpools: [],
    filamentPresets: [],
    hostSpoolMap: {},
    customPresets: [],
    ...overrides,
  };
}

/**
 * テスト用マシンエントリを生成
 * @param {string} hostname - ホスト名
 * @param {Object} [storedDataOverrides] - storedData の上書き
 * @returns {Object} machine エントリ
 */
export function createMockMachine(hostname, storedDataOverrides = {}) {
  return {
    storedData: {
      hostname: { value: hostname, rawValue: hostname },
      nozzleTemp: { value: 0, rawValue: 0 },
      bedTemp0: { value: 0, rawValue: 0 },
      state: { value: 0, rawValue: 0 },
      printProgress: { value: 0, rawValue: 0 },
      materialStatus: { value: 0, rawValue: 0 },
      materialDetect: { value: 0, rawValue: 0 },
      ...storedDataOverrides,
    },
    _dirtyKeys: new Map(),
    _fieldCache: new Map(),
    runtimeData: { lastError: null },
  };
}

/**
 * テスト用スプールオブジェクトを生成
 * @param {Object} [overrides] - 上書きするプロパティ
 * @returns {Object} spool オブジェクト
 */
export function createMockSpool(overrides = {}) {
  mockSpoolSequence += 1;
  return {
    id: `spool_${String(mockSpoolSequence).padStart(6, "0")}`,
    serialNo: 1,
    presetId: null,
    name: 'Test PLA',
    reelName: 'Test PLA',
    material: 'PLA',
    materialName: 'PLA',
    brand: 'TestBrand',
    manufacturerName: 'TestBrand',
    color: '#22C55E',
    filamentColor: '#22C55E',
    colorName: 'Green',
    density: 1.24,
    filamentDiameter: 1.75,
    totalLengthMm: 336000,
    remainingLengthMm: 168000,
    printCount: 5,
    usedLengthLog: [],
    startDate: new Date().toISOString(),
    startedAt: null,
    removedAt: null,
    isActive: false,
    isInUse: false,
    isPending: false,
    isFavorite: false,
    deleted: false,
    isDeleted: false,
    hostname: null,
    purchasePrice: 1699,
    currencySymbol: '¥',
    purchaseLink: '',
    note: '',
    ...overrides,
  };
}

/**
 * テスト用プリンタステータスメッセージを生成
 * @param {Object} [overrides] - 上書きフィールド
 * @returns {Object} WebSocket受信メッセージ
 */
export function createMockStatusMessage(overrides = {}) {
  return {
    hostname: 'K1-TEST',
    model: 'K1 Max',
    modelVersion: '1.3.3.46',
    state: 0,
    deviceState: 0,
    printProgress: 0,
    printJobTime: 0,
    printStartTime: 0,
    printLeftTime: 0,
    printFileName: '',
    fileName: '',
    nozzleTemp: 25.0,
    targetNozzleTemp: 0,
    bedTemp0: 25.0,
    targetBedTemp0: 0,
    boxTemp: 28.0,
    fan: 0,
    fanAuxiliary: 0,
    fanCase: 0,
    lightSw: 0,
    aiSw: 0,
    aiDetection: 0,
    curFeedratePct: 100,
    curFlowratePct: 100,
    layer: 0,
    TotalLayer: 0,
    curPosition: 'X:0 Y:0 Z:0',
    materialDetect: 0,
    materialStatus: 0,
    usedMaterialLength: 0,
    totalJob: 0,
    totalUsageTime: 0,
    totalUsageMaterial: 0,
    err: { errcode: 0, key: 0 },
    ...overrides,
  };
}
