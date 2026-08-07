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
  observeK1LiveShadowFrame,
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
});
