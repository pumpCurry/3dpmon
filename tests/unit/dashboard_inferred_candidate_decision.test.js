/**
 * @fileoverview dashboard_inferred_candidate_decision.js（#414-O5A Decision Core）の単体テスト
 * Confirm / Reject / Reassign が pending candidate だけを入口にし、保存失敗時に rollback することを検証する。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  monitorData: {
    machines: {},
    filamentSpools: [],
    inferredCandidateStore: {},
    inferredDecisionRecoveryRequired: null,
    inferredRecoveryOperationRecoveryRequired: null
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
  reassignInferredCandidate,
  undoInferredCandidateDecision
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

/**
 * 手動で resolve/reject できる Promise を作る。
 *
 * @function deferred
 * @returns {{promise:Promise<*>,resolve:Function,reject:Function}} deferred Promise。
 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
  mocks.monitorData.inferredDecisionRecoveryRequired = null;
  mocks.monitorData.inferredRecoveryOperationRecoveryRequired = null;
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

  it("#424/O6D: recovery operation blocker がある間は O5 decision を停止する", async () => {
    mocks.monitorData.inferredRecoveryOperationRecoveryRequired = {
      operation: "clearLedgerRepairRequired",
      reason: "rollback_durable_save_failed",
      createdAt: 900
    };

    const result = await confirmInferredCandidate("ic-a", { nowMs: 11000 });

    expect(canSubmitLedgerDecision()).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      reason: "recovery_required",
      candidateHash: "ic-a",
      recoveryField: "inferredRecoveryOperationRecoveryRequired"
    });
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(10000);
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

  it("satellite 操作モードでは Undo も Parent へ decision request を送る", async () => {
    globalThis.window = { _3dpmonRelayChild: true };
    mocks.getRelayMode.mockReturnValue("satellite");
    mocks.monitorData.inferredCandidateStore["ic-a"].status = INFERRED_CANDIDATE_STATUS.CONFIRMED;

    const result = await undoInferredCandidateDecision("ic-a", { actor: "operator", nowMs: 12000 });

    expect(result).toMatchObject({
      ok: true,
      reason: "decision_requested",
      relayed: true,
      action: "undoInferredCandidateDecision",
      candidateHash: "ic-a"
    });
    expect(sendRelayFilament).toHaveBeenCalledWith("undoInferredCandidateDecision", {
      candidateHash: "ic-a",
      actor: "operator"
    });
    expect(mocks.monitorData.inferredCandidateStore["ic-a"].status).toBe(INFERRED_CANDIDATE_STATUS.CONFIRMED);
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
      actor: "operator",
      remainingBeforeMm: 10000,
      appliedDebitMm: 3000,
      remainingAfterMm: 7000,
      overdrawnMm: 0,
      crossedZero: false
    });
    const history = mocks.monitorData.machines.k1.printStore.history;
    expect(history[0].filamentId).toBe("S1");
    expect(history[0].filamentInfo[0]).toMatchObject({
      spoolId: "S1",
      usedMm: 1000,
      isInferredContinuityConfirmed: true,
      candidateHash: "ic-a"
    });
    expect(mocks.monitorData.filamentSpools[0].usedLengthLog[0].historyAfter[0]).toMatchObject({
      observationKey: "kA",
      filamentInfoPresent: true,
      filamentIdPresent: true,
      filamentId: "S1"
    });
    expect(mocks.monitorData.filamentSpools[0].usedLengthLog[0].historyAfter[0].filamentInfo[0]).toMatchObject({
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

  it("対象 spool の確定残量が candidate 使用量未満でも負残量として確定する", async () => {
    mocks.monitorData.filamentSpools[0].remainingLengthMm = 100;

    const result = await confirmInferredCandidate("ic-a", { nowMs: 11000 });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("confirmed");
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(-2900);
    expect(mocks.monitorData.filamentSpools[0].usedLengthLog[0]).toMatchObject({
      remainingBeforeMm: 100,
      appliedDebitMm: 3000,
      remainingAfterMm: -2900,
      overdrawnMm: 2900,
      crossedZero: true
    });
    expect(mocks.monitorData.inferredCandidateStore["ic-a"].status).toBe(INFERRED_CANDIDATE_STATUS.CONFIRMED);
    expect(mocks.saveUnifiedStorageDurably).toHaveBeenCalledTimes(1);
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

  it("同時 decision は直列化され、先行失敗rollback後に後続を開始する", async () => {
    mocks.monitorData.machines.k1.printStore.history.push(job("kC", 1500), job("kD", 1500));
    mocks.monitorData.inferredCandidateStore["ic-b"] = candidate({
      candidateHash: "ic-b",
      observationKeys: ["kC", "kD"],
      candidateDebits: [
        { observationKey: "kC", status: "inferred-debit", usedMm: 1500, reason: "unattributed-usage", confirmedSpoolIds: [] },
        { observationKey: "kD", status: "inferred-debit", usedMm: 1500, reason: "unattributed-usage", confirmedSpoolIds: [] }
      ],
      events: [{ type: "created", at: 9000, status: INFERRED_CANDIDATE_STATUS.PENDING, usedMm: 3000 }]
    });
    const firstSave = deferred();
    mocks.saveUnifiedStorageDurably
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValueOnce({ ok: true, backend: "indexedDB", reason: "rollback_saved" })
      .mockResolvedValueOnce({ ok: true, backend: "indexedDB", reason: "saved-b" });

    const first = confirmInferredCandidate("ic-a", { actor: "operator", nowMs: 11000 });
    await Promise.resolve();
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(7000);
    expect(mocks.saveUnifiedStorageDurably).toHaveBeenCalledTimes(1);

    const second = confirmInferredCandidate("ic-b", { actor: "operator", nowMs: 12000 });
    await Promise.resolve();
    expect(mocks.saveUnifiedStorageDurably).toHaveBeenCalledTimes(1);
    expect(mocks.monitorData.inferredCandidateStore["ic-b"].status).toBe(INFERRED_CANDIDATE_STATUS.PENDING);

    firstSave.resolve({ ok: false, backend: "indexedDB", reason: "idb_fail" });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.ok).toBe(false);
    expect(firstResult.reason).toBe("idb_fail");
    expect(secondResult.ok).toBe(true);
    expect(secondResult.reason).toBe("confirmed");
    expect(mocks.monitorData.inferredCandidateStore["ic-a"].status).toBe(INFERRED_CANDIDATE_STATUS.PENDING);
    expect(mocks.monitorData.inferredCandidateStore["ic-b"].status).toBe(INFERRED_CANDIDATE_STATUS.CONFIRMED);
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(7000);
    expect(mocks.monitorData.filamentSpools[0].usedLengthLog).toHaveLength(1);
    expect(mocks.monitorData.filamentSpools[0].usedLengthLog[0].candidateHash).toBe("ic-b");
  });

  it("先行 decision 成功後、後続 decision は更新後 remaining を基準に処理する", async () => {
    mocks.monitorData.machines.k1.printStore.history.push(job("kC", 1500), job("kD", 1500));
    mocks.monitorData.inferredCandidateStore["ic-b"] = candidate({
      candidateHash: "ic-b",
      observationKeys: ["kC", "kD"],
      candidateDebits: [
        { observationKey: "kC", status: "inferred-debit", usedMm: 1500, reason: "unattributed-usage", confirmedSpoolIds: [] },
        { observationKey: "kD", status: "inferred-debit", usedMm: 1500, reason: "unattributed-usage", confirmedSpoolIds: [] }
      ],
      events: [{ type: "created", at: 9000, status: INFERRED_CANDIDATE_STATUS.PENDING, usedMm: 3000 }]
    });
    const firstSave = deferred();
    mocks.saveUnifiedStorageDurably
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValueOnce({ ok: true, backend: "indexedDB", reason: "saved-b" });

    const first = confirmInferredCandidate("ic-a", { actor: "operator", nowMs: 11000 });
    await Promise.resolve();
    const second = confirmInferredCandidate("ic-b", { actor: "operator", nowMs: 12000 });
    await Promise.resolve();
    expect(mocks.saveUnifiedStorageDurably).toHaveBeenCalledTimes(1);

    firstSave.resolve({ ok: true, backend: "indexedDB", reason: "saved-a" });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(4000);
    expect(mocks.monitorData.filamentSpools[0].usedLengthLog.map(item => item.candidateHash)).toEqual(["ic-a", "ic-b"]);
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

  it("再割当て先 spool の確定残量が candidate 使用量未満でも負残量として確定する", async () => {
    mocks.monitorData.filamentSpools.find(s => s.id === "S2").remainingLengthMm = 100;

    const result = await reassignInferredCandidate("ic-a", "S2", { actor: "operator", nowMs: 11000 });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("reassigned");
    expect(mocks.monitorData.filamentSpools.find(s => s.id === "S2").remainingLengthMm).toBe(-2900);
    expect(mocks.monitorData.filamentSpools.find(s => s.id === "S2").usedLengthLog[0]).toMatchObject({
      remainingBeforeMm: 100,
      appliedDebitMm: 3000,
      remainingAfterMm: -2900,
      overdrawnMm: 2900,
      crossedZero: true
    });
    expect(mocks.monitorData.inferredCandidateStore["ic-a"].status).toBe(INFERRED_CANDIDATE_STATUS.REASSIGNED);
    expect(mocks.saveUnifiedStorageDurably).toHaveBeenCalledTimes(1);
  });
});

describe("undoInferredCandidateDecision", () => {
  it("confirmed candidate の残量・履歴・usedLengthLog を戻し status を undone にする", async () => {
    const confirmed = await confirmInferredCandidate("ic-a", { actor: "operator", nowMs: 11000 });
    expect(confirmed.ok).toBe(true);
    mocks.saveUnifiedStorageDurably.mockClear();

    const result = await undoInferredCandidateDecision("ic-a", { actor: "operator", nowMs: 12000 });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("undone");
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(10000);
    expect(mocks.monitorData.filamentSpools[0].usedLengthLog).toHaveLength(2);
    expect(mocks.monitorData.filamentSpools[0].usedLengthLog[0].type).toBe("inferred-continuity-confirmed");
    expect(mocks.monitorData.filamentSpools[0].usedLengthLog[1]).toMatchObject({
      type: "inferred-continuity-undone",
      reversesEventId: mocks.monitorData.filamentSpools[0].usedLengthLog[0].eventId,
      candidateHash: "ic-a",
      usedMm: 3000,
      actor: "operator",
      remainingBeforeMm: 7000,
      reversedUsedMm: 3000,
      remainingAfterMm: 10000
    });
    const history = mocks.monitorData.machines.k1.printStore.history;
    expect(history[0].filamentId).toBeUndefined();
    expect(history[0].filamentInfo).toBeUndefined();
    expect(history[1].filamentId).toBeUndefined();
    expect(history[1].filamentInfo).toBeUndefined();
    expect(mocks.monitorData.inferredCandidateStore["ic-a"].status).toBe(INFERRED_CANDIDATE_STATUS.UNDONE);
    expect(mocks.monitorData.inferredCandidateStore["ic-a"].events.at(-1)).toMatchObject({
      status: INFERRED_CANDIDATE_STATUS.UNDONE,
      reason: "operator-undo",
      actor: "operator"
    });
    expect(mocks.saveUnifiedStorageDurably).toHaveBeenCalledTimes(1);
  });

  it("色だけの filamentInfo は Confirm 前 snapshot から完全復元する", async () => {
    mocks.monitorData.inferredCandidateStore["ic-a"] = candidate({
      observationKeys: ["kA"],
      candidateDebits: [
        { observationKey: "kA", status: "inferred-debit", usedMm: 1000, reason: "unattributed-usage", confirmedSpoolIds: [] }
      ],
      usedMm: 1000
    });
    const beforeInfo = [{ color: "#ff0000", material: "PLA", source: "preview-only" }];
    const entry = mocks.monitorData.machines.k1.printStore.history[0];
    entry.filamentInfo = beforeInfo.map(item => ({ ...item }));
    expect(Object.hasOwn(entry, "filamentId")).toBe(false);

    const confirmed = await confirmInferredCandidate("ic-a", { actor: "operator", nowMs: 11000 });
    expect(confirmed.ok).toBe(true);
    expect(mocks.monitorData.filamentSpools[0].usedLengthLog[0].historyBefore).toEqual([{
      observationKey: "kA",
      filamentInfoPresent: true,
      filamentInfo: beforeInfo,
      filamentIdPresent: false,
      filamentId: null
    }]);
    mocks.saveUnifiedStorageDurably.mockClear();

    const result = await undoInferredCandidateDecision("ic-a", { actor: "operator", nowMs: 12000 });

    expect(result.ok).toBe(true);
    expect(entry.filamentInfo).toEqual(beforeInfo);
    expect(Object.hasOwn(entry, "filamentId")).toBe(false);
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(10000);
    expect(mocks.saveUnifiedStorageDurably).toHaveBeenCalledTimes(1);
  });

  it("複数の非O5 filamentInfo は順序と内容を保ったまま Undo で復元する", async () => {
    mocks.monitorData.inferredCandidateStore["ic-a"] = candidate({
      observationKeys: ["kA"],
      candidateDebits: [
        { observationKey: "kA", status: "inferred-debit", usedMm: 1000, reason: "unattributed-usage", confirmedSpoolIds: [] }
      ],
      usedMm: 1000
    });
    const beforeInfo = [
      { color: "#ff0000", material: "PLA", source: "preview-a" },
      { color: "#00ff00", material: "PETG", source: "preview-b" }
    ];
    const entry = mocks.monitorData.machines.k1.printStore.history[0];
    entry.filamentInfo = beforeInfo.map(item => ({ ...item }));

    const confirmed = await confirmInferredCandidate("ic-a", { actor: "operator", nowMs: 11000 });
    expect(confirmed.ok).toBe(true);
    expect(entry.filamentInfo).toHaveLength(3);
    mocks.saveUnifiedStorageDurably.mockClear();

    const result = await undoInferredCandidateDecision("ic-a", { actor: "operator", nowMs: 12000 });

    expect(result.ok).toBe(true);
    expect(entry.filamentInfo).toEqual(beforeInfo);
    expect(Object.hasOwn(entry, "filamentId")).toBe(false);
  });

  it("Reassign 後の Undo でも Confirm 前の未帰属履歴情報を復元する", async () => {
    mocks.monitorData.inferredCandidateStore["ic-a"] = candidate({
      observationKeys: ["kA"],
      candidateDebits: [
        { observationKey: "kA", status: "inferred-debit", usedMm: 1000, reason: "unattributed-usage", confirmedSpoolIds: [] }
      ],
      usedMm: 1000
    });
    const beforeInfo = [{ color: "#123456", material: "ABS", legacyHint: true }];
    const entry = mocks.monitorData.machines.k1.printStore.history[0];
    entry.filamentInfo = beforeInfo.map(item => ({ ...item }));

    const reassigned = await reassignInferredCandidate("ic-a", "S2", { actor: "operator", nowMs: 11000 });
    expect(reassigned.ok).toBe(true);
    expect(entry.filamentId).toBe("S2");
    mocks.saveUnifiedStorageDurably.mockClear();

    const result = await undoInferredCandidateDecision("ic-a", { actor: "operator", nowMs: 12000 });

    expect(result.ok).toBe(true);
    expect(mocks.monitorData.filamentSpools.find(s => s.id === "S2").remainingLengthMm).toBe(8000);
    expect(entry.filamentInfo).toEqual(beforeInfo);
    expect(Object.hasOwn(entry, "filamentId")).toBe(false);
  });

  it("snapshot に filamentId='none' が保存されている旧状態は Undo で値ごと復元する", async () => {
    mocks.monitorData.inferredCandidateStore["ic-a"] = candidate({
      observationKeys: ["kA"],
      candidateDebits: [
        { observationKey: "kA", status: "inferred-debit", usedMm: 1000, reason: "unattributed-usage", confirmedSpoolIds: [] }
      ],
      usedMm: 1000,
      status: INFERRED_CANDIDATE_STATUS.CONFIRMED,
      confirmedAt: 11000,
      confirmedBy: "operator"
    });
    const beforeInfo = [{ color: "#ff0000", material: "PLA" }];
    const entry = mocks.monitorData.machines.k1.printStore.history[0];
    entry.filamentInfo = [{
      ...beforeInfo[0],
      spoolId: "S1",
      usedMm: 1000,
      candidateHash: "ic-a",
      isInferredContinuityConfirmed: true
    }];
    entry.filamentId = "S1";
    mocks.monitorData.filamentSpools[0].remainingLengthMm = 9000;
    mocks.monitorData.filamentSpools[0].usedLengthLog.push({
      eventId: "icd-manual",
      type: "inferred-continuity-confirmed",
      candidateHash: "ic-a",
      host: "k1",
      spoolId: "S1",
      usedMm: 1000,
      observationKeys: ["kA"],
      historyBefore: [{
        observationKey: "kA",
        filamentInfoPresent: true,
        filamentInfo: beforeInfo,
        filamentIdPresent: true,
        filamentId: "none"
      }],
      historyAfter: [{
        observationKey: "kA",
        filamentInfoPresent: true,
        filamentInfo: entry.filamentInfo.map(item => ({ ...item })),
        filamentIdPresent: true,
        filamentId: "S1"
      }],
      createdAt: 11000
    });
    mocks.saveUnifiedStorageDurably.mockClear();

    const result = await undoInferredCandidateDecision("ic-a", { actor: "operator", nowMs: 12000 });

    expect(result.ok).toBe(true);
    expect(entry.filamentInfo).toEqual(beforeInfo);
    expect(entry.filamentId).toBe("none");
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(10000);
  });

  it("履歴snapshotを持たない台帳 event は完全復元できないため Undo しない", async () => {
    const confirmed = await confirmInferredCandidate("ic-a", { actor: "operator", nowMs: 11000 });
    expect(confirmed.ok).toBe(true);
    delete mocks.monitorData.filamentSpools[0].usedLengthLog[0].historyBefore;
    mocks.saveUnifiedStorageDurably.mockClear();

    const result = await undoInferredCandidateDecision("ic-a", { actor: "operator", nowMs: 12000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("candidate_history_snapshot_missing");
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(7000);
    expect(mocks.monitorData.machines.k1.printStore.history[0].filamentId).toBe("S1");
    expect(mocks.saveUnifiedStorageDurably).not.toHaveBeenCalled();
  });

  it("reassigned candidate は assigned spool から Undo する", async () => {
    const reassigned = await reassignInferredCandidate("ic-a", "S2", { actor: "operator", nowMs: 11000 });
    expect(reassigned.ok).toBe(true);
    mocks.saveUnifiedStorageDurably.mockClear();

    const result = await undoInferredCandidateDecision("ic-a", { actor: "operator", nowMs: 12000 });

    expect(result.ok).toBe(true);
    expect(mocks.monitorData.filamentSpools.find(s => s.id === "S1").remainingLengthMm).toBe(10000);
    expect(mocks.monitorData.filamentSpools.find(s => s.id === "S2").remainingLengthMm).toBe(8000);
    expect(mocks.monitorData.filamentSpools.find(s => s.id === "S2").usedLengthLog).toHaveLength(2);
    expect(mocks.monitorData.filamentSpools.find(s => s.id === "S2").usedLengthLog[1]).toMatchObject({
      type: "inferred-continuity-undone",
      candidateHash: "ic-a"
    });
    expect(mocks.monitorData.machines.k1.printStore.history[0].filamentId).toBeUndefined();
    expect(mocks.monitorData.inferredCandidateStore["ic-a"].status).toBe(INFERRED_CANDIDATE_STATUS.UNDONE);
  });

  it("Confirm 後に別metadataが履歴へ追加された場合は Undo しない", async () => {
    const confirmed = await confirmInferredCandidate("ic-a", { actor: "operator", nowMs: 11000 });
    expect(confirmed.ok).toBe(true);
    mocks.monitorData.machines.k1.printStore.history[0].filamentInfo.push({
      spoolId: "S9",
      usedMm: 1,
      source: "post-confirm-edit"
    });
    mocks.saveUnifiedStorageDurably.mockClear();

    const result = await undoInferredCandidateDecision("ic-a", { actor: "operator", nowMs: 12000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("candidate_history_post_state_changed");
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(7000);
    expect(mocks.monitorData.inferredCandidateStore["ic-a"].status).toBe(INFERRED_CANDIDATE_STATUS.CONFIRMED);
    expect(mocks.saveUnifiedStorageDurably).not.toHaveBeenCalled();
  });

  it.each([
    ["material", "PETG"],
    ["filamentColor", "#00ff00"],
    ["colorName", "green"],
    ["usedMm", 9999]
  ])("Confirm 後に同一 filamentInfo 行の %s が変更された場合は Undo しない", async (field, value) => {
    const beforeInfo = [{ color: "#ff0000", material: "PLA", filamentColor: "#ff0000", colorName: "red" }];
    const entry = mocks.monitorData.machines.k1.printStore.history[0];
    entry.filamentInfo = beforeInfo.map(item => ({ ...item }));

    const confirmed = await confirmInferredCandidate("ic-a", { actor: "operator", nowMs: 11000 });
    expect(confirmed.ok).toBe(true);
    entry.filamentInfo[0][field] = value;
    mocks.saveUnifiedStorageDurably.mockClear();

    const result = await undoInferredCandidateDecision("ic-a", { actor: "operator", nowMs: 12000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("candidate_history_post_state_changed");
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(7000);
    expect(mocks.monitorData.inferredCandidateStore["ic-a"].status).toBe(INFERRED_CANDIDATE_STATUS.CONFIRMED);
    expect(mocks.saveUnifiedStorageDurably).not.toHaveBeenCalled();
  });

  it("Confirm 後に filamentId が削除された場合は Undo しない", async () => {
    const confirmed = await confirmInferredCandidate("ic-a", { actor: "operator", nowMs: 11000 });
    expect(confirmed.ok).toBe(true);
    delete mocks.monitorData.machines.k1.printStore.history[0].filamentId;
    mocks.saveUnifiedStorageDurably.mockClear();

    const result = await undoInferredCandidateDecision("ic-a", { actor: "operator", nowMs: 12000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("candidate_history_post_state_changed");
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(7000);
    expect(mocks.monitorData.inferredCandidateStore["ic-a"].status).toBe(INFERRED_CANDIDATE_STATUS.CONFIRMED);
    expect(mocks.saveUnifiedStorageDurably).not.toHaveBeenCalled();
  });

  it("Confirm 後に filamentId が null へ変更された場合は Undo しない", async () => {
    const confirmed = await confirmInferredCandidate("ic-a", { actor: "operator", nowMs: 11000 });
    expect(confirmed.ok).toBe(true);
    mocks.monitorData.machines.k1.printStore.history[0].filamentId = null;
    mocks.saveUnifiedStorageDurably.mockClear();

    const result = await undoInferredCandidateDecision("ic-a", { actor: "operator", nowMs: 12000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("candidate_history_post_state_changed");
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(7000);
    expect(mocks.monitorData.inferredCandidateStore["ic-a"].status).toBe(INFERRED_CANDIDATE_STATUS.CONFIRMED);
    expect(mocks.saveUnifiedStorageDurably).not.toHaveBeenCalled();
  });

  it("逆仕訳eventが既にある台帳eventは二重Undoしない", async () => {
    const confirmed = await confirmInferredCandidate("ic-a", { actor: "operator", nowMs: 11000 });
    expect(confirmed.ok).toBe(true);
    const undone = await undoInferredCandidateDecision("ic-a", { actor: "operator", nowMs: 12000 });
    expect(undone.ok).toBe(true);
    mocks.monitorData.inferredCandidateStore["ic-a"].status = INFERRED_CANDIDATE_STATUS.CONFIRMED;
    mocks.monitorData.inferredCandidateStore["ic-a"].resolvedAt = 11000;
    mocks.saveUnifiedStorageDurably.mockClear();

    const result = await undoInferredCandidateDecision("ic-a", { actor: "operator", nowMs: 13000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("candidate_ledger_event_already_undone");
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(10000);
    expect(mocks.monitorData.filamentSpools[0].usedLengthLog).toHaveLength(2);
    expect(mocks.saveUnifiedStorageDurably).not.toHaveBeenCalled();
  });

  it("未反映 status の candidate は Undo しない", async () => {
    const result = await undoInferredCandidateDecision("ic-a", { nowMs: 12000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("candidate_not_undoable");
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(10000);
    expect(mocks.saveUnifiedStorageDurably).not.toHaveBeenCalled();
  });

  it("台帳 event の spoolId が一致しない場合は Undo しない", async () => {
    const confirmed = await confirmInferredCandidate("ic-a", { actor: "operator", nowMs: 11000 });
    expect(confirmed.ok).toBe(true);
    mocks.monitorData.filamentSpools[0].usedLengthLog[0].spoolId = "S9";
    mocks.saveUnifiedStorageDurably.mockClear();

    const result = await undoInferredCandidateDecision("ic-a", { actor: "operator", nowMs: 12000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("candidate_ledger_event_spool_mismatch");
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(7000);
    expect(mocks.monitorData.machines.k1.printStore.history[0].filamentId).toBe("S1");
    expect(mocks.monitorData.inferredCandidateStore["ic-a"].status).toBe(INFERRED_CANDIDATE_STATUS.CONFIRMED);
    expect(mocks.saveUnifiedStorageDurably).not.toHaveBeenCalled();
  });

  it("台帳 event の host が一致しない場合は Undo しない", async () => {
    const confirmed = await confirmInferredCandidate("ic-a", { actor: "operator", nowMs: 11000 });
    expect(confirmed.ok).toBe(true);
    mocks.monitorData.filamentSpools[0].usedLengthLog[0].host = "other-host";
    mocks.saveUnifiedStorageDurably.mockClear();

    const result = await undoInferredCandidateDecision("ic-a", { actor: "operator", nowMs: 12000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("candidate_ledger_event_host_mismatch");
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(7000);
    expect(mocks.monitorData.machines.k1.printStore.history[0].filamentId).toBe("S1");
    expect(mocks.monitorData.inferredCandidateStore["ic-a"].status).toBe(INFERRED_CANDIDATE_STATUS.CONFIRMED);
    expect(mocks.saveUnifiedStorageDurably).not.toHaveBeenCalled();
  });

  it("履歴内の candidate attribution が重複している場合は Undo しない", async () => {
    const confirmed = await confirmInferredCandidate("ic-a", { actor: "operator", nowMs: 11000 });
    expect(confirmed.ok).toBe(true);
    const history = mocks.monitorData.machines.k1.printStore.history;
    history[0].filamentInfo.push({ ...history[0].filamentInfo[0] });
    mocks.saveUnifiedStorageDurably.mockClear();

    const result = await undoInferredCandidateDecision("ic-a", { actor: "operator", nowMs: 12000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("candidate_history_link_ambiguous");
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(7000);
    expect(history[0].filamentInfo).toHaveLength(2);
    expect(mocks.monitorData.inferredCandidateStore["ic-a"].status).toBe(INFERRED_CANDIDATE_STATUS.CONFIRMED);
    expect(mocks.saveUnifiedStorageDurably).not.toHaveBeenCalled();
  });

  it("Undo 保存失敗時は台帳と candidate を元へ戻し rollback 状態を保存する", async () => {
    const confirmed = await confirmInferredCandidate("ic-a", { actor: "operator", nowMs: 11000 });
    expect(confirmed.ok).toBe(true);
    mocks.saveUnifiedStorageDurably.mockReset();
    mocks.saveUnifiedStorageDurably
      .mockResolvedValueOnce({ ok: false, backend: "indexedDB", reason: "undo_save_fail" })
      .mockResolvedValueOnce({ ok: true, backend: "indexedDB", reason: "undo_rollback_saved" });

    const result = await undoInferredCandidateDecision("ic-a", { actor: "operator", nowMs: 12000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("undo_save_fail");
    expect(result.rollback).toEqual({ ok: true, reason: "rolled_back" });
    expect(result.candidateRollback).toEqual({ ok: true, reason: "candidate_rolled_back" });
    expect(mocks.monitorData.filamentSpools[0].remainingLengthMm).toBe(7000);
    expect(mocks.monitorData.filamentSpools[0].usedLengthLog).toHaveLength(1);
    expect(mocks.monitorData.machines.k1.printStore.history[0].filamentId).toBe("S1");
    expect(mocks.monitorData.inferredCandidateStore["ic-a"].status).toBe(INFERRED_CANDIDATE_STATUS.CONFIRMED);
    expect(mocks.saveUnifiedStorageDurably).toHaveBeenCalledTimes(2);
  });
});
