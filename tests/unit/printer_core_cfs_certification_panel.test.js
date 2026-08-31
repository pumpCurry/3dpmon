/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 CFS Certification パネルDOM描画単体テスト
 * @file printer_core_cfs_certification_panel.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_cfs_certification_panel_test
 *
 * 【機能内容サマリ】
 * - Hybrid Filament UI案のCFS Debug / Certification パネルを検証
 * - read-only probe、preflight、dry-run、live arm、evidence timeline、exportの表示契約を固定
 * - 未認証状態でLIVE送信が実行できないことを検証
 *
 * 【公開関数一覧】
 * - なし：Vitest による単体テストのみを提供
 *
 * @version 1.390.1565 (PR #439)
 * @since   1.390.1469 (PR #436)
 * @lastModified 2026-08-31 21:12:57
 * -----------------------------------------------------------
 * @todo
 * - none
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from "vitest";
import {
  createCfsCertificationExportBundle,
  createCfsCertificationPanelViewModel,
  renderCfsCertificationPanel,
} from "../../3dp_lib/printer_core/dashboard_cfs_certification_panel.js";

/**
 * CFS Certification パネル用の代表material view modelを生成する。
 *
 * 【詳細説明】
 * - 外部スプールとCFS slotを分離し、1Cが装填中/機器選択中/印刷割当T1Cである状態を使う。
 *
 * @function createMaterialViewModel
 * @returns {object} テスト用material topology view model
 */
function createMaterialViewModel() {
  return {
    summary: {
      topologyState: "fresh",
      loadedSourceCount: 4,
      selectedSourceCount: 1,
      cfsUnitCount: 1,
      cfsSlotCapacity: 4,
    },
    observation: {
      lastObservedAt: "2026-08-29T09:00:00.000Z",
      request: { state: "idle" },
    },
    external: [
      {
        sourceId: "external:0",
        displaySlot: "external",
        kind: "external-spool",
        presence: "empty",
        selected: false,
        assignments: [],
        material: { type: null, name: null },
        status: { remaining: { displayPercent: null, valid: null } },
      },
    ],
    units: [
      {
        displayUnit: 1,
        boxId: 1,
        observed: true,
        slots: [
          {
            sourceId: "cfs:1:slot:0",
            displaySlot: "1A",
            kind: "cfs-slot",
            boxId: 1,
            slotIndex: 0,
            protocolSlotId: 0,
            presence: "loaded",
            selected: false,
            assignments: [{ assignmentId: "T1A" }],
            material: { type: "PLA", name: "White PLA" },
            status: {
              remaining: { displayPercent: 95, valid: true },
              selectionState: "unselected",
              selectionValid: true,
            },
          },
          {
            sourceId: "cfs:1:slot:2",
            displaySlot: "1C",
            kind: "cfs-slot",
            boxId: 1,
            slotIndex: 2,
            protocolSlotId: 2,
            presence: "loaded",
            selected: true,
            assignments: [{ assignmentId: "T1C" }],
            material: { type: "PLA", name: "Silver PLA" },
            status: {
              remaining: { displayPercent: 54, valid: true },
              selectionState: "selected",
              selectionValid: true,
            },
          },
        ],
      },
    ],
  };
}

describe("dashboard_cfs_certification_panel", () => {
  it("B Hybrid案の広いCertificationパネルをread-only/dry-run中心に描画する", () => {
    const viewModel = createCfsCertificationPanelViewModel({
      printer: {
        displayName: "K2Pro-69E7",
        model: "F012",
        firmwareVersion: "1.0.0",
        deviceId: "device-k2",
        sessionId: "session-1",
        transportKind: "ws9999",
        active: true,
      },
      materialViewModel: createMaterialViewModel(),
      command: {
        commandKind: "cfs-load",
      },
      dryRunPlan: {
        ok: true,
        certificationOnly: true,
        requiresLiveConfirmation: true,
        transportKind: "ws9999",
        profile: "k2-ws9999-feed-in-or-out-candidate-v1",
        frames: [{ method: "set", params: { feedInOrOut: { boxId: 1, materialId: 2, isFeed: 1 } } }],
        details: {
          commandKind: "cfs-load",
          sourceId: "cfs:1:slot:2",
          semanticStatus: "uncertified",
        },
      },
      execution: {
        status: "submitted",
      },
    });

    const container = document.createElement("div");
    const onLiveSend = vi.fn();
    const onExport = vi.fn();
    renderCfsCertificationPanel(container, viewModel, {
      onLiveSend,
      onExport,
    });

    expect(container.textContent).toContain("CFS Debug / Certification");
    expect(container.textContent).toContain("K2Pro-69E7 / F012");
    expect(container.textContent).toContain("Read-only Probe");
    expect(container.textContent).toContain("Preflight");
    expect(container.textContent).toContain("Dry-run");
    expect(container.textContent).toContain("Live Arm");
    expect(container.textContent).toContain("Evidence timeline");
    expect(container.textContent).toContain("証跡エクスポート");
    expect(container.textContent).toContain("1C");
    expect(container.textContent).toContain("印刷割当 T1C");
    expect(container.textContent).toContain("送信済み / 物理確認待ち");

    const liveButton = container.querySelector('[data-action="live-send"]');
    expect(liveButton).not.toBeNull();
    expect(liveButton.disabled).toBe(true);
    liveButton.click();
    expect(onLiveSend).not.toHaveBeenCalled();

    const exportButton = container.querySelector('[data-export-format="json"]');
    exportButton.click();
    expect(onExport).toHaveBeenCalledWith(
      "json",
      expect.objectContaining({
        manifest: expect.objectContaining({
          panel: "cfs-debug-certification",
          sourceId: "cfs:1:slot:2",
          commandKind: "cfs-load",
        }),
      })
    );
  });

  it("sessionやsourceに束縛されていないarmはLIVE送信不可として表示する", () => {
    const viewModel = createCfsCertificationPanelViewModel({
      printer: {
        displayName: "K2Pro-69E7",
        model: "F012",
        deviceId: "device-k2",
        sessionId: "session-new",
        active: true,
      },
      materialViewModel: createMaterialViewModel(),
      command: {
        commandKind: "cfs-unload",
      },
      arm: {
        armed: true,
        boundDeviceId: "device-k2",
        boundSessionId: "session-old",
        boundSourceId: "cfs:1:slot:0",
        boundCommandKind: "cfs-unload",
      },
      dryRunPlan: {
        ok: true,
        certificationOnly: true,
        details: {
          semanticStatus: "uncertified",
        },
      },
    });

    const container = document.createElement("div");
    renderCfsCertificationPanel(container, viewModel);

    expect(container.textContent).toContain("ARM無効");
    expect(container.textContent).toContain("session/source変更");
    expect(container.querySelector('[data-action="live-send"]').disabled).toBe(true);
  });

  it("export bundleはraw /infoやRFIDをredactionし、canonical protocol eventsをNDJSON対象にする", () => {
    const viewModel = createCfsCertificationPanelViewModel({
      printer: {
        displayName: "K2Pro-69E7",
        model: "F012",
        deviceId: "device-k2",
        sessionId: "session-1",
        active: true,
      },
      materialViewModel: createMaterialViewModel(),
      dryRunPlan: {
        ok: true,
        details: {
          commandKind: "cfs-load",
          sourceId: "cfs:1:slot:2",
          semanticStatus: "uncertified",
        },
      },
      evidence: {
        info: {
          observedAt: "2026-08-29T10:00:00.000Z",
          payload: {
            mac: "FCEE280E69E7",
            sn: "905251280E69E7",
            ip: "192.168.54.153",
            hostname: "K2Pro-69E7",
          },
        },
        events: [
          { kind: "outbound", payload: { url: "ws://192.168.54.153:9999", rfid: "ABCDEF123456" } },
          { kind: "marker", name: "operator-cfs-load" },
        ],
      },
    });

    const bundle = createCfsCertificationExportBundle(viewModel);
    const serialized = JSON.stringify(bundle);

    expect(bundle.manifest.redactionApplied).toBe(true);
    expect(bundle.events).toHaveLength(2);
    expect(bundle.summaryTimeline[0]).toMatchObject({ label: "証跡未記録" });
    expect(serialized).not.toContain("FCEE280E69E7");
    expect(serialized).not.toContain("905251280E69E7");
    expect(serialized).not.toContain("192.168.54.153");
    expect(serialized).not.toContain("K2Pro-69E7");
    expect(serialized).not.toContain("ABCDEF123456");
    expect(serialized).toContain("<MAC_001>");
    expect(serialized).toContain("<SERIAL_001>");
    expect(serialized).toContain("<IP_001>");
    expect(serialized).toContain("<HOSTNAME_001>");
    expect(serialized).toContain("<RFID_001>");
  });

  it("export bundleはboxsInfo probe summaryをraw evidenceとは別に抽出する", () => {
    const viewModel = createCfsCertificationPanelViewModel({
      printer: {
        displayName: "K2Pro-69E7",
        model: "F012",
        deviceId: "device-k2",
        sessionId: "session-1",
        active: true,
      },
      materialViewModel: createMaterialViewModel(),
      evidence: {
        beforeBoxsInfo: {
          observedAt: "2026-08-31T07:00:00.000Z",
          summary: {
            observedAt: "1999-01-01T00:00:00.000Z",
            selectedSourceIds: ["cfs:1:slot:0"],
            targetSource: { sourceId: "cfs:1:slot:2", presence: "loaded" },
            loadedSourceCount: 3,
          },
        },
        afterBoxsInfo: {
          observedAt: "2026-08-31T07:00:03.000Z",
          summary: {
            observedAt: "1999-01-01T00:00:01.000Z",
            selectedSourceIds: ["cfs:1:slot:2"],
            targetSource: { sourceId: "cfs:1:slot:2", presence: "loaded" },
            loadedSourceCount: 3,
          },
        },
      },
    });

    const bundle = createCfsCertificationExportBundle(viewModel);

    expect(bundle.summary.probeSummaries).toEqual({
      before: {
        observedAt: "2026-08-31T07:00:00.000Z",
        selectedSourceIds: ["cfs:1:slot:0"],
        targetSource: { sourceId: "cfs:1:slot:2", presence: "loaded" },
        loadedSourceCount: 3,
      },
      after: {
        observedAt: "2026-08-31T07:00:03.000Z",
        selectedSourceIds: ["cfs:1:slot:2"],
        targetSource: { sourceId: "cfs:1:slot:2", presence: "loaded" },
        loadedSourceCount: 3,
      },
    });
  });

  it("boxsInfo probe summaryをCertificationパネル上にも表示する", () => {
    const viewModel = createCfsCertificationPanelViewModel({
      printer: {
        displayName: "K2Pro-69E7",
        model: "F012",
        deviceId: "device-k2",
        sessionId: "session-1",
        active: true,
      },
      materialViewModel: createMaterialViewModel(),
      evidence: {
        beforeBoxsInfo: {
          observedAt: "2026-08-31T07:00:00.000Z",
          summary: {
            selectedSourceIds: ["cfs:1:slot:0"],
            targetSource: { sourceId: "cfs:1:slot:2", displaySlot: "1C" },
            loadedSourceCount: 3,
          },
        },
        afterBoxsInfo: {
          observedAt: "2026-08-31T07:00:03.000Z",
          summary: {
            selectedSourceIds: ["cfs:1:slot:2"],
            targetSource: { sourceId: "cfs:1:slot:2", displaySlot: "1C" },
            loadedSourceCount: 3,
          },
        },
      },
    });

    const container = document.createElement("div");
    renderCfsCertificationPanel(container, viewModel);

    expect(container.textContent).toContain("Probe summary");
    expect(container.textContent).toContain("before selected");
    expect(container.textContent).toContain("cfs:1:slot:0");
    expect(container.textContent).toContain("after selected");
    expect(container.textContent).toContain("cfs:1:slot:2");
    expect(container.textContent).toContain("target");
    expect(container.textContent).toContain("1C / cfs:1:slot:2");
  });

  it("selected sourceをPreflight診断へ出し、期限切れARMとdry-run不整合ではLIVE不可にする", () => {
    const viewModel = createCfsCertificationPanelViewModel({
      nowMs: Date.parse("2026-08-29T10:00:00.000Z"),
      printer: {
        displayName: "K2Pro-69E7",
        model: "F012",
        deviceId: "device-k2",
        sessionId: "session-1",
        active: true,
        state: "idle",
      },
      materialViewModel: createMaterialViewModel(),
      command: {
        commandKind: "cfs-load",
        certificationStatus: "certified",
      },
      dryRunPlan: {
        ok: true,
        details: {
          commandKind: "cfs-unload",
          sourceId: "cfs:1:slot:2",
          semanticStatus: "certified",
        },
      },
      arm: {
        armed: true,
        expiresAt: "2026-08-29T09:59:59.000Z",
        boundDeviceId: "device-k2",
        boundSessionId: "session-1",
        boundSourceId: "cfs:1:slot:2",
        boundCommandKind: "cfs-load",
      },
    });

    expect(viewModel.preflight.map((item) => item.key)).toContain("selected-source");
    expect(viewModel.arm.valid).toBe(false);
    expect(viewModel.arm.reason).toContain("ARM期限切れ");
    expect(viewModel.dryRun.status).toBe("mismatch");
    expect(viewModel.liveSend.enabled).toBe(false);
  });

  it.each([
    ["commandKind欠落", { sourceId: "cfs:1:slot:2", semanticStatus: "certified" }, "dry-run-command-missing"],
    ["sourceId欠落", { commandKind: "cfs-load", semanticStatus: "certified" }, "dry-run-source-missing"],
    ["commandKind/sourceId欠落", { semanticStatus: "certified" }, "dry-run-command/source-missing"],
  ])("dry-run detailsの%sは現在値fallbackで補わずLIVE不可にする", (_label, details, expectedReason) => {
    const viewModel = createCfsCertificationPanelViewModel({
      nowMs: Date.parse("2026-08-29T10:00:00.000Z"),
      printer: {
        displayName: "K2Pro-69E7",
        model: "F012",
        deviceId: "device-k2",
        sessionId: "session-1",
        active: true,
        state: "idle",
      },
      materialViewModel: createMaterialViewModel(),
      command: {
        commandKind: "cfs-load",
        certificationStatus: "certified",
      },
      dryRunPlan: {
        ok: true,
        details,
      },
      arm: {
        armed: true,
        expiresAt: "2026-08-29T10:01:00.000Z",
        boundDeviceId: "device-k2",
        boundSessionId: "session-1",
        boundSourceId: "cfs:1:slot:2",
        boundCommandKind: "cfs-load",
      },
    });

    expect(viewModel.dryRun.status).toBe("missing");
    expect(viewModel.dryRun.reason).toBe(expectedReason);
    expect(viewModel.liveSend.enabled).toBe(false);
    expect(viewModel.liveSend.reason).toBe(expectedReason);
  });

  it("ARMとdry-runがOKでもpreflight fail時はdry-run-okではなく失敗項目をLIVE不可理由にする", () => {
    const staleViewModel = createMaterialViewModel();
    staleViewModel.summary.topologyState = "stale";
    const viewModel = createCfsCertificationPanelViewModel({
      nowMs: Date.parse("2026-08-29T10:00:00.000Z"),
      printer: {
        displayName: "K2Pro-69E7",
        model: "F012",
        deviceId: "device-k2",
        sessionId: "session-1",
        active: true,
        state: "idle",
      },
      materialViewModel: staleViewModel,
      command: {
        commandKind: "cfs-load",
        certificationStatus: "certified",
      },
      dryRunPlan: {
        ok: true,
        details: {
          commandKind: "cfs-load",
          sourceId: "cfs:1:slot:2",
          semanticStatus: "certified",
        },
      },
      arm: {
        armed: true,
        expiresAt: "2026-08-29T10:01:00.000Z",
        boundDeviceId: "device-k2",
        boundSessionId: "session-1",
        boundSourceId: "cfs:1:slot:2",
        boundCommandKind: "cfs-load",
      },
    });

    expect(viewModel.arm.valid).toBe(true);
    expect(viewModel.dryRun.status).toBe("ok");
    expect(viewModel.liveSend.enabled).toBe(false);
    expect(viewModel.liveSend.reason).toBe("preflight-failed:topology-fresh");
  });

  it("selected-source WARNだけでは将来の認証済みLIVE候補をhard gateしない", () => {
    const materialViewModel = createMaterialViewModel();
    materialViewModel.units[0].slots[1].selected = false;
    materialViewModel.units[0].slots[1].status.selectionState = "unselected";
    const viewModel = createCfsCertificationPanelViewModel({
      nowMs: Date.parse("2026-08-29T10:00:00.000Z"),
      printer: {
        displayName: "K2Pro-69E7",
        model: "F012",
        deviceId: "device-k2",
        sessionId: "session-1",
        active: true,
        state: "idle",
      },
      materialViewModel,
      targetSource: materialViewModel.units[0].slots[1],
      command: {
        commandKind: "cfs-load",
        certificationStatus: "certified",
      },
      dryRunPlan: {
        ok: true,
        details: {
          commandKind: "cfs-load",
          sourceId: "cfs:1:slot:2",
          semanticStatus: "certified",
        },
      },
      arm: {
        armed: true,
        expiresAt: "2026-08-29T10:01:00.000Z",
        boundDeviceId: "device-k2",
        boundSessionId: "session-1",
        boundSourceId: "cfs:1:slot:2",
        boundCommandKind: "cfs-load",
      },
    });

    expect(viewModel.preflight.find((item) => item.key === "selected-source")).toMatchObject({
      state: "warn",
    });
    expect(viewModel.liveSend.enabled).toBe(true);
  });

  it("loaded sourceのselection証跡が不完全ならCertificationパネルでもLIVE不可理由として表示する", () => {
    const materialViewModel = createMaterialViewModel();
    materialViewModel.units[0].slots[0].status.selectionState = "unobserved";
    materialViewModel.units[0].slots[0].status.selectionValid = null;
    const viewModel = createCfsCertificationPanelViewModel({
      nowMs: Date.parse("2026-08-29T10:00:00.000Z"),
      printer: {
        displayName: "K2Pro-69E7",
        model: "F012",
        deviceId: "device-k2",
        sessionId: "session-1",
        active: true,
        state: "idle",
      },
      materialViewModel,
      targetSource: materialViewModel.units[0].slots[1],
      command: {
        commandKind: "cfs-load",
        certificationStatus: "certified",
      },
      dryRunPlan: {
        ok: true,
        details: {
          commandKind: "cfs-load",
          sourceId: "cfs:1:slot:2",
          semanticStatus: "certified",
        },
      },
      arm: {
        armed: true,
        expiresAt: "2026-08-29T10:01:00.000Z",
        boundDeviceId: "device-k2",
        boundSessionId: "session-1",
        boundSourceId: "cfs:1:slot:2",
        boundCommandKind: "cfs-load",
      },
    });

    const container = document.createElement("div");
    renderCfsCertificationPanel(container, viewModel);

    expect(viewModel.preflight.find((item) => item.key === "selection-complete")).toMatchObject({
      state: "fail",
      detail: "選択状態未観測: 1A",
    });
    expect(viewModel.liveSend.enabled).toBe(false);
    expect(viewModel.liveSend.reason).toBe("preflight-failed:selection-complete");
    expect(container.textContent).toContain("Selection evidence");
    expect(container.textContent).toContain("選択状態未観測: 1A");
  });

  it("固定枠の未観測placeholderはselection証跡不完全としてLIVE不可にしない", () => {
    const materialViewModel = createMaterialViewModel();
    materialViewModel.units[0].slots.push({
      sourceId: "cfs:1:slot:3",
      displaySlot: "1D",
      kind: "cfs-slot",
      boxId: 1,
      slotIndex: 3,
      protocolSlotId: 3,
      presence: "unobserved",
      selected: null,
      assignments: [],
      material: { type: null, name: null },
      status: {
        remaining: { displayPercent: null, valid: null },
        selectionState: "unobserved",
        selectionValid: null,
      },
    });
    const viewModel = createCfsCertificationPanelViewModel({
      nowMs: Date.parse("2026-08-29T10:00:00.000Z"),
      printer: {
        displayName: "K2Pro-69E7",
        model: "F012",
        deviceId: "device-k2",
        sessionId: "session-1",
        active: true,
        state: "idle",
      },
      materialViewModel,
      targetSource: materialViewModel.units[0].slots[1],
      command: {
        commandKind: "cfs-load",
        certificationStatus: "certified",
      },
      dryRunPlan: {
        ok: true,
        details: {
          commandKind: "cfs-load",
          sourceId: "cfs:1:slot:2",
          semanticStatus: "certified",
        },
      },
      arm: {
        armed: true,
        expiresAt: "2026-08-29T10:01:00.000Z",
        boundDeviceId: "device-k2",
        boundSessionId: "session-1",
        boundSourceId: "cfs:1:slot:2",
        boundCommandKind: "cfs-load",
      },
    });

    expect(viewModel.preflight.find((item) => item.key === "selection-complete")).toMatchObject({
      state: "ok",
      detail: "選択証跡OK: 2 sources",
    });
    expect(viewModel.liveSend.enabled).toBe(true);
  });

  it("復旧ラッチblockerがある場合はCertificationパネルのpreflightでLIVE送信不可として表示する", () => {
    const viewModel = createCfsCertificationPanelViewModel({
      nowMs: Date.parse("2026-08-29T10:00:00.000Z"),
      printer: {
        displayName: "K2Pro-69E7",
        model: "F012",
        deviceId: "device-k2",
        sessionId: "session-1",
        active: true,
        state: "idle",
      },
      materialViewModel: createMaterialViewModel(),
      command: {
        commandKind: "cfs-load",
        certificationStatus: "certified",
      },
      dryRunPlan: {
        ok: true,
        details: {
          commandKind: "cfs-load",
          sourceId: "cfs:1:slot:2",
          semanticStatus: "certified",
        },
      },
      arm: {
        armed: true,
        expiresAt: "2026-08-29T10:01:00.000Z",
        boundDeviceId: "device-k2",
        boundSessionId: "session-1",
        boundSourceId: "cfs:1:slot:2",
        boundCommandKind: "cfs-load",
      },
      recoveryBlocker: {
        blocked: true,
        reason: "integrity-quarantine",
        commandId: "command:k2-load-1c",
        quarantineReason: "command-id-digest-mismatch",
      },
    });

    const container = document.createElement("div");
    renderCfsCertificationPanel(container, viewModel);

    expect(viewModel.preflight.find((item) => item.key === "recovery-blocker")).toMatchObject({
      state: "fail",
      detail: "復旧確認待ち: integrity-quarantine / command:k2-load-1c / command-id-digest-mismatch",
    });
    expect(viewModel.liveSend.enabled).toBe(false);
    expect(viewModel.liveSend.reason).toBe("preflight-failed:recovery-blocker");
    expect(viewModel.recoveryBlocker).toMatchObject({
      blocked: true,
      reason: "integrity-quarantine",
    });
    expect(container.textContent).toContain("Recovery blocker");
    expect(container.textContent).toContain("復旧確認待ち: integrity-quarantine / command:k2-load-1c / command-id-digest-mismatch");
  });

  it("復旧ラッチblockerがある場合はoperator確認用ボタンからcommandIdを渡せる", () => {
    const onResolveRecoveryBlocker = vi.fn();
    const viewModel = createCfsCertificationPanelViewModel({
      nowMs: Date.parse("2026-08-29T10:00:00.000Z"),
      printer: {
        displayName: "K2Pro-69E7",
        model: "F012",
        deviceId: "device-k2",
        sessionId: "session-1",
        active: true,
        state: "idle",
      },
      materialViewModel: createMaterialViewModel(),
      command: {
        commandKind: "cfs-load",
        certificationStatus: "certified",
      },
      dryRunPlan: {
        ok: true,
        details: {
          commandKind: "cfs-load",
          sourceId: "cfs:1:slot:2",
          semanticStatus: "certified",
        },
      },
      recoveryBlocker: {
        blocked: true,
        reason: "unresolved-recovery",
        commandId: "command:k2-load-1c",
        commandKind: "cfs-load",
        deviceId: "device-k2",
        sessionId: "session-1",
        materialSourceId: "cfs:1:slot:2",
        status: "submitted",
        sentAt: "2026-08-31T07:00:00.000Z",
        recordDigest: "fnv1a128:displayed-record",
        operatorResolvable: true,
      },
    });

    const container = document.createElement("div");
    renderCfsCertificationPanel(container, viewModel, {
      onResolveRecoveryBlocker,
    });
    const button = container.querySelector('[data-action="resolve-recovery-blocker"]');

    expect(button).not.toBeNull();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain("物理確認済みとして解除");
    expect(container.textContent).toContain("Command");
    expect(container.textContent).toContain("cfs-load");
    expect(container.textContent).toContain("Source");
    expect(container.textContent).toContain("cfs:1:slot:2");
    expect(container.textContent).toContain("Digest");
    expect(container.textContent).toContain("fnv1a128:displayed-record");

    button.click();

    expect(onResolveRecoveryBlocker).toHaveBeenCalledWith({
      commandId: "command:k2-load-1c",
      resolution: "operator-cleared",
      expectedDeviceId: "device-k2",
      expectedDigest: "fnv1a128:displayed-record",
      expectedCommandKind: "cfs-load",
      expectedMaterialSourceId: "cfs:1:slot:2",
      viewModel,
    });
  });

  it.each([
    ["conflict", "conflicted-recovery"],
    ["quarantine", "integrity-quarantine"],
  ])("%s blockerは通常operator解除ボタンを無効にする", (_label, reason) => {
    const onResolveRecoveryBlocker = vi.fn();
    const viewModel = createCfsCertificationPanelViewModel({
      printer: {
        displayName: "K2Pro-69E7",
        model: "F012",
        deviceId: "device-k2",
        sessionId: "session-1",
        active: true,
        state: "idle",
      },
      materialViewModel: createMaterialViewModel(),
      recoveryBlocker: {
        blocked: true,
        reason,
        commandId: "command:k2-load-1c",
        quarantineReason: reason === "integrity-quarantine" ? "command-id-digest-mismatch" : "",
      },
    });

    const container = document.createElement("div");
    renderCfsCertificationPanel(container, viewModel, {
      onResolveRecoveryBlocker,
    });
    const button = container.querySelector('[data-action="resolve-recovery-blocker"]');

    expect(button).not.toBeNull();
    expect(button.disabled).toBe(true);
    button.click();
    expect(onResolveRecoveryBlocker).not.toHaveBeenCalled();
  });

  it("printer idle未観測WARNはselected-sourceと違いLIVE送信をblockingする", () => {
    const viewModel = createCfsCertificationPanelViewModel({
      nowMs: Date.parse("2026-08-29T10:00:00.000Z"),
      printer: {
        displayName: "K2Pro-69E7",
        model: "F012",
        deviceId: "device-k2",
        sessionId: "session-1",
        active: true,
        state: "",
      },
      materialViewModel: createMaterialViewModel(),
      command: {
        commandKind: "cfs-load",
        certificationStatus: "certified",
      },
      dryRunPlan: {
        ok: true,
        details: {
          commandKind: "cfs-load",
          sourceId: "cfs:1:slot:2",
          semanticStatus: "certified",
        },
      },
      arm: {
        armed: true,
        expiresAt: "2026-08-29T10:01:00.000Z",
        boundDeviceId: "device-k2",
        boundSessionId: "session-1",
        boundSourceId: "cfs:1:slot:2",
        boundCommandKind: "cfs-load",
      },
    });

    expect(viewModel.preflight.find((item) => item.key === "printer-idle")).toMatchObject({
      state: "warn",
    });
    expect(viewModel.liveSend.enabled).toBe(false);
    expect(viewModel.liveSend.reason).toBe("preflight-failed:printer-idle");
  });

  it("認証未完了はpreflight項目名ではなくcertification-uncertifiedとしてLIVE不可理由にする", () => {
    const viewModel = createCfsCertificationPanelViewModel({
      nowMs: Date.parse("2026-08-29T10:00:00.000Z"),
      printer: {
        displayName: "K2Pro-69E7",
        model: "F012",
        deviceId: "device-k2",
        sessionId: "session-1",
        active: true,
        state: "idle",
      },
      materialViewModel: createMaterialViewModel(),
      command: {
        commandKind: "cfs-load",
        certificationStatus: "uncertified",
      },
      dryRunPlan: {
        ok: true,
        details: {
          commandKind: "cfs-load",
          sourceId: "cfs:1:slot:2",
          semanticStatus: "uncertified",
        },
      },
      arm: {
        armed: true,
        expiresAt: "2026-08-29T10:01:00.000Z",
        boundDeviceId: "device-k2",
        boundSessionId: "session-1",
        boundSourceId: "cfs:1:slot:2",
        boundCommandKind: "cfs-load",
      },
    });

    expect(viewModel.liveSend.enabled).toBe(false);
    expect(viewModel.liveSend.reason).toBe("certification-uncertified");
  });

  it("post-command observation失敗のunknown実行状態は待機中ではなく結果不明として表示する", () => {
    const viewModel = createCfsCertificationPanelViewModel({
      printer: {
        displayName: "K2Pro-69E7",
        model: "F012",
        deviceId: "device-k2",
        sessionId: "session-1",
        active: true,
        state: "idle",
      },
      materialViewModel: createMaterialViewModel(),
      command: {
        commandKind: "cfs-load",
      },
      dryRunPlan: {
        ok: true,
        details: {
          commandKind: "cfs-load",
          sourceId: "cfs:1:slot:2",
          semanticStatus: "uncertified",
        },
      },
      execution: {
        status: "unknown",
        reason: "post-command-observation-failed",
        startedAt: "2026-08-31T07:00:00.000Z",
        completedAt: "2026-08-31T07:00:05.000Z",
      },
    });

    const container = document.createElement("div");
    renderCfsCertificationPanel(container, viewModel);

    expect(viewModel.execution.displayStatus).toBe("結果不明 / 物理確認が必要");
    expect(viewModel.evidence.timeline).toContainEqual(expect.objectContaining({
      key: "execution",
      label: "結果不明 / 物理確認が必要",
      status: "unknown",
      observedAt: "2026-08-31T07:00:05.000Z",
    }));
    expect(container.textContent).toContain("結果不明 / 物理確認が必要");
  });

  it("post-observed実行状態は成功ではなく物理確認待ちとしてLIVE再送をhard disableする", () => {
    const viewModel = createCfsCertificationPanelViewModel({
      nowMs: Date.parse("2026-08-29T10:00:00.000Z"),
      printer: {
        displayName: "K2Pro-69E7",
        model: "F012",
        deviceId: "device-k2",
        sessionId: "session-1",
        active: true,
        state: "idle",
      },
      materialViewModel: createMaterialViewModel(),
      command: {
        commandKind: "cfs-load",
        certificationStatus: "certified",
      },
      dryRunPlan: {
        ok: true,
        details: {
          commandKind: "cfs-load",
          sourceId: "cfs:1:slot:2",
          semanticStatus: "certified",
        },
      },
      arm: {
        armed: true,
        expiresAt: "2026-08-29T10:01:00.000Z",
        boundDeviceId: "device-k2",
        boundSessionId: "session-1",
        boundSourceId: "cfs:1:slot:2",
        boundCommandKind: "cfs-load",
      },
      execution: {
        status: "post-observed",
        reason: "post-command-telemetry-observed",
        startedAt: "2026-08-31T07:00:00.000Z",
        completedAt: "2026-08-31T07:00:05.000Z",
      },
    });

    const container = document.createElement("div");
    renderCfsCertificationPanel(container, viewModel);

    expect(viewModel.execution.displayStatus).toBe("観測済み / 物理確認待ち");
    expect(viewModel.liveSend.enabled).toBe(false);
    expect(viewModel.liveSend.reason).toBe("execution-unresolved:post-observed");
    expect(viewModel.evidence.timeline).toContainEqual(expect.objectContaining({
      key: "execution",
      label: "観測済み / 物理確認待ち",
      status: "post-observed",
      observedAt: "2026-08-31T07:00:05.000Z",
    }));
    expect(container.textContent).toContain("観測済み / 物理確認待ち");
  });

  it("unknown実行状態が残る間はpreflight/ARMがOKでもLIVE再送をhard disableする", () => {
    const viewModel = createCfsCertificationPanelViewModel({
      nowMs: Date.parse("2026-08-29T10:00:00.000Z"),
      printer: {
        displayName: "K2Pro-69E7",
        model: "F012",
        deviceId: "device-k2",
        sessionId: "session-1",
        active: true,
        state: "idle",
      },
      materialViewModel: createMaterialViewModel(),
      command: {
        commandKind: "cfs-load",
        certificationStatus: "certified",
      },
      dryRunPlan: {
        ok: true,
        details: {
          commandKind: "cfs-load",
          sourceId: "cfs:1:slot:2",
          semanticStatus: "certified",
        },
      },
      arm: {
        armed: true,
        expiresAt: "2026-08-29T10:01:00.000Z",
        boundDeviceId: "device-k2",
        boundSessionId: "session-1",
        boundSourceId: "cfs:1:slot:2",
        boundCommandKind: "cfs-load",
      },
      execution: {
        status: "unknown",
        mutexOwner: null,
        completedAt: "2026-08-31T07:00:05.000Z",
      },
    });

    expect(viewModel.arm.valid).toBe(true);
    expect(viewModel.dryRun.status).toBe("ok");
    expect(viewModel.preflight.every((item) => item.state !== "fail")).toBe(true);
    expect(viewModel.liveSend.enabled).toBe(false);
    expect(viewModel.liveSend.reason).toBe("execution-unresolved:unknown");
  });
});
