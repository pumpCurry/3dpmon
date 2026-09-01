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
 * @version 1.390.1584 (PR #440)
 * @since   1.390.1576 (PR #440)
 * @lastModified 2026-09-01 16:42:00
 * -----------------------------------------------------------
 * @todo
 * - Gate 18.9H-2でフィラメント管理UIからoperator mount/unmount/replaceへ接続する
 */

"use strict";

import {
  MATERIAL_IDENTITY_STRENGTH,
  SPOOL_MOUNT_VERIFICATION,
  createSpoolMountRecord,
  validateMaterialSource,
} from "./dashboard_material_accounting_contract.js";
import {
  createPrinterCoreV3DeterministicId,
  stableStringifyPrinterCoreV3Value,
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
 * managed spoolが削除済みか判定する。
 *
 * @private
 * @function isManagedSpoolDeleted
 * @param {Object} spool - managed spool候補。
 * @returns {boolean} 削除済みならtrue。
 */
function isManagedSpoolDeleted(spool) {
  return spool?.deleted === true || spool?.isDeleted === true;
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
    identity: cloneJsonValue(source.identity || null),
    locator: cloneJsonValue(source.locator || null),
    aliases: Array.isArray(source.aliases)
      ? source.aliases.map((alias) => toTrimmedString(alias)).filter(Boolean)
      : [],
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
      binding.identity,
      binding.locator,
    ]),
  });
}

/**
 * authority precondition用digestを生成する。
 *
 * @private
 * @function createAuthorityPreconditionDigest
 * @param {string} namespace - precondition namespace。
 * @param {*} value - digest対象値。
 * @returns {string} deterministic digest。
 */
function createAuthorityPreconditionDigest(namespace, value) {
  return `fnv1a128:${createPrinterCoreV3DeterministicId(namespace, [
    stableStringifyPrinterCoreV3Value(cloneJsonValue(value ?? null)),
  ])}`;
}

/**
 * managed spoolの送信時preconditionを生成する。
 *
 * @private
 * @function createManagedSpoolPrecondition
 * @param {Object} spool - resolverから得たmanaged spool。
 * @returns {Object} managed spool precondition。
 */
function createManagedSpoolPrecondition(spool) {
  const spoolId = toTrimmedString(spool?.id || spool?.spoolId);
  const snapshot = cloneJsonValue(spool || null);
  return deepFreezeJson({
    spoolId,
    digest: createAuthorityPreconditionDigest("material-accounting-managed-spool-precondition", snapshot),
    deleted: isManagedSpoolDeleted(spool),
  });
}

/**
 * legacy占有の送信時preconditionを生成する。
 *
 * @private
 * @function createLegacyOccupancyPrecondition
 * @param {Object|null} occupancy - resolverから得たlegacy占有。
 * @param {string} spoolId - 対象spool ID。
 * @param {string} expectedDeviceId - 期待device ID。
 * @returns {Object} legacy occupancy precondition。
 */
function createLegacyOccupancyPrecondition(occupancy, spoolId, expectedDeviceId) {
  const snapshot = cloneJsonValue(occupancy || null);
  return deepFreezeJson({
    spoolId: toTrimmedString(spoolId),
    expectedDeviceId: toTrimmedString(expectedDeviceId),
    occupied: Boolean(occupancy),
    digest: createAuthorityPreconditionDigest("material-accounting-legacy-occupancy-precondition", snapshot),
  });
}

/**
 * durable CASへ渡すauthority precondition群を生成する。
 *
 * @private
 * @function createCommitPreconditions
 * @param {Object} input - precondition入力。
 * @param {Object} input.materialSource - MaterialSource record。
 * @param {Object} input.sourceBindingAtOpen - source binding evidence。
 * @param {Object} input.spool - managed spool。
 * @param {Object|null} input.legacyOccupancy - legacy occupancy。
 * @param {string} input.expectedDeviceId - 期待device ID。
 * @returns {Object} precondition群。
 */
