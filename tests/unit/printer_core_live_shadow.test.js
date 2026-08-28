/**
 * @fileoverview Printer Core v3 live shadow の単体テスト
 * @description
 * - K1 legacy differential と K2 read-only shadow の runtime record 境界を検証する。
 *
 * @version 1.390.1436 (PR #435)
 * @since 1.390.1299 (PR #432)
 * @lastModified 2026-08-28 10:37:51
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { monitorData } from "../../3dp_lib/dashboard_data.js";
import {
  beginK1LiveShadowSession,
  beginK2LiveShadowSession,
  createPrinterCoreV3ShadowSessionId,
  endK1LiveShadowSession,
  endK2LiveShadowSession,
  isRecoverableK1LiveShadowObserveError,
  observeK1LiveShadowFrame,
  observeK2LiveShadowFrame,
  observeMoonrakerCfsMaterialProviderFrame,
  resolveK1LiveShadowDeviceId,
} from "../../3dp_lib/printer_core/dashboard_live_shadow.js";
import { PRINTER_FACADE_ERROR_CODES } from "../../3dp_lib/printer_core/dashboard_printer_facade.js";

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
    monitorData.materialSourceObservations = undefined;
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

  it("K2 live shadow session ID はK1と別namespaceで生成する", () => {
    const sessionId = createPrinterCoreV3ShadowSessionId({
      family: "k2",
      host: "K2Pro-69E7",
      dest: "192.168.54.21:9999",
      openedAt: "2026-08-07T08:15:03.000Z",
    });

    expect(sessionId).toBe("k2-live:K2Pro-69E7:192.168.54.21%3A9999:2026-08-07T08%3A15%3A03.000Z");
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

  it("identityが無い場合もhostnameをstable ID扱いせずshadow暫定IDにする", () => {
    const withEndpoint = resolveK1LiveShadowDeviceId({
      host: "K1Max-NoIdentity",
      dest: "192.168.54.151:9999",
    });
    const withoutEndpoint = resolveK1LiveShadowDeviceId({
      host: "K1Max-NoEndpoint",
    });

    expect(withEndpoint).toBe("provisional-shadow:endpoint:192.168.54.151%3A9999");
    expect(withoutEndpoint).toBe("provisional-shadow:host:K1Max-NoEndpoint");
  });

  it("session未開始だけをrecoverable observe errorとして扱う", () => {
    expect(isRecoverableK1LiveShadowObserveError(new Error("session has not been started"))).toBe(true);
    expect(isRecoverableK1LiveShadowObserveError({
      code: PRINTER_FACADE_ERROR_CODES.SESSION_NOT_STARTED,
      message: "localized message",
    })).toBe(true);
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

  it("observeFrameResult contract のsession未開始rejectionも1回だけ復旧する", () => {
    const host = "K1Max-Live-Result-Recover";
    const deviceId = "host:K1Max-Live-Result-Recover";
    const sessionId = "k1-live:test-result-recover";
    const state = {
      source: {
        receivedAt: "2026-08-07T08:15:03.000Z",
        sequence: 1,
      },
      identity: {
        reportedModel: null,
        reportedHostname: null,
      },
      temperatures: {
        nozzle: { current: null, target: null, max: null },
        bed: { current: null, target: null, max: null },
        chamber: { current: null, target: null, max: null },
      },
      fans: {
        partCooling: { enabled: null, percent: null },
        auxiliary: { enabled: null, percent: null },
        case: { enabled: null, percent: null },
      },
      light: {
        enabled: null,
      },
      print: {
        stateCode: null,
        progressPct: 10,
        layer: null,
        totalLayer: null,
        remainingSec: null,
        fileName: null,
      },
      motion: {
        position: null,
      },
      error: {
        code: null,
        key: null,
      },
      camera: {
        mjpeg: null,
        webrtc: null,
        timelapseEnabled: null,
      },
      ai: {
        detection: null,
        switchEnabled: null,
        pauseOnDetection: null,
        firstLayer: null,
      },
    };
    const facade = {
      observeFrameResult: vi.fn()
        .mockReturnValueOnce({
          accepted: false,
          reason: PRINTER_FACADE_ERROR_CODES.SESSION_NOT_STARTED,
          deviceId,
          sessionId,
          activeSessionId: null,
        })
        .mockReturnValueOnce({
          accepted: true,
          state,
        }),
    };
    setMachine(host, {
      printProgress: stored(10),
    });

    const record = observeK1LiveShadowFrame({
      host,
      deviceId,
      sessionId,
      frame: { printProgress: 10 },
      receivedAt: "2026-08-07T08:15:03.000Z",
    }, { facade });

    expect(facade.observeFrameResult).toHaveBeenCalledTimes(2);
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
    expect(record.differentialCompared).toBe(true);
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

  it("K2 live frameはlegacy差分ではなくstatus/material topologyの観測結果としてruntimeDataへ記録する", () => {
    const host = "K2Pro-Live-A";
    const deviceId = "host:K2Pro-Live-A";
    const sessionId = "k2-live:test-a";
    setMachine(host);
    beginK2LiveShadowSession({ host, deviceId, sessionId });

    observeK2LiveShadowFrame({
      host,
      deviceId,
      sessionId,
      frame: {
        hostname: host,
        model: "F012",
        cfsConnect: 1,
        nozzleTemp: "32.090000",
      },
      receivedAt: "2026-08-07T08:15:03.000Z",
    });
    const record = observeK2LiveShadowFrame({
      host,
      deviceId,
      sessionId,
      frame: {
        boxsInfo: {
          enable: 1,
          materialBoxs: [
            {
              id: 1,
              state: 1,
              type: 0,
              temp: 29,
              humidity: 50,
              materials: [
                { id: 0, vendor: "Generic", type: "PLA", color: "#0ffffff", name: "Generic PLA", percent: 100 },
              ],
            },
          ],
          colorMatch: [{ id: "T1A", boxId: 1, materialId: 0 }],
        },
      },
      receivedAt: "2026-08-07T08:15:04.000Z",
      snapshotCompleteness: "complete",
    });

    expect(record).toMatchObject({
      printerFamily: "k2",
      state: "observed",
      differentialCompared: false,
      observedFrames: 2,
      diffCount: 0,
      cfsConnected: true,
      cfsTopologyState: "fresh",
      cfsSourceCount: 1,
      cfsAssignmentCount: 1,
    });
    expect(record.lastState.identity.reportedModel).toBe("F012");
    expect(record.lastState.materials.sources[0].sourceId).toBe("cfs:1:slot:0");
    expect(monitorData.machines[host].runtimeData.printerCoreV3Shadow).toMatchObject({
      printerFamily: "k2",
      sessionId,
      lastSequence: 2,
    });
  });

  it("K2 CFS topologyの観測時刻はboxsInfo実受信時だけ更新し通常statusでは延命しない", () => {
    const host = "K2Pro-Live-Freshness";
    const deviceId = "host:K2Pro-Live-Freshness";
    const sessionId = "k2-live:freshness";
    setMachine(host);
    beginK2LiveShadowSession({ host, deviceId, sessionId });

    const materialRecord = observeK2LiveShadowFrame({
      host,
      deviceId,
      sessionId,
      frame: {
        hostname: host,
        model: "F012",
        cfsConnect: 1,
        boxsInfo: {
          enable: 1,
          materialBoxs: [
            {
              id: 1,
              state: 1,
              type: 0,
              materials: [
                { id: 0, vendor: "Generic", type: "PLA", color: "#0ffffff", name: "Silver PLA", percent: 54 },
              ],
            },
          ],
        },
      },
      receivedAt: "2026-08-07T08:15:04.000Z",
      snapshotCompleteness: "complete",
    });

    expect(materialRecord.materialProviderLastObservedAt).toBe("2026-08-07T08:15:04.000Z");
    expect(materialRecord.lastState.materials.provider.lastObservedAt).toBe("2026-08-07T08:15:04.000Z");

    const statusRecord = observeK2LiveShadowFrame({
      host,
      deviceId,
      sessionId,
      frame: {
        nozzleTemp: "35.0",
        printProgress: 10,
      },
      receivedAt: "2026-08-07T08:16:04.000Z",
    });

    expect(statusRecord.lastObservedAt).toBe("2026-08-07T08:16:04.000Z");
    expect(statusRecord.materialProviderLastObservedAt).toBe("2026-08-07T08:15:04.000Z");
    expect(statusRecord.lastState.materials.provider.lastObservedAt).toBe("2026-08-07T08:15:04.000Z");
    expect(statusRecord.lastState.materials.sources[0].material.name).toBe("Silver PLA");
  });

  it("K2 runtime material topologyはpartial source deltaでも未観測material/remaining/assignmentを保持する", () => {
    const host = "K2Pro-Live-Partial-Source";
    const deviceId = "host:K2Pro-Live-Partial-Source";
    const sessionId = "k2-live:partial-source";
    setMachine(host);
    beginK2LiveShadowSession({ host, deviceId, sessionId });

    observeK2LiveShadowFrame({
      host,
      deviceId,
      sessionId,
      frame: {
        boxsInfo: {
          enable: 1,
          materialBoxs: [
            {
              id: 1,
              state: 1,
              type: 0,
              materials: [
                { id: 2, vendor: "Generic", type: "PLA", color: "#09ea7ae", name: "Silver PLA", selected: 1, percent: 54, state: 1 },
              ],
            },
          ],
          colorMatch: [{ id: "T1C", boxId: 1, materialId: 2 }],
        },
      },
      receivedAt: "2026-08-07T08:15:04.000Z",
    });

    const partialRecord = observeK2LiveShadowFrame({
      host,
      deviceId,
      sessionId,
      frame: {
        boxsInfo: {
          enable: 1,
          materialBoxs: [
            {
              id: 1,
              type: 0,
              materials: [
                { id: 2, selected: 0 },
              ],
            },
          ],
        },
      },
      receivedAt: "2026-08-07T08:15:14.000Z",
    });

    const source = partialRecord.lastState.materials.sources.find((entry) => entry.sourceId === "cfs:1:slot:2");
    expect(source).toMatchObject({
      material: {
        type: "PLA",
        name: "Silver PLA",
        color: {
          raw: "#09ea7ae",
          displayHex: "9ea7ae",
        },
      },
      status: {
        selected: false,
        remaining: {
          normalizedPercent: 54,
          valid: true,
        },
        stateCode: 1,
      },
    });
    expect(partialRecord.lastState.materials.assignments).toEqual([
      expect.objectContaining({ assignmentId: "T1C", sourceId: "cfs:1:slot:2" }),
    ]);
  });

  it("K2 runtime material topologyはcolorMatchのみのpartial deltaで既存source assignmentを置換またはclearする", () => {
    const host = "K2Pro-Live-Partial-Assignment";
    const deviceId = "host:K2Pro-Live-Partial-Assignment";
    const sessionId = "k2-live:partial-assignment";
    setMachine(host);
    beginK2LiveShadowSession({ host, deviceId, sessionId });

    observeK2LiveShadowFrame({
      host,
      deviceId,
      sessionId,
      frame: {
        boxsInfo: {
          enable: 1,
          materialBoxs: [
            {
              id: 1,
              state: 1,
              type: 0,
              materials: [
                { id: 2, vendor: "Generic", type: "PLA", color: "#09ea7ae", name: "Silver PLA", selected: 1, percent: 54, state: 1 },
              ],
            },
          ],
          colorMatch: [{ id: "T1C", boxId: 1, materialId: 2 }],
        },
      },
      receivedAt: "2026-08-07T08:15:04.000Z",
    });

    const updateRecord = observeK2LiveShadowFrame({
      host,
      deviceId,
      sessionId,
      frame: {
        boxsInfo: {
          enable: 1,
          colorMatch: [{ id: "T1A", boxId: 1, materialId: 2 }],
        },
      },
      receivedAt: "2026-08-07T08:15:14.000Z",
    });

    expect(updateRecord.lastState.materials.sources.find((entry) => entry.sourceId === "cfs:1:slot:2")).toMatchObject({
      material: {
        name: "Silver PLA",
      },
      status: {
        remaining: {
          normalizedPercent: 54,
        },
      },
    });
    expect(updateRecord.lastState.materials.assignments).toEqual([
      expect.objectContaining({ assignmentId: "T1A", sourceId: "cfs:1:slot:2" }),
    ]);

    const clearRecord = observeK2LiveShadowFrame({
      host,
      deviceId,
      sessionId,
      frame: {
        boxsInfo: {
          enable: 1,
          colorMatch: [],
        },
      },
      receivedAt: "2026-08-07T08:15:24.000Z",
    });

    expect(clearRecord.lastState.materials.assignments).toEqual([]);
    expect(clearRecord.lastState.materials.sources.find((entry) => entry.sourceId === "cfs:1:slot:2")).toMatchObject({
      material: {
        name: "Silver PLA",
      },
      status: {
        remaining: {
          normalizedPercent: 54,
        },
      },
    });
  });

  it("K2 CFS topologyはread-only観測台帳へ保存し、管理スプールや台帳には書き込まない", () => {
    const host = "K2Pro-Observation";
    const deviceId = "serial:905251280E69E7";
    const sessionId = "k2-live:observation";
    setMachine(host);
    beginK2LiveShadowSession({ host, deviceId, sessionId });
    monitorData.hostSpoolMap = { [host]: "spool-managed" };
    monitorData.mountHistory = [{ evId: "mount-1", host, spoolId: "spool-managed" }];
    monitorData.usageHistory = [{ usageId: "usage-1", host, spoolId: "spool-managed" }];
    monitorData.filamentSpools = [{ id: "spool-managed", remainingLengthMm: 1000 }];
    const untouched = {
      hostSpoolMap: JSON.stringify(monitorData.hostSpoolMap),
      mountHistory: JSON.stringify(monitorData.mountHistory),
      usageHistory: JSON.stringify(monitorData.usageHistory),
      filamentSpools: JSON.stringify(monitorData.filamentSpools),
    };

    observeK2LiveShadowFrame({
      host,
      deviceId,
      sessionId,
      frame: {
        boxsInfo: {
          enable: 1,
          materialBoxs: [
            {
              id: 0,
              state: 1,
              type: 1,
              materials: [
                { id: 0, vendor: "Generic", type: "PLA", color: "#0ffffff", name: "External PLA", percent: null, rfid: "" },
              ],
            },
            {
              id: 1,
              state: 1,
              type: 0,
              materials: [
                { id: 2, vendor: "Generic", type: "PLA", color: "#09ea7ae", name: "Silver PLA", percent: -5, selected: 1, rfid: "" },
              ],
            },
          ],
          colorMatch: [{ id: "T1A", boxId: 1, materialId: 2 }],
        },
      },
      receivedAt: "2026-08-07T08:15:04.000Z",
      snapshotCompleteness: "complete",
    });

    const observations = monitorData.materialSourceObservations;
    expect(observations.byDeviceId[deviceId]).toMatchObject({
      authority: "observation-only",
      identityStrength: "stable",
      providerId: "creality-cfs-boxs-info",
      sessionId,
      snapshotCompleteness: "complete",
    });
    expect(observations.byDeviceId[deviceId].latestBySourceId["external:0:slot:0"]).toMatchObject({
      kind: "external-spool",
      material: { rfid: "" },
      authority: "observation-only",
    });
    expect(observations.byDeviceId[deviceId].latestBySourceId["cfs:1:slot:2"]).toMatchObject({
      selected: true,
      assignments: [{ assignmentId: "T1A" }],
      material: {
        rfid: "",
        color: {
          raw: "#09ea7ae",
          displayHex: "9ea7ae",
          cssColor: "#9ea7ae",
        },
      },
      remaining: {
        rawPercent: -5,
        normalizedPercent: 0,
        valid: false,
        authority: "observation-only",
      },
    });
    expect(JSON.stringify(monitorData.hostSpoolMap)).toBe(untouched.hostSpoolMap);
    expect(JSON.stringify(monitorData.mountHistory)).toBe(untouched.mountHistory);
    expect(JSON.stringify(monitorData.usageHistory)).toBe(untouched.usageHistory);
    expect(JSON.stringify(monitorData.filamentSpools)).toBe(untouched.filamentSpools);
  });

  it("K2 material observationはMACをstable扱いせず、同一hostのprovisional履歴をserialへrekeyする", () => {
    const host = "K2Pro-Rekey";
    setMachine(host);
    beginK2LiveShadowSession({ host, deviceId: "provisional-shadow:endpoint:192.168.54.153%3A9999", sessionId: "k2-live:provisional" });
    observeK2LiveShadowFrame({
      host,
      deviceId: "provisional-shadow:endpoint:192.168.54.153%3A9999",
      sessionId: "k2-live:provisional",
      frame: {
        boxsInfo: {
          enable: 1,
          materialBoxs: [
            { id: 1, state: 1, type: 0, materials: [{ id: 0, vendor: "Generic", type: "PLA", color: "#0bbbbbb", name: "Silver PLA", percent: 54 }] },
          ],
        },
      },
      receivedAt: "2026-08-07T08:15:04.000Z",
    });

    expect(monitorData.materialSourceObservations.byDeviceId["provisional-shadow:endpoint:192.168.54.153%3A9999"]).toMatchObject({
      identityStrength: "provisional",
    });

    beginK2LiveShadowSession({ host, deviceId: "serial:905251280E69E7", sessionId: "k2-live:stable" });
    observeK2LiveShadowFrame({
      host,
      deviceId: "serial:905251280E69E7",
      sessionId: "k2-live:stable",
      frame: {
        boxsInfo: {
          enable: 1,
          materialBoxs: [
            { id: 1, state: 1, type: 0, materials: [{ id: 0, vendor: "Generic", type: "PLA", color: "#0bbbbbb", name: "Silver PLA", percent: 54 }] },
          ],
        },
      },
      receivedAt: "2026-08-07T08:16:04.000Z",
    });

    expect(monitorData.materialSourceObservations.byDeviceId["provisional-shadow:endpoint:192.168.54.153%3A9999"]).toBeUndefined();
    expect(monitorData.materialSourceObservations.byDeviceId["serial:905251280E69E7"]).toMatchObject({
      identityStrength: "stable",
      aliases: ["provisional-shadow:endpoint:192.168.54.153%3A9999"],
    });

    setMachine("K2Pro-Mac");
    beginK2LiveShadowSession({ host: "K2Pro-Mac", deviceId: "mac:58:41:46:cf:fa:99", sessionId: "k2-live:mac" });
    observeK2LiveShadowFrame({
      host: "K2Pro-Mac",
      deviceId: "mac:58:41:46:cf:fa:99",
      sessionId: "k2-live:mac",
      frame: {
        boxsInfo: {
          enable: 1,
          materialBoxs: [
            { id: 1, state: 1, type: 0, materials: [{ id: 0, vendor: "Generic", type: "PLA" }] },
          ],
        },
      },
      receivedAt: "2026-08-07T08:17:04.000Z",
    });
    expect(monitorData.materialSourceObservations.byDeviceId["mac:58:41:46:cf:fa:99"]).toMatchObject({
      identityStrength: "provisional",
    });
  });

  it("CFS-C secondary provider切断時はlast-known topologyを空にせずstale化する", () => {
    const host = "K1C-CFSC-Live";
    setMachine(host);

    const observed = observeMoonrakerCfsMaterialProviderFrame({
      host,
      payload: {
        materialBoxs: [
          {
            id: 1,
            state: 1,
            type: 0,
            materials: [
              { id: 2, vendor: "Generic", type: "PLA", color: "#0bbbbbb", name: "Silver PLA", percent: 54, selected: 1 },
            ],
          },
        ],
      },
      providerSessionId: "material-provider:test",
      connected: true,
      receivedAt: "2026-08-07T08:15:04.000Z",
    });

    expect(observed.lastState.materials.sources[0]).toMatchObject({
      sourceId: "cfs:1:slot:2",
      material: {
        name: "Silver PLA",
      },
    });

    const stale = observeMoonrakerCfsMaterialProviderFrame({
      host,
      payload: null,
      providerSessionId: "material-provider:test",
      connected: false,
      receivedAt: "2026-08-07T08:16:04.000Z",
    });

    expect(stale.lastState.materials.sources[0]).toMatchObject({
      sourceId: "cfs:1:slot:2",
      material: {
        name: "Silver PLA",
      },
    });
    expect(stale.lastState.materials.cfs).toMatchObject({
      connected: false,
      topologyState: "stale",
    });
    expect(stale.materialProviderLastObservedAt).toBe("2026-08-07T08:15:04.000Z");
    expect(stale.materialProviderDisconnectedAt).toBe("2026-08-07T08:16:04.000Z");
    expect(stale.lastState.materials.provider).toMatchObject({
      lastObservedAt: "2026-08-07T08:15:04.000Z",
      disconnectedAt: "2026-08-07T08:16:04.000Z",
      freshness: "stale",
    });
  });

  it("CFS-C secondary providerもread-only観測台帳へ保存し、切断時はlast-knownをstaleとして残す", () => {
    const host = "K1C-CFSC-Observation";
    setMachine(host);
    monitorData.hostSpoolMap = { [host]: "k1-managed-spool" };
    monitorData.mountHistory = [];
    monitorData.usageHistory = [];

    observeMoonrakerCfsMaterialProviderFrame({
      host,
      payload: {
        materialBoxs: [
          {
            id: 1,
            state: 1,
            type: 0,
            materials: [
              { id: 2, vendor: "Generic", type: "PLA", color: "#0bbbbbb", name: "Silver PLA", percent: 54, selected: 1, rfid: null },
            ],
          },
        ],
      },
      providerSessionId: "material-provider:test",
      connected: true,
      receivedAt: "2026-08-07T08:15:04.000Z",
    });
    observeMoonrakerCfsMaterialProviderFrame({
      host,
      payload: null,
      providerSessionId: "material-provider:test",
      connected: false,
      receivedAt: "2026-08-07T08:16:04.000Z",
    });

    const deviceId = "material-provider:K1C-CFSC-Observation";
    expect(monitorData.materialSourceObservations.byDeviceId[deviceId]).toMatchObject({
      authority: "observation-only",
      identityStrength: "provisional",
      providerId: "creality-cfs-moonraker-box",
      providerDisconnectedAt: "2026-08-07T08:16:04.000Z",
      latestBySourceId: {
        "cfs:1:slot:2": {
          presence: "loaded",
          selected: true,
          lastObservedAt: "2026-08-07T08:15:04.000Z",
          material: { rfid: null },
          remaining: {
            rawPercent: 54,
            normalizedPercent: 54,
            valid: true,
            authority: "observation-only",
          },
        },
      },
    });
    expect(monitorData.hostSpoolMap).toEqual({ [host]: "k1-managed-spool" });
    expect(monitorData.mountHistory).toEqual([]);
    expect(monitorData.usageHistory).toEqual([]);
  });

  it("CFS-C notify deltaはpartial観測として扱い、payloadに無いslotをtombstone化しない", () => {
    const host = "K1C-CFSC-Delta";
    setMachine(host);

    observeMoonrakerCfsMaterialProviderFrame({
      host,
      payload: {
        materialBoxs: [
          {
            id: 1,
            state: 1,
            type: 0,
            materials: [
              { id: 0, vendor: "Generic", type: "PLA", color: "#0aaaaaa", name: "White PLA", percent: 80 },
              { id: 2, vendor: "Generic", type: "PLA", color: "#0bbbbbb", name: "Silver PLA", percent: 54 },
            ],
          },
        ],
      },
      providerSessionId: "material-provider:delta",
      connected: true,
      receivedAt: "2026-08-07T08:15:04.000Z",
      snapshotCompleteness: "complete",
    });

    observeMoonrakerCfsMaterialProviderFrame({
      host,
      payload: {
        materialBoxs: [
          {
            id: 1,
            state: 1,
            type: 0,
            materials: [
              { id: 2, vendor: "Generic", type: "PLA", color: "#0bbbbbb", name: "Silver PLA", percent: 53 },
            ],
          },
        ],
      },
      providerSessionId: "material-provider:delta",
      connected: true,
      receivedAt: "2026-08-07T08:15:14.000Z",
      snapshotCompleteness: "partial",
    });

    const observation = monitorData.materialSourceObservations.byDeviceId["material-provider:K1C-CFSC-Delta"];
    expect(observation.latestBySourceId["cfs:1:slot:0"]).toMatchObject({
      presence: "loaded",
      material: { name: "White PLA" },
      lastObservedAt: "2026-08-07T08:15:04.000Z",
    });
    expect(observation.latestBySourceId["cfs:1:slot:2"]).toMatchObject({
      presence: "loaded",
      remaining: { rawPercent: 53 },
      lastObservedAt: "2026-08-07T08:15:14.000Z",
    });
    expect(observation.events.some((event) => event.sourceId === "cfs:1:slot:0" && event.changeKind === "source-disappeared")).toBe(false);
  });

  it("CFS-C provider close/reopenで同じendpoint generationを自己退役扱いにしない", () => {
    const host = "K1C-CFSC-Reopen";
    setMachine(host);

    observeMoonrakerCfsMaterialProviderFrame({
      host,
      payload: {
        materialBoxs: [
          {
            id: 1,
            state: 1,
            type: 0,
            materials: [
              { id: 0, vendor: "Generic", type: "PLA", color: "#0aaaaaa", name: "White PLA", percent: 80 },
            ],
          },
        ],
      },
      providerSessionId: "material-provider:reopen",
      providerGeneration: "material-provider:reopen:transport:1",
      connected: true,
      receivedAt: "2026-08-07T08:15:04.000Z",
      snapshotCompleteness: "complete",
    });

    observeMoonrakerCfsMaterialProviderFrame({
      host,
      payload: null,
      connected: false,
      receivedAt: "2026-08-07T08:16:04.000Z",
    });

    const reopened = observeMoonrakerCfsMaterialProviderFrame({
      host,
      payload: {
        materialBoxs: [
          {
            id: 1,
            state: 1,
            type: 0,
            materials: [
              { id: 0, vendor: "Generic", type: "PLA", color: "#0aaaaaa", name: "White PLA", percent: 79 },
            ],
          },
        ],
      },
      providerSessionId: "material-provider:reopen",
      providerGeneration: "material-provider:reopen:transport:2",
      connected: true,
      receivedAt: "2026-08-07T08:17:04.000Z",
      snapshotCompleteness: "complete",
    });

    expect(reopened.materialSourceObservationStatus).toMatchObject({
      accepted: true,
    });
    expect(
      monitorData.materialSourceObservations.byDeviceId["material-provider:K1C-CFSC-Reopen"].latestBySourceId["cfs:1:slot:0"].remaining.rawPercent
    ).toBe(79);
  });

  it("CFS-C notify deltaはruntime表示用topologyでも既存slotを保持する", () => {
    const host = "K1C-CFSC-Runtime-Delta";
    setMachine(host);

    observeMoonrakerCfsMaterialProviderFrame({
      host,
      payload: {
        materialBoxs: [
          {
            id: 1,
            state: 1,
            type: 0,
            materials: [
              { id: 0, vendor: "Generic", type: "PLA", color: "#0aaaaaa", name: "White PLA", percent: 80 },
              { id: 2, vendor: "Generic", type: "PLA", color: "#0bbbbbb", name: "Silver PLA", percent: 54 },
            ],
          },
        ],
      },
      providerSessionId: "material-provider:runtime-delta",
      providerGeneration: "material-provider:runtime-delta:transport:1",
      connected: true,
      receivedAt: "2026-08-07T08:15:04.000Z",
      snapshotCompleteness: "complete",
    });

    const updated = observeMoonrakerCfsMaterialProviderFrame({
      host,
      payload: {
        materialBoxs: [
          {
            id: 1,
            state: 1,
            type: 0,
            materials: [
              { id: 2, vendor: "Generic", type: "PLA", color: "#0bbbbbb", name: "Silver PLA", percent: 53 },
            ],
          },
        ],
      },
      providerSessionId: "material-provider:runtime-delta",
      providerGeneration: "material-provider:runtime-delta:transport:1",
      connected: true,
      receivedAt: "2026-08-07T08:15:14.000Z",
      snapshotCompleteness: "partial",
    });

    const runtimeSources = new Map(updated.lastState.materials.sources.map((source) => [source.sourceId, source]));
    expect(runtimeSources.get("cfs:1:slot:0")).toMatchObject({
      material: { name: "White PLA" },
      status: { remaining: { rawPercent: 80 } },
    });
    expect(runtimeSources.get("cfs:1:slot:2")).toMatchObject({
      material: { name: "Silver PLA" },
      status: { remaining: { rawPercent: 53 } },
    });
  });

  it("endK2LiveShadowSession はruntimeDataをclosedへ更新する", () => {
    const host = "K2Pro-Live-D";
    const deviceId = "host:K2Pro-Live-D";
    const sessionId = "k2-live:test-d";
    setMachine(host);
    beginK2LiveShadowSession({ host, deviceId, sessionId });

    expect(endK2LiveShadowSession({ host, deviceId, sessionId })).toBe(true);
    expect(monitorData.machines[host].runtimeData.printerCoreV3Shadow).toMatchObject({
      printerFamily: "k2",
      state: "closed",
    });
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
