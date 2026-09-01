/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 MaterialAccounting PrintBinding live bridge 単体テスト
 * @file printer_core_material_accounting_print_binding_live_bridge.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_material_accounting_print_binding_live_bridge_test
 *
 * 【機能内容サマリ】
 * - Gate 18.9I のK2/CFS印刷開始UIとPrintBinding runtimeの接続境界を検証
 * - 送信済みPrintPlanを実機観測job IDへbindするpending bridgeを検証
 * - 完了履歴観測後にsource-specific usage runtimeへ同じPrintPlanを渡す境界を検証
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1595 (PR #440)
 * @since   1.390.1595 (PR #440)
 * @lastModified 2026-09-01 19:17:01
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearMaterialAccountingPrintBindingLiveBridge,
  forgetMaterialAccountingPrintStartRequest,
  getMaterialAccountingPrintBindingLiveBridgeSnapshot,
  recordObservedMaterialAccountingPrintCompletion,
  recordObservedMaterialAccountingPrintStart,
  rememberMaterialAccountingPrintStartRequest,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_print_binding_live_bridge.js";

/**
 * K2/CFS印刷開始command request fixtureを生成する。
 *
 * 【詳細説明】
 * - 本fixtureは実transportへ送らず、printmanagerが作るcommand request shapeのうち
 *   live bridgeが必要とするdevice/session/PrintPlan payloadだけを保持する。
 *
 * @function createCommandRequest
 * @returns {Object} Printer Core command request互換fixture。
 */
function createCommandRequest() {
  return {
    commandId: "cmd:k2:print-start:001",
    deviceId: "serial:k2",
    sessionId: "session:k2-live",
    commandKind: "print-start",
    transportKind: "ws9999",
    payload: {
      printPlanId: "ui-k2-cfs:K2Pro-69E7:/mnt/UDISK/printer_data/gcodes/two-color.gcode:hash",
      planKind: "multicolor-cfs",
      asset: {
        path: "/mnt/UDISK/printer_data/gcodes/two-color.gcode",
        fileHash: "sha256:test",
      },
      toolAssignments: [
        {
          toolId: 0,
          protocolToolAlias: "T1A",
          materialSourceId: "source:k2:cfs:1a",
          spoolId: "spool:a",
        },
        {
          toolId: 1,
          protocolToolAlias: "T1B",
          materialSourceId: "source:k2:cfs:1b",
          spoolId: "spool:b",
        },
      ],
      materialSourceIds: [
        "source:k2:cfs:1a",
        "source:k2:cfs:1b",
      ],
      startContext: {
        sessionId: "session:k2-live",
        connectionGeneration: 7,
        uploadGeneration: "upload:two-color:1",
      },
    },
  };
}

describe("MaterialAccountingPrintBindingLiveBridge", () => {
  beforeEach(() => {
    clearMaterialAccountingPrintBindingLiveBridge();
  });

  it("K2/CFS印刷開始requestをpending PrintPlanとして保持し送信だけではruntimeへ保存しない", () => {
    const runtime = {
      recordObservedPrintStart: vi.fn(),
    };

    const pending = rememberMaterialAccountingPrintStartRequest({
      hostname: "K2Pro-69E7",
      commandRequest: createCommandRequest(),
      submittedAt: "2026-09-01T10:00:00.000Z",
    });

    expect(runtime.recordObservedPrintStart).not.toHaveBeenCalled();
    expect(pending.printPlan.deviceId).toBe("serial:k2");
    expect(pending.printPlan.sessionId).toBe("session:k2-live");
    expect(pending.printPlan.toolAssignments.map((assignment) => assignment.protocolToolAlias)).toEqual(["T1A", "T1B"]);
    expect(getMaterialAccountingPrintBindingLiveBridgeSnapshot().pendingByHost["K2Pro-69E7"].printPlan.printPlanId)
      .toBe("ui-k2-cfs:K2Pro-69E7:/mnt/UDISK/printer_data/gcodes/two-color.gcode:hash");
  });

  it("実機観測printJobIdが来たときだけpending PrintPlanをprint-start runtimeへ一度だけ渡す", async () => {
    const runtime = {
      recordObservedPrintStart: vi.fn(async () => ({ ok: true, status: "recorded" })),
    };
    rememberMaterialAccountingPrintStartRequest({
      hostname: "K2Pro-69E7",
      commandRequest: createCommandRequest(),
      submittedAt: "2026-09-01T10:00:00.000Z",
    });

    const first = await recordObservedMaterialAccountingPrintStart({
      hostname: "K2Pro-69E7",
      printJobId: "1785991119",
      runtime,
    });
    const second = await recordObservedMaterialAccountingPrintStart({
      hostname: "K2Pro-69E7",
      printJobId: "1785991119",
      runtime,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.status).toBe("already-recorded");
    expect(runtime.recordObservedPrintStart).toHaveBeenCalledTimes(1);
    expect(runtime.recordObservedPrintStart).toHaveBeenCalledWith(expect.objectContaining({
      hostname: "K2Pro-69E7",
      printJobId: "1785991119",
      sessionId: "session:k2-live",
      connectionGeneration: 7,
      printPlan: expect.objectContaining({
        deviceId: "serial:k2",
        printPlanId: "ui-k2-cfs:K2Pro-69E7:/mnt/UDISK/printer_data/gcodes/two-color.gcode:hash",
      }),
    }));
  });

  it("print-start記録済みpendingだけを完了runtimeへ渡しsource集合completeとして要求する", async () => {
    const runtime = {
      recordObservedPrintStart: vi.fn(async () => ({ ok: true, status: "recorded" })),
      recordObservedPrintCompletion: vi.fn(async () => ({ ok: true, status: "recorded" })),
    };
    rememberMaterialAccountingPrintStartRequest({
      hostname: "K2Pro-69E7",
      commandRequest: createCommandRequest(),
      submittedAt: "2026-09-01T10:00:00.000Z",
    });
    await recordObservedMaterialAccountingPrintStart({
      hostname: "K2Pro-69E7",
      printJobId: "1785991119",
      runtime,
    });

    const first = await recordObservedMaterialAccountingPrintCompletion({
      hostname: "K2Pro-69E7",
      printJobId: "1785991119",
      runtime,
    });
    const second = await recordObservedMaterialAccountingPrintCompletion({
      hostname: "K2Pro-69E7",
      printJobId: "1785991119",
      runtime,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.status).toBe("already-recorded");
    expect(runtime.recordObservedPrintCompletion).toHaveBeenCalledTimes(1);
    expect(runtime.recordObservedPrintCompletion).toHaveBeenCalledWith(expect.objectContaining({
      hostname: "K2Pro-69E7",
      printJobId: "1785991119",
      sessionId: "session:k2-live",
      connectionGeneration: 7,
      resultSetCompleteness: "complete",
      printPlan: expect.objectContaining({
        materialSourceIds: ["source:k2:cfs:1a", "source:k2:cfs:1b"],
      }),
    }));
  });

  it("送信失敗時はhostname単位でpending PrintPlanを破棄できる", () => {
    rememberMaterialAccountingPrintStartRequest({
      hostname: "K2Pro-69E7",
      commandRequest: createCommandRequest(),
      submittedAt: "2026-09-01T10:00:00.000Z",
    });

    const removed = forgetMaterialAccountingPrintStartRequest({
      hostname: "K2Pro-69E7",
    });

    expect(removed).toBe(true);
    expect(getMaterialAccountingPrintBindingLiveBridgeSnapshot().pendingByHost).toEqual({});
  });
});
