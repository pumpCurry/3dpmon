/**
 * @fileoverview 印刷再開(resume)の remainingLengthMm 非復元テスト（監査 P0-5）
 *
 * 固定する不変条件:
 *  - T-FIL-01: pd_<host>_remainingLengthMm が存在しても restorePrintResume 後に
 *    spool.remainingLengthMm は変化しない（ライブ途中値の復活を防ぐ）。
 *  - 旧キー pd_<host>_remainingLengthMm は restore 時に削除される。
 *  - persistPrintResume は remainingLengthMm を保存しない。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const spool = { id: "s1", remainingLengthMm: 12345, currentPrintID: "", currentJobStartLength: null, currentJobExpectedLength: null };

vi.mock("../../3dp_lib/dashboard_storage.js", () => ({
  initStorage: vi.fn(), restoreUnifiedStorage: vi.fn(), saveUnifiedStorage: vi.fn(), setStorageNamespace: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_panel_factory.js", () => ({ setPanelLayoutNamespace: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_data.js", () => ({
  PLACEHOLDER_HOSTNAME: "_$_NO_MACHINE_$_",
  monitorData: { machines: { A: { storedData: {} } } },
  setStoredDataForHost: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_connection.js", () => ({ connectAllSavedTargets: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_spool.js", () => ({
  addSpoolFromPreset: vi.fn(),
  getCurrentSpool: vi.fn(() => spool),
  getCurrentSpoolId: vi.fn(() => "s1"),
  setCurrentSpoolId: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_filament_presets.js", () => ({ FILAMENT_PRESETS: [] }));
vi.mock("../../3dp_lib/dashboard_notification_manager.js", () => ({
  notificationManager: { notify: vi.fn() }, showAlert: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_integration_itemkeeper.js", () => ({ itemKeeperIntegration: {} }));
vi.mock("../../3dp_lib/dashboard_aggregator.js", () => ({
  persistAggregatorState: vi.fn(), stopAggregatorTimer: vi.fn(), aggregatorUpdate: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_about.js", () => ({ initAboutDialogListener: vi.fn() }));

const { restorePrintResume, persistPrintResume } = await import("../../3dp_lib/3dp_dashboard_init.js");

beforeEach(() => {
  localStorage.clear();
  spool.remainingLengthMm = 12345;
  spool.currentPrintID = "";
  spool.currentJobStartLength = null;
  spool.currentJobExpectedLength = null;
});

describe("T-FIL-01: resume は remainingLengthMm を復元しない", () => {
  it("pd_A_remainingLengthMm があっても spool.remainingLengthMm は不変", () => {
    localStorage.setItem("pd_A_remainingLengthMm", JSON.stringify(5000));
    localStorage.setItem("pd_A_currentPrintID", JSON.stringify("job-1"));
    restorePrintResume("A");
    expect(spool.remainingLengthMm, "ライブ途中値5000で上書きされない").toBe(12345);
    expect(spool.currentPrintID, "他のspoolキーは復元される").toBe("job-1");
  });

  it("旧 pd_A_remainingLengthMm は restore 時に削除される", () => {
    localStorage.setItem("pd_A_remainingLengthMm", JSON.stringify(5000));
    restorePrintResume("A");
    expect(localStorage.getItem("pd_A_remainingLengthMm")).toBeNull();
  });

  it("persistPrintResume は pd_A_remainingLengthMm を書き出さない", () => {
    spool.remainingLengthMm = 9999;
    persistPrintResume("A");
    expect(localStorage.getItem("pd_A_remainingLengthMm")).toBeNull();
  });
});
