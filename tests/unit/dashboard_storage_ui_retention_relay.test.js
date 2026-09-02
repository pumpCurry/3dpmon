/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 ストレージUIリレー子保持設定テスト
 * @file dashboard_storage_ui_retention_relay.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_storage_ui_retention_relay_test
 *
 * 【機能内容サマリ】
 * - リレー子ウィンドウで印刷履歴保持設定が親権威を破らないことを検証
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1645 (PR #441)
 * @since   1.390.1645 (PR #441)
 * @lastModified 2026-09-02 14:40:50
 * -----------------------------------------------------------
 * @todo
 * - none
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  monitorData: {
    appSettings: {
      printHistoryMaxEntries: 42,
      logMaxLines: 1000,
      chartWindowMin: 15,
      logReceivedRaw: false,
      negativeRemainingDisplayMode: "show-negative"
    },
    machines: {}
  },
  applyConfiguredPrintHistoryRetentionToAllMachines: vi.fn(() => ({ removedJobs: 0 })),
  saveUnifiedStorage: vi.fn(),
  syncStorageNow: vi.fn(),
  setChartWindowMinutes: vi.fn((value) => value)
}));

vi.mock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: mocks.monitorData
}));

vi.mock("../../3dp_lib/dashboard_chart.js", () => ({
  setChartWindowMinutes: mocks.setChartWindowMinutes
}));

vi.mock("../../3dp_lib/dashboard_storage.js", () => ({
  estimateStorageQuota: vi.fn(async () => ({ usage: 0, quota: 1 })),
  estimateLocalStorageUsageBytes: vi.fn(() => 0),
  syncStorageNow: mocks.syncStorageNow,
  testMaxLocalStorageQuota: vi.fn(async () => 0),
  exportAllData: vi.fn(() => ({})),
  importAllData: vi.fn(async () => ({})),
  importHistoryOnly: vi.fn(async () => ({})),
  saveUnifiedStorage: mocks.saveUnifiedStorage,
  resolvePrintHistoryRetentionLimit: vi.fn((settings) => Number(settings?.printHistoryMaxEntries) || 0),
  applyConfiguredPrintHistoryRetentionToAllMachines: mocks.applyConfiguredPrintHistoryRetentionToAllMachines,
  MAX_PRINT_HISTORY: 100000
}));

const { initStorageUI } = await import("../../3dp_lib/dashboard_storage_ui.js");

/**
 * ストレージ設定UIが参照する最小DOMを構築する。
 *
 * 【詳細説明】
 * - 本テストはリレー子での印刷履歴保持設定だけを検証するため、
 *   Export/Import等のボタンもIDだけを揃えて副作用を最小化する。
 *
 * @function mountStorageDom
 * @returns {{retention:HTMLInputElement,max:HTMLInputElement,status:HTMLElement}} 主要入力要素。
 */
function mountStorageDom() {
  document.body.innerHTML = `
    <div id="storage-panel"><div></div></div>
    <span id="storage-usage"></span>
    <span id="storage-last-sync"></span>
    <span id="storage-error"></span>
    <button id="storage-save-btn"></button>
    <button id="storage-quota-test-btn"></button>
    <input id="setting-log-max-lines" type="number">
    <input id="setting-chart-window-min" type="number">
    <input id="setting-print-history-retention-enabled" type="checkbox">
    <input id="setting-print-history-max-entries" type="number">
    <span id="setting-print-history-retention-status"></span>
    <input id="setting-log-received-raw" type="checkbox">
    <select id="setting-negative-remaining-display">
      <option value="show-negative"></option>
      <option value="clamp-zero"></option>
    </select>
    <div id="storage-modal-overlay" class="open"></div>
  `;
  return {
    retention: document.getElementById("setting-print-history-retention-enabled"),
    max: document.getElementById("setting-print-history-max-entries"),
    status: document.getElementById("setting-print-history-retention-status")
  };
}

describe("ストレージUI — リレー子の印刷履歴保持設定", () => {
  beforeEach(() => {
    mocks.monitorData.appSettings.printHistoryMaxEntries = 42;
    mocks.applyConfiguredPrintHistoryRetentionToAllMachines.mockClear();
    mocks.saveUnifiedStorage.mockClear();
    delete window.getRelayMode;
    delete window._3dpmonRelayChild;
  });

  afterEach(() => {
    document.body.innerHTML = "";
    delete window.getRelayMode;
    delete window._3dpmonRelayChild;
  });

  it("readonly子では履歴保持設定を表示のみとし、ローカルtrimを実行しない", () => {
    window.getRelayMode = () => "readonly";
    window._3dpmonRelayChild = true;
    const { retention, max, status } = mountStorageDom();

    initStorageUI();

    expect(retention.disabled).toBe(true);
    expect(max.disabled).toBe(true);
    expect(status.textContent).toContain("親ウィンドウ");

    retention.checked = false;
    retention.dispatchEvent(new Event("change", { bubbles: true }));

    expect(mocks.monitorData.appSettings.printHistoryMaxEntries).toBe(42);
    expect(mocks.applyConfiguredPrintHistoryRetentionToAllMachines).not.toHaveBeenCalled();
    expect(mocks.saveUnifiedStorage).not.toHaveBeenCalled();
  });

  it("satellite子でも履歴保持設定は親権威の表示のみとする", () => {
    window.getRelayMode = () => "satellite";
    window._3dpmonRelayChild = true;
    const { retention, max } = mountStorageDom();

    initStorageUI();

    expect(retention.disabled).toBe(true);
    expect(max.disabled).toBe(true);
  });
});
