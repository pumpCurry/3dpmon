// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 ThemeManager 単体テスト
 * @file theme.test.js
 * -----------------------------------------------------------
 * @module tests/theme
 *
 * 【機能内容サマリ】
 * - テーマ適用と保存機能を検証
 *
 * @version 1.390.600 (PR #277)
 * @since   1.390.600 (PR #277)
 * @lastModified 2025-07-01 12:00:00
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setTheme, getTheme, initTheme, store, ensureContrast } from '@core/ThemeManager.js';

describe('ThemeManager', () => {
  beforeEach(() => {
    document.documentElement.dataset.theme = '';
    window.localStorage.clear();
  });

  it('setTheme updates dataset and storage', () => {
    setTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(store.get('theme')).toBe('dark');
  });

  it('initTheme restores saved value', () => {
    store.set('theme', 'dark');
    initTheme();
    expect(getTheme()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('ensureContrast selects readable text color', () => {
    const text = ensureContrast('#ffa500');
    expect(['#ffffff', '#000000']).toContain(text);
  });
});
