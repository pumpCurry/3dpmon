/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 MaterialAccounting SpoolMount runtime モジュール
 * @file dashboard_material_accounting_mount_runtime.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_accounting_mount_runtime
 *
 * 【機能内容サマリ】
 * - Gate 18.9H-1b のoperator-managed SpoolMount serviceをmonitorDataへ接続
 * - read-only MaterialSource観測からtrusted MaterialSource recordを再構成
 * - IndexedDB CAS writerを注入し、UIから呼べる管理台帳runtime factoryとして提供
 *
 * 【公開関数一覧】
 * - {@link createMaterialAccountingSpoolMountRuntime}：runtime service wrapperを生成
 * - {@link resolveObservedMaterialSourceRecord}：観測storeからMaterialSource recordを解決
 *
 * @version 1.390.1584 (PR #440)
 * @since   1.390.1580 (PR #440)
 * @lastModified 2026-09-01 16:42:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

import { monitorData } from "../dashboard_data.js";
import { commitMaterialAccountingSpoolMountStoreDurably } from "../dashboard_storage.js";
import {
  FILAMENT_UNIT_KIND,
  MATERIAL_IDENTITY_STRENGTH,
  MATERIAL_SOURCE_KIND,
  createFilamentUnitRecord,
  createMaterialSourceIdentity,
  createMaterialSourceLocator,
  createMaterialSourceRecord,
} from "./dashboard_material_accounting_contract.js";
import { createMaterialAccountingSpoolMountService } from "./dashboard_material_accounting_mount_service.js";
import {
  reserveUniversalSpoolAssignment,
} from "./dashboard_material_accounting_spool_assignment_guard.js";

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
 * MaterialSource kindからFilamentUnit kindを推定する。
 *
 * @private
 * @function resolveFilamentUnitKind
 * @param {string} sourceKind - MaterialSource kind。
 * @returns {string} FilamentUnit kind。
 */
function resolveFilamentUnitKind(sourceKind) {
  if (sourceKind === MATERIAL_SOURCE_KIND.CFS_C_SLOT) {
    return FILAMENT_UNIT_KIND.CFS_C;
  }
  if (sourceKind === MATERIAL_SOURCE_KIND.CFS_SLOT) {
    return FILAMENT_UNIT_KIND.CFS;
  }
  return FILAMENT_UNIT_KIND.PRINTER_DIRECT;
}

/**
 * 観測snapshotからMaterialSource kindを正規化する。
 *
 * @private
 * @function resolveObservedSourceKind
 * @param {Object} snapshot - read-only source snapshot。
 * @returns {?string} MaterialSource kind。証明できない場合はnull。
 */
function resolveObservedSourceKind(snapshot) {
  const kind = toTrimmedString(snapshot?.kind);
  if (kind === MATERIAL_SOURCE_KIND.CFS_SLOT ||
      kind === MATERIAL_SOURCE_KIND.CFS_C_SLOT ||
      kind === MATERIAL_SOURCE_KIND.EXTERNAL_SPOOL ||
      kind === MATERIAL_SOURCE_KIND.DIRECT_FEED) {
    return kind;
  }
  if (toTrimmedString(snapshot?.providerKind) === "cfs-c") {
    return MATERIAL_SOURCE_KIND.CFS_C_SLOT;
  }
  if (toTrimmedString(snapshot?.type) === "external") {
    return MATERIAL_SOURCE_KIND.EXTERNAL_SPOOL;
  }
  return null;
}

/**
 * 観測snapshotからMaterialSource identity strengthを正規化する。
 *
 * @private
 * @function resolveObservedIdentityStrength
 * @param {Object} snapshot - read-only source snapshot。
 * @param {Object} deviceRecord - device observation record。
 * @returns {?string} identity strength。不正値ならnull。
 */
function resolveObservedIdentityStrength(snapshot, deviceRecord) {
  const candidates = [
    snapshot?.materialSourceIdentityStrength,
    snapshot?.identityStrength,
    deviceRecord?.identityStrength,
  ];
  const allowed = new Set(Object.values(MATERIAL_IDENTITY_STRENGTH));
  for (const candidate of candidates) {
    const value = toTrimmedString(candidate);
    if (!value) {
      continue;
    }
    return allowed.has(value) ? value : null;
  }
  return MATERIAL_IDENTITY_STRENGTH.UNKNOWN;
}

/**
 * 観測snapshotからMaterialSource locatorを生成する。
 *
 * @private
 * @function createLocatorFromObservedSnapshot
 * @param {Object} snapshot - read-only source snapshot。
 * @param {string} kind - MaterialSource kind。
 * @returns {Object} MaterialSource locator。
 */
function createLocatorFromObservedSnapshot(snapshot, kind) {
  const rawLocator = snapshot?.locator && typeof snapshot.locator === "object" ? snapshot.locator : {};
  return createMaterialSourceLocator({
    kind,
    index: rawLocator.index ?? snapshot?.index ?? (kind === MATERIAL_SOURCE_KIND.EXTERNAL_SPOOL ? 0 : null),
    unitIndex: rawLocator.unitIndex ?? snapshot?.unitIndex ?? snapshot?.boxIndex ?? snapshot?.boxId ?? null,
    boxId: rawLocator.boxId ?? snapshot?.boxId ?? null,
    slotIndex: rawLocator.slotIndex ?? snapshot?.slotIndex ?? snapshot?.slotId ?? snapshot?.protocolSlotId ?? null,
    protocolSlotId: rawLocator.protocolSlotId ?? snapshot?.protocolSlotId ?? snapshot?.slotId ?? null,
  });
}

/**
 * 観測store内のdevice recordを取得する。
 *
 * @private
 * @function findObservationDeviceRecord
 * @param {Object} store - materialSourceObservations store。
 * @param {string} deviceId - Device ID。
 * @returns {?Object} device observation record。
 */
function findObservationDeviceRecord(store, deviceId) {
  const key = toTrimmedString(deviceId);
  if (!key || !store || typeof store !== "object") {
    return null;
  }
  const byDeviceId = store.byDeviceId && typeof store.byDeviceId === "object" ? store.byDeviceId : {};
  return byDeviceId[key] || null;
}

/**
 * 観測snapshotをoperator mount用MaterialSource recordへ変換する。
 *
 * 【詳細説明】
 * - 観測storeのキーや`sourceId`はtransport/localな検索キーとして扱い、durable
 *   `materialSourceId`はMaterialSource identityから生成する。
 * - raw sourceIdはaliasesへ保持し、UIやimport済み履歴との照合に利用できるようにする。
 *
 * @private
 * @function createObservedMaterialSourceRecord
 * @param {Object} snapshot - read-only source snapshot。
 * @param {Object} deviceRecord - device observation record。
 * @param {string} deviceId - Device ID。
 * @param {string} sourceLookupId - 観測storeで使った検索キー。
 * @returns {?Object} MaterialSource record。検証できない場合はnull。
 */
function createObservedMaterialSourceRecord(snapshot, deviceRecord, deviceId, sourceLookupId) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  const sourceKind = resolveObservedSourceKind(snapshot);
  if (!sourceKind) {
    return null;
  }
  const unitKind = resolveFilamentUnitKind(sourceKind);
  const locator = createLocatorFromObservedSnapshot(snapshot, sourceKind);
  const identityStrength = resolveObservedIdentityStrength(snapshot, deviceRecord);
  if (!identityStrength) {
    return null;
  }
  const unitId = toTrimmedString(snapshot.unitId) || toTrimmedString(snapshot.providerId) ||
    `material-unit:${deviceId}:${unitKind}:${locator.unitIndex ?? locator.index ?? 0}`;
  const unit = createFilamentUnitRecord({
    deviceId,
    kind: unitKind,
    unitId,
    unitIndex: locator.unitIndex,
    providerId: snapshot.providerId || deviceRecord.providerId || null,
    identityStrength,
  });

  return createMaterialSourceRecord({
    deviceId,
    unitId: unit.unitId,
    kind: sourceKind,
    locator,
    identity: createMaterialSourceIdentity({
      deviceId,
      unitId: unit.unitId,
      kind: sourceKind,
      slotIndex: locator.slotIndex,
      index: locator.index,
    }),
    identityStrength,
    displayLabel: snapshot.displayLabel || snapshot.label || sourceLookupId,
    aliases: [sourceLookupId, snapshot.sourceId, snapshot.materialSourceId, snapshot.id]
      .map((value) => toTrimmedString(value))
      .filter((value, index, list) => value && list.indexOf(value) === index),
  });
}

/**
 * read-only observation snapshotからMaterialSource recordを解決する。
 *
 * 【詳細説明】
 * - callerが渡した任意の文字列をそのままtrusted sourceとして扱わず、保存済み観測store内の
 *   `deviceId + materialSourceId` に一致するsnapshotからのみMaterialSource recordを再構成する。
 * - 観測snapshotのidentityStrengthがunknownの場合は、そのままunknownとして返し、service層で
 *   operator mount拒否へ進ませる。
 *
 * @function resolveObservedMaterialSourceRecord
 * @param {Object} input - 解決入力。
 * @param {Object=} input.materialSourceObservations - 観測store。未指定ならmonitorDataを参照する。
 * @param {string} input.deviceId - Device ID。
 * @param {string} input.materialSourceId - MaterialSource ID。
 * @returns {?Object} MaterialSource record。見つからない場合はnull。
 * @example
 * const source = resolveObservedMaterialSourceRecord({ deviceId, materialSourceId });
 */
export function resolveObservedMaterialSourceRecord(input = {}) {
  const store = input.materialSourceObservations || monitorData.materialSourceObservations;
  const deviceId = toTrimmedString(input.deviceId);
  const sourceId = toTrimmedString(input.materialSourceId || input.sourceId);
  const deviceRecord = findObservationDeviceRecord(store, deviceId);
  const latestBySourceId = deviceRecord?.latestBySourceId && typeof deviceRecord.latestBySourceId === "object"
    ? deviceRecord.latestBySourceId
    : {};
  const snapshot = sourceId ? latestBySourceId[sourceId] : null;
  if (!deviceRecord || !sourceId) {
    return null;
  }
  const directRecord = createObservedMaterialSourceRecord(snapshot, deviceRecord, deviceId, sourceId);
  if (directRecord) {
    return directRecord;
  }
  for (const [lookupId, candidateSnapshot] of Object.entries(latestBySourceId)) {
    const candidateRecord = createObservedMaterialSourceRecord(candidateSnapshot, deviceRecord, deviceId, lookupId);
    if (!candidateRecord) {
      continue;
    }
    if (candidateRecord.materialSourceId === sourceId || candidateRecord.aliases.includes(sourceId)) {
      return candidateRecord;
    }
  }
  return null;
}

/**
 * monitorDataへ接続されたMaterialAccounting SpoolMount runtimeを生成する。
 *
 * 【詳細説明】
 * - service本体はpure moduleのまま保ち、runtime層だけがmonitorDataとstorage CAS writerを知る。
 * - UIから渡される`materialSourceId`は利便性の入力に留め、runtime内の`resolveMaterialSource()`で
 *   観測済みsource recordを送信時に再解決してからH-1a serviceへ渡す。
 * - このfactoryが許可するのは3DPmon管理台帳のmount/unmount/replaceだけであり、
 *   CFS physical commandやspool残量debitは別Gateまで実行しない。
 *
 * @function createMaterialAccountingSpoolMountRuntime
 * @param {Object=} input - runtime入力。
 * @param {Object=} input.data - monitorData互換データ。未指定なら実monitorData。
 * @param {Function=} input.persist - durable CAS writer。未指定ならstorage実装。
 * @param {Function=} input.now - 現在時刻関数。
 * @returns {{service:Object, resolveMaterialSource:Function, snapshot:Function}} runtime API。
 * @example
 * const runtime = createMaterialAccountingSpoolMountRuntime();
 */
export function createMaterialAccountingSpoolMountRuntime(input = {}) {
  const data = input.data || monitorData;
  const service = createMaterialAccountingSpoolMountService({
    store: data.materialAccountingSpoolMountStore,
    resolveMaterialSource,
    resolveManagedSpool,
    resolveLegacyOccupancy,
    persist: typeof input.persist === "function"
      ? input.persist
      : commitMaterialAccountingSpoolMountStoreDurably,
    now: input.now,
  });

  /**
 * runtime dataからMaterialSourceを解決する。
   *
   * @function resolveMaterialSource
   * @param {Object} request - 解決入力。
   * @param {string} request.deviceId - Device ID。
   * @param {string} request.materialSourceId - MaterialSource ID。
   * @returns {?Object} MaterialSource record。
   */
  function resolveMaterialSource(request = {}) {
    return resolveObservedMaterialSourceRecord({
      materialSourceObservations: data.materialSourceObservations,
      deviceId: request.deviceId || request.expectedDeviceId,
      materialSourceId: request.materialSourceId,
    });
  }

  /**
   * runtime dataから3DPmon管理spoolを解決する。
   *
   * @function resolveManagedSpool
   * @param {Object} request - 解決入力。
   * @param {string} request.spoolId - managed spool ID。
   * @returns {?Object} managed spool。見つからない場合はnull。
   */
  function resolveManagedSpool(request = {}) {
    const spoolId = toTrimmedString(request.spoolId);
    const spools = Array.isArray(data.filamentSpools) ? data.filamentSpools : [];
    return spools.find((spool) => toTrimmedString(spool?.id || spool?.spoolId) === spoolId) || null;
  }

  /**
   * runtime dataからlegacy hostSpoolMap占有を解決する。
   *
   * @function resolveLegacyOccupancy
   * @param {Object} request - 解決入力。
   * @param {string} request.spoolId - managed spool ID。
   * @param {string} request.expectedDeviceId - 期待device ID。
   * @returns {?Object} legacy占有。未占有ならnull。
   */
  function resolveLegacyOccupancy(request = {}) {
    const spoolId = toTrimmedString(request.spoolId);
    const expectedDeviceId = toTrimmedString(request.expectedDeviceId);
    const hostSpoolMap = data.hostSpoolMap && typeof data.hostSpoolMap === "object" ? data.hostSpoolMap : {};
    for (const [host, mountedSpoolId] of Object.entries(hostSpoolMap)) {
      if (toTrimmedString(mountedSpoolId) !== spoolId) {
        continue;
      }
      return {
        host,
        spoolId,
        reason: toTrimmedString(host) === expectedDeviceId
          ? "legacy-spool-occupancy-requires-migration"
          : "legacy-spool-already-mounted",
      };
    }
    return null;
  }

  /**
   * runtime serviceの現在snapshotを返す。
   *
   * @function snapshot
   * @returns {Object} SpoolMount store snapshot。
   */
  function snapshot() {
    return service.snapshot();
  }

  /**
   * Universal mount/replace中にmanaged spoolを予約してlegacy装着を遮断する。
   *
   * @function withUniversalSpoolReservation
   * @param {Object} request - operator request。
   * @param {string} action - 操作種別。
   * @param {string} spoolId - 予約対象managed spool ID。
   * @param {Function} operation - 実行するservice operation。
   * @returns {Promise<Object>} service result。
   */
  async function withUniversalSpoolReservation(request, action, spoolId, operation) {
    const ownerId = toTrimmedString(request.operatorActionId) || `${action}:${toTrimmedString(request.materialSourceId)}`;
    const reservation = reserveUniversalSpoolAssignment({
      spoolId,
      ownerId,
      materialSourceId: request.materialSourceId || request.materialSource?.materialSourceId,
    });
    if (!reservation.ok) {
      return {
        ok: false,
        action,
        reason: reservation.reason,
        conflict: reservation.conflict,
        store: service.snapshot(),
      };
    }
    try {
      return await operation();
    } finally {
      reservation.release();
    }
  }

  /**
   * production runtime向けに予約境界を追加したservice facadeを生成する。
   *
   * @function createReservedRuntimeService
   * @returns {Object} runtime service facade。
   */
  function createReservedRuntimeService() {
    return Object.freeze({
      snapshot,
      operatorMountSource: (request = {}) => withUniversalSpoolReservation(
        request,
        "mount",
        request.spoolId,
        () => service.operatorMountSource(request)
      ),
      operatorUnmountSource: (request = {}) => service.operatorUnmountSource(request),
      operatorReplaceSourceMount: (request = {}) => withUniversalSpoolReservation(
        request,
        "replace",
        request.newSpoolId,
        () => service.operatorReplaceSourceMount(request)
      ),
    });
  }

  return Object.freeze({
    service: createReservedRuntimeService(),
    resolveMaterialSource,
    resolveManagedSpool,
    resolveLegacyOccupancy,
    snapshot,
  });
}
