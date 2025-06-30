/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon E2E テスト (splash -> dashboard)
 * @file e2e_splash.spec.ts
 * -----------------------------------------------------------
 * @module tests/e2e_splash
 *
 * 【機能内容サマリ】
 * - SplashScreen 表示から Enter 操作で Dashboard が表示されるか検証
 *
 * @version 1.390.580 (PR #268)
 * @since   1.390.580 (PR #268)
 * @lastModified 2025-07-01 00:00:00
 */

import { test, expect } from '@playwright/test';

test('splash -> dashboard', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('img', { name: /logo/i })).toBeVisible();
  await page.getByRole('button', { name: /enter/i }).click();
  await expect(page.getByRole('navigation')).toBeVisible();
});
