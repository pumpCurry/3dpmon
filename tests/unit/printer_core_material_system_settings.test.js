/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 material system 設定正規化単体テスト
 * @file printer_core_material_system_settings.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_material_system_settings_test
 *
 * 【機能内容サマリ】
 * - 接続先ごとのCFS/CFS-C表示設定を0-4台へ正規化できることを検証
 * - K2 Combo標準の1台表示と、K1通常1巻表示の既定値を検証
 * - topology観測時のauto表示切替を検証
 *
 * 【公開関数一覧】
 * - なし：Vitest による単体テストのみを提供
 *
 * @version 1.390.1402 (PR #434)
 * @since   1.390.1362 (PR #432)
 * @lastModified 2026-08-26 22:30:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { describe, expect, it } from "vitest";
import {
  MATERIAL_DISPLAY_MODE,
  MATERIAL_PROVIDER_MODE,
  MATERIAL_SYSTEM_MODE,
  normalizeMaterialSystemSettings,
  resolveDisplayMaterialTopology,
  resolveMaterialDisplayMode,
  resolveMaterialTopologyViewOptions,
} from "../../3dp_lib/printer_core/dashboard_material_system_settings.js";

/**
 * 観測済みunit数だけを持つ最小topologyを生成する。
 *
 * 【詳細説明】
 * - provider正規化そのものではなく表示設定判定を検証するため、必要最小限のshapeだけを使う。
 *
 * @function createObservedTopology
 * @param {number} unitCount - 観測済みunit数
 * @returns {object} Normalized material topology相当の最小fixture
 */
function createObservedTopology(unitCount) {
  return {
    cfs: {
      topologyState: "fresh",
      connected: true,
    },
    units: Array.from({ length: unitCount }, (_, index) => ({
      unitId: `cfs:${index + 1}`,
      boxId: index + 1,
    })),
    sources: [],
  };
}

describe("Printer Core v3 material system settings", () => {
  it("K2は既定でCombo標準の1台CFS表示へ進める", () => {
    const target = { printerType: "creality-k2" };

    expect(resolveMaterialDisplayMode({ target, printerType: "creality-k2", topology: null })).toBe(
      MATERIAL_DISPLAY_MODE.MULTI_SLOT
    );
    expect(resolveMaterialTopologyViewOptions({ target, printerType: "creality-k2", topology: null })).toMatchObject({
      unitLimit: 1,
      slotsPerUnit: 4,
      externalSourceLimit: 1,
    });
  });

  it("K1は既定で従来の手動1巻カードを維持する", () => {
    const target = { printerType: "creality-k1" };

    expect(resolveMaterialDisplayMode({ target, printerType: "creality-k1", topology: null })).toBe(
      MATERIAL_DISPLAY_MODE.LEGACY_CARD
    );
    expect(resolveMaterialTopologyViewOptions({ target, printerType: "creality-k1", topology: null })).toMatchObject({
      unitLimit: 0,
    });
  });

  it("0台設定はK2でも従来カードへ戻せる", () => {
    const target = {
      printerType: "creality-k2",
      materialSystem: {
        mode: MATERIAL_SYSTEM_MODE.SINGLE_SPOOL,
        unitLimit: 0,
        readOnly: false,
      },
    };

    expect(normalizeMaterialSystemSettings(target.materialSystem, target.printerType)).toMatchObject({
      mode: MATERIAL_SYSTEM_MODE.SINGLE_SPOOL,
      unitLimit: 0,
      readOnly: true,
      canSendCommands: false,
      canDriveLedger: false,
    });
    expect(resolveMaterialDisplayMode({ target, printerType: "creality-k2", topology: null })).toBe(
      MATERIAL_DISPLAY_MODE.LEGACY_CARD
    );
  });

  it("旧UI由来のCFSスロット固定+0台という矛盾設定は従来カードへ倒す", () => {
    const target = {
      printerType: "creality-k2",
      materialSystem: {
        mode: MATERIAL_SYSTEM_MODE.SINGLE_SPOOL,
        displayMode: MATERIAL_DISPLAY_MODE.MULTI_SLOT,
        unitLimit: 0,
      },
    };

    expect(resolveMaterialDisplayMode({ target, printerType: "creality-k2", topology: null })).toBe(
      MATERIAL_DISPLAY_MODE.LEGACY_CARD
    );
  });

  it("外部スプールなし設定ではtopology view optionも外部0本になる", () => {
    const target = {
      printerType: "creality-k2",
      materialSystem: {
        mode: MATERIAL_SYSTEM_MODE.CFS_READONLY,
        unitLimit: 3,
        externalSourceLimit: 0,
      },
    };

    expect(resolveMaterialTopologyViewOptions({ target, printerType: "creality-k2", topology: null })).toMatchObject({
      unitLimit: 3,
      externalSourceLimit: 0,
    });
  });

  it("手動CFS台数は最大4台に丸め、表示枠数の入力として維持する", () => {
    const target = {
      printerType: "creality-k2",
      materialSystem: {
        mode: MATERIAL_SYSTEM_MODE.CFS_READONLY,
        unitLimit: 9,
      },
    };

    expect(resolveMaterialDisplayMode({ target, printerType: "creality-k2", topology: null })).toBe(
      MATERIAL_DISPLAY_MODE.MULTI_SLOT
    );
    expect(resolveMaterialTopologyViewOptions({ target, printerType: "creality-k2", topology: null })).toMatchObject({
      unitLimit: 4,
      slotsPerUnit: 4,
      externalSourceLimit: 1,
    });
  });

  it("autoでtopologyを観測した場合は観測unit数まで表示を広げる", () => {
    const target = {
      printerType: "creality-k1",
      materialSystem: {
        mode: MATERIAL_SYSTEM_MODE.AUTO,
        unitLimit: 0,
      },
    };
    const topology = createObservedTopology(2);

    expect(resolveMaterialDisplayMode({ target, printerType: "creality-k1", topology })).toBe(
      MATERIAL_DISPLAY_MODE.MULTI_SLOT
    );
    expect(resolveMaterialTopologyViewOptions({ target, printerType: "creality-k1", topology })).toMatchObject({
      unitLimit: 2,
    });
  });

  it("autoでboxId欠番を観測した場合は最大物理boxIdまで表示を広げる", () => {
    const target = {
      printerType: "creality-k1",
      materialSystem: {
        mode: MATERIAL_SYSTEM_MODE.AUTO,
        unitLimit: 0,
      },
    };
    const topology = {
      cfs: { topologyState: "fresh", connected: true },
      units: [{ unitId: "cfs:3", boxId: 3 }],
      sources: [],
    };

    expect(resolveMaterialTopologyViewOptions({ target, printerType: "creality-k1", topology })).toMatchObject({
      unitLimit: 3,
    });
  });

  it("CFS-C provider endpointを保存し、provider指定を維持する", () => {
    const normalized = normalizeMaterialSystemSettings({
      mode: MATERIAL_SYSTEM_MODE.CFS_C_READONLY,
      provider: MATERIAL_PROVIDER_MODE.MOONRAKER_BOXS_INFO,
      providerEndpoint: " 192.168.54.150:80 ",
      unitLimit: 2,
    }, "creality-k1");

    expect(normalized).toMatchObject({
      mode: MATERIAL_SYSTEM_MODE.CFS_C_READONLY,
      provider: MATERIAL_PROVIDER_MODE.MOONRAKER_BOXS_INFO,
      providerEndpoint: "192.168.54.150:80",
      unitLimit: 2,
      readOnly: true,
      canSendCommands: false,
      canDriveLedger: false,
    });
  });

  it("closedなruntime recordはtopologyをstale表示へ落とす", () => {
    const topology = createObservedTopology(1);
    const displayTopology = resolveDisplayMaterialTopology({
      topology,
      shadowRecord: {
        state: "closed",
        lastObservedAt: "2026-08-25T00:00:00.000Z",
      },
      nowMs: Date.parse("2026-08-25T00:00:01.000Z"),
    });

    expect(displayTopology).not.toBe(topology);
    expect(displayTopology.cfs).toMatchObject({
      connected: false,
      topologyState: "stale",
    });
    expect(displayTopology.diagnostics.some((entry) => entry.code === "material-topology-stale")).toBe(true);
  });

  it("TTLを超えたruntime recordはfresh topologyでもstale表示へ落とす", () => {
    const topology = createObservedTopology(1);
    const displayTopology = resolveDisplayMaterialTopology({
      topology,
      shadowRecord: {
        state: "observed",
        lastObservedAt: "2026-08-25T00:00:00.000Z",
      },
      nowMs: Date.parse("2026-08-25T00:02:00.000Z"),
      ttlMs: 45_000,
    });

    expect(displayTopology.cfs.topologyState).toBe("stale");
    expect(displayTopology.provider.freshness).toBe("stale");
  });

  it("active sessionでsource/unit実体がある場合は観測時刻metadata欠落だけでstale化しない", () => {
    const topology = {
      cfs: { topologyState: "fresh", connected: true },
      units: [{ unitId: "cfs:1", boxId: 1 }],
      sources: [{ sourceId: "cfs:1:slot:2", kind: "cfs-slot", unitId: "cfs:1", boxId: 1, slotId: 2 }],
    };
    const displayTopology = resolveDisplayMaterialTopology({
      topology,
      shadowRecord: {
        state: "observed",
      },
      nowMs: Date.parse("2026-08-25T00:02:00.000Z"),
      ttlMs: 45_000,
    });

    expect(displayTopology).toBe(topology);
    expect(displayTopology.cfs.topologyState).toBe("fresh");
  });
});
