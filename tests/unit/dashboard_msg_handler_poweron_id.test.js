/**
 * @fileoverview 電源投入直後の ID:0/null 報告に対する behavioral 回帰テスト
 *
 * バグ: K1 系プリンタは電源投入直後に「前回印刷の進捗(printProgress=100)」と
 * 「printStartTime=0/null」を同一メッセージで push することがある。
 * 旧実装は (2.7.4) で entry.id=0（epoch 0 = 1970年の「大過去」）のゴースト履歴を
 * 生成し、(a) 履歴の最新ID比較が誤動作しサムネイルが出ない、(b) h.id===0 照合で
 * フィラメント情報を誤復元、(c) 重複防止により実ジョブの完了記録がスキップされる、
 * という「印刷結果がおかしくなる」症状を引き起こした。
 *
 * 検証方針: 実 processData を流し、
 *   (A) printStartTime=0 の stale push でゴースト履歴が生成されないこと
 *   (B) 保存済み現在ジョブIDがあればそちらへ正しく帰属すること
 *   (C) 印刷開始(2.3.1)で currStartTime=0 のとき curJob.id=0 を書き込まないこと
 *   (D) normalizeJobId の正規化仕様
 *
 * vi.mock ブロックは tests/unit/processData_multihost.test.js をテンプレとして使用。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeK1Status } from "../helpers/multihost.js";

/* ── window / document シム（imports より前に用意） ── */
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
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => dummyEl(),
      body: dummyEl(),
    };
  }
});

