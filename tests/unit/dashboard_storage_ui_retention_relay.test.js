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
 * - 親ウィンドウの保持設定入力がstrict integerだけを保存することを検証
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1653 (PR #440)
 * @since   1.390.1645 (PR #441)
 * @lastModified 2026-09-02 16:47:35
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

/**
 * テスト用に履歴保持上限を本番と同じstrict positive integer規則で解釈する。
 *
 * 【詳細説明】
 * - UIテストのmockが`Number()`で指数表記を受け入れると、本番storage normalizerとの境界を
 *   検証できないため、ここでは十進整数文字列と正のsafe integerだけを受理する。
 *
 * @function resolveStrictRetentionLimitForTest
 * @param {Object|null|undefined} settings - appSettings互換値。
 * @returns {number} 0または1以上の保持上限。
 */
function resolveStrictRetentionLimitForTest(settings) {
  const raw = settings?.printHistoryMaxEntries;
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!/^[0-9]+$/.test(trimmed)) return 0;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  }
  return 0;
}

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
  resolvePrintHistoryRetentionLimit: vi.fn(resolveStrictRetentionLimitForTest),
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

  it("親ウィンドウでも指数表記の保持上限は保存せず、即時trimを実行しない", () => {
    window.getRelayMode = () => "parent";
    mocks.monitorData.appSettings.printHistoryMaxEntries = 42;
    const { retention, max } = mountStorageDom();

    initStorageUI();

    retention.checked = true;
    max.disabled = false;
    max.value = "1e3";
    max.dispatchEvent(new Event("change", { bubbles: true }));

    expect(mocks.monitorData.appSettings.printHistoryMaxEntries).toBe(42);
    expect(mocks.applyConfiguredPrintHistoryRetentionToAllMachines).not.toHaveBeenCalled();
    expect(mocks.saveUnifiedStorage).not.toHaveBeenCalled();
    expect(max.value).toBe("42");
  });
});
