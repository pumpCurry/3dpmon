// @vitest-environment happy-dom
/**
 * @fileoverview
 * @description 3dpmon ConnManagerModal unit tests
 * @file conn_manager.test.js
 * -----------------------------------------------------------
 * @module tests/conn_manager
 *
 * 【機能内容サマリ】
 * - ConnManagerModal の validate とイベント発火を検証
 *
 * @version 1.390.600 (PR #277)
 * @since   1.390.600 (PR #277)
 * @lastModified 2025-07-01 12:00:00
 */

import { describe, it, expect, vi } from 'vitest';
import ConnManagerModal from '@dialogs/ConnManagerModal.js';
import { bus } from '@core/EventBus.js';

describe('ConnManagerModal', () => {
  it('validate checks ip and ports', () => {
    expect(ConnManagerModal.validate('192.168.0.1', '80', '8080')).toBe(true);
    expect(ConnManagerModal.validate('bad', '80', '8080')).toBe(false);
  });

  it('emits conn:add on form submit', () => {
    const spy = vi.fn();
    bus.on('conn:add', spy);
    const dlg = new ConnManagerModal(bus);
    dlg.open();
    const form = dlg.dialog.querySelector('form');
    form.ip.value = '127.0.0.1';
    form.ws.value = '8080';
    form.cam.value = '80';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(spy).toHaveBeenCalled();
    dlg.close();
  });
});
