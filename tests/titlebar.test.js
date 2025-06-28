// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 TitleBar 単体テスト
 * @file titlebar.test.js
 * -----------------------------------------------------------
 * @module tests/titlebar
 *
 * 【機能内容サマリ】
 * - TitleBar のクリック動作とイベント発火を検証
 *
 * @version 1.390.549 (PR #252)
 * @since   1.390.549 (PR #252)
 * @lastModified 2025-06-28 20:00:00
 */

import { describe, it, expect, vi } from 'vitest';
import TitleBar from '@cards/Bar_Title.js';
import { bus } from '@core/EventBus.js';

describe('TitleBar', () => {
  it('adds tab and emits select', () => {
    const bar = new TitleBar(bus);
    bar.mount(document.body);
    bar.setTabs([{ id: 't1', label: 'K1', color: '#f66' }]);

    const spy = vi.fn();
    bus.on('tab:select', spy);

    document.querySelector('.tab').click();
    expect(spy).toHaveBeenCalledWith('t1');
  });
});
