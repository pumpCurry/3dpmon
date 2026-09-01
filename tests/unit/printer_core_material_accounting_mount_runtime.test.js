/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 MaterialAccounting SpoolMount runtime 単体テスト
 * @file printer_core_material_accounting_mount_runtime.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_material_accounting_mount_runtime_test
 *
 * 【機能内容サマリ】
 * - read-only MaterialSource観測からoperator mount用MaterialSource recordを復元する境界を検証
 * - runtime factoryがmonitorData互換データとCAS writerをH-1a serviceへ注入することを検証
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1582 (PR #440)
 * @since   1.390.1580 (PR #440)
 * @lastModified 2026-09-01 15:42:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { describe, expect, it, vi } from "vitest";

import {
  MATERIAL_IDENTITY_STRENGTH,
  MATERIAL_SOURCE_KIND,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_contract.js";
import { createEmptyMaterialAccountingSpoolMountStore } from "../../3dp_lib/printer_core/dashboard_material_accounting_mount_store.js";

const mockMonitorData = {};

vi.mock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: mockMonitorData,
}));

vi.mock("../../3dp_lib/dashboard_storage.js", () => ({
  commitMaterialAccountingSpoolMountStoreDurably: vi.fn(),
}));

const {
  createMaterialAccountingSpoolMountRuntime,
  resolveObservedMaterialSourceRecord,
} = await import("../../3dp_lib/printer_core/dashboard_material_accounting_mount_runtime.js");

/**
 * runtime test用のmonitorData互換データを生成する。
 *
 * @function createRuntimeData
 * @returns {Object} monitorData互換データ。
 */
function createRuntimeData() {
  return {
    filamentSpools: [
      { id: "spool-031", name: "CC3D Sand" },
      { id: "spool-002", name: "CC3D Yellow" },
    ],
    hostSpoolMap: {},
    materialAccountingSpoolMountStore: createEmptyMaterialAccountingSpoolMountStore(),
    materialSourceObservations: {
      schemaVersion: 1,
      authority: "observation-only",
      byDeviceId: {
        "serial:k2": {
          deviceId: "serial:k2",
          identityStrength: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
          latestBySourceId: {
            "source:k2:cfs:1a": {
              sourceId: "source:k2:cfs:1a",
              kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
              unitId: "unit:k2:cfs:1",
              unitIndex: 1,
              boxId: 1,
              slotId: 0,
              displayLabel: "1A",
              materialSourceIdentityStrength: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
            },
            "source:k2:cfs:1b": {
              sourceId: "source:k2:cfs:1b",
              kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
              unitId: "unit:k2:cfs:1",
              unitIndex: 1,
              boxId: 1,
              slotId: 1,
              displayLabel: "1B",
              materialSourceIdentityStrength: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
            },
          },
        },
      },
    },
  };
}

describe("MaterialAccountingSpoolMountRuntime", () => {
  it("観測済みdevice/sourceからoperator mount用MaterialSource recordを解決する", () => {
    const data = createRuntimeData();

    const source = resolveObservedMaterialSourceRecord({
      materialSourceObservations: data.materialSourceObservations,
      deviceId: "serial:k2",
      materialSourceId: "source:k2:cfs:1a",
    });

    expect(source).toMatchObject({
      deviceId: "serial:k2",
      materialSourceId: "source:k2:cfs:1a",
      unitId: "unit:k2:cfs:1",
      kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
      identityStrength: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
      displayLabel: "1A",
      locator: {
        kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
        unitIndex: 1,
        boxId: 1,
        slotIndex: 0,
      },
    });
  });

  it("未観測sourceはtrusted MaterialSourceとして解決しない", () => {
    const data = createRuntimeData();

    const source = resolveObservedMaterialSourceRecord({
      materialSourceObservations: data.materialSourceObservations,
      deviceId: "serial:k2",
      materialSourceId: "source:k2:cfs:9z",
    });

    expect(source).toBeNull();
  });

  it("kindを証明できない観測sourceはdirect feedへfallbackせず拒否する", () => {
    const data = createRuntimeData();
    data.materialSourceObservations.byDeviceId["serial:k2"].latestBySourceId["source:k2:unknown"] = {
      sourceId: "source:k2:unknown",
      unitId: "unit:k2:unknown",
      displayLabel: "unknown source",
      materialSourceIdentityStrength: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
    };

    const source = resolveObservedMaterialSourceRecord({
      materialSourceObservations: data.materialSourceObservations,
      deviceId: "serial:k2",
      materialSourceId: "source:k2:unknown",
    });

    expect(source).toBeNull();
  });

  it("identityStrengthが不正な観測sourceはprovisionalへ丸めず拒否する", () => {
    const data = createRuntimeData();
    data.materialSourceObservations.byDeviceId["serial:k2"].latestBySourceId["source:k2:cfs:1a"].materialSourceIdentityStrength = "firmware-ish";

    const source = resolveObservedMaterialSourceRecord({
      materialSourceObservations: data.materialSourceObservations,
      deviceId: "serial:k2",
      materialSourceId: "source:k2:cfs:1a",
    });

    expect(source).toBeNull();
  });

  it("runtime factoryは複数CFS sourceへ別々の管理スプールをmountできる", async () => {
    const data = createRuntimeData();
    const persist = vi.fn(async ({ nextStore }) => {
      data.materialAccountingSpoolMountStore = nextStore;
      return { ok: true, casApplied: true, backend: "indexedDB", reason: "cas-applied" };
    });
    const runtime = createMaterialAccountingSpoolMountRuntime({
      data,
      persist,
      now: () => "2026-09-01T05:00:00.000Z",
    });

    const first = await runtime.service.operatorMountSource({
      operatorActionId: "action:mount:1a",
      expectedDeviceId: "serial:k2",
      materialSource: runtime.resolveMaterialSource({
        deviceId: "serial:k2",
        materialSourceId: "source:k2:cfs:1a",
      }),
      spoolId: "spool-031",
      actor: "operator",
    });
    const second = await runtime.service.operatorMountSource({
      operatorActionId: "action:mount:1b",
      expectedDeviceId: "serial:k2",
      materialSource: runtime.resolveMaterialSource({
        deviceId: "serial:k2",
        materialSourceId: "source:k2:cfs:1b",
      }),
      spoolId: "spool-002",
      actor: "operator",
    });

    expect(first).toMatchObject({ ok: true, action: "mount" });
    expect(second).toMatchObject({ ok: true, action: "mount" });
    expect(runtime.snapshot().spoolMounts.map((mount) => [mount.materialSourceId, mount.spoolId])).toEqual([
      ["source:k2:cfs:1a", "spool-031"],
      ["source:k2:cfs:1b", "spool-002"],
    ]);
    expect(data.hostSpoolMap).toEqual({});
    expect(persist).toHaveBeenCalledTimes(2);
  });
});
