/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 MaterialAccounting SpoolMount store モジュール
 * @file dashboard_material_accounting_mount_store.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_accounting_mount_store
 *
 * 【機能内容サマリ】
 * - Gate 18.9H-1a のoperator-managed SpoolMount production store shapeを提供
 * - 保存済みSpoolMount recordを検証し、壊れたentryや衝突entryをactive authorityから隔離
 * - durable authorityにoperationsByIdを保存せず、mount/event配列から復元できる形に正規化
 *
 * 【公開関数一覧】
 * - {@link createEmptyMaterialAccountingSpoolMountStore}：空のSpoolMount storeを生成
 * - {@link normalizeStoredMaterialAccountingSpoolMountStore}：保存済みstoreを安全なshapeへ正規化
 * - {@link createMaterialAccountingSpoolMountStoreDigest}：store digestを生成
 * - {@link createMaterialAccountingSpoolMountOperationPayloadDigest}：operation payload digestを生成
 * - {@link createMaterialAccountingSpoolMountStoreSnapshot}：store snapshotを生成
 *
 * @version 1.390.1581 (PR #440)
 * @since   1.390.1575 (PR #440)
 * @lastModified 2026-09-01 14:58:00
 * -----------------------------------------------------------
 * @todo
 * - Gate 18.9H-2でフィラメント管理UIからoperator mount/unmount/replaceへ接続する
 */

"use strict";

import {
  validateSpoolMount,
} from "./dashboard_material_accounting_contract.js";
import {
  createPrinterCoreV3DeterministicId,
  stableStringifyPrinterCoreV3Value,
} from "./dashboard_data_schema_v3.js";
import { createSpoolMountRepository } from "./dashboard_spool_mount_repository.js";

/**
 * MaterialAccounting SpoolMount store schema version。
 *
 * @constant {number}
 */
export const MATERIAL_ACCOUNTING_SPOOL_MOUNT_STORE_SCHEMA_VERSION = 1;

/**
 * MaterialAccounting SpoolMount store authority名。
 *
 * @constant {string}
 */
export const MATERIAL_ACCOUNTING_SPOOL_MOUNT_STORE_AUTHORITY = "material-accounting-spool-mount-store";

/**
 * store invariantsの固定値。
 *
 * @constant {Readonly<object>}
 */
const MATERIAL_ACCOUNTING_SPOOL_MOUNT_STORE_INVARIANTS = Object.freeze({
  operatorManaged: true,
  deviceObservationWrites: false,
  physicalCommandWrites: false,
  legacyHostSpoolMapWrites: false,
  legacyUsageHistoryWrites: false,
  legacySpoolRemainingWrites: false,
  filamentLedgerWrites: false,
  printBindingWrites: false,
});

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
 * 非負整数へ正規化する。
 *
 * @private
 * @function normalizeNonNegativeInteger
 * @param {*} value - 数値候補。
 * @param {number} fallback - fallback値。
 * @returns {number} 非負整数。
 */
function normalizeNonNegativeInteger(value, fallback) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) {
    return fallback;
  }
  return Math.floor(numberValue);
}

/**
 * 配列候補をclone済み配列へ正規化する。
 *
 * @private
 * @function normalizeArray
 * @param {*} value - 配列候補。
 * @returns {Array<*>} clone済み配列。
 */
function normalizeArray(value) {
  return Array.isArray(value) ? value.map((entry) => cloneJsonValue(entry)) : [];
}

/**
 * retained unsupported entryを生成する。
 *
 * @private
 * @function createRetainedUnsupportedEntry
 * @param {Object} input - entry入力。
 * @param {string} input.kind - entry種別。
 * @param {string} input.reason - 隔離理由。
 * @param {*} input.record - 隔離対象record。
 * @returns {Object} retained unsupported entry。
 */
function createRetainedUnsupportedEntry({ kind, reason, record }) {
  return {
    kind,
    reason,
    record: cloneJsonValue(record),
  };
}

/**
 * conflict recordから関係mount IDを抽出する。
 *
 * @private
 * @function collectConflictMountIds
 * @param {Object} conflict - conflict record。
 * @returns {string[]} mount ID配列。
 */
function collectConflictMountIds(conflict) {
  return [
    toTrimmedString(conflict?.existingMountId),
    toTrimmedString(conflict?.candidateMountId),
  ].filter(Boolean);
}

