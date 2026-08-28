/**
 * @fileoverview Printer Core v3 command authority contract の単体テスト
 * @description
 * - Gate 14 で送信経路へ接続する前に、command request/result/retry の安全境界を検証する。
 *
 * @version 1.390.1449 (PR #435)
 * @since 1.390.1342 (PR #432)
 * @lastModified 2026-08-28 12:21:00
 */

import { describe, expect, it, vi } from "vitest";
import {
  createBoundPrinterCommandDispatcher,
  createPrinterCommandRequest,
  createPrinterCommandResult,
  dispatchPrinterCommand,
  evaluateExpectedStateConfirmation,
  shouldRetryPrinterCommand,
  validatePrinterCommandRequest,
  validatePrinterCommandSendTime,
} from "../../3dp_lib/printer_core/dashboard_command_authority.js";

/**
 * command request の共通オプションを返す。
 *
 * 【詳細説明】
 * - commandId を安定させるため entropySource を固定する。
 *
 * @function createBaseRequestOptions
 * @param {string} commandKind - command 種別
 * @returns {object} request 生成オプション
 */
function createBaseRequestOptions(commandKind) {
  return {
    deviceId: "serial:demo",
    sessionId: "session:1",
    commandKind,
    transportKind: "ws9999",
    entropySource: () => "unit",
    createdAt: "2026-08-09T01:35:57.000+09:00",
  };
}

/**
 * production dispatcher 用の共通send-time snapshotを返す。
 *
 * 【詳細説明】
 * - dispatcherが内部でcontextを発行する前段として、active session と sequence を固定する。
 *
 * @function createBaseSendTimeSnapshot
 * @param {object=} overrides - snapshot override
 * @returns {object} send-time snapshot
 */
function createBaseSendTimeSnapshot(overrides = {}) {
  return {
    deviceId: "serial:demo",
    sessionId: "session:1",
    transportKind: "ws9999",
    active: true,
    stateSequence: 10,
    createdAt: "2026-08-25T19:30:32.000+09:00",
    materialTopology: {
      cfsConnected: true,
      topologyState: "fresh",
      sources: [
        {
          sourceId: "cfs:1:slot:2",
          kind: "cfs-slot",
          boxId: 1,
          slotId: 2,
          presence: "loaded",
        },
      ],
    },
    ...overrides,
  };
}

