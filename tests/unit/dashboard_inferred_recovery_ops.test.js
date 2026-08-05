/**
 * @fileoverview dashboard_inferred_recovery_ops.js（#420/O6A Recovery Operations）の単体テスト
 * recovery / repair flag の解除、耐久保存失敗時 rollback、Satellite 拒否を検証する。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  monitorData: {
    inferredDecisionRecoveryRequired: null,
    inferredRecoveryOperationRecoveryRequired: null,
    inferredRecoveryEvents: [],
    ledgerRepairRequired: {},
    mountHistoryRejectedEvents: [],
    mountHistory: [],
    mountHistorySeq: 0
  },
  saveUnifiedStorageDurably: vi.fn(async () => ({ ok: true, backend: "test", reason: "saved" })),
  canExecuteLedgerDecision: vi.fn(() => true),
  getMountIntervalStatus: vi.fn(() => ({ status: "none", openInterval: null, intervals: [], diagnostics: [] })),
  appendSupersedeEvent: vi.fn(() => ({
    evId: "ev-super",
    opId: "op-super",
    seq: 3,
    type: "supersede",
    host: "k1",
    spoolId: "S1",
    targetIntervalIds: ["iv-a"],
    survivingIntervalId: "iv-b"
  })),
  queue: Promise.resolve()
}));

vi.mock("../../3dp_lib/dashboard_data.js", () => ({ monitorData: mocks.monitorData }));
vi.mock("../../3dp_lib/dashboard_storage.js", () => ({ saveUnifiedStorageDurably: mocks.saveUnifiedStorageDurably }));
vi.mock("../../3dp_lib/dashboard_time.js", () => ({ wallNowMs: () => 123456 }));
vi.mock("../../3dp_lib/dashboard_filament_ledger.js", () => ({
  appendSupersedeEvent: mocks.appendSupersedeEvent,
  getMountIntervalStatus: mocks.getMountIntervalStatus
}));
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
  clearInferredRecoveryOperationRecoveryRequired,
  clearLedgerRepairRequired,
  repairLedgerMountIntervals,
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
  mocks.monitorData.inferredRecoveryOperationRecoveryRequired = null;
  mocks.monitorData.inferredRecoveryEvents = [];
  mocks.monitorData.ledgerRepairRequired = {};
  mocks.monitorData.mountHistoryRejectedEvents = [];
  mocks.monitorData.mountHistory = [];
  mocks.monitorData.mountHistorySeq = 0;
}

beforeEach(() => {
  resetRecoveryState();
  mocks.queue = Promise.resolve();
  mocks.canExecuteLedgerDecision.mockReset();
  mocks.canExecuteLedgerDecision.mockReturnValue(true);
  mocks.saveUnifiedStorageDurably.mockReset();
  mocks.saveUnifiedStorageDurably.mockResolvedValue({ ok: true, backend: "test", reason: "saved" });
  mocks.getMountIntervalStatus.mockReset();
  mocks.getMountIntervalStatus.mockReturnValue({ status: "none", openInterval: null, intervals: [], diagnostics: [] });
  mocks.appendSupersedeEvent.mockReset();
  mocks.appendSupersedeEvent.mockImplementation(({ host, spoolId, targetIntervalIds, survivingIntervalId, ts, opId }) => {
    const event = {
      evId: "ev-super",
      opId,
      seq: 3,
      ts,
      type: "supersede",
      host,
      spoolId,
      targetIntervalIds,
      survivingIntervalId
    };
    mocks.monitorData.mountHistory.push(event);
    mocks.monitorData.mountHistorySeq = 3;
    return event;
  });
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
    expect(mocks.getMountIntervalStatus).toHaveBeenCalledWith("S1", "k1");
    expect(mocks.monitorData.ledgerRepairRequired).toEqual({});
    expect(mocks.monitorData.inferredRecoveryEvents[0]).toMatchObject({
      type: "ledger-repair-cleared",
      host: "k1",
      createdAt: 500
    });
    expect(mocks.monitorData.inferredRecoveryEvents[0].clearanceStatus.status).toBe("none");
  });

  it("現在も ambiguous/corrupt の ledger repair flag は解除しない", async () => {
    mocks.monitorData.ledgerRepairRequired = {
      k1: { spoolId: "S1", status: "ambiguous", detectedAtEpochMs: 100 }
    };
    mocks.getMountIntervalStatus.mockReturnValueOnce({
      status: "ambiguous",
      openInterval: null,
      intervals: [{ intervalId: "iv-a" }, { intervalId: "iv-b" }],
      diagnostics: []
    });

    const result = await clearLedgerRepairRequired("k1");

    expect(result).toMatchObject({
      ok: false,
      reason: "ledger_repair_still_unresolved",
      host: "k1",
      status: { status: "ambiguous" }
    });
    expect(mocks.monitorData.ledgerRepairRequired.k1.status).toBe("ambiguous");
    expect(mocks.monitorData.inferredRecoveryEvents).toHaveLength(0);
    expect(mocks.saveUnifiedStorageDurably).not.toHaveBeenCalled();
  });

  it("#424/O6D: ok/none 以外の未知状態では ledger repair flag を解除しない", async () => {
    mocks.monitorData.ledgerRepairRequired = {
      k1: { spoolId: "S1", status: "ambiguous", detectedAtEpochMs: 100 }
    };
    mocks.getMountIntervalStatus.mockReturnValueOnce({
      status: "error",
      openInterval: null,
      intervals: [],
      diagnostics: [{ code: "status-read-failed" }]
    });

    const result = await clearLedgerRepairRequired("k1");

    expect(result).toMatchObject({
      ok: false,
      reason: "ledger_repair_still_unresolved",
      host: "k1",
      status: { status: "error" }
    });
    expect(mocks.monitorData.ledgerRepairRequired.k1.status).toBe("ambiguous");
    expect(mocks.saveUnifiedStorageDurably).not.toHaveBeenCalled();
  });

  it("spoolId がない ledger repair flag は解除しない", async () => {
    mocks.monitorData.ledgerRepairRequired = {
      k1: { status: "ambiguous", detectedAtEpochMs: 100 }
    };

    const result = await clearLedgerRepairRequired("k1");

    expect(result).toMatchObject({ ok: false, reason: "ledger_repair_spool_required", host: "k1" });
    expect(mocks.getMountIntervalStatus).not.toHaveBeenCalled();
    expect(mocks.saveUnifiedStorageDurably).not.toHaveBeenCalled();
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

  it("#424/O6D: rollback 保存にも失敗した場合は recovery operation blocker を残し後続通常操作を止める", async () => {
    const repair = { k1: { spoolId: "S1", status: "ambiguous", detectedAtEpochMs: 100 } };
    mocks.monitorData.ledgerRepairRequired = { k1: { ...repair.k1 } };
    mocks.saveUnifiedStorageDurably
      .mockResolvedValueOnce({ ok: false, backend: "indexedDB", reason: "idb_flush_failed" })
      .mockResolvedValueOnce({ ok: false, backend: "indexedDB", reason: "rollback_flush_failed" })
      .mockResolvedValueOnce({ ok: true, backend: "indexedDB", reason: "blocker_saved" });

    const result = await clearLedgerRepairRequired("k1", { nowMs: 900 });

    expect(result).toMatchObject({ ok: false, reason: "recovery_operation_rollback_save_failed" });
    expect(result.recovery).toMatchObject({
      operation: "clearLedgerRepairRequired",
      reason: "rollback_durable_save_failed",
      failureReason: "ledger_repair_clear_not_durably_saved",
      target: { host: "k1", spoolId: "S1" },
      createdAt: 900
    });
    expect(result.recoverySave).toEqual({ ok: true, backend: "indexedDB", reason: "blocker_saved" });
    expect(mocks.monitorData.ledgerRepairRequired).toEqual(repair);
    expect(mocks.monitorData.inferredRecoveryOperationRecoveryRequired).toEqual(result.recovery);
    expect(mocks.saveUnifiedStorageDurably).toHaveBeenCalledTimes(3);

    const blocked = await archiveMountHistoryRejectedEvents();
    expect(blocked).toMatchObject({ ok: false, reason: "recovery_required" });
    expect(mocks.saveUnifiedStorageDurably).toHaveBeenCalledTimes(3);
  });
});

describe("clearInferredRecoveryOperationRecoveryRequired", () => {
  it("確認済みの recovery operation blocker を解除し audit event を保存する", async () => {
    mocks.monitorData.inferredRecoveryOperationRecoveryRequired = {
      operation: "clearLedgerRepairRequired",
      reason: "rollback_durable_save_failed",
      createdAt: 900
    };

    const result = await clearInferredRecoveryOperationRecoveryRequired({ actor: "operator", note: "checked", nowMs: 950 });

    expect(result).toMatchObject({ ok: true, reason: "recovery_operation_recovery_cleared" });
    expect(mocks.monitorData.inferredRecoveryOperationRecoveryRequired).toBeNull();
    expect(mocks.monitorData.inferredRecoveryEvents[0]).toMatchObject({
      type: "recovery-operation-recovery-cleared",
      actor: "operator",
      note: "checked",
      createdAt: 950
    });
  });
});

describe("repairLedgerMountIntervals", () => {
  it("ambiguous な ledger repair を survivor 選択で supersede 修復し flag を解除する", async () => {
    mocks.monitorData.ledgerRepairRequired = {
      k1: { spoolId: "S1", status: "ambiguous", detectedAtEpochMs: 100 }
    };
    mocks.getMountIntervalStatus
      .mockReturnValueOnce({
        status: "ambiguous",
        openInterval: null,
        intervals: [
          { intervalId: "iv-a", host: "k1", untilJobId: null, sinceJobId: 1, anchorRemainingMm: 10000, boundaryStatus: "known" },
          { intervalId: "iv-b", host: "k1", untilJobId: null, sinceJobId: 2, anchorRemainingMm: 9000, boundaryStatus: "known" }
        ],
        diagnostics: []
      })
      .mockReturnValueOnce({
        status: "ok",
        openInterval: { intervalId: "iv-b", host: "k1", untilJobId: null },
        intervals: [{ intervalId: "iv-b", host: "k1", untilJobId: null }],
        diagnostics: []
      });

    const result = await repairLedgerMountIntervals("k1", "iv-b", { actor: "operator", nowMs: 700 });

    expect(result).toMatchObject({
      ok: true,
      reason: "ledger_repair_intervals_repaired",
      host: "k1",
      survivingIntervalId: "iv-b",
      supersededIntervalIds: ["iv-a"]
    });
    expect(mocks.appendSupersedeEvent).toHaveBeenCalledWith({
      host: "k1",
      spoolId: "S1",
      targetIntervalIds: ["iv-a"],
      survivingIntervalId: "iv-b",
      reason: "operator-selected-survivor",
      ts: 700,
      opId: "o6_repair_k1_S1_iv-b_700"
    });
    expect(mocks.monitorData.ledgerRepairRequired).toEqual({});
    expect(mocks.monitorData.inferredRecoveryEvents[0]).toMatchObject({
      type: "ledger-intervals-repaired",
      host: "k1",
      spoolId: "S1",
      survivingIntervalId: "iv-b",
      supersededIntervalIds: ["iv-a"]
    });
    expect(mocks.saveUnifiedStorageDurably).toHaveBeenCalledTimes(1);
  });

  it("ambiguous ではない ledger repair は修復しない", async () => {
    mocks.monitorData.ledgerRepairRequired = {
      k1: { spoolId: "S1", status: "ambiguous", detectedAtEpochMs: 100 }
    };
    mocks.getMountIntervalStatus.mockReturnValueOnce({
      status: "corrupt",
      openInterval: null,
      intervals: [],
      diagnostics: [{ code: "supersede-invalid-reference" }]
    });

    const result = await repairLedgerMountIntervals("k1", "iv-b");

    expect(result).toMatchObject({ ok: false, reason: "ledger_repair_not_ambiguous", host: "k1" });
    expect(mocks.appendSupersedeEvent).not.toHaveBeenCalled();
    expect(mocks.saveUnifiedStorageDurably).not.toHaveBeenCalled();
  });

  it("選択 survivor が open 区間ではない場合は fail-closed する", async () => {
    mocks.monitorData.ledgerRepairRequired = {
      k1: { spoolId: "S1", status: "ambiguous", detectedAtEpochMs: 100 }
    };
    mocks.getMountIntervalStatus.mockReturnValueOnce({
      status: "ambiguous",
      openInterval: null,
      intervals: [
        { intervalId: "iv-a", host: "k1", untilJobId: null, sinceJobId: 1, anchorRemainingMm: 10000, boundaryStatus: "known" },
        { intervalId: "iv-b", host: "k1", untilJobId: null, sinceJobId: 2, anchorRemainingMm: 9000, boundaryStatus: "known" }
      ],
      diagnostics: []
    });

    const result = await repairLedgerMountIntervals("k1", "iv-c");

    expect(result).toMatchObject({ ok: false, reason: "ledger_repair_survivor_not_open", host: "k1" });
    expect(mocks.appendSupersedeEvent).not.toHaveBeenCalled();
    expect(mocks.saveUnifiedStorageDurably).not.toHaveBeenCalled();
  });

  it("保存失敗時は supersede event と repair flag を rollback する", async () => {
    const repair = { k1: { spoolId: "S1", status: "ambiguous", detectedAtEpochMs: 100 } };
    const mountHistory = [{ evId: "mount-a", intervalId: "iv-a", type: "mount", host: "k1", spoolId: "S1" }];
    mocks.monitorData.ledgerRepairRequired = { k1: { ...repair.k1 } };
    mocks.monitorData.mountHistory = mountHistory.map(item => ({ ...item }));
    mocks.monitorData.mountHistorySeq = 1;
    mocks.getMountIntervalStatus
      .mockReturnValueOnce({
        status: "ambiguous",
        openInterval: null,
        intervals: [
          { intervalId: "iv-a", host: "k1", untilJobId: null, sinceJobId: 1, anchorRemainingMm: 10000, boundaryStatus: "known" },
          { intervalId: "iv-b", host: "k1", untilJobId: null, sinceJobId: 2, anchorRemainingMm: 9000, boundaryStatus: "known" }
        ],
        diagnostics: []
      })
      .mockReturnValueOnce({
        status: "ok",
        openInterval: { intervalId: "iv-b", host: "k1", untilJobId: null },
        intervals: [{ intervalId: "iv-b", host: "k1", untilJobId: null }],
        diagnostics: []
      });
    mocks.saveUnifiedStorageDurably
      .mockResolvedValueOnce({ ok: false, backend: "indexedDB", reason: "idb_flush_failed" })
      .mockResolvedValueOnce({ ok: true, backend: "indexedDB", reason: "flushed" });

    const result = await repairLedgerMountIntervals("k1", "iv-b", { nowMs: 800 });

    expect(result).toMatchObject({ ok: false, reason: "ledger_repair_repair_not_durably_saved" });
    expect(mocks.monitorData.ledgerRepairRequired).toEqual(repair);
    expect(mocks.monitorData.mountHistory).toEqual(mountHistory);
    expect(mocks.monitorData.mountHistorySeq).toBe(1);
    expect(mocks.monitorData.inferredRecoveryEvents).toHaveLength(0);
    expect(mocks.saveUnifiedStorageDurably).toHaveBeenCalledTimes(2);
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