/**
 * conflict種別がfirst-win禁止のauthority ambiguityか判定する。
 *
 * @private
 * @function isAuthorityAmbiguityConflict
 * @param {Object} conflict - conflict record。
 * @returns {boolean} authority ambiguityならtrue。
 */
function isAuthorityAmbiguityConflict(conflict) {
  return [
    "source-open-mount-conflict",
    "spool-open-mount-conflict",
    "operation-payload-conflict",
    "mount-id-payload-conflict",
    "close-operation-payload-conflict",
    "close-payload-conflict",
    "source-interval-overlap-conflict",
    "spool-interval-overlap-conflict",
  ].includes(conflict?.type);
}

/**
 * store digestの入力shapeを生成する。
 *
 * @private
 * @function createDigestInput
 * @param {Object} store - store候補。
 * @returns {Object} digest入力。
 */
function createDigestInput(store) {
  return {
    schemaVersion: MATERIAL_ACCOUNTING_SPOOL_MOUNT_STORE_SCHEMA_VERSION,
    authority: MATERIAL_ACCOUNTING_SPOOL_MOUNT_STORE_AUTHORITY,
    storeRevision: normalizeNonNegativeInteger(store?.storeRevision, 0),
    spoolMounts: normalizeArray(store?.spoolMounts),
    events: normalizeArray(store?.events),
    conflicts: normalizeArray(store?.conflicts),
    retainedUnsupportedEntries: normalizeArray(store?.retainedUnsupportedEntries),
    invariants: { ...MATERIAL_ACCOUNTING_SPOOL_MOUNT_STORE_INVARIANTS },
  };
}

/**
 * operation payload digestを生成する。
 *
 * 【詳細説明】
 * - service層とstore復元層で同じpayload意味判定を使うため、store module側に集約する。
 * - `operatorActionId`の同一payload再送と異payloadconflictの判定材料として使う。
 *
 * @function createMaterialAccountingSpoolMountOperationPayloadDigest
 * @param {Object} payload - operation payload。
 * @returns {string} payload digest。
 * @example
 * const digest = createMaterialAccountingSpoolMountOperationPayloadDigest(payload);
 */
export function createMaterialAccountingSpoolMountOperationPayloadDigest(payload) {
  return `fnv1a128:${createPrinterCoreV3DeterministicId(
    "material-accounting-spool-mount-operation-payload",
    [stableStringifyPrinterCoreV3Value(cloneJsonValue(payload || {}))]
  )}`;
}

/**
 * MaterialAccounting SpoolMount store digestを生成する。
 *
 * 【詳細説明】
 * - 保存済み`storeDigest`は信頼せず、canonical fieldsから毎回再計算する。
 * - `storeDigest`自体をdigest入力へ含めると自己参照になるため除外する。
 *
 * @function createMaterialAccountingSpoolMountStoreDigest
 * @param {Object} store - digest対象store。
 * @returns {string} deterministic digest。
 * @example
 * const digest = createMaterialAccountingSpoolMountStoreDigest(store);
 */
export function createMaterialAccountingSpoolMountStoreDigest(store) {
  return `fnv1a128:${createPrinterCoreV3DeterministicId(
    "material-accounting-spool-mount-store-digest",
    [stableStringifyPrinterCoreV3Value(createDigestInput(store))]
  )}`;
}

/**
 * 空のMaterialAccounting SpoolMount storeを生成する。
 *
 * @function createEmptyMaterialAccountingSpoolMountStore
 * @param {Object} [input={}] - store初期値。
 * @param {number=} input.storeRevision - store revision。
 * @returns {Object} 空store。
 * @example
 * const store = createEmptyMaterialAccountingSpoolMountStore();
 */
export function createEmptyMaterialAccountingSpoolMountStore(input = {}) {
  const base = {
    schemaVersion: MATERIAL_ACCOUNTING_SPOOL_MOUNT_STORE_SCHEMA_VERSION,
    authority: MATERIAL_ACCOUNTING_SPOOL_MOUNT_STORE_AUTHORITY,
    storeRevision: normalizeNonNegativeInteger(input.storeRevision, 0),
    storeDigest: "",
    spoolMounts: [],
    events: [],
    conflicts: [],
    retainedUnsupportedEntries: [],
    invariants: { ...MATERIAL_ACCOUNTING_SPOOL_MOUNT_STORE_INVARIANTS },
  };
  base.storeDigest = createMaterialAccountingSpoolMountStoreDigest(base);
  return deepFreezeJson(base);
}

