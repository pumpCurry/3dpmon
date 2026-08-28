/**
 * @fileoverview Printer Core v3 K2 CFS command transport の単体テスト
 * @description
 * - K2/CFS print-start が `colorMatch` と `multiColorPrint` の明示frameへ変換されることを検証する。
 * - 未certifiedのslot操作や外部スプールfallbackが送信計画へ進まないことを検証する。
 * - Gate 19 certification-only planが通常送信経路へ混入しないことを検証する。
 *
 * @version 1.390.1448 (PR #435)
 * @since 1.390.1384 (PR #432)
 * @lastModified 2026-08-28 20:35:00
 */

import { describe, expect, it, vi } from "vitest";
import {
  K2_CFS_PRINT_START_TRANSPORT_PROFILE,
  K2_CFS_SLOT_CONTROL_PRODUCTION_TRANSPORT_PROFILE,
  K2_CFS_SLOT_CONTROL_CERTIFICATION_TRANSPORT_PROFILE,
  createK2CfsCommandTransportPlan,
  sendK2CfsCommandTransportPlan,
} from "../../3dp_lib/printer_core/dashboard_k2_cfs_command_transport.js";

/**
 * Gate 19 production CFS slot control 用の実機certification evidenceを生成する。
 *
 * 【詳細説明】
 * - transport profile、command kind、機種、firmware、capture ID を明示し、空objectや別profileを
 *   production昇格へ使えないことを検証しやすくする。
 *
 * @function createCertifiedCfsEvidence
 * @param {object=} overrides - evidence override
 * @returns {object} certification evidence
 */
