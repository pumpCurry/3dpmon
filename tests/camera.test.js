// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 CameraCard 単体テスト
 * @file camera.test.js
 * -----------------------------------------------------------
 * @module tests/camera
 *
 * 【機能内容サマリ】
 * - CameraCard の mount と retry を検証
 *
 * @version 1.390.557 (PR #255)
 * @since   1.390.557 (PR #255)
 * @lastModified 2025-06-28 12:39:10
 */

import { describe, it, expect, beforeEach } from 'vitest';
import CameraCard from '@cards/Card_Camera.js';
import { bus } from '@core/EventBus.js';

describe('CameraCard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('mounts video element', () => {
    const card = new CameraCard(bus);
    card.init({ streamUrl: 'test.mp4' });
    card.mount(document.body);
    expect(document.querySelector('video')).toBeTruthy();
  });

  it('retry resets source', () => {
    const card = new CameraCard(bus);
    card.init({ streamUrl: 'one.mp4' });
    card.mount(document.body);
    card.update({ streamUrl: 'two.mp4' });
    card.retry();
    expect(document.querySelector('video').src).toMatch('two.mp4');
  });

  it('retry uses exponential delay', () => {
    const card = new CameraCard(bus);
    card.init({ streamUrl: 'one.mp4' });
    card.mount(document.body);
    const spy = vi.spyOn(globalThis, 'setTimeout');
    card.retry();
    expect(spy).toHaveBeenLastCalledWith(expect.any(Function), 1000);
    card.retry();
    expect(spy).toHaveBeenLastCalledWith(expect.any(Function), 2000);
    spy.mockRestore();
  });
});
