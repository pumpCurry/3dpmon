/**
 * @fileoverview dashboard_offline_observation.js（#411-O1 観測レイヤ）の単体テスト
 * record / computeObservationWindow / commitObservationWindow の read-only 契約と
 * 5000件切詰め境界・候補単位の識別判定・fail-closed commit を検証する。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mockMonitorData = {
  machines: {}, hostSpoolMap: {}, hostObservationWatermark: {}, hostObservationCurrent: {},
  appSettings: { connectionTargets: [] },
  mountHistory: [{ evId: "keep" }], pendingUnattributedUsage: [{ pendingUsageId: "keep" }],
};
vi.mock("../../3dp_lib/dashboard_data.js", () => ({ monitorData: mockMonitorData }));

const { recordObservation, commitObservationWindow, computeObservationWindow, buildConfidence } =
  await import("../../3dp_lib/dashboard_offline_observation.js");

const BASE = 1_700_000_000_000; // epoch ms 基準（_epochMs が ms として扱える範囲）
/** 完了ジョブ（finishTime＋filename で識別材料あり）。t は基準からの相対秒。 */
function job(id, t, extra = {}) {
  return { id, materialUsedMm: 5000, printfinish: 1, finishTime: BASE + t * 1000, filename: `f${id}.gcode`, ...extra };
}
/** 識別材料の無い完了ジョブ（id のみ・時刻/ファイルなし）。 */
function bareJob(id) {
  return { id, materialUsedMm: 5000, printfinish: 1 };
}
function setHistory(host, entries) {
  if (!mockMonitorData.machines[host]) mockMonitorData.machines[host] = { printStore: {}, storedData: {} };
  mockMonitorData.machines[host].printStore = { history: entries };
}
/** record→compute→commit の一連（baseline 昇格）を実行して window を返す。 */
function commitBaseline(host, entries, tag) {
  setHistory(host, entries);
  recordObservation(host);
  const w = computeObservationWindow(host);
  const wid = tag || w.windowId;
  commitObservationWindow(host, { windowId: wid, expectedSequence: w.currentSequence, candidatePersistedAt: 1 });
  return w;
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
  it("read-only: 未装着は observationState=unmounted、安全基盤は不変", () => {
    setHistory("h", [job("1", 100)]);
    const snap = recordObservation("h", { mountIntervalStatus: "none" });
    expect(snap.observationState).toBe("unmounted");
    expect(snap.mountIntervalStatus).toBe("none");
    expect(mockMonitorData.mountHistory).toEqual([{ evId: "keep" }]);
    expect(mockMonitorData.pendingUnattributedUsage).toEqual([{ pendingUsageId: "keep" }]);
  });

  it("起動直後の record は復元済み baseline を上書きしない（current のみ更新）", () => {
    commitBaseline("h", [job("1000", 100), job("1001", 200)]);
    const baseKeys = mockMonitorData.hostObservationWatermark.h.seenObservationKeys.slice();
    // 「再起動後」: オフライン完了が出現
    setHistory("h", [job("1000", 100), job("1001", 200), job("1002", 300), job("1003", 400)]);
    recordObservation("h"); // current 更新・baseline 不変
    expect(mockMonitorData.hostObservationWatermark.h.seenObservationKeys).toEqual(baseKeys);
    const w = computeObservationWindow("h");
    expect(w.bounded).toBe(true);
    expect(w.offlineObservationKeys).toHaveLength(2); // 1002,1003
    expect(w.reason).toBe("diff-ok");
  });

  it("observationSequence は再起動で 1 へ戻らず継続採番", () => {
    mockMonitorData.hostObservationWatermark = { h: { seenObservationKeys: [], observationSequence: 7, printerIdentity: "h||", generation: {} } };
    setHistory("h", [job("1", 100)]);
    const snap = recordObservation("h");
    expect(snap.observationSequence).toBe(8); // max(7,0)+1
  });
});

describe("computeObservationWindow — 5000件切詰め境界（P0-1・実運用の主要被害）", () => {
  function bulk(n, offset = 0) {
    const arr = [];
    for (let i = 1; i <= n; i++) arr.push(job(String(offset + i), i));
    return arr;
  }

  it("6000件履歴・追加なし → offline は空（捨てた古い5000件超を false offline にしない）", () => {
    const hist = bulk(6000);
    commitBaseline("h", hist);
    setHistory("h", hist); // 同一履歴を再観測
    recordObservation("h");
    const w = computeObservationWindow("h");
    expect(w.truncated).toBe(true);
    expect(w.offlineObservationKeys).toEqual([]);
    expect(w.bounded).toBe(true);
  });

  it("6000件履歴＋新規2件 → offline は新規2件のみ（切詰めた古い分は混入しない）", () => {
    const hist = bulk(6000);
    commitBaseline("h", hist);
    const grown = hist.concat([job("6001", 6001), job("6002", 6002)]);
    setHistory("h", grown);
    recordObservation("h");
    const w = computeObservationWindow("h");
    expect(w.offlineObservationKeys).toHaveLength(2);
    expect(w.bounded).toBe(true);
    expect(w.reason).toBe("diff-ok");
  });
});

