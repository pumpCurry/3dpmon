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
    machines: {}, hostCameraToggle: {}, hostSpoolMap: {}, filamentSpools: [],
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
vi.mock("../../3dp_lib/printer_core/dashboard_live_shadow.js", () => ({
  beginK1LiveShadowSession: vi.fn(),
  createPrinterCoreV3ShadowSessionId: vi.fn(() => "k1-live:test-session"),
  endK1LiveShadowSession: vi.fn(),
  observeK1LiveShadowFrame: vi.fn(),
  resolveK1LiveShadowDeviceId: vi.fn(({ identity, identityConflict, identityConflicts, host, dest }) => {
    const hasOpenConflict = identityConflict?.status === "open" ||
      (Array.isArray(identityConflicts) && identityConflicts.some((entry) => entry?.status === "open"));
    return hasOpenConflict
      ? `provisional-shadow:endpoint:${encodeURIComponent(dest)}`
      : identity?.deviceIdSeed || `host:${host}`;
  }),
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

let mod, dataMock, shadowMock;
beforeEach(async () => {
  vi.resetModules();
  FakeWebSocket.instances = [];
  global.WebSocket = FakeWebSocket;
  window.WebSocket = FakeWebSocket;
  delete window._3dpmonRelayChild;
  mod = await import("../../3dp_lib/dashboard_connection.js");
  dataMock = await import("../../3dp_lib/dashboard_data.js");
  shadowMock = await import("../../3dp_lib/printer_core/dashboard_live_shadow.js");
  dataMock.monitorData.appSettings.connectionTargets = [];
  dataMock.monitorData.machines = {};
  dataMock.monitorData.hostCameraToggle = {};
  dataMock.monitorData.hostSpoolMap = {};
  dataMock.monitorData.filamentSpools = [];
  vi.clearAllMocks();
});
afterEach(() => {
  for (const ws of FakeWebSocket.instances) {
    try { ws.close(); } catch { /* noop */ }
  }
  delete window._3dpmonRelayChild;
});

function connectK1Socket(dest) {
  mod.connectWithType(dest, "creality-k1");
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

function receiveK1Status(ip, host, extra = {}) {
  mod.simulateReceivedJson(JSON.stringify({
    hostname: host,
    model: "K1 Max",
    printProgress: 50,
    video: 1,
    video1: 0,
    ...extra,
  }), ip);
}

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

describe("Printer Core v3 identity dry-run", () => {
  it("WS受信データからv3 identity候補をconnectionTargetsへ保存する", () => {
    mod.connectWithType("203.0.113.10:9999", "creality-k1");
    mod.simulateReceivedJson(JSON.stringify({
      hostname: "K2Pro-Test",
      model: "F012",
      sn: "K2PRO-SERIAL-001",
      mac: "AA1122334455",
    }), "203.0.113.10");

    const target = dataMock.monitorData.appSettings.connectionTargets[0];
    expect(target.hostname).toBe("K2Pro-Test");
    expect(target.printerCoreV3Identity).toMatchObject({
      schemaVersion: 1,
      dryRun: true,
      deviceIdSeed: "serial:k2pro-serial-001",
      identityStrength: "serial",
      reportedModel: "F012",
      reportedHostname: "K2Pro-Test",
    });
    expect(target.printerCoreV3Identity.endpointAliases.addresses).toEqual(["203.0.113.10"]);
    expect(target.printerCoreV3Identity.endpointAliases.macs).toEqual(["aa:11:22:33:44:55"]);
  });

  it("同一serialの別endpoint/別MACはDHCP統合後もaliasとして保持する", () => {
    mod.connectWithType("203.0.113.10:9999", "creality-k1");
    mod.simulateReceivedJson(JSON.stringify({
      hostname: "K2Pro-Test",
      model: "F012",
      sn: "K2PRO-SERIAL-001",
      mac: "AA1122334455",
    }), "203.0.113.10");

    mod.connectWithType("203.0.113.11:9999", "creality-k1");
    mod.simulateReceivedJson(JSON.stringify({
      hostname: "K2Pro-Test",
      model: "F012",
      sn: "K2PRO-SERIAL-001",
      mac: "66778899AABB",
    }), "203.0.113.11");

    const targets = dataMock.monitorData.appSettings.connectionTargets;
    expect(targets.length).toBe(1);
    expect(targets[0].dest).toBe("203.0.113.11:9999");
    expect(targets[0].printerCoreV3Identity.deviceIdSeed).toBe("serial:k2pro-serial-001");
    expect(targets[0].printerCoreV3Identity.endpointAliases.addresses).toEqual([
      "203.0.113.10",
      "203.0.113.11",
    ]);
    expect(targets[0].printerCoreV3Identity.endpointAliases.macs).toEqual([
      "66:77:88:99:aa:bb",
      "aa:11:22:33:44:55",
    ]);
  });

  it("K1 WS受信データをPrinter Core v3 live shadowへ分岐する", () => {
    mod.connectWithType("203.0.113.12:9999", "creality-k1");
    mod.simulateReceivedJson(JSON.stringify({
      hostname: "K1Max-Shadow",
      model: "K1 Max",
      printProgress: 50,
      video: 1,
      video1: 0,
    }), "203.0.113.12");

    expect(shadowMock.beginK1LiveShadowSession).toHaveBeenCalledWith({
      host: "K1Max-Shadow",
      deviceId: "provisional:k1%20max:k1max-shadow",
      sessionId: "k1-live:test-session",
    });
    expect(shadowMock.observeK1LiveShadowFrame).toHaveBeenCalledWith({
      host: "K1Max-Shadow",
      deviceId: "provisional:k1%20max:k1max-shadow",
      sessionId: "k1-live:test-session",
      frame: {
        hostname: "K1Max-Shadow",
        model: "K1 Max",
        printProgress: 50,
        video: 1,
        video1: 0,
      },
    });
  });

  it("identity conflictがopenの場合は旧deviceIdではなくendpoint暫定shadow IDを使う", () => {
    dataMock.monitorData.appSettings.connectionTargets = [
      {
        dest: "203.0.113.13:9999",
        printerType: "creality-k1",
        hostname: "K1Max-Conflict",
        printerCoreV3Identity: {
          schemaVersion: 1,
          dryRun: true,
          deviceIdSeed: "serial:old-serial",
          identityStrength: "serial",
          serialNumber: "OLD-SERIAL",
          stableMachineId: null,
          reportedModel: "K1 Max",
          reportedHostname: "K1Max-Conflict",
          endpointAliases: { addresses: ["203.0.113.13"], macs: [] },
        },
      },
    ];

    connectK1Socket("203.0.113.13:9999");
    receiveK1Status("203.0.113.13", "K1Max-Conflict", { sn: "NEW-SERIAL" });

    expect(shadowMock.resolveK1LiveShadowDeviceId).toHaveBeenCalledWith(expect.objectContaining({
      identity: expect.objectContaining({ deviceIdSeed: "serial:old-serial" }),
      identityConflict: expect.objectContaining({ status: "open" }),
      identityConflicts: expect.arrayContaining([expect.objectContaining({ status: "open" })]),
      host: "K1Max-Conflict",
      dest: "203.0.113.13:9999",
    }));
    expect(shadowMock.beginK1LiveShadowSession).toHaveBeenCalledWith({
      host: "K1Max-Conflict",
      deviceId: "provisional-shadow:endpoint:203.0.113.13%3A9999",
      sessionId: "k1-live:test-session",
    });
  });

  it("WebSocket openでK1 live shadow session IDを生成する", () => {
    const ws = connectK1Socket("203.0.113.20:9999");

    ws.onopen();

    expect(shadowMock.createPrinterCoreV3ShadowSessionId).toHaveBeenCalledWith({
      host: "203.0.113.20",
      dest: "203.0.113.20:9999",
    });
  });

  it("WebSocket closeでK1 live shadow sessionを終了する", () => {
    const ws = connectK1Socket("203.0.113.21:9999");
    ws.onopen();
    receiveK1Status("203.0.113.21", "K1Max-Close");
    shadowMock.endK1LiveShadowSession.mockClear();

    ws.onclose();

    expect(shadowMock.endK1LiveShadowSession).toHaveBeenCalledWith({
      host: "K1Max-Close",
      deviceId: "provisional:k1%20max:k1max-close",
      sessionId: "k1-live:test-session",
    });
  });

  it("manual disconnectでK1 live shadow sessionを終了する", () => {
    connectK1Socket("203.0.113.22:9999");
    receiveK1Status("203.0.113.22", "K1Max-Disconnect");
    shadowMock.endK1LiveShadowSession.mockClear();

    mod.disconnectWs("K1Max-Disconnect");

    expect(shadowMock.endK1LiveShadowSession).toHaveBeenCalledWith({
      host: "K1Max-Disconnect",
      deviceId: "provisional:k1%20max:k1max-disconnect",
      sessionId: "k1-live:test-session",
    });
  });

  it("cleanupConnectionでK1 live shadow sessionを終了する", () => {
    connectK1Socket("203.0.113.23:9999");
    receiveK1Status("203.0.113.23", "K1Max-Cleanup");
    shadowMock.endK1LiveShadowSession.mockClear();

    expect(mod.cleanupConnection("K1Max-Cleanup")).toBe(true);

    expect(shadowMock.endK1LiveShadowSession).toHaveBeenCalledWith({
      host: "K1Max-Cleanup",
      deviceId: "provisional:k1%20max:k1max-cleanup",
      sessionId: "k1-live:test-session",
    });
  });

  it("同一destのstale WebSocket置換時に旧K1 live shadow sessionを終了する", () => {
    connectK1Socket("203.0.113.24:9999");
    receiveK1Status("203.0.113.24", "K1Max-Stale");
    shadowMock.endK1LiveShadowSession.mockClear();

    connectK1Socket("203.0.113.24:9999");

    expect(shadowMock.endK1LiveShadowSession).toHaveBeenCalledWith({
      host: "K1Max-Stale",
      deviceId: "provisional:k1%20max:k1max-stale",
      sessionId: "k1-live:test-session",
    });
  });
});
