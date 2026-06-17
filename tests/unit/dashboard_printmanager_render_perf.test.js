/**
 * @fileoverview 履歴/ファイル一覧テーブルの描画律速対策（PR #385）回帰テスト
 *
 * 背景（実機プロファイルで確定）:
 *   親アプリの「2fps で固まる/リサイズ暴走/gcode タブ激重」は CPU(Script) ではなく
 *   描画(Rendering 1251ms ≫ Scripting 299ms)律速だった。実測 DOM は
 *   img=686 / tr=704 / listeners≈4400。原因は renderHistoryTable / renderFileList が
 *   (1) サムネイルを eager 読み込み、(2) 行ごとに 6 個前後の addEventListener を貼って
 *   いた（数百行 × 数リスナ＝数千リスナ）こと。
 *
 * 本テストで固定する不変条件:
 *   (A) サムネイル <img> は loading="lazy" decoding="async"（オフスクリーン画像を
 *       即デコードしない）
 *   (B) 行は data-row-index を持ち、クリックは tbody 1個のイベント委譲で捌く
 *       （= 行ごとの addEventListener を貼らない。再描画しても tbody のクリック
 *         リスナは 1 本のみ＝二重バインドしない）
 *   (C) 委譲ディスパッチが正しい行データで該当ハンドラへ届く
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

/* ── 重い依存グラフを切り離す（描画と委譲のみ検証） ── */
vi.mock("../../3dp_lib/dashboard_storage.js", () => ({
  loadPrintCurrent: vi.fn(() => ({})),
  savePrintCurrent: vi.fn(),
  loadPrintHistory: vi.fn(() => []),
  savePrintHistory: vi.fn(),
  loadPrintVideos: vi.fn(() => []),
  savePrintVideos: vi.fn(),
  saveUnifiedStorage: vi.fn(),
  MAX_PRINT_HISTORY: 100,
}));
vi.mock("../../3dp_lib/dashboard_utils.js", () => ({
  formatEpochToDateTime: vi.fn((v) => String(v ?? "")),
  formatDuration: vi.fn((s) => `${s}s`),
  normalizeJobId: vi.fn((v) => (Number(v) > 0 ? Number(v) : null)),
}));
vi.mock("../../3dp_lib/dashboard_log_util.js", () => ({ pushLog: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_ui_confirm.js", () => ({
  showConfirmDialog: vi.fn(() => Promise.resolve(false)),
  showInputDialog: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: { machines: {}, appSettings: { filamentUnit: "m" } },
  scopedById: vi.fn(),
  setStoredDataForHost: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_spool.js", () => ({
  getCurrentSpool: vi.fn(() => ({ id: "s1", remainingLengthMm: 1000 })),
  getCurrentSpoolId: vi.fn(),
  setCurrentSpoolId: vi.fn(),
  useFilament: vi.fn(),
  getSpoolById: vi.fn(() => null),
  formatFilamentAmount: vi.fn(() => ({ display: "—", g: null })),
  formatUsageHtml: vi.fn(() => "—"),
  usageHeaderLabel: vi.fn(() => "使用量"),
  formatSpoolDisplayId: vi.fn(() => ""),
  buildFilamentRecommendations: vi.fn(() => []),
}));
vi.mock("../../3dp_lib/dashboard_connection.js", () => ({
  sendCommand: vi.fn(),
  fetchStoredData: vi.fn(),
  getDeviceIp: vi.fn(() => "127.0.0.1"),
  getDisplayBaseUrl: vi.fn(() => "http://127.0.0.1"),
  getConnectionState: vi.fn(() => "connected"),
  getPrinterType: vi.fn(() => "creality-k1"),
}));
vi.mock("../../3dp_lib/dashboard_filament_ledger.js", () => ({
  recomputeSpoolFromManualEdit: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_video_player.js", () => ({ showVideoOverlay: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_spool_ui.js", () => ({
  showSpoolDialog: vi.fn(), showSpoolSelectDialog: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_filament_change.js", () => ({
  showHistoryFilamentDialog: vi.fn(() => Promise.resolve(null)),
  updatePreview: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_ui_mapping.js", () => ({
  PRINT_STATE_CODE: { printStarted: 1, printPaused: 2 },
}));
vi.mock("../../3dp_lib/dashboard_aggregator.js", () => ({ getCurrentPrintID: vi.fn(() => 0) }));

const { renderHistoryTable, renderFileList } =
  await import("../../3dp_lib/dashboard_printmanager.js");
const { scopedById } = await import("../../3dp_lib/dashboard_data.js");
const spoolMod = await import("../../3dp_lib/dashboard_spool.js");

/** スコープ付きテーブル（thead+tbody+親）を生成して scopedById に登録する */
function makeTable(tableId) {
  const wrap = document.createElement("div");
  const table = document.createElement("table");
  table.id = tableId;
  const thead = document.createElement("thead");
  const tbody = document.createElement("tbody");
  table.appendChild(thead);
  table.appendChild(tbody);
  wrap.appendChild(table);
  document.body.appendChild(wrap);
  return table;
}

function makeHistoryRows(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: 1000 + i,
    filename: `/usr/data/file_${i}.gcode`,
    printfinish: 1,
    usagematerial: 100 + i,
    usagetime: 60,
    starttime: 1700000000 + i,
    endtime: 1700000600 + i,
  }));
}

