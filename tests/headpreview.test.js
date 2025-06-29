// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 HeadPreviewCard 単体テスト
 * @file headpreview.test.js
 * -----------------------------------------------------------
 * @module tests/headpreview
 *
 * 【機能内容サマリ】
 * - HeadPreviewCard の描画ループと update 動作を検証
 * @version 1.390.561 (PR #258)
 * @since   1.390.560 (PR #257)
 * @lastModified 2025-06-29 12:35:19
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import HeadPreviewCard from '@cards/Card_HeadPreview.js';
import { bus } from '@core/EventBus.js';

describe('HeadPreviewCard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('mounts canvas element', () => {
    const card = new HeadPreviewCard(bus);
    card.init({ position: { x: 0, y: 0, z: 0 }, model: 'K1' });
    card.mount(document.body);
    expect(document.querySelector('canvas')).toBeTruthy();
    card.destroy();
  });

  it('update draws new position', () => {
    const card = new HeadPreviewCard(bus);
    card.init({ position: { x: 0, y: 0, z: 0 }, model: 'K1' });
    card.mount(document.body);
    card.update({ position: { x: 10, y: 10, z: 0 } });
    expect(card.el.getAttribute('aria-label')).toMatch('10');
    card.destroy();
  });

  it('has keyboard attributes', () => {
    const card = new HeadPreviewCard(bus);
    card.init({ position: { x: 0, y: 0, z: 0 }, model: 'K1' });
    card.mount(document.body);
    expect(card.el.getAttribute('tabindex')).toBe('0');
    expect(card.el.getAttribute('aria-keyshortcuts')).toBe('Space,?');
    card.destroy();
  });
});
