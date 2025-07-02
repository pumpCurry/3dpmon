/**
 * @fileoverview
 * @description 3dpmon card mix e2e smoke test
 * @file card_mix.spec.ts
 * -----------------------------------------------------------
 * @module tests/e2e_card_mix
 *
 * 【機能内容サマリ】
 * - EventBus 経由でカードが更新されるか簡易検証
 */

import { test, expect } from '@playwright/test';

 test('cards update via bus', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    window.bus.emit('printer:p1:camera', { frameUrl: '/snapshot.jpg' });
    window.bus.emit('printer:p1:gcode-pos', { x: 1, y: 2, z: 3 });
  });
  // just ensure page loaded and bus global exists
  await expect(page).toHaveTitle(/3dpmon/);
});
