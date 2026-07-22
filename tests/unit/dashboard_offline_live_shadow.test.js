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
  saveUnifiedStorage: vi.fn(async () => { mocks.events.push("save"); return { ok: true, backend: "indexedDB", reason: "flushed" }; }),
  classifyHostAttribution: vi.fn(),
  buildInferredContinuityProjection: vi.fn(),
  persistInferredCandidate: vi.fn(),
  commitObservationWindow: vi.fn()
}));

vi.mock("../../3dp_lib/dashboard_data.js", () => ({ monitorData: mocks.monitorData }));
vi.mock("../../3dp_lib/dashboard_storage.js", () => ({ saveUnifiedStorageDurably: mocks.saveUnifiedStorage }));
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
vi.mock("../../3dp_lib/dashboard_time.js", () => ({ wallNowMs: () => 123456 }));

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
  mocks.saveUnifiedStorage.mockReset();
  mocks.saveUnifiedStorage.mockImplementation(async () => {
    mocks.events.push("save");
    return { ok: true, backend: "indexedDB", reason: "flushed" };
  });
  mocks.classifyHostAttribution.mockReset();
  mocks.buildInferredContinuityProjection.mockReset();
  mocks.persistInferredCandidate.mockReset();
  mocks.commitObservationWindow.mockReset();
});

