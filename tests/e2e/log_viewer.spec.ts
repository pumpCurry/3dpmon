/**
 * @fileoverview
 * @description 3dpmon LogViewer e2e test
 * @file log_viewer.spec.ts
 * -----------------------------------------------------------
 * @module tests/e2e_log_viewer
 *
 * 【機能内容サマリ】
 * - サイドバーから Logs ダイアログが開きログが表示されるか検証
 *
 * @version 1.390.618 (PR #286)
 * @since   1.390.618 (PR #286)
 * @lastModified 2025-07-02 09:09:00
 */

import { test, expect } from '@playwright/test';

test('open logs and append entry', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'L' }).click();
  const dlg = page.locator('dialog.log-viewer');
  await expect(dlg).toBeVisible();
  await page.evaluate(() => window.bus.emit('log:add', '[Error] foo'));
  await expect(dlg.locator('pre')).toHaveText(/foo/);
});
