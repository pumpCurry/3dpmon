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
 * - 印刷完了履歴からsource-specific usageをshadow ledgerへCAS保存
 *
 * 【公開関数一覧】
 * - {@link createMaterialAccountingPrintBindingRuntime}：print-start/completion binding runtimeを生成
 *
 * @version 1.390.1597 (PR #440)
 * @since   1.390.1587 (PR #440)
 * @lastModified 2026-09-01 19:56:42
 * -----------------------------------------------------------
 * @todo
 * - Gate 18.9J でmanaged spool残量debitとItemKeeper projectionを接続する
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
import { deriveMaterialSourceObservationFreshness } from "./dashboard_material_source_observation.js";

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
 * 完了履歴entryが成功完了として扱えるか判定する。
 *
 * 【詳細説明】
 * - K1/K2/IR3互換履歴は`printfinish`、`status`、`finishTime`の揺れを持つ。
 * - 完了時source usage runtimeでは、履歴上の完了シグナルが無いentryをcaller補完だけで採用しない。
 *
 * @private
 * @function isCompletedHistoryEntry
 * @param {Object|null|undefined} entry - printStore.history entry候補。
 * @returns {boolean} 完了履歴として扱える場合true。
 */
function isCompletedHistoryEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  if (Number(entry.printfinish) === 1) {
    return true;
  }
  const status = toTrimmedString(entry.status || entry.result || entry.state).toLowerCase();
  if (["completed", "complete", "success", "succeeded", "done"].includes(status)) {
    return true;
  }
  return !!normalizeObservedTime(entry.finishTime || entry.endTime || entry.completedAt || entry.endtime);
}

/**
 * 完了履歴entryからPrintJob IDを解決する。
 *
 * @private
 * @function resolveHistoryPrintJobId
 * @param {Object|null|undefined} entry - printStore.history entry候補。
 * @returns {string} PrintJob ID。
 */
function resolveHistoryPrintJobId(entry) {
  return toTrimmedString(entry?.id || entry?.printId || entry?.printStartTime || entry?.starttime);
}

/**
 * 完了履歴entryから完了観測時刻を解決する。
 *
 * @private
 * @function resolveHistoryCompletedAt
 * @param {Object|null|undefined} entry - printStore.history entry候補。
 * @returns {string|null} 完了時刻。
 */
function resolveHistoryCompletedAt(entry) {
  return normalizeObservedTime(entry?.finishTime || entry?.endTime || entry?.completedAt || entry?.endtime);
}

/**
 * MachineDataから完了済みjob観測候補を収集する。
 *
 * 【詳細説明】
 * - 完了時には`printStore.current`が消えている場合があるため、永続履歴の完了entryをauthorityにする。
 * - device/session/generationは現在接続中のPrinter Core v3 shadow recordから束縛し、別機器履歴の流用を防ぐ。
 *
 * @private
 * @function collectCompletedPrintJobObservationsFromMachine
 * @param {Object|null|undefined} machine - MachineData候補。
 * @returns {Array<{printJobId:string,completedAt:string|null,deviceId:string,sessionId:string,connectionGeneration:number|null,historyEntry:Object}>} 完了job観測候補。
 */
function collectCompletedPrintJobObservationsFromMachine(machine) {
  const shadowRecord = machine?.runtimeData?.printerCoreV3Shadow || {};
  const deviceId = toTrimmedString(shadowRecord.deviceId || shadowRecord.printerCoreV3ShadowDeviceId);
  const sessionId = toTrimmedString(shadowRecord.sessionId || shadowRecord.printerCoreV3ShadowSessionId);
  const connectionGenerationCandidate = Number(
    shadowRecord.connectionGeneration || shadowRecord.printerCoreV3ConnectionGeneration
  );
  const connectionGeneration = Number.isFinite(connectionGenerationCandidate) && connectionGenerationCandidate > 0
    ? connectionGenerationCandidate
    : null;
  const observations = [];
  for (const entry of Array.isArray(machine?.printStore?.history) ? machine.printStore.history : []) {
    if (!isCompletedHistoryEntry(entry)) {
      continue;
    }
    const printJobId = resolveHistoryPrintJobId(entry);
    if (!printJobId) {
      continue;
    }
    observations.push({
      printJobId,
      completedAt: resolveHistoryCompletedAt(entry),
      deviceId,
      sessionId,
      connectionGeneration,
      historyEntry: entry,
    });
  }
  return observations;
}

/**
 * 実機観測済み完了PrintJobを解決する。
 *
 * 【詳細説明】
 * - `request.printJobId`は期待値として扱い、履歴に完了済みjobが観測された場合だけ採用する。
 * - session/generationはprint-start runtimeと同じく、send-time側が束縛した場合に照合する。
 *
 * @private
 * @function resolveObservedCompletedPrintJob
 * @param {Object} data - monitorData互換データ。
 * @param {Object} request - runtime request。
 * @returns {{ok:boolean,printJobId:string,completedAt:string|null,deviceId:string,sessionId:string,connectionGeneration:number|null,reasons:string[],observedPrintJobIds:string[],historyEntry:Object|null}} 解決結果。
 */
function resolveObservedCompletedPrintJob(data, request) {
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
    observations.push(...collectCompletedPrintJobObservationsFromMachine(machine));
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
    if (!observation.completedAt) {
      return "observed-print-completed-time-required";
    }
    return null;
  };
  const createOkResolution = (observation) => ({
    ok: true,
    printJobId: observation.printJobId,
    completedAt: observation.completedAt,
    deviceId: observation.deviceId,
    sessionId: observation.sessionId,
    connectionGeneration: observation.connectionGeneration,
    reasons: [],
    observedPrintJobIds: observedIds,
    historyEntry: observation.historyEntry,
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
      completedAt: null,
      deviceId: "",
      sessionId: "",
      connectionGeneration: null,
      reasons: observations.length > 0
        ? (rejectionReasons.length > 0 ? [...new Set(rejectionReasons)] : ["observed-print-completion-required"])
        : ["observed-print-completion-required"],
      observedPrintJobIds: observedIds,
      historyEntry: null,
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
    completedAt: null,
    deviceId: "",
    sessionId: "",
    connectionGeneration: null,
    reasons: uniqueValidIds.length > 1
      ? ["observed-print-job-id-ambiguous"]
      : (rejectionReasons.length > 0 ? [...new Set(rejectionReasons)] : ["observed-print-completion-required"]),
    observedPrintJobIds: observedIds,
    historyEntry: null,
  };
}

/**
 * 保存済みprint-start snapshotを安定順へ整列する。
 *
 * @private
 * @function getOrderedPrintStartSnapshots
 * @param {Object} store - print binding store。
 * @param {Object} printPlan - PrintPlan。
 * @param {string} printJobId - PrintJob ID。
 * @returns {Object[]} order昇順のprint-start snapshot配列。
 */
function getOrderedPrintStartSnapshots(store, printPlan, printJobId) {
  const planId = toTrimmedString(printPlan?.printPlanId);
  return (Array.isArray(store?.printStartSnapshots) ? store.printStartSnapshots : [])
    .filter((snapshot) =>
      toTrimmedString(snapshot?.printJobId) === printJobId &&
      toTrimmedString(snapshot?.printPlanId) === planId
    )
    .sort((a, b) => {
      const orderA = Number.isFinite(Number(a?.order)) ? Number(a.order) : 0;
      const orderB = Number.isFinite(Number(b?.order)) ? Number(b.order) : 0;
      if (orderA !== orderB) return orderA - orderB;
      return toTrimmedString(a?.snapshotId).localeCompare(toTrimmedString(b?.snapshotId));
    });
}

/**
 * K2/Creality形式のsource別使用量文字列を保存済みsnapshot基準のMaterialUsage配列へ変換する。
 *
 * 【詳細説明】
 * - `materialUsed:"3210,6543"` はprint-start時点で固定したsnapshot orderへ対応付ける。
 * - completion時callerが渡すPrintPlan assignmentは、source mapping authorityとして採用しない。
 * - CSV値数とsnapshot数が一致しない場合は、余剰値を黙って捨てずBLOCK理由を返す。
 *
 * @private
 * @function parseMaterialUsagesFromHistoryEntry
 * @param {Object|null|undefined} historyEntry - printStore.history entry。
 * @param {Object[]} orderedSnapshots - order昇順のprint-start snapshot配列。
 * @returns {{ok:boolean,materialUsages:Object[],rawMaterialUsed:string,parserVersion:string,reasons:string[]}} source-specific usage候補。
 */
function parseMaterialUsagesFromHistoryEntry(historyEntry, orderedSnapshots) {
  const raw = toTrimmedString(
    historyEntry?.materialUsed ||
    historyEntry?.materialUsedSourceCsv ||
    historyEntry?.sourceMaterialUsedCsv ||
    historyEntry?.raw?.materialUsed ||
    historyEntry?.materialUsedCsv ||
    historyEntry?.sourceMaterialUsed
  );
  const snapshots = Array.isArray(orderedSnapshots) ? orderedSnapshots : [];
  const parserVersion = "k2-material-used-csv:snapshot-order:v1";
  if (!raw) {
    return {
      ok: false,
      materialUsages: [],
      rawMaterialUsed: "",
      parserVersion,
      reasons: snapshots.length > 1 ? ["observed-material-used-required"] : [],
    };
  }
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const reasons = [];
  if (parts.length !== snapshots.length) {
    reasons.push("material-used-source-count-mismatch");
  }
  const materialUsages = parts
    .map((part, index) => ({ part, snapshot: snapshots[index] }))
    .filter(({ snapshot }) => snapshot)
    .map(({ part, snapshot }) => ({
      toolId: snapshot.toolId,
      protocolToolAlias: snapshot.protocolToolAlias || snapshot.toolAlias,
      materialSourceId: snapshot.materialSourceId,
      usedLengthMm: Number(part),
      source: "firmware-source-specific",
    }))
    .filter((entry) => {
      const valid = Number.isFinite(entry.usedLengthMm) && entry.usedLengthMm >= 0;
      if (!valid) {
        reasons.push("usage-length-invalid");
      }
      return valid;
    });
  return {
    ok: reasons.length === 0,
    materialUsages,
    rawMaterialUsed: raw,
    parserVersion,
    reasons: [...new Set(reasons)],
  };
}

/**
 * completion時点でruntime所有のsource continuity evidenceを作る。
 *
 * 【詳細説明】
 * - caller supplied continuityをtrusted debit候補へ使わないため、現在のMaterialSource観測storeを読む。
 * - provisional sourceは、同一device/sourceが最新観測に残っていてproviderがstaleでない場合だけ
 *   `freshTopology/sourceContinuity`をtrueにする。
 *
 * @private
 * @function buildRuntimeContinuityBySourceId
 * @param {Object} data - monitorData互換データ。
 * @param {Object[]} orderedSnapshots - print-start snapshot配列。
 * @param {string|null=} completedAt - 完了観測時刻。
 * @returns {Object<string,Object>} source ID別continuity evidence。
 */
function buildRuntimeContinuityBySourceId(data, orderedSnapshots, completedAt = null) {
  const continuityBySourceId = {};
  for (const snapshot of Array.isArray(orderedSnapshots) ? orderedSnapshots : []) {
    const sourceId = toTrimmedString(snapshot?.materialSourceId);
    const deviceId = toTrimmedString(snapshot?.deviceId);
    if (!sourceId || !deviceId) {
      continue;
    }
    const deviceRecord = data?.materialSourceObservations?.byDeviceId?.[deviceId] || {};
    const observedSource = resolveObservedMaterialSourceRecord({
      materialSourceObservations: data?.materialSourceObservations,
      deviceId,
      materialSourceId: sourceId,
    });
    const freshness = deriveMaterialSourceObservationFreshness(deviceRecord, {
      now: completedAt || new Date().toISOString(),
    });
    const freshTopology = !!observedSource && freshness.state === "fresh";
    continuityBySourceId[sourceId] = {
      sourceContinuity: freshTopology,
      freshTopology,
      observedAt: normalizeObservedTime(deviceRecord.lastObservedAt) || null,
      freshness,
      source: "runtime-material-source-observation",
    };
  }
  return continuityBySourceId;
}

/**
 * 完了履歴entryからtotal使用量を、観測済みの場合だけ取り出す。
 *
 * 【詳細説明】
 * - `parseRawHistoryEntry()` は未観測totalを `materialUsedMm:0` として互換保持するため、
 *   `materialUsedTotalObserved === false` の場合は0mm authorityとして扱わない。
 *
 * @private
 * @function resolveObservedTotalUsedLengthMm
 * @param {Object|null|undefined} historyEntry - 完了履歴entry。
 * @returns {number|undefined} 観測済みtotal使用量、またはundefined。
 */
function resolveObservedTotalUsedLengthMm(historyEntry) {
  if (historyEntry?.materialUsedTotalObserved === false) {
    return undefined;
  }
  return historyEntry?.materialUsedMm ??
    historyEntry?.usagematerial ??
    historyEntry?.usedMaterialLength;
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
      issuanceEvidence: {
        source: "printer-core-print-binding-runtime",
        deviceId: printJobResolution.deviceId,
        sessionId: printJobResolution.sessionId,
        connectionGeneration: printJobResolution.connectionGeneration,
        printJobId,
        firstObservedAt: capturedAt,
      },
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

  /**
   * 実機で観測したprint completionをsource-specific usageへ固定する。
   *
   * 【詳細説明】
   * - 保存済みtrusted print-start snapshotを基準にし、完了時点のcurrent mountへ後付け帰属しない。
   * - 完了履歴が機器から観測できない場合はcaller supplied `completedAt`だけでは保存しない。
   * - このGateではshadow ledger eventを保存するだけで、既存`usageHistory`やスプール残量は更新しない。
   *
   * @function recordObservedPrintCompletion
   * @param {Object} request - 記録要求。
   * @param {Object} request.printPlan - 実行したPrintPlan。
   * @param {string=} request.printJobId - 完了したPrintJob ID。
   * @param {Object[]=} request.materialUsages - source-specific usage期待値またはテスト用観測候補。trusted authorityには採用しない。
   * @param {number=} request.totalUsedLengthMm - total-only usage期待値。trusted authorityには採用しない。
   * @param {"complete"|"partial"=} request.resultSetCompleteness - source-specific結果集合の完全性。
   * @param {Object<string,Object>=} request.continuityBySourceId - source continuity期待値。trusted authorityには採用しない。
   * @returns {Promise<Object>} runtime result。
   */
  async function recordObservedPrintCompletion(request = {}) {
    const previousStore = snapshot();
    const printPlan = request.printPlan;
    const completionResolution = resolveObservedCompletedPrintJob(data, request);
    if (!completionResolution.ok) {
      return createBlockedResult(completionResolution.reasons, previousStore, {
        observedPrintJobIds: completionResolution.observedPrintJobIds,
      });
    }
    if (Object.prototype.hasOwnProperty.call(request, "completedAt") &&
        request.completedAt !== null &&
        request.completedAt !== undefined &&
        request.completedAt !== "" &&
        !normalizeObservedTime(request.completedAt)) {
      return createBlockedResult(["observed-print-completed-time-invalid"], previousStore, {
        observedPrintJobIds: completionResolution.observedPrintJobIds,
      });
    }
    const printJobId = completionResolution.printJobId;
    const completedAt = completionResolution.completedAt;
    const repository = createTrustedPrintStartMaterialAccountingPrintBindingRepository(previousStore);
    const orderedSnapshots = getOrderedPrintStartSnapshots(previousStore, printPlan, printJobId);
    const usageSet = parseMaterialUsagesFromHistoryEntry(completionResolution.historyEntry, orderedSnapshots);
    if (!usageSet.ok) {
      return createBlockedResult(usageSet.reasons, previousStore, {
        observedPrintJobIds: completionResolution.observedPrintJobIds,
        rawMaterialUsed: usageSet.rawMaterialUsed,
        parserVersion: usageSet.parserVersion,
      });
    }
    const materialUsages = usageSet.materialUsages;
    const attributionOperationId = toTrimmedString(request.attributionOperationId) ||
      `usage:${createPrinterCoreV3DeterministicId("material-usage-attribution-runtime", [
        stableStringifyPrinterCoreV3Value({
          printJobId,
          printPlanId: printPlan?.printPlanId || null,
          deviceId: printPlan?.deviceId || null,
        }),
      ])}`;
    const totalUsedLengthMm = resolveObservedTotalUsedLengthMm(completionResolution.historyEntry);
    const inferredResultSetCompleteness = materialUsages.length > 0 &&
      materialUsages.length === orderedSnapshots.length
      ? "complete"
      : "partial";
    const result = repository.recordUsageAttribution({
      printPlan,
      printJobId,
      completedAt,
      attributionOperationId,
      materialUsages,
      totalUsedLengthMm,
      resultSetCompleteness: request.resultSetCompleteness === "complete" ? inferredResultSetCompleteness : "partial",
      resultSetCompletenessEvidence: request.resultSetCompletenessEvidence,
      continuityBySourceId: buildRuntimeContinuityBySourceId(data, orderedSnapshots, completedAt),
    });
    if (!result.ok && result.status !== MATERIAL_ACCOUNTING_PRINT_BINDING_STATUS.PENDING) {
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
        completedAt,
        attributionOperationId,
        observedDeviceId: completionResolution.deviceId,
        observedSessionId: completionResolution.sessionId,
        observedConnectionGeneration: completionResolution.connectionGeneration,
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
    recordObservedPrintCompletion,
    recordObservedPrintStart,
    snapshot,
  });
}
