// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Card_Status 単体テスト
 * @file status.test.js
 * -----------------------------------------------------------
 * @module tests/status
 *
 * 【機能内容サマリ】
 * - Card_Status のバス購読を検証
 */

import { describe, it, expect, vi } from 'vitest';
import { Card_Status } from '@cards/Card_Status.js';
import { bus } from '@core/EventBus.js';

describe('Card_Status', () => {
  it('subscribes on connected', () => {
    const spy = vi.spyOn(bus, 'on');
    const card = new Card_Status({ deviceId: 'p1', bus });
    card.connected();
    expect(spy).toHaveBeenCalledWith('printer:p1:status', expect.any(Function));
    card.destroy();
    spy.mockRestore();
  });
});
