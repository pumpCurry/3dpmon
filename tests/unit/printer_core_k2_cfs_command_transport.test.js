/**
 * @fileoverview Printer Core v3 K2 CFS command transport の単体テスト
 * @description
 * - K2/CFS print-start が `colorMatch` と `multiColorPrint` の明示frameへ変換されることを検証する。
 * - 未certifiedのslot操作や外部スプールfallbackが送信計画へ進まないことを検証する。
 *
 * @version 1.390.1388 (PR #432)
 * @since 1.390.1384 (PR #432)
 * @lastModified 2026-08-26 01:05:00
 */

import { describe, expect, it, vi } from "vitest";
import {
  K2_CFS_PRINT_START_TRANSPORT_PROFILE,
  createK2CfsCommandTransportPlan,
  sendK2CfsCommandTransportPlan,
} from "../../3dp_lib/printer_core/dashboard_k2_cfs_command_transport.js";

/**
 * K2/CFS print-start request を生成する。
 *
 * 【詳細説明】
 * - PrintPlan moduleの公開payload shapeに合わせ、transport mappingに必要なasset/tool assignmentだけを持つ。
 *
 * @function createPrintStartRequest
 * @param {object=} overrides - request override
 * @returns {object} Printer Core command request風object
 */
function createPrintStartRequest(overrides = {}) {
  return {
    commandKind: "print-start",
    transportKind: "ws9999",
    payload: {
      printPlanId: "print-plan:k2-cfs",
      planKind: "multicolor-cfs",
      asset: {
        path: "/mnt/UDISK/printer_data/gcodes/benchy.gcode",
      },
      toolAssignments: [
        {
          toolId: 0,
          protocolToolAlias: "T1A",
          materialSourceId: "cfs:1:slot:0",
          protocol: {
            type: "PLA",
            color: "0ffffff",
          },
        },
        {
          toolId: 1,
          protocolToolAlias: "T1B",
          materialSourceId: "cfs:1:slot:1",
          protocol: {
            type: "PLA",
            color: "072a530",
          },
        },
      ],
      startOptions: {
        enableSelfTest: 1,
      },
    },
    ...overrides,
  };
}

