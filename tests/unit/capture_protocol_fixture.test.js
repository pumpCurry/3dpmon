/**
 * @fileoverview capture_protocol_fixture.mjs の単体テスト
 */
import { describe, it, expect } from "vitest";
import { parseArgs, normalizeWsPayload } from "../../scripts/capture_protocol_fixture.mjs";

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
    ]);

    expect(options.host).toBe("192.168.54.151");
    expect(options.outDir).toBe("tests/fixtures/printers/k1-max/device-a");
    expect(options.model).toBe("K1 Max");
    expect(options.scenario).toBe("idle");
    expect(options.skipWs).toBe(true);
    expect(options.skipHttp).toBe(true);
    expect(options.sendBoxsInfo).toBe(true);
    expect(options.durationMs).toBe(1500);
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
});

