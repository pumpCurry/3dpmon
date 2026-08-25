/**
 * @fileoverview K2 CFS print-start certification CLI の単体テスト
 * @description
 * - CLIが既定dry-runで、明示 `--send` なしに実機送信へ進まないことを検証する。
 *
 * @version 1.390.1385 (PR #432)
 * @since 1.390.1385 (PR #432)
 * @lastModified 2026-08-26 09:45:00
 */

import { describe, expect, it } from "vitest";
import {
  buildK2CfsPrintStartRequest,
  parseArgs,
  parseToolAssignmentOption,
  runK2CfsPrintStartCertification,
} from "../../scripts/capture_k2_cfs_print_start.mjs";

describe("capture_k2_cfs_print_start", () => {
  it("assignment指定をtool alias / CFS source / material evidenceへ解析する", () => {
    expect(parseToolAssignmentOption("T1C,cfs:1:slot:2,PLA,#09ea7ae")).toEqual({
      protocolToolAlias: "T1C",
      materialSourceId: "cfs:1:slot:2",
      protocol: {
        type: "PLA",
        color: "09ea7ae",
      },
    });
  });

  it("既定ではdry-runとして送信せずtransport planだけを返す", async () => {
    const options = parseArgs([
      "--file-path",
      "/mnt/UDISK/printer_data/gcodes/benchy.gcode",
      "--assignment",
      "T1C,cfs:1:slot:2,PLA,09ea7ae",
    ]);

    const result = await runK2CfsPrintStartCertification(options);

    expect(options.send).toBe(false);
    expect(result).toMatchObject({
      ok: true,
      sent: false,
      dryRun: true,
      plan: {
        ok: true,
      },
    });
    expect(result.plan.frames).toHaveLength(2);
    expect(result.plan.frames[0].params).toHaveProperty("colorMatch");
    expect(result.plan.frames[1].params).toHaveProperty("multiColorPrint");
  });

  it("--send指定時だけhostを必須にする", () => {
    expect(() => parseArgs([
      "--send",
      "--file-path",
      "/mnt/UDISK/printer_data/gcodes/benchy.gcode",
      "--assignment",
      "T1A,cfs:1:slot:0,PLA,ffffff",
    ])).toThrow("--host is required");
  });

  it("external source assignmentはdry-run段階でも拒否結果になる", async () => {
    const options = parseArgs([
      "--file-path",
      "/mnt/UDISK/printer_data/gcodes/benchy.gcode",
      "--assignment",
      "T1A,external:0:slot:0,PLA,ffffff",
    ]);

    const result = await runK2CfsPrintStartCertification(options);

    expect(result).toMatchObject({
      ok: false,
      sent: false,
      plan: {
        ok: false,
        reason: "external-source-print-start-not-certified",
      },
    });
  });

  it("複数assignmentはmulticolor-cfs requestへする", () => {
    const options = parseArgs([
      "--file-path",
      "/mnt/UDISK/printer_data/gcodes/4c.gcode",
      "--assignment",
      "T1A,cfs:1:slot:0,PLA,ffffff",
      "--assignment",
      "T1B,cfs:1:slot:1,PLA,72a530",
    ]);
    const request = buildK2CfsPrintStartRequest(options);

    expect(request.payload.planKind).toBe("multicolor-cfs");
    expect(request.payload.toolAssignments).toEqual([
      {
        toolId: 0,
        protocolToolAlias: "T1A",
        materialSourceId: "cfs:1:slot:0",
        protocol: {
          type: "PLA",
          color: "ffffff",
        },
      },
      {
        toolId: 1,
        protocolToolAlias: "T1B",
        materialSourceId: "cfs:1:slot:1",
        protocol: {
          type: "PLA",
          color: "72a530",
        },
      },
    ]);
  });
});
