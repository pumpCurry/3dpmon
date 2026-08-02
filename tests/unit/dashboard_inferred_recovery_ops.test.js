/**
 * @fileoverview dashboard_inferred_recovery_ops.js（#420/O6A Recovery Operations）の単体テスト
 * recovery / repair flag の解除、耐久保存失敗時 rollback、Satellite 拒否を検証する。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  monitorData: {
    inferredDecisionRecoveryRequired: null,
    inferredRecoveryEvents: [],
    ledgerRepairRequired: {},
    mountHistoryRejectedEvents: []
  },
  saveUnifiedStorageDurably: vi.fn(async () => ({ ok: true, backend: "test", reason: "saved" })),
  canExecuteLedgerDecision: vi.fn(() => true),
  queue: Promise.resolve()
}));

vi.mock("../../3dp_lib/dashboard_data.js", () => ({ monitorData: mocks.monitorData }));
vi.mock("../../3dp_lib/dashboard_storage.js", () => ({ saveUnifiedStorageDurably: mocks.saveUnifiedStorageDurably }));
vi.mock("../../3dp_lib/dashboard_time.js", () => ({ wallNowMs: () => 123456 }));
vi.mock("../../3dp_lib/dashboard_inferred_candidate_decision.js", () => ({
  canExecuteLedgerDecision: mocks.canExecuteLedgerDecision,
  enqueueLedgerDecisionTask: (task) => {
    const run = mocks.queue.then(task, task);
    mocks.queue = run.catch(() => {});
    return run;
  }
}));

const {
  archiveMountHistoryRejectedEvents,
  canExecuteRecoveryOperation,
  clearInferredDecisionRecoveryRequired,
  clearLedgerRepairRequired,
  retryInferredRecoveryDurableSave
} = await import("../../3dp_lib/dashboard_inferred_recovery_ops.js");

/**
 * monitorData の recovery 関連 field を初期状態へ戻す。
 *
 * @function resetRecoveryState
 * @returns {void}
 */
function resetRecoveryState() {
  mocks.monitorData.inferredDecisionRecoveryRequired = null;
  mocks.monitorData.inferredRecoveryEvents = [];
  mocks.monitorData.ledgerRepairRequired = {};
  mocks.monitorData.mountHistoryRejectedEvents = [];
}

beforeEach(() => {
  resetRecoveryState();
  mocks.queue = Promise.resolve();
  mocks.canExecuteLedgerDecision.mockReset();
  mocks.canExecuteLedgerDecision.mockReturnValue(true);
  mocks.saveUnifiedStorageDurably.mockReset();
  mocks.saveUnifiedStorageDurably.mockResolvedValue({ ok: true, backend: "test", reason: "saved" });
});

describe("canExecuteRecoveryOperation", () => {
  it("Parent/Standalone 権威では true、Satellite では false を返す", () => {
    mocks.canExecuteLedgerDecision.mockReturnValueOnce(true);
    expect(canExecuteRecoveryOperation()).toBe(true);

    mocks.canExecuteLedgerDecision.mockReturnValueOnce(false);
    expect(canExecuteRecoveryOperation()).toBe(false);
  });
});

describe("retryInferredRecoveryDurableSave", () => {
  it("recovery 状態を audit event 付きで再保存する", async () => {
    mocks.monitorData.inferredDecisionRecoveryRequired = {
      candidateHash: "ic-a",
      reason: "rollback_durable_save_failed",
      createdAt: 100
    };

    const result = await retryInferredRecoveryDurableSave({ actor: "operator", nowMs: 200 });

    expect(result).toMatchObject({ ok: true, reason: "recovery_durable_save_retried" });
    expect(mocks.saveUnifiedStorageDurably).toHaveBeenCalledTimes(1);
    expect(mocks.monitorData.inferredRecoveryEvents).toHaveLength(1);
    expect(mocks.monitorData.inferredRecoveryEvents[0]).toMatchObject({
      type: "recovery-durable-save-retried",
      actor: "operator",
      createdAt: 200,
      rejectedMountEventCount: 0
    });
  });

  it("Satellite 権威では保存せず拒否する", async () => {
    mocks.canExecuteLedgerDecision.mockReturnValue(false);
    mocks.monitorData.inferredDecisionRecoveryRequired = { candidateHash: "ic-a" };

    const result = await retryInferredRecoveryDurableSave();

    expect(result).toEqual({ ok: false, reason: "recovery_not_authorized" });
    expect(mocks.saveUnifiedStorageDurably).not.toHaveBeenCalled();
    expect(mocks.monitorData.inferredRecoveryEvents).toHaveLength(0);
  });
});

