/**
 * @fileoverview K2 CFS slot control certification CLI の単体テスト
 * @description
 * - CLIが既定dry-runで、明示 `--send` なしに実機送信へ進まないことを検証する。
 * - certification-only planがlive確認なしに送信されないことを検証する。
 * - live certification用のread-only boxsInfo probeが送信前後で安全に待機できることを検証する。
 *
 * @version 1.390.1526 (PR #439)
 * @since 1.390.1415 (PR #435)
 * @lastModified 2026-08-31 16:32:06
 */

import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
      status: "submitted",
      reason: "post-command-observation-not-requested",
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
    }));
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
      status: "confirmed",
      reason: null,
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
        if (frame?.params?.boxsInfo === 1 && this.sentFrames.length === 1) {
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
    const ws = new TimeoutAfterProbeWs();
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
        this.sentFrames.push(JSON.parse(payload));
        setTimeout(() => callback(), 1);
      }

      close() {
        this.closed = true;
      }
    }
    const ws = new TimeoutBeforeProbeWs();
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
      ]),
      boxsInfoTimeoutMs: 5,
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
});
