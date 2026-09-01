/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 material source 観測ストア モジュール
 * @file dashboard_material_source_observation.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_source_observation
 *
 * 【機能内容サマリ】
 * - CFS/CFS-C/外部スプールのread-only material source観測をsnapshotとchange logへ正規化
 * - device identityのprovisional/stable昇格と、source単位のsemantic changeを管理
 * - command authority / spool ledgerへ逆流しない観測専用データ境界を提供
 *
 * 【公開関数一覧】
 * - {@link createEmptyMaterialSourceObservations}：空のmaterial source観測ストアを生成
 * - {@link normalizeStoredMaterialSourceObservations}：保存済み観測ストアをschema-awareに復元
 * - {@link recordMaterialTopologyObservation}：material topologyをatomic batchとして観測ストアへ反映
 * - {@link rekeyMaterialSourceObservationDevice}：provisional device観測をstable device IDへ安全に昇格
 * - {@link deriveMaterialSourceObservationFreshness}：保存snapshotから現在のfresh/stale表示状態を導出
 *
 * @version 1.390.1607 (PR #440)
 * @since   1.390.1422 (PR #435)
 * @lastModified 2026-09-01 21:55:00
 * -----------------------------------------------------------
 * @todo
 * - Gate 19のexpected-state correlationで参照する場合もcommand authorityへ直接入力しない境界を維持する
 */

"use strict";

import { normalizeMaterialColor } from "./dashboard_material_color.js";

/**
 * material source観測ストアのschema version。
 *
 * @constant {number}
 */
export const MATERIAL_SOURCE_OBSERVATION_SCHEMA_VERSION = 1;

/**
 * source単位のchange log保持上限。
 *
 * @constant {number}
 */
const DEFAULT_MAX_EVENTS_PER_SOURCE = 200;

/**
 * device単位のchange log保持上限。
 *
 * @constant {number}
 */
const DEFAULT_MAX_EVENTS_PER_DEVICE = 1000;

/**
 * 任意値を空値保持の文字列へ変換する。
 *
 * 【詳細説明】
 * - null/undefinedは未観測としてnullを返す。
 * - 空文字は「観測したが空」として空文字のまま返し、RFIDなどの意味を壊さない。
 *
 * @private
 * @function toNullableString
 * @param {*} value - 文字列候補。
 * @returns {?string} 文字列、またはnull。
 */
function toNullableString(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

/**
 * 任意値を有限数へ変換する。
 *
 * @private
 * @function toFiniteNumber
 * @param {*} value - 数値候補。
 * @param {?number} fallback - 変換不能時の値。
 * @returns {?number} 有限数、またはfallback。
 */
function toFiniteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * ISO日時文字列を正規化する。
 *
 * 【詳細説明】
 * - 日時が不正な場合は現在時刻へfallbackし、観測レコードの必須時刻を欠落させない。
 *
 * @private
 * @function toIsoDateTimeString
 * @param {*} value - 日時候補。
 * @returns {string} ISO 8601日時文字列。
 */
function toIsoDateTimeString(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  const time = date.getTime();
  return Number.isFinite(time) ? date.toISOString() : new Date().toISOString();
}

/**
 * 任意の日時候補を任意ISO文字列へ正規化する。
 *
 * 【詳細説明】
 * - source固有coverageのようなfail-closed証跡は、不正値を現在時刻へ化けさせると
 *   「観測できていた」証明に誤変換されるため、壊れた値はnullとして扱う。
 *
 * @private
 * @function normalizeOptionalIsoDateTimeString
 * @param {*} value - 日時候補。
 * @returns {string|null} 有効なISO 8601日時、またはnull。
 */
function normalizeOptionalIsoDateTimeString(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * 2つのISO時刻のうち遅い方を返す。
 *
 * 【詳細説明】
 * - bounded event logをtrimした場合、source固有coverageは保持範囲の先頭より前へ戻せない。
 * - 既存sourceの初回観測時刻とdevice log保持開始時刻のうち、より保守的な遅い時刻を採用する。
 *
 * @private
 * @function pickLaterIsoDateTimeString
 * @param {string|null|undefined} left - 時刻候補。
 * @param {string|null|undefined} right - 時刻候補。
 * @returns {string|null} 遅いISO 8601日時、またはnull。
 */
function pickLaterIsoDateTimeString(left, right) {
  const leftIso = normalizeOptionalIsoDateTimeString(left);
  const rightIso = normalizeOptionalIsoDateTimeString(right);
  if (!leftIso) return rightIso;
  if (!rightIso) return leftIso;
  return Date.parse(leftIso) >= Date.parse(rightIso) ? leftIso : rightIso;
}

/**
 * 明示指定された観測日時が有効かを確認する。
 *
 * 【詳細説明】
 * - `observedAt`未指定はアプリ側受信時刻を採番するため有効扱いにする。
 * - 文字列などが明示されていて日時として壊れている場合は、現在時刻へ化けさせず観測batchを拒否する。
 *
 * @private
 * @function isValidExplicitObservedAt
 * @param {*} value - 観測日時候補。
 * @returns {boolean} 未指定または有効日時ならtrue。
 */
function isValidExplicitObservedAt(value) {
  if (value === null || value === undefined || value === "") {
    return true;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime());
}

/**
 * JSON化可能な値をcloneする。
 *
 * @private
 * @function cloneJsonValue
 * @param {*} value - clone対象。
 * @returns {*} clone結果。
 */
function cloneJsonValue(value) {
  if (value === null || value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * object自身が指定propertyを持つかを判定する。
 *
 * 【詳細説明】
 * - `undefined`値を「観測されていない」と区別するため、truthy判定ではなく
 *   hasOwnPropertyでpayload上の存在だけを確認する。
 *
 * @private
 * @function hasOwn
 * @param {*} value - 判定対象。
 * @param {string} propertyName - property名。
 * @returns {boolean} 自身のpropertyとして存在する場合true。
 */
function hasOwn(value, propertyName) {
  return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, propertyName));
}

/**
 * observedFields maskが明示されているか判定する。
 *
 * @private
 * @function hasObservedFieldMask
 * @param {*} mask - observedFields候補。
 * @returns {boolean} mask objectならtrue。
 */
function hasObservedFieldMask(mask) {
  return Boolean(mask && typeof mask === "object" && !Array.isArray(mask));
}

/**
 * mask内のfieldが観測済みかを返す。
 *
 * 【詳細説明】
 * - maskが無い旧Normalized topologyではfallback判定を使い、後方互換を維持する。
 *
 * @private
 * @function isMaskedFieldObserved
 * @param {*} mask - field mask object。
 * @param {string} fieldName - field名。
 * @param {boolean} fallback - maskが無い場合の判定。
 * @returns {boolean} 観測済みならtrue。
 */
function isMaskedFieldObserved(mask, fieldName, fallback) {
  if (!hasObservedFieldMask(mask)) {
    return fallback;
  }
  return mask[fieldName] === true;
}

/**
 * mask内に観測済みfieldが1つでもあるかを返す。
 *
 * @private
 * @function hasAnyMaskedFieldObserved
 * @param {*} mask - field mask object。
 * @param {boolean} fallback - maskが無い場合の判定。
 * @returns {boolean} いずれかのfieldが観測済みならtrue。
 */
function hasAnyMaskedFieldObserved(mask, fallback) {
  if (!hasObservedFieldMask(mask)) {
    return fallback;
  }
  return Object.values(mask).some((value) => value === true);
}

/**
 * topology sectionが観測済みかを返す。
 *
 * @private
 * @function isTopologySectionObserved
 * @param {Object} topology - Normalized material topology。
 * @param {string} sectionName - section名。
 * @param {boolean} fallback - maskが無い場合の判定。
 * @returns {boolean} sectionが観測済みならtrue。
 */
function isTopologySectionObserved(topology, sectionName, fallback) {
  const sections = topology?.observationMask?.sections;
  if (!hasObservedFieldMask(sections)) {
    return fallback;
  }
  return sections[sectionName] === true;
}

/**
 * 既存source snapshotからbox/slot参照indexを生成する。
 *
 * 【詳細説明】
 * - `colorMatch` だけのpartial deltaではincoming sourcesが無いため、前回観測済みsourceの
 *   boxId/slotIdを使ってassignmentをsourceIdへ解決する。
 *
 * @private
 * @function createPreviousSourceLocationIndex
 * @param {Object<string,Object>} latestBySourceId - 既存source snapshot map。
 * @returns {Map<string,string>} `boxId:slotId` から sourceId へのindex。
 */
function createPreviousSourceLocationIndex(latestBySourceId) {
  const index = new Map();
  for (const [sourceId, snapshot] of Object.entries(latestBySourceId || {})) {
    const boxId = snapshot?.boxId ?? null;
    const slotId = snapshot?.slotId ?? snapshot?.protocolSlotId ?? null;
    if (sourceId && boxId !== null && boxId !== undefined && slotId !== null && slotId !== undefined) {
      index.set(`${boxId}:${slotId}`, sourceId);
    }
  }
  return index;
}

/**
 * assignment listを既存source snapshotで補完する。
 *
 * 【詳細説明】
 * - Normalizerは同じraw payload内にsourceが無い場合、`colorMatch` のsourceIdを未解決にする。
 * - Observation storeでは前回source locationを持っているため、assignment sectionが観測済みなら
 *   既存sourceへ再解決してからsource snapshotへ適用する。
 *
 * @private
 * @function resolveAssignmentsAgainstPreviousSources
 * @param {Array<Object>} assignments - incoming assignment list。
 * @param {Object<string,Object>} latestBySourceId - 既存source snapshot map。
 * @returns {Array<Object>} sourceId補完済みassignment list。
 */
function resolveAssignmentsAgainstPreviousSources(assignments, latestBySourceId) {
  const locationIndex = createPreviousSourceLocationIndex(latestBySourceId);
  return (Array.isArray(assignments) ? assignments : []).map((assignment) => {
    if (assignment?.sourceId) {
      return cloneJsonValue(assignment);
    }
    const boxId = assignment?.boxId ?? null;
    const slotId = assignment?.slotId ?? assignment?.protocolSlotId ?? null;
    const resolvedSourceId = boxId !== null && boxId !== undefined && slotId !== null && slotId !== undefined
      ? locationIndex.get(`${boxId}:${slotId}`) || null
      : null;
    return {
      ...cloneJsonValue(assignment),
      sourceId: resolvedSourceId,
      resolution: resolvedSourceId ? "resolved-from-previous-source" : (assignment?.resolution || "unresolved"),
    };
  });
}

/**
 * 空のmaterial source観測ストアを生成する。
 *
 * @function createEmptyMaterialSourceObservations
 * @returns {Object} 空の観測ストア。
 * @example
 * const store = createEmptyMaterialSourceObservations();
 */
export function createEmptyMaterialSourceObservations() {
  return {
    schemaVersion: MATERIAL_SOURCE_OBSERVATION_SCHEMA_VERSION,
    byDeviceId: {},
  };
}

/**
 * storeらしいobjectを安全に初期化する。
 *
 * @private
 * @function ensureObservationStore
 * @param {Object|null|undefined} store - 観測ストア候補。
 * @returns {Object} 初期化済み観測ストア。
 */
function ensureObservationStore(store) {
  const target = store && typeof store === "object" ? store : createEmptyMaterialSourceObservations();
  target.schemaVersion = MATERIAL_SOURCE_OBSERVATION_SCHEMA_VERSION;
  if (!target.byDeviceId || typeof target.byDeviceId !== "object" || Array.isArray(target.byDeviceId)) {
    target.byDeviceId = {};
  }
  return target;
}

/**
 * 復元したmaterial source観測recordへlast-known印を付ける。
 *
 * 【詳細説明】
 * - 保存済みの観測は現在通信で得た値ではないため、live providerから新しい観測が来るまでは
 *   fresh/current扱いしない。
 * - snapshot側にも同じ印を付け、UIや診断がsource単位でも最終観測値と識別できるようにする。
 *
 * @private
 * @function markRestoredObservationRecord
 * @param {Object} record - 保存済みdevice観測record。
 * @param {string} restoredAt - 復元日時ISO文字列。
 * @returns {Object} 復元印付きrecord。
 */
function markRestoredObservationRecord(record, restoredAt) {
  const restored = cloneJsonValue(record) || {};
  restored.restoredFromStorage = true;
  restored.restoredAt = restoredAt;
  restored.authority = "observation-only";
  if (restored.latestBySourceId && typeof restored.latestBySourceId === "object") {
    for (const snapshot of Object.values(restored.latestBySourceId)) {
      if (snapshot && typeof snapshot === "object") {
        snapshot.restoredFromStorage = true;
        snapshot.restoredAt = restoredAt;
        snapshot.authority = "observation-only";
        snapshot.eventCoverageStartedAt = normalizeOptionalIsoDateTimeString(snapshot.eventCoverageStartedAt);
        snapshot.eventCoverageTrimmedAt = normalizeOptionalIsoDateTimeString(snapshot.eventCoverageTrimmedAt);
      }
    }
  }
  if (!Array.isArray(restored.events)) {
    restored.events = [];
  }
  if (!restored.latestBySourceId || typeof restored.latestBySourceId !== "object" || Array.isArray(restored.latestBySourceId)) {
    restored.latestBySourceId = {};
  }
  restored.eventCoverageStartedAt =
    restored.eventCoverageStartedAt !== null &&
    restored.eventCoverageStartedAt !== undefined &&
    restored.eventCoverageStartedAt !== "" &&
    isValidExplicitObservedAt(restored.eventCoverageStartedAt)
    ? toIsoDateTimeString(restored.eventCoverageStartedAt)
    : null;
  return restored;
}

/**
 * 保存済みmaterial source観測ストアをschema-awareに正規化する。
 *
 * 【詳細説明】
 * - version未記録/現行v1はlast-known evidenceとして安全に復元する。
 * - future schemaは現行コードで意味変換せず、unsupported storeとして保持するだけにして
 *   誤った再ラベルや上書きを防ぐ。
 *
 * @function normalizeStoredMaterialSourceObservations
 * @param {Object|null|undefined} stored - 保存済み観測ストア候補。
 * @param {Object=} options - 復元オプション。
 * @param {string=} options.restoredAt - 復元日時ISO文字列。
 * @returns {Object} 正規化済み観測ストア。
 * @example
 * const restored = normalizeStoredMaterialSourceObservations(rawStore);
 */
export function normalizeStoredMaterialSourceObservations(stored, options = {}) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return createEmptyMaterialSourceObservations();
  }
  const rawVersion = toFiniteNumber(stored.schemaVersion, MATERIAL_SOURCE_OBSERVATION_SCHEMA_VERSION);
  const schemaVersion = rawVersion === null ? MATERIAL_SOURCE_OBSERVATION_SCHEMA_VERSION : rawVersion;
  if (schemaVersion > MATERIAL_SOURCE_OBSERVATION_SCHEMA_VERSION) {
    return {
      schemaVersion,
      migrationStatus: "future-version-unsupported",
      byDeviceId: {},
      retainedUnsupportedStore: cloneJsonValue(stored),
      authority: "observation-only",
    };
  }
  const restoredAt = toIsoDateTimeString(options.restoredAt);
  const normalized = {
    schemaVersion: MATERIAL_SOURCE_OBSERVATION_SCHEMA_VERSION,
    migrationStatus: "current",
    byDeviceId: {},
    authority: "observation-only",
  };
  const byDeviceId = stored.byDeviceId && typeof stored.byDeviceId === "object" && !Array.isArray(stored.byDeviceId)
    ? stored.byDeviceId
    : {};
  for (const [deviceId, record] of Object.entries(byDeviceId)) {
    const key = String(deviceId || record?.deviceId || "").trim();
    if (!key || !record || typeof record !== "object" || Array.isArray(record)) {
      continue;
    }
    normalized.byDeviceId[key] = markRestoredObservationRecord({
      ...record,
      schemaVersion: MATERIAL_SOURCE_OBSERVATION_SCHEMA_VERSION,
      deviceId: record.deviceId || key,
    }, restoredAt);
  }
  return normalized;
}

/**
 * device観測レコードを取得または生成する。
 *
 * @private
 * @function ensureDeviceRecord
 * @param {Object} store - 観測ストア。
 * @param {Object} options - device生成オプション。
 * @param {string} options.deviceId - device ID。
 * @param {string} options.identityStrength - identity強度。
 * @param {string} options.host - 表示host。
 * @param {string} options.observedAt - 観測日時。
 * @returns {Object} device観測レコード。
 */
function ensureDeviceRecord(store, options) {
  const deviceId = String(options.deviceId || "").trim();
  if (!store.byDeviceId[deviceId]) {
    store.byDeviceId[deviceId] = {
      schemaVersion: MATERIAL_SOURCE_OBSERVATION_SCHEMA_VERSION,
      deviceId,
      identityStrength: options.identityStrength || "provisional",
      aliases: [],
      host: options.host || null,
      observationRevision: 0,
      latestBySourceId: {},
      events: [],
      firstObservedAt: options.observedAt,
      eventCoverageStartedAt: options.observedAt,
      lastObservedAt: options.observedAt,
      lastChangedAt: options.observedAt,
      providerId: null,
      providerStates: {},
      sessionId: null,
      providerGeneration: null,
      retiredProviderGenerations: [],
      lastSequence: null,
      providerDisconnectedAt: null,
      restoredFromStorage: false,
      restoredAt: null,
      authority: "observation-only",
    };
  }
  const record = store.byDeviceId[deviceId];
  record.identityStrength = options.identityStrength || record.identityStrength || "provisional";
  record.host = options.host || record.host || null;
  record.authority = "observation-only";
  return record;
}

/**
 * normalized topology sourceからsource IDを決定する。
 *
 * 【詳細説明】
 * - Adapter/Providerが出すsourceIdを最優先する。
 * - 欠落時だけkind/box/slotから保守的に合成し、外部とCFS slotをcollapseさせない。
 *
 * @private
 * @function resolveSourceId
 * @param {Object|null|undefined} source - material source。
 * @returns {?string} source ID。
 */
function resolveSourceId(source) {
  if (source?.sourceIdentity && source.sourceIdentity.valid === false) {
    return null;
  }
  const explicit = String(source?.sourceId ?? "").trim();
  if (explicit) {
    if (/(^|:)unknown(?=:|$)/i.test(explicit)) {
      return null;
    }
    return explicit;
  }
  const kind = String(source?.kind || "").trim();
  const slotId = toFiniteNumber(source?.slotId);
  if (kind === "external-spool") {
    return slotId === null ? null : `external:${slotId}`;
  }
  if (kind === "cfs-slot") {
    const boxId = toFiniteNumber(source?.boxId, toFiniteNumber(source?.unitIndex));
    return boxId === null || slotId === null ? null : `cfs:${boxId}:slot:${slotId}`;
  }
  return null;
}

/**
 * material sourceの装填状態を保守的に導出する。
 *
 * 【詳細説明】
 * - CFS/CFS-Cはフィラメント取り外し後もmaterial名・色・RFIDの残留metadataを返す可能性がある。
 * - 観測snapshotではそれらをprotocol evidenceとして保持するが、物理presenceの根拠には使わない。
 *
 * @private
 * @function derivePresence
 * @param {Object|null|undefined} source - material source。
 * @returns {string} loaded/empty/unknown/unobservedのいずれか。
 */
function derivePresence(source) {
  if (!source) {
    return "unobserved";
  }
  const explicitPresence = String(source.presence || "").trim();
  if (["loaded", "empty", "unknown", "unobserved"].includes(explicitPresence)) {
    return explicitPresence;
  }
  const stateCode = toFiniteNumber(source.status?.stateCode);
  if (stateCode === 1) {
    return "loaded";
  }
  if (stateCode === 0) {
    return "empty";
  }
  if (stateCode === null) {
    return "unknown";
  }
  return "unknown";
}

/**
 * sourceに紐づくassignmentを正規化する。
 *
 * @private
 * @function normalizeAssignmentsForSource
 * @param {Array<Object>} assignments - topology assignment一覧。
 * @param {string} sourceId - source ID。
 * @returns {Array<Object>} 正規化済みassignment一覧。
 */
function normalizeAssignmentsForSource(assignments, sourceId) {
  return (Array.isArray(assignments) ? assignments : [])
    .filter((assignment) => String(assignment?.sourceId || assignment?.materialSourceId || "").trim() === sourceId)
    .map((assignment) => ({
      assignmentId: toNullableString(assignment.assignmentId ?? assignment.protocolToolAlias),
      namespace: toNullableString(assignment.namespace),
      resolution: toNullableString(assignment.resolution) || "unknown",
    }))
    .sort((a, b) => String(a.assignmentId || "").localeCompare(String(b.assignmentId || "")));
}

/**
 * remaining証跡を意味を潰さず正規化する。
 *
 * @private
 * @function normalizeRemainingEvidence
 * @param {Object|null|undefined} source - material source。
 * @returns {Object} remaining観測証跡。
 */
function normalizeRemainingEvidence(source) {
  const remaining = source?.status?.remaining && typeof source.status.remaining === "object"
    ? source.status.remaining
    : {};
  return {
    rawPercent: remaining.rawPercent ?? source?.status?.percent ?? null,
    normalizedPercent: remaining.normalizedPercent ?? source?.status?.percent ?? null,
    valid: remaining.valid === undefined ? (remaining.rawPercent === undefined && source?.status?.percent === undefined ? null : true) : remaining.valid === true,
    confidence: remaining.confidence || "unknown",
    authority: "observation-only",
    provenance: remaining.provenance ? cloneJsonValue(remaining.provenance) : null,
  };
}

/**
 * material証跡を正規化する。
 *
 * @private
 * @function normalizeMaterialEvidence
 * @param {Object|null|undefined} source - material source。
 * @returns {Object} material観測証跡。
 */
function normalizeMaterialEvidence(source) {
  const material = source?.material && typeof source.material === "object" ? source.material : {};
  return {
    vendor: material.vendor ?? null,
    type: material.type ?? null,
    name: material.name ?? null,
    color: normalizeMaterialColor(material.color, {
      source: "material-source-observation",
      vendor: material.vendor || "unknown",
    }),
    rfid: material.rfid ?? null,
    minTemp: material.minTemp ?? null,
    maxTemp: material.maxTemp ?? null,
    pressure: material.pressure ?? null,
  };
}

/**
 * material source snapshotを作る。
 *
 * @private
 * @function createSourceSnapshot
 * @param {Object} options - snapshot生成オプション。
 * @returns {Object|null} source snapshot。
 */
function createSourceSnapshot(options) {
  const sourceId = resolveSourceId(options.source);
  if (!sourceId) {
    return null;
  }
  const source = options.source && typeof options.source === "object" ? options.source : {};
  const previous = options.previous && typeof options.previous === "object" ? options.previous : null;
  const status = source.status && typeof source.status === "object" ? source.status : {};
  const isPartial = options.snapshotCompleteness !== "complete";
  const observedFields = source.observedFields && typeof source.observedFields === "object" ? source.observedFields : null;
  const materialMask = observedFields?.material;
  const statusMask = observedFields?.status;
  const materialObserved = hasAnyMaskedFieldObserved(materialMask, hasOwn(source, "material"));
  const remainingObserved = isMaskedFieldObserved(
    statusMask,
    "remaining",
    hasOwn(status, "remaining") || hasOwn(status, "percent")
  );
  const stateCodeObserved = isMaskedFieldObserved(statusMask, "stateCode", hasOwn(status, "stateCode"));
  const presenceObserved = isMaskedFieldObserved(statusMask, "presence", hasOwn(source, "presence"));
  const editStatusObserved = isMaskedFieldObserved(statusMask, "editStatusCode", hasOwn(status, "editStatusCode"));
  const scrapObserved = isMaskedFieldObserved(statusMask, "scrap", hasOwn(status, "scrap"));
  const selectedObserved = isMaskedFieldObserved(statusMask, "selected", hasOwn(status, "selected"));
  const assignmentsObserved = options.assignmentsObserved === true;
  const snapshot = {
    sourceId,
    deviceId: options.deviceId,
    host: options.host || null,
    identityStrength: options.identityStrength || "provisional",
    kind: source?.kind || previous?.kind || "unknown",
    unitId: source?.unitId ?? previous?.unitId ?? null,
    boxId: source?.boxId ?? previous?.boxId ?? null,
    slotId: source?.slotId ?? previous?.slotId ?? null,
    protocolSlotId: source?.slotId ?? previous?.protocolSlotId ?? null,
    presence: derivePresence(source),
    presenceEvidence: cloneJsonValue(source.presenceEvidence || null),
    selected: source?.status?.selected === undefined || source?.status?.selected === null
      ? null
      : source.status.selected === true || Number(source.status.selected) === 1,
    material: normalizeMaterialEvidence(source),
    remaining: normalizeRemainingEvidence(source),
    status: {
      stateCode: toFiniteNumber(source?.status?.stateCode),
      editStatusCode: toFiniteNumber(source?.status?.editStatusCode),
      scrap: toFiniteNumber(source?.status?.scrap),
    },
    assignments: normalizeAssignmentsForSource(options.assignments, sourceId),
    firstObservedAt: previous?.firstObservedAt || options.observedAt,
    eventCoverageStartedAt: normalizeOptionalIsoDateTimeString(previous?.eventCoverageStartedAt) || options.observedAt,
    eventCoverageTrimmedAt: normalizeOptionalIsoDateTimeString(previous?.eventCoverageTrimmedAt),
    lastObservedAt: options.observedAt,
    lastChangedAt: previous?.lastChangedAt || options.observedAt,
    providerId: options.providerId || null,
    sessionId: options.sessionId || null,
    providerGeneration: options.providerGeneration || null,
    sequence: options.sequence ?? null,
    snapshotCompleteness: options.snapshotCompleteness || "partial",
    authority: "observation-only",
  };
  if (isPartial && previous) {
    if (hasObservedFieldMask(materialMask)) {
      const mergedMaterial = {
        ...cloneJsonValue(snapshot.material),
      };
      for (const key of ["vendor", "type", "name", "color", "rfid", "minTemp", "maxTemp", "pressure"]) {
        if (materialMask[key] !== true && previous.material && hasOwn(previous.material, key)) {
          mergedMaterial[key] = cloneJsonValue(previous.material[key]);
        }
      }
      snapshot.material = mergedMaterial;
    } else if (!materialObserved) {
      snapshot.material = cloneJsonValue(previous.material);
    }
    if (!remainingObserved) {
      snapshot.remaining = cloneJsonValue(previous.remaining);
    }
    if (!stateCodeObserved) {
      snapshot.status.stateCode = previous.status?.stateCode ?? null;
    }
    if (!editStatusObserved) {
      snapshot.status.editStatusCode = previous.status?.editStatusCode ?? null;
    }
    if (!scrapObserved) {
      snapshot.status.scrap = previous.status?.scrap ?? null;
    }
    if (!selectedObserved) {
      snapshot.selected = previous.selected ?? null;
    }
    if (!assignmentsObserved) {
      snapshot.assignments = cloneJsonValue(previous.assignments) || [];
    }
    if (!presenceObserved && !materialObserved && !stateCodeObserved) {
      snapshot.presence = previous.presence || snapshot.presence;
      snapshot.presenceEvidence = cloneJsonValue(previous.presenceEvidence) || snapshot.presenceEvidence;
    } else if (!presenceObserved && (!materialObserved || !stateCodeObserved)) {
      snapshot.presence = derivePresence({
        presence: snapshot.presence,
        material: snapshot.material,
        status: { stateCode: snapshot.status.stateCode },
      });
      snapshot.presenceEvidence = null;
    }
  }
  return snapshot;
}

/**
 * source snapshotごとのevent coverage開始時刻を保持範囲へ前進させる。
 *
 * 【詳細説明】
 * - device event logはsource別履歴も同じ配列に保持するbounded logなので、trim後は
 *   どのsourceについても保持範囲より前の「eventが無い」証明を使えない。
 * - sourceが後から初観測された場合は、そのsource自身のcoverage開始時刻を優先し、device側の
 *   早いcoverage開始で水増ししない。
 *
 * @private
 * @function advanceSourceEventCoverageStarts
 * @param {Object} record - device観測レコード。
 * @param {string|null} retainedFromAt - device全体のcoverageが前進した場合の最古event時刻。
 * @param {Map<string,string|null>=} retainedFromBySourceId - source別trim後の最古event時刻。
 * @returns {void}
 */
function advanceSourceEventCoverageStarts(record, retainedFromAt, retainedFromBySourceId = new Map()) {
  if (!record?.latestBySourceId || typeof record.latestBySourceId !== "object") {
    return;
  }
  for (const [sourceId, snapshot] of Object.entries(record.latestBySourceId)) {
    if (!snapshot || typeof snapshot !== "object") {
      continue;
    }
    snapshot.eventCoverageStartedAt = pickLaterIsoDateTimeString(
      snapshot.eventCoverageStartedAt,
      retainedFromAt
    );
    snapshot.eventCoverageStartedAt = pickLaterIsoDateTimeString(
      snapshot.eventCoverageStartedAt,
      retainedFromBySourceId.get(sourceId)
    );
    const sourceRetainedFromAt = retainedFromBySourceId.get(sourceId);
    const trimmedAt = pickLaterIsoDateTimeString(retainedFromAt, sourceRetainedFromAt);
    if (trimmedAt) {
      snapshot.eventCoverageTrimmedAt = pickLaterIsoDateTimeString(
        snapshot.eventCoverageTrimmedAt,
        trimmedAt
      );
    }
  }
}

/**
 * event配列から最も遅い観測時刻を取り出す。
 *
 * 【詳細説明】
 * - bounded event logのcoverage watermarkは、保持されたeventではなく削除されたeventの最遅時刻を
 *   基準にすることで、eventの挿入順とobservedAt順が逆転してもfail-openしない。
 * - 削除eventに有効なobservedAtが無い場合は、呼び出し元が渡したfallbackで安全側へ倒す。
 *
 * @private
 * @function pickLatestObservedAtFromEvents
 * @param {Object[]} events - 観測時刻を調べるevent配列。
 * @param {string|null=} fallbackAt - 有効な観測時刻が見つからない場合の保守的時刻。
 * @returns {string|null} 最も遅いISO 8601日時、またはnull。
 */
function pickLatestObservedAtFromEvents(events, fallbackAt = null) {
  let latestObservedAt = null;
  for (const event of Array.isArray(events) ? events : []) {
    latestObservedAt = pickLaterIsoDateTimeString(
      latestObservedAt,
      normalizeOptionalIsoDateTimeString(event?.observedAt)
    );
  }
  return latestObservedAt || normalizeOptionalIsoDateTimeString(fallbackAt);
}

/**
 * trimで削除されたeventをsource別coverage開始へ反映するwatermarkへ変換する。
 *
 * 【詳細説明】
 * - `maxEventsPerSource`や`maxEventsPerDevice`で特定sourceのeventが落ちた場合、残ったeventの
 *   最古時刻ではなく、削除されたeventの最遅時刻までcoverageを前進させる。
 * - event配列は監査用の挿入順を保持するためsortせず、coverage計算だけをobservedAt基準にする。
 *
 * @private
 * @function createRemovedEventCoverageBySourceId
 * @param {Object[]} originalEvents - trim前のevent配列。
 * @param {Object[]} retainedEvents - trim後に保持するevent配列。
 * @param {string|null} fallbackAt - 削除eventの時刻が壊れていた場合に使う保守的時刻。
 * @returns {Map<string,string|null>} source ID別coverage開始時刻。
 */
function createRemovedEventCoverageBySourceId(originalEvents, retainedEvents, fallbackAt) {
  const retainedSet = new Set(Array.isArray(retainedEvents) ? retainedEvents : []);
  const removedLatestBySourceId = new Map();
  const removedMissingObservedAt = new Set();
  for (const event of Array.isArray(originalEvents) ? originalEvents : []) {
    if (retainedSet.has(event)) {
      continue;
    }
    const sourceId = toNullableString(event?.sourceId);
    if (!sourceId) {
      continue;
    }
    const observedAt = normalizeOptionalIsoDateTimeString(event?.observedAt);
    if (!observedAt) {
      removedMissingObservedAt.add(sourceId);
      continue;
    }
    removedLatestBySourceId.set(
      sourceId,
      pickLaterIsoDateTimeString(removedLatestBySourceId.get(sourceId), observedAt)
    );
  }
  const coverageBySourceId = new Map();
  for (const sourceId of new Set([...removedLatestBySourceId.keys(), ...removedMissingObservedAt.values()])) {
    coverageBySourceId.set(sourceId, removedLatestBySourceId.get(sourceId) || normalizeOptionalIsoDateTimeString(fallbackAt));
  }
  return coverageBySourceId;
}

/**
 * semantic change判定用の署名を作る。
 *
 * 【詳細説明】
 * - lastObservedAtなどの時刻・heartbeatは含めず、意味のあるsource状態だけで比較する。
 *
 * @private
 * @function createSemanticSignature
 * @param {Object} snapshot - source snapshot。
 * @returns {string} semantic signature。
 */
function createSemanticSignature(snapshot) {
  return JSON.stringify({
    sourceId: snapshot.sourceId,
    kind: snapshot.kind,
    unitId: snapshot.unitId,
    boxId: snapshot.boxId,
    slotId: snapshot.slotId,
    presence: snapshot.presence,
    presenceEvidence: snapshot.presenceEvidence,
    selected: snapshot.selected,
    material: snapshot.material,
    remaining: snapshot.remaining,
    status: snapshot.status,
    assignments: snapshot.assignments,
    authority: snapshot.authority,
  });
}

/**
 * snapshotのlastObservedAtを比較用epoch msへ変換する。
 *
 * @private
 * @function snapshotObservedTime
 * @param {Object|null|undefined} snapshot - source snapshot。
 * @returns {?number} 有効なepoch ms、またはnull。
 */
function snapshotObservedTime(snapshot) {
  const time = new Date(snapshot?.lastObservedAt || 0).getTime();
  return Number.isFinite(time) && time > 0 ? time : null;
}

/**
 * rekey merge時の同一source競合を評価する。
 *
 * 【詳細説明】
 * - incomingが新しければ、provisional側で最後に観測した値をstable recordへ昇格する。
 * - 同時刻かつ意味が異なる場合は自動上書きせず、source単位のmerge conflict証跡として残す。
 *
 * @private
 * @function classifySourceMerge
 * @param {Object} existingSnapshot - merge先snapshot。
 * @param {Object} incomingSnapshot - merge元snapshot。
 * @returns {string} "replace"|"skip"|"conflict" のいずれか。
 */
function classifySourceMerge(existingSnapshot, incomingSnapshot) {
  const existingTime = snapshotObservedTime(existingSnapshot);
  const incomingTime = snapshotObservedTime(incomingSnapshot);
  if (incomingTime !== null && (existingTime === null || incomingTime > existingTime)) {
    return "replace";
  }
  if (incomingTime !== null && existingTime !== null && incomingTime === existingTime &&
      createSemanticSignature(existingSnapshot) !== createSemanticSignature(incomingSnapshot)) {
    return "conflict";
  }
  return "skip";
}

/**
 * source change eventを作る。
 *
 * @private
 * @function createSourceChangeEvent
 * @param {Object} options - event生成オプション。
 * @returns {Object} change event。
 */
function createSourceChangeEvent(options) {
  const revision = Number(options.revision || 0);
  const sourceId = options.sourceId || null;
  return {
    observationId: [
      "mso",
      encodeURIComponent(options.deviceId || "unknown"),
      sourceId ? encodeURIComponent(sourceId) : "device",
      revision,
      encodeURIComponent(options.changeKind || "changed"),
    ].join(":"),
    deviceId: options.deviceId,
    sourceId,
    observedAt: options.observedAt,
    changeKind: options.changeKind,
    before: options.before ? cloneJsonValue(options.before) : null,
    after: options.after ? cloneJsonValue(options.after) : null,
    authority: "observation-only",
    sessionId: options.sessionId || null,
    providerId: options.providerId || null,
    providerGeneration: options.providerGeneration || null,
    sequence: options.sequence ?? null,
  };
}

/**
 * change logを上限でtrimする。
 *
 * @private
 * @function trimDeviceEvents
 * @param {Object} record - device観測レコード。
 * @param {Object} limits - 上限設定。
 * @returns {void}
 */
function trimDeviceEvents(record, limits) {
  const maxPerSource = Math.max(1, Math.floor(toFiniteNumber(limits?.maxEventsPerSource, DEFAULT_MAX_EVENTS_PER_SOURCE) ?? DEFAULT_MAX_EVENTS_PER_SOURCE));
  const maxPerDevice = Math.max(1, Math.floor(toFiniteNumber(limits?.maxEventsPerDevice, DEFAULT_MAX_EVENTS_PER_DEVICE) ?? DEFAULT_MAX_EVENTS_PER_DEVICE));
  const originalEvents = Array.isArray(record.events) ? record.events : [];
  const originalLength = originalEvents.length;
  const sourceCounts = new Map();
  const keepBySource = [];
  for (let index = originalEvents.length - 1; index >= 0; index -= 1) {
    const event = originalEvents[index];
    const sourceId = event?.sourceId || "__device__";
    const count = sourceCounts.get(sourceId) || 0;
    if (count < maxPerSource) {
      keepBySource.push(event);
      sourceCounts.set(sourceId, count + 1);
    }
  }
  keepBySource.reverse();
  const retainedEvents = keepBySource.slice(Math.max(0, keepBySource.length - maxPerDevice));
  if (retainedEvents.length !== originalLength) {
    const retainedSet = new Set(retainedEvents);
    const removedEvents = originalEvents.filter((event) => !retainedSet.has(event));
    const previousEventCoverageStartedAt = normalizeOptionalIsoDateTimeString(record.eventCoverageStartedAt);
    const removedLatestObservedAt = pickLatestObservedAtFromEvents(removedEvents, record.lastObservedAt || null);
    record.eventCoverageStartedAt = pickLaterIsoDateTimeString(
      previousEventCoverageStartedAt,
      removedLatestObservedAt
    ) || record.lastObservedAt || null;
    record.eventCoverageTrimmedAt = pickLaterIsoDateTimeString(
      record.eventCoverageTrimmedAt,
      removedLatestObservedAt || record.lastObservedAt || null
    );
    const globalRetainedFromAt = pickLaterIsoDateTimeString(
      previousEventCoverageStartedAt,
      record.eventCoverageStartedAt
    ) !== previousEventCoverageStartedAt
      ? record.eventCoverageStartedAt
      : null;
    advanceSourceEventCoverageStarts(
      record,
      globalRetainedFromAt,
      createRemovedEventCoverageBySourceId(originalEvents, retainedEvents, record.lastObservedAt || record.eventCoverageStartedAt || null)
    );
  }
  record.events = retainedEvents;
}

/**
 * 観測batchが既存snapshotを巻き戻すか判定する。
 *
 * @private
 * @function rejectStaleBatch
 * @param {Object} record - device観測レコード。
 * @param {Object} options - 観測オプション。
 * @returns {Object|null} reject結果、またはnull。
 */
function rejectStaleBatch(record, options) {
  const providerKey = String(options.providerId || "__default__");
  const providerState = record.providerStates?.[providerKey] && typeof record.providerStates[providerKey] === "object"
    ? record.providerStates[providerKey]
    : null;
  const retiredSource = providerState
    ? providerState.retiredGenerations
    : record.retiredProviderGenerations;
  const retiredGenerations = new Set((Array.isArray(retiredSource) ? retiredSource : []).map((value) => String(value)));
  const incomingGeneration = options.providerGeneration ? String(options.providerGeneration) : null;
  if (incomingGeneration && retiredGenerations.has(incomingGeneration)) {
    return { accepted: false, reason: "stale-provider-generation", record };
  }
  const hasProviderState = Boolean(providerState);
  const hasExplicitProvider = Boolean(options.providerId);
  const previousObservedAt = hasProviderState
    ? providerState.lastObservedAt
    : (hasExplicitProvider ? null : record.lastObservedAt);
  if (!previousObservedAt) {
    return null;
  }
  const nextTime = new Date(options.observedAt).getTime();
  const prevTime = new Date(previousObservedAt).getTime();
  if (Number.isFinite(nextTime) && Number.isFinite(prevTime) && nextTime < prevTime) {
    const activeGeneration = hasProviderState ? providerState.activeGeneration : record.providerGeneration || null;
    if (activeGeneration && options.providerGeneration && activeGeneration !== options.providerGeneration) {
      return { accepted: false, reason: "stale-provider-generation", record };
    }
    return { accepted: false, reason: "stale-observation", record };
  }
  const activeGeneration = hasProviderState ? providerState.activeGeneration : (hasExplicitProvider ? null : record.providerGeneration || null);
  if (activeGeneration && options.providerGeneration && activeGeneration === options.providerGeneration) {
    const previousSequence = hasProviderState
      ? toFiniteNumber(providerState.lastSequence)
      : toFiniteNumber(record.lastSequence);
    const nextSequence = toFiniteNumber(options.sequence);
    if (previousSequence !== null && nextSequence !== null && nextSequence < previousSequence) {
      return { accepted: false, reason: "stale-sequence", record };
    }
  }
  return null;
}

/**
 * provider generationの切替を退役リストへ反映する。
 *
 * 【詳細説明】
 * - 再接続後に旧WebSocket/Moonraker callbackが遅れて到着しても、時刻が新しいという理由で
 *   最新snapshotを巻き戻せないようにする。
 *
 * @private
 * @function updateProviderGenerationLifecycle
 * @param {Object} record - device観測レコード。
 * @param {?string} providerId - provider ID。
 * @param {?string} nextGeneration - 今回受理するprovider generation。
 * @returns {void}
 */
function updateProviderGenerationLifecycle(record, providerId, nextGeneration) {
  const next = nextGeneration ? String(nextGeneration) : null;
  if (!next) {
    return;
  }
  const providerKey = String(providerId || "__default__");
  if (!record.providerStates || typeof record.providerStates !== "object" || Array.isArray(record.providerStates)) {
    record.providerStates = {};
  }
  const providerState = record.providerStates[providerKey] && typeof record.providerStates[providerKey] === "object"
    ? record.providerStates[providerKey]
    : { providerId: providerKey, activeGeneration: null, retiredGenerations: [] };
  const current = providerState.activeGeneration ? String(providerState.activeGeneration) : null;
  if (!current || current === next) {
    providerState.activeGeneration = next;
    providerState.lastObservedAt = record.lastObservedAt || null;
    providerState.lastSequence = record.lastSequence ?? providerState.lastSequence ?? null;
    providerState.disconnectedAt = null;
    record.providerStates[providerKey] = providerState;
    record.providerGeneration = next;
    return;
  }
  const retired = new Set(Array.isArray(providerState.retiredGenerations)
    ? providerState.retiredGenerations.map((value) => String(value))
    : []);
  retired.add(current);
  retired.delete(next);
  providerState.activeGeneration = next;
  providerState.retiredGenerations = Array.from(retired).slice(-16);
  providerState.lastObservedAt = record.lastObservedAt || null;
  providerState.lastSequence = record.lastSequence ?? null;
  providerState.disconnectedAt = null;
  record.providerStates[providerKey] = providerState;
  record.retiredProviderGenerations = Array.from(new Set([
    ...(Array.isArray(record.retiredProviderGenerations) ? record.retiredProviderGenerations : []),
    ...providerState.retiredGenerations,
  ])).slice(-16);
  record.providerGeneration = next;
}

/**
 * rekey merge時にprovider別状態を統合する。
 *
 * 【詳細説明】
 * - stable recordへprovisional recordを吸収する際、source snapshot/eventだけでなく、
 *   provider generationのactive/retired状態も保持して再接続診断の証跡を失わない。
 * - 同じproviderIdが両recordにある場合はlastObservedAtが新しい側のactiveGenerationを採用し、
 *   置き換えられたactiveGenerationはretiredGenerationsへ移す。
 *
 * @private
 * @function mergeProviderStatesForRekey
 * @param {Object} existing - merge先のstable device観測レコード。
 * @param {Object} incoming - merge元のprovisional device観測レコード。
 * @returns {void}
 */
function mergeProviderStatesForRekey(existing, incoming) {
  if (!existing.providerStates || typeof existing.providerStates !== "object" || Array.isArray(existing.providerStates)) {
    existing.providerStates = {};
  }
  const incomingStates = incoming.providerStates && typeof incoming.providerStates === "object" && !Array.isArray(incoming.providerStates)
    ? incoming.providerStates
    : {};
  for (const [providerId, incomingState] of Object.entries(incomingStates)) {
    if (!incomingState || typeof incomingState !== "object" || Array.isArray(incomingState)) {
      continue;
    }
    const key = String(providerId || "__default__");
    const currentState = existing.providerStates[key] && typeof existing.providerStates[key] === "object"
      ? existing.providerStates[key]
      : null;
    if (!currentState) {
      existing.providerStates[key] = cloneJsonValue(incomingState);
      continue;
    }
    const currentTime = new Date(currentState.lastObservedAt || 0).getTime();
    const incomingTime = new Date(incomingState.lastObservedAt || 0).getTime();
    const incomingIsNewer = Number.isFinite(incomingTime) &&
      (!Number.isFinite(currentTime) || incomingTime > currentTime);
    const winner = incomingIsNewer ? incomingState : currentState;
    const retired = new Set([
      ...(Array.isArray(currentState.retiredGenerations) ? currentState.retiredGenerations : []),
      ...(Array.isArray(incomingState.retiredGenerations) ? incomingState.retiredGenerations : []),
    ].map((value) => String(value)));
    const currentGeneration = currentState.activeGeneration ? String(currentState.activeGeneration) : null;
    const incomingGeneration = incomingState.activeGeneration ? String(incomingState.activeGeneration) : null;
    const winnerGeneration = winner.activeGeneration ? String(winner.activeGeneration) : null;
    for (const generation of [currentGeneration, incomingGeneration]) {
      if (generation && generation !== winnerGeneration) {
        retired.add(generation);
      }
    }
    retired.delete(winnerGeneration);
    existing.providerStates[key] = {
      ...cloneJsonValue(currentState),
      ...cloneJsonValue(winner),
      providerId: key,
      activeGeneration: winnerGeneration,
      retiredGenerations: Array.from(retired).slice(-16),
      lastObservedAt: winner.lastObservedAt || currentState.lastObservedAt || incomingState.lastObservedAt || null,
      lastSequence: winner.lastSequence ?? currentState.lastSequence ?? incomingState.lastSequence ?? null,
      disconnectedAt: winner.disconnectedAt ?? null,
    };
  }
}

/**
 * source消失をtombstone snapshotとして記録する。
 *
 * @private
 * @function createTombstoneSnapshot
 * @param {Object} previous - 直前snapshot。
 * @param {Object} options - tombstone生成オプション。
 * @returns {Object} tombstone snapshot。
 */
function createTombstoneSnapshot(previous, options) {
  return {
    ...previous,
    presence: "unobserved",
    selected: null,
    assignments: [],
    lastObservedAt: options.observedAt,
    lastChangedAt: options.observedAt,
    providerId: options.providerId || previous.providerId || null,
    sessionId: options.sessionId || previous.sessionId || null,
    providerGeneration: options.providerGeneration || previous.providerGeneration || null,
    sequence: options.sequence ?? previous.sequence ?? null,
    snapshotCompleteness: "complete",
    tombstoneAt: options.observedAt,
    authority: "observation-only",
  };
}

/**
 * material topologyをatomic batchとして観測ストアへ記録する。
 *
 * 【詳細説明】
 * - すべてのsource snapshotとdiffを先に計算し、最後にdevice recordへ一括commitする。
 * - selected/assignment/remainingは観測証跡として保持するだけで、command authorityやledgerへは接続しない。
 * - complete snapshotで消えたsourceは削除せずtombstone化し、partial snapshotでは前回値を保持する。
 *
 * @function recordMaterialTopologyObservation
 * @param {Object} store - material source観測ストア。
 * @param {Object} options - 観測オプション。
 * @param {string} options.host - 表示host。
 * @param {string} options.deviceId - device ID。
 * @param {string=} options.identityStrength - stable/provisional。
 * @param {string=} options.sessionId - provider/session ID。
 * @param {string=} options.providerId - provider ID。
 * @param {string=} options.providerGeneration - provider世代。
 * @param {number=} options.sequence - 観測sequence。
 * @param {string=} options.observedAt - 観測日時。
 * @param {Object} options.topology - Normalized material topology。
 * @param {string=} options.snapshotCompleteness - complete/partial。
 * @param {Object=} options.limits - change log上限。
 * @returns {Object} 記録結果。
 * @example
 * const result = recordMaterialTopologyObservation(store, { deviceId, topology });
 */
export function recordMaterialTopologyObservation(store, options = {}) {
  const targetStore = ensureObservationStore(store);
  const deviceId = String(options.deviceId || "").trim();
  if (!deviceId) {
    return { accepted: false, reason: "device-id-missing" };
  }
  if (!isValidExplicitObservedAt(options.observedAt)) {
    return { accepted: false, reason: "invalid-observed-at" };
  }
  const observedAt = toIsoDateTimeString(options.observedAt);
  const snapshotCompleteness = options.snapshotCompleteness === "complete" ? "complete" : "partial";
  const existingRecord = targetStore.byDeviceId[deviceId] || null;
  if (existingRecord) {
    const stale = rejectStaleBatch(existingRecord, {
      observedAt,
      providerId: options.providerId || options.topology?.provider?.providerId || null,
      providerGeneration: options.providerGeneration || null,
      sequence: options.sequence ?? null,
    });
    if (stale) {
      return stale;
    }
  }
  const record = ensureDeviceRecord(targetStore, {
    deviceId,
    identityStrength: options.identityStrength || "provisional",
    host: options.host || null,
    observedAt,
  });
  if (!record.eventCoverageStartedAt || !isValidExplicitObservedAt(record.eventCoverageStartedAt)) {
    record.eventCoverageStartedAt = observedAt;
  }

  const topology = options.topology && typeof options.topology === "object" ? options.topology : {};
  const assignments = Array.isArray(topology.assignments) ? topology.assignments : [];
  const assignmentSectionExplicitlyObserved = hasObservedFieldMask(topology.observationMask?.sections)
    && isTopologySectionObserved(topology, "assignments", false);
  const assignmentsObserved = isTopologySectionObserved(topology, "assignments", Array.isArray(topology.assignments));
  const resolvedAssignments = assignmentsObserved
    ? resolveAssignmentsAgainstPreviousSources(assignments, record.latestBySourceId)
    : assignments;
  const nextSnapshots = {};
  const diagnostics = [];
  for (const source of Array.isArray(topology.sources) ? topology.sources : []) {
    const sourceId = resolveSourceId(source);
    if (!sourceId) {
      diagnostics.push({ reason: "source-id-missing", source: cloneJsonValue(source) });
      continue;
    }
    if (nextSnapshots[sourceId]) {
      diagnostics.push({ reason: "duplicate-source-id", sourceId });
      continue;
    }
    nextSnapshots[sourceId] = createSourceSnapshot({
      source,
      assignments: resolvedAssignments,
      deviceId,
      host: options.host || record.host || null,
      identityStrength: options.identityStrength || record.identityStrength || "provisional",
      observedAt,
      providerId: options.providerId || topology.provider?.providerId || null,
      sessionId: options.sessionId || null,
      providerGeneration: options.providerGeneration || null,
      sequence: options.sequence ?? null,
      snapshotCompleteness,
      assignmentsObserved,
      previous: record.latestBySourceId[sourceId] || null,
    });
  }

  if (snapshotCompleteness !== "complete" && assignmentSectionExplicitlyObserved) {
    for (const [sourceId, previous] of Object.entries(record.latestBySourceId || {})) {
      if (nextSnapshots[sourceId]) {
        continue;
      }
      nextSnapshots[sourceId] = createSourceSnapshot({
        source: { sourceId },
        assignments: resolvedAssignments,
        deviceId,
        host: options.host || record.host || null,
        identityStrength: options.identityStrength || record.identityStrength || "provisional",
        observedAt,
        providerId: options.providerId || topology.provider?.providerId || null,
        sessionId: options.sessionId || null,
        providerGeneration: options.providerGeneration || null,
        sequence: options.sequence ?? null,
        snapshotCompleteness,
        assignmentsObserved,
        previous,
      });
    }
  }

  if (snapshotCompleteness === "complete") {
    for (const [sourceId, previous] of Object.entries(record.latestBySourceId || {})) {
      if (!nextSnapshots[sourceId]) {
        nextSnapshots[sourceId] = createTombstoneSnapshot(previous, {
          observedAt,
          providerId: options.providerId || topology.provider?.providerId || null,
          sessionId: options.sessionId || null,
          providerGeneration: options.providerGeneration || null,
          sequence: options.sequence ?? null,
        });
      }
    }
  }

  const nextRevision = Number(record.observationRevision || 0) + 1;
  const changes = [];
  const previousProviderDisconnectedAt = record.providerDisconnectedAt || null;
  const previousProviderGeneration = record.providerGeneration ? String(record.providerGeneration) : null;
  const nextProviderId = options.providerId || topology.provider?.providerId || record.providerId || null;
  const nextProviderGeneration = options.providerGeneration ? String(options.providerGeneration) : null;
  const nextProviderDisconnectedAt = topology.cfs?.topologyState === "stale"
    ? (topology.provider?.disconnectedAt || observedAt)
    : null;
  if (previousProviderGeneration && nextProviderGeneration && previousProviderGeneration !== nextProviderGeneration) {
    changes.push(createSourceChangeEvent({
      deviceId,
      sourceId: null,
      observedAt,
      changeKind: "provider-generation-changed",
      before: { providerGeneration: previousProviderGeneration },
      after: { providerGeneration: nextProviderGeneration },
      revision: nextRevision,
      sessionId: options.sessionId || null,
      providerId: nextProviderId,
      providerGeneration: nextProviderGeneration,
      sequence: options.sequence ?? null,
    }));
  }
  if ((!previousProviderDisconnectedAt && nextProviderDisconnectedAt) ||
      (previousProviderDisconnectedAt && !nextProviderDisconnectedAt)) {
    changes.push(createSourceChangeEvent({
      deviceId,
      sourceId: null,
      observedAt,
      changeKind: nextProviderDisconnectedAt ? "provider-disconnected" : "provider-reconnected",
      before: { providerDisconnectedAt: previousProviderDisconnectedAt },
      after: { providerDisconnectedAt: nextProviderDisconnectedAt },
      revision: nextRevision,
      sessionId: options.sessionId || null,
      providerId: nextProviderId,
      providerGeneration: nextProviderGeneration,
      sequence: options.sequence ?? null,
    }));
  }
  for (const [sourceId, snapshot] of Object.entries(nextSnapshots)) {
    const previous = record.latestBySourceId[sourceId] || null;
    const previousSignature = previous ? createSemanticSignature(previous) : null;
    const nextSignature = createSemanticSignature(snapshot);
    if (!previous) {
      changes.push(createSourceChangeEvent({
        deviceId,
        sourceId,
        observedAt,
        changeKind: "source-observed",
        before: null,
        after: snapshot,
        revision: nextRevision,
        sessionId: options.sessionId || null,
        providerId: options.providerId || topology.provider?.providerId || null,
        providerGeneration: options.providerGeneration || null,
        sequence: options.sequence ?? null,
      }));
    } else if (previousSignature !== nextSignature) {
      changes.push(createSourceChangeEvent({
        deviceId,
        sourceId,
        observedAt,
        changeKind: snapshot.tombstoneAt ? "source-disappeared" : "source-changed",
        before: previous,
        after: snapshot,
        revision: nextRevision,
        sessionId: options.sessionId || null,
        providerId: options.providerId || topology.provider?.providerId || null,
        providerGeneration: options.providerGeneration || null,
        sequence: options.sequence ?? null,
      }));
      snapshot.lastChangedAt = observedAt;
    } else {
      snapshot.lastChangedAt = previous.lastChangedAt || observedAt;
    }
  }

  record.latestBySourceId = {
    ...(snapshotCompleteness === "partial" ? record.latestBySourceId : {}),
    ...nextSnapshots,
  };
  record.observationRevision = nextRevision;
  record.lastObservedAt = observedAt;
  if (changes.length > 0) {
    record.lastChangedAt = observedAt;
  }
  record.providerId = nextProviderId;
  record.sessionId = options.sessionId || record.sessionId || null;
  updateProviderGenerationLifecycle(record, record.providerId, options.providerGeneration || null);
  record.lastSequence = options.sequence ?? record.lastSequence ?? null;
  record.providerDisconnectedAt = nextProviderDisconnectedAt;
  if (record.providerId && record.providerStates?.[record.providerId]) {
    record.providerStates[record.providerId].lastObservedAt = observedAt;
    record.providerStates[record.providerId].lastSequence = record.lastSequence;
    record.providerStates[record.providerId].disconnectedAt = record.providerDisconnectedAt;
  }
  record.restoredFromStorage = false;
  record.restoredAt = null;
  record.snapshotCompleteness = snapshotCompleteness;
  record.diagnostics = diagnostics;
  record.events.push(...changes);
  trimDeviceEvents(record, options.limits || {});

  return {
    accepted: true,
    reason: changes.length > 0 ? "changed" : "observed",
    store: targetStore,
    record,
    changes,
  };
}

/**
 * provisional device観測をstable device IDへ安全に昇格する。
 *
 * 【詳細説明】
 * - identity conflict中は自動mergeしない。
 * - rekey時はsource snapshot/eventを保持し、旧IDをaliasとして残す。
 *
 * @function rekeyMaterialSourceObservationDevice
 * @param {Object} store - material source観測ストア。
 * @param {Object} options - rekeyオプション。
 * @param {string} options.fromDeviceId - 旧device ID。
 * @param {string} options.toDeviceId - 新device ID。
 * @param {string=} options.observedAt - rekey日時。
 * @param {boolean=} options.mergeIfTargetExists - 移行先recordが存在する場合に明示mergeするならtrue。
 * @param {boolean=} options.identityConflict - identity conflict中ならtrue。
 * @returns {Object} rekey結果。
 * @example
 * rekeyMaterialSourceObservationDevice(store, { fromDeviceId, toDeviceId });
 */
export function rekeyMaterialSourceObservationDevice(store, options = {}) {
  const targetStore = ensureObservationStore(store);
  const fromDeviceId = String(options.fromDeviceId || "").trim();
  const toDeviceId = String(options.toDeviceId || "").trim();
  if (!fromDeviceId || !toDeviceId) {
    return { accepted: false, reason: "device-id-missing" };
  }
  if (options.identityConflict === true) {
    return { accepted: false, reason: "identity-conflict" };
  }
  if (fromDeviceId === toDeviceId) {
    const same = targetStore.byDeviceId[toDeviceId] || null;
    return { accepted: true, reason: "same-device-id", record: same };
  }
  const from = targetStore.byDeviceId[fromDeviceId];
  if (!from) {
    return { accepted: false, reason: "source-device-missing" };
  }
  const observedAt = toIsoDateTimeString(options.observedAt);
  const existing = targetStore.byDeviceId[toDeviceId];
  if (existing && existing !== from) {
    if (options.mergeIfTargetExists !== true) {
      return { accepted: false, reason: "target-device-exists" };
    }
    const mergedSourceIds = [];
    const skippedSourceIds = [];
    const conflictSourceIds = [];
    if (!existing.latestBySourceId || typeof existing.latestBySourceId !== "object" || Array.isArray(existing.latestBySourceId)) {
      existing.latestBySourceId = {};
    }
    const conflictEvents = [];
    for (const [sourceId, snapshot] of Object.entries(from.latestBySourceId || {})) {
      const existingSnapshot = existing.latestBySourceId[sourceId] || null;
      if (existingSnapshot) {
        const mergeAction = classifySourceMerge(existingSnapshot, snapshot);
        if (mergeAction === "replace") {
          existing.latestBySourceId[sourceId] = {
            ...cloneJsonValue(snapshot),
            deviceId: toDeviceId,
            identityStrength: "stable",
          };
          mergedSourceIds.push(sourceId);
          continue;
        }
        skippedSourceIds.push(sourceId);
        if (mergeAction === "conflict") {
          conflictSourceIds.push(sourceId);
          conflictEvents.push(createSourceChangeEvent({
            deviceId: toDeviceId,
            sourceId,
            observedAt,
            changeKind: "source-merge-conflict",
            before: existingSnapshot,
            after: {
              incoming: {
                ...cloneJsonValue(snapshot),
                deviceId: toDeviceId,
                identityStrength: "stable",
              },
            },
            revision: Number(existing.observationRevision || 0) + 1,
            sessionId: existing.sessionId || from.sessionId || null,
            providerId: existing.providerId || from.providerId || null,
            providerGeneration: existing.providerGeneration || from.providerGeneration || null,
            sequence: existing.lastSequence ?? from.lastSequence ?? null,
          }));
        }
        continue;
      }
      existing.latestBySourceId[sourceId] = {
        ...cloneJsonValue(snapshot),
        deviceId: toDeviceId,
        identityStrength: "stable",
      };
      mergedSourceIds.push(sourceId);
    }
    const revision = Number(existing.observationRevision || 0) + 1;
    existing.observationRevision = revision;
    existing.identityStrength = "stable";
    existing.aliases = [...new Set([
      ...(Array.isArray(existing.aliases) ? existing.aliases : []),
      fromDeviceId,
      ...(Array.isArray(from.aliases) ? from.aliases : []),
    ])];
    existing.host = existing.host || from.host || null;
    existing.firstObservedAt = existing.firstObservedAt || from.firstObservedAt || observedAt;
    existing.lastObservedAt = [existing.lastObservedAt, from.lastObservedAt]
      .filter(Boolean)
      .sort()
      .at(-1) || observedAt;
    existing.lastChangedAt = observedAt;
    existing.providerId = existing.providerId || from.providerId || null;
    existing.sessionId = existing.sessionId || from.sessionId || null;
    existing.providerGeneration = existing.providerGeneration || from.providerGeneration || null;
    mergeProviderStatesForRekey(existing, from);
    existing.retiredProviderGenerations = [...new Set([
      ...(Array.isArray(existing.retiredProviderGenerations) ? existing.retiredProviderGenerations : []),
      ...(Array.isArray(from.retiredProviderGenerations) ? from.retiredProviderGenerations : []),
      ...Object.values(existing.providerStates || {})
        .flatMap((providerState) => Array.isArray(providerState?.retiredGenerations) ? providerState.retiredGenerations : []),
    ])].slice(-16);
    const importedEvents = Array.isArray(from.events)
      ? from.events.map((event) => ({
          ...cloneJsonValue(event),
          canonicalDeviceId: toDeviceId,
        }))
      : [];
    existing.events = [
      ...(Array.isArray(existing.events) ? existing.events : []),
      ...importedEvents,
      ...conflictEvents,
      createSourceChangeEvent({
        deviceId: toDeviceId,
        sourceId: null,
        observedAt,
        changeKind: "device-merged",
        before: { deviceId: fromDeviceId },
        after: { deviceId: toDeviceId, mergedSourceIds, skippedSourceIds, conflictSourceIds },
        revision,
        sessionId: existing.sessionId || null,
        providerId: existing.providerId || null,
        providerGeneration: existing.providerGeneration || null,
        sequence: existing.lastSequence ?? null,
      }),
    ];
    trimDeviceEvents(existing, options.limits || {});
    delete targetStore.byDeviceId[fromDeviceId];
    return { accepted: true, reason: "merged", record: existing, mergedSourceIds, skippedSourceIds, conflictSourceIds };
  }
  delete targetStore.byDeviceId[fromDeviceId];
  from.deviceId = toDeviceId;
  from.identityStrength = "stable";
  from.aliases = [...new Set([...(Array.isArray(from.aliases) ? from.aliases : []), fromDeviceId])];
  from.updatedAt = observedAt;
  from.lastChangedAt = observedAt;
  for (const snapshot of Object.values(from.latestBySourceId || {})) {
    snapshot.deviceId = toDeviceId;
    snapshot.identityStrength = "stable";
  }
  const revision = Number(from.observationRevision || 0) + 1;
  from.observationRevision = revision;
  from.events.push(createSourceChangeEvent({
    deviceId: toDeviceId,
    sourceId: null,
    observedAt,
    changeKind: "device-rekeyed",
    before: { deviceId: fromDeviceId },
    after: { deviceId: toDeviceId },
    revision,
    sessionId: from.sessionId || null,
    providerId: from.providerId || null,
    providerGeneration: from.providerGeneration || null,
    sequence: from.lastSequence ?? null,
  }));
  trimDeviceEvents(from, options.limits || {});
  targetStore.byDeviceId[toDeviceId] = from;
  return { accepted: true, reason: "rekeyed", record: from };
}

/**
 * 保存snapshotから現在のfresh/stale表示状態を導出する。
 *
 * 【詳細説明】
 * - freshnessは保存された固定値ではなく、現在時刻・TTL・provider切断時刻から導出する。
 * - 復元済みの過去snapshotはproviderDisconnectedAtが無くてもTTL経過でstaleになる。
 *
 * @function deriveMaterialSourceObservationFreshness
 * @param {Object|null|undefined} record - device観測レコード。
 * @param {Object=} options - 導出オプション。
 * @param {string|Date=} options.now - 現在時刻。
 * @param {number=} options.freshTtlMs - fresh扱いするTTL。
 * @returns {Object} freshness表示状態。
 * @example
 * const freshness = deriveMaterialSourceObservationFreshness(record, { freshTtlMs: 60000 });
 */
export function deriveMaterialSourceObservationFreshness(record, options = {}) {
  if (!record || typeof record !== "object") {
    return { state: "unobserved", reason: "record-missing", ageMs: null };
  }
  if (record.providerDisconnectedAt) {
    return { state: "stale", reason: "provider-disconnected", ageMs: null };
  }
  if (record.restoredFromStorage === true) {
    return { state: "stale", reason: "restored-last-known", ageMs: null };
  }
  const nowMs = new Date(options.now || Date.now()).getTime();
  const observedMs = new Date(record.lastObservedAt || 0).getTime();
  const ageMs = Number.isFinite(nowMs) && Number.isFinite(observedMs) ? Math.max(0, nowMs - observedMs) : null;
  const ttl = Math.max(1, Math.floor(toFiniteNumber(options.freshTtlMs, 60_000) ?? 60_000));
  if (ageMs === null) {
    return { state: "unknown", reason: "invalid-time", ageMs: null };
  }
  if (ageMs > ttl) {
    return { state: "stale", reason: "ttl-expired", ageMs };
  }
  return { state: "fresh", reason: "within-ttl", ageMs };
}
