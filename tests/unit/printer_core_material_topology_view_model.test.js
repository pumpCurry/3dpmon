/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 material topology view model 単体テスト
 * @file printer_core_material_topology_view_model.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_material_topology_view_model_test
 *
 * 【機能内容サマリ】
 * - K2/CFS と K1C/CFS-C の read-only material topology を同じ表示モデルへ変換できることを検証
 * - 外部スプール1本とCFS/CFS-C最大16スロットの固定表示契約を検証
 * - selected、残量、空/未観測/装填状態、assignment、provider metadata を表示境界で保持することを検証
 * - CFS操作候補authorityが既定read-onlyで、明示時だけ表示モデルへ反映されることを検証
 *
 * 【公開関数一覧】
 * - なし：Vitest による単体テストのみを提供
 *
 * @version 1.390.1420 (PR #434)
 * @since   1.390.1361 (PR #432)
 * @lastModified 2026-08-27 15:45:53
 * -----------------------------------------------------------
 * @todo
 * - 実UIへ接続した後、DOM表示のintegration testを追加する
 */

import { describe, expect, it } from "vitest";
import {
  createCfsMoonrakerBoxMaterialProvider,
} from "../../3dp_lib/printer_core/dashboard_material_provider.js";
import {
  normalizeK2BoxsInfo,
} from "../../3dp_lib/printer_core/dashboard_normalized_state.js";
import {
  createMaterialTopologyViewModel,
} from "../../3dp_lib/printer_core/dashboard_material_topology_view_model.js";

/**
 * K2 Pro Combo の1 CFS unitと外部スプールを含む `boxsInfo` payload を生成する。
 *
 * 【詳細説明】
 * - 1C の銀色PLAが選択された代表状態を再現する。
 * - 外部スプールと4 slotの assignment を同時に持たせ、表示モデルの対応関係を検証しやすくする。
 *
 * @function createK2ProComboBoxsInfo
 * @returns {object} テスト用 `boxsInfo` payload
 */
function createK2ProComboBoxsInfo() {
  return {
    enable: 1,
    materialBoxs: [
      {
        id: 0,
        type: 1,
        state: 1,
        materials: [
          {
            id: 0,
            state: 1,
            vendor: "Generic",
            type: "PLA",
            name: "External PLA",
            color: "#FFFFFF",
            selected: 0,
            percent: 88,
          },
        ],
      },
      {
        id: 1,
        type: 0,
        state: 1,
        temp: 26,
        humidity: 41,
        materials: [
          {
            id: 0,
            state: 1,
            vendor: "Generic",
            type: "PLA",
            name: "White PLA",
            color: "#FFFFFF",
            selected: 0,
            percent: 95,
          },
          {
            id: 1,
            state: 1,
            vendor: "Generic",
            type: "PLA",
            name: "Green PLA",
            color: "#74B843",
            selected: 0,
            percent: 80,
          },
          {
            id: 2,
            state: 1,
            vendor: "Generic",
            type: "PLA",
            name: "Silver PLA",
            color: "#A7ADB1",
            selected: 1,
            percent: 54,
          },
          {
            id: 3,
            state: 1,
            vendor: "Generic",
            type: "PLA",
            name: "Yellow PLA",
            color: "#FFEA00",
            selected: 0,
            percent: 70,
          },
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
 * 最大表示数を検証するための4 CFS unit payload を生成する。
 *
 * 【詳細説明】
 * - 実機ではまだ全unitを同時観測していないが、ViewModelの表示容量を固定するために合成payloadを使う。
 *
 * @function createFourUnitBoxsInfo
 * @returns {object} 4unit x 4slot と外部スプールを含む `boxsInfo` payload
 */
function createFourUnitBoxsInfo() {
  const materialBoxs = [
    {
      id: 0,
      type: 1,
      state: 1,
      materials: [{ id: 0, state: 1, type: "PLA", color: "#111111", selected: 0, percent: 100 }],
    },
  ];
  const colorMatch = [];
  for (let boxId = 1; boxId <= 4; boxId += 1) {
    const materials = [];
    for (let slotId = 0; slotId < 4; slotId += 1) {
      materials.push({
        id: slotId,
        state: 1,
        type: "PLA",
        name: `Unit ${boxId} Slot ${slotId}`,
        color: `#${boxId}${slotId}${boxId}${slotId}${boxId}${slotId}`,
        selected: boxId === 4 && slotId === 3 ? 1 : 0,
        percent: 90 - ((boxId - 1) * 4) - slotId,
      });
      colorMatch.push({
        id: `T${boxId}${slotId}`,
        boxId,
        materialId: slotId,
      });
    }
    materialBoxs.push({
      id: boxId,
      type: 0,
      state: 1,
      temp: 25 + boxId,
      humidity: 40 + boxId,
      materials,
    });
  }
  return {
    enable: 1,
    materialBoxs,
    colorMatch,
  };
}

describe("Printer Core v3 material topology view model", () => {
  it("未観測topologyでも外部1本とCFS最大16slotのread-only固定枠を返す", () => {
    const viewModel = createMaterialTopologyViewModel(null);

    expect(viewModel.authority).toEqual({
      mode: "read-only-view",
      canDriveLedger: false,
      canSendCommands: false,
      allowedActions: [],
      reason: "command-authority-not-enabled",
      sourceAuthority: "unknown",
    });
    expect(viewModel.limits).toEqual({
      externalSourceLimit: 1,
      cfsUnitLimit: 4,
      slotsPerUnit: 4,
      maxDisplayedSources: 17,
    });
    expect(viewModel.external).toHaveLength(1);
    expect(viewModel.external[0]).toMatchObject({
      kind: "external-spool",
      displaySlot: "external",
      presence: "unobserved",
      selected: null,
    });
    expect(viewModel.units).toHaveLength(4);
    expect(viewModel.units.every((unit) => unit.slots.length === 4)).toBe(true);
    expect(viewModel.units[0].slots[0]).toMatchObject({ displaySlot: "1A", presence: "unobserved" });
    expect(viewModel.units[3].slots[3]).toMatchObject({ displaySlot: "4D", presence: "unobserved" });
    expect(viewModel.summary).toMatchObject({
      cfsSlotCapacity: 16,
      cfsObservedSlotCount: 0,
      loadedSourceCount: 0,
      selectedSourceCount: 0,
      topologyState: "unobserved",
    });
  });

  it("K2 Pro Comboの1C銀色PLA selected/残量/assignmentを表示モデルへ保持する", () => {
    const topology = normalizeK2BoxsInfo(createK2ProComboBoxsInfo(), { connected: true });
    const viewModel = createMaterialTopologyViewModel(topology, {
      observation: {
        lastObservedAt: "2026-08-27T03:34:56.000Z",
        request: {
          state: "in-flight",
          startedAt: "2026-08-27T03:35:01.000Z",
          startedAtMs: Date.parse("2026-08-27T03:35:01.000Z"),
        },
        nowMs: Date.parse("2026-08-27T03:35:14.000Z"),
      },
    });
    const selectedSlot = viewModel.units[0].slots[2];

    expect(viewModel.cfs).toMatchObject({
      connected: true,
      enabled: true,
      topologyState: "fresh",
    });
    expect(viewModel.observation).toMatchObject({
      lastObservedAt: "2026-08-27T03:34:56.000Z",
      request: {
        state: "in-flight",
        elapsedSeconds: 13,
      },
    });
    expect(viewModel.external[0]).toMatchObject({
      kind: "external-spool",
      presence: "loaded",
      material: {
        type: "PLA",
        name: "External PLA",
      },
      status: {
        remaining: {
          rawPercent: 88,
          normalizedPercent: 88,
          displayPercent: 88,
          valid: true,
          authority: "observation-only",
        },
      },
    });
    expect(selectedSlot).toMatchObject({
      kind: "cfs-slot",
      displaySlot: "1C",
      presence: "loaded",
      selected: true,
      material: {
        type: "PLA",
        name: "Silver PLA",
        color: { raw: "#A7ADB1", normalized: "a7adb1" },
      },
      status: {
        stateCode: 1,
        remaining: {
          rawPercent: 54,
          normalizedPercent: 54,
          displayPercent: 54,
          valid: true,
        },
      },
    });
    expect(selectedSlot.assignments).toEqual([{
      assignmentId: "T1C",
      namespace: "creality-color-match",
      resolution: "resolved",
    }]);
    expect(viewModel.summary).toMatchObject({
      externalSourceCount: 1,
      cfsUnitCount: 1,
      cfsObservedSlotCount: 4,
      loadedSourceCount: 5,
      selectedSourceCount: 1,
      assignmentCount: 4,
    });
  });

  it("物理boxIdに欠番があってもdisplay unit番号へcompactしない", () => {
    const topology = normalizeK2BoxsInfo({
      enable: 1,
      materialBoxs: [
        {
          id: 3,
          type: 0,
          state: 1,
          materials: [
            {
              id: 0,
              state: 1,
              type: "PLA",
              name: "Physical Unit 3 PLA",
              color: "#A7ADB1",
              selected: 1,
              percent: 54,
            },
          ],
        },
      ],
    }, { connected: true });
    const viewModel = createMaterialTopologyViewModel(topology, { unitLimit: 4 });

    expect(viewModel.units[0]).toMatchObject({ displayUnit: 1, observed: false });
    expect(viewModel.units[1]).toMatchObject({ displayUnit: 2, observed: false });
    expect(viewModel.units[2]).toMatchObject({ displayUnit: 3, observed: true, boxId: 3 });
    expect(viewModel.units[2].slots[0]).toMatchObject({
      displaySlot: "3A",
      boxId: 3,
      presence: "loaded",
      selected: true,
    });
  });

  it("外部1本とCFS 4unit x 4slotを最大17 sourceとして表示できる", () => {
    const topology = normalizeK2BoxsInfo(createFourUnitBoxsInfo(), { connected: true });
    const viewModel = createMaterialTopologyViewModel(topology);
    const cfsSlots = viewModel.units.flatMap((unit) => unit.slots);

    expect(viewModel.external).toHaveLength(1);
    expect(viewModel.units).toHaveLength(4);
    expect(cfsSlots).toHaveLength(16);
    expect(viewModel.limits.maxDisplayedSources).toBe(17);
    expect(viewModel.external.filter((row) => row.sourceId)).toHaveLength(1);
    expect(cfsSlots.filter((row) => row.sourceId)).toHaveLength(16);
    expect(viewModel.units[0].slots[0]).toMatchObject({
      displaySlot: "1A",
      sourceId: "cfs:1:slot:0",
    });
    expect(viewModel.units[3].slots[3]).toMatchObject({
      displaySlot: "4D",
      sourceId: "cfs:4:slot:3",
      selected: true,
    });
    expect(viewModel.summary).toMatchObject({
      cfsUnitCount: 4,
      cfsSlotCapacity: 16,
      cfsObservedSlotCount: 16,
      loadedSourceCount: 17,
      selectedSourceCount: 1,
      assignmentCount: 16,
    });
  });

  it("セット/アンセット/フィラメント切れ相当の表示状態とinvalid remainingを区別する", () => {
    const topology = normalizeK2BoxsInfo({
      enable: 1,
      materialBoxs: [
        {
          id: 1,
          type: 0,
          state: 1,
          materials: [
            { id: 0, state: 1, type: "PLA", name: "Loaded PLA", selected: 1, percent: 54 },
            { id: 1, state: 0, type: "", name: "", color: "", selected: 0, percent: 0 },
            { id: 2, state: 1, type: "PLA", name: "Runout Candidate", selected: 0, percent: -5 },
          ],
        },
      ],
    }, { connected: true });
    const viewModel = createMaterialTopologyViewModel(topology);

    expect(viewModel.units[0].slots[0]).toMatchObject({
      displaySlot: "1A",
      presence: "loaded",
      selected: true,
      status: {
        remaining: {
          rawPercent: 54,
          normalizedPercent: 54,
          valid: true,
        },
      },
    });
    expect(viewModel.units[0].slots[1]).toMatchObject({
      displaySlot: "1B",
      presence: "empty",
      selected: false,
      status: {
        stateCode: 0,
        remaining: {
          rawPercent: 0,
          normalizedPercent: 0,
          valid: true,
        },
      },
    });
    expect(viewModel.units[0].slots[2]).toMatchObject({
      displaySlot: "1C",
      presence: "loaded",
      selected: false,
      status: {
        remaining: {
          rawPercent: -5,
          normalizedPercent: 0,
          displayPercent: 0,
          valid: false,
        },
      },
    });
    expect(viewModel.units[0].slots[3]).toMatchObject({
      displaySlot: "1D",
      presence: "unobserved",
      selected: null,
    });
    expect(viewModel.summary).toMatchObject({
      loadedSourceCount: 2,
      selectedSourceCount: 1,
      invalidRemainingCount: 1,
    });
  });

  it("K1C/CFS-C Moonraker provider由来のtopologyも同じ表示モデルへ変換する", () => {
    const provider = createCfsMoonrakerBoxMaterialProvider();
    const topology = provider.createTopology({
      result: {
        boxsInfo: createK2ProComboBoxsInfo(),
      },
    }, { connected: true });
    const viewModel = createMaterialTopologyViewModel(topology);

    expect(viewModel.cfs.provider).toMatchObject({
      providerId: "creality-cfs-moonraker-box",
      transportKind: "moonraker",
      sourceProtocol: "creality-moonraker-boxsInfo",
      canDriveLedger: false,
    });
    expect(viewModel.authority).toMatchObject({
      mode: "read-only-view",
      canDriveLedger: false,
      canSendCommands: false,
      sourceAuthority: "read-only-observation",
    });
    expect(viewModel.units[0].slots[2]).toMatchObject({
      displaySlot: "1C",
      presence: "loaded",
      selected: true,
      material: {
        name: "Silver PLA",
      },
    });
    expect(viewModel.summary).toMatchObject({
      externalSourceCount: 1,
      cfsObservedSlotCount: 4,
      selectedSourceCount: 1,
    });
  });

  it("commandAuthorityが明示された場合だけCFS操作候補を表示モデルへ反映する", () => {
    const topology = normalizeK2BoxsInfo(createK2ProComboBoxsInfo(), { connected: true });
    const readOnlyViewModel = createMaterialTopologyViewModel(topology);
    const commandViewModel = createMaterialTopologyViewModel(topology, {
      commandAuthority: {
        canSendCommands: true,
        allowedActions: ["select", "feed", "unknown"],
        sourceAuthority: "printer-core-command-dispatcher",
      },
    });

    expect(readOnlyViewModel.authority).toMatchObject({
      mode: "read-only-view",
      canSendCommands: false,
      canDriveLedger: false,
      reason: "command-authority-not-enabled",
    });
    expect(commandViewModel.authority).toMatchObject({
      mode: "command-candidate-view",
      canSendCommands: true,
      canDriveLedger: false,
      allowedActions: ["select", "feed"],
      reason: null,
      sourceAuthority: "printer-core-command-dispatcher",
    });
  });
});
