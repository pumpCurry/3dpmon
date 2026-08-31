/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 物理コマンド復旧ラッチモジュール
 * @file dashboard_physical_command_recovery_latch.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_physical_command_recovery_latch
 *
 * 【機能内容サマリ】
 * - CFS/CFS-Cなど物理状態を変えるコマンドがsubmitted/post-observed/unknownで終わった場合の復旧証跡を保持
 * - 再起動後も未解決コマンドを自動再送せず、operator確認または後続観測でのみ解決する契約を固定
 * - 保存済みstoreをfail-closedに正規化し、壊れたentryや衝突entryを隔離する
 *
 * 【公開関数一覧】
 * - {@link normalizeStoredPhysicalCommandRecoveryLatchStore}：保存済み復旧ラッチstoreを正規化
 * - {@link createPhysicalCommandRecoveryLatchRecord}：送信結果から未解決候補recordを生成
 * - {@link appendPhysicalCommandRecoveryLatchRecord}：未解決候補recordをstoreへ冪等追加
 * - {@link resolvePhysicalCommandRecoveryLatchRecord}：operator/観測結果で未解決recordを解決
 *
 * @version 1.390.1540 (PR #439)
 * @since   1.390.1536 (PR #439)
 * @lastModified 2026-08-31 18:41:08
 * -----------------------------------------------------------
 * @todo
 * - Gate 19 production command dispatcherへ接続し、submitted/post-observed/unknown resultを永続保存する
 */

"use strict";

import {
  createPrinterCoreV3DeterministicId,
  stableStringifyPrinterCoreV3Value,
} from "./dashboard_data_schema_v3.js";

/**
 * 物理コマンド復旧ラッチstore schema version。
 *
 * @constant {number}
 */
export const PHYSICAL_COMMAND_RECOVERY_LATCH_SCHEMA_VERSION = 1;

/**
 * 復旧ラッチが扱うコマンド状態。
 *
 * @constant {Readonly<object>}
 */
export const PHYSICAL_COMMAND_RECOVERY_LATCH_STATUS = Object.freeze({
  SUBMITTED: "submitted",
  POST_OBSERVED: "post-observed",
  UNKNOWN: "unknown",
  COMPLETED: "completed",
  REJECTED: "rejected",
  FAILED: "failed",
  TIMEOUT: "timeout",
});

/**
 * 復旧ラッチが未解決として保持する状態集合。
 *
 * @private
 * @constant {ReadonlySet<string>}
 */
const UNRESOLVED_STATUSES = Object.freeze(new Set([
  PHYSICAL_COMMAND_RECOVERY_LATCH_STATUS.SUBMITTED,
  PHYSICAL_COMMAND_RECOVERY_LATCH_STATUS.POST_OBSERVED,
  PHYSICAL_COMMAND_RECOVERY_LATCH_STATUS.UNKNOWN,
]));

/**
 * 復旧ラッチを解除できるresolution一覧。
 *
 * @private
 * @constant {ReadonlySet<string>}
 */
const SUPPORTED_RESOLUTIONS = Object.freeze(new Set([
  "operator-cleared",
  "observed-confirmed",
  "observed-rejected",
]));

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
 * JSON互換値をdeep freezeする。
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
 * audit保存値から再送材料になり得るキーを除去する。
 *
 * 【詳細説明】
 * - `events` や `retainedUnsupportedEntries` はimportされた過去データを保持する場所だが、
 *   そこにRPC method/paramsやraw frameが残ると、復旧UIや将来コードが誤って再送材料として使う余地が生まれる。
 * - 復旧ラッチは「何を確認すべきか」の証跡だけを保持するため、再送に十分なpayload系キーは再帰的に落とす。
 *
 * @private
 * @function sanitizeAuditValue
 * @param {*} value - audit保存値候補。
 * @returns {*} サニタイズ済みJSON互換値。
 */
function sanitizeAuditValue(value) {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeAuditValue(entry));
  }
  const blockedKeys = new Set([
    "commandFrame",
    "rpcPayload",
    "rawFrame",
    "frame",
    "payload",
    "request",
    "response",
    "method",
    "params",
  ]);
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (blockedKeys.has(key)) {
      continue;
    }
    output[key] = sanitizeAuditValue(child);
  }
  return output;
}

