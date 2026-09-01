/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 MaterialAccounting SpoolMount service 単体テスト
 * @file printer_core_material_accounting_mount_service.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_material_accounting_mount_service_test
 *
 * 【機能内容サマリ】
 * - Gate 18.9H-1a のoperator-managed SpoolMount service contractを検証
 * - durable CAS成功後だけproduction mount成功扱いにする境界を固定
 * - legacy hostSpoolMapとのcross-backend重複拒否とreplace atomicityを固定
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1576 (PR #440)
 * @since   1.390.1576 (PR #440)
 * @lastModified 2026-09-01 13:20:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { describe, expect, it, vi } from "vitest";

import {
  FILAMENT_UNIT_KIND,
  MATERIAL_IDENTITY_STRENGTH,
  MATERIAL_SOURCE_KIND,
  SPOOL_MOUNT_STATUS,
  SPOOL_MOUNT_VERIFICATION,
  createFilamentUnitRecord,
  createMaterialSourceLocator,
  createMaterialSourceRecord,
  createSpoolMountRecord,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_contract.js";
import {
  normalizeStoredMaterialAccountingSpoolMountStore,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_mount_store.js";
import {
  createMaterialAccountingSpoolMountService,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_mount_service.js";

/**
 * テスト用MaterialSource recordを生成する。
 *
 * @function createSource
 * @param {Object} overrides - 上書き値。
 * @returns {Object} MaterialSource record。
 */
function createSource(overrides = {}) {
  const deviceId = overrides.deviceId || "device:k2";
  const unit = createFilamentUnitRecord({
    deviceId,
    kind: FILAMENT_UNIT_KIND.CFS,
    unitIndex: 1,
    unitId: overrides.unitId || "unit:k2:cfs:1",
    identityStrength: overrides.identityStrength || MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
  });
  const locator = createMaterialSourceLocator({
    kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
    unitIndex: 1,
    boxId: 1,
    slotIndex: overrides.slotIndex ?? 0,
  });
  return createMaterialSourceRecord({
    deviceId,
    unitId: unit.unitId,
    kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
    locator,
    materialSourceId: overrides.materialSourceId || "source:k2:cfs:1a",
    identityStrength: overrides.identityStrength || MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
    displayLabel: overrides.displayLabel || "1A",
  });
}

/**
 * テスト用SpoolMount recordを生成する。
 *
 * @function createOpenMount
 * @param {Object} overrides - 上書き値。
 * @returns {Object} SpoolMount record。
 */
function createOpenMount(overrides = {}) {
  return createSpoolMountRecord({
    materialSourceId: "source:k2:cfs:1a",
    spoolId: "spool:a",
    mountOperationId: "mount-op:existing",
    openedAt: "2026-09-01T00:00:00.000Z",
    openedBy: "operator",
    verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
    sourceIdentityStrengthAtOpen: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
    ...overrides,
  });
}

/**
 * mount済みserviceを生成する。
 *
 * @function createMountedService
 * @param {Object} overrides - 上書き値。
 * @returns {Object} service。
 */
function createMountedService(overrides = {}) {
  const mounts = [
    createOpenMount(),
    ...(overrides.extraMounts || []),
  ];
  return createMaterialAccountingSpoolMountService({
    store: normalizeStoredMaterialAccountingSpoolMountStore({ spoolMounts: mounts }),
    managedSpools: overrides.managedSpools || [{ id: "spool:a" }, { id: "spool:b" }],
    legacyHostSpoolMap: overrides.legacyHostSpoolMap || {},
    persist: overrides.persist || vi.fn(async () => ({ ok: true, casApplied: true })),
    now: () => "2026-09-01T01:00:00.000Z",
  });
}

/**
 * mount入力を生成する。
 *
 * @function createMountInput
 * @param {Object} overrides - 上書き値。
 * @returns {Object} mount入力。
 */
function createMountInput(overrides = {}) {
  return {
    operatorActionId: overrides.operatorActionId || "action:mount:1",
    expectedDeviceId: overrides.expectedDeviceId || "device:k2",
    materialSource: overrides.materialSource || createSource({
      materialSourceId: overrides.materialSourceId || "source:k2:cfs:1a",
      deviceId: overrides.sourceDeviceId || "device:k2",
      identityStrength: overrides.identityStrength || MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
    }),
    spoolId: overrides.spoolId || "spool:a",
    actor: overrides.actor || "operator",
  };
}

describe("MaterialAccountingSpoolMountService", () => {
  it("operatorMountSourceはCAS成功後だけmountを返す", async () => {
    const persist = vi.fn(async () => ({ ok: true, casApplied: true }));
    const service = createMaterialAccountingSpoolMountService({
      store: normalizeStoredMaterialAccountingSpoolMountStore(null),
      managedSpools: [{ id: "spool:a", deleted: false }],
      legacyHostSpoolMap: {},
      persist,
      now: () => "2026-09-01T00:00:00.000Z",
    });

    const result = await service.operatorMountSource(createMountInput());

    expect(result).toMatchObject({ ok: true, action: "mount" });
    expect(result.store.spoolMounts).toHaveLength(1);
    expect(result.store.events).toEqual([
      expect.objectContaining({
        kind: "operator-mount",
        operatorActionId: "action:mount:1",
      }),
    ]);
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({
      baseStoreDigest: expect.any(String),
      nextStore: expect.objectContaining({ spoolMounts: expect.any(Array) }),
      operation: expect.objectContaining({ kind: "operator-mount" }),
    }));
    expect(service.snapshot().spoolMounts).toHaveLength(1);
  });

  it("casApplied falseならmountを成功扱いにせずcurrent storeを保持する", async () => {
    const service = createMaterialAccountingSpoolMountService({
      store: normalizeStoredMaterialAccountingSpoolMountStore(null),
      managedSpools: [{ id: "spool:a", deleted: false }],
      legacyHostSpoolMap: {},
      persist: async () => ({ ok: true, casApplied: false }),
      now: () => "2026-09-01T00:00:00.000Z",
    });

    const result = await service.operatorMountSource(createMountInput());

    expect(result).toMatchObject({ ok: false, reason: "durable-cas-not-applied" });
    expect(result.store.spoolMounts).toEqual([]);
    expect(service.snapshot().spoolMounts).toEqual([]);
  });

  it("legacy hostSpoolMapで装着中のspoolはUniversal mountへ重複装着しない", async () => {
    const service = createMaterialAccountingSpoolMountService({
      store: normalizeStoredMaterialAccountingSpoolMountStore(null),
      managedSpools: [{ id: "spool:a", deleted: false }],
      legacyHostSpoolMap: { "K1Max-4A1B": "spool:a" },
      persist: vi.fn(async () => ({ ok: true, casApplied: true })),
      now: () => "2026-09-01T00:00:00.000Z",
    });

    const result = await service.operatorMountSource(createMountInput());

    expect(result).toMatchObject({ ok: false, reason: "legacy-spool-already-mounted" });
    expect(service.snapshot().spoolMounts).toEqual([]);
  });

  it("同じmulti-source deviceのlegacy spoolはmigration確認が必要な占有として拒否する", async () => {
    const service = createMaterialAccountingSpoolMountService({
      store: normalizeStoredMaterialAccountingSpoolMountStore(null),
      managedSpools: [{ id: "spool:a", deleted: false }],
      legacyHostSpoolMap: { "device:k2": "spool:a" },
      persist: vi.fn(async () => ({ ok: true, casApplied: true })),
      now: () => "2026-09-01T00:00:00.000Z",
    });

    const result = await service.operatorMountSource(createMountInput());

    expect(result).toMatchObject({ ok: false, reason: "legacy-spool-occupancy-requires-migration" });
    expect(service.snapshot().spoolMounts).toEqual([]);
  });

  it("同一deviceの別sourceへ別spoolを同時openできる", async () => {
    const persist = vi.fn(async () => ({ ok: true, casApplied: true }));
    const service = createMaterialAccountingSpoolMountService({
      store: normalizeStoredMaterialAccountingSpoolMountStore(null),
      managedSpools: [{ id: "spool:a" }, { id: "spool:b" }],
      legacyHostSpoolMap: {},
      persist,
      now: () => "2026-09-01T00:00:00.000Z",
    });

    expect(await service.operatorMountSource(createMountInput({
      operatorActionId: "action:mount:1a",
      materialSourceId: "source:k2:cfs:1a",
      spoolId: "spool:a",
    }))).toMatchObject({ ok: true });
    expect(await service.operatorMountSource(createMountInput({
      operatorActionId: "action:mount:1b",
      materialSourceId: "source:k2:cfs:1b",
      spoolId: "spool:b",
    }))).toMatchObject({ ok: true });

    expect(service.snapshot().spoolMounts.map((mount) => [mount.materialSourceId, mount.spoolId])).toEqual([
      ["source:k2:cfs:1a", "spool:a"],
      ["source:k2:cfs:1b", "spool:b"],
    ]);
  });

  it("unknown identity sourceはmanual mountしない", async () => {
    const service = createMaterialAccountingSpoolMountService({
      store: normalizeStoredMaterialAccountingSpoolMountStore(null),
      managedSpools: [{ id: "spool:a", deleted: false }],
      legacyHostSpoolMap: {},
      persist: vi.fn(async () => ({ ok: true, casApplied: true })),
      now: () => "2026-09-01T00:00:00.000Z",
    });

    const result = await service.operatorMountSource(createMountInput({
      identityStrength: MATERIAL_IDENTITY_STRENGTH.UNKNOWN,
    }));

    expect(result).toMatchObject({ ok: false, reason: "source-identity-required" });
    expect(service.snapshot().spoolMounts).toEqual([]);
  });

  it("wrong-device sourceはmanual mountしない", async () => {
    const service = createMaterialAccountingSpoolMountService({
      store: normalizeStoredMaterialAccountingSpoolMountStore(null),
      managedSpools: [{ id: "spool:a", deleted: false }],
      legacyHostSpoolMap: {},
      persist: vi.fn(async () => ({ ok: true, casApplied: true })),
      now: () => "2026-09-01T00:00:00.000Z",
    });

    const result = await service.operatorMountSource(createMountInput({
      expectedDeviceId: "device:k2-a",
      sourceDeviceId: "device:k2-b",
    }));

    expect(result).toMatchObject({ ok: false, reason: "material-source-device-mismatch" });
    expect(service.snapshot().spoolMounts).toEqual([]);
  });

  it("missing/deleted managed spoolはmanual mountしない", async () => {
    const missingService = createMaterialAccountingSpoolMountService({
      store: normalizeStoredMaterialAccountingSpoolMountStore(null),
      managedSpools: [],
      legacyHostSpoolMap: {},
      persist: vi.fn(async () => ({ ok: true, casApplied: true })),
      now: () => "2026-09-01T00:00:00.000Z",
    });
    const deletedService = createMaterialAccountingSpoolMountService({
      store: normalizeStoredMaterialAccountingSpoolMountStore(null),
      managedSpools: [{ id: "spool:a", deleted: true }],
      legacyHostSpoolMap: {},
      persist: vi.fn(async () => ({ ok: true, casApplied: true })),
      now: () => "2026-09-01T00:00:00.000Z",
    });

    expect(await missingService.operatorMountSource(createMountInput())).toMatchObject({
      ok: false,
      reason: "managed-spool-not-found",
    });
    expect(await deletedService.operatorMountSource(createMountInput())).toMatchObject({
      ok: false,
      reason: "managed-spool-deleted",
    });
  });

  it("expectedMountIdが現在open mountと違うunmountを拒否する", async () => {
    const service = createMountedService();

    const result = await service.operatorUnmountSource({
      operatorActionId: "action:close",
      materialSourceId: "source:k2:cfs:1a",
      expectedMountId: "mount:stale",
      actor: "operator",
      reason: "operator-unmount",
    });

    expect(result).toMatchObject({ ok: false, reason: "expected-mount-mismatch" });
    expect(service.snapshot().spoolMounts[0]).toMatchObject({ status: SPOOL_MOUNT_STATUS.OPEN });
  });

  it("operatorUnmountSourceはexpectedMountId一致時だけCAS後にcloseする", async () => {
    const persist = vi.fn(async () => ({ ok: true, casApplied: true }));
    const service = createMountedService({ persist });
    const oldMount = service.snapshot().spoolMounts[0];

    const result = await service.operatorUnmountSource({
      operatorActionId: "action:close",
      materialSourceId: "source:k2:cfs:1a",
      expectedMountId: oldMount.mountId,
      actor: "operator",
      reason: "operator-unmount",
    });

    expect(result).toMatchObject({ ok: true, action: "unmount" });
    expect(service.snapshot().spoolMounts[0]).toMatchObject({
      mountId: oldMount.mountId,
      status: SPOOL_MOUNT_STATUS.CLOSED,
      closeReason: "operator-unmount",
    });
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({
      operation: expect.objectContaining({ kind: "operator-unmount" }),
    }));
  });

  it("replaceのnew mount conflictではold mountをopenのまま保持する", async () => {
    const existingOther = createOpenMount({
      materialSourceId: "source:k2:cfs:1b",
      spoolId: "spool:b",
      mountOperationId: "mount-op:other",
    });
    const service = createMountedService({
      extraMounts: [existingOther],
    });
    const oldMount = service.snapshot().spoolMounts.find((mount) => mount.materialSourceId === "source:k2:cfs:1a");

    const result = await service.operatorReplaceSourceMount({
      operatorActionId: "action:replace",
      materialSource: createSource({ materialSourceId: "source:k2:cfs:1a" }),
      expectedOldMountId: oldMount.mountId,
      newSpoolId: "spool:b",
      actor: "operator",
    });

    expect(result).toMatchObject({ ok: false, reason: "spool-already-mounted-on-another-source" });
    expect(service.snapshot().spoolMounts.find((mount) => mount.mountId === oldMount.mountId)).toMatchObject({
      status: SPOOL_MOUNT_STATUS.OPEN,
      spoolId: "spool:a",
    });
  });

  it("operatorReplaceSourceMountはclose old + open newを1回のCASで反映する", async () => {
    const persist = vi.fn(async () => ({ ok: true, casApplied: true }));
    const service = createMountedService({ persist });
    const oldMount = service.snapshot().spoolMounts[0];

    const result = await service.operatorReplaceSourceMount({
      operatorActionId: "action:replace",
      materialSource: createSource({ materialSourceId: "source:k2:cfs:1a" }),
      expectedOldMountId: oldMount.mountId,
      newSpoolId: "spool:b",
      actor: "operator",
    });

    expect(result).toMatchObject({ ok: true, action: "replace" });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(service.snapshot().spoolMounts).toEqual([
      expect.objectContaining({ mountId: oldMount.mountId, status: SPOOL_MOUNT_STATUS.CLOSED }),
      expect.objectContaining({ materialSourceId: "source:k2:cfs:1a", spoolId: "spool:b", status: SPOOL_MOUNT_STATUS.OPEN }),
    ]);
  });

  it("replaceのCAS失敗ではold mountをopenのまま保持する", async () => {
    const service = createMountedService({
      persist: vi.fn(async () => ({ ok: false, casApplied: true, reason: "quota" })),
    });
    const oldMount = service.snapshot().spoolMounts[0];

    const result = await service.operatorReplaceSourceMount({
      operatorActionId: "action:replace",
      materialSource: createSource({ materialSourceId: "source:k2:cfs:1a" }),
      expectedOldMountId: oldMount.mountId,
      newSpoolId: "spool:b",
      actor: "operator",
    });

    expect(result).toMatchObject({ ok: false, reason: "durable-cas-not-applied" });
    expect(service.snapshot().spoolMounts).toEqual([oldMount]);
  });

  it("restart後も同operation同payloadはidempotentに扱う", async () => {
    const firstService = createMaterialAccountingSpoolMountService({
      store: normalizeStoredMaterialAccountingSpoolMountStore(null),
      managedSpools: [{ id: "spool:a" }],
      legacyHostSpoolMap: {},
      persist: vi.fn(async () => ({ ok: true, casApplied: true })),
      now: () => "2026-09-01T00:00:00.000Z",
    });
    const first = await firstService.operatorMountSource(createMountInput({ operatorActionId: "action:repeat" }));
    const restoredService = createMaterialAccountingSpoolMountService({
      store: first.store,
      managedSpools: [{ id: "spool:a" }],
      legacyHostSpoolMap: {},
      persist: vi.fn(async () => ({ ok: true, casApplied: true })),
      now: () => "2026-09-01T00:00:00.000Z",
    });

    const retry = await restoredService.operatorMountSource(createMountInput({ operatorActionId: "action:repeat" }));

    expect(retry).toMatchObject({ ok: true, action: "idempotent" });
    expect(retry.store.spoolMounts).toHaveLength(1);
    expect(retry.store.operationsById).toBeUndefined();
  });

  it("restart後の同operation異payloadはconflictにする", async () => {
    const firstService = createMaterialAccountingSpoolMountService({
      store: normalizeStoredMaterialAccountingSpoolMountStore(null),
      managedSpools: [{ id: "spool:a" }, { id: "spool:b" }],
      legacyHostSpoolMap: {},
      persist: vi.fn(async () => ({ ok: true, casApplied: true })),
      now: () => "2026-09-01T00:00:00.000Z",
    });
    const first = await firstService.operatorMountSource(createMountInput({
      operatorActionId: "action:repeat",
      spoolId: "spool:a",
    }));
    const restoredService = createMaterialAccountingSpoolMountService({
      store: first.store,
      managedSpools: [{ id: "spool:a" }, { id: "spool:b" }],
      legacyHostSpoolMap: {},
      persist: vi.fn(async () => ({ ok: true, casApplied: true })),
      now: () => "2026-09-01T00:00:00.000Z",
    });

    const retry = await restoredService.operatorMountSource(createMountInput({
      operatorActionId: "action:repeat",
      spoolId: "spool:b",
    }));

    expect(retry).toMatchObject({ ok: false, reason: "operator-action-payload-conflict" });
    expect(restoredService.snapshot().spoolMounts).toEqual(first.store.spoolMounts);
  });
});
