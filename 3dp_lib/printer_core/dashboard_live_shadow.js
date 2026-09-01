/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 live shadow モジュール
 * @file dashboard_live_shadow.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_live_shadow
 *
 * 【機能内容サマリ】
 * - K1/K2 系 live WebSocket 受信を Printer Core v3 へ shadow 入力する
 * - 既存 processData() 後の storedData と NormalizedPrinterState を runtime differential として比較
 * - K2 Pro Combo + CFS の read-only 観測結果を runtimeData に保持
 * - UI authority / command path を変更せず、CFS material source 観測だけを read-only 台帳へ蓄積
 *
 * 【公開関数一覧】
 * - {@link createPrinterCoreV3ShadowSessionId}：WebSocket 接続ごとの shadow session ID を生成
 * - {@link beginK1LiveShadowSession}：K1 live shadow session を開始
 * - {@link beginK2LiveShadowSession}：K2 live shadow session を開始
 * - {@link observeK1LiveShadowFrame}：K1 live frame を v3 state へ反映し legacy differential を記録
 * - {@link observeK2LiveShadowFrame}：K2 live frame を v3 state へ反映し material topology を記録
 * - {@link observeMoonrakerCfsMaterialProviderFrame}：K1C/CFS-C secondary provider frame を material topology へ反映
 * - {@link endK1LiveShadowSession}：K1 live shadow session を終了
 * - {@link endK2LiveShadowSession}：K2 live shadow session を終了
 *
 * @version 1.390.1621 (PR #440)
 * @since   1.390.1299 (PR #432)
 * @lastModified 2026-09-02 02:24:00
 * -----------------------------------------------------------
 * @todo
 * - K2 Pro Combo 実機で CFS disconnect/reconnect の到着順を検証する
 */

"use strict";

import { monitorData } from "../dashboard_data.js";
import {
  PRINTER_FACADE_ERROR_CODES,
  createK1PrinterFacade,
  createK2PrinterFacade,
} from "./dashboard_printer_facade.js";
import {
  createCfsMoonrakerBoxMaterialProvider,
} from "./dashboard_material_provider.js";
import {
  createEmptyMaterialSourceObservations,
  recordMaterialTopologyObservation,
  rekeyMaterialSourceObservationDevice,
} from "./dashboard_material_source_observation.js";

/**
 * live shadow runtime record の schema version。
 *
 * 【詳細説明】
 * - runtimeData 上の揮発 record であり、Data Schema v3 の永続 schema version ではない。
 *
 * @constant {number}
 */
export const PRINTER_CORE_V3_LIVE_SHADOW_SCHEMA_VERSION = 1;

/**
 * K2 CFS物理操作前に使えるprinter idle観測証跡の有効期限。
 *
 * 【詳細説明】
 * - panel側のsend-time context TTLとは別に、status frame自体の鮮度を保証するための短い期限。
 *
 * @constant {number}
 */
const K2_PRINTER_IDLE_OBSERVATION_TTL_MS = 5000;

/**
 * K1 live shadow 用の共有 Facade。
 *
 * 【詳細説明】
 * - 状態は Facade 内の PrinterInstance が deviceId ごとに保持する。
 * - Adapter 自体は stateless に扱い、1台ごとの protocol state は Instance に閉じ込める。
 *
 * @constant {object}
 */
const k1LiveShadowFacade = createK1PrinterFacade();

/**
 * K2 live shadow 用の共有 Facade。
 *
 * 【詳細説明】
 * - K2 Pro Combo + CFS は read-only Adapter として扱い、material topology を runtimeData にだけ保持する。
 * - 送信 authority や filament ledger 書き込みには接続しない。
 *
 * @constant {object}
 */
const k2LiveShadowFacade = createK2PrinterFacade();

/**
 * K1C/CFS-C secondary material provider。
 *
 * 【詳細説明】
 * - K1本体のWebSocket identity/sessionとは分け、Moonraker由来のCFS-C boxsInfoだけを
 *   read-only material topologyとしてruntimeDataへ合流させる。
 *
 * @constant {object}
 */
const cfsMoonrakerMaterialProvider = createCfsMoonrakerBoxMaterialProvider();

/**
 * 同一 diff path の console warning を再出力する最短間隔。
 *
 * 【詳細説明】
 * - runtimeData は全 frame で更新するが、恒常的な差分で DevTools console が埋まらないようにする。
 *
 * @constant {number}
 */
const SHADOW_DIFF_WARN_INTERVAL_MS = 10_000;

/**
 * object が持つ key を安全に判定する。
 *
 * 【詳細説明】
 * - storedData には null や undefined が入り得るため、truthy 判定ではなく own property を見る。
 *
 * @private
 * @param {object|null|undefined} value - 検査対象
 * @param {string} key - 検査 key
 * @returns {boolean} key を own property として持つ場合 true
 */
function hasOwn(value, key) {
  return !!value && Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * ISO時刻文字列をepoch millisecondsへ正規化する。
 *
 * 【詳細説明】
 * - status freshnessで不正時刻を安全側へ倒すため、parse失敗時はnullを返す。
 *
 * @private
 * @function parseIsoEpochMs
 * @param {*} value - ISO時刻候補
 * @returns {number|null} epoch ms、または不正時null
 */
function parseIsoEpochMs(value) {
  const ms = Date.parse(String(value || "").trim());
  return Number.isFinite(ms) ? ms : null;
}

/**
 * K2 print state labelがCFS物理操作前のidle候補か判定する。
 *
 * 【詳細説明】
 * - `completed` はジョブ完了を示しても物理操作可能な待機状態を保証しないため含めない。
 *
 * @private
 * @function isK2CfsSafeIdleLabel
 * @param {*} value - print state label候補
 * @returns {boolean} idle/ready/standbyならtrue
 */
function isK2CfsSafeIdleLabel(value) {
  return ["idle", "ready", "standby"].includes(String(value || "").trim().toLowerCase());
}

/**
 * K2 raw frameがprinter status scalarを含むか判定する。
 *
 * 【詳細説明】
 * - boxsInfoだけのframeでprinter idle証跡を延命しないため、CFS物理操作に関係するstatus keyだけを見る。
 *
 * @private
 * @function hasK2PrinterStatusScalarFrame
 * @param {object|null|undefined} frame - K2 raw frame
 * @returns {boolean} printer status scalarを含む場合true
 */
function hasK2PrinterStatusScalarFrame(frame) {
  if (!frame || typeof frame !== "object") {
    return false;
  }
  return [
    "state",
    "deviceState",
    "printProgress",
    "dProgress",
    "printJobTime",
    "printLeftTime",
    "nozzleTemp",
    "bedTemp0",
    "targetNozzleTemp",
    "targetBedTemp0",
    "printFileName",
    "fileName",
    "printId",
  ].some((key) => hasOwn(frame, key));
}

/**
 * K2 print patchからCFS物理操作用printer idle証跡を生成する。
 *
 * 【詳細説明】
 * - complete status frameはそのまま`observed`証跡にする。
 * - delta-only / partial frameは、直前に同一session/generationのcomplete baselineがあり、sequenceが前進した場合だけ
 *   `assembled`として扱う。baselineが無いdeltaはidle authorityへ昇格しない。
 *
 * @private
 * @function createK2PrinterIdleObservationForShadow
 * @param {object} options - 生成オプション
 * @param {object|null|undefined} options.previousRecord - 直前shadow record
 * @param {object|null|undefined} options.lastState - Facade累積後のNormalizedState
 * @param {string} options.sessionId - shadow session ID
 * @param {number|null} options.connectionGeneration - WebSocket接続世代
 * @param {string} options.observedAt - status frame受信時刻
 * @param {number|null} options.sequence - current sequence
 * @returns {object|null} printer idle観測証跡
 */
function createK2PrinterIdleObservationForShadow(options) {
  const print = options.lastState?.print;
  if (!print || typeof print !== "object") {
    return null;
  }
  const observedAtMs = parseIsoEpochMs(options.observedAt);
  if (observedAtMs === null) {
    return null;
  }
  const snapshotCompleteness = String(print.snapshotCompleteness || "").trim().toLowerCase();
  const activityState = String(print.activityState || "").trim().toLowerCase();
  const coreStateComplete = print.coreStateComplete === true;
  const connectionGeneration = Number.isFinite(Number(options.connectionGeneration))
    ? Number(options.connectionGeneration)
    : null;
  const sequence = Number.isFinite(Number(options.sequence)) ? Number(options.sequence) : null;
  const expiresAtMs = observedAtMs + K2_PRINTER_IDLE_OBSERVATION_TTL_MS;
  const base = {
    activityState: activityState || "unknown",
    coreStateComplete,
    snapshotCompleteness: snapshotCompleteness || "unknown",
    observedAt: options.observedAt,
    receivedAt: options.observedAt,
    expiresAt: new Date(expiresAtMs).toISOString(),
    sessionId: options.sessionId || null,
    connectionGeneration,
    baselineSequence: sequence,
    lastAppliedSequence: sequence,
    appliedDeltaCount: 0,
    fresh: true,
    idle: isK2CfsSafeIdleLabel(print.stateLabel || print.state) && activityState === "idle" && coreStateComplete,
  };
  if (snapshotCompleteness === "complete" && coreStateComplete) {
    return {
      ...base,
      status: "observed",
    };
  }

  const previous = options.previousRecord?.printerIdleObservation;
  const previousComplete = previous &&
    ["observed", "assembled"].includes(String(previous.status || "").toLowerCase()) &&
    previous.coreStateComplete === true &&
    String(previous.sessionId || "") === String(options.sessionId || "") &&
    Number(previous.connectionGeneration) === connectionGeneration;
  const orderedDelta = sequence !== null &&
    Number.isFinite(Number(previous?.lastAppliedSequence)) &&
    sequence > Number(previous.lastAppliedSequence);
  if (!previousComplete || !orderedDelta) {
    return {
      ...base,
      status: "partial",
      baselineSequence: previous?.baselineSequence ?? null,
      appliedDeltaCount: 0,
      fresh: false,
      idle: false,
    };
  }

  const partialShowsActive = activityState === "active" ||
    activityState === "active-without-core-state" ||
    ["printing", "paused", "busy", "heating", "checking", "running"].includes(String(print.stateLabel || print.state || "").toLowerCase());
  return {
    ...base,
    status: "assembled",
    activityState: partialShowsActive ? "active" : (previous.activityState || "idle"),
    coreStateComplete: true,
    snapshotCompleteness: "complete",
    baselineSequence: previous.baselineSequence ?? previous.lastAppliedSequence ?? sequence,
    appliedDeltaCount: Number(previous.appliedDeltaCount || 0) + 1,
    idle: partialShowsActive ? false : previous.idle === true,
  };
}

/**
 * material topology更新をUIへ通知する。
 *
 * 【詳細説明】
 * - フィラメントパネルがlegacy cardで起動したあとにCFS topologyが遅れて到着した場合、
 *   パネル側が同じDOM内でmulti-slotへ切り替えるための軽量イベント。
 * - Node/Vitest環境ではDOMが無い場合があるため、dispatch不可なら静かに無視する。
 *
 * @private
 * @param {string} host - 更新対象ホスト名
 * @returns {void}
 */
function emitMaterialTopologyUpdated(host) {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") {
    return;
  }
  try {
    const event = typeof CustomEvent === "function"
      ? new CustomEvent("printer-core-v3-material-topology-updated", { detail: { host } })
      : Object.assign(new Event("printer-core-v3-material-topology-updated"), { detail: { host } });
    window.dispatchEvent(event);
  } catch {
    /* UI通知は補助経路のため、古い環境で失敗してもshadow本体は継続する。 */
  }
}

/**
 * material topologyを表示用にstale化する。
 *
 * 【詳細説明】
 * - provider切断やtransport終了は「新しい空topologyの観測」ではなく、
 *   「最後に観測したtopologyの鮮度低下」として扱う。
 *
 * @private
 * @param {object|null|undefined} topology - 直前のmaterial topology
 * @param {string|null} disconnectedAt - provider切断を観測した日時ISO文字列
 * @param {string|null} lastObservedAt - 最後にmaterial payloadを観測した日時ISO文字列
 * @returns {object|null} stale化したtopology、元topologyが無ければ null
 */
function markMaterialTopologyStale(topology, disconnectedAt = null, lastObservedAt = null) {
  if (!topology || typeof topology !== "object") {
    return null;
  }
  return {
    ...topology,
    cfs: {
      ...(topology.cfs || {}),
      connected: false,
      topologyState: "stale",
    },
    provider: {
      ...(topology.provider || {}),
      freshness: "stale",
      lastObservedAt: topology.provider?.lastObservedAt ?? lastObservedAt,
      disconnectedAt,
    },
  };
}

/**
 * JSON化可能な値をcloneする。
 *
 * @private
 * @function cloneJsonValue
 * @param {*} value - clone対象
 * @returns {*} clone結果
 */
function cloneJsonValue(value) {
  if (value === null || value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * observedFields maskが明示されているか判定する。
 *
 * @private
 * @function hasObservedFieldMask
 * @param {*} mask - observedFields候補
 * @returns {boolean} mask objectならtrue
 */
function hasObservedFieldMask(mask) {
  return Boolean(mask && typeof mask === "object" && !Array.isArray(mask));
}

/**
 * mask内のfieldが観測済みかを返す。
 *
 * @private
 * @function isMaskedFieldObserved
 * @param {*} mask - field mask object
 * @param {string} fieldName - field名
 * @param {boolean} fallback - maskが無い場合の判定
 * @returns {boolean} 観測済みならtrue
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
 * @param {*} mask - field mask object
 * @param {boolean} fallback - maskが無い場合の判定
 * @returns {boolean} いずれかのfieldが観測済みならtrue
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
 * @param {Object} topology - Normalized material topology
 * @param {string} sectionName - section名
 * @param {boolean} fallback - maskが無い場合の判定
 * @returns {boolean} sectionが観測済みならtrue
 */
function isTopologySectionObserved(topology, sectionName, fallback) {
  const sections = topology?.observationMask?.sections;
  if (!hasObservedFieldMask(sections)) {
    return fallback;
  }
  return sections[sectionName] === true;
}

/**
 * 既存runtime sourceからbox/slot参照indexを生成する。
 *
 * @private
 * @function createRuntimeSourceLocationIndex
 * @param {Map<string,Object>} sourceMap - 既存source map
 * @returns {Map<string,string>} `boxId:slotId` からsourceIdへのindex
 */
function createRuntimeSourceLocationIndex(sourceMap) {
  const index = new Map();
  for (const [sourceId, source] of sourceMap.entries()) {
    const boxId = source?.boxId ?? null;
    const slotId = source?.slotId ?? source?.protocolSlotId ?? null;
    if (sourceId && boxId !== null && boxId !== undefined && slotId !== null && slotId !== undefined) {
      index.set(`${boxId}:${slotId}`, sourceId);
    }
  }
  return index;
}

/**
 * incoming assignmentを既存runtime sourceへ解決する。
 *
 * 【詳細説明】
 * - `colorMatch` だけのpartial deltaではincoming sourcesが空になるため、前回runtime topologyの
 *   box/slot locationからsourceIdを補完する。
 *
 * @private
 * @function resolveRuntimeAssignments
 * @param {Array<Object>} assignments - incoming assignment list
 * @param {Map<string,Object>} sourceMap - 既存source map
 * @returns {Array<Object>} sourceId補完済みassignment list
 */
function resolveRuntimeAssignments(assignments, sourceMap) {
  const locationIndex = createRuntimeSourceLocationIndex(sourceMap);
  return (Array.isArray(assignments) ? assignments : []).map((assignment) => {
    if (assignment?.sourceId) {
      return cloneJsonValue(assignment);
    }
    const boxId = assignment?.boxId ?? null;
    const slotId = assignment?.slotId ?? assignment?.protocolSlotId ?? null;
    const sourceId = boxId !== null && boxId !== undefined && slotId !== null && slotId !== undefined
      ? locationIndex.get(`${boxId}:${slotId}`) || null
      : null;
    return {
      ...cloneJsonValue(assignment),
      sourceId,
      resolution: sourceId ? "resolved-from-previous-runtime-source" : (assignment?.resolution || "unresolved"),
    };
  });
}

/**
 * 1つのruntime material sourceをobservedFieldsに従ってmergeする。
 *
 * 【詳細説明】
 * - incoming normalized sourceには未観測fieldがnullとして存在することがあるため、maskがある場合は
 *   field単位で前回値を保持する。
 *
 * @private
 * @function mergeRuntimeMaterialSource
 * @param {Object|null} previous - 直前source
 * @param {Object} incoming - incoming source
 * @returns {Object} merge済みsource
 */
function mergeRuntimeMaterialSource(previous, incoming) {
  if (!previous || !incoming || typeof incoming !== "object") {
    return incoming;
  }
  const observedFields = incoming.observedFields && typeof incoming.observedFields === "object" ? incoming.observedFields : null;
  const materialMask = observedFields?.material;
  const statusMask = observedFields?.status;
  const materialObserved = hasAnyMaskedFieldObserved(materialMask, hasOwn(incoming, "material"));
  const stateCodeObserved = isMaskedFieldObserved(statusMask, "stateCode", hasOwn(incoming.status, "stateCode"));
  const merged = {
    ...cloneJsonValue(previous),
    ...cloneJsonValue(incoming),
    material: {
      ...(previous.material || {}),
      ...(incoming.material || {}),
    },
    status: {
      ...(previous.status || {}),
      ...(incoming.status || {}),
    },
  };
  if (hasObservedFieldMask(materialMask)) {
    for (const key of ["vendor", "type", "name", "color", "rfid", "minTemp", "maxTemp", "pressure"]) {
      if (materialMask[key] !== true && previous.material && hasOwn(previous.material, key)) {
        merged.material[key] = cloneJsonValue(previous.material[key]);
      }
    }
  } else if (!materialObserved) {
    merged.material = cloneJsonValue(previous.material);
  }
  for (const key of ["remaining", "stateCode", "editStatusCode", "scrap", "selected"]) {
    const observed = isMaskedFieldObserved(statusMask, key, hasOwn(incoming.status, key));
    if (!observed && previous.status && hasOwn(previous.status, key)) {
      merged.status[key] = cloneJsonValue(previous.status[key]);
    }
  }
  if (!materialObserved && !stateCodeObserved) {
    merged.presence = previous.presence || merged.presence;
  }
  return merged;
}

/**
 * material source観測ストアをmonitorData上に用意する。
 *
 * 【詳細説明】
 * - live shadowはruntimeDataへ最新状態を置くが、CFS slot/外部スプールの観測履歴は
 *   `materialSourceObservations` に分離して保存する。
 * - このストアはread-only evidence専用であり、hostSpoolMapやfilament ledgerの権威にはしない。
 *
 * @private
 * @function ensureMaterialSourceObservationStore
 * @returns {object} material source観測ストア。
 */
function ensureMaterialSourceObservationStore() {
  if (!monitorData.materialSourceObservations || typeof monitorData.materialSourceObservations !== "object") {
    monitorData.materialSourceObservations = createEmptyMaterialSourceObservations();
  }
  return monitorData.materialSourceObservations;
}

/**
 * shadow deviceIdのidentity強度を保守的に判定する。
 *
 * 【詳細説明】
 * - `serial:` などの強いIDだけをstable扱いにし、endpoint/host/material-provider由来はprovisionalとして扱う。
 * - これによりDHCP再利用やprovider単独接続時の観測を、後段のstable device authorityへ自動昇格しない。
 *
 * @private
 * @function deriveObservationIdentityStrength
 * @param {string} deviceId - shadowまたはprovider由来のdevice ID。
 * @returns {string} `"stable"` または `"provisional"`。
 */
function deriveObservationIdentityStrength(deviceId) {
  const text = String(deviceId || "").trim();
  if (/^(serial|sn|machine):/i.test(text)) {
    return "stable";
  }
  return "provisional";
}

/**
 * 同一hostのprovisional観測をstable device recordへ昇格する。
 *
 * 【詳細説明】
 * - live shadowはsession開始時にdeviceIdを固定するため、再接続後にserial/machine IDが得られると
 *   以前のendpoint由来観測が別deviceとして残り得る。
 * - command authorityへは使わないread-only証跡だが、履歴を物理機ごとに追えるよう、hostが一致する
 *   provisional recordだけをstable recordへ移す。
 *
 * @private
 * @function rekeyProvisionalObservationForStableDevice
 * @param {object} store - material source観測ストア。
 * @param {object} options - rekey候補。
 * @param {string} options.host - 表示host。
 * @param {string} options.deviceId - 今回のdevice ID。
 * @param {string} options.identityStrength - 今回のidentity強度。
 * @param {string=} options.observedAt - 観測日時。
 * @returns {object|null} rekey結果、またはnull。
 */
function rekeyProvisionalObservationForStableDevice(store, options = {}) {
  const host = String(options.host || "").trim();
  const deviceId = String(options.deviceId || "").trim();
  if (!host || !deviceId || options.identityStrength !== "stable") {
    return null;
  }
  const byDeviceId = store?.byDeviceId && typeof store.byDeviceId === "object" ? store.byDeviceId : {};
  for (const [candidateId, record] of Object.entries(byDeviceId)) {
    if (candidateId === deviceId || !record || record.identityStrength !== "provisional") {
      continue;
    }
    if (String(record.host || "").trim() !== host) {
      continue;
    }
    return rekeyMaterialSourceObservationDevice(store, {
      fromDeviceId: candidateId,
      toDeviceId: deviceId,
      observedAt: options.observedAt,
      mergeIfTargetExists: true,
      identityConflict: false,
    });
  }
  return null;
}

/**
 * material topologyをread-only観測台帳へ反映する。
 *
 * 【詳細説明】
 * - UI表示用runtime recordとは別に、source単位のsemantic changeだけを保存する。
 * - 失敗してもプリンタ接続・legacy UIを止めず、diagnosticとしてruntime recordへ残すための結果を返す。
 *
 * @private
 * @function recordMaterialSourceObservationForShadow
 * @param {Object} options - 観測記録オプション。
 * @param {string} options.host - 表示host。
 * @param {string} options.deviceId - device ID。
 * @param {string} options.sessionId - session ID。
 * @param {Object} options.topology - Normalized material topology。
 * @param {string} options.observedAt - 観測日時ISO文字列。
 * @param {string=} options.providerGeneration - provider世代。
 * @param {number=} options.sequence - 観測sequence。
 * @param {string=} options.snapshotCompleteness - complete/partial。
 * @param {string=} options.identityStrength - identity repository由来またはdeviceId由来のidentity強度。
 * @returns {Object|null} 観測記録結果。
 */
function recordMaterialSourceObservationForShadow(options) {
  if (!options?.topology || typeof options.topology !== "object") {
    return null;
  }
  const providerId = options.topology.provider?.providerId || options.providerId || null;
  const store = ensureMaterialSourceObservationStore();
  const identityStrength = options.identityStrength || deriveObservationIdentityStrength(options.deviceId);
  rekeyProvisionalObservationForStableDevice(store, {
    host: options.host,
    deviceId: options.deviceId,
    identityStrength,
    observedAt: options.observedAt,
  });
  return recordMaterialTopologyObservation(store, {
    host: options.host,
    deviceId: options.deviceId,
    identityStrength,
    sessionId: options.sessionId,
    providerId,
    providerGeneration: options.providerGeneration || options.sessionId || null,
    sequence: options.sequence ?? null,
    observedAt: options.observedAt,
    topology: options.topology,
    snapshotCompleteness: options.snapshotCompleteness,
  });
}

/**
 * sourceId/assignment単位でmaterial topologyを表示用にmergeする。
 *
 * 【詳細説明】
 * - Providerから届いたpartial deltaは永続Observation storeへはpartialとして渡す。
 * - UI表示用runtime topologyでは、payloadに含まれないslotを未観測へ落とさないよう、前回topologyを保持して
 *   受信分だけ上書きする。complete snapshotの場合だけ全置換する。
 *
 * @private
 * @function mergeMaterialTopologyForRuntimeDisplay
 * @param {Object|null|undefined} previousTopology - 直前のruntime material topology。
 * @param {Object|null|undefined} incomingTopology - 今回providerが生成したmaterial topology。
 * @param {"complete"|"partial"} snapshotCompleteness - snapshot完全性。
 * @returns {Object|null} 表示用material topology。
 */
function mergeMaterialTopologyForRuntimeDisplay(previousTopology, incomingTopology, snapshotCompleteness) {
  if (!incomingTopology || typeof incomingTopology !== "object") {
    return previousTopology && typeof previousTopology === "object" ? previousTopology : null;
  }
  if (snapshotCompleteness === "complete" || !previousTopology || typeof previousTopology !== "object") {
    return incomingTopology;
  }
  const sourceMap = new Map();
  for (const source of Array.isArray(previousTopology.sources) ? previousTopology.sources : []) {
    if (source?.sourceId) {
      sourceMap.set(source.sourceId, source);
    }
  }
  for (const source of Array.isArray(incomingTopology.sources) ? incomingTopology.sources : []) {
    if (source?.sourceId) {
      sourceMap.set(source.sourceId, mergeRuntimeMaterialSource(sourceMap.get(source.sourceId) || null, source));
    }
  }
  const unitMap = new Map();
  for (const unit of Array.isArray(previousTopology.units) ? previousTopology.units : []) {
    if (unit?.unitId) {
      unitMap.set(unit.unitId, unit);
    }
  }
  for (const unit of Array.isArray(incomingTopology.units) ? incomingTopology.units : []) {
    if (unit?.unitId) {
      unitMap.set(unit.unitId, unit);
    }
  }
  const assignmentSectionHasMask = hasObservedFieldMask(incomingTopology?.observationMask?.sections);
  const assignmentsObserved = assignmentSectionHasMask &&
    isTopologySectionObserved(incomingTopology, "assignments", false);
  const resolvedIncomingAssignments = assignmentsObserved
    ? resolveRuntimeAssignments(incomingTopology.assignments, sourceMap)
    : (Array.isArray(incomingTopology.assignments) ? incomingTopology.assignments : []);
  const assignmentMap = new Map();
  const putAssignment = (assignment) => {
    const key = String(assignment?.assignmentId || assignment?.sourceId || "");
    if (key) {
      assignmentMap.set(key, assignment);
    }
  };
  const baseAssignments = assignmentsObserved ? [] : (Array.isArray(previousTopology.assignments) ? previousTopology.assignments : []);
  for (const assignment of baseAssignments) {
    putAssignment(assignment);
  }
  for (const assignment of resolvedIncomingAssignments) {
    putAssignment(assignment);
  }
  return {
    ...previousTopology,
    ...incomingTopology,
    cfs: {
      ...(previousTopology.cfs || {}),
      ...(incomingTopology.cfs || {}),
    },
    provider: {
      ...(previousTopology.provider || {}),
      ...(incomingTopology.provider || {}),
    },
    authority: {
      ...(previousTopology.authority || {}),
      ...(incomingTopology.authority || {}),
    },
    units: Array.from(unitMap.values()),
    sources: Array.from(sourceMap.values()),
    assignments: Array.from(assignmentMap.values()),
    diagnostics: [
      ...(Array.isArray(previousTopology.diagnostics) ? previousTopology.diagnostics : []),
      ...(Array.isArray(incomingTopology.diagnostics) ? incomingTopology.diagnostics : []),
    ],
  };
}

/**
 * live shadow 用 ID 部品を安全な文字列へ変換する。
 *
 * 【詳細説明】
 * - sessionId はログや runtimeData で比較するだけなので、可読な URI encode 文字列へ寄せる。
 *
 * @private
 * @param {*} value - ID 部品候補
 * @param {string} fallback - 空値時の fallback
 * @returns {string} 正規化済み ID 部品
 */
function toShadowIdPart(value, fallback) {
  const text = String(value ?? "").trim();
  return encodeURIComponent(text || fallback);
}

/**
 * WebSocket 接続ごとの shadow session ID を生成する。
 *
 * 【詳細説明】
 * - WebSocket open ごとに呼び出すことで、再接続時に sequence と adapterState を必ずリセットする。
 * - テストでは `openedAt` を固定し、session ID を決定的にできる。
 *
 * @function createPrinterCoreV3ShadowSessionId
 * @param {object=} options - 生成オプション
 * @param {string=} options.host - 接続ホスト名
 * @param {string=} options.dest - 接続先 dest
 * @param {Date|string|number=} options.openedAt - 接続開始時刻
 * @returns {string} shadow session ID
 * @example
 * const sessionId = createPrinterCoreV3ShadowSessionId({ host: "K1Max-A" });
 */
export function createPrinterCoreV3ShadowSessionId(options = {}) {
  const family = String(options.family || "k1").trim().toLowerCase() === "k2" ? "k2" : "k1";
  const openedAt = options.openedAt instanceof Date
    ? options.openedAt.toISOString()
    : String(options.openedAt ?? new Date().toISOString());
  return [
    `${family}-live`,
    toShadowIdPart(options.host || options.dest, "unknown-host"),
    toShadowIdPart(options.dest || options.host, "unknown-dest"),
    toShadowIdPart(openedAt, "unknown-time"),
  ].join(":");
}

/**
 * identity evidence に open conflict が含まれるか判定する。
 *
 * 【詳細説明】
 * - DHCP や IP 再利用で強い conflict が開いている間は、既存 identity の deviceIdSeed を
 *   live shadow の deviceId として使うと旧機体名義の shadow session になり得る。
 * - singleton と plural の両方を受け取り、Data Schema v3 移行前の互換形を同時に扱う。
 *
 * @private
 * @param {object|null|undefined} conflict - singleton conflict record
 * @param {Array<object>|null|undefined} conflicts - plural conflict records
 * @returns {boolean} open conflict がある場合 true
 */
function hasOpenIdentityConflict(conflict, conflicts) {
  if (conflict?.status === "open") {
    return true;
  }
  return (Array.isArray(conflicts) ? conflicts : []).some((entry) => entry?.status === "open");
}

/**
 * identity conflict 中に使う暫定 shadow deviceId を生成する。
 *
 * 【詳細説明】
 * - conflict 中は hostname や serial identity を信用しすぎないため、接続 endpoint を優先する。
 * - `provisional-shadow:` namespace に閉じ、後続 Data Schema v3 の stable device ID と混同しないようにする。
 *
 * @private
 * @param {object=} options - ID 生成オプション
 * @param {string=} options.host - 解決済みホスト名
 * @param {string=} options.dest - 接続先 dest
 * @returns {string} 暫定 shadow deviceId
 */
function createConflictShadowDeviceId(options = {}) {
  const endpoint = String(options.dest || "").trim();
  if (endpoint) {
    return `provisional-shadow:endpoint:${encodeURIComponent(endpoint)}`;
  }
  const host = String(options.host || "").trim();
  return `provisional-shadow:host:${encodeURIComponent(host || "unknown")}`;
}

/**
 * shadow session 用の deviceId を決定する。
 *
 * 【詳細説明】
 * - identity があれば `deviceIdSeed` を使い、無い場合は live shadow 専用の暫定 endpoint/host ID に倒す。
 * - open conflict がある場合は旧 identity を採用せず、endpoint/host 由来の暫定 shadow ID に倒す。
 * - fallback では `host:` namespace を使わず、hostname を安定 ID と誤読しない形にする。
 * - この値はまだ command authorization や routing authority には使わない。
 *
 * @function resolvePrinterCoreV3LiveShadowDeviceId
 * @param {object=} options - 解決オプション
 * @param {object|null=} options.identity - Printer Core v3 identity dry-run record
 * @param {object|null=} options.identityConflict - singleton identity conflict record
 * @param {Array<object>|null=} options.identityConflicts - plural identity conflict records
 * @param {string=} options.host - 解決済みホスト名
 * @param {string=} options.dest - 接続先 dest
 * @returns {string} shadow 用 deviceId
 * @example
 * const deviceId = resolvePrinterCoreV3LiveShadowDeviceId({ host: "K1Max-A" });
 */
export function resolvePrinterCoreV3LiveShadowDeviceId(options = {}) {
  const hostOrDest = String(options.host || options.dest || "").trim();
  if (hasOpenIdentityConflict(options.identityConflict, options.identityConflicts)) {
    return createConflictShadowDeviceId(options);
  }
  const seed = String(options.identity?.deviceIdSeed || "").trim();
  if (seed) {
    return seed;
  }
  return createConflictShadowDeviceId({
    ...options,
    host: hostOrDest || "unknown",
  });
}

/**
 * K1 live shadow 用の deviceId を決定する。
 *
 * 【詳細説明】
 * - 互換 API として残し、実処理は printer family 非依存の
 *   {@link resolvePrinterCoreV3LiveShadowDeviceId} に委譲する。
 *
 * @function resolveK1LiveShadowDeviceId
 * @param {object=} options - 解決オプション
 * @returns {string} shadow 用 deviceId
 * @example
 * const deviceId = resolveK1LiveShadowDeviceId({ host: "K1Max-A" });
 */
export function resolveK1LiveShadowDeviceId(options = {}) {
  return resolvePrinterCoreV3LiveShadowDeviceId(options);
}

/**
 * host に紐づく machine runtimeData を返す。
 *
 * 【詳細説明】
 * - live shadow は既存 connection/processData の後段にぶら下がるため、machine が未作成なら副作用を避けて null を返す。
 *
 * @private
 * @param {string} host - ホスト名
 * @returns {object|null} runtimeData を持つ machine、または null
 */
function getMachineForShadow(host) {
  const machine = monitorData.machines?.[host];
  if (!machine) {
    return null;
  }
  machine.runtimeData ??= {};
  return machine;
}

/**
 * host の現在の live shadow runtime record を返す。
 *
 * 【詳細説明】
 * - recover 判定では runtimeData 側の現在 session を権威にし、古い callback が旧sessionを再生成しないようにする。
 *
 * @private
 * @param {string} host - ホスト名
 * @returns {object|null} 現在の shadow runtime record、または null
 */
function getCurrentShadowRecord(host) {
  const machine = getMachineForShadow(host);
  return machine?.runtimeData?.printerCoreV3Shadow || null;
}

/**
 * storedData の raw/computed 値を取り出す。
 *
 * 【詳細説明】
 * - legacy 側は `setStoredDataForHost()` の呼び方により rawValue / computedValue / `{value}` が混在する。
 *
 * @private
 * @param {string} host - ホスト名
 * @param {string} key - storedData key
 * @returns {*} storedData の値、または null
 */
function readStoredValue(host, key) {
  const entry = monitorData.machines?.[host]?.storedData?.[key];
  const value = entry && typeof entry === "object" && (hasOwn(entry, "rawValue") || hasOwn(entry, "computedValue"))
    ? entry.rawValue ?? entry.computedValue
    : entry;
  return value === undefined ? null : value;
}

/**
 * storedData の値を number へ変換する。
 *
 * 【詳細説明】
 * - preview 座標のような `{value, unit}` 形式も legacy projection で比較できるようにする。
 *
 * @private
 * @param {string} host - ホスト名
 * @param {string} key - storedData key
 * @returns {?number} 数値、または null
 */
function readStoredNumber(host, key) {
  const value = readStoredValue(host, key);
  const raw = value && typeof value === "object" && hasOwn(value, "value") ? value.value : value;
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  const numberValue = Number(raw);
  return Number.isFinite(numberValue) ? numberValue : null;
}

/**
 * storedData の値を string へ変換する。
 *
 * 【詳細説明】
 * - 空文字は firmware の意味を保つため空文字のまま返す。
 *
 * @private
 * @param {string} host - ホスト名
 * @param {string} key - storedData key
 * @returns {?string} 文字列、または null
 */
function readStoredString(host, key) {
  const value = readStoredValue(host, key);
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

/**
 * storedData の数値 flag を boolean へ変換する。
 *
 * 【詳細説明】
 * - 0 と未観測を区別するため、数値化不能な値は null として扱う。
 *
 * @private
 * @param {string} host - ホスト名
 * @param {string} key - storedData key
 * @returns {?boolean} boolean、または null
 */
function readStoredBooleanFlag(host, key) {
  const numberValue = readStoredNumber(host, key);
  return numberValue === null ? null : numberValue === 1;
}

/**
 * legacy storedData から MJPEG flag を投影する。
 *
 * 【詳細説明】
 * - K1 系は `video` と `video1` のどちらかが 1 なら MJPEG usable とみなす。
 *
 * @private
 * @param {string} host - ホスト名
 * @returns {?boolean} MJPEG 使用可否、または未観測 null
 */
function projectLegacyCameraMjpeg(host) {
  const video = readStoredBooleanFlag(host, "video");
  const video1 = readStoredBooleanFlag(host, "video1");
  if (video === null && video1 === null) {
    return null;
  }
  return video === true || video1 === true;
}

/**
 * legacy storedData から XYZ position を投影する。
 *
 * 【詳細説明】
 * - positionX/Y/Z がすべて未観測の場合は v3 の初期値と同じ null にし、空 object 差分を出さない。
 *
 * @private
 * @param {string} host - ホスト名
 * @returns {{x:?number,y:?number,z:?number}|null} 比較用 position、または null
 */
function projectLegacyPosition(host) {
  const position = {
    x: readStoredNumber(host, "positionX"),
    y: readStoredNumber(host, "positionY"),
    z: readStoredNumber(host, "positionZ"),
  };
  return position.x === null && position.y === null && position.z === null ? null : position;
}

/**
 * legacy storedData から比較用 state を投影する。
 *
 * 【詳細説明】
 * - processData() が UI authority として保持している storedData を NormalizedPrinterState と同じ比較形へ寄せる。
 * - live shadow のための read-only projection であり、storedData を変更しない。
 *
 * @function projectLegacyK1ShadowState
 * @param {string} host - ホスト名
 * @returns {object} legacy 比較用 state
 * @example
 * const legacy = projectLegacyK1ShadowState("K1Max-A");
 */
export function projectLegacyK1ShadowState(host) {
  const err = readStoredValue(host, "err");
  return {
    identity: {
      reportedModel: readStoredString(host, "model"),
      reportedHostname: readStoredString(host, "hostname"),
    },
    temperatures: {
      nozzle: {
        current: readStoredNumber(host, "nozzleTemp"),
        target: readStoredNumber(host, "targetNozzleTemp"),
        max: readStoredNumber(host, "maxNozzleTemp"),
      },
      bed: {
        current: readStoredNumber(host, "bedTemp0"),
        target: readStoredNumber(host, "targetBedTemp0"),
        max: readStoredNumber(host, "maxBedTemp"),
      },
      chamber: {
        current: readStoredNumber(host, "boxTemp"),
        target: readStoredNumber(host, "targetBoxTemp"),
        max: readStoredNumber(host, "maxBoxTemp"),
      },
    },
    fans: {
      partCooling: {
        enabled: readStoredBooleanFlag(host, "fan"),
        percent: readStoredNumber(host, "modelFanPct"),
      },
      auxiliary: {
        enabled: readStoredBooleanFlag(host, "fanAuxiliary"),
        percent: readStoredNumber(host, "auxiliaryFanPct"),
      },
      case: {
        enabled: readStoredBooleanFlag(host, "fanCase"),
        percent: readStoredNumber(host, "caseFanPct"),
      },
    },
    light: {
      enabled: readStoredBooleanFlag(host, "lightSw"),
    },
    print: {
      stateCode: readStoredNumber(host, "state"),
      progressPct: readStoredNumber(host, "printProgress"),
      layer: readStoredNumber(host, "layer"),
      totalLayer: readStoredNumber(host, "TotalLayer"),
      remainingSec: readStoredNumber(host, "printLeftTime"),
      fileName: readStoredString(host, "printFileName") ?? readStoredString(host, "fileName"),
    },
    motion: {
      position: projectLegacyPosition(host),
    },
    error: {
      code: err && typeof err === "object" ? Number(err.errcode) : null,
      key: err && typeof err === "object" ? Number(err.key) : null,
    },
    camera: {
      mjpeg: projectLegacyCameraMjpeg(host),
      webrtc: readStoredBooleanFlag(host, "webrtcSupport"),
      timelapseEnabled: readStoredBooleanFlag(host, "videoElapse"),
    },
    ai: {
      detection: readStoredNumber(host, "aiDetection"),
      switchEnabled: readStoredNumber(host, "aiSw"),
      pauseOnDetection: readStoredNumber(host, "aiPausePrint"),
      firstLayer: readStoredNumber(host, "aiFirstFloor"),
    },
  };
}

/**
 * NormalizedPrinterState から legacy differential 用の比較 subset を抽出する。
 *
 * 【詳細説明】
 * - source/capabilities/schemaVersion は live shadow の健全性とは別の監査対象なので differential から外す。
 *
 * @function selectComparableK1ShadowState
 * @param {object|null|undefined} state - NormalizedPrinterState
 * @returns {object} 比較用 subset
 * @example
 * const comparable = selectComparableK1ShadowState(state);
 */
export function selectComparableK1ShadowState(state) {
  const source = state && typeof state === "object" ? state : {};
  return {
    identity: {
      reportedModel: source.identity?.reportedModel ?? null,
      reportedHostname: source.identity?.reportedHostname ?? null,
    },
    temperatures: source.temperatures ?? {},
    fans: source.fans ?? {},
    light: source.light ?? {},
    print: {
      stateCode: source.print?.stateCode ?? null,
      progressPct: source.print?.progressPct ?? null,
      layer: source.print?.layer ?? null,
      totalLayer: source.print?.totalLayer ?? null,
      remainingSec: source.print?.remainingSec ?? null,
      fileName: source.print?.fileName ?? null,
    },
    motion: {
      position: source.motion?.position ?? null,
    },
    error: {
      code: source.error?.code ?? null,
      key: source.error?.key ?? null,
    },
    camera: source.camera ?? {},
    ai: source.ai ?? {},
  };
}

/**
 * 比較に意味のある leaf 値か判定する。
 *
 * 【詳細説明】
 * - 両側とも未観測の null / undefined なら differential から除外する。
 *
 * @private
 * @param {*} left - 左値
 * @param {*} right - 右値
 * @returns {boolean} 比較対象にする場合 true
 */
function hasComparableValue(left, right) {
  return left !== null && left !== undefined || right !== null && right !== undefined;
}

/**
 * 二つの leaf 値が同等か判定する。
 *
 * 【詳細説明】
 * - 温度などは小数丸め差があるため、number 同士は小さな許容誤差で比較する。
 *
 * @private
 * @param {*} left - 左値
 * @param {*} right - 右値
 * @returns {boolean} 同等なら true
 */
function areShadowValuesEqual(left, right) {
  if (!hasComparableValue(left, right)) {
    return true;
  }
  if (typeof left === "number" && typeof right === "number") {
    return Math.abs(left - right) <= 0.01;
  }
  return Object.is(left, right);
}

/**
 * object を path 付きで再帰比較する。
 *
 * 【詳細説明】
 * - 差分ログを人間が読みやすくするため、`print.progressPct` のような path を残す。
 *
 * @private
 * @param {*} v3 - v3 側値
 * @param {*} legacy - legacy 側値
 * @param {string} path - 現在 path
 * @param {Array<object>} diffs - 差分出力先
 * @returns {void}
 */
function collectShadowDiffs(v3, legacy, path, diffs) {
  const bothObjects = v3 && legacy &&
    typeof v3 === "object" &&
    typeof legacy === "object" &&
    !Array.isArray(v3) &&
    !Array.isArray(legacy);
  if (bothObjects) {
    const keys = Array.from(new Set([...Object.keys(v3), ...Object.keys(legacy)])).sort();
    for (const key of keys) {
      collectShadowDiffs(v3[key], legacy[key], path ? `${path}.${key}` : key, diffs);
    }
    return;
  }
  if (!areShadowValuesEqual(v3, legacy)) {
    diffs.push({ path, v3, legacy });
  }
}

/**
 * NormalizedPrinterState と legacy projection の差分を返す。
 *
 * 【詳細説明】
 * - 戻り値は runtimeData へ保存できる plain object 配列にする。
 *
 * @function diffK1ShadowStates
 * @param {object} v3 - v3 比較用 state
 * @param {object} legacy - legacy 比較用 state
 * @returns {Array<object>} 差分一覧
 * @example
 * const diffs = diffK1ShadowStates(v3, legacy);
 */
export function diffK1ShadowStates(v3, legacy) {
  const diffs = [];
  collectShadowDiffs(v3, legacy, "", diffs);
  return diffs;
}

/**
 * diff path だけを使った console warning 用 signature を生成する。
 *
 * 【詳細説明】
 * - 値が毎frame揺れても同じ原因の差分なら同一signatureにし、ログ量を抑制する。
 *
 * @private
 * @param {Array<object>} diffs - 差分一覧
 * @returns {string} diff path signature
 */
function createShadowDiffSignature(diffs) {
  return (Array.isArray(diffs) ? diffs : [])
    .map((diff) => String(diff?.path || ""))
    .filter(Boolean)
    .sort()
    .join("|");
}

/**
 * 差分を console warning として出力すべきか判定する。
 *
 * 【詳細説明】
 * - 最初の差分、差分pathの変化、または一定時間経過時だけ true にする。
 * - runtimeData の lastDiffs はこの判定に関係なく毎frame更新される。
 *
 * @private
 * @param {object} previous - 前回の runtime shadow record
 * @param {string} signature - 現在 diff の path signature
 * @param {string} observedAt - 現在観測時刻
 * @returns {boolean} console warning を出す場合 true
 */
function shouldWarnShadowDiff(previous, signature, observedAt) {
  if (!signature) {
    return false;
  }
  if (previous.lastDiffLogSignature !== signature) {
    return true;
  }
  const previousAt = Date.parse(previous.lastDiffLogAt || "");
  const currentAt = Date.parse(observedAt || "");
  if (!Number.isFinite(previousAt) || !Number.isFinite(currentAt)) {
    return true;
  }
  return currentAt - previousAt >= SHADOW_DIFF_WARN_INTERVAL_MS;
}

/**
 * K1 live shadow session を開始する。
 *
 * 【詳細説明】
 * - 既存 UI や command path は変更せず、Printer Core v3 側の Instance だけを準備する。
 * - session 開始情報は machine.runtimeData.printerCoreV3Shadow に揮発的に記録する。
 *
 * @function beginK1LiveShadowSession
 * @param {object} options - session 開始オプション
 * @param {string} options.host - ホスト名
 * @param {string} options.deviceId - shadow 用 deviceId
 * @param {string} options.sessionId - shadow session ID
 * @returns {object} shadow runtime record
 * @example
 * beginK1LiveShadowSession({ host: "K1Max-A", deviceId: "host:K1Max-A", sessionId: "k1-live:..." });
 */
export function beginK1LiveShadowSession(options) {
  return beginPrinterCoreV3LiveShadowSession({
    ...options,
    printerFamily: "k1",
    facade: k1LiveShadowFacade,
  });
}

/**
 * K2 live shadow session を開始する。
 *
 * 【詳細説明】
 * - K2 Pro Combo + CFS の観測専用 Instance を準備する。
 * - runtimeData には printerFamily を明示し、K1 differential record と区別できるようにする。
 *
 * @function beginK2LiveShadowSession
 * @param {object} options - session 開始オプション
 * @param {string} options.host - ホスト名
 * @param {string} options.deviceId - shadow 用 deviceId
 * @param {string} options.sessionId - shadow session ID
 * @param {number=} options.connectionGeneration - WebSocket接続世代
 * @returns {object} shadow runtime record
 * @example
 * beginK2LiveShadowSession({ host: "K2Pro-A", deviceId: "host:K2Pro-A", sessionId: "k2-live:..." });
 */
export function beginK2LiveShadowSession(options) {
  return beginPrinterCoreV3LiveShadowSession({
    ...options,
    printerFamily: "k2",
    facade: k2LiveShadowFacade,
  });
}

/**
 * Printer Core v3 live shadow session を開始する。
 *
 * 【詳細説明】
 * - family 固有の Facade を受け取り、runtime record の共通 shape を生成する。
 * - K1/K2 どちらも UI authority や persistent storage を変更しない。
 *
 * @private
 * @param {object} options - session 開始オプション
 * @param {string} options.host - ホスト名
 * @param {string} options.deviceId - shadow 用 deviceId
 * @param {string} options.sessionId - shadow session ID
 * @param {string} options.printerFamily - printer family
 * @param {number=} options.connectionGeneration - WebSocket接続世代
 * @param {object} options.facade - PrinterFacade instance
 * @returns {object} shadow runtime record
 */
function beginPrinterCoreV3LiveShadowSession(options) {
  const host = String(options?.host || "").trim();
  const deviceId = String(options?.deviceId || "").trim();
  const sessionId = String(options?.sessionId || "").trim();
  const printerFamily = String(options?.printerFamily || "k1").trim().toLowerCase();
  const connectionGeneration = Number(options?.connectionGeneration);
  const facade = options?.facade;
  if (!host || !deviceId || !sessionId) {
    return {
      accepted: false,
      reason: "shadow-ids-missing",
      host: host || null,
      deviceId: deviceId || null,
      sessionId: sessionId || null,
    };
  }
  facade.beginSession({ deviceId, sessionId });
  const machine = getMachineForShadow(host);
  const record = {
    schemaVersion: PRINTER_CORE_V3_LIVE_SHADOW_SCHEMA_VERSION,
    enabled: true,
    printerFamily,
    host,
    deviceId,
    sessionId,
    connectionGeneration: Number.isFinite(connectionGeneration) ? connectionGeneration : null,
    printerCoreV3ConnectionGeneration: Number.isFinite(connectionGeneration) ? connectionGeneration : null,
    state: "active",
    differentialCompared: false,
    observedFrames: 0,
    diffCount: 0,
    lastDiffs: [],
    lastObservedAt: null,
    lastSequence: 0,
  };
  if (machine) {
    machine.runtimeData.printerCoreV3Shadow = record;
  }
  return record;
}

/**
 * session 未開始 error から復旧してよいか runtime record と照合する。
 *
 * 【詳細説明】
 * - deviceId や sessionId が現在 record と異なる場合、遅延 callback 由来の stale observe とみなし、
 *   旧 session を再生成しない。
 * - runtime record が存在しない初回だけは、従来どおり未開始 session を1回復旧できる。
 *
 * @private
 * @param {object} options - 復旧判定オプション
 * @param {string} options.host - ホスト名
 * @param {string} options.deviceId - shadow 用 deviceId
 * @param {string} options.sessionId - shadow session ID
 * @returns {{recoverable:boolean,rejection:(object|null)}} 復旧可否と拒否理由
 */
function canRecoverMissingShadowSession(options) {
  const currentRecord = getCurrentShadowRecord(options.host);
  if (!currentRecord) {
    return { recoverable: true, rejection: null };
  }
  const sameSession =
    currentRecord.deviceId === options.deviceId &&
    currentRecord.sessionId === options.sessionId;
  if (!sameSession) {
    return {
      recoverable: false,
      rejection: {
        accepted: false,
        reason: "stale-shadow-session",
        host: options.host,
        deviceId: options.deviceId,
        sessionId: options.sessionId,
        activeDeviceId: currentRecord.deviceId ?? null,
        activeSessionId: currentRecord.sessionId ?? null,
      },
    };
  }
  if (currentRecord.state === "closed") {
    return {
      recoverable: false,
      rejection: {
        accepted: false,
        reason: "session-closed",
        host: options.host,
        deviceId: options.deviceId,
        sessionId: options.sessionId,
      },
    };
  }
  return { recoverable: true, rejection: null };
}

/**
 * observeFrame の例外が session 未開始として復旧可能か判定する。
 *
 * 【詳細説明】
 * - connection 層では通常 `_ensurePrinterCoreV3LiveShadowSession()` が先に呼ばれるため、ここで復旧してよいのは
 *   session 未開始に限る。Adapter 実装バグなどは error record として可視化し、再生成で隠さない。
 *
 * @function isRecoverableK1LiveShadowObserveError
 * @param {*} error - observeFrame で発生した例外
 * @returns {boolean} session を開始して一度だけ再試行してよい場合 true
 * @example
 * const recoverable = isRecoverableK1LiveShadowObserveError(error);
 */
export function isRecoverableK1LiveShadowObserveError(error) {
  return isRecoverablePrinterCoreV3LiveShadowObserveError(error);
}

/**
 * observeFrame の例外が session 未開始として復旧可能か判定する。
 *
 * 【詳細説明】
 * - Adapter family に依存しない session lifecycle error を判定する。
 *
 * @function isRecoverablePrinterCoreV3LiveShadowObserveError
 * @param {*} error - observeFrame で発生した例外
 * @returns {boolean} session を開始して一度だけ再試行してよい場合 true
 * @example
 * const recoverable = isRecoverablePrinterCoreV3LiveShadowObserveError(error);
 */
export function isRecoverablePrinterCoreV3LiveShadowObserveError(error) {
  if (error?.code === PRINTER_FACADE_ERROR_CODES.SESSION_NOT_STARTED) {
    return true;
  }
  const message = String(error?.message || error || "");
  return message.includes("session has not been started");
}

/**
 * live shadow 用 Facade 観測結果を state/rejection へ正規化する。
 *
 * 【詳細説明】
 * - Gate 7.5 以降は `observeFrameResult()` を forward contract として優先し、成功/拒否を
 *   `accepted` flag で判定する。
 * - 旧テストや既存依存注入は `observeFrame()` だけを持つため、互換 fallback も残す。
 *
 * @private
 * @param {object} facade - PrinterFacade 互換 object
 * @param {object} options - observeFrame/observeFrameResult へ渡す観測オプション
 * @returns {{state:(object|null), rejection:(object|null)}} 正規化済み観測結果
 */
function observePrinterCoreV3ShadowFacadeFrame(facade, options) {
  if (facade && typeof facade.observeFrameResult === "function") {
    const result = facade.observeFrameResult(options);
    if (result?.accepted === true) {
      return {
        state: result.state,
        rejection: null,
      };
    }
    if (result?.accepted === false) {
      return {
        state: null,
        rejection: result,
      };
    }
    return {
      state: result,
      rejection: null,
    };
  }
  const state = facade.observeFrame(options);
  return {
    state,
    rejection: null,
  };
}

/**
 * live shadow の rejection が session 未開始として復旧可能か判定する。
 *
 * 【詳細説明】
 * - `observeFrameResult()` は session 未開始を throw ではなく rejection として返すため、
 *   exception 経路と同じ復旧条件をここで共有する。
 *
 * @private
 * @param {object|null|undefined} rejection - accepted:false の観測結果
 * @returns {boolean} session 再生成で一度だけ復旧してよい場合 true
 */
function isRecoverablePrinterCoreV3LiveShadowRejection(rejection) {
  return rejection?.reason === PRINTER_FACADE_ERROR_CODES.SESSION_NOT_STARTED;
}

/**
 * live shadow rejection を既存の拒否レスポンス形式へ変換する。
 *
 * 【詳細説明】
 * - observeFrameResult 導入後も、呼び出し側が期待する `host/deviceId/sessionId/activeSessionId` を
 *   失わないようにする。
 *
 * @private
 * @param {object} options - 変換オプション
 * @param {object} options.rejection - accepted:false の観測結果
 * @param {string} options.host - ホスト名
 * @param {string} options.deviceId - shadow deviceId
 * @param {string} options.sessionId - shadow sessionId
 * @returns {object} live shadow の拒否レスポンス
 */
function createLiveShadowObserveRejection(options) {
  const rejection = options.rejection || {};
  return {
    accepted: false,
    reason: rejection.reason,
    host: options.host,
    deviceId: options.deviceId,
    sessionId: options.sessionId,
    activeDeviceId: rejection.activeDeviceId ?? null,
    activeSessionId: rejection.activeSessionId ?? null,
  };
}

/**
 * live shadow frame を Facade へ渡し、session 未開始だけを復旧する。
 *
 * 【詳細説明】
 * - K1/K2 の live shadow は同じ lifecycle 契約を使うため、復旧条件と error 記録を一箇所に集約する。
 * - Adapter 例外や stale/closed rejection は session 再生成で隠さず、診断可能な戻り値として返す。
 *
 * @private
 * @param {object} options - 観測/復旧オプション
 * @param {object} options.facade - PrinterFacade 互換 object
 * @param {Function} options.beginSession - family 別 shadow session 開始関数
 * @param {string} options.printerFamily - `k1` または `k2`
 * @param {string} options.logFamily - console 診断用 family 名
 * @param {string} options.host - ホスト名
 * @param {string} options.deviceId - shadow deviceId
 * @param {string} options.sessionId - shadow sessionId
 * @param {object|null|undefined} options.frame - raw frame
 * @param {string=} options.receivedAt - 受信時刻 ISO 文字列
 * @param {"complete"|"partial"=} options.snapshotCompleteness - boxsInfoをcomplete snapshotとして扱う場合だけ`complete`。
 * @returns {{state:(object|null), terminal:(object|null)}} state または最終レスポンス
 */
function observePrinterCoreV3ShadowFrameWithRecovery(options) {
  const observeOptions = {
    deviceId: options.deviceId,
    sessionId: options.sessionId,
    frame: options.frame,
    receivedAt: options.receivedAt,
  };
  const observeOnce = () => observePrinterCoreV3ShadowFacadeFrame(options.facade, observeOptions);
  const retryAfterRecovery = () => {
    const recovery = canRecoverMissingShadowSession({
      host: options.host,
      deviceId: options.deviceId,
      sessionId: options.sessionId,
    });
    if (!recovery.recoverable) {
      return {
        state: null,
        terminal: recovery.rejection,
      };
    }
    options.beginSession({
      host: options.host,
      deviceId: options.deviceId,
      sessionId: options.sessionId,
    });
    try {
      const retryObservation = observeOnce();
      if (retryObservation.rejection) {
        return {
          state: null,
          terminal: createLiveShadowObserveRejection({
            rejection: retryObservation.rejection,
            host: options.host,
            deviceId: options.deviceId,
            sessionId: options.sessionId,
          }),
        };
      }
      return {
        state: retryObservation.state,
        terminal: null,
      };
    } catch (retryError) {
      console.error(`[printer-core-v3 shadow] ${options.logFamily} observe retry failed`, {
        host: options.host,
        sessionId: options.sessionId,
        error: retryError,
      });
      return {
        state: null,
        terminal: recordLiveShadowObserveError({
          host: options.host,
          deviceId: options.deviceId,
          sessionId: options.sessionId,
          printerFamily: options.printerFamily,
          error: retryError,
          reason: "shadow-observe-retry-error",
        }),
      };
    }
  };

  try {
    const observation = observeOnce();
    if (observation.rejection) {
      if (!isRecoverablePrinterCoreV3LiveShadowRejection(observation.rejection)) {
        return {
          state: null,
          terminal: createLiveShadowObserveRejection({
            rejection: observation.rejection,
            host: options.host,
            deviceId: options.deviceId,
            sessionId: options.sessionId,
          }),
        };
      }
      return retryAfterRecovery();
    }
    return {
      state: observation.state,
      terminal: null,
    };
  } catch (error) {
    if (!isRecoverablePrinterCoreV3LiveShadowObserveError(error)) {
      console.error(`[printer-core-v3 shadow] ${options.logFamily} observe failed`, {
        host: options.host,
        sessionId: options.sessionId,
        error,
      });
      return {
        state: null,
        terminal: recordLiveShadowObserveError({
          host: options.host,
          deviceId: options.deviceId,
          sessionId: options.sessionId,
          printerFamily: options.printerFamily,
          error,
        }),
      };
    }
    return retryAfterRecovery();
  }
}

/**
 * live shadow の observe 失敗を runtimeData に記録する。
 *
 * 【詳細説明】
 * - v3 shadow は診断器なので、adapter bug や予期しない例外を session 再生成で隠さず、
 *   runtimeData 上の error state と console error に残す。
 *
 * @private
 * @param {object} options - error 記録オプション
 * @param {string} options.host - ホスト名
 * @param {string} options.deviceId - shadow 用 deviceId
 * @param {string} options.sessionId - shadow session ID
 * @param {*} options.error - 発生した例外
 * @param {string=} options.reason - error reason
 * @returns {object} shadow runtime error record
 */
function recordLiveShadowObserveError(options) {
  const host = options.host;
  const deviceId = options.deviceId;
  const sessionId = options.sessionId;
  const printerFamily = options.printerFamily || "k1";
  const machine = getMachineForShadow(host);
  const previous = machine?.runtimeData?.printerCoreV3Shadow || {};
  const record = {
    schemaVersion: PRINTER_CORE_V3_LIVE_SHADOW_SCHEMA_VERSION,
    enabled: true,
    printerFamily,
    host,
    deviceId,
    sessionId,
    state: "error",
    observedFrames: Number(previous.observedFrames || 0),
    diffCount: Number(previous.diffCount || 0),
    lastDiffs: Array.isArray(previous.lastDiffs) ? previous.lastDiffs : [],
    lastObservedAt: new Date().toISOString(),
    lastSequence: previous.lastSequence ?? null,
    lastState: previous.lastState ?? null,
    shadowError: {
      reason: options.reason || "shadow-observe-error",
      message: String(options.error?.message || options.error || "unknown error"),
      observedAt: new Date().toISOString(),
    },
  };
  if (machine) {
    machine.runtimeData.printerCoreV3Shadow = record;
  }
  return record;
}

/**
 * K1 live frame を v3 state へ反映し legacy differential を記録する。
 *
 * 【詳細説明】
 * - 呼び出し側は legacy `processData()` 実行後に呼ぶことで、同じ frame に対する legacy/v3 の結果を比較できる。
 * - 差分は console warning と runtimeData のみに残し、UI authority や送信経路には一切反映しない。
 *
 * @function observeK1LiveShadowFrame
 * @param {object} options - 観測オプション
 * @param {string} options.host - ホスト名
 * @param {string} options.deviceId - shadow 用 deviceId
 * @param {string} options.sessionId - shadow session ID
 * @param {object|null|undefined} options.frame - K1 raw payload
 * @param {string=} options.receivedAt - 受信時刻 ISO 文字列
 * @param {object=} dependencies - テスト用依存注入
 * @param {object=} dependencies.facade - observeFrame を提供する Facade
 * @returns {object} shadow runtime record または拒否理由
 * @example
 * const record = observeK1LiveShadowFrame({ host, deviceId, sessionId, frame: data });
 */
export function observeK1LiveShadowFrame(options, dependencies = {}) {
  const host = String(options?.host || "").trim();
  const deviceId = String(options?.deviceId || "").trim();
  const sessionId = String(options?.sessionId || "").trim();
  if (!host || !deviceId || !sessionId) {
    return {
      accepted: false,
      reason: "shadow-ids-missing",
      host: host || null,
      deviceId: deviceId || null,
      sessionId: sessionId || null,
    };
  }

  const facade = dependencies.facade || k1LiveShadowFacade;
  const observed = observePrinterCoreV3ShadowFrameWithRecovery({
    facade,
    beginSession: beginK1LiveShadowSession,
    printerFamily: "k1",
    logFamily: "K1",
    host,
    deviceId,
    sessionId,
    frame: options.frame,
    receivedAt: options.receivedAt,
  });
  if (observed.terminal) {
    return observed.terminal;
  }
  const state = observed.state;

  if (state?.accepted === false) {
    return {
      accepted: false,
      reason: state.reason,
      host,
      deviceId,
      sessionId,
      activeSessionId: state.activeSessionId ?? null,
    };
  }

  const legacy = projectLegacyK1ShadowState(host);
  const v3 = selectComparableK1ShadowState(state);
  const diffs = diffK1ShadowStates(v3, legacy);
  const machine = getMachineForShadow(host);
  const previous = machine?.runtimeData?.printerCoreV3Shadow || {};
  const lastObservedAt = state.source?.receivedAt ?? options.receivedAt ?? new Date().toISOString();
  const diffSignature = createShadowDiffSignature(diffs);
  const warnDiff = shouldWarnShadowDiff(previous, diffSignature, lastObservedAt);
  const record = {
    schemaVersion: PRINTER_CORE_V3_LIVE_SHADOW_SCHEMA_VERSION,
    enabled: true,
    printerFamily: "k1",
    host,
    deviceId,
    sessionId,
    state: diffs.length > 0 ? "diff" : "matched",
    differentialCompared: true,
    observedFrames: Number(previous.observedFrames || 0) + 1,
    diffCount: Number(previous.diffCount || 0) + diffs.length,
    lastDiffs: diffs,
    lastObservedAt,
    lastSequence: state.source?.sequence ?? null,
    lastState: state,
    lastDiffLogSignature: warnDiff ? diffSignature : previous.lastDiffLogSignature ?? null,
    lastDiffLogAt: warnDiff ? lastObservedAt : previous.lastDiffLogAt ?? null,
  };
  if (machine) {
    machine.runtimeData.printerCoreV3Shadow = record;
  }
  if (warnDiff) {
    console.warn("[printer-core-v3 shadow] K1 legacy differential", { host, sessionId, diffs });
  } else if (diffs.length === 0 && monitorData.appSettings?.logLevel === "debug") {
    console.debug("[printer-core-v3 shadow] K1 frame matched legacy", { host, sessionId, sequence: record.lastSequence });
  }
  return record;
}

/**
 * K2 live frame を v3 state へ反映し material topology を runtimeData に記録する。
 *
 * 【詳細説明】
 * - K2 は Gate 5 時点で legacy processData との差分判定対象にせず、Printer Core v3 の観測結果だけを保持する。
 * - `boxsInfo` が届いた場合は `lastState.materials` へ CFS topology が同居し、UI authority や台帳には反映しない。
 *
 * @function observeK2LiveShadowFrame
 * @param {object} options - 観測オプション
 * @param {string} options.host - ホスト名
 * @param {string} options.deviceId - shadow 用 deviceId
 * @param {string} options.sessionId - shadow session ID
 * @param {object|null|undefined} options.frame - K2 raw payload
 * @param {string=} options.receivedAt - 受信時刻 ISO 文字列
 * @param {number=} options.connectionGeneration - WebSocket接続世代
 * @param {object=} dependencies - テスト用依存注入
 * @param {object=} dependencies.facade - observeFrame を提供する Facade
 * @returns {object} shadow runtime record または拒否理由
 * @example
 * const record = observeK2LiveShadowFrame({ host, deviceId, sessionId, frame: data });
 */
export function observeK2LiveShadowFrame(options, dependencies = {}) {
  const host = String(options?.host || "").trim();
  const deviceId = String(options?.deviceId || "").trim();
  const sessionId = String(options?.sessionId || "").trim();
  if (!host || !deviceId || !sessionId) {
    return {
      accepted: false,
      reason: "shadow-ids-missing",
      host: host || null,
      deviceId: deviceId || null,
      sessionId: sessionId || null,
    };
  }

  const facade = dependencies.facade || k2LiveShadowFacade;
  const observed = observePrinterCoreV3ShadowFrameWithRecovery({
    facade,
    beginSession: beginK2LiveShadowSession,
    printerFamily: "k2",
    logFamily: "K2",
    host,
    deviceId,
    sessionId,
    frame: options.frame,
    receivedAt: options.receivedAt,
  });
  if (observed.terminal) {
    return observed.terminal;
  }
  const state = observed.state;

  if (state?.accepted === false) {
    return {
      accepted: false,
      reason: state.reason,
      host,
      deviceId,
      sessionId,
      activeSessionId: state.activeSessionId ?? null,
    };
  }

  const machine = getMachineForShadow(host);
  const previous = machine?.runtimeData?.printerCoreV3Shadow || {};
  const observedConnectionGeneration = Number(
    options.connectionGeneration ??
    previous.connectionGeneration ??
    previous.printerCoreV3ConnectionGeneration
  );
  const lastObservedAt = state.source?.receivedAt ?? options.receivedAt ?? new Date().toISOString();
  const hasBoxsInfoFrame = hasOwn(options.frame, "boxsInfo") && options.frame?.boxsInfo && typeof options.frame.boxsInfo === "object";
  const previousMaterialObservedAt = previous.materialProviderLastObservedAt ||
    previous.lastState?.materials?.provider?.lastObservedAt ||
    null;
  const materialProviderLastObservedAt = hasBoxsInfoFrame
    ? lastObservedAt
    : previousMaterialObservedAt;
  const materials = state.materials && materialProviderLastObservedAt
    ? {
        ...state.materials,
        provider: {
          ...(state.materials.provider || {}),
          lastObservedAt: materialProviderLastObservedAt,
        },
      }
    : state.materials;
  const lastState = materials && materials !== state.materials
    ? { ...state, materials }
    : state;
  const record = {
    schemaVersion: PRINTER_CORE_V3_LIVE_SHADOW_SCHEMA_VERSION,
    enabled: true,
    printerFamily: "k2",
    host,
    deviceId,
    sessionId,
    connectionGeneration: Number.isFinite(observedConnectionGeneration) ? observedConnectionGeneration : null,
    printerCoreV3ConnectionGeneration: Number.isFinite(observedConnectionGeneration) ? observedConnectionGeneration : null,
    state: "observed",
    differentialCompared: false,
    observedFrames: Number(previous.observedFrames || 0) + 1,
    diffCount: 0,
    lastDiffs: [],
    lastObservedAt,
    lastSequence: state.source?.sequence ?? null,
    lastState,
    materialProviderLastObservedAt,
    cfsConnected: materials?.cfs?.connected ?? null,
    cfsTopologyState: materials?.cfs?.topologyState ?? null,
    cfsSourceCount: Array.isArray(materials?.sources) ? materials.sources.length : 0,
    cfsAssignmentCount: Array.isArray(materials?.assignments) ? materials.assignments.length : 0,
  };
  const snapshotCompleteness = options.snapshotCompleteness === "complete" ? "complete" : "partial";
  const runtimeMaterials = hasBoxsInfoFrame && materials
    ? mergeMaterialTopologyForRuntimeDisplay(previous.lastState?.materials || null, materials, snapshotCompleteness)
    : materials;
  const runtimeLastState = runtimeMaterials && runtimeMaterials !== state.materials
    ? { ...state, materials: runtimeMaterials }
    : lastState;
  record.lastState = runtimeLastState;
  record.printerIdleObservation = hasK2PrinterStatusScalarFrame(options.frame)
    ? createK2PrinterIdleObservationForShadow({
        previousRecord: previous,
        lastState: runtimeLastState,
        sessionId,
        connectionGeneration: record.connectionGeneration,
        observedAt: lastObservedAt,
        sequence: record.lastSequence,
      })
    : (previous.printerIdleObservation || null);
  record.cfsConnected = runtimeMaterials?.cfs?.connected ?? null;
  record.cfsTopologyState = runtimeMaterials?.cfs?.topologyState ?? null;
  record.cfsSourceCount = Array.isArray(runtimeMaterials?.sources) ? runtimeMaterials.sources.length : 0;
  record.cfsAssignmentCount = Array.isArray(runtimeMaterials?.assignments) ? runtimeMaterials.assignments.length : 0;
  const materialObservation = hasBoxsInfoFrame && materials
    ? recordMaterialSourceObservationForShadow({
        host,
        deviceId,
        sessionId,
        topology: materials,
        observedAt: materialProviderLastObservedAt || lastObservedAt,
        providerGeneration: sessionId,
        sequence: record.lastSequence,
        snapshotCompleteness,
      })
    : null;
  record.materialSourceObservationStatus = materialObservation
    ? {
        accepted: materialObservation.accepted === true,
        reason: materialObservation.reason || null,
        changedCount: Array.isArray(materialObservation.changes) ? materialObservation.changes.length : 0,
      }
    : previous.materialSourceObservationStatus || null;
  if (machine) {
    machine.runtimeData.printerCoreV3Shadow = record;
  }
  if (materials) {
    emitMaterialTopologyUpdated(host);
  }
  if (monitorData.appSettings?.logLevel === "debug") {
    console.debug("[printer-core-v3 shadow] K2 frame observed", {
      host,
      sessionId,
      sequence: record.lastSequence,
      cfsTopologyState: record.cfsTopologyState,
    });
  }
  return record;
}

/**
 * Moonraker/CFS-C secondary provider frame を material topology として記録する。
 *
 * 【詳細説明】
 * - K1C本体のPrinter Core v3 sessionとは別に、CFS-C boxsInfo相当のread-only payloadだけを
 *   `runtimeData.printerCoreV3Shadow.lastState.materials` へ合流する。
 * - printer identity / command authority / filament ledger には接続しない。UIが17巻構成を監視するための
 *   一時runtime evidenceとして扱う。
 *
 * @function observeMoonrakerCfsMaterialProviderFrame
 * @param {object} options - provider frame観測オプション
 * @param {string} options.host - 表示対象ホスト名
 * @param {object|null|undefined} options.payload - Moonraker/CFS-C payload
 * @param {string=} options.receivedAt - 観測日時ISO文字列
 * @param {string=} options.providerSessionId - secondary provider session id
 * @param {string=} options.providerGeneration - secondary provider transport generation
 * @param {boolean=} options.connected - provider transport が接続中なら true
 * @param {"complete"|"partial"=} options.snapshotCompleteness - 初期subscribeはcomplete、notify deltaはpartial
 * @param {object=} dependencies - テスト用依存差し替え
 * @param {object=} dependencies.materialProvider - material provider実装
 * @returns {object|null} 更新後runtime record、host不正なら null
 * @example
 * observeMoonrakerCfsMaterialProviderFrame({ host, payload: { boxsInfo } });
 */
export function observeMoonrakerCfsMaterialProviderFrame(options = {}, dependencies = {}) {
  const host = String(options?.host || "").trim();
  if (!host) {
    return null;
  }
  const machine = getMachineForShadow(host);
  const previous = machine?.runtimeData?.printerCoreV3Shadow || {};
  const provider = dependencies.materialProvider || cfsMoonrakerMaterialProvider;
  const receivedAt = options.receivedAt || new Date().toISOString();
  const connected = options.connected !== false;
  const previousLastState = previous.lastState && typeof previous.lastState === "object"
    ? previous.lastState
    : {};
  const hasPayload = options.payload && typeof options.payload === "object";
  const snapshotCompleteness = options.snapshotCompleteness === "complete" ? "complete" : "partial";
  const previousMaterialObservedAt = previous.materialProviderLastObservedAt ||
    previousLastState.materials?.provider?.lastObservedAt ||
    null;
  const materialProviderLastObservedAt = hasPayload
    ? receivedAt
    : previousMaterialObservedAt;
  const observedTopology = !connected && !hasPayload
    ? markMaterialTopologyStale(previousLastState.materials, receivedAt, materialProviderLastObservedAt)
    : provider.createTopology(options.payload, {
        connected,
        receivedAt,
      });
  const topology = observedTopology || provider.createTopology(null, {
    connected: false,
    receivedAt,
  });
  const providerSessionId = String(options.providerSessionId || previous.materialProviderSessionId || `material-provider:${host}`);
  const providerGeneration = String(options.providerGeneration || previous.materialProviderGeneration || providerSessionId);
  const observedMaterialTopology = hasPayload && materialProviderLastObservedAt
    ? {
        ...topology,
        provider: {
          ...(topology.provider || {}),
          lastObservedAt: materialProviderLastObservedAt,
        },
      }
    : topology;
  const materialTopology = hasPayload
    ? mergeMaterialTopologyForRuntimeDisplay(previousLastState.materials, observedMaterialTopology, snapshotCompleteness)
    : observedMaterialTopology;
  const record = {
    ...previous,
    schemaVersion: PRINTER_CORE_V3_LIVE_SHADOW_SCHEMA_VERSION,
    enabled: true,
    printerFamily: previous.printerFamily || "k1",
    host,
    deviceId: previous.deviceId || `material-provider:${encodeURIComponent(host)}`,
    sessionId: previous.sessionId || providerSessionId,
    state: connected ? (previous.state === "closed" ? "material-provider-observed" : (previous.state || "material-provider-observed")) : "material-provider-stale",
    lastObservedAt: connected ? (previous.lastObservedAt || receivedAt) : previous.lastObservedAt || receivedAt,
    materialProviderSessionId: providerSessionId,
    materialProviderGeneration: providerGeneration,
    materialProviderLastObservedAt,
    materialProviderDisconnectedAt: connected ? null : receivedAt,
    materialProviderObservedFrames: Number(previous.materialProviderObservedFrames || 0) + 1,
    lastState: {
      ...previousLastState,
      materials: materialTopology,
    },
    cfsConnected: materialTopology?.cfs?.connected ?? connected,
    cfsTopologyState: materialTopology?.cfs?.topologyState ?? (connected ? "fresh" : "stale"),
    cfsSourceCount: Array.isArray(materialTopology?.sources) ? materialTopology.sources.length : 0,
    cfsAssignmentCount: Array.isArray(materialTopology?.assignments) ? materialTopology.assignments.length : 0,
  };
  const materialObservation = observedMaterialTopology
    ? recordMaterialSourceObservationForShadow({
        host,
        deviceId: record.deviceId,
        sessionId: providerSessionId,
        topology: hasPayload
          ? observedMaterialTopology
          : {
              ...observedMaterialTopology,
              sources: [],
              assignments: [],
            },
        observedAt: hasPayload ? materialProviderLastObservedAt || receivedAt : receivedAt,
        providerGeneration,
        sequence: record.materialProviderObservedFrames,
        snapshotCompleteness: hasPayload ? snapshotCompleteness : "partial",
      })
    : null;
  record.materialSourceObservationStatus = materialObservation
    ? {
        accepted: materialObservation.accepted === true,
        reason: materialObservation.reason || null,
        changedCount: Array.isArray(materialObservation.changes) ? materialObservation.changes.length : 0,
      }
    : previous.materialSourceObservationStatus || null;
  if (machine) {
    machine.runtimeData.printerCoreV3Shadow = record;
  }
  emitMaterialTopologyUpdated(host);
  return record;
}

/**
 * K1 live shadow session を終了する。
 *
 * 【詳細説明】
 * - WebSocket close / cleanup と同じ lifecycle で呼び、Facade 側の Instance を closed にする。
 * - runtimeData は直近の観測結果を残したまま `state:"closed"` に更新する。
 *
 * @function endK1LiveShadowSession
 * @param {object} options - session 終了オプション
 * @param {string} options.host - ホスト名
 * @param {string} options.deviceId - shadow 用 deviceId
 * @param {string} options.sessionId - shadow session ID
 * @returns {boolean} active session を終了した場合 true
 * @example
 * endK1LiveShadowSession({ host, deviceId, sessionId });
 */
export function endK1LiveShadowSession(options) {
  return endPrinterCoreV3LiveShadowSession({
    ...options,
    facade: k1LiveShadowFacade,
  });
}

/**
 * K2 live shadow session を終了する。
 *
 * 【詳細説明】
 * - WebSocket close / cleanup と同じ lifecycle で呼び、K2 Facade 側の Instance を closed にする。
 * - runtimeData は直近の観測結果を残したまま `state:"closed"` に更新する。
 *
 * @function endK2LiveShadowSession
 * @param {object} options - session 終了オプション
 * @param {string} options.host - ホスト名
 * @param {string} options.deviceId - shadow 用 deviceId
 * @param {string} options.sessionId - shadow session ID
 * @returns {boolean} active session を終了した場合 true
 * @example
 * endK2LiveShadowSession({ host, deviceId, sessionId });
 */
export function endK2LiveShadowSession(options) {
  return endPrinterCoreV3LiveShadowSession({
    ...options,
    facade: k2LiveShadowFacade,
  });
}

/**
 * Printer Core v3 live shadow session を終了する。
 *
 * 【詳細説明】
 * - family 固有 Facade の session を閉じ、runtimeData の sessionId が一致する場合だけ closed 表示へ更新する。
 *
 * @private
 * @param {object} options - session 終了オプション
 * @param {string} options.host - ホスト名
 * @param {string} options.deviceId - shadow 用 deviceId
 * @param {string} options.sessionId - shadow session ID
 * @param {object} options.facade - PrinterFacade instance
 * @returns {boolean} active session を終了した場合 true
 */
function endPrinterCoreV3LiveShadowSession(options) {
  const host = String(options?.host || "").trim();
  const deviceId = String(options?.deviceId || "").trim();
  const sessionId = String(options?.sessionId || "").trim();
  if (!deviceId || !sessionId) {
    return false;
  }
  const ended = options.facade.endSession({ deviceId, sessionId });
  const machine = getMachineForShadow(host);
  const record = machine?.runtimeData?.printerCoreV3Shadow;
  if (record?.sessionId === sessionId) {
    machine.runtimeData.printerCoreV3Shadow = {
      ...record,
      state: "closed",
      closedAt: new Date().toISOString(),
    };
    emitMaterialTopologyUpdated(host);
  }
  return ended;
}