/**
 * 値をtrim済み文字列へ正規化する。
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
 * 任意値をISO日時文字列へ正規化する。
 *
 * @private
 * @function normalizeIsoTime
 * @param {*} value - 日時候補。
 * @returns {?string} 有効なISO日時、またはnull。
 */
function normalizeIsoTime(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * 整数値へ正規化する。
 *
 * @private
 * @function normalizeInteger
 * @param {*} value - 数値候補。
 * @returns {?number} 有効な整数、またはnull。
 */
function normalizeInteger(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return null;
  }
  return Math.trunc(numberValue);
}

/**
 * 観測snapshot参照を保存可能な最小shapeへ正規化する。
 *
 * 【詳細説明】
 * - 復旧ラッチには「どの観測を根拠に送ったか」だけを残す。
 * - raw frameやcommand payloadを混ぜると再起動後の再送材料になり得るため、digest/sequence/observedAtへ限定する。
 *
 * @private
 * @function normalizeObservationReference
 * @param {*} value - 観測参照候補。
 * @returns {?Object} 正規化済み観測参照、またはnull。
 */
function normalizeObservationReference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const sequence = normalizeInteger(value.sequence);
  const digest = toTrimmedString(value.digest);
  const observedAt = normalizeIsoTime(value.observedAt);
  if (sequence === null && !digest && !observedAt) {
    return null;
  }
  return {
    sequence,
    digest: digest || null,
    observedAt,
  };
}

/**
 * 復旧ラッチrecordのpayload digestを生成する。
 *
 * @private
 * @function createRecoveryRecordDigest
 * @param {Object} record - 復旧ラッチrecord。
 * @returns {string} deterministic digest。
 */
function createRecoveryRecordDigest(record) {
  return `fnv1a128:${createPrinterCoreV3DeterministicId("physical-command-recovery-record-digest", [
    stableStringifyPrinterCoreV3Value({
      commandId: record.commandId,
      commandKind: record.commandKind,
      deviceId: record.deviceId,
      sessionId: record.sessionId,
      connectionGeneration: record.connectionGeneration,
      status: record.status,
      sentAt: record.sentAt,
      materialSourceId: record.materialSourceId,
      certificationId: record.certificationId,
      preObservation: record.preObservation,
    }),
  ]).split(":")[1]}`;
}

/**
 * 空の復旧ラッチstoreを生成する。
 *
 * @private
 * @function createEmptyStore
 * @returns {Object} 空store。
 */
function createEmptyStore() {
  return {
    schemaVersion: PHYSICAL_COMMAND_RECOVERY_LATCH_SCHEMA_VERSION,
    authority: "physical-command-recovery-latch",
    unresolvedByCommandId: {},
    events: [],
    retainedUnsupportedEntries: [],
    invariants: {
      autoReplay: false,
      commandFramePersistence: false,
      physicalCommandAuthority: "recovery-latch-only",
    },
  };
}

/**
 * 復旧ラッチrecordの妥当性を検査する。
 *
 * @private
 * @function validateRecoveryRecord
 * @param {*} value - record候補。
 * @returns {{ok:boolean, reasons:Array<string>, record:?Object, persistedDigest:?string, recomputedDigest:?string}} 検査結果。
 */
function validateRecoveryRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      reasons: ["record-not-object"],
      record: null,
      persistedDigest: null,
      recomputedDigest: null,
    };
  }
  const commandId = toTrimmedString(value.commandId);
  const commandKind = toTrimmedString(value.commandKind);
  const deviceId = toTrimmedString(value.deviceId);
  const sessionId = toTrimmedString(value.sessionId);
  const status = toTrimmedString(value.status);
  const sentAt = normalizeIsoTime(value.sentAt);
  const reasons = [];
  if (!commandId) reasons.push("missing-command-id");
  if (!commandKind) reasons.push("missing-command-kind");
  if (!deviceId) reasons.push("missing-device-id");
  if (!sessionId) reasons.push("missing-session-id");
  if (!status) reasons.push("missing-status");
  if (!sentAt) reasons.push("missing-sent-at");

  const record = {
    recoveryId: toTrimmedString(value.recoveryId) || null,
    commandId,
    commandKind,
    deviceId,
    sessionId,
    connectionGeneration: normalizeInteger(value.connectionGeneration),
    status,
    sentAt,
    materialSourceId: toTrimmedString(value.materialSourceId) || null,
    certificationId: toTrimmedString(value.certificationId) || null,
    preObservation: normalizeObservationReference(value.preObservation),
  };
  const persistedDigest = toTrimmedString(value.digest) || null;
  const recomputedDigest = createRecoveryRecordDigest(record);
  if (persistedDigest && persistedDigest !== recomputedDigest) {
    reasons.push("command-id-digest-mismatch");
  }
  // 保存済みdigestは信頼境界外なので、record本体は常にcanonical fieldsから再計算した値へ寄せる。
  record.digest = recomputedDigest;
  record.recoveryId = record.recoveryId || createPrinterCoreV3DeterministicId("physical-command-recovery", [
    record.commandId,
    record.digest,
  ]);

  return {
    ok: reasons.length === 0,
    reasons,
    record,
    persistedDigest,
    recomputedDigest,
  };
}