describe("clearInferredDecisionRecoveryRequired", () => {
  it("decision recovery flag を解除し audit event を保存する", async () => {
    mocks.monitorData.inferredDecisionRecoveryRequired = {
      candidateHash: "ic-a",
      reason: "rollback_durable_save_failed",
      createdAt: 100
    };

    const result = await clearInferredDecisionRecoveryRequired({ actor: "operator", note: "checked", nowMs: 300 });

    expect(result).toMatchObject({ ok: true, reason: "decision_recovery_cleared" });
    expect(mocks.monitorData.inferredDecisionRecoveryRequired).toBeNull();
    expect(mocks.monitorData.inferredRecoveryEvents[0]).toMatchObject({
      type: "decision-recovery-cleared",
      note: "checked",
      createdAt: 300
    });
  });

  it("保存失敗時は recovery flag と audit event を rollback する", async () => {
    const flag = { candidateHash: "ic-a", reason: "rollback_durable_save_failed", createdAt: 100 };
    mocks.monitorData.inferredDecisionRecoveryRequired = { ...flag };
    mocks.saveUnifiedStorageDurably
      .mockResolvedValueOnce({ ok: false, backend: "localStorage", reason: "quota" })
      .mockResolvedValueOnce({ ok: true, backend: "localStorage", reason: "saved" });

    const result = await clearInferredDecisionRecoveryRequired({ nowMs: 400 });

    expect(result).toMatchObject({ ok: false, reason: "decision_recovery_clear_not_durably_saved" });
    expect(mocks.monitorData.inferredDecisionRecoveryRequired).toEqual(flag);
    expect(mocks.monitorData.inferredRecoveryEvents).toHaveLength(0);
    expect(mocks.saveUnifiedStorageDurably).toHaveBeenCalledTimes(2);
  });
});

describe("clearLedgerRepairRequired", () => {
  it("host 単位の ledger repair flag を解除する", async () => {
    mocks.monitorData.ledgerRepairRequired = {
      k1: { spoolId: "S1", status: "ambiguous", detectedAtEpochMs: 100 }
    };

    const result = await clearLedgerRepairRequired("k1", { actor: "operator", nowMs: 500 });

    expect(result).toMatchObject({ ok: true, reason: "ledger_repair_cleared", host: "k1" });
    expect(mocks.monitorData.ledgerRepairRequired).toEqual({});
    expect(mocks.monitorData.inferredRecoveryEvents[0]).toMatchObject({
      type: "ledger-repair-cleared",
      host: "k1",
      createdAt: 500
    });
  });

  it("保存失敗時は ledger repair flag を rollback する", async () => {
    const repair = { k1: { spoolId: "S1", status: "ambiguous", detectedAtEpochMs: 100 } };
    mocks.monitorData.ledgerRepairRequired = { k1: { ...repair.k1 } };
    mocks.saveUnifiedStorageDurably
      .mockResolvedValueOnce({ ok: false, backend: "indexedDB", reason: "idb_flush_failed" })
      .mockResolvedValueOnce({ ok: true, backend: "indexedDB", reason: "flushed" });

    const result = await clearLedgerRepairRequired("k1");

    expect(result).toMatchObject({ ok: false, reason: "ledger_repair_clear_not_durably_saved" });
    expect(mocks.monitorData.ledgerRepairRequired).toEqual(repair);
    expect(mocks.monitorData.inferredRecoveryEvents).toHaveLength(0);
  });
});

describe("archiveMountHistoryRejectedEvents", () => {
  it("隔離済み mount event を audit event へ退避して warning を閉じる", async () => {
    mocks.monitorData.mountHistoryRejectedEvents = [
      { reason: "reanchor-invalid-reference", event: { evId: "ev-a", host: "k1" } },
      { reason: "supersede-invalid-survivor", event: { evId: "ev-b", host: "k2" } }
    ];

    const result = await archiveMountHistoryRejectedEvents({ actor: "operator", nowMs: 600 });

    expect(result).toMatchObject({
      ok: true,
      reason: "mount_history_rejected_events_archived",
      archivedCount: 2
    });
    expect(mocks.monitorData.mountHistoryRejectedEvents).toEqual([]);
    expect(mocks.monitorData.inferredRecoveryEvents[0]).toMatchObject({
      type: "mount-history-rejected-events-archived",
      rejectedEventCount: 2,
      createdAt: 600
    });
    expect(mocks.monitorData.inferredRecoveryEvents[0].rejectedEvents).toHaveLength(2);
  });
});
