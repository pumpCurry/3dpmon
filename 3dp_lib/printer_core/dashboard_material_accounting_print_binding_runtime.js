/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 MaterialAccounting PrintBinding runtime モジュール
 * @file dashboard_material_accounting_print_binding_runtime.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_accounting_print_binding_runtime
 *
 * 【機能内容サマリ】
 * - Gate 18.9I のprint-start binding repositoryをmonitorDataへ接続
 * - 実機で観測できたPrintJob IDを条件に、開始時点のMaterialSource/SpoolMount snapshotを保存
 * - CFS/外部スプールのsource別使用量を後続Gateで帰属するためのtrusted print-start証跡を構築
 *
 * 【公開関数一覧】
 * - {@link createMaterialAccountingPrintBindingRuntime}：print-start binding runtimeを生成
 *
 * @version 1.390.1592 (PR #440)
 * @since   1.390.1587 (PR #440)
 * @lastModified 2026-09-01 18:47:47
 * -----------------------------------------------------------
 * @todo
 * - Gate 18.9J でcompletion usage observation runtimeを接続する
 */

"use strict";

import { monitorData } from "../dashboard_data.js";
import { commitMaterialAccountingPrintBindingStoreDurably } from "../dashboard_storage.js";
import {
  createPrinterCoreV3DeterministicId,
  stableStringifyPrinterCoreV3Value,
} from "./dashboard_data_schema_v3.js";
import {
  MATERIAL_ACCOUNTING_PRINT_BINDING_STATUS,
  createMaterialAccountingPrintBindingStoreDigest,
  createTrustedPrintStartMaterialAccountingPrintBindingRepository,
  normalizeStoredMaterialAccountingPrintBindingStore,
} from "./dashboard_material_accounting_print_binding.js";
import {
  resolveObservedMaterialSourceRecord,
} from "./dashboard_material_accounting_mount_runtime.js";

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
 * storedData互換値からraw/computed/valueを順に取り出す。
 *
 * @private
 * @function readStoredDatumValue
 * @param {*} value - storedData entry候補。
 * @returns {*} 観測値候補。
 */
function readStoredDatumValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if ("rawValue" in value) return value.rawValue;
    if ("computedValue" in value) return value.computedValue;
    if ("value" in value) return value.value;
  }
  return value;
}

/**
 * 時刻候補をISO時刻へ正規化する。
 *
 * 【詳細説明】
 * - `printStartTime`系のepoch秒、epoch ms、ISO文字列の差をruntime内で吸収する。
 * - 不正値はcaller supplied evidenceとして採用せず、nullへ落とす。
 *
 * @private
 * @function normalizeObservedTime
 * @param {*} value - 時刻候補。
 * @returns {string|null} ISO時刻、またはnull。
 */
