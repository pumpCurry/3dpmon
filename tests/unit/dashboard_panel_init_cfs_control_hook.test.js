/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 CFS control hook パネル初期化テスト
 * @file dashboard_panel_init_cfs_control_hook.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_panel_init_cfs_control_hook_test
 *
 * 【機能内容サマリ】
 * - 通常フィラメントパネルのCFS表示がfail-closed操作hookをrendererへ渡すことを検証
 * - production有効化前にCFS操作がdispatcher/transportへ流れないことを検証
 *
 * 【公開関数一覧】
 * - なし：Vitest による単体テストのみを提供
 *
 * @version 1.390.1382 (PR #432)
 * @since   1.390.1381 (PR #432)
 * @lastModified 2026-08-25 22:35:00
 * -----------------------------------------------------------
 * @todo
 * - none
 *
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  renderMaterialTopologyPanel: vi.fn(),
  createMaterialTopologyViewModel: vi.fn(),
  resolveDisplayMaterialTopology: vi.fn(),
  resolveMaterialDisplayMode: vi.fn(),
  resolveMaterialTopologyViewOptions: vi.fn(),
  createBoundCfsControlIntegration: vi.fn(),
  boundOnCommand: vi.fn(),
  panelDestroy: vi.fn(),
  monitorData: {
    machines: {},
    appSettings: {
      connectionTargets: [],
    },
  },
}));

vi.mock("../../3dp_lib/dashboard_chart.js", () => ({
  initTemperatureGraph: vi.fn(),
  resetTemperatureGraph: vi.fn(),
  resetTemperatureGraphView: vi.fn(),
  toggleChartInteractionLock: vi.fn(),
  setChartWindowMinutes: vi.fn(),
  setChartViewMinutes: vi.fn(),
}));

vi.mock("../../3dp_lib/dashboard_camera_ctrl.js", () => ({
  registerCameraPanel: vi.fn(),
  unregisterCameraPanel: vi.fn(),
  startCameraStream: vi.fn(),
  stopCameraStream: vi.fn(),
}));

vi.mock("../../3dp_lib/dashboard_stage_preview.js", () => ({
  restoreXYPreviewState: vi.fn(),
  initXYPreview: vi.fn(),
  registerPreviewPanel: vi.fn(),
  replayPreviewState: vi.fn(),
  destroyPreviewPanel: vi.fn(),
  setPrinterModel: vi.fn(),
  setFlatView: vi.fn(),
  setTilt45View: vi.fn(),
  setObliqueView: vi.fn(),
  toggleZSpin: vi.fn(),
}));

vi.mock("../../3dp_lib/dashboard_filament_view.js", () => ({
  createFilamentPreview: vi.fn(),
}));

vi.mock("../../3dp_lib/dashboard_filament_change.js", () => ({
  showFilamentChangeDialog: vi.fn(),
}));

vi.mock("../../3dp_lib/dashboard_filament_manager.js", () => ({
  showFilamentManager: vi.fn(),
}));

vi.mock("../../3dp_lib/dashboard_log_util.js", () => ({
  initLogAutoScroll: vi.fn(),
  initLogRenderer: vi.fn(),
}));

vi.mock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: mockState.monitorData,
}));

vi.mock("../../3dp_lib/dashboard_spool.js", () => ({
  getCurrentSpool: vi.fn(),
  setCurrentSpoolId: vi.fn(),
  formatSpoolDisplayId: vi.fn(),
  weightFromLength: vi.fn(),
}));

vi.mock("../../3dp_lib/dashboard_notification_manager.js", () => ({
  showAlert: vi.fn(),
}));

vi.mock("../../3dp_lib/dashboard_connection.js", () => ({
  getDeviceIp: vi.fn(),
  getDisplayBaseUrl: vi.fn(),
  sendCommand: vi.fn(),
  getPrinterType: vi.fn(() => "creality-k2"),
  getConnectionTarget: vi.fn(() => ({
    printerType: "creality-k2",
    materialSystem: {
      mode: "cfs-readonly",
      unitLimit: 1,
      externalSourceLimit: 1,
    },
  })),
}));

vi.mock("../../3dp_lib/dashboard_printmanager.js", () => ({
  applyFilamentUnitToUI: vi.fn(),
}));

vi.mock("../../3dp_lib/dashboard_production.js", () => ({
  buildFleetSummary: vi.fn(),
  buildDailyProductionReport: vi.fn(),
  buildEstimateVsActual: vi.fn(),
  buildJobCostReport: vi.fn(),
  buildHostRanking: vi.fn(),
  buildMaterialReport: vi.fn(),
}));

vi.mock("../../3dp_lib/dashboard_storage.js", () => ({
  saveUnifiedStorage: vi.fn(),
}));

vi.mock("../../3dp_lib/dashboard_ui_components.js", () => ({
  createEmptyState: vi.fn(),
}));

vi.mock("../../3dp_lib/dashboard_send_command.js", () => ({
  initializeCommandPalette: vi.fn(),
  initializeRateControls: vi.fn(),
  initSendRawJson: vi.fn(),
  initSendGcode: vi.fn(),
  initTestRawJson: vi.fn(),
  initPauseHome: vi.fn(),
  initXYUnlock: vi.fn(),
}));

