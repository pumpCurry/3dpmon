/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 MaterialAccounting SpoolMount service モジュール
 * @file dashboard_material_accounting_mount_service.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_accounting_mount_service
 *
 * 【機能内容サマリ】
 * - Gate 18.9H-1a のoperator-managed SpoolMount serviceを提供
 * - mount / unmount / replace をstaged transactionとして構築しdurable CAS成功後だけ反映
 * - legacy hostSpoolMapとのcross-backend spool重複をread-only検査で拒否
 *
 * 【公開関数一覧】
 * - {@link createMaterialAccountingSpoolMountService}：SpoolMount serviceを生成
 *
 * @version 1.390.1578 (PR #440)
 * @since   1.390.1576 (PR #440)
 * @lastModified 2026-09-01 13:22:00
 * -----------------------------------------------------------
 * @todo
 * - Gate 18.9H-1bでmonitorData/shared storage/IndexedDB CASへ接続する
 */

"use strict";

import {
  MATERIAL_IDENTITY_STRENGTH,
  SPOOL_MOUNT_STATUS,
  SPOOL_MOUNT_VERIFICATION,
  createSpoolMountRecord,
  validateMaterialSource,
} from "./dashboard_material_accounting_contract.js";
import {
  createPrinterCoreV3DeterministicId,
} from "./dashboard_data_schema_v3.js";
import {
  createMaterialAccountingSpoolMountOperationPayloadDigest,
  createMaterialAccountingSpoolMountStoreDigest,
  normalizeStoredMaterialAccountingSpoolMountStore,
} from "./dashboard_material_accounting_mount_store.js";
import { createSpoolMountRepository } from "./dashboard_spool_mount_repository.js";

/**
 * JSON互換値をcloneする。
 *
 * @private
 * @function cloneJsonValue
 * @param {*} value - clone対象。
 * @returns {*} clone済み値。
 */
function cloneJsonValue(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * JSON互換値を再帰freezeする。
 *
 * @private
 * @function deepFreezeJson
 * @param {*} value - freeze対象。
 * @returns {*} freeze済み値。
 */
function deepFreezeJson(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreezeJson(child);
  }
  return Object.freeze(value);
}

/**
 * 値をtrim済み文字列へ変換する。
 *
 * @private
 * @function toTrimmedString
 * @param {*} value - 文字列候補。
 * @returns {string} trim済み文字列。
 */
function toTrimmedString(value) {
  return String(value ?? "").trim();
}

/**
 * service resultを生成する。
 *
 * @private
 * @function createServiceResult
 * @param {Object} input - result入力。
 * @param {boolean} input.ok - 成功可否。
 * @param {string} input.action - action名。
 * @param {string=} input.reason - 失敗理由。
 * @param {Object} input.store - currentまたはnext store。
 * @param {Object|null=} input.record - 対象mount record。
 * @param {Object|null=} input.operation - operation event。
 * @param {Array<string>=} input.errors - error配列。
 * @returns {Object} service result。
 */
function createServiceResult({
  ok,
  action,
  reason = "",
  store,
  record = null,
  operation = null,
  errors = [],
}) {
  return deepFreezeJson({
    ok,
    action,
    reason: reason || null,
    store: normalizeStoredMaterialAccountingSpoolMountStore(store),
    record: record ? cloneJsonValue(record) : null,
    operation: operation ? cloneJsonValue(operation) : null,
    errors: [...errors],
  });
}

/**
 * operation payload digestを生成する。
 *
 * @private
 * @function createOperationPayloadDigest
 * @param {Object} payload - operation payload。
 * @returns {string} payload digest。
 */
function createOperationPayloadDigest(payload) {
  return createMaterialAccountingSpoolMountOperationPayloadDigest(payload);
}

/**
 * operation eventを生成する。
 *
 * @private
 * @function createOperationEvent
 * @param {Object} input - event入力。
 * @param {string} input.kind - event種別。
 * @param {string} input.operatorActionId - operator action ID。
 * @param {string} input.operationId - operation ID。
 * @param {Object} input.payload - semantic payload。
 * @param {Array<string>=} input.recordRefs - eventが参照するmount/operation ID。
 * @param {string} input.createdAt - 作成日時。
 * @param {string=} input.actor - actor。
 * @returns {Object} operation event。
 */
function createOperationEvent(input = {}) {
  const kind = toTrimmedString(input.kind);
  const operatorActionId = toTrimmedString(input.operatorActionId);
  const operationId = toTrimmedString(input.operationId);
  const payload = cloneJsonValue(input.payload || {});
  const payloadDigest = createOperationPayloadDigest(payload);
  return deepFreezeJson({
    eventId: createPrinterCoreV3DeterministicId("material-accounting-spool-mount-event", [
      kind,
      operatorActionId,
      operationId,
      payloadDigest,
    ]),
    kind,
    operatorActionId,
    operationId,
    payloadDigest,
    payload,
    recordRefs: Array.isArray(input.recordRefs)
      ? input.recordRefs.map((ref) => toTrimmedString(ref)).filter(Boolean)
      : [],
    createdAt: toTrimmedString(input.createdAt),
    actor: toTrimmedString(input.actor) || null,
  });
}

/**
 * storeからoperation indexを再構築する。
 *
 * @private
 * @function buildOperationIndex
 * @param {Object} store - 正規化済みstore。
 * @returns {Map<string, Object>} operation index。
 */
function buildOperationIndex(store) {
  const index = new Map();
  for (const event of store.events || []) {
    const key = `${toTrimmedString(event.kind)}:${toTrimmedString(event.operatorActionId)}`;
    if (!key.endsWith(":")) {
      index.set(key, event);
    }
  }
  return index;
}

/**
 * managed spoolを取得する。
 *
 * @private
 * @function findManagedSpool
 * @param {Array<Object>} managedSpools - managed spool配列。
 * @param {string} spoolId - spool ID。
 * @returns {Object|null} managed spool。
 */
function findManagedSpool(managedSpools, spoolId) {
  const target = toTrimmedString(spoolId);
  return managedSpools.find((spool) => toTrimmedString(spool?.id || spool?.spoolId) === target) || null;
}

/**
 * material sourceを検証する。
 *
 * @private
 * @function validateOperatorMaterialSource
 * @param {Object} materialSource - MaterialSource record。
 * @param {string} expectedDeviceId - 期待device ID。
 * @returns {{ok:boolean, reason:string, errors:string[]}} 検証結果。
 */
function validateOperatorMaterialSource(materialSource, expectedDeviceId) {
  const validation = validateMaterialSource(materialSource);
  if (!validation.ok) {
    return { ok: false, reason: "invalid-material-source", errors: validation.errors };
  }
  if (toTrimmedString(materialSource.deviceId) !== toTrimmedString(expectedDeviceId)) {
    return { ok: false, reason: "material-source-device-mismatch", errors: [] };
  }
  if (materialSource.identityStrength === MATERIAL_IDENTITY_STRENGTH.UNKNOWN) {
    return { ok: false, reason: "source-identity-required", errors: [] };
  }
  return { ok: true, reason: "", errors: [] };
}

/**
 * legacy hostSpoolMap側のspool占有を検査する。
 *
 * @private
 * @function findLegacySpoolOccupancy
 * @param {Object} legacyHostSpoolMap - legacy hostSpoolMap。
 * @param {string} spoolId - 検査対象spool ID。
 * @param {string} expectedDeviceId - 期待device ID。
 * @returns {{reason:string, host:string}|null} legacy占有情報。
 */
function findLegacySpoolOccupancy(legacyHostSpoolMap, spoolId, expectedDeviceId) {
  if (!legacyHostSpoolMap || typeof legacyHostSpoolMap !== "object") {
    return null;
  }
  const target = toTrimmedString(spoolId);
  for (const [host, mountedSpoolId] of Object.entries(legacyHostSpoolMap)) {
    if (toTrimmedString(mountedSpoolId) !== target) {
      continue;
    }
    return {
      host,
      reason: toTrimmedString(host) === toTrimmedString(expectedDeviceId)
        ? "legacy-spool-occupancy-requires-migration"
        : "legacy-spool-already-mounted",
    };
  }
  return null;
}

/**
 * source binding evidenceを生成する。
 *
 * @private
 * @function createSourceBindingAtOpen
 * @param {Object} source - MaterialSource record。
 * @param {string} resolvedAt - 解決日時。
 * @returns {Object} source binding evidence。
 */
function createSourceBindingAtOpen(source, resolvedAt) {
  const binding = {
    deviceId: source.deviceId,
    materialSourceId: source.materialSourceId,
    unitId: source.unitId,
    kind: source.kind,
    identityStrength: source.identityStrength,
    locator: cloneJsonValue(source.locator || null),
    resolvedAt,
  };
  return deepFreezeJson({
    ...binding,
    sourceIdentityDigest: createPrinterCoreV3DeterministicId("material-source-binding", [
      binding.deviceId,
      binding.materialSourceId,
      binding.unitId,
      binding.kind,
      binding.identityStrength,
      binding.locator,
    ]),
  });
}

/**
 * operation index上の既存payloadを検査する。
 *
 * @private
 * @function evaluateExistingOperation
 * @param {Map<string,Object>} operationIndex - operation index。
 * @param {string} kind - event種別。
 * @param {string} operatorActionId - operator action ID。
 * @param {Object} payload - semantic payload。
 * @returns {{status:string, event:Object|null}} operation状態。
 */
function evaluateExistingOperation(operationIndex, kind, operatorActionId, payload) {
  const event = operationIndex.get(`${kind}:${operatorActionId}`);
  if (!event) {
    return { status: "new", event: null };
  }
  const payloadDigest = createOperationPayloadDigest(payload);
  return {
    status: event.payloadDigest === payloadDigest ? "idempotent" : "conflict",
    event,
  };
}

/**
 * storeへeventを追加して正規化する。
 *
 * @private
 * @function appendEventToStore
 * @param {Object} store - base store。
 * @param {Object} event - operation event。
 * @param {Array<Object>} mounts - mount配列。
 * @returns {Object} next store。
 */
function appendEventToStore(store, event, mounts) {
  return normalizeStoredMaterialAccountingSpoolMountStore({
    ...cloneJsonValue(store),
    storeRevision: Number(store.storeRevision || 0) + 1,
    storeDigest: "",
    spoolMounts: mounts,
    events: [...(store.events || []), event],
  });
}

/**
 * durable writer結果を検査する。
 *
 * @private
 * @function persistNextStore
 * @param {Function} persist - durable writer callback。
 * @param {Object} baseStore - base store。
 * @param {Object} nextStore - next store。
 * @param {Object} operation - operation event。
 * @returns {Promise<{ok:boolean, reason:string, durable:Object|null}>} durable結果。
 */
async function persistNextStore(persist, baseStore, nextStore, operation) {
  if (typeof persist !== "function") {
    return { ok: false, reason: "durable-writer-required", durable: null };
  }
  const durable = await persist({
    baseStoreDigest: createMaterialAccountingSpoolMountStoreDigest(baseStore),
    nextStore,
    operation,
  });
  if (!durable || durable.ok !== true || durable.casApplied !== true) {
    return { ok: false, reason: "durable-cas-not-applied", durable: durable || null };
  }
  return { ok: true, reason: "", durable };
}

/**
 * repository conflictからservice reasonを取得する。
 *
 * @private
 * @function getRepositoryConflictReason
 * @param {Object} result - repository result。
 * @returns {string} reason。
 */
function getRepositoryConflictReason(result) {
  return toTrimmedString(result?.conflicts?.[0]?.reason) ||
    toTrimmedString(result?.errors?.[0]) ||
    toTrimmedString(result?.action) ||
    "repository-conflict";
}

/**
 * MaterialAccounting SpoolMount serviceを生成する。
 *
 * 【詳細説明】
 * - このserviceはGate18.9H-1aのpure service層であり、monitorDataやIndexedDBを直接触らない。
 * - 呼び出し側から注入されたdurable writerが`casApplied:true`を返した場合だけcurrent storeを差し替える。
 * - `hostSpoolMap`はlegacy compatibility authorityとしてread-only参照し、同一spoolの二重装着を拒否する。
 *
 * @function createMaterialAccountingSpoolMountService
 * @param {Object} input - service入力。
 * @param {Object=} input.store - 初期SpoolMount store。
 * @param {Array<Object>=} input.managedSpools - 3DPmon管理スプール一覧。
 * @param {Object=} input.legacyHostSpoolMap - legacy hostSpoolMap。
 * @param {Function=} input.persist - durable writer callback。
 * @param {Function=} input.now - 現在時刻関数。
 * @returns {Object} service API。
 * @example
 * const service = createMaterialAccountingSpoolMountService({ store, managedSpools, persist });
 */
export function createMaterialAccountingSpoolMountService(input = {}) {
  let currentStore = normalizeStoredMaterialAccountingSpoolMountStore(input.store);
  const managedSpools = Array.isArray(input.managedSpools) ? input.managedSpools.map((spool) => cloneJsonValue(spool)) : [];
  const legacyHostSpoolMap = input.legacyHostSpoolMap && typeof input.legacyHostSpoolMap === "object"
    ? cloneJsonValue(input.legacyHostSpoolMap)
    : {};
  const persist = input.persist;
  const now = typeof input.now === "function" ? input.now : () => new Date().toISOString();

  /**
   * current store snapshotを返す。
   *
   * @function snapshot
   * @returns {Object} current store snapshot。
   */
  function snapshot() {
    return normalizeStoredMaterialAccountingSpoolMountStore(currentStore);
  }

  /**
   * durable CAS成功後にcurrent storeを更新する。
   *
   * @private
   * @function commitNextStore
   * @param {Object} nextStore - 次store。
   * @param {Object} operation - operation event。
   * @returns {Promise<{ok:boolean, reason:string}>} commit結果。
   */
  async function commitNextStore(nextStore, operation) {
    const durable = await persistNextStore(persist, currentStore, nextStore, operation);
    if (!durable.ok) {
      return durable;
    }
    currentStore = normalizeStoredMaterialAccountingSpoolMountStore(nextStore);
    return durable;
  }

  /**
   * MaterialSourceへmanaged spoolをmountする。
   *
   * @function operatorMountSource
   * @param {Object} request - mount request。
   * @param {string} request.operatorActionId - operator action ID。
   * @param {string} request.expectedDeviceId - 期待device ID。
   * @param {Object} request.materialSource - MaterialSource record。
   * @param {string} request.spoolId - managed spool ID。
   * @param {string=} request.actor - actor。
   * @returns {Promise<Object>} service result。
   */
  async function operatorMountSource(request = {}) {
    const operatorActionId = toTrimmedString(request.operatorActionId);
    const expectedDeviceId = toTrimmedString(request.expectedDeviceId);
    const spoolId = toTrimmedString(request.spoolId);
    const createdAt = now();
    const sourceValidation = validateOperatorMaterialSource(request.materialSource, expectedDeviceId);
    if (!sourceValidation.ok) {
      return createServiceResult({
        ok: false,
        action: "mount",
        reason: sourceValidation.reason,
        store: currentStore,
        errors: sourceValidation.errors,
      });
    }
    const spool = findManagedSpool(managedSpools, spoolId);
    if (!spool) {
      return createServiceResult({ ok: false, action: "mount", reason: "managed-spool-not-found", store: currentStore });
    }
    if (spool.deleted === true) {
      return createServiceResult({ ok: false, action: "mount", reason: "managed-spool-deleted", store: currentStore });
    }
    const legacyOccupancy = findLegacySpoolOccupancy(legacyHostSpoolMap, spoolId, expectedDeviceId);
    if (legacyOccupancy) {
      return createServiceResult({ ok: false, action: "mount", reason: legacyOccupancy.reason, store: currentStore });
    }

    const sourceBindingAtOpen = createSourceBindingAtOpen(request.materialSource, createdAt);
    const payload = {
      kind: "operator-mount",
      operatorActionId,
      expectedDeviceId,
      materialSourceId: request.materialSource.materialSourceId,
      spoolId,
      sourceBindingAtOpen,
    };
    const operationId = createPrinterCoreV3DeterministicId("material-accounting-spool-mount-operation", [
      "mount",
      operatorActionId,
      request.materialSource.materialSourceId,
      spoolId,
    ]);
    const existingOperation = evaluateExistingOperation(buildOperationIndex(currentStore), "operator-mount", operatorActionId, payload);
    if (existingOperation.status === "idempotent") {
      return createServiceResult({ ok: true, action: "idempotent", store: currentStore, operation: existingOperation.event });
    }
    if (existingOperation.status === "conflict") {
      return createServiceResult({ ok: false, action: "mount", reason: "operator-action-payload-conflict", store: currentStore });
    }

    const mount = deepFreezeJson({
      ...createSpoolMountRecord({
        mountId: createPrinterCoreV3DeterministicId("spool-mount", [
          operationId,
          request.materialSource.materialSourceId,
          spoolId,
          createdAt,
        ]),
        materialSourceId: request.materialSource.materialSourceId,
        spoolId,
        mountOperationId: operationId,
        openedAt: createdAt,
        openedBy: toTrimmedString(request.actor) || "operator",
        verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
        sourceIdentityStrengthAtOpen: request.materialSource.identityStrength,
      }),
      mountSubjectId: createPrinterCoreV3DeterministicId("spool-mount-subject", [
        request.materialSource.deviceId,
        request.materialSource.materialSourceId,
      ]),
      sourceBindingAtOpen,
    });
    const repository = createSpoolMountRepository(currentStore.spoolMounts);
    const repositoryResult = repository.recordMount(mount);
    if (!repositoryResult.ok) {
      return createServiceResult({
        ok: false,
        action: "mount",
        reason: getRepositoryConflictReason(repositoryResult),
        store: currentStore,
      });
    }
    const event = createOperationEvent({
      kind: "operator-mount",
      operatorActionId,
      operationId,
      payload,
      recordRefs: [mount.mountId, mount.mountOperationId],
      createdAt,
      actor: request.actor,
    });
    const nextStore = appendEventToStore(currentStore, event, repository.toJSON().mounts);
    const commit = await commitNextStore(nextStore, event);
    if (!commit.ok) {
      return createServiceResult({ ok: false, action: "mount", reason: commit.reason, store: currentStore, operation: event });
    }
    return createServiceResult({ ok: true, action: "mount", store: currentStore, record: mount, operation: event });
  }

  /**
   * MaterialSourceのopen mountをoperator操作で解除する。
   *
   * @function operatorUnmountSource
   * @param {Object} request - unmount request。
   * @param {string} request.operatorActionId - operator action ID。
   * @param {string} request.materialSourceId - MaterialSource ID。
   * @param {string} request.expectedMountId - UIが束縛したmount ID。
   * @param {string=} request.actor - actor。
   * @param {string=} request.reason - close理由。
   * @returns {Promise<Object>} service result。
   */
  async function operatorUnmountSource(request = {}) {
    const operatorActionId = toTrimmedString(request.operatorActionId);
    const materialSourceId = toTrimmedString(request.materialSourceId);
    const expectedMountId = toTrimmedString(request.expectedMountId);
    const createdAt = now();
    const payload = {
      kind: "operator-unmount",
      operatorActionId,
      materialSourceId,
      expectedMountId,
      reason: toTrimmedString(request.reason) || "operator-unmount",
    };
    const operationId = createPrinterCoreV3DeterministicId("material-accounting-spool-mount-operation", [
      "unmount",
      operatorActionId,
      expectedMountId,
    ]);
    const existingOperation = evaluateExistingOperation(buildOperationIndex(currentStore), "operator-unmount", operatorActionId, payload);
    if (existingOperation.status === "idempotent") {
      return createServiceResult({ ok: true, action: "idempotent", store: currentStore, operation: existingOperation.event });
    }
    if (existingOperation.status === "conflict") {
      return createServiceResult({ ok: false, action: "unmount", reason: "operator-action-payload-conflict", store: currentStore });
    }
    const repository = createSpoolMountRepository(currentStore.spoolMounts);
    const currentMount = repository.getOpenMountForSource(materialSourceId);
    if (!currentMount) {
      return createServiceResult({ ok: false, action: "unmount", reason: "open-mount-not-found", store: currentStore });
    }
    if (currentMount.mountId !== expectedMountId) {
      return createServiceResult({ ok: false, action: "unmount", reason: "expected-mount-mismatch", store: currentStore, record: currentMount });
    }
    const closeResult = repository.closeMount({
      mountId: expectedMountId,
      closeOperationId: operationId,
      closedAt: createdAt,
      closedBy: toTrimmedString(request.actor) || "operator",
      reason: payload.reason,
    });
    if (!closeResult.ok) {
      return createServiceResult({
        ok: false,
        action: "unmount",
        reason: getRepositoryConflictReason(closeResult),
        store: currentStore,
        record: currentMount,
      });
    }
    const event = createOperationEvent({
      kind: "operator-unmount",
      operatorActionId,
      operationId,
      payload,
      recordRefs: [expectedMountId, operationId],
      createdAt,
      actor: request.actor,
    });
    const nextStore = appendEventToStore(currentStore, event, repository.toJSON().mounts);
    const commit = await commitNextStore(nextStore, event);
    if (!commit.ok) {
      return createServiceResult({ ok: false, action: "unmount", reason: commit.reason, store: currentStore, operation: event });
    }
    return createServiceResult({ ok: true, action: "unmount", store: currentStore, record: closeResult.record, operation: event });
  }

  /**
   * MaterialSourceのmanaged spoolをatomicに交換する。
   *
   * @function operatorReplaceSourceMount
   * @param {Object} request - replace request。
   * @param {string} request.operatorActionId - operator action ID。
   * @param {Object} request.materialSource - MaterialSource record。
   * @param {string} request.expectedOldMountId - UIが束縛した旧mount ID。
   * @param {string} request.newSpoolId - 新managed spool ID。
   * @param {string=} request.actor - actor。
   * @returns {Promise<Object>} service result。
   */
  async function operatorReplaceSourceMount(request = {}) {
    const operatorActionId = toTrimmedString(request.operatorActionId);
    const expectedOldMountId = toTrimmedString(request.expectedOldMountId);
    const newSpoolId = toTrimmedString(request.newSpoolId);
    const expectedDeviceId = toTrimmedString(request.materialSource?.deviceId);
    const createdAt = now();
    const sourceValidation = validateOperatorMaterialSource(request.materialSource, expectedDeviceId);
    if (!sourceValidation.ok) {
      return createServiceResult({
        ok: false,
        action: "replace",
        reason: sourceValidation.reason,
        store: currentStore,
        errors: sourceValidation.errors,
      });
    }
    const spool = findManagedSpool(managedSpools, newSpoolId);
    if (!spool) {
      return createServiceResult({ ok: false, action: "replace", reason: "managed-spool-not-found", store: currentStore });
    }
    if (spool.deleted === true) {
      return createServiceResult({ ok: false, action: "replace", reason: "managed-spool-deleted", store: currentStore });
    }
    const legacyOccupancy = findLegacySpoolOccupancy(legacyHostSpoolMap, newSpoolId, expectedDeviceId);
    if (legacyOccupancy) {
      return createServiceResult({ ok: false, action: "replace", reason: legacyOccupancy.reason, store: currentStore });
    }
    const sourceBindingAtOpen = createSourceBindingAtOpen(request.materialSource, createdAt);
    const payload = {
      kind: "operator-replace",
      operatorActionId,
      materialSourceId: request.materialSource.materialSourceId,
      expectedOldMountId,
      newSpoolId,
      sourceBindingAtOpen,
    };
    const replaceOperationId = createPrinterCoreV3DeterministicId("material-accounting-spool-mount-operation", [
      "replace",
      operatorActionId,
      request.materialSource.materialSourceId,
      expectedOldMountId,
      newSpoolId,
    ]);
    const existingOperation = evaluateExistingOperation(buildOperationIndex(currentStore), "operator-replace", operatorActionId, payload);
    if (existingOperation.status === "idempotent") {
      return createServiceResult({ ok: true, action: "idempotent", store: currentStore, operation: existingOperation.event });
    }
    if (existingOperation.status === "conflict") {
      return createServiceResult({ ok: false, action: "replace", reason: "operator-action-payload-conflict", store: currentStore });
    }
    const repository = createSpoolMountRepository(currentStore.spoolMounts);
    const currentMount = repository.getOpenMountForSource(request.materialSource.materialSourceId);
    if (!currentMount) {
      return createServiceResult({ ok: false, action: "replace", reason: "open-mount-not-found", store: currentStore });
    }
    if (currentMount.mountId !== expectedOldMountId) {
      return createServiceResult({ ok: false, action: "replace", reason: "expected-mount-mismatch", store: currentStore, record: currentMount });
    }
    const closeResult = repository.closeMount({
      mountId: expectedOldMountId,
      closeOperationId: createPrinterCoreV3DeterministicId("material-accounting-spool-mount-operation", [
        "replace-close",
        replaceOperationId,
        expectedOldMountId,
      ]),
      closedAt: createdAt,
      closedBy: toTrimmedString(request.actor) || "operator",
      reason: "operator-replace",
    });
    if (!closeResult.ok) {
      return createServiceResult({ ok: false, action: "replace", reason: getRepositoryConflictReason(closeResult), store: currentStore, record: currentMount });
    }
    const replaceCloseOperationId = closeResult.record.closeOperationId;
    const newMountOperationId = createPrinterCoreV3DeterministicId("material-accounting-spool-mount-operation", [
      "replace-open",
      replaceOperationId,
      request.materialSource.materialSourceId,
      newSpoolId,
    ]);
    const newMount = deepFreezeJson({
      ...createSpoolMountRecord({
        mountId: createPrinterCoreV3DeterministicId("spool-mount", [
          newMountOperationId,
          request.materialSource.materialSourceId,
          newSpoolId,
          createdAt,
        ]),
        materialSourceId: request.materialSource.materialSourceId,
        spoolId: newSpoolId,
        mountOperationId: newMountOperationId,
        openedAt: createdAt,
        openedBy: toTrimmedString(request.actor) || "operator",
        verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
        sourceIdentityStrengthAtOpen: request.materialSource.identityStrength,
      }),
      mountSubjectId: createPrinterCoreV3DeterministicId("spool-mount-subject", [
        request.materialSource.deviceId,
        request.materialSource.materialSourceId,
      ]),
      sourceBindingAtOpen,
    });
    const recordResult = repository.recordMount(newMount);
    if (!recordResult.ok) {
      return createServiceResult({ ok: false, action: "replace", reason: getRepositoryConflictReason(recordResult), store: currentStore, record: currentMount });
    }
    const event = createOperationEvent({
      kind: "operator-replace",
      operatorActionId,
      operationId: replaceOperationId,
      payload,
      recordRefs: [
        expectedOldMountId,
        replaceCloseOperationId,
        newMount.mountId,
        newMount.mountOperationId,
      ],
      createdAt,
      actor: request.actor,
    });
    const nextStore = appendEventToStore(currentStore, event, repository.toJSON().mounts);
    const commit = await commitNextStore(nextStore, event);
    if (!commit.ok) {
      return createServiceResult({ ok: false, action: "replace", reason: commit.reason, store: currentStore, operation: event });
    }
    return createServiceResult({ ok: true, action: "replace", store: currentStore, record: newMount, operation: event });
  }

  return Object.freeze({
    snapshot,
    operatorMountSource,
    operatorUnmountSource,
    operatorReplaceSourceMount,
  });
}
