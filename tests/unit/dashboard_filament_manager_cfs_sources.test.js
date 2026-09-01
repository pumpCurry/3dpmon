/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 フィラメント管理CFS供給源表示単体テスト
 * @file dashboard_filament_manager_cfs_sources.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_filament_manager_cfs_sources_test
 *
 * 【機能内容サマリ】
 * - フィラメント管理ダッシュボードで外部スプールとCFSスロットを別欄として表示することを検証
 * - CFS 1台構成で外部1本+1A-1Dの5 sourceを同時に扱う表示契約を固定
 * - CFS sourceを3DPmon台帳の単一装着スプールへ混ぜないread-only表示を検証
 *
 * 【公開関数一覧】
 * - なし：Vitest による単体テストのみを提供
 *
 * @version 1.390.1584 (PR #440)
 * @since   1.390.1402 (PR #434)
 * @lastModified 2026-09-01 16:39:00
 * -----------------------------------------------------------
 * @todo
 * - none
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { monitorData } from "../../3dp_lib/dashboard_data.js";
import {
  createFilamentManagerMaterialSupplySection,
} from "../../3dp_lib/dashboard_filament_manager.js";
import {
  normalizeK2BoxsInfo,
} from "../../3dp_lib/printer_core/dashboard_normalized_state.js";

const mockState = vi.hoisted(() => ({
  monitorData: {
    appSettings: { connectionTargets: [] },
    machines: {},
    filamentSpools: [],
    materialAccountingPrintBindingStore: {
      schemaVersion: 1,
      authority: "material-accounting-print-binding-shadow-store",
      printStartSnapshots: [],
      usageEvidence: [],
      jobMaterialSegments: [],
      ledgerEvents: [],
      unattributedUsage: [],
      operationsById: {},
      invariants: {
        legacyUsageHistoryWrites: false,
        legacySpoolRemainingWrites: false,
        materialSourceLedgerWrites: "shadow-only",
      },
    },
    materialAccountingSpoolMountStore: {
      schemaVersion: 1,
      authority: "material-accounting-spool-mount-store",
      storeRevision: 0,
      storeDigest: "",
      spoolMounts: [],
      events: [],
      conflicts: [],
      retainedUnsupportedEntries: [],
      invariants: {
        operatorManaged: true,
        deviceObservationWrites: false,
        physicalCommandWrites: false,
        legacyHostSpoolMapWrites: false,
        legacyUsageHistoryWrites: false,
        legacySpoolRemainingWrites: false,
        filamentLedgerWrites: false,
        printBindingWrites: false,
      },
    },
  },
  operatorMountSource: vi.fn(async () => ({ ok: true, action: "mount" })),
  operatorUnmountSource: vi.fn(async () => ({ ok: true, action: "unmount" })),
  operatorReplaceSourceMount: vi.fn(async () => ({ ok: true, action: "replace" })),
  showConfirmDialog: vi.fn(async (options = {}) => {
    if (options.html && typeof document !== "undefined") {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = options.html;
      document.body.appendChild(wrapper);
    }
    return true;
  }),
  target: null,
}));

vi.mock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: mockState.monitorData,
  PLACEHOLDER_HOSTNAME: "__placeholder__",
}));

vi.mock("../../3dp_lib/dashboard_connection.js", () => ({
  getConnectionState: vi.fn(() => "connected"),
  getConnectionTarget: vi.fn(() => mockState.target),
  getPrinterType: vi.fn(() => "creality-k2"),
}));

