/**
 * @fileoverview dashboard_offline_classifier.js（#411-O2 分類レイヤ）の単体テスト
 * ObservationWindow → 分類 → candidate → confidence の純関数を検証する。
 * O2 は Observation 層を変更せず利用のみ・remaining/安全基盤に触れないことも確認。
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

/** 既定 bounded・継続候補になる ObservationWindow を組み立てる。 */
function win(over = {}) {
  return {
    windowId: "h|b1|c2", bounded: true, truncated: false, generationChanged: false,
    reason: "diff-ok", offlineObservationKeys: [], unresolvedJobIds: [],
    baselineFingerprint: {}, currentFingerprint: {}, baselineSequence: 1, currentSequence: 2,
    stalenessMs: 0,
    watermark: { mountedSpoolId: "S1", mountIntervalId: "iv1", mountIntervalStatus: "ok" },
    ...over
  };
}

describe("classifyObservationWindow（純関数）", () => {
  it("bounded＋offline完了＋装着スプール＋interval ok → continuity-candidate/high", () => {
    const r = classifyObservationWindow(win({ offlineObservationKeys: ["k1", "k2"] }));
    expect(r.classification).toBe(ATTR_CLASS.CONTINUITY_CANDIDATE);
    expect(r.candidate.candidateSpoolId).toBe("S1");
    expect(r.candidate.candidateIntervalId).toBe("iv1");
    expect(r.candidate.offlineObservationKeys).toEqual(["k1", "k2"]);
    expect(r.confidence.level).toBe("high");
    expect(r.confidence.reasons).toEqual(expect.arrayContaining(["bounded", "same-mounted-spool", "mount-interval-ok"]));
  });

  it("interval が ok でない（ambiguous）と confidence を1段下げる", () => {
    const r = classifyObservationWindow(win({
      offlineObservationKeys: ["k1"], watermark: { mountedSpoolId: "S1", mountIntervalStatus: "ambiguous" }
    }));
    expect(r.classification).toBe(ATTR_CLASS.CONTINUITY_CANDIDATE);
    expect(r.confidence.level).toBe("medium");
    expect(r.confidence.reasons).toContain("mount-interval-ambiguous");
  });

  it("truncated は confidence を1段下げる", () => {
    const r = classifyObservationWindow(win({ offlineObservationKeys: ["k1"], truncated: true }));
    expect(r.confidence.level).toBe("medium");
    expect(r.confidence.reasons).toContain("history-truncated");
  });

  it("弱い証拠が重なっても candidate の confidence は low で下げ止まる", () => {
    const r = classifyObservationWindow(win({
      offlineObservationKeys: ["k1"], truncated: true, unresolvedJobIds: ["9"], stalenessMs: 40 * 24 * 3600 * 1000,
      watermark: { mountedSpoolId: "S1", mountIntervalStatus: "none" }
    }));
    expect(r.classification).toBe(ATTR_CLASS.CONTINUITY_CANDIDATE);
    expect(r.confidence.level).toBe("low"); // none まで落ちない
  });

  it("bounded だが offline 完了なし → no-offline-activity（candidate なし・high）", () => {
    const r = classifyObservationWindow(win({ offlineObservationKeys: [] }));
    expect(r.classification).toBe(ATTR_CLASS.NO_OFFLINE_ACTIVITY);
    expect(r.candidate).toBeNull();
    expect(r.confidence.level).toBe("high");
  });

  it("bounded＋offline あるが baseline 未装着 → no-mounted-spool（candidate なし）", () => {
    const r = classifyObservationWindow(win({
      offlineObservationKeys: ["k1"], watermark: { mountedSpoolId: null, mountIntervalStatus: "none" }
    }));
    expect(r.classification).toBe(ATTR_CLASS.NO_MOUNTED_SPOOL);
    expect(r.candidate).toBeNull();
  });

  it("bounded=false / identity 変化 → unbounded（candidate なし・none）", () => {
    const r = classifyObservationWindow(win({ bounded: false, reason: "printer-identity-changed" }));
    expect(r.classification).toBe(ATTR_CLASS.UNBOUNDED);
    expect(r.candidate).toBeNull();
    expect(r.confidence.level).toBe("none");
    expect(r.confidence.reasons).toContain("printer-identity-changed");
  });

  it("bounded=false / 識別不足 → insufficient（unresolvedJobIds を持ち越す）", () => {
    const r = classifyObservationWindow(win({ bounded: false, reason: "job-identity-insufficient", unresolvedJobIds: ["3"] }));
    expect(r.classification).toBe(ATTR_CLASS.INSUFFICIENT);
    expect(r.candidate).toBeNull();
    expect(r.unresolvedJobIds).toEqual(["3"]);
  });

  it("再利用ID未検証も insufficient", () => {
    const r = classifyObservationWindow(win({ bounded: false, reason: "reused-job-id-unverifiable", unresolvedJobIds: ["7"] }));
    expect(r.classification).toBe(ATTR_CLASS.INSUFFICIENT);
  });

  it("前回観測なし → no-prior", () => {
    const r = classifyObservationWindow(win({ bounded: false, reason: "no-prior-observation", watermark: null }));
    expect(r.classification).toBe(ATTR_CLASS.NO_PRIOR);
    expect(r.candidate).toBeNull();
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

  it("装着中に offline 完了が出れば continuity-candidate を返し、安全基盤は不変", () => {
    mockMonitorData.hostSpoolMap.h = "S1";
    setHistory("h", [job("1000", 100)]);
    recordObservation("h", { mountIntervalStatus: "ok", mountIntervalId: "iv1" });
    const w0 = computeObservationWindow("h");
    commitObservationWindow("h", { windowId: w0.windowId, expectedSequence: w0.currentSequence, candidatePersistedAt: 1 });
    // 再起動後: オフライン完了 1001 が出現
    setHistory("h", [job("1000", 100), job("1001", 200)]);
    recordObservation("h", { mountIntervalStatus: "ok", mountIntervalId: "iv1" });

    const r = classifyHostAttribution("h");
    expect(r.classification).toBe(ATTR_CLASS.CONTINUITY_CANDIDATE);
    expect(r.candidate.candidateSpoolId).toBe("S1");
    expect(r.candidate.offlineObservationKeys).toHaveLength(1);
    expect(r.confidence.level).toBe("high");
    // read-only 境界: remaining / mountHistory / pendingUnattributedUsage 不変
    expect(mockMonitorData.remainingLengthMm).toBe(12345);
    expect(mockMonitorData.mountHistory).toEqual([{ evId: "keep" }]);
    expect(mockMonitorData.pendingUnattributedUsage).toEqual([{ pendingUsageId: "keep" }]);
  });

  it("前回観測が無ければ no-prior", () => {
    setHistory("h", [job("1", 100)]);
    expect(classifyHostAttribution("h").classification).toBe(ATTR_CLASS.NO_PRIOR);
  });
});
