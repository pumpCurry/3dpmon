/**
 * @fileoverview dashboard_offline_observation.js（#411-O1 観測 watermark）の単体テスト
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mockMonitorData = {
  machines: {},
  hostSpoolMap: {},
  hostObservationWatermark: {},
  hostObservationCurrent: {},
  appSettings: { connectionTargets: [] },
  // 安全基盤（read-only 確認用）
  mountHistory: [{ evId: "keep" }],
  pendingUnattributedUsage: [{ pendingUsageId: "keep" }],
};
vi.mock("../../3dp_lib/dashboard_data.js", () => ({ monitorData: mockMonitorData }));

const { recordHostObservation, commitObservationBaseline, computeOfflineWindow, buildConfidence } =
  await import("../../3dp_lib/dashboard_offline_observation.js");

/** 完了ジョブ（id は文字列 canonical key を想定） */
function job(id, extra = {}) {
  return { id, materialUsedMm: 5000, printfinish: 1, ...extra };
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

describe("recordHostObservation（current 更新・baseline 非上書き）", () => {
  it("完了ジョブ key 集合・装着スプール・observationState を current へ記録", () => {
    setHistory("h", [job("1000"), job("1001"), { id: "1002", materialUsedMm: 3000, printfinish: null }]);
    mockMonitorData.hostSpoolMap = { h: "S" };
    const snap = recordHostObservation("h", { mountIntervalId: "iv1", mountIntervalStatus: "ok" });
    expect(snap.seenCompletedJobKeys).toEqual(["1000", "1001"]); // 印刷中(1002)除外
    expect(snap.mountedSpoolId).toBe("S");
    expect(snap.observationState).toBe("mounted");
    expect(snap.mountIntervalId).toBe("iv1");       // #411-P0-4 配線
    expect(snap.mountIntervalStatus).toBe("ok");
    expect(mockMonitorData.hostObservationCurrent.h.seenCompletedJobKeys).toEqual(["1000", "1001"]);
    // baseline 未設定だったので bootstrap される（新規導入＝offline無し）
    expect(mockMonitorData.hostObservationWatermark.h.committedReason).toBe("bootstrap");
  });

  it("P0-3: スプール未装着でも記録し observationState=unmounted", () => {
    setHistory("h", [job("1")]);
    mockMonitorData.hostSpoolMap = {}; // 未装着
    const snap = recordHostObservation("h");
    expect(snap.observationState).toBe("unmounted");
    expect(snap.mountedSpoolId).toBeNull();
  });

  it("P0-1: restore された baseline を起動直後の record が上書きしない", () => {
    // 停止前 baseline（restore 済み）。printerIdentity は _identity('h')="h||" に一致させる。
    mockMonitorData.hostObservationWatermark = {
      h: { seenCompletedJobKeys: ["1000", "1001"], printerIdentity: "h||", historyCount: 2, mountedSpoolId: "S" }
    };
    // 再起動後: オフライン完了 1002,1003 が履歴へ出現
    setHistory("h", [job("1000"), job("1001"), job("1002"), job("1003")]);
    mockMonitorData.hostSpoolMap = { h: "S" };
    recordHostObservation("h");
    // ★ baseline は不変（seen={1000,1001} のまま＝証拠を消さない）
    expect(mockMonitorData.hostObservationWatermark.h.seenCompletedJobKeys).toEqual(["1000", "1001"]);
    // current は現在集合
    expect(mockMonitorData.hostObservationCurrent.h.seenCompletedJobKeys).toEqual(["1000", "1001", "1002", "1003"]);
    // オフライン窓 = 1002,1003
    const w = computeOfflineWindow("h");
    expect(w.bounded).toBe(true);
    expect(w.offlineJobKeys).toEqual(["1002", "1003"]);
  });

  it("commitObservationBaseline は評価後に current を baseline へ昇格", () => {
    mockMonitorData.hostObservationWatermark = { h: { seenCompletedJobKeys: ["1000"], printerIdentity: "h||", historyCount: 1 } };
    setHistory("h", [job("1000"), job("1001")]);
    recordHostObservation("h"); // current={1000,1001}, baseline 不変
    commitObservationBaseline("h", { reason: "window-evaluated" });
    expect(mockMonitorData.hostObservationWatermark.h.seenCompletedJobKeys).toEqual(["1000", "1001"]);
    expect(mockMonitorData.hostObservationWatermark.h.committedReason).toBe("window-evaluated");
    expect(typeof mockMonitorData.hostObservationWatermark.h.persistedAt).toBe("number");
  });

  it("安全基盤（mountHistory / pendingUnattributedUsage）に一切触れない（read-only）", () => {
    setHistory("h", [job("1000")]);
    recordHostObservation("h");
    commitObservationBaseline("h");
    expect(mockMonitorData.mountHistory).toEqual([{ evId: "keep" }]);
    expect(mockMonitorData.pendingUnattributedUsage).toEqual([{ pendingUsageId: "keep" }]);
  });
});

describe("computeOfflineWindow（集合差分＋世代反証）", () => {
  function baseline(host, keys, extra = {}) {
    mockMonitorData.hostObservationWatermark[host] = {
      seenCompletedJobKeys: keys, printerIdentity: "h||", historyCount: keys.length, ...extra
    };
  }

  it("集合差分でオフライン新規ジョブを特定", () => {
    baseline("h", ["1000", "1001"]);
    setHistory("h", [job("1000"), job("1001"), job("1002")]);
    const w = computeOfflineWindow("h");
    expect(w.bounded).toBe(true);
    expect(w.offlineJobKeys).toEqual(["1002"]);
    expect(w.reason).toBe("diff-ok");
  });

  it("前回観測なしは bounded=false", () => {
    setHistory("h", [job("1000")]);
    const w = computeOfflineWindow("h");
    expect(w.bounded).toBe(false);
    expect(w.reason).toBe("no-prior-observation");
  });

  it("P0-2: printer identity 変化は bounded=false", () => {
    baseline("h", ["1000"], { printerIdentity: "h||OLD" });
    setHistory("h", [job("1000"), job("1001")]);
    const w = computeOfflineWindow("h");
    expect(w.identityChanged).toBe(true);
    expect(w.bounded).toBe(false);
    expect(w.reason).toBe("printer-identity-changed");
  });

  it("P0-2: 履歴 generation 交代（seen の過半が消失）は bounded=false", () => {
    // 停止前 seen={1000,1001,1002,1003}、現在は別世代（IDが再利用され過半が消失）
    baseline("h", ["1000", "1001", "1002", "1003"], { historyCount: 4 });
    setHistory("h", [job("1"), job("2")]); // 現在は別ID・件数も縮小
    const w = computeOfflineWindow("h");
    expect(w.generationChanged).toBe(true);
    expect(w.bounded).toBe(false);
    // reason は history-generation-changed か history-shrunk（どちらも世代交代）
    expect(["history-generation-changed", "history-shrunk"]).toContain(w.reason);
  });

  it("P1-1/P1-2: 重複IDや無効ID('0'/空)を除いた canonical string 集合で差分", () => {
    baseline("h", ["1000"]);
    setHistory("h", [job("1000"), job("1000"), job("2000"), job("0"), job("")]);
    const w = computeOfflineWindow("h");
    expect(w.offlineJobKeys).toEqual(["2000"]); // 重複1000は1つ、0/空は除外
  });

  it("stalenessMs を返す（鮮度＝confidence 判断材料）", () => {
    baseline("h", ["1000"], { persistedAt: 1 });
    setHistory("h", [job("1000")]);
    const w = computeOfflineWindow("h");
    expect(typeof w.stalenessMs).toBe("number");
    expect(w.stalenessMs).toBeGreaterThan(0);
  });
});

describe("buildConfidence（reasons 付き schema）", () => {
  it("level と reasons を保持する", () => {
    const c = buildConfidence("high", ["seen-job", "continuous-print"]);
    expect(c.level).toBe("high");
    expect(c.reasons).toEqual(["seen-job", "continuous-print"]);
  });
  it("不正 level は none、reasons 既定は空", () => {
    expect(buildConfidence("bogus")).toEqual({ level: "none", reasons: [] });
  });
});