vi.mock("../../3dp_lib/dashboard_spool.js", () => ({
  SPOOL_STATE: { MOUNTED: "mounted", STORED: "stored", DISCARDED: "discarded", INVENTORY: "inventory" },
  SPOOL_BALANCE_STATE: { OVERDRAWN: "overdrawn" },
  getCurrentSpool: vi.fn(() => null),
  getCurrentSpoolId: vi.fn(() => null),
  getSpools: vi.fn(() => mockState.monitorData.filamentSpools),
  addSpool: vi.fn(),
  updateSpool: vi.fn(),
  addSpoolFromPreset: vi.fn(),
  deleteSpool: vi.fn(),
  setCurrentSpoolId: vi.fn(() => true),
  restoreSpool: vi.fn(),
  getSpoolState: vi.fn(() => "inventory"),
  getSpoolStateLabel: vi.fn(() => "未使用"),
  getSpoolBalanceState: vi.fn(() => "unknown"),
  getSpoolBalanceStateLabel: vi.fn(() => "残量不明"),
  getSpoolMountedLocationLabels: vi.fn(() => []),
  formatSpoolDisplayId: vi.fn((spool) => `#${String(spool?.serialNo || 0).padStart(3, "0")}`),
  formatFilamentAmount: vi.fn((value) => ({ display: `${value}mm` })),
  formatRemainingFilamentAmount: vi.fn((value) => ({ display: `${value}mm` })),
  displayRemainingLengthMm: vi.fn((value) => value),
  buildSpoolAnalytics: vi.fn(() => null),
  buildWasteReport: vi.fn(() => null),
  getSpoolById: vi.fn((id) => mockState.monitorData.filamentSpools.find((spool) => spool.id === id) || null),
  confirmInferredSpool: vi.fn(),
  revertInferredSpool: vi.fn(),
  mountNewSpoolFromPreset: vi.fn(),
}));

vi.mock("../../3dp_lib/dashboard_filament_inventory.js", () => ({
  getInventory: vi.fn(() => []),
  setInventoryQuantity: vi.fn(),
  adjustInventory: vi.fn(),
  setMinStockAlert: vi.fn(),
  isLowStock: vi.fn(() => false),
  getLowStockPresets: vi.fn(() => []),
}));

vi.mock("../../3dp_lib/dashboard_filament_presets.js", () => ({
  FILAMENT_PRESETS: [],
  getAllPresets: vi.fn(() => []),
  addUserPreset: vi.fn(),
  updateUserPreset: vi.fn(),
  deleteUserPreset: vi.fn(),
  isHiddenPreset: vi.fn(() => false),
  togglePresetVisibility: vi.fn(),
  exportUserPresets: vi.fn(),
  importUserPresets: vi.fn(),
}));

vi.mock("../../3dp_lib/dashboard_storage.js", () => ({
  saveUnifiedStorage: vi.fn(),
}));

vi.mock("../../3dp_lib/printer_core/dashboard_material_accounting_mount_runtime.js", () => ({
  createMaterialAccountingSpoolMountRuntime: vi.fn(() => ({
    service: {
      operatorMountSource: mockState.operatorMountSource,
      operatorUnmountSource: mockState.operatorUnmountSource,
      operatorReplaceSourceMount: mockState.operatorReplaceSourceMount,
    },
  })),
}));

vi.mock("../../3dp_lib/dashboard_filament_view.js", () => ({
  createFilamentPreview: vi.fn(),
}));

vi.mock("../../3dp_lib/dashboard_filament_remaining_model.js", () => ({
  buildFilamentRemainingModel: vi.fn(() => ({ confirmedRemainingMm: 0, hasPendingInferredUsage: false })),
}));

vi.mock("../../3dp_lib/dashboard_inferred_candidate_ui.js", () => ({
  createInferredCandidateCenterContent: vi.fn(() => document.createElement("div")),
}));

vi.mock("../../3dp_lib/dashboard_notification_manager.js", () => ({
  showAlert: vi.fn(),
}));

vi.mock("../../3dp_lib/dashboard_ui_confirm.js", () => ({
  showConfirmDialog: mockState.showConfirmDialog,
}));

vi.mock("../../3dp_lib/dashboard_ui_components.js", () => ({
  createEmptyState: vi.fn(() => document.createElement("div")),
}));

vi.mock("../../3dp_lib/dashboard_filament_change.js", () => ({
  showFilamentChangeDialog: vi.fn(),
}));

