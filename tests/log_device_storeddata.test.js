// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description 3dpmon log device test using storedData before/after snapshots
 * @file log_device_storeddata.test.js
 * -----------------------------------------------------------
 * @module tests/log_device_storeddata
 *
 * 【機能内容サマリ】
 * - ログ002をモックデバイスで再生しstoredData更新を検証
 *
 * @version 1.390.705 (PR #328)
 * @since   1.390.705 (PR #328)
 * @lastModified 2025-07-11 07:50:00
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createLogDevice } from './utils/log_device.js';
import { monitorData, setCurrentHostname, createEmptyMachineData } from '../3dp_lib/dashboard_data.js';
import { processData } from '../3dp_lib/dashboard_msg_handler.js';
import { aggregatorUpdate } from '../3dp_lib/dashboard_aggregator.js';
import { addSpool, setCurrentSpoolId } from '../3dp_lib/dashboard_spool.js';
import * as stagePreview from '../3dp_lib/dashboard_stage_preview.js';

const BEFORE_PATH = path.resolve('tests', 'data', 'printinglog_sample_test_002_storedData_before.log');
const AFTER_PATH  = path.resolve('tests', 'data', 'printinglog_sample_test_002_storedData_after.log');

/**
 * storedDataロガーファイルを読み込みJSONとして返す
 * @param {string} p - ファイルパス
 * @returns {Object} パースされたオブジェクト
 */
function loadStoredData(p) {
  const txt = fs.readFileSync(p, 'utf8');
  return JSON.parse(txt);
}

describe('log device storedData update', () => {
  it('replays log and updates storedData', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(stagePreview, 'updateXYPreview').mockImplementation(() => {});
    vi.spyOn(stagePreview, 'updateZPreview').mockImplementation(() => {});
    setCurrentHostname('K1');
    monitorData.machines['K1'] = createEmptyMachineData();
    monitorData.machines['K1'].storedData = loadStoredData(BEFORE_PATH);
    const spool = addSpool({ name: 'test', material: 'PLA', remainingLengthMm: 200000, totalLengthMm: 200000 });
    setCurrentSpoolId(spool.id);

    const dev = createLogDevice('002', 0, 0, true);
    let now = 0;
    while (true) {
      const { json, is_finished } = dev.get(now);
      for (const frame of json) {
        processData(frame);
        aggregatorUpdate();
      }
      if (is_finished) break;
      now += 1;
    }
    aggregatorUpdate();

    const after = loadStoredData(AFTER_PATH);
    const sd = monitorData.machines['K1'].storedData;
    expect(sd.printStartTime.rawValue).toBe(after.printStartTime.rawValue);
    expect(Object.keys(sd).length).toBeGreaterThan(0);
  });
});
