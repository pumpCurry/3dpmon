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
 * - IndexedDB CAS writerを注入し、UI未接続のruntime factoryとして提供
 *
 * 【公開関数一覧】
 * - {@link createMaterialAccountingSpoolMountRuntime}：runtime service wrapperを生成
 * - {@link resolveObservedMaterialSourceRecord}：観測storeからMaterialSource recordを解決
 *
 * @version 1.390.1580 (PR #440)
 * @since   1.390.1580 (PR #440)
 * @lastModified 2026-09-01 13:38:00
 * -----------------------------------------------------------
 * @todo
 * - Gate 18.9H-2でフィラメント管理UIからoperator mount/unmount/replaceへ接続する
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
 * 有限数またはnullへ正規化する。
 *
 * @private
 * @function toFiniteNumberOrNull
 * @param {*} value - 数値候補。
 * @returns {?number} 有限数、またはnull。
 */
function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
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
 * @returns {string} MaterialSource kind。
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
  return MATERIAL_SOURCE_KIND.DIRECT_FEED;
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
  const snapshot = sourceId ? deviceRecord?.latestBySourceId?.[sourceId] : null;
  if (!deviceRecord || !snapshot || typeof snapshot !== "object") {
    return null;
  }

  const sourceKind = resolveObservedSourceKind(snapshot);
  const unitKind = resolveFilamentUnitKind(sourceKind);
  const locator = createLocatorFromObservedSnapshot(snapshot, sourceKind);
  const identityStrength = toTrimmedString(
    snapshot.materialSourceIdentityStrength ||
    snapshot.identityStrength ||
    deviceRecord.identityStrength ||
    MATERIAL_IDENTITY_STRENGTH.PROVISIONAL
  );
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
    materialSourceId: sourceId,
    displayLabel: snapshot.displayLabel || snapshot.label || sourceId,
    aliases: [snapshot.sourceId, snapshot.materialSourceId, snapshot.id]
      .map((value) => toTrimmedString(value))
      .filter((value, index, list) => value && list.indexOf(value) === index),
  });
}

/**
 * monitorDataへ接続されたMaterialAccounting SpoolMount runtimeを生成する。
 *
 * 【詳細説明】
 * - service本体はpure moduleのまま保ち、runtime層だけがmonitorDataとstorage CAS writerを知る。
 * - UIからは`resolveMaterialSource()`で観測済みsource recordを取得し、そのrecordをH-1a serviceへ渡す。
 * - このfactory自体はUI未接続であり、H-2まではproduction UI操作を追加しない。
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
    managedSpools: Array.isArray(data.filamentSpools) ? data.filamentSpools : [],
    legacyHostSpoolMap: data.hostSpoolMap || {},
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
      deviceId: request.deviceId,
      materialSourceId: request.materialSourceId,
    });
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

  return Object.freeze({
    service,
    resolveMaterialSource,
    snapshot,
  });
}