function normalizeObservedTime(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const epochMs = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return new Date(epochMs).toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * MachineDataから現在印刷中のjob観測候補を収集する。
 *
 * 【詳細説明】
 * - job IDだけではprint-start時刻がcaller suppliedになってしまうため、機器状態に付随する
 *   `startTime` / `startedAt` / `firstObservedAt` / `printStartTime`も同時に保持する。
 * - `runtimeData.printerCoreV3Shadow`にあるdevice/session観測を同じrecordへ束縛し、別機器の現在ジョブを
 *   PrintPlanの開始証跡として流用しない。
 * - 同じIDが複数経路から見える場合は、最初に得られた時刻を採用する。
 *
 * @private
 * @function collectCurrentPrintJobObservationsFromMachine
 * @param {Object|null|undefined} machine - MachineData候補。
 * @returns {Array<{printJobId:string,firstObservedAt:string|null,deviceId:string,sessionId:string,connectionGeneration:number|null}>} 現在ジョブ観測候補。
 */
function collectCurrentPrintJobObservationsFromMachine(machine) {
  const observationsById = new Map();
  const current = machine?.printStore?.current || {};
  const storedPrintStartTime = readStoredDatumValue(machine?.storedData?.printStartTime);
  const shadowRecord = machine?.runtimeData?.printerCoreV3Shadow || {};
  const deviceId = toTrimmedString(shadowRecord.deviceId || shadowRecord.printerCoreV3ShadowDeviceId);
  const sessionId = toTrimmedString(shadowRecord.sessionId || shadowRecord.printerCoreV3ShadowSessionId);
  const connectionGenerationCandidate = Number(
    shadowRecord.connectionGeneration || shadowRecord.printerCoreV3ConnectionGeneration
  );
  const connectionGeneration = Number.isFinite(connectionGenerationCandidate) && connectionGenerationCandidate > 0
    ? connectionGenerationCandidate
    : null;
  const candidates = [
    {
      id: current.id,
      observedAt: current.firstObservedAt || current.startTime || current.startedAt || current.printStartTime || storedPrintStartTime,
    },
    {
      id: current.printId,
      observedAt: current.firstObservedAt || current.startTime || current.startedAt || current.printStartTime || storedPrintStartTime,
    },
    {
      id: readStoredDatumValue(machine?.storedData?.printId),
      observedAt: storedPrintStartTime || current.firstObservedAt || current.startTime || current.startedAt,
    },
    {
      id: readStoredDatumValue(machine?.storedData?.currentPrintID),
      observedAt: storedPrintStartTime || current.firstObservedAt || current.startTime || current.startedAt,
    },
    {
      id: storedPrintStartTime,
      observedAt: storedPrintStartTime,
    },
  ];
  for (const candidate of candidates) {
    const id = toTrimmedString(candidate.id);
    if (!id || observationsById.has(id)) {
      continue;
    }
    observationsById.set(id, {
      printJobId: id,
      firstObservedAt: normalizeObservedTime(candidate.observedAt),
      deviceId,
      sessionId,
      connectionGeneration,
    });
  }
  return Array.from(observationsById.values());
}

/**
 * snapshot storeから既存のprint-start観測時刻を探す。
 *
 * @private
 * @function resolveExistingPrintStartSnapshotTime
 * @param {Object} store - print binding store。
 * @param {Object} printPlan - PrintPlan。
 * @param {string} printJobId - PrintJob ID。
 * @returns {string|null} 既存snapshot時刻。
 */
function resolveExistingPrintStartSnapshotTime(store, printPlan, printJobId) {
  const printPlanId = toTrimmedString(printPlan?.printPlanId);
  const snapshots = Array.isArray(store?.printStartSnapshots) ? store.printStartSnapshots : [];
  const match = snapshots.find((snapshot) =>
    toTrimmedString(snapshot?.printJobId) === printJobId &&
    toTrimmedString(snapshot?.printPlanId) === printPlanId &&
    normalizeObservedTime(snapshot?.capturedAt)
  );
  return normalizeObservedTime(match?.capturedAt);
}

/**
 * print-start capturedAtをtrusted observationから解決する。
 *
 * 【詳細説明】
 * - 既存snapshotがある場合はその時刻を最優先し、同一print-start retryでpayload conflictを起こさない。
 * - 既存snapshotが無い場合は機器の現在ジョブ観測に含まれるstart timeだけを採用する。
 * - caller supplied `capturedAt`はauthorityとして採用しないが、不正な明示値は入力汚染として拒否する。
 *
 * @private
 * @function resolveTrustedPrintStartCapturedAt
 * @param {Object} previousStore - 記録前store。
 * @param {Object} printPlan - PrintPlan。
 * @param {{printJobId:string,firstObservedAt:string|null}} printJobResolution - PrintJob解決結果。
 * @param {Object} request - runtime request。
 * @returns {{ok:boolean,capturedAt:string|null,reasons:string[]}} capturedAt解決結果。
 */
function resolveTrustedPrintStartCapturedAt(previousStore, printPlan, printJobResolution, request) {
  if (Object.prototype.hasOwnProperty.call(request, "capturedAt") &&
      request.capturedAt !== null &&
      request.capturedAt !== undefined &&
      request.capturedAt !== "" &&
      !normalizeObservedTime(request.capturedAt)) {
    return { ok: false, capturedAt: null, reasons: ["observed-print-start-time-invalid"] };
  }
  const existingCapturedAt = resolveExistingPrintStartSnapshotTime(previousStore, printPlan, printJobResolution.printJobId);
  if (existingCapturedAt) {
    return { ok: true, capturedAt: existingCapturedAt, reasons: [] };
  }
  if (printJobResolution.firstObservedAt) {
    return { ok: true, capturedAt: printJobResolution.firstObservedAt, reasons: [] };
  }
  return { ok: false, capturedAt: null, reasons: ["observed-print-start-time-required"] };
}

/**
 * runtime process内の初回観測時刻cacheを生成する。
 *
 * @private
 * @function createFirstObservedAtCache
 * @returns {Map<string,string>} cache。
 */
function createFirstObservedAtCache() {
  return new Map();
}

/**
 * runtime cacheから安定したfirstObservedAtを取得する。
 *
 * @private
 * @function getCachedFirstObservedAt
 * @param {Map<string,string>} cache - process lifetime cache。
 * @param {Object} printPlan - PrintPlan。
 * @param {string} printJobId - PrintJob ID。
 * @param {string} observedAt - 観測時刻。
 * @returns {string} 安定化済み初回観測時刻。
 */
function getCachedFirstObservedAt(cache, printPlan, printJobId, observedAt) {
  const key = stableStringifyPrinterCoreV3Value({
    deviceId: printPlan?.deviceId || null,
    printPlanId: printPlan?.printPlanId || null,
    printJobId,
  });
  if (!cache.has(key)) {
    cache.set(key, observedAt);
  }
  return cache.get(key);
}

/**
 * 実機観測済みPrintJobを解決する。
 *
 * 【詳細説明】
 * - `hostname`が指定された場合は、その機器の現在ジョブ観測だけを見る。
 * - `request.printJobId`は期待値として扱い、実機観測集合と一致した場合だけ採用する。
 * - hostname未指定で複数候補がある場合は曖昧なので採用しない。
 *
 * @private
 * @function resolveObservedPrintJob
 * @param {Object} data - monitorData互換データ。
 * @param {Object} request - runtime request。
 * @returns {{ok:boolean,printJobId:string,firstObservedAt:string|null,deviceId:string,sessionId:string,connectionGeneration:number|null,reasons:string[],observedPrintJobIds:string[]}} 解決結果。
 */
function resolveObservedPrintJob(data, request) {
  const requestedPrintJobId = toTrimmedString(request.printJobId || request.observedPrintJobId);
  const hostname = toTrimmedString(request.hostname || request.host);
  const expectedDeviceId = toTrimmedString(request.printPlan?.deviceId || request.deviceId);
  const expectedSessionId = toTrimmedString(request.sessionId || request.expectedSessionId);
  const expectedConnectionGeneration = Number(request.connectionGeneration || request.expectedConnectionGeneration || 0);
  const machines = data?.machines && typeof data.machines === "object" ? data.machines : {};
  const machineEntries = hostname
    ? [[hostname, machines[hostname]]]
    : Object.entries(machines);
  const observations = [];
  for (const [, machine] of machineEntries) {
    for (const observation of collectCurrentPrintJobObservationsFromMachine(machine)) {
      observations.push(observation);
    }
  }
  const observedIds = [...new Set(observations.map((observation) => observation.printJobId))];
  const validateObservation = (observation) => {
    if (!observation.deviceId) {
      return "observed-print-device-required";
    }
    if (expectedDeviceId && observation.deviceId !== expectedDeviceId) {
      return "observed-print-device-mismatch";
    }
    if (!observation.sessionId) {
      return "observed-print-session-required";
    }
    if (expectedSessionId && observation.sessionId !== expectedSessionId) {
      return "observed-print-session-mismatch";
    }
    if (expectedConnectionGeneration > 0) {
      if (observation.connectionGeneration === null) {
        return "observed-print-connection-generation-required";
      }
      if (observation.connectionGeneration !== expectedConnectionGeneration) {
        return "observed-print-connection-generation-mismatch";
      }
    }
    return null;
  };
  const createOkResolution = (observation) => ({
    ok: true,
    printJobId: observation.printJobId,
    firstObservedAt: observation.firstObservedAt,
    deviceId: observation.deviceId,
    sessionId: observation.sessionId,
    connectionGeneration: observation.connectionGeneration,
    reasons: [],
    observedPrintJobIds: observedIds,
  });
  if (requestedPrintJobId) {
    const matchingObservations = observations.filter((observation) => observation.printJobId === requestedPrintJobId);
    for (const observation of matchingObservations) {
      const rejectionReason = validateObservation(observation);
      if (!rejectionReason) {
        return createOkResolution(observation);
      }
    }
    const rejectionReasons = matchingObservations
      .map((observation) => validateObservation(observation))
      .filter(Boolean);
    return {
      ok: false,
      printJobId: "",
      firstObservedAt: null,
      deviceId: "",
      sessionId: "",
      connectionGeneration: null,
      reasons: observedIds.length > 0
        ? (rejectionReasons.length > 0 ? [...new Set(rejectionReasons)] : ["observed-print-job-id-mismatch"])
        : ["observed-print-job-id-required"],
      observedPrintJobIds: observedIds,
    };
  }
  const validObservations = [];
  const rejectionReasons = [];
  for (const observation of observations) {
    const rejectionReason = validateObservation(observation);
    if (rejectionReason) {
      rejectionReasons.push(rejectionReason);
      continue;
    }
    validObservations.push(observation);
  }
  const uniqueValidIds = [...new Set(validObservations.map((observation) => observation.printJobId))];
  if (uniqueValidIds.length === 1) {
    const observation = validObservations.find((entry) => entry.printJobId === uniqueValidIds[0]);
    return createOkResolution(observation);
  }
  return {
    ok: false,
    printJobId: "",
    firstObservedAt: null,
    deviceId: "",
    sessionId: "",
    connectionGeneration: null,
    reasons: uniqueValidIds.length > 1
      ? ["observed-print-job-id-ambiguous"]
      : (rejectionReasons.length > 0 ? [...new Set(rejectionReasons)] : ["observed-print-job-id-required"]),
    observedPrintJobIds: observedIds,
  };
}

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
 * binding operation IDを生成する。
 *
 * @private
 * @function createBindingOperationId
 * @param {Object} printPlan - PrintPlan。
 * @param {string} printJobId - 実機で観測したPrintJob ID。
 * @returns {string} deterministic operation ID。
 */
function createBindingOperationId(printPlan, printJobId) {
  return `binding:${createPrinterCoreV3DeterministicId("material-print-start-binding-runtime", [
    stableStringifyPrinterCoreV3Value({
      printJobId,
      printPlanId: printPlan?.printPlanId || null,
      deviceId: printPlan?.deviceId || null,
    }),
  ])}`;
}

/**
 * runtime用の失敗結果を生成する。
 *
 * @private
 * @function createBlockedResult
 * @param {string[]} reasons - 失敗理由。
 * @param {Object} store - 現在store。
 * @param {Object=} extra - 追加フィールド。
 * @returns {Object} runtime result。
 */
function createBlockedResult(reasons, store, extra = {}) {
  return Object.freeze({
    ok: false,
    status: MATERIAL_ACCOUNTING_PRINT_BINDING_STATUS.BLOCKED,
    action: "blocked",
    reasons: [...new Set(reasons.filter(Boolean))],
    snapshots: [],
    store: cloneJsonValue(store),
    ...extra,
  });
}

/**
 * PrintPlanで参照されるMaterialSourceを現在観測storeから解決する。
 *
 * 【詳細説明】
 * - `printPlan.deviceId`を必ずscopeに使い、同じraw aliasが別deviceへ存在しても混線させない。
 * - repositoryへ渡すsource配列はcanonical MaterialSource IDで重複排除する。
 *
 * @private
 * @function collectMaterialSourcesForPrintPlan
 * @param {Object} data - monitorData互換データ。
 * @param {Object} printPlan - PrintPlan。
 * @returns {Object[]} MaterialSource record配列。
 */
function collectMaterialSourcesForPrintPlan(data, printPlan) {
  const byCanonicalId = new Map();
  const assignments = Array.isArray(printPlan?.toolAssignments) ? printPlan.toolAssignments : [];
  for (const assignment of assignments) {
    const sourceId = toTrimmedString(assignment?.materialSourceId);
    if (!sourceId) {
      continue;
    }
    const source = resolveObservedMaterialSourceRecord({
      materialSourceObservations: data.materialSourceObservations,
      deviceId: printPlan.deviceId,
      materialSourceId: sourceId,
    });
    if (source?.materialSourceId && !byCanonicalId.has(source.materialSourceId)) {
      byCanonicalId.set(source.materialSourceId, source);
    }
  }
  return Array.from(byCanonicalId.values());
}

/**
 * SpoolMount storeからmount配列を正規化して取得する。
 *
 * @private
 * @function getCurrentSpoolMounts
 * @param {Object} data - monitorData互換データ。
 * @returns {Object[]} SpoolMount配列。
 */
function getCurrentSpoolMounts(data) {
  const store = data.materialAccountingSpoolMountStore;
  return Array.isArray(store?.spoolMounts) ? store.spoolMounts : [];
}

/**
 * 既定の永続化処理を実行する。
 *
 * 【詳細説明】
 * - print binding storeは後続のsource-specific usage attribution根拠になるため、通常flush queueではなく
 *   専用IndexedDB CAS commitが成功した場合だけruntime storeを進める。
 * - IndexedDB未使用やCAS不一致は成功扱いせず、callerへblockedとして返す。
 *
 * @private
 * @function persistPrintBindingStoreWithUnifiedStorage
 * @param {Object} input - 永続化入力。
 * @param {Object} input.data - monitorData互換データ。
 * @param {Object} input.nextStore - 保存するstore。
 * @returns {Promise<Object>} 永続化結果。
 */
async function persistPrintBindingStoreWithUnifiedStorage(input = {}) {
  const previousStore = normalizeStoredMaterialAccountingPrintBindingStore(input.previousStore);
  const nextStore = normalizeStoredMaterialAccountingPrintBindingStore(input.nextStore);
  return commitMaterialAccountingPrintBindingStoreDurably({
    baseStoreDigest: createMaterialAccountingPrintBindingStoreDigest(previousStore),
    nextStore,
  });
}

/**
 * 永続化結果を成功扱いできるか判定する。
 *
 * @private
 * @function isPersistOk
 * @param {*} result - 永続化戻り値。
 * @returns {boolean} 成功扱いできる場合true。
 */
function isPersistOk(result) {
  return Boolean(result && typeof result === "object" && result.ok === true && result.casApplied === true);
}

/**
 * MaterialAccounting PrintBinding runtimeを生成する。
 *
 * 【詳細説明】
 * - repository自体はpureなshadow storeとして維持し、runtimeだけがmonitorDataと保存処理を知る。
 * - 実機から観測したPrintJob IDが無い、またはcaller指定IDと実機観測IDが一致しない段階ではbindingを記録しない。
 * - 記録対象はprint-start時点のsnapshotだけであり、spool残量debitやlegacy hostSpoolMap更新は行わない。
 *
 * @function createMaterialAccountingPrintBindingRuntime
 * @param {Object=} input - runtime入力。
 * @param {Object=} input.data - monitorData互換データ。未指定なら実monitorData。
 * @param {Function=} input.persist - 永続化関数。未指定ならunified storageへ保存。
 * @returns {{recordObservedPrintStart:Function,snapshot:Function}} runtime API。
 * @example
 * const runtime = createMaterialAccountingPrintBindingRuntime();
 * await runtime.recordObservedPrintStart({ printPlan, printJobId });
 */
export function createMaterialAccountingPrintBindingRuntime(input = {}) {
  const data = input.data || monitorData;
  const persist = typeof input.persist === "function"
    ? input.persist
    : (request) => persistPrintBindingStoreWithUnifiedStorage({ ...request, data });
  const firstObservedAtCache = createFirstObservedAtCache();

  /**
   * 現在のprint binding store snapshotを返す。
   *
   * @function snapshot
   * @returns {Object} 正規化済みprint binding store。
   */
  function snapshot() {
    return normalizeStoredMaterialAccountingPrintBindingStore(data.materialAccountingPrintBindingStore);
  }

  /**
   * 実機で観測したprint-startをsource別SpoolMount snapshotへ固定する。
   *
   * @function recordObservedPrintStart
   * @param {Object} request - 記録要求。
   * @param {Object} request.printPlan - 実行したPrintPlan。
   * @param {string=} request.printJobId - 実機で観測したPrintJob ID。
   * @param {string=} request.observedPrintJobId - 実機で観測したPrintJob IDの別名。
   * @param {string|Date=} request.capturedAt - print-start観測時刻。
   * @param {string=} request.bindingOperationId - idempotency用operation ID。
   * @returns {Promise<Object>} runtime result。
   */
  async function recordObservedPrintStart(request = {}) {
    const previousStore = snapshot();
    const printPlan = request.printPlan;
    const printJobResolution = resolveObservedPrintJob(data, request);
    if (!printJobResolution.ok) {
      return createBlockedResult(printJobResolution.reasons, previousStore, {
        observedPrintJobIds: printJobResolution.observedPrintJobIds,
      });
    }
    const printJobId = printJobResolution.printJobId;
    const capturedAtResolution = resolveTrustedPrintStartCapturedAt(previousStore, printPlan, printJobResolution, request);
    if (!capturedAtResolution.ok) {
      return createBlockedResult(capturedAtResolution.reasons, previousStore, {
        observedPrintJobIds: printJobResolution.observedPrintJobIds,
      });
    }
    const capturedAt = getCachedFirstObservedAt(firstObservedAtCache, printPlan, printJobId, capturedAtResolution.capturedAt);
    const bindingOperationId = toTrimmedString(request.bindingOperationId) ||
      createBindingOperationId(printPlan, printJobId);
    const repository = createTrustedPrintStartMaterialAccountingPrintBindingRepository(previousStore);
    const materialSources = collectMaterialSourcesForPrintPlan(data, printPlan);
    const result = repository.recordPrintStartBindings({
      printPlan,
      printJobId,
      materialSources,
      spoolMounts: getCurrentSpoolMounts(data),
      capturedAt,
      bindingOperationId,
    });
    if (!result.ok) {
      return {
        ...result,
        store: cloneJsonValue(previousStore),
      };
    }
    const nextStore = repository.toJSON();
    const persistResult = await persist({
      previousStore,
      nextStore,
      result,
      request: {
        printPlan,
        printJobId,
        capturedAt,
        bindingOperationId,
        observedDeviceId: printJobResolution.deviceId,
        observedSessionId: printJobResolution.sessionId,
        observedConnectionGeneration: printJobResolution.connectionGeneration,
      },
    });
    if (!isPersistOk(persistResult)) {
      return createBlockedResult(
        [...(Array.isArray(result.reasons) ? result.reasons : []), "print-binding-persist-failed"],
        previousStore,
        { persistResult }
      );
    }
    data.materialAccountingPrintBindingStore =
      normalizeStoredMaterialAccountingPrintBindingStore(nextStore);
    return {
      ...result,
      persistResult,
      store: cloneJsonValue(data.materialAccountingPrintBindingStore),
    };
  }

  return Object.freeze({
    recordObservedPrintStart,
    snapshot,
  });
}
