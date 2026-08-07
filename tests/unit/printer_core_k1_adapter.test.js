/**
 * @fileoverview Printer Core v3 K1 dry-run adapter の単体テスト
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { PRINTER_CAPABILITIES, hasCapability } from "../../3dp_lib/printer_core/dashboard_capabilities.js";
import { createK1Adapter, extractK1StatusPayload } from "../../3dp_lib/printer_core/dashboard_k1_adapter.js";
import {
  createK1PrinterFacade,
  createPrinterFacade,
} from "../../3dp_lib/printer_core/dashboard_printer_facade.js";

vi.hoisted(() => {
  globalThis.window = globalThis.window || {};
  if (!globalThis.document) {
    const dummyEl = () => ({
      style: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      appendChild() {}, removeChild() {}, setAttribute() {}, removeAttribute() {},
      addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
      innerHTML: "", textContent: "",
    });
    globalThis.document = {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => dummyEl(),
      body: dummyEl(),
    };
  }
});

vi.mock("../../3dp_lib/dashboard_storage.js", () => ({
  restoreUnifiedStorage: vi.fn(),
  saveUnifiedStorage: vi.fn(),
  trimUsageHistory: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_log_util.js", () => ({ pushLog: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_notification_manager.js", () => ({
  notificationManager: { notify: vi.fn() },
  showAlert: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_integration_itemkeeper.js", () => ({
  itemKeeperIntegration: { onPrintEvent: vi.fn() },
}));
vi.mock("../../3dp_lib/dashboard_printstatus.js", () => ({ handlePrintStateTransition: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_stage_preview.js", () => ({
  updateXYPreview: vi.fn(), updateZPreview: vi.fn(), setPrinterModel: vi.fn(),
}));
vi.mock("../../3dp_lib/3dp_dashboard_init.js", () => ({
  restorePrintResume: vi.fn(), persistPrintResume: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_printmanager.js", () => ({
  updateHistoryList: vi.fn(), updateVideoList: vi.fn(),
  loadHistory: vi.fn(() => []), jobsToRaw: vi.fn(() => []),
  renderHistoryTable: vi.fn(), renderPrintCurrent: vi.fn(),
  loadCurrent: vi.fn(() => ({})), saveCurrent: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_connection.js", () => ({
  getDeviceIp: vi.fn(() => "127.0.0.1"), getHttpPort: vi.fn(() => 80),
}));
vi.mock("../../3dp_lib/dashboard_spool.js", () => ({
  getCurrentSpool: vi.fn(() => null), formatFilamentAmount: vi.fn(() => ""), formatSpoolDisplayId: vi.fn(() => ""),
}));
vi.mock("../../3dp_lib/dashboard_aggregator.js", () => ({
  ingestData: vi.fn(), restoreAggregatorState: vi.fn(), restartAggregatorTimer: vi.fn(), ensureAggregatorTimer: vi.fn(),
  persistAggregatorState: vi.fn(), setHistoryPersistFunc: vi.fn(), aggregatorUpdate: vi.fn(),
  getCurrentPrintID: vi.fn(() => 0),
}));

import { processData } from "../../3dp_lib/dashboard_msg_handler.js";
import { ensureMachineData, monitorData } from "../../3dp_lib/dashboard_data.js";

const FIXTURE_DEVICE_A = path.resolve("tests", "fixtures", "printers", "k1-max", "device-a", "events.ndjson");
const FIXTURE_DEVICE_B = path.resolve("tests", "fixtures", "printers", "k1-max", "device-b", "events.ndjson");

function readNdjson(filePath) {
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readStatusEvents(filePath) {
  return readNdjson(filePath).filter((event) => {
    return event.direction === "in" &&
      event.channel === "ws9999" &&
      event.payload?.bodyKind === "json" &&
      event.payload?.body &&
      typeof event.payload.body === "object";
  });
}

function readFirstStatusEvent(filePath) {
  return readStatusEvents(filePath)[0];
}

function rawStoredValue(host, key) {
  const entry = monitorData.machines[host]?.storedData?.[key];
  return entry?.rawValue ?? entry?.computedValue;
}

function rawNumber(host, key) {
  const value = rawStoredValue(host, key);
  const raw = value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value")
    ? value.value
    : value;
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  const numberValue = Number(raw);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function rawString(host, key) {
  const value = rawStoredValue(host, key);
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

function rawBooleanFlag(host, key) {
  const numberValue = rawNumber(host, key);
  return numberValue === null ? null : numberValue === 1;
}

function rawCameraMjpeg(host) {
  const video = rawBooleanFlag(host, "video");
  const video1 = rawBooleanFlag(host, "video1");
  if (video === null && video1 === null) {
    return null;
  }
  return video === true || video1 === true;
}

function projectLegacyStoredData(host) {
  const err = rawStoredValue(host, "err");
  return {
    identity: {
      reportedModel: rawString(host, "model"),
      reportedHostname: rawString(host, "hostname"),
    },
    temperatures: {
      nozzle: {
        current: rawNumber(host, "nozzleTemp"),
        target: rawNumber(host, "targetNozzleTemp"),
        max: rawNumber(host, "maxNozzleTemp"),
      },
      bed: {
        current: rawNumber(host, "bedTemp0"),
        target: rawNumber(host, "targetBedTemp0"),
        max: rawNumber(host, "maxBedTemp"),
      },
      chamber: {
        current: rawNumber(host, "boxTemp"),
        target: rawNumber(host, "targetBoxTemp"),
        max: rawNumber(host, "maxBoxTemp"),
      },
    },
    fans: {
      partCooling: {
        enabled: rawBooleanFlag(host, "fan"),
        percent: rawNumber(host, "modelFanPct"),
      },
      auxiliary: {
        enabled: rawBooleanFlag(host, "fanAuxiliary"),
        percent: rawNumber(host, "auxiliaryFanPct"),
      },
      chamber: {
        enabled: rawBooleanFlag(host, "fanCase"),
        percent: rawNumber(host, "caseFanPct"),
      },
    },
    light: {
      enabled: rawBooleanFlag(host, "lightSw"),
    },
    print: {
      stateCode: rawNumber(host, "state"),
      progressPct: rawNumber(host, "printProgress"),
      layer: rawNumber(host, "layer"),
      totalLayer: rawNumber(host, "TotalLayer"),
      remainingSec: rawNumber(host, "printLeftTime"),
      fileName: rawString(host, "printFileName"),
    },
    motion: {
      position: {
        x: rawNumber(host, "positionX"),
        y: rawNumber(host, "positionY"),
        z: rawNumber(host, "positionZ"),
      },
    },
    error: {
      code: err ? Number(err.errcode) : null,
      key: err ? Number(err.key) : null,
    },
    camera: {
      mjpeg: rawCameraMjpeg(host),
      webrtc: rawBooleanFlag(host, "webrtcSupport"),
      timelapseEnabled: rawBooleanFlag(host, "videoElapse"),
    },
    ai: {
      detection: rawNumber(host, "aiDetection"),
      switchEnabled: rawNumber(host, "aiSw"),
      pauseOnDetection: rawNumber(host, "aiPausePrint"),
      firstLayer: rawNumber(host, "aiFirstFloor"),
    },
  };
}

function expectOptionalCloseTo(actual, expected) {
  if (expected === null) {
    expect(actual).toBeNull();
  } else {
    expect(actual).toBeCloseTo(expected);
  }
}

function expectStateMatchesLegacy(v3, legacy) {
  expect(v3.identity.reportedModel).toBe(legacy.identity.reportedModel);
  expectOptionalCloseTo(v3.temperatures.nozzle.current, legacy.temperatures.nozzle.current);
  expect(v3.temperatures.nozzle.target).toBe(legacy.temperatures.nozzle.target);
  expect(v3.temperatures.nozzle.max).toBe(legacy.temperatures.nozzle.max);
  expectOptionalCloseTo(v3.temperatures.bed.current, legacy.temperatures.bed.current);
  expect(v3.temperatures.bed.target).toBe(legacy.temperatures.bed.target);
  expect(v3.temperatures.bed.max).toBe(legacy.temperatures.bed.max);
  expect(v3.temperatures.chamber.current).toBe(legacy.temperatures.chamber.current);
  expect(v3.temperatures.chamber.target).toBe(legacy.temperatures.chamber.target);
  expect(v3.temperatures.chamber.max).toBe(legacy.temperatures.chamber.max);
  expect(v3.fans).toEqual(legacy.fans);
  expect(v3.light).toEqual(legacy.light);
  expect(v3.print.stateCode).toBe(legacy.print.stateCode);
  expect(v3.print.progressPct).toBe(legacy.print.progressPct);
  expect(v3.print.layer).toBe(legacy.print.layer);
  expect(v3.print.totalLayer).toBe(legacy.print.totalLayer);
  expect(v3.print.remainingSec).toBe(legacy.print.remainingSec);
  expect(v3.print.fileName).toBe(legacy.print.fileName);
  expect(v3.motion.position).toEqual(legacy.motion.position);
  expect(v3.error.code).toBe(legacy.error.code);
  expect(v3.error.key).toBe(legacy.error.key);
  expect(v3.camera).toEqual(legacy.camera);
  expect(v3.ai).toEqual(legacy.ai);
}

function replayFixtureThroughLegacyAndV3(fixturePath, host, deviceId, sessionId) {
  const facade = createK1PrinterFacade({
    clock: () => new Date("2026-08-07T02:42:13.000Z"),
  });
  const events = readStatusEvents(fixturePath);
  ensureMachineData(host);
  facade.beginSession({ deviceId, sessionId });

  const states = [];
  for (const event of events) {
    const payload = extractK1StatusPayload(event);
    processData(payload, host);
    const v3 = facade.observeFrame({ deviceId, sessionId, frame: event });
    const legacy = projectLegacyStoredData(host);
    expectStateMatchesLegacy(v3, legacy);
    states.push(v3);
  }
  return states;
}

describe("Printer Core v3 K1 dry-run adapter", () => {
  beforeEach(() => {
    monitorData.machines = {};
    vi.clearAllMocks();
  });

  it("fixture event から K1 status payload を抽出する", () => {
    const event = readFirstStatusEvent(FIXTURE_DEVICE_A);
    const payload = extractK1StatusPayload(event);

    expect(payload.model).toBe("K1 Max");
    expect(payload.curPosition).toBe("X:296.50 Y:220.00 Z:300.16");
  });

  it("K1Adapter は完全stateではなく観測keyだけの Normalized Patch を返す", () => {
    const adapter = createK1Adapter();
    const deltaEvent = readStatusEvents(FIXTURE_DEVICE_B)[1];
    const patch = adapter.normalizeFrame(deltaEvent, {
      deviceId: "fixture:k1-max-b",
      sessionId: "fixture-session-b",
      sequence: 2,
      receivedAt: "2026-08-07T02:42:13.000Z",
    });

    expect(patch.kind).toBe("state-patch");
    expect(patch.source.rawKeys).toEqual(["bedTemp0", "nozzleTemp"]);
    expect(patch.patch.temperatures.nozzle.current).toBeCloseTo(25.99);
    expect(patch.patch.temperatures.bed.current).toBeCloseTo(25.72);
    expect(patch.patch.print).toBeUndefined();
    expect(patch.patch.fans).toBeUndefined();
    expect(patch.patch.motion).toBeUndefined();
  });

  it("binary fan と percent fan を混同しない", () => {
    const adapter = createK1Adapter();
    const binaryOnly = adapter.normalizeFrame({ fan: 1 }, {
      deviceId: "fixture:k1-fan",
      sessionId: "fixture-session-fan",
      sequence: 1,
      receivedAt: "2026-08-07T02:42:13.000Z",
    });
    const withPercent = adapter.normalizeFrame({ fan: 1, modelFanPct: 47 }, {
      deviceId: "fixture:k1-fan",
      sessionId: "fixture-session-fan",
      sequence: 2,
      receivedAt: "2026-08-07T02:42:14.000Z",
    });

    expect(binaryOnly.patch.fans.partCooling).toEqual({ enabled: true });
    expect(withPercent.patch.fans.partCooling).toEqual({ enabled: true, percent: 47 });
  });

  it("multi-raw camera field の delta frame でも protocol state から MJPEG capability を復元する", () => {
    const facade = createK1PrinterFacade({
      clock: () => new Date("2026-08-07T02:42:13.000Z"),
    });
    facade.beginSession({ deviceId: "fixture:k1-camera", sessionId: "session-camera" });

    const first = facade.observeFrame({
      deviceId: "fixture:k1-camera",
      sessionId: "session-camera",
      frame: { video: 1, video1: 0 },
    });
    const second = facade.observeFrame({
      deviceId: "fixture:k1-camera",
      sessionId: "session-camera",
      frame: { video1: 0 },
    });

    expect(first.camera.mjpeg).toBe(true);
    expect(second.camera.mjpeg).toBe(true);
    expect(second.source.rawKeys).toEqual(["video1"]);
  });

  it("multi-raw progress field の delta frame でも printProgress 優先を維持する", () => {
    const facade = createK1PrinterFacade({
      clock: () => new Date("2026-08-07T02:42:13.000Z"),
    });
    facade.beginSession({ deviceId: "fixture:k1-progress", sessionId: "session-progress" });

    const first = facade.observeFrame({
      deviceId: "fixture:k1-progress",
      sessionId: "session-progress",
      frame: { printProgress: 50, dProgress: 40 },
    });
    const second = facade.observeFrame({
      deviceId: "fixture:k1-progress",
      sessionId: "session-progress",
      frame: { dProgress: 41 },
    });

    expect(first.print.progressPct).toBe(50);
    expect(second.print.progressPct).toBe(50);
    expect(second.source.rawKeys).toEqual(["dProgress"]);
  });

  it("K1 Max device-a fixture stream を実processDataとframeごとに比較できる", () => {
    const states = replayFixtureThroughLegacyAndV3(
      FIXTURE_DEVICE_A,
      "K1Max-G2-A",
      "fixture:k1-max-a",
      "fixture-session-a",
    );

    expect(states).toHaveLength(1);
    expect(hasCapability(states[0].capabilities, PRINTER_CAPABILITIES.STATUS_TEMPERATURES)).toBe(true);
    expect(hasCapability(states[0].capabilities, PRINTER_CAPABILITIES.STATUS_POSITION)).toBe(true);
    expect(hasCapability(states[0].capabilities, PRINTER_CAPABILITIES.CAMERA_MJPEG)).toBe(true);
    expect(hasCapability(states[0].capabilities, PRINTER_CAPABILITIES.COMMAND_LED)).toBe(false);
  });

  it("K1 Max device-b の差分frameでも sequence 4 の状態を保持し温度だけ更新する", () => {
    const states = replayFixtureThroughLegacyAndV3(
      FIXTURE_DEVICE_B,
      "K1Max-G2-B",
      "fixture:k1-max-b",
      "fixture-session-b",
    );

    expect(states).toHaveLength(2);
    const [after4, after5] = states;
    expect(after5.temperatures.nozzle.current).toBeCloseTo(25.99);
    expect(after5.temperatures.bed.current).toBeCloseTo(25.72);
    expect(after5.print.fileName).toBe(after4.print.fileName);
    expect(after5.print.stateCode).toBe(after4.print.stateCode);
    expect(after5.motion.position).toEqual(after4.motion.position);
    expect(after5.light.enabled).toBe(after4.light.enabled);
    expect(after5.fans).toEqual(after4.fans);
  });

  it("PrinterFacade は明示session lifecycleで stale session を拒否する", () => {
    const event = readFirstStatusEvent(FIXTURE_DEVICE_A);
    const facade = createK1PrinterFacade({
      clock: () => new Date("2026-08-07T02:42:13.000Z"),
    });

    expect(() => facade.beginSession({ deviceId: "", sessionId: "session-1" })).toThrow(TypeError);
    expect(() => facade.beginSession({ deviceId: "fixture:k1-max-a", sessionId: "" })).toThrow(TypeError);

    const oldInstance = facade.beginSession({ deviceId: "fixture:k1-max-a", sessionId: "session-1" });
    const first = facade.observeFrame({
      deviceId: "fixture:k1-max-a",
      sessionId: "session-1",
      frame: event,
    });

    facade.beginSession({ deviceId: "fixture:k1-max-a", sessionId: "session-2" });
    const closed = oldInstance.observeFrame(event, { sessionId: "session-1" });
    const stale = facade.observeFrame({
      deviceId: "fixture:k1-max-a",
      sessionId: "session-1",
      frame: event,
    });
    const second = facade.observeFrame({
      deviceId: "fixture:k1-max-a",
      sessionId: "session-2",
      frame: event,
    });

    expect(first.source.sequence).toBe(1);
    expect(closed).toEqual({
      accepted: false,
      reason: "session-closed",
      deviceId: "fixture:k1-max-a",
      sessionId: "session-1",
      activeSessionId: "session-1",
    });
    expect(stale).toEqual({
      accepted: false,
      reason: "stale-session",
      deviceId: "fixture:k1-max-a",
      sessionId: "session-1",
      activeSessionId: "session-2",
    });
    expect(second.source.sequence).toBe(1);
    expect(facade.endSession({ deviceId: "fixture:k1-max-a", sessionId: "session-1" })).toBe(false);
    expect(facade.endSession({ deviceId: "fixture:k1-max-a", sessionId: "session-2" })).toBe(true);
  });

  it("generic PrinterFacade は adapter 指定漏れをK1へfallbackしない", () => {
    const facade = createPrinterFacade();

    expect(() => {
      facade.beginSession({ deviceId: "fixture:k1-max-a", sessionId: "session-1" });
    }).toThrow("Adapter has not been resolved");
  });

  it("getState と observeFrame の戻り値を mutate しても内部stateは壊れない", () => {
    const event = readFirstStatusEvent(FIXTURE_DEVICE_A);
    const facade = createK1PrinterFacade({
      clock: () => new Date("2026-08-07T02:42:13.000Z"),
    });
    facade.beginSession({ deviceId: "fixture:k1-max-a", sessionId: "session-1" });
    const observed = facade.observeFrame({
      deviceId: "fixture:k1-max-a",
      sessionId: "session-1",
      frame: event,
    });
    observed.print.progressPct = 999;

    const state = facade.getState("fixture:k1-max-a");
    state.print.progressPct = 888;

    expect(facade.getState("fixture:k1-max-a").print.progressPct).toBe(100);
  });
});
