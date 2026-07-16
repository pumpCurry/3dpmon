/**
 * @fileoverview dashboard_attribution_notify.js（帰属未確認 重複抑制通知 Phase5 U3）の単体テスト
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// 課題ID集合はテストごとに差し替える
let _issueIds = new Set();
vi.mock("../../3dp_lib/dashboard_spool.js", () => ({
  getAttributionIssueIdsForHost: vi.fn(() => new Set(_issueIds)),
  countAttributionIssuesForHost: vi.fn(() => _issueIds.size),
}));
vi.mock("../../3dp_lib/dashboard_data.js", () => ({
  getHostDisplayName: vi.fn((h) => h),
}));
const showAlert = vi.fn();
vi.mock("../../3dp_lib/dashboard_notification_manager.js", () => ({
  showAlert: (...a) => showAlert(...a),
}));

const {
  evaluateAttributionNotice,
  scheduleAttributionNotice,
  resetAttributionNoticeState,
} = await import("../../3dp_lib/dashboard_attribution_notify.js");

function setIssues(ids) { _issueIds = new Set(ids); }

describe("evaluateAttributionNotice（集合差分の判定）", () => {
  beforeEach(() => { resetAttributionNoticeState(); setIssues([]); });

  it("初回に課題があれば startup 種別で1回集約通知", () => {
    setIssues(["pending:h:1", "quarantine:h:q1"]);
    const n = evaluateAttributionNotice("h");
    expect(n).toMatchObject({ host: "h", kind: "startup", total: 2 });
    expect(new Set(n.newIds)).toEqual(new Set(["pending:h:1", "quarantine:h:q1"]));
  });

  it("初回0件なら通知なし（null）", () => {
    setIssues([]);
    expect(evaluateAttributionNotice("h")).toBeNull();
  });

  it("初回で観測済みにした課題は2回目に再通知しない（dedup）", () => {
    setIssues(["pending:h:1"]);
    expect(evaluateAttributionNotice("h").kind).toBe("startup");
    // 同じ集合 → null
    expect(evaluateAttributionNotice("h")).toBeNull();
  });

  it("初回後に新規IDが増えたら new 種別で新規のみ検出", () => {
    setIssues(["pending:h:1"]);
    evaluateAttributionNotice("h"); // startup で {1} を観測済みに
    setIssues(["pending:h:1", "pending:h:2"]);
    const n = evaluateAttributionNotice("h");
    expect(n).toMatchObject({ kind: "new", total: 2 });
    expect(n.newIds).toEqual(["pending:h:2"]); // 1 は再通知しない
  });

  it("1件解決＋1件新規で件数が不変でも新規を見逃さない（差分判定の要点）", () => {
    setIssues(["pending:h:1"]);
    evaluateAttributionNotice("h"); // 観測 {1}
    setIssues(["pending:h:2"]);     // 1解決・2新規 → 件数は1で不変
    const n = evaluateAttributionNotice("h");
    expect(n).toMatchObject({ kind: "new" });
    expect(n.newIds).toEqual(["pending:h:2"]);
  });

  it("解決のみ（新規なし）は通知しない", () => {
    setIssues(["pending:h:1", "pending:h:2"]);
    evaluateAttributionNotice("h"); // 観測 {1,2}
    setIssues(["pending:h:1"]);     // 2 解決のみ
    expect(evaluateAttributionNotice("h")).toBeNull();
  });

  it("ホスト未指定は null", () => {
    expect(evaluateAttributionNotice()).toBeNull();
  });
});

describe("scheduleAttributionNotice（debounce 集約・親のみ）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAttributionNoticeState();
    setIssues([]);
    showAlert.mockClear();
    if (typeof window !== "undefined") delete window._3dpmonRelayChild;
  });
  afterEach(() => { vi.useRealTimers(); });

  it("P1-4: 同一集合の連続呼び出しはタイマーを延長しない（永久延期を防ぐ）", () => {
    setIssues(["pending:h:1", "pending:h:2"]);
    scheduleAttributionNotice("h");     // t=0, timer→6000
    vi.advanceTimersByTime(3000);       // t=3000
    scheduleAttributionNotice("h");     // 同一集合 → 延長しない（P1-4）
    vi.advanceTimersByTime(2000);       // t=5000 未発火
    expect(showAlert).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);       // t=6500 > 6000 → 最初のタイマーが発火
    expect(showAlert).toHaveBeenCalledTimes(1);
    expect(showAlert.mock.calls[0][0]).toContain("2 件");
    expect(showAlert.mock.calls[0][1]).toBe("warn"); // 低優先・画面内
  });

  it("P1-4: 課題集合が変わったら再スケジュールして新規分を通知", () => {
    setIssues(["pending:h:1"]);
    scheduleAttributionNotice("h");
    vi.advanceTimersByTime(6000);
    expect(showAlert).toHaveBeenCalledTimes(1); // startup（既存1件）
    setIssues(["pending:h:1", "pending:h:2"]);  // 集合変化＝新規
    scheduleAttributionNotice("h");
    vi.advanceTimersByTime(6000);
    expect(showAlert).toHaveBeenCalledTimes(2); // new（h:2）
  });

  it("リレー子（window._3dpmonRelayChild）は通知しない（親のみ権威）", () => {
    globalThis.window = globalThis.window || {};
    window._3dpmonRelayChild = true;
    setIssues(["pending:h:1"]);
    scheduleAttributionNotice("h");
    vi.advanceTimersByTime(10000);
    expect(showAlert).not.toHaveBeenCalled();
    delete window._3dpmonRelayChild;
  });

  it("0件では発火しない", () => {
    setIssues([]);
    scheduleAttributionNotice("h");
    vi.advanceTimersByTime(10000);
    expect(showAlert).not.toHaveBeenCalled();
  });
});