/**
 * 保存済みSpoolMount record配列をactive authorityとquarantineへ分ける。
 *
 * @private
 * @function normalizeSpoolMounts
 * @param {Array<Object>} candidates - 保存済みSpoolMount候補。
 * @returns {{spoolMounts:Array<Object>, conflicts:Array<Object>, retainedUnsupportedEntries:Array<Object>}} 正規化結果。
 */
function normalizeSpoolMounts(candidates) {
  const repository = createSpoolMountRepository();
  const acceptedById = new Map();
  const acceptedOrder = [];
  const conflicts = [];
  const retainedUnsupportedEntries = [];
  const quarantineIds = new Set();

  for (const candidate of candidates) {
    const validation = validateSpoolMount(candidate);
    if (!validation.ok) {
      retainedUnsupportedEntries.push(createRetainedUnsupportedEntry({
        kind: "spoolMount",
        reason: `invalid:${validation.errors.join(",")}`,
        record: candidate,
      }));
      continue;
    }

    const result = repository.recordMount(candidate);
    if (result.ok) {
      const stored = cloneJsonValue(result.record);
      acceptedById.set(stored.mountId, stored);
      if (!acceptedOrder.includes(stored.mountId)) {
        acceptedOrder.push(stored.mountId);
      }
      continue;
    }

    for (const conflict of result.conflicts || []) {
      conflicts.push(cloneJsonValue(conflict));
      const ids = collectConflictMountIds(conflict);
      for (const id of ids) {
        if (isAuthorityAmbiguityConflict(conflict)) {
          quarantineIds.add(id);
        }
      }
      retainedUnsupportedEntries.push(createRetainedUnsupportedEntry({
        kind: "spoolMount",
        reason: conflict.reason || "repository-conflict",
        record: candidate,
      }));
    }
    if (!Array.isArray(result.conflicts) || result.conflicts.length === 0) {
      retainedUnsupportedEntries.push(createRetainedUnsupportedEntry({
        kind: "spoolMount",
        reason: `repository-${result.action || "rejected"}`,
        record: candidate,
      }));
    }
  }

  for (const id of quarantineIds) {
    const accepted = acceptedById.get(id);
    if (accepted) {
      retainedUnsupportedEntries.push(createRetainedUnsupportedEntry({
        kind: "spoolMount",
        reason: "authority-conflict-quarantine",
        record: accepted,
      }));
    }
  }

  return {
    spoolMounts: acceptedOrder
      .filter((id) => !quarantineIds.has(id))
      .map((id) => acceptedById.get(id))
      .filter(Boolean),
    conflicts,
    retainedUnsupportedEntries,
  };
}

/**
 * store eventの参照可能record ID集合を生成する。
 *
 * @private
 * @function createRecordRefSet
 * @param {Array<Object>} mounts - active mount配列。
 * @returns {Set<string>} eventから参照可能なID集合。
 */
function createRecordRefSet(mounts) {
  const refs = new Set();
  for (const mount of mounts || []) {
    for (const value of [
      mount.mountId,
      mount.mountOperationId,
      mount.closeOperationId,
    ]) {
      const text = toTrimmedString(value);
      if (text) {
        refs.add(text);
      }
    }
  }
  return refs;
}

/**
 * operation eventがrecordRefs必須のoperator eventか判定する。
 *
 * @private
 * @function isRecordRefRequiredEventKind
 * @param {string} kind - event kind。
 * @returns {boolean} recordRefs必須ならtrue。
 */
function isRecordRefRequiredEventKind(kind) {
  return [
    "operator-mount",
    "operator-unmount",
    "operator-replace",
  ].includes(toTrimmedString(kind));
}

/**
 * operation eventのsemantic keyを生成する。
 *
 * @private
 * @function createOperationSemanticKey
 * @param {Object} event - operation event。
 * @returns {string} semantic key。生成できない場合は空文字。
 */
function createOperationSemanticKey(event) {
  const kind = toTrimmedString(event?.kind);
  const operatorActionId = toTrimmedString(event?.operatorActionId);
  return kind && operatorActionId ? `${kind}:${operatorActionId}` : "";
}

