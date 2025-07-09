// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description 3dpmon log replay test using WebSocket frames
 * @file log_replay.test.js
 * -----------------------------------------------------------
 * @module tests/log_replay
 *
 * 【機能内容サマリ】
 * - ログファイルを読み取り状態遷移を再現
 *
 * @version 1.390.669 (PR #310)
 * @since   1.390.669 (PR #310)
 * @lastModified 2025-07-09 00:00:00
 */

import { describe, it, expect, vi } from 'vitest';
import { parseLogToFrames } from './utils/log_replay.js';
import { monitorData, setCurrentHostname, createEmptyMachineData } from '../3dp_lib/dashboard_data.js';
import { processData } from '../3dp_lib/dashboard_msg_handler.js';
import * as stagePreview from '../3dp_lib/dashboard_stage_preview.js';
import path from 'path';

const LOG_PATH = path.resolve('tests', 'data', 'printinglog_sample_test_001.log');

describe('log replay', () => {
  it('emulates print states from log', () => {
    vi.spyOn(stagePreview, 'updateXYPreview').mockImplementation(() => {});
    vi.spyOn(stagePreview, 'updateZPreview').mockImplementation(() => {});
    setCurrentHostname('K1');
    monitorData.machines['K1'] = createEmptyMachineData();
    const frames = parseLogToFrames(LOG_PATH);
    const states = [];
    for (const f of frames) {
      processData(f);
      if ('state' in f) {
        states.push(monitorData.machines['K1'].runtimeData.state);
      }
    }
    expect(states).toEqual(['2', '0', '1', '2']);
  });
});
