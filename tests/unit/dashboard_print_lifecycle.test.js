/**
 * @fileoverview dashboard_print_lifecycle.js 単体テスト（観測フラグ＋区間時間）
 *
 * 既定は "history"（取れなかった）。開始から観測できたジョブのみ warmup/paused/後処理を
 * 実測する。時刻は nowMs で受ける純設計なので決定論的に検証できる。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordPrintLifecycle,
  getPrintLifecycleMetrics,
  resetPrintLifecycle,
  _resetAllPrintLifecycle,
} from "../../3dp_lib/dashboard_print_lifecycle.js";

const PRINTING = 1, PAUSED = 5, DONE = 2;
const H = "h1";

beforeEach(() => _resetAllPrintLifecycle());

describe("getPrintLifecycleMetrics 既定", () => {
  it("未追跡ホストは observed=history・全 null（＝取れなかった）", () => {
    expect(getPrintLifecycleMetrics("nope", { nowMs: 1000 }))
      .toEqual({ observed: "history", warmupSec: null, pausedSec: null, postProcessingTime: null });
  });
});

describe("ライブ観測（開始から立ち会えた）", () => {
  it("warmup/paused=0/後処理 を実測し observed=live", () => {
    recordPrintLifecycle(H, { state: PRINTING, progress: 0,   jobId: 100, nowMs: 0 });       // 開始(progress0)
    recordPrintLifecycle(H, { state: PRINTING, progress: 5,   jobId: 100, nowMs: 300_000 }); // 初進捗=warmup 300s
    recordPrintLifecycle(H, { state: PRINTING, progress: 100, jobId: 100, nowMs: 600_000 }); // 100%到達
    const m = getPrintLifecycleMetrics(H, { nowMs: 632_000 });                                // 完了(後処理32s)
    expect(m.observed).toBe("live");
    expect(m.warmupSec).toBe(300);
    expect(m.pausedSec).toBe(0);
    expect(m.postProcessingTime).toBe(32);
  });

  it("一時停止区間を pausedSec に積算", () => {
    recordPrintLifecycle(H, { state: PRINTING, progress: 0,  jobId: 1, nowMs: 0 });
    recordPrintLifecycle(H, { state: PRINTING, progress: 10, jobId: 1, nowMs: 100_000 });
    recordPrintLifecycle(H, { state: PAUSED,   progress: 50, jobId: 1, nowMs: 200_000 }); // 停止開始
    recordPrintLifecycle(H, { state: PRINTING, progress: 50, jobId: 1, nowMs: 260_000 }); // 再開（停止60s）
    recordPrintLifecycle(H, { state: PRINTING, progress: 100, jobId: 1, nowMs: 400_000 });
    const m = getPrintLifecycleMetrics(H, { nowMs: 410_000 });
    expect(m.observed).toBe("live");
    expect(m.pausedSec).toBe(60);
    expect(m.postProcessingTime).toBe(10);
  });

  it("停止中に metrics 取得しても進行中の停止を含める", () => {
    recordPrintLifecycle(H, { state: PRINTING, progress: 0,  jobId: 1, nowMs: 0 });
    recordPrintLifecycle(H, { state: PRINTING, progress: 10, jobId: 1, nowMs: 10_000 });
    recordPrintLifecycle(H, { state: PAUSED,   progress: 30, jobId: 1, nowMs: 50_000 }); // 停止開始(未再開)
    const m = getPrintLifecycleMetrics(H, { nowMs: 80_000 });
    expect(m.pausedSec).toBe(30); // 50_000→80_000
  });
});

describe("途中参加（partial）", () => {
  it("開始を見ていない→observed=partial・warmup/paused は null、後処理は100%観測時のみ", () => {
    recordPrintLifecycle(H, { state: PRINTING, progress: 50,  jobId: 7, nowMs: 0 });   // 50%から参加
    recordPrintLifecycle(H, { state: PRINTING, progress: 100, jobId: 7, nowMs: 200_000 });
    const m = getPrintLifecycleMetrics(H, { nowMs: 215_000 });
    expect(m.observed).toBe("partial");
    expect(m.warmupSec).toBeNull();
    expect(m.pausedSec).toBeNull();
    expect(m.postProcessingTime).toBe(15); // 100%→完了は観測できているので取れる
  });

  it("100%を見ずに完了→後処理も null（取れなかった）", () => {
    recordPrintLifecycle(H, { state: PRINTING, progress: 60, jobId: 8, nowMs: 0 });
    const m = getPrintLifecycleMetrics(H, { nowMs: 5_000 });
    expect(m.observed).toBe("partial");
    expect(m.postProcessingTime).toBeNull();
  });
});

describe("ジョブ切替・リセット", () => {
  it("jobId 変化で新規トラックに切り替わる", () => {
    recordPrintLifecycle(H, { state: PRINTING, progress: 0, jobId: 1, nowMs: 0 });
    recordPrintLifecycle(H, { state: PRINTING, progress: 0, jobId: 2, nowMs: 1000 }); // 別ジョブ
    const m = getPrintLifecycleMetrics(H, { nowMs: 2000 });
    expect(m.observed).toBe("live"); // 新ジョブも開始から観測
  });

  it("resetPrintLifecycle で history に戻る", () => {
    recordPrintLifecycle(H, { state: PRINTING, progress: 0, jobId: 1, nowMs: 0 });
    resetPrintLifecycle(H);
    expect(getPrintLifecycleMetrics(H, { nowMs: 1 }).observed).toBe("history");
  });
});
