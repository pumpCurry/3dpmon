// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description 3dpmon Card_TempGraph unit test
 * @file tempgraph.test.js
 * -----------------------------------------------------------
 * @module tests/tempgraph
 *
 * 【機能内容サマリ】
 * - Card_TempGraph のイベント購読を検証
 */

import { describe, it, expect, vi } from 'vitest';
import Card_TempGraph from '@cards/Card_TempGraph.js';
import { bus } from '@core/EventBus.js';

describe('Card_TempGraph', () => {
  it('subscribes to temps on connected', () => {
    const spy = vi.spyOn(bus, 'on');
    const card = new Card_TempGraph({ deviceId: 'p1', bus });
    card.connected();
    expect(spy).toHaveBeenCalledWith('printer:p1:temps', expect.any(Function));
    card.destroy();
    spy.mockRestore();
  });
});
