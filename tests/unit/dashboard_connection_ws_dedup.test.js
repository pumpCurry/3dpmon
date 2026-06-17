/**
 * @fileoverview dashboard_connection.js connectWs の多重接続防止（fix/ws-duplicate-connection）テスト
 *
 * 仕様:
 *   - 同一 dest に対して connectWs を再度呼ぶと、既存の生ソケット(CONNECTING/OPEN)を
 *     close() してから新規ソケットを生成する（WebSocket リーク/多重 onmessage を防ぐ）。
 *   - close() の前に旧ソケットの onopen/onmessage/onerror/onclose を無効化し、
 *     handleSocketClose 経由の自動再接続が誘発されないようにする。
 *   - 既存ソケットが既に CLOSED の場合は何も閉じずに新規接続する（自動再接続を壊さない）。
 *
 * 注: connectWs は connectionMap / reconnect カウンタをモジュールスコープに持ち、
 *     テスト間で状態が残るため、各テストで vi.resetModules() し再 import する。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: { appSettings: { httpPort: 80, connectionTargets: [] }, machines: {} },
  PLACEHOLDER_HOSTNAME: "_$_NO_MACHINE_$_",
  setNotificationSuppressed: vi.fn(), setStoredDataForHost: vi.fn(),
  ensureMachineData: vi.fn(), markAllKeysDirty: vi.fn(), scopedById: vi.fn(),
  getHostDisplayName: vi.fn((h) => h),
}));
vi.mock("../../3dp_lib/dashboard_log_util.js", () => ({ pushLog: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_aggregator.js", () => ({
  aggregatorUpdate: vi.fn(), restoreAggregatorState: vi.fn(),
  restartAggregatorTimer: vi.fn(), stopAggregatorTimer: vi.fn(),
}));
vi.mock("../../3dp_lib/3dp_dashboard_init.js", () => ({ restorePrintResume: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_msg_handler.js", () => ({ processData: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_printmanager.js", () => ({}));
vi.mock("../../3dp_lib/dashboard_notification_manager.js", () => ({ showAlert: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_camera_ctrl.js", () => ({
  startCameraStream: vi.fn(), stopCameraStream: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_utils.js", () => ({ getCurrentTimestamp: vi.fn(() => "t") }));
vi.mock("../../3dp_lib/dashboard_panel_menu.js", () => ({ updatePanelMenuHosts: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_panel_factory.js", () => ({
  migratePanelsToHost: vi.fn(), renamePanelsHost: vi.fn(), ensureHostPanels: vi.fn(),
  removePanelsForHost: vi.fn(), updateAllPanelHeaders: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_storage.js", () => ({ saveUnifiedStorage: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_ui_confirm.js", () => ({ showConfirmDialog: vi.fn() }));

/** new WebSocket() を記録するフェイク実装 */
class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static instances = [];
  constructor(url) {
    this.url = url; this.binaryType = "";
    this.readyState = FakeWebSocket.OPEN; // 生成直後から OPEN とみなす
    this.closeCalls = 0;
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
    FakeWebSocket.instances.push(this);
  }
  close() { this.closeCalls++; this.readyState = FakeWebSocket.CLOSED; }
  send() {}
}

let connectWs;
beforeEach(async () => {
  vi.resetModules();                 // connectionMap / reconnect を毎回まっさら化
  FakeWebSocket.instances = [];
  global.WebSocket = FakeWebSocket;
  window.WebSocket = FakeWebSocket;
  delete window._3dpmonRelayChild;
  ({ connectWs } = await import("../../3dp_lib/dashboard_connection.js"));
});
afterEach(() => { delete window._3dpmonRelayChild; });

describe("connectWs — 多重接続防止 (fix/ws-duplicate-connection)", () => {
  it("同一destへ再接続すると旧ソケットを閉じ、ハンドラを無効化し、生存は1本だけ", () => {
    connectWs("127.0.0.1:9999");
    expect(FakeWebSocket.instances.length).toBe(1);
    const first = FakeWebSocket.instances[0];
    expect(first.closeCalls).toBe(0);

    connectWs("127.0.0.1:9999"); // 再接続: 旧を閉じてから新規
    expect(FakeWebSocket.instances.length).toBe(2);
    expect(first.closeCalls).toBe(1);            // 旧ソケットは閉じられた
    expect(first.onmessage).toBeNull();          // 多重 onmessage を防止
    expect(first.onclose).toBeNull();            // 自動再接続の誘発を防止

    const alive = FakeWebSocket.instances.filter(w => w.readyState !== FakeWebSocket.CLOSED);
    expect(alive.length).toBe(1);                // 生きているのは新ソケット1本だけ
  });

  it("既存ソケットが既にCLOSEDなら追加で閉じない（自動再接続を壊さない）", () => {
    connectWs("127.0.0.1:9999");
    const first = FakeWebSocket.instances[0];
    first.readyState = FakeWebSocket.CLOSED;      // 自然切断済みを模擬
    connectWs("127.0.0.1:9999");
    expect(first.closeCalls).toBe(0);            // CLOSED には close() を呼ばない
    expect(FakeWebSocket.instances.length).toBe(2); // 新規接続は張られる
  });
});
