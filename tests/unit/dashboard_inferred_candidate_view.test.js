/**
 * @fileoverview dashboard_inferred_candidate_view.js（#415-O5B ViewModel）の単体テスト
 * Candidate Store から UI 表示モデルを read-only に生成することを検証する。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  monitorData: {
    machines: {},
    filamentSpools: [],
    inferredCandidateStore: {}
  },
  canSubmit: true,
  getMountIntervalStatus: vi.fn(() => ({ status: "none", openInterval: null, intervals: [], diagnostics: [] })),
  reconciliationReport: {
    ok: true,
    status: "ok",
    checkedAt: 0,
    candidateCount: 0,
    spoolCount: 0,
    decisionEventCount: 0,
    undoEventCount: 0,
    remainingBalanceOkCount: 0,
    remainingBalanceMismatchCount: 0,
    remainingBalanceUnverifiableCount: 0,
    remainingBalances: [],
    issueCount: 0,
    visibleIssueCount: 0,
    truncated: false,
    blockerCount: 0,
    warningCount: 0,
    infoCount: 0,
    issues: []
  }
}));

vi.mock("../../3dp_lib/dashboard_data.js", () => ({ monitorData: mocks.monitorData }));
vi.mock("../../3dp_lib/dashboard_filament_ledger.js", () => ({
  getMountIntervalStatus: mocks.getMountIntervalStatus
}));
vi.mock("../../3dp_lib/dashboard_inferred_candidate_decision.js", () => ({
  canSubmitLedgerDecision: () => mocks.canSubmit
}));
vi.mock("../../3dp_lib/dashboard_inferred_reconciliation.js", () => ({
  buildInferredLedgerReconciliationReport: vi.fn(() => mocks.reconciliationReport)
}));
vi.mock("../../3dp_lib/dashboard_spool.js", () => ({
  formatFilamentAmount: (mm) => ({ display: `${Math.round(Number(mm)).toLocaleString()} mm` }),
  formatSpoolDisplayId: (spool) => `#${spool.serialNo || spool.id}`
}));

const {
  INFERRED_CANDIDATE_FILTER,
  INFERRED_CANDIDATE_SORT,
  buildInferredRecoverySurfaceViewModel,
  buildInferredCandidateViewModel,
  countPendingInferredCandidates,
  listInferredCandidateViewModels
} = await import("../../3dp_lib/dashboard_inferred_candidate_view.js");

/**
 * candidate fixture を作る。
 *
 * @function record
 * @param {string} hash - candidateHash。
 * @param {Object} over - 上書き値。
 * @returns {Object} candidate record。
 */
function record(hash, over = {}) {
  return {
    candidateHash: hash,
    status: "pending",
    host: "k1",
    candidateSpoolId: "S1",
    usedMm: 3000,
    confidence: { level: "high" },
    evidence: { sameMountedSpool: true },
    observationKeys: ["kA", "kB"],
    candidateDebits: [
      { observationKey: "kA", status: "inferred-debit", usedMm: 1000 },
      { observationKey: "kB", status: "inferred-debit", usedMm: 2000 }
    ],
    createdAt: 2000,
    updatedAt: 3000,
    events: [{ type: "created", status: "pending" }],
    ...over
  };
}

