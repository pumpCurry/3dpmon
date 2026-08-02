/**
 * @fileoverview dashboard_inferred_candidate_ui.js（#415-O5B Candidate Center UI）の単体テスト
 * 一覧・詳細・操作ボタンが ViewModel と Decision Core に正しく接続されることを検証する。
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  monitorData: {
    filamentSpools: [],
    inferredCandidateStore: {}
  },
  vm: null,
  confirmInferredCandidate: vi.fn(async () => ({ ok: true, reason: "confirmed" })),
  rejectInferredCandidate: vi.fn(async () => ({ ok: true, reason: "rejected" })),
  reassignInferredCandidate: vi.fn(async () => ({ ok: true, reason: "reassigned" })),
  undoInferredCandidateDecision: vi.fn(async () => ({ ok: true, reason: "undone" })),
  canExecuteRecoveryOperation: vi.fn(() => true),
  retryInferredRecoveryDurableSave: vi.fn(async () => ({ ok: true, reason: "recovery_durable_save_retried" })),
  clearInferredDecisionRecoveryRequired: vi.fn(async () => ({ ok: true, reason: "decision_recovery_cleared" })),
  clearLedgerRepairRequired: vi.fn(async () => ({ ok: true, reason: "ledger_repair_cleared" })),
  archiveMountHistoryRejectedEvents: vi.fn(async () => ({ ok: true, reason: "mount_history_rejected_events_archived" })),
  showConfirmDialog: vi.fn(async () => true),
  showAlert: vi.fn(),
  recoveryVm: { hasIssues: false, totalCount: 0, blockerCount: 0, warningCount: 0, cards: [] }
}));

vi.mock("../../3dp_lib/dashboard_data.js", () => ({ monitorData: mocks.monitorData }));
vi.mock("../../3dp_lib/dashboard_inferred_candidate_decision.js", () => ({
  confirmInferredCandidate: mocks.confirmInferredCandidate,
  rejectInferredCandidate: mocks.rejectInferredCandidate,
  reassignInferredCandidate: mocks.reassignInferredCandidate,
  undoInferredCandidateDecision: mocks.undoInferredCandidateDecision
}));
vi.mock("../../3dp_lib/dashboard_inferred_recovery_ops.js", () => ({
  canExecuteRecoveryOperation: mocks.canExecuteRecoveryOperation,
  retryInferredRecoveryDurableSave: mocks.retryInferredRecoveryDurableSave,
  clearInferredDecisionRecoveryRequired: mocks.clearInferredDecisionRecoveryRequired,
  clearLedgerRepairRequired: mocks.clearLedgerRepairRequired,
  archiveMountHistoryRejectedEvents: mocks.archiveMountHistoryRejectedEvents
}));
vi.mock("../../3dp_lib/dashboard_inferred_candidate_view.js", () => ({
  INFERRED_CANDIDATE_FILTER: {
    PENDING: "pending",
    CONFIRMED: "confirmed",
    REJECTED: "rejected",
    REASSIGNED: "reassigned",
    SUPERSEDED: "superseded",
    UNDONE: "undone",
    ALL: "all"
  },
  INFERRED_CANDIDATE_SORT: {
    NEWEST: "newest",
    OLDEST: "oldest",
    CONFIDENCE: "confidence",
    PRINTER: "printer",
    SPOOL: "spool"
  },
  buildInferredCandidateViewModel: vi.fn(() => mocks.vm),
  buildInferredRecoverySurfaceViewModel: vi.fn(() => mocks.recoveryVm),
  countPendingInferredCandidates: vi.fn(() => mocks.vm?.status === "pending" ? 1 : 0),
  listInferredCandidateViewModels: vi.fn(() => mocks.vm ? [mocks.vm] : [])
}));
vi.mock("../../3dp_lib/dashboard_notification_manager.js", () => ({ showAlert: mocks.showAlert }));
vi.mock("../../3dp_lib/dashboard_ui_confirm.js", () => ({ showConfirmDialog: mocks.showConfirmDialog }));
vi.mock("../../3dp_lib/dashboard_ui_components.js", () => ({
  createEmptyState: ({ title }) => {
    const el = document.createElement("div");
    el.className = "state-empty";
    el.textContent = title || "";
    return el;
  }
}));

const { createInferredCandidateCenterContent } = await import("../../3dp_lib/dashboard_inferred_candidate_ui.js");

/**
 * ViewModel fixture を作る。
 *
 * @function vm
 * @param {Object} over - 上書き値。
 * @returns {Object} Candidate ViewModel。
 */
