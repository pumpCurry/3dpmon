/**
 * @fileoverview dashboard_connection.js getDisplayBaseUrl のユニットテスト
 *
 * 仕様:
 *   - リレー子(window._3dpmonRelayChild===true): 親プロキシを指す相対URL
 *     "/relay-image/{encodeURIComponent(host)}" を返す（getDeviceIp に依存しない）。
 *   - 親/standalone: 従来どおり "http://{ip}:{httpPort}" の直URLを返す。
 *     未接続ホストでは ip 空 + 既定httpPort(80) → "http://:80"。
 *   - host に特殊文字を含む場合は子モードで encodeURIComponent される。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// dashboard_connection.js の全直接依存をモックして純粋に getDisplayBaseUrl を検証する。
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
}));
vi.mock("../../3dp_lib/3dp_dashboard_init.js", () => ({ restorePrintResume: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_msg_handler.js", () => ({ processData: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_printmanager.js", () => ({}));
vi.mock("../../3dp_lib/dashboard_notification_manager.js", () => ({ showAlert: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_camera_ctrl.js", () => ({
  startCameraStream: vi.fn(),
  stopCameraStream: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_utils.js", () => ({ getCurrentTimestamp: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_panel_menu.js", () => ({ updatePanelMenuHosts: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_panel_factory.js", () => ({
  migratePanelsToHost: vi.fn(),
  renamePanelsHost: vi.fn(),
  ensureHostPanels: vi.fn(),
  removePanelsForHost: vi.fn(),
  updateAllPanelHeaders: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_storage.js", () => ({ saveUnifiedStorage: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_ui_confirm.js", () => ({ showConfirmDialog: vi.fn() }));

const { getDisplayBaseUrl } = await import("../../3dp_lib/dashboard_connection.js");

describe("getDisplayBaseUrl — 表示用ベースURL", () => {
  beforeEach(() => {
    delete window._3dpmonRelayChild;
  });
  afterEach(() => {
    delete window._3dpmonRelayChild;
  });

  it("リレー子モード → 親プロキシ相対URL（/relay-image/{host}）", () => {
    window._3dpmonRelayChild = true;
    expect(getDisplayBaseUrl("k1-max")).toBe("/relay-image/k1-max");
  });

  it("リレー子モード → host を encodeURIComponent する", () => {
    window._3dpmonRelayChild = true;
    // スペースや / を含むホスト名でもパス境界を壊さない
    expect(getDisplayBaseUrl("my host/01")).toBe("/relay-image/my%20host%2F01");
  });

  it("非子モード(未接続ホスト) → http://:80（ip空 + 既定httpPort）", () => {
    // window._3dpmonRelayChild 未設定 = 親/standalone
    expect(getDisplayBaseUrl("unknown-host")).toBe("http://:80");
  });

  it("_3dpmonRelayChild が true 以外(falsy)なら直URL扱い", () => {
    window._3dpmonRelayChild = false;
    expect(getDisplayBaseUrl("h")).toBe("http://:80");
  });
});
