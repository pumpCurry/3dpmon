/**
 * @fileoverview capture_protocol_fixture.mjs の単体テスト
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  captureProtocolFixture,
  countMinimumValidationEvents,
  isHeartbeatPayload,
  normalizeWsPayload,
  parseArgs,
  parseInteractiveMarkerLine,
  parseMarkerScheduleItem,
  payloadHasKey,
  recordInteractiveMarkerLine,
  sendReadOnlyBoxsInfoProbe,
} from "../../scripts/capture_protocol_fixture.mjs";

describe("capture_protocol_fixture CLI helpers", () => {
  it("必須引数とskip系オプションを解析する", () => {
    const options = parseArgs([
      "--host",
      "192.168.54.151",
      "--out",
      "tests/fixtures/printers/k1-max/device-a",
      "--model",
      "K1 Max",
      "--scenario",
      "idle",
      "--skip-ws",
      "--skip-http",
      "--send-boxsinfo",
      "--duration-ms",
      "1500",
      "--boxsinfo-interval-ms",
      "30000",
      "--require-http",
      "--require-ws",
      "--require-boxsinfo",
      "--minimum-events",
      "3",
      "--marker-at",
      "250:operator-print-start:{\"phase\":\"start\"}",
      "--interactive-markers",
      "--keep-failed",
    ]);

    expect(options.host).toBe("192.168.54.151");
    expect(options.outDir).toBe("tests/fixtures/printers/k1-max/device-a");
    expect(options.model).toBe("K1 Max");
    expect(options.scenario).toBe("idle");
    expect(options.skipWs).toBe(true);
    expect(options.skipHttp).toBe(true);
    expect(options.sendBoxsInfo).toBe(true);
    expect(options.durationMs).toBe(1500);
    expect(options.boxsInfoProbeIntervalMs).toBe(30000);
    expect(options.requireHttp).toBe(true);
    expect(options.requireWs).toBe(true);
    expect(options.requireBoxsInfo).toBe(true);
    expect(options.minimumEvents).toBe(3);
    expect(options.markerSchedule).toEqual([
      {
        atMs: 250,
        name: "operator-print-start",
        details: { phase: "start" },
      },
    ]);
    expect(options.interactiveMarkers).toBe(true);
    expect(options.keepFailed).toBe(true);
  });

  it("予約markerと標準入力markerの行を解析する", () => {
    expect(parseMarkerScheduleItem("1000:cfs-slot-loaded")).toEqual({
      atMs: 1000,
      name: "cfs-slot-loaded",
      details: { source: "scheduled-cli" },
    });
    expect(parseMarkerScheduleItem("1500:operator print start:{\"phase\":\"start\",\"slot\":2}")).toEqual({
      atMs: 1500,
      name: "operator print start",
      details: { phase: "start", slot: 2 },
    });
    expect(parseInteractiveMarkerLine("")).toBeNull();
    expect(parseInteractiveMarkerLine("print paused")).toEqual({
      name: "print paused",
      details: { source: "stdin" },
    });
    expect(parseInteractiveMarkerLine("print resumed {\"phase\":\"resume\"}")).toEqual({
      name: "print resumed",
      details: { phase: "resume" },
    });
  });

  it("boxsInfo interval probe は5秒未満を拒否する", () => {
    expect(() => parseArgs([
      "--host",
      "192.0.2.21",
      "--out",
      "tmp/capture",
      "--boxsinfo-interval-ms",
      "1000",
    ])).toThrow("--boxsinfo-interval-ms must be 0 or a number >= 5000");

    expect(parseArgs([
      "--host",
      "192.0.2.21",
      "--out",
      "tmp/capture",
      "--boxsinfo-interval-ms",
      "5000",
    ]).boxsInfoProbeIntervalMs).toBe(5000);
  });

  it("text JSON frameをJSONとして保持する", () => {
    const payload = normalizeWsPayload(Buffer.from("{\"nozzleTemp\":\"220\"}"), false);

    expect(payload.frameType).toBe("text");
    expect(payload.bodyKind).toBe("json");
    expect(payload.body.nozzleTemp).toBe("220");
  });

  it("binary frameをbase64として保持する", () => {
    const payload = normalizeWsPayload(Buffer.from([1, 2, 3]), true);

    expect(payload.frameType).toBe("binary");
    expect(payload.encoding).toBe("base64");
    expect(payload.body).toBe("AQID");
  });

  it("heartbeat text frameとboxsInfo payloadを検出できる", () => {
    const heartbeat = normalizeWsPayload(Buffer.from("heart_beat"), false);
    const data = normalizeWsPayload(Buffer.from("{\"result\":{\"boxsInfo\":{\"materialBoxs\":[]}}}"), false);

    expect(isHeartbeatPayload(heartbeat)).toBe(true);
    expect(payloadHasKey(data, "boxsInfo")).toBe(true);
  });

  it("read-only boxsInfo probe は outbound metadata 付きで送信される", () => {
    const outbound = [];
    const sent = [];
    const recorder = {
      recordOutbound(channel, payload, metadata) {
        outbound.push({ channel, payload, metadata });
      },
    };
    const ws = {
      readyState: 1,
      send(payload) {
        sent.push(payload);
      },
    };

    expect(sendReadOnlyBoxsInfoProbe(ws, recorder, { probeIndex: 2, probeMode: "interval" })).toBe(true);
    expect(sent).toEqual([JSON.stringify({ method: "get", params: { boxsInfo: 1 } })]);
    expect(outbound).toEqual([
      {
        channel: "ws9999",
        payload: { method: "get", params: { boxsInfo: 1 } },
        metadata: {
          purpose: "read-only-boxsInfo-probe",
          probeIndex: 2,
          probeMode: "interval",
        },
      },
    ]);
  });

  it("minimum-events判定ではread-only boxsInfo probe requestを数えない", () => {
    const events = [
      {
        direction: "out",
        kind: "frame",
        details: { purpose: "read-only-boxsInfo-probe" },
      },
      {
        direction: "in",
        kind: "frame",
        payload: { result: { boxsInfo: {} } },
      },
      {
        direction: "marker",
        kind: "marker",
        name: "observed-cfs-connected",
      },
      {
        direction: "out",
        kind: "frame",
        details: { purpose: "heartbeat-ack" },
      },
    ];

    expect(countMinimumValidationEvents(events)).toBe(3);
  });

  it("require条件に失敗したcaptureは既存fixtureを上書きしない", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "3dpmon-capture-test-"));
    const outDir = path.join(root, "fixture");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "capture.json"), "{\"existing\":true}\n", "utf8");

    const result = await captureProtocolFixture({
      host: "127.0.0.1",
      outDir,
      durationMs: 100,
      wsPort: 9999,
      httpPort: 80,
      sendBoxsInfo: false,
      skipHttp: true,
      skipWs: true,
      requireHttp: false,
      requireWs: true,
      requireBoxsInfo: false,
      minimumEvents: 0,
      keepFailed: false,
      model: "K1 Max",
      attachment: "none",
      scenario: "unit-failed-capture",
      notes: "",
    });

    expect(result.success).toBe(false);
    expect(result.failureReasons).toEqual(["required-ws-not-opened"]);
    expect(result.writtenOutDir).toBeNull();
    expect(result.failedOutDir).toBeNull();
    expect(fs.readFileSync(path.join(outDir, "capture.json"), "utf8")).toBe("{\"existing\":true}\n");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("成功captureは3ファイルだけを置換しnotes.mdなどの付随ファイルを保持する", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "3dpmon-capture-success-test-"));
    const outDir = path.join(root, "fixture");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "notes.md"), "manual note\n", "utf8");
    fs.writeFileSync(path.join(outDir, "capture.json"), "{\"existing\":true}\n", "utf8");

    const result = await captureProtocolFixture({
      host: "127.0.0.1",
      outDir,
      durationMs: 100,
      wsPort: 9999,
      httpPort: 80,
      sendBoxsInfo: false,
      skipHttp: true,
      skipWs: true,
      requireHttp: false,
      requireWs: false,
      requireBoxsInfo: false,
      minimumEvents: 0,
      keepFailed: false,
      model: "K1 Max",
      attachment: "none",
      scenario: "unit-success-capture",
      notes: "",
    });

    expect(result.success).toBe(true);
    expect(result.writtenOutDir).toBe(outDir);
    expect(fs.readFileSync(path.join(outDir, "notes.md"), "utf8")).toBe("manual note\n");
    const capture = JSON.parse(fs.readFileSync(path.join(outDir, "capture.json"), "utf8"));
    const metadata = JSON.parse(fs.readFileSync(path.join(outDir, "metadata.json"), "utf8"));
    expect(capture.metadata.capture.scenario).toBe("unit-success-capture");
    expect(capture.metadata.validation).toEqual(metadata.validation);
    expect(metadata.validation).toEqual({
      success: true,
      failureReasons: [],
      eventCount: 0,
      countedEventCount: 0,
      protocolEventCount: 0,
      markerCount: 0,
      required: {
        http: false,
        ws: false,
        boxsInfo: false,
        minimumEvents: 0,
        scheduledMarkers: 0,
      },
      observations: {
        httpObserved: false,
        wsOpened: false,
        boxsInfoObserved: false,
        boxsInfoProbeCount: 0,
        heartbeatAcked: false,
        errorCount: 0,
      },
      markers: {
        scheduled: 0,
        observedScheduled: 0,
        markerCount: 0,
        parseErrors: 0,
        missing: [],
      },
    });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("interactive markerのprovenanceを固定しparse errorへ入力断片を保存しない", () => {
    const events = [];
    const tracker = { scheduled: [], parseErrors: 0 };
    const recorder = {
      addMarker(name, details) {
        events.push({ name, details });
      },
    };

    expect(recordInteractiveMarkerLine(recorder, "print resumed {\"source\":\"spoof\",\"phase\":\"resume\"}", tracker))
      .toBe(true);
    expect(recordInteractiveMarkerLine(recorder, "pause {\"hostname\":\"actual-printer-name\"", tracker))
      .toBe(false);

    expect(events).toEqual([
      {
        name: "print resumed",
        details: {
          source: "stdin",
          phase: "resume",
        },
      },
      {
        name: "marker-parse-error",
        details: {
          source: "stdin",
          errorCode: "invalid-marker-json",
        },
      },
    ]);
    expect(tracker.parseErrors).toBe(1);
    expect(JSON.stringify(events)).not.toContain("actual-printer-name");
  });

  it("予約markerをcapture fixtureのeventとして保存する", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "3dpmon-capture-marker-test-"));
    const outDir = path.join(root, "fixture");

    const result = await captureProtocolFixture({
      host: "127.0.0.1",
      outDir,
      durationMs: 100,
      wsPort: 9999,
      httpPort: 80,
      sendBoxsInfo: false,
      skipHttp: true,
      skipWs: true,
      requireHttp: false,
      requireWs: false,
      requireBoxsInfo: false,
      minimumEvents: 1,
      markerSchedule: [
        {
          atMs: 0,
          name: "operator-print-start",
          details: { phase: "start", source: "spoof" },
        },
      ],
      interactiveMarkers: false,
      keepFailed: false,
      model: "K2 Pro Combo",
      attachment: "CFS",
      scenario: "unit-marker-capture",
      notes: "",
    });

    expect(result.success).toBe(true);
    expect(result.eventCount).toBe(1);
    const capture = JSON.parse(fs.readFileSync(path.join(outDir, "capture.json"), "utf8"));
    expect(capture.events).toEqual([
      expect.objectContaining({
        direction: "marker",
        channel: "operator",
        kind: "marker",
        name: "operator-print-start",
        details: {
          phase: "start",
          source: "scheduled-cli",
          scheduledAtMs: 0,
        },
      }),
    ]);
    expect(capture.metadata.validation.eventCount).toBe(1);
    expect(capture.metadata.validation.countedEventCount).toBe(1);
    expect(capture.metadata.validation.protocolEventCount).toBe(0);
    expect(capture.metadata.validation.markerCount).toBe(1);
    expect(capture.metadata.validation.markers).toEqual({
      scheduled: 1,
      observedScheduled: 1,
      markerCount: 1,
      parseErrors: 0,
      missing: [],
    });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("未発火の予約markerがあるcaptureは成功扱いにしない", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "3dpmon-capture-missing-marker-test-"));
    const outDir = path.join(root, "fixture");

    const result = await captureProtocolFixture({
      host: "127.0.0.1",
      outDir,
      durationMs: 100,
      wsPort: 9999,
      httpPort: 80,
      sendBoxsInfo: false,
      skipHttp: true,
      skipWs: true,
      requireHttp: false,
      requireWs: false,
      requireBoxsInfo: false,
      minimumEvents: 0,
      markerSchedule: [
        {
          atMs: 200,
          name: "operator-paused",
          details: { phase: "paused" },
        },
      ],
      interactiveMarkers: false,
      keepFailed: true,
      model: "K2 Pro Combo",
      attachment: "CFS",
      scenario: "unit-missing-marker-capture",
      notes: "",
    });

    expect(result.success).toBe(false);
    expect(result.failureReasons).toEqual(["required-marker-not-observed"]);
    expect(result.writtenOutDir).toBeNull();
    expect(result.failedOutDir).toMatch(/tmp[\\/]failed-captures/);
    expect(result.markers).toEqual({
      scheduled: 1,
      observedScheduled: 0,
      markerCount: 0,
      parseErrors: 0,
      missing: [{ index: 0, atMs: 200 }],
    });
    const failedCapture = JSON.parse(fs.readFileSync(path.join(result.failedOutDir, "capture.json"), "utf8"));
    expect(failedCapture.metadata.validation.markers.missing).toEqual([{ index: 0, atMs: 200 }]);

    fs.rmSync(result.failedOutDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
});
