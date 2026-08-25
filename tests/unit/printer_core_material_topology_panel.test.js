/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 material topology パネルDOM描画単体テスト
 * @file printer_core_material_topology_panel.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_material_topology_panel_test
 *
 * 【機能内容サマリ】
 * - CFS/CFS-C read-only view model をDOMへ描画できることを検証
 * - 設定台数1台では外部1本+CFS4slot、4台では外部1本+CFS16slotだけを表示することを検証
 * - selected、残量、slot名の表示契約を検証
 * - CFS操作ボタンが既定disabledで、明示authority時だけ送信hookを呼ぶことを検証
 *
 * 【公開関数一覧】
 * - なし：Vitest による単体テストのみを提供
 *
 * @version 1.390.1376 (PR #432)
 * @since   1.390.1362 (PR #432)
 * @lastModified 2026-08-25 20:35:00
 * -----------------------------------------------------------
 * @todo
 * - none
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from "vitest";
import {
  normalizeK2BoxsInfo,
} from "../../3dp_lib/printer_core/dashboard_normalized_state.js";
import {
  createMaterialTopologyViewModel,
} from "../../3dp_lib/printer_core/dashboard_material_topology_view_model.js";
import {
  renderMaterialTopologyPanel,
} from "../../3dp_lib/printer_core/dashboard_material_topology_panel.js";

/**
 * K2 Pro Combo相当の1 CFS unit payloadを生成する。
 *
 * 【詳細説明】
 * - 1Cの銀色PLAがselectedで、残量54%として見える代表状態を使う。
 *
 * @function createOneUnitBoxsInfo
 * @returns {object} テスト用boxsInfo
 */
function createOneUnitBoxsInfo() {
  return {
    enable: 1,
    materialBoxs: [
      {
        id: 0,
        type: 1,
        state: 1,
        materials: [{ id: 0, state: 1, type: "PLA", name: "External PLA", color: "#FFFFFF", selected: 0, percent: 90 }],
      },
      {
        id: 1,
        type: 0,
        state: 1,
        temp: 26,
        humidity: 41,
        materials: [
          { id: 0, state: 1, type: "PLA", name: "White PLA", color: "#FFFFFF", selected: 0, percent: 95 },
          { id: 1, state: 1, type: "PLA", name: "Green PLA", color: "#74B843", selected: 0, percent: 80 },
          { id: 2, state: 1, type: "PLA", name: "Silver PLA", color: "#A7ADB1", selected: 1, percent: 54 },
          { id: 3, state: 1, type: "PLA", name: "Yellow PLA", color: "#FFEA00", selected: 0, percent: 70 },
        ],
      },
    ],
    colorMatch: [
      { id: "T1A", boxId: 1, materialId: 0 },
      { id: "T1B", boxId: 1, materialId: 1 },
      { id: "T1C", boxId: 1, materialId: 2 },
      { id: "T1D", boxId: 1, materialId: 3 },
    ],
  };
}

/**
 * DOM要素内のslot表示ラベル一覧を返す。
 *
 * 【詳細説明】
 * - 表示台数に応じたslot数検証を読みやすくするためのテストヘルパー。
 *
 * @function getSlotLabels
 * @param {HTMLElement} root - 検索対象DOM
 * @returns {string[]} slot label一覧
 */
function getSlotLabels(root) {
  return [...root.querySelectorAll(".mtv-slot-label")].map((element) => element.textContent);
}

/**
 * 指定slot/actionの操作ボタンを返す。
 *
 * 【詳細説明】
 * - CFS操作UIのenabled/disabled検証を読みやすくするためのテストヘルパー。
 *
 * @function getSlotActionButton
 * @param {HTMLElement} root - 検索対象DOM
 * @param {string} slot - 表示slot名
 * @param {string} action - 操作action
 * @returns {HTMLButtonElement|null} 操作ボタン
 */
function getSlotActionButton(root, slot, action) {
  return root.querySelector(`.mtv-slot[data-slot="${slot}"] .mtv-control-btn[data-action="${action}"]`);
}

describe("Printer Core v3 material topology panel", () => {
  it("1台CFS設定では外部1本と1A-1Dだけを描画する", () => {
    const topology = normalizeK2BoxsInfo(createOneUnitBoxsInfo(), { connected: true });
    const viewModel = createMaterialTopologyViewModel(topology, { unitLimit: 1 });
    const container = document.createElement("div");

    renderMaterialTopologyPanel(container, viewModel, { hostname: "K2Pro" });

    expect(getSlotLabels(container)).toEqual(["external", "1A", "1B", "1C", "1D"]);
    expect(container.querySelectorAll(".mtv-unit")).toHaveLength(1);
    expect(container.querySelector(".mtv-selected")?.dataset.slot).toBe("1C");
    expect(container.textContent).toContain("Silver PLA");
    expect(container.textContent).toContain("残量 54%");
    expect(container.textContent).toContain("現在選択中");
    expect(container.textContent).toContain("監視のみ");
    expect(container.querySelectorAll(".mtv-control-btn")).toHaveLength(0);
  });

  it("4台CFS設定では外部1本と1A-4Dまでの17枠を描画する", () => {
    const topology = normalizeK2BoxsInfo(createOneUnitBoxsInfo(), { connected: true });
    const viewModel = createMaterialTopologyViewModel(topology, { unitLimit: 4 });
    const container = document.createElement("div");

    renderMaterialTopologyPanel(container, viewModel, { hostname: "K2Pro" });

    expect(getSlotLabels(container)).toHaveLength(17);
    expect(getSlotLabels(container).at(-1)).toBe("4D");
    expect(container.querySelectorAll(".mtv-unit")).toHaveLength(4);
    expect(container.querySelectorAll(".mtv-unit-unobserved")).toHaveLength(3);
  });

  it("updateで表示台数とslot状態を差し替えられる", () => {
    const topology = normalizeK2BoxsInfo(createOneUnitBoxsInfo(), { connected: true });
    const container = document.createElement("div");
    const handle = renderMaterialTopologyPanel(
      container,
      createMaterialTopologyViewModel(null, { unitLimit: 1 }),
      { hostname: "K2Pro" }
    );

    expect(container.textContent).toContain("未観測");

    handle.update(createMaterialTopologyViewModel(topology, { unitLimit: 1 }));

    expect(getSlotLabels(container)).toEqual(["external", "1A", "1B", "1C", "1D"]);
    expect(container.querySelector(".mtv-selected")?.dataset.slot).toBe("1C");
  });

  it("invalid remainingを0%として見せず報告値異常の不明表示にする", () => {
    const payload = createOneUnitBoxsInfo();
    payload.materialBoxs[1].materials[2].percent = -5;
    const topology = normalizeK2BoxsInfo(payload, { connected: true });
    const viewModel = createMaterialTopologyViewModel(topology, { unitLimit: 1 });
    const container = document.createElement("div");

    renderMaterialTopologyPanel(container, viewModel, { hostname: "K2Pro" });

    const selectedRemaining = container.querySelector('.mtv-slot[data-slot="1C"] .mtv-remaining');
    expect(selectedRemaining?.textContent).toBe("残量 不明 ⚠");
    expect(selectedRemaining?.classList.contains("mtv-remaining-invalid")).toBe(true);
    expect(selectedRemaining?.getAttribute("title")).toContain("装置報告値: -5%");
    expect(container.textContent).not.toContain("残量 0%");
  });

  it("stale topologyではbannerと最終観測表示で現在値との誤認を防ぐ", () => {
    const topology = normalizeK2BoxsInfo(createOneUnitBoxsInfo(), { connected: false });
    const viewModel = createMaterialTopologyViewModel(topology, { unitLimit: 1 });
    const container = document.createElement("div");

    renderMaterialTopologyPanel(container, viewModel, { hostname: "K2Pro" });

    expect(container.querySelector(".mtv-root")?.classList.contains("mtv-root-stale")).toBe(true);
    expect(container.textContent).toContain("CFS情報を現在取得できません");
    expect(container.querySelector('.mtv-slot[data-slot="1C"] .mtv-slot-state')?.textContent).toBe("最終観測:選択中");
    expect(container.querySelector('.mtv-slot[data-slot="1C"] .mtv-remaining')?.textContent).toBe("最終観測 54%");
  });

  it("CFS操作ボタンは既定では表示されてもdisabledで送信hookを呼ばない", () => {
    const topology = normalizeK2BoxsInfo(createOneUnitBoxsInfo(), { connected: true });
    const viewModel = createMaterialTopologyViewModel(topology, { unitLimit: 1 });
    const container = document.createElement("div");
    const onCommand = vi.fn();

    renderMaterialTopologyPanel(container, viewModel, {
      hostname: "K2Pro",
      control: {
        showControls: true,
        canSendCommands: true,
        allowedActions: ["select", "feed"],
        onCommand,
      },
    });

    const selectButton = getSlotActionButton(container, "1C", "select");
    expect(selectButton?.disabled).toBe(true);
    expect(selectButton?.title).toContain("command-authority-not-enabled");
    selectButton?.click();
    expect(onCommand).not.toHaveBeenCalled();
    expect(container.textContent).toContain("監視のみ");
  });

  it("ViewModelとrendererの両方で許可されたCFS操作だけ送信hookへ渡す", async () => {
    const topology = normalizeK2BoxsInfo(createOneUnitBoxsInfo(), { connected: true });
    const viewModel = createMaterialTopologyViewModel(topology, {
      unitLimit: 2,
      commandAuthority: {
        canSendCommands: true,
        allowedActions: ["select", "feed"],
        sourceAuthority: "printer-core-command-dispatcher",
      },
    });
    const container = document.createElement("div");
    const onCommand = vi.fn().mockResolvedValue({ ok: true });

    renderMaterialTopologyPanel(container, viewModel, {
      hostname: "K2Pro",
      control: {
        canSendCommands: true,
        allowedActions: ["select"],
        onCommand,
      },
    });

    const selectButton = getSlotActionButton(container, "1C", "select");
    const feedButton = getSlotActionButton(container, "1C", "feed");
    const emptySlotButton = getSlotActionButton(container, "2A", "select");
    expect(selectButton?.disabled).toBe(false);
    expect(feedButton?.disabled).toBe(true);
    expect(emptySlotButton?.disabled).toBe(true);

    selectButton?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith({
      action: "select",
      commandKind: "cfs-slot-select",
      sourceId: "cfs:1:slot:2",
      displaySlot: "1C",
      unitIndex: 0,
      slotIndex: 2,
      boxId: 1,
      protocolSlotId: 2,
    });
    expect(container.textContent).toContain("送信直前に再検証");
  });

  it("renderer側allowedActions未指定ではViewModelが許可していてもCFS操作をdisabledにする", () => {
    const topology = normalizeK2BoxsInfo(createOneUnitBoxsInfo(), { connected: true });
    const viewModel = createMaterialTopologyViewModel(topology, {
      unitLimit: 1,
      commandAuthority: {
        canSendCommands: true,
        allowedActions: ["select", "feed"],
        sourceAuthority: "printer-core-command-dispatcher",
      },
    });
    const container = document.createElement("div");
    const onCommand = vi.fn();

    renderMaterialTopologyPanel(container, viewModel, {
      hostname: "K2Pro",
      control: {
        canSendCommands: true,
        onCommand,
      },
    });

    const selectButton = getSlotActionButton(container, "1C", "select");
    const feedButton = getSlotActionButton(container, "1C", "feed");
    expect(selectButton?.disabled).toBe(true);
    expect(feedButton?.disabled).toBe(true);

    selectButton?.click();
    feedButton?.click();

    expect(onCommand).not.toHaveBeenCalled();
  });

  it("stale topologyでは明示authorityがあってもCFS操作をdisabledにする", () => {
    const topology = normalizeK2BoxsInfo(createOneUnitBoxsInfo(), { connected: false });
    const viewModel = createMaterialTopologyViewModel(topology, {
      unitLimit: 1,
      commandAuthority: {
        canSendCommands: true,
        allowedActions: ["select"],
        sourceAuthority: "printer-core-command-dispatcher",
      },
    });
    const container = document.createElement("div");
    const onCommand = vi.fn();

    renderMaterialTopologyPanel(container, viewModel, {
      hostname: "K2Pro",
      control: {
        canSendCommands: true,
        allowedActions: ["select"],
        onCommand,
      },
    });

    const selectButton = getSlotActionButton(container, "1C", "select");
    expect(selectButton?.disabled).toBe(true);
    expect(selectButton?.title).toContain("最終観測状態");
    selectButton?.click();
    expect(onCommand).not.toHaveBeenCalled();
  });
});