describe("computeObservationWindow — 同一実行識別と世代反証", () => {
  it("ID 再利用（同id・別完了時刻・別ファイル）は見失わず offline に出る／世代反証で bounded=false", () => {
    commitBaseline("h", [job("1", 100), job("2", 200), job("3", 300)]);
    // 再起動で id 1,2 が別物理印刷（別 finishTime/別 file）として再利用され履歴置換
    setHistory("h", [job("1", 500, { filename: "x.gcode" }), job("2", 600, { filename: "y.gcode" }), job("3", 300)]);
    recordObservation("h");
    const w = computeObservationWindow("h");
    expect(w.offlineObservationKeys.length).toBeGreaterThan(0); // 見失わない
    expect(w.bounded).toBe(false);                              // 過半消失＝世代交代
  });

  it("latest completion の巻き戻りは history-time-rollback で bounded=false", () => {
    commitBaseline("h", [job("1000", 300)]);
    setHistory("h", [job("2000", 100)]); // 別世代・最新完了が過去へ
    recordObservation("h");
    const w = computeObservationWindow("h");
    expect(w.bounded).toBe(false);
    expect(w.reason).toBe("history-time-rollback");
  });

  it("識別材料不足（id のみ・新規）は job-identity-insufficient で bounded=false、unresolvedJobIds に載る", () => {
    commitBaseline("h", [bareJob("1"), bareJob("2")]);
    setHistory("h", [bareJob("1"), bareJob("2"), bareJob("3")]);
    recordObservation("h");
    const w = computeObservationWindow("h");
    expect(w.bounded).toBe(false);
    expect(w.reason).toBe("job-identity-insufficient");
    expect(w.unresolvedJobIds).toContain("3");
  });

  it("正常系: 識別十分・世代連続なら diff-ok で bounded=true", () => {
    commitBaseline("h", [job("1000", 100), job("1001", 200)]);
    setHistory("h", [job("1000", 100), job("1001", 200), job("1002", 300)]);
    recordObservation("h");
    const w = computeObservationWindow("h");
    expect(w.bounded).toBe(true);
    expect(w.reason).toBe("diff-ok");
    expect(w.offlineObservationKeys).toHaveLength(1);
  });

  it("前回観測なしは bounded=false / no-prior-observation", () => {
    setHistory("h", [job("1", 100)]);
    // record せず watermark も無い
    expect(computeObservationWindow("h").reason).toBe("no-prior-observation");
  });

  it("stalenessMs を返す（鮮度）", () => {
    mockMonitorData.hostObservationWatermark = { h: { seenObservationKeys: [], printerIdentity: "h||", persistedAt: 1, generation: {}, retainedObservationCount: 0, retainedRange: {} } };
    setHistory("h", [job("1", 100)]);
    recordObservation("h");
    const w = computeObservationWindow("h");
    expect(typeof w.stalenessMs).toBe("number");
    expect(w.stalenessMs).toBeGreaterThan(0);
  });
});

describe("commitObservationWindow — fail-closed transaction（P0-3）", () => {
  function prep(host = "h") {
    setHistory(host, [job("1000", 100)]);
    recordObservation(host);
    return computeObservationWindow(host);
  }

  it("windowId 空は window_id_required で拒否", () => {
    const w = prep();
    expect(commitObservationWindow("h", { windowId: "", expectedSequence: w.currentSequence, candidatePersistedAt: 1 }).reason).toBe("window_id_required");
  });

  it("candidatePersistedAt 無しは candidate_not_persisted で拒否", () => {
    const w = prep();
    expect(commitObservationWindow("h", { windowId: w.windowId, expectedSequence: w.currentSequence }).reason).toBe("candidate_not_persisted");
  });

  it("評価後に current が変わったら observation_changed_since_evaluation で前進しない", () => {
    const w = prep();
    // 評価後に新しい観測が来る（sequence 進行）
    setHistory("h", [job("1000", 100), job("1001", 200)]);
    recordObservation("h");
    const r = commitObservationWindow("h", { windowId: w.windowId, expectedSequence: w.currentSequence, candidatePersistedAt: 1 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("observation_changed_since_evaluation");
  });

  it("同一 windowId の再 commit は冪等 no-op（二重昇格しない）", () => {
    const w = prep();
    const first = commitObservationWindow("h", { windowId: "wX", expectedSequence: w.currentSequence, candidatePersistedAt: 1 });
    expect(first.ok).toBe(true);
    const firstKeys = first.baseline.seenObservationKeys.slice();
    // current を進めても同一 windowId は no-op
    setHistory("h", [job("1000", 100), job("1001", 200), job("1002", 300)]);
    recordObservation("h");
    const second = commitObservationWindow("h", { windowId: "wX", expectedSequence: 999, candidatePersistedAt: 1 });
    expect(second.idempotent).toBe(true);
    expect(second.baseline.seenObservationKeys).toEqual(firstKeys);
  });

  it("windowA→windowB 昇格後に windowA を再 commit すると reject（観測が進んでいる）", () => {
    // A 昇格
    const wa = prep();
    commitObservationWindow("h", { windowId: "wA", expectedSequence: wa.currentSequence, candidatePersistedAt: 1 });
    // 観測進行 → B 昇格
    setHistory("h", [job("1000", 100), job("1001", 200)]);
    recordObservation("h");
    const wb = computeObservationWindow("h");
    commitObservationWindow("h", { windowId: "wB", expectedSequence: wb.currentSequence, candidatePersistedAt: 1 });
    // 旧 A を再 commit（sequence は A 評価時のまま古い）→ reject
    const r = commitObservationWindow("h", { windowId: "wA-stale", expectedSequence: wa.currentSequence, candidatePersistedAt: 1 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("observation_changed_since_evaluation");
  });
});

describe("buildConfidence", () => {
  it("level と reasons を保持、不正 level は none", () => {
    expect(buildConfidence("high", ["seen-job"])).toEqual({ level: "high", reasons: ["seen-job"] });
    expect(buildConfidence("bogus")).toEqual({ level: "none", reasons: [] });
  });
});
