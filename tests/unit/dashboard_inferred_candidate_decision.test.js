/**
 * @fileoverview dashboard_inferred_candidate_decision.js（#414-O5A Decision Core）の単体テスト
 * Confirm / Reject / Reassign が pending candidate だけを入口にし、保存失敗時に rollback することを検証する。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  monitorData: {
    machines: {},
    filamentSpools: [],
    inferredCandidateStore: {}
  },
  saveUnifiedStorageDurably: vi.fn(async () => ({ ok: true, backend: "test", reason: "saved" })),
  sendRelayFilament: vi.fn(() => true),
  getRelayMode: vi.fn(() => "standalone"),
  eventSeq: 0
}));

vi.mock("../../3dp_lib/dashboard_data.js", () => ({ monitorData: mocks.monitorData }));
vi.mock("../../3dp_lib/dashboard_storage.js", () => ({ saveUnifiedStorageDurably: mocks.saveUnifiedStorageDurably }));
vi.mock("../../3dp_lib/dashboard_time.js", () => ({
  wallNowMs: () => 10000,
  randomEventId: (prefix = "evt") => `${prefix}-${++mocks.eventSeq}`
}));
vi.mock("../../3dp_lib/dashboard_filament_inventory.js", () => ({ consumeInventory: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_ui.js", () => ({ updateStoredDataToDOM: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_printmanager.js", () => ({
  updateHistoryList: vi.fn(),
  loadHistory: vi.fn(() => []),
  saveHistory: vi.fn()
}));
vi.mock("../../3dp_lib/dashboard_connection.js", () => ({ getDisplayBaseUrl: vi.fn(() => "") }));
vi.mock("../../3dp_lib/dashboard_client_sync.js", () => ({
  sendRelayFilament: mocks.sendRelayFilament,
  getRelayMode: mocks.getRelayMode
}));
vi.mock("../../3dp_lib/dashboard_filament_ledger.js", () => ({
  appendMountEvent: vi.fn(),
  appendUnmountEvent: vi.fn(),
  appendReanchorEvent: vi.fn(),
  reconcileSpool: vi.fn(),
  getOpenFilamentEvent: vi.fn(() => null),
  resolveFilamentEvent: vi.fn(),
  deriveSpoolRemaining: vi.fn(),
  getOpenMountInterval: vi.fn(() => null),
  getMountIntervalStatus: vi.fn(() => "none")
}));
vi.mock("../../3dp_lib/dashboard_utils.js", () => ({
  normalizeJobId: (id) => (id == null || id === "" || String(id) === "0" ? null : String(id))
}));

const {
  INFERRED_CANDIDATE_STATUS
} = await import("../../3dp_lib/dashboard_offline_candidate_store.js");
const {
  canExecuteLedgerDecision,
  canSubmitLedgerDecision,
  confirmInferredCandidate,
  rejectInferredCandidate,
  reassignInferredCandidate
} = await import("../../3dp_lib/dashboard_inferred_candidate_decision.js");
const { sendRelayFilament } = await import("../../3dp_lib/dashboard_client_sync.js");

/**
 * observation key を持つ履歴 fixture を作る。
 *
 * @function job
 * @param {string} key - observation key。
 * @param {number} usedMm - 使用量 mm。
 * @param {Object} [over] - 上書き値。
 * @returns {Object} 履歴行 fixture。
 */
function job(key, usedMm, over = {}) {
  return {
    id: key,
    observationKey: key,
    printfinish: 1,
    materialUsedMm: usedMm,
    filename: `${key}.gcode`,
    ...over
  };
}

/**
 * spool fixture を作る。
 *
 * @function spool
 * @param {string} id - spool ID。
 * @param {number|null} remainingLengthMm - 残量 mm。
 * @returns {Object} spool fixture。
 */
function spool(id, remainingLengthMm) {
  return {
    id,
    serialNo: `${id}-serial`,
    name: `${id} spool`,
    colorName: "black",
    filamentColor: "#000000",
    material: "PLA",
    printCount: 2,
    remainingLengthMm,
    usedLengthLog: []
  };
}

/**
 * candidate fixture を作る。
 *
 * @function candidate
 * @param {Object} [over] - 上書き値。
 * @returns {Object} inferredCandidateStore record fixture。
 */
function candidate(over = {}) {
  return {
    candidateHash: "ic-a",
    host: "k1",
    windowId: "win-a",
    candidateSpoolId: "S1",
    observationKeys: ["kA", "kB"],
    candidateDebits: [
      { observationKey: "kA", status: "inferred-debit", usedMm: 1000, reason: "unattributed-usage", confirmedSpoolIds: [] },
      { observationKey: "kB", status: "inferred-debit", usedMm: 2000, reason: "unattributed-usage", confirmedSpoolIds: [] }
    ],
    usedMm: 3000,
    confidence: { level: "high" },
    evidence: { sameMountedSpool: true },
    status: INFERRED_CANDIDATE_STATUS.PENDING,
    events: [{ type: "created", at: 9000, status: INFERRED_CANDIDATE_STATUS.PENDING, usedMm: 3000 }],
    ...over
  };
}

