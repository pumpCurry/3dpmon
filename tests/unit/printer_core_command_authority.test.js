/**
 * @fileoverview Printer Core v3 command authority contract の単体テスト
 * @description
 * - Gate 14 で送信経路へ接続する前に、command request/result/retry の安全境界を検証する。
 *
 * @version 1.390.1342 (PR #432)
 * @since 1.390.1342 (PR #432)
 * @lastModified 2026-08-09 01:35:57
 */

import { describe, expect, it } from "vitest";
import {
  createPrinterCommandRequest,
  createPrinterCommandResult,
  evaluateExpectedStateConfirmation,
  shouldRetryPrinterCommand,
  validatePrinterCommandRequest,
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
    });

    expect(before.completed).toBe(false);
    expect(before.confirmation.confirmed).toBe(false);
    expect(after.completed).toBe(true);
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
});
