/**
 * @fileoverview Printer Core v3 CFS command integration scaffold の単体テスト
 * @description
 * - CFS操作intentがfail-closedにcommand requestへ変換され、bound dispatcherだけへ渡されることを検証する。
 *
 * @version 1.390.1382 (PR #432)
 * @since 1.390.1380 (PR #432)
 * @lastModified 2026-08-25 22:35:00
 */

import { describe, expect, it, vi } from "vitest";
import {
  createBoundCfsControlIntegration,
  createCfsControlCommandRequest,
  dispatchCfsControlIntent,
} from "../../3dp_lib/printer_core/dashboard_cfs_command_integration.js";
import {
  createBoundPrinterCommandDispatcher,
} from "../../3dp_lib/printer_core/dashboard_command_authority.js";

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

/**
 * CFS制御capabilityとfresh topologyを返す送信直前contextを生成する。
 *
 * 【詳細説明】
 * - production dispatcherのsend-time validationを通すため、現在source bindingを明示する。
 *
 * @function createSendTimeContext
 * @returns {object} dispatch context生成用raw context
 */
function createSendTimeContext() {
  return {
    deviceId: "serial:k2-pro",
    sessionId: "session:live",
    transportKind: "ws9999",
    active: true,
    capabilities: ["material.cfs", "material.cfsTopology", "command.cfs-control"],
    materialTopology: {
      cfsConnected: true,
      topologyState: "fresh",
      sources: [{
        sourceId: "cfs:1:slot:2",
        kind: "cfs-slot",
        boxId: 1,
        slotId: 2,
        presence: "loaded",
      }],
    },
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

  it("transport未指定時はCFS-Cも見据えてpending-adapterを使う", () => {
    const request = createCfsControlCommandRequest(createSlotIntent(), {
      deviceId: "serial:k2-pro",
      sessionId: "session:live",
      entropySource: () => "unit",
    });

    expect(request.transportKind).toBe("pending-adapter");
  });

  it("actionとcommandKindが矛盾するintentはrequest生成前に拒否する", () => {
    expect(() => createCfsControlCommandRequest(
      createSlotIntent({ action: "select", commandKind: "cfs-feed" }),
      createRequestContext()
    )).toThrow(/mismatch/);
  });

  it("既定ではenabledでないためbound dispatcherを呼ばない", async () => {
    const integration = createBoundCfsControlIntegration();

    const result = await dispatchCfsControlIntent(createSlotIntent(), integration);

    expect(result).toEqual({
      accepted: false,
      reason: "cfs-command-integration-disabled",
    });
  });

  it("per-call optionsでenabledや偽dispatcherを渡しても拒否する", async () => {
    const result = await dispatchCfsControlIntent(createSlotIntent(), {
      enabled: true,
      dispatcher: { dispatch: vi.fn() },
      getCommandContext: () => createRequestContext(),
    });

    expect(result).toEqual({
      accepted: false,
      reason: "untrusted-cfs-control-integration",
    });
  });

  it("enabledなbound integration生成時は本物のbound dispatcherだけを受け付ける", () => {
    expect(() => createBoundCfsControlIntegration({
      enabled: true,
      allowedActions: ["select"],
      dispatcher: { dispatch: vi.fn() },
      getCommandContext: () => createRequestContext(),
    })).toThrow(/bound printer command dispatcher/);
  });

  it("enabled時はcomposition-bound integrationからrequestだけをbound dispatcherへ渡す", async () => {
    const sendTransport = vi.fn().mockResolvedValue({ status: "acknowledged" });
    const dispatcher = createBoundPrinterCommandDispatcher({
      getSendTimeContext: () => createSendTimeContext(),
      sendTransport,
    });
    const integration = createBoundCfsControlIntegration({
      enabled: true,
      allowedActions: ["select"],
      dispatcher,
      getCommandContext: () => createRequestContext(),
    });
    const result = await integration.onCommand(createSlotIntent());

    expect(result.accepted).toBe(true);
    expect(sendTransport).toHaveBeenCalledTimes(1);
    expect(sendTransport.mock.calls[0][0]).toMatchObject({
      commandKind: "cfs-slot-select",
      payload: {
        sourceId: "cfs:1:slot:2",
      },
    });
    expect(sendTransport.mock.calls[0]).toHaveLength(2);
    expect(result.request.commandKind).toBe("cfs-slot-select");
  });

  it("composition時のallowedActionsでaction単位に拒否する", async () => {
    const sendTransport = vi.fn();
    const dispatcher = createBoundPrinterCommandDispatcher({
      getSendTimeContext: () => createSendTimeContext(),
      sendTransport,
    });
    const integration = createBoundCfsControlIntegration({
      enabled: true,
      allowedActions: ["select"],
      dispatcher,
      getCommandContext: () => createRequestContext(),
    });

    const result = await integration.onCommand(createSlotIntent({ action: "feed", commandKind: "cfs-feed" }));

    expect(result).toEqual({
      accepted: false,
      reason: "cfs-command-action-not-enabled",
    });
    expect(sendTransport).not.toHaveBeenCalled();
  });

  it("sourceId欠落はdispatch前にinvalid intentとして返す", async () => {
    const sendTransport = vi.fn();
    const dispatcher = createBoundPrinterCommandDispatcher({
      getSendTimeContext: () => createSendTimeContext(),
      sendTransport,
    });
    const integration = createBoundCfsControlIntegration({
      enabled: true,
      dispatcher,
      getCommandContext: () => createRequestContext(),
    });
    const result = await integration.onCommand(createSlotIntent({ sourceId: "" }));

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("invalid-cfs-command-intent");
    expect(sendTransport).not.toHaveBeenCalled();
  });
});
