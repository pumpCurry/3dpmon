/**
 * @fileoverview dashboard_offline_live_shadow.js（#413 live shadow 配線）の単体テスト
 * aggregator から O2/O3/O4 を呼び、candidate 保存後だけ baseline commit へ進むことを検証する。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  events: [],
  monitorData: {
    hostObservationCurrent: { k1: { appSessionId: "session-a" } },
    machines: { k1: { printStore: { history: [{ id: "job-a", materialUsedMm: 1200 }] } } }
  },
  saveUnifiedStorage: vi.fn(() => { mocks.events.push("save"); }),
  classifyHostAttribution: vi.fn(),
  buildInferredContinuityProjection: vi.fn(),
  persistInferredCandidate: vi.fn(),
  commitObservationWindow: vi.fn()
}));

vi.mock("../../3dp_lib/dashboard_data.js", () => ({ monitorData: mocks.monitorData }));
vi.mock("../../3dp_lib/dashboard_storage.js", () => ({ saveUnifiedStorage: mocks.saveUnifiedStorage }));
vi.mock("../../3dp_lib/dashboard_offline_classifier.js", () => ({
  ATTR_CLASS: { CONTINUITY_CANDIDATE: "continuity-candidate" },
  classifyHostAttribution: mocks.classifyHostAttribution
}));
vi.mock("../../3dp_lib/dashboard_offline_projection.js", () => ({
  buildInferredContinuityProjection: mocks.buildInferredContinuityProjection
}));
vi.mock("../../3dp_lib/dashboard_offline_candidate_store.js", () => ({
  persistInferredCandidate: mocks.persistInferredCandidate
}));
vi.mock("../../3dp_lib/dashboard_offline_observation.js", () => ({
  commitObservationWindow: mocks.commitObservationWindow
}));

const { runInferredContinuityShadow } = await import("../../3dp_lib/dashboard_offline_live_shadow.js");

/**
 * O2 classification fixture を作成する。
 *
 * @function classification
 * @param {Object} [over] - 上書きする分類値。
 * @returns {Object} classifyHostAttribution の戻り値相当。
 */
function classification(over = {}) {
  return {
    classification: "continuity-candidate",
    host: "k1",
    windowId: "k1|b1|c2",
    currentSequence: 2,
    candidate: {
      candidateSpoolId: "S1",
      candidateBaselineIntervalId: "iv1",
      candidateCurrentIntervalId: "iv1",
      offlineObservationKeys: ["job-a"]
    },
    ...over
  };
}

beforeEach(() => {
  mocks.events.length = 0;
  mocks.monitorData.hostObservationCurrent = { k1: { appSessionId: "session-a" } };
  mocks.monitorData.machines = { k1: { printStore: { history: [{ id: "job-a", materialUsedMm: 1200 }] } } };
  mocks.saveUnifiedStorage.mockClear();
  mocks.classifyHostAttribution.mockReset();
  mocks.buildInferredContinuityProjection.mockReset();
  mocks.persistInferredCandidate.mockReset();
  mocks.commitObservationWindow.mockReset();
});

describe("runInferredContinuityShadow", () => {
  it("candidate を保存してから baseline commit し、commit 成功後に再保存する", () => {
    const cls = classification();
    const projection = { host: "k1", inferredContinuityUsedMm: 1200 };
    mocks.classifyHostAttribution.mockReturnValue(cls);
    mocks.buildInferredContinuityProjection.mockReturnValue(projection);
    mocks.persistInferredCandidate.mockImplementation(() => {
      mocks.events.push("persist");
      return { ok: true, reason: "created", candidateHash: "ic-1", record: { createdAt: 1000 } };
    });
    mocks.commitObservationWindow.mockImplementation(() => {
      mocks.events.push("commit");
      return { ok: true, reason: "committed" };
    });

    const result = runInferredContinuityShadow("k1", { id: "S1", remainingLengthMm: 5000 });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("committed");
    expect(mocks.buildInferredContinuityProjection).toHaveBeenCalledWith(cls, { id: "S1", remainingLengthMm: 5000 }, mocks.monitorData.machines.k1.printStore.history);
    expect(mocks.commitObservationWindow).toHaveBeenCalledWith("k1", {
      windowId: "k1|b1|c2",
      expectedSequence: 2,
      candidatePersistedAt: 1000,
      candidateHash: "ic-1",
      expectedAppSessionId: "session-a"
    });
    expect(mocks.events).toEqual(["persist", "save", "commit", "save"]);
  });

  it("O2 が continuity-candidate 以外なら projection と保存を実行しない", () => {
    mocks.classifyHostAttribution.mockReturnValue(classification({ classification: "no-offline-activity" }));

    const result = runInferredContinuityShadow("k1", { id: "S1" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-offline-activity");
    expect(mocks.buildInferredContinuityProjection).not.toHaveBeenCalled();
    expect(mocks.persistInferredCandidate).not.toHaveBeenCalled();
    expect(mocks.commitObservationWindow).not.toHaveBeenCalled();
  });

  it("O4 が no_inferred_debit を返した場合は baseline を進めない", () => {
    mocks.classifyHostAttribution.mockReturnValue(classification());
    mocks.buildInferredContinuityProjection.mockReturnValue({ host: "k1", inferredContinuityUsedMm: 0 });
    mocks.persistInferredCandidate.mockReturnValue({ ok: false, reason: "no_inferred_debit", candidateHash: null, record: null });

    const result = runInferredContinuityShadow("k1", { id: "S1" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_inferred_debit");
    expect(mocks.saveUnifiedStorage).not.toHaveBeenCalled();
    expect(mocks.commitObservationWindow).not.toHaveBeenCalled();
  });

  it("例外を shadow_failed に畳み、本流へ throw しない", () => {
    mocks.classifyHostAttribution.mockImplementation(() => { throw new Error("classifier boom"); });

    const result = runInferredContinuityShadow("k1", { id: "S1" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("shadow_failed");
    expect(result.error).toBe("classifier boom");
  });
});
