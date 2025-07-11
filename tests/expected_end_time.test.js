// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description ensure expectedEndTime field reflects final print finish time
 * @file expected_end_time.test.js
 * -----------------------------------------------------------
 * @module tests/expected_end_time
 *
 * 【機能内容サマリ】
 * - log 002 replay via log_device verifies expectedEndTime
 *
 * @version 1.390.711 (PR #328)
 * @since   1.390.711 (PR #328)
 * @lastModified 2025-07-11 09:25:51
 */

import { describe, it, expect, vi } from 'vitest';
import { createLogDevice } from './utils/log_device.js';
import { monitorData, setCurrentHostname, createEmptyMachineData } from '../3dp_lib/dashboard_data.js';
import { processData } from '../3dp_lib/dashboard_msg_handler.js';
import { aggregatorUpdate } from '../3dp_lib/dashboard_aggregator.js';
import * as stagePreview from '../3dp_lib/dashboard_stage_preview.js';

// ---------------------------------------------------------------------------
// テスト本体
// ---------------------------------------------------------------------------

describe('expectedEndTime calculation', () => {
  it('updates expectedEndTime using log device for log 002', () => {

    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(stagePreview, 'updateXYPreview').mockImplementation(() => {});
    vi.spyOn(stagePreview, 'updateZPreview').mockImplementation(() => {});

    setCurrentHostname('K1');
    monitorData.machines['K1'] = createEmptyMachineData();

    const dev = createLogDevice('002', 0, 0, true);
    const result = dev.get(999999);
    for (const frame of result.json) {
      processData(frame);
      aggregatorUpdate();
    }
    aggregatorUpdate();

    const stored = monitorData.machines['K1'].storedData;
    expect(parseInt(stored.expectedEndTime.rawValue, 10))
      .toBe(parseInt(stored.printFinishTime.rawValue, 10));
  });
});

