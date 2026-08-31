/**
 * @fileoverview K2 CFS slot control certification CLI の単体テスト
 * @description
 * - CLIが既定dry-runで、明示 `--send` なしに実機送信へ進まないことを検証する。
 * - certification-only planがlive確認なしに送信されないことを検証する。
 * - live certification用のread-only boxsInfo probeが送信前後で安全に待機できることを検証する。
 *
 * @version 1.390.1554 (PR #439)
 * @since 1.390.1415 (PR #435)
 * @lastModified 2026-08-31 20:06:12
 */

import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildK2CfsSlotControlRequest,
  findBoxsInfoEvidence,
  parseArgs,
  runK2CfsSlotControlCertification,
  sendBoxsInfoProbeAndWait,
  summarizeBoxsInfoEvidence,
} from "../../scripts/capture_k2_cfs_slot_control.mjs";

/**
 * Gate19 live certificationで最低限必要な確認済みCLI引数を生成する。
 *
 * 【詳細説明】
 * - CFS物理操作を伴うテストでは、host/command/source/model/probeの確認条件を毎回明示する。
 * - 個別テストはこの配列に追加・上書きすることで、runnerの安全境界を崩さず差分だけを検証する。
 *
 * @function createConfirmedF012LiveArgs
 * @param {Array<string>=} extraArgs - 追加CLI引数
 * @param {object=} overrides - command/source/hostの上書き
 * @returns {Array<string>} F012 live certification用CLI引数
 */
function createConfirmedF012LiveArgs(extraArgs = [], overrides = {}) {
  const command = overrides.command || "cfs-load";
  const source = overrides.source || "cfs:1:slot:0";
  const host = overrides.host || "192.168.54.153";
  return [
    "--send",
    "--host",
    host,
    "--confirm-live",
    "--confirm-host",
    host,
    "--confirm-command",
    command,
    "--confirm-source",
    source,
    "--command",
    command,
    "--source",
    source,
    "--probe-before",
    "--probe-after",
    "--probe-info",
    "--require-info-model",
    "F012",
    "--require-printer-idle",
    ...extraArgs,
  ];
}

/**
 * printer status guardが送るread-only GET frameかを判定する。
 *
 * 【詳細説明】
 * - live certificationの全mockで同じ判定を使い、CFS boxsInfo probeとprinter idle probeを混同しない。
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

/**
 * live certification mockへidle状態のprinter statusを返す。
 *
 * 【詳細説明】
 * - 実機送信前guardの通過条件を満たすため、state/deviceStateおよび活動指標をすべて0で返す。
 *
 * @function emitIdlePrinterStatus
 * @param {EventEmitter} ws - テスト用WebSocket mock
 * @returns {void}
 */
function emitIdlePrinterStatus(ws) {
  setTimeout(() => {
    ws.emit("message", JSON.stringify({
      state: 0,
      deviceState: 0,
      printProgress: 0,
      printJobTime: 0,
      printLeftTime: 0,
      targetNozzleTemp: 0,
      targetBedTemp0: 0,
      printFileName: "",
      printId: "",
    }));
  }, 1);
}

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
 * `/info` のF012成功応答を返すテスト用fetch関数を生成する。
 *
 * @function createF012InfoFetch
 * @returns {Function} F012 `/info` 応答を返すfetch互換関数
 */
function createF012InfoFetch() {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ model: "F012", version: "1.0.0" }),
  });
}

