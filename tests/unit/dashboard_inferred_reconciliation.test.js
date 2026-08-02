/**
 * @fileoverview dashboard_inferred_reconciliation.js（#425-O7A）の単体テスト
 * O5 candidate decision と usedLengthLog / 履歴 attribution の read-only 照合を検証する。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  monitorData: {
    machines: {},
    filamentSpools: [],
    inferredCandidateStore: {}
  },
  wallNowMs: vi.fn(() => 123456)
}));

vi.mock("../../3dp_lib/dashboard_data.js", () => ({ monitorData: mocks.monitorData }));
vi.mock("../../3dp_lib/dashboard_time.js", () => ({
  wallNowMs: mocks.wallNowMs
}));
vi.mock("../../3dp_lib/dashboard_inferred_candidate_ledger.js", () => ({
  INFERRED_DECISION_LEDGER_EVENT_TYPE: "inferred-continuity-confirmed",
  INFERRED_DECISION_UNDO_LEDGER_EVENT_TYPE: "inferred-continuity-undone"
}));

const {
  buildInferredLedgerReconciliationReport
} = await import("../../3dp_lib/dashboard_inferred_reconciliation.js");

/**
 * candidate fixture を作る。
 *
 * @function candidate
 * @param {string} status - candidate status。
 * @param {Object} [over={}] - 上書き値。
 * @returns {Object} candidate record。
 */
function candidate(status, over = {}) {
  return {
    candidateHash: "ic-a",
    status,
    host: "k1",
    candidateSpoolId: "S1",
    usedMm: 3000,
    observationKeys: ["kA", "kB"],
    candidateDebits: [
      { observationKey: "kA", status: "inferred-debit", usedMm: 1000 },
      { observationKey: "kB", status: "inferred-debit", usedMm: 2000 }
    ],
    ...over
  };
}

/**
 * O5 confirmed ledger event fixture を作る。
 *
 * @function decisionEvent
 * @param {Object} [over={}] - 上書き値。
 * @returns {Object} usedLengthLog event。
 */
function decisionEvent(over = {}) {
  return {
    eventId: "ev-a",
    type: "inferred-continuity-confirmed",
    candidateHash: "ic-a",
    host: "k1",
    spoolId: "S1",
    usedMm: 3000,
    observationKeys: ["kA", "kB"],
    historyBefore: [
      { observationKey: "kA", filamentInfoPresent: false, filamentInfo: null, filamentIdPresent: false, filamentId: null },
      { observationKey: "kB", filamentInfoPresent: false, filamentInfo: null, filamentIdPresent: false, filamentId: null }
    ],
    historyAfter: [
      {
        observationKey: "kA",
        filamentInfoPresent: true,
        filamentInfo: [{ spoolId: "S1", candidateHash: "ic-a", isInferredContinuityConfirmed: true, usedMm: 1000 }],
        filamentIdPresent: true,
        filamentId: "S1"
      },
      {
        observationKey: "kB",
        filamentInfoPresent: true,
        filamentInfo: [{ spoolId: "S1", candidateHash: "ic-a", isInferredContinuityConfirmed: true, usedMm: 2000 }],
        filamentIdPresent: true,
        filamentId: "S1"
      }
    ],
    createdAt: 1000,
    ...over
  };
}

/**
 * O5 Undo ledger event fixture を作る。
 *
 * @function undoEvent
 * @param {Object} [over={}] - 上書き値。
 * @returns {Object} usedLengthLog undo event。
 */
function undoEvent(over = {}) {
  return {
    eventId: "undo-a",
    type: "inferred-continuity-undone",
    reversesEventId: "ev-a",
    candidateHash: "ic-a",
    host: "k1",
    spoolId: "S1",
    usedMm: 3000,
    observationKeys: ["kA", "kB"],
    createdAt: 2000,
    ...over
  };
}