beforeEach(() => {
  mocks.saveUnifiedStorageDurably.mockReset();
  mocks.saveUnifiedStorageDurably.mockResolvedValue({ ok: true, backend: "test", reason: "saved" });
  mocks.sendRelayFilament.mockReset();
  mocks.sendRelayFilament.mockReturnValue(true);
  mocks.getRelayMode.mockReset();
  mocks.getRelayMode.mockReturnValue("standalone");
  mocks.eventSeq = 0;
  delete globalThis.window;
  mocks.monitorData.machines = {
    k1: {
      storedData: {},
      runtimeData: {},
      printStore: { history: [job("kA", 1000), job("kB", 2000)] }
    }
  };
  mocks.monitorData.filamentSpools = [spool("S1", 10000), spool("S2", 8000)];
  mocks.monitorData.inferredCandidateStore = { "ic-a": candidate() };
  delete mocks.monitorData.inferredDecisionRecoveryRequired;
});

describe("canExecuteLedgerDecision", () => {
  it("standalone / parent 相当では decision を許可する", () => {
    expect(canExecuteLedgerDecision()).toBe(true);
  });

  it("satellite / readonly 子では decision を禁止する", async () => {
    globalThis.window = { _3dpmonRelayChild: true };

    const result = await confirmInferredCandidate("ic-a", { nowMs: 11000 });

    expect(canExecuteLedgerDecision()).toBe(false);
    expect(canSubmitLedgerDecision()).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("decision_not_authorized");
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(10000);
    expect(mocks.saveUnifiedStorageDurably).not.toHaveBeenCalled();
  });

  it("satellite 操作モードではローカル台帳を書かず Parent へ decision request を送る", async () => {
    globalThis.window = { _3dpmonRelayChild: true };
    mocks.getRelayMode.mockReturnValue("satellite");

    const result = await confirmInferredCandidate("ic-a", { actor: "operator", nowMs: 11000 });

    expect(canExecuteLedgerDecision()).toBe(false);
    expect(canSubmitLedgerDecision()).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      reason: "decision_requested",
      relayed: true,
      action: "confirmInferredCandidate",
      candidateHash: "ic-a"
    });
    expect(sendRelayFilament).toHaveBeenCalledWith("confirmInferredCandidate", {
      candidateHash: "ic-a",
      actor: "operator"
    });
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(10000);
    expect(mocks.monitorData.inferredCandidateStore["ic-a"].status).toBe(INFERRED_CANDIDATE_STATUS.PENDING);
    expect(mocks.saveUnifiedStorageDurably).not.toHaveBeenCalled();
  });

  it("satellite request 送信に失敗した場合は未処理として返す", async () => {
    globalThis.window = { _3dpmonRelayChild: true };
    mocks.getRelayMode.mockReturnValue("satellite");
    mocks.sendRelayFilament.mockReturnValue(false);

    const result = await rejectInferredCandidate("ic-a", { actor: "operator", reason: "other", note: "skip" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("decision_request_not_sent");
    expect(sendRelayFilament).toHaveBeenCalledWith("rejectInferredCandidate", {
      candidateHash: "ic-a",
      actor: "operator",
      reason: "other",
      note: "skip"
    });
    expect(mocks.monitorData.inferredCandidateStore["ic-a"].status).toBe(INFERRED_CANDIDATE_STATUS.PENDING);
    expect(mocks.saveUnifiedStorageDurably).not.toHaveBeenCalled();
  });
});

