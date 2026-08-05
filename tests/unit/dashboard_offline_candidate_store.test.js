/**
 * @fileoverview dashboard_offline_candidate_store.js（#412-O4 candidate store）の単体テスト
 * O2/O3 の結果を冪等に永続候補化し、削除ではなく状態遷移で監査できることを検証する。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mockMonitorData = { inferredCandidateStore: {} };
vi.mock("../../3dp_lib/dashboard_data.js", () => ({ monitorData: mockMonitorData }));

const {
  INFERRED_CANDIDATE_STATUS,
  buildInferredCandidateHash,
  persistInferredCandidate,
  transitionInferredCandidate,
  getInferredCandidatesForHost
} = await import("../../3dp_lib/dashboard_offline_candidate_store.js");

/**
 * O2 分類結果 fixture を作る。
 *
 * @function cls
 * @param {Object} [over] - 上書き値。
 * @returns {Object} classifyObservationWindow の戻り値相当。
 */
function cls(over = {}) {
  return {
    classification: "continuity-candidate",
    host: "k1",
    windowId: "k1|b1|c2",
    confidence: { level: "medium", reasons: ["bounded"], contradictions: [] },
    evidence: { sameMountedSpool: true },
    candidate: {
      candidateSpoolId: "S1",
      candidateBaselineIntervalId: "iv1",
      candidateCurrentIntervalId: "iv1",
      offlineObservationKeys: ["kA", "kB"],
      windowId: "k1|b1|c2"
    },
    ...over
  };
}

/**
 * O3 projection fixture を作る。
 *
 * @function proj
 * @param {Object} [over] - 上書き値。
 * @returns {Object} buildInferredContinuityProjection の戻り値相当。
 */
function proj(over = {}) {
  return {
    host: "k1",
    inferredContinuityUsedMm: 3000,
    candidateDebits: [
      { observationKey: "kA", status: "inferred-debit", usedMm: 1000, reason: "unattributed-usage", confirmedSpoolIds: [] },
      { observationKey: "kB", status: "inferred-debit", usedMm: 2000, reason: "unattributed-usage", confirmedSpoolIds: [] }
    ],
    ok: true,
    status: "ok",
    eligibleForPersistence: true,
    ...over
  };
}

beforeEach(() => {
  mockMonitorData.inferredCandidateStore = {};
});

describe("buildInferredCandidateHash", () => {
  it("observationKeys の順序差を同じ candidateHash に畳む", () => {
    const a = buildInferredCandidateHash(cls(), proj());
    const b = buildInferredCandidateHash(cls({
      candidate: { ...cls().candidate, offlineObservationKeys: ["kB", "kA"] }
    }), proj());
    expect(a).toBe(b);
    expect(a.startsWith("ic-")).toBe(true);
  });

  it("windowId が異なれば別 candidateHash になる", () => {
    const a = buildInferredCandidateHash(cls(), proj());
    const b = buildInferredCandidateHash(cls({ windowId: "k1|b2|c3" }), proj());
    expect(a).not.toBe(b);
  });

  it("同一 candidate の使用量変化では candidateHash を変えない", () => {
    const a = buildInferredCandidateHash(cls(), proj({ inferredContinuityUsedMm: 3000 }));
    const b = buildInferredCandidateHash(cls(), proj({ inferredContinuityUsedMm: 4500 }));
    expect(a).toBe(b);
  });
});