/* ── 重い副作用依存をモック（データ層 dashboard_data は実物のまま） ── */
vi.mock("../../3dp_lib/dashboard_storage.js", () => ({
  restoreUnifiedStorage: vi.fn(),
  saveUnifiedStorage: vi.fn(),
  trimUsageHistory: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_log_util.js", () => ({ pushLog: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_notification_manager.js", () => ({
  notificationManager: { notify: vi.fn() },
  showAlert: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_integration_itemkeeper.js", () => ({
  itemKeeperIntegration: { onPrintEvent: vi.fn() },
}));
vi.mock("../../3dp_lib/dashboard_printstatus.js", () => ({ handlePrintStateTransition: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_stage_preview.js", () => ({
  updateXYPreview: vi.fn(), updateZPreview: vi.fn(), setPrinterModel: vi.fn(),
}));
vi.mock("../../3dp_lib/3dp_dashboard_init.js", () => ({
  restorePrintResume: vi.fn(), persistPrintResume: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_printmanager.js", () => ({
  updateHistoryList: vi.fn(), updateVideoList: vi.fn(),
  loadHistory: vi.fn(() => []), jobsToRaw: vi.fn(() => []),
  renderHistoryTable: vi.fn(), renderPrintCurrent: vi.fn(),
  loadCurrent: vi.fn(() => ({})), saveCurrent: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_connection.js", () => ({
  getDeviceIp: vi.fn(() => "127.0.0.1"), getHttpPort: vi.fn(() => 80),
}));
vi.mock("../../3dp_lib/dashboard_spool.js", () => ({
  getCurrentSpool: vi.fn(() => null), formatFilamentAmount: vi.fn(() => ""), formatSpoolDisplayId: vi.fn(() => ""),
}));
vi.mock("../../3dp_lib/dashboard_aggregator.js", () => ({
  ingestData: vi.fn(), restoreAggregatorState: vi.fn(), restartAggregatorTimer: vi.fn(),
  persistAggregatorState: vi.fn(), setHistoryPersistFunc: vi.fn(), aggregatorUpdate: vi.fn(),
  getCurrentPrintID: vi.fn(() => 0),
}));

import { processData } from "../../3dp_lib/dashboard_msg_handler.js";
import { monitorData, ensureMachineData } from "../../3dp_lib/dashboard_data.js";
import { normalizeJobId } from "../../3dp_lib/dashboard_utils.js";
import * as printManager from "../../3dp_lib/dashboard_printmanager.js";
import { getCurrentPrintID } from "../../3dp_lib/dashboard_aggregator.js";

describe("normalizeJobId — ID:0/null 正規化仕様", () => {
  it("正の有限整数のみ有効、それ以外は null", () => {
    expect(normalizeJobId(1749700000)).toBe(1749700000);
    expect(normalizeJobId("1749700000")).toBe(1749700000);
    expect(normalizeJobId(1749700000.9)).toBe(1749700000); // 整数へ切り捨て
    expect(normalizeJobId(0)).toBeNull();        // 電源投入直後の偽ID
    expect(normalizeJobId("0")).toBeNull();
    expect(normalizeJobId(null)).toBeNull();
    expect(normalizeJobId(undefined)).toBeNull();
    expect(normalizeJobId(-5)).toBeNull();
    expect(normalizeJobId(NaN)).toBeNull();
    expect(normalizeJobId("abc")).toBeNull();
    expect(normalizeJobId(Infinity)).toBeNull();
  });
});

describe("processData 電源投入直後 behavioral (ID:0/null)", () => {
  beforeEach(() => {
    monitorData.machines = {};
    vi.clearAllMocks();
  });

  it("(A) printProgress=100 + printStartTime=0 の stale push でゴースト履歴(id=0)を作らない", () => {
    const H = "K1Max-PWR-A";
    ensureMachineData(H);
    // 現在ジョブ未保存・aggregator も未把握（完全初回）→ 帰属先なし → 登録スキップ
    printManager.loadCurrent.mockReturnValue({});
    getCurrentPrintID.mockReturnValue(0);

    processData(makeK1Status(H, {
      state: 0,                       // 電源投入直後は idle
      printProgress: 100,             // 前回印刷の残骸
      printStartTime: 0,              // ★ 偽ID
      printFileName: "/usr/data/last_print.gcode",
    }), H);

    // ゴースト履歴(id=0)が historyData に積まれないこと
    const ghosts = monitorData.machines[H].historyData.filter(h => !(Number(h.id) > 0));
    expect(ghosts).toEqual([]);
    // updateHistoryList にも id=0 エントリが渡らないこと（履歴登録自体スキップ）
    for (const call of printManager.updateHistoryList.mock.calls) {
      const arr = call[0] || [];
      expect(arr.filter(e => !(Number(e.id) > 0))).toEqual([]);
    }
  });

  it("(B) printStartTime=0 でも保存済み現在ジョブIDがあればそちらへ帰属する", () => {
    const H = "K1Max-PWR-B";
    ensureMachineData(H);
    const SAVED_ID = 1749000111;
    printManager.loadCurrent.mockReturnValue({ id: SAVED_ID, filename: "boat.gcode" });

    processData(makeK1Status(H, {
      state: 0,
      printProgress: 100,
      printStartTime: 0,              // ★ 偽ID → 保存済みIDへフォールバック
      printFileName: "/usr/data/boat.gcode",
    }), H);

    const entry = monitorData.machines[H].historyData.find(h => Number(h.id) === SAVED_ID);
    expect(entry, "保存済み現在ジョブIDへ帰属した履歴エントリが必要").toBeTruthy();
    // id=0 のゴーストは存在しない
    expect(monitorData.machines[H].historyData.filter(h => !(Number(h.id) > 0))).toEqual([]);
  });

  it("(C) 印刷開始(2.3.1)で printStartTime=0 のとき curJob.id=0/1970 を書き込まない", () => {
    const H = "K1Max-PWR-C";
    ensureMachineData(H);
    printManager.loadCurrent.mockReturnValue({});
    getCurrentPrintID.mockReturnValue(0);

    processData(makeK1Status(H, {
      state: 1,                       // printStarted
      printProgress: 0,
      printStartTime: 0,              // ★ 開始直後は ID 未確定で 0 が来ることがある
      printFileName: "/usr/data/new_print.gcode",
    }), H);

    // saveCurrent は呼ばれる（ファイル名等の反映）が、id=0 を書いてはならない
    expect(printManager.saveCurrent).toHaveBeenCalled();
    for (const call of printManager.saveCurrent.mock.calls) {
      const job = call[0] || {};
      expect(job.id, "curJob.id に 0 を書き込んではならない").not.toBe(0);
      if (job.startTime) {
        expect(String(job.startTime).startsWith("1970"), "epoch 0 (1970年) を書き込んではならない").toBe(false);
      }
    }
  });

  it("(D) 実IDが届けば従来どおり履歴登録される（リグレッションなし）", () => {
    const H = "K1Max-PWR-D";
    ensureMachineData(H);
    const REAL_ID = 1749223344;
    printManager.loadCurrent.mockReturnValue({});

    processData(makeK1Status(H, {
      state: 2,                       // printDone
      printProgress: 100,
      printStartTime: REAL_ID,        // 実ID
      printFileName: "/usr/data/done.gcode",
    }), H);

    const entry = monitorData.machines[H].historyData.find(h => Number(h.id) === REAL_ID);
    expect(entry, "実IDの完了履歴は登録される").toBeTruthy();
  });

  it("(E) 再起動直後: 開始時刻0かつファイル名空の完了は保存済みIDへ寄せず「(不明)」ゴーストを作らない", () => {
    const H = "K1Max-PWR-E";
    ensureMachineData(H);
    const STALE_ID = 1781659601;
    // 前回印刷の残骸: 保存済み現在ジョブIDは残っているが、stale push は開始時刻0・ファイル名空
    printManager.loadCurrent.mockReturnValue({ id: STALE_ID });
    getCurrentPrintID.mockReturnValue(STALE_ID);

    processData(makeK1Status(H, {
      state: 0,
      printProgress: 100,
      printStartTime: 0,        // ★ 無効
      printFileName: "",        // ★ ファイル名空 → 従来は「(不明)/→0秒」ゴースト化
      fileName: "",
    }), H);

    // 開始時刻もファイル名も無い → stale push とみなしスキップ（ゴースト未生成）
    expect(monitorData.machines[H].historyData.find(h => Number(h.id) === STALE_ID)).toBeUndefined();
    expect(monitorData.machines[H].historyData.filter(h => !(Number(h.id) > 0))).toEqual([]);
  });

  it("(F) 既に保存済みの完了ジョブを連続報告(Moonraker state=complete)しても再登録ループしない", () => {
    const H = "K1Max-PWR-F";
    ensureMachineData(H);
    const REAL_ID = 1781659601;
    // 既に printStore.history に保存済み（前回登録 or 機器履歴由来）
    printManager.loadHistory.mockReturnValue([{ id: REAL_ID, filename: "Piggy.gcode", filamentInfo: [] }]);

    // 完了後も state=complete・progress=100 を報告し続ける状況を5回再現
    for (let i = 0; i < 5; i++) {
      processData(makeK1Status(H, {
        state: 2, printProgress: 100, printStartTime: REAL_ID, printFileName: "/x/Piggy.gcode",
      }), H);
    }
    // savedJob があるため再登録されない（毎push の updateHistoryList/saveHistory ループを断つ）
    expect(monitorData.machines[H].historyData.filter(h => Number(h.id) === REAL_ID)).toEqual([]);
  });
});
