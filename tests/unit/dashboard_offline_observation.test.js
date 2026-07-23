/**
 * @fileoverview dashboard_offline_observation.js（#411-O1 観測レイヤ）の単体テスト
 * record / computeObservationWindow / commitObservationWindow の read-only 契約と
 * 5000件切詰め境界・候補単位の識別判定・fail-closed commit を検証する。
 *
 * @version 1.390.1246 (PR #411)
 * @since   2.3.0
 * @lastModified 2026-07-23 09:57:05
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mockMonitorData = {
  machines: {}, hostSpoolMap: {}, hostObservationWatermark: {}, hostObservationCurrent: {},
  appSettings: { connectionTargets: [] },
  mountHistory: [{ evId: "keep" }], pendingUnattributedUsage: [{ pendingUsageId: "keep" }],
};
vi.mock("../../3dp_lib/dashboard_data.js", () => ({ monitorData: mockMonitorData }));

const { recordObservation, commitObservationWindow, computeObservationWindow, computeOfflineWindow, observationDue, buildConfidence } =
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

  it("★codex-P1: truncated baseline＋完了時刻なしの差分を offline 確定しない（fail-closed）", () => {
    // Codex 指摘: 5000件切詰め後、完了時刻が無い/境界時刻が作れない古い履歴を offline 誤検出する。
    const key = (id) => JSON.stringify([id, 0, 0, `f${id}.gcode`]);
    const baselineKeys = []; for (let i = 1001; i <= 6000; i++) baselineKeys.push(key(String(i)));
    const currentKeys = []; for (let i = 1; i <= 6000; i++) currentKeys.push(key(String(i))); // 1..1000 は baseline に無い（切詰め済）
    const previous = {
      observationSequence: 1, observedAtEpochMs: BASE, persistedAt: BASE,
      seenObservationKeys: baselineKeys, retainedObservationCount: 5000, truncated: true,
      retainedRange: { firstCompletedAt: 0, truncated: true },
      generation: { latestCompletedAt: 0 }, printerIdentity: { model: "K1", completeness: "strong" },
      mountedSpoolId: "S1", observationState: "mounted", mountIntervalStatus: "ok"
    };
    const current = { ...previous, observationSequence: 2, seenObservationKeys: currentKeys };
    const w = computeOfflineWindow(previous, current); // sessionId 未指定=fresh
    expect(w.offlineObservationKeys).toEqual([]);      // 誤 offline を出さない
    expect(w.bounded).toBe(false);                     // 境界不確定は fail-closed
    expect(w.reason).toBe("history-truncated-unverifiable");
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

  it("★P1-A: 旧セッションの current（sequence一致でも）は baseline へ昇格しない", () => {
    const w = prep();
    // candidate 永続化後・baseline 昇格前にクラッシュ→旧 current を復元した状況を模す
    mockMonitorData.hostObservationCurrent.h = { ...mockMonitorData.hostObservationCurrent.h, appSessionId: "old-session" };
    const r = commitObservationWindow("h", { windowId: "wS", expectedSequence: w.currentSequence, candidatePersistedAt: 1 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("current_observation_stale");
  });

  it("★P1-A: expectedAppSessionId 不一致は昇格しない（transaction 境界）", () => {
    const w = prep();
    const r = commitObservationWindow("h", { windowId: "wT", expectedSequence: w.currentSequence, candidatePersistedAt: 1, expectedAppSessionId: "some-other" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("app_session_changed_since_evaluation");
  });
});

describe("computeObservationWindow — 観測事実の投影（O2-P0 用・解釈しない）", () => {
  it("baselineMount / currentMount / hasCurrentObservation / windowKind を返す", () => {
    mockMonitorData.hostSpoolMap.h = "S1";
    setHistory("h", [job("1000", 100)]);
    recordObservation("h", { mountIntervalStatus: "ok", mountIntervalId: "iv1" });
    const w0 = computeObservationWindow("h");
    commitObservationWindow("h", { windowId: w0.windowId, expectedSequence: w0.currentSequence, candidatePersistedAt: 1 });
    setHistory("h", [job("1000", 100), job("1001", 200)]);
    recordObservation("h", { mountIntervalStatus: "ok", mountIntervalId: "iv1" });
    const w = computeObservationWindow("h");
    expect(w.hasCurrentObservation).toBe(true);
    expect(w.windowKind).toBe("bounded");
    expect(w.baselineMount).toMatchObject({ spoolId: "S1", intervalId: "iv1", intervalStatus: "ok", observationState: "mounted" });
    expect(w.currentMount).toMatchObject({ spoolId: "S1", observationState: "mounted" });
  });

  it("baseline はあるが current 未観測なら hasCurrentObservation=false / windowKind=incomplete", () => {
    mockMonitorData.hostObservationWatermark = { h: {
      seenObservationKeys: [], observationSequence: 3, printerIdentity: "h||", generation: {},
      retainedRange: {}, mountedSpoolId: "S1", observationState: "mounted", persistedAt: 1
    } };
    // hostObservationCurrent.h は未設定
    setHistory("h", [job("1", 100)]);
    const w = computeObservationWindow("h");
    expect(w.hasCurrentObservation).toBe(false);
    expect(w.windowKind).toBe("incomplete");
    expect(w.baselineMount.spoolId).toBe("S1");
  });

  it("current が別スプールでも観測事実として反映する（分類はしない）", () => {
    mockMonitorData.hostSpoolMap.h = "S1";
    setHistory("h", [job("1000", 100)]);
    recordObservation("h", { mountIntervalStatus: "ok", mountIntervalId: "iv1" });
    const w0 = computeObservationWindow("h");
    commitObservationWindow("h", { windowId: w0.windowId, expectedSequence: w0.currentSequence, candidatePersistedAt: 1 });
    mockMonitorData.hostSpoolMap.h = "S2"; // 復帰後に別スプール
    setHistory("h", [job("1000", 100), job("1001", 200)]);
    recordObservation("h", { mountIntervalStatus: "ok", mountIntervalId: "iv9" });
    const w = computeObservationWindow("h");
    expect(w.baselineMount.spoolId).toBe("S1");
    expect(w.currentMount.spoolId).toBe("S2");
  });
});

describe("computeOfflineWindow（P1-4 完全な純関数・2スナップショットのみ）", () => {
  const BASE = 1_700_000_000_000;
  const snap = (over = {}) => ({
    observationSequence: 1, observedAtEpochMs: BASE, persistedAt: BASE,
    mountedSpoolId: "S1", mountIntervalId: "iv1", mountIntervalStatus: "ok", observationState: "mounted",
    printerIdentity: { host: "h", printerType: "k1", model: "K1 Max", completeness: "strong" },
    generation: { completedCount: 1, earliestCompletedAt: BASE, latestCompletedAt: BASE, retainedHash: "x" },
    seenObservationKeys: [JSON.stringify(["1000", 0, BASE, "f.gcode"])],
    retainedRange: { firstCompletedAt: BASE, lastCompletedAt: BASE, truncated: false },
    retainedObservationCount: 1, totalCompletedCount: 1, truncated: false,
    ...over
  });

  it("グローバル状態を読まず、引数のみで決定論的に窓を返す", () => {
    const prev = snap();
    const curKeys = prev.seenObservationKeys.concat([JSON.stringify(["1001", 0, BASE + 1000, "g.gcode"])]);
    const cur = snap({ observationSequence: 2, observedAtEpochMs: BASE + 5000, persistedAt: null,
      seenObservationKeys: curKeys,
      generation: { completedCount: 2, earliestCompletedAt: BASE, latestCompletedAt: BASE + 1000, retainedHash: "y" } });
    const w = computeOfflineWindow(prev, cur, "h");
    expect(w.bounded).toBe(true);
    expect(w.offlineObservationKeys).toHaveLength(1);
    expect(w.windowKind).toBe("bounded");
    expect(w.stalenessMs).toBe(5000); // curAt - baseAt（wall clock 非依存）
  });

  it("previous なし＝no-prior / current なし＝incomplete", () => {
    expect(computeOfflineWindow(null, snap()).windowKind).toBe("no-prior");
    expect(computeOfflineWindow(snap(), null).windowKind).toBe("incomplete");
  });
});

describe("printerIdentity（P1-1 構造化・weak→strong は交換扱いしない）", () => {
  it("weak→strong の情報補完は identityChanged にしない（同一機で model が後着）", () => {
    mockMonitorData.hostSpoolMap.h = "S1";
    setHistory("h", [job("1000", 100)]);
    // baseline は model 未取得（weak）で確定
    mockMonitorData.machines.h.storedData = {};
    recordObservation("h", { mountIntervalStatus: "ok", mountIntervalId: "iv1" });
    const w0 = computeObservationWindow("h");
    commitObservationWindow("h", { windowId: w0.windowId, expectedSequence: w0.currentSequence, candidatePersistedAt: 1 });
    // 復帰後: model が届いた（strong）＋ offline 完了
    mockMonitorData.machines.h.storedData = { model: { rawValue: "K1 Max" } };
    setHistory("h", [job("1000", 100), job("1001", 200)]);
    recordObservation("h", { mountIntervalStatus: "ok", mountIntervalId: "iv1" });
    const w = computeObservationWindow("h");
    expect(w.identityChanged).toBe(false);         // 補完であって交換ではない
    expect(w.reason).toBe("diff-ok");
  });

  it("strong 同士で model 不一致＝プリンタ交換は identityChanged", () => {
    mockMonitorData.hostSpoolMap.h = "S1";
    mockMonitorData.machines.h = { printStore: { history: [job("1000", 100)] }, storedData: { model: { rawValue: "K1 Max" } } };
    recordObservation("h", { mountIntervalStatus: "ok", mountIntervalId: "iv1" });
    const w0 = computeObservationWindow("h");
    commitObservationWindow("h", { windowId: w0.windowId, expectedSequence: w0.currentSequence, candidatePersistedAt: 1 });
    mockMonitorData.machines.h.storedData = { model: { rawValue: "Ender 3" } }; // 別機種へ本体交換
    setHistory("h", [job("1000", 100), job("2001", 300)]);
    recordObservation("h", { mountIntervalStatus: "ok", mountIntervalId: "iv1" });
    const w = computeObservationWindow("h");
    expect(w.identityChanged).toBe(true);
    expect(w.bounded).toBe(false);
  });
});

describe("observationDue（P0-1 signature 判定・純関数）", () => {
  const facts = (over = {}) => ({ historyRevision: 5, activeJobId: "1000", printState: 13, mountedSpoolId: "S1", mountIntervalStatus: "ok", mountIntervalId: "iv1", ...over });

  it("初回（prev なし）は必ず記録", () => {
    expect(observationDue(null, facts(), { nowMs: 1000 }).record).toBe(true);
  });
  it("★ _historyRev だけ変化したら 5s 未満でも即記録", () => {
    const { signature } = observationDue(null, facts(), { nowMs: 1000 });
    const due = observationDue({ lastAtMs: 1000, signature }, facts({ historyRevision: 6 }), { nowMs: 1200 });
    expect(due.record).toBe(true);
  });
  it("★ 同一 spool・status=ok のまま intervalId だけ変化したら 5s 未満でも即記録", () => {
    const { signature } = observationDue(null, facts(), { nowMs: 1000 });
    const due = observationDue({ lastAtMs: 1000, signature }, facts({ mountIntervalId: "iv2" }), { nowMs: 1200 });
    expect(due.record).toBe(true);
  });
  it("signature 不変かつ 5s 未満なら記録しない", () => {
    const { signature } = observationDue(null, facts(), { nowMs: 1000 });
    expect(observationDue({ lastAtMs: 1000, signature }, facts(), { nowMs: 1200 }).record).toBe(false);
  });
  it("signature 不変でも 5s 超過（heartbeat）なら記録", () => {
    const { signature } = observationDue(null, facts(), { nowMs: 1000 });
    expect(observationDue({ lastAtMs: 1000, signature }, facts(), { nowMs: 7000 }).record).toBe(true);
  });
});

describe("P0-4 / P1-B 連続印刷証拠の記録", () => {
  it("activeJobId / printState / historyRevision を観測へ保存", () => {
    mockMonitorData.hostSpoolMap.h = "S1";
    mockMonitorData.machines.h = { printStore: { history: [job("1000", 100)], current: { id: "1000" }, _historyRev: 7 }, storedData: {} };
    const snap = recordObservation("h", { mountIntervalStatus: "ok", activeJobId: "1000", printState: 13 });
    expect(snap.activeJobId).toBe("1000");
    expect(snap.printState).toBe(13);
    expect(snap.historyRevision).toBe(7);
  });

  it("★P1-B: activePrinting のときだけ activeJobObservation（複合 identity）を保存", () => {
    mockMonitorData.hostSpoolMap.h = "S1";
    const current = { id: "1000", printStartTime: BASE, filename: "a.gcode" };
    mockMonitorData.machines.h = { printStore: { history: [job("1000", 100)], current, _historyRev: 3 }, storedData: {} };
    // 印刷中
    const printing = recordObservation("h", { mountIntervalStatus: "ok", activePrinting: true });
    expect(printing.activeJobObservation).toMatchObject({ canonicalJobId: "1000", startAt: BASE, fileSignature: "a.gcode" });
    // idle（activePrinting=false）は null＝high の根拠にしない
    const idle = recordObservation("h", { mountIntervalStatus: "ok", activePrinting: false });
    expect(idle.activeJobObservation).toBeNull();
  });
});

describe("buildConfidence", () => {
  it("level / reasons / contradictions を保持、不正 level は none", () => {
    expect(buildConfidence("high", ["seen-job"])).toEqual({ level: "high", reasons: ["seen-job"], contradictions: [] });
    expect(buildConfidence("none", ["r"], ["c"])).toEqual({ level: "none", reasons: ["r"], contradictions: ["c"] });
    expect(buildConfidence("bogus")).toEqual({ level: "none", reasons: [], contradictions: [] });
  });
});
