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
 * @version 1.390.1404 (PR #434)
 * @since   1.390.1365 (PR #432)
 * @lastModified 2026-08-26 23:45:00
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
  formatRemainingFilamentAmount: vi.fn(() => ({ display: "—", g: null })),
  formatUsageHtml: vi.fn(() => "—"),
  usageHeaderLabel: vi.fn(() => "使用量"),
  formatSpoolDisplayId: vi.fn(() => ""),
  buildFilamentRecommendations: vi.fn(() => []),
  getAttributionPresentation: vi.fn(() => ({ state: "known", label: null, reason: null, severity: "none" })),
  countAttributionIssuesForHost: vi.fn(() => 0),
  getAttributionIssueIdsForHost: vi.fn(() => new Set()),
  countUnattributedArchiveForHost: vi.fn(() => 0),
}));
vi.mock("../../3dp_lib/dashboard_connection.js", () => ({
  sendCommand: vi.fn(),
  fetchStoredData: vi.fn(),
  getDeviceIp: vi.fn(() => "127.0.0.1"),
  getDisplayBaseUrl: vi.fn(() => "http://127.0.0.1"),
  getConnectionState: vi.fn(() => "connected"),
  getPrinterType: vi.fn(() => "creality-k1"),
  getConnectionTarget: vi.fn(() => null),
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
const { scopedById, monitorData } = await import("../../3dp_lib/dashboard_data.js");
const spoolMod = await import("../../3dp_lib/dashboard_spool.js");
const aggMod = await import("../../3dp_lib/dashboard_aggregator.js");
const confirmMod = await import("../../3dp_lib/dashboard_ui_confirm.js");
const connectionMod = await import("../../3dp_lib/dashboard_connection.js");

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

async function flushAsyncPrintClick() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("renderHistoryTable — 描画律速対策（lazy画像＋イベント委譲）", () => {
  let table;
  const HOST = "K1Max-03FA";

  beforeEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
    monitorData.machines = {};
    monitorData.appSettings = { filamentUnit: "m" };
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

  it("K2/CFS観測済みなら台帳スプール未装着を物理未装着として警告しない", async () => {
    const nowIso = new Date().toISOString();
    spoolMod.getCurrentSpool.mockReturnValue(null);
    connectionMod.getPrinterType.mockReturnValue("creality-k2");
    connectionMod.getConnectionTarget.mockReturnValue({
      hostname: HOST,
      printerType: "creality-k2",
      materialSystem: {
        mode: "cfs-readonly",
        displayMode: "auto",
        unitLimit: 1,
        slotsPerUnit: 4,
        externalSourceLimit: 1,
      },
    });
    monitorData.machines[HOST] = {
      runtimeData: {
        printerCoreV3Shadow: {
          state: "observed",
          lastObservedAt: nowIso,
          materialProviderLastObservedAt: nowIso,
          lastState: {
            materials: {
              cfs: { connected: true, enabled: true, topologyState: "fresh" },
              provider: { lastObservedAt: nowIso },
              units: [{ unitId: "cfs:1", boxId: 1, observedSlotCount: 4 }],
              sources: [{
                sourceId: "cfs:1:slot:2",
                kind: "cfs-slot",
                unitId: "cfs:1",
                boxId: 1,
                slotId: 2,
                material: {
                  type: "PLA",
                  name: "Silver PLA",
                  color: { raw: "#A7ADB1", normalized: "a7adb1" },
                },
                status: {
                  stateCode: 1,
                  selected: true,
                  remaining: {
                    rawPercent: 54,
                    normalizedPercent: 54,
                    valid: true,
                  },
                },
              }],
              assignments: [],
            },
          },
        },
      },
    };

    renderHistoryTable(makeHistoryRows(1), "http://127.0.0.1", HOST);
    const btn = table.querySelector("tbody tr.history-row .cmd-print");
    btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();

    const dialogArg = confirmMod.showConfirmDialog.mock.calls.at(-1)?.[0];
    expect(dialogArg?.html).toContain("CFS/CFS-C供給を観測");
    expect(dialogArg?.html).toContain("1C Silver PLA (PLA)");
    expect(dialogArg?.html).toContain("CFSスロット割当");
    expect(dialogArg?.html).not.toContain("スプール未装着");
    expect(dialogArg?.confirmText).toBe("CFS割当で印刷する");
  });

  it("K2/CFSファイル印刷はopGcodeFileではなくcolorMatchからmultiColorPrintを送る", async () => {
    table = makeTable("file-list-table");
    scopedById.mockImplementation((id) => (id === "file-list-table" ? table : null));
    const nowIso = new Date().toISOString();
    spoolMod.getCurrentSpool.mockReturnValue(null);
    connectionMod.getPrinterType.mockReturnValue("creality-k2");
    connectionMod.getConnectionTarget.mockReturnValue({
      hostname: HOST,
      printerType: "creality-k2",
      materialSystem: {
        mode: "cfs-readonly",
        displayMode: "auto",
        unitLimit: 1,
        slotsPerUnit: 4,
        externalSourceLimit: 1,
      },
    });
    confirmMod.showConfirmDialog.mockImplementationOnce(async ({ html }) => {
      const holder = document.createElement("div");
      holder.innerHTML = html;
      document.body.appendChild(holder);
      const select = holder.querySelector(".pm-cfs-print-source-select");
      expect(select).toBeTruthy();
      select.value = "cfs:1:slot:1";
      return true;
    });
    monitorData.machines[HOST] = {
      runtimeData: {
        printerCoreV3Shadow: {
          state: "observed",
          lastObservedAt: nowIso,
          materialProviderLastObservedAt: nowIso,
          lastState: {
            materials: {
              cfs: { connected: true, enabled: true, topologyState: "fresh" },
              provider: { lastObservedAt: nowIso },
              units: [{ unitId: "cfs:1", boxId: 1, observedSlotCount: 4 }],
              sources: [
                {
                  sourceId: "cfs:1:slot:0",
                  kind: "cfs-slot",
                  unitId: "cfs:1",
                  boxId: 1,
                  slotId: 0,
                  material: {
                    type: "PLA",
                    name: "White PLA",
                    color: { raw: "#0ffffff", normalized: "ffffff", displayHex: "ffffff" },
                  },
                  status: { stateCode: 1, selected: false },
                },
                {
                  sourceId: "cfs:1:slot:1",
                  kind: "cfs-slot",
                  unitId: "cfs:1",
                  boxId: 1,
                  slotId: 1,
                  material: {
                    type: "PLA",
                    name: "Green PLA",
                    color: { raw: "#072a530", normalized: "72a530", displayHex: "72a530" },
                  },
                  status: { stateCode: 1, selected: true },
                },
              ],
              assignments: [
                {
                  assignmentId: "T1B",
                  namespace: "creality-color-match",
                  sourceId: "cfs:1:slot:1",
                  resolution: "resolved",
                },
              ],
            },
          },
        },
      },
    };

    renderFileList({
      totalNum: 1,
      entries: [{
        number: 1,
        filename: "/mnt/UDISK/printer_data/gcodes/single.gcode",
        basename: "single.gcode",
        thumbUrl: "",
        layer: 10,
        size: 1234,
        mtime: new Date(),
        expect: 200,
        printCount: 0,
        material: "PLA",
        materialColors: "#00ff00",
        match: "T1A=T1B ",
        sourceProtocol: "retGcodeFileInfo2",
      }],
    }, "http://127.0.0.1", HOST);
    const btn = table.querySelector("tbody tr.file-row .cmd-print");
    btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await flushAsyncPrintClick();

    expect(connectionMod.sendCommand).toHaveBeenCalledTimes(2);
    expect(connectionMod.sendCommand.mock.calls[0]).toEqual([
      "set",
      {
        colorMatch: {
          path: "/mnt/UDISK/printer_data/gcodes/single.gcode",
          list: [
            { id: "T1A", type: "PLA", color: "72a530", boxId: 1, materialId: 1 },
          ],
        },
      },
      HOST,
    ]);
    expect(connectionMod.sendCommand.mock.calls[1]).toEqual([
      "set",
      {
        multiColorPrint: {
          gcode: "/mnt/UDISK/printer_data/gcodes/single.gcode",
          enableSelfTest: 0,
        },
      },
      HOST,
    ]);
    expect(JSON.stringify(connectionMod.sendCommand.mock.calls)).not.toContain("opGcodeFile");
  });

  it("K2/CFSがstaleなら印刷開始frameを送らない", async () => {
    table = makeTable("file-list-table");
    scopedById.mockImplementation((id) => (id === "file-list-table" ? table : null));
    const nowIso = new Date(Date.now() - 120_000).toISOString();
    spoolMod.getCurrentSpool.mockReturnValue(null);
    connectionMod.getPrinterType.mockReturnValue("creality-k2");
    connectionMod.getConnectionTarget.mockReturnValue({
      hostname: HOST,
      printerType: "creality-k2",
      materialSystem: {
        mode: "cfs-readonly",
        displayMode: "auto",
        unitLimit: 1,
        slotsPerUnit: 4,
        externalSourceLimit: 1,
      },
    });
    confirmMod.showConfirmDialog.mockResolvedValueOnce(true);
    monitorData.machines[HOST] = {
      runtimeData: {
        printerCoreV3Shadow: {
          state: "observed",
          lastObservedAt: nowIso,
          materialProviderLastObservedAt: nowIso,
          lastState: {
            materials: {
              cfs: { connected: true, enabled: true, topologyState: "fresh" },
              provider: { lastObservedAt: nowIso },
              units: [{ unitId: "cfs:1", boxId: 1, observedSlotCount: 4 }],
              sources: [{
                sourceId: "cfs:1:slot:0",
                kind: "cfs-slot",
                unitId: "cfs:1",
                boxId: 1,
                slotId: 0,
                material: {
                  type: "PLA",
                  name: "White PLA",
                  color: { raw: "#0ffffff", normalized: "ffffff", displayHex: "ffffff" },
                },
                status: { stateCode: 1, selected: true },
              }],
              assignments: [],
            },
          },
        },
      },
    };

    renderFileList({
      totalNum: 1,
      entries: [{
        number: 1,
        filename: "/mnt/UDISK/printer_data/gcodes/stale.gcode",
        basename: "stale.gcode",
        thumbUrl: "",
        layer: 10,
        size: 1234,
        mtime: new Date(),
        expect: 200,
        printCount: 0,
        material: "PLA",
        materialColors: "#ffffff",
        match: "T1A=T1A ",
        sourceProtocol: "retGcodeFileInfo2",
      }],
    }, "http://127.0.0.1", HOST);
    const btn = table.querySelector("tbody tr.file-row .cmd-print");
    btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await flushAsyncPrintClick();

    const dialogArg = confirmMod.showConfirmDialog.mock.calls.at(-1)?.[0];
    expect(dialogArg?.html).toContain("CFS割当不可");
    expect(dialogArg?.confirmText).toBe("OK");
    expect(connectionMod.sendCommand).not.toHaveBeenCalled();
  });

  it("K2/CFSでselectedのみ観測されloadedではないslotは供給あり扱いしない", async () => {
    const nowIso = new Date().toISOString();
    spoolMod.getCurrentSpool.mockReturnValue(null);
    connectionMod.getPrinterType.mockReturnValue("creality-k2");
    connectionMod.getConnectionTarget.mockReturnValue({
      hostname: HOST,
      printerType: "creality-k2",
      materialSystem: {
        mode: "cfs-readonly",
        displayMode: "auto",
        unitLimit: 1,
        slotsPerUnit: 4,
        externalSourceLimit: 1,
      },
    });
    monitorData.machines[HOST] = {
      runtimeData: {
        printerCoreV3Shadow: {
          state: "observed",
          lastObservedAt: nowIso,
          materialProviderLastObservedAt: nowIso,
          lastState: {
            materials: {
              cfs: { connected: true, enabled: true, topologyState: "fresh" },
              provider: { lastObservedAt: nowIso },
              units: [{ unitId: "cfs:1", boxId: 1, observedSlotCount: 4 }],
              sources: [{
                sourceId: "cfs:1:slot:2",
                kind: "cfs-slot",
                unitId: "cfs:1",
                boxId: 1,
                slotId: 2,
                material: {},
                status: { selected: true },
              }],
              assignments: [],
            },
          },
        },
      },
    };

    renderHistoryTable(makeHistoryRows(1), "http://127.0.0.1", HOST);
    const btn = table.querySelector("tbody tr.history-row .cmd-print");
    btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();

    const dialogArg = confirmMod.showConfirmDialog.mock.calls.at(-1)?.[0];
    expect(dialogArg?.html).toContain("CFS/CFS-C供給を取得待ち");
    expect(dialogArg?.html).toContain("CFS割当不可");
    expect(dialogArg?.html).not.toContain("スプール未装着");
    expect(dialogArg?.confirmText).toBe("OK");
  });

  it("(C) 行（ボタン以外）クリックでドリルダウン領域が生成・表示される", () => {
    renderHistoryTable(makeHistoryRows(3), "http://127.0.0.1", HOST);
    const drill = table.parentElement.querySelector(".job-drilldown");
    expect(drill).toBeTruthy();
  });

  it("(D) 印刷中(storedData.state=printStarted)の現在ジョブは ▶(result-active)になる（runtimeData.state が NaN でも）", () => {
    const CURID = 1781739950;
    // ★ K1 は state 欠落メッセージで runtimeData.state が "NaN" に化けるが、
    //   storedData.state(機器報告の生値)で判定して印刷中ジョブを ▶ にする回帰防止。
    monitorData.machines[HOST] = {
      storedData: { state: { rawValue: 1 /* printStarted */ } },
      runtimeData: { state: "NaN" },
    };
    aggMod.getCurrentPrintID.mockReturnValue(CURID);

    renderHistoryTable(
      [{ id: CURID, filename: "/x/cur.gcode", starttime: CURID, usagetime: 0, printfinish: 0 }],
      "http://127.0.0.1", HOST
    );

    const row = table.querySelector("tbody tr.history-row");
    const finishSpan = row?.querySelector(".col-finish span");
    expect(finishSpan?.className, "現在の印刷ジョブは ▶(result-active)").toBe("result-active");
    expect(finishSpan?.textContent).toBe("▶");
    expect(row?.classList.contains("history-row-printing"), "印刷中行ハイライト").toBe(true);
    aggMod.getCurrentPrintID.mockReturnValue(0);
    delete monitorData.machines[HOST];
  });

  it("(E) 中止確定(discontinued)の行は ⏹(result-aborted)＋ツールチップで描画される", () => {
    aggMod.getCurrentPrintID.mockReturnValue(0); // 稼働中ジョブなし
    // discontinued=true / 未確定(finishTime なし=usagetime0) の非カレント行
    renderHistoryTable(
      [{ id: 1234, filename: "/x/aborted.gcode", starttime: 1234, usagetime: 0,
         printfinish: null, discontinued: true }],
      "http://127.0.0.1", HOST
    );
    const span = table.querySelector("tbody tr.history-row .col-finish span");
    expect(span?.className).toBe("result-aborted");
    expect(span?.textContent).toBe("⏹");
    expect(span?.getAttribute("title"), "中止理由のツールチップ").toContain("中止");
  });

  it("(E) discontinued でない未確定行は従来どおり …(result-pending)", () => {
    aggMod.getCurrentPrintID.mockReturnValue(0);
    renderHistoryTable(
      [{ id: 1234, filename: "/x/pending.gcode", starttime: 1234, usagetime: 0, printfinish: null }],
      "http://127.0.0.1", HOST
    );
    const span = table.querySelector("tbody tr.history-row .col-finish span");
    expect(span?.className).toBe("result-pending");
    expect(span?.textContent).toBe("…");
    expect(span?.hasAttribute("title"), "通常未確定にはツールチップを付けない").toBe(false);
  });

  it("(F) 帰属未確認ジョブの行に「未確認」チップが付く（Phase5 U2）", () => {
    spoolMod.getAttributionPresentation.mockReturnValue(
      { state: "pending", label: "未確認", reason: "unattributed", severity: "warning" }
    );
    renderHistoryTable(makeHistoryRows(1), "http://127.0.0.1", HOST);
    const chip = table.querySelector("td.col-spool .attr-chip");
    expect(chip).not.toBeNull();
    expect(chip.textContent).toBe("未確認");
  });

  it("(F) 確定ジョブの行にはチップが付かない", () => {
    spoolMod.getAttributionPresentation.mockReturnValue(
      { state: "known", label: null, reason: null, severity: "none" }
    );
    renderHistoryTable(makeHistoryRows(1), "http://127.0.0.1", HOST);
    expect(table.querySelector("td.col-spool .attr-chip")).toBeNull();
  });
});

describe("renderFileList — 描画律速対策（lazy画像＋イベント委譲）", () => {
  let table;
  const HOST = "IR3V2";

  beforeEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
    monitorData.machines = {};
    monitorData.appSettings = { filamentUnit: "m" };
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

  it("K2 retGcodeFileInfo2 のprinter-local thumbnail pathをdownloads/humbnail URLへ正規化する", () => {
    connectionMod.getPrinterType.mockReturnValue("creality-k2");
    renderFileList({
      totalNum: 1,
      entries: [{
        number: 1,
        filename: "/mnt/UDISK/printer_data/gcodes/3DBench_PLA_21m.gcode",
        basename: "3DBench_PLA_21m.gcode",
        thumbUrl: "/mnt/UDISK/creality/local_gcode/humbnail/3DBench_PLA_21m.png",
        layer: 25,
        size: 2740121,
        mtime: new Date(1700000000000),
        expect: 7468,
        printCount: 0,
      }],
    }, "http://127.0.0.1", HOST);

    const img = table.querySelector("td.col-thumb img");
    expect(img?.getAttribute("src")).toBe("http://127.0.0.1/downloads/humbnail/3DBench_PLA_21m.png");
  });

  it("Moonraker/IR3の既存thumbUrlはK2用downloads/humbnail正規化に巻き込まない", () => {
    connectionMod.getPrinterType.mockReturnValue("moonraker");
    renderFileList({
      totalNum: 1,
      entries: [{
        number: 1,
        filename: "gcodes/ir3_sample.gcode",
        basename: "ir3_sample.gcode",
        thumbUrl: "server/files/gcodes/.thumbs/ir3_sample.png",
        layer: 10,
        size: 1200,
        mtime: new Date(1700000000000),
        expect: 120,
        printCount: 0,
      }],
    }, "http://127.0.0.1", HOST);

    const img = table.querySelector("td.col-thumb img");
    expect(img?.getAttribute("src")).toBe("server/files/gcodes/.thumbs/ir3_sample.png");
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
