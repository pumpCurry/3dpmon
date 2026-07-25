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
  showConfirmDialog: vi.fn(async () => true),
  showAlert: vi.fn()
}));

vi.mock("../../3dp_lib/dashboard_data.js", () => ({ monitorData: mocks.monitorData }));
vi.mock("../../3dp_lib/dashboard_inferred_candidate_decision.js", () => ({
  confirmInferredCandidate: mocks.confirmInferredCandidate,
  rejectInferredCandidate: mocks.rejectInferredCandidate,
  reassignInferredCandidate: mocks.reassignInferredCandidate,
  undoInferredCandidateDecision: mocks.undoInferredCandidateDecision
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
  mocks.monitorData.filamentSpools = [
    { id: "S2", name: "PLA Blue", material: "PLA", remainingLengthMm: 8000 }
  ];
  mocks.monitorData.inferredCandidateStore = { "ic-a": { candidateHash: "ic-a" } };
  mocks.confirmInferredCandidate.mockClear();
  mocks.rejectInferredCandidate.mockClear();
  mocks.reassignInferredCandidate.mockClear();
  mocks.undoInferredCandidateDecision.mockClear();
  mocks.showConfirmDialog.mockClear();
  mocks.showConfirmDialog.mockResolvedValue(true);
  mocks.showAlert.mockClear();
});

describe("createInferredCandidateCenterContent", () => {
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
