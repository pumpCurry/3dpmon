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

import { describe, it, expect, vi } from 'vitest';
import { Card_CurrentPrint } from '@cards/Card_CurrentPrint.js';
import { bus } from '@core/EventBus.js';

describe('Card_CurrentPrint', () => {
  it('subscribes on connected', () => {
    const spy = vi.spyOn(bus, 'on');
    const card = new Card_CurrentPrint({ deviceId: 'p1', bus });
    card.connected();
    expect(spy).toHaveBeenCalledWith('printer:p1:current', expect.any(Function));
    card.destroy();
    spy.mockRestore();
  });
});
