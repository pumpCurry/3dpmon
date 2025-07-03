// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description MiniMap widget unit tests
 * @file minimap.test.js
 * -----------------------------------------------------------
 * @module tests/minimap
 *
 * 【機能内容サマリ】
 * - MiniMap の描画とスナップショット更新を検証
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { bus } from '@core/EventBus.js';
import LayoutStore from '@core/LayoutStore.js';
import { MiniMap } from '@widgets/MiniMap.js';

let store;
let container;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  store = new LayoutStore();
  store.current = {
    id: 'l1',
    name: 'L1',
    updated: 0,
    filter: 'ALL',
    grid: [
      { id: 'c1', x: 0, y: 0, w: 1, h: 1 },
      { id: 'c2', x: 1, y: 0, w: 1, h: 1 }
    ]
  };
});

describe('MiniMap', () => {
  it('layout rectangles equal grid length', () => {
    const mm = new MiniMap({ container, store, bus });
    const rects = container.querySelectorAll('svg rect');
    expect(rects.length).toBe(2);
    mm.destroy();
  });

  it('snapshot event updates img src', () => {
    const mm = new MiniMap({ container, store, bus });
    bus.emit('card:snapshot', { id: 'c1', dataUrl: 'data:image/png;base64,AA' });
    const img = container.querySelector('.thumb[data-id="c1"]');
    expect(img.src).toMatch(/^data:image\/png/);
    mm.destroy();
  });
});
