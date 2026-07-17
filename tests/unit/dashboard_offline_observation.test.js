/**
 * @fileoverview dashboard_offline_observation.js（#411-O1 観測 watermark）の単体テスト
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mockMonitorData = {
  machines: {}, hostSpoolMap: {}, hostObservationWatermark: {}, hostObservationCurrent: {},
  appSettings: { connectionTargets: [] },
  mountHistory: [{ evId: "keep" }], pendingUnattributedUsage: [{ pendingUsageId: "keep" }],
};
vi.mock("../../3dp_lib/dashboard_data.js", () => ({ monitorData: mockMonitorData }));

const { recordHostObservation, commitObservationBaseline, computeOfflineWindow, buildConfidence } =
  await import("../../3dp_lib/dashboard_offline_observation.js");

/** 完了ジョブ（finishTime＋filename で識別材料あり）。 */
function job(id, finishAt, extra = {}) {
  return { id, materialUsedMm: 5000, printfinish: 1, finishTime: finishAt, filename: `f${id}.gcode`, ...extra };
}
/** 識別材料の無い完了ジョブ（id のみ）。 */
function bareJob(id) {
  return { id, materialUsedMm: 5000, printfinish: 1 };
}
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
});

describe("record / commit / baseline 非上書き", () => {
  it("P0-3: 未装着は observationState=unmounted、read-only（安全基盤不変）", () => {
    setHistory("h", [job("1", 100)]);
    const snap = recordHostObservation("h", { mountIntervalStatus: "none" });
    expect(snap.observationState).toBe("unmounted");
    expect(snap.mountIntervalStatus).toBe("none");
    expect(mockMonitorData.mountHistory).toEqual([{ evId: "keep" }]);
    expect(mockMonitorData.pendingUnattributedUsage).toEqual([{ pendingUsageId: "keep" }]);
  });

  it("P0-1: restore された baseline を起動直後の record が上書きしない", () => {
    setHistory("h", [job("1000", 100), job("1001", 200)]);
    recordHostObservation("h");                       // bootstrap baseline = {1000,1001}
    commitObservationBaseline("h", { windowId: "w1" });
    const baseKeys = mockMonitorData.hostObservationWatermark.h.seenObservationKeys.slice();
    // 「再起動後」: オフライン完了が出現
    setHistory("h", [job("1000", 100), job("1001", 200), job("1002", 300), job("1003", 400)]);
    recordHostObservation("h");                       // current 更新・baseline 不変
    expect(mockMonitorData.hostObservationWatermark.h.seenObservationKeys).toEqual(baseKeys);
    const w = computeOfflineWindow("h");
    expect(w.bounded).toBe(true);
    expect(w.offlineJobKeys).toHaveLength(2);         // 1002,1003（複合キー）
    expect(w.offlineJobKeys.every(k => k.includes("100"))).toBe(true);
  });

  it("commit は windowId 冪等（同一 windowId で二重昇格しない）", () => {
    setHistory("h", [job("1000", 100)]);
    recordHostObservation("h");
    setHistory("h", [job("1000", 100), job("1001", 200)]);
    recordHostObservation("h");
    const first = commitObservationBaseline("h", { windowId: "w1" });
    const firstKeys = first.seenObservationKeys.slice();
    // current をさらに進めても、同一 windowId の再 commit は no-op
    setHistory("h", [job("1000", 100), job("1001", 200), job("1002", 300)]);
    recordHostObservation("h");
    const second = commitObservationBaseline("h", { windowId: "w1" });
    expect(second.seenObservationKeys).toEqual(firstKeys); // 昇格されない
  });

  it("P1-3: observationSequence は再起動で 1 へ戻らず継続採番", () => {
    // baseline に seq=7 が復元された状態を模す
    mockMonitorData.hostObservationWatermark = { h: { seenObservationKeys: [], observationSequence: 7, printerIdentity: "h||", generation: {} } };
    setHistory("h", [job("1", 100)]);
    const snap = recordHostObservation("h");
    expect(snap.observationSequence).toBe(8); // max(7,...)+1
  });
});

describe("computeOfflineWindow — 同一実行識別と世代反証", () => {
  function commitBaseline(host, entries, windowId = "w") {
    setHistory(host, entries);
    recordHostObservation(host);
    return commitObservationBaseline(host, { windowId });
  }

  it("P0-1: ID 再利用（同id・別完了時刻）を見失わず offline に出す/世代反証で bounded=false", () => {
    commitBaseline("h", [job("1", 100), job("2", 200), job("3", 300)]);
    // プリンタ再起動で id 1,2 が別の物理印刷（別 finishTime）として再利用され、履歴が置換される
    setHistory("h", [job("1", 500), job("2", 600), job("3", 300)]);
    const w = computeOfflineWindow("h");
    // 複合キーが変わるので新実行は offline に現れる（= 見失わない）
    expect(w.offlineJobKeys.length).toBeGreaterThan(0);
    // 旧複合キーの過半が消えるため世代交代として bounded=false（安全側）
    expect(w.bounded).toBe(false);
  });

  it("P0-2: latest completion の巻き戻りは history-time-rollback で bounded=false", () => {
    commitBaseline("h", [job("1000", 300)]);
    setHistory("h", [job("2000", 100)]); // 別世代・最新完了が過去へ
    const w = computeOfflineWindow("h");
    expect(w.bounded).toBe(false);
    expect(w.reason).toBe("history-time-rollback");
  });

  it("P0-1: 識別材料不足（id のみ）は job-identity-insufficient で bounded=false", () => {
    commitBaseline("h", [bareJob("1"), bareJob("2")]);
    setHistory("h", [bareJob("1"), bareJob("2"), bareJob("3")]);
    const w = computeOfflineWindow("h");
    expect(w.bounded).toBe(false);
    expect(w.reason).toBe("job-identity-insufficient");
  });

  it("正常系: 識別十分・世代連続なら diff-ok で bounded=true", () => {
    commitBaseline("h", [job("1000", 100), job("1001", 200)]);
    setHistory("h", [job("1000", 100), job("1001", 200), job("1002", 300)]);
    const w = computeOfflineWindow("h");
    expect(w.bounded).toBe(true);
    expect(w.reason).toBe("diff-ok");
    expect(w.offlineJobKeys).toHaveLength(1);
  });

  it("前回観測なしは bounded=false", () => {
    setHistory("h", [job("1", 100)]);
    expect(computeOfflineWindow("h").reason).toBe("no-prior-observation");
  });

  it("stalenessMs を返す（鮮度）", () => {
    mockMonitorData.hostObservationWatermark = { h: { seenObservationKeys: [], printerIdentity: "h||", persistedAt: 1, generation: {}, retainedObservationCount: 0 } };
    setHistory("h", [job("1", 100)]);
    const w = computeOfflineWindow("h");
    expect(typeof w.stalenessMs).toBe("number");
    expect(w.stalenessMs).toBeGreaterThan(0);
  });
});

describe("buildConfidence", () => {
  it("level と reasons を保持、不正 level は none", () => {
    expect(buildConfidence("high", ["seen-job"])).toEqual({ level: "high", reasons: ["seen-job"] });
    expect(buildConfidence("bogus")).toEqual({ level: "none", reasons: [] });
  });
});
