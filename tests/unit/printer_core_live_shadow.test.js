/**
 * @fileoverview Printer Core v3 K1 live shadow の単体テスト
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { monitorData } from "../../3dp_lib/dashboard_data.js";
import {
  beginK1LiveShadowSession,
  createPrinterCoreV3ShadowSessionId,
  endK1LiveShadowSession,
  isRecoverableK1LiveShadowObserveError,
  observeK1LiveShadowFrame,
  resolveK1LiveShadowDeviceId,
} from "../../3dp_lib/printer_core/dashboard_live_shadow.js";

function stored(rawValue) {
  return { rawValue, isNew: false, isFromEquipVal: true };
}

function setMachine(host, storedData = {}) {
  monitorData.machines[host] = {
    storedData,
    runtimeData: {},
    historyData: [],
    printStore: { current: null, history: [], videos: {} },
  };
}

describe("Printer Core v3 K1 live shadow", () => {
  beforeEach(() => {
    monitorData.machines = {};
    monitorData.appSettings = { logLevel: "info" };
    vi.restoreAllMocks();
  });

  it("WebSocket接続ごとの deterministic shadow session ID を生成する", () => {
    const sessionId = createPrinterCoreV3ShadowSessionId({
      host: "K1Max-A",
      dest: "192.168.54.151:9999",
      openedAt: "2026-08-07T08:15:03.000Z",
    });

    expect(sessionId).toBe("k1-live:K1Max-A:192.168.54.151%3A9999:2026-08-07T08%3A15%3A03.000Z");
  });

  it("open conflictがある場合は旧identityのdeviceIdSeedではなくendpoint暫定IDを使う", () => {
    const deviceId = resolveK1LiveShadowDeviceId({
      host: "K1Max-New",
      dest: "192.168.54.151:9999",
      identity: { deviceIdSeed: "serial:old-machine" },
      identityConflict: { status: "open" },
    });

    expect(deviceId).toBe("provisional-shadow:endpoint:192.168.54.151%3A9999");
  });

  it("session未開始だけをrecoverable observe errorとして扱う", () => {
    expect(isRecoverableK1LiveShadowObserveError(new Error("session has not been started"))).toBe(true);
    expect(isRecoverableK1LiveShadowObserveError(new Error("adapter invariant failed"))).toBe(false);
  });

  it("未開始sessionのobserveは1回だけsessionを開始して復旧する", () => {
    const host = "K1Max-Live-Recover";
    const deviceId = "host:K1Max-Live-Recover";
    const sessionId = "k1-live:test-recover";
    setMachine(host, {
      printProgress: stored(10),
    });

    const record = observeK1LiveShadowFrame({
      host,
      deviceId,
      sessionId,
      frame: { printProgress: 10 },
      receivedAt: "2026-08-07T08:15:03.000Z",
    });

    expect(record.state).toBe("matched");
    expect(record.lastSequence).toBe(1);
  });

  it("未開始sessionでも現在runtime recordと異なる旧deviceId/sessionは復旧しない", () => {
    const host = "K1Max-Live-Stale-Recover";
    setMachine(host, {
      printProgress: stored(10),
    });
    beginK1LiveShadowSession({ host, deviceId: "host:K1Max-Live-Stale-Recover", sessionId: "k1-live:old" });
    endK1LiveShadowSession({ host, deviceId: "host:K1Max-Live-Stale-Recover", sessionId: "k1-live:old" });
    beginK1LiveShadowSession({ host, deviceId: "serial:strong-id", sessionId: "k1-live:new" });

    const stale = observeK1LiveShadowFrame({
      host,
      deviceId: "host:K1Max-Live-Stale-Recover",
      sessionId: "k1-live:old",
      frame: { printProgress: 10 },
    });

    expect(stale).toEqual({
      accepted: false,
      reason: "stale-shadow-session",
      host,
      deviceId: "host:K1Max-Live-Stale-Recover",
      sessionId: "k1-live:old",
      activeDeviceId: "serial:strong-id",
      activeSessionId: "k1-live:new",
    });
    expect(monitorData.machines[host].runtimeData.printerCoreV3Shadow).toMatchObject({
      deviceId: "serial:strong-id",
      sessionId: "k1-live:new",
      state: "active",
    });
  });

  it("非recoverable observe errorはsession再生成せずruntimeDataへerrorとして記録する", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const host = "K1Max-Live-Error";
    const deviceId = "host:K1Max-Live-Error";
    const sessionId = "k1-live:error";
    const facade = {
      observeFrame: vi.fn(() => {
        throw new Error("adapter invariant failed");
      }),
    };
    setMachine(host);

    const record = observeK1LiveShadowFrame({
      host,
      deviceId,
      sessionId,
      frame: { printProgress: 10 },
    }, { facade });

    expect(facade.observeFrame).toHaveBeenCalledOnce();
    expect(record).toMatchObject({
      state: "error",
      shadowError: {
        reason: "shadow-observe-error",
        message: "adapter invariant failed",
      },
    });
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(monitorData.machines[host].runtimeData.printerCoreV3Shadow).toMatchObject({
      state: "error",
      sessionId,
    });
  });

  it("processData後のlegacy storedDataとv3 shadow stateが一致すればmatchedとしてruntimeDataへ記録する", () => {
    const host = "K1Max-Live-A";
    const deviceId = "host:K1Max-Live-A";
    const sessionId = "k1-live:test-a";
    setMachine(host, {
      hostname: stored(host),
      model: stored("K1 Max"),
      nozzleTemp: stored("25.500000"),
      bedTemp0: stored("30.000000"),
      fan: stored(1),
      modelFanPct: stored(47),
      state: stored(1),
      printProgress: stored(50),
      positionX: stored({ value: "1.00", unit: "" }),
      positionY: stored({ value: "2.00", unit: "" }),
      positionZ: stored({ value: "3.00", unit: "" }),
      err: stored({ errcode: 0, key: 0 }),
      video: stored(1),
      video1: stored(0),
    });
    beginK1LiveShadowSession({ host, deviceId, sessionId });

    const record = observeK1LiveShadowFrame({
      host,
      deviceId,
      sessionId,
      frame: {
        hostname: host,
        model: "K1 Max",
        nozzleTemp: "25.500000",
        bedTemp0: "30.000000",
        fan: 1,
        modelFanPct: 47,
        state: 1,
        printProgress: 50,
        dProgress: 40,
        curPosition: "X:1.00 Y:2.00 Z:3.00",
        err: { errcode: 0, key: 0 },
        video: 1,
        video1: 0,
      },
      receivedAt: "2026-08-07T08:15:03.000Z",
    });

    expect(record.state).toBe("matched");
    expect(record.lastDiffs).toEqual([]);
    expect(record.lastSequence).toBe(1);
    expect(monitorData.machines[host].runtimeData.printerCoreV3Shadow.lastState.camera.mjpeg).toBe(true);
  });

  it("K1 delta frameでもprotocolStateを通してlegacyとの差分なしでMJPEGを維持する", () => {
    const host = "K1Max-Live-B";
    const deviceId = "host:K1Max-Live-B";
    const sessionId = "k1-live:test-b";
    setMachine(host, {
      video: stored(1),
      video1: stored(0),
    });
    beginK1LiveShadowSession({ host, deviceId, sessionId });
    observeK1LiveShadowFrame({
      host,
      deviceId,
      sessionId,
      frame: { video: 1, video1: 0 },
      receivedAt: "2026-08-07T08:15:03.000Z",
    });

    const record = observeK1LiveShadowFrame({
      host,
      deviceId,
      sessionId,
      frame: { video1: 0 },
      receivedAt: "2026-08-07T08:15:04.000Z",
    });

    expect(record.state).toBe("matched");
    expect(record.lastState.camera.mjpeg).toBe(true);
    expect(record.lastDiffs).toEqual([]);
  });

  it("legacy projectionとv3 stateが異なる場合はdiffとしてruntimeDataへ記録する", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = "K1Max-Live-C";
    const deviceId = "host:K1Max-Live-C";
    const sessionId = "k1-live:test-c";
    setMachine(host, {
      printProgress: stored(49),
    });
    beginK1LiveShadowSession({ host, deviceId, sessionId });

    const record = observeK1LiveShadowFrame({
      host,
      deviceId,
      sessionId,
      frame: { printProgress: 50 },
      receivedAt: "2026-08-07T08:15:03.000Z",
    });

    expect(record.state).toBe("diff");
    expect(record.lastDiffs).toEqual([
      { path: "print.progressPct", v3: 50, legacy: 49 },
    ]);
    expect(warnSpy).toHaveBeenCalledOnce();

    const repeated = observeK1LiveShadowFrame({
      host,
      deviceId,
      sessionId,
      frame: { printProgress: 51 },
      receivedAt: "2026-08-07T08:15:04.000Z",
    });

    expect(repeated.state).toBe("diff");
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("endK1LiveShadowSession はruntimeDataをclosedへ更新する", () => {
    const host = "K1Max-Live-D";
    const deviceId = "host:K1Max-Live-D";
    const sessionId = "k1-live:test-d";
    setMachine(host);
    beginK1LiveShadowSession({ host, deviceId, sessionId });

    expect(endK1LiveShadowSession({ host, deviceId, sessionId })).toBe(true);
    expect(monitorData.machines[host].runtimeData.printerCoreV3Shadow.state).toBe("closed");
  });

  it("stale sessionの終了要求では現在のruntimeDataをclosedへ変えない", () => {
    const host = "K1Max-Live-E";
    const deviceId = "host:K1Max-Live-E";
    setMachine(host);
    beginK1LiveShadowSession({ host, deviceId, sessionId: "k1-live:old" });
    beginK1LiveShadowSession({ host, deviceId, sessionId: "k1-live:new" });

    expect(endK1LiveShadowSession({ host, deviceId, sessionId: "k1-live:old" })).toBe(false);
    expect(monitorData.machines[host].runtimeData.printerCoreV3Shadow).toMatchObject({
      state: "active",
      sessionId: "k1-live:new",
    });
  });
});