describe("runInferredContinuityShadow", () => {
  it("candidate を耐久保存してから baseline commit し、commit 成功後に再保存する", async () => {
    const cls = classification();
    const projection = { host: "k1", inferredContinuityUsedMm: 1200, eligibleForPersistence: true, status: "ok" };
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

    const result = await runInferredContinuityShadow("k1", { id: "S1", remainingLengthMm: 5000 });

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

  it("耐久保存中に sequence だけ進んだ同一 window は最新 sequence で baseline commit する", async () => {
    const before = classification({ currentSequence: 2 });
    const after = classification({ currentSequence: 3 });
    const projection = { host: "k1", inferredContinuityUsedMm: 1200, eligibleForPersistence: true, status: "ok" };
    mocks.classifyHostAttribution.mockReturnValueOnce(before).mockReturnValueOnce(after);
    mocks.buildInferredContinuityProjection.mockReturnValue(projection);
    mocks.persistInferredCandidate.mockImplementation(() => {
      mocks.events.push("persist");
      return { ok: true, reason: "created", candidateHash: "ic-1", record: { createdAt: 1000 } };
    });
    mocks.commitObservationWindow.mockImplementation(() => {
      mocks.events.push("commit");
      return { ok: true, reason: "committed" };
    });

    const result = await runInferredContinuityShadow("k1", { id: "S1" });

    expect(result.ok).toBe(true);
    expect(mocks.commitObservationWindow).toHaveBeenCalledWith("k1", {
      windowId: "k1|b1|c2",
      expectedSequence: 3,
      candidatePersistedAt: 1000,
      candidateHash: "ic-1",
      expectedAppSessionId: "session-a"
    });
    expect(mocks.events).toEqual(["persist", "save", "commit", "save"]);
  });

  it("耐久保存中に offline key 集合が変わった場合は baseline commit を止める", async () => {
    const before = classification({ currentSequence: 2 });
    const after = classification({
      currentSequence: 3,
      candidate: { ...classification().candidate, offlineObservationKeys: ["job-a", "job-b"] }
    });
    mocks.classifyHostAttribution.mockReturnValueOnce(before).mockReturnValueOnce(after);
    mocks.buildInferredContinuityProjection.mockReturnValue({
      host: "k1",
      inferredContinuityUsedMm: 1200,
      eligibleForPersistence: true,
      status: "ok"
    });
    mocks.persistInferredCandidate.mockImplementation(() => {
      mocks.events.push("persist");
      return { ok: true, reason: "created", candidateHash: "ic-1", record: { createdAt: 1000 } };
    });

    const result = await runInferredContinuityShadow("k1", { id: "S1" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("classification_changed_since_candidate_persisted");
    expect(mocks.events).toEqual(["persist", "save"]);
    expect(mocks.commitObservationWindow).not.toHaveBeenCalled();
  });

  it("O2 が continuity-candidate 以外なら projection と保存を実行しない", async () => {
    mocks.classifyHostAttribution.mockReturnValue(classification({ classification: "no-offline-activity" }));

    const result = await runInferredContinuityShadow("k1", { id: "S1" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-offline-activity");
    expect(mocks.buildInferredContinuityProjection).not.toHaveBeenCalled();
    expect(mocks.persistInferredCandidate).not.toHaveBeenCalled();
    expect(mocks.commitObservationWindow).not.toHaveBeenCalled();
  });

  it("O4 が no_inferred_debit を返した場合は baseline を進めない", async () => {
    mocks.classifyHostAttribution.mockReturnValue(classification());
    mocks.buildInferredContinuityProjection.mockReturnValue({ host: "k1", inferredContinuityUsedMm: 0, eligibleForPersistence: true, status: "ok" });
    mocks.persistInferredCandidate.mockReturnValue({ ok: false, reason: "no_inferred_debit", candidateHash: null, record: null });

    const result = await runInferredContinuityShadow("k1", { id: "S1" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_inferred_debit");
    expect(mocks.saveUnifiedStorage).not.toHaveBeenCalled();
    expect(mocks.commitObservationWindow).not.toHaveBeenCalled();
  });

  it("candidate と baseline がともに idempotent の場合は耐久保存を追加実行しない", async () => {
    mocks.classifyHostAttribution.mockReturnValue(classification());
    mocks.buildInferredContinuityProjection.mockReturnValue({
      host: "k1",
      inferredContinuityUsedMm: 1200,
      eligibleForPersistence: true,
      status: "ok"
    });
    mocks.persistInferredCandidate.mockImplementation(() => {
      mocks.events.push("persist");
      return {
        ok: true,
        reason: "idempotent",
        candidateHash: "ic-1",
        record: { createdAt: 1000, updatedAt: 1000 },
        idempotent: true
      };
    });
    mocks.commitObservationWindow.mockImplementation(() => {
      mocks.events.push("commit");
      return { ok: true, reason: "idempotent", idempotent: true };
    });

    const result = await runInferredContinuityShadow("k1", { id: "S1" });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("idempotent");
    expect(mocks.events).toEqual(["persist", "commit"]);
    expect(mocks.saveUnifiedStorage).not.toHaveBeenCalled();
  });

  it("O3 が persistence 不可なら O4 保存と baseline commit を実行しない", async () => {
    mocks.classifyHostAttribution.mockReturnValue(classification());
    mocks.buildInferredContinuityProjection.mockReturnValue({
      host: "k1",
      inferredContinuityUsedMm: 1200,
      eligibleForPersistence: false,
      status: "contradicted",
      contradictions: [{ reason: "already-confirmed-on-other-spool" }]
    });

    const result = await runInferredContinuityShadow("k1", { id: "S1" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("contradicted");
    expect(mocks.persistInferredCandidate).not.toHaveBeenCalled();
    expect(mocks.saveUnifiedStorage).not.toHaveBeenCalled();
    expect(mocks.commitObservationWindow).not.toHaveBeenCalled();
  });

  it("candidate の耐久保存に失敗した場合は baseline commit へ進まない", async () => {
    mocks.classifyHostAttribution.mockReturnValue(classification());
    mocks.buildInferredContinuityProjection.mockReturnValue({
      host: "k1",
      inferredContinuityUsedMm: 1200,
      eligibleForPersistence: true,
      status: "ok"
    });
    mocks.persistInferredCandidate.mockImplementation(() => {
      mocks.events.push("persist");
      return { ok: true, reason: "created", candidateHash: "ic-1", record: { createdAt: 1000 } };
    });
    mocks.saveUnifiedStorage.mockImplementation(async () => {
      mocks.events.push("save");
      return { ok: false, backend: "indexedDB", reason: "idb_flush_failed" };
    });

    const result = await runInferredContinuityShadow("k1", { id: "S1" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("idb_flush_failed");
    expect(mocks.events).toEqual(["persist", "save"]);
    expect(mocks.commitObservationWindow).not.toHaveBeenCalled();
  });

  it("baseline commit 後の耐久保存に失敗した場合は失敗として返す", async () => {
    mocks.classifyHostAttribution.mockReturnValue(classification());
    mocks.buildInferredContinuityProjection.mockReturnValue({
      host: "k1",
      inferredContinuityUsedMm: 1200,
      eligibleForPersistence: true,
      status: "ok"
    });
    mocks.persistInferredCandidate.mockImplementation(() => {
      mocks.events.push("persist");
      return { ok: true, reason: "created", candidateHash: "ic-1", record: { createdAt: 1000 } };
    });
    mocks.commitObservationWindow.mockImplementation(() => {
      mocks.events.push("commit");
      return { ok: true, reason: "committed" };
    });
    mocks.saveUnifiedStorage.mockImplementationOnce(async () => {
      mocks.events.push("save");
      return { ok: true, backend: "indexedDB", reason: "flushed" };
    }).mockImplementationOnce(async () => {
      mocks.events.push("save");
      return { ok: false, backend: "indexedDB", reason: "idb_flush_failed" };
    });

    const result = await runInferredContinuityShadow("k1", { id: "S1" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("idb_flush_failed");
    expect(mocks.events).toEqual(["persist", "save", "commit", "save"]);
  });

  it("例外を shadow_failed に畳み、本流へ throw しない", async () => {
    mocks.classifyHostAttribution.mockImplementation(() => { throw new Error("classifier boom"); });

    const result = await runInferredContinuityShadow("k1", { id: "S1" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("shadow_failed");
    expect(result.error).toBe("classifier boom");
  });
});
