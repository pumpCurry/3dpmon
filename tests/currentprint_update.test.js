// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description ensure current job updates when file name or start time arrive late
 * @file currentprint_update.test.js
 * -----------------------------------------------------------
 * @module tests/currentprint_update
 *
 * 【機能内容サマリ】
 * - 遅延したファイル名/開始時刻による現在ジョブ更新を検証
 *
 * @version 1.390.737 (PR #340)
 * @since   1.390.737 (PR #340)
 * @lastModified 2025-07-13 11:05:00
 */

import { describe, it, expect, vi } from 'vitest';
import { setCurrentHostname, monitorData, createEmptyMachineData } from '../3dp_lib/dashboard_data.js';
import { processData } from '../3dp_lib/dashboard_msg_handler.js';
import { loadCurrent } from '../3dp_lib/dashboard_printmanager.js';
import * as stagePreview from '../3dp_lib/dashboard_stage_preview.js';

// -------------------------------------------------------------------------
// テスト本体
// -------------------------------------------------------------------------

describe('current job update on late info', () => {
  it('updates stored current job when info arrives after start', () => {
    vi.spyOn(stagePreview, 'updateXYPreview').mockImplementation(() => {});
    vi.spyOn(stagePreview, 'updateZPreview').mockImplementation(() => {});

    setCurrentHostname('K1');
    monitorData.machines['K1'] = createEmptyMachineData();

    // Start without filename or start time
    processData({ state: 1, printProgress: 0 });
    expect(loadCurrent()).toBeNull();

    // Later receive filename and start time
    processData({ fileName: '/path/to/test.gcode', printStartTime: 1000 });
    const job = loadCurrent();
    expect(job).not.toBeNull();
    expect(job.filename).toBe('test.gcode');
    expect(job.id).toBe(1000);
  });
});
