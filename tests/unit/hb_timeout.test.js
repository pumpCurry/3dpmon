// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description WSClient heartbeat timeout tests
 * @file hb_timeout.test.js
 * -----------------------------------------------------------
 * @module tests/hb_timeout
 *
 * 【機能内容サマリ】
 * - ハートビート監視が一定時間でタイムアウトするか検証
 *
 * @version 1.390.657 (PR #304)
 * @since   1.390.657 (PR #304)
 * @lastModified 2025-07-04 12:00:00
 */

import { describe, it, expect, vi } from 'vitest';
import WSClient from '@core/WSClient.js';
import { bus } from '@core/EventBus.js';
import WebSocketMock from '../__mocks__/ws.js';

globalThis.WebSocket = WebSocketMock;

vi.useFakeTimers();

describe('WSClient heartbeat', () => {
  it('emits timeout when no heartbeat', () => {
    const spy = vi.fn();
    bus.on('printer:timeout', spy);
    const client = new WSClient('ws://localhost', 'p1');
    client.connect();
    vi.advanceTimersByTime(10); // open
    client.lastHb = Date.now() - 46000;
    vi.advanceTimersByTime(5000);
    expect(spy).toHaveBeenCalled();
    client.destroy();
  });

  it('updates lastHb on ok', () => {
    const client = new WSClient('ws://localhost', 'p1');
    client.connect();
    vi.advanceTimersByTime(10);
    const prev = client.lastHb;
    client.socket.onmessage({ data: 'ok' });
    expect(client.lastHb).toBeGreaterThanOrEqual(prev);
    client.destroy();
  });
});
