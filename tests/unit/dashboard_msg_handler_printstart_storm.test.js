/**
 * @fileoverview 「印刷開始」通知ストーム 回帰テスト（PR #385）
 *
 * バグ（2fps修正で aggregator が復活した結果に表面化, 実機 IR3v2 で確認）:
 *   processData 冒頭の「完了経過タイマー復元」ブロックは tsCompletion===null
 *   （印刷中も真）のとき毎メッセージ走り、prevPrintStartTime を
 *   storedData.prevPrintID で**無条件上書き**していた。aggregator が書く
 *   prevPrintID は Moonraker では latched currStartTime と一致しないことがあり、
 *   末尾(L1010)で維持している prevPrintStartTime を毎push壊す → (2.3.1) の
 *   `currStartTime !== prevPrintStartTime` が毎push真 → printStarted 通知を
 *   約4Hz連発（通知ストーム）。
 *
 * 修正: prevPrintStartTime が未初期化(null)のときだけシードし、以降は上書きしない。
 *
 * 検証: prevPrintID を currStartTime と異なる値にして印刷中ステータスを連続投入し、
 *   printStarted 通知が「1回だけ」発火することを確認する。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeK1Status } from "../helpers/multihost.js";

vi.hoisted(() => {
  globalThis.window = globalThis.window || {};
  if (!globalThis.document) {
    const dummyEl = () => ({
      style: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      appendChild() {}, removeChild() {}, setAttribute() {}, removeAttribute() {},
      addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
      innerHTML: "", textContent: "",
    });
    globalThis.document = {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      createElement: () => dummyEl(), body: dummyEl(),
    };
  }
});

vi.mock("../../3dp_lib/dashboard_storage.js", () => ({
  restoreUnifiedStorage: vi.fn(), saveUnifiedStorage: vi.fn(), trimUsageHistory: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_log_util.js", () => ({ pushLog: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_notification_manager.js", () => ({
  notificationManager: { notify: vi.fn() }, showAlert: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_integration_itemkeeper.js", () => ({
  itemKeeperIntegration: { onPrintEvent: vi.fn() },
}));
vi.mock("../../3dp_lib/dashboard_printstatus.js", () => ({ handlePrintStateTransition: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_stage_preview.js", () => ({
  updateXYPreview: vi.fn(), updateZPreview: vi.fn(), setPrinterModel: vi.fn(), setStageGeometry: vi.fn(),
}));
vi.mock("../../3dp_lib/3dp_dashboard_init.js", () => ({
  restorePrintResume: vi.fn(), persistPrintResume: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_printmanager.js", () => ({
  updateHistoryList: vi.fn(), updateVideoList: vi.fn(),
  loadHistory: vi.fn(() => []), jobsToRaw: vi.fn(() => []),
  renderHistoryTable: vi.fn(), renderPrintCurrent: vi.fn(),
  loadCurrent: vi.fn(() => ({})), saveCurrent: vi.fn(),
  applyLifecycleMetrics: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_connection.js", () => ({
  getDeviceIp: vi.fn(() => "127.0.0.1"), getHttpPort: vi.fn(() => 80),
}));
vi.mock("../../3dp_lib/dashboard_spool.js", () => ({
  getCurrentSpool: vi.fn(() => null), formatFilamentAmount: vi.fn(() => ""), formatSpoolDisplayId: vi.fn(() => ""),
}));
vi.mock("../../3dp_lib/dashboard_aggregator.js", () => ({
  ingestData: vi.fn(), restoreAggregatorState: vi.fn(), restartAggregatorTimer: vi.fn(),
  ensureAggregatorTimer: vi.fn(), persistAggregatorState: vi.fn(), setHistoryPersistFunc: vi.fn(),
  aggregatorUpdate: vi.fn(), getCurrentPrintID: vi.fn(() => 0),
}));
vi.mock("../../3dp_lib/dashboard_print_lifecycle.js", () => ({
  recordPrintLifecycle: vi.fn(), getPrintLifecycleMetrics: vi.fn(() => ({})), resetPrintLifecycle: vi.fn(),
}));

import { processData } from "../../3dp_lib/dashboard_msg_handler.js";
import { monitorData, ensureMachineData } from "../../3dp_lib/dashboard_data.js";
import { notificationManager } from "../../3dp_lib/dashboard_notification_manager.js";

describe("processData printStarted 通知ストーム防止", () => {
  beforeEach(() => {
    monitorData.machines = {};
    vi.clearAllMocks();
  });

  it("印刷中ステータスを連続投入しても printStarted 通知は1回だけ（prevPrintID 不一致でも）", () => {
    const H = "IR3V2-STORM";
    ensureMachineData(H);
    const REAL_ID = 1781659601;
    // ★ aggregator が書く prevPrintID を currStartTime(REAL_ID) と「異なる」値にする
    //   （Moonraker で latched startEpoch と一致しない状況を再現）
    monitorData.machines[H].storedData.prevPrintID = { rawValue: REAL_ID - 137, isNew: false };

    // 印刷中(state=1, progress<100)の同一ジョブを10連続投入＝約数秒の push 相当
    for (let i = 0; i < 10; i++) {
      processData(makeK1Status(H, {
        state: 1, printProgress: 30 + i, printStartTime: REAL_ID,
        printFileName: "/usr/data/Piggy.gcode",
      }), H);
    }

    const starts = notificationManager.notify.mock.calls.filter(c => c[0] === "printStarted");
    expect(starts.length, "printStarted 通知は新規開始の1回のみ").toBe(1);
  });

  it("同一ファイルで開始時刻が推定値→実値に1回補正されても printStarted は1回だけ", () => {
    const H = "IR3V2-REFINE";
    ensureMachineData(H);
    // 起動直後: Moonraker は推定値(now-print_duration)で開始
    processData(makeK1Status(H, {
      state: 1, printProgress: 12, printStartTime: 1781000050, printFileName: "/x/Piggy.gcode",
    }), H);
    // 履歴到着で実 start_time に補正（同一ファイル・state継続）→ 再発火してはいけない
    for (let i = 0; i < 5; i++) {
      processData(makeK1Status(H, {
        state: 1, printProgress: 13 + i, printStartTime: 1781000001, printFileName: "/x/Piggy.gcode",
      }), H);
    }
    const starts = notificationManager.notify.mock.calls.filter(c => c[0] === "printStarted");
    expect(starts.length, "推定→実値の補正は新規印刷ではない＝1回のみ").toBe(1);
  });

  it("別ジョブ（startTime変化）では改めて printStarted が出る（リグレッションなし）", () => {
    const H = "IR3V2-STORM2";
    ensureMachineData(H);

    for (let i = 0; i < 4; i++) {
      processData(makeK1Status(H, {
        state: 1, printProgress: 10 + i, printStartTime: 1781000001, printFileName: "/x/a.gcode",
      }), H);
    }
    // 別ジョブ開始（startTime が明確に変わる）
    for (let i = 0; i < 4; i++) {
      processData(makeK1Status(H, {
        state: 1, printProgress: 10 + i, printStartTime: 1781009999, printFileName: "/x/b.gcode",
      }), H);
    }

    const starts = notificationManager.notify.mock.calls.filter(c => c[0] === "printStarted");
    expect(starts.length, "ジョブAとジョブBで計2回").toBe(2);
  });
});
