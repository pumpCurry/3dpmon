/**
 * @fileoverview dashboard_filament_remaining_model.js の単体テスト。
 * O8/O9 の Model 層が、表示用 projected 残量と不可逆判断用 confirmed 残量を混同しないことを検証する。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMonitorData = {
  filamentSpools: [],
  inferredCandidateStore: {}
};

vi.mock("../../3dp_lib/dashboard_data.js", () => ({ monitorData: mockMonitorData }));

const {
  IRREVERSIBLE_REMAINING_ACTION,
  buildFilamentRemainingModel,
  getIrreversibleFilamentRemaining,
  canExecuteIrreversibleRemainingAction
} = await import("../../3dp_lib/dashboard_filament_remaining_model.js");

/**
 * テスト用スプールを作成する。
 *
 * @function spool
 * @param {Object} [overrides] - 上書きするフィールド。
 * @returns {Object} スプール fixture。
 */
function spool(overrides = {}) {
  return {
    id: "S1",
    spoolId: "S1",
    remainingLengthMm: 10000,
    totalLengthMm: 330000,
    ...overrides
  };
}

/**
 * テスト用 candidate record を作成する。
 *
 * @function candidate
 * @param {Object} [overrides] - 上書きするフィールド。
 * @returns {Object} candidate fixture。
 */
function candidate(overrides = {}) {
  return {
    candidateHash: "ic-a",
    candidateSpoolId: "S1",
    host: "k1",
    usedMm: 3000,
    status: "pending",
    ...overrides
  };
}

beforeEach(() => {
  mockMonitorData.filamentSpools = [spool()];
  mockMonitorData.inferredCandidateStore = {};
});

describe("buildFilamentRemainingModel", () => {
  it("pending inferred candidate を表示用 projected 残量へだけ反映する", () => {
    mockMonitorData.inferredCandidateStore = {
      "ic-a": candidate({ candidateHash: "ic-a", usedMm: 3000 }),
      "ic-b": candidate({ candidateHash: "ic-b", usedMm: 1200 }),
      "ic-confirmed": candidate({ candidateHash: "ic-c", usedMm: 500, status: "confirmed" })
    };

    const model = buildFilamentRemainingModel("S1");

    expect(model.ok).toBe(true);
    expect(model.confirmedRemainingMm).toBe(10000);
    expect(model.pendingInferredUsedMm).toBe(4200);
    expect(model.pendingCandidateCount).toBe(2);
    expect(model.pendingCandidateHashes).toEqual(["ic-a", "ic-b"]);
    expect(model.projectedRemainingMm).toBe(5800);
    expect(model.irreversibleRemainingMm).toBe(10000);
    expect(model.warnings).toContain("projected-remaining-display-only");
  });

  it("host が指定された場合は表示対象 candidate を host 単位に絞る", () => {
    mockMonitorData.inferredCandidateStore = {
      "ic-a": candidate({ candidateHash: "ic-a", host: "k1", usedMm: 3000 }),
      "ic-b": candidate({ candidateHash: "ic-b", host: "k2", usedMm: 1200 })
    };

    const model = buildFilamentRemainingModel("S1", { host: "k1" });

    expect(model.pendingInferredUsedMm).toBe(3000);
    expect(model.pendingCandidateHashes).toEqual(["ic-a"]);
    expect(model.projectedRemainingMm).toBe(7000);
  });

  it("確定残量が不明なら projected も不可逆判断値も不明にする", () => {
    mockMonitorData.filamentSpools = [spool({ remainingLengthMm: null })];
    mockMonitorData.inferredCandidateStore = {
      "ic-a": candidate({ usedMm: 3000 })
    };

    const model = buildFilamentRemainingModel("S1");

    expect(model.ok).toBe(false);
    expect(model.reason).toBe("confirmed_remaining_unknown");
    expect(model.confirmedRemainingMm).toBe(null);
    expect(model.projectedRemainingMm).toBe(null);
    expect(model.irreversibleRemainingMm).toBe(null);
  });
});

describe("getIrreversibleFilamentRemaining", () => {
  it("pending inferred candidate があっても不可逆判断には confirmed 残量を返す", () => {
    mockMonitorData.inferredCandidateStore = {
      "ic-a": candidate({ usedMm: 9000 })
    };

    const gate = getIrreversibleFilamentRemaining("S1", {
      action: IRREVERSIBLE_REMAINING_ACTION.RUNOUT_DECISION
    });

    expect(gate.ok).toBe(true);
    expect(gate.action).toBe(IRREVERSIBLE_REMAINING_ACTION.RUNOUT_DECISION);
    expect(gate.remainingMm).toBe(10000);
    expect(gate.projectedRemainingMm).toBe(1000);
    expect(gate.ignoredPendingInferredUsedMm).toBe(9000);
    expect(gate.source).toBe("confirmed-ledger");
  });

  it("confirmed 残量が不明な不可逆判断は fail-closed する", () => {
    mockMonitorData.filamentSpools = [spool({ remainingLengthMm: "unknown" })];

    const gate = getIrreversibleFilamentRemaining("S1", {
      action: IRREVERSIBLE_REMAINING_ACTION.SPOOL_DISCARD
    });

    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe("confirmed_remaining_unknown");
    expect(gate.remainingMm).toBe(null);
  });
});

describe("canExecuteIrreversibleRemainingAction", () => {
  it("必要量判定は projected ではなく confirmed 残量で行う", () => {
    mockMonitorData.inferredCandidateStore = {
      "ic-a": candidate({ usedMm: 9500 })
    };

    const result = canExecuteIrreversibleRemainingAction("S1", 8000, {
      action: IRREVERSIBLE_REMAINING_ACTION.PRINT_START_GATE
    });

    expect(result.ok).toBe(true);
    expect(result.remainingMm).toBe(10000);
    expect(result.projectedRemainingMm).toBe(500);
    expect(result.ignoredPendingInferredUsedMm).toBe(9500);
  });

  it("confirmed 残量が必要量を満たさない場合は projected に関係なく拒否する", () => {
    mockMonitorData.inferredCandidateStore = {
      "ic-a": candidate({ usedMm: 100 })
    };

    const result = canExecuteIrreversibleRemainingAction("S1", 12000, {
      action: IRREVERSIBLE_REMAINING_ACTION.AUTO_SPOOL_SELECTION
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("confirmed_remaining_insufficient");
    expect(result.remainingMm).toBe(10000);
    expect(result.projectedRemainingMm).toBe(9900);
  });

  it("signed confirmed 残量が負数なら必要量ありの不可逆操作を拒否する", () => {
    mockMonitorData.filamentSpools = [spool({ remainingLengthMm: -300 })];

    const result = canExecuteIrreversibleRemainingAction("S1", 1, {
      action: IRREVERSIBLE_REMAINING_ACTION.PRODUCTION_PLANNING
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("confirmed_remaining_insufficient");
    expect(result.remainingMm).toBe(-300);
  });
});