describe("capture_k2_cfs_slot_control", () => {
  it("既定ではdry-runとして送信せずfeedInOrOut candidate planだけを返す", async () => {
    const options = parseArgs([
      "--command",
      "cfs-load",
      "--source",
      "cfs:1:slot:0",
    ]);

    const result = await runK2CfsSlotControlCertification(options);

    expect(options.send).toBe(false);
    expect(result).toMatchObject({
      ok: true,
      sent: false,
      dryRun: true,
      plan: {
        ok: true,
        certificationOnly: true,
        requiresLiveConfirmation: true,
      },
    });
    expect(result.plan.frames).toEqual([
      {
        method: "set",
        params: {
          feedInOrOut: {
            boxId: 1,
            materialId: 0,
            isFeed: 1,
          },
        },
      },
    ]);
    expect(result.probePlan).toEqual({
      before: false,
      after: false,
      info: false,
      requireInfoModel: null,
      confirmSource: null,
      requirePrinterIdle: false,
      boxsInfoTimeoutMs: 5000,
      printerStatusTimeoutMs: 5000,
      infoTimeoutMs: 5000,
      postCommandProbeDelayMs: 1500,
      postCommandProbeCount: 6,
      postCommandProbeIntervalMs: 5000,
    });
  });

  it("--send指定時だけhost/live/host一致/command一致/printer idle確認を必須にする", () => {
    const baseArgs = [
      "--send",
      "--host",
      "192.168.54.153",
      "--command",
      "cfs-load",
      "--source",
      "cfs:1:slot:0",
    ];

    expect(() => parseArgs([
      "--send",
      "--command",
      "cfs-load",
      "--source",
      "cfs:1:slot:0",
    ])).toThrow("--host is required");
    expect(() => parseArgs(baseArgs)).toThrow("--confirm-live is required");
    expect(() => parseArgs([
      ...baseArgs,
      "--confirm-live",
      "--confirm-host",
      "192.168.54.21",
    ])).toThrow("--confirm-host must exactly match --host");
    expect(() => parseArgs([
      ...baseArgs,
      "--confirm-live",
      "--confirm-host",
      "192.168.54.153",
      "--confirm-command",
      "cfs-unload",
    ])).toThrow("--confirm-command must exactly match --command");
    expect(() => parseArgs([
      ...baseArgs,
      "--boxsinfo-timeout-ms",
      "999",
    ])).toThrow("--boxsinfo-timeout-ms must be between 1000 and 60000");
    expect(() => parseArgs([
      ...baseArgs,
      "--probe-after-delay-ms",
      "-1",
    ])).toThrow("--probe-after-delay-ms must be between 0 and 60000");
    expect(() => parseArgs([
      ...baseArgs,
      "--probe-after-count",
      "0",
    ])).toThrow("--probe-after-count must be between 1 and 60");
    expect(() => parseArgs([
      ...baseArgs,
      "--probe-after-interval-ms",
      "99",
    ])).toThrow("--probe-after-interval-ms must be between 100 and 60000");
    expect(() => parseArgs([
      "--send",
      "--host",
      "192.168.54.153",
      "--confirm-live",
      "--confirm-host",
      "192.168.54.153",
      "--confirm-command",
      "cfs-feed",
      "--command",
      "cfs-feed",
      "--source",
      "cfs:1:slot:0",
    ])).toThrow("--send is currently limited to cfs-load and cfs-unload");
    expect(() => parseArgs([
      ...baseArgs,
      "--confirm-live",
      "--confirm-host",
      "192.168.54.153",
      "--confirm-command",
      "cfs-load",
    ])).toThrow("--probe-before and --probe-after are required when --send is used");
    expect(() => parseArgs([
      ...baseArgs,
      "--confirm-live",
      "--confirm-host",
      "192.168.54.153",
      "--confirm-command",
      "cfs-load",
      "--probe-before",
    ])).toThrow("--probe-before and --probe-after are required when --send is used");
    expect(() => parseArgs([
      ...baseArgs,
      "--confirm-live",
      "--confirm-host",
      "192.168.54.153",
      "--confirm-command",
      "cfs-load",
      "--probe-after",
    ])).toThrow("--probe-before and --probe-after are required when --send is used");
    expect(() => parseArgs([
      ...baseArgs,
      "--confirm-live",
      "--confirm-host",
      "192.168.54.153",
      "--confirm-command",
      "cfs-load",
      "--probe-before",
      "--probe-after",
      "--probe-info",
      "--require-info-model",
      "F012",
    ])).toThrow("--confirm-source must exactly match --source");
    expect(() => parseArgs([
      ...baseArgs,
      "--confirm-live",
      "--confirm-host",
      "192.168.54.153",
      "--confirm-command",
      "cfs-load",
      "--confirm-source",
      "cfs:1:slot:0",
      "--probe-before",
      "--probe-after",
      "--probe-info",
      "--require-info-model",
      "F012",
    ])).toThrow("--require-printer-idle is required when --send is used");
    expect(() => parseArgs([
      ...baseArgs,
      "--confirm-live",
      "--confirm-host",
      "192.168.54.153",
      "--confirm-command",
      "cfs-load",
      "--confirm-source",
      "cfs:1:slot:0",
      "--probe-before",
      "--probe-after",
    ])).toThrow("--probe-info and --require-info-model F012 are required");
    expect(parseArgs([
      ...baseArgs,
      "--confirm-live",
      "--confirm-host",
      "192.168.54.153",
      "--confirm-command",
      "cfs-load",
      "--confirm-source",
      "cfs:1:slot:0",
      "--probe-before",
      "--probe-after",
      "--boxsinfo-timeout-ms",
      "1500",
      "--probe-info",
      "--require-info-model",
      "F012",
      "--operator-marker",
      "observed-cfs-load-motion",
      "--require-printer-idle",
      "--printer-status-timeout-ms",
      "2500",
    ])).toMatchObject({
      send: true,
      confirmLive: true,
      confirmHost: "192.168.54.153",
      confirmCommand: "cfs-load",
      confirmSource: "cfs:1:slot:0",
      probeBefore: true,
      probeAfter: true,
      probeInfo: true,
      requireInfoModel: "F012",
      operatorMarker: "observed-cfs-load-motion",
      requirePrinterIdle: true,
      boxsInfoTimeoutMs: 1500,
      printerStatusTimeoutMs: 2500,
      postCommandProbeDelayMs: 1500,
      postCommandProbeCount: 6,
      postCommandProbeIntervalMs: 5000,
    });
    const liveDefault = parseArgs(createConfirmedF012LiveArgs());

    expect(liveDefault).toMatchObject({
      probeBefore: true,
      probeAfter: true,
      requirePrinterIdle: true,
      boxsInfoTimeoutMs: 5000,
      printerStatusTimeoutMs: 5000,
      postCommandProbeDelayMs: 1500,
      postCommandProbeCount: 6,
      postCommandProbeIntervalMs: 5000,
    });
    expect(parseArgs([
      "--command",
      "cfs-load",
      "--source",
      "cfs:1:slot:0",
      "--probe-after-delay-ms",
      "2500",
      "--probe-after-count",
      "3",
      "--probe-after-interval-ms",
      "750",
    ])).toMatchObject({
      postCommandProbeDelayMs: 2500,
      postCommandProbeCount: 3,
      postCommandProbeIntervalMs: 750,
    });
  });

  it("/info model requirement不一致時はWebSocketを開く前にlive送信を拒否する", async () => {
    const options = {
      ...parseArgs(createConfirmedF012LiveArgs()),
      fetchInfo: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ model: "F013", version: "1.0.0" }),
      }),
      openWs: async () => {
        throw new Error("model mismatch must reject before websocket open");
      },
    };

    const result = await runK2CfsSlotControlCertification(options);

    expect(result).toMatchObject({
      ok: false,
      sent: false,
      dryRun: false,
      status: "rejected",
      reason: "printer-info-model-mismatch",
      printerInfo: {
        status: "observed",
        expectedModel: "F012",
        modelMatched: false,
        info: {
          model: "F013",
          version: "1.0.0",
        },
      },
    });
  });

  it("programmatic callerでもsend時はbefore/after probe必須としてrunner本体で拒否する", async () => {
    const options = {
      ...parseArgs([
        "--command",
        "cfs-load",
        "--source",
        "cfs:1:slot:0",
      ]),
      send: true,
      confirmLive: true,
      host: "192.168.54.153",
      confirmHost: "192.168.54.153",
      confirmCommand: "cfs-load",
      confirmSource: "cfs:1:slot:0",
      probeInfo: true,
      requireInfoModel: "F012",
      openWs: async () => {
        throw new Error("runner guard should reject before opening websocket");
      },
    };

    const result = await runK2CfsSlotControlCertification(options);

    expect(result).toMatchObject({
      ok: false,
      sent: false,
      dryRun: false,
      status: "rejected",
      reason: "live-certification-probes-required",
      blindRetryAllowed: false,
    });
  });

  it("programmatic callerでもlive確認不一致時はrunner本体でWebSocketを開かず拒否する", async () => {
    const options = {
      ...parseArgs([
        "--command",
        "cfs-load",
        "--source",
        "cfs:1:slot:0",
      ]),
      send: true,
      confirmLive: false,
      host: "192.168.54.153",
      confirmHost: "192.168.54.153",
      confirmCommand: "cfs-load",
      confirmSource: "cfs:1:slot:0",
      probeBefore: true,
      probeAfter: true,
      probeInfo: true,
      requireInfoModel: "F012",
      openWs: async () => {
        throw new Error("runner guard should reject before opening websocket");
      },
    };

    const result = await runK2CfsSlotControlCertification(options);

    expect(result).toMatchObject({
      ok: false,
      sent: false,
      dryRun: false,
      status: "rejected",
      reason: "live-certification-confirm-live-required",
      blindRetryAllowed: false,
    });
  });

  it("programmatic callerでもF012 /info必須条件なしではrunner本体でWebSocketを開かず拒否する", async () => {
    const options = {
      ...parseArgs([
        "--command",
        "cfs-load",
        "--source",
        "cfs:1:slot:0",
      ]),
      send: true,
      confirmLive: true,
      host: "192.168.54.153",
      confirmHost: "192.168.54.153",
      confirmCommand: "cfs-load",
      confirmSource: "cfs:1:slot:0",
      probeBefore: true,
      probeAfter: true,
      openWs: async () => {
        throw new Error("runner guard should reject before opening websocket");
      },
    };

    const result = await runK2CfsSlotControlCertification(options);

    expect(result).toMatchObject({
      ok: false,
      sent: false,
      dryRun: false,
      status: "rejected",
      reason: "live-certification-f012-info-required",
      blindRetryAllowed: false,
    });
  });

  it("--require-printer-idle指定時は印刷活動中のK2へCFS操作frameを送らない", async () => {
    class ActivePrinterStatusWs extends EventEmitter {
      constructor() {
        super();
        this.sentFrames = [];
        this.closed = false;
      }

      send(payload, callback) {
        const frame = JSON.parse(payload);
        this.sentFrames.push(frame);
        if (frame?.params?.state === 1) {
          setTimeout(() => {
            this.emit("message", JSON.stringify({
              state: 2,
              deviceState: 0,
              printProgress: 100,
              printJobTime: 613,
              printLeftTime: 0,
              printFileName: "/mnt/UDISK/printer_data/gcodes/bracket.stl_PLA_8m15s.gcode",
            }));
          }, 1);
        }
        setTimeout(() => callback(), 1);
      }

      close() {
        this.closed = true;
      }
    }
    const ws = new ActivePrinterStatusWs();
    const options = {
      ...parseArgs(createConfirmedF012LiveArgs([
        "--require-printer-idle",
      ])),
      fetchInfo: createF012InfoFetch(),
      openWs: async () => ws,
    };

    const result = await runK2CfsSlotControlCertification(options);

    expect(result).toMatchObject({
      ok: false,
      sent: false,
      dryRun: false,
      status: "rejected",
      reason: "pre-command-printer-not-idle",
      blindRetryAllowed: false,
      printerStatus: {
        status: "observed",
        summary: {
          idle: false,
          active: true,
          state: 2,
          printJobTime: 613,
        },
      },
      response: null,
    });
    expect(ws.sentFrames).toEqual([PRINTER_STATUS_GET_FRAME]);
    expect(ws.closed).toBe(true);
  });

  it("--require-printer-idle指定時はnull/空文字のprinter statusをidle根拠にしない", async () => {
    class UnknownPrinterStatusWs extends EventEmitter {
      constructor() {
        super();
        this.sentFrames = [];
        this.closed = false;
      }

      send(payload, callback) {
        const frame = JSON.parse(payload);
        this.sentFrames.push(frame);
        if (frame?.params?.state === 1) {
          setTimeout(() => {
            this.emit("message", JSON.stringify({
              state: null,
              deviceState: "",
              printProgress: "",
              printJobTime: "",
              printLeftTime: null,
              targetNozzleTemp: "",
              targetBedTemp0: null,
            }));
          }, 1);
        } else if (frame?.params?.boxsInfo === 1) {
          setTimeout(() => {
            this.emit("message", JSON.stringify({
              boxsInfo: {
                cfsConnect: 1,
                materialBoxs: [{ id: 1, type: 0, materials: [{ id: 0, state: 1, selected: 1 }] }],
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
    const ws = new UnknownPrinterStatusWs();
    const options = {
      ...parseArgs(createConfirmedF012LiveArgs([
        "--require-printer-idle",
      ])),
      fetchInfo: createF012InfoFetch(),
      openWs: async () => ws,
    };

    const result = await runK2CfsSlotControlCertification(options);

    expect(result).toMatchObject({
      ok: false,
      sent: false,
      dryRun: false,
      status: "rejected",
      reason: "pre-command-printer-not-idle",
      blindRetryAllowed: false,
      printerStatus: {
        status: "observed",
        summary: {
          idle: false,
          active: true,
          state: null,
          deviceState: null,
        },
      },
      response: null,
    });
    expect(ws.sentFrames).toEqual([PRINTER_STATUS_GET_FRAME]);
    expect(ws.closed).toBe(true);
  });

  it("unsupported commandはdry-run段階で拒否する", () => {
    expect(() => parseArgs([
      "--command",
      "print-start",
      "--source",
      "cfs:1:slot:0",
    ])).toThrow("--command must be one of");
  });

  it("external sourceはdry-run段階でも拒否結果になる", async () => {
    const options = parseArgs([
      "--command",
      "cfs-load",
      "--source",
      "external:0:slot:0",
    ]);

    const result = await runK2CfsSlotControlCertification(options);

    expect(result).toMatchObject({
      ok: false,
      sent: false,
      plan: {
        ok: false,
        reason: "invalid-cfs-control-source-id",
      },
    });
  });

  it("requestはcommand/sourceだけをtransport候補へ渡す", () => {
    const options = parseArgs([
      "--command",
      "cfs-retract",
      "--source",
      "cfs:2:slot:3",
    ]);
    const request = buildK2CfsSlotControlRequest(options);

    expect(request).toMatchObject({
      commandKind: "cfs-retract",
      transportKind: "ws9999",
      payload: {
        sourceId: "cfs:2:slot:3",
      },
    });
    expect(request.payload.certificationIntentId).toMatch(/^live-certification:/u);
  });

  it("--send時はws.send callback完了を待ち、certification-only送信を明示許可する", async () => {
    class SubmittedProbeWs extends EventEmitter {
      constructor() {
        super();
        this.sentFrames = [];
        this.closed = false;
      }

      send(payload, callback) {
        const frame = JSON.parse(payload);
        this.sentFrames.push(frame);
        if (isPrinterStatusProbeFrame(frame)) {
          emitIdlePrinterStatus(this);
        } else if (frame?.params?.boxsInfo === 1) {
          setTimeout(() => {
            this.emit("message", JSON.stringify({
              result: {
                boxsInfo: {
                  materialBoxs: [{ id: 1, type: 0, materials: [{ id: 0, state: 1, selected: 1 }] }],
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
    const ws = new SubmittedProbeWs();
    const options = {
      ...parseArgs(createConfirmedF012LiveArgs([
        "--probe-after-count",
        "1",
      ], { command: "cfs-unload" })),
      fetchInfo: createF012InfoFetch(),
      openWs: async () => ws,
    };

    const result = await runK2CfsSlotControlCertification(options);

    expect(result).toMatchObject({
      ok: true,
      sent: true,
      dryRun: false,
      status: "post-observed",
      reason: "post-command-telemetry-observed",
      response: {
        status: "submitted",
        sentFrameCount: 1,
      },
    });
    expect(ws.sentFrames).toEqual([
      PRINTER_STATUS_GET_FRAME,
      { method: "get", params: { boxsInfo: 1 } },
      {
        method: "set",
        params: {
          feedInOrOut: {
            boxId: 1,
            materialId: 0,
            isFeed: 0,
          },
        },
      },
      { method: "get", params: { boxsInfo: 1 } },
    ]);
    expect(ws.closed).toBe(true);
  });

  it("live送信resultに/info証跡、operator marker、target source前後差分を残す", async () => {
    class DeltaProbeWs extends EventEmitter {
      constructor() {
        super();
        this.sentFrames = [];
        this.closed = false;
        this.getCount = 0;
      }

      send(payload, callback) {
        const frame = JSON.parse(payload);
        this.sentFrames.push(frame);
        if (isPrinterStatusProbeFrame(frame)) {
          emitIdlePrinterStatus(this);
        } else if (frame?.params?.boxsInfo === 1) {
          this.getCount += 1;
          const percent = this.getCount > 1 ? 99 : 100;
          setTimeout(() => {
            this.emit("message", JSON.stringify({
              result: {
                boxsInfo: {
                  materialBoxs: [
                    {
                      id: 1,
                      type: 0,
                      materials: [
                        { id: 0, state: 1, selected: 1, percent, name: "Generic PLA" },
                      ],
                    },
                  ],
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
    const ws = new DeltaProbeWs();
    const options = {
      ...parseArgs(createConfirmedF012LiveArgs([
        "--operator-marker",
        "preflight: operator present / printer idle / CFS visually checked",
        "--probe-after-count",
        "1",
      ])),
      fetchInfo: async (url) => ({
        ok: true,
        status: 200,
        url,
        json: async () => ({
          mac: "redacted",
          model: "F012",
          version: "1.0.0",
          wssPort: 443,
        }),
      }),
      openWs: async () => ws,
    };

    const result = await runK2CfsSlotControlCertification(options);

    expect(result).toMatchObject({
      ok: true,
      sent: true,
      status: "post-observed",
      printerInfo: {
        status: "observed",
        expectedModel: "F012",
        modelMatched: true,
        info: {
          model: "F012",
          version: "1.0.0",
          wssPort: 443,
        },
      },
      operatorMarker: {
        source: "operator-cli",
        value: "preflight: operator present / printer idle / CFS visually checked",
      },
      targetSourceDelta: {
        sourceId: "cfs:1:slot:0",
        observed: true,
        beforeProbe: "before",
        afterProbe: "after",
        before: {
          presence: "loaded",
          selected: true,
          percent: 100,
        },
        after: {
          presence: "loaded",
          selected: true,
          percent: 99,
        },
        changedFields: ["percent"],
      },
    });
  });

  it("CFS command frameのws.send callback errorは未送信断定にせずunknown証跡として残す", async () => {
    class ErroringCommandSendWs extends EventEmitter {
      constructor() {
        super();
        this.sentFrames = [];
        this.closed = false;
      }

      send(payload, callback) {
        const frame = JSON.parse(payload);
        this.sentFrames.push(frame);
        if (isPrinterStatusProbeFrame(frame)) {
          emitIdlePrinterStatus(this);
        } else if (frame?.params?.boxsInfo === 1) {
          setTimeout(() => {
            this.emit("message", JSON.stringify({
              result: {
                boxsInfo: {
                  materialBoxs: [{ id: 1, type: 0, materials: [{ id: 0, state: 1, selected: 1 }] }],
                },
              },
            }));
          }, 1);
          setTimeout(() => callback(), 1);
          return;
        }
        setTimeout(() => callback(new Error("socket write failed after enqueue")), 1);
      }

      close() {
        this.closed = true;
      }
    }
    const ws = new ErroringCommandSendWs();
    const options = {
      ...parseArgs(createConfirmedF012LiveArgs([
        "--probe-after-count",
        "1",
      ])),
      fetchInfo: createF012InfoFetch(),
      openWs: async () => ws,
    };

    const result = await runK2CfsSlotControlCertification(options);

    expect(result).toMatchObject({
      ok: false,
      sent: true,
      sendAttempted: true,
      dryRun: false,
      status: "unknown",
      reason: "command-submit-outcome-unknown",
      blindRetryAllowed: false,
      response: null,
      error: {
        message: "socket write failed after enqueue",
      },
    });
    expect(ws.sentFrames).toEqual([
      PRINTER_STATUS_GET_FRAME,
      { method: "get", params: { boxsInfo: 1 } },
      { method: "set", params: { feedInOrOut: { boxId: 1, materialId: 0, isFeed: 1 } } },
    ]);
    expect(ws.closed).toBe(true);
  });

  it("boxsInfo evidenceはnested envelopeから取り出せる", () => {
    expect(findBoxsInfoEvidence({
      result: {
        data: {
          boxsInfo: {
            materialBoxs: [{ id: 1 }],
          },
        },
      },
    })).toEqual({
      path: "$.result.data.boxsInfo",
      value: {
        materialBoxs: [{ id: 1 }],
      },
    });
    expect(findBoxsInfoEvidence({ result: { state: 1 } })).toBeNull();
  });

  it("boxsInfo evidenceから外部/CFS source summaryとtarget sourceを抽出する", () => {
    const summary = summarizeBoxsInfoEvidence({
      materialBoxs: [
        {
          id: 0,
          type: 1,
          state: 0,
          materials: [{ id: 0, state: 0, selected: 0, percent: 100 }],
        },
        {
          id: 1,
          type: 0,
          state: 1,
          temp: 27,
          humidity: 55,
          materials: [
            { id: 0, state: 1, selected: 0, percent: 95, type: "PLA", name: "White", color: "#0ffffff", rfid: "" },
            { id: 2, state: 1, selected: 1, percent: 54, type: "PLA", name: "Silver", color: "#09ea7ae", rfid: "ABC" },
          ],
        },
      ],
      colorMatch: [
        { id: "T1A", boxId: 1, materialId: 0 },
        { id: "T1C", boxId: 1, materialId: 2 },
      ],
    }, "cfs:1:slot:2");

    expect(summary).toMatchObject({
      boxCount: 2,
      cfsUnitCount: 1,
      externalEndpointCount: 1,
      loadedSourceCount: 2,
      selectedSourceIds: ["cfs:1:slot:2"],
      targetSource: {
        sourceId: "cfs:1:slot:2",
        displaySlot: "1C",
        presence: "loaded",
        selected: true,
        selectedObserved: true,
        selectionState: "selected",
        percent: 54,
        materialType: "PLA",
        materialName: "Silver",
        color: "#09ea7ae",
        rfidPresent: true,
      },
      colorMatches: [
        { assignmentId: "T1A", sourceId: "cfs:1:slot:0", boxId: 1, materialId: 0 },
        { assignmentId: "T1C", sourceId: "cfs:1:slot:2", boxId: 1, materialId: 2 },
      ],
    });
    expect(summary.sources).toContainEqual(expect.objectContaining({
      sourceId: "external:0",
      kind: "external-spool",
      presence: "empty",
      selectedObserved: true,
      selectionState: "unselected",
    }));
  });

  it("boxsInfo summaryはselected=falseとselected未観測を分けて残す", () => {
    const summary = summarizeBoxsInfoEvidence({
      materialBoxs: [{
        id: 1,
        type: 0,
        materials: [
          { id: 0, state: 1, selected: 1, name: "Selected" },
          { id: 1, state: 1, selected: 0, name: "Unselected" },
          { id: 2, state: 1, name: "Unobserved" },
          { id: 3, state: 1, selected: null, name: "NullSelected" },
        ],
      }],
    });

    expect(summary.sources.map((source) => [
      source.materialName,
      source.selected,
      source.selectedObserved,
      source.selectionState,
    ])).toEqual([
      ["Selected", true, true, "selected"],
      ["Unselected", false, true, "unselected"],
      ["Unobserved", false, false, "unobserved"],
      ["NullSelected", false, false, "unobserved"],
    ]);
    expect(summary.selectedSourceIds).toEqual(["cfs:1:slot:0"]);
  });

  it("boxsInfo summaryは不正なselected値をunselectedへ潰さずdiagnosticsへ残す", () => {
    const summary = summarizeBoxsInfoEvidence({
      materialBoxs: [{
        id: 1,
        type: 0,
        materials: [
          { id: 0, state: 1, selected: 2, name: "MalformedNumericSelected" },
          { id: 1, state: 1, selected: "yes", name: "MalformedStringSelected" },
        ],
      }],
    });

    expect(summary.sources.map((source) => [
      source.materialName,
      source.selected,
      source.selectedObserved,
      source.selectionState,
      source.selectionValid,
      source.selectionRaw,
    ])).toEqual([
      ["MalformedNumericSelected", false, true, "invalid", false, 2],
      ["MalformedStringSelected", false, true, "invalid", false, "yes"],
    ]);
    expect(summary.selectedSourceIds).toEqual([]);
    expect(summary.diagnostics).toEqual([
      {
        reason: "selected-value-invalid",
        path: "materialBoxs[0].materials[0].selected",
        value: 2,
      },
      {
        reason: "selected-value-invalid",
        path: "materialBoxs[0].materials[1].selected",
        value: "yes",
      },
    ]);
  });

  it("boxsInfo summaryは明示state codeだけをpresenceへ採用する", () => {
    const summary = summarizeBoxsInfoEvidence({
      materialBoxs: [{
        id: 1,
        type: 0,
        materials: [
          { id: 0, state: null, name: "NullState PLA" },
          { id: 1, state: "", name: "EmptyString PLA" },
          { id: 2, name: "MissingState PLA" },
          { id: 3, state: "0", name: "StringEmpty PLA" },
          { id: 4, state: 0, name: "NumericEmpty PLA" },
          { id: 5, state: "1", name: "StringLoaded PLA" },
          { id: 6, state: 1, name: "NumericLoaded PLA" },
          { id: 7, state: "01", name: "PaddedLoaded PLA" },
        ],
      }],
    });

    expect(summary.sources.map((source) => [source.materialName, source.presence])).toEqual([
      ["NullState PLA", "unknown"],
      ["EmptyString PLA", "unknown"],
      ["MissingState PLA", "unknown"],
      ["StringEmpty PLA", "empty"],
      ["NumericEmpty PLA", "empty"],
      ["StringLoaded PLA", "loaded"],
      ["NumericLoaded PLA", "loaded"],
      ["PaddedLoaded PLA", "unknown"],
    ]);
    expect(summary.loadedSourceCount).toBe(2);
  });

  it("boxsInfo summaryはbox/material locator欠落をsourceIdへ補完せずdiagnosticsへ残す", () => {
    const summary = summarizeBoxsInfoEvidence({
      materialBoxs: [
        { type: 0, materials: [{ id: 0, state: 1, name: "MissingBox" }] },
        { id: 2, materials: [{ id: 0, state: 1, name: "MissingType" }] },
        { id: 3, type: 0, materials: [{ state: 1, name: "MissingMaterial" }] },
        { id: 4, type: 0, materials: [{ id: "A", state: 1, name: "BadMaterial" }] },
        { id: 5, type: 0, materials: [{ id: 1, state: 1, name: "Valid" }] },
      ],
      colorMatch: [
        { id: "T1A", boxId: 3 },
        { id: "T1B", boxId: 5, materialId: 1 },
      ],
    });

    expect(summary.sources.map((source) => source.sourceId)).toEqual(["cfs:5:slot:1"]);
    expect(summary.colorMatches).toEqual([
      { assignmentId: "T1B", sourceId: "cfs:5:slot:1", boxId: 5, materialId: 1 },
    ]);
    expect(summary.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "box-id-missing", path: "materialBoxs[0]" }),
      expect.objectContaining({ reason: "box-type-missing", path: "materialBoxs[1]" }),
      expect.objectContaining({ reason: "material-id-missing", path: "materialBoxs[2].materials[0]" }),
      expect.objectContaining({ reason: "material-id-invalid", path: "materialBoxs[3].materials[0]" }),
      expect.objectContaining({ reason: "color-match-material-id-missing", path: "colorMatch[0]" }),
    ]));
  });

  it("boxsInfo summaryは重複box/source locatorを曖昧なauthority候補にしない", () => {
    const summary = summarizeBoxsInfoEvidence({
      materialBoxs: [
        { id: 1, type: 0, materials: [{ id: 0, state: 1, name: "Primary" }] },
        { id: 1, type: 0, materials: [{ id: 1, state: 1, name: "DuplicateBox" }] },
        {
          id: 2,
          type: 0,
          materials: [
            { id: 0, state: 1, name: "Slot0" },
            { id: 0, state: 1, name: "DuplicateSlot0" },
          ],
        },
      ],
      colorMatch: [
        { id: "T1A", boxId: 1, materialId: 0 },
        { id: "T1B", boxId: 1, materialId: 1 },
        { id: "T1C", boxId: 2, materialId: 0 },
      ],
    });

    expect(summary.sources.map((source) => source.sourceId)).toEqual([]);
    expect(summary.colorMatches).toEqual([]);
    expect(summary.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "box-id-duplicate", path: "materialBoxs[1]" }),
      expect.objectContaining({ reason: "source-id-duplicate", path: "materialBoxs[2].materials[1]" }),
      expect.objectContaining({ reason: "color-match-box-unresolved", path: "colorMatch[1]" }),
      expect.objectContaining({ reason: "color-match-box-unresolved", path: "colorMatch[0]" }),
      expect.objectContaining({ reason: "color-match-source-unresolved", path: "colorMatch[2]" }),
    ]));
  });

  it("pre-command probeでduplicate locatorが観測された場合はCFS操作frameを送らない", async () => {
    class DuplicateBeforeProbeWs extends EventEmitter {
      constructor() {
        super();
        this.sentFrames = [];
        this.closed = false;
      }

      send(payload, callback) {
        const frame = JSON.parse(payload);
        this.sentFrames.push(frame);
        if (isPrinterStatusProbeFrame(frame)) {
          emitIdlePrinterStatus(this);
        } else if (frame?.params?.boxsInfo === 1) {
          setTimeout(() => {
            this.emit("message", JSON.stringify({
              result: {
                boxsInfo: {
                  materialBoxs: [
                    { id: 1, type: 0, materials: [{ id: 0, state: 1, name: "Primary" }] },
                    { id: 1, type: 0, materials: [{ id: 0, state: 1, name: "Duplicate" }] },
                  ],
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
    const ws = new DuplicateBeforeProbeWs();
    const options = {
      ...parseArgs(createConfirmedF012LiveArgs()),
      fetchInfo: createF012InfoFetch(),
      openWs: async () => ws,
    };

    const result = await runK2CfsSlotControlCertification(options);

    expect(result).toMatchObject({
      ok: false,
      sent: false,
      dryRun: false,
      status: "rejected",
      reason: "pre-command-target-source-ambiguous",
      blindRetryAllowed: false,
    });
    expect(result.probes.before.summary.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "box-id-duplicate" }),
    ]));
    expect(ws.sentFrames).toEqual([
      PRINTER_STATUS_GET_FRAME,
      { method: "get", params: { boxsInfo: 1 } },
    ]);
    expect(ws.closed).toBe(true);
  });

  it("pre-command probeでtarget sourceがloadedでも未選択ならCFS操作frameを送らない", async () => {
    class UnselectedBeforeProbeWs extends EventEmitter {
      constructor() {
        super();
        this.sentFrames = [];
        this.closed = false;
      }

      send(payload, callback) {
        const frame = JSON.parse(payload);
        this.sentFrames.push(frame);
        if (isPrinterStatusProbeFrame(frame)) {
          emitIdlePrinterStatus(this);
        } else if (frame?.params?.boxsInfo === 1) {
          setTimeout(() => {
            this.emit("message", JSON.stringify({
              result: {
                boxsInfo: {
                  materialBoxs: [{
                    id: 1,
                    type: 0,
                    materials: [
                      { id: 0, state: 1, selected: 0, name: "Target" },
                      { id: 1, state: 1, selected: 1, name: "SelectedOther" },
                    ],
                  }],
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
    const ws = new UnselectedBeforeProbeWs();
    const options = {
      ...parseArgs(createConfirmedF012LiveArgs()),
      fetchInfo: createF012InfoFetch(),
      openWs: async () => ws,
    };

    const result = await runK2CfsSlotControlCertification(options);

    expect(result).toMatchObject({
      ok: false,
      sent: false,
      dryRun: false,
      status: "rejected",
      reason: "pre-command-target-source-not-selected",
      blindRetryAllowed: false,
    });
    expect(result.probes.before.summary.selectedSourceIds).toEqual(["cfs:1:slot:1"]);
    expect(ws.sentFrames).toEqual([
      PRINTER_STATUS_GET_FRAME,
      { method: "get", params: { boxsInfo: 1 } },
    ]);
    expect(ws.closed).toBe(true);
  });

  it("pre-command probeでtarget以外のloaded sourceにinvalid selectedがある場合はCFS操作frameを送らない", async () => {
    class InvalidNonTargetSelectionBeforeProbeWs extends EventEmitter {
      constructor() {
        super();
        this.sentFrames = [];
        this.closed = false;
      }

      send(payload, callback) {
        const frame = JSON.parse(payload);
        this.sentFrames.push(frame);
        if (isPrinterStatusProbeFrame(frame)) {
          emitIdlePrinterStatus(this);
        } else if (frame?.params?.boxsInfo === 1) {
          setTimeout(() => {
            this.emit("message", JSON.stringify({
              result: {
                boxsInfo: {
                  materialBoxs: [{
                    id: 1,
                    type: 0,
                    materials: [
                      { id: 0, state: 1, selected: 1, name: "Target" },
                      { id: 1, state: 1, selected: 2, name: "MalformedOther" },
                    ],
                  }],
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
    const ws = new InvalidNonTargetSelectionBeforeProbeWs();
    const options = {
      ...parseArgs(createConfirmedF012LiveArgs()),
      fetchInfo: createF012InfoFetch(),
      openWs: async () => ws,
    };

    const result = await runK2CfsSlotControlCertification(options);

    expect(result).toMatchObject({
      ok: false,
      sent: false,
      dryRun: false,
      status: "rejected",
      reason: "pre-command-selected-value-invalid",
      blindRetryAllowed: false,
    });
    expect(result.probes.before.summary.selectedSourceIds).toEqual(["cfs:1:slot:0"]);
    expect(result.probes.before.summary.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceId: "cfs:1:slot:1",
        selectionState: "invalid",
        selectionValid: false,
        selectionRaw: 2,
      }),
    ]));
    expect(ws.sentFrames).toEqual([
      PRINTER_STATUS_GET_FRAME,
      { method: "get", params: { boxsInfo: 1 } },
    ]);
    expect(ws.closed).toBe(true);
  });

  it("pre-command probeでtarget以外のloaded sourceがselection未観測の場合はCFS操作frameを送らない", async () => {
    class UnobservedNonTargetSelectionBeforeProbeWs extends EventEmitter {
      constructor() {
        super();
        this.sentFrames = [];
        this.closed = false;
      }

      send(payload, callback) {
        const frame = JSON.parse(payload);
        this.sentFrames.push(frame);
        if (isPrinterStatusProbeFrame(frame)) {
          emitIdlePrinterStatus(this);
        } else if (frame?.params?.boxsInfo === 1) {
          setTimeout(() => {
            this.emit("message", JSON.stringify({
              result: {
                boxsInfo: {
                  materialBoxs: [{
                    id: 1,
                    type: 0,
                    materials: [
                      { id: 0, state: 1, selected: 1, name: "Target" },
                      { id: 1, state: 1, name: "UnobservedOther" },
                    ],
                  }],
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
    const ws = new UnobservedNonTargetSelectionBeforeProbeWs();
    const options = {
      ...parseArgs(createConfirmedF012LiveArgs()),
      fetchInfo: createF012InfoFetch(),
      openWs: async () => ws,
    };

    const result = await runK2CfsSlotControlCertification(options);

    expect(result).toMatchObject({
      ok: false,
      sent: false,
      dryRun: false,
      status: "rejected",
      reason: "pre-command-selected-source-observation-incomplete",
      blindRetryAllowed: false,
    });
    expect(result.probes.before.summary.selectedSourceIds).toEqual(["cfs:1:slot:0"]);
    expect(result.probes.before.summary.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceId: "cfs:1:slot:1",
        selectionState: "unobserved",
        selectionValid: null,
      }),
    ]));
    expect(ws.sentFrames).toEqual([
      PRINTER_STATUS_GET_FRAME,
      { method: "get", params: { boxsInfo: 1 } },
    ]);
    expect(ws.closed).toBe(true);
  });

  it("read-only boxsInfo probeは応答を待ち、timeout時はlistenerを残さない", async () => {
    class MockWs extends EventEmitter {
      send(payload, callback) {
        this.sentPayload = payload;
        setTimeout(() => {
          this.emit("message", JSON.stringify({
            result: {
              boxsInfo: {
                materialBoxs: [{ id: 1, type: 0, materials: [] }],
              },
            },
          }));
          callback();
        }, 1);
      }
    }
    const ws = new MockWs();

    const result = await sendBoxsInfoProbeAndWait(ws, {
      probeMode: "before",
      timeoutMs: 1000,
    });

    expect(JSON.parse(ws.sentPayload)).toEqual({ method: "get", params: { boxsInfo: 1 } });
    expect(result.status).toBe("observed");
    expect(result.probeMode).toBe("before");
    expect(result.observedAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u));
    expect(result.evidence.path).toBe("$.result.boxsInfo");
    expect(result.summary).toMatchObject({
      boxCount: 1,
      cfsUnitCount: 1,
    });
    expect(ws.listenerCount("message")).toBe(0);

    const timeoutWs = new EventEmitter();
    timeoutWs.send = (_payload, callback) => callback();
    await expect(sendBoxsInfoProbeAndWait(timeoutWs, {
      probeMode: "after",
      timeoutMs: 5,
    })).rejects.toThrow("boxsInfo probe timeout");
    expect(timeoutWs.listenerCount("message")).toBe(0);
  });

  it("--probe-before/after指定時はcommand前後にread-only boxsInfoを観測する", async () => {
    class ProbeWs extends EventEmitter {
      constructor() {
        super();
        this.sentFrames = [];
        this.closed = false;
      }

      send(payload, callback) {
        const frame = JSON.parse(payload);
        this.sentFrames.push(frame);
        if (isPrinterStatusProbeFrame(frame)) {
          emitIdlePrinterStatus(this);
        } else if (frame?.params?.boxsInfo === 1) {
          setTimeout(() => {
            this.emit("message", JSON.stringify({
              result: {
                boxsInfo: {
                  materialBoxs: [{ id: 1, type: 0, state: 1, materials: [{ id: 0, state: 1, selected: 1 }] }],
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
    const ws = new ProbeWs();
    const options = {
      ...parseArgs(createConfirmedF012LiveArgs([
        "--probe-after-delay-ms",
        "0",
        "--probe-after-count",
        "1",
        "--boxsinfo-timeout-ms",
        "1000",
      ])),
      fetchInfo: createF012InfoFetch(),
      openWs: async () => ws,
    };

    const result = await runK2CfsSlotControlCertification(options);

    expect(result).toMatchObject({
      ok: true,
      sent: true,
      status: "post-observed",
      reason: "post-command-telemetry-observed",
      probes: {
        before: {
          status: "observed",
          evidence: {
            path: "$.result.boxsInfo",
          },
        },
        after: {
          status: "observed",
          evidence: {
            path: "$.result.boxsInfo",
          },
        },
      },
    });
    expect(ws.sentFrames).toEqual([
      PRINTER_STATUS_GET_FRAME,
      { method: "get", params: { boxsInfo: 1 } },
      { method: "set", params: { feedInOrOut: { boxId: 1, materialId: 0, isFeed: 1 } } },
      { method: "get", params: { boxsInfo: 1 } },
    ]);
    expect(ws.closed).toBe(true);
    expect(ws.listenerCount("message")).toBe(0);
  });

  it("post-command probeは反映待ちdelay後に送信する", async () => {
    class DelayedAfterProbeWs extends EventEmitter {
      constructor() {
        super();
        this.sentFrames = [];
        this.sentAt = [];
        this.closed = false;
      }

      send(payload, callback) {
        const frame = JSON.parse(payload);
        this.sentFrames.push(frame);
        this.sentAt.push(Date.now());
        if (isPrinterStatusProbeFrame(frame)) {
          emitIdlePrinterStatus(this);
        } else if (frame?.params?.boxsInfo === 1) {
          setTimeout(() => {
            this.emit("message", JSON.stringify({
              result: {
                boxsInfo: {
                  materialBoxs: [{ id: 1, type: 0, materials: [{ id: 0, state: 1, selected: 1 }] }],
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
    const ws = new DelayedAfterProbeWs();
    const options = {
      ...parseArgs(createConfirmedF012LiveArgs([
        "--probe-after-delay-ms",
        "25",
        "--probe-after-count",
        "1",
        "--boxsinfo-timeout-ms",
        "1000",
      ])),
      fetchInfo: createF012InfoFetch(),
      openWs: async () => ws,
    };

    const result = await runK2CfsSlotControlCertification(options);

    expect(result).toMatchObject({
      ok: true,
      status: "post-observed",
      probePlan: {
        postCommandProbeDelayMs: 25,
      },
    });
    expect(ws.sentFrames).toHaveLength(4);
    expect(ws.sentFrames[3]).toEqual({ method: "get", params: { boxsInfo: 1 } });
    expect(ws.sentAt[3] - ws.sentAt[2]).toBeGreaterThanOrEqual(20);
  });

  it("post-command probe count指定時はcommand再送なしでafter観測を複数回採る", async () => {
    class AfterSeriesProbeWs extends EventEmitter {
      constructor() {
        super();
        this.sentFrames = [];
      }

      send(payload, callback) {
        const frame = JSON.parse(payload);
        this.sentFrames.push(frame);
        if (isPrinterStatusProbeFrame(frame)) {
          emitIdlePrinterStatus(this);
        } else if (frame?.params?.boxsInfo === 1) {
          const percent = this.sentFrames.filter((sentFrame) => sentFrame?.params?.boxsInfo === 1).length * 10;
          setTimeout(() => {
            this.emit("message", JSON.stringify({
              result: {
                boxsInfo: {
                  materialBoxs: [{
                    id: 1,
                    type: 0,
                    materials: [{ id: 0, state: 1, selected: 1, percent }],
                  }],
                },
              },
            }));
          }, 1);
        }
        setTimeout(() => callback(), 1);
      }

      close() {}
    }
    const ws = new AfterSeriesProbeWs();
    const options = {
      ...parseArgs(createConfirmedF012LiveArgs([
        "--probe-after-delay-ms",
        "0",
        "--probe-after-count",
        "3",
        "--probe-after-interval-ms",
        "100",
        "--boxsinfo-timeout-ms",
        "1000",
      ])),
      fetchInfo: createF012InfoFetch(),
      openWs: async () => ws,
    };

    const result = await runK2CfsSlotControlCertification(options);

    expect(result).toMatchObject({
      ok: true,
      status: "post-observed",
      probes: {
        afterSeries: [
          { status: "observed", probeMode: "after:1" },
          { status: "observed", probeMode: "after:2" },
          { status: "observed", probeMode: "after:3" },
        ],
        after: {
          status: "observed",
          probeMode: "after:1",
        },
      },
    });
    expect(result.probes.afterSeries.map((probe) => probe.observedAt))
      .toEqual([
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      ]);
    expect(ws.sentFrames).toEqual([
      PRINTER_STATUS_GET_FRAME,
      { method: "get", params: { boxsInfo: 1 } },
      { method: "set", params: { feedInOrOut: { boxId: 1, materialId: 0, isFeed: 1 } } },
      { method: "get", params: { boxsInfo: 1 } },
      { method: "get", params: { boxsInfo: 1 } },
      { method: "get", params: { boxsInfo: 1 } },
    ]);
  });

  it("post-command probe series途中timeoutでもcommand再送なしで残りのread-only probeを続ける", async () => {
    class PartialTimeoutAfterSeriesProbeWs extends EventEmitter {
      constructor() {
        super();
        this.sentFrames = [];
      }

      send(payload, callback) {
        const frame = JSON.parse(payload);
        this.sentFrames.push(frame);
        const boxsInfoProbeCount = this.sentFrames.filter((sentFrame) => sentFrame?.params?.boxsInfo === 1).length;
        if (isPrinterStatusProbeFrame(frame)) {
          emitIdlePrinterStatus(this);
        } else if (frame?.params?.boxsInfo === 1 && boxsInfoProbeCount <= 2) {
          setTimeout(() => {
            this.emit("message", JSON.stringify({
              result: {
                boxsInfo: {
                  materialBoxs: [{
                    id: 1,
                    type: 0,
                    materials: [{ id: 0, state: 1, selected: 1, percent: 10 }],
                  }],
                },
              },
            }));
          }, 1);
        }
        setTimeout(() => callback(), 1);
      }

      close() {}
    }
    const ws = new PartialTimeoutAfterSeriesProbeWs();
    const options = {
      ...parseArgs(createConfirmedF012LiveArgs([
        "--probe-after-delay-ms",
        "0",
        "--probe-after-count",
        "3",
      ])),
      boxsInfoTimeoutMs: 5,
      postCommandProbeIntervalMs: 0,
      fetchInfo: createF012InfoFetch(),
      openWs: async () => ws,
    };

    const result = await runK2CfsSlotControlCertification(options);

    expect(result).toMatchObject({
      ok: false,
      sent: true,
      status: "unknown",
      reason: "post-command-observation-failed",
      probes: {
        after: {
          status: "observed",
          probeMode: "after:1",
        },
        afterSeries: [
          { status: "observed", probeMode: "after:1" },
          { status: "timeout", probeMode: "after:2", observedAt: null },
          { status: "timeout", probeMode: "after:3", observedAt: null },
        ],
      },
      probeAttemptCount: 4,
      observedProbeCount: 2,
      failedProbeCount: 2,
    });
    expect(result.probes.afterSeries[1].completedAt)
      .toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u));
    expect(ws.sentFrames).toEqual([
      PRINTER_STATUS_GET_FRAME,
      { method: "get", params: { boxsInfo: 1 } },
      { method: "set", params: { feedInOrOut: { boxId: 1, materialId: 0, isFeed: 1 } } },
      { method: "get", params: { boxsInfo: 1 } },
      { method: "get", params: { boxsInfo: 1 } },
      { method: "get", params: { boxsInfo: 1 } },
    ]);
  });

  it("post-command probe seriesで途中timeout後に復帰してもunknownのままにする", async () => {
    class RecoveredAfterTimeoutProbeWs extends EventEmitter {
      constructor() {
        super();
        this.sentFrames = [];
      }

      send(payload, callback) {
        const frame = JSON.parse(payload);
        this.sentFrames.push(frame);
        const boxsInfoProbeCount = this.sentFrames.filter((sentFrame) => sentFrame?.params?.boxsInfo === 1).length;
        if (isPrinterStatusProbeFrame(frame)) {
          emitIdlePrinterStatus(this);
        } else if (frame?.params?.boxsInfo === 1 && boxsInfoProbeCount !== 3) {
          setTimeout(() => {
            this.emit("message", JSON.stringify({
              result: {
                boxsInfo: {
                  materialBoxs: [{
                    id: 1,
                    type: 0,
                    materials: [{ id: 0, state: 1, selected: 1, percent: boxsInfoProbeCount }],
                  }],
                },
              },
            }));
          }, 1);
        }
        setTimeout(() => callback(), 1);
      }

      close() {}
    }
    const ws = new RecoveredAfterTimeoutProbeWs();
    const options = {
      ...parseArgs(createConfirmedF012LiveArgs([
        "--probe-after-delay-ms",
        "0",
        "--probe-after-count",
        "3",
      ])),
      boxsInfoTimeoutMs: 5,
      postCommandProbeIntervalMs: 0,
      fetchInfo: createF012InfoFetch(),
      openWs: async () => ws,
    };

    const result = await runK2CfsSlotControlCertification(options);

    expect(result).toMatchObject({
      ok: false,
      sent: true,
      status: "unknown",
      reason: "post-command-observation-failed",
      probes: {
        afterSeries: [
          { status: "observed", probeMode: "after:1" },
          { status: "timeout", probeMode: "after:2" },
          { status: "observed", probeMode: "after:3" },
        ],
      },
      probeAttemptCount: 4,
      observedProbeCount: 3,
      failedProbeCount: 1,
    });
    expect(result.targetSourceDelta).toMatchObject({
      observed: true,
      afterProbe: "after:3",
      changedFields: ["percent"],
    });
    expect(ws.sentFrames.filter((frame) => frame?.method === "set")).toHaveLength(1);
  });

  it("command送信後のprobe timeoutは送信証跡を保持したunknown結果として返す", async () => {
    class TimeoutAfterProbeWs extends EventEmitter {
      constructor() {
        super();
        this.sentFrames = [];
        this.closed = false;
      }

      send(payload, callback) {
        const frame = JSON.parse(payload);
        this.sentFrames.push(frame);
        const boxsInfoProbeCount = this.sentFrames.filter((sentFrame) => sentFrame?.params?.boxsInfo === 1).length;
        if (isPrinterStatusProbeFrame(frame)) {
          emitIdlePrinterStatus(this);
        } else if (frame?.params?.boxsInfo === 1 && boxsInfoProbeCount === 1) {
          setTimeout(() => {
            this.emit("message", JSON.stringify({
              result: {
                boxsInfo: {
                  materialBoxs: [{ id: 1, type: 0, state: 1, materials: [{ id: 0, state: 1, selected: 1 }] }],
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
    const ws = new TimeoutAfterProbeWs();
    const options = {
      ...parseArgs(createConfirmedF012LiveArgs([
        "--probe-after-delay-ms",
        "0",
        "--boxsinfo-timeout-ms",
        "1000",
        "--probe-after-count",
        "1",
      ])),
      fetchInfo: createF012InfoFetch(),
      openWs: async () => ws,
    };

    const result = await runK2CfsSlotControlCertification(options);

    expect(result).toMatchObject({
      ok: false,
      sent: true,
      dryRun: false,
      status: "unknown",
      reason: "post-command-observation-failed",
      blindRetryAllowed: false,
      response: {
        status: "submitted",
        sentFrameCount: 1,
      },
      probes: {
        before: {
          status: "observed",
        },
        after: {
          status: "timeout",
          probeMode: "after",
        },
      },
    });
    expect(result.probes.after.message).toContain("boxsInfo probe timeout");
    expect(ws.sentFrames).toEqual([
      PRINTER_STATUS_GET_FRAME,
      { method: "get", params: { boxsInfo: 1 } },
      { method: "set", params: { feedInOrOut: { boxId: 1, materialId: 0, isFeed: 1 } } },
      { method: "get", params: { boxsInfo: 1 } },
    ]);
    expect(ws.closed).toBe(true);
    expect(ws.listenerCount("message")).toBe(0);
  });

  it("command送信前のprobe timeoutではCFS操作frameを送らない", async () => {
    class TimeoutBeforeProbeWs extends EventEmitter {
      constructor() {
        super();
        this.sentFrames = [];
        this.closed = false;
      }

      send(payload, callback) {
        const frame = JSON.parse(payload);
        this.sentFrames.push(frame);
        if (isPrinterStatusProbeFrame(frame)) {
          emitIdlePrinterStatus(this);
        }
        setTimeout(() => callback(), 1);
      }

      close() {
        this.closed = true;
      }
    }
    const ws = new TimeoutBeforeProbeWs();
    const options = {
      ...parseArgs(createConfirmedF012LiveArgs()),
      boxsInfoTimeoutMs: 5,
      fetchInfo: createF012InfoFetch(),
      openWs: async () => ws,
    };

    const result = await runK2CfsSlotControlCertification(options);

    expect(result).toMatchObject({
      ok: false,
      sent: false,
      dryRun: false,
      status: "rejected",
      reason: "pre-command-observation-failed",
      blindRetryAllowed: false,
      response: null,
      probes: {
        before: {
          status: "timeout",
          probeMode: "before",
        },
        after: null,
      },
    });
    expect(ws.sentFrames).toEqual([
      PRINTER_STATUS_GET_FRAME,
      { method: "get", params: { boxsInfo: 1 } },
    ]);
    expect(ws.closed).toBe(true);
    expect(ws.listenerCount("message")).toBe(0);
  });

  it("--output-dir指定時はcertification resultをtimestamp付きdirectoryへ保存する", async () => {
    const outputRoot = await mkdtemp(path.join(os.tmpdir(), "3dpmon-cfs-cert-"));
    try {
      const options = {
        ...parseArgs([
          "--command",
          "cfs-load",
          "--source",
          "cfs:1:slot:0",
          "--output-dir",
          outputRoot,
        ]),
      };

      const result = await runK2CfsSlotControlCertification(options);

      expect(result.evidence).toMatchObject({
        written: true,
      });
      expect(result.evidence.directory).toContain(outputRoot);
      expect(result.evidence.files).toEqual(["certification-result.json"]);
      const saved = JSON.parse(await readFile(
        path.join(result.evidence.directory, "certification-result.json"),
        "utf8",
      ));
      expect(saved).toMatchObject({
        ok: true,
        sent: false,
        dryRun: true,
        evidence: {
          written: true,
        },
      });
      expect(saved.evidence.directory).toBe(result.evidence.directory);
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("command送信後のoutput-dir保存失敗は物理command結果を保持したままevidence失敗として返す", async () => {
    class SubmittedCommandWs extends EventEmitter {
      constructor() {
        super();
        this.sentFrames = [];
      }

      send(payload, callback) {
        const frame = JSON.parse(payload);
        this.sentFrames.push(frame);
        if (isPrinterStatusProbeFrame(frame)) {
          emitIdlePrinterStatus(this);
        } else if (frame?.params?.boxsInfo === 1) {
          setTimeout(() => {
            this.emit("message", JSON.stringify({
              result: {
                boxsInfo: {
                  materialBoxs: [{ id: 1, type: 0, materials: [{ id: 0, state: 1, selected: 1 }] }],
                },
              },
            }));
          }, 1);
        }
        setTimeout(() => callback(), 1);
      }

      close() {}
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "3dpmon-cfs-cert-evidence-fail-"));
    try {
      const fileAsOutputDir = path.join(root, "not-a-directory");
      await writeFile(fileAsOutputDir, "blocks mkdir", "utf8");
      const ws = new SubmittedCommandWs();
      const options = {
        ...parseArgs(createConfirmedF012LiveArgs([
          "--probe-after-count",
          "1",
          "--output-dir",
          fileAsOutputDir,
        ])),
        fetchInfo: createF012InfoFetch(),
        openWs: async () => ws,
      };

      const result = await runK2CfsSlotControlCertification(options);

      expect(result).toMatchObject({
        ok: false,
        sent: true,
        dryRun: false,
        status: "post-observed",
        evidenceWriteFailed: true,
        evidence: {
          written: false,
        },
        commandResult: {
          ok: true,
          sent: true,
          status: "post-observed",
          reason: "post-command-telemetry-observed",
        },
      });
      expect(result.evidence.error.message).toMatch(/ENOTDIR|EEXIST|not a directory|file already exists/iu);
      expect(ws.sentFrames).toEqual([
        PRINTER_STATUS_GET_FRAME,
        { method: "get", params: { boxsInfo: 1 } },
        { method: "set", params: { feedInOrOut: { boxId: 1, materialId: 0, isFeed: 1 } } },
        { method: "get", params: { boxsInfo: 1 } },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