beforeEach(() => {
  mocks.wallNowMs.mockReturnValue(123456);
  mocks.monitorData.machines = {
    k1: {
      printStore: {
        history: [
          {
            observationKey: "kA",
            filamentInfo: [{ spoolId: "S1", candidateHash: "ic-a", isInferredContinuityConfirmed: true, usedMm: 1000 }],
            filamentId: "S1"
          },
          {
            observationKey: "kB",
            filamentInfo: [{ spoolId: "S1", candidateHash: "ic-a", isInferredContinuityConfirmed: true, usedMm: 2000 }],
            filamentId: "S1"
          }
        ]
      }
    }
  };
  mocks.monitorData.filamentSpools = [
    { id: "S1", remainingLengthMm: 7000, usedLengthLog: [decisionEvent()] }
  ];
  mocks.monitorData.inferredCandidateStore = {
    "ic-a": candidate("confirmed")
  };
});

describe("buildInferredLedgerReconciliationReport", () => {
  it("#425/O7A: confirmed candidate と ledger / history が一致する場合は ok を返す", () => {
    const report = buildInferredLedgerReconciliationReport({ nowMs: 9000 });

    expect(report).toMatchObject({
      ok: true,
      status: "ok",
      checkedAt: 9000,
      candidateCount: 1,
      spoolCount: 1,
      decisionEventCount: 1,
      undoEventCount: 0,
      issueCount: 0,
      issues: []
    });
  });

  it("#425/O7A: confirmed candidate の ledger event 欠落を blocker として検出する", () => {
    mocks.monitorData.filamentSpools[0].usedLengthLog = [];

    const report = buildInferredLedgerReconciliationReport();

    expect(report.ok).toBe(false);
    expect(report.status).toBe("blocker");
    expect(report.issues).toContainEqual(expect.objectContaining({
      severity: "blocker",
      reason: "candidate_ledger_event_missing",
      candidateHash: "ic-a",
      spoolId: "S1"
    }));
  });

  it("#425/O7A: pending candidate に ledger event がある場合は blocker として検出する", () => {
    mocks.monitorData.inferredCandidateStore["ic-a"] = candidate("pending");

    const report = buildInferredLedgerReconciliationReport();

    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      severity: "blocker",
      reason: "unresolved_candidate_has_ledger_event",
      candidateHash: "ic-a",
      spoolId: "S1"
    }));
  });

  it("#425/O7A: undone candidate の Undo event 欠落を blocker として検出する", () => {
    mocks.monitorData.inferredCandidateStore["ic-a"] = candidate("undone");

    const report = buildInferredLedgerReconciliationReport();

    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      severity: "blocker",
      reason: "candidate_undo_event_missing_or_ambiguous",
      candidateHash: "ic-a",
      spoolId: "S1"
    }));
  });

  it("#425/O7A: undone candidate の履歴が Confirm 前 snapshot に戻っていれば ok を返す", () => {
    mocks.monitorData.inferredCandidateStore["ic-a"] = candidate("undone");
    mocks.monitorData.filamentSpools[0].usedLengthLog = [decisionEvent(), undoEvent()];
    mocks.monitorData.machines.k1.printStore.history = [
      { observationKey: "kA" },
      { observationKey: "kB" }
    ];

    const report = buildInferredLedgerReconciliationReport();

    expect(report.ok).toBe(true);
    expect(report.undoEventCount).toBe(1);
  });

  it("#425/O7A: confirmed candidate の履歴 attribution 変更を blocker として検出する", () => {
    mocks.monitorData.machines.k1.printStore.history[0].filamentInfo[0].usedMm = 999;

    const report = buildInferredLedgerReconciliationReport();

    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      severity: "blocker",
      reason: "history_attribution_mismatch",
      candidateHash: "ic-a",
      observationKey: "kA"
    }));
  });

  it("#425/O7A: candidate と ledger event の observation key 不一致を検出する", () => {
    mocks.monitorData.filamentSpools[0].usedLengthLog = [
      decisionEvent({ observationKeys: ["kA"] })
    ];

    const report = buildInferredLedgerReconciliationReport();

    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      severity: "blocker",
      reason: "candidate_ledger_observation_keys_mismatch",
      candidateHash: "ic-a",
      eventId: "ev-a"
    }));
  });

  it("#425/O7A: candidate store にない O5 ledger event を orphan として検出する", () => {
    mocks.monitorData.inferredCandidateStore = {};

    const report = buildInferredLedgerReconciliationReport();

    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      severity: "blocker",
      reason: "orphan_inferred_ledger_event",
      candidateHash: "ic-a",
      eventId: "ev-a"
    }));
  });
});
