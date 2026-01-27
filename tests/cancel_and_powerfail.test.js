// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description verify filament finalization on cancel and power failure
 * @file cancel_and_powerfail.test.js
 * -----------------------------------------------------------
 * @module tests/cancel_and_powerfail
 *
 * 【機能内容サマリ】
 * - 印刷キャンセル時や電源断後の再接続時でもフィラメント使用量を確定
 *
 * @version 1.390.779 (PR #358)
 * @since   1.390.760 (PR #351)
 * @lastModified 2026-01-27 09:58:39
 */

import { describe, it, expect, vi } from 'vitest';
import { monitorData, setCurrentHostname, createEmptyMachineData } from '../3dp_lib/dashboard_data.js';
import { processData } from '../3dp_lib/dashboard_msg_handler.js';
import { addSpool, setCurrentSpoolId } from '../3dp_lib/dashboard_spool.js';
import { aggregatorUpdate } from '../3dp_lib/dashboard_aggregator.js';
import * as stagePreview from '../3dp_lib/dashboard_stage_preview.js';
import { PRINT_STATE_CODE } from '../3dp_lib/dashboard_ui_mapping.js';

// ---------------------------------------------------------------------------
// テスト本体
// ---------------------------------------------------------------------------

describe('spool finalize on cancel/power fail', () => {
  it('finalizes when job cancelled before completion', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(stagePreview, 'updateXYPreview').mockImplementation(() => {});
    vi.spyOn(stagePreview, 'updateZPreview').mockImplementation(() => {});

    setCurrentHostname('K1');
    monitorData.machines['K1'] = createEmptyMachineData();
    const spool = addSpool({ name: 'sp', material: 'PLA', remainingLengthMm: 1000, totalLengthMm: 1000 });
    setCurrentSpoolId(spool.id);

    processData({ printStartTime: 1, state: PRINT_STATE_CODE.printStarted });
    aggregatorUpdate();
    processData({ printProgress: 50, state: PRINT_STATE_CODE.printStarted, usedMaterialLength: 100 });
    aggregatorUpdate();
    processData({ state: PRINT_STATE_CODE.printFailed, usedMaterialLength: 150 });
    aggregatorUpdate();

    expect(spool.currentPrintID).toBe('1');
    expect(spool.usedLengthLog.length).toBe(1);
    expect(spool.remainingLengthMm).toBeCloseTo(850);
  });

  it('finalizes leftover usage after power failure', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(stagePreview, 'updateXYPreview').mockImplementation(() => {});
    vi.spyOn(stagePreview, 'updateZPreview').mockImplementation(() => {});

    setCurrentHostname('K2');
    const machine = createEmptyMachineData();
    machine.runtimeData.state = String(PRINT_STATE_CODE.printStarted);
    monitorData.machines['K2'] = machine;
    const spool = addSpool({ name: 'sp2', material: 'PLA', remainingLengthMm: 2000, totalLengthMm: 2000 });
    setCurrentSpoolId(spool.id);
    spool.currentJobStartLength = 2000;
    spool.currentJobExpectedLength = 500;
    spool.currentPrintID = '2';

    processData({ state: PRINT_STATE_CODE.printIdle, usedMaterialLength: 250, printStartTime: 2 });
    aggregatorUpdate();

    expect(spool.currentPrintID).toBe('2');
    expect(spool.usedLengthLog.length).toBe(2);
    expect(spool.remainingLengthMm).toBeCloseTo(1500);
  });
});
