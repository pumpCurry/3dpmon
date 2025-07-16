// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description verify spool printIdRanges tracking across logs 001 and 002
 * @file spool_idrange.test.js
 * -----------------------------------------------------------
 * @module tests/spool_idrange
 *
 * 【機能内容サマリ】
 * - ログ001,002再生でスプールの印刷ID範囲を記録
 *
 * @version 1.390.746 (PR #343)
 * @since   1.390.746 (PR #343)
 * @lastModified 2025-07-16 11:28:50
 */

import { describe, it, expect, vi } from 'vitest';
import { parseLogToFrames } from './utils/log_replay.js';
import { monitorData, setCurrentHostname, createEmptyMachineData } from '../3dp_lib/dashboard_data.js';
import { processData } from '../3dp_lib/dashboard_msg_handler.js';
import * as stagePreview from '../3dp_lib/dashboard_stage_preview.js';
import { addSpool, setCurrentSpoolId } from '../3dp_lib/dashboard_spool.js';
import { aggregatorUpdate } from '../3dp_lib/dashboard_aggregator.js';
import path from 'path';

const LOG1 = path.resolve('tests', 'data', 'printinglog_sample_test_001.log');
const LOG2 = path.resolve('tests', 'data', 'printinglog_sample_test_002.log');

describe('spool printIdRanges', () => {
  it('records first and last print IDs per spool', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(stagePreview, 'updateXYPreview').mockImplementation(() => {});
    vi.spyOn(stagePreview, 'updateZPreview').mockImplementation(() => {});
    setCurrentHostname('K1');
    monitorData.machines['K1'] = createEmptyMachineData();

    const spool1 = addSpool({ name: 'sp1', material: 'PLA', remainingLengthMm: 200000, totalLengthMm: 200000 });
    setCurrentSpoolId(spool1.id);

    [LOG1, LOG2].forEach(p => {
      const frames = parseLogToFrames(p);
      for (const f of frames) {
        processData(f);
        aggregatorUpdate();
      }
      aggregatorUpdate();
    });

    const spool2 = addSpool({ name: 'sp2', material: 'PLA', remainingLengthMm: 200000, totalLengthMm: 200000 });
    setCurrentSpoolId(spool2.id);

    expect(Array.isArray(spool1.printIdRanges)).toBe(true);
    expect(spool1.printIdRanges.length).toBe(1);
    const range = spool1.printIdRanges[0];
    expect(range.startPrintID).toBe('1752053741');
    expect(range.endPrintID).toBe('1752145064');
  });
});
