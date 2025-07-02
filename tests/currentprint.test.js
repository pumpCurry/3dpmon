// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description 3dpmon Card_CurrentPrint unit test
 * @file currentprint.test.js
 * -----------------------------------------------------------
 * @module tests/currentprint
 *
 * 【機能内容サマリ】
 * - Card_CurrentPrint のイベント購読を検証
 */

import { describe, it, expect } from 'vitest';
import { Card_CurrentPrint } from '@cards/Card_CurrentPrint.js';
import { bus } from '@core/EventBus.js';

describe('Card_CurrentPrint', () => {
  it('subscribes and unsubscribes correctly', () => {
    const card = new Card_CurrentPrint({ deviceId: 'p1', bus });
    card.connected();
    expect(bus.count('printer:p1:current')).toBe(1);
    card.destroy();
    expect(bus.count('printer:p1:current')).toBe(0);
  });
});
