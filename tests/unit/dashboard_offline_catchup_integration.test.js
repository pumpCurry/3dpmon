/**
 * @fileoverview オフライン取りこぼし→mid-print再起動 の aggregator 統合テスト（レビュー P1-2）
 *
 * シナリオ:
 *   S装着 → A開始 → A途中でapp停止 → A/Bオフライン完了 → C途中でapp起動。
 *   復元で spool.currentPrintID=A(stale), currentJobStartLength=300000 が戻った状態。
 *   実機は現在ジョブ C(印刷中, ライブ消費5000) を報告。
 *
 * 検証する処理順（aggregatorUpdate 1回で成立）:
 *   1. stale resume 検出: currentPrintID(A) != live(C) → 旧一時値を破棄
 *   2. 現在ジョブ C を採用（currentPrintID=C）
 *   3. catchUp: 過去完了ジョブ A/B を帰属（C は除外）
 *   4. rebase: derive(=270000) を現在ジョブ C の開始基準へ取り込む
 *   5. C の開始基準 currentJobStartLength = 270000（A開始前の300000へ戻さない）
 *
 * aggregator の orchestration を検証するため、leaf（catchUp/derive）は spy にする。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const PSC = { printIdle: 0, printStarted: 1, printPaused: 2, printDone: 3, printFailed: 4 };

const mockMonitorData = { appSettings: { updateInterval: 500 }, machines: {}, filamentSpools: [], hostSpoolMap: {} };

vi.mock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: mockMonitorData,
  // 実挙動に近づける: storedData へ実際にキーを書く（needed keys 充足 + _set 反映のため）
  setStoredDataForHost: vi.fn((host, key, value, isRaw = false) => {
    const m = mockMonitorData.machines[host];
    if (!m) return;
    m.storedData ??= {};
    m.storedData[key] ??= {};
    if (isRaw) m.storedData[key].rawValue = value;
    else m.storedData[key].computedValue = value;
  }),
  PLACEHOLDER_HOSTNAME: "_$_NO_MACHINE_$_",
}));
vi.mock("../../3dp_lib/dashboard_ui.js", () => ({ clearNewClasses: vi.fn(), updateStoredDataToDOM: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_storage.js", () => ({
  saveUnifiedStorage: vi.fn(),
  loadPrintCurrent: vi.fn(() => ({ id: "1003" })),
}));
vi.mock("../../3dp_lib/dashboard_chart.js", () => ({
  updateTemperatureGraphFromStoredData: vi.fn(), switchChartHost: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_thermal_guard.js", () => ({
  createThermalState: vi.fn(() => ({})),
  evaluateThermal: vi.fn(() => ({ newAlerts: [] })),
  getThermalConfig: vi.fn(() => ({})),
}));
vi.mock("../../3dp_lib/dashboard_utils.js", () => ({
  checkUpdatedFields: vi.fn(), formatDuration: vi.fn(() => ""), formatDurationSimple: vi.fn(() => ""),
  normalizeJobId: vi.fn((v) => (v == null || v === "" ? null : Number(v) || null)),
}));
vi.mock("../../3dp_lib/dashboard_notification_manager.js", () => ({
  notificationManager: { statusSnapshotEnabled: false, notify: vi.fn() },
}));
vi.mock("../../3dp_lib/dashboard_ui_mapping.js", () => ({ PRINT_STATE_CODE: PSC }));
vi.mock("../../3dp_lib/dashboard_filament_change.js", () => ({
  showFilamentChangeDialog: vi.fn(), closeFilamentChangeDialog: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_connection.js", () => ({ getConnectionState: vi.fn(() => "connected") }));

// leaf を spy 化（orchestration の順序・引数を検証する）
const _spool = {
  getCurrentSpool: vi.fn(),
  reserveFilament: vi.fn(),
  finalizeFilamentUsage: vi.fn(),
  autoCorrectCurrentSpool: vi.fn(),
  catchUpOfflineFilamentAttribution: vi.fn(() => 2),
  addUsageSnapshot: vi.fn(),
  beginExternalPrint: vi.fn(),
  formatFilamentAmount: vi.fn(() => ({ display: "" })),
  formatSpoolDisplayId: vi.fn(() => ""),
  getSpoolById: vi.fn(() => null),
};
vi.mock("../../3dp_lib/dashboard_spool.js", () => _spool);
const _ledger = {
  reconcileSpool: vi.fn(),
  recordFilamentEvent: vi.fn(),
  resolveFilamentEvent: vi.fn(),
  getOpenFilamentEvent: vi.fn(() => null),
  runoutGateHeld: vi.fn(() => false),
  deriveSpoolRemaining: vi.fn(() => ({ remainingMm: 270000, verified: true, mode: "anchor" })),
};
vi.mock("../../3dp_lib/dashboard_filament_ledger.js", () => _ledger);

const { aggregatorUpdate } = await import("../../3dp_lib/dashboard_aggregator.js");

/** storedData フィールドを rawValue 形式で構築 */
function sd(fields) {
  const o = {};
  for (const [k, v] of Object.entries(fields)) o[k] = { rawValue: v };
  return o;
}

