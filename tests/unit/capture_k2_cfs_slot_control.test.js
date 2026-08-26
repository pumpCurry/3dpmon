/**
 * @fileoverview K2 CFS slot control certification CLI の単体テスト
 * @description
 * - CLIが既定dry-runで、明示 `--send` なしに実機送信へ進まないことを検証する。
 * - certification-only planがlive確認なしに送信されないことを検証する。
 * - live certification用のread-only boxsInfo probeが送信前後で安全に待機できることを検証する。
 *
 * @version 1.390.1419 (PR #435)
 * @since 1.390.1415 (PR #435)
 * @lastModified 2026-08-27 06:18:00
 */

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  buildK2CfsSlotControlRequest,
  findBoxsInfoEvidence,
  parseArgs,
  runK2CfsSlotControlCertification,
  sendBoxsInfoProbeAndWait,
} from "../../scripts/capture_k2_cfs_slot_control.mjs";

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
      boxsInfoTimeoutMs: 5000,
    });
  });

  it("--send指定時だけhost/live/host一致/command一致を必須にする", () => {
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
    expect(parseArgs([
      ...baseArgs,
      "--confirm-live",
      "--confirm-host",
      "192.168.54.153",
      "--confirm-command",
      "cfs-load",
      "--probe-before",
      "--probe-after",
      "--boxsinfo-timeout-ms",
      "1500",
    ])).toMatchObject({
      send: true,
      confirmLive: true,
      confirmHost: "192.168.54.153",
      confirmCommand: "cfs-load",
      probeBefore: true,
      probeAfter: true,
      boxsInfoTimeoutMs: 1500,
    });
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
    const sentFrames = [];
    let closeCalled = false;
    const ws = {
      send(payload, callback) {
        sentFrames.push(JSON.parse(payload));
        setTimeout(() => callback(), 1);
      },
      close() {
        closeCalled = true;
      },
    };
    const options = {
      ...parseArgs([
        "--send",
        "--host",
        "192.168.54.153",
        "--confirm-live",
        "--confirm-host",
        "192.168.54.153",
        "--confirm-command",
        "cfs-unload",
        "--command",
        "cfs-unload",
        "--source",
        "cfs:1:slot:0",
      ]),
      openWs: async () => ws,
    };

    const result = await runK2CfsSlotControlCertification(options);

    expect(result).toMatchObject({
      ok: true,
      sent: true,
      dryRun: false,
      response: {
        status: "submitted",
        sentFrameCount: 1,
      },
    });
    expect(sentFrames).toEqual([
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
    ]);
    expect(closeCalled).toBe(true);
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

  it("read-only boxsInfo probeは応答を待ち、timeout時はlistenerを残さない", async () => {
    class MockWs extends EventEmitter {
      send(payload, callback) {
        this.sentPayload = payload;
        setTimeout(() => {
          this.emit("message", JSON.stringify({
            result: {
              boxsInfo: {
                materialBoxs: [{ id: 1, materials: [] }],
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
    expect(result.evidence.path).toBe("$.result.boxsInfo");
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
        if (frame?.params?.boxsInfo === 1) {
          setTimeout(() => {
            this.emit("message", JSON.stringify({
              result: {
                boxsInfo: {
                  materialBoxs: [{ id: 1, state: 1 }],
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
      ...parseArgs([
        "--send",
        "--host",
        "192.168.54.153",
        "--confirm-live",
        "--confirm-host",
        "192.168.54.153",
        "--confirm-command",
        "cfs-load",
        "--command",
        "cfs-load",
        "--source",
        "cfs:1:slot:0",
        "--probe-before",
        "--probe-after",
        "--boxsinfo-timeout-ms",
        "1000",
      ]),
      openWs: async () => ws,
    };

    const result = await runK2CfsSlotControlCertification(options);

    expect(result).toMatchObject({
      ok: true,
      sent: true,
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
      { method: "get", params: { boxsInfo: 1 } },
      { method: "set", params: { feedInOrOut: { boxId: 1, materialId: 0, isFeed: 1 } } },
      { method: "get", params: { boxsInfo: 1 } },
    ]);
    expect(ws.closed).toBe(true);
    expect(ws.listenerCount("message")).toBe(0);
  });
});
