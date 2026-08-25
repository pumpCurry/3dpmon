/**
 * @fileoverview Printer Core v3 CFS command integration scaffold の単体テスト
 * @description
 * - CFS操作intentがfail-closedにcommand requestへ変換され、bound dispatcherだけへ渡されることを検証する。
 *
 * @version 1.390.1380 (PR #432)
 * @since 1.390.1380 (PR #432)
 * @lastModified 2026-08-25 21:34:00
 */

import { describe, expect, it, vi } from "vitest";
import {
  createCfsControlCommandRequest,
  dispatchCfsControlIntent,
} from "../../3dp_lib/printer_core/dashboard_cfs_command_integration.js";

/**
 * 代表的なCFS slot操作intentを返す。
 *
 * 【詳細説明】
 * - material topology panel が `onCommand` へ渡すpayload shapeに合わせる。
 *
 * @function createSlotIntent
 * @param {object=} overrides - intent override
 * @returns {object} CFS操作intent
 */
function createSlotIntent(overrides = {}) {
  return {
    action: "select",
    commandKind: "cfs-slot-select",
    sourceId: "cfs:1:slot:2",
    displaySlot: "1C",
    unitIndex: 0,
    slotIndex: 2,
    boxId: 1,
    protocolSlotId: 2,
    ...overrides,
  };
}

/**
 * request生成用contextを返す。
 *
 * 【詳細説明】
 * - send-time再検証用contextではなく、request envelopeに必要なdevice/sessionだけを持つ。
 *
 * @function createRequestContext
 * @returns {object} command request context
 */
function createRequestContext() {
  return {
    deviceId: "serial:k2-pro",
    sessionId: "session:live",
    transportKind: "ws9999",
    entropySource: () => "unit",
  };
}

describe("Printer Core v3 CFS command integration scaffold", () => {
  it("CFS slot select intentをPrinter Core command requestへ変換する", () => {
    const request = createCfsControlCommandRequest(createSlotIntent(), createRequestContext());

    expect(request).toMatchObject({
      deviceId: "serial:k2-pro",
      sessionId: "session:live",
      commandKind: "cfs-slot-select",
      transportKind: "ws9999",
      payload: {
        action: "select",
        sourceId: "cfs:1:slot:2",
        displaySlot: "1C",
        unitIndex: 0,
        slotIndex: 2,
        boxId: 1,
        protocolSlotId: 2,
      },
      authority: {
        canSend: false,
      },
    });
    expect(request.expectedState).toEqual([{
      path: "materials.selectedSource.sourceId",
      operator: "equals",
      expected: "cfs:1:slot:2",
    }]);
  });

  it("load/feed/retract系intentでは未certifiedな期待状態を推測しない", () => {
    const request = createCfsControlCommandRequest(
      createSlotIntent({ action: "feed", commandKind: "cfs-feed" }),
      createRequestContext()
    );

    expect(request.commandKind).toBe("cfs-feed");
    expect(request.expectedState).toEqual([]);
    expect(request.expectedStateRequired).toBe(true);
  });

  it("actionとcommandKindが矛盾するintentはrequest生成前に拒否する", () => {
    expect(() => createCfsControlCommandRequest(
      createSlotIntent({ action: "select", commandKind: "cfs-feed" }),
      createRequestContext()
    )).toThrow(/mismatch/);
  });

  it("既定ではenabledでないためbound dispatcherを呼ばない", async () => {
    const dispatcher = {
      dispatch: vi.fn(),
    };

    const result = await dispatchCfsControlIntent(createSlotIntent(), {
      dispatcher,
      getCommandContext: () => createRequestContext(),
    });

    expect(result).toEqual({
      accepted: false,
      reason: "cfs-command-integration-disabled",
    });
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("enabled時はrequestだけをbound dispatcherへ渡す", async () => {
    const dispatcher = {
      dispatch: vi.fn().mockResolvedValue({ status: "acknowledged" }),
    };
    const result = await dispatchCfsControlIntent(createSlotIntent(), {
      enabled: true,
      dispatcher,
      getCommandContext: () => createRequestContext(),
    });

    expect(result.accepted).toBe(true);
    expect(result.result).toEqual({ status: "acknowledged" });
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch.mock.calls[0][0]).toMatchObject({
      commandKind: "cfs-slot-select",
      payload: {
        sourceId: "cfs:1:slot:2",
      },
    });
    expect(dispatcher.dispatch.mock.calls[0]).toHaveLength(1);
  });

  it("sourceId欠落はdispatch前にinvalid intentとして返す", async () => {
    const dispatcher = {
      dispatch: vi.fn(),
    };
    const result = await dispatchCfsControlIntent(createSlotIntent({ sourceId: "" }), {
      enabled: true,
      dispatcher,
      getCommandContext: () => createRequestContext(),
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("invalid-cfs-command-intent");
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });
});