/**
 * K2 Pro Comboの外部スプールとCFS 1台を含むboxsInfoを返す。
 *
 * 【詳細説明】
 * - 1Cをselectedにし、外部sourceとCFS slot sourceが同時に表示される契約を確認する。
 *
 * @function createK2CfsBoxsInfo
 * @returns {Object} テスト用boxsInfo payload。
 */
function createK2CfsBoxsInfo() {
  return {
    enable: 1,
    materialBoxs: [
      {
        id: 0,
        type: 1,
        state: 1,
        materials: [
          { id: 0, state: 1, type: "PLA", name: "External PLA", color: "#0ffffff", selected: 0, percent: 100 },
        ],
      },
      {
        id: 1,
        type: 0,
        state: 1,
        temp: 28,
        humidity: 55,
        materials: [
          { id: 0, state: 1, type: "PLA", name: "White PLA", color: "#0ffffff", selected: 0, percent: 100 },
          { id: 1, state: 1, type: "PLA", name: "Green PLA", color: "#072a530", selected: 0, percent: 100 },
          { id: 2, state: 1, type: "PLA", name: "Silver PLA", color: "#09ea7ae", selected: 1, percent: 100 },
          { id: 3, state: 0, type: "", name: "", color: "", selected: 0, percent: 0 },
        ],
      },
    ],
    colorMatch: [
      { id: "T1A", boxId: 1, materialId: 0 },
      { id: "T1B", boxId: 1, materialId: 1 },
      { id: "T1C", boxId: 1, materialId: 2 },
    ],
  };
}

/**
 * テスト用monitorDataを初期化する。
 *
 * 【詳細説明】
 * - dashboard_filament_managerは実monitorDataを参照するため、各テストで必要最小限の接続先と
 *   runtime material topologyだけを入れる。
 *
 * @function setupK2Runtime
 * @param {Object=} options - テスト用オプション。
 * @param {string=} options.observedAt - 固定観測日時。
 * @returns {void}
 */
function setupK2Runtime(options = {}) {
  const observedAt = options.observedAt || new Date().toISOString();
  const topology = normalizeK2BoxsInfo(createK2CfsBoxsInfo(), { connected: true });
  topology.provider = {
    ...(topology.provider || {}),
    lastObservedAt: observedAt,
  };
  mockState.target = {
    dest: "192.168.54.153:9999",
    hostname: "K2Pro-69E7",
    printerType: "creality-k2",
    materialSystem: {
      mode: "auto",
      displayMode: "auto",
      unitLimit: 1,
      externalSourceLimit: 1,
    },
  };
  monitorData.appSettings ??= {};
  monitorData.appSettings.connectionTargets = [mockState.target];
  monitorData.filamentSpools = [];
  monitorData.materialAccountingPrintBindingStore = {
    schemaVersion: 1,
    authority: "material-accounting-print-binding-shadow-store",
    printStartSnapshots: [],
    usageEvidence: [],
    jobMaterialSegments: [],
    ledgerEvents: [],
    unattributedUsage: [],
    operationsById: {},
    invariants: {
      legacyUsageHistoryWrites: false,
      legacySpoolRemainingWrites: false,
      materialSourceLedgerWrites: "shadow-only",
    },
  };
  monitorData.materialAccountingSpoolMountStore = {
    schemaVersion: 1,
    authority: "material-accounting-spool-mount-store",
    storeRevision: 0,
    storeDigest: "",
    spoolMounts: [],
    events: [],
    conflicts: [],
    retainedUnsupportedEntries: [],
    invariants: {
      operatorManaged: true,
      deviceObservationWrites: false,
      physicalCommandWrites: false,
      legacyHostSpoolMapWrites: false,
      legacyUsageHistoryWrites: false,
      legacySpoolRemainingWrites: false,
      filamentLedgerWrites: false,
      printBindingWrites: false,
    },
  };
  monitorData.machines = {
    "K2Pro-69E7": {
      runtimeData: {
        printerCoreV3Shadow: {
          state: "observed",
          deviceId: "serial:k2pro-69e7",
          lastObservedAt: observedAt,
          materialProviderLastObservedAt: observedAt,
          lastState: {
            materials: topology,
          },
        },
      },
    },
  };
}

