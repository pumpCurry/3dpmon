/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 物理コマンド復旧ラッチテスト
 * @file printer_core_physical_command_recovery_latch.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_physical_command_recovery_latch_test
 *
 * 【機能内容サマリ】
 * - Gate 19 向けの物理コマンド復旧ラッチが未解決状態だけを保持することを検証
 * - 再起動後もコマンドフレームを保存せず自動再送しないことを検証
 * - 壊れた保存データや同一ID衝突を隔離し、復旧判断に使える証跡だけを残すことを検証
 *
 * 【公開関数一覧】
 * - なし：Vitest のテストケースのみを定義する
 *
 * @version 1.390.1550 (PR #439)
 * @since   1.390.1536 (PR #439)
 * @lastModified 2026-08-31 19:48:53
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { describe, expect, it } from "vitest";
import {
  PHYSICAL_COMMAND_RECOVERY_LATCH_STATUS,
  appendPhysicalCommandRecoveryLatchRecord,
  createPhysicalCommandRecoveryLatchRecord,
  isPhysicalCommandRecoveryBlocked,
  normalizeStoredPhysicalCommandRecoveryLatchStore,
  resolvePhysicalCommandRecoveryLatchRecord,
} from "../../3dp_lib/printer_core/dashboard_physical_command_recovery_latch.js";

/**
 * テスト用の最小コマンド送信結果を生成する。
 *
 * 【詳細説明】
 * - production command dispatcherが将来渡す想定のmetadataだけを使う。
 * - 実際のcommand frameやRPC payloadは保存しない契約を検証するため、入力には含める。
 *
 * @function createCommandInput
 * @param {Object=} overrides - 上書きする入力フィールド。
 * @returns {Object} recovery record入力。
 */
function createCommandInput(overrides = {}) {
  return {
    commandId: "command:k2-select-1a",
    commandKind: "cfs-slot-select",
    deviceId: "serial:k2pro-69e7",
    sessionId: "session:live-001",
    connectionGeneration: 42,
    status: PHYSICAL_COMMAND_RECOVERY_LATCH_STATUS.UNKNOWN,
    sentAt: "2026-08-31T09:20:00.000Z",
    materialSourceId: "material-source:k2pro-69e7:cfs-1:slot-a",
    certificationId: "cert:k2-slot-control-f012",
    preObservation: {
      sequence: 128,
      digest: "fnv1a128:before",
      observedAt: "2026-08-31T09:19:59.000Z",
    },
    commandFrame: {
      method: "multi.machine.material_box.select",
      params: { boxId: 1, slot: 0 },
    },
    ...overrides,
  };
}

describe("dashboard_physical_command_recovery_latch", () => {
  it("submitted/unknown/post-observedの物理コマンドだけを未解決ラッチとして保持し、command frameは保存しない", () => {
    const unknownRecord = createPhysicalCommandRecoveryLatchRecord(createCommandInput());
    const submittedRecord = createPhysicalCommandRecoveryLatchRecord(createCommandInput({
      commandId: "command:k2-load-1a",
      commandKind: "cfs-slot-load",
      status: PHYSICAL_COMMAND_RECOVERY_LATCH_STATUS.SUBMITTED,
    }));
    const postObservedRecord = createPhysicalCommandRecoveryLatchRecord(createCommandInput({
      commandId: "command:k2-load-1b",
      commandKind: "cfs-slot-load",
      status: PHYSICAL_COMMAND_RECOVERY_LATCH_STATUS.POST_OBSERVED,
    }));

    const store = appendPhysicalCommandRecoveryLatchRecord(
      appendPhysicalCommandRecoveryLatchRecord(
        appendPhysicalCommandRecoveryLatchRecord(null, unknownRecord).store,
        submittedRecord
      ).store,
      postObservedRecord
    ).store;

    expect(Object.keys(store.unresolvedByCommandId)).toEqual([
      "command:k2-select-1a",
      "command:k2-load-1a",
      "command:k2-load-1b",
    ]);
    expect(store.unresolvedByCommandId["command:k2-select-1a"]).toMatchObject({
      commandKind: "cfs-slot-select",
      status: "unknown",
      materialSourceId: "material-source:k2pro-69e7:cfs-1:slot-a",
    });
    expect(store.unresolvedByCommandId["command:k2-load-1b"]).toMatchObject({
      commandKind: "cfs-slot-load",
      status: "post-observed",
    });
    expect(JSON.stringify(store)).not.toContain("multi.machine.material_box.select");
    expect(store.invariants).toMatchObject({
      autoReplay: false,
      commandFramePersistence: false,
      physicalCommandAuthority: "recovery-latch-only",
    });
  });

  it("completed/rejectedなど解決済み状態は未解決ラッチへ追加しない", () => {
    const completedRecord = createPhysicalCommandRecoveryLatchRecord(createCommandInput({
      commandId: "command:k2-select-completed",
      status: PHYSICAL_COMMAND_RECOVERY_LATCH_STATUS.COMPLETED,
    }));
    const rejectedRecord = createPhysicalCommandRecoveryLatchRecord(createCommandInput({
      commandId: "command:k2-select-rejected",
      status: PHYSICAL_COMMAND_RECOVERY_LATCH_STATUS.REJECTED,
    }));

    const afterCompleted = appendPhysicalCommandRecoveryLatchRecord(null, completedRecord);
    const afterRejected = appendPhysicalCommandRecoveryLatchRecord(afterCompleted.store, rejectedRecord);

    expect(afterRejected.store.unresolvedByCommandId).toEqual({});
    expect(afterRejected.store.events.map((event) => event.type)).toEqual([
      "physical-command-recovery-ignored",
      "physical-command-recovery-ignored",
    ]);
  });

  it("同一commandIdかつ同一digestの追加は冪等に扱い、異なるdigestは全て隔離する", () => {
    const firstRecord = createPhysicalCommandRecoveryLatchRecord(createCommandInput());
    const duplicateRecord = createPhysicalCommandRecoveryLatchRecord(createCommandInput());
    const conflictingRecord = createPhysicalCommandRecoveryLatchRecord(createCommandInput({
      sentAt: "2026-08-31T09:21:00.000Z",
      preObservation: {
        sequence: 129,
        digest: "fnv1a128:different",
        observedAt: "2026-08-31T09:20:59.000Z",
      },
    }));

    const first = appendPhysicalCommandRecoveryLatchRecord(null, firstRecord);
    const duplicate = appendPhysicalCommandRecoveryLatchRecord(first.store, duplicateRecord);
    const conflict = appendPhysicalCommandRecoveryLatchRecord(duplicate.store, conflictingRecord);

    expect(duplicate.status).toBe("idempotent");
    expect(conflict.status).toBe("conflict");
    expect(conflict.store.unresolvedByCommandId).toEqual({});
    expect(conflict.store.conflictedCommandIds).toEqual(["command:k2-select-1a"]);
    expect(conflict.store.retainedUnsupportedEntries).toEqual([
      expect.objectContaining({
        commandId: "command:k2-select-1a",
        reason: "command-id-digest-conflict",
        conflictedDigest: firstRecord.digest,
      }),
      expect.objectContaining({
        commandId: "command:k2-select-1a",
        reason: "command-id-digest-conflict",
        conflictedDigest: conflictingRecord.digest,
      }),
    ]);
  });

  it("UI/dispatcher用blocker APIは未解決recordとconflict indexの両方をblock扱いにする", () => {
    const firstRecord = createPhysicalCommandRecoveryLatchRecord(createCommandInput({
      commandId: "command:k2-select-1a",
    }));
    const conflictedRecord = createPhysicalCommandRecoveryLatchRecord(createCommandInput({
      commandId: "command:k2-load-1b",
    }));
    const store = normalizeStoredPhysicalCommandRecoveryLatchStore({
      unresolvedByCommandId: {
        [firstRecord.commandId]: firstRecord,
      },
      conflictedCommandIds: [conflictedRecord.commandId],
    });

    expect(isPhysicalCommandRecoveryBlocked(store, "command:k2-select-1a")).toMatchObject({
      blocked: true,
      reason: "unresolved-recovery",
      commandId: "command:k2-select-1a",
    });
    expect(isPhysicalCommandRecoveryBlocked(store, "command:k2-load-1b")).toMatchObject({
      blocked: true,
      reason: "conflicted-recovery",
      commandId: "command:k2-load-1b",
    });
    expect(isPhysicalCommandRecoveryBlocked(store, "command:k2-unload-1c")).toEqual({
      blocked: false,
      reason: "not-blocked",
      commandId: "command:k2-unload-1c",
    });
    expect(isPhysicalCommandRecoveryBlocked(store, "   ")).toEqual({
      blocked: true,
      reason: "missing-command-id",
      commandId: "",
    });
    expect(isPhysicalCommandRecoveryBlocked(store, null)).toEqual({
      blocked: true,
      reason: "missing-command-id",
      commandId: "",
    });
  });

  it("blocker APIはcommandIdが特定できるintegrity quarantineもblock扱いにする", () => {
    const store = normalizeStoredPhysicalCommandRecoveryLatchStore({
      retainedUnsupportedEntries: [
        {
          commandId: "command:k2-select-tampered",
          reason: "command-id-digest-mismatch",
        },
        {
          commandId: "command:k2-select-wrong-key",
          reason: "command-id-storage-key-mismatch",
        },
        {
          commandId: "command:k2-broken-shape",
          reason: "invalid-recovery-record",
        },
      ],
    });

    expect(isPhysicalCommandRecoveryBlocked(store, "command:k2-select-tampered")).toMatchObject({
      blocked: true,
      reason: "integrity-quarantine",
      commandId: "command:k2-select-tampered",
      quarantineReason: "command-id-digest-mismatch",
    });
    expect(isPhysicalCommandRecoveryBlocked(store, "command:k2-select-wrong-key")).toMatchObject({
      blocked: true,
      reason: "integrity-quarantine",
      commandId: "command:k2-select-wrong-key",
      quarantineReason: "command-id-storage-key-mismatch",
    });
    expect(isPhysicalCommandRecoveryBlocked(store, "command:k2-broken-shape")).toEqual({
      blocked: false,
      reason: "not-blocked",
      commandId: "command:k2-broken-shape",
    });
  });

  it("保存済みdigestがcanonical recordから再計算した値と異なる場合は未解決authorityから隔離する", () => {
    const validRecord = createPhysicalCommandRecoveryLatchRecord(createCommandInput({
      commandId: "command:valid",
    }));
    const restored = normalizeStoredPhysicalCommandRecoveryLatchStore({
      unresolvedByCommandId: {
        "command:valid": {
          ...validRecord,
          digest: "fnv1a128:tampered",
        },
      },
    });

    expect(restored.unresolvedByCommandId).toEqual({});
    expect(restored.conflictedCommandIds).toEqual([]);
    expect(restored.retainedUnsupportedEntries).toEqual([
      expect.objectContaining({
        commandId: "command:valid",
        reason: "command-id-digest-mismatch",
        persistedDigest: "fnv1a128:tampered",
        recomputedDigest: validRecord.digest,
      }),
    ]);
  });

  it("保存データを正規化し、壊れたentryを未解決authorityから隔離する", () => {
    const restored = normalizeStoredPhysicalCommandRecoveryLatchStore({
      schemaVersion: 999,
      authority: "tampered",
      unresolvedByCommandId: {
        "command:valid": createPhysicalCommandRecoveryLatchRecord(createCommandInput({
          commandId: "command:valid",
        })),
        "command:broken": {
          commandId: "command:broken",
          commandKind: "",
          status: "unknown",
        },
      },
      retainedUnsupportedEntries: [{ reason: "legacy-entry" }],
      invariants: {
        autoReplay: true,
        commandFramePersistence: true,
      },
    });

    expect(restored).toMatchObject({
      schemaVersion: 1,
      authority: "physical-command-recovery-latch",
      invariants: {
        autoReplay: false,
        commandFramePersistence: false,
      },
    });
    expect(Object.keys(restored.unresolvedByCommandId)).toEqual(["command:valid"]);
    expect(restored.retainedUnsupportedEntries).toEqual([
      { reason: "legacy-entry" },
      expect.objectContaining({
        commandId: "command:broken",
        reason: "invalid-recovery-record",
      }),
    ]);
  });

  it("保存keyとrecord.commandIdが一致しない未解決entryは復元時に隔離する", () => {
    const restored = normalizeStoredPhysicalCommandRecoveryLatchStore({
      unresolvedByCommandId: {
        "command:visible-key": createPhysicalCommandRecoveryLatchRecord(createCommandInput({
          commandId: "command:payload-key",
          status: PHYSICAL_COMMAND_RECOVERY_LATCH_STATUS.UNKNOWN,
        })),
      },
    });

    expect(restored.unresolvedByCommandId).toEqual({});
    expect(restored.retainedUnsupportedEntries).toEqual([
      expect.objectContaining({
        commandId: "command:payload-key",
        storageKey: "command:visible-key",
        reason: "command-id-storage-key-mismatch",
      }),
    ]);
  });

  it("保存済みevents/retainedUnsupportedEntriesに紛れたcommand frameも復旧storeから除去する", () => {
    const restored = normalizeStoredPhysicalCommandRecoveryLatchStore({
      unresolvedByCommandId: {
        "command:valid": createPhysicalCommandRecoveryLatchRecord(createCommandInput({
          commandId: "command:valid",
        })),
      },
      events: [
        {
          eventId: "event:malicious",
          type: "physical-command-recovery-opened",
          commandId: "command:valid",
          recordedAt: "2026-08-31T09:20:00.000Z",
          commandFrame: {
            method: "multi.machine.material_box.select",
            params: { boxId: 1, materialId: 0 },
          },
        },
      ],
      retainedUnsupportedEntries: [
        {
          commandId: "command:old",
          reason: "legacy",
          rpcPayload: {
            method: "multi.machine.material_box.feedInOrOut",
            params: { boxId: 1, materialId: 0, isFeed: 1 },
          },
        },
      ],
    });

    const serialized = JSON.stringify(restored);
    expect(serialized).not.toContain("multi.machine.material_box");
    expect(serialized).not.toContain("params");
    expect(restored.events).toEqual([
      expect.objectContaining({
        eventId: "event:malicious",
        type: "physical-command-recovery-opened",
        commandId: "command:valid",
      }),
    ]);
    expect(restored.retainedUnsupportedEntries).toEqual([
      expect.objectContaining({
        commandId: "command:old",
        reason: "legacy",
      }),
    ]);
  });

  it("operatorまたは観測で解決したrecordは未解決一覧から外し、監査eventだけを残す", () => {
    const record = createPhysicalCommandRecoveryLatchRecord(createCommandInput());
    const store = appendPhysicalCommandRecoveryLatchRecord(null, record).store;

    const resolved = resolvePhysicalCommandRecoveryLatchRecord(store, {
      commandId: "command:k2-select-1a",
      resolution: "operator-cleared",
      resolvedAt: "2026-08-31T09:25:00.000Z",
      postObservation: {
        sequence: 144,
        digest: "fnv1a128:after",
        observedAt: "2026-08-31T09:24:59.000Z",
      },
    });

    expect(resolved.status).toBe("resolved");
    expect(resolved.store.unresolvedByCommandId).toEqual({});
    expect(resolved.store.events).toEqual([
      expect.objectContaining({ type: "physical-command-recovery-opened" }),
      expect.objectContaining({
        type: "physical-command-recovery-resolved",
        commandId: "command:k2-select-1a",
        resolution: "operator-cleared",
      }),
    ]);
    expect(JSON.stringify(resolved.store)).not.toContain("params");
  });

  it("未解決recordは許可されたresolutionだけで解除し、observed系は観測digestと時刻を必須にする", () => {
    const record = createPhysicalCommandRecoveryLatchRecord(createCommandInput());
    const store = appendPhysicalCommandRecoveryLatchRecord(null, record).store;

    const arbitrary = resolvePhysicalCommandRecoveryLatchRecord(store, {
      commandId: "command:k2-select-1a",
      resolution: "whatever",
      resolvedAt: "2026-08-31T09:25:00.000Z",
    });
    const observedWithoutEvidence = resolvePhysicalCommandRecoveryLatchRecord(store, {
      commandId: "command:k2-select-1a",
      resolution: "observed-confirmed",
      resolvedAt: "2026-08-31T09:25:00.000Z",
      postObservation: {
        sequence: 144,
      },
    });
    const observedResolved = resolvePhysicalCommandRecoveryLatchRecord(store, {
      commandId: "command:k2-select-1a",
      resolution: "observed-confirmed",
      resolvedAt: "2026-08-31T09:25:00.000Z",
      postObservation: {
        sequence: 144,
        digest: "fnv1a128:after",
        observedAt: "2026-08-31T09:24:59.000Z",
      },
    });

    expect(arbitrary).toMatchObject({
      ok: false,
      status: "invalid",
      reasons: ["unsupported-resolution"],
    });
    expect(arbitrary.store.unresolvedByCommandId).toHaveProperty("command:k2-select-1a");
    expect(observedWithoutEvidence).toMatchObject({
      ok: false,
      status: "invalid",
      reasons: ["missing-post-observation-digest", "missing-post-observation-observed-at"],
    });
    expect(observedWithoutEvidence.store.unresolvedByCommandId).toHaveProperty("command:k2-select-1a");
    expect(observedResolved.status).toBe("resolved");
    expect(observedResolved.store.unresolvedByCommandId).toEqual({});
  });
});
