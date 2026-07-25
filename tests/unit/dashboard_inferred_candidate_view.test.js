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
  canSubmit: true
}));

vi.mock("../../3dp_lib/dashboard_data.js", () => ({ monitorData: mocks.monitorData }));
vi.mock("../../3dp_lib/dashboard_inferred_candidate_decision.js", () => ({
  canSubmitLedgerDecision: () => mocks.canSubmit
}));
vi.mock("../../3dp_lib/dashboard_spool.js", () => ({
  formatFilamentAmount: (mm) => ({ display: `${Math.round(Number(mm)).toLocaleString()} mm` }),
  formatSpoolDisplayId: (spool) => `#${spool.serialNo || spool.id}`
}));

const {
  INFERRED_CANDIDATE_FILTER,
  INFERRED_CANDIDATE_SORT,
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
