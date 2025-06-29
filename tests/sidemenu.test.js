// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 SideMenu 単体テスト
 * @file sidemenu.test.js
 * -----------------------------------------------------------
 * @module tests/sidemenu
 *
 * 【機能内容サマリ】
 * - SideMenu の開閉とフォーカストラップを検証
 *
 * @version 1.390.563 (PR #259)
 * @since   1.390.563 (PR #259)
 * @lastModified 2025-06-29 13:09:40
 */

import { describe, it, expect, beforeEach } from 'vitest';
import SideMenu from '@cards/Bar_SideMenu.js';
import { bus } from '@core/EventBus.js';

describe('SideMenu', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('opens and closes via methods', () => {
    const menu = new SideMenu(bus);
    menu.mount(document.body);
    menu.open();
    expect(menu.el.style.transform).toBe('translateX(0)');
    menu.close();
    expect(menu.el.style.transform).toBe('translateX(-100%)');
  });
});
