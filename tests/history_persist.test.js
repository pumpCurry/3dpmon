// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description ensure actualStartTime is persisted when printStartTime arrives late
 * @file history_persist.test.js
 * -----------------------------------------------------------
 * @module tests/history_persist
 *
 * 【機能内容サマリ】
 * - printJobTime が先行した場合でも actualStartTime を履歴へ保存
 *
 * @version 1.390.704 (PR #325)
 * @since   1.390.704 (PR #325)
 * @lastModified 2025-07-10 23:11:44
 */

import { describe, it, expect, vi } from 'vitest';
import { monitorData, setCurrentHostname, createEmptyMachineData } from '../3dp_lib/dashboard_data.js';
import { processData } from '../3dp_lib/dashboard_msg_handler.js';
import { aggregatorUpdate } from '../3dp_lib/dashboard_aggregator.js';
import * as stagePreview from '../3dp_lib/dashboard_stage_preview.js';

// ----------------------------------------------------------------------------
// テスト本体
// ----------------------------------------------------------------------------

describe('persist history when start time delayed', () => {
  it('keeps actualStartTime in history after delayed ID', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(stagePreview, 'updateXYPreview').mockImplementation(() => {});
    vi.spyOn(stagePreview, 'updateZPreview').mockImplementation(() => {});

    setCurrentHostname('K1');
    monitorData.machines['K1'] = createEmptyMachineData();

    const frames = [
      { printJobTime: 2, printProgress: 0, state: 1 },
      { printStartTime: 1234567 }
    ];

    for (const f of frames) {
      processData(f);
      aggregatorUpdate();
    }
    aggregatorUpdate();

    const hist = monitorData.machines['K1'].historyData.find(h => h.id === 1234567);
    expect(hist).toBeDefined();
    expect(hist.actualStartTime).not.toBeUndefined();
  });
});
