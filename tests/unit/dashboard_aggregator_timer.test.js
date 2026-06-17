/**
 * @fileoverview aggregator タイマー自己修復セマンティクス 回帰テスト（PR #385）
 *
 * 背景（実機 DevTools で確定した 2fps 停止の真因）:
 *   集約ループ(setInterval 500ms)が stopAggregatorTimer() で停止されると、
 *   全ホストの storedData→DOM 反映が止まる（dirty が消化されず固着、
 *   グラフは rawValue 直読のため別途動く）。原因は handleSocketClose の
 *   接続数判定が Moonraker(s.ws を持たない)を数えず誤停止していたこと。
 *
 * 本テストで固定する不変条件:
 *   (1) ensureAggregatorTimer は停止中のみ起動する（自己修復）。
 *   (2) ensureAggregatorTimer は稼働中 no-op＝clearInterval を呼ばない
 *       （= 高頻度呼び出ししても発火を妨げない。restartAggregatorTimer の
 *         clear+再生成スパムで永遠に発火しない不具合を避ける設計）。
 *   (3) restartAggregatorTimer は稼働中 clear+再生成する。
 *   (4) stopAggregatorTimer 後でも ensureAggregatorTimer で復帰する。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: { appSettings: { updateInterval: 500 }, machines: {} },
  setStoredDataForHost: vi.fn(),
  PLACEHOLDER_HOSTNAME: "_$_NO_MACHINE_$_",
}));
vi.mock("../../3dp_lib/dashboard_ui.js", () => ({
  clearNewClasses: vi.fn(), updateStoredDataToDOM: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_storage.js", () => ({
  saveUnifiedStorage: vi.fn(), loadPrintCurrent: vi.fn(() => ({})),
}));
vi.mock("../../3dp_lib/dashboard_chart.js", () => ({
  updateTemperatureGraphFromStoredData: vi.fn(), switchChartHost: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_thermal_guard.js", () => ({
  createThermalState: vi.fn(() => ({})), evaluateThermal: vi.fn(), getThermalConfig: vi.fn(() => ({})),
}));
vi.mock("../../3dp_lib/dashboard_utils.js", () => ({
  checkUpdatedFields: vi.fn(), formatDuration: vi.fn(() => ""), formatDurationSimple: vi.fn(() => ""),
}));
vi.mock("../../3dp_lib/dashboard_notification_manager.js", () => ({
  notificationManager: { statusSnapshotEnabled: false, notify: vi.fn() },
}));
vi.mock("../../3dp_lib/dashboard_ui_mapping.js", () => ({
  PRINT_STATE_CODE: { printIdle: 0, printStarted: 1, printPaused: 2, printDone: 3 },
}));
vi.mock("../../3dp_lib/dashboard_filament_change.js", () => ({
  showFilamentChangeDialog: vi.fn(), closeFilamentChangeDialog: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_spool.js", () => ({
  getCurrentSpool: vi.fn(() => null), reserveFilament: vi.fn(), finalizeFilamentUsage: vi.fn(),
  autoCorrectCurrentSpool: vi.fn(), addUsageSnapshot: vi.fn(), beginExternalPrint: vi.fn(),
  formatFilamentAmount: vi.fn(() => ({ display: "" })), formatSpoolDisplayId: vi.fn(() => ""),
  getSpoolById: vi.fn(() => null), setCurrentSpoolId: vi.fn(), addInferredSpool: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_filament_ledger.js", () => ({
  reconcileSpool: vi.fn(), recordFilamentEvent: vi.fn(), resolveFilamentEvent: vi.fn(),
  getOpenFilamentEvent: vi.fn(() => null), runoutGateHeld: vi.fn(() => false),
}));
vi.mock("../../3dp_lib/dashboard_connection.js", () => ({
  getConnectionState: vi.fn(() => "connected"),
}));

const { restartAggregatorTimer, stopAggregatorTimer, ensureAggregatorTimer } =
  await import("../../3dp_lib/dashboard_aggregator.js");

describe("aggregatorタイマー 自己修復セマンティクス", () => {
  let setSpy, clrSpy;

  beforeEach(() => {
    vi.useFakeTimers();
    // 既定で停止状態にする（前テストのタイマーを掃除）。timer=null なら no-op。
    stopAggregatorTimer();
    setSpy = vi.spyOn(globalThis, "setInterval");
    clrSpy = vi.spyOn(globalThis, "clearInterval");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    stopAggregatorTimer();
    vi.useRealTimers();
  });

  it("(1) 停止中の ensureAggregatorTimer は1本だけ起動する", () => {
    ensureAggregatorTimer();
    expect(setSpy).toHaveBeenCalledTimes(1);
  });

  it("(2) 稼働中の多重 ensureAggregatorTimer は no-op（clear/再生成しない）", () => {
    ensureAggregatorTimer();          // 起動
    setSpy.mockClear(); clrSpy.mockClear();
    ensureAggregatorTimer();
    ensureAggregatorTimer();
    ensureAggregatorTimer();
    expect(setSpy).not.toHaveBeenCalled();   // 追加生成しない
    expect(clrSpy).not.toHaveBeenCalled();   // clear しない＝稼働中タイマーの発火を妨げない
  });

  it("(3) restartAggregatorTimer は稼働中 clear+再生成する", () => {
    ensureAggregatorTimer();
    setSpy.mockClear(); clrSpy.mockClear();
    restartAggregatorTimer();
    expect(clrSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledTimes(1);
  });

  it("(4) stopAggregatorTimer 後に ensureAggregatorTimer で復帰する（自己修復）", () => {
    ensureAggregatorTimer();
    stopAggregatorTimer();
    setSpy.mockClear();
    ensureAggregatorTimer();
    expect(setSpy).toHaveBeenCalledTimes(1);
  });
});