function makeFileInfo(n) {
  return {
    totalNum: n,
    entries: Array.from({ length: n }, (_, i) => ({
      number: i + 1,
      filename: `/usr/data/f_${i}.gcode`,
      basename: `f_${i}.gcode`,
      thumbUrl: `http://127.0.0.1/thumb_${i}.png`,
      layer: 100,
      size: 12345,
      mtime: new Date(1700000000000 + i * 1000),
      expect: 200,
      printCount: 0,
    })),
  };
}

describe("renderHistoryTable — 描画律速対策（lazy画像＋イベント委譲）", () => {
  let table;
  const HOST = "K1Max-03FA";

  beforeEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
    table = makeTable("print-history-table");
    scopedById.mockImplementation((id) => (id === "print-history-table" ? table : null));
  });

  it("(A) サムネイル img は loading=lazy / decoding=async", () => {
    renderHistoryTable(makeHistoryRows(5), "http://127.0.0.1", HOST);
    const imgs = table.querySelectorAll("td.col-thumb img");
    expect(imgs.length).toBe(5);
    imgs.forEach((img) => {
      expect(img.getAttribute("loading")).toBe("lazy");
      expect(img.getAttribute("decoding")).toBe("async");
    });
  });

  it("(B) 各行に data-row-index が連番で付与される", () => {
    renderHistoryTable(makeHistoryRows(4), "http://127.0.0.1", HOST);
    const rows = table.querySelectorAll("tbody tr.history-row");
    expect(rows.length).toBe(4);
    rows.forEach((tr, i) => expect(tr.dataset.rowIndex).toBe(String(i)));
  });

  it("(B) tbody のクリックリスナは委譲1本のみ・再描画で二重バインドしない", () => {
    const tbody = table.querySelector("tbody");
    const spy = vi.spyOn(tbody, "addEventListener");
    renderHistoryTable(makeHistoryRows(3), "http://127.0.0.1", HOST);
    renderHistoryTable(makeHistoryRows(6), "http://127.0.0.1", HOST); // 再描画
    const clickBinds = spy.mock.calls.filter((c) => c[0] === "click");
    expect(clickBinds.length).toBe(1);
  });

  it("(C) 行の印刷ボタンクリックが委譲経由で正しい行データを処理する", () => {
    const rows = makeHistoryRows(5);
    renderHistoryTable(rows, "http://127.0.0.1", HOST);
    spoolMod.getCurrentSpool.mockClear();
    const btn = table.querySelectorAll("tbody tr.history-row .cmd-print")[2];
    btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    // handlePrintClick の冒頭で getCurrentSpool(host) を呼ぶ＝委譲ディスパッチ到達の証跡
    expect(spoolMod.getCurrentSpool).toHaveBeenCalledWith(HOST);
  });

  it("(C) 行（ボタン以外）クリックでドリルダウン領域が生成・表示される", () => {
    renderHistoryTable(makeHistoryRows(3), "http://127.0.0.1", HOST);
    const drill = table.parentElement.querySelector(".job-drilldown");
    expect(drill).toBeTruthy();
  });
});

describe("renderFileList — 描画律速対策（lazy画像＋イベント委譲）", () => {
  let table;
  const HOST = "IR3V2";

  beforeEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
    table = makeTable("file-list-table");
    scopedById.mockImplementation((id) =>
      id === "file-list-table" ? table : (id === "file-list-total" ? document.createElement("span") : null));
  });

  it("(A) サムネイル img は loading=lazy / decoding=async", () => {
    renderFileList(makeFileInfo(4), "http://127.0.0.1", HOST);
    const imgs = table.querySelectorAll("td.col-thumb img");
    expect(imgs.length).toBe(4);
    imgs.forEach((img) => {
      expect(img.getAttribute("loading")).toBe("lazy");
      expect(img.getAttribute("decoding")).toBe("async");
    });
  });

  it("(B) 各行に data-row-index・tbody委譲1本のみ（再描画で二重バインドなし）", () => {
    const tbody = table.querySelector("tbody");
    const spy = vi.spyOn(tbody, "addEventListener");
    renderFileList(makeFileInfo(3), "http://127.0.0.1", HOST);
    renderFileList(makeFileInfo(5), "http://127.0.0.1", HOST);
    const rows = table.querySelectorAll("tbody tr.file-row");
    rows.forEach((tr, i) => expect(tr.dataset.rowIndex).toBe(String(i)));
    expect(spy.mock.calls.filter((c) => c[0] === "click").length).toBe(1);
  });

  it("(C) ファイル行の印刷ボタンが委譲経由で正しい行を処理する", () => {
    renderFileList(makeFileInfo(4), "http://127.0.0.1", HOST);
    spoolMod.getCurrentSpool.mockClear();
    const btn = table.querySelectorAll("tbody tr.file-row .cmd-print")[1];
    btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(spoolMod.getCurrentSpool).toHaveBeenCalledWith(HOST);
  });
});