/**
 * 物理コマンド送信結果から復旧ラッチrecordを生成する。
 *
 * 【詳細説明】
 * - commandFrame/RPC payloadなど再送に使える情報は意図的に保存しない。
 * - submitted/post-observed/unknown以外の状態もrecord化はできるが、append時には未解決一覧へ入れずaudit eventのみ残す。
 *
 * @function createPhysicalCommandRecoveryLatchRecord
 * @param {Object} input - コマンド送信結果。
 * @param {string} input.commandId - コマンドID。
 * @param {string} input.commandKind - コマンド種別。
 * @param {string} input.deviceId - Printer Core v3 deviceId。
 * @param {string} input.sessionId - 送信時sessionId。
 * @param {number=} input.connectionGeneration - 接続世代番号。
 * @param {string} input.status - submitted/post-observed/unknown/completed/rejectedなどの結果状態。
 * @param {string|Date} input.sentAt - 送信時刻。
 * @param {?string=} input.materialSourceId - 対象MaterialSource ID。
 * @param {?string=} input.certificationId - 利用したcertification ID。
 * @param {?Object=} input.preObservation - 送信前観測参照。
 * @returns {Object} 正規化済み復旧ラッチrecord。
 * @throws {TypeError} 必須項目が欠けた場合。
 * @example
 * const record = createPhysicalCommandRecoveryLatchRecord({
 *   commandId: "command:k2-select-1a",
 *   commandKind: "cfs-slot-select",
 *   deviceId: "serial:k2pro-69e7",
 *   sessionId: "session:live-001",
 *   status: "unknown",
 *   sentAt: new Date(),
 * });
 */
export function createPhysicalCommandRecoveryLatchRecord(input) {
  const validation = validateRecoveryRecord(input);
  if (!validation.ok) {
    throw new TypeError(`invalid physical command recovery record: ${validation.reasons.join(",")}`);
  }
  return deepFreezeJson(validation.record);
}

/**
 * 保存済み復旧ラッチstoreをfail-closedに正規化する。
 *
 * 【詳細説明】
 * - 保存値が改ざん・破損していても、autoReplayやcommandFramePersistenceは必ずfalseへ戻す。
 * - 未解決一覧にはsubmitted/post-observed/unknownだけを残し、壊れたrecordや解決済みrecordはretainedUnsupportedEntriesへ隔離する。
 *
 * @function normalizeStoredPhysicalCommandRecoveryLatchStore
 * @param {Object|null|undefined} input - 保存済みstore候補。
 * @returns {Object} 正規化済みstore。
 * @example
 * const store = normalizeStoredPhysicalCommandRecoveryLatchStore(rawStore);
 */