function createCommitPreconditions(input = {}) {
  return deepFreezeJson({
    materialSource: {
      deviceId: toTrimmedString(input.materialSource?.deviceId),
      materialSourceId: toTrimmedString(input.materialSource?.materialSourceId),
      sourceIdentityDigest: toTrimmedString(input.sourceBindingAtOpen?.sourceIdentityDigest),
    },
    managedSpool: createManagedSpoolPrecondition(input.spool),
    legacyOccupancy: createLegacyOccupancyPrecondition(
      input.legacyOccupancy,
      input.spool?.id || input.spool?.spoolId,
      input.expectedDeviceId,
    ),
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
 * mount operationのsemantic payloadを生成する。
 *
 * @private
 * @function createMountOperationPayload
 * @param {Object} input - payload入力。
 * @param {string} input.operatorActionId - operator action ID。
 * @param {string} input.operationId - operation ID。
 * @param {string} input.expectedDeviceId - 期待device ID。
 * @param {string} input.materialSourceId - MaterialSource ID。
 * @param {string} input.spoolId - managed spool ID。
 * @returns {Object} semantic payload。
 */
function createMountOperationPayload(input = {}) {
  return {
    kind: "operator-mount",
    operatorActionId: toTrimmedString(input.operatorActionId),
    operationId: toTrimmedString(input.operationId),
    expectedDeviceId: toTrimmedString(input.expectedDeviceId),
    materialSourceId: toTrimmedString(input.materialSourceId),
    spoolId: toTrimmedString(input.spoolId),
  };
}

/**
 * replace operationのsemantic payloadを生成する。
 *
 * @private
 * @function createReplaceOperationPayload
 * @param {Object} input - payload入力。
 * @param {string} input.operatorActionId - operator action ID。
 * @param {string} input.operationId - operation ID。
 * @param {string} input.expectedDeviceId - 期待device ID。
 * @param {string} input.materialSourceId - MaterialSource ID。
 * @param {string} input.expectedOldMountId - 旧mount ID。
 * @param {string} input.newSpoolId - 新managed spool ID。
 * @returns {Object} semantic payload。
 */
function createReplaceOperationPayload(input = {}) {
  return {
    kind: "operator-replace",
    operatorActionId: toTrimmedString(input.operatorActionId),
    operationId: toTrimmedString(input.operationId),
    expectedDeviceId: toTrimmedString(input.expectedDeviceId),
    materialSourceId: toTrimmedString(input.materialSourceId),
    expectedOldMountId: toTrimmedString(input.expectedOldMountId),
    newSpoolId: toTrimmedString(input.newSpoolId),
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
 * @param {Object|null=} preconditions - durable CAS直前に再検査するauthority precondition群。
 * @returns {Promise<{ok:boolean, reason:string, durable:Object|null}>} durable結果。
 */
async function persistNextStore(persist, baseStore, nextStore, operation, preconditions = null) {
  if (typeof persist !== "function") {
    return { ok: false, reason: "durable-writer-required", durable: null };
  }
  let durable = null;
  try {
    durable = await persist({
      baseStoreDigest: createMaterialAccountingSpoolMountStoreDigest(baseStore),
      nextStore,
      operation,
      preconditions: preconditions ? cloneJsonValue(preconditions) : null,
    });
  } catch (error) {
    return {
      ok: false,
      reason: "durable-writer-threw",
      durable: {
        ok: false,
        casApplied: false,
        reason: "durable-writer-threw",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
  if (!durable || durable.ok !== true || durable.casApplied !== true) {
    return { ok: false, reason: "durable-cas-not-applied", durable: durable || null };
  }
  return { ok: true, reason: "", durable };
}

/**
 * resolver呼び出しを安全に実行する。
 *
 * @private
 * @function callResolver
 * @param {Function} resolver - resolver callback。
 * @param {Object} request - resolver入力。
 * @returns {Promise<*>} resolver結果。
 */
async function callResolver(resolver, request) {
  return resolver(cloneJsonValue(request));
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
 * UI入力source IDが保存済みmountのsource bindingと一致するか判定する。
 *
 * 【詳細説明】
 * - UIは現在観測行の一時sourceIdを持つが、SpoolMount storeはdevice-scopedなdurable
 *   MaterialSource IDを保持する。解除操作ではexpectedMountIdを主キーにし、入力sourceIdが
 *   durable IDまたはopen時binding aliasに一致する場合だけ同じsourceとして扱う。
 *
 * @private
 * @function doesMountMatchSourceInput
 * @param {Object} mount - 検査対象のSpoolMount record。
 * @param {string} materialSourceId - UI入力またはdurable MaterialSource ID。
 * @returns {boolean} 同一sourceとみなせる場合はtrue。
 */
function doesMountMatchSourceInput(mount, materialSourceId) {
  const sourceId = toTrimmedString(materialSourceId);
  if (!mount || !sourceId) {
    return false;
  }
  const bindingAliases = [
    mount.materialSourceId,
    mount.sourceBindingAtOpen?.materialSourceId,
    mount.sourceBindingAtOpen?.sourceId,
    mount.sourceBindingAtOpen?.id,
    ...(Array.isArray(mount.sourceBindingAtOpen?.aliases) ? mount.sourceBindingAtOpen.aliases : []),
  ]
    .map((value) => toTrimmedString(value))
    .filter(Boolean);
  return bindingAliases.includes(sourceId);
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
 * @param {Function=} input.resolveMaterialSource - 現在観測MaterialSource resolver。
 * @param {Function=} input.resolveManagedSpool - 現在managed spool resolver。
 * @param {Function=} input.resolveLegacyOccupancy - 現在legacy占有resolver。
 * @param {Function=} input.persist - durable writer callback。
 * @param {Function=} input.now - 現在時刻関数。
 * @returns {Object} service API。
 * @example
 * const service = createMaterialAccountingSpoolMountService({ store, managedSpools, persist });
 */
export function createMaterialAccountingSpoolMountService(input = {}) {
  let currentStore = normalizeStoredMaterialAccountingSpoolMountStore(input.store);
  const resolveMaterialSource = typeof input.resolveMaterialSource === "function" ? input.resolveMaterialSource : null;
  const resolveManagedSpool = typeof input.resolveManagedSpool === "function" ? input.resolveManagedSpool : null;
  const resolveLegacyOccupancy = typeof input.resolveLegacyOccupancy === "function" ? input.resolveLegacyOccupancy : null;
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
   * @param {Object|null=} preconditions - durable CAS直前に再検査するauthority precondition群。
   * @returns {Promise<{ok:boolean, reason:string}>} commit結果。
   */
  async function commitNextStore(nextStore, operation, preconditions = null) {
    const durable = await persistNextStore(persist, currentStore, nextStore, operation, preconditions);
    if (!durable.ok) {
      return durable;
    }
    currentStore = normalizeStoredMaterialAccountingSpoolMountStore(nextStore);
    return durable;
  }

  /**
   * trusted resolverからMaterialSourceを解決し検証する。
   *
   * @private
   * @function resolveOperatorMaterialSource
   * @param {Object} request - operator request。
   * @param {string} action - 操作種別。
   * @returns {Promise<{ok:boolean, reason:string, source:Object|null, errors:Array<string>}>} 解決結果。
   */
  async function resolveOperatorMaterialSource(request, action) {
    if (typeof resolveMaterialSource !== "function") {
      return { ok: false, reason: "trusted-material-source-resolver-required", source: null, errors: [] };
    }
    const materialSourceId = toTrimmedString(request.materialSourceId || request.materialSource?.materialSourceId);
    if (!materialSourceId) {
      return { ok: false, reason: "material-source-id-required", source: null, errors: [] };
    }
    const expectedDeviceId = toTrimmedString(request.expectedDeviceId);
    const source = await callResolver(resolveMaterialSource, {
      action,
      materialSourceId,
      expectedDeviceId,
      operatorActionId: request.operatorActionId,
    });
    if (!source) {
      return { ok: false, reason: "material-source-not-found", source: null, errors: [] };
    }
    const sourceValidation = validateOperatorMaterialSource(source, expectedDeviceId);
    if (!sourceValidation.ok) {
      return { ok: false, reason: sourceValidation.reason, source: null, errors: sourceValidation.errors };
    }
    return { ok: true, reason: "", source, errors: [] };
  }

  /**
   * trusted resolverからmanaged spoolを解決し検証する。
   *
   * @private
   * @function resolveOperatorManagedSpool
   * @param {Object} request - operator request。
   * @param {string} spoolId - managed spool ID。
   * @param {string} action - 操作種別。
   * @returns {Promise<{ok:boolean, reason:string, spool:Object|null}>} 解決結果。
   */
  async function resolveOperatorManagedSpool(request, spoolId, action) {
    if (typeof resolveManagedSpool !== "function") {
      return { ok: false, reason: "trusted-managed-spool-resolver-required", spool: null };
    }
    const spool = await callResolver(resolveManagedSpool, {
      action,
      spoolId,
      expectedDeviceId: request.expectedDeviceId,
      materialSourceId: request.materialSourceId || request.materialSource?.materialSourceId,
      operatorActionId: request.operatorActionId,
    });
    if (!spool) {
      return { ok: false, reason: "managed-spool-not-found", spool: null };
    }
    if (isManagedSpoolDeleted(spool)) {
      return { ok: false, reason: "managed-spool-deleted", spool: null };
    }
    return { ok: true, reason: "", spool };
  }

  /**
   * trusted resolverからlegacy占有を解決する。
   *
   * @private
   * @function resolveOperatorLegacyOccupancy
   * @param {Object} request - operator request。
   * @param {string} spoolId - managed spool ID。
   * @param {string} expectedDeviceId - 期待device ID。
   * @param {string} action - 操作種別。
   * @returns {Promise<{ok:boolean, reason:string, occupancy:Object|null}>} 解決結果。
   */
  async function resolveOperatorLegacyOccupancy(request, spoolId, expectedDeviceId, action) {
    if (typeof resolveLegacyOccupancy !== "function") {
      return { ok: false, reason: "trusted-legacy-occupancy-resolver-required", occupancy: null };
    }
    const occupancy = await callResolver(resolveLegacyOccupancy, {
      action,
      spoolId,
      expectedDeviceId,
      materialSourceId: request.materialSourceId || request.materialSource?.materialSourceId,
      operatorActionId: request.operatorActionId,
    });
    return occupancy
      ? { ok: false, reason: occupancy.reason || "legacy-spool-already-mounted", occupancy }
      : { ok: true, reason: "", occupancy: null };
  }

  /**
   * MaterialSourceへmanaged spoolをmountする。
   *
   * @function operatorMountSource
   * @param {Object} request - mount request。
   * @param {string} request.operatorActionId - operator action ID。
   * @param {string} request.expectedDeviceId - 期待device ID。
   * @param {string} request.materialSourceId - trusted resolverで解決するMaterialSource ID。
   * @param {string} request.spoolId - managed spool ID。
   * @param {string=} request.actor - actor。
   * @returns {Promise<Object>} service result。
   */
  async function operatorMountSource(request = {}) {
    const operatorActionId = toTrimmedString(request.operatorActionId);
    const expectedDeviceId = toTrimmedString(request.expectedDeviceId);
    const materialSourceId = toTrimmedString(request.materialSourceId || request.materialSource?.materialSourceId);
    const spoolId = toTrimmedString(request.spoolId);
    const createdAt = now();
    if (!operatorActionId) {
      return createServiceResult({ ok: false, action: "mount", reason: "operator-action-id-required", store: currentStore });
    }
    const operationId = createPrinterCoreV3DeterministicId("material-accounting-spool-mount-operation", [
      "mount",
      operatorActionId,
      materialSourceId,
      spoolId,
    ]);
    const payload = createMountOperationPayload({
      operatorActionId,
      operationId,
      expectedDeviceId,
      materialSourceId,
      spoolId,
    });
    const existingOperation = evaluateExistingOperation(buildOperationIndex(currentStore), "operator-mount", operatorActionId, payload);
    if (existingOperation.status === "idempotent") {
      return createServiceResult({ ok: true, action: "idempotent", store: currentStore, operation: existingOperation.event });
    }
    if (existingOperation.status === "conflict") {
      return createServiceResult({ ok: false, action: "mount", reason: "operator-action-payload-conflict", store: currentStore });
    }
    const sourceResult = await resolveOperatorMaterialSource({
      ...request,
      materialSourceId,
      expectedDeviceId,
    }, "mount");
    if (!sourceResult.ok) {
      return createServiceResult({
        ok: false,
        action: "mount",
        reason: sourceResult.reason,
        store: currentStore,
        errors: sourceResult.errors,
      });
    }
    const source = sourceResult.source;
    const spoolResult = await resolveOperatorManagedSpool({
      ...request,
      materialSourceId,
      expectedDeviceId,
    }, spoolId, "mount");
    if (!spoolResult.ok) {
      return createServiceResult({ ok: false, action: "mount", reason: spoolResult.reason, store: currentStore });
    }
    const legacyResult = await resolveOperatorLegacyOccupancy({
      ...request,
      materialSourceId,
      expectedDeviceId,
    }, spoolId, expectedDeviceId, "mount");
    if (!legacyResult.ok) {
      return createServiceResult({ ok: false, action: "mount", reason: legacyResult.reason, store: currentStore });
    }

    const sourceBindingAtOpen = createSourceBindingAtOpen(source, createdAt);

    const mount = deepFreezeJson({
      ...createSpoolMountRecord({
        mountId: createPrinterCoreV3DeterministicId("spool-mount", [
          operationId,
          source.materialSourceId,
          spoolId,
          createdAt,
        ]),
        materialSourceId: source.materialSourceId,
        spoolId,
        mountOperationId: operationId,
        openedAt: createdAt,
        openedBy: toTrimmedString(request.actor) || "operator",
        verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
        sourceIdentityStrengthAtOpen: source.identityStrength,
      }),
      mountSubjectId: createPrinterCoreV3DeterministicId("spool-mount-subject", [
        source.deviceId,
        source.materialSourceId,
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
    const commit = await commitNextStore(nextStore, event, createCommitPreconditions({
      materialSource: source,
      sourceBindingAtOpen,
      spool: spoolResult.spool,
      legacyOccupancy: legacyResult.occupancy,
      expectedDeviceId,
    }));
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
    if (!operatorActionId) {
      return createServiceResult({ ok: false, action: "unmount", reason: "operator-action-id-required", store: currentStore });
    }
    const operationId = createPrinterCoreV3DeterministicId("material-accounting-spool-mount-operation", [
      "unmount",
      operatorActionId,
      expectedMountId,
    ]);
    const payload = {
      kind: "operator-unmount",
      operatorActionId,
      operationId,
      materialSourceId,
      expectedMountId,
      reason: toTrimmedString(request.reason) || "operator-unmount",
    };
    const existingOperation = evaluateExistingOperation(buildOperationIndex(currentStore), "operator-unmount", operatorActionId, payload);
    if (existingOperation.status === "idempotent") {
      return createServiceResult({ ok: true, action: "idempotent", store: currentStore, operation: existingOperation.event });
    }
    if (existingOperation.status === "conflict") {
      return createServiceResult({ ok: false, action: "unmount", reason: "operator-action-payload-conflict", store: currentStore });
    }
    const repository = createSpoolMountRepository(currentStore.spoolMounts);
    const currentMount = repository.getMount(expectedMountId);
    if (!currentMount) {
      const sourceMount = repository.getOpenMountForSource(materialSourceId);
      if (sourceMount) {
        return createServiceResult({ ok: false, action: "unmount", reason: "expected-mount-mismatch", store: currentStore, record: sourceMount });
      }
      return createServiceResult({ ok: false, action: "unmount", reason: "open-mount-not-found", store: currentStore });
    }
    if (currentMount.status !== "open") {
      return createServiceResult({ ok: false, action: "unmount", reason: "open-mount-not-found", store: currentStore, record: currentMount });
    }
    if (!doesMountMatchSourceInput(currentMount, materialSourceId)) {
      return createServiceResult({ ok: false, action: "unmount", reason: "material-source-mismatch", store: currentStore, record: currentMount });
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
   * @param {string} request.expectedDeviceId - 期待device ID。
   * @param {string} request.materialSourceId - trusted resolverで解決するMaterialSource ID。
   * @param {string} request.expectedOldMountId - UIが束縛した旧mount ID。
   * @param {string} request.newSpoolId - 新managed spool ID。
   * @param {string=} request.actor - actor。
   * @returns {Promise<Object>} service result。
   */
  async function operatorReplaceSourceMount(request = {}) {
    const operatorActionId = toTrimmedString(request.operatorActionId);
    const expectedOldMountId = toTrimmedString(request.expectedOldMountId);
    const newSpoolId = toTrimmedString(request.newSpoolId);
    const expectedDeviceId = toTrimmedString(request.expectedDeviceId);
    const materialSourceId = toTrimmedString(request.materialSourceId || request.materialSource?.materialSourceId);
    const createdAt = now();
    if (!operatorActionId) {
      return createServiceResult({ ok: false, action: "replace", reason: "operator-action-id-required", store: currentStore });
    }
    const replaceOperationId = createPrinterCoreV3DeterministicId("material-accounting-spool-mount-operation", [
      "replace",
      operatorActionId,
      materialSourceId,
      expectedOldMountId,
      newSpoolId,
    ]);
    const payload = createReplaceOperationPayload({
      operatorActionId,
      operationId: replaceOperationId,
      expectedDeviceId,
      materialSourceId,
      expectedOldMountId,
      newSpoolId,
    });
    const existingOperation = evaluateExistingOperation(buildOperationIndex(currentStore), "operator-replace", operatorActionId, payload);
    if (existingOperation.status === "idempotent") {
      return createServiceResult({ ok: true, action: "idempotent", store: currentStore, operation: existingOperation.event });
    }
    if (existingOperation.status === "conflict") {
      return createServiceResult({ ok: false, action: "replace", reason: "operator-action-payload-conflict", store: currentStore });
    }
    const sourceResult = await resolveOperatorMaterialSource({
      ...request,
      materialSourceId,
      expectedDeviceId,
    }, "replace");
    if (!sourceResult.ok) {
      return createServiceResult({
        ok: false,
        action: "replace",
        reason: sourceResult.reason,
        store: currentStore,
        errors: sourceResult.errors,
      });
    }
    const source = sourceResult.source;
    const spoolResult = await resolveOperatorManagedSpool({
      ...request,
      materialSourceId,
      expectedDeviceId,
    }, newSpoolId, "replace");
    if (!spoolResult.ok) {
      return createServiceResult({ ok: false, action: "replace", reason: spoolResult.reason, store: currentStore });
    }
    const legacyResult = await resolveOperatorLegacyOccupancy({
      ...request,
      materialSourceId,
      expectedDeviceId,
    }, newSpoolId, expectedDeviceId, "replace");
    if (!legacyResult.ok) {
      return createServiceResult({ ok: false, action: "replace", reason: legacyResult.reason, store: currentStore });
    }
    const sourceBindingAtOpen = createSourceBindingAtOpen(source, createdAt);
    const repository = createSpoolMountRepository(currentStore.spoolMounts);
    const currentMount = repository.getOpenMountForSource(source.materialSourceId);
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
      source.materialSourceId,
      newSpoolId,
    ]);
    const newMount = deepFreezeJson({
      ...createSpoolMountRecord({
        mountId: createPrinterCoreV3DeterministicId("spool-mount", [
          newMountOperationId,
          source.materialSourceId,
          newSpoolId,
          createdAt,
        ]),
        materialSourceId: source.materialSourceId,
        spoolId: newSpoolId,
        mountOperationId: newMountOperationId,
        openedAt: createdAt,
        openedBy: toTrimmedString(request.actor) || "operator",
        verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
        sourceIdentityStrengthAtOpen: source.identityStrength,
      }),
      mountSubjectId: createPrinterCoreV3DeterministicId("spool-mount-subject", [
        source.deviceId,
        source.materialSourceId,
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
    const commit = await commitNextStore(nextStore, event, createCommitPreconditions({
      materialSource: source,
      sourceBindingAtOpen,
      spool: spoolResult.spool,
      legacyOccupancy: legacyResult.occupancy,
      expectedDeviceId,
    }));
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
