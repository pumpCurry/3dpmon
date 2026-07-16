/**
 * @fileoverview dashboard_offline_observation.js（#411-O1 観測 watermark）の単体テスト
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mockMonitorData = {
  machines: {},
  hostSpoolMap: {},
  hostObservationWatermark: {},
  appSettings: { connectionTargets: [] },
  // 安全基盤（read-only であることの確認用に置く）
  mountHistory: [{ evId: "keep" }],
  pendingUnattributedUsage: [{ pendingUsageId: "keep" }],
};
vi.mock("../../3dp_lib/dashboard_data.js", () => ({ monitorData: mockMonitorData }));

const { recordHostObservation, computeOfflineWindow, buildConfidence } =
  await import("../../3dp_lib/dashboard_offline_observation.js");

/** 完了ジョブ（printfinish あり）を作る */
function job(id, extra = {}) {
  return { id, materialUsedMm: 5000, printfinish: 1, ...extra };
}
function setHistory(host, entries) {
  mockMonitorData.machines[host] = { printStore: { history: entries }, storedData: {} };
}

beforeEach(() => {
  mockMonitorData.machines = {};
  mockMonitorData.hostSpoolMap = {};
  mockMonitorData.hostObservationWatermark = {};
  mockMonitorData.appSettings = { connectionTargets: [] };
  mockMonitorData.mountHistory = [{ evId: "keep" }];
  mockMonitorData.pendingUnattributedUsage = [{ pendingUsageId: "keep" }];
});

describe("recordHostObservation（read-only 観測）", () => {
  it("完了ジョブの printId 集合・装着スプールを記録する（未完了は除外）", () => {
    setHistory("h", [job(1000), job(1001), { id: 1002, materialUsedMm: 3000, printfinish: null }]);
    mockMonitorData.hostSpoolMap = { h: "S" };
    const wm = recordHostObservation("h");
    expect(wm.seenCompletedJobIds).toEqual([1000, 1001]); // 印刷中(1002)は除外
    expect(wm.mountedSpoolId).toBe("S");
    expect(wm.historyCount).toBe(2);
    expect(typeof wm.printerIdentity).toBe("string");
    // 保存先に入る
    expect(mockMonitorData.hostObservationWatermark.h.seenCompletedJobIds).toEqual([1000, 1001]);
  });

  it("旧データ(printfinish欠落だが endtime/usagetime あり)も完了として記録", () => {
    setHistory("h", [job(1, { printfinish: undefined, endtime: 123 }), job(2, { printfinish: undefined, usagetime: 60 })]);
    const wm = recordHostObservation("h");
    expect(wm.seenCompletedJobIds).toEqual([1, 2]);
  });

  it("安全基盤（mountHistory / pendingUnattributedUsage）に一切触れない（read-only）", () => {
    setHistory("h", [job(1000)]);
    recordHostObservation("h");
    expect(mockMonitorData.mountHistory).toEqual([{ evId: "keep" }]);
    expect(mockMonitorData.pendingUnattributedUsage).toEqual([{ pendingUsageId: "keep" }]);
  });

  it("host 未指定は null", () => {
    expect(recordHostObservation()).toBeNull();
  });
});

describe("computeOfflineWindow（集合差分）", () => {
  it("前回観測後に新たに現れた完了ジョブを集合差分で特定", () => {
    setHistory("h", [job(1000), job(1001)]);
    recordHostObservation("h"); // 観測: {1000,1001}
    // アプリ停止中に 1002,1003 が完了して履歴に現れる
    setHistory("h", [job(1000), job(1001), job(1002), job(1003)]);
    const w = computeOfflineWindow("h");
    expect(w.bounded).toBe(true);
    expect(w.offlineJobIds).toEqual([1002, 1003]);
    expect(w.reason).toBe("diff-ok");
  });

  it("ID 巻き戻り（小さい id 出現）でも last-seen 比較でなく集合差分で拾う", () => {
    setHistory("h", [job(1000), job(1001)]);
    recordHostObservation("h");
    // プリンタ再起動等で小さい id の完了が現れる
    setHistory("h", [job(5), job(1000), job(1001)]);
    const w = computeOfflineWindow("h");
    expect(w.offlineJobIds).toEqual([5]); // id>lastSeen だと拾えないが集合差分なら拾う
  });

  it("前回観測が無ければ bounded=false（初回導入/移行）", () => {
    setHistory("h", [job(1000)]);
    const w = computeOfflineWindow("h");
    expect(w.bounded).toBe(false);
    expect(w.reason).toBe("no-prior-observation");
  });

  it("printer identity 変化は bounded=false（同じ窓と断定しない）", () => {
    setHistory("h", [job(1000)]);
    mockMonitorData.machines.h.storedData = { model: { rawValue: "A" } };
    recordHostObservation("h");
    // identity を変える（モデル変更＝別プリンタ/再セットアップ相当）
    mockMonitorData.machines.h.storedData = { model: { rawValue: "B" } };
    mockMonitorData.machines.h.printStore = { history: [job(1000), job(1001)] };
    const w = computeOfflineWindow("h");
    expect(w.identityChanged).toBe(true);
    expect(w.bounded).toBe(false);
    expect(w.reason).toBe("printer-identity-changed");
  });
});

describe("buildConfidence（reasons 付き schema）", () => {
  it("level と reasons を保持する", () => {
    const c = buildConfidence("high", ["seen-job", "continuous-print", "no-spool-change"]);
    expect(c.level).toBe("high");
    expect(c.reasons).toEqual(["seen-job", "continuous-print", "no-spool-change"]);
  });
  it("不正 level は none、reasons 既定は空", () => {
    expect(buildConfidence("bogus")).toEqual({ level: "none", reasons: [] });
  });
});
