// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description verify reserveFilament history merges with device history
 * @file history_spool_merge.test.js
 * -----------------------------------------------------------
 * @module tests/history_spool_merge
 *
 * 【機能内容サマリ】
 * - reserveFilament entry merges into print history when device list arrives
 *
 * @version 1.390.724 (PR #333)
 * @since   1.390.724 (PR #333)
 * @lastModified 2025-07-11 15:20:00
 */

import { describe, it, expect, vi } from 'vitest';
import { monitorData, setCurrentHostname, createEmptyMachineData } from '../3dp_lib/dashboard_data.js';
import { updateHistoryList } from '../3dp_lib/dashboard_printmanager.js';
import { reserveFilament, addSpool, setCurrentSpoolId } from '../3dp_lib/dashboard_spool.js';
import * as stagePreview from '../3dp_lib/dashboard_stage_preview.js';

// ---------------------------------------------------------------------------
// テスト本体
// ---------------------------------------------------------------------------

describe('history spool merge', () => {
  it('merges spool info entry with device history', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(stagePreview, 'updateXYPreview').mockImplementation(() => {});
    vi.spyOn(stagePreview, 'updateZPreview').mockImplementation(() => {});

    setCurrentHostname('K1');
    monitorData.machines['K1'] = createEmptyMachineData();
    const spool = addSpool({ name: 'test', material: 'PLA', remainingLengthMm: 200000, totalLengthMm: 200000 });
    setCurrentSpoolId(spool.id);

    reserveFilament(100, '123');

    const raw = [{ id: 123, filename: 'a.gcode', starttime: 1 }];
    updateHistoryList(raw, '');

    const entry = monitorData.machines['K1'].printStore.history.find(h => h.id === 123);
    expect(entry).toBeDefined();
    expect(Array.isArray(entry.filamentInfo)).toBe(true);
    expect(entry.filamentInfo.some(info => info.spoolId === spool.id)).toBe(true);

    const saved = JSON.parse(localStorage.getItem('3dp-monitor_1.400'));
    const storedEntry = saved.machines.K1.printStore.history.find(h => h.id === 123);
    expect(storedEntry).toBeDefined();
    expect(storedEntry.filamentInfo.some(info => info.spoolId === spool.id)).toBe(true);
  });
});