describe("persistInferredCandidate", () => {
  it("O2/O3 結果を pending candidate として保存する", () => {
    const r = persistInferredCandidate(cls(), proj(), { nowMs: 1000 });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("created");
    expect(r.record.status).toBe(INFERRED_CANDIDATE_STATUS.PENDING);
    expect(r.record.usedMm).toBe(3000);
    expect(r.record.observationKeys).toEqual(["kA", "kB"]);
    expect(r.record.events).toHaveLength(1);
    expect(Object.keys(mockMonitorData.inferredCandidateStore)).toEqual([r.candidateHash]);
  });

  it("同一 candidateHash は再保存しても増殖しない", () => {
    const first = persistInferredCandidate(cls(), proj(), { nowMs: 1000 });
    const second = persistInferredCandidate(cls(), proj(), { nowMs: 2000 });
    expect(second.reason).toBe("idempotent");
    expect(second.record).toBe(first.record);
    expect(Object.keys(mockMonitorData.inferredCandidateStore)).toHaveLength(1);
    expect(second.record.events).toHaveLength(1);
  });

  it.each([
    INFERRED_CANDIDATE_STATUS.SUPERSEDED,
    INFERRED_CANDIDATE_STATUS.REJECTED,
    INFERRED_CANDIDATE_STATUS.CONFIRMED,
    INFERRED_CANDIDATE_STATUS.REASSIGNED,
    INFERRED_CANDIDATE_STATUS.UNDONE
  ])("既存 candidate が %s の場合は同一 identity でも再利用しない", (status) => {
    const first = persistInferredCandidate(cls(), proj(), { nowMs: 1000 });
    const transition = transitionInferredCandidate(first.candidateHash, status, {
      nowMs: 1500,
      reason: "resolved-before-reevaluation",
      assignedSpoolId: status === INFERRED_CANDIDATE_STATUS.REASSIGNED ? "S2" : null
    });
    const second = persistInferredCandidate(cls(), proj(), { nowMs: 2000 });

    expect(transition.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("candidate_not_pending");
    expect(second.candidateHash).toBe(first.candidateHash);
    expect(second.record).toBe(first.record);
    expect(second.record.status).toBe(status);
  });

  it("同一 candidateHash の再評価では使用量と根拠を同一 record 上で更新する", () => {
    const first = persistInferredCandidate(cls(), proj(), { nowMs: 1000 });
    const second = persistInferredCandidate(
      cls({
        confidence: { level: "high", reasons: ["bounded", "stable"], contradictions: [] },
        evidence: { sameMountedSpool: true, operatorConfirmed: false }
      }),
      proj({
        inferredContinuityUsedMm: 4500,
        candidateDebits: [
          { observationKey: "kA", status: "inferred-debit", usedMm: 1500, reason: "unattributed-usage", confirmedSpoolIds: [] },
          { observationKey: "kB", status: "inferred-debit", usedMm: 3000, reason: "unattributed-usage", confirmedSpoolIds: [] }
        ]
      }),
      { nowMs: 2000 }
    );
    expect(second.reason).toBe("updated");
    expect(second.record).toBe(first.record);
    expect(second.record.usedMm).toBe(4500);
    expect(second.record.confidence.level).toBe("high");
    expect(second.record.evidence.operatorConfirmed).toBe(false);
    expect(second.record.events).toHaveLength(2);
    expect(second.record.events[1].reason).toBe("projection-used-mm-changed");
    expect(Object.keys(mockMonitorData.inferredCandidateStore)).toHaveLength(1);
  });

  it("projection が永続化対象外なら candidate を保存しない", () => {
    const r = persistInferredCandidate(cls(), proj({ eligibleForPersistence: false }), { nowMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("projection_not_eligible");
    expect(mockMonitorData.inferredCandidateStore).toEqual({});
  });

  it("同一 candidateHash の再評価で confidence と evidence を更新する", () => {
    const first = persistInferredCandidate(cls(), proj(), { nowMs: 1000 });
    const second = persistInferredCandidate(cls({
      confidence: { level: "high", reasons: ["bounded", "same-spool"], contradictions: [] },
      evidence: { sameMountedSpool: true, sequenceRefreshed: true }
    }), proj(), { nowMs: 2000 });

    expect(second.reason).toBe("updated");
    expect(second.record).toBe(first.record);
    expect(second.record.usedMm).toBe(3000);
    expect(second.record.updatedAt).toBe(2000);
    expect(second.record.confidence).toEqual({ level: "high", reasons: ["bounded", "same-spool"], contradictions: [] });
    expect(second.record.evidence).toEqual({ sameMountedSpool: true, sequenceRefreshed: true });
    expect(second.record.events).toHaveLength(1);
  });

  it("推定 debit が 0 なら保存しない", () => {
    const r = persistInferredCandidate(cls(), proj({ inferredContinuityUsedMm: 0 }), { nowMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_inferred_debit");
    expect(mockMonitorData.inferredCandidateStore).toEqual({});
  });

  it("hash が一致しても identity が違う既存 record は衝突として拒否する", () => {
    const candidateHash = buildInferredCandidateHash(cls(), proj());
    mockMonitorData.inferredCandidateStore[candidateHash] = {
      candidateHash,
      status: INFERRED_CANDIDATE_STATUS.PENDING,
      windowId: "k9|b1|c2",
      host: "k9",
      candidateSpoolId: "S9",
      candidateBaselineIntervalId: "iv9",
      candidateCurrentIntervalId: "iv9",
      observationKeys: ["kZ"],
      identityMaterial: {
        windowId: "k9|b1|c2",
        candidateSpoolId: "S9",
        candidateBaselineIntervalId: "iv9",
        candidateCurrentIntervalId: "iv9",
        observationKeys: ["kZ"]
      },
      events: []
    };
    const r = persistInferredCandidate(cls(), proj(), { nowMs: 2000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("candidate_hash_collision");
    expect(r.collision).toBe(mockMonitorData.inferredCandidateStore[candidateHash]);
    expect(Object.keys(mockMonitorData.inferredCandidateStore)).toHaveLength(1);
    expect(mockMonitorData.inferredCandidateStore[candidateHash].windowId).toBe("k9|b1|c2");
  });

  it("O3 が persistence 不可なら推定 debit があっても保存しない", () => {
    const r = persistInferredCandidate(cls(), proj({ eligibleForPersistence: false, status: "contradicted" }), { nowMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("contradicted");
    expect(mockMonitorData.inferredCandidateStore).toEqual({});
  });
});

describe("transitionInferredCandidate", () => {
  it("confirmed へ状態遷移し resolvedAt と event を追記する", () => {
    const created = persistInferredCandidate(cls(), proj(), { nowMs: 1000 });
    const r = transitionInferredCandidate(created.candidateHash, "confirmed", {
      nowMs: 2000, actor: "user", reason: "same-spool-confirmed"
    });
    expect(r.ok).toBe(true);
    expect(r.record.status).toBe("confirmed");
    expect(r.record.resolvedAt).toBe(2000);
    expect(r.record.events).toHaveLength(2);
    expect(r.record.events[1].actor).toBe("user");
  });

  it("同じ状態への再適用は冪等で event を増やさない", () => {
    const created = persistInferredCandidate(cls(), proj(), { nowMs: 1000 });
    transitionInferredCandidate(created.candidateHash, "rejected", { nowMs: 2000 });
    const r = transitionInferredCandidate(created.candidateHash, "rejected", { nowMs: 3000 });
    expect(r.reason).toBe("idempotent");
    expect(r.record.events).toHaveLength(2);
  });

  it("reassigned は assignedSpoolId を保持する", () => {
    const created = persistInferredCandidate(cls(), proj(), { nowMs: 1000 });
    const r = transitionInferredCandidate(created.candidateHash, "reassigned", {
      nowMs: 2000, assignedSpoolId: "S2"
    });
    expect(r.record.assignedSpoolId).toBe("S2");
  });
});

describe("getInferredCandidatesForHost", () => {
  it("host と status で candidate を取得する", () => {
    const k1 = persistInferredCandidate(cls(), proj(), { nowMs: 1000 });
    persistInferredCandidate(cls({ host: "k2", windowId: "k2|b1|c2" }), proj({ host: "k2" }), { nowMs: 2000 });
    transitionInferredCandidate(k1.candidateHash, "confirmed", { nowMs: 3000 });
    expect(getInferredCandidatesForHost("k1")).toHaveLength(1);
    expect(getInferredCandidatesForHost("k1", { status: "pending" })).toHaveLength(0);
    expect(getInferredCandidatesForHost("k1", { status: "confirmed" })).toHaveLength(1);
  });
});