/**
 * operation eventのvalidation errorを取得する。
 *
 * @private
 * @function validateOperationEvent
 * @param {Object} event - event候補。
 * @param {Set<string>} recordRefs - 参照可能record ID集合。
 * @returns {Array<string>} validation error配列。
 */
function validateOperationEvent(event, recordRefs) {
  const errors = [];
  if (!event || typeof event !== "object") {
    return ["event-not-object"];
  }
  for (const key of ["eventId", "kind", "operatorActionId", "operationId", "payloadDigest"]) {
    if (!toTrimmedString(event[key])) {
      errors.push(`missing-${key}`);
    }
  }
  const payloadDigest = createMaterialAccountingSpoolMountOperationPayloadDigest(event.payload || {});
  if (toTrimmedString(event.payloadDigest) && event.payloadDigest !== payloadDigest) {
    errors.push("payload-digest-mismatch");
  }
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  for (const key of ["kind", "operatorActionId", "operationId"]) {
    const payloadValue = toTrimmedString(payload[key]);
    if (!payloadValue || payloadValue !== toTrimmedString(event[key])) {
      errors.push(`payload-${key}-mismatch`);
    }
  }
  const normalizedRecordRefs = Array.isArray(event.recordRefs)
    ? event.recordRefs.map((ref) => toTrimmedString(ref)).filter(Boolean)
    : [];
  if (isRecordRefRequiredEventKind(event.kind) && normalizedRecordRefs.length === 0) {
    errors.push("missing-event-record-refs");
  }
  const hasOrphanRef = normalizedRecordRefs.some((ref) => !recordRefs.has(ref));
  if (hasOrphanRef) {
    errors.push("orphan-event-record-ref");
  }
  return errors;
}

/**
 * operation event conflict recordを生成する。
 *
 * @private
 * @function createEventConflict
 * @param {Object} input - conflict入力。
 * @param {string} input.type - conflict種別。
 * @param {string} input.reason - conflict理由。
 * @param {Object} input.existingEvent - 既存event。
 * @param {Object} input.candidateEvent - 候補event。
 * @returns {Object} event conflict record。
 */
function createEventConflict({ type, reason, existingEvent, candidateEvent }) {
  return {
    type,
    reason,
    existingEventId: existingEvent.eventId,
    candidateEventId: candidateEvent.eventId,
    operationId: candidateEvent.operationId || null,
    operatorActionId: candidateEvent.operatorActionId || null,
  };
}

/**
 * 保存済みoperation event配列をactive eventsとquarantineへ分ける。
 *
 * @private
 * @function normalizeOperationEvents
 * @param {Array<Object>} candidates - 保存済みevent候補。
 * @param {Array<Object>} mounts - active mount配列。
 * @returns {{events:Array<Object>, conflicts:Array<Object>, retainedUnsupportedEntries:Array<Object>}} 正規化結果。
 */
