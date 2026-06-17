/**
 * @fileoverview processData マルチホスト behavioral 回帰テスト
 *
 * 目的:
 *   「優先1ホスト」/ 単一ホスト処理の omission(書き漏れ)バグを検出する。
 *   今回の err→storedData 書き漏れバグ（2台目以降の状態パネル「エラー状況」が空）
 *   のような、grep でも目視でも見つからない欠落を、実パイプラインを2台分流して捕まえる。
 *
 * 方針（重要）:
 *   - 実 processData を呼ぶ（dashboard_spool.test.js と同じく重い副作用依存は vi.mock）。
 *   - dashboard_data（per-host レジストリ）は実物を使用（window/document は最小シム）。
 *   - 検証は2軸:
 *       (A) parity   … 2台へ等価メッセージ→ storedData のキー集合が一致
 *       (B) 期待仕様 … 各ホストが必須フィールド(state/温度/err 等)を必ず持つ
 *     (A) だけでは「全ホストで同じく欠落」する omission を見逃すため (B) が必須。
 *
 * このテストは pre-fix コード（_set("err",…) 未追加）では (B) の err で red になる（実証済み）。
 *
 * ▼ 新しい per-host テストを書くとき: 下の vi.mock ブロックをテンプレとしてコピーし、
 *   メッセージ生成/検証は tests/helpers/multihost.js を使う。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  makeK1Status,
  EXPECTED_DISPLAY_KEYS,
  findMissingPerHost,
  storedKeysOf,
} from "../helpers/multihost.js";

/* ── window / document シム（dashboard_data.js が module top-level で window へ代入、
 *    scopedById が document.getElementById を参照するため、imports より前に用意） ── */
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
  ingestData: vi.fn(), restoreAggregatorState: vi.fn(), restartAggregatorTimer: vi.fn(), ensureAggregatorTimer: vi.fn(),
  persistAggregatorState: vi.fn(), setHistoryPersistFunc: vi.fn(), aggregatorUpdate: vi.fn(),
  getCurrentPrintID: vi.fn(() => 0),
}));

import { processData } from "../../3dp_lib/dashboard_msg_handler.js";
import { monitorData, ensureMachineData, getDisplayValue } from "../../3dp_lib/dashboard_data.js";
import { dashboardMapping } from "../../3dp_lib/dashboard_ui_mapping.js";

/**
 * updateStoredDataToDOM の computedValue 再生成を再現し、ホストの「エラー状況」表示値を返す。
 * process / getDisplayValue は実関数。
 * @param {string} host
 * @returns {{value:string, unit:string}|null}
 */
function renderErrorStatus(host) {
  const d = monitorData.machines[host]?.storedData?.err;
  if (d && d.rawValue != null && typeof dashboardMapping.err.process === "function") {
    d.computedValue = dashboardMapping.err.process(d.rawValue);
  }
  return getDisplayValue("err", host);
}

describe("processData マルチホスト behavioral (omission検出)", () => {
  beforeEach(() => {
    monitorData.machines = {};
  });

  it("(B) 2台とも必須フィールドを storedData に持つ — err 含む", () => {
    // ユニークホスト名で _initializedHosts のテスト間汚染を回避
    const A = "K1Max-B1A", B = "K1Max-B1B";
    ensureMachineData(A);
    ensureMachineData(B);

    processData(makeK1Status(A, { nozzleTemp: 210.0, err: { errcode: 0, key: 0 } }), A);
    processData(makeK1Status(B, { nozzleTemp: 25.0, err: { errcode: 23, key: 1 } }), B);

    // ★ pre-fix では err が両ホストとも欠落して落ちる
    const missing = findMissingPerHost(monitorData, [A, B], EXPECTED_DISPLAY_KEYS);
    expect(missing, `必須フィールド欠落のホストあり: ${JSON.stringify(missing)}`).toEqual({});

    // err はホストごとに正しい値で独立格納
    expect(monitorData.machines[A].storedData.err.rawValue).toEqual({ errcode: 0, key: 0 });
    expect(monitorData.machines[B].storedData.err.rawValue).toEqual({ errcode: 23, key: 1 });
  });

  it("(B) エラー状況の表示が 2台目でも空にならない", () => {
    const A = "K1Max-B2A", B = "K1Max-B2B";
    ensureMachineData(A);
    ensureMachineData(B);

    processData(makeK1Status(A, { err: { errcode: 0, key: 0 } }), A);
    processData(makeK1Status(B, { err: { errcode: 23, key: 1 } }), B);

    expect(renderErrorStatus(A)).toEqual({ value: "コード0, キー0", unit: "" });
    expect(renderErrorStatus(B)).toEqual({ value: "コード23, キー1", unit: "" });
  });

  it("(A) parity — 等価メッセージで 2台の storedData キー集合が一致", () => {
    const A = "K1Max-B3A", B = "K1Max-B3B";
    ensureMachineData(A);
    ensureMachineData(B);

    processData(makeK1Status(A), A);
    processData(makeK1Status(B), B);

    const keysA = storedKeysOf(monitorData, A);
    const keysB = storedKeysOf(monitorData, B);
    expect(keysB).toEqual(keysA);
    // 期待キーが parity 集合に含まれること（空集合同士の一致を排除）
    for (const key of EXPECTED_DISPLAY_KEYS) {
      expect(keysA).toContain(key);
    }
  });

  it("(B) 3台でも全ホストが独立して err を格納する", () => {
    const hosts = ["K1Max-B4A", "K1Max-B4B", "K1C-B4C"];
    hosts.forEach((h, i) => {
      ensureMachineData(h);
      processData(makeK1Status(h, { err: { errcode: i, key: i } }), h);
    });
    expect(findMissingPerHost(monitorData, hosts, ["err"])).toEqual({});
    hosts.forEach((h, i) => {
      expect(monitorData.machines[h].storedData.err.rawValue).toEqual({ errcode: i, key: i });
    });
  });
});