vi.mock("../../3dp_lib/printer_core/dashboard_material_system_settings.js", () => ({
  MATERIAL_DISPLAY_MODE: {
    LEGACY_CARD: "legacy-card",
    MULTI_SLOT: "multi-slot",
  },
  resolveDisplayMaterialTopology: mockState.resolveDisplayMaterialTopology,
  resolveMaterialDisplayMode: mockState.resolveMaterialDisplayMode,
  resolveMaterialTopologyViewOptions: mockState.resolveMaterialTopologyViewOptions,
}));

vi.mock("../../3dp_lib/printer_core/dashboard_material_topology_view_model.js", () => ({
  createMaterialTopologyViewModel: mockState.createMaterialTopologyViewModel,
}));

vi.mock("../../3dp_lib/printer_core/dashboard_material_topology_panel.js", () => ({
  renderMaterialTopologyPanel: mockState.renderMaterialTopologyPanel,
}));

vi.mock("../../3dp_lib/printer_core/dashboard_cfs_command_integration.js", () => ({
  createBoundCfsControlIntegration: mockState.createBoundCfsControlIntegration,
}));

/**
 * CFSモード用の最小フィラメントパネルDOMを生成する。
 *
 * 【詳細説明】
 * - initFilamentPanel が参照するpreview containerとlegacy操作ボタンだけを用意する。
 *
 * @function createFilamentPanelBody
 * @returns {HTMLElement} テスト用パネルbody
 */
function createFilamentPanelBody() {
  const body = document.createElement("div");
  body.innerHTML = `
    <div id="filament-preview"></div>
    <button id="filament-change-btn" type="button"></button>
    <button id="filament-remove-btn" type="button"></button>
    <button id="filament-list-btn" type="button"></button>
  `;
  return body;
}

describe("dashboard_panel_init CFS control hook", () => {
  beforeEach(() => {
    vi.resetModules();
    mockState.renderMaterialTopologyPanel.mockReset();
    mockState.createMaterialTopologyViewModel.mockReset();
    mockState.resolveDisplayMaterialTopology.mockReset();
    mockState.resolveMaterialDisplayMode.mockReset();
    mockState.resolveMaterialTopologyViewOptions.mockReset();
    mockState.createBoundCfsControlIntegration.mockReset();
    mockState.boundOnCommand.mockReset();
    mockState.panelDestroy.mockReset();
    mockState.monitorData.machines = {
      K2Pro: {
        runtimeData: {
          printerCoreV3Shadow: {
            lastState: {
              materials: {
                cfs: {
                  connected: true,
                  topologyState: "fresh",
                },
              },
            },
          },
        },
      },
    };
    mockState.resolveDisplayMaterialTopology.mockReturnValue({
      cfs: {
        connected: true,
        topologyState: "fresh",
      },
    });
    mockState.resolveMaterialDisplayMode.mockReturnValue("multi-slot");
    mockState.resolveMaterialTopologyViewOptions.mockReturnValue({
      unitLimit: 1,
      slotsPerUnit: 4,
      externalSourceLimit: 1,
    });
    mockState.createMaterialTopologyViewModel.mockReturnValue({
      summary: {
        topologyState: "fresh",
      },
      authority: {
        canSendCommands: false,
        allowedActions: [],
      },
    });
    mockState.renderMaterialTopologyPanel.mockReturnValue({
      update: vi.fn(),
      destroy: mockState.panelDestroy,
    });
    mockState.boundOnCommand.mockResolvedValue({
      accepted: false,
      reason: "cfs-command-integration-disabled",
    });
    mockState.createBoundCfsControlIntegration.mockReturnValue({
      onCommand: mockState.boundOnCommand,
    });
    document.body.innerHTML = "";
  });

  it("CFSフィラメントパネルはproduction未有効のcontrol hookをrendererへ渡す", async () => {
    const body = createFilamentPanelBody();
    const {
      destroyPanel,
      initializePanel,
      registerAllPanelInits,
    } = await import("../../3dp_lib/dashboard_panel_init.js");

    registerAllPanelInits();
    initializePanel("filament", body, "K2Pro");

    expect(body.classList.contains("filament-panel-cfs-mode")).toBe(true);
    expect(body.querySelector("#filament-change-btn")?.disabled).toBe(true);
    expect(body.querySelector("#filament-remove-btn")?.disabled).toBe(true);
    expect(mockState.createBoundCfsControlIntegration).toHaveBeenCalledWith({
      enabled: false,
      allowedActions: ["select", "load", "unload", "feed", "retract"],
    });
    expect(mockState.renderMaterialTopologyPanel).toHaveBeenCalledTimes(1);
    const [, , options] = mockState.renderMaterialTopologyPanel.mock.calls[0];
    expect(options.hostname).toBe("K2Pro");
    expect(options.control).toMatchObject({
      showControls: true,
      canSendCommands: false,
      allowedActions: ["select", "load", "unload", "feed", "retract"],
      disabledReason: "実機認証前のため3dpmonからのCFS/CFS-C操作は無効です",
    });
    expect(typeof options.control.onCommand).toBe("function");

    const result = await options.control.onCommand({
      action: "select",
      commandKind: "cfs-slot-select",
      sourceId: "cfs:1:slot:2",
    });

    expect(result).toEqual({
      accepted: false,
      reason: "cfs-command-integration-disabled",
    });
    expect(mockState.boundOnCommand).toHaveBeenCalledWith(
      {
        action: "select",
        commandKind: "cfs-slot-select",
        sourceId: "cfs:1:slot:2",
      }
    );

    destroyPanel("filament", body, "K2Pro");
    expect(mockState.panelDestroy).toHaveBeenCalledTimes(1);
  });
});
