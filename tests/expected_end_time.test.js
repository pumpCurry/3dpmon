// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description 3dpmon log playback test for expected end time
 * @file expected_end_time.test.js
 * -----------------------------------------------------------
 * @module tests/expected_end_time
 *
 * 【機能内容サマリ】
 * - Log device playback verifies expectedEndTime update
 *
 * 【公開関数一覧】
 * - なし (Vitest suite)
 *
 * @version 1.390.711 (PR #328)
 * @since   1.390.711 (PR #328)
 * @lastModified 2025-07-11 07:28:24
 * -----------------------------------------------------------
 * @todo
 * - none
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

describe('expected end time update', () => {
  it('updates expectedEndTime after finish', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(stagePreview, 'updateXYPreview').mockImplementation(() => {});
    vi.spyOn(stagePreview, 'updateZPreview').mockImplementation(() => {});

    setCurrentHostname('K1');
    monitorData.machines['K1'] = createEmptyMachineData();

    const device = createLogDevice('002', 0);
    let now = 0;
    let result;

    do {
      result = device.get(now);
      for (const frame of result.json) {
        processData(frame);
        aggregatorUpdate();
      }
      now += 1;
    } while (!result.is_finished);

    aggregatorUpdate();
    const sd = monitorData.machines['K1'].storedData;
    expect(sd.expectedEndTime.rawValue).toBe(sd.printFinishTime.rawValue);
  });
});

