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
 * @version 1.390.1624 (PR #440)
 * @since   1.390.1576 (PR #440)
 * @lastModified 2026-09-02 06:58:30
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
  createMaterialAccountingSpoolMountOperationPayloadDigest,
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
    identity: overrides.identity,
    materialSourceId: overrides.materialSourceId || "source:k2:cfs:1a",
    identityStrength: overrides.identityStrength || MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
    displayLabel: overrides.displayLabel || "1A",
  });
}

/**
 * テスト用の現在値resolver群を生成する。
 *
 * @function createTrustedResolvers
 * @param {Object} overrides - 上書き値。
 * @returns {Object} serviceへ渡すresolver群。
 */
function createTrustedResolvers(overrides = {}) {
  const sourceById = overrides.sourceById || new Map([
    ["source:k2:cfs:1a", createSource({ materialSourceId: "source:k2:cfs:1a", slotIndex: 0 })],
    ["source:k2:cfs:1b", createSource({ materialSourceId: "source:k2:cfs:1b", slotIndex: 1 })],
  ]);
  const spoolsRef = overrides.spoolsRef || { current: overrides.managedSpools || [{ id: "spool:a" }, { id: "spool:b" }] };
  const legacyRef = overrides.legacyRef || { current: overrides.legacyHostSpoolMap || {} };
  return {
    spoolsRef,
    legacyRef,
    resolveMaterialSource: overrides.resolveMaterialSource || vi.fn((request) => sourceById.get(request.materialSourceId) || null),
    resolveManagedSpool: overrides.resolveManagedSpool || vi.fn((request) => {
      const target = String(request.spoolId || "").trim();
      return (spoolsRef.current || []).find((spool) => String(spool?.id || spool?.spoolId || "").trim() === target) || null;
    }),
    resolveLegacyOccupancy: overrides.resolveLegacyOccupancy || vi.fn((request) => {
      const target = String(request.spoolId || "").trim();
      const expectedDeviceId = String(request.expectedDeviceId || "").trim();
      for (const [host, spoolId] of Object.entries(legacyRef.current || {})) {
        if (String(spoolId || "").trim() !== target) {
          continue;
        }
        return {
          host,
          spoolId: target,
          reason: String(host || "").trim() === expectedDeviceId
            ? "legacy-spool-occupancy-requires-migration"
            : "legacy-spool-already-mounted",
        };
      }
      return null;
    }),
  };
}

/**
 * テスト用service入力を生成する。
 *
 * @function createServiceOptions
 * @param {Object} overrides - 上書き値。
 * @returns {Object} service入力。
 */
