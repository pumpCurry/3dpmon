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
const AJ = "J1";
const AJ_START = 1700000000000;
const AJKEY = JSON.stringify([AJ, AJ_START, AJ_START + 5000, "fJ1.gcode"]); // active job の offline 複合キー
const AJOBS = { canonicalJobId: AJ, startAt: AJ_START, fileSignature: "fJ1.gcode" }; // 印刷中に取得した複合 identity

/** 既定 bounded・同一スプール継続の ObservationWindow を組み立てる。 */
function win(over = {}) {
  const baselineMount = M(over.baselineMount || {});
  const currentMount = M(over.currentMount || {});
  return {
    windowId: "h|b1|c2", windowKind: "bounded", bounded: true, truncated: false, generationChanged: false,
    reason: "diff-ok", offlineObservationKeys: [], unresolvedJobIds: [], hasCurrentObservation: true,
    baselineFingerprint: {}, currentFingerprint: {}, baselineSequence: 1, currentSequence: 2, stalenessMs: 0,
    watermark: {}, printerIdentityMatch: { status: "same-descriptive", matchedBy: "model" },
    ...over,
    baselineMount, currentMount
  };
}
/** activeJobContinued=true（停止前印刷中ジョブの完了を複合 identity で観測＝high の前提）の継続窓。 */
function contWin(over = {}) {
  return win({ offlineObservationKeys: [AJKEY], watermark: { activeJobObservation: AJOBS }, ...over });
}

