/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 ConnectionManager 結合テスト
 * @file connection.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * -----------------------------------------------------------
 * @module tests/connection
 *
 * 【機能内容サマリ】
 * - WebSocket モックを用いた ConnectionManager の送受信検証
 *
 * 【公開関数一覧】
 * - なし（Vitest スイート）
 *
 * @version 1.390.546 (PR #250)
 * @since   1.390.540 (PR #247)
 * @lastModified 2025-06-28 11:40:57
 * -----------------------------------------------------------
 * @todo
 * - なし
 */

import { describe, it, expect, vi } from 'vitest';
import { ConnectionManager } from '@core/ConnectionManager.js';
import { bus } from '@core/EventBus.js';

vi.mock('ws', async () => ({
  default: (await import('./__mocks__/ws.js')).default
}));

describe('ConnectionManager', () => {
  it('opens / echoes / closes', async () => {
    const cm = new ConnectionManager(bus);
    const id = await cm.add({ ip: '127.0.0.1', wsPort: 9999 });
    const openP = new Promise((r) => bus.on('cm:open', r));
    await cm.connect(id);
    await openP;
    expect(cm.getState(id)).toBe('open');

    const p = new Promise((r) => bus.on('cm:message', r));
    cm.send(id, { ping: 1 });
    const frame = await p;
    expect(frame.data).toEqual({ ping: 1 });

    const closeP = new Promise((r) => bus.on('cm:close', r));
    cm.close(id);
    await closeP;
    expect(cm.getState(id)).toBe('closed');
  });
});
