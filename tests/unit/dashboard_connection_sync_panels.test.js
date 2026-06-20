/**
 * @fileoverview _syncPanelsForHost 冪等化 回帰テスト（PR #385, 真の2fps killer）
 *
 * 真因(実機 DevTools のスタックで確定):
 *   handleSocketMessage → updateConnectionHost(oldHost===newHost) → _syncPanelsForHost
 *   が「毎メッセージ(約4Hz)」呼ばれ、その中で restartAggregatorTimer() を毎回実行して
 *   500ms タイマーを約250ms毎にクリア＆再生成 → 発火(500ms)に永遠に到達せず集約ループ
 *   停止＝全状態が固着。加えて markAllKeysDirty() を毎回呼び全セル再描画していた。
 *
 * 本テストで固定する不変条件（updateConnectionHost(host,host) を N 回呼ぶ＝毎メッセージ相当）:
 *   - restartAggregatorTimer は呼ばれない（ensureAggregatorTimer に置換済み）。
 *   - ensureAggregatorTimer は毎回呼ばれる（稼働中 no-op でタイマー生存を保証）。
 *   - markAllKeysDirty / restoreAggregatorState は初回同期の1回のみ。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: { appSettings: { httpPort: 80, connectionTargets: [] }, machines: {} },
  PLACEHOLDER_HOSTNAME: "_$_NO_MACHINE_$_",
  setNotificationSuppressed: vi.fn(),
  setStoredDataForHost: vi.fn(),
  ensureMachineData: vi.fn(),
  markAllKeysDirty: vi.fn(),
  scopedById: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_log_util.js", () => ({ pushLog: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_aggregator.js", () => ({
  aggregatorUpdate: vi.fn(),
  restoreAggregatorState: vi.fn(),
  restartAggregatorTimer: vi.fn(),
  stopAggregatorTimer: vi.fn(),
  ensureAggregatorTimer: vi.fn(),
}));
vi.mock("../../3dp_lib/3dp_dashboard_init.js", () => ({ restorePrintResume: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_msg_handler.js", () => ({ processData: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_printmanager.js", () => ({}));
vi.mock("../../3dp_lib/dashboard_notification_manager.js", () => ({ showAlert: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_camera_ctrl.js", () => ({
  startCameraStream: vi.fn(), stopCameraStream: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_utils.js", () => ({ getCurrentTimestamp: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_panel_menu.js", () => ({ updatePanelMenuHosts: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_panel_factory.js", () => ({
  migratePanelsToHost: vi.fn(() => 0),
  renamePanelsHost: vi.fn(),
  ensureHostPanels: vi.fn(() => 0),
  removePanelsForHost: vi.fn(),
  updateAllPanelHeaders: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_storage.js", () => ({ saveUnifiedStorage: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_ui_confirm.js", () => ({ showConfirmDialog: vi.fn() }));

const { updateConnectionHost } = await import("../../3dp_lib/dashboard_connection.js");
const agg = await import("../../3dp_lib/dashboard_aggregator.js");
const data = await import("../../3dp_lib/dashboard_data.js");

describe("_syncPanelsForHost 冪等化（updateConnectionHost 毎メッセージ経路）", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("同一ホストで N 回呼んでも restartAggregatorTimer は0回・ensureAggregatorTimer は毎回・重い同期は1回", () => {
    const HOST = "K1Max-SYNC-A";
    const N = 6;
    for (let i = 0; i < N; i++) updateConnectionHost(HOST, HOST);

    // ★ タイマー再生成スパムが無いこと（2fps停止の真因）
    expect(agg.restartAggregatorTimer).not.toHaveBeenCalled();
    // ★ 毎回 ensureAggregatorTimer でタイマー生存を保証（稼働中 no-op）
    expect(agg.ensureAggregatorTimer).toHaveBeenCalledTimes(N);
    // ★ 重い初期同期は初回の1回のみ（毎ティック全セル再描画しない）
    expect(data.markAllKeysDirty).toHaveBeenCalledTimes(1);
    expect(agg.restoreAggregatorState).toHaveBeenCalledTimes(1);
  });

  it("別ホストはそれぞれ初回同期される（ホスト独立）", () => {
    const H1 = "K1Max-SYNC-B1", H2 = "K1Max-SYNC-B2";
    updateConnectionHost(H1, H1);
    updateConnectionHost(H1, H1);
    updateConnectionHost(H2, H2);
    updateConnectionHost(H2, H2);

    // 2ホスト分の初回同期＝markAllKeysDirty 2回（各ホスト1回ずつ）
    expect(data.markAllKeysDirty).toHaveBeenCalledTimes(2);
    expect(data.markAllKeysDirty).toHaveBeenCalledWith(H1);
    expect(data.markAllKeysDirty).toHaveBeenCalledWith(H2);
    // ensureAggregatorTimer は全呼び出しで（4回）
    expect(agg.ensureAggregatorTimer).toHaveBeenCalledTimes(4);
    expect(agg.restartAggregatorTimer).not.toHaveBeenCalled();
  });
});