function createCertifiedCfsEvidence(overrides = {}) {
  return {
    schemaVersion: 1,
    status: "certified",
    gate: "Gate 19",
    commandKinds: ["cfs-load"],
    transportProfile: K2_CFS_SLOT_CONTROL_PRODUCTION_TRANSPORT_PROFILE,
    printerType: "creality-k2",
    model: "F012",
    firmwareVersion: "1.0.0",
    fixtureId: "k2-f012-feed-in-or-out-20260828",
    captureId: "capture:k2-f012-cfs-load-1c-20260828",
    certifiedAt: "2026-08-28T12:00:00.000+09:00",
    ...overrides,
  };
}

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

  it("Gate 19明示opt-in時だけfeedInOrOutのcertification-only planを生成する", () => {
    const plan = createK2CfsCommandTransportPlan({
      commandKind: "cfs-load",
      payload: {
        sourceId: "cfs:1:slot:2",
      },
    }, {
      allowUncertifiedCfsSlotCommandCandidates: true,
    });

    expect(plan).toMatchObject({
      ok: true,
      profile: K2_CFS_SLOT_CONTROL_CERTIFICATION_TRANSPORT_PROFILE,
      certificationOnly: true,
      requiresLiveConfirmation: true,
      details: {
        commandKind: "cfs-load",
        sourceId: "cfs:1:slot:2",
        boxId: 1,
        materialId: 2,
        candidateOperation: "feed-in-or-load",
        semanticStatus: "uncertified",
        liveCertificationAllowed: true,
        productionEnabled: false,
      },
    });
    expect(plan.frames).toEqual([
      {
        method: "set",
        params: {
          feedInOrOut: {
            boxId: 1,
            materialId: 2,
            isFeed: 1,
          },
        },
      },
    ]);
  });

  it("caller supplied evidenceだけではslot操作をproduction planへ昇格しない", () => {
    const plan = createK2CfsCommandTransportPlan({
      commandKind: "cfs-load",
      payload: {
        sourceId: "cfs:1:slot:2",
      },
    }, {
      certifiedCfsSlotControlCommands: ["cfs-load"],
      certificationEvidence: createCertifiedCfsEvidence(),
      certificationScope: {
        printerType: "creality-k2",
        model: "F012",
        firmwareVersion: "1.0.0",
      },
    });

    expect(plan).toMatchObject({
      ok: false,
      reason: "invalid-cfs-slot-certification-evidence",
      details: {
        commandKind: "cfs-load",
      },
    });
    expect(plan.details.errors).toContain("certification-evidence-not-registered");
    expect(plan.frames).toEqual([]);
  });

  it("factoryが返すtransport planは生成後にframeやdetailsを書き換えられない", () => {
    const plan = createK2CfsCommandTransportPlan({
      commandKind: "cfs-load",
      payload: {
        sourceId: "cfs:1:slot:2",
      },
    }, {
      allowUncertifiedCfsSlotCommandCandidates: true,
    });

    expect(plan.ok).toBe(true);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.frames)).toBe(true);
    expect(Object.isFrozen(plan.frames[0])).toBe(true);
    expect(Object.isFrozen(plan.frames[0].params.feedInOrOut)).toBe(true);
    expect(Object.isFrozen(plan.details)).toBe(true);
    expect(() => {
      plan.frames[0].params.feedInOrOut.isFeed = 0;
    }).toThrow(TypeError);
    expect(plan.frames[0].params.feedInOrOut.isFeed).toBe(1);
  });

  it("production昇格は現在targetのprinter/model/firmware scopeが未観測なら拒否する", () => {
    const plan = createK2CfsCommandTransportPlan({
      commandKind: "cfs-load",
      payload: {
        sourceId: "cfs:1:slot:2",
      },
    }, {
      certifiedCfsSlotControlCommands: ["cfs-load"],
      certificationEvidence: createCertifiedCfsEvidence(),
      certificationScope: {
        printerType: "creality-k2",
      },
    });

    expect(plan).toMatchObject({
      ok: false,
      reason: "invalid-cfs-slot-certification-evidence",
    });
    expect(plan.details.errors).toEqual(expect.arrayContaining([
      "model-scope-missing-or-mismatch",
      "firmware-scope-missing-or-mismatch",
    ]));
  });

  it("production昇格は空objectや配列のcertification evidenceを拒否する", () => {
    const createPlan = (certificationEvidence) => createK2CfsCommandTransportPlan({
      commandKind: "cfs-load",
      payload: {
        sourceId: "cfs:1:slot:2",
      },
    }, {
      certifiedCfsSlotControlCommands: ["cfs-load"],
      certificationEvidence,
    });

    expect(createPlan({})).toMatchObject({
      ok: false,
      reason: "invalid-cfs-slot-certification-evidence",
    });
    expect(createPlan([])).toMatchObject({
      ok: false,
      reason: "invalid-cfs-slot-certification-evidence",
    });
  });

  it("production昇格はcommand kindとtransport profileが一致するcertification evidenceだけ許可する", () => {
    const wrongCommandPlan = createK2CfsCommandTransportPlan({
      commandKind: "cfs-load",
      payload: {
        sourceId: "cfs:1:slot:2",
      },
    }, {
      certifiedCfsSlotControlCommands: ["cfs-load"],
      certificationEvidence: createCertifiedCfsEvidence({
        commandKinds: ["cfs-unload"],
      }),
    });
    const wrongProfilePlan = createK2CfsCommandTransportPlan({
      commandKind: "cfs-load",
      payload: {
        sourceId: "cfs:1:slot:2",
      },
    }, {
      certifiedCfsSlotControlCommands: ["cfs-load"],
      certificationEvidence: createCertifiedCfsEvidence({
        transportProfile: "k2-ws9999-other-profile",
      }),
    });

    expect(wrongCommandPlan).toMatchObject({
      ok: false,
      reason: "invalid-cfs-slot-certification-evidence",
    });
    expect(wrongProfilePlan).toMatchObject({
      ok: false,
      reason: "invalid-cfs-slot-certification-evidence",
    });
  });

  it("certified registryに無いslot操作はproduction option付きでも拒否を維持する", () => {
    const plan = createK2CfsCommandTransportPlan({
      commandKind: "cfs-unload",
      payload: {
        sourceId: "cfs:1:slot:2",
      },
    }, {
      certifiedCfsSlotControlCommands: ["cfs-load"],
    });

    expect(plan).toMatchObject({
      ok: false,
      reason: "uncertified-cfs-slot-command",
      details: {
        commandKind: "cfs-unload",
      },
    });
    expect(plan.frames).toEqual([]);
  });

  it("Gate 19 certification-only unload/retract候補はisFeed=0としてdry-runできる", () => {
    const plan = createK2CfsCommandTransportPlan({
      commandKind: "cfs-retract",
      payload: {
        materialSourceId: "cfs:3:slot:1",
      },
    }, {
      allowUncertifiedCfsSlotCommandCandidates: true,
    });

    expect(plan).toMatchObject({
      ok: true,
      certificationOnly: true,
      details: {
        commandKind: "cfs-retract",
        candidateOperation: "feed-out-or-retract",
        boxId: 3,
        materialId: 1,
        liveCertificationAllowed: false,
      },
    });
    expect(plan.frames[0].params.feedInOrOut).toEqual({
      boxId: 3,
      materialId: 1,
      isFeed: 0,
    });
  });

  it("Gate 19 certification-onlyでも外部スプールや不正sourceは拒否する", () => {
    const plan = createK2CfsCommandTransportPlan({
      commandKind: "cfs-load",
      payload: {
        sourceId: "external:0:slot:0",
      },
    }, {
      allowUncertifiedCfsSlotCommandCandidates: true,
    });

    expect(plan).toMatchObject({
      ok: false,
      reason: "invalid-cfs-control-source-id",
      details: {
        sourceKind: "external-spool",
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

  it("低レベルsenderはfactory外で偽装されたproduction planを送信しない", async () => {
    const sendFrame = vi.fn();
    const forgedPlan = {
      schemaVersion: 1,
      ok: true,
      reason: null,
      transportKind: "ws9999",
      profile: K2_CFS_SLOT_CONTROL_PRODUCTION_TRANSPORT_PROFILE,
      certificationOnly: false,
      frames: [{
        method: "set",
        params: {
          feedInOrOut: {
            boxId: 1,
            materialId: 2,
            isFeed: 1,
          },
        },
      }],
      details: {
        safetyBoundary: "production-certified",
      },
    };

    await expect(sendK2CfsCommandTransportPlan(forgedPlan, sendFrame))
      .rejects
      .toThrow("must be created by createK2CfsCommandTransportPlan");
    expect(sendFrame).not.toHaveBeenCalled();
  });

  it("certification-only planは明示許可なしでは送信しない", async () => {
    const sendFrame = vi.fn(async () => ({ status: "submitted" }));
    const plan = createK2CfsCommandTransportPlan({
      commandKind: "cfs-load",
      payload: {
        sourceId: "cfs:1:slot:0",
      },
    }, {
      allowUncertifiedCfsSlotCommandCandidates: true,
    });

    await expect(sendK2CfsCommandTransportPlan(plan, sendFrame))
      .rejects
      .toThrow("allowCertificationOnly");
    expect(sendFrame).not.toHaveBeenCalled();

    const response = await sendK2CfsCommandTransportPlan(plan, sendFrame, {
      allowCertificationOnly: true,
    });

    expect(sendFrame).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      status: "submitted",
      profile: K2_CFS_SLOT_CONTROL_CERTIFICATION_TRANSPORT_PROFILE,
      sentFrameCount: 1,
    });
  });

  it("select/feed/retractなどlive意味未確定candidateは追加opt-inなしに送信しない", async () => {
    const sendFrame = vi.fn(async () => ({ status: "submitted" }));
    const plan = createK2CfsCommandTransportPlan({
      commandKind: "cfs-feed",
      payload: {
        sourceId: "cfs:1:slot:0",
      },
    }, {
      allowUncertifiedCfsSlotCommandCandidates: true,
    });

    expect(plan).toMatchObject({
      ok: true,
      certificationOnly: true,
      details: {
        commandKind: "cfs-feed",
        liveCertificationAllowed: false,
      },
    });
    await expect(sendK2CfsCommandTransportPlan(plan, sendFrame, {
      allowCertificationOnly: true,
    })).rejects.toThrow("allowExperimentalSlotSemantics");
    expect(sendFrame).not.toHaveBeenCalled();

    const response = await sendK2CfsCommandTransportPlan(plan, sendFrame, {
      allowCertificationOnly: true,
      allowExperimentalSlotSemantics: true,
    });
    expect(response).toMatchObject({
      status: "submitted",
      sentFrameCount: 1,
    });
  });
});
