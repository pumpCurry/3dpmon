/**
 * @fileoverview dashboard_offline_classifier.js（#411-O2 分類レイヤ）の単体テスト
 * ObservationWindow → 分類 → candidate → confidence の純関数を検証する。
 * 継続候補は「停止前後で同一スプールが装着継続」を観測できた場合のみ成立すること、
 * O2 が Observation 層を変更せず利用のみ・remaining/安全基盤に触れないことを確認。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mockMonitorData = {
  machines: {}, hostSpoolMap: {}, hostObservationWatermark: {}, hostObservationCurrent: {},
  appSettings: { connectionTargets: [] },
  mountHistory: [{ evId: "keep" }], pendingUnattributedUsage: [{ pendingUsageId: "keep" }],
  remainingLengthMm: 12345,
};
vi.mock("../../3dp_lib/dashboard_data.js", () => ({ monitorData: mockMonitorData }));

const { ATTR_CLASS, classifyObservationWindow, classifyHostAttribution } =
  await import("../../3dp_lib/dashboard_offline_classifier.js");
const { recordObservation, computeObservationWindow, commitObservationWindow } =
  await import("../../3dp_lib/dashboard_offline_observation.js");

const M = (over = {}) => ({ spoolId: "S1", intervalId: "iv1", intervalStatus: "ok", observationState: "mounted", ...over });

/** 既定 bounded・同一スプール継続の ObservationWindow を組み立てる。 */
function win(over = {}) {
  const baselineMount = M(over.baselineMount || {});
  const currentMount = M(over.currentMount || {});
  return {
    windowId: "h|b1|c2", windowKind: "bounded", bounded: true, truncated: false, generationChanged: false,
    reason: "diff-ok", offlineObservationKeys: [], unresolvedJobIds: [], hasCurrentObservation: true,
    baselineFingerprint: {}, currentFingerprint: {}, baselineSequence: 1, currentSequence: 2, stalenessMs: 0,
    watermark: {},
    ...over,
    baselineMount, currentMount
  };
}

describe("continuity 成立条件（O2-P0-1: 停止前後で同一スプール装着継続の観測が必須）", () => {
  it("baseline A / current A / offline あり → continuity-candidate（interval一致で high）", () => {
    const r = classifyObservationWindow(win({ offlineObservationKeys: ["k1", "k2"] }));
    expect(r.classification).toBe(ATTR_CLASS.CONTINUITY_CANDIDATE);
    expect(r.candidate.candidateSpoolId).toBe("S1");
    expect(r.candidate.candidateBaselineIntervalId).toBe("iv1");
    expect(r.candidate.candidateCurrentIntervalId).toBe("iv1");
    expect(r.candidate.offlineObservationKeys).toEqual(["k1", "k2"]);
    expect(r.confidence.level).toBe("high");
    expect(r.confidence.reasons).toEqual(expect.arrayContaining(["same-mounted-spool", "current-interval-ok", "same-mount-interval"]));
  });

  it("baseline A / current B → continuity-contradicted（candidate なし）", () => {
    const r = classifyObservationWindow(win({
      offlineObservationKeys: ["k1"], currentMount: { spoolId: "S2" }
    }));
    expect(r.classification).toBe(ATTR_CLASS.CONTINUITY_CONTRADICTED);
    expect(r.candidate).toBeNull();
    expect(r.confidence.reasons).toContain("mounted-spool-changed");
  });

  it("baseline A / current 未装着 → continuity-contradicted（candidate なし）", () => {
    const r = classifyObservationWindow(win({
      offlineObservationKeys: ["k1"], currentMount: { spoolId: null, observationState: "unmounted", intervalStatus: "none" }
    }));
    expect(r.classification).toBe(ATTR_CLASS.CONTINUITY_CONTRADICTED);
    expect(r.candidate).toBeNull();
    expect(r.confidence.reasons).toContain("current-unmounted");
  });

  it("current の mount interval が corrupt → continuity-contradicted（candidate なし）", () => {
    const r = classifyObservationWindow(win({
      offlineObservationKeys: ["k1"], currentMount: { intervalStatus: "corrupt" }
    }));
    expect(r.classification).toBe(ATTR_CLASS.CONTINUITY_CONTRADICTED);
    expect(r.candidate).toBeNull();
  });

  it("current の mount interval が ambiguous → continuity-contradicted", () => {
    const r = classifyObservationWindow(win({
      offlineObservationKeys: ["k1"], currentMount: { intervalStatus: "ambiguous" }
    }));
    expect(r.classification).toBe(ATTR_CLASS.CONTINUITY_CONTRADICTED);
  });

  it("baseline 未装着 → no-mounted-spool（candidate なし）", () => {
    const r = classifyObservationWindow(win({
      offlineObservationKeys: ["k1"], baselineMount: { spoolId: null, observationState: "unmounted", intervalStatus: "none" }
    }));
    expect(r.classification).toBe(ATTR_CLASS.NO_MOUNTED_SPOOL);
    expect(r.candidate).toBeNull();
  });
});

