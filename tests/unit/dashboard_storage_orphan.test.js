/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 orphan storage key 単体テスト
 * @file dashboard_storage_orphan.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_storage_orphan_test
 *
 * 【機能内容サマリ】
 * - データを持つ孤児ホストキーを自動削除しない安全判定を検証
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1580 (PR #440)
 * @since   1.390.1538 (PR #439)
 * @lastModified 2026-09-01 13:38:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../3dp_lib/dashboard_data.js', () => ({
  monitorData: { machines: {} },
  ensureMachineData: vi.fn(),
  PLACEHOLDER_HOSTNAME: '_$_NO_MACHINE_$_',
}));
vi.mock('../../3dp_lib/dashboard_filament_presets.js', () => ({ FILAMENT_PRESETS: [] }));
vi.mock('../../3dp_lib/dashboard_log_util.js', () => ({
  logManager: { add: vi.fn() },
}));
vi.mock('../../3dp_lib/dashboard_utils.js', () => ({
  getCurrentTimestamp: vi.fn(() => 0),
}));
vi.mock('../../3dp_lib/dashboard_storage_idb.js', () => ({
  initIdb: vi.fn(), isIdbAvailable: vi.fn(() => false), getIdbCache: vi.fn(),
  queueSharedWrite: vi.fn(), queueMachineWrite: vi.fn(), flushIdb: vi.fn(),
  exportAllIdb: vi.fn(), importAllIdb: vi.fn(),
  compareAndSwapSharedValue: vi.fn(),
}));

const { isEmptyHostShell } = await import('../../3dp_lib/dashboard_storage.js');

describe('isEmptyHostShell — 孤児ホストキー削除の安全判定', () => {
  it('★回帰: 印刷履歴を持つホストは削除対象にしない', () => {
    const data = { printStore: { history: [{ id: 1 }] }, storedData: {} };
    expect(isEmptyHostShell(data)).toBe(false);
  });

  it('★回帰: storedData を持つホストは削除対象にしない', () => {
    const data = { printStore: { history: [] }, storedData: { hostname: { rawValue: 'k1' } } };
    expect(isEmptyHostShell(data)).toBe(false);
  });

  it('履歴も storedData も無い空シェルは削除可', () => {
    expect(isEmptyHostShell({ printStore: { history: [] }, storedData: {} })).toBe(true);
    expect(isEmptyHostShell({})).toBe(true);
    expect(isEmptyHostShell(null)).toBe(true);
    expect(isEmptyHostShell(undefined)).toBe(true);
  });

  it('printStore はあるが history が空、storedData も空 → 削除可', () => {
    expect(isEmptyHostShell({ printStore: { history: [], current: null, videos: [] }, storedData: {} })).toBe(true);
  });

  it('★回帰: フィラメント履歴(history内filamentInfo)を持つホストは保持', () => {
    const data = {
      printStore: { history: [{ id: 5, filamentInfo: [{ spoolId: 'A' }], usagetime: 3600 }] },
    };
    expect(isEmptyHostShell(data)).toBe(false);
  });

  it('history が1件でもあれば保持（usagetime/時間履歴の保護）', () => {
    expect(isEmptyHostShell({ printStore: { history: [{ id: 1, usagetime: 100 }] } })).toBe(false);
  });
});