export function normalizeStoredPhysicalCommandRecoveryLatchStore(input) {
  const emptyStore = createEmptyStore();
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return deepFreezeJson(emptyStore);
  }

  const unresolvedByCommandId = {};
  const retainedUnsupportedEntries = Array.isArray(input.retainedUnsupportedEntries)
    ? sanitizeAuditValue(cloneJsonValue(input.retainedUnsupportedEntries))
    : [];
  const sourceEntries = input.unresolvedByCommandId && typeof input.unresolvedByCommandId === "object"
    && !Array.isArray(input.unresolvedByCommandId)
    ? Object.entries(input.unresolvedByCommandId)
    : [];

  for (const [key, value] of sourceEntries) {
    const validation = validateRecoveryRecord(value);
    if (!validation.ok || !UNRESOLVED_STATUSES.has(validation.record.status)) {
      if (validation.reasons.includes("command-id-digest-mismatch")) {
        retainedUnsupportedEntries.push({
          commandId: validation.record?.commandId || toTrimmedString(value?.commandId) || toTrimmedString(key) || null,
          reason: "command-id-digest-mismatch",
          persistedDigest: validation.persistedDigest,
          recomputedDigest: validation.recomputedDigest,
          status: validation.record?.status || toTrimmedString(value?.status) || null,
        });
      } else {
        retainedUnsupportedEntries.push({
          commandId: toTrimmedString(value?.commandId) || toTrimmedString(key) || null,
          reason: "invalid-recovery-record",
          validationReasons: validation.reasons,
          status: toTrimmedString(value?.status) || null,
        });
      }
      continue;
    }
    if (validation.record.commandId !== toTrimmedString(key)) {
      retainedUnsupportedEntries.push({
        commandId: validation.record.commandId,
        storageKey: toTrimmedString(key),
        reason: "command-id-storage-key-mismatch",
        status: validation.record.status,
      });
      continue;
    }
    unresolvedByCommandId[validation.record.commandId] = validation.record;
  }

  const events = Array.isArray(input.events)
    ? sanitizeAuditValue(cloneJsonValue(input.events)).filter((event) => event && typeof event === "object" && !Array.isArray(event))
    : [];

  return deepFreezeJson({
    ...emptyStore,
    unresolvedByCommandId,
    events,
    retainedUnsupportedEntries,
  });
}

/**
 * 復旧ラッチrecordをstoreへ追加する。
 *
 * 【詳細説明】
 * - submitted/post-observed/unknownのみ未解決一覧へ入れる。
 * - 同一commandIdかつ同一digestは冪等追加として扱い、異なるdigestは既存recordを保持したまま隔離する。
 * - この関数は再起動後の復旧UIに必要な証跡だけを更新し、実コマンドの再送は行わない。
 *
 * @function appendPhysicalCommandRecoveryLatchRecord
 * @param {Object|null|undefined} storeInput - 現在のstore。
 * @param {Object} recordInput - 追加する復旧ラッチrecord。
 * @returns {{ok:boolean, status:string, store:Object, record:?Object, reasons:Array<string>}} 追加結果。
 * @example
 * const result = appendPhysicalCommandRecoveryLatchRecord(store, record);
 */
export function appendPhysicalCommandRecoveryLatchRecord(storeInput, recordInput) {
  const store = normalizeStoredPhysicalCommandRecoveryLatchStore(storeInput);
  const validation = validateRecoveryRecord(recordInput);
  if (!validation.ok) {
    return deepFreezeJson({
      ok: false,
      status: "invalid",
      store,
      record: null,
      reasons: validation.reasons,
    });
  }

  const record = validation.record;
  const unresolvedByCommandId = { ...store.unresolvedByCommandId };
  const events = [...store.events];
  const retainedUnsupportedEntries = [...store.retainedUnsupportedEntries];

  if (!UNRESOLVED_STATUSES.has(record.status)) {
    events.push({
      eventId: createPrinterCoreV3DeterministicId("physical-command-recovery-ignored-event", [
        record.commandId,
        record.digest,
      ]),
      type: "physical-command-recovery-ignored",
      commandId: record.commandId,
      status: record.status,
      recordedAt: record.sentAt,
    });
    return deepFreezeJson({
      ok: true,
      status: "ignored",
      store: {
        ...createEmptyStore(),
        unresolvedByCommandId,
        events,
        retainedUnsupportedEntries,
      },
      record,
      reasons: [],
    });
  }

  const existing = unresolvedByCommandId[record.commandId];
  if (existing) {
    if (existing.digest === record.digest) {
      return deepFreezeJson({
        ok: true,
        status: "idempotent",
        store,
        record: existing,
        reasons: [],
      });
    }
    delete unresolvedByCommandId[record.commandId];
    retainedUnsupportedEntries.push({
      commandId: record.commandId,
      reason: "command-id-digest-conflict",
      conflictedDigest: existing.digest,
      status: existing.status,
    });
    retainedUnsupportedEntries.push({
      commandId: record.commandId,
      reason: "command-id-digest-conflict",
      conflictedDigest: record.digest,
      status: record.status,
    });
    return deepFreezeJson({
      ok: false,
      status: "conflict",
      store: {
        ...createEmptyStore(),
        unresolvedByCommandId,
        events,
        retainedUnsupportedEntries,
      },
      record: existing,
      reasons: ["command-id-digest-conflict"],
    });
  }

  unresolvedByCommandId[record.commandId] = record;
  events.push({
    eventId: createPrinterCoreV3DeterministicId("physical-command-recovery-opened-event", [
      record.commandId,
      record.digest,
    ]),
    type: "physical-command-recovery-opened",
    commandId: record.commandId,
    commandKind: record.commandKind,
    deviceId: record.deviceId,
    sessionId: record.sessionId,
    materialSourceId: record.materialSourceId,
    status: record.status,
    recordedAt: record.sentAt,
  });

  return deepFreezeJson({
    ok: true,
    status: "appended",
    store: {
      ...createEmptyStore(),
      unresolvedByCommandId,
      events,
      retainedUnsupportedEntries,
    },
    record,
    reasons: [],
  });
}

