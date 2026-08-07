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

describe("Printer Core v3 protocol scenario analyzer", () => {
  it("payload key はrootとresult wrapperの両方から検出する", () => {
    expect(eventHasPayloadKey(ws(1, 0, { boxsInfo: { materialBoxs: [] } }), "boxsInfo")).toBe(true);
    expect(eventHasPayloadKey(ws(2, 0, { result: { boxsInfo: { materialBoxs: [] } } }), "boxsInfo")).toBe(true);
    expect(eventHasPayloadKey(marker(3, 0, "operator-print-start"), "boxsInfo")).toBe(false);
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
