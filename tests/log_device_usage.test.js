// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description 3dpmon log replay test for filament usage with log 002
 * @file log_device_usage.test.js
 * -----------------------------------------------------------
 * @module tests/log_device_usage
 *
 * 【機能内容サマリ】
 * - ログ002を再生しフィラメント履歴を確認
 *
 * @version 1.390.697 (PR #322)
 * @since   1.390.697 (PR #322)
 * @lastModified 2025-07-10 21:30:00
 */

import { describe, it, expect, vi } from 'vitest';
import { parseLogToFrames } from './utils/log_replay.js';
import { monitorData, setCurrentHostname, createEmptyMachineData } from '../3dp_lib/dashboard_data.js';
import { processData } from '../3dp_lib/dashboard_msg_handler.js';
import * as stagePreview from '../3dp_lib/dashboard_stage_preview.js';
import { addSpool, setCurrentSpoolId } from '../3dp_lib/dashboard_spool.js';
import { aggregatorUpdate } from '../3dp_lib/dashboard_aggregator.js';
import path from 'path';

const LOG_PATH = path.resolve('tests', 'data', 'printinglog_sample_test_002.log');

describe('filament usage from log 002', () => {
  it('records spool information into history', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(stagePreview, 'updateXYPreview').mockImplementation(() => {});
    vi.spyOn(stagePreview, 'updateZPreview').mockImplementation(() => {});
    setCurrentHostname('K1');
    monitorData.machines['K1'] = createEmptyMachineData();
    const spool = addSpool({ name: 'test', material: 'PLA', remainingLengthMm: 200000, totalLengthMm: 200000 });
    setCurrentSpoolId(spool.id);

    const frames = parseLogToFrames(LOG_PATH);
    for (const f of frames) {
      processData(f);
      aggregatorUpdate();
    }

    aggregatorUpdate();
    const entry = monitorData.machines['K1'].historyData.find(h => h.id === 1752145064);
    expect(entry).toBeDefined();
    expect(spool.currentPrintID).toBe('1752145064');
  });
});