describe("Printer Core v3 command authority contract", () => {
  it("read-only commandはcontract-onlyでblind retry可能なrequestになる", () => {
    const request = createPrinterCommandRequest(createBaseRequestOptions("read-status"));

    expect(request).toMatchObject({
      schemaVersion: 1,
      commandId: "cmd:serial%3Ademo:session%3A1:read-status:unit",
      sideEffect: false,
      idempotent: true,
      expectedStateRequired: false,
      authority: {
        mode: "contract-only",
        canSend: false,
        canBlindRetry: true,
      },
    });
    expect(validatePrinterCommandRequest(request)).toEqual({ ok: true, errors: [] });
    expect(shouldRetryPrinterCommand(request, { status: "timeout" })).toBe(true);
  });

  it("print-startは非冪等side-effectとしてtimeoutでもblind retryしない", () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("print-start"),
      payload: {
        opGcodeFile: "printprt:/usr/data/benchy.gcode",
      },
      expectedState: {
        path: "print.stateLabel",
        operator: "oneOf",
        expected: ["printing", "checking"],
      },
    });
    const result = createPrinterCommandResult(request, { status: "timeout" });

    expect(request).toMatchObject({
      sideEffect: true,
      idempotent: false,
      expectedStateRequired: true,
      authority: {
        canSend: false,
        canBlindRetry: false,
      },
    });
    expect(result.completed).toBe(false);
    expect(shouldRetryPrinterCommand(request, result)).toBe(false);
  });

  it("expected-state confirmationはNormalizedState到達時だけcompletedにする", () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("set-led"),
      expectedState: {
        path: "light.enabled",
        expected: true,
      },
    });
    const before = createPrinterCommandResult(request, {
      status: "acknowledged",
      observedState: {
        light: {
          enabled: false,
        },
      },
    });
    const after = createPrinterCommandResult(request, {
      status: "acknowledged",
      observedState: {
        light: {
          enabled: true,
        },
      },
      sentSequence: 10,
      observedSequence: 11,
      observedSessionId: "session:1",
    });

    expect(before.completed).toBe(false);
    expect(before.confirmation.confirmed).toBe(false);
    expect(after.completed).toBe(false);
    expect(after.confirmation).toMatchObject({
      checked: true,
      confirmed: true,
      checks: [
        {
          path: "light.enabled",
          operator: "equals",
          expected: true,
          actual: true,
          matched: true,
        },
      ],
    });
    expect(after.postCommandObservation).toMatchObject({
      required: true,
      confirmed: false,
      sequenceAdvanced: true,
      sameSession: true,
      commandCorrelated: false,
      correlationId: null,
      reason: "command-correlation-missing",
    });
  });

  it("transport errorではexpected-stateが一致してもcompletedにしない", () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("print-start"),
      expectedState: {
        path: "print.stateLabel",
        expected: "printing",
      },
    });
    const result = createPrinterCommandResult(request, {
      status: "transport-error",
      observedState: {
        print: {
          stateLabel: "printing",
        },
      },
      sentSequence: 10,
      observedSequence: 11,
      observedSessionId: "session:1",
    });

    expect(result.transportAccepted).toBe(false);
    expect(result.confirmation.confirmed).toBe(true);
    expect(result.completed).toBe(false);
  });

  it("submittedはtransport失敗ではなく送信済み確認待ちとして扱う", () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("print-start"),
      expectedState: {
        path: "print.stateLabel",
        expected: "printing",
      },
    });
    const result = createPrinterCommandResult(request, {
      status: "submitted",
      sentSequence: 10,
      observedSequence: 10,
      observedSessionId: "session:1",
    });

    expect(result).toMatchObject({
      status: "submitted",
      transportAccepted: true,
      completed: false,
      error: null,
    });
    expect(result.postCommandObservation.reason).toContain("sequence-not-advanced");
    expect(shouldRetryPrinterCommand(request, result)).toBe(false);
  });

  it("command前から成立していたexpected-stateは完了証拠にしない", () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("print-start"),
      expectedState: {
        path: "print.stateLabel",
        expected: "printing",
      },
    });
    const result = createPrinterCommandResult(request, {
      status: "acknowledged",
      observedState: {
        print: {
          stateLabel: "printing",
        },
      },
      sentSequence: 10,
      observedSequence: 10,
      observedSessionId: "session:1",
    });

    expect(result.transportAccepted).toBe(true);
    expect(result.confirmation.confirmed).toBe(true);
    expect(result.postCommandObservation).toMatchObject({
      confirmed: false,
      reason: "sequence-not-advanced,command-correlation-missing",
    });
    expect(result.completed).toBe(false);
  });

  it("observedSessionIdが欠落したexpected-state一致は完了証拠にしない", () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("print-start"),
      expectedState: {
        path: "print.stateLabel",
        expected: "printing",
      },
    });
    const result = createPrinterCommandResult(request, {
      status: "acknowledged",
      observedState: {
        print: {
          stateLabel: "printing",
        },
      },
      sentSequence: 10,
      observedSequence: 11,
    });

    expect(result.transportAccepted).toBe(true);
    expect(result.confirmation.confirmed).toBe(true);
    expect(result.postCommandObservation).toMatchObject({
      confirmed: false,
      sameSession: false,
      commandCorrelated: false,
      reason: "session-mismatch,command-correlation-missing",
    });
    expect(result.completed).toBe(false);
  });

  it("observedSessionIdが異なるexpected-state一致は完了証拠にしない", () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("print-start"),
      expectedState: {
        path: "print.stateLabel",
        expected: "printing",
      },
    });
    const result = createPrinterCommandResult(request, {
      status: "acknowledged",
      observedState: {
        print: {
          stateLabel: "printing",
        },
      },
      sentSequence: 10,
      observedSequence: 11,
      observedSessionId: "session:other",
    });

    expect(result.postCommandObservation).toMatchObject({
      confirmed: false,
      sameSession: false,
      commandCorrelated: false,
      reason: "session-mismatch,command-correlation-missing",
    });
    expect(result.completed).toBe(false);
  });

  it("未知commandは安全側で非冪等side-effect扱いにする", () => {
    const request = createPrinterCommandRequest(createBaseRequestOptions("vendor-unknown-op"));

    expect(request).toMatchObject({
      commandKind: "vendor-unknown-op",
      sideEffect: true,
      idempotent: false,
      expectedStateRequired: true,
      authority: {
        canBlindRetry: false,
      },
    });
    expect(shouldRetryPrinterCommand(request, { status: "transient-error" })).toBe(false);
  });

  it("caller booleanのcommandCorrelationでは完了証跡にならない", () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("set-led"),
      expectedState: {
        path: "light.enabled",
        expected: true,
      },
    });
    const result = createPrinterCommandResult(request, {
      status: "acknowledged",
      observedState: {
        light: {
          enabled: true,
        },
      },
      sentSequence: 10,
      observedSequence: 11,
      observedSessionId: "session:1",
      commandCorrelation: true,
    });

    expect(result.confirmation.confirmed).toBe(true);
    expect(result.postCommandObservation).toMatchObject({
      confirmed: false,
      commandCorrelated: false,
      reason: "command-correlation-missing",
    });
    expect(result.completed).toBe(false);
  });

  it("invalid requestはvalidationで具体的な理由を返す", () => {
    expect(validatePrinterCommandRequest({
      schemaVersion: 999,
      commandId: "",
      deviceId: "",
      sessionId: "session:1",
      commandKind: "",
      timeoutMs: 0,
      expectedState: {},
      sideEffect: true,
      idempotent: false,
      authority: {
        canBlindRetry: true,
        canSend: true,
      },
    })).toEqual({
      ok: false,
      errors: [
        "missing-commandId",
        "missing-deviceId",
        "missing-commandKind",
        "unexpected-schema-version",
        "invalid-timeout",
        "expected-state-not-array",
        "non-idempotent-side-effect-can-blind-retry",
        "contract-request-can-send",
      ],
    });
  });

  it("oneOf confirmationは候補のいずれかに一致すればconfirmedになる", () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("print-stop"),
      expectedState: {
        path: "print.stateLabel",
        operator: "oneOf",
        expected: ["completed", "idle"],
      },
    });

    expect(evaluateExpectedStateConfirmation(request, {
      print: {
        stateLabel: "idle",
      },
    }).confirmed).toBe(true);
  });

  it("production dispatcherは手書きcontextを受け取らずsend-time hookを必須にする", async () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("cfs-slot-select"),
      payload: {
        sourceId: "cfs:1:slot:2",
        boxId: 1,
        slotIndex: 2,
      },
      expectedState: {
        path: "materials.selectedSource.sourceId",
        expected: "cfs:1:2",
      },
    });
    const sendTransport = vi.fn();
    const result = await dispatchPrinterCommand(request, {
      context: {
        schemaVersion: 1,
        deviceId: "serial:demo",
        sessionId: "session:1",
        transportKind: "ws9999",
        active: true,
        capabilities: ["material.cfs", "material.cfsTopology", "command.cfs-control"],
        materialTopology: {
          cfsConnected: true,
          topologyState: "fresh",
        },
        authority: {
          source: "printer-core-command-dispatcher",
          canSend: true,
          attestation: "caller-forged",
        },
      },
      sendTransport,
    });

    expect(result.status).toBe("rejected");
    expect(result.error.errors).toContain("missing-send-time-context");
    expect(sendTransport).not.toHaveBeenCalled();

    expect(validatePrinterCommandSendTime(request, {
      schemaVersion: 1,
      deviceId: "serial:demo",
      sessionId: "session:1",
      active: true,
      authority: {
        source: "printer-core-command-dispatcher",
        canSend: true,
        attestation: "caller-forged",
      },
    }).errors).toContain("untrusted-dispatch-context");
  });

  it("production dispatcherは未知command kindを送信直前で拒否する", async () => {
    const request = createPrinterCommandRequest(createBaseRequestOptions("vendor-unknown-op"));
    const sendTransport = vi.fn();
    const result = await dispatchPrinterCommand(request, {
      getSendTimeContext: () => createBaseSendTimeSnapshot(),
      sendTransport,
    });

    expect(result.status).toBe("rejected");
    expect(result.error.errors).toContain("unsupported-command-kind");
    expect(sendTransport).not.toHaveBeenCalled();
  });

  it("production dispatcherは不正send-time snapshotを送信前に拒否する", async () => {
    const request = createPrinterCommandRequest(createBaseRequestOptions("set-led"));
    const sendTransport = vi.fn();
    const result = await dispatchPrinterCommand(request, {
      getSendTimeContext: () => ({ sessionId: "session:1", active: true }),
      sendTransport,
    });

    expect(result.status).toBe("rejected");
    expect(result.error.errors).toContain("invalid-send-time-context");
    expect(sendTransport).not.toHaveBeenCalled();
  });

  it("CFS commandはfreshな接続topologyと明示制御capabilityを要求する", async () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("cfs-feed"),
      payload: {
        sourceId: "cfs:1:slot:2",
        boxId: 1,
        slotIndex: 2,
      },
      expectedState: {
        path: "materials.commandState",
        expected: "feeding",
      },
    });
    const staleSnapshot = createBaseSendTimeSnapshot({
      capabilities: ["material.cfs", "material.cfsTopology"],
      materialTopology: {
        cfsConnected: false,
        topologyState: "stale",
        sources: [],
      },
    });
    const readySnapshot = createBaseSendTimeSnapshot({
      capabilities: ["material.cfs", "material.cfsTopology", "command.cfs-control"],
    });
    const staleResult = await dispatchPrinterCommand(request, {
      getSendTimeContext: () => staleSnapshot,
      sendTransport: vi.fn(),
    });
    const readySendTransport = vi.fn().mockResolvedValue({ status: "acknowledged" });
    const readyResult = await dispatchPrinterCommand(request, {
      getSendTimeContext: () => readySnapshot,
      sendTransport: readySendTransport,
    });

    expect(staleResult.status).toBe("rejected");
    expect(staleResult.error.errors).toEqual([
      "missing-capability:command.cfs-control",
      "cfs-not-connected",
      "cfs-topology-not-fresh",
      "cfs-target-source-not-current",
    ]);
    expect(readyResult.status).toBe("acknowledged");
    expect(readySendTransport).toHaveBeenCalledTimes(1);
  });

  it("CFS command targetは現在のtopology sourceへbindされていなければ送信しない", async () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("cfs-slot-select"),
      payload: {
        sourceId: "cfs:1:slot:3",
        boxId: 1,
        slotIndex: 3,
      },
      expectedState: {
        path: "materials.selectedSource.sourceId",
        expected: "cfs:1:slot:3",
      },
    });
    const sendTransport = vi.fn();
    const result = await dispatchPrinterCommand(request, {
      getSendTimeContext: () => createBaseSendTimeSnapshot({
        capabilities: ["material.cfs", "material.cfsTopology", "command.cfs-control"],
      }),
      sendTransport,
    });

    expect(result.status).toBe("rejected");
    expect(result.error.errors).toContain("cfs-target-source-not-current");
    expect(sendTransport).not.toHaveBeenCalled();
  });

  it("CFS physical commandは印刷中または一時停止中のprinterへ送信しない", async () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("cfs-load"),
      payload: {
        sourceId: "cfs:1:slot:2",
      },
    });
    const printingSendTransport = vi.fn();
    const pausedSendTransport = vi.fn();
    const printingResult = await dispatchPrinterCommand(request, {
      getSendTimeContext: () => createBaseSendTimeSnapshot({
        capabilities: ["material.cfs", "material.cfsTopology", "command.cfs-control"],
        observedState: {
          print: {
            stateLabel: "printing",
          },
        },
      }),
      sendTransport: printingSendTransport,
    });
    const pausedResult = await dispatchPrinterCommand(request, {
      getSendTimeContext: () => createBaseSendTimeSnapshot({
        capabilities: ["material.cfs", "material.cfsTopology", "command.cfs-control"],
        observedState: {
          print: {
            stateLabel: "paused",
          },
        },
      }),
      sendTransport: pausedSendTransport,
    });

    expect(printingResult.status).toBe("rejected");
    expect(printingResult.error.errors).toContain("cfs-control-printer-busy");
    expect(printingSendTransport).not.toHaveBeenCalled();
    expect(pausedResult.status).toBe("rejected");
    expect(pausedResult.error.errors).toContain("cfs-control-printer-busy");
    expect(pausedSendTransport).not.toHaveBeenCalled();
  });

  it("CFS physical commandはdeviceState系のbusy/heating/running表示でも送信しない", async () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("cfs-load"),
      payload: {
        sourceId: "cfs:1:slot:2",
      },
    });
    const heatingSendTransport = vi.fn();
    const runningSendTransport = vi.fn();
    const heatingResult = await dispatchPrinterCommand(request, {
      getSendTimeContext: () => createBaseSendTimeSnapshot({
        capabilities: ["material.cfs", "material.cfsTopology", "command.cfs-control"],
        observedState: {
          device: {
            stateLabel: "heating",
          },
        },
      }),
      sendTransport: heatingSendTransport,
    });
    const runningResult = await dispatchPrinterCommand(request, {
      getSendTimeContext: () => createBaseSendTimeSnapshot({
        capabilities: ["material.cfs", "material.cfsTopology", "command.cfs-control"],
        observedState: {
          status: {
            stateLabel: "running",
          },
        },
      }),
      sendTransport: runningSendTransport,
    });

    expect(heatingResult.status).toBe("rejected");
    expect(heatingResult.error.errors).toContain("cfs-control-printer-busy");
    expect(heatingSendTransport).not.toHaveBeenCalled();
    expect(runningResult.status).toBe("rejected");
    expect(runningResult.error.errors).toContain("cfs-control-printer-busy");
    expect(runningSendTransport).not.toHaveBeenCalled();
  });

  it("CFS physical commandは送信直前に対象sourceがloadedでなければ送信しない", async () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("cfs-load"),
      payload: {
        sourceId: "cfs:1:slot:2",
      },
    });
    const sendTransport = vi.fn();
    const result = await dispatchPrinterCommand(request, {
      getSendTimeContext: () => createBaseSendTimeSnapshot({
        capabilities: ["material.cfs", "material.cfsTopology", "command.cfs-control"],
        materialTopology: {
          cfsConnected: true,
          topologyState: "fresh",
          sources: [{
            sourceId: "cfs:1:slot:2",
            kind: "cfs-slot",
            boxId: 1,
            slotId: 2,
            presence: "empty",
          }],
        },
      }),
      sendTransport,
    });

    expect(result.status).toBe("rejected");
    expect(result.error.errors).toContain("cfs-target-source-not-loaded");
    expect(sendTransport).not.toHaveBeenCalled();
  });

  it("CFS physical commandは材料metadataだけではloadedとみなさない", async () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("cfs-load"),
      payload: {
        sourceId: "cfs:1:slot:2",
      },
    });
    const sendTransport = vi.fn();
    const result = await dispatchPrinterCommand(request, {
      getSendTimeContext: () => createBaseSendTimeSnapshot({
        capabilities: ["material.cfs", "material.cfsTopology", "command.cfs-control"],
        materialTopology: {
          cfsConnected: true,
          topologyState: "fresh",
          sources: [{
            sourceId: "cfs:1:slot:2",
            kind: "cfs-slot",
            boxId: 1,
            slotId: 2,
            material: {
              type: "PLA",
              color: {
                raw: "#09ea7ae",
                normalized: "09ea7ae",
              },
              rfid: "tag-from-previous-observation",
            },
          }],
        },
      }),
      sendTransport,
    });

    expect(result.status).toBe("rejected");
    expect(result.error.errors).toContain("cfs-target-source-not-loaded");
    expect(sendTransport).not.toHaveBeenCalled();
  });

  it("dispatcherは送信時snapshotを内部context化し、correlationが無ければ完了扱いにしない", async () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("set-led"),
      expectedState: {
        path: "light.enabled",
        expected: true,
      },
    });
    const sendTransport = vi.fn().mockResolvedValue({
      status: "acknowledged",
      vendorCode: 0,
    });
    const observeState = vi.fn().mockResolvedValue({
      observedState: {
        light: {
          enabled: true,
        },
      },
      observedSequence: 11,
      observedSessionId: "session:1",
    });

    const result = await dispatchPrinterCommand(request, {
      getSendTimeContext: () => createBaseSendTimeSnapshot(),
      sendTransport,
      observeState,
      completedAt: "2026-08-25T19:31:00.000+09:00",
    });

    expect(sendTransport).toHaveBeenCalledTimes(1);
    expect(observeState).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "acknowledged",
      transportAccepted: true,
      completed: false,
      postCommandObservation: {
        confirmed: false,
        sequenceAdvanced: true,
        sameSession: true,
        commandCorrelated: false,
        reason: "command-correlation-missing",
      },
    });
  });

  it("低レベルdispatcherはprotocol correlation proof風objectだけでは完了扱いにしない", async () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("set-led"),
      expectedState: {
        path: "light.enabled",
        expected: true,
      },
    });
    const result = await dispatchPrinterCommand(request, {
      getSendTimeContext: () => createBaseSendTimeSnapshot(),
      sendTransport: vi.fn().mockResolvedValue({ status: "acknowledged" }),
      observeState: vi.fn().mockResolvedValue({
        observedState: {
          light: {
            enabled: true,
          },
        },
        observedSequence: 11,
        observedSessionId: "session:1",
        trustedCorrelationProof: {
          evidenceSource: "caller-supplied-proof",
          protocolCommandId: "response:1",
          commandId: request.commandId,
          sessionId: "session:1",
        },
      }),
    });

    expect(result.completed).toBe(false);
    expect(result.postCommandObservation.commandCorrelated).toBe(false);
    expect(result.postCommandObservation.reason).toBe("command-correlation-missing");
  });

  it("bound dispatcherはtrusted providerだけを束ね、trusted proofからcorrelationを内部発行する", async () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("set-led"),
      expectedState: {
        path: "light.enabled",
        expected: true,
      },
    });
    const injectedContext = vi.fn(() => createBaseSendTimeSnapshot({ active: false }));
    const trustedSendTimeContext = vi.fn(() => createBaseSendTimeSnapshot());
    const trustedSendTransport = vi.fn().mockResolvedValue({ status: "acknowledged", protocolCommandId: "response:1" });
    const trustedObserveState = vi.fn().mockResolvedValue({
      observedState: {
        light: {
          enabled: true,
        },
      },
      observedSequence: 11,
      observedSessionId: "session:1",
      trustedCorrelationProof: {
        evidenceSource: "ws9999-response",
        protocolCommandId: "response:1",
        commandId: request.commandId,
        sessionId: "session:1",
      },
    });
    const dispatcher = createBoundPrinterCommandDispatcher({
      getSendTimeContext: trustedSendTimeContext,
      sendTransport: trustedSendTransport,
      observeState: trustedObserveState,
    });

    const result = await dispatcher.dispatch(request, {
      getSendTimeContext: injectedContext,
    });

    expect(injectedContext).not.toHaveBeenCalled();
    expect(trustedSendTimeContext).toHaveBeenCalledTimes(1);
    expect(trustedSendTransport).toHaveBeenCalledTimes(1);
    expect(trustedObserveState).toHaveBeenCalledTimes(1);
    expect(result.completed).toBe(true);
    expect(result.postCommandObservation).toMatchObject({
      confirmed: true,
      commandCorrelated: true,
      reason: "confirmed",
    });
    expect(result.postCommandObservation.correlationId).toMatch(/^cmd:/);
  });

  it("bound dispatcherでもtrusted proofがcommand/sessionへbindされていなければcorrelationを発行しない", async () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("set-led"),
      expectedState: {
        path: "light.enabled",
        expected: true,
      },
    });
    const dispatcher = createBoundPrinterCommandDispatcher({
      getSendTimeContext: () => createBaseSendTimeSnapshot(),
      sendTransport: vi.fn().mockResolvedValue({ status: "acknowledged", protocolCommandId: "response:1" }),
      observeState: vi.fn().mockResolvedValue({
        observedState: {
          light: {
            enabled: true,
          },
        },
        observedSequence: 11,
        observedSessionId: "session:1",
        trustedCorrelationProof: {
          evidenceSource: "ws9999-response",
          protocolCommandId: "response:1",
        },
      }),
    });

    const result = await dispatcher.dispatch(request);

    expect(result.completed).toBe(false);
    expect(result.postCommandObservation.commandCorrelated).toBe(false);
    expect(result.postCommandObservation.reason).toBe("command-correlation-missing");
  });

  it("bound dispatcherはtransport response IDとproof IDが一致しなければcorrelationを発行しない", async () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("set-led"),
      expectedState: {
        path: "light.enabled",
        expected: true,
      },
    });
    const dispatcher = createBoundPrinterCommandDispatcher({
      getSendTimeContext: () => createBaseSendTimeSnapshot(),
      sendTransport: vi.fn().mockResolvedValue({ status: "acknowledged", protocolCommandId: "response:transport" }),
      observeState: vi.fn().mockResolvedValue({
        observedState: {
          light: {
            enabled: true,
          },
        },
        observedSequence: 11,
        observedSessionId: "session:1",
        trustedCorrelationProof: {
          evidenceSource: "ws9999-response",
          protocolCommandId: "response:other",
          commandId: request.commandId,
          sessionId: "session:1",
        },
      }),
    });

    const result = await dispatcher.dispatch(request);

    expect(result.completed).toBe(false);
    expect(result.postCommandObservation.commandCorrelated).toBe(false);
    expect(result.postCommandObservation.reason).toBe("command-correlation-missing");
  });

  it("print-startはupload generationとfile identityを送信直前に照合する", async () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("print-start"),
      payload: {
        asset: {
          path: "printprt:/usr/data/benchy.gcode",
          fileHash: "sha256:benchy",
        },
        startContext: {
          uploadGeneration: "upload:42",
        },
      },
      expectedState: {
        path: "print.stateLabel",
        operator: "oneOf",
        expected: ["printing", "checking"],
      },
    });
    const mismatchedSnapshot = createBaseSendTimeSnapshot({
      capabilities: ["command.print-start"],
      uploadGeneration: "upload:41",
      fileIdentity: {
        remotePath: "printprt:/usr/data/other.gcode",
        fileHash: "sha256:other",
      },
    });
    const matchedSnapshot = createBaseSendTimeSnapshot({
      capabilities: ["command.print-start"],
      uploadGeneration: "upload:42",
      fileIdentity: {
        remotePath: "printprt:/usr/data/benchy.gcode",
        fileHash: "sha256:benchy",
      },
    });
    const mismatchedSendTransport = vi.fn();
    const matchedSendTransport = vi.fn().mockResolvedValue({ status: "acknowledged" });
    const mismatchedResult = await dispatchPrinterCommand(request, {
      getSendTimeContext: () => mismatchedSnapshot,
      sendTransport: mismatchedSendTransport,
    });
    const matchedResult = await dispatchPrinterCommand(request, {
      getSendTimeContext: () => matchedSnapshot,
      sendTransport: matchedSendTransport,
    });

    expect(mismatchedResult.status).toBe("rejected");
    expect(mismatchedResult.error.errors).toEqual([
      "upload-generation-mismatch",
      "file-identity-path-mismatch",
      "file-identity-hash-mismatch",
    ]);
    expect(mismatchedSendTransport).not.toHaveBeenCalled();
    expect(matchedResult.status).toBe("acknowledged");
    expect(matchedSendTransport).toHaveBeenCalledTimes(1);
  });

  it("print-startは指定material sourceを送信直前のfreshなCFS topologyへbindする", async () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("print-start"),
      payload: {
        asset: {
          path: "printprt:/usr/data/benchy.gcode",
          fileHash: "sha256:benchy",
        },
        materialSourceIds: ["cfs:1:slot:2"],
        transportProfile: "k2-ws9999-color-match-multicolor-v1",
        startContext: {
          uploadGeneration: "upload:42",
        },
      },
      expectedState: {
        path: "print.stateLabel",
        operator: "oneOf",
        expected: ["printing", "checking"],
      },
    });
    const staleSnapshot = createBaseSendTimeSnapshot({
      capabilities: ["command.print-start"],
      transportProfiles: ["k2-ws9999-color-match-multicolor-v1"],
      uploadGeneration: "upload:42",
      fileIdentity: {
        remotePath: "printprt:/usr/data/benchy.gcode",
        fileHash: "sha256:benchy",
      },
      materialTopology: {
        cfsConnected: true,
        topologyState: "stale",
        sources: [{
          sourceId: "cfs:1:slot:2",
          kind: "cfs-slot",
          boxId: 1,
          slotId: 2,
          presence: "loaded",
        }],
      },
    });
    const unloadedSnapshot = createBaseSendTimeSnapshot({
      capabilities: ["command.print-start"],
      transportProfiles: ["k2-ws9999-color-match-multicolor-v1"],
      uploadGeneration: "upload:42",
      fileIdentity: {
        remotePath: "printprt:/usr/data/benchy.gcode",
        fileHash: "sha256:benchy",
      },
      materialTopology: {
        cfsConnected: true,
        topologyState: "fresh",
        sources: [{
          sourceId: "cfs:1:slot:2",
          kind: "cfs-slot",
          boxId: 1,
          slotId: 2,
          presence: "empty",
        }],
      },
    });
    const readySnapshot = createBaseSendTimeSnapshot({
      capabilities: ["command.print-start"],
      transportProfiles: ["k2-ws9999-color-match-multicolor-v1"],
      uploadGeneration: "upload:42",
      fileIdentity: {
        remotePath: "printprt:/usr/data/benchy.gcode",
        fileHash: "sha256:benchy",
      },
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
    });
    const staleSendTransport = vi.fn();
    const unloadedSendTransport = vi.fn();
    const readySendTransport = vi.fn().mockResolvedValue({ status: "acknowledged" });
    const staleResult = await dispatchPrinterCommand(request, {
      getSendTimeContext: () => staleSnapshot,
      sendTransport: staleSendTransport,
    });
    const unloadedResult = await dispatchPrinterCommand(request, {
      getSendTimeContext: () => unloadedSnapshot,
      sendTransport: unloadedSendTransport,
    });
    const readyResult = await dispatchPrinterCommand(request, {
      getSendTimeContext: () => readySnapshot,
      sendTransport: readySendTransport,
    });

    expect(staleResult.status).toBe("rejected");
    expect(staleResult.error.errors).toContain("print-start-cfs-topology-not-fresh");
    expect(staleSendTransport).not.toHaveBeenCalled();
    expect(unloadedResult.status).toBe("rejected");
    expect(unloadedResult.error.errors).toContain("print-start-material-source-not-loaded:cfs:1:slot:2");
    expect(unloadedSendTransport).not.toHaveBeenCalled();
    expect(readyResult.status).toBe("acknowledged");
    expect(readySendTransport).toHaveBeenCalledTimes(1);
  });

  it("print-startは要求transport profileがsend-time contextに無ければ拒否する", async () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("print-start"),
      payload: {
        asset: {
          path: "printprt:/usr/data/benchy.gcode",
          fileHash: "sha256:benchy",
        },
        materialSourceIds: ["cfs:1:slot:2"],
        transportProfile: "k2-ws9999-color-match-multicolor-v1",
        startContext: {
          uploadGeneration: "upload:42",
        },
      },
      expectedState: {
        path: "print.stateLabel",
        operator: "oneOf",
        expected: ["printing", "checking"],
      },
    });
    const snapshot = createBaseSendTimeSnapshot({
      capabilities: ["command.print-start"],
      transportProfiles: ["other-profile"],
      uploadGeneration: "upload:42",
      fileIdentity: {
        remotePath: "printprt:/usr/data/benchy.gcode",
        fileHash: "sha256:benchy",
      },
    });
    const sendTransport = vi.fn();
    const result = await dispatchPrinterCommand(request, {
      getSendTimeContext: () => snapshot,
      sendTransport,
    });

    expect(result.status).toBe("rejected");
    expect(result.error.errors).toContain("print-start-transport-profile-not-certified:k2-ws9999-color-match-multicolor-v1");
    expect(sendTransport).not.toHaveBeenCalled();
  });

  it("print-startは同じsourceIdでも送信直前の材料type/colorが変わっていたら拒否する", async () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("print-start"),
      payload: {
        asset: {
          path: "printprt:/usr/data/benchy.gcode",
          fileHash: "sha256:benchy",
        },
        materialSourceIds: ["cfs:1:slot:2"],
        transportProfile: "k2-ws9999-color-match-multicolor-v1",
        toolAssignments: [{
          toolId: 0,
          protocolToolAlias: "T1A",
          materialSourceId: "cfs:1:slot:2",
          protocol: {
            type: "PLA",
            color: "72a530",
          },
        }],
        startContext: {
          uploadGeneration: "upload:42",
        },
      },
      expectedState: {
        path: "print.stateLabel",
        operator: "oneOf",
        expected: ["printing", "checking"],
      },
    });
    const driftSnapshot = createBaseSendTimeSnapshot({
      capabilities: ["command.print-start"],
      transportProfiles: ["k2-ws9999-color-match-multicolor-v1"],
      uploadGeneration: "upload:42",
      fileIdentity: {
        remotePath: "printprt:/usr/data/benchy.gcode",
        fileHash: "sha256:benchy",
      },
      materialTopology: {
        cfsConnected: true,
        topologyState: "fresh",
        sources: [{
          sourceId: "cfs:1:slot:2",
          kind: "cfs-slot",
          boxId: 1,
          slotId: 2,
          presence: "loaded",
          material: {
            type: "ABS",
            color: { raw: "#ff0000", normalized: "ff0000" },
          },
        }],
      },
    });
    const sendTransport = vi.fn();
    const result = await dispatchPrinterCommand(request, {
      getSendTimeContext: () => driftSnapshot,
      sendTransport,
    });

    expect(result.status).toBe("rejected");
    expect(result.error.errors).toContain("print-start-material-type-mismatch:cfs:1:slot:2");
    expect(result.error.errors).toContain("print-start-material-color-mismatch:cfs:1:slot:2");
    expect(sendTransport).not.toHaveBeenCalled();
  });

  it("transport例外はtransport-errorとして返しside-effect commandをblind retryしない", async () => {
    const request = createPrinterCommandRequest({
      ...createBaseRequestOptions("cfs-retract"),
      payload: {
        sourceId: "cfs:1:slot:2",
        boxId: 1,
        slotIndex: 2,
      },
      expectedState: {
        path: "materials.commandState",
        expected: "retracting",
      },
    });
    const snapshot = createBaseSendTimeSnapshot({
      capabilities: ["material.cfs", "material.cfsTopology", "command.cfs-control"],
    });
    const result = await dispatchPrinterCommand(request, {
      getSendTimeContext: () => snapshot,
      sendTransport: vi.fn().mockRejectedValue(new Error("socket closed")),
    });

    expect(result).toMatchObject({
      status: "transport-error",
      transportAccepted: false,
      completed: false,
      error: {
        code: "transport-error",
        message: "socket closed",
      },
    });
    expect(shouldRetryPrinterCommand(request, result)).toBe(false);
  });
});
