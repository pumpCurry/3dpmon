/**
 * @fileoverview
 * @description 3dpmon Connection Manager e2e test
 * @file conn_manager.spec.ts
 * -----------------------------------------------------------
 * @module tests/e2e_conn_manager
 *
 * 【機能内容サマリ】
 * - Connections モーダルから追加したタブが保持されるか検証
 *
 * @version 1.390.600 (PR #277)
 * @since   1.390.600 (PR #277)
 * @lastModified 2025-07-01 12:00:00
 */

import { test, expect } from '@playwright/test';

test('add connection and persist', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '≡' }).click();
  await page.getByRole('button', { name: 'Connections' }).click();
  await page.getByLabel('IP').fill('127.0.0.1');
  await page.getByLabel('WS').fill('8080');
  await page.getByLabel('Cam').fill('80');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('tab', { name: '127.0.0.1' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('tab', { name: '127.0.0.1' })).toBeVisible();
});