beforeEach(() => {
  mocks.canSubmit = true;
  mocks.monitorData.machines = {
    k1: {
      storedData: { hostname: { rawValue: "K1 Max" } },
      printStore: {
        history: [
          { id: "A", observationKey: "kA", printfinish: 1, materialUsedMm: 1000, filename: "a.gcode" },
          { id: "B", observationKey: "kB", printfinish: 1, materialUsedMm: 2000, filename: "b.gcode" }
        ]
      }
    }
  };
  mocks.monitorData.filamentSpools = [
    { id: "S1", serialNo: 12, name: "PLA Red", remainingLengthMm: 10000, filamentColor: "red" },
    { id: "S2", serialNo: 13, name: "PLA Blue", remainingLengthMm: 8000, filamentColor: "blue" }
  ];
  mocks.monitorData.inferredCandidateStore = {
    "ic-new": record("ic-new", { createdAt: 3000 }),
    "ic-old": record("ic-old", { createdAt: 1000, status: "confirmed" })
  };
  delete mocks.monitorData.inferredDecisionRecoveryRequired;
  delete mocks.monitorData.inferredRecoveryOperationRecoveryRequired;
  mocks.monitorData.inferredRecoveryEvents = [];
  mocks.monitorData.ledgerRepairRequired = {};
  mocks.monitorData.mountHistoryRejectedEvents = [];
  mocks.reconciliationReport = {
    ok: true,
    status: "ok",
    checkedAt: 0,
    candidateCount: 0,
    spoolCount: 0,
    decisionEventCount: 0,
    undoEventCount: 0,
    remainingBalanceOkCount: 0,
    remainingBalanceMismatchCount: 0,
    remainingBalanceUnverifiableCount: 0,
    remainingBalances: [],
    issueCount: 0,
    visibleIssueCount: 0,
    truncated: false,
    blockerCount: 0,
    warningCount: 0,
    infoCount: 0,
    issues: []
  };
  mocks.getMountIntervalStatus.mockReset();
  mocks.getMountIntervalStatus.mockReturnValue({ status: "none", openInterval: null, intervals: [], diagnostics: [] });
});

describe("buildInferredCandidateViewModel", () => {
  it("pending candidate の残量差分・履歴・操作可否を生成する", () => {
    const vm = buildInferredCandidateViewModel(mocks.monitorData.inferredCandidateStore["ic-new"]);

    expect(vm.statusLabel).toBe("Pending");
    expect(vm.hostLabel).toBe("K1 Max");
    expect(vm.candidateSpoolName).toContain("PLA Red");
    expect(vm.usedDisplay).toBe("3,000 mm");
    expect(vm.confirmedRemainingMm).toBe(10000);
    expect(vm.projectedRemainingMm).toBe(7000);
    expect(vm.jobCount).toBe(2);
    expect(vm.jobs.map(job => job.filename)).toEqual(["a.gcode", "b.gcode"]);
    expect(vm.canConfirm).toBe(true);
    expect(vm.warningCodes).toEqual([]);
  });

  it("Satellite相当では閲覧専用 warning と操作不可を返す", () => {
    mocks.canSubmit = false;

    const vm = buildInferredCandidateViewModel(mocks.monitorData.inferredCandidateStore["ic-new"]);

    expect(vm.canConfirm).toBe(false);
    expect(vm.canReject).toBe(false);
    expect(vm.canReassign).toBe(false);
    expect(vm.readOnlyReason).toBe("relay-readonly");
    expect(vm.warningCodes).toContain("relay-readonly");
  });

  it("Satellite request が可能な場合は操作ボタンを有効化する", () => {
    mocks.canSubmit = true;

    const vm = buildInferredCandidateViewModel(mocks.monitorData.inferredCandidateStore["ic-new"]);

    expect(vm.canConfirm).toBe(true);
    expect(vm.canReject).toBe(true);
    expect(vm.canReassign).toBe(true);
    expect(vm.readOnlyReason).toBeNull();
  });

  it("confirmed / reassigned candidate だけ Undo を有効化する", () => {
    const pending = buildInferredCandidateViewModel(mocks.monitorData.inferredCandidateStore["ic-new"]);
    const confirmed = buildInferredCandidateViewModel(mocks.monitorData.inferredCandidateStore["ic-old"]);
    const reassigned = buildInferredCandidateViewModel(record("ic-reassign", { status: "reassigned", assignedSpoolId: "S2" }));
    const rejected = buildInferredCandidateViewModel(record("ic-reject", { status: "rejected" }));

    expect(pending.canUndo).toBe(false);
    expect(confirmed.canUndo).toBe(true);
    expect(reassigned.canUndo).toBe(true);
    expect(rejected.canUndo).toBe(false);
  });

  it("O4保存後に履歴が帰属済みになった場合は警告へ出す", () => {
    mocks.monitorData.machines.k1.printStore.history[0].filamentInfo = [{ spoolId: "S9" }];

    const vm = buildInferredCandidateViewModel(mocks.monitorData.inferredCandidateStore["ic-new"]);

    expect(vm.warningCodes).toContain("history-already-attributed");
  });

  it("#424/O6D: recovery operation blocker がある場合は candidate decision を無効化する", () => {
    mocks.monitorData.inferredRecoveryOperationRecoveryRequired = {
      operation: "clearLedgerRepairRequired",
      reason: "rollback_durable_save_failed",
      createdAt: 900
    };

    const vm = buildInferredCandidateViewModel(mocks.monitorData.inferredCandidateStore["ic-new"]);

    expect(vm.canConfirm).toBe(false);
    expect(vm.canReject).toBe(false);
    expect(vm.canReassign).toBe(false);
    expect(vm.readOnlyReason).toBe("recovery-required");
    expect(vm.warningCodes).toContain("decision-recovery-required");
  });
});