function vm(over = {}) {
  return {
    candidateHash: "ic-a",
    status: "pending",
    statusLabel: "Pending",
    hostLabel: "K1 Max",
    candidateSpoolId: "S1",
    candidateSpoolName: "PLA Red",
    candidateSpoolColor: "red",
    usedDisplay: "3,000 mm",
    confirmedRemainingDisplay: "10,000 mm",
    projectedRemainingDisplay: "7,000 mm",
    confidenceLabel: "High",
    jobCount: 2,
    jobs: [
      { filename: "a.gcode", usedDisplay: "1,000 mm", attributionState: "pending" },
      { filename: "b.gcode", usedDisplay: "2,000 mm", attributionState: "pending" }
    ],
    createdAtDisplay: "2026/7/25 14:00:00",
    windowId: "win-a",
    candidateBaselineIntervalId: "iv-a",
    candidateCurrentIntervalId: "iv-a",
    events: [{ type: "created", status: "pending", reason: "" }],
    warningCodes: [],
    canConfirm: true,
    canReject: true,
    canReassign: true,
    canUndo: false,
    readOnlyReason: null,
    ...over
  };
}

/**
 * 非同期イベントハンドラの完了を待ってから検証する。
 *
 * @function waitForAssertion
 * @param {Function} assertion - 成功するまで再試行する検証関数。
 * @returns {Promise<void>} 検証成功で解決する Promise。
 */
