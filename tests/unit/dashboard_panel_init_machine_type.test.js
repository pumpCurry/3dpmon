/**
 * @fileoverview dashboard_panel_init.js machine type visibility の単体テスト
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  printerType: "creality-k1",
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
vi.mock("../../3dp_lib/dashboard_filament_view.js", () => ({ createFilamentPreview: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_filament_change.js", () => ({ showFilamentChangeDialog: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_filament_manager.js", () => ({ showFilamentManager: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_log_util.js", () => ({
  initLogAutoScroll: vi.fn(),
  initLogRenderer: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_data.js", () => ({ monitorData: { machines: {} } }));
vi.mock("../../3dp_lib/dashboard_spool.js", () => ({
  getCurrentSpool: vi.fn(),
  setCurrentSpoolId: vi.fn(),
  formatSpoolDisplayId: vi.fn(),
  weightFromLength: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_notification_manager.js", () => ({ showAlert: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_connection.js", () => ({
  getDeviceIp: vi.fn(),
  getDisplayBaseUrl: vi.fn(),
  sendCommand: vi.fn(),
  getPrinterType: vi.fn(() => mockState.printerType),
}));
vi.mock("../../3dp_lib/dashboard_printmanager.js", () => ({}));
vi.mock("../../3dp_lib/dashboard_production.js", () => ({
  buildFleetSummary: vi.fn(),
  buildDailyProductionReport: vi.fn(),
  buildEstimateVsActual: vi.fn(),
  buildJobCostReport: vi.fn(),
  buildHostRanking: vi.fn(),
  buildMaterialReport: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_storage.js", () => ({ saveUnifiedStorage: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_ui_components.js", () => ({ createEmptyState: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_send_command.js", () => ({
  initializeCommandPalette: vi.fn(),
  initializeRateControls: vi.fn(),
  initSendRawJson: vi.fn(),
  initSendGcode: vi.fn(),
  initTestRawJson: vi.fn(),
  initPauseHome: vi.fn(),
  initXYUnlock: vi.fn(),
}));

describe("dashboard_panel_init machine type visibility", () => {
  it("creality-k2ではK1専用UIとMoonraker専用UIをどちらも隠す", async () => {
    mockState.printerType = "creality-k2";
    const { initializePanel } = await import("../../3dp_lib/dashboard_panel_init.js");
    const panelBody = document.createElement("div");
    const k1Only = document.createElement("button");
    const moonrakerOnly = document.createElement("button");
    k1Only.dataset.machineType = "k1-only";
    moonrakerOnly.dataset.machineType = "moonraker-only";
    panelBody.append(k1Only, moonrakerOnly);

    initializePanel("unknown-test-panel", panelBody, "K2Pro-69E7");

    expect(k1Only.classList.contains("hidden")).toBe(true);
    expect(moonrakerOnly.classList.contains("hidden")).toBe(true);
  });

  it("moonrakerではMoonraker専用UIだけを表示する", async () => {
    mockState.printerType = "moonraker";
    const { initializePanel } = await import("../../3dp_lib/dashboard_panel_init.js");
    const panelBody = document.createElement("div");
    const k1Only = document.createElement("button");
    const moonrakerOnly = document.createElement("button");
    k1Only.dataset.machineType = "k1-only";
    moonrakerOnly.dataset.machineType = "moonraker-only";
    panelBody.append(k1Only, moonrakerOnly);

    initializePanel("unknown-test-panel", panelBody, "IR3V2");

    expect(k1Only.classList.contains("hidden")).toBe(true);
    expect(moonrakerOnly.classList.contains("hidden")).toBe(false);
  });
});