describe("confirmInferredCandidate", () => {
  it("pending candidate を確定し、残量・履歴・usedLengthLog・candidate status を更新して保存する", async () => {
    const result = await confirmInferredCandidate("ic-a", { actor: "operator", nowMs: 11000 });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("confirmed");
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(7000);
    expect(mocks.monitorData.filamentSpools[0].usedLengthLog[0]).toMatchObject({
      type: "inferred-continuity-confirmed",
      candidateHash: "ic-a",
      spoolId: "S1",
      usedMm: 3000,
      decisionType: "confirm",
      actor: "operator"
    });
    const history = mocks.monitorData.machines.k1.printStore.history;
    expect(history[0].filamentId).toBe("S1");
    expect(history[0].filamentInfo[0]).toMatchObject({
      spoolId: "S1",
      usedMm: 1000,
      isInferredContinuityConfirmed: true,
      candidateHash: "ic-a"
    });
    expect(mocks.monitorData.inferredCandidateStore["ic-a"].status).toBe(INFERRED_CANDIDATE_STATUS.CONFIRMED);
    expect(mocks.saveUnifiedStorageDurably).toHaveBeenCalledTimes(1);
  });

  it("pending 以外の candidate は台帳にも保存にも進めない", async () => {
    mocks.monitorData.inferredCandidateStore["ic-a"].status = INFERRED_CANDIDATE_STATUS.SUPERSEDED;

    const result = await confirmInferredCandidate("ic-a", { nowMs: 11000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("candidate_not_pending");
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(10000);
    expect(mocks.saveUnifiedStorageDurably).not.toHaveBeenCalled();
  });

  it("対象 spool の確定残量が不明なら fail-closed する", async () => {
    mocks.monitorData.filamentSpools[0].remainingLengthMm = null;

    const result = await confirmInferredCandidate("ic-a", { nowMs: 11000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("confirmed_remaining_unknown");
    expect(mocks.saveUnifiedStorageDurably).not.toHaveBeenCalled();
  });

  it("履歴が既に帰属済みなら二重反映しない", async () => {
    mocks.monitorData.machines.k1.printStore.history[0].filamentInfo = [{ spoolId: "S9", usedMm: 1000 }];

    const result = await confirmInferredCandidate("ic-a", { nowMs: 11000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("history_already_attributed");
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(10000);
    expect(mocks.saveUnifiedStorageDurably).not.toHaveBeenCalled();
  });

  it("保存失敗時は ledger と candidate を rollback し、rollback 状態を保存する", async () => {
    mocks.saveUnifiedStorageDurably
      .mockResolvedValueOnce({ ok: false, backend: "indexedDB", reason: "idb_fail" })
      .mockResolvedValueOnce({ ok: true, backend: "indexedDB", reason: "rollback_saved" });

    const result = await confirmInferredCandidate("ic-a", { actor: "operator", nowMs: 11000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("idb_fail");
    expect(result.rollback).toEqual({ ok: true, reason: "rolled_back" });
    expect(result.candidateRollback).toEqual({ ok: true, reason: "candidate_rolled_back" });
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(10000);
    expect(mocks.monitorData.filamentSpools[0].usedLengthLog).toEqual([]);
    expect(mocks.monitorData.machines.k1.printStore.history[0].filamentId).toBeUndefined();
    expect(mocks.monitorData.inferredCandidateStore["ic-a"].status).toBe(INFERRED_CANDIDATE_STATUS.PENDING);
    expect(mocks.saveUnifiedStorageDurably).toHaveBeenCalledTimes(2);
  });

  it("rollback 状態も保存できない場合は recovery flag を残す", async () => {
    mocks.saveUnifiedStorageDurably
      .mockResolvedValueOnce({ ok: false, backend: "indexedDB", reason: "idb_fail" })
      .mockResolvedValueOnce({ ok: false, backend: "indexedDB", reason: "rollback_fail" });

    const result = await confirmInferredCandidate("ic-a", { nowMs: 11000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("rollback_durable_save_failed");
    expect(mocks.monitorData.inferredDecisionRecoveryRequired).toMatchObject({
      candidateHash: "ic-a",
      action: "confirm",
      reason: "rollback_durable_save_failed"
    });
  });
});

describe("rejectInferredCandidate", () => {
  it("candidate を rejected に遷移し、確定台帳は変更しない", async () => {
    const result = await rejectInferredCandidate("ic-a", {
      actor: "operator",
      reason: "not-same-spool",
      note: "Operator saw a spool swap.",
      nowMs: 11000
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("rejected");
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(10000);
    expect(mocks.monitorData.filamentSpools[0].usedLengthLog).toEqual([]);
    expect(mocks.monitorData.machines.k1.printStore.history[0].filamentId).toBeUndefined();
    expect(mocks.monitorData.inferredCandidateStore["ic-a"].status).toBe(INFERRED_CANDIDATE_STATUS.REJECTED);
    expect(mocks.monitorData.inferredCandidateStore["ic-a"].events.at(-1)).toMatchObject({
      type: "decision-note",
      note: "Operator saw a spool swap."
    });
    expect(mocks.saveUnifiedStorageDurably).toHaveBeenCalledTimes(1);
  });

  it("未知の reject reason は拒否する", async () => {
    const result = await rejectInferredCandidate("ic-a", { reason: "bad-reason" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_reject_reason");
    expect(mocks.monitorData.inferredCandidateStore["ic-a"].status).toBe(INFERRED_CANDIDATE_STATUS.PENDING);
    expect(mocks.saveUnifiedStorageDurably).not.toHaveBeenCalled();
  });
});

describe("reassignInferredCandidate", () => {
  it("別 spool へ再割当てし、その spool の残量・履歴・candidate status を更新する", async () => {
    const result = await reassignInferredCandidate("ic-a", "S2", { actor: "operator", nowMs: 11000 });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("reassigned");
    expect(mocks.monitorData.filamentSpools.find(s => s.id === "S1").remainingLengthMm).toBe(10000);
    expect(mocks.monitorData.filamentSpools.find(s => s.id === "S2").remainingLengthMm).toBe(5000);
    expect(mocks.monitorData.machines.k1.printStore.history[1].filamentId).toBe("S2");
    expect(mocks.monitorData.inferredCandidateStore["ic-a"]).toMatchObject({
      status: INFERRED_CANDIDATE_STATUS.REASSIGNED,
      assignedSpoolId: "S2"
    });
  });

  it("candidate spool と同じ target は reassign として扱わない", async () => {
    const result = await reassignInferredCandidate("ic-a", "S1", { nowMs: 11000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target_spool_same_as_candidate");
    expect(mocks.saveUnifiedStorageDurably).not.toHaveBeenCalled();
  });
});
