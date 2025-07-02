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

import { describe, it, expect } from 'vitest';
import { Card_ControlPanel } from '@cards/Card_ControlPanel.js';
import { bus } from '@core/EventBus.js';

describe('Card_ControlPanel', () => {
  it('subscribes and unsubscribes correctly', () => {
    const card = new Card_ControlPanel({ deviceId: 'p1', bus });
    card.connected();
    expect(bus.count('printer:p1:control')).toBe(1);
    card.destroy();
    expect(bus.count('printer:p1:control')).toBe(0);
  });
});