describe("continuity 成立条件（O2-P0-1: 停止前後で同一スプール装着継続の観測が必須）", () => {
  it("baseline A / current A / activeJob継続 → continuity-candidate（interval一致で high）", () => {
    const r = classifyObservationWindow(contWin());
    expect(r.classification).toBe(ATTR_CLASS.CONTINUITY_CANDIDATE);
    expect(r.candidate.candidateSpoolId).toBe("S1");
    expect(r.candidate.candidateBaselineIntervalId).toBe("iv1");
    expect(r.candidate.candidateCurrentIntervalId).toBe("iv1");
    expect(r.candidate.offlineObservationKeys).toEqual([AJKEY]);
    expect(r.confidence.level).toBe("high");
    expect(r.confidence.reasons).toEqual(expect.arrayContaining(["same-mounted-spool", "active-job-continued", "current-interval-ok", "baseline-interval-ok", "same-mount-interval"]));
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

  it("★P0-2: baseline interval が corrupt → continuity-contradicted（破損台帳を根拠にしない）", () => {
    const r = classifyObservationWindow(win({ offlineObservationKeys: ["k1"], baselineMount: { intervalStatus: "corrupt" } }));
    expect(r.classification).toBe(ATTR_CLASS.CONTINUITY_CONTRADICTED);
    expect(r.candidate).toBeNull();
    expect(r.confidence.contradictions).toContain("baseline-interval-corrupt");
  });

  it("★P0-2: baseline interval が ambiguous → continuity-contradicted", () => {
    const r = classifyObservationWindow(win({ offlineObservationKeys: ["k1"], baselineMount: { intervalStatus: "ambiguous" } }));
    expect(r.classification).toBe(ATTR_CLASS.CONTINUITY_CONTRADICTED);
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

describe("confidence 段階（P0-3: activeJobContinued / interval / truncated）", () => {
  it("activeJob継続＋same spool＋same interval＋前後ok → high", () => {
    expect(classifyObservationWindow(contWin()).confidence.level).toBe("high");
  });

  it("★P0-3: 完全オフライン（activeJobObservation なし）は high にしない＝medium 止まり", () => {
    const r = classifyObservationWindow(win({ offlineObservationKeys: ["k1"] })); // activeJobObservation なし
    expect(r.classification).toBe(ATTR_CLASS.CONTINUITY_CANDIDATE);
    expect(r.confidence.level).toBe("medium");
    expect(r.confidence.reasons).toContain("fully-offline");
  });

  it("★P1-B: active job の ID は一致でも複合 identity（開始時刻/file）が不一致なら high にしない", () => {
    // offline key は同 id だが startAt/file が別＝別実行（ID 再利用など）
    const otherKey = JSON.stringify([AJ, 999, 1000, "other.gcode"]);
    const r = classifyObservationWindow(win({
      offlineObservationKeys: [otherKey], watermark: { activeJobObservation: AJOBS }
    }));
    expect(r.classification).toBe(ATTR_CLASS.CONTINUITY_CANDIDATE);
    expect(r.confidence.level).toBe("medium"); // activeJobContinued=false 扱い
    expect(r.evidence.activeJobContinued).toBe(false);
  });

  it("★P1-B: baseline が idle（activeJobObservation なし）なら activeJobContinued=false", () => {
    const r = classifyObservationWindow(win({ offlineObservationKeys: [AJKEY], watermark: {} }));
    expect(r.evidence.activeJobContinued).toBe(false);
  });

  it("same spool / different interval → high にしない（途中 detach/reattach 疑い）", () => {
    const r = classifyObservationWindow(contWin({ currentMount: { intervalId: "iv2" } }));
    expect(r.classification).toBe(ATTR_CLASS.CONTINUITY_CANDIDATE);
    expect(r.confidence.level).not.toBe("high");
    expect(r.confidence.reasons).toContain("mount-interval-changed");
  });

  it("current interval none（同一スプール・mounted）→ candidate は出すが low", () => {
    const r = classifyObservationWindow(contWin({ currentMount: { intervalStatus: "none", intervalId: null } }));
    expect(r.classification).toBe(ATTR_CLASS.CONTINUITY_CANDIDATE);
    expect(r.confidence.level).toBe("low");
  });

  it("baseline interval が none/unknown → candidate は出すが low", () => {
    const r = classifyObservationWindow(contWin({ baselineMount: { intervalStatus: "none" } }));
    expect(r.classification).toBe(ATTR_CLASS.CONTINUITY_CANDIDATE);
    expect(r.confidence.level).toBe("low");
    expect(r.confidence.reasons).toContain("baseline-interval-none");
  });

  it("truncated は low tier（窓が欠けている可能性）", () => {
    const r = classifyObservationWindow(contWin({ truncated: true }));
    expect(r.confidence.level).toBe("low");
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

describe("evidence / contradictions（O2 返却仕様）", () => {
  it("continuity-candidate は evidence を埋める（sameMountedSpool/sameMountInterval/mountStatus）", () => {
    const r = classifyObservationWindow(win({ offlineObservationKeys: ["k1"] }));
    expect(r.evidence.sameMountedSpool).toBe(true);
    expect(r.evidence.sameMountInterval).toBe(true);
    expect(r.evidence.mountStatus).toBe("ok");
  });
  it("★P1-1: sameStrongPrinterIdentity は serial/deviceId 一致(same-strong)のみ true。model一致(same-descriptive)では false", () => {
    const desc = classifyObservationWindow(win({ offlineObservationKeys: ["k1"], printerIdentityMatch: { status: "same-descriptive", matchedBy: "model" } }));
    expect(desc.evidence.sameStrongPrinterIdentity).toBe(false);
    expect(desc.evidence.printerIdentityMatch.status).toBe("same-descriptive");
    const strong = classifyObservationWindow(win({ offlineObservationKeys: ["k1"], printerIdentityMatch: { status: "same-strong", matchedBy: "serialNumber" } }));
    expect(strong.evidence.sameStrongPrinterIdentity).toBe(true);
  });
  it("activeJobContinued: baseline の active job 複合 identity が offline 集合に現れる", () => {
    const r = classifyObservationWindow(contWin());
    expect(r.evidence.activeJobContinued).toBe(true);
  });
  it("continuity-contradicted は confidence.contradictions を埋める", () => {
    const r = classifyObservationWindow(win({ offlineObservationKeys: ["k1"], currentMount: { spoolId: "S2" } }));
    expect(r.confidence.contradictions).toContain("mounted-spool-changed");
  });
  it("unbounded も contradictions を埋める", () => {
    const r = classifyObservationWindow(win({ windowKind: "unbounded", bounded: false, reason: "printer-identity-changed" }));
    expect(r.confidence.contradictions).toContain("printer-identity-changed");
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

  it("同一スプール継続で offline 完了が出れば continuity-candidate（完全オフラインは medium）、安全基盤は不変", () => {
    establishBaseline("h", "S1", [job("1000", 100)]);
    setHistory("h", [job("1000", 100), job("1001", 200)]);
    recordObservation("h", { mountIntervalStatus: "ok", mountIntervalId: "iv1" });

    const r = classifyHostAttribution("h");
    expect(r.classification).toBe(ATTR_CLASS.CONTINUITY_CANDIDATE);
    expect(r.candidate.candidateSpoolId).toBe("S1");
    expect(r.candidate.offlineObservationKeys).toHaveLength(1);
    expect(r.confidence.level).toBe("medium"); // 停止前 idle＝完全オフライン→high にしない
    // read-only 境界
    expect(mockMonitorData.remainingLengthMm).toBe(12345);
    expect(mockMonitorData.mountHistory).toEqual([{ evId: "keep" }]);
    expect(mockMonitorData.pendingUnattributedUsage).toEqual([{ pendingUsageId: "keep" }]);
  });

  it("★P1-2: 永続復元された旧 current だけでは observation-incomplete（現セッションの観測が要る）", () => {
    establishBaseline("h", "S1", [job("1000", 100)]);
    // 復帰後: current を「旧セッションの appSessionId」に差し替える（永続復元を模す）
    mockMonitorData.hostObservationCurrent.h = { ...mockMonitorData.hostObservationCurrent.h, appSessionId: "stale-session" };
    setHistory("h", [job("1000", 100), job("1001", 200)]);
    const r = classifyHostAttribution("h");
    expect(r.classification).toBe(ATTR_CLASS.OBSERVATION_INCOMPLETE);
    expect(r.candidate).toBeNull();
    // 現セッションで観測を取れば bounded 判定へ進める
    recordObservation("h", { mountIntervalStatus: "ok", mountIntervalId: "iv1" });
    expect(classifyHostAttribution("h").classification).toBe(ATTR_CLASS.CONTINUITY_CANDIDATE);
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