async function waitForAssertion(assertion) {
  let lastError = null;
  for (let i = 0; i < 20; i++) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

beforeEach(() => {
  document.body.innerHTML = "";
  mocks.vm = vm();
  mocks.recoveryVm = { hasIssues: false, totalCount: 0, blockerCount: 0, warningCount: 0, cards: [] };
  mocks.monitorData.filamentSpools = [
    { id: "S2", name: "PLA Blue", material: "PLA", remainingLengthMm: 8000 }
  ];
  mocks.monitorData.inferredCandidateStore = { "ic-a": { candidateHash: "ic-a" } };
  mocks.confirmInferredCandidate.mockClear();
  mocks.rejectInferredCandidate.mockClear();
  mocks.reassignInferredCandidate.mockClear();
  mocks.undoInferredCandidateDecision.mockClear();
  mocks.canExecuteRecoveryOperation.mockClear();
  mocks.canExecuteRecoveryOperation.mockReturnValue(true);
  mocks.retryInferredRecoveryDurableSave.mockClear();
  mocks.retryInferredRecoveryDurableSave.mockResolvedValue({ ok: true, reason: "recovery_durable_save_retried" });
  mocks.clearInferredDecisionRecoveryRequired.mockClear();
  mocks.clearInferredDecisionRecoveryRequired.mockResolvedValue({ ok: true, reason: "decision_recovery_cleared" });
  mocks.clearLedgerRepairRequired.mockClear();
  mocks.clearLedgerRepairRequired.mockResolvedValue({ ok: true, reason: "ledger_repair_cleared" });
  mocks.archiveMountHistoryRejectedEvents.mockClear();
  mocks.archiveMountHistoryRejectedEvents.mockResolvedValue({ ok: true, reason: "mount_history_rejected_events_archived" });
  mocks.showConfirmDialog.mockClear();
  mocks.showConfirmDialog.mockResolvedValue(true);
  mocks.showAlert.mockClear();
});

describe("createInferredCandidateCenterContent", () => {
  it("recovery surface を診断カードと復旧操作として表示する", () => {
    mocks.recoveryVm = {
      hasIssues: true,
      totalCount: 2,
      blockerCount: 1,
      warningCount: 1,
      cards: [
        {
          type: "decision-recovery",
          severity: "blocker",
          title: "O5 decision recovery required",
          summary: "rollback状態の確認が必要です",
          details: [
            { label: "Candidate", value: "ic-a" },
            { label: "Reason", value: "rollback_durable_save_failed" }
          ]
        },
        {
          type: "mount-history-rejected",
          severity: "warning",
          title: "Rejected mount history events",
          summary: "2件の mountHistory event が隔離されています",
          details: [{ label: "Rejected 1", value: "ev-b" }]
        }
      ]
    };

    const center = createInferredCandidateCenterContent();
    document.body.appendChild(center.el);

    expect(document.querySelector(".ic-recovery-surface").textContent).toContain("Blocker 1 / Warning 1");
    expect(document.querySelector(".ic-recovery-surface").textContent).toContain("O5 decision recovery required");
    expect(document.querySelector(".ic-recovery-surface").textContent).toContain("Rejected mount history events");
    expect(document.querySelector(".ic-recovery-surface").textContent).toContain("Retry save");
    expect(document.querySelector(".ic-recovery-surface").textContent).toContain("Archive rejected");
    expect(mocks.confirmInferredCandidate).not.toHaveBeenCalled();
    expect(mocks.rejectInferredCandidate).not.toHaveBeenCalled();
    expect(mocks.reassignInferredCandidate).not.toHaveBeenCalled();
    expect(mocks.undoInferredCandidateDecision).not.toHaveBeenCalled();
  });

  it("recovery card の Retry save は O6 Recovery Operations を呼ぶ", async () => {
    mocks.recoveryVm = {
      hasIssues: true,
      totalCount: 1,
      blockerCount: 1,
      warningCount: 0,
      cards: [{
        type: "decision-recovery",
        severity: "blocker",
        title: "O5 decision recovery required",
        summary: "rollback状態の確認が必要です",
        details: [{ label: "Candidate", value: "ic-a" }]
      }]
    };
    const center = createInferredCandidateCenterContent();
    document.body.appendChild(center.el);

    [...document.querySelectorAll(".ic-recovery-actions button")]
      .find(button => button.textContent === "Retry save")
      .click();

    await waitForAssertion(() => {
      expect(mocks.retryInferredRecoveryDurableSave).toHaveBeenCalledWith({ actor: "local-user" });
      expect(mocks.showAlert).toHaveBeenCalledWith("復旧状態を再保存しました", "success");
    });
  });

  it("#421/O6B: recovery audit card は INFO として表示し操作ボタンを出さない", () => {
    mocks.recoveryVm = {
      hasIssues: true,
      totalCount: 1,
      blockerCount: 0,
      warningCount: 0,
      infoCount: 1,
      cards: [{
        type: "recovery-audit",
        severity: "info",
        title: "Recovery operation audit",
        summary: "2件の recovery 操作監査eventがあります",
        details: [{ label: "Audit 1", value: "decision-recovery-cleared" }]
      }]
    };

    const center = createInferredCandidateCenterContent();
    document.body.appendChild(center.el);

    expect(document.querySelector(".ic-recovery-surface").textContent).toContain("Blocker 0 / Warning 0 / Info 1");
    expect(document.querySelector(".ic-recovery-severity").textContent).toBe("INFO");
    expect(document.querySelector(".ic-recovery-title").textContent).toBe("Recovery operation audit");
    expect(document.querySelector(".ic-recovery-actions")).toBeNull();
  });

  it("Satellite では recovery 操作を disabled にする", () => {
    mocks.canExecuteRecoveryOperation.mockReturnValue(false);
    mocks.recoveryVm = {
      hasIssues: true,
      totalCount: 1,
      blockerCount: 1,
      warningCount: 0,
      cards: [{
        type: "ledger-repair",
        severity: "blocker",
        title: "Mount ledger repair required",
        summary: "修復が必要です",
        host: "k1",
        details: [{ label: "Host", value: "k1" }]
      }]
    };

    const center = createInferredCandidateCenterContent();
    document.body.appendChild(center.el);

    const clear = [...document.querySelectorAll(".ic-recovery-actions button")]
      .find(button => button.textContent === "Clear repair");
    expect(clear.disabled).toBe(true);
    expect(document.querySelector(".ic-readonly-note").textContent).toContain("親端末");
  });

  it("candidate 一覧から詳細を開き、Confirm は Decision Core を呼ぶ", async () => {
    const center = createInferredCandidateCenterContent();
    document.body.appendChild(center.el);

    center.el.querySelector("tbody .ic-open-button").click();
    expect(document.querySelector(".ic-detail-modal")).toBeTruthy();
    document.querySelector(".ic-action-primary").click();

    await waitForAssertion(() => {
      expect(mocks.confirmInferredCandidate).toHaveBeenCalledWith("ic-a", { actor: "local-user" });
      expect(mocks.showAlert).toHaveBeenCalledWith("確定しました", "success");
    });
  });

  it("閲覧専用 ViewModel では操作ボタンを disabled にし Decision Core を呼ばない", async () => {
    mocks.vm = vm({
      canConfirm: false,
      canReject: false,
      canReassign: false,
      readOnlyReason: "relay-readonly",
      warningCodes: ["relay-readonly"]
    });
    const center = createInferredCandidateCenterContent();
    document.body.appendChild(center.el);

    center.el.querySelector("tbody .ic-open-button").click();
    const confirm = document.querySelector(".ic-action-primary");
    confirm.click();
    await Promise.resolve();

    expect(confirm.disabled).toBe(true);
    expect(document.querySelector(".ic-readonly-note").textContent).toContain("親端末");
    expect(mocks.confirmInferredCandidate).not.toHaveBeenCalled();
  });

  it("操作失敗後は元から disabled だった action を disabled のまま戻す", async () => {
    mocks.vm = vm({
      canConfirm: true,
      canReject: false,
      canReassign: false,
      canUndo: false
    });
    mocks.confirmInferredCandidate.mockResolvedValueOnce({ ok: false, reason: "candidate_history_link_ambiguous" });
    const center = createInferredCandidateCenterContent();
    document.body.appendChild(center.el);

    center.el.querySelector("tbody .ic-open-button").click();
    document.querySelector(".ic-action-primary").click();

    await waitForAssertion(() => {
      expect(mocks.showAlert).toHaveBeenCalledWith("取り消し対象の履歴帰属が曖昧です", "error");
      expect(document.querySelector(".ic-action-primary").disabled).toBe(false);
      const secondary = [...document.querySelectorAll(".ic-action-secondary")];
      expect(secondary.find(button => button.textContent === "Reject").disabled).toBe(true);
      expect(secondary.find(button => button.textContent === "Reassign").disabled).toBe(true);
      expect(secondary.find(button => button.textContent === "Undo").disabled).toBe(true);
    });
  });

  it("confirmed ViewModel では Undo ボタンから Decision Core を呼ぶ", async () => {
    mocks.vm = vm({
      status: "confirmed",
      statusLabel: "Confirmed",
      canConfirm: false,
      canReject: false,
      canReassign: false,
      canUndo: true
    });
    const center = createInferredCandidateCenterContent();
    document.body.appendChild(center.el);

    center.el.querySelector("tbody .ic-open-button").click();
    const buttons = [...document.querySelectorAll(".ic-action-secondary")];
    const undo = buttons.find(button => button.textContent === "Undo");
    undo.click();

    await waitForAssertion(() => {
      expect(mocks.undoInferredCandidateDecision).toHaveBeenCalledWith("ic-a", { actor: "local-user" });
      expect(mocks.showAlert).toHaveBeenCalledWith("取り消しました", "success");
    });
  });

  it("Satellite decision request 成功は親端末への送信として通知する", async () => {
    mocks.confirmInferredCandidate.mockResolvedValueOnce({
      ok: true,
      reason: "decision_requested",
      relayed: true,
      action: "confirmInferredCandidate",
      candidateHash: "ic-a"
    });
    const center = createInferredCandidateCenterContent();
    document.body.appendChild(center.el);

    center.el.querySelector("tbody .ic-open-button").click();
    document.querySelector(".ic-action-primary").click();

    await waitForAssertion(() => {
      expect(mocks.showAlert).toHaveBeenCalledWith("親端末へ送信しました", "success");
    });
  });
});
