/**
 * @fileoverview dashboard_connection.js 同一性/接続先(監査 P0)テスト
 *
 * 固定する不変条件:
 *  - T-ID-01: 同一IP・別ポートは両方とも接続候補になる（IP単位 dedupe 廃止）
 *  - T-ID-03: 同一 dest で別 hostname が返っても即上書きせず ip-reuse-conflict にする
 *  - T-ID-04: IPv6 の一時到達先キーも IP→hostname へ移行される
 *
 * @version 1.390.1452 (PR #435)
 * @since 1.390.1342 (PR #432)
 * @lastModified 2026-08-28 14:28:57
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
vi.mock("../../3dp_lib/dashboard_printmanager.js", () => ({
  updateHistoryList: vi.fn(),
  updateVideoList: vi.fn(),
  renderFileList: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_notification_manager.js", () => ({ showAlert: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_camera_ctrl.js", () => ({
  startCameraStream: vi.fn(), stopCameraStream: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_utils.js", () => ({ getCurrentTimestamp: vi.fn(() => "t") }));
vi.mock("../../3dp_lib/dashboard_panel_menu.js", () => ({ updatePanelMenuHosts: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_panel_factory.js", () => ({
  migratePanelsToHost: vi.fn(), renamePanelsHost: vi.fn(), ensureHostPanels: vi.fn(),
  removePanelsForHost: vi.fn(), recreatePanelsForHost: vi.fn(), updateAllPanelHeaders: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_storage.js", () => ({ saveUnifiedStorage: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_ui_confirm.js", () => ({ showConfirmDialog: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_moonraker.js", () => ({
  createMoonrakerSession: vi.fn(() => ({ close: vi.fn() })),
  moonrakerFilesToEntries: vi.fn((files) => (Array.isArray(files) ? files : []).map((file) => ({
    basename: String(file.path || "").split("/").pop(),
    filename: file.path,
    size: Number(file.size || 0),
    mtime: new Date(Number(file.modified || 0) * 1000),
    expect: null,
  }))),
  moonrakerHistoryToK1: vi.fn((jobs) => (Array.isArray(jobs) ? jobs : []).map((job) => ({
    id: Math.floor(Number(job.start_time || 0)),
    filename: job.filename,
    starttime: Math.floor(Number(job.start_time || 0)),
  }))),
  translateK1CommandToMoonraker: vi.fn(),
}));
vi.mock("../../3dp_lib/printer_core/dashboard_live_shadow.js", () => ({
  beginK1LiveShadowSession: vi.fn(),
  beginK2LiveShadowSession: vi.fn(),
  createPrinterCoreV3ShadowSessionId: vi.fn(({ family } = {}) => `${family === "k2" ? "k2" : "k1"}-live:test-session`),
  endK1LiveShadowSession: vi.fn(),
  endK2LiveShadowSession: vi.fn(),
  observeK1LiveShadowFrame: vi.fn(),
  observeK2LiveShadowFrame: vi.fn(),
  observeMoonrakerCfsMaterialProviderFrame: vi.fn(),
  resolvePrinterCoreV3LiveShadowDeviceId: vi.fn(({ identity, identityConflict, identityConflicts, host, dest }) => {
    const hasOpenConflict = identityConflict?.status === "open" ||
      (Array.isArray(identityConflicts) && identityConflicts.some((entry) => entry?.status === "open"));
    return hasOpenConflict
      ? `provisional-shadow:endpoint:${encodeURIComponent(dest)}`
      : identity?.deviceIdSeed || `host:${host}`;
  }),
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
    this.sentMessages = [];
    FakeWebSocket.instances.push(this);
  }
  close() { this.readyState = FakeWebSocket.CLOSED; }
  send(message) { this.sentMessages.push(message); }
}

let mod, dataMock, shadowMock, moonrakerMock, msgHandlerMock, printManagerMock;
beforeEach(async () => {
  vi.resetModules();
  FakeWebSocket.instances = [];
  global.WebSocket = FakeWebSocket;
  window.WebSocket = FakeWebSocket;
  delete window.fetch;
  delete window._3dpmonRelayChild;
  mod = await import("../../3dp_lib/dashboard_connection.js");
  dataMock = await import("../../3dp_lib/dashboard_data.js");
  shadowMock = await import("../../3dp_lib/printer_core/dashboard_live_shadow.js");
  moonrakerMock = await import("../../3dp_lib/dashboard_moonraker.js");
  msgHandlerMock = await import("../../3dp_lib/dashboard_msg_handler.js");
  printManagerMock = await import("../../3dp_lib/dashboard_printmanager.js");
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
  delete window.fetch;
  delete window._3dpmonRelayChild;
});

async function flushAsyncProbe() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

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
    expect(target.printerCoreV3Identity.deviceFingerprint).toMatchObject({
      schemaVersion: 1,
      sources: ["ws9999"],
      strong: {
        serialNumber: "k2pro-serial-001",
      },
      reported: {
        model: "F012",
        hostname: "K2Pro-Test",
      },
      endpointAliases: {
        addresses: ["203.0.113.10"],
        macs: ["aa:11:22:33:44:55"],
      },
      transports: {
        httpInfoObserved: false,
        ws9999Observed: true,
      },
    });
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

  it("同一hostnameでもstrong identityが異なる別endpointはDHCP統合しない", () => {
    mod.connectWithType("203.0.113.10:9999", "creality-k1");
    mod.simulateReceivedJson(JSON.stringify({
      hostname: "K2Pro-Duplicate",
      model: "F012",
      sn: "K2PRO-SERIAL-A",
      mac: "AA1122334455",
    }), "203.0.113.10");

    mod.connectWithType("203.0.113.11:9999", "creality-k1");
    mod.simulateReceivedJson(JSON.stringify({
      hostname: "K2Pro-Duplicate",
      model: "F012",
      sn: "K2PRO-SERIAL-B",
      mac: "66778899AABB",
    }), "203.0.113.11");

    const targets = dataMock.monitorData.appSettings.connectionTargets;
    expect(targets.map((target) => target.dest).sort()).toEqual([
      "203.0.113.10:9999",
      "203.0.113.11:9999",
    ]);
    expect(targets.every((target) => target.hostname === "K2Pro-Duplicate")).toBe(true);
    expect(targets.map((target) => target.printerCoreV3Identity.deviceIdSeed).sort()).toEqual([
      "serial:k2pro-serial-a",
      "serial:k2pro-serial-b",
    ]);
  });

  it("同一hostnameかつ同一provisional seedでもstrong identityが無い場合はDHCP統合しない", () => {
    mod.connectWithType("203.0.113.12:9999", "creality-k1");
    mod.simulateReceivedJson(JSON.stringify({
      hostname: "Workshop-Printer",
      model: "K1 Max",
    }), "203.0.113.12");

    mod.connectWithType("203.0.113.13:9999", "creality-k1");
    mod.simulateReceivedJson(JSON.stringify({
      hostname: "Workshop-Printer",
      model: "K1 Max",
    }), "203.0.113.13");

    const targets = dataMock.monitorData.appSettings.connectionTargets;
    expect(targets.map((target) => target.dest).sort()).toEqual([
      "203.0.113.12:9999",
      "203.0.113.13:9999",
    ]);
    expect(targets.map((target) => target.printerCoreV3Identity.identityStrength)).toEqual([
      "provisional",
      "provisional",
    ]);
    expect(targets.map((target) => target.printerCoreV3Identity.deviceIdSeed)).toEqual([
      "provisional:k1%20max:workshop-printer",
      "provisional:k1%20max:workshop-printer",
    ]);
  });

  it("接続時のHTTP /infoをPrinter Core v3 identity evidenceへ統合する", async () => {
    window.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        model: "F012",
        sn: "K2PRO-SERIAL-001",
        mac: "AA1122334455",
        version: "1.0.0",
        wssPort: 443,
        videoPort: 443,
      }),
    }));

    mod.connectWithType("203.0.113.21:9999", "creality-k1");
    await flushAsyncProbe();
    mod.simulateReceivedJson(JSON.stringify({
      hostname: "K2Pro-Test",
      model: "F012",
      sn: "K2PRO-SERIAL-001",
      mac: "66778899AABB",
    }), "203.0.113.21");

    const target = dataMock.monitorData.appSettings.connectionTargets[0];
    expect(window.fetch).toHaveBeenCalledWith("http://203.0.113.21:80/info", expect.objectContaining({
      cache: "no-store",
    }));
    expect(target.printerCoreV3Identity.deviceFingerprint.sources).toEqual(["http-info", "ws9999"]);
    expect(target.printerCoreV3Identity.deviceFingerprint.reported).toMatchObject({
      model: "F012",
      hostname: "K2Pro-Test",
      firmwareVersion: "1.0.0",
    });
    expect(target.printerCoreV3Identity.deviceFingerprint.transports).toMatchObject({
      httpInfoObserved: true,
      ws9999Observed: true,
      wssPort: 443,
      videoPort: 443,
    });
    expect(target).toMatchObject({
      printerType: "creality-k2",
      cameraPort: 8000,
      cameraProtocol: "k2-webrtc",
      wssPort: 443,
      videoPort: 443,
      printerCoreV3Info: {
        source: "http-info",
        model: "F012",
        version: "1.0.0",
        probeSessionId: mod.getPrinterCoreV3RuntimeProbeSessionId(),
        connectionGeneration: 1,
        connectionDest: "203.0.113.21:9999",
        connectionHost: "203.0.113.21",
      },
    });
    expect(mod.getPrinterCoreV3ConnectionGeneration("K2Pro-Test")).toBe(0);
    expect(target.printerCoreV3Identity.endpointAliases.macs).toEqual([
      "66:77:88:99:aa:bb",
      "aa:11:22:33:44:55",
    ]);
  });

  it("遅延した古いHTTP /info応答を新しい接続世代へ誤bindしない", async () => {
    const pendingFetches = [];
    window.fetch = vi.fn(() => new Promise((resolve) => {
      pendingFetches.push(resolve);
    }));

    mod.connectWithType("203.0.113.22:9999", "creality-k1");
    mod.connectWithType("203.0.113.22:9999", "creality-k1");
    expect(window.fetch).toHaveBeenCalledTimes(2);

    pendingFetches[0]({
      ok: true,
      json: async () => ({
        model: "F011",
        version: "stale-response",
        wssPort: 443,
      }),
    });
    await flushAsyncProbe();

    const target = dataMock.monitorData.appSettings.connectionTargets[0];
    expect(target.printerCoreV3Info).toBeUndefined();
    expect(target.printerCoreV3Identity).toBeUndefined();

    pendingFetches[1]({
      ok: true,
      json: async () => ({
        model: "F012",
        version: "1.0.0",
        wssPort: 443,
      }),
    });
    await flushAsyncProbe();

    expect(target.printerCoreV3Info).toMatchObject({
      model: "F012",
      version: "1.0.0",
      connectionGeneration: 2,
      connectionDest: "203.0.113.22:9999",
    });
    expect(target.printerCoreV3Identity.deviceFingerprint.reported).toMatchObject({
      model: "F012",
      firmwareVersion: "1.0.0",
    });
  });

  it("cleanup後に同一destへ再接続してもPrinter Core v3接続世代を再利用しない", async () => {
    window.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        model: "F012",
        version: "1.0.0",
        wssPort: 443,
      }),
    }));

    mod.connectWithType("203.0.113.23:9999", "creality-k2");
    await flushAsyncProbe();
    const target = dataMock.monitorData.appSettings.connectionTargets[0];
    const firstGeneration = target.printerCoreV3Info.connectionGeneration;
    expect(firstGeneration).toBeGreaterThan(0);

    expect(mod.cleanupConnection("203.0.113.23")).toBe(true);
    mod.connectWithType("203.0.113.23:9999", "creality-k2");
    await flushAsyncProbe();

    expect(target.printerCoreV3Info.connectionGeneration).toBeGreaterThan(firstGeneration);
  });

  it("Moonraker/IR3翻訳フレームはlegacy processDataへ流すがPrinter Core v3 identity/shadowへ入れない", () => {
    mod.connectWithType("203.0.113.40", "moonraker");
    expect(moonrakerMock.createMoonrakerSession).toHaveBeenCalledTimes(1);
    const sessionOptions = moonrakerMock.createMoonrakerSession.mock.calls[0][0];

    sessionOptions.onData({
      hostname: "IR3V2-Test",
      model: "Ideaformer IR3 V2",
      printProgress: 42,
    });

    const target = dataMock.monitorData.appSettings.connectionTargets[0];
    expect(target).toMatchObject({
      dest: "203.0.113.40:80",
      hostname: "IR3V2-Test",
      printerType: "moonraker",
    });
    expect(target.printerCoreV3Identity).toBeUndefined();
    expect(target.printerCoreV3DeviceFingerprint).toBeUndefined();
    expect(msgHandlerMock.processData).toHaveBeenCalledWith({
      hostname: "IR3V2-Test",
      model: "Ideaformer IR3 V2",
      printProgress: 42,
    }, "IR3V2-Test");
    expect(shadowMock.beginK1LiveShadowSession).not.toHaveBeenCalled();
    expect(shadowMock.beginK2LiveShadowSession).not.toHaveBeenCalled();
    expect(shadowMock.observeK1LiveShadowFrame).not.toHaveBeenCalled();
    expect(shadowMock.observeK2LiveShadowFrame).not.toHaveBeenCalled();
  });

  it("K1C+CFS-C設定ではsecondary Moonraker providerのmaterial payloadをread-only shadowへ流す", () => {
    dataMock.monitorData.appSettings.connectionTargets = [
      {
        dest: "203.0.113.90:9999",
        printerType: "creality-k1",
        hostname: "",
        materialSystem: {
          mode: "cfs-c-readonly",
          provider: "moonraker-boxsInfo",
          providerEndpoint: "198.51.100.20:80",
          unitLimit: 1,
        },
      },
    ];
    mod.connectWs("203.0.113.90:9999");

    mod.simulateReceivedJson(JSON.stringify({
      hostname: "K1C-CFSC",
      model: "K1C",
      printProgress: 0,
    }), "203.0.113.90");

    const providerCall = moonrakerMock.createMoonrakerSession.mock.calls.find((call) => call[0]?.onMaterial);
    expect(providerCall).toBeTruthy();
    expect(providerCall[0]).toMatchObject({
      url: "ws://198.51.100.20:80/websocket",
      fallbackHost: "K1C-CFSC",
      materialOnly: true,
      materialSubscribeObjects: {
        boxsInfo: null,
        boxs_info: null,
      },
    });

    providerCall[0].onMaterial({ materialBoxs: [] });
    expect(shadowMock.observeMoonrakerCfsMaterialProviderFrame).toHaveBeenCalledWith({
      host: "K1C-CFSC",
      payload: { materialBoxs: [] },
      providerSessionId: "material-provider:K1C-CFSC:198.51.100.20%3A80",
      providerGeneration: "material-provider:K1C-CFSC:198.51.100.20%3A80",
      connected: true,
      receivedAt: expect.any(String),
      snapshotCompleteness: "partial",
    });
  });

  it("secondary Moonraker providerのwaiting/connecting/disconnectedはmaterial topologyを即stale化する", () => {
    dataMock.monitorData.appSettings.connectionTargets = [
      {
        dest: "203.0.113.91:9999",
        printerType: "creality-k1",
        hostname: "",
        materialSystem: {
          mode: "cfs-c-readonly",
          provider: "moonraker-boxsInfo",
          providerEndpoint: "198.51.100.21:80",
          unitLimit: 1,
        },
      },
    ];
    mod.connectWs("203.0.113.91:9999");

    mod.simulateReceivedJson(JSON.stringify({
      hostname: "K1C-CFSC",
      model: "K1C",
      printProgress: 0,
    }), "203.0.113.91");

    const providerCall = moonrakerMock.createMoonrakerSession.mock.calls.find((call) => call[0]?.onState);
    expect(providerCall).toBeTruthy();

    providerCall[0].onState("connected", { transportGeneration: "provider-gen-1" });
    expect(shadowMock.observeMoonrakerCfsMaterialProviderFrame).not.toHaveBeenCalled();

    providerCall[0].onState("waiting", { transportGeneration: "provider-gen-1" });
    providerCall[0].onState("connecting", { transportGeneration: "provider-gen-2" });
    providerCall[0].onState("disconnected", { transportGeneration: "provider-gen-2" });

    expect(shadowMock.observeMoonrakerCfsMaterialProviderFrame).toHaveBeenCalledTimes(3);
    expect(shadowMock.observeMoonrakerCfsMaterialProviderFrame).toHaveBeenNthCalledWith(1, {
      host: "K1C-CFSC",
      payload: null,
      providerSessionId: "material-provider:K1C-CFSC:198.51.100.21%3A80",
      providerGeneration: "provider-gen-1",
      connected: false,
      receivedAt: expect.any(String),
    });
    expect(shadowMock.observeMoonrakerCfsMaterialProviderFrame).toHaveBeenNthCalledWith(3, {
      host: "K1C-CFSC",
      payload: null,
      providerSessionId: "material-provider:K1C-CFSC:198.51.100.21%3A80",
      providerGeneration: "provider-gen-2",
      connected: false,
      receivedAt: expect.any(String),
    });
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

  it("K2 Pro Combo WS受信データをK2 live shadowへ分岐しCFS boxsInfo probeを一度だけ送る", () => {
    mod.connectWithType("203.0.113.30:9999", "creality-k1");
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

    mod.simulateReceivedJson(JSON.stringify({
      hostname: "K2Pro-69E7",
      model: "F012",
      cfsConnect: 1,
      printProgress: 100,
    }), "203.0.113.30");

    expect(shadowMock.beginK2LiveShadowSession).toHaveBeenCalledWith({
      host: "K2Pro-69E7",
      deviceId: "provisional:f012:k2pro-69e7",
      sessionId: "k2-live:test-session",
    });
    expect(shadowMock.observeK2LiveShadowFrame).toHaveBeenCalledWith({
      host: "K2Pro-69E7",
      deviceId: "provisional:f012:k2pro-69e7",
      sessionId: "k2-live:test-session",
      frame: {
        hostname: "K2Pro-69E7",
        model: "F012",
        cfsConnect: 1,
        printProgress: 100,
      },
    });
    expect(shadowMock.observeK1LiveShadowFrame).not.toHaveBeenCalled();
    expect(ws.sentMessages).toContain(JSON.stringify({ method: "get", params: { boxsInfo: 1 } }));
    expect(dataMock.monitorData.appSettings.connectionTargets[0]).toMatchObject({
      dest: "203.0.113.30:9999",
      printerType: "creality-k2",
      cameraPort: 8000,
      cameraProtocol: "k2-webrtc",
      materialSystem: {
        mode: "auto",
        unitLimit: 1,
      },
    });

    ws.sentMessages.length = 0;
    mod.simulateReceivedJson(JSON.stringify({
      boxsInfo: {
        enable: 1,
        materialBoxs: [
          {
            id: 1,
            type: 0,
            state: 1,
            materials: [
              { id: 0, vendor: "Generic", type: "PLA", color: "#0ffffff", percent: 100, state: 1, selected: 1 },
            ],
          },
        ],
        colorMatch: [{ id: "T1A", boxId: 1, materialId: 0 }],
        same_material: [["000001", "0ffffff", [{ boxId: 1, materialId: 0 }], "PLA"]],
      },
    }), "K2Pro-69E7");

    expect(shadowMock.observeK2LiveShadowFrame).toHaveBeenCalledTimes(2);
    expect(shadowMock.observeK2LiveShadowFrame).toHaveBeenLastCalledWith({
      host: "K2Pro-69E7",
      deviceId: "provisional:f012:k2pro-69e7",
      sessionId: "k2-live:test-session",
      frame: {
        boxsInfo: {
          enable: 1,
          materialBoxs: [
            {
              id: 1,
              type: 0,
              state: 1,
              materials: [
                { id: 0, vendor: "Generic", type: "PLA", color: "#0ffffff", percent: 100, state: 1, selected: 1 },
              ],
            },
          ],
          colorMatch: [{ id: "T1A", boxId: 1, materialId: 0 }],
          same_material: [["000001", "0ffffff", [{ boxId: 1, materialId: 0 }], "PLA"]],
        },
      },
      snapshotCompleteness: "complete",
    });
    expect(ws.sentMessages).toEqual([]);
  });

  it("K2 CFS boxsInfo probe待ち中でも疎なpush deltaはcomplete snapshot扱いしない", () => {
    mod.connectWithType("203.0.113.30:9999", "creality-k1");
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

    mod.simulateReceivedJson(JSON.stringify({
      hostname: "K2Pro-Sparse",
      model: "F012",
      cfsConnect: 1,
    }), "203.0.113.30");
    expect(ws.sentMessages).toContain(JSON.stringify({ method: "get", params: { boxsInfo: 1 } }));

    mod.simulateReceivedJson(JSON.stringify({
      boxsInfo: {
        materialBoxs: [
          {
            id: 1,
            type: 0,
            materials: [
              { id: 2, selected: 1 },
            ],
          },
        ],
      },
    }), "K2Pro-Sparse");

    expect(shadowMock.observeK2LiveShadowFrame).toHaveBeenLastCalledWith({
      host: "K2Pro-Sparse",
      deviceId: "provisional:f012:k2pro-sparse",
      sessionId: "k2-live:test-session",
      frame: {
        boxsInfo: {
          materialBoxs: [
            {
              id: 1,
              type: 0,
              materials: [
                { id: 2, selected: 1 },
              ],
            },
          ],
        },
      },
    });

    mod.simulateReceivedJson(JSON.stringify({
      boxsInfo: {
        enable: 1,
        materialBoxs: [
          {
            id: 1,
            type: 0,
            state: 1,
            materials: [
              { id: 2, vendor: "Generic", type: "PLA", color: "#09ea7ae", percent: 54, state: 1, selected: 1 },
            ],
          },
        ],
        colorMatch: [{ id: "T1C", boxId: 1, materialId: 2 }],
        same_material: [["000002", "09ea7ae", [{ boxId: 1, materialId: 2 }], "PLA"]],
      },
    }), "K2Pro-Sparse");

    expect(shadowMock.observeK2LiveShadowFrame).toHaveBeenLastCalledWith({
      host: "K2Pro-Sparse",
      deviceId: "provisional:f012:k2pro-sparse",
      sessionId: "k2-live:test-session",
      frame: {
        boxsInfo: {
          enable: 1,
          materialBoxs: [
            {
              id: 1,
              type: 0,
              state: 1,
              materials: [
                { id: 2, vendor: "Generic", type: "PLA", color: "#09ea7ae", percent: 54, state: 1, selected: 1 },
              ],
            },
          ],
          colorMatch: [{ id: "T1C", boxId: 1, materialId: 2 }],
          same_material: [["000002", "09ea7ae", [{ boxId: 1, materialId: 2 }], "PLA"]],
        },
      },
      snapshotCompleteness: "complete",
    });
  });

  it("K2 retGcodeFileInfo2を既存ファイル一覧rendererのentries形式へ橋渡しする", () => {
    mod.connectWithType("203.0.113.31:9999", "creality-k2");
    dataMock.monitorData.machines["K2Pro-Files"] = { storedData: {}, runtimeData: {}, historyData: [] };

    mod.simulateReceivedJson(JSON.stringify({
      hostname: "K2Pro-Files",
      model: "F012",
      retGcodeFileInfo2: [
        {
          name: "3DBench_PLA_21m.gcode",
          path: "/mnt/UDISK/printer_data/gcodes/3DBench_PLA_21m.gcode",
          file_size: 2740121,
          create_time: 1784086071,
          timeCost: 1261,
          consumables: 7468,
          floorHeight: 25,
          material: "PLA",
          materialColors: "#00ff00",
          materialUsed: "3734.44",
          thumbnail: "/mnt/UDISK/creality/local_gcode/humbnail/3DBench_PLA_21m.png",
          match: "T1A=T1B ",
        },
      ],
    }), "203.0.113.31");

    expect(printManagerMock.renderFileList).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceProtocol: "retGcodeFileInfo2",
        totalNum: 1,
        entries: [
          expect.objectContaining({
            basename: "3DBench_PLA_21m.gcode",
            filename: "/mnt/UDISK/printer_data/gcodes/3DBench_PLA_21m.gcode",
            size: 2740121,
            expect: 3734.44,
            material: "PLA",
            match: "T1A=T1B ",
            sourceProtocol: "retGcodeFileInfo2",
          }),
        ],
      }),
      "http://203.0.113.31:80",
      "K2Pro-Files"
    );
    const machine = dataMock.monitorData.machines["K2Pro-Files"];
    expect(machine._cachedFileInfo).toMatchObject({
      sourceProtocol: "retGcodeFileInfo2",
      totalNum: 1,
    });
  });

  it("F012でK2確定後はhostnameがK2 prefixでない疎なdeltaでもK2 shadowを維持する", () => {
    mod.connectWithType("203.0.113.32:9999", "creality-k1");

    mod.simulateReceivedJson(JSON.stringify({
      hostname: "Workshop-Printer",
      model: "F012",
      cfsConnect: 1,
    }), "203.0.113.32");
    shadowMock.observeK2LiveShadowFrame.mockClear();
    shadowMock.observeK1LiveShadowFrame.mockClear();

    mod.simulateReceivedJson(JSON.stringify({
      connectionCount: 1,
    }), "Workshop-Printer");

    expect(shadowMock.observeK2LiveShadowFrame).toHaveBeenCalledWith({
      host: "Workshop-Printer",
      deviceId: "provisional:f012:workshop-printer",
      sessionId: "k2-live:test-session",
      frame: {
        connectionCount: 1,
      },
    });
    expect(shadowMock.observeK1LiveShadowFrame).not.toHaveBeenCalled();
  });

  it("K2 CFS reconnect後はboxsInfo probeを接続epoch単位で再送する", () => {
    mod.connectWithType("203.0.113.33:9999", "creality-k1");
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

    mod.simulateReceivedJson(JSON.stringify({
      hostname: "K2Pro-Rearm",
      model: "F012",
      cfsConnect: 1,
    }), "203.0.113.33");
    expect(ws.sentMessages).toEqual([
      JSON.stringify({ method: "get", params: { boxsInfo: 1 } }),
    ]);

    ws.sentMessages.length = 0;
    mod.simulateReceivedJson(JSON.stringify({
      boxsInfo: {
        materialBoxs: [],
      },
    }), "K2Pro-Rearm");
    mod.simulateReceivedJson(JSON.stringify({ cfsConnect: 0 }), "K2Pro-Rearm");
    mod.simulateReceivedJson(JSON.stringify({
      boxsInfo: {
        materialBoxs: [],
      },
    }), "K2Pro-Rearm");
    expect(ws.sentMessages).toEqual([]);

    mod.simulateReceivedJson(JSON.stringify({ cfsConnect: 1 }), "K2Pro-Rearm");
    expect(ws.sentMessages).toEqual([
      JSON.stringify({ method: "get", params: { boxsInfo: 1 } }),
    ]);
  });

  it("K2 CFS接続通知とboxsInfoが同一frameにある場合はprobeを送らない", () => {
    mod.connectWithType("203.0.113.34:9999", "creality-k1");
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

    mod.simulateReceivedJson(JSON.stringify({
      hostname: "K2Pro-MixedFrame",
      model: "F012",
      cfsConnect: 1,
      boxsInfo: {
        enable: 1,
        materialBoxs: [
          {
            id: 1,
            type: 0,
            state: 1,
            materials: [
              { id: 0, vendor: "Generic", type: "PLA", color: "#0ffffff", percent: 100, state: 1, selected: 1 },
            ],
          },
        ],
        colorMatch: [{ id: "T1A", boxId: 1, materialId: 0 }],
        same_material: [["000001", "0ffffff", [{ boxId: 1, materialId: 0 }], "PLA"]],
      },
    }), "203.0.113.34");
    expect(ws.sentMessages).toEqual([]);
    expect(shadowMock.observeK2LiveShadowFrame).toHaveBeenLastCalledWith({
      host: "K2Pro-MixedFrame",
      deviceId: "provisional:f012:k2pro-mixedframe",
      sessionId: "k2-live:test-session",
      frame: {
        hostname: "K2Pro-MixedFrame",
        model: "F012",
        cfsConnect: 1,
        boxsInfo: {
          enable: 1,
          materialBoxs: [
            {
              id: 1,
              type: 0,
              state: 1,
              materials: [
                { id: 0, vendor: "Generic", type: "PLA", color: "#0ffffff", percent: 100, state: 1, selected: 1 },
              ],
            },
          ],
          colorMatch: [{ id: "T1A", boxId: 1, materialId: 0 }],
          same_material: [["000001", "0ffffff", [{ boxId: 1, materialId: 0 }], "PLA"]],
        },
      },
    });

    mod.simulateReceivedJson(JSON.stringify({ cfsConnect: 1 }), "K2Pro-MixedFrame");
    expect(ws.sentMessages).toEqual([]);
  });

  it("K2 CFS boxsInfoはpush後もrefresh間隔経過でread-only再取得する", () => {
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(1_000);
      mod.connectWithType("203.0.113.35:9999", "creality-k2");
      const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

      mod.simulateReceivedJson(JSON.stringify({
        hostname: "K2Pro-Refresh",
        model: "F012",
        cfsConnect: 1,
        boxsInfo: {
          materialBoxs: [],
        },
      }), "203.0.113.35");
      expect(ws.sentMessages).toEqual([]);

      nowSpy.mockReturnValue(31_500);
      mod.simulateReceivedJson(JSON.stringify({ cfsConnect: 1 }), "K2Pro-Refresh");

      expect(ws.sentMessages).toEqual([
        JSON.stringify({ method: "get", params: { boxsInfo: 1 } }),
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("K2 CFS boxsInfo probe応答待ちは通信中状態をruntimeDataへ記録しtimeout前に重複送信しない", () => {
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(1_000);
      mod.connectWithType("203.0.113.36:9999", "creality-k2");
      const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      dataMock.monitorData.machines["K2Pro-InFlight"] = { runtimeData: {} };

      mod.simulateReceivedJson(JSON.stringify({
        hostname: "K2Pro-InFlight",
        model: "F012",
        cfsConnect: 1,
      }), "203.0.113.36");

      expect(ws.sentMessages).toEqual([
        JSON.stringify({ method: "get", params: { boxsInfo: 1 } }),
      ]);
      expect(dataMock.monitorData.machines["K2Pro-InFlight"].runtimeData.printerCoreV3Shadow.materialProviderRequest).toMatchObject({
        state: "in-flight",
        startedAtMs: 1_000,
      });

      nowSpy.mockReturnValue(12_000);
      mod.simulateReceivedJson(JSON.stringify({ cfsConnect: 1 }), "K2Pro-InFlight");
      expect(ws.sentMessages).toHaveLength(1);
      expect(dataMock.monitorData.machines["K2Pro-InFlight"].runtimeData.printerCoreV3Shadow.materialProviderRequest).toMatchObject({
        state: "in-flight",
        startedAtMs: 1_000,
      });

      nowSpy.mockReturnValue(26_500);
      mod.simulateReceivedJson(JSON.stringify({ cfsConnect: 1 }), "K2Pro-InFlight");
      expect(ws.sentMessages).toHaveLength(2);
      expect(dataMock.monitorData.machines["K2Pro-InFlight"].runtimeData.printerCoreV3Shadow.materialProviderRequest).toMatchObject({
        state: "in-flight",
        startedAtMs: 26_500,
      });
    } finally {
      nowSpy.mockRestore();
    }
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

    expect(shadowMock.resolvePrinterCoreV3LiveShadowDeviceId).toHaveBeenCalledWith(expect.objectContaining({
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
      family: "k1",
      host: "203.0.113.20",
      dest: "203.0.113.20:9999",
    });
  });

  it("WebSocket closeでK2 live shadow sessionを終了する", () => {
    const ws = connectK1Socket("203.0.113.31:9999");
    ws.onopen();
    mod.simulateReceivedJson(JSON.stringify({
      hostname: "K2Pro-Close",
      model: "F012",
      cfsConnect: 1,
    }), "203.0.113.31");
    shadowMock.endK2LiveShadowSession.mockClear();

    ws.onclose();

    expect(shadowMock.endK2LiveShadowSession).toHaveBeenCalledWith({
      host: "K2Pro-Close",
      deviceId: "provisional:f012:k2pro-close",
      sessionId: "k2-live:test-session",
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

describe("Printer Core v3 material supply settings UI contract", () => {
  it("AUTO + unitLimit=0 は設定画面で自動検出としてround-tripし通常スプールへ化けない", () => {
    const currentMaterialSystem = {
      mode: "auto",
      displayMode: "auto",
      provider: "auto",
      unitLimit: 0,
      slotsPerUnit: 4,
      externalSourceLimit: 1,
      readOnly: true,
      canSendCommands: false,
      canDriveLedger: false,
    };

    expect(mod._materialSupplyValue(currentMaterialSystem)).toBe("auto");
    expect(mod._materialSystemFromSupplyValue("auto", true, currentMaterialSystem)).toMatchObject({
      mode: "auto",
      displayMode: "auto",
      provider: "auto",
      unitLimit: 0,
      slotsPerUnit: 4,
      externalSourceLimit: 1,
      readOnly: true,
      canSendCommands: false,
      canDriveLedger: false,
    });
  });
});
