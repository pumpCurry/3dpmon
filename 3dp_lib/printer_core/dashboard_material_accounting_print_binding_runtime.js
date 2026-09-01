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
 * - CFS/外部スプールのsource別使用量を後続Gateで帰属するためのshadow証跡を構築
 *
 * 【公開関数一覧】
 * - {@link createMaterialAccountingPrintBindingRuntime}：print-start binding runtimeを生成
 *
 * @version 1.390.1589 (PR #440)
 * @since   1.390.1587 (PR #440)
 * @lastModified 2026-09-01 18:15:11
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
  createMaterialAccountingPrintBindingRepository,
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
 * MachineDataから現在印刷中のjob ID候補を収集する。
 *
 * 【詳細説明】
 * - print-start bindingは実機観測済みジョブだけを根拠にするため、caller引数だけを採用しない。
 * - K1/K2で観測位置が異なるため、`printStore.current.id`と`storedData.printId`の両方を読む。
 *
 * @private
 * @function collectCurrentPrintJobIdsFromMachine
 * @param {Object|null|undefined} machine - MachineData候補。
 * @returns {string[]} 現在ジョブID候補。
 */
function collectCurrentPrintJobIdsFromMachine(machine) {
  const ids = [];
  const candidates = [
    machine?.printStore?.current?.id,
    machine?.printStore?.current?.printId,
    readStoredDatumValue(machine?.storedData?.printId),
    readStoredDatumValue(machine?.storedData?.currentPrintID),
  ];
  for (const candidate of candidates) {
    const id = toTrimmedString(candidate);
    if (id && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * 実機観測済みPrintJob IDを解決する。
 *
 * 【詳細説明】
 * - `hostname`が指定された場合は、その機器の現在ジョブ観測だけを見る。
 * - `request.printJobId`は期待値として扱い、実機観測集合と一致した場合だけ採用する。
 * - hostname未指定で複数候補がある場合は曖昧なので採用しない。
 *
 * @private
 * @function resolveObservedPrintJobId
 * @param {Object} data - monitorData互換データ。
 * @param {Object} request - runtime request。
 * @returns {{ok:boolean,printJobId:string,reasons:string[],observedPrintJobIds:string[]}} 解決結果。
 */
function resolveObservedPrintJobId(data, request) {
  const requestedPrintJobId = toTrimmedString(request.printJobId || request.observedPrintJobId);
  const hostname = toTrimmedString(request.hostname || request.host);
  const machines = data?.machines && typeof data.machines === "object" ? data.machines : {};
  const machineEntries = hostname
    ? [[hostname, machines[hostname]]]
    : Object.entries(machines);
  const observedIds = [];
  for (const [, machine] of machineEntries) {
    for (const id of collectCurrentPrintJobIdsFromMachine(machine)) {
      if (!observedIds.includes(id)) {
        observedIds.push(id);
      }
    }
  }
  if (requestedPrintJobId) {
    if (observedIds.includes(requestedPrintJobId)) {
      return { ok: true, printJobId: requestedPrintJobId, reasons: [], observedPrintJobIds: observedIds };
    }
    return {
      ok: false,
      printJobId: "",
      reasons: observedIds.length > 0
        ? ["observed-print-job-id-mismatch"]
        : ["observed-print-job-id-required"],
      observedPrintJobIds: observedIds,
    };
  }
  if (observedIds.length === 1) {
    return { ok: true, printJobId: observedIds[0], reasons: [], observedPrintJobIds: observedIds };
  }
  return {
    ok: false,
    printJobId: "",
    reasons: observedIds.length > 1
      ? ["observed-print-job-id-ambiguous"]
      : ["observed-print-job-id-required"],
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
 * ISO時刻を生成または正規化する。
 *
 * @private
 * @function resolveCapturedAt
 * @param {string|Date|null|undefined} value - 時刻候補。
 * @param {Function|null} now - 現在時刻関数。
 * @returns {string} ISO時刻。
 */
function resolveCapturedAt(value, now) {
  const explicit = Date.parse(value);
  if (Number.isFinite(explicit)) {
    return new Date(explicit).toISOString();
  }
  const current = typeof now === "function" ? now() : new Date();
  const currentEpoch = Date.parse(current);
  return Number.isFinite(currentEpoch) ? new Date(currentEpoch).toISOString() : new Date().toISOString();
}

/**
 * binding operation IDを生成する。
 *
 * @private
 * @function createBindingOperationId
 * @param {Object} printPlan - PrintPlan。
 * @param {string} printJobId - 実機で観測したPrintJob ID。
 * @param {string} capturedAt - print-start観測時刻。
 * @returns {string} deterministic operation ID。
 */
function createBindingOperationId(printPlan, printJobId, capturedAt) {
  return `binding:${createPrinterCoreV3DeterministicId("material-print-start-binding-runtime", [
    stableStringifyPrinterCoreV3Value({
      printJobId,
      printPlanId: printPlan?.printPlanId || null,
      deviceId: printPlan?.deviceId || null,
      capturedAt,
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
  return result === undefined || result === null || result === true ||
    (typeof result === "object" && result.ok !== false);
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
 * @param {Function=} input.now - 現在時刻関数。
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
    const printJobResolution = resolveObservedPrintJobId(data, request);
    if (!printJobResolution.ok) {
      return createBlockedResult(printJobResolution.reasons, previousStore, {
        observedPrintJobIds: printJobResolution.observedPrintJobIds,
      });
    }
    const printJobId = printJobResolution.printJobId;
    const capturedAt = resolveCapturedAt(request.capturedAt, input.now);
    const bindingOperationId = toTrimmedString(request.bindingOperationId) ||
      createBindingOperationId(printPlan, printJobId, capturedAt);
    const repository = createMaterialAccountingPrintBindingRepository(previousStore);
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