afterEach(() => {
  monitorData.appSettings.connectionTargets = [];
  monitorData.machines = {};
  monitorData.filamentSpools = [];
  monitorData.materialAccountingPrintBindingStore = {
    schemaVersion: 1,
    authority: "material-accounting-print-binding-shadow-store",
    printStartSnapshots: [],
    usageEvidence: [],
    jobMaterialSegments: [],
    ledgerEvents: [],
    unattributedUsage: [],
    operationsById: {},
    invariants: {
      legacyUsageHistoryWrites: false,
      legacySpoolRemainingWrites: false,
      materialSourceLedgerWrites: "shadow-only",
    },
  };
  monitorData.materialAccountingSpoolMountStore = {
    schemaVersion: 1,
    authority: "material-accounting-spool-mount-store",
    storeRevision: 0,
    storeDigest: "",
    spoolMounts: [],
    events: [],
    conflicts: [],
    retainedUnsupportedEntries: [],
    invariants: {
      operatorManaged: true,
      deviceObservationWrites: false,
      physicalCommandWrites: false,
      legacyHostSpoolMapWrites: false,
      legacyUsageHistoryWrites: false,
      legacySpoolRemainingWrites: false,
      filamentLedgerWrites: false,
      printBindingWrites: false,
    },
  };
  mockState.operatorMountSource.mockClear();
  mockState.operatorUnmountSource.mockClear();
  mockState.operatorReplaceSourceMount.mockClear();
  mockState.showConfirmDialog.mockClear();
  mockState.target = null;
});

