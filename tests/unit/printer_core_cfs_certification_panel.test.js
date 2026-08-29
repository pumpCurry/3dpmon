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
 * @version 1.390.1473 (PR #436)
 * @since   1.390.1469 (PR #436)
 * @lastModified 2026-08-29 21:30:05
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
            status: { remaining: { displayPercent: 95, valid: true } },
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
            status: { remaining: { displayPercent: 54, valid: true } },
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
});
