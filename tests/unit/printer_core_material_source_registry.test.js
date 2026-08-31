/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Universal MaterialSource registry 単体テスト
 * @file printer_core_material_source_registry.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_material_source_registry_test
 *
 * 【機能内容サマリ】
 * - Gate 18.9A のpure MaterialSourceRegistry不変条件を検証
 * - DeviceごとのN=1/N>1 source管理とlocator/identity分離を固定
 * - locator/identity衝突を自動上書きしないfail-closed境界を固定
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1497 (PR #438)
 * @since   1.390.1496 (PR #438)
 * @lastModified 2026-08-31 10:50:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { describe, expect, it } from "vitest";

import {
  FILAMENT_UNIT_KIND,
  MATERIAL_IDENTITY_STRENGTH,
  MATERIAL_SOURCE_KIND,
  createDirectFeedUnitIdentity,
  createFilamentUnitRecord,
  createMaterialSourceIdentity,
  createMaterialSourceLocator,
  createMaterialSourceRecord,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_contract.js";
import {
  createMaterialSourceIdentityKey,
  createMaterialSourceLocatorKey,
  createMaterialSourceRegistry,
} from "../../3dp_lib/printer_core/dashboard_material_source_registry.js";

/**
 * direct feed sourceを生成する。
 *
 * @function createDirectSource
 * @param {string} deviceId - Device ID。
 * @returns {Object} MaterialSource record。
 */
function createDirectSource(deviceId) {
  const unit = createFilamentUnitRecord({
    deviceId,
    kind: FILAMENT_UNIT_KIND.PRINTER_DIRECT,
    identityStrength: MATERIAL_IDENTITY_STRENGTH.STABLE,
    identity: createDirectFeedUnitIdentity({ deviceId }),
  });
  return createMaterialSourceRecord({
    deviceId,
    unitId: unit.unitId,
    kind: MATERIAL_SOURCE_KIND.DIRECT_FEED,
    locator: createMaterialSourceLocator({ kind: MATERIAL_SOURCE_KIND.DIRECT_FEED, index: 0 }),
    identity: createMaterialSourceIdentity({
      deviceId,
      unitId: unit.unitId,
      kind: MATERIAL_SOURCE_KIND.DIRECT_FEED,
      slotIndex: 0,
    }),
    identityStrength: MATERIAL_IDENTITY_STRENGTH.STABLE,
    displayLabel: "通常スプール",
  });
}

/**
 * CFS slot sourceを生成する。
 *
 * @function createCfsSource
 * @param {Object} input - source入力。
 * @param {string} input.deviceId - Device ID。
 * @param {number} input.unitIndex - CFS unit番号。
 * @param {number} input.slotIndex - slot index。
 * @param {string=} input.unitId - unit ID。
 * @param {string=} input.displayLabel - 表示label。
 * @param {string=} input.identityStrength - identity強度。
 * @returns {Object} MaterialSource record。
 */
function createCfsSource({
  deviceId,
  unitIndex,
  slotIndex,
  unitId = `filament-unit:${deviceId}:cfs:${unitIndex}`,
  displayLabel = `${unitIndex}${String.fromCharCode(65 + slotIndex)}`,
  identityStrength = MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
}) {
  return createMaterialSourceRecord({
    deviceId,
    unitId,
    kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
    locator: createMaterialSourceLocator({
      kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
      unitIndex,
      boxId: unitIndex,
      slotIndex,
    }),
    identity: createMaterialSourceIdentity({
      deviceId,
      unitId,
      kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
      slotIndex,
    }),
    identityStrength,
    displayLabel,
    aliases: [`T${unitIndex}${String.fromCharCode(65 + slotIndex)}`],
  });
}

describe("MaterialSourceRegistry", () => {
  it("K1 directのN=1 sourceをDevice単位で登録/解決できる", () => {
    const source = createDirectSource("serial:k1max-4a1b");
    const registry = createMaterialSourceRegistry();

    const result = registry.upsertSource(source);

    expect(result).toMatchObject({ ok: true, action: "insert" });
    expect(registry.listDeviceSources("serial:k1max-4a1b")).toHaveLength(1);
    expect(registry.resolveByLocator(source.deviceId, source.locator)).toMatchObject({
      materialSourceId: source.materialSourceId,
      displayLabel: "通常スプール",
    });
    expect(registry.resolveByIdentity(source.deviceId, source.identity)).toMatchObject({
      materialSourceId: source.materialSourceId,
    });
  });

  it("K2 external/CFSのN>1 sourceを同じregistryで保持できる", () => {
    const deviceId = "serial:k2pro-69e7";
    const registry = createMaterialSourceRegistry();
    const sources = [
      createDirectSource(deviceId),
      ...[0, 1, 2, 3].map((slotIndex) => createCfsSource({
        deviceId,
        unitIndex: 1,
        slotIndex,
      })),
    ];

    const results = sources.map((source) => registry.upsertSource(source));

    expect(results.every((result) => result.ok)).toBe(true);
    expect(registry.listDeviceSources(deviceId).map((source) => source.displayLabel)).toEqual([
      "通常スプール",
      "1A",
      "1B",
      "1C",
      "1D",
    ]);
    expect(registry.getConflicts()).toEqual([]);
  });

  it("locator keyとidentity keyを分離し、表示labelをdurable IDにしない", () => {
    const source = createCfsSource({
      deviceId: "serial:k2pro-69e7",
      unitIndex: 1,
      slotIndex: 0,
      displayLabel: "1A",
    });

    const locatorKey = createMaterialSourceLocatorKey(source.deviceId, source.locator);
    const identityKey = createMaterialSourceIdentityKey(source.deviceId, source.identity);

    expect(locatorKey).not.toBe(identityKey);
    expect(locatorKey).not.toContain("1A");
    expect(identityKey).not.toContain("1A");
    expect(source.materialSourceId).not.toBe("1A");
  });

  it("同じDevice/locatorを別sourceが名乗った場合は自動上書きせずconflictとして保持する", () => {
    const registry = createMaterialSourceRegistry();
    const source = createCfsSource({
      deviceId: "serial:k2pro-69e7",
      unitIndex: 1,
      slotIndex: 0,
    });
    const candidate = createMaterialSourceRecord({
      ...source,
      materialSourceId: "material-source:manual-candidate",
      identity: createMaterialSourceIdentity({
        deviceId: source.deviceId,
        unitId: source.unitId,
        kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
        slotIndex: 1,
      }),
      displayLabel: "1A candidate",
    });

    expect(registry.upsertSource(source).ok).toBe(true);
    const result = registry.upsertSource(candidate);

    expect(result).toMatchObject({ ok: false, action: "conflict" });
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        type: "locator-conflict",
        reason: "same-device-locator-different-source",
        existingMaterialSourceId: source.materialSourceId,
        candidateMaterialSourceId: candidate.materialSourceId,
      }),
    ]);
    expect(registry.resolveByLocator(source.deviceId, source.locator).materialSourceId).toBe(source.materialSourceId);
  });

  it("stable identityを別sourceが名乗った場合はidentity-conflictとして保持する", () => {
    const registry = createMaterialSourceRegistry();
    const source = createCfsSource({
      deviceId: "serial:k2pro-69e7",
      unitIndex: 1,
      slotIndex: 0,
      identityStrength: MATERIAL_IDENTITY_STRENGTH.STABLE,
    });
    const candidate = createMaterialSourceRecord({
      ...source,
      materialSourceId: "material-source:stable-candidate",
      locator: createMaterialSourceLocator({
        kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
        unitIndex: 1,
        boxId: 1,
        slotIndex: 1,
      }),
      displayLabel: "1B candidate",
    });

    expect(registry.upsertSource(source).ok).toBe(true);
    const result = registry.upsertSource(candidate);

    expect(result).toMatchObject({ ok: false, action: "conflict" });
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        type: "identity-conflict",
        reason: "same-stable-identity-different-source",
        existingMaterialSourceId: source.materialSourceId,
        candidateMaterialSourceId: candidate.materialSourceId,
      }),
    ]);
    expect(registry.resolveByIdentity(source.deviceId, source.identity).materialSourceId).toBe(source.materialSourceId);
  });

  it("provisional identityはstable identity indexへ登録せずfresh observation待ちにできる", () => {
    const registry = createMaterialSourceRegistry();
    const provisional = createCfsSource({
      deviceId: "serial:k2pro-69e7",
      unitIndex: 1,
      slotIndex: 2,
      identityStrength: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
    });

    expect(registry.upsertSource(provisional).ok).toBe(true);

    expect(registry.resolveByLocator(provisional.deviceId, provisional.locator).materialSourceId)
      .toBe(provisional.materialSourceId);
    expect(registry.resolveByIdentity(provisional.deviceId, provisional.identity)).toBeNull();
  });

  it("同一materialSourceId更新時は古いlocator indexを残さない", () => {
    const registry = createMaterialSourceRegistry();
    const source = createCfsSource({
      deviceId: "serial:k2pro-69e7",
      unitIndex: 1,
      slotIndex: 0,
      identityStrength: MATERIAL_IDENTITY_STRENGTH.STABLE,
    });
    const moved = createMaterialSourceRecord({
      ...source,
      locator: createMaterialSourceLocator({
        kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
        unitIndex: 1,
        boxId: 1,
        slotIndex: 2,
      }),
      displayLabel: "1C",
    });

    expect(registry.upsertSource(source)).toMatchObject({ ok: true, action: "insert" });
    expect(registry.upsertSource(moved)).toMatchObject({ ok: true, action: "update" });

    expect(registry.resolveByLocator(source.deviceId, source.locator)).toBeNull();
    expect(registry.resolveByLocator(moved.deviceId, moved.locator)).toMatchObject({
      materialSourceId: source.materialSourceId,
      displayLabel: "1C",
    });
    expect(registry.resolveByIdentity(source.deviceId, source.identity)).toMatchObject({
      materialSourceId: source.materialSourceId,
    });
  });

  it("同一materialSourceIdでDeviceやidentityを変える更新は拒否する", () => {
    const registry = createMaterialSourceRegistry();
    const source = createCfsSource({
      deviceId: "serial:k2pro-69e7",
      unitIndex: 1,
      slotIndex: 0,
      identityStrength: MATERIAL_IDENTITY_STRENGTH.STABLE,
    });
    const changedIdentity = createMaterialSourceRecord({
      ...source,
      identity: createMaterialSourceIdentity({
        deviceId: source.deviceId,
        unitId: source.unitId,
        kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
        slotIndex: 1,
      }),
    });
    const changedDevice = {
      ...source,
      deviceId: "serial:k2pro-other",
    };

    expect(registry.upsertSource(source)).toMatchObject({ ok: true, action: "insert" });

    expect(registry.upsertSource(changedIdentity)).toMatchObject({
      ok: false,
      action: "conflict",
      conflicts: [
        expect.objectContaining({
          type: "source-id-immutability-conflict",
          reason: "material-source-id-identity-changed",
        }),
      ],
    });
    expect(registry.upsertSource(changedDevice)).toMatchObject({
      ok: false,
      action: "conflict",
      conflicts: [
        expect.objectContaining({
          type: "source-id-immutability-conflict",
          reason: "material-source-id-device-changed",
        }),
      ],
    });
    expect(registry.getSource(source.materialSourceId).deviceId).toBe(source.deviceId);
  });

  it("invalid MaterialSourceはregistryへ保存せずvalidation errorを返す", () => {
    const registry = createMaterialSourceRegistry();
    const source = createCfsSource({
      deviceId: "serial:k2pro-69e7",
      unitIndex: 1,
      slotIndex: 0,
    });
    const invalid = {
      ...source,
      deviceId: "",
    };

    const result = registry.upsertSource(invalid);

    expect(result).toMatchObject({ ok: false, action: "invalid" });
    expect(result.errors).toContain("missing-deviceId");
    expect(registry.toJSON().sources).toEqual([]);
  });
});
