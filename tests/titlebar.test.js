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
 * @version 1.390.553 (PR #253)
 * @since   1.390.549 (PR #252)
 * @lastModified 2025-06-28 20:00:00
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import TitleBar from '@cards/Bar_Title.js';
import { bus } from '@core/EventBus.js';

describe('TitleBar', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  it('adds tab and emits select', () => {
    const bar = new TitleBar(bus);
    bar.mount(document.body);
    bar.setTabs([{ id: 't1', label: 'K1', color: '#f66' }]);

    const spy = vi.fn();
    bus.on('tab:select', spy);

    document.querySelector('.tab').click();
    expect(spy).toHaveBeenCalledWith('t1');
  });

  it('addTab increases DOM count', () => {
    const bar = new TitleBar(bus);
    bar.mount(document.body);
    bar.setTabs([]);
    expect(document.querySelectorAll('.tab').length).toBe(0);
    bar.addTab({ id: 'x1', label: 'X' });
    expect(document.querySelectorAll('.tab').length).toBe(1);
  });

  it('removeTab decreases DOM count', () => {
    const bar = new TitleBar(bus);
    bar.mount(document.body);
    bar.setTabs([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]);
    expect(document.querySelectorAll('.tab').length).toBe(2);
    bar.removeTab('a');
    expect(document.querySelectorAll('.tab').length).toBe(1);
  });

  it('keyboard navigation switches active', () => {
    const bar = new TitleBar(bus);
    bar.mount(document.body);
    bar.setTabs([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]);
    const tabs = document.querySelectorAll('.tab');
    tabs[0].focus();
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(tabs[1].classList.contains('active')).toBe(true);
  });
});