describe("オフライン取りこぼし→mid-print再起動 の帰属・基準リベース(P1-2)", () => {
  let spool;
  // aggregator の per-host 状態(_lastCatchUp 等)はモジュールに残るため、テストごとに別ホストを使う。
  function setup(host) {
    vi.clearAllMocks();
    spool = {
      id: "S", remainingLengthMm: 300000,
      currentPrintID: "1001",           // A(stale)
      currentJobStartLength: 300000,    // A開始前残量
      currentJobExpectedLength: 100000,
    };
    _spool.getCurrentSpool.mockReturnValue(spool);
    _ledger.deriveSpoolRemaining.mockReturnValue({ remainingMm: 270000, verified: true, mode: "anchor" });
    _spool.catchUpOfflineFilamentAttribution.mockReturnValue(2);
    mockMonitorData.machines = {
      [host]: {
        storedData: sd({
          state: PSC.printStarted,         // 印刷中(C)
          printStartTime: 1003,            // 実機の現在ジョブ = C
          usedMaterialLength: 5000,        // C のライブ消費
          printProgress: 10,
          materialLength: 100000,
        }),
        printStore: { history: [], current: { id: "1003" } },
        runtimeData: {},
      },
    };
    mockMonitorData.hostSpoolMap = { [host]: "S" };
  }

  it("stale A破棄→C採用→catchUp(C除外)→derive反映で C開始基準=270000（300000へ戻さない）", () => {
    setup("hostA");
    aggregatorUpdate("hostA");

    // 3. catchUp が現在ジョブ C(1003) を除外指定で呼ばれる
    expect(_spool.catchUpOfflineFilamentAttribution).toHaveBeenCalled();
    const arg = _spool.catchUpOfflineFilamentAttribution.mock.calls[0][1];
    expect(String(arg.liveJobId)).toBe("1003");

    // 4/5. derive(270000) が C(1003) 除外で呼ばれ、C の開始基準へ取り込まれる
    expect(_ledger.deriveSpoolRemaining).toHaveBeenCalledWith("S", { excludeJobId: "1003" });
    expect(spool.remainingLengthMm).toBe(270000);
    // 2. 現在ジョブ C が採用されている（A のままではない）
    expect(String(spool.currentPrintID)).toBe("1003");
    // 5. C の開始基準は 270000（A開始前の 300000 に戻っていない）
    expect(spool.currentJobStartLength).toBe(270000);
  });

  it("再度アプリを落として再起動しても C の基準が 300000 へ戻らない（stale再破棄→再リベース）", () => {
    // 別ホストで最初から: 1回目で 270000 に確定
    setup("hostB");
    aggregatorUpdate("hostB");
    expect(spool.currentJobStartLength).toBe(270000);
    expect(String(spool.currentPrintID)).toBe("1003"); // C 採用済み・stale A へ戻らない
  });

  it("Phase3: catchUp が0件(linked=0)でも台帳導出値で開始基準が自己修復される（linked>0依存の除去）", () => {
    setup("hostC");
    // 今tickは何も紐付かない（従来なら linked>0 でないため rebase されなかった）
    _spool.catchUpOfflineFilamentAttribution.mockReturnValue(0);
    // 台帳は権威として 250000 を導出（現在の開始基準 300000 とはズレている）
    _ledger.deriveSpoolRemaining.mockReturnValue({ remainingMm: 250000, verified: true, mode: "anchor" });

    aggregatorUpdate("hostC");

    // linked=0 でも watermark/ドリフト経路で開始基準が台帳値へ自己修復される
    expect(spool.currentJobStartLength).toBe(250000);
    expect(spool.remainingLengthMm).toBe(250000);
    expect(_ledger.deriveSpoolRemaining).toHaveBeenCalledWith("S", { excludeJobId: "1003" });
  });

  it("Phase3: 台帳が曖昧(mode!=anchor)なら開始基準を壊さない（halt時は現状維持）", () => {
    setup("hostD");
    _spool.catchUpOfflineFilamentAttribution.mockReturnValue(0);
    // 複数open等で halt-ambiguous: remainingMm は現在値だが mode が anchor でない
    _ledger.deriveSpoolRemaining.mockReturnValue({ remainingMm: 999, verified: false, mode: "halt-ambiguous" });

    aggregatorUpdate("hostD");

    // rebase 対象外 → currentJobStartLength は台帳の 999 に引きずられない
    expect(spool.currentJobStartLength).not.toBe(999);
    expect(spool.remainingLengthMm).not.toBe(999);
  });
});