describe("listInferredCandidateViewModels", () => {
  it("status filter と sort を適用する", () => {
    const pending = listInferredCandidateViewModels({
      status: INFERRED_CANDIDATE_FILTER.PENDING,
      sort: INFERRED_CANDIDATE_SORT.NEWEST
    });
    const allOldest = listInferredCandidateViewModels({
      status: INFERRED_CANDIDATE_FILTER.ALL,
      sort: INFERRED_CANDIDATE_SORT.OLDEST
    });

    expect(pending.map(vm => vm.candidateHash)).toEqual(["ic-new"]);
    expect(allOldest.map(vm => vm.candidateHash)).toEqual(["ic-old", "ic-new"]);
    expect(countPendingInferredCandidates()).toBe(1);
    expect(INFERRED_CANDIDATE_FILTER.UNDONE).toBe("undone");
  });
});

describe("buildInferredRecoverySurfaceViewModel", () => {
  it("recovery / ledger repair / rejected mount events を read-only card に変換する", () => {
    mocks.monitorData.inferredDecisionRecoveryRequired = {
      candidateHash: "ic-new",
      action: "confirmInferredCandidate",
      reason: "rollback_durable_save_failed",
      createdAt: 4000,
      save: { reason: "quota" },
      rollbackSave: { reason: "quota-again" }
    };
    mocks.monitorData.ledgerRepairRequired = {
      k1: { spoolId: "S1", status: "ambiguous", detectedAtEpochMs: 5000 }
    };
    mocks.getMountIntervalStatus.mockReturnValueOnce({
      status: "ambiguous",
      openInterval: null,
      intervals: [
        { intervalId: "iv-a", untilJobId: null, sinceJobId: 1, anchorRemainingMm: 10000, boundaryStatus: "known" },
        { intervalId: "iv-b", untilJobId: null, sinceJobId: 2, anchorRemainingMm: 9000, boundaryStatus: "unknown" }
      ],
      diagnostics: []
    });
    mocks.monitorData.mountHistoryRejectedEvents = [
      { reason: "reanchor-invalid-reference", event: { evId: "ev-a", host: "k1", spoolId: "S1" } },
      { reason: "supersede-invalid-survivor", event: { evId: "ev-b", host: "k2", spoolId: "S2" } }
    ];

    const vm = buildInferredRecoverySurfaceViewModel({ maxRejectedEvents: 1 });

    expect(vm.hasIssues).toBe(true);
    expect(vm.totalCount).toBe(3);
    expect(vm.blockerCount).toBe(2);
    expect(vm.warningCount).toBe(1);
    expect(vm.infoCount).toBe(0);
    expect(vm.cards.map(card => card.type)).toEqual([
      "decision-recovery",
      "ledger-repair",
      "mount-history-rejected"
    ]);
    expect(vm.cards[0].details).toContainEqual({ label: "Candidate", value: "ic-new" });
    expect(vm.cards[1].summary).toContain("K1 Max");
    expect(vm.cards[1].repairStatus.status).toBe("ambiguous");
    expect(vm.cards[1].openIntervals.map(interval => interval.intervalId)).toEqual(["iv-a", "iv-b"]);
    expect(vm.cards[1].details).toContainEqual({ label: "Open intervals", value: "2" });
    expect(vm.cards[2].details).toHaveLength(1);
    expect(vm.cards[2].details[0].value).toContain("ev-b");
  });

  it("#421/O6B: recovery 操作 audit event を info card に変換する", () => {
    mocks.monitorData.inferredRecoveryEvents = [
      {
        eventId: "ir-a",
        type: "recovery-durable-save-retried",
        actor: "operator-a",
        createdAt: 1000,
        decisionRecovery: { candidateHash: "ic-old" }
      },
      {
        eventId: "ir-b",
        type: "decision-recovery-cleared",
        actor: "operator-b",
        createdAt: 3000,
        clearedRecovery: { candidateHash: "ic-new" }
      }
    ];

    const vm = buildInferredRecoverySurfaceViewModel({ maxRecoveryEvents: 1 });

    expect(vm.hasIssues).toBe(true);
    expect(vm.blockerCount).toBe(0);
    expect(vm.warningCount).toBe(0);
    expect(vm.infoCount).toBe(1);
    expect(vm.cards.map(card => card.type)).toEqual(["recovery-audit"]);
    expect(vm.cards[0].summary).toContain("2件");
    expect(vm.cards[0].details).toHaveLength(1);
    expect(vm.cards[0].details[0].value).toContain("decision-recovery-cleared");
    expect(vm.cards[0].details[0].value).toContain("ic-new");
  });

  it("#424/O6D: recovery operation blocker を blocker card に変換する", () => {
    mocks.monitorData.inferredRecoveryOperationRecoveryRequired = {
      operation: "clearLedgerRepairRequired",
      reason: "rollback_durable_save_failed",
      failureReason: "ledger_repair_clear_not_durably_saved",
      createdAt: 900,
      target: { host: "k1", spoolId: "S1" },
      save: { reason: "idb_flush_failed" },
      rollbackSave: { reason: "rollback_flush_failed" }
    };

    const vm = buildInferredRecoverySurfaceViewModel();

    expect(vm.hasIssues).toBe(true);
    expect(vm.blockerCount).toBe(1);
    expect(vm.cards[0]).toMatchObject({
      type: "recovery-operation-recovery",
      severity: "blocker",
      title: "O6 recovery operation recovery required"
    });
    expect(vm.cards[0].details).toContainEqual({ label: "Operation", value: "clearLedgerRepairRequired" });
    expect(vm.cards[0].details).toContainEqual({ label: "Failure", value: "ledger_repair_clear_not_durably_saved" });
  });

  it("#425/O7A: ledger reconciliation issue を read-only blocker card に変換する", () => {
    mocks.reconciliationReport = {
      ok: false,
      status: "blocker",
      checkedAt: 7000,
      candidateCount: 2,
      spoolCount: 1,
      decisionEventCount: 1,
      undoEventCount: 0,
      remainingBalanceOkCount: 0,
      remainingBalanceMismatchCount: 1,
      remainingBalanceUnverifiableCount: 0,
      remainingBalances: [{ spoolId: "S1", status: "mismatch" }],
      issueCount: 1,
      visibleIssueCount: 1,
      truncated: false,
      blockerCount: 1,
      warningCount: 0,
      infoCount: 0,
      issues: [{
        severity: "blocker",
        reason: "candidate_ledger_event_missing",
        repairHint: "restore-ledger-event-or-reopen-candidate",
        candidateHash: "ic-old",
        host: "k1",
        spoolId: "S1",
        eventId: null,
        observationKey: null,
        details: {}
      }]
    };

    const vm = buildInferredRecoverySurfaceViewModel();

    expect(vm.hasIssues).toBe(true);
    expect(vm.blockerCount).toBe(1);
    expect(vm.cards[0]).toMatchObject({
      type: "ledger-reconciliation",
      severity: "blocker",
      title: "Ledger reconciliation issues"
    });
    expect(vm.cards[0].details).toContainEqual({ label: "Remaining mismatch", value: "1" });
    const issueDetail = vm.cards[0].details.find(item => item.label === "Issue 1");
    expect(issueDetail?.value).toContain("candidate_ledger_event_missing");
    expect(issueDetail?.value).toContain("restore-ledger-event-or-reopen-candidate");
    expect(vm.cards[0].reconciliation.issueCount).toBe(1);
  });

  it("recovery item がない場合は空の診断モデルを返す", () => {
    const vm = buildInferredRecoverySurfaceViewModel();

    expect(vm).toMatchObject({
      hasIssues: false,
      totalCount: 0,
      blockerCount: 0,
      warningCount: 0,
      cards: []
    });
  });
});
