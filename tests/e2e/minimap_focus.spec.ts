/**
 * @fileoverview
 * @description minimap focus e2e test
 * @file minimap_focus.spec.ts
 * -----------------------------------------------------------
 * @module tests/e2e_minimap_focus
 *
 * 【機能内容サマリ】
 * - ミニマップ操作でカードへスクロールしハイライトされるか検証
 */

import { test, expect } from '@playwright/test';

test('focus card via minimap', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const [{ MiniMap }, { default: LayoutStore }] = await Promise.all([
      import('/src/widgets/MiniMap.js'),
      import('/src/core/LayoutStore.js')
    ]);
    window.store = new LayoutStore();
    window.store.current = {
      id: 'l1', name: 'L1', updated: 0, filter: 'ALL',
      grid: [{ id: 'c1', x: 0, y: 0, w: 1, h: 1 }]
    };
    const card = document.createElement('div');
    card.dataset.cardInst = 'c1';
    card.style.height = '500px';
    card.textContent = 'card';
    document.body.appendChild(card);
    window.mm = new MiniMap({ container: document.body, store: window.store, bus: window.bus });
    window.scrollTo(0, 1000);
  });
  await page.locator('svg rect[data-id="c1"]').click();
  await expect(page.locator('[data-card-inst="c1"]')).toHaveClass(/highlight/);
});

test('Alt+M toggles minimap', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const [{ MiniMap }, { default: LayoutStore }] = await Promise.all([
      import('/src/widgets/MiniMap.js'),
      import('/src/core/LayoutStore.js')
    ]);
    window.store = new LayoutStore();
    window.store.current = { id: 'l1', name: 'L1', updated: 0, filter: 'ALL', grid: [] };
    window.mm = new MiniMap({ container: document.body, store: window.store, bus: window.bus });
  });
  await page.keyboard.press('Alt+M');
  await expect(page.locator('.minimap')).toHaveClass(/hidden/);
  await page.keyboard.press('Alt+M');
  await expect(page.locator('.minimap')).not.toHaveClass(/hidden/);
});