describe("O2-P0-2: current 観測が無ければ candidate を作らない", () => {
  it("hasCurrentObservation=false → observation-incomplete（NO_PRIOR とは別）", () => {
    const r = classifyObservationWindow(win({ windowKind: "incomplete", bounded: false, hasCurrentObservation: false, offlineObservationKeys: ["k1"] }));
    expect(r.classification).toBe(ATTR_CLASS.OBSERVATION_INCOMPLETE);
    expect(r.candidate).toBeNull();
    expect(r.confidence.level).toBe("none");
  });
});

describe("confidence 段階（interval / truncated）", () => {
  it("same spool / same interval → high", () => {
    expect(classifyObservationWindow(win({ offlineObservationKeys: ["k1"] })).confidence.level).toBe("high");
  });

  it("same spool / different interval → high にしない（途中 detach/reattach 疑い）", () => {
    const r = classifyObservationWindow(win({ offlineObservationKeys: ["k1"], currentMount: { intervalId: "iv2" } }));
    expect(r.classification).toBe(ATTR_CLASS.CONTINUITY_CANDIDATE);
    expect(r.confidence.level).not.toBe("high");
    expect(r.confidence.reasons).toContain("mount-interval-changed");
  });

  it("current interval none（同一スプール・mounted）→ candidate は出すが low", () => {
    const r = classifyObservationWindow(win({
      offlineObservationKeys: ["k1"], currentMount: { intervalStatus: "none", intervalId: null }
    }));
    expect(r.classification).toBe(ATTR_CLASS.CONTINUITY_CANDIDATE);
    expect(r.confidence.level).toBe("low");
  });

  it("truncated は candidate の confidence を1段下げる（下限 low）", () => {
    const r = classifyObservationWindow(win({ offlineObservationKeys: ["k1"], truncated: true }));
    expect(r.confidence.level).toBe("medium");
    expect(r.confidence.reasons).toContain("history-truncated");
  });
});

describe("非 candidate 分類", () => {
  it("bounded だが offline なし → no-offline-activity（high）", () => {
    const r = classifyObservationWindow(win({ offlineObservationKeys: [] }));
    expect(r.classification).toBe(ATTR_CLASS.NO_OFFLINE_ACTIVITY);
    expect(r.candidate).toBeNull();
    expect(r.confidence.level).toBe("high");
  });

  it("offline なし＋truncated → no-offline-activity だが medium（監査用に理由を残す）", () => {
    const r = classifyObservationWindow(win({ offlineObservationKeys: [], truncated: true }));
    expect(r.classification).toBe(ATTR_CLASS.NO_OFFLINE_ACTIVITY);
    expect(r.confidence.level).toBe("medium");
    expect(r.confidence.reasons).toContain("history-truncated");
  });

  it("windowKind=unbounded → unbounded（candidate なし・none）", () => {
    const r = classifyObservationWindow(win({ windowKind: "unbounded", bounded: false, reason: "printer-identity-changed" }));
    expect(r.classification).toBe(ATTR_CLASS.UNBOUNDED);
    expect(r.candidate).toBeNull();
    expect(r.confidence.reasons).toContain("printer-identity-changed");
  });

  it("windowKind=insufficient → insufficient（unresolvedJobIds を持ち越す）", () => {
    const r = classifyObservationWindow(win({ windowKind: "insufficient", bounded: false, reason: "job-identity-insufficient", unresolvedJobIds: ["3"] }));
    expect(r.classification).toBe(ATTR_CLASS.INSUFFICIENT);
    expect(r.candidate).toBeNull();
    expect(r.unresolvedJobIds).toEqual(["3"]);
  });

  it("windowKind=no-prior → no-prior", () => {
    const r = classifyObservationWindow(win({ windowKind: "no-prior", bounded: false, reason: "no-prior-observation" }));
    expect(r.classification).toBe(ATTR_CLASS.NO_PRIOR);
  });

  it("window が無効でも落ちない（no-prior/none）", () => {
    expect(classifyObservationWindow(null).classification).toBe(ATTR_CLASS.NO_PRIOR);
    expect(classifyObservationWindow(undefined).confidence.level).toBe("none");
  });
});

