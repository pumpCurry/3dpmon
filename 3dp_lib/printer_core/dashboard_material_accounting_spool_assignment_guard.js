/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 MaterialAccounting スプール割当排他ガード モジュール
 * @file dashboard_material_accounting_spool_assignment_guard.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_accounting_spool_assignment_guard
 *
 * 【機能内容サマリ】
 * - legacy hostSpoolMap と Universal SpoolMount の同一スプール二重装着を検査
 * - Universal SpoolMount 操作中の in-flight reservation を同期的に保持
 * - restore/import 時に現在OPENなUniversal mountだけをlegacy/current backendと照合
 *
 * 【公開関数一覧】
 * - {@link findUniversalSpoolAssignmentConflict}：Universal側の現在占有または予約を検出
 * - {@link reserveUniversalSpoolAssignment}：Universal操作中のスプール予約を取得
 * - {@link reconcileCurrentOpenUniversalSpoolMountsAgainstBackends}：現在OPEN mountだけをbackend照合して隔離
 *
 * @version 1.390.1583 (PR #440)
 * @since   1.390.1583 (PR #440)
 * @lastModified 2026-09-01 16:12:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

import {
  SPOOL_MOUNT_STATUS,
} from "./dashboard_material_accounting_contract.js";
import {
  normalizeStoredMaterialAccountingSpoolMountStore,
} from "./dashboard_material_accounting_mount_store.js";

/**
 * Universal SpoolMount操作中の同期reservation。
 *
 * @constant {Map<string,Object>}
 */
const UNIVERSAL_SPOOL_ASSIGNMENT_RESERVATIONS = new Map();

/**
 * 値をtrim済み文字列へ変換する。
 *
 * @private
 * @function toTrimmedText
 * @param {*} value - 文字列候補。
 * @returns {string} trim済み文字列。
 */
function toTrimmedText(value) {
  return String(value ?? "").trim();
}

/**
 * managed spoolが削除済みかを判定する。
 *
 * @private
 * @function isManagedSpoolDeleted
 * @param {Object|null|undefined} spool - managed spool候補。
 * @returns {boolean} 削除済みならtrue。
 */
function isManagedSpoolDeleted(spool) {
  return !!(spool && (spool.deleted === true || spool.isDeleted === true));
}

/**
 * managed spool配列からspoolId別mapを生成する。
 *
 * @private
 * @function createManagedSpoolMap
 * @param {Array<Object>} spools - managed spool配列。
 * @returns {Map<string,Object>} spoolId別managed spool map。
 */
function createManagedSpoolMap(spools) {
  const map = new Map();
  for (const spool of Array.isArray(spools) ? spools : []) {
    const spoolId = toTrimmedText(spool?.id || spool?.spoolId);
    if (spoolId) {
      map.set(spoolId, spool);
    }
  }
  return map;
}

/**
 * legacy hostSpoolMapからspoolId別owner一覧を生成する。
 *
 * @private
 * @function createLegacyOwnersBySpoolId
 * @param {Object} hostSpoolMap - legacy hostSpoolMap。
 * @returns {Map<string,Array<string>>} spoolId別legacy host一覧。
 */
function createLegacyOwnersBySpoolId(hostSpoolMap) {
  const map = new Map();
  const source = hostSpoolMap && typeof hostSpoolMap === "object" ? hostSpoolMap : {};
  for (const [host, spoolIdValue] of Object.entries(source)) {
    const spoolId = toTrimmedText(spoolIdValue);
    if (!spoolId) {
      continue;
    }
    const owners = map.get(spoolId) || [];
    owners.push(host);
    map.set(spoolId, owners);
  }
  return map;
}

/**
 * Universal storeの現在OPEN mountを列挙する。
 *
 * 【詳細説明】
 * - cross-backend排他の対象は「現在装着中」のOPEN mountだけであり、CLOSED履歴は監査証跡として保持する。
 * - 入力storeは保存途中や旧形式の可能性があるため、必ず既存normalizerを通してから参照する。
 *
 * @function listCurrentOpenUniversalSpoolMounts
 * @param {Object|null|undefined} store - Universal SpoolMount store。
 * @returns {Array<Object>} 現在OPENなUniversal mount一覧。
 * @example
 * const openMounts = listCurrentOpenUniversalSpoolMounts(store);
 */
export function listCurrentOpenUniversalSpoolMounts(store) {
  const normalizedStore = normalizeStoredMaterialAccountingSpoolMountStore(store);
  return (normalizedStore.spoolMounts || []).filter((mount) => mount?.status === SPOOL_MOUNT_STATUS.OPEN);
}

/**
 * Universal側の現在占有または予約を検出する。
 *
 * 【詳細説明】
 * - legacy hostSpoolMapが同一spoolを装着する直前に呼び、Universal OPEN mountまたはin-flight reservationが
 *   ある場合は拒否理由を返す。
 * - CLOSED mount履歴は過去の証跡であり、現在占有とは見なさない。
 *
 * @function findUniversalSpoolAssignmentConflict
 * @param {Object} input - 検査入力。
 * @param {string} input.spoolId - 検査対象managed spool ID。
 * @param {Object=} input.store - Universal SpoolMount store。
 * @param {string=} input.allowReservationOwnerId - 同一ownerのreservationだけ許容する場合のowner ID。
 * @returns {Object|null} 衝突情報。衝突がなければnull。
 * @example
 * const conflict = findUniversalSpoolAssignmentConflict({ spoolId, store });
 */
export function findUniversalSpoolAssignmentConflict(input = {}) {
  const spoolId = toTrimmedText(input.spoolId);
  if (!spoolId) {
    return null;
  }
  for (const mount of listCurrentOpenUniversalSpoolMounts(input.store)) {
    if (toTrimmedText(mount?.spoolId) === spoolId) {
      return {
        type: "universal-spool-open-mount-conflict",
        reason: "universal-spool-already-mounted",
        spoolId,
        mountId: mount.mountId,
        materialSourceId: mount.materialSourceId,
      };
    }
  }
  const reservation = UNIVERSAL_SPOOL_ASSIGNMENT_RESERVATIONS.get(spoolId) || null;
  if (reservation && toTrimmedText(reservation.ownerId) !== toTrimmedText(input.allowReservationOwnerId)) {
    return {
      type: "universal-spool-reservation-conflict",
      reason: "universal-spool-assignment-in-flight",
      spoolId,
      ownerId: reservation.ownerId,
      materialSourceId: reservation.materialSourceId,
    };
  }
  return null;
}

/**
 * Universal SpoolMount操作中のスプール予約を取得する。
 *
 * 【詳細説明】
 * - JavaScriptの単一イベントループ上でも、IndexedDB CAS中にlegacy UI操作が割り込む余地があるため、
 *   awaitを跨ぐUniversal mount/replaceはこのreservationを保持する。
 * - 予約に失敗した場合、呼び出し側はdurable mutationへ進まずfail-closedする。
 *
 * @function reserveUniversalSpoolAssignment
 * @param {Object} input - 予約入力。
 * @param {string} input.spoolId - 予約対象managed spool ID。
 * @param {string} input.ownerId - operationまたはoperator action由来の予約owner ID。
 * @param {string=} input.materialSourceId - 対象MaterialSource ID。
 * @returns {{ok:boolean, reason:string, release:Function, conflict:Object|null}} 予約結果。
 * @example
 * const reservation = reserveUniversalSpoolAssignment({ spoolId, ownerId });
 */
export function reserveUniversalSpoolAssignment(input = {}) {
  const spoolId = toTrimmedText(input.spoolId);
  const ownerId = toTrimmedText(input.ownerId);
  if (!spoolId) {
    return { ok: false, reason: "spool-id-required", release: () => {}, conflict: null };
  }
  if (!ownerId) {
    return { ok: false, reason: "reservation-owner-id-required", release: () => {}, conflict: null };
  }
  const existing = UNIVERSAL_SPOOL_ASSIGNMENT_RESERVATIONS.get(spoolId) || null;
  if (existing && toTrimmedText(existing.ownerId) !== ownerId) {
    return {
      ok: false,
      reason: "universal-spool-assignment-in-flight",
      release: () => {},
      conflict: {
        type: "universal-spool-reservation-conflict",
        reason: "universal-spool-assignment-in-flight",
        spoolId,
        ownerId: existing.ownerId,
        materialSourceId: existing.materialSourceId,
      },
    };
  }
  UNIVERSAL_SPOOL_ASSIGNMENT_RESERVATIONS.set(spoolId, {
    spoolId,
    ownerId,
    materialSourceId: toTrimmedText(input.materialSourceId),
    reservedAt: new Date().toISOString(),
  });
  let released = false;
  return {
    ok: true,
    reason: "",
    conflict: null,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      const current = UNIVERSAL_SPOOL_ASSIGNMENT_RESERVATIONS.get(spoolId) || null;
      if (current && toTrimmedText(current.ownerId) === ownerId) {
        UNIVERSAL_SPOOL_ASSIGNMENT_RESERVATIONS.delete(spoolId);
      }
    },
  };
}

/**
 * 現在OPENなUniversal mountだけをlegacy/current backendと照合する。
 *
 * 【詳細説明】
 * - restore/import後に、最終的なfilamentSpools/hostSpoolMapとUniversal SpoolMount authorityを照合する。
 * - legacy hostSpoolMapと同じspoolを指すOPEN mount、またはmanaged spoolがmissing/deletedのOPEN mountだけを
 *   active authorityから隔離する。
 * - CLOSED mount履歴は過去の監査証跡なので隔離しない。
 *
 * @function reconcileCurrentOpenUniversalSpoolMountsAgainstBackends
 * @param {Object} input - 照合入力。
 * @param {Object} input.store - Universal SpoolMount store。
 * @param {Array<Object>} input.managedSpools - 現在のmanaged spool配列。
 * @param {Object} input.hostSpoolMap - 現在のlegacy hostSpoolMap。
 * @returns {Object} backend整合性を反映した正規化済みstore。
 * @example
 * const reconciled = reconcileCurrentOpenUniversalSpoolMountsAgainstBackends({ store, managedSpools, hostSpoolMap });
 */
export function reconcileCurrentOpenUniversalSpoolMountsAgainstBackends(input = {}) {
  const normalizedStore = normalizeStoredMaterialAccountingSpoolMountStore(input.store);
  const managedSpoolById = createManagedSpoolMap(input.managedSpools);
  const legacyOwnersBySpoolId = createLegacyOwnersBySpoolId(input.hostSpoolMap);
  const activeMounts = [];
  const conflicts = [];
  const retainedUnsupportedEntries = [];

  for (const mount of normalizedStore.spoolMounts || []) {
    if (mount?.status !== SPOOL_MOUNT_STATUS.OPEN) {
      activeMounts.push(mount);
      continue;
    }
    const spoolId = toTrimmedText(mount?.spoolId);
    const managedSpool = managedSpoolById.get(spoolId) || null;
    if (!managedSpool || isManagedSpoolDeleted(managedSpool)) {
      const reason = !managedSpool ? "managed-spool-backend-missing" : "managed-spool-backend-deleted";
      conflicts.push({
        type: "spool-mount-cross-backend-conflict",
        reason,
        mountId: mount.mountId,
        materialSourceId: mount.materialSourceId,
        spoolId,
      });
      retainedUnsupportedEntries.push({
        kind: "spoolMount",
        reason,
        record: mount,
      });
      continue;
    }
    const legacyOwners = legacyOwnersBySpoolId.get(spoolId) || [];
    if (legacyOwners.length > 0) {
      conflicts.push({
        type: "spool-mount-cross-backend-conflict",
        reason: "legacy-spool-backend-conflict",
        mountId: mount.mountId,
        materialSourceId: mount.materialSourceId,
        spoolId,
        legacyHosts: legacyOwners,
      });
      retainedUnsupportedEntries.push({
        kind: "spoolMount",
        reason: "legacy-spool-backend-conflict",
        record: mount,
      });
      continue;
    }
    activeMounts.push(mount);
  }

  return normalizeStoredMaterialAccountingSpoolMountStore({
    ...normalizedStore,
    spoolMounts: activeMounts,
    conflicts: [
      ...(normalizedStore.conflicts || []),
      ...conflicts,
    ],
    retainedUnsupportedEntries: [
      ...(normalizedStore.retainedUnsupportedEntries || []),
      ...retainedUnsupportedEntries,
    ],
  });
}
