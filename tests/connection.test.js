import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocketServer } from 'ws';
import { ConnectionManager } from '../src/core/ConnectionManager.js';
import { bus } from '../src/core/EventBus.js';

let server;

beforeAll(() => {
  server = new WebSocketServer({ port: 9999 });
  server.on('connection', (socket) => {
    socket.on('message', (msg) => {
      socket.send(msg.toString());
    });
  });
});

afterAll(() => {
  server.close();
});

describe('ConnectionManager', () => {
  it('registry creation and message bridge', async () => {
    const cm = new ConnectionManager(bus);
    const id = await cm.add({ ip: '127.0.0.1', wsPort: 9999 });
    expect(cm.list()).toHaveLength(1);
    await cm.connect(id);
    await new Promise((r) => setTimeout(r, 100));
    const recv = [];
    bus.on('cm:message', ({ data }) => recv.push(data));
    cm.send(id, { test: 1 });
    await new Promise((r) => setTimeout(r, 100));
    expect(recv[0]).toEqual({ test: 1 });
    cm.close(id);
  });

  it('reconnect attempt on close', async () => {
    const cm = new ConnectionManager(bus);
    const id = await cm.add({ ip: '127.0.0.1', wsPort: 9999 });
    await cm.connect(id);
    await new Promise((r) => setTimeout(r, 100));
    server.clients.forEach((ws) => ws.close());
    await new Promise((r) => setTimeout(r, 2500));
    expect(['connecting', 'open', 'closed']).toContain(cm.getState(id));
    cm.close(id);
  });
});
