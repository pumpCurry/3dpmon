/**
 * @fileoverview Printer Core v3 protocol scenario analyzer の単体テスト
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  analyzeProtocolScenarioFixture,
  eventHasPayloadKey,
  getProtocolScenarioProfile,
  listProtocolScenarioProfiles,
} from "../../3dp_lib/printer_core/dashboard_protocol_scenario_analyzer.js";
import {
  analyzeProtocolScenarioFromCli,
  parseArgs,
  readScenarioFixture,
} from "../../scripts/analyze_protocol_scenario.mjs";

function marker(sequence, atMs, name, details = {}) {
  return {
    sequence,
    atMs,
    direction: "marker",
    channel: "operator",
    kind: "marker",
    name,
    details,
  };
}

function ws(sequence, atMs, body) {
  return {
    sequence,
    atMs,
    direction: "in",
    channel: "ws9999",
    kind: "frame",
    payload: {
      frameType: "text",
      bodyKind: "json",
      body,
    },
    details: {},
  };
}

function k2PrintLifecycleEvents() {
  return [
    marker(1, 0, "observed-idle-before-start", { source: "stdin" }),
    marker(2, 1000, "operator-print-start", { source: "stdin" }),
    ws(3, 1500, {
      state: 1,
      deviceState: 1,
      printProgress: 1,
      printFileName: "profile-test.gcode",
      printId: "print-1",
      nozzleTemp: "25.0",
      targetNozzleTemp: 220,
      bedTemp0: "30.0",
      targetBedTemp0: 60,
      cfsConnect: 1,
    }),
    marker(4, 2000, "observed-heating", { source: "stdin" }),
    marker(5, 3000, "observed-printing", { source: "stdin" }),
    ws(6, 4000, { boxsInfo: { materialBoxs: [] } }),
    marker(7, 5000, "operator-pause-requested", { source: "stdin" }),
    marker(8, 6000, "observed-paused", { source: "stdin" }),
    marker(9, 7000, "operator-resume-requested", { source: "stdin" }),
    marker(10, 8000, "observed-resumed", { source: "stdin" }),
    marker(11, 9000, "observed-completed", { source: "stdin" }),
    marker(12, 10000, "observed-idle-after-completed", { source: "stdin" }),
  ];
}

function k2CfsTopologyEvents() {
  const freshBoxsInfo = {
    enable: 1,
    materialBoxs: [
      {
        id: 0,
        type: 1,
        state: 1,
        boxTemp: 31,
        humidity: 42,
        materials: [
          {
            id: 0,
            vendor: "",
            type: "",
            name: "",
            rfid: "",
            color: "",
            minTemp: 0,
            maxTemp: 0,
            pressure: 0,
            percent: 100,
            state: 1,
            selected: false,
            editStatus: 0,
            scrap: 0,
          },
          {
            id: 1,
            vendor: "",
            type: "",
            name: "",
            rfid: "",
            color: "",
            minTemp: 0,
            maxTemp: 0,
            pressure: 0,
            percent: 0,
            state: 0,
            selected: false,
            editStatus: 0,
            scrap: 0,
          },
        ],
      },
      {
        id: 1,
        type: 0,
        state: 1,
        materials: [
          {
            id: 0,
            vendor: "Creality",
            type: "PLA",
            name: "Hyper PLA",
            rfid: "rfid-white",
            color: "white",
            minTemp: 190,
            maxTemp: 230,
            pressure: 0.95,
            percent: 100,
            state: 1,
            selected: true,
            editStatus: 0,
            scrap: 0,
          },
          {
            id: 1,
            vendor: "Creality",
            type: "PLA",
            name: "Hyper PLA",
            rfid: "rfid-black",
            color: "black",
            minTemp: 190,
            maxTemp: 230,
            pressure: 0.96,
            percent: 95,
            state: 1,
            selected: false,
            editStatus: 0,
            scrap: 0,
          },
        ],
      },
    ],
    colorMatch: [{ id: "T1A", boxId: 1, materialId: 0 }],
    same_material: [
      ["000001", "white", [{ boxId: 1, materialId: 0 }], "PLA"],
      ["000002", "black", [{ boxId: 1, materialId: 1 }], "PLA"],
    ],
  };
  const changedBoxsInfo = {
    ...freshBoxsInfo,
    materialBoxs: [
      freshBoxsInfo.materialBoxs[0],
      {
        id: 1,
        type: 0,
        state: 1,
        materials: [
          {
            id: 0,
            vendor: "Creality",
            type: "PETG",
            name: "Hyper PETG",
            rfid: "rfid-red",
            color: "red",
            minTemp: 220,
            maxTemp: 250,
            pressure: 1.05,
            percent: 80,
            state: 1,
            selected: false,
            editStatus: 1,
            scrap: 0,
          },
          {
            id: 1,
            vendor: "Creality",
            type: "PLA",
            name: "Hyper PLA",
            rfid: "rfid-black",
            color: "black",
            minTemp: 190,
            maxTemp: 230,
            pressure: 0.96,
            percent: 95,
            state: 1,
            selected: true,
            editStatus: 0,
            scrap: 0,
          },
        ],
      },
    ],
    colorMatch: [{ id: "T1A", boxId: 1, materialId: 1 }],
    same_material: [
      ["000003", "red", [{ boxId: 1, materialId: 0 }], "PETG"],
      ["000002", "black", [{ boxId: 1, materialId: 1 }], "PLA"],
    ],
  };

  return [
    marker(1, 0, "observed-cfs-connected", { source: "stdin" }),
    ws(2, 100, { cfsConnect: 1, boxsInfo: freshBoxsInfo }),
    marker(3, 1000, "operator-cfs-disconnect", { source: "stdin" }),
    ws(4, 1200, { cfsConnect: 0 }),
    marker(5, 1500, "observed-cfs-disconnected", { source: "stdin" }),
    marker(6, 2000, "operator-cfs-reconnect", { source: "stdin" }),
    ws(7, 2300, { cfsConnect: 1, boxsInfo: freshBoxsInfo }),
    marker(8, 2600, "observed-cfs-reconnected", { source: "stdin" }),
    ws(9, 3000, { boxsInfo: changedBoxsInfo }),
    marker(10, 3200, "observed-slot-change", { source: "stdin" }),
    marker(11, 3300, "observed-material-change", { source: "stdin" }),
    marker(12, 3400, "observed-external-spool", { source: "stdin" }),
    marker(13, 3500, "observed-color-assignment-change", { source: "stdin" }),
  ];
}

describe("Printer Core v3 protocol scenario analyzer", () => {
  it("K2 print lifecycle profileを列挙・取得できる", () => {
    const profile = getProtocolScenarioProfile("k2-print-lifecycle");

    expect(listProtocolScenarioProfiles()).toContain("k2-print-lifecycle");
    expect(profile).toMatchObject({
      name: "k2-print-lifecycle",
      expectedScenario: "k2-print-lifecycle",
      requireValidationSuccess: true,
    });
    expect(profile.requiredMarkers).toContainEqual({
      name: "observed-paused",
      source: "stdin",
    });
    expect(profile.requiredMarkers).toContainEqual({
      name: "operator-print-start",
      source: "stdin",
    });
    expect(profile.requiredPayloadKeys).toContain("deviceState");
    expect(profile.timelinePayloadKeys).toEqual([
      "state",
      "deviceState",
      "printProgress",
      "printFileName",
      "printId",
    ]);
    expect(getProtocolScenarioProfile("missing-profile")).toBeNull();
  });

  it("K2 CFS topology profileを列挙・取得できる", () => {
    const profile = getProtocolScenarioProfile("k2-cfs-topology");

    expect(listProtocolScenarioProfiles()).toContain("k2-cfs-topology");
    expect(profile).toMatchObject({
      name: "k2-cfs-topology",
      expectedScenario: "k2-cfs-topology-validation",
      requireValidationSuccess: true,
      requiredPayloadKeys: ["cfsConnect", "boxsInfo"],
      timelinePayloadKeys: ["cfsConnect", "boxsInfo"],
    });
    expect(profile.requiredMarkers).toContainEqual({
      name: "observed-cfs-disconnected",
      source: "stdin",
    });
  });

  it("payload key はrootと既知wrapperだけから検出する", () => {
    expect(eventHasPayloadKey(ws(1, 0, { boxsInfo: { materialBoxs: [] } }), "boxsInfo")).toBe(true);
    expect(eventHasPayloadKey(ws(2, 0, { result: { boxsInfo: { materialBoxs: [] } } }), "boxsInfo")).toBe(true);
    expect(eventHasPayloadKey(ws(3, 0, { data: { printProgress: 1 } }), "printProgress")).toBe(true);
    expect(eventHasPayloadKey(ws(4, 0, { boxsInfo: { materialBoxs: [{ state: 1 }] } }), "state")).toBe(false);
    expect(eventHasPayloadKey(marker(5, 0, "operator-print-start"), "boxsInfo")).toBe(false);
  });

  it("必須markerとpayload keyがそろうscenarioをPASSにする", () => {
    const report = analyzeProtocolScenarioFixture({
      metadata: {
        capture: { scenario: "printing" },
        validation: { success: true, failureReasons: [] },
      },
      events: [
        marker(1, 0, "operator-print-start", { source: "stdin" }),
        ws(2, 50, { printProgress: 1, state: 1 }),
        marker(3, 5000, "operator-paused", { source: "stdin" }),
      ],
    }, {
      expectedScenario: "printing",
      requireValidationSuccess: true,
      requiredMarkers: ["operator-print-start", "operator-paused"],
      requiredPayloadKeys: ["printProgress", "state"],
    });

    expect(report.success).toBe(true);
    expect(report.failureReasons).toEqual([]);
    expect(report.markerCount).toBe(2);
    expect(report.protocolEventCount).toBe(1);
    expect(report.requiredMarkers.ordered).toBe(true);
    expect(report.requiredPayloadKeys.missing).toEqual([]);
  });

  it("payload timelineはdelta frameを前回状態へ畳み込んで変化だけを保持する", () => {
    const report = analyzeProtocolScenarioFixture({
      metadata: {
        capture: { scenario: "timeline" },
        validation: { success: true, failureReasons: [] },
      },
      events: [
        ws(1, 0, { state: 1, deviceState: 1, printProgress: 0 }),
        ws(2, 100, { printProgress: 0 }),
        ws(3, 200, { printProgress: 10 }),
        marker(4, 250, "observed-printing", { source: "stdin" }),
        ws(5, 300, { data: { deviceState: 2 } }),
      ],
    }, {
      timelinePayloadKeys: ["state", "deviceState", "printProgress"],
    });

    expect(report.payloadTimeline.keys).toEqual(["state", "deviceState", "printProgress"]);
    expect(report.payloadTimeline.entries).toEqual([
      {
        sequence: 1,
        atMs: 0,
        changedKeys: ["state", "deviceState", "printProgress"],
        state: { state: 1, deviceState: 1, printProgress: 0 },
      },
      {
        sequence: 3,
        atMs: 200,
        changedKeys: ["printProgress"],
        state: { state: 1, deviceState: 1, printProgress: 10 },
      },
      {
        sequence: 5,
        atMs: 300,
        changedKeys: ["deviceState"],
        state: { state: 1, deviceState: 2, printProgress: 10 },
      },
    ]);
  });

  it("metadata.validation countが実eventsと一致する場合はcount検査もPASSにする", () => {
    const report = analyzeProtocolScenarioFixture({
      metadata: {
        capture: { scenario: "count-match" },
        validation: {
          success: true,
          failureReasons: [],
          eventCount: 2,
          protocolEventCount: 1,
          markerCount: 1,
        },
      },
      events: [
        marker(1, 0, "observed", { source: "stdin" }),
        ws(2, 50, { state: 1 }),
      ],
    });

    expect(report.success).toBe(true);
    expect(report.validation.counts).toEqual({
      checked: [
        { key: "eventCount", expected: 2, actual: 2, matches: true },
        { key: "protocolEventCount", expected: 1, actual: 1, matches: true },
        { key: "markerCount", expected: 1, actual: 1, matches: true },
      ],
      mismatches: [],
      success: true,
    });
  });

  it("metadata.validation countが実eventsとずれた場合はfailure reasonへ分離する", () => {
    const report = analyzeProtocolScenarioFixture({
      metadata: {
        capture: { scenario: "count-mismatch" },
        validation: {
          success: true,
          failureReasons: [],
          eventCount: 3,
          protocolEventCount: 2,
          markerCount: 1,
        },
      },
      events: [
        marker(1, 0, "observed", { source: "stdin" }),
        ws(2, 50, { state: 1 }),
      ],
    });

    expect(report.success).toBe(false);
    expect(report.failureReasons).toEqual(["fixture-event-count-mismatch"]);
    expect(report.validation.counts.mismatches).toEqual([
      { key: "eventCount", expected: 3, actual: 2 },
      { key: "protocolEventCount", expected: 2, actual: 1 },
    ]);
  });

  it("marker不足、順序逆転、payload不足、validation失敗をfailureReasonsへ分離する", () => {
    const report = analyzeProtocolScenarioFixture({
      metadata: {
        capture: { scenario: "paused" },
        validation: { success: false, failureReasons: ["required-marker-not-observed"] },
      },
      events: [
        marker(1, 0, "operator-resumed", { source: "stdin" }),
        ws(2, 50, { state: 2 }),
        marker(3, 100, "operator-paused", { source: "stdin" }),
      ],
    }, {
      expectedScenario: "printing",
      requireValidationSuccess: true,
      requiredMarkers: ["operator-paused", "operator-resumed", "operator-completed"],
      requiredPayloadKeys: ["printProgress"],
    });

    expect(report.success).toBe(false);
    expect(report.failureReasons).toEqual([
      "scenario-name-mismatch",
      "fixture-validation-failed",
      "required-marker-missing",
      "required-marker-order-invalid",
      "required-payload-key-missing",
    ]);
    expect(report.requiredMarkers.missing).toEqual(["operator-completed"]);
    expect(report.requiredPayloadKeys.missing).toEqual(["printProgress"]);
  });

  it("observed marker要求はscheduled markerだけでは満たさない", () => {
    const report = analyzeProtocolScenarioFixture({
      metadata: {
        capture: { scenario: "paused" },
        validation: { success: true, failureReasons: [] },
      },
      events: [
        marker(1, 0, "operator-pause-requested", { source: "scheduled-cli", scheduledAtMs: 0 }),
        marker(2, 1000, "observed-paused", { source: "scheduled-cli", scheduledAtMs: 1000 }),
        marker(3, 2000, "observed-resumed", { source: "stdin" }),
      ],
    }, {
      requiredMarkers: [
        "operator-pause-requested",
        { name: "observed-paused", source: "stdin" },
        { name: "observed-resumed", source: "stdin" },
      ],
    });

    expect(report.success).toBe(false);
    expect(report.failureReasons).toEqual(["required-marker-missing"]);
    expect(report.requiredMarkers.missing).toEqual(["stdin:observed-paused"]);
    expect(report.requiredMarkers.matched[0]).toMatchObject({
      name: "operator-pause-requested",
      source: null,
      observed: true,
      observedSource: "scheduled-cli",
    });
    expect(report.requiredMarkers.matched[1]).toMatchObject({
      name: "observed-paused",
      source: "stdin",
      observed: false,
    });
  });

  it("CLI optionsはobserved/scheduled marker requirementへ展開する", () => {
    const options = parseArgs([
      "--fixture",
      "fixture",
      "--require-marker",
      "operator-pause-requested",
      "--require-observed-marker",
      "observed-paused",
      "--require-scheduled-marker",
      "operator-pause-requested",
      "--timeline-payload-key",
      "state",
    ]);

    expect(options.requiredMarkers).toEqual(["operator-pause-requested"]);
    expect(options.requiredObservedMarkers).toEqual(["observed-paused"]);
    expect(options.requiredScheduledMarkers).toEqual(["operator-pause-requested"]);
    expect(options.timelinePayloadKeys).toEqual(["state"]);
  });

  it("CLIのscheduled marker requirementはcapture CLIのscheduled-cli sourceと一致する", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "3dpmon-scheduled-marker-"));
    fs.writeFileSync(path.join(root, "metadata.json"), JSON.stringify({
      fixtureVersion: 1,
      capture: { scenario: "scheduled-marker" },
      validation: { success: true, failureReasons: [] },
    }), "utf8");
    fs.writeFileSync(path.join(root, "events.ndjson"), [
      JSON.stringify(marker(1, 0, "operator-pause-requested", { source: "scheduled-cli", scheduledAtMs: 0 })),
      "",
    ].join("\n"), "utf8");
    const options = parseArgs([
      "--fixture",
      root,
      "--require-scheduled-marker",
      "operator-pause-requested",
    ]);
    const report = await analyzeProtocolScenarioFromCli(options);

    expect(report.success).toBe(true);
    expect(report.requiredMarkers.matched[0]).toMatchObject({
      name: "operator-pause-requested",
      source: "scheduled-cli",
      observed: true,
      observedSource: "scheduled-cli",
    });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("K2 print lifecycle profileはmarker/sourceとroot payload evidenceをまとめて要求する", () => {
    const report = analyzeProtocolScenarioFixture({
      metadata: {
        capture: { scenario: "k2-print-lifecycle" },
        validation: { success: true, failureReasons: [] },
      },
      events: k2PrintLifecycleEvents(),
    }, {
      profiles: ["k2-print-lifecycle"],
    });

    expect(report.success).toBe(true);
    expect(report.profiles.applied).toEqual(["k2-print-lifecycle"]);
    expect(report.requiredMarkers.missing).toEqual([]);
    expect(report.requiredPayloadKeys.missing).toEqual([]);
    expect(report.requiredMarkers.required).toContainEqual({
      name: "observed-paused",
      source: "stdin",
      label: "stdin:observed-paused",
    });
    expect(report.payloadTimeline.entries.length).toBeGreaterThan(0);
    expect(report.payloadTimeline.entries[0]).toMatchObject({
      sequence: 3,
      state: {
        state: 1,
        deviceState: 1,
        printProgress: 1,
        printFileName: "profile-test.gcode",
        printId: "print-1",
      },
    });
  });

  it("K2 CFS topology profileはCFS物理変化markerとboxsInfo timelineを要求する", () => {
    const report = analyzeProtocolScenarioFixture({
      metadata: {
        capture: { scenario: "k2-cfs-topology-validation" },
        validation: { success: true, failureReasons: [] },
      },
      events: k2CfsTopologyEvents(),
    }, {
      profiles: ["k2-cfs-topology"],
    });

    expect(report.success).toBe(true);
    expect(report.profiles.applied).toEqual(["k2-cfs-topology"]);
    expect(report.requiredMarkers.missing).toEqual([]);
    expect(report.requiredPayloadKeys.missing).toEqual([]);
    expect(report.payloadTimeline.entries.map((entry) => entry.sequence)).toEqual([2, 4, 7, 9]);
    expect(report.payloadTimeline.entries[0].state.boxsInfo).toMatchObject({
      boxCount: 2,
      materialSourceCount: 4,
      externalSourceEndpointCount: 1,
      cfsSourceCount: 2,
      sameMaterialGroupCount: 2,
      colorMatchCount: 1,
    });
    expect(report.payloadTimeline.entries[0].state.boxsInfo.boxes[0]).toMatchObject({
      boxId: 0,
      boxType: 1,
      boxState: 1,
      boxTemp: 31,
      humidity: 42,
      observedSlotCount: 2,
    });
    expect(report.payloadTimeline.entries[0].state.boxsInfo.sameMaterialGroups[0]).toMatchObject({
      materialCode: "000001",
      color: "white",
      materialType: "PLA",
      refs: [{ boxId: 1, materialId: 0 }],
    });
    const changedPetgSource = report.payloadTimeline.entries.at(-1).state.boxsInfo.materialSources
      .find((source) => source.boxId === 1 && source.materialId === 0);
    expect(changedPetgSource).toMatchObject({
      boxId: 1,
      boxState: 1,
      materialId: 0,
      state: 1,
      selected: false,
      percent: 80,
      vendor: "Creality",
      name: "Hyper PETG",
      materialType: "PETG",
      color: "red",
      rfid: "rfid-red",
    });
    expect(report.payloadTimeline.entries[0].state.boxsInfo.colorMatch).toEqual([
      { id: "T1A", boxId: 1, materialId: 0 },
    ]);
    expect(report.payloadTimeline.entries.at(-1).state.boxsInfo.colorMatch).toEqual([
      { id: "T1A", boxId: 1, materialId: 1 },
    ]);
  });

  it("未知profileはfailureReasonsへ分離する", () => {
    const report = analyzeProtocolScenarioFixture({
      metadata: {
        capture: { scenario: "anything" },
        validation: { success: true, failureReasons: [] },
      },
      events: [],
    }, {
      profiles: ["missing-profile"],
    });

    expect(report.success).toBe(false);
    expect(report.failureReasons).toEqual(["unknown-scenario-profile"]);
    expect(report.profiles.unknown).toEqual(["missing-profile"]);
  });

  it("CLI --profile はK2 print lifecycle profileをAnalyzerへ適用する", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "3dpmon-k2-profile-"));
    fs.writeFileSync(path.join(root, "metadata.json"), JSON.stringify({
      fixtureVersion: 1,
      capture: { scenario: "k2-print-lifecycle" },
      validation: { success: true, failureReasons: [] },
    }), "utf8");
    fs.writeFileSync(path.join(root, "events.ndjson"), [
      ...k2PrintLifecycleEvents().map((event) => JSON.stringify(event)),
      "",
    ].join("\n"), "utf8");
    const options = parseArgs([
      "--fixture",
      root,
      "--profile",
      "k2-print-lifecycle",
    ]);
    const report = await analyzeProtocolScenarioFromCli(options);

    expect(options.profiles).toEqual(["k2-print-lifecycle"]);
    expect(report.success).toBe(true);
    expect(report.profiles.applied).toEqual(["k2-print-lifecycle"]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("CLI optionsで既存K2 idle fixtureをread-only検査できる", async () => {
    const options = parseArgs([
      "--fixture",
      path.resolve("tests", "fixtures", "printers", "k2-pro-cfs"),
      "--expected-scenario",
      "gate6-live-idle-validation",
      "--require-validation-success",
      "--require-payload-key",
      "boxsInfo",
    ]);
    const fixture = await readScenarioFixture(options.fixtureDir);
    const report = await analyzeProtocolScenarioFromCli(options);

    expect(fixture.events.length).toBeGreaterThan(0);
    expect(report.success).toBe(true);
    expect(report.scenario).toBe("gate6-live-idle-validation");
    expect(report.requiredPayloadKeys.matched[0]).toMatchObject({
      key: "boxsInfo",
      observed: true,
    });
  });

  it("fixture directoryからmetadata.jsonとevents.ndjsonを読み込む", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "3dpmon-scenario-analyzer-"));
    fs.writeFileSync(path.join(root, "metadata.json"), JSON.stringify({
      fixtureVersion: 1,
      capture: { scenario: "unit-scenario" },
      validation: { success: true, failureReasons: [] },
    }), "utf8");
    fs.writeFileSync(path.join(root, "events.ndjson"), [
      JSON.stringify(marker(1, 0, "operator-print-start", { source: "stdin" })),
      JSON.stringify(ws(2, 50, { printProgress: 1 })),
      "",
    ].join("\n"), "utf8");

    const fixture = await readScenarioFixture(root);

    expect(fixture.metadata.capture.scenario).toBe("unit-scenario");
    expect(fixture.events).toHaveLength(2);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
