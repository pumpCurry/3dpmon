/**
 * @fileoverview
 * @description device filter e2e test
 * @file device_filter.spec.ts
 * -----------------------------------------------------------
 * @module tests/e2e_device_filter
 *
 * 【機能内容サマリ】
 * - デバイスフィルタバーの操作でカード表示が切り替わり状態が保持されるか検証
 */

import { test, expect } from '@playwright/test';

test('filter persists across reload', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const [{ default: CardContainer }, { default: LayoutStore }] = await Promise.all([
      import('/src/core/CardContainer.js'),
      import('/src/core/LayoutStore.js')
    ]);
    window.store = new LayoutStore();
    window.store.current = { id: 'l1', name: 'L1', updated: 0, grid: [], filter: 'ALL' };
    const cont = new CardContainer(window.bus, window.store);
    cont.mount(document.querySelector('main'));
    const c1 = document.createElement('div');
    c1.dataset.card = 'cam';
    c1.dataset.device = 'd1';
    document.querySelector('.card-container').appendChild(c1);
    const c2 = document.createElement('div');
    c2.dataset.card = 'cam';
    c2.dataset.device = 'd2';
    document.querySelector('.card-container').appendChild(c2);
    window.bus.emit('conn:added', { id: 'd1', ip: 'K1-MAX', color: '#0f0' });
    window.bus.emit('conn:added', { id: 'd2', ip: 'K1-C', color: '#ff0' });
  });
  await page.getByRole('button', { name: 'K1-C' }).click();
  const cards = await page.$$('[data-card]');
  await expect(cards[0]).toHaveCSS('opacity', '0.2');
  await expect(cards[1]).toHaveCSS('opacity', '1');
  await page.reload();
  await expect(page.getByRole('button', { name: 'K1-C' })).toHaveClass(/active/);
});
