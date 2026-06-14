/**
 * @fileoverview リレー子（satellite）での aggregator フィラメント処理ガード回帰テスト
 *
 * バグ: 旧実装ではリレー子も aggregator のフィラメント消費計算を実行し、
 * spool.remainingLengthMm を毎 tick ローカル上書き・台帳予約（reserveFilament）まで
 * 行っていた。親が relay-delta で配信した権威値が 500ms 以内に子のローカル計算で
 * 破壊され、親とサテライトのフィラメント表示が大きく乖離する根本原因だった。
 *
 * 検証: 実 aggregatorUpdate を「印刷中ホスト」に対して実行し、
 *   - リレー子: スプール取得すら行わず（getCurrentSpool 不呼出）、予約/確定も走らない
 *   - 親:       従来どおりスプールを取得し消費トラッキングを初期化する（対照群）
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.hoisted(() => {
  globalThis.window = globalThis.window || {};
  if (!globalThis.document) {
    globalThis.document = {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { classList: { add() {}, remove() {} } },
    };
  }
  // aggregator はモジュール先頭と persist で localStorage を参照する（node 環境用シム）
  if (!globalThis.localStorage) {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    };
  }
});

/* ── 重い副作用依存をモック（dashboard_data / dashboard_utils / ui_mapping は実物） ── */
vi.mock("../../3dp_lib/dashboard_ui.js", () => ({
  clearNewClasses: vi.fn(),
  updateStoredDataToDOM: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_storage.js", () => ({
  saveUnifiedStorage: vi.fn(),
  loadPrintCurrent: vi.fn(() => null),
}));
vi.mock("../../3dp_lib/dashboard_chart.js", () => ({
  updateTemperatureGraphFromStoredData: vi.fn(),
  switchChartHost: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_notification_manager.js", () => ({
  notificationManager: {
    notify: vi.fn(),
    getFilamentLowThreshold: vi.fn(() => 0.1),
  },
  showAlert: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_filament_change.js", () => ({
  showFilamentChangeDialog: vi.fn(),
  closeFilamentChangeDialog: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_spool.js", () => ({
  getCurrentSpool: vi.fn(),
  reserveFilament: vi.fn(),
  finalizeFilamentUsage: vi.fn(),
  autoCorrectCurrentSpool: vi.fn(),
  addUsageSnapshot: vi.fn(),
  beginExternalPrint: vi.fn(),
  formatFilamentAmount: vi.fn(() => ({ display: "" })),
  formatSpoolDisplayId: vi.fn(() => ""),
  getSpoolById: vi.fn(() => null),
  setCurrentSpoolId: vi.fn(() => true),
  addInferredSpool: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_filament_ledger.js", () => ({
  reconcileSpool: vi.fn(),
  recordFilamentEvent: vi.fn(),
  resolveFilamentEvent: vi.fn(),
  getOpenFilamentEvent: vi.fn(() => null),
  runoutGateHeld: vi.fn(() => false),
}));
vi.mock("../../3dp_lib/dashboard_connection.js", () => ({
  getConnectionState: vi.fn(() => ({ state: "connected" })),
}));

const { aggregatorUpdate } = await import("../../3dp_lib/dashboard_aggregator.js");
const { monitorData, ensureMachineData, setStoredDataForHost } =
  await import("../../3dp_lib/dashboard_data.js");
const spoolMod = await import("../../3dp_lib/dashboard_spool.js");

/**
 * 印刷中ホストを実データ層にセットアップする。
 * @param {string} host - ホスト名
 * @returns {object} getCurrentSpool が返すスプールオブジェクト
 */
function setupPrintingHost(host) {
  ensureMachineData(host);
  const machine = monitorData.machines[host];
  machine.runtimeData = { state: "1", lastError: null };
  machine.printStore = { current: { id: "1700000123" }, history: [], videos: {} };
  const raw = {
    state: 1,                 // printStarted
    printProgress: 50,
    printJobTime: 120,
    printLeftTime: 100,
    printStartTime: 1700000123,
    usedMaterialLength: 1000,
    nozzleTemp: 210, targetNozzleTemp: 210, maxNozzleTemp: 300,
    bedTemp0: 60, targetBedTemp0: 60, maxBedTemp: 100,
    materialStatus: 0,
    withSelfTest: 0,
  };
  for (const [k, v] of Object.entries(raw)) {
    setStoredDataForHost(host, k, v, true);
  }
  const spool = {
    id: "SP1", name: "PLA-1",
    remainingLengthMm: 100000, totalLengthMm: 330000,
    currentPrintID: "", currentJobStartLength: null, currentJobExpectedLength: null,
    isActive: true, hostname: host,
  };
  spoolMod.getCurrentSpool.mockReturnValue(spool);
  return spool;
}

describe("aggregatorUpdate のリレー子ガード", () => {
  beforeEach(() => {
    monitorData.machines = {};
    vi.clearAllMocks();
  });

  it("リレー子: スプールに一切触れない（取得・予約・消費計算・確定なし）", () => {
    window._3dpmonRelayChild = true;
    const spool = setupPrintingHost("K1Max-RG-CHILD");

    try { aggregatorUpdate(); } catch { /* webhook 等の後段は対象外 */ }

    // フィラメント関連のスプール API が一切呼ばれない
    expect(spoolMod.getCurrentSpool).not.toHaveBeenCalled();
    expect(spoolMod.reserveFilament).not.toHaveBeenCalled();
    expect(spoolMod.finalizeFilamentUsage).not.toHaveBeenCalled();
    expect(spoolMod.beginExternalPrint).not.toHaveBeenCalled();
    expect(spoolMod.autoCorrectCurrentSpool).not.toHaveBeenCalled();
    // スプールオブジェクトが無変更（親配信値が権威のまま）
    expect(spool.remainingLengthMm).toBe(100000);
    expect(spool.currentJobStartLength).toBeNull();
    expect(spool.currentPrintID).toBe("");

    delete window._3dpmonRelayChild;
  });

  it("親/スタンドアロン: 従来どおり消費トラッキングを初期化する（対照群）", () => {
    delete window._3dpmonRelayChild;
    const spool = setupPrintingHost("K1Max-RG-PARENT");

    try { aggregatorUpdate(); } catch { /* webhook 等の後段は対象外 */ }

    // スプールを取得し、印刷中ジョブの基点を記録している（ガード誤適用の検出）
    expect(spoolMod.getCurrentSpool).toHaveBeenCalled();
    expect(spool.currentJobStartLength).not.toBeNull();
  });
});
