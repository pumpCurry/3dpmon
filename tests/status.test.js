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

import { describe, it, expect } from 'vitest';
import { Card_Status } from '@cards/Card_Status.js';
import { bus } from '@core/EventBus.js';

describe('Card_Status', () => {
  it('subscribes and unsubscribes correctly', () => {
    const card = new Card_Status({ deviceId: 'p1', bus });
    card.connected();
    expect(bus.count('printer:p1:status')).toBe(1);
    card.destroy();
    expect(bus.count('printer:p1:status')).toBe(0);
  });
});