describe("Printer Core v3 K2 CFS command transport", () => {
  it("CFS print-startをcolorMatchとmultiColorPrintの順序付きWS9999 frameへ変換する", () => {
    const plan = createK2CfsCommandTransportPlan(createPrintStartRequest());

    expect(plan).toMatchObject({
      ok: true,
      transportKind: "ws9999",
      profile: K2_CFS_PRINT_START_TRANSPORT_PROFILE,
      details: {
        printPlanId: "print-plan:k2-cfs",
        materialSupply: "cfs",
        assignmentCount: 2,
      },
    });
    expect(plan.details.assignmentEvidence).toEqual([
      {
        protocolToolAlias: "T1A",
        sourceId: "cfs:1:slot:0",
        type: "PLA",
        typeProvenance: "assignment.protocol.type",
        color: "0ffffff",
        colorProvenance: "assignment.protocol.color",
        boxId: 1,
        materialId: 0,
      },
      {
        protocolToolAlias: "T1B",
        sourceId: "cfs:1:slot:1",
        type: "PLA",
        typeProvenance: "assignment.protocol.type",
        color: "072a530",
        colorProvenance: "assignment.protocol.color",
        boxId: 1,
        materialId: 1,
      },
    ]);
    expect(plan.frames).toEqual([
      {
        method: "set",
        params: {
          colorMatch: {
            path: "/mnt/UDISK/printer_data/gcodes/benchy.gcode",
            list: [
              { id: "T1A", type: "PLA", color: "0ffffff", boxId: 1, materialId: 0 },
              { id: "T1B", type: "PLA", color: "072a530", boxId: 1, materialId: 1 },
            ],
          },
        },
      },
      {
        method: "set",
        params: {
          multiColorPrint: {
            gcode: "/mnt/UDISK/printer_data/gcodes/benchy.gcode",
            enableSelfTest: 1,
          },
        },
      },
    ]);
    expect(JSON.stringify(plan.frames)).not.toContain("opGcodeFile");
  });

  it("printprt prefix付きasset pathもK2 colorMatch用のprinter-local pathへ正規化する", () => {
    const plan = createK2CfsCommandTransportPlan(createPrintStartRequest({
      payload: {
        ...createPrintStartRequest().payload,
        asset: {
          path: "printprt:/mnt/UDISK/printer_data/gcodes/benchy.gcode",
        },
      },
    }));

    expect(plan.ok).toBe(true);
    expect(plan.frames[0].params.colorMatch.path).toBe("/mnt/UDISK/printer_data/gcodes/benchy.gcode");
    expect(plan.frames[1].params.multiColorPrint.gcode).toBe("/mnt/UDISK/printer_data/gcodes/benchy.gcode");
  });

  it("外部スプールへ向くPrintPlanはopGcodeFile fallbackを生成せず拒否する", () => {
    const request = createPrintStartRequest({
      payload: {
        ...createPrintStartRequest().payload,
        toolAssignments: [{
          toolId: 0,
          protocolToolAlias: "T1A",
          materialSourceId: "external:0:slot:0",
          protocol: {
            type: "PLA",
            color: "ffffff",
          },
        }],
      },
    });
    const plan = createK2CfsCommandTransportPlan(request);

    expect(plan).toMatchObject({
      ok: false,
      reason: "external-source-print-start-not-certified",
    });
    expect(plan.frames).toEqual([]);
  });

  it("材料type/color証拠が足りないassignmentは送信計画にしない", () => {
    const request = createPrintStartRequest({
      payload: {
        ...createPrintStartRequest().payload,
        toolAssignments: [{
          toolId: 0,
          protocolToolAlias: "T1A",
          materialSourceId: "cfs:1:slot:0",
        }],
      },
    });
    const plan = createK2CfsCommandTransportPlan(request);

    expect(plan).toMatchObject({
      ok: false,
      reason: "missing-material-protocol-evidence",
    });
  });

  it("未certifiedのCFS slot操作はtransport frame生成前に拒否する", () => {
    const plan = createK2CfsCommandTransportPlan({
      commandKind: "cfs-slot-select",
      payload: {
        sourceId: "cfs:1:slot:2",
      },
    });

    expect(plan).toMatchObject({
      ok: false,
      reason: "uncertified-cfs-slot-command",
      details: {
        commandKind: "cfs-slot-select",
      },
    });
    expect(plan.frames).toEqual([]);
  });

  it("transport planはcolorMatchからmultiColorPrintへ逐次送信する", async () => {
    const plan = createK2CfsCommandTransportPlan(createPrintStartRequest());
    const sendFrame = vi.fn(async (frame, meta) => ({
      status: "submitted",
      frame,
      meta,
    }));

    const response = await sendK2CfsCommandTransportPlan(plan, sendFrame);

    expect(sendFrame).toHaveBeenCalledTimes(2);
    expect(sendFrame.mock.calls[0][0].params).toHaveProperty("colorMatch");
    expect(sendFrame.mock.calls[0][1]).toEqual({
      index: 0,
      profile: K2_CFS_PRINT_START_TRANSPORT_PROFILE,
      frameCount: 2,
    });
    expect(sendFrame.mock.calls[1][0].params).toHaveProperty("multiColorPrint");
    expect(response).toMatchObject({
      status: "submitted",
      protocolCommandId: null,
      correlationEvidence: {
        kind: "none",
        reason: "no-protocol-response-id",
      },
      sentFrameCount: 2,
    });
  });

  it("protocol response IDが実際に返った場合だけcorrelation evidenceへ採用する", async () => {
    const plan = createK2CfsCommandTransportPlan(createPrintStartRequest());
    const sendFrame = vi.fn(async (frame, meta) => ({
      status: "acknowledged",
      protocolResponseId: `response:${meta.index}`,
      frame,
    }));

    const response = await sendK2CfsCommandTransportPlan(plan, sendFrame);

    expect(response).toMatchObject({
      status: "acknowledged",
      protocolCommandId: null,
      protocolFrameIds: ["response:0", "response:1"],
      correlationEvidence: {
        kind: "protocol-response",
        complete: true,
      },
    });
  });

  it("frame responseが失敗または未知statusなら次frameへ進めない", async () => {
    const plan = createK2CfsCommandTransportPlan(createPrintStartRequest());
    const sendFrame = vi.fn(async () => ({
      status: "failed",
      error: "boom",
    }));

    await expect(sendK2CfsCommandTransportPlan(plan, sendFrame))
      .rejects
      .toThrow("frame-response-error");
    expect(sendFrame).toHaveBeenCalledTimes(1);
  });

  it("拒否されたtransport planは送信hookを呼ばない", async () => {
    const sendFrame = vi.fn();
    const plan = createK2CfsCommandTransportPlan({
      commandKind: "cfs-unload",
      payload: {
        sourceId: "cfs:1:slot:2",
      },
    });

    await expect(sendK2CfsCommandTransportPlan(plan, sendFrame))
      .rejects
      .toThrow("uncertified-cfs-slot-command");
    expect(sendFrame).not.toHaveBeenCalled();
  });
});
