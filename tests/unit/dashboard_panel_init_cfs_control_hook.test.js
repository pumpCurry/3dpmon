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
 * @version 1.390.1565 (PR #439)
 * @since   1.390.1381 (PR #432)
 * @lastModified 2026-08-31 21:12:57
 * -----------------------------------------------------------
 * @todo
 * - none
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  renderMaterialTopologyPanel: vi.fn(),
  createMaterialTopologyViewModel: vi.fn(),
  resolveDisplayMaterialTopology: vi.fn(),
  resolveMaterialDisplayMode: vi.fn(),
  resolveMaterialTopologyViewOptions: vi.fn(),
  createBoundCfsControlIntegration: vi.fn(),
  validateRegisteredK2CfsSlotControlCertificationEvidence: vi.fn(),
  createK2CfsCommandTransportPlan: vi.fn(),
  sendK2CfsCommandTransportPlan: vi.fn(),
  createPhysicalCommandRecoveryLatchRecord: vi.fn(),
  appendPhysicalCommandRecoveryLatchRecord: vi.fn(),
  resolvePhysicalCommandRecoveryLatchRecord: vi.fn(),
  isPhysicalCommandRecoveryBlocked: vi.fn(),
  saveUnifiedStorage: vi.fn(),
  boundOnCommand: vi.fn(),
  panelDestroy: vi.fn(),
  connectionTarget: {
    printerType: "creality-k2",
    printerCoreV3Info: {
      model: "F012",
      version: "1.0.0",
      probeSessionId: "test-runtime-probe-session",
      connectionGeneration: 7,
      connectionDest: "192.0.2.10:9999",
      connectionHost: "K2Pro",
    },
    dest: "192.0.2.10:9999",
    materialSystem: {
      mode: "cfs-readonly",
      unitLimit: 1,
      externalSourceLimit: 1,
    },
  },
  sendCommand: vi.fn(),
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
  sendCommand: mockState.sendCommand,
  getConnectionState: vi.fn(() => "connected"),
  getPrinterType: vi.fn(() => "creality-k2"),
  getConnectionTarget: vi.fn(() => mockState.connectionTarget),
  getPrinterCoreV3RuntimeProbeSessionId: vi.fn(() => "test-runtime-probe-session"),
  getPrinterCoreV3ConnectionGeneration: vi.fn(() => 7),
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
  saveUnifiedStorage: mockState.saveUnifiedStorage,
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

vi.mock("../../3dp_lib/printer_core/dashboard_k2_cfs_command_transport.js", () => ({
  K2_CFS_SLOT_CONTROL_PRODUCTION_TRANSPORT_PROFILE: "k2-ws9999-feed-in-or-out-certified-v1",
  createK2CfsCommandTransportPlan: mockState.createK2CfsCommandTransportPlan,
  sendK2CfsCommandTransportPlan: mockState.sendK2CfsCommandTransportPlan,
  validateRegisteredK2CfsSlotControlCertificationEvidence: mockState.validateRegisteredK2CfsSlotControlCertificationEvidence,
}));

vi.mock("../../3dp_lib/printer_core/dashboard_physical_command_recovery_latch.js", () => ({
  PHYSICAL_COMMAND_RECOVERY_LATCH_STATUS: {
    SUBMITTED: "submitted",
    POST_OBSERVED: "post-observed",
    UNKNOWN: "unknown",
    COMPLETED: "completed",
    REJECTED: "rejected",
    FAILED: "failed",
    TIMEOUT: "timeout",
  },
  appendPhysicalCommandRecoveryLatchRecord: mockState.appendPhysicalCommandRecoveryLatchRecord,
  createPhysicalCommandRecoveryLatchRecord: mockState.createPhysicalCommandRecoveryLatchRecord,
  resolvePhysicalCommandRecoveryLatchRecord: mockState.resolvePhysicalCommandRecoveryLatchRecord,
  isPhysicalCommandRecoveryBlocked: mockState.isPhysicalCommandRecoveryBlocked,
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

const activePanelRecords = [];

/**
 * 初期化したパネルをテスト終了時の自動破棄対象として登録する。
 *
 * 【詳細説明】
 * - フィラメントパネルは1秒周期の再描画timerを持つため、テスト内で明示破棄を忘れると
 *   後続テストの一回限りmockを先に消費してしまう。
 * - 実アプリではパネル破棄時にtimerを止めるため、unit testでも同じライフサイクルを再現する。
 *
 * @function initializeTrackedPanel
 * @param {Function} initializePanel - dashboard_panel_init が公開する初期化関数
 * @param {string} panelType - 初期化するパネル種別
 * @param {HTMLElement} panelBody - 初期化対象のパネルbody
 * @param {string} hostname - 対象ホスト名
 * @returns {void}
 */
function initializeTrackedPanel(initializePanel, panelType, panelBody, hostname) {
  initializePanel(panelType, panelBody, hostname);
  activePanelRecords.push({
    panelType,
    panelBody,
    hostname,
  });
}

describe("dashboard_panel_init CFS control hook", () => {
  afterEach(async () => {
    if (activePanelRecords.length > 0) {
      const { destroyPanel } = await import("../../3dp_lib/dashboard_panel_init.js");
      const records = activePanelRecords.splice(0).reverse();
      records.forEach((record) => {
        destroyPanel(record.panelType, record.panelBody, record.hostname);
      });
    }
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  beforeEach(() => {
    vi.resetModules();
    mockState.renderMaterialTopologyPanel.mockReset();
    mockState.createMaterialTopologyViewModel.mockReset();
    mockState.resolveDisplayMaterialTopology.mockReset();
    mockState.resolveMaterialDisplayMode.mockReset();
    mockState.resolveMaterialTopologyViewOptions.mockReset();
    mockState.createBoundCfsControlIntegration.mockReset();
    mockState.validateRegisteredK2CfsSlotControlCertificationEvidence.mockReset();
    mockState.createK2CfsCommandTransportPlan.mockReset();
    mockState.sendK2CfsCommandTransportPlan.mockReset();
    mockState.createPhysicalCommandRecoveryLatchRecord.mockReset();
    mockState.appendPhysicalCommandRecoveryLatchRecord.mockReset();
    mockState.resolvePhysicalCommandRecoveryLatchRecord.mockReset();
    mockState.isPhysicalCommandRecoveryBlocked.mockReset();
    mockState.saveUnifiedStorage.mockReset();
    mockState.boundOnCommand.mockReset();
    mockState.panelDestroy.mockReset();
    mockState.sendCommand.mockReset();
    mockState.connectionTarget = {
      printerType: "creality-k2",
      printerCoreV3Info: {
        model: "F012",
        version: "1.0.0",
        probeSessionId: "test-runtime-probe-session",
        connectionGeneration: 7,
        connectionDest: "192.0.2.10:9999",
        connectionHost: "K2Pro",
      },
      dest: "192.0.2.10:9999",
      materialSystem: {
        mode: "cfs-readonly",
        unitLimit: 1,
        externalSourceLimit: 1,
      },
    };
    mockState.monitorData.machines = {
      K2Pro: {
        runtimeData: {
          printerCoreV3Shadow: {
            deviceId: "device-k2",
            sessionId: "session-1",
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
    mockState.monitorData.physicalCommandRecoveryLatch = {
      unresolvedByCommandId: {},
      conflictedCommandIds: [],
      retainedUnsupportedEntries: [],
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
      units: [{
        slots: [{
          sourceId: "cfs:1:slot:2",
          displaySlot: "1C",
          presence: "loaded",
        }],
      }],
    });
    mockState.renderMaterialTopologyPanel.mockReturnValue({
      update: vi.fn(),
      destroy: mockState.panelDestroy,
    });
    mockState.boundOnCommand.mockResolvedValue({
      accepted: false,
      reason: "cfs-command-integration-disabled",
    });
    mockState.validateRegisteredK2CfsSlotControlCertificationEvidence.mockReturnValue({
      ok: false,
      errors: ["certification-evidence-not-registered"],
    });
    mockState.createK2CfsCommandTransportPlan.mockReturnValue({
      ok: false,
      reason: "invalid-cfs-slot-certification-evidence",
      frames: [],
    });
    mockState.isPhysicalCommandRecoveryBlocked.mockReturnValue({
      blocked: false,
      reason: "not-blocked",
      commandId: "",
    });
    mockState.createPhysicalCommandRecoveryLatchRecord.mockImplementation((input) => ({
      commandId: input.commandId,
      commandKind: input.commandKind,
      deviceId: input.deviceId,
      sessionId: input.sessionId,
      status: input.status,
      materialSourceId: input.materialSourceId,
    }));
    mockState.appendPhysicalCommandRecoveryLatchRecord.mockImplementation((store, record) => ({
      ok: true,
      status: "appended",
      store: {
        unresolvedByCommandId: {
          ...(store?.unresolvedByCommandId || {}),
          [record.commandId]: record,
        },
        conflictedCommandIds: [...(store?.conflictedCommandIds || [])],
        retainedUnsupportedEntries: [...(store?.retainedUnsupportedEntries || [])],
        events: [...(store?.events || [])],
      },
      record,
      reasons: [],
    }));
    mockState.resolvePhysicalCommandRecoveryLatchRecord.mockImplementation((store) => ({
      ok: true,
      status: "resolved",
      store: {
        unresolvedByCommandId: {},
        conflictedCommandIds: [...(store?.conflictedCommandIds || [])],
        retainedUnsupportedEntries: [...(store?.retainedUnsupportedEntries || [])],
        events: [...(store?.events || []), {
          type: "physical-command-recovery-resolved",
          commandId: "cmd:k2-load-1c",
        }],
      },
      record: store?.unresolvedByCommandId?.["cmd:k2-load-1c"] || null,
      reasons: [],
    }));
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
    initializeTrackedPanel(initializePanel, "filament", body, "K2Pro");

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
    expect(typeof options.control.validateCommandIntent).toBe("function");

    expect(options.control.validateCommandIntent({
      sourceId: "cfs:1:slot:2",
      displaySlot: "1C",
    })).toBeNull();

    mockState.createMaterialTopologyViewModel.mockReturnValueOnce({
      summary: {
        topologyState: "stale",
      },
      units: [],
    });
    expect(options.control.validateCommandIntent({
      sourceId: "cfs:1:slot:2",
      displaySlot: "1C",
    })).toBe("CFS情報が最新ではないため操作できません");

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

  it("registry未登録のcertificationEvidenceだけではproduction候補hookを有効化しない", async () => {
    mockState.connectionTarget = {
      printerType: "creality-k2",
      printerCoreV3Info: {
        model: "F012",
        version: "1.0.0",
        probeSessionId: "test-runtime-probe-session",
        connectionGeneration: 7,
        connectionDest: "192.0.2.10:9999",
        connectionHost: "K2Pro",
      },
      dest: "192.0.2.10:9999",
      materialSystem: {
        mode: "cfs-readonly",
        unitLimit: 1,
        externalSourceLimit: 1,
        cfsControl: {
          enabled: true,
          allowedActions: ["load", "unload"],
          certifiedCfsSlotControlCommands: ["cfs-load", "cfs-unload"],
          certificationEvidence: {
            schemaVersion: 1,
            status: "certified",
            gate: "Gate 19",
            commandKinds: ["cfs-load", "cfs-unload"],
            transportProfile: "k2-ws9999-feed-in-or-out-certified-v1",
            printerType: "creality-k2",
            model: "F012",
            firmwareVersion: "1.0.0",
            fixtureId: "k2-f012-feed-in-or-out-20260828",
            captureId: "capture:k2-f012-feed-in-or-out-20260828",
            certifiedAt: "2026-08-28T12:00:00.000+09:00",
          },
        },
      },
    };
    mockState.createMaterialTopologyViewModel.mockReturnValue({
      summary: {
        topologyState: "fresh",
      },
      authority: {
        canSendCommands: false,
        allowedActions: [],
      },
      units: [{
        slots: [{
          sourceId: "cfs:1:slot:2",
          displaySlot: "1C",
          presence: "loaded",
        }],
      }],
    });
    const body = createFilamentPanelBody();
    const {
      initializePanel,
      registerAllPanelInits,
    } = await import("../../3dp_lib/dashboard_panel_init.js");

    registerAllPanelInits();
    initializeTrackedPanel(initializePanel, "filament", body, "K2Pro");

    expect(mockState.createBoundCfsControlIntegration).toHaveBeenCalledWith({
      enabled: false,
      allowedActions: ["select", "load", "unload", "feed", "retract"],
    });
    expect(mockState.renderMaterialTopologyPanel).toHaveBeenCalledTimes(1);
    const [, viewModel, options] = mockState.renderMaterialTopologyPanel.mock.calls[0];
    expect(viewModel.authority).toMatchObject({
      canSendCommands: false,
      allowedActions: [],
    });
    expect(options.control).toMatchObject({
      showControls: true,
      canSendCommands: false,
      allowedActions: ["select", "load", "unload", "feed", "retract"],
      disabledReason: "実機認証前のため3dpmonからのCFS/CFS-C操作は無効です",
    });
  });

  it("certificationEvidenceだけで現在targetのmodel/firmwareが無い場合はproduction CFS controlを有効化しない", async () => {
    mockState.connectionTarget = {
      printerType: "creality-k2",
      materialSystem: {
        mode: "cfs-readonly",
        unitLimit: 1,
        externalSourceLimit: 1,
        cfsControl: {
          enabled: true,
          allowedActions: ["load"],
          certifiedCfsSlotControlCommands: ["cfs-load"],
          certificationEvidence: {
            schemaVersion: 1,
            status: "certified",
            gate: "Gate 19",
            commandKinds: ["cfs-load"],
            transportProfile: "k2-ws9999-feed-in-or-out-certified-v1",
            printerType: "creality-k2",
            model: "F012",
            firmwareVersion: "1.0.0",
            fixtureId: "k2-f012-feed-in-or-out-20260828",
            captureId: "capture:k2-f012-feed-in-or-out-20260828",
            certifiedAt: "2026-08-28T12:00:00.000+09:00",
          },
        },
      },
    };
    const body = createFilamentPanelBody();
    const {
      initializePanel,
      registerAllPanelInits,
    } = await import("../../3dp_lib/dashboard_panel_init.js");

    registerAllPanelInits();
    initializeTrackedPanel(initializePanel, "filament", body, "K2Pro");

    expect(mockState.createBoundCfsControlIntegration).toHaveBeenCalledWith({
      enabled: false,
      allowedActions: ["select", "load", "unload", "feed", "retract"],
    });
    const [, , options] = mockState.renderMaterialTopologyPanel.mock.calls[0];
    expect(options.control.canSendCommands).toBe(false);
  });

  it("Gate20: 再起動前のprinterCoreV3Infoだけではre-probe前にproduction CFS controlを有効化しない", async () => {
    mockState.connectionTarget = {
      printerType: "creality-k2",
      printerCoreV3Info: {
        model: "F012",
        version: "1.0.0",
        probeSessionId: "previous-runtime-probe-session",
        observedAt: "2026-08-28T01:00:00.000Z",
      },
      materialSystem: {
        mode: "cfs-readonly",
        unitLimit: 1,
        externalSourceLimit: 1,
        cfsControl: {
          enabled: true,
          allowedActions: ["load"],
          certifiedCfsSlotControlCommands: ["cfs-load"],
          certificationEvidence: {
            schemaVersion: 1,
            status: "certified",
            gate: "Gate 19",
            commandKinds: ["cfs-load"],
            transportProfile: "k2-ws9999-feed-in-or-out-certified-v1",
            printerType: "creality-k2",
            model: "F012",
            firmwareVersion: "1.0.0",
            fixtureId: "k2-f012-feed-in-or-out-20260828",
            captureId: "capture:k2-f012-feed-in-or-out-20260828",
            certifiedAt: "2026-08-28T12:00:00.000+09:00",
          },
        },
      },
    };
    const body = createFilamentPanelBody();
    const {
      initializePanel,
      registerAllPanelInits,
    } = await import("../../3dp_lib/dashboard_panel_init.js");

    registerAllPanelInits();
    initializeTrackedPanel(initializePanel, "filament", body, "K2Pro");

    expect(mockState.createBoundCfsControlIntegration).toHaveBeenCalledWith({
      enabled: false,
      allowedActions: ["select", "load", "unload", "feed", "retract"],
    });
    const [, , options] = mockState.renderMaterialTopologyPanel.mock.calls[0];
    expect(options.control.canSendCommands).toBe(false);
  });

  it("Gate19 debug: 古いprinterCoreV3InfoをCertificationパネルのcurrent model表示へ使わない", async () => {
    mockState.connectionTarget = {
      printerType: "creality-k2",
      dest: "192.0.2.10:9999",
      printerCoreV3Info: {
        model: "F012",
        version: "1.0.0",
        probeSessionId: "previous-runtime-probe-session",
        connectionGeneration: 7,
        connectionDest: "192.0.2.10:9999",
        connectionHost: "K2Pro",
        observedAt: "2026-08-28T01:00:00.000Z",
      },
      materialSystem: {
        mode: "cfs-readonly",
        unitLimit: 1,
        externalSourceLimit: 1,
      },
    };
    const body = document.createElement("div");
    const {
      destroyPanel,
      initializePanel,
      registerAllPanelInits,
    } = await import("../../3dp_lib/dashboard_panel_init.js");

    registerAllPanelInits();
    initializeTrackedPanel(initializePanel, "cfs-certification", body, "K2Pro");

    expect(body.textContent).toContain("K2Pro / --");
    expect(body.textContent).not.toContain("K2Pro / F012");

    destroyPanel("cfs-certification", body, "K2Pro");
  });

  it("Gate19 debug: staleな第一候補infoがcurrentな第二候補infoを隠さない", async () => {
    mockState.connectionTarget = {
      printerType: "creality-k2",
      dest: "192.0.2.10:9999",
      printerCoreV3Info: {
        model: "STALE_MODEL",
        version: "0.0.1",
        probeSessionId: "previous-runtime-probe-session",
        connectionGeneration: 7,
        connectionDest: "192.0.2.10:9999",
        connectionHost: "K2Pro",
      },
      printerCoreV3HttpInfo: {
        model: "F012",
        version: "1.0.0",
        probeSessionId: "test-runtime-probe-session",
        connectionGeneration: 7,
        connectionDest: "192.0.2.10:9999",
        connectionHost: "K2Pro",
      },
      materialSystem: {
        mode: "cfs-readonly",
        unitLimit: 1,
        externalSourceLimit: 1,
      },
    };
    const body = document.createElement("div");
    const {
      destroyPanel,
      initializePanel,
      registerAllPanelInits,
    } = await import("../../3dp_lib/dashboard_panel_init.js");

    registerAllPanelInits();
    initializeTrackedPanel(initializePanel, "cfs-certification", body, "K2Pro");

    expect(body.textContent).toContain("K2Pro / F012");
    expect(body.textContent).not.toContain("STALE_MODEL");

    destroyPanel("cfs-certification", body, "K2Pro");
  });

  it("Gate19.5 debug: 復旧ラッチstoreに未解決commandがある場合はCertificationパネルpreflightへ表示する", async () => {
    mockState.monitorData.physicalCommandRecoveryLatch = {
      unresolvedByCommandId: {
        "cmd:k2-load-1c": {
          commandId: "cmd:k2-load-1c",
          status: "submitted",
        },
      },
      conflictedCommandIds: [],
      retainedUnsupportedEntries: [],
    };
    mockState.isPhysicalCommandRecoveryBlocked.mockReturnValue({
      blocked: true,
      reason: "unresolved-recovery",
      commandId: "cmd:k2-load-1c",
    });
    const body = document.createElement("div");
    const {
      destroyPanel,
      initializePanel,
      registerAllPanelInits,
    } = await import("../../3dp_lib/dashboard_panel_init.js");

    registerAllPanelInits();
    initializeTrackedPanel(initializePanel, "cfs-certification", body, "K2Pro");

    expect(body.textContent).toContain("復旧確認待ち: unresolved-recovery / cmd:k2-load-1c");
    expect(body.textContent).not.toContain("未解決の復旧ラッチなし");
    expect(mockState.isPhysicalCommandRecoveryBlocked).toHaveBeenCalledWith(
      mockState.monitorData.physicalCommandRecoveryLatch,
      "cmd:k2-load-1c"
    );

    destroyPanel("cfs-certification", body, "K2Pro");
  });

  it("Gate19.5 debug: operator確認で未解決復旧ラッチを解決済みにして保存する", async () => {
    mockState.monitorData.physicalCommandRecoveryLatch = {
      unresolvedByCommandId: {
        "cmd:k2-load-1c": {
          commandId: "cmd:k2-load-1c",
          commandKind: "cfs-load",
          deviceId: "device-k2",
          sessionId: "session-1",
          materialSourceId: "cfs:1:slot:2",
          status: "submitted",
          sentAt: "2026-08-31T07:00:00.000Z",
          digest: "fnv1a128:record-a",
        },
      },
      conflictedCommandIds: [],
      retainedUnsupportedEntries: [],
      events: [],
    };
    mockState.isPhysicalCommandRecoveryBlocked.mockReturnValue({
      blocked: true,
      reason: "unresolved-recovery",
      commandId: "cmd:k2-load-1c",
    });
    const body = document.createElement("div");
    const {
      destroyPanel,
      initializePanel,
      registerAllPanelInits,
    } = await import("../../3dp_lib/dashboard_panel_init.js");

    registerAllPanelInits();
    initializeTrackedPanel(initializePanel, "cfs-certification", body, "K2Pro");

    const button = body.querySelector('[data-action="resolve-recovery-blocker"]');
    expect(button).not.toBeNull();
    button.click();

    expect(mockState.resolvePhysicalCommandRecoveryLatchRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        unresolvedByCommandId: {
          "cmd:k2-load-1c": expect.objectContaining({
            commandId: "cmd:k2-load-1c",
          }),
        },
      }),
      expect.objectContaining({
        commandId: "cmd:k2-load-1c",
        resolution: "operator-cleared",
        expectedDeviceId: "device-k2",
        expectedDigest: "fnv1a128:record-a",
        expectedCommandKind: "cfs-load",
        expectedMaterialSourceId: "cfs:1:slot:2",
      })
    );
    expect(mockState.monitorData.physicalCommandRecoveryLatch.unresolvedByCommandId).toEqual({});
    expect(mockState.saveUnifiedStorage).toHaveBeenCalledWith(true);

    destroyPanel("cfs-certification", body, "K2Pro");
  });

  it("Gate19.5 debug: 別deviceの未解決復旧ラッチは現在panelからoperator解除できない", async () => {
    mockState.monitorData.physicalCommandRecoveryLatch = {
      unresolvedByCommandId: {
        "cmd:k2-load-other": {
          commandId: "cmd:k2-load-other",
          commandKind: "cfs-load",
          deviceId: "device-other",
          sessionId: "session-other",
          materialSourceId: "cfs:1:slot:0",
          status: "submitted",
          sentAt: "2026-08-31T07:00:00.000Z",
          digest: "fnv1a128:record-other",
        },
      },
      conflictedCommandIds: [],
      retainedUnsupportedEntries: [],
      events: [],
    };
    const body = document.createElement("div");
    const {
      destroyPanel,
      initializePanel,
      registerAllPanelInits,
    } = await import("../../3dp_lib/dashboard_panel_init.js");

    registerAllPanelInits();
    initializeTrackedPanel(initializePanel, "cfs-certification", body, "K2Pro");

    expect(body.textContent).toContain("未解決の復旧ラッチなし");
    expect(body.querySelector('[data-action="resolve-recovery-blocker"]')).toBeNull();
    expect(mockState.resolvePhysicalCommandRecoveryLatchRecord).not.toHaveBeenCalled();
    expect(mockState.saveUnifiedStorage).not.toHaveBeenCalled();

    destroyPanel("cfs-certification", body, "K2Pro");
  });

  it("Gate19.5 debug: 表示後に同commandIdのrecord digestが変わった場合は古い解除要求を保存しない", async () => {
    mockState.monitorData.physicalCommandRecoveryLatch = {
      unresolvedByCommandId: {
        "cmd:k2-load-1c": {
          commandId: "cmd:k2-load-1c",
          commandKind: "cfs-load",
          deviceId: "device-k2",
          sessionId: "session-1",
          materialSourceId: "cfs:1:slot:2",
          status: "submitted",
          sentAt: "2026-08-31T07:00:00.000Z",
          digest: "fnv1a128:record-old",
        },
      },
      conflictedCommandIds: [],
      retainedUnsupportedEntries: [],
      events: [],
    };
    mockState.isPhysicalCommandRecoveryBlocked.mockReturnValue({
      blocked: true,
      reason: "unresolved-recovery",
      commandId: "cmd:k2-load-1c",
    });
    mockState.resolvePhysicalCommandRecoveryLatchRecord.mockImplementation((store, resolution) => ({
      ok: false,
      status: "mismatch",
      store,
      record: store?.unresolvedByCommandId?.[resolution?.commandId] || null,
      reasons: ["expected-digest-mismatch"],
    }));
    const body = document.createElement("div");
    const {
      destroyPanel,
      initializePanel,
      registerAllPanelInits,
    } = await import("../../3dp_lib/dashboard_panel_init.js");

    registerAllPanelInits();
    initializeTrackedPanel(initializePanel, "cfs-certification", body, "K2Pro");

    mockState.monitorData.physicalCommandRecoveryLatch = {
      ...mockState.monitorData.physicalCommandRecoveryLatch,
      unresolvedByCommandId: {
        "cmd:k2-load-1c": {
          ...mockState.monitorData.physicalCommandRecoveryLatch.unresolvedByCommandId["cmd:k2-load-1c"],
          digest: "fnv1a128:record-new",
        },
      },
    };

    const button = body.querySelector('[data-action="resolve-recovery-blocker"]');
    expect(button).not.toBeNull();
    button.click();

    expect(mockState.resolvePhysicalCommandRecoveryLatchRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        unresolvedByCommandId: {
          "cmd:k2-load-1c": expect.objectContaining({
            digest: "fnv1a128:record-new",
          }),
        },
      }),
      expect.objectContaining({
        commandId: "cmd:k2-load-1c",
        expectedDeviceId: "device-k2",
        expectedDigest: "fnv1a128:record-old",
      })
    );
    expect(mockState.saveUnifiedStorage).not.toHaveBeenCalled();

    destroyPanel("cfs-certification", body, "K2Pro");
  });

  it("Gate20: 同じruntime probeでも接続世代が古いprinterCoreV3Infoはproduction scopeに使わない", async () => {
    mockState.connectionTarget = {
      printerType: "creality-k2",
      dest: "192.0.2.10:9999",
      printerCoreV3Info: {
        model: "F012",
        version: "1.0.0",
        probeSessionId: "test-runtime-probe-session",
        connectionGeneration: 6,
        connectionDest: "192.0.2.10:9999",
        connectionHost: "K2Pro",
        observedAt: "2026-08-28T01:00:00.000Z",
      },
      materialSystem: {
        mode: "cfs-readonly",
        unitLimit: 1,
        externalSourceLimit: 1,
        cfsControl: {
          enabled: true,
          allowedActions: ["load"],
          certifiedCfsSlotControlCommands: ["cfs-load"],
          certificationEvidence: {
            schemaVersion: 1,
            status: "certified",
            gate: "Gate 19",
            commandKinds: ["cfs-load"],
            transportProfile: "k2-ws9999-feed-in-or-out-certified-v1",
            printerType: "creality-k2",
            model: "F012",
            firmwareVersion: "1.0.0",
            fixtureId: "k2-f012-feed-in-or-out-20260828",
            captureId: "capture:k2-f012-feed-in-or-out-20260828",
            certifiedAt: "2026-08-28T12:00:00.000+09:00",
          },
        },
      },
    };
    const body = createFilamentPanelBody();
    const {
      initializePanel,
      registerAllPanelInits,
    } = await import("../../3dp_lib/dashboard_panel_init.js");

    registerAllPanelInits();
    initializeTrackedPanel(initializePanel, "filament", body, "K2Pro");

    expect(mockState.createBoundCfsControlIntegration).toHaveBeenCalledWith({
      enabled: false,
      allowedActions: ["select", "load", "unload", "feed", "retract"],
    });
    const [, , options] = mockState.renderMaterialTopologyPanel.mock.calls[0];
    expect(options.control.canSendCommands).toBe(false);
  });

  it("Gate20: shadow identityにmodel/firmwareがあってもcurrent /infoなしではproduction scopeに使わない", async () => {
    mockState.connectionTarget = {
      printerType: "creality-k2",
      dest: "192.0.2.10:9999",
      materialSystem: {
        mode: "cfs-readonly",
        unitLimit: 1,
        externalSourceLimit: 1,
        cfsControl: {
          enabled: true,
          allowedActions: ["load"],
          certifiedCfsSlotControlCommands: ["cfs-load"],
          certificationEvidence: {
            schemaVersion: 1,
            status: "certified",
            gate: "Gate 19",
            commandKinds: ["cfs-load"],
            transportProfile: "k2-ws9999-feed-in-or-out-certified-v1",
            printerType: "creality-k2",
            model: "F012",
            firmwareVersion: "1.0.0",
            fixtureId: "k2-f012-feed-in-or-out-20260828",
            captureId: "capture:k2-f012-feed-in-or-out-20260828",
            certifiedAt: "2026-08-28T12:00:00.000+09:00",
          },
        },
      },
    };
    mockState.monitorData.machines.K2Pro = {
      runtimeData: {
        printerCoreV3Shadow: {
          lastState: {
            identity: {
              reportedModel: "F012",
              firmwareVersion: "1.0.0",
            },
          },
        },
      },
    };
    mockState.validateRegisteredK2CfsSlotControlCertificationEvidence.mockReturnValue({
      ok: false,
      errors: ["model-scope-missing-or-mismatch"],
    });
    const body = createFilamentPanelBody();
    const {
      initializePanel,
      registerAllPanelInits,
    } = await import("../../3dp_lib/dashboard_panel_init.js");

    registerAllPanelInits();
    initializeTrackedPanel(initializePanel, "filament", body, "K2Pro");

    expect(mockState.createBoundCfsControlIntegration).toHaveBeenCalledWith({
      enabled: false,
      allowedActions: ["select", "load", "unload", "feed", "retract"],
    });
    expect(mockState.validateRegisteredK2CfsSlotControlCertificationEvidence.mock.calls[0][2]).toMatchObject({
      printerType: "creality-k2",
      model: null,
      firmwareVersion: null,
    });
    const [, , options] = mockState.renderMaterialTopologyPanel.mock.calls[0];
    expect(options.control.canSendCommands).toBe(false);
  });

  it("certificationEvidenceが空objectの場合はproduction CFS controlを有効化しない", async () => {
    mockState.connectionTarget = {
      printerType: "creality-k2",
      materialSystem: {
        mode: "cfs-readonly",
        unitLimit: 1,
        externalSourceLimit: 1,
        cfsControl: {
          enabled: true,
          allowedActions: ["load"],
          certifiedCfsSlotControlCommands: ["cfs-load"],
          certificationEvidence: {},
        },
      },
    };
    const body = createFilamentPanelBody();
    const {
      initializePanel,
      registerAllPanelInits,
    } = await import("../../3dp_lib/dashboard_panel_init.js");

    registerAllPanelInits();
    initializeTrackedPanel(initializePanel, "filament", body, "K2Pro");

    expect(mockState.createBoundCfsControlIntegration).toHaveBeenCalledWith({
      enabled: false,
      allowedActions: ["select", "load", "unload", "feed", "retract"],
    });
    const [, , options] = mockState.renderMaterialTopologyPanel.mock.calls[0];
    expect(options.control.canSendCommands).toBe(false);
  });

  it("legacy aliasのcommandKindsだけではproduction CFS controlを有効化しない", async () => {
    mockState.connectionTarget = {
      printerType: "creality-k2",
      materialSystem: {
        mode: "cfs-readonly",
        unitLimit: 1,
        externalSourceLimit: 1,
        cfsControl: {
          enabled: true,
          allowedActions: ["load"],
          commandKinds: ["cfs-load"],
          certificationEvidence: {
            schemaVersion: 1,
            status: "certified",
            gate: "Gate 19",
            commandKinds: ["cfs-load"],
            transportProfile: "k2-ws9999-feed-in-or-out-certified-v1",
            printerType: "creality-k2",
            model: "F012",
            firmwareVersion: "1.0.0",
            fixtureId: "k2-f012-feed-in-or-out-20260828",
            captureId: "capture:k2-f012-feed-in-or-out-20260828",
            certifiedAt: "2026-08-28T12:00:00.000+09:00",
          },
        },
      },
    };
    const body = createFilamentPanelBody();
    const {
      initializePanel,
      registerAllPanelInits,
    } = await import("../../3dp_lib/dashboard_panel_init.js");

    registerAllPanelInits();
    initializeTrackedPanel(initializePanel, "filament", body, "K2Pro");

    expect(mockState.createBoundCfsControlIntegration).toHaveBeenCalledWith({
      enabled: false,
      allowedActions: ["select", "load", "unload", "feed", "retract"],
    });
    const [, , options] = mockState.renderMaterialTopologyPanel.mock.calls[0];
    expect(options.control.canSendCommands).toBe(false);
  });

  it("K2以外のtargetではcertified CFS control設定があってもproduction有効化しない", async () => {
    mockState.connectionTarget = {
      printerType: "creality-k1",
      materialSystem: {
        mode: "cfs-readonly",
        unitLimit: 1,
        externalSourceLimit: 1,
        cfsControl: {
          enabled: true,
          allowedActions: ["load"],
          certifiedCfsSlotControlCommands: ["cfs-load"],
          certificationEvidence: {
            schemaVersion: 1,
            status: "certified",
            gate: "Gate 19",
            commandKinds: ["cfs-load"],
            transportProfile: "k2-ws9999-feed-in-or-out-certified-v1",
            printerType: "creality-k2",
            model: "F012",
            firmwareVersion: "1.0.0",
            fixtureId: "k2-f012-feed-in-or-out-20260828",
            captureId: "capture:k2-f012-feed-in-or-out-20260828",
            certifiedAt: "2026-08-28T12:00:00.000+09:00",
          },
        },
      },
    };
    const body = createFilamentPanelBody();
    const {
      initializePanel,
      registerAllPanelInits,
    } = await import("../../3dp_lib/dashboard_panel_init.js");

    registerAllPanelInits();
    initializeTrackedPanel(initializePanel, "filament", body, "K2Pro");

    expect(mockState.createBoundCfsControlIntegration).toHaveBeenCalledWith({
      enabled: false,
      allowedActions: ["select", "load", "unload", "feed", "retract"],
    });
  });

  it("registry未登録のCFS control設定ではdispatcher自体をcompositionしない", async () => {
    mockState.connectionTarget = {
      printerType: "creality-k2",
      printerCoreV3Info: {
        model: "F012",
        version: "1.0.0",
        probeSessionId: "test-runtime-probe-session",
        connectionGeneration: 7,
        connectionDest: "192.0.2.10:9999",
        connectionHost: "K2Pro",
      },
      dest: "192.0.2.10:9999",
      materialSystem: {
        mode: "cfs-readonly",
        unitLimit: 1,
        externalSourceLimit: 1,
        cfsControl: {
          enabled: true,
          allowedActions: ["load"],
          certifiedCfsSlotControlCommands: ["cfs-load"],
          certificationEvidence: {
            schemaVersion: 1,
            status: "certified",
            gate: "Gate 19",
            commandKinds: ["cfs-load"],
            transportProfile: "k2-ws9999-feed-in-or-out-certified-v1",
            printerType: "creality-k2",
            model: "F012",
            firmwareVersion: "1.0.0",
            fixtureId: "k2-f012-feed-in-or-out-20260828",
            captureId: "capture:k2-f012-feed-in-or-out-20260828",
            certifiedAt: "2026-08-28T12:00:00.000+09:00",
          },
        },
      },
    };
    const body = createFilamentPanelBody();
    const {
      initializePanel,
      registerAllPanelInits,
    } = await import("../../3dp_lib/dashboard_panel_init.js");

    registerAllPanelInits();
    initializeTrackedPanel(initializePanel, "filament", body, "K2Pro");

    const integrationOptions = mockState.createBoundCfsControlIntegration.mock.calls[0][0];
    expect(integrationOptions).toEqual({
      enabled: false,
      allowedActions: ["select", "load", "unload", "feed", "retract"],
    });
    expect(integrationOptions.dispatcher).toBeUndefined();
    expect(mockState.sendCommand).not.toHaveBeenCalled();
  });

  it("CFSパネルはre-probe後のproduction readinessを同じpanel handleへ再compositionする", async () => {
    vi.useFakeTimers();
    try {
      mockState.connectionTarget = {
        printerType: "creality-k2",
        printerCoreV3Info: {
          model: "F012",
          version: "1.0.0",
          probeSessionId: "test-runtime-probe-session",
          connectionGeneration: 7,
          connectionDest: "192.0.2.10:9999",
          connectionHost: "K2Pro",
        },
        dest: "192.0.2.10:9999",
        materialSystem: {
          mode: "cfs-readonly",
          unitLimit: 1,
          externalSourceLimit: 1,
          cfsControl: {
            enabled: true,
            allowedActions: ["load"],
            certifiedCfsSlotControlCommands: ["cfs-load"],
            certificationEvidence: {
              schemaVersion: 1,
              status: "certified",
              gate: "Gate 19",
              commandKinds: ["cfs-load"],
              transportProfile: "k2-ws9999-feed-in-or-out-certified-v1",
              printerType: "creality-k2",
              model: "F012",
              firmwareVersion: "1.0.0",
              fixtureId: "k2-f012-feed-in-or-out-20260828",
              captureId: "capture:k2-f012-feed-in-or-out-20260828",
              certifiedAt: "2026-08-28T12:00:00.000+09:00",
            },
          },
        },
      };
      mockState.createMaterialTopologyViewModel.mockImplementation((topology, options) => ({
        summary: {
          topologyState: "fresh",
        },
        authority: options.commandAuthority,
        units: [],
      }));
      const updatePanel = vi.fn();
      mockState.renderMaterialTopologyPanel.mockReturnValue({
        update: updatePanel,
        destroy: mockState.panelDestroy,
      });
      mockState.validateRegisteredK2CfsSlotControlCertificationEvidence
        .mockReturnValueOnce({
          ok: false,
          errors: ["certification-evidence-not-registered"],
        })
        .mockReturnValue({
          ok: true,
          errors: [],
        });

      const body = createFilamentPanelBody();
      const {
        destroyPanel,
        initializePanel,
        registerAllPanelInits,
      } = await import("../../3dp_lib/dashboard_panel_init.js");

      registerAllPanelInits();
      initializeTrackedPanel(initializePanel, "filament", body, "K2Pro");

      const [, initialViewModel, initialOptions] = mockState.renderMaterialTopologyPanel.mock.calls[0];
      expect(initialViewModel.authority.canSendCommands).toBe(false);
      expect(initialOptions.control.canSendCommands).toBe(false);

      await vi.advanceTimersByTimeAsync(1100);

      expect(updatePanel).toHaveBeenCalledWith(
        expect.objectContaining({
          authority: expect.objectContaining({
            canSendCommands: true,
            allowedActions: ["load"],
          }),
        }),
        expect.objectContaining({
          control: expect.objectContaining({
            canSendCommands: true,
            allowedActions: ["load"],
          }),
        })
      );

      destroyPanel("filament", body, "K2Pro");
    } finally {
      vi.useRealTimers();
    }
  });

  it("production dispatcherはsend-time topologyへCFS選択証跡を渡す", async () => {
    mockState.connectionTarget = {
      printerType: "creality-k2",
      printerCoreV3Info: {
        model: "F012",
        version: "1.0.0",
        probeSessionId: "test-runtime-probe-session",
        connectionGeneration: 7,
        connectionDest: "192.0.2.10:9999",
        connectionHost: "K2Pro",
      },
      dest: "192.0.2.10:9999",
      materialSystem: {
        mode: "cfs-readonly",
        unitLimit: 1,
        externalSourceLimit: 1,
        cfsControl: {
          enabled: true,
          allowedActions: ["load"],
          certifiedCfsSlotControlCommands: ["cfs-load"],
          certificationEvidence: {
            schemaVersion: 1,
            status: "certified",
            gate: "Gate 19",
            commandKinds: ["cfs-load"],
            transportProfile: "k2-ws9999-feed-in-or-out-certified-v1",
            printerType: "creality-k2",
            model: "F012",
            firmwareVersion: "1.0.0",
            fixtureId: "k2-f012-feed-in-or-out-20260828",
            captureId: "capture:k2-f012-feed-in-or-out-20260828",
            certifiedAt: "2026-08-28T12:00:00.000+09:00",
          },
        },
      },
    };
    mockState.monitorData.machines.K2Pro.runtimeData.printerCoreV3Shadow = {
      state: "observed",
      deviceId: "serial:demo",
      sessionId: "session:1",
      lastSequence: 10,
      lastState: {
        source: {
          sequence: 10,
        },
        print: {
          stateLabel: "idle",
        },
        materials: {
          cfs: {
            connected: true,
            topologyState: "fresh",
          },
          sources: [
            {
              sourceId: "cfs:1:slot:2",
              kind: "cfs-slot",
              boxId: 1,
              protocolSlotId: 2,
              presence: "loaded",
              selected: true,
              status: {
                presence: "loaded",
                stateCode: 1,
                selectionState: "selected",
                selectionValid: true,
              },
              material: {
                type: "PLA",
                color: {
                  displayHex: "ffffff",
                },
              },
            },
            {
              sourceId: "cfs:1:slot:1",
              kind: "cfs-slot",
              boxId: 1,
              protocolSlotId: 1,
              presence: "loaded",
              selected: false,
              status: {
                presence: "loaded",
                stateCode: 1,
                selectionState: "unselected",
                selectionValid: true,
              },
              material: {
                type: "PLA",
                color: {
                  displayHex: "00ff00",
                },
              },
            },
          ],
        },
      },
    };
    mockState.validateRegisteredK2CfsSlotControlCertificationEvidence.mockReturnValue({
      ok: true,
      errors: [],
    });
    mockState.createK2CfsCommandTransportPlan.mockReturnValue({
      ok: true,
      frames: [],
      details: {
        semanticStatus: "certified",
      },
    });
    mockState.sendK2CfsCommandTransportPlan.mockResolvedValue({
      status: "acknowledged",
    });
    mockState.createMaterialTopologyViewModel.mockReturnValue({
      summary: {
        topologyState: "fresh",
      },
      authority: {
        canSendCommands: true,
        allowedActions: ["load"],
      },
      units: [{
        slots: [{
          sourceId: "cfs:1:slot:2",
          displaySlot: "1C",
          presence: "loaded",
          selected: true,
        }],
      }],
    });
    const body = createFilamentPanelBody();
    const {
      createPrinterCommandRequest,
    } = await import("../../3dp_lib/printer_core/dashboard_command_authority.js");
    const {
      initializePanel,
      registerAllPanelInits,
    } = await import("../../3dp_lib/dashboard_panel_init.js");

    registerAllPanelInits();
    initializeTrackedPanel(initializePanel, "filament", body, "K2Pro");

    const integrationOptions = mockState.createBoundCfsControlIntegration.mock.calls[0][0];
    const request = createPrinterCommandRequest({
      deviceId: "serial:demo",
      sessionId: "session:1",
      commandKind: "cfs-load",
      transportKind: "ws9999",
      idempotencyKey: "load-1c",
      createdAt: "2026-08-31T20:19:55.000+09:00",
      entropySource: () => "unit",
      payload: {
        sourceId: "cfs:1:slot:2",
        boxId: 1,
        slotIndex: 2,
      },
    });
    const result = await integrationOptions.dispatcher.dispatch(request);

    expect(result.status).toBe("acknowledged");
    expect(mockState.createK2CfsCommandTransportPlan).toHaveBeenCalledTimes(1);
  });

  it("production controlはsubmittedで戻った物理CFS commandを復旧ラッチへ保存する", async () => {
    mockState.connectionTarget = {
      printerType: "creality-k2",
      printerCoreV3Info: {
        model: "F012",
        version: "1.0.0",
        probeSessionId: "test-runtime-probe-session",
        connectionGeneration: 7,
        connectionDest: "192.0.2.10:9999",
        connectionHost: "K2Pro",
      },
      dest: "192.0.2.10:9999",
      materialSystem: {
        mode: "cfs-readonly",
        unitLimit: 1,
        externalSourceLimit: 1,
        cfsControl: {
          enabled: true,
          allowedActions: ["load"],
          certifiedCfsSlotControlCommands: ["cfs-load"],
          certificationEvidence: {
            schemaVersion: 1,
            status: "certified",
            gate: "Gate 19",
            commandKinds: ["cfs-load"],
            transportProfile: "k2-ws9999-feed-in-or-out-certified-v1",
            printerType: "creality-k2",
            model: "F012",
            firmwareVersion: "1.0.0",
            fixtureId: "k2-f012-feed-in-or-out-20260828",
            captureId: "capture:k2-f012-feed-in-or-out-20260828",
            certifiedAt: "2026-08-28T12:00:00.000+09:00",
          },
        },
      },
    };
    mockState.monitorData.machines.K2Pro.runtimeData.printerCoreV3Shadow = {
      state: "observed",
      deviceId: "serial:demo",
      sessionId: "session:1",
      lastSequence: 10,
      lastState: {
        source: {
          sequence: 10,
        },
        print: {
          stateLabel: "idle",
        },
        materials: {
          cfs: {
            connected: true,
            topologyState: "fresh",
          },
          sources: [{
            sourceId: "cfs:1:slot:2",
            kind: "cfs-slot",
            boxId: 1,
            protocolSlotId: 2,
            presence: "loaded",
            selected: true,
            status: {
              presence: "loaded",
              stateCode: 1,
              selectionState: "selected",
              selectionValid: true,
            },
          }],
        },
      },
    };
    mockState.validateRegisteredK2CfsSlotControlCertificationEvidence.mockReturnValue({
      ok: true,
      errors: [],
    });
    mockState.createK2CfsCommandTransportPlan.mockReturnValue({
      ok: true,
      frames: [],
      details: {
        semanticStatus: "certified",
      },
    });
    mockState.sendK2CfsCommandTransportPlan.mockResolvedValue({
      status: "submitted",
    });
    const submittedRequest = {
      commandId: "cmd:k2-load-1c",
      commandKind: "cfs-load",
      deviceId: "serial:demo",
      sessionId: "session:1",
      transportKind: "ws9999",
      createdAt: "2026-08-31T20:19:55.000+09:00",
      payload: {
        sourceId: "cfs:1:slot:2",
      },
    };
    mockState.createBoundCfsControlIntegration.mockReturnValue({
      onCommand: vi.fn().mockResolvedValue({
        accepted: true,
        request: submittedRequest,
        result: {
          commandId: submittedRequest.commandId,
          commandKind: submittedRequest.commandKind,
          deviceId: submittedRequest.deviceId,
          sessionId: submittedRequest.sessionId,
          status: "submitted",
          transportAccepted: true,
          completed: false,
          postCommandObservation: {
            required: true,
            confirmed: false,
            sentSequence: 10,
            observedSequence: null,
          },
        },
      }),
    });
    mockState.createMaterialTopologyViewModel.mockReturnValue({
      summary: {
        topologyState: "fresh",
      },
      authority: {
        canSendCommands: true,
        allowedActions: ["load"],
      },
      units: [{
        slots: [{
          sourceId: "cfs:1:slot:2",
          displaySlot: "1C",
          presence: "loaded",
          selected: true,
        }],
      }],
    });
    const body = createFilamentPanelBody();
    const {
      initializePanel,
      registerAllPanelInits,
    } = await import("../../3dp_lib/dashboard_panel_init.js");

    registerAllPanelInits();
    initializeTrackedPanel(initializePanel, "filament", body, "K2Pro");

    const [, , options] = mockState.renderMaterialTopologyPanel.mock.calls[0];
    const dispatchResult = await options.control.onCommand({
      action: "load",
      commandKind: "cfs-load",
      sourceId: "cfs:1:slot:2",
      displaySlot: "1C",
      unitIndex: 0,
      slotIndex: 2,
      boxId: 1,
      protocolSlotId: 2,
    });

    expect(dispatchResult.accepted).toBe(true);
    expect(dispatchResult.result.status).toBe("submitted");
    expect(mockState.createPhysicalCommandRecoveryLatchRecord).toHaveBeenCalledWith(expect.objectContaining({
      commandId: submittedRequest.commandId,
      commandKind: "cfs-load",
      deviceId: "serial:demo",
      sessionId: "session:1",
      connectionGeneration: 7,
      status: "submitted",
      materialSourceId: "cfs:1:slot:2",
      certificationId: "capture:k2-f012-feed-in-or-out-20260828",
    }));
    expect(mockState.appendPhysicalCommandRecoveryLatchRecord).toHaveBeenCalledTimes(1);
    expect(mockState.saveUnifiedStorage).toHaveBeenCalledWith(true);
    expect(mockState.monitorData.physicalCommandRecoveryLatch.unresolvedByCommandId[submittedRequest.commandId])
      .toMatchObject({
        commandKind: "cfs-load",
        status: "submitted",
      });
  });

  it("production controlは次観測で確認されたselectの復旧ラッチをobserved-confirmedで解決する", async () => {
    mockState.connectionTarget = {
      printerType: "creality-k2",
      printerCoreV3Info: {
        model: "F012",
        version: "1.0.0",
        probeSessionId: "test-runtime-probe-session",
        connectionGeneration: 7,
        connectionDest: "192.0.2.10:9999",
        connectionHost: "K2Pro",
      },
      dest: "192.0.2.10:9999",
      materialSystem: {
        mode: "cfs-readonly",
        unitLimit: 1,
        externalSourceLimit: 1,
        cfsControl: {
          enabled: true,
          allowedActions: ["select"],
          certifiedCfsSlotControlCommands: ["cfs-slot-select"],
          certificationEvidence: {
            schemaVersion: 1,
            status: "certified",
            gate: "Gate 19",
            commandKinds: ["cfs-slot-select"],
            transportProfile: "k2-ws9999-feed-in-or-out-certified-v1",
            printerType: "creality-k2",
            model: "F012",
            firmwareVersion: "1.0.0",
            fixtureId: "k2-f012-feed-in-or-out-20260828",
            captureId: "capture:k2-f012-feed-in-or-out-20260828",
            certifiedAt: "2026-08-28T12:00:00.000+09:00",
          },
        },
      },
    };
    mockState.monitorData.physicalCommandRecoveryLatch = {
      unresolvedByCommandId: {
        "cmd:k2-select-1b": {
          commandId: "cmd:k2-select-1b",
          status: "post-observed",
        },
      },
      conflictedCommandIds: [],
      retainedUnsupportedEntries: [],
      events: [],
    };
    mockState.validateRegisteredK2CfsSlotControlCertificationEvidence.mockReturnValue({
      ok: true,
      errors: [],
    });
    const body = createFilamentPanelBody();
    const {
      initializePanel,
      registerAllPanelInits,
    } = await import("../../3dp_lib/dashboard_panel_init.js");

    registerAllPanelInits();
    initializeTrackedPanel(initializePanel, "filament", body, "K2Pro");

    const [, , options] = mockState.renderMaterialTopologyPanel.mock.calls[0];
    options.control.onCommandReconciled({
      commandId: "cmd:k2-select-1b",
      resolution: "observed-confirmed",
      sourceId: "cfs:1:slot:1",
      postObservation: {
        sequence: 12,
        digest: "material-topology-observation:2026-08-28T01:00:05.000Z",
        observedAt: "2026-08-28T01:00:05.000Z",
      },
    });

    expect(mockState.resolvePhysicalCommandRecoveryLatchRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        unresolvedByCommandId: {
          "cmd:k2-select-1b": expect.objectContaining({
            commandId: "cmd:k2-select-1b",
          }),
        },
      }),
      expect.objectContaining({
        commandId: "cmd:k2-select-1b",
        resolution: "observed-confirmed",
        postObservation: expect.objectContaining({
          digest: "material-topology-observation:2026-08-28T01:00:05.000Z",
        }),
      })
    );
    expect(mockState.saveUnifiedStorage).toHaveBeenCalledWith(true);
  });

  it("production dispatcherはsend-time recovery blockerをtransport前に反映する", async () => {
    mockState.connectionTarget = {
      printerType: "creality-k2",
      printerCoreV3Info: {
        model: "F012",
        version: "1.0.0",
        probeSessionId: "test-runtime-probe-session",
        connectionGeneration: 7,
        connectionDest: "192.0.2.10:9999",
        connectionHost: "K2Pro",
      },
      dest: "192.0.2.10:9999",
      materialSystem: {
        mode: "cfs-readonly",
        unitLimit: 1,
        externalSourceLimit: 1,
        cfsControl: {
          enabled: true,
          allowedActions: ["load"],
          certifiedCfsSlotControlCommands: ["cfs-load"],
          certificationEvidence: {
            schemaVersion: 1,
            status: "certified",
            gate: "Gate 19",
            commandKinds: ["cfs-load"],
            transportProfile: "k2-ws9999-feed-in-or-out-certified-v1",
            printerType: "creality-k2",
            model: "F012",
            firmwareVersion: "1.0.0",
            fixtureId: "k2-f012-feed-in-or-out-20260828",
            captureId: "capture:k2-f012-feed-in-or-out-20260828",
            certifiedAt: "2026-08-28T12:00:00.000+09:00",
          },
        },
      },
    };
    mockState.monitorData.machines.K2Pro.runtimeData.printerCoreV3Shadow = {
      state: "observed",
      deviceId: "serial:demo",
      sessionId: "session:1",
      lastSequence: 10,
      lastState: {
        print: {
          stateLabel: "idle",
        },
        materials: {
          cfs: {
            connected: true,
            topologyState: "fresh",
          },
          sources: [{
            sourceId: "cfs:1:slot:2",
            kind: "cfs-slot",
            boxId: 1,
            protocolSlotId: 2,
            presence: "loaded",
            selected: true,
            status: {
              presence: "loaded",
              stateCode: 1,
              selectionState: "selected",
              selectionValid: true,
            },
          }],
        },
      },
    };
    mockState.validateRegisteredK2CfsSlotControlCertificationEvidence.mockReturnValue({
      ok: true,
      errors: [],
    });
    mockState.isPhysicalCommandRecoveryBlocked.mockReturnValue({
      blocked: true,
      reason: "integrity-quarantine",
      commandId: "cmd:serial%3Ademo:session%3A1:cfs-load:unit%3Aload-1c",
      quarantineReason: "command-id-storage-key-mismatch",
    });
    const body = createFilamentPanelBody();
    const {
      createPrinterCommandRequest,
    } = await import("../../3dp_lib/printer_core/dashboard_command_authority.js");
    const {
      initializePanel,
      registerAllPanelInits,
    } = await import("../../3dp_lib/dashboard_panel_init.js");

    registerAllPanelInits();
    initializeTrackedPanel(initializePanel, "filament", body, "K2Pro");

    const integrationOptions = mockState.createBoundCfsControlIntegration.mock.calls[0][0];
    const request = createPrinterCommandRequest({
      deviceId: "serial:demo",
      sessionId: "session:1",
      commandKind: "cfs-load",
      transportKind: "ws9999",
      idempotencyKey: "load-1c",
      createdAt: "2026-08-31T20:19:55.000+09:00",
      entropySource: () => "unit",
      payload: {
        sourceId: "cfs:1:slot:2",
        boxId: 1,
        slotIndex: 2,
      },
    });
    const result = await integrationOptions.dispatcher.dispatch(request);

    expect(result.status).toBe("rejected");
    expect(result.error.errors).toContain("cfs-recovery-blocked:integrity-quarantine");
    expect(mockState.createK2CfsCommandTransportPlan).not.toHaveBeenCalled();
    expect(mockState.isPhysicalCommandRecoveryBlocked).toHaveBeenCalledWith(
      mockState.monitorData.physicalCommandRecoveryLatch,
      request.commandId
    );
  });
});