function createServiceOptions(overrides = {}) {
  const resolvers = createTrustedResolvers(overrides);
  return {
    store: overrides.store === undefined ? normalizeStoredMaterialAccountingSpoolMountStore(null) : overrides.store,
    resolveMaterialSource: resolvers.resolveMaterialSource,
    resolveManagedSpool: resolvers.resolveManagedSpool,
    resolveLegacyOccupancy: resolvers.resolveLegacyOccupancy,
    persist: overrides.persist || vi.fn(async () => ({ ok: true, casApplied: true })),
    now: overrides.now || (() => "2026-09-01T00:00:00.000Z"),
  };
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
 * テスト用既存mountのcreation eventを生成する。
 *
 * @function createOpenMountEvent
 * @param {Object} mount - SpoolMount record。
 * @returns {Object} operator mount creation event。
 */
function createOpenMountEvent(mount) {
  const payload = {
    kind: "operator-mount",
    operatorActionId: `action:${mount.mountOperationId}`,
    operationId: mount.mountOperationId,
    materialSourceId: mount.materialSourceId,
    spoolId: mount.spoolId,
  };
  return {
    eventId: `event:${mount.mountOperationId}`,
    kind: "operator-mount",
    operatorActionId: payload.operatorActionId,
    operationId: mount.mountOperationId,
    payload,
    payloadDigest: createMaterialAccountingSpoolMountOperationPayloadDigest(payload),
    recordRefs: [mount.mountId, mount.mountOperationId],
    createdAt: mount.openedAt,
    actor: mount.openedBy,
  };
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
  return createMaterialAccountingSpoolMountService(createServiceOptions({
    ...overrides,
    store: normalizeStoredMaterialAccountingSpoolMountStore({
      spoolMounts: mounts,
      events: mounts.map((mount) => createOpenMountEvent(mount)),
    }),
    now: () => "2026-09-01T01:00:00.000Z",
  }));
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
    materialSourceId: overrides.materialSourceId || "source:k2:cfs:1a",
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
    const service = createMaterialAccountingSpoolMountService(createServiceOptions({
      managedSpools: [{ id: "spool:a", deleted: false }],
      persist,
    }));

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
      preconditions: expect.objectContaining({
        managedSpool: expect.objectContaining({ spoolId: "spool:a", deleted: false }),
        materialSource: expect.objectContaining({ materialSourceId: "source:k2:cfs:1a" }),
      }),
    }));
    expect(service.snapshot().spoolMounts).toHaveLength(1);
  });

  it("casApplied falseならmountを成功扱いにせずcurrent storeを保持する", async () => {
    const service = createMaterialAccountingSpoolMountService(createServiceOptions({
      managedSpools: [{ id: "spool:a", deleted: false }],
      persist: async () => ({ ok: true, casApplied: false }),
    }));

    const result = await service.operatorMountSource(createMountInput());

    expect(result).toMatchObject({ ok: false, reason: "durable-cas-not-applied" });
    expect(result.store.spoolMounts).toEqual([]);
    expect(service.snapshot().spoolMounts).toEqual([]);
  });

  it("operatorActionIdが空のmount/replaceはevent無しauthorityを作らず拒否する", async () => {
    const mountService = createMaterialAccountingSpoolMountService(createServiceOptions({
      managedSpools: [{ id: "spool:a" }, { id: "spool:b" }],
      persist: vi.fn(async () => ({ ok: true, casApplied: true })),
    }));

    const mountResult = await mountService.operatorMountSource({
      ...createMountInput(),
      operatorActionId: "",
    });

    expect(mountResult).toMatchObject({ ok: false, reason: "operator-action-id-required" });
    expect(mountService.snapshot().spoolMounts).toEqual([]);
    expect(mountService.snapshot().events).toEqual([]);

    const replaceService = createMountedService();
    const oldMount = replaceService.snapshot().spoolMounts[0];
    const replaceResult = await replaceService.operatorReplaceSourceMount({
      operatorActionId: "",
      expectedDeviceId: "device:k2",
      materialSourceId: "source:k2:cfs:1a",
      expectedOldMountId: oldMount.mountId,
      newSpoolId: "spool:b",
      actor: "operator",
    });

    expect(replaceResult).toMatchObject({ ok: false, reason: "operator-action-id-required" });
    expect(replaceService.snapshot().spoolMounts).toEqual([oldMount]);
  });

  it("trusted MaterialSource resolverなしではcaller supplied sourceをauthorityとして扱わない", async () => {
    const service = createMaterialAccountingSpoolMountService({
      store: normalizeStoredMaterialAccountingSpoolMountStore(null),
      resolveManagedSpool: vi.fn(() => ({ id: "spool:a" })),
      resolveLegacyOccupancy: vi.fn(() => null),
      persist: vi.fn(async () => ({ ok: true, casApplied: true })),
      now: () => "2026-09-01T00:00:00.000Z",
    });

    const result = await service.operatorMountSource(createMountInput());

    expect(result).toMatchObject({ ok: false, reason: "trusted-material-source-resolver-required" });
    expect(result.store.spoolMounts).toEqual([]);
  });

  it("legacy hostSpoolMapで装着中のspoolはUniversal mountへ重複装着しない", async () => {
    const service = createMaterialAccountingSpoolMountService(createServiceOptions({
      managedSpools: [{ id: "spool:a", deleted: false }],
      legacyHostSpoolMap: { "K1Max-4A1B": "spool:a" },
    }));

    const result = await service.operatorMountSource(createMountInput());

    expect(result).toMatchObject({ ok: false, reason: "legacy-spool-already-mounted" });
    expect(service.snapshot().spoolMounts).toEqual([]);
  });

  it("同じmulti-source deviceのlegacy spoolはmigration確認が必要な占有として拒否する", async () => {
    const service = createMaterialAccountingSpoolMountService(createServiceOptions({
      managedSpools: [{ id: "spool:a", deleted: false }],
      legacyHostSpoolMap: { "device:k2": "spool:a" },
    }));

    const result = await service.operatorMountSource(createMountInput());

    expect(result).toMatchObject({ ok: false, reason: "legacy-spool-occupancy-requires-migration" });
    expect(service.snapshot().spoolMounts).toEqual([]);
  });

  it("同一deviceの別sourceへ別spoolを同時openできる", async () => {
    const persist = vi.fn(async () => ({ ok: true, casApplied: true }));
    const service = createMaterialAccountingSpoolMountService(createServiceOptions({
      managedSpools: [{ id: "spool:a" }, { id: "spool:b" }],
      persist,
    }));

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
    const service = createMaterialAccountingSpoolMountService(createServiceOptions({
      managedSpools: [{ id: "spool:a", deleted: false }],
      sourceById: new Map([
        ["source:k2:cfs:1a", createSource({ identityStrength: MATERIAL_IDENTITY_STRENGTH.UNKNOWN })],
      ]),
    }));

    const result = await service.operatorMountSource(createMountInput({
      identityStrength: MATERIAL_IDENTITY_STRENGTH.UNKNOWN,
    }));

    expect(result).toMatchObject({ ok: false, reason: "source-identity-required" });
    expect(service.snapshot().spoolMounts).toEqual([]);
  });

  it("wrong-device sourceはmanual mountしない", async () => {
    const service = createMaterialAccountingSpoolMountService(createServiceOptions({
      managedSpools: [{ id: "spool:a", deleted: false }],
      sourceById: new Map([
        ["source:k2:cfs:1a", createSource({ deviceId: "device:k2-b" })],
      ]),
    }));

    const result = await service.operatorMountSource(createMountInput({
      expectedDeviceId: "device:k2-a",
      sourceDeviceId: "device:k2-b",
    }));

    expect(result).toMatchObject({ ok: false, reason: "material-source-device-mismatch" });
    expect(service.snapshot().spoolMounts).toEqual([]);
  });

  it("missing/deleted managed spoolはmanual mountしない", async () => {
    const missingService = createMaterialAccountingSpoolMountService(createServiceOptions({
      managedSpools: [],
    }));
    const deletedService = createMaterialAccountingSpoolMountService(createServiceOptions({
      managedSpools: [{ id: "spool:a", deleted: true }],
    }));

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
      expectedDeviceId: "device:k2",
      materialSourceId: "source:k2:cfs:1a",
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
      expectedDeviceId: "device:k2",
      materialSourceId: "source:k2:cfs:1a",
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
      expectedDeviceId: "device:k2",
      materialSourceId: "source:k2:cfs:1a",
      expectedOldMountId: oldMount.mountId,
      newSpoolId: "spool:b",
      actor: "operator",
    });

    expect(result).toMatchObject({ ok: false, reason: "durable-cas-not-applied" });
    expect(service.snapshot().spoolMounts).toEqual([oldMount]);
  });

  it("restart後も同operation同payloadはidempotentに扱う", async () => {
    const firstService = createMaterialAccountingSpoolMountService(createServiceOptions({
      managedSpools: [{ id: "spool:a" }],
      persist: vi.fn(async () => ({ ok: true, casApplied: true })),
      now: () => "2026-09-01T00:00:00.000Z",
    }));
    const first = await firstService.operatorMountSource(createMountInput({ operatorActionId: "action:repeat" }));
    const restoredService = createMaterialAccountingSpoolMountService(createServiceOptions({
      store: first.store,
      managedSpools: [{ id: "spool:a" }],
      persist: vi.fn(async () => ({ ok: true, casApplied: true })),
      now: () => "2026-09-01T01:00:00.000Z",
    }));

    const retry = await restoredService.operatorMountSource(createMountInput({ operatorActionId: "action:repeat" }));

    expect(retry).toMatchObject({ ok: true, action: "idempotent" });
    expect(retry.store.spoolMounts).toHaveLength(1);
    expect(retry.store.operationsById).toBeUndefined();
  });

  it("restart後の同operation再送は現在sourceが未観測でも既存operationを先に返す", async () => {
    const firstService = createMaterialAccountingSpoolMountService(createServiceOptions({
      managedSpools: [{ id: "spool:a" }],
      persist: vi.fn(async () => ({ ok: true, casApplied: true })),
      now: () => "2026-09-01T00:00:00.000Z",
    }));
    const first = await firstService.operatorMountSource(createMountInput({ operatorActionId: "action:repeat:offline" }));
    const restoredService = createMaterialAccountingSpoolMountService(createServiceOptions({
      store: first.store,
      managedSpools: [{ id: "spool:a" }],
      resolveMaterialSource: vi.fn(() => null),
      persist: vi.fn(async () => ({ ok: true, casApplied: true })),
      now: () => "2026-09-01T02:00:00.000Z",
    }));

    const retry = await restoredService.operatorMountSource(createMountInput({ operatorActionId: "action:repeat:offline" }));

    expect(retry).toMatchObject({ ok: true, action: "idempotent" });
    expect(restoredService.snapshot().spoolMounts).toEqual(first.store.spoolMounts);
  });

  it("restart後の同operation異payloadはconflictにする", async () => {
    const firstService = createMaterialAccountingSpoolMountService(createServiceOptions({
      managedSpools: [{ id: "spool:a" }, { id: "spool:b" }],
      persist: vi.fn(async () => ({ ok: true, casApplied: true })),
    }));
    const first = await firstService.operatorMountSource(createMountInput({
      operatorActionId: "action:repeat",
      spoolId: "spool:a",
    }));
    const restoredService = createMaterialAccountingSpoolMountService(createServiceOptions({
      store: first.store,
      managedSpools: [{ id: "spool:a" }, { id: "spool:b" }],
      persist: vi.fn(async () => ({ ok: true, casApplied: true })),
    }));

    const retry = await restoredService.operatorMountSource(createMountInput({
      operatorActionId: "action:repeat",
      spoolId: "spool:b",
    }));

    expect(retry).toMatchObject({ ok: false, reason: "operator-action-payload-conflict" });
    expect(restoredService.snapshot().spoolMounts).toEqual(first.store.spoolMounts);
  });

  it("managed spoolとlegacy占有はservice生成時snapshotではなく送信時resolver結果で判定する", async () => {
    const spoolsRef = { current: [{ id: "spool:a", deleted: false }] };
    const legacyRef = { current: {} };
    const service = createMaterialAccountingSpoolMountService(createServiceOptions({
      spoolsRef,
      legacyRef,
    }));

    spoolsRef.current = [{ id: "spool:a", isDeleted: true }];
    expect(await service.operatorMountSource(createMountInput({
      operatorActionId: "action:deleted-at-send",
    }))).toMatchObject({ ok: false, reason: "managed-spool-deleted" });

    spoolsRef.current = [{ id: "spool:a", deleted: false }];
    legacyRef.current = { "K1Max-4A1B": "spool:a" };
    expect(await service.operatorMountSource(createMountInput({
      operatorActionId: "action:occupied-at-send",
    }))).toMatchObject({ ok: false, reason: "legacy-spool-already-mounted" });
  });

  it("replaceはrequest内sourceではなくresolverで得たdeviceをexpectedDeviceIdへ照合する", async () => {
    const service = createMountedService({
      sourceById: new Map([
        ["source:k2:cfs:1a", createSource({ materialSourceId: "source:k2:cfs:1a", deviceId: "device:k2-b" })],
      ]),
    });
    const oldMount = service.snapshot().spoolMounts[0];

    const result = await service.operatorReplaceSourceMount({
      operatorActionId: "action:replace:wrong-device",
      expectedDeviceId: "device:k2-a",
      materialSourceId: "source:k2:cfs:1a",
      expectedOldMountId: oldMount.mountId,
      newSpoolId: "spool:b",
      actor: "operator",
    });

    expect(result).toMatchObject({ ok: false, reason: "material-source-device-mismatch" });
  });

  it("source identity evidenceが変わるとsourceIdentityDigestAtOpenも変わる", async () => {
    const firstPersist = vi.fn(async () => ({ ok: true, casApplied: true }));
    const secondPersist = vi.fn(async () => ({ ok: true, casApplied: true }));
    const firstService = createMaterialAccountingSpoolMountService(createServiceOptions({
      persist: firstPersist,
      sourceById: new Map([
        ["source:k2:cfs:1a", createSource({
          identity: { namespace: "material-source", parts: ["device:k2", "unit:k2:cfs:1", "cfs-slot", 0, "rfid-a"] },
        })],
      ]),
    }));
    const secondService = createMaterialAccountingSpoolMountService(createServiceOptions({
      persist: secondPersist,
      sourceById: new Map([
        ["source:k2:cfs:1a", createSource({
          identity: { namespace: "material-source", parts: ["device:k2", "unit:k2:cfs:1", "cfs-slot", 0, "rfid-b"] },
        })],
      ]),
    }));

    const first = await firstService.operatorMountSource(createMountInput({ operatorActionId: "action:identity:a" }));
    const second = await secondService.operatorMountSource(createMountInput({ operatorActionId: "action:identity:b" }));

    expect(first.record.sourceBindingAtOpen.identity).toEqual({
      namespace: "material-source",
      parts: ["device:k2", "unit:k2:cfs:1", "cfs-slot", 0, "rfid-a"],
    });
    expect(first.record.sourceBindingAtOpen.sourceIdentityDigest)
      .not.toBe(second.record.sourceBindingAtOpen.sourceIdentityDigest);
  });

  it("durable writer例外はthrowせず失敗結果としてcurrent storeを保持する", async () => {
    const service = createMaterialAccountingSpoolMountService(createServiceOptions({
      persist: vi.fn(async () => {
        throw new Error("disk failed");
      }),
    }));

    const result = await service.operatorMountSource(createMountInput());

    expect(result).toMatchObject({ ok: false, reason: "durable-writer-threw" });
    expect(service.snapshot().spoolMounts).toEqual([]);
  });
});
