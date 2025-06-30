/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon E2E テスト (theme switch)
 * @file theme.spec.ts
 * -----------------------------------------------------------
 * @module tests/e2e_theme
 *
 * 【機能内容サマリ】
 * - ハンバーガーメニューからテーマ変更が反映されるか検証
 *
 * @version 1.390.597 (PR #276)
 * @since   1.390.597 (PR #276)
 * @lastModified 2025-07-01 12:00:00
 */

import { test, expect } from '@playwright/test';

test('switch to dark theme', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '≡' }).click();
  await page.getByRole('button', { name: 'Dark' }).click();
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(24, 24, 24)');
  await page.reload();
  const bg2 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg2).toBe('rgb(24, 24, 24)');
});
