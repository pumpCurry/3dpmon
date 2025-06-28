import { describe, it, expect, vi } from 'vitest';
import { ConnectionManager } from '@core/ConnectionManager.js';
import { bus } from '@core/EventBus.js';

vi.mock('ws', () => ({
  default: (await import('./__mocks__/ws.js')).default
}));

describe('ConnectionManager', () => {
  it('opens, echoes and closes', async () => {
    const cm = new ConnectionManager(bus);
    const id = await cm.add({ ip: '127.0.0.1', wsPort: 9999 });
    await cm.connect(id);
    expect(cm.getState(id)).toBe('open');

    const p = new Promise((r) => bus.on('cm:message', r));
    cm.send(id, { ping: 1 });
    const frame = await p;
    expect(frame.data).toEqual({ ping: 1 });

    cm.close(id);
    expect(cm.getState(id)).toBe('closed');
  });
});
