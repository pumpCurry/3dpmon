/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 プロトコル記録単体テスト
 * @file dashboard_protocol_recorder.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_protocol_recorder_test
 *
 * 【機能内容サマリ】
 * - Protocol Recorder のfixture exportとredaction契約を検証
 * - runtime session IDと公開fixture provenance IDの秘匿境界を固定
 *
 * 【公開関数一覧】
 * - なし：Vitest による単体テストのみを提供
 *
 * @version 1.390.1472 (PR #436)
 * @since   1.390.1290 (PR #432)
 * @lastModified 2026-08-29 21:19:45
 * -----------------------------------------------------------
 * @todo
 * - none
 */
import { describe, it, expect } from "vitest";
import {
  PROTOCOL_FIXTURE_VERSION,
  ProtocolRecorder,
  createProtocolRecorder,
  redactProtocolValue,
  toFixtureNdjson,
} from "../../3dp_lib/printer_core/dashboard_protocol_recorder.js";

describe("ProtocolRecorder", () => {
  it("inbound/outbound/transport/marker を順序付き fixture として出力する", () => {
    let now = 1_786_000_000_000;
    const recorder = createProtocolRecorder({
      clock: () => now,
      idFactory: () => "capture_test",
    });

    recorder.startSession({
      device: {
        model: "K2 Pro Combo",
        firmwareVersion: "1.0.0",
        attachment: "CFS",
      },
      capture: {
        scenario: "startup",
      },
      endpoints: [
        { address: "192.168.54.21", wsPort: 9999 },
      ],
    });

    now += 10;
    recorder.recordTransportEvent({ channel: "ws9999", type: "open" });
    now += 20;
    recorder.recordOutbound("ws9999", { method: "get", params: { boxsInfo: 1 } });
    now += 30;
    recorder.recordInbound("ws9999", {
      boxsInfo: {
        materialBoxs: [
          { id: 2, state: 1, materials: [{ id: 0, state: 1, type: "PLA", color: "#00A050" }] },
        ],
      },
    });
    now += 40;
    recorder.addMarker("baseline-complete", { operator: "codex" });
    now += 50;
    recorder.stopSession();

    const fixture = recorder.exportFixture({ redact: false });
    expect(fixture.fixtureVersion).toBe(PROTOCOL_FIXTURE_VERSION);
    expect(fixture.captureId).toBe("capture_test");
    expect(fixture.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(fixture.events.map((event) => event.atMs)).toEqual([10, 30, 60, 100]);
    expect(fixture.events[2].payload.boxsInfo.materialBoxs[0].materials[0].type).toBe("PLA");
  });

  it("キャプチャ開始後に判明したmetadataを追記できる", () => {
    const recorder = createProtocolRecorder({
      clock: () => 1_786_000_000_000,
      idFactory: () => "capture_metadata",
    });

    recorder.startSession({ device: { model: "K2 Pro Combo" } });
    const metadata = recorder.mergeMetadata({
      device: {
        reportedModel: "F012",
        firmwareVersion: "1.0.0",
      },
    });

    expect(metadata.device.model).toBe("K2 Pro Combo");
    expect(metadata.device.reportedModel).toBe("F012");
    expect(metadata.device.firmwareVersion).toBe("1.0.0");
  });

  it("IP/MAC/serial/credential/SSID を決定的 token へ redaction する", () => {
    const recorder = new ProtocolRecorder({
      clock: () => 1_786_000_000_000,
      idFactory: () => "capture_secret",
    });

    recorder.startSession({
      device: {
        model: "K1 Max",
        firmwareVersion: "2.2.1039",
      },
      endpoints: [
        { address: "192.168.54.151", macAddress: "AA:BB:CC:DD:EE:FF" },
      ],
    });
    recorder.recordInbound("ws9999", {
      ip: "192.168.54.151",
      url: "http://192.168.54.151/upload/demo.gcode",
      macAddress: "AA:BB:CC:DD:EE:FF",
      mac: "FCEE280E69E7",
      serialNumber: "SERIAL-12345",
      password: "printer-pass",
      ssid: "factory-lab",
      hostname: "K2Pro-69E7",
      printId: 123456789,
      sessionId: "session-runtime-001",
      probeSessionId: "probe-runtime-001",
      rfid: "RFID-RAW-001",
      fileName: "customer-part.gcode",
      console: "seen 58:41:46:CF:FA:99 at fe80::5841:46ff:fecf:fa99 printing nested-demo.gcode",
      captureLikeId: "capture_afff4598-cb09-4a50-bbd1-242e4574e818",
      nozzleMoveSnapshot: 0,
      emptyRfid: "",
      emptyPrintId: "",
      reportedHostname: null,
    });

    const fixture = recorder.exportFixture();
    const text = JSON.stringify(fixture);
    expect(text).not.toContain("192.168.54.151");
    expect(text).not.toContain("fe80::5841:46ff:fecf:fa99");
    expect(text).not.toContain("AA:BB:CC:DD:EE:FF");
    expect(text).not.toContain("58:41:46:CF:FA:99");
    expect(text).not.toContain("FCEE280E69E7");
    expect(text).not.toContain("SERIAL-12345");
    expect(text).not.toContain("printer-pass");
    expect(text).not.toContain("factory-lab");
    expect(text).not.toContain("K2Pro-69E7");
    expect(text).not.toContain("123456789");
    expect(text).not.toContain("session-runtime-001");
    expect(text).not.toContain("probe-runtime-001");
    expect(text).not.toContain("RFID-RAW-001");
    expect(text).not.toContain("customer-part.gcode");
    expect(text).not.toContain("nested-demo.gcode");
    expect(text).toContain("capture_afff4598-cb09-4a50-bbd1-242e4574e818");
    expect(text).toContain("<IP_001>");
    expect(text).toContain("<MAC_001>");
    expect(text).toContain("<SERIAL_001>");
    expect(text).toContain("<CREDENTIAL_001>");
    expect(text).toContain("<SSID_001>");
    expect(text).toContain("<HOSTNAME_001>");
    expect(text).toContain("<ID_001>");
    expect(text).toContain("<ID_002>");
    expect(text).toContain("<ID_003>");
    expect(text).toContain("<RFID_001>");
    expect(text).toContain("<FILE_001>.gcode");
    expect(fixture.events[0].payload.url).toBe("http://<IP_001>/upload/<FILE_001>.gcode");
    expect(fixture.events[0].payload.fileName).toBe("<FILE_002>.gcode");
    expect(fixture.events[0].payload.nozzleMoveSnapshot).toBe(0);
    expect(fixture.events[0].payload.emptyRfid).toBe("");
    expect(fixture.events[0].payload.emptyPrintId).toBe("");
    expect(fixture.events[0].payload.reportedHostname).toBeNull();
    expect(fixture.metadata.redaction.mac).toBe(true);
  });

  it("standalone redaction でも同じ値を同じ token にする", () => {
    const redacted = redactProtocolValue({
      first: "192.168.54.151",
      second: "ws://192.168.54.151:9999",
      other: "192.168.54.152",
    });

    expect(redacted.first).toBe("<IP_001>");
    expect(redacted.second).toBe("ws://<IP_001>:9999");
    expect(redacted.other).toBe("<IP_002>");
  });

  it("NDJSON は1行1イベントで末尾改行を付ける", () => {
    const ndjson = toFixtureNdjson([
      { sequence: 1, direction: "in" },
      { sequence: 2, direction: "out" },
    ]);

    expect(ndjson).toBe("{\"sequence\":1,\"direction\":\"in\"}\n{\"sequence\":2,\"direction\":\"out\"}\n");
  });
});
