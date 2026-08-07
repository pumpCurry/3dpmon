/**
 * @fileoverview Printer Core v3 K2 read-only adapter の単体テスト
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  PRINTER_CAPABILITIES,
  hasCapability,
} from "../../3dp_lib/printer_core/dashboard_capabilities.js";
import {
  createK2Adapter,
  extractK2BoxsInfo,
  extractK2Payload,
} from "../../3dp_lib/printer_core/dashboard_k2_adapter.js";
import { createK2PrinterFacade } from "../../3dp_lib/printer_core/dashboard_printer_facade.js";
import { normalizeK2BoxsInfo } from "../../3dp_lib/printer_core/dashboard_normalized_state.js";

const FIXTURE_K2_PRO_CFS = path.resolve("tests", "fixtures", "printers", "k2-pro-cfs", "events.ndjson");

function readNdjson(filePath) {
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readK2JsonEvents() {
  return readNdjson(FIXTURE_K2_PRO_CFS).filter((event) => {
    return event.direction === "in" &&
      event.channel === "ws9999" &&
      event.payload?.bodyKind === "json" &&
      event.payload?.body &&
      typeof event.payload.body === "object";
  });
}

function readK2StatusEvent() {
  return readK2JsonEvents().find((event) => !event.payload.body.boxsInfo);
}

function readK2BoxsInfoEvent() {
  return readK2JsonEvents().find((event) => event.payload.body.boxsInfo);
}

describe("Printer Core v3 K2 read-only adapter", () => {
  it("fixture event から K2 status payload と boxsInfo payload を抽出する", () => {
    const statusEvent = readK2StatusEvent();
    const boxsInfoEvent = readK2BoxsInfoEvent();
    const statusPayload = extractK2Payload(statusEvent);
    const boxsInfo = extractK2BoxsInfo(boxsInfoEvent);

    expect(statusPayload.model).toBe("F012");
    expect(statusPayload.cfsConnect).toBe(1);
    expect(boxsInfo.materialBoxs).toHaveLength(2);
    expect(boxsInfo.colorMatch).toHaveLength(4);
  });

  it("K2 status frame を K1 と同じ semantic field へ read-only 正規化する", () => {
    const adapter = createK2Adapter();
    const statusEvent = readK2StatusEvent();
    const patch = adapter.normalizeFrame(statusEvent, {
      deviceId: "fixture:k2-pro-cfs",
      sessionId: "fixture-session-k2",
      sequence: 1,
      receivedAt: "2026-08-07T10:00:00.000Z",
    });

    expect(patch.kind).toBe("state-patch");
    expect(patch.source.adapterId).toBe("creality-k2");
    expect(patch.patch.identity.reportedModel).toBe("F012");
    expect(patch.patch.temperatures.nozzle.current).toBeCloseTo(32.09);
    expect(patch.patch.temperatures.chamber.current).toBe(28);
    expect(patch.patch.fans.case).toEqual({ enabled: false, percent: 0 });
    expect(patch.patch.materials.cfs.connected).toBe(true);
    expect(hasCapability(patch.capabilities, PRINTER_CAPABILITIES.MATERIAL_CFS)).toBe(true);
    expect(hasCapability(patch.capabilities, PRINTER_CAPABILITIES.STATUS_TEMPERATURES)).toBe(true);
  });

  it("K2 boxsInfo を CFS unit / source / tool assignment topology へ正規化する", () => {
    const boxsInfo = extractK2BoxsInfo(readK2BoxsInfoEvent());
    const topology = normalizeK2BoxsInfo(boxsInfo);

    expect(topology.cfs).toEqual({
      connected: true,
      enabled: true,
      unitCount: 1,
    });
    expect(topology.units).toEqual([{
      unitId: "cfs:1",
      boxId: 1,
      stateCode: 1,
      temperature: 29,
      humidity: 50,
      serialNumber: "<SERIAL_002>",
      slotCount: 4,
    }]);
    expect(topology.sources).toHaveLength(5);
    expect(topology.sources[0]).toMatchObject({
      sourceId: "external:0:slot:0",
      kind: "external-spool",
      unitId: null,
      material: {
        vendor: "",
        type: "",
        color: "",
      },
      status: {
        selected: false,
        percent: 100,
      },
    });
    expect(topology.sources[1]).toMatchObject({
      sourceId: "cfs:1:slot:0",
      kind: "cfs-slot",
      unitId: "cfs:1",
      material: {
        vendor: "Generic",
        type: "PLA",
        name: "Generic PLA",
        color: "#0ffffff",
        rfid: "<RFID_001>",
      },
      status: {
        selected: false,
        percent: 100,
      },
    });
    expect(topology.assignments).toEqual([
      { toolId: "T1A", sourceId: "cfs:1:slot:0", boxId: 1, slotId: 0 },
      { toolId: "T1B", sourceId: "cfs:1:slot:1", boxId: 1, slotId: 1 },
      { toolId: "T1C", sourceId: "cfs:1:slot:2", boxId: 1, slotId: 2 },
      { toolId: "T1D", sourceId: "cfs:1:slot:3", boxId: 1, slotId: 3 },
    ]);
    expect(topology.sameMaterialGroups[0]).toMatchObject({
      materialCode: "000001",
      color: "0ffffff",
      materialType: "PLA",
      sourceIds: ["cfs:1:slot:0"],
    });
  });

  it("K2 Pro CFS fixture stream を Facade で replay し status と topology を同居させる", () => {
    const facade = createK2PrinterFacade({
      clock: () => new Date("2026-08-07T10:00:00.000Z"),
    });
    const deviceId = "fixture:k2-pro-cfs";
    const sessionId = "fixture-session-k2";
    const states = [];

    facade.beginSession({ deviceId, sessionId });
    for (const event of readK2JsonEvents()) {
      states.push(facade.observeFrame({ deviceId, sessionId, frame: event }));
    }

    const finalState = states.at(-1);
    expect(finalState.source.sequence).toBe(3);
    expect(finalState.identity.reportedModel).toBe("F012");
    expect(finalState.temperatures.nozzle.current).toBeCloseTo(32.09);
    expect(finalState.materials.cfs.connected).toBe(true);
    expect(finalState.materials.cfs.enabled).toBe(true);
    expect(finalState.materials.sources.map((source) => source.sourceId)).toEqual([
      "external:0:slot:0",
      "cfs:1:slot:0",
      "cfs:1:slot:1",
      "cfs:1:slot:2",
      "cfs:1:slot:3",
    ]);
    expect(hasCapability(finalState.capabilities, PRINTER_CAPABILITIES.MATERIAL_CFS_TOPOLOGY)).toBe(true);
    expect(hasCapability(finalState.capabilities, PRINTER_CAPABILITIES.MATERIAL_MULTI_SOURCE)).toBe(true);
  });
});