describe("filament manager CFS material source section", () => {
  it("CFS 1台構成では外部スプールと1A-1Dを別欄の5 sourceとして表示する", () => {
    setupK2Runtime();

    const section = createFilamentManagerMaterialSupplySection("K2Pro-69E7");

    expect(section).not.toBeNull();
    expect(section?.textContent).toContain("機器観測フィラメント");
    expect(section?.querySelectorAll(".fm-material-source-chip")).toHaveLength(5);
    expect(section?.querySelector("fieldset legend")?.textContent).toBe("外部スプール");
    expect([...(section?.querySelectorAll(".fm-material-source-head strong") || [])].map((el) => el.textContent)).toEqual([
      "external",
      "1A",
      "1B",
      "1C",
      "1D",
    ]);
    expect(section?.querySelector(".fm-material-source-chip.is-selected strong")?.textContent).toBe("1C");
    expect(section?.querySelector(".fm-material-source-chip.is-selected .fm-material-source-state")?.textContent).toBe("装填中");
    expect(section?.querySelector(".fm-material-source-chip.is-selected .fm-material-source-selected")?.textContent).toBe("機器選択中");
    const assignment = section?.querySelector(".fm-material-source-assignment");
    expect(assignment?.textContent).toBe("印刷割当 T1A");
    expect(assignment?.getAttribute("title")).toBe("T1A/T1B等は物理CFSスロット名ではなく、印刷/G-code側の割当識別子です。");
    expect(section?.textContent).toContain("管理中スプールとは別情報です");
  });

  it("フィラメント管理内でもCFS観測時刻とsource集計を表示する", () => {
    setupK2Runtime({ observedAt: new Date().toISOString() });

    const section = createFilamentManagerMaterialSupplySection("K2Pro-69E7");

    const meta = section?.querySelector(".fm-material-supply-meta");
    expect(meta).not.toBeNull();
    expect(meta?.textContent).toMatch(/状態: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(meta?.textContent).toContain("装填 4");
    expect(meta?.textContent).toContain("選択中 1");
    expect(meta?.textContent).toContain("CFS 1/1台");
    expect(meta?.textContent).toContain("外部 1");
  });

  it("staleなCFS情報は状態ではなく最終観測時刻として表示する", () => {
    setupK2Runtime({ observedAt: "2026-08-27T12:34:56" });
    monitorData.machines["K2Pro-69E7"].runtimeData.printerCoreV3Shadow.lastState.materials.cfs.topologyState = "stale";

    const section = createFilamentManagerMaterialSupplySection("K2Pro-69E7");

    const meta = section?.querySelector(".fm-material-supply-meta");
    expect(meta?.textContent).toContain("最終観測: 2026-08-27 12:34:56");
    expect(meta?.textContent).not.toContain("状態: 2026-08-27 12:34:56");
    expect(section?.querySelector('[data-source-id="cfs:1:slot:2"] .fm-material-source-state')?.textContent).toBe("最終観測: 装填中");
  });

  it("フィラメント管理内でもunknownとunobservedを別のpresence文言として表示する", () => {
    setupK2Runtime();
    const machine = monitorData.machines["K2Pro-69E7"];
    const sources = machine.runtimeData.printerCoreV3Shadow.lastState.materials.sources;
    sources.find((source) => source.sourceId === "cfs:1:slot:1").presence = "unknown";
    sources.find((source) => source.sourceId === "cfs:1:slot:3").presence = "unobserved";

    const section = createFilamentManagerMaterialSupplySection("K2Pro-69E7");

    expect(section?.querySelector('[data-source-id="cfs:1:slot:1"] .fm-material-source-state')?.textContent).toBe("装填状態 不明");
    expect(section?.querySelector('[data-source-id="cfs:1:slot:3"] .fm-material-source-state')?.textContent).toBe("未観測");
  });

  it("CFS sourceごとの3DPmon管理スプール残量と直近使用量を機器観測とは別行で表示する", () => {
    setupK2Runtime({ observedAt: "2026-08-27T12:34:56.000Z" });
    const source = monitorData.machines["K2Pro-69E7"].runtimeData.printerCoreV3Shadow.lastState.materials.sources
      .find((entry) => entry.sourceId === "cfs:1:slot:2");
    const materialSourceId = "material-source:k2pro-69e7:cfs-1c";
    monitorData.filamentSpools = [{
      id: "spool:1c",
      serialNo: 1,
      name: "CC3D Sand Color",
      materialName: "PLA+",
      totalLengthMm: 336000,
      remainingLengthMm: 268800,
      filamentColor: "#c0b8a0",
    }];
    monitorData.materialAccountingPrintBindingStore.printStartSnapshots.push({
      snapshotId: "snapshot:job-1:1c",
      deviceId: "serial:k2pro-69e7",
      printJobId: "job:4c-benchy",
      printPlanId: "plan:4c-benchy",
      materialSourceId,
      mountId: "mount:1c",
      spoolId: "spool:1c",
      capturedAt: "2026-08-27T12:00:00.000Z",
      materialSource: {
        materialSourceId,
        aliases: [source.sourceId],
        locator: {
          kind: "cfs-slot",
          unitIndex: 1,
          boxId: 1,
          slotIndex: 2,
          protocolSlotId: "1C",
        },
      },
      spoolMount: {
        mountId: "mount:1c",
        materialSourceId,
        spoolId: "spool:1c",
        status: "open",
      },
    });
    monitorData.materialAccountingPrintBindingStore.jobMaterialSegments.push({
      segmentId: "segment:job-1:1c",
      printJobId: "job:4c-benchy",
      printPlanId: "plan:4c-benchy",
      deviceId: "serial:k2pro-69e7",
      materialSourceId,
      mountId: "mount:1c",
      spoolId: "spool:1c",
      usedLengthMm: 3210,
      usageState: "observed-used",
      confidence: "high",
    });
    monitorData.materialAccountingPrintBindingStore.ledgerEvents.push({
      ledgerEventId: "ledger:job-1:1c",
      segmentId: "segment:job-1:1c",
      deviceId: "serial:k2pro-69e7",
      materialSourceId,
      spoolId: "spool:1c",
      usedLengthMm: 3210,
      createdAt: "2026-08-27T13:00:00.000Z",
    });

    const section = createFilamentManagerMaterialSupplySection("K2Pro-69E7");
    const chip = section?.querySelector('[data-source-id="cfs:1:slot:2"]');

    expect(chip?.querySelector(".fm-material-source-managed-spool")?.textContent).toContain("3DPmon管理 #001 CC3D Sand Color");
    expect(chip?.querySelector(".fm-material-source-managed-remaining")?.textContent).toContain("3DPmon残量 268800mm / 80%");
    expect(chip?.querySelector(".fm-material-source-usage")?.textContent).toContain("直近使用 3210mm");
    expect(chip?.textContent).toContain("機器残量 100%");
    expect(chip?.querySelector(".fm-material-source-actions")?.textContent).toContain("設定");
    expect(chip?.querySelector(".fm-material-source-actions")?.textContent).not.toContain("割当解除");
  });

  it("deviceIdが未確定のCFS表示では別機体のaccounting履歴を合流しない", () => {
    setupK2Runtime({ observedAt: "2026-08-27T12:34:56.000Z" });
    monitorData.machines["K2Pro-69E7"].runtimeData.printerCoreV3Shadow.deviceId = null;
    monitorData.machines["K2Pro-69E7"].runtimeData.printerCoreV3Shadow.lastState.identity = {};
    monitorData.materialAccountingPrintBindingStore.printStartSnapshots.push({
      snapshotId: "snapshot:other-device:1c",
      deviceId: "serial:other-k2",
      printJobId: "job:other-device",
      printPlanId: "plan:other-device",
      materialSourceId: "material-source:other-k2:cfs-1c",
      mountId: "mount:other-1c",
      spoolId: "spool:other-1c",
      capturedAt: "2026-08-27T12:00:00.000Z",
      materialSource: {
        materialSourceId: "material-source:other-k2:cfs-1c",
        aliases: ["cfs:1:slot:2"],
        locator: {
          kind: "cfs-slot",
          unitIndex: 1,
          boxId: 1,
          slotIndex: 2,
          protocolSlotId: "1C",
        },
      },
      spoolMount: {
        mountId: "mount:other-1c",
        materialSourceId: "material-source:other-k2:cfs-1c",
        spoolId: "spool:other-1c",
        status: "open",
      },
    });

    const section = createFilamentManagerMaterialSupplySection("K2Pro-69E7");
    const chip = section?.querySelector('[data-source-id="cfs:1:slot:2"]');

    expect(chip?.querySelector(".fm-material-source-managed-spool")).toBeNull();
    expect(chip?.textContent).not.toContain("3DPmon管理");
  });

  it("open SpoolMount storeからCFS複数sourceの3DPmon管理スプールを同時表示する", () => {
    setupK2Runtime({ observedAt: "2026-09-01T07:00:00.000Z" });
    monitorData.filamentSpools = [
      {
        id: "spool:1a",
        serialNo: 1,
        name: "Yellow PLA",
        materialName: "PLA",
        colorName: "Yellow",
        totalLengthMm: 336000,
        remainingLengthMm: 300000,
        filamentColor: "#facc15",
      },
      {
        id: "spool:1b",
        serialNo: 2,
        name: "Orange PLA",
        materialName: "PLA",
        colorName: "Orange",
        totalLengthMm: 336000,
        remainingLengthMm: 250000,
        filamentColor: "#f97316",
      },
    ];
    monitorData.materialAccountingSpoolMountStore.spoolMounts = [
      {
        mountId: "mount:1a",
        mountOperationId: "operation:1a",
        materialSourceId: "material-source:serial-k2pro-69e7:cfs-1:slot-0",
        spoolId: "spool:1a",
        status: "open",
        openedAt: "2026-09-01T06:00:00.000Z",
        verification: "operator-confirmed",
        sourceIdentityStrengthAtOpen: "provisional",
        sourceBindingAtOpen: {
          deviceId: "serial:k2pro-69e7",
          materialSourceId: "cfs:1:slot:0",
          locator: {
            kind: "cfs-slot",
            boxId: 1,
            slotIndex: 0,
            protocolSlotId: "1A",
          },
        },
      },
      {
        mountId: "mount:1b",
        mountOperationId: "operation:1b",
        materialSourceId: "material-source:serial-k2pro-69e7:cfs-1:slot-1",
        spoolId: "spool:1b",
        status: "open",
        openedAt: "2026-09-01T06:05:00.000Z",
        verification: "operator-confirmed",
        sourceIdentityStrengthAtOpen: "provisional",
        sourceBindingAtOpen: {
          deviceId: "serial:k2pro-69e7",
          materialSourceId: "cfs:1:slot:1",
          locator: {
            kind: "cfs-slot",
            boxId: 1,
            slotIndex: 1,
            protocolSlotId: "1B",
          },
        },
      },
    ];

    const section = createFilamentManagerMaterialSupplySection("K2Pro-69E7");
    const chip1a = section?.querySelector('[data-source-id="cfs:1:slot:0"]');
    const chip1b = section?.querySelector('[data-source-id="cfs:1:slot:1"]');

    expect(chip1a?.querySelector(".fm-material-source-managed-spool")?.textContent).toContain("3DPmon管理 #001 Yellow PLA");
    expect(chip1a?.querySelector(".fm-material-source-managed-remaining")?.textContent).toContain("3DPmon残量 300000mm / 89%");
    expect(chip1b?.querySelector(".fm-material-source-managed-spool")?.textContent).toContain("3DPmon管理 #002 Orange PLA");
    expect(chip1b?.querySelector(".fm-material-source-managed-remaining")?.textContent).toContain("3DPmon残量 250000mm / 74%");
  });

  it("sourceカードの設定ボタンはCFS物理操作ではなくoperator mount runtimeへ委譲する", async () => {
    setupK2Runtime({ observedAt: "2026-09-01T07:00:00.000Z" });
    monitorData.filamentSpools = [{
      id: "spool:1a",
      serialNo: 1,
      name: "Yellow PLA",
      materialName: "PLA",
      totalLengthMm: 336000,
      remainingLengthMm: 300000,
      filamentColor: "#facc15",
    }];
    const section = createFilamentManagerMaterialSupplySection("K2Pro-69E7");
    const button = section?.querySelector('[data-source-id="cfs:1:slot:0"] .fm-material-source-actions button');

    button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(mockState.operatorMountSource).toHaveBeenCalledWith(expect.objectContaining({
      expectedDeviceId: "serial:k2pro-69e7",
      materialSourceId: "cfs:1:slot:0",
      spoolId: "spool:1a",
      actor: "filament-manager-ui",
    }));
    expect(mockState.operatorReplaceSourceMount).not.toHaveBeenCalled();
    expect(mockState.operatorUnmountSource).not.toHaveBeenCalled();
  });

  it("sourceカードの割当解除ボタンはexpectedMountId付きでoperator unmount runtimeへ委譲する", async () => {
    setupK2Runtime({ observedAt: "2026-09-01T07:00:00.000Z" });
    monitorData.filamentSpools = [{
      id: "spool:1a",
      serialNo: 1,
      name: "Yellow PLA",
      materialName: "PLA",
      totalLengthMm: 336000,
      remainingLengthMm: 300000,
      filamentColor: "#facc15",
    }];
    monitorData.materialAccountingSpoolMountStore.spoolMounts = [{
      mountId: "mount:1a",
      mountOperationId: "operation:1a",
      materialSourceId: "cfs:1:slot:0",
      spoolId: "spool:1a",
      status: "open",
      openedAt: "2026-09-01T06:00:00.000Z",
      verification: "operator-confirmed",
      sourceIdentityStrengthAtOpen: "provisional",
      sourceBindingAtOpen: {
        deviceId: "serial:k2pro-69e7",
        materialSourceId: "cfs:1:slot:0",
        locator: { kind: "cfs-slot", boxId: 1, slotIndex: 0, protocolSlotId: "1A" },
      },
    }];
    const section = createFilamentManagerMaterialSupplySection("K2Pro-69E7");
    const buttons = [...(section?.querySelectorAll('[data-source-id="cfs:1:slot:0"] .fm-material-source-actions button') || [])];
    const unmountButton = buttons.find((buttonElement) => buttonElement.textContent === "割当解除");

    unmountButton?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(mockState.operatorUnmountSource).toHaveBeenCalledWith(expect.objectContaining({
      materialSourceId: "cfs:1:slot:0",
      expectedMountId: "mount:1a",
      actor: "filament-manager-ui",
      reason: "operator-unmount",
    }));
    expect(mockState.operatorMountSource).not.toHaveBeenCalled();
    expect(mockState.operatorReplaceSourceMount).not.toHaveBeenCalled();
  });

  it("open SpoolMount storeは同じsourceIdでも別deviceIdの装着を混入しない", () => {
    setupK2Runtime({ observedAt: "2026-09-01T07:00:00.000Z" });
    monitorData.filamentSpools = [{
      id: "spool:other",
      serialNo: 77,
      name: "Other Device PLA",
      materialName: "PLA",
      totalLengthMm: 336000,
      remainingLengthMm: 120000,
    }];
    monitorData.materialAccountingSpoolMountStore.spoolMounts = [{
      mountId: "mount:other",
      mountOperationId: "operation:other",
      materialSourceId: "cfs:1:slot:0",
      spoolId: "spool:other",
      status: "open",
      openedAt: "2026-09-01T06:00:00.000Z",
      verification: "operator-confirmed",
      sourceIdentityStrengthAtOpen: "provisional",
      sourceBindingAtOpen: {
        deviceId: "serial:other-k2",
        materialSourceId: "cfs:1:slot:0",
        locator: { kind: "cfs-slot", boxId: 1, slotIndex: 0, protocolSlotId: "1A" },
      },
    }];

    const section = createFilamentManagerMaterialSupplySection("K2Pro-69E7");
    const chip1a = section?.querySelector('[data-source-id="cfs:1:slot:0"]');

    expect(chip1a?.querySelector(".fm-material-source-managed-spool")?.textContent || "").not.toContain("Other Device PLA");
  });

  it("durable MaterialSource IDのopen mountをsourceBinding aliasで現在sourceへ表示する", () => {
    setupK2Runtime({ observedAt: "2026-09-01T07:00:00.000Z" });
    monitorData.materialAccountingPrintBindingStore = {
      schemaVersion: 1,
      authority: "material-accounting-print-binding-shadow-store",
      printStartSnapshots: [],
      usageEvidence: [],
      jobMaterialSegments: [],
      ledgerEvents: [],
      unattributedUsage: [],
      operationsById: {},
      invariants: {
        legacyUsageHistoryWrites: false,
        legacySpoolRemainingWrites: false,
        materialSourceLedgerWrites: "shadow-only",
      },
    };
    monitorData.filamentSpools = [{
      id: "spool:1a",
      serialNo: 1,
      name: "Yellow PLA",
      materialName: "PLA",
      totalLengthMm: 336000,
      remainingLengthMm: 300000,
      filamentColor: "#facc15",
    }];
    monitorData.materialAccountingSpoolMountStore.spoolMounts = [{
      mountId: "mount:1a",
      mountOperationId: "operation:1a",
      materialSourceId: "material-source:serial-k2pro-69e7:cfs-1:slot-0",
      spoolId: "spool:1a",
      status: "open",
      openedAt: "2026-09-01T06:00:00.000Z",
      verification: "operator-confirmed",
      sourceIdentityStrengthAtOpen: "provisional",
      sourceBindingAtOpen: {
        deviceId: "serial:k2pro-69e7",
        materialSourceId: "cfs:1:slot:0",
        locator: { kind: "cfs-slot", boxId: 1, slotIndex: 0, protocolSlotId: "1A" },
      },
    }];

    const section = createFilamentManagerMaterialSupplySection("K2Pro-69E7");
    const chip1a = section?.querySelector('[data-source-id="cfs:1:slot:0"]');

    expect(chip1a?.querySelector(".fm-material-source-managed-spool")?.textContent).toContain("3DPmon管理 #001 Yellow PLA");
  });
});
