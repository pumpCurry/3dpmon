/**
 * @fileoverview K2 CFS slot control certification CLI の単体テスト
 * @description
 * - CLIが既定dry-runで、明示 `--send` なしに実機送信へ進まないことを検証する。
 * - certification-only planがlive確認なしに送信されないことを検証する。
 *
 * @version 1.390.1415 (PR #435)
 * @since 1.390.1415 (PR #435)
 * @lastModified 2026-08-27 05:32:29
 */

import { describe, expect, it } from "vitest";
import {
  buildK2CfsSlotControlRequest,
  parseArgs,
  runK2CfsSlotControlCertification,
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
    expect(parseArgs([
      ...baseArgs,
      "--confirm-live",
      "--confirm-host",
      "192.168.54.153",
      "--confirm-command",
      "cfs-load",
    ])).toMatchObject({
      send: true,
      confirmLive: true,
      confirmHost: "192.168.54.153",
      confirmCommand: "cfs-load",
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
});
