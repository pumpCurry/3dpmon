// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 SplashScreen 単体テスト
 * @file splash.test.js
 * -----------------------------------------------------------
 * @module tests/splash
 *
 * 【機能内容サマリ】
 * - SplashScreen の Enter ボタンが auth:ok を発火するか検証
 *
 * @version 1.390.580 (PR #268)
 * @since   1.390.580 (PR #268)
 * @lastModified 2025-07-01 00:00:00
 */

import { it, expect, vi } from 'vitest';
import { bus } from '@core/EventBus.js';
import SplashScreen from '../src/splash/SplashScreen.js';

it('emits auth:ok on Enter', () => {
  const spy = vi.fn();
  bus.on('auth:ok', spy);
  const s = new SplashScreen(bus);
  s.mount(document.body);
  document.querySelector('button.enter').click();
  expect(spy).toHaveBeenCalled();
  s.destroy();
});
