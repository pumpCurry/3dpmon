// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description exportLayouts helper tests
 * @file backup.test.js
 * -----------------------------------------------------------
 * @module tests/backup
 *
 * 【機能内容サマリ】
 * - exportLayouts が正しいオブジェクトを返すか検証
 */

import { describe, it, expect } from 'vitest';
import { exportLayouts } from '@core/backup.js';
import LayoutStore from '@core/LayoutStore.js';

const store = new LayoutStore();

describe('exportLayouts', () => {
  it('collects connections and layouts', () => {
    localStorage.setItem('connections', JSON.stringify([{ ip: '1.1.1.1', wsPort: 80 }]));
    store.save({ id: '1', name: 'A', updated: 0, grid: [] });
    const data = exportLayouts();
    expect(data.connections.length).toBe(1);
    expect(data.layouts.length).toBe(1);
  });
});
