// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 App 結合テスト
 * @file app.test.js
 * -----------------------------------------------------------
 * @module tests/app
 *
 * 【機能内容サマリ】
 * - App 初期化時に DashboardManager が描画されるか検証
 *
 * @version 1.390.576 (PR #260)
 * @since   1.390.576 (PR #260)
 * @lastModified 2025-06-30 12:00:00
 */

import { describe, it, beforeEach, expect } from 'vitest';
import { App } from '@core/App.js';

describe('App', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
  });

  it('renders title bar on initialization', () => {
    new App('#root');
    expect(document.querySelector('.title-bar')).not.toBeNull();
    expect(document.querySelector('main.dashboard-main')).not.toBeNull();
  });
});
