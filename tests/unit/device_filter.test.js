// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description DeviceFilterBar and CardContainer unit test
 * @file device_filter.test.js
 * -----------------------------------------------------------
 * @module tests/device_filter
 *
 * 【機能内容サマリ】
 * - フィルタ変更でカード表示が切り替わることを検証
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { bus } from '@core/EventBus.js';
import LayoutStore from '@core/LayoutStore.js';
import CardContainer from '@core/CardContainer.js';

const store = new LayoutStore();
store.current = { id: 'l1', name: 'L1', updated: 0, grid: [], filter: 'ALL' };

describe('device filter', () => {
  let root;
  let container;
  beforeEach(() => {
    document.body.innerHTML = '';
    root = document.createElement('div');
    document.body.appendChild(root);
    container = new CardContainer(bus, store);
    container.mount(root);
    const a = document.createElement('div');
    a.dataset.card = 'camera';
    a.dataset.device = 'A';
    root.querySelector('.card-container').appendChild(a);
    const b = document.createElement('div');
    b.dataset.card = 'camera';
    b.dataset.device = 'B';
    root.querySelector('.card-container').appendChild(b);
  });

  it('updateFilter hides unmatched cards', () => {
    bus.emit('filter:change', 'B');
    const nodes = root.querySelectorAll('[data-card]');
    expect(nodes[0].style.opacity).toBe('0.2');
    expect(nodes[1].style.opacity).toBe('1');
  });
});
