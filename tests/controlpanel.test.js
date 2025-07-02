// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description 3dpmon Card_ControlPanel unit test
 * @file controlpanel.test.js
 * -----------------------------------------------------------
 * @module tests/controlpanel
 *
 * 【機能内容サマリ】
 * - Card_ControlPanel のイベント購読を検証
 */

import { describe, it, expect, vi } from 'vitest';
import { Card_ControlPanel } from '@cards/Card_ControlPanel.js';
import { bus } from '@core/EventBus.js';

describe('Card_ControlPanel', () => {
  it('subscribes on connected', () => {
    const spy = vi.spyOn(bus, 'on');
    const card = new Card_ControlPanel({ deviceId: 'p1', bus });
    card.connected();
    expect(spy).toHaveBeenCalledWith('printer:p1:control', expect.any(Function));
    card.destroy();
    spy.mockRestore();
  });
});
