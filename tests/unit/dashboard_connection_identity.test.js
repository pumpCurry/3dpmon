/**
 * @fileoverview dashboard_connection.js 同一性/接続先(監査 P0)テスト
 *
 * 固定する不変条件:
 *  - T-ID-01: 同一IP・別ポートは両方とも接続候補になる（IP単位 dedupe 廃止）
 *  - T-ID-03: 同一 dest で別 hostname が返っても即上書きせず ip-reuse-conflict にする
 *  - T-ID-04: IPv6 の一時到達先キーも IP→hostname へ移行される
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: {
    appSettings: { httpPort: 80, connectionTargets: [] },
    machines: {}, hostSpoolMap: {}, filamentSpools: [],
  },
  PLACEHOLDER_HOSTNAME: "_$_NO_MACHINE_$_",
  setNotificationSuppressed: vi.fn(), setStoredDataForHost: vi.fn(),
  ensureMachineData: vi.fn(), markAllKeysDirty: vi.fn(), scopedById: vi.fn(),
  getHostDisplayName: vi.fn((h) => h),
}));
vi.mock("../../3dp_lib/dashboard_log_util.js", () => ({ pushLog: vi.fn(), pushGcodeConsole: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_aggregator.js", () => ({
  aggregatorUpdate: vi.fn(), restoreAggregatorState: vi.fn(),
  restartAggregatorTimer: vi.fn(), stopAggregatorTimer: vi.fn(), ensureAggregatorTimer: vi.fn(),
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
vi.mock("../../3dp_lib/dashboard_moonraker.js", () => ({
  createMoonrakerSession: vi.fn(() => ({ close: vi.fn() })),
  translateK1CommandToMoonraker: vi.fn(),
}));

class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static instances = [];
  constructor(url) {
    this.url = url; this.binaryType = "";
    this.readyState = FakeWebSocket.OPEN;
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
    FakeWebSocket.instances.push(this);
  }
  close() { this.readyState = FakeWebSocket.CLOSED; }
  send() {}
}

let mod, dataMock;
beforeEach(async () => {
  vi.resetModules();
  FakeWebSocket.instances = [];
  global.WebSocket = FakeWebSocket;
  window.WebSocket = FakeWebSocket;
  delete window._3dpmonRelayChild;
  mod = await import("../../3dp_lib/dashboard_connection.js");
  dataMock = await import("../../3dp_lib/dashboard_data.js");
  dataMock.monitorData.appSettings.connectionTargets = [];
  dataMock.monitorData.machines = {};
  dataMock.monitorData.hostSpoolMap = {};
  dataMock.monitorData.filamentSpools = [];
});
afterEach(() => { delete window._3dpmonRelayChild; });

describe("T-ID-01: connectAllSavedTargets — 同一IP別ポートを両方接続", () => {
  it("同一IP・別ポート(共にK1)は2本とも接続する（IP単位dedupe廃止の証跡）", () => {
    dataMock.monitorData.appSettings.connectionTargets = [
      { dest: "192.168.1.50:9999", printerType: "creality-k1", hostname: "" },
      { dest: "192.168.1.50:9998", printerType: "creality-k1", hostname: "" },
    ];
    mod.connectAllSavedTargets();
    expect(FakeWebSocket.instances.length, "同一IP別ポートで2本").toBe(2);
    const urls = FakeWebSocket.instances.map(w => w.url).join(" ");
    expect(urls).toContain("9999");
    expect(urls).toContain("9998");
  });

  it("完全同一 dest の重複は1本のみ（normalizedDest dedupe は維持）", () => {
    dataMock.monitorData.appSettings.connectionTargets = [
      { dest: "192.168.1.50:9999", printerType: "creality-k1", hostname: "" },
      { dest: "192.168.1.50:9999", printerType: "creality-k1", hostname: "" },
    ];
    mod.connectAllSavedTargets();
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it("ip-reuse-conflict の target は自動接続対象外（保留）", () => {
    dataMock.monitorData.appSettings.connectionTargets = [
      { dest: "192.168.1.50:9999", printerType: "creality-k1", hostname: "K1-A", identityStatus: "ip-reuse-conflict" },
    ];
    mod.connectAllSavedTargets();
    expect(FakeWebSocket.instances.length).toBe(0);
  });
});

describe("T-ID-03: IP再利用conflict — 即上書きしない", () => {
  it("同一 dest で別 hostname が返ると identityStatus=ip-reuse-conflict、hostname は保持", () => {
    dataMock.monitorData.appSettings.connectionTargets = [
      { dest: "192.168.1.50:9999", printerType: "creality-k1", hostname: "K1Max-A", label: "1号機", color: "#f00" },
    ];
    // connectWs で connectionMap["K1Max-A"] を用意（state.dest を確定）
    mod.connectWs("192.168.1.50:9999");
    // 別機体 hostname が確定した体で updateConnectionHost を呼ぶ
    mod.updateConnectionHost("K1Max-A", "K1C-B");

    const t = dataMock.monitorData.appSettings.connectionTargets[0];
    expect(t.hostname, "hostname は即上書きされない").toBe("K1Max-A");
    expect(t.identityStatus).toBe("ip-reuse-conflict");
    expect(t.conflict?.reportedHostname).toBe("K1C-B");
    expect(t.label, "旧機体の設定は保護").toBe("1号機");
  });
});

describe("T-ID-04: IPv6 IP→hostname 移行", () => {
  it("IPv6 一時キーの machines が hostname キーへ移行され、旧キーは消える", () => {
    dataMock.monitorData.machines["fe80::1"] = { storedData: { temp: { rawValue: 25 } } };
    // connectionMap["fe80::1"] を用意（updateConnectionHost の state 前提）
    mod.connectWs("[fe80::1]:9999");
    expect(dataMock.monitorData.machines["fe80::1"], "前提: IPv6キー存在").toBeTruthy();

    mod.updateConnectionHost("fe80::1", "K1Max-A");

    expect(dataMock.monitorData.machines["K1Max-A"], "hostnameキーへ移行").toBeTruthy();
    expect(dataMock.monitorData.machines["fe80::1"], "IPv6一時キーは削除").toBeUndefined();
  });
});
