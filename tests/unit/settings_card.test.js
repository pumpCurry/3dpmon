// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description Card_Settings component tests
 * @file settings_card.test.js
 * -----------------------------------------------------------
 * @module tests/settings_card
 *
 * 【機能内容サマリ】
 * - ボタンの title 属性を検証
 */

import { describe, it, expect } from 'vitest';
import { Card_Settings } from '@cards/Card_Settings.js';
import LayoutStore from '@core/LayoutStore.js';
import { bus } from '@core/EventBus.js';

describe('Card_Settings', () => {
  it('buttons contain title attributes', () => {
    const root = document.createElement('div');
    const card = new Card_Settings({ bus, store: new LayoutStore() });
    card.mount(root);
    const btns = root.querySelectorAll('button');
    expect(btns[0].title).toBe('Export');
    expect(btns[1].title).toBe('Import');
  });
});
