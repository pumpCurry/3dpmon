/**
 * @fileoverview K2 CFS read-only calibration CLI の単体テスト
 * @description
 * - K2/F012 live certification前に、/info、printer status、boxsInfoを副作用なしで観測することを検証する。
 * - read-only calibrationがCFS操作frameを送らず、複数probe結果をJSONへ保持することを検証する。
 *
 * @version 1.390.1547 (PR #439)
 * @since 1.390.1545 (PR #439)
 * @lastModified 2026-08-31 19:39:05
 */

import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseArgs,
  runK2CfsReadOnlyCalibration,
} from "../../scripts/capture_k2_cfs_readonly_calibration.mjs";

const PRINTER_STATUS_GET_FRAME = {
  method: "get",
  params: {
    state: 1,
    deviceState: 1,
    printProgress: 1,
    printJobTime: 1,
    printLeftTime: 1,
    printFileName: 1,
    fileName: 1,
    printId: 1,
    targetNozzleTemp: 1,
    targetBedTemp0: 1,
  },
};

/**
 * printer status guardが送るread-only GET frameかを判定する。
 *
 * @function isPrinterStatusProbeFrame
 * @param {object} frame - JSON parse済みWebSocket frame
 * @returns {boolean} printer status probe frameならtrue
 */
function isPrinterStatusProbeFrame(frame) {
  return frame?.method === "get" &&
    frame?.params?.state === 1 &&
    frame?.params?.deviceState === 1 &&
    frame?.params?.boxsInfo !== 1;
}