function normalizeOperationEvents(candidates, mounts) {
  const recordRefs = createRecordRefSet(mounts);
  const acceptedById = new Map();
  const acceptedBySemanticKey = new Map();
  const acceptedOrder = [];
  const conflicts = [];
  const retainedUnsupportedEntries = [];
  const quarantineIds = new Set();

  for (const candidate of candidates) {
    const errors = validateOperationEvent(candidate, recordRefs);
    if (errors.length > 0) {
      retainedUnsupportedEntries.push(createRetainedUnsupportedEntry({
        kind: "event",
        reason: errors.includes("orphan-event-record-ref")
          ? "orphan-event-record-ref"
          : `invalid:${errors.join(",")}`,
        record: candidate,
      }));
      continue;
    }

    const event = cloneJsonValue(candidate);
    const existing = acceptedById.get(event.eventId);
    if (existing) {
      if (stableStringifyPrinterCoreV3Value(existing) === stableStringifyPrinterCoreV3Value(event)) {
        continue;
      }
      conflicts.push(createEventConflict({
        type: "event-id-payload-conflict",
        reason: "same-event-id-different-payload",
        existingEvent: existing,
        candidateEvent: event,
      }));
      quarantineIds.add(existing.eventId);
      quarantineIds.add(event.eventId);
      retainedUnsupportedEntries.push(createRetainedUnsupportedEntry({
        kind: "event",
        reason: "same-event-id-different-payload",
        record: event,
      }));
      continue;
    }

    const semanticKey = createOperationSemanticKey(event);
    const existingSemanticEvent = semanticKey ? acceptedBySemanticKey.get(semanticKey) : null;
    if (existingSemanticEvent) {
      if (existingSemanticEvent.payloadDigest === event.payloadDigest) {
        continue;
      }
      conflicts.push(createEventConflict({
        type: "operation-semantic-payload-conflict",
        reason: "same-operation-semantic-key-different-payload",
        existingEvent: existingSemanticEvent,
        candidateEvent: event,
      }));
      quarantineIds.add(existingSemanticEvent.eventId);
      quarantineIds.add(event.eventId);
      retainedUnsupportedEntries.push(createRetainedUnsupportedEntry({
        kind: "event",
        reason: "same-operation-semantic-key-different-payload",
        record: event,
      }));
      continue;
    }

    acceptedById.set(event.eventId, event);
    if (semanticKey) {
      acceptedBySemanticKey.set(semanticKey, event);
    }
    acceptedOrder.push(event.eventId);
  }

  for (const id of quarantineIds) {
    const accepted = acceptedById.get(id);
    if (accepted) {
      retainedUnsupportedEntries.push(createRetainedUnsupportedEntry({
        kind: "event",
        reason: "operation-event-conflict-quarantine",
        record: accepted,
      }));
    }
  }

  return {
    events: acceptedOrder
      .filter((id) => !quarantineIds.has(id))
      .map((id) => acceptedById.get(id))
      .filter(Boolean),
    conflicts,
    retainedUnsupportedEntries,
  };
}

/**
 * 保存済みMaterialAccounting SpoolMount storeを正規化する。
 *
 * 【詳細説明】
 * - 壊れたstoreを推測修復せず、valid recordだけactive authorityへ戻す。
 * - `operationsById`はdurable authorityとして受け継がず、mount/eventから再構築できる情報だけ残す。
 * - open conflictはfirst-winせず、既存・候補の双方をactive authorityから外す。
 *
 * @function normalizeStoredMaterialAccountingSpoolMountStore
 * @param {Object|null|undefined} stored - 保存済みstore。
 * @returns {Object} 正規化済みstore。
 * @example
 * const store = normalizeStoredMaterialAccountingSpoolMountStore(rawStore);
 */
export function normalizeStoredMaterialAccountingSpoolMountStore(stored) {
  const input = stored && typeof stored === "object" ? stored : {};
  const normalizedMounts = normalizeSpoolMounts(normalizeArray(input.spoolMounts));
  const normalizedEvents = normalizeOperationEvents(normalizeArray(input.events), normalizedMounts.spoolMounts);
  const base = {
    schemaVersion: MATERIAL_ACCOUNTING_SPOOL_MOUNT_STORE_SCHEMA_VERSION,
    authority: MATERIAL_ACCOUNTING_SPOOL_MOUNT_STORE_AUTHORITY,
    storeRevision: normalizeNonNegativeInteger(input.storeRevision, 0),
    storeDigest: "",
    spoolMounts: normalizedMounts.spoolMounts,
    events: normalizedEvents.events,
    conflicts: [
      ...normalizeArray(input.conflicts),
      ...normalizedMounts.conflicts,
      ...normalizedEvents.conflicts,
    ],
    retainedUnsupportedEntries: [
      ...normalizeArray(input.retainedUnsupportedEntries),
      ...normalizedMounts.retainedUnsupportedEntries,
      ...normalizedEvents.retainedUnsupportedEntries,
    ],
    invariants: { ...MATERIAL_ACCOUNTING_SPOOL_MOUNT_STORE_INVARIANTS },
  };
  base.storeDigest = createMaterialAccountingSpoolMountStoreDigest(base);
  return deepFreezeJson(base);
}

/**
 * MaterialAccounting SpoolMount store snapshotを生成する。
 *
 * @function createMaterialAccountingSpoolMountStoreSnapshot
 * @param {Object|null|undefined} store - store候補。
 * @returns {Object} clone済み正規化snapshot。
 * @example
 * const snapshot = createMaterialAccountingSpoolMountStoreSnapshot(store);
 */
export function createMaterialAccountingSpoolMountStoreSnapshot(store) {
  return normalizeStoredMaterialAccountingSpoolMountStore(store);
}
