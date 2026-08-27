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
 * - {@link recordMaterialTopologyObservation}：material topologyをatomic batchとして観測ストアへ反映
 * - {@link rekeyMaterialSourceObservationDevice}：provisional device観測をstable device IDへ安全に昇格
 * - {@link deriveMaterialSourceObservationFreshness}：保存snapshotから現在のfresh/stale表示状態を導出
 *
 * @version 1.390.1422 (PR #435)
 * @since   1.390.1422 (PR #435)
 * @lastModified 2026-08-27 22:50:33
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
      lastObservedAt: options.observedAt,
      lastChangedAt: options.observedAt,
      providerId: null,
      sessionId: null,
      providerGeneration: null,
      lastSequence: null,
      providerDisconnectedAt: null,
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
  const explicit = String(source?.sourceId || "").trim();
  if (explicit) {
    return explicit;
  }
  const kind = String(source?.kind || "").trim();
  const slotId = toFiniteNumber(source?.slotId, 0);
  if (kind === "external-spool") {
    return `external:${slotId ?? 0}`;
  }
  if (kind === "cfs-slot") {
    const boxId = toFiniteNumber(source?.boxId, toFiniteNumber(source?.unitIndex, 0));
    return `cfs:${boxId ?? 0}:slot:${slotId ?? 0}`;
  }
  return null;
}

/**
 * material sourceの装填状態を保守的に導出する。
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
  const stateCode = toFiniteNumber(source.status?.stateCode);
  const material = source.material && typeof source.material === "object" ? source.material : {};
  const color = material.color && typeof material.color === "object" ? material.color : {};
  const hasMaterialEvidence = Boolean(
    String(material.vendor || "").trim() ||
    String(material.type || "").trim() ||
    String(material.name || "").trim() ||
    String(color.normalized ?? color.raw ?? "").trim() ||
    material.rfid !== null && material.rfid !== undefined && String(material.rfid).trim() !== ""
  );
  if (stateCode === 0 && !hasMaterialEvidence) {
    return "empty";
  }
  if (stateCode === null && !hasMaterialEvidence) {
    return "unknown";
  }
  return "loaded";
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
  return {
    sourceId,
    deviceId: options.deviceId,
    host: options.host || null,
    identityStrength: options.identityStrength || "provisional",
    kind: options.source?.kind || "unknown",
    unitId: options.source?.unitId ?? null,
    boxId: options.source?.boxId ?? null,
    slotId: options.source?.slotId ?? null,
    protocolSlotId: options.source?.slotId ?? null,
    presence: derivePresence(options.source),
    selected: options.source?.status?.selected === undefined || options.source?.status?.selected === null
      ? null
      : options.source.status.selected === true || Number(options.source.status.selected) === 1,
    material: normalizeMaterialEvidence(options.source),
    remaining: normalizeRemainingEvidence(options.source),
    status: {
      stateCode: toFiniteNumber(options.source?.status?.stateCode),
      editStatusCode: toFiniteNumber(options.source?.status?.editStatusCode),
      scrap: toFiniteNumber(options.source?.status?.scrap),
    },
    assignments: normalizeAssignmentsForSource(options.assignments, sourceId),
    firstObservedAt: options.previous?.firstObservedAt || options.observedAt,
    lastObservedAt: options.observedAt,
    lastChangedAt: options.previous?.lastChangedAt || options.observedAt,
    providerId: options.providerId || null,
    sessionId: options.sessionId || null,
    providerGeneration: options.providerGeneration || null,
    sequence: options.sequence ?? null,
    snapshotCompleteness: options.snapshotCompleteness || "partial",
    authority: "observation-only",
  };
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
    selected: snapshot.selected,
    material: snapshot.material,
    remaining: snapshot.remaining,
    status: snapshot.status,
    assignments: snapshot.assignments,
    authority: snapshot.authority,
  });
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
  const sourceCounts = new Map();
  const keepBySource = [];
  for (let index = record.events.length - 1; index >= 0; index -= 1) {
    const event = record.events[index];
    const sourceId = event?.sourceId || "__device__";
    const count = sourceCounts.get(sourceId) || 0;
    if (count < maxPerSource) {
      keepBySource.push(event);
      sourceCounts.set(sourceId, count + 1);
    }
  }
  keepBySource.reverse();
  record.events = keepBySource.slice(Math.max(0, keepBySource.length - maxPerDevice));
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
  if (!record.lastObservedAt) {
    return null;
  }
  const nextTime = new Date(options.observedAt).getTime();
  const prevTime = new Date(record.lastObservedAt).getTime();
  if (Number.isFinite(nextTime) && Number.isFinite(prevTime) && nextTime < prevTime) {
    if (record.providerGeneration && options.providerGeneration && record.providerGeneration !== options.providerGeneration) {
      return { accepted: false, reason: "stale-provider-generation", record };
    }
    return { accepted: false, reason: "stale-observation", record };
  }
  if (record.providerGeneration && options.providerGeneration && record.providerGeneration === options.providerGeneration) {
    const previousSequence = toFiniteNumber(record.lastSequence);
    const nextSequence = toFiniteNumber(options.sequence);
    if (previousSequence !== null && nextSequence !== null && nextSequence < previousSequence) {
      return { accepted: false, reason: "stale-sequence", record };
    }
  }
  return null;
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
  const observedAt = toIsoDateTimeString(options.observedAt);
  const snapshotCompleteness = options.snapshotCompleteness === "complete" ? "complete" : "partial";
  const record = ensureDeviceRecord(targetStore, {
    deviceId,
    identityStrength: options.identityStrength || "provisional",
    host: options.host || null,
    observedAt,
  });
  const stale = rejectStaleBatch(record, {
    observedAt,
    providerGeneration: options.providerGeneration || null,
    sequence: options.sequence ?? null,
  });
  if (stale) {
    return stale;
  }

  const topology = options.topology && typeof options.topology === "object" ? options.topology : {};
  const assignments = Array.isArray(topology.assignments) ? topology.assignments : [];
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
      assignments,
      deviceId,
      host: options.host || record.host || null,
      identityStrength: options.identityStrength || record.identityStrength || "provisional",
      observedAt,
      providerId: options.providerId || topology.provider?.providerId || null,
      sessionId: options.sessionId || null,
      providerGeneration: options.providerGeneration || null,
      sequence: options.sequence ?? null,
      snapshotCompleteness,
      previous: record.latestBySourceId[sourceId] || null,
    });
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
  record.providerId = options.providerId || topology.provider?.providerId || record.providerId || null;
  record.sessionId = options.sessionId || record.sessionId || null;
  record.providerGeneration = options.providerGeneration || record.providerGeneration || null;
  record.lastSequence = options.sequence ?? record.lastSequence ?? null;
  record.providerDisconnectedAt = topology.cfs?.topologyState === "stale"
    ? (topology.provider?.disconnectedAt || observedAt)
    : null;
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
    return { accepted: false, reason: "target-device-exists" };
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