describe("capture_k2_cfs_readonly_calibration", () => {
  it("CLI引数をread-only calibration用に解析する", () => {
    expect(() => parseArgs([])).toThrow("--host is required");
    expect(parseArgs([
      "--host",
      "192.168.54.153",
      "--status-probe-count",
      "3",
      "--status-probe-interval-ms",
      "250",
      "--boxsinfo-probe-count",
      "2",
      "--boxsinfo-probe-interval-ms",
      "500",
      "--require-info-model",
      "F012",
      "--pretty",
    ])).toMatchObject({
      host: "192.168.54.153",
      wsPort: 9999,
      statusProbeCount: 3,
      statusProbeIntervalMs: 250,
      boxsInfoProbeCount: 2,
      boxsInfoProbeIntervalMs: 500,
      requireInfoModel: "F012",
      pretty: true,
    });
  });

  it("printer statusとboxsInfoを複数回観測し、set frameを送らない", async () => {
    class CalibrationWs extends EventEmitter {
      constructor() {
        super();
        this.sentFrames = [];
        this.closed = false;
      }

      send(payload, callback) {
        const frame = JSON.parse(payload);
        this.sentFrames.push(frame);
        if (isPrinterStatusProbeFrame(frame)) {
          setTimeout(() => {
            this.emit("message", JSON.stringify({
              state: 2,
              deviceState: 0,
              printProgress: 100,
              printJobTime: 613,
              printLeftTime: 0,
              targetNozzleTemp: 0,
              targetBedTemp0: 0,
              printFileName: "/mnt/UDISK/printer_data/gcodes/bracket.gcode",
              printId: "job-1",
            }));
          }, 1);
        } else if (frame?.params?.boxsInfo === 1) {
          setTimeout(() => {
            this.emit("message", JSON.stringify({
              result: {
                boxsInfo: {
                  materialBoxs: [
                    { id: 0, type: 1, state: 0, materials: [{ id: 0, state: 0, selected: 0, percent: 100 }] },
                    { id: 1, type: 0, state: 1, materials: [{ id: 0, state: 1, selected: 0, percent: 100, type: "PLA" }] },
                  ],
                  colorMatch: [{ id: "T1A", boxId: 1, materialId: 0 }],
                },
              },
            }));
          }, 1);
        }
        setTimeout(() => callback(), 1);
      }

      close() {
        this.closed = true;
      }
    }
    const ws = new CalibrationWs();

    const result = await runK2CfsReadOnlyCalibration({
      ...parseArgs([
        "--host",
        "192.168.54.153",
        "--status-probe-count",
        "2",
        "--status-probe-interval-ms",
        "0",
        "--boxsinfo-probe-count",
        "2",
        "--boxsinfo-probe-interval-ms",
        "0",
        "--require-info-model",
        "F012",
      ]),
      fetchInfo: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ model: "F012", version: "1.0.0", wssPort: 443 }),
      }),
      openWs: async () => ws,
    });

    expect(result).toMatchObject({
      ok: true,
      sent: false,
      status: "observed",
      reason: "read-only-calibration-observed",
      blindRetryAllowed: false,
      printerInfo: {
        status: "observed",
        modelMatched: true,
      },
      statusProbeCount: 2,
      boxsInfoProbeCount: 2,
    });
    expect(result.printerStatusSeries).toHaveLength(2);
    expect(result.printerStatusSeries[0]).toMatchObject({
      status: "observed",
      summary: {
        idle: false,
        active: true,
        state: 2,
        printJobTime: 613,
      },
    });
    expect(result.boxsInfoSeries).toHaveLength(2);
    expect(result.boxsInfoSeries[0].summary).toMatchObject({
      cfsUnitCount: 1,
      externalEndpointCount: 1,
      selectedSourceIds: [],
      colorMatches: [{ assignmentId: "T1A", sourceId: "cfs:1:slot:0", boxId: 1, materialId: 0 }],
    });
    expect(ws.sentFrames).toEqual([
      PRINTER_STATUS_GET_FRAME,
      PRINTER_STATUS_GET_FRAME,
      { method: "get", params: { boxsInfo: 1 } },
      { method: "get", params: { boxsInfo: 1 } },
    ]);
    expect(ws.sentFrames.filter((frame) => frame?.method === "set")).toHaveLength(0);
    expect(ws.closed).toBe(true);
    expect(result.wsTimeline.map((entry) => entry.direction)).toEqual([
      "out",
      "in",
      "out",
      "in",
      "out",
      "in",
      "out",
      "in",
    ]);
    expect(result.wsTimeline.filter((entry) => entry.method === "set")).toHaveLength(0);
  });

  it("一部probeがtimeoutした場合は観測証跡を保持しつつpartialとして返す", async () => {
    class PartiallyTimingOutWs extends EventEmitter {
      constructor() {
        super();
        this.sentFrames = [];
        this.statusProbeCount = 0;
      }

      send(payload, callback) {
        const frame = JSON.parse(payload);
        this.sentFrames.push(frame);
        if (isPrinterStatusProbeFrame(frame)) {
          this.statusProbeCount += 1;
          if (this.statusProbeCount === 1) {
            setTimeout(() => {
              this.emit("message", JSON.stringify({ state: 2, deviceState: 0, printJobTime: 613 }));
            }, 1);
          }
        } else if (frame?.params?.boxsInfo === 1) {
          setTimeout(() => {
            this.emit("message", JSON.stringify({ boxsInfo: { materialBoxs: [] } }));
          }, 1);
        }
        setTimeout(() => callback(), 1);
      }

      close() {}
    }

    const result = await runK2CfsReadOnlyCalibration({
      ...parseArgs([
        "--host",
        "192.168.54.153",
        "--probe-timeout-ms",
        "1000",
        "--status-probe-count",
        "2",
        "--status-probe-interval-ms",
        "0",
        "--boxsinfo-probe-count",
        "1",
        "--require-info-model",
        "F012",
      ]),
      fetchInfo: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ model: "F012", version: "1.0.0" }),
      }),
      openWs: async () => new PartiallyTimingOutWs(),
    });

    expect(result).toMatchObject({
      ok: false,
      sent: false,
      status: "partial",
      reason: "read-only-calibration-incomplete",
      blindRetryAllowed: false,
      statusProbeCount: 2,
      observedStatusProbeCount: 1,
      failedStatusProbeCount: 1,
      boxsInfoProbeCount: 1,
      observedBoxsInfoProbeCount: 1,
      failedBoxsInfoProbeCount: 0,
    });
    expect(result.printerStatusSeries.map((probe) => probe.status)).toEqual(["observed", "timeout"]);
    expect(result.wsTimeline.map((entry) => ({
      direction: entry.direction,
      kind: entry.kind,
      probe: entry.probe,
    }))).toEqual([
      { direction: "out", kind: "printer-status-get", probe: 1 },
      { direction: "in", kind: "printer-status", probe: 1 },
      { direction: "out", kind: "printer-status-get", probe: 2 },
      { direction: "out", kind: "boxsInfo-get", probe: 1 },
      { direction: "in", kind: "boxsInfo", probe: 1 },
    ]);
  });

  it("output-dir指定時はcalibration resultを保存する", async () => {
    class CalibrationWs extends EventEmitter {
      constructor() {
        super();
        this.sentFrames = [];
      }

      send(payload, callback) {
        const frame = JSON.parse(payload);
        this.sentFrames.push(frame);
        if (isPrinterStatusProbeFrame(frame)) {
          setTimeout(() => {
            this.emit("message", JSON.stringify({ state: 0, deviceState: 0 }));
          }, 1);
        } else if (frame?.params?.boxsInfo === 1) {
          setTimeout(() => {
            this.emit("message", JSON.stringify({ boxsInfo: { materialBoxs: [] } }));
          }, 1);
        }
        setTimeout(() => callback(), 1);
      }

      close() {}
    }
    const outputRoot = await mkdtemp(path.join(os.tmpdir(), "3dpmon-k2-cfs-readonly-"));
    try {
      const result = await runK2CfsReadOnlyCalibration({
        ...parseArgs([
          "--host",
          "192.168.54.153",
          "--status-probe-count",
          "1",
          "--boxsinfo-probe-count",
          "1",
          "--output-dir",
          outputRoot,
        ]),
        fetchInfo: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ model: "F012", version: "1.0.0" }),
        }),
        openWs: async () => new CalibrationWs(),
      });

      expect(result.evidence).toMatchObject({
        written: true,
        files: ["readonly-calibration-result.json"],
      });
      const saved = JSON.parse(await readFile(
        path.join(result.evidence.directory, "readonly-calibration-result.json"),
        "utf8",
      ));
      expect(saved).toMatchObject({
        ok: true,
        sent: false,
        evidence: {
          written: true,
        },
      });
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
