/**
 * @fileoverview Printer Core v3 K1 dry-run adapter の単体テスト
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { PRINTER_CAPABILITIES, hasCapability } from "../../3dp_lib/printer_core/dashboard_capabilities.js";
import { createK1Adapter, extractK1StatusPayload } from "../../3dp_lib/printer_core/dashboard_k1_adapter.js";
import { createPrinterFacade } from "../../3dp_lib/printer_core/dashboard_printer_facade.js";
import { parseK1Position } from "../../3dp_lib/printer_core/dashboard_normalized_state.js";

const FIXTURE_DEVICE_A = path.resolve("tests", "fixtures", "printers", "k1-max", "device-a", "events.ndjson");
const FIXTURE_DEVICE_B = path.resolve("tests", "fixtures", "printers", "k1-max", "device-b", "events.ndjson");

function readNdjson(filePath) {
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readFirstStatusEvent(filePath) {
  return readNdjson(filePath).find((event) => {
    return event.direction === "in" &&
      event.channel === "ws9999" &&
      event.payload?.bodyKind === "json" &&
      event.payload?.body?.state !== undefined;
  });
}

function buildLegacyComparable(payload) {
  const position = parseK1Position(payload.curPosition);
  return {
    nozzleCurrent: Number(payload.nozzleTemp),
    nozzleTarget: Number(payload.targetNozzleTemp),
    bedCurrent: Number(payload.bedTemp0),
    bedTarget: Number(payload.targetBedTemp0),
    partCoolingPct: Number(payload.modelFanPct ?? payload.fan),
    auxiliaryPct: Number(payload.auxiliaryFanPct ?? payload.fanAuxiliary),
    chamberPct: Number(payload.caseFanPct ?? payload.fanCase),
    lightEnabled: Number(payload.lightSw) === 1,
    stateCode: Number(payload.state),
    progressPct: Number(payload.printProgress ?? payload.dProgress),
    layer: Number(payload.layer),
    totalLayer: Number(payload.TotalLayer),
    remainingSec: Number(payload.printLeftTime),
    fileName: payload.printFileName,
    position: position ? { x: position.x, y: position.y, z: position.z } : null,
    errorCode: Number(payload.err.errcode),
    errorKey: Number(payload.err.key),
    cameraMjpeg: Number(payload.video) === 1 || Number(payload.video1) === 1,
    cameraWebrtc: Number(payload.webrtcSupport) === 1,
    aiDetection: Number(payload.aiDetection),
  };
}

describe("Printer Core v3 K1 dry-run adapter", () => {
  it("fixture event から K1 status payload を抽出する", () => {
    const event = readFirstStatusEvent(FIXTURE_DEVICE_A);
    const payload = extractK1StatusPayload(event);

    expect(payload.model).toBe("K1 Max");
    expect(payload.curPosition).toBe("X:296.50 Y:220.00 Z:300.16");
  });

  it("K1 Max fixture を legacy processData と比較可能な NormalizedPrinterState へ変換する", () => {
    const adapter = createK1Adapter();

    for (const fixturePath of [FIXTURE_DEVICE_A, FIXTURE_DEVICE_B]) {
      const event = readFirstStatusEvent(fixturePath);
      const payload = extractK1StatusPayload(event);
      const legacy = buildLegacyComparable(payload);
      const state = adapter.normalizeFrame(event, {
        deviceId: `fixture:${path.basename(path.dirname(fixturePath))}`,
        sessionId: "fixture-session",
        sequence: event.sequence,
        receivedAt: "2026-08-07T02:42:13.000Z",
      });

      expect(state.source.adapterId).toBe("creality-k1");
      expect(state.source.protocol).toBe("ws9999");
      expect(state.identity.reportedModel).toBe("K1 Max");
      expect(state.temperatures.nozzle.current).toBeCloseTo(legacy.nozzleCurrent);
      expect(state.temperatures.nozzle.target).toBe(legacy.nozzleTarget);
      expect(state.temperatures.bed.current).toBeCloseTo(legacy.bedCurrent);
      expect(state.temperatures.bed.target).toBe(legacy.bedTarget);
      expect(state.fans.partCoolingPct).toBe(legacy.partCoolingPct);
      expect(state.fans.auxiliaryPct).toBe(legacy.auxiliaryPct);
      expect(state.fans.chamberPct).toBe(legacy.chamberPct);
      expect(state.light.enabled).toBe(legacy.lightEnabled);
      expect(state.print.stateCode).toBe(legacy.stateCode);
      expect(state.print.progressPct).toBe(legacy.progressPct);
      expect(state.print.layer).toBe(legacy.layer);
      expect(state.print.totalLayer).toBe(legacy.totalLayer);
      expect(state.print.remainingSec).toBe(legacy.remainingSec);
      expect(state.print.fileName).toBe(legacy.fileName);
      expect(state.motion.position).toEqual(legacy.position);
      expect(state.error.code).toBe(legacy.errorCode);
      expect(state.error.key).toBe(legacy.errorKey);
      expect(state.camera.mjpeg).toBe(legacy.cameraMjpeg);
      expect(state.camera.webrtc).toBe(legacy.cameraWebrtc);
      expect(state.ai.detection).toBe(legacy.aiDetection);
      expect(hasCapability(state.capabilities, PRINTER_CAPABILITIES.STATUS_TEMPERATURES)).toBe(true);
      expect(hasCapability(state.capabilities, PRINTER_CAPABILITIES.STATUS_POSITION)).toBe(true);
      expect(hasCapability(state.capabilities, PRINTER_CAPABILITIES.CAMERA_MJPEG)).toBe(true);
    }
  });

  it("PrinterFacade 経由で Instance sequence と capability を蓄積する", () => {
    const event = readFirstStatusEvent(FIXTURE_DEVICE_A);
    const facade = createPrinterFacade({
      clock: () => new Date("2026-08-07T02:42:13.000Z"),
    });

    const first = facade.observeFrame("fixture:k1-max-a", event, { sessionId: "fixture-session" });
    const second = facade.observeFrame("fixture:k1-max-a", event, { sessionId: "fixture-session" });

    expect(first.source.sequence).toBe(1);
    expect(second.source.sequence).toBe(2);
    expect(second.identity.deviceId).toBe("fixture:k1-max-a");
    expect(second.identity.sessionId).toBe("fixture-session");
    expect(facade.getState("fixture:k1-max-a").source.sequence).toBe(2);
    expect(hasCapability(second.capabilities, PRINTER_CAPABILITIES.STATUS_PRINT_JOB)).toBe(true);
  });
});
