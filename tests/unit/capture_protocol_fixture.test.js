/**
 * @fileoverview capture_protocol_fixture.mjs の単体テスト
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  captureProtocolFixture,
  isHeartbeatPayload,
  normalizeWsPayload,
  parseArgs,
  payloadHasKey,
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
      "--require-http",
      "--require-ws",
      "--require-boxsinfo",
      "--minimum-events",
      "3",
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
    expect(options.requireHttp).toBe(true);
    expect(options.requireWs).toBe(true);
    expect(options.requireBoxsInfo).toBe(true);
    expect(options.minimumEvents).toBe(3);
    expect(options.keepFailed).toBe(true);
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
      required: {
        http: false,
        ws: false,
        boxsInfo: false,
        minimumEvents: 0,
      },
      observations: {
        httpObserved: false,
        wsOpened: false,
        boxsInfoObserved: false,
        heartbeatAcked: false,
        errorCount: 0,
      },
    });

    fs.rmSync(root, { recursive: true, force: true });
  });
});