describe("classifyHostAttribution（Observation 層を利用のみ・read-only）", () => {
  const BASE = 1_700_000_000_000;
  function job(id, t) { return { id, materialUsedMm: 5000, printfinish: 1, finishTime: BASE + t * 1000, filename: `f${id}.gcode` }; }
  function setHistory(host, entries) {
    if (!mockMonitorData.machines[host]) mockMonitorData.machines[host] = { printStore: {}, storedData: {} };
    mockMonitorData.machines[host].printStore = { history: entries };
  }
  function establishBaseline(host, spool, entries) {
    mockMonitorData.hostSpoolMap[host] = spool;
    setHistory(host, entries);
    recordObservation(host, { mountIntervalStatus: "ok", mountIntervalId: "iv1" });
    const w = computeObservationWindow(host);
    commitObservationWindow(host, { windowId: w.windowId, expectedSequence: w.currentSequence, candidatePersistedAt: 1 });
  }

  beforeEach(() => {
    mockMonitorData.machines = {};
    mockMonitorData.hostSpoolMap = {};
    mockMonitorData.hostObservationWatermark = {};
    mockMonitorData.hostObservationCurrent = {};
    mockMonitorData.appSettings = { connectionTargets: [] };
    mockMonitorData.mountHistory = [{ evId: "keep" }];
    mockMonitorData.pendingUnattributedUsage = [{ pendingUsageId: "keep" }];
    mockMonitorData.remainingLengthMm = 12345;
  });

  it("同一スプール継続で offline 完了が出れば continuity-candidate、安全基盤は不変", () => {
    establishBaseline("h", "S1", [job("1000", 100)]);
    setHistory("h", [job("1000", 100), job("1001", 200)]);
    recordObservation("h", { mountIntervalStatus: "ok", mountIntervalId: "iv1" });

    const r = classifyHostAttribution("h");
    expect(r.classification).toBe(ATTR_CLASS.CONTINUITY_CANDIDATE);
    expect(r.candidate.candidateSpoolId).toBe("S1");
    expect(r.candidate.offlineObservationKeys).toHaveLength(1);
    expect(r.confidence.level).toBe("high");
    // read-only 境界
    expect(mockMonitorData.remainingLengthMm).toBe(12345);
    expect(mockMonitorData.mountHistory).toEqual([{ evId: "keep" }]);
    expect(mockMonitorData.pendingUnattributedUsage).toEqual([{ pendingUsageId: "keep" }]);
  });

  it("復帰後に別スプールへ替わっていたら continuity-contradicted（誤帰属しない）", () => {
    establishBaseline("h", "S1", [job("1000", 100)]);
    // 復帰後: 物理的に S2 へ交換され、offline 完了 1001 が出現
    mockMonitorData.hostSpoolMap.h = "S2";
    setHistory("h", [job("1000", 100), job("1001", 200)]);
    recordObservation("h", { mountIntervalStatus: "ok", mountIntervalId: "iv9" });

    const r = classifyHostAttribution("h");
    expect(r.classification).toBe(ATTR_CLASS.CONTINUITY_CONTRADICTED);
    expect(r.candidate).toBeNull();
  });

  it("baseline はあるが復帰後 current 未観測なら observation-incomplete", () => {
    establishBaseline("h", "S1", [job("1000", 100)]);
    // 再起動直後: current 観測がまだ無い状態を模す
    delete mockMonitorData.hostObservationCurrent.h;
    setHistory("h", [job("1000", 100), job("1001", 200)]);

    const r = classifyHostAttribution("h");
    expect(r.classification).toBe(ATTR_CLASS.OBSERVATION_INCOMPLETE);
    expect(r.candidate).toBeNull();
  });

  it("前回観測が無ければ no-prior", () => {
    setHistory("h", [job("1", 100)]);
    expect(classifyHostAttribution("h").classification).toBe(ATTR_CLASS.NO_PRIOR);
  });
});