/**
 * 未解決復旧ラッチrecordを解決済みにする。
 *
 * 【詳細説明】
 * - operator-cleared / observed-confirmed / observed-rejectedなど、外部確認でのみ未解決一覧から外す。
 * - 解決eventにはpostObservation参照を残せるが、ここでもraw frameやcommand payloadは保存しない。
 *
 * @function resolvePhysicalCommandRecoveryLatchRecord
 * @param {Object|null|undefined} storeInput - 現在のstore。
 * @param {Object} resolutionInput - 解決入力。
 * @param {string} resolutionInput.commandId - 解決するコマンドID。
 * @param {string} resolutionInput.resolution - 解決種別。
 * @param {string|Date} resolutionInput.resolvedAt - 解決時刻。
 * @param {?Object=} resolutionInput.postObservation - 解決根拠となる後続観測参照。
 * @returns {{ok:boolean, status:string, store:Object, record:?Object, reasons:Array<string>}} 解決結果。
 * @example
 * const result = resolvePhysicalCommandRecoveryLatchRecord(store, {
 *   commandId: "command:k2-select-1a",
 *   resolution: "operator-cleared",
 *   resolvedAt: new Date(),
 * });
 */
export function resolvePhysicalCommandRecoveryLatchRecord(storeInput, resolutionInput) {
  const store = normalizeStoredPhysicalCommandRecoveryLatchStore(storeInput);
  const commandId = toTrimmedString(resolutionInput?.commandId);
  const resolution = toTrimmedString(resolutionInput?.resolution);
  const resolvedAt = normalizeIsoTime(resolutionInput?.resolvedAt);
  const reasons = [];
  if (!commandId) reasons.push("missing-command-id");
  if (!resolution) reasons.push("missing-resolution");
  if (resolution && !SUPPORTED_RESOLUTIONS.has(resolution)) reasons.push("unsupported-resolution");
  if (!resolvedAt) reasons.push("missing-resolved-at");
  const postObservation = normalizeObservationReference(resolutionInput?.postObservation);
  if (resolution.startsWith("observed-")) {
    if (!postObservation?.digest) reasons.push("missing-post-observation-digest");
    if (!postObservation?.observedAt) reasons.push("missing-post-observation-observed-at");
  }
  if (reasons.length > 0) {
    return deepFreezeJson({
      ok: false,
      status: "invalid",
      store,
      record: null,
      reasons,
    });
  }

  const record = store.unresolvedByCommandId[commandId] || null;
  if (!record) {
    return deepFreezeJson({
      ok: false,
      status: "not-found",
      store,
      record: null,
      reasons: ["command-not-found"],
    });
  }

  const unresolvedByCommandId = { ...store.unresolvedByCommandId };
  delete unresolvedByCommandId[commandId];
  const event = {
    eventId: createPrinterCoreV3DeterministicId("physical-command-recovery-resolved-event", [
      commandId,
      resolution,
      resolvedAt,
    ]),
    type: "physical-command-recovery-resolved",
    commandId,
    commandKind: record.commandKind,
    deviceId: record.deviceId,
    sessionId: record.sessionId,
    materialSourceId: record.materialSourceId,
    resolution,
    resolvedAt,
    postObservation,
  };

  return deepFreezeJson({
    ok: true,
    status: "resolved",
    store: {
      ...createEmptyStore(),
      unresolvedByCommandId,
      events: [...store.events, event],
      retainedUnsupportedEntries: [...store.retainedUnsupportedEntries],
    },
    record,
    reasons: [],
  });
}
