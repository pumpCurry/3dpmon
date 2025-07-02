// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description LayoutStore unit tests
 * @file layout_store.test.js
 * -----------------------------------------------------------
 * @module tests/layout_store
 *
 * 【機能内容サマリ】
 * - LayoutStore の保存・削除処理を検証
 */

import { describe, it, expect, beforeEach } from 'vitest';
import LayoutStore from '@core/LayoutStore.js';

const store = new LayoutStore();

describe('LayoutStore', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('save adds new layout', () => {
    const layout = { id: '1', name: 'a', updated: 0, grid: [] };
    store.save(layout);
    expect(store.getAll().length).toBe(1);
  });

  it('delete removes layout', () => {
    const layout = { id: '1', name: 'a', updated: 0, grid: [] };
    store.save(layout);
    store.delete('1');
    expect(store.getAll().length).toBe(0);
  });
});
