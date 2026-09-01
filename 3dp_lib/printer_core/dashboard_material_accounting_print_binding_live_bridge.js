/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 MaterialAccounting PrintBinding live bridge モジュール
 * @file dashboard_material_accounting_print_binding_live_bridge.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_accounting_print_binding_live_bridge
 *
 * 【機能内容サマリ】
 * - K2/CFS印刷開始UIで送信したPrintPlan候補を一時pendingとして保持
 * - WebSocketで実機print-start job IDを観測した段階でPrintBinding runtimeへ接続
 * - 完了履歴が観測された段階で同じPrintPlanをsource-specific usage runtimeへ接続
 * - 送信済みcommandだけを根にし、caller suppliedなjob IDやusageだけで保存しない境界を補助
 *
 * 【公開関数一覧】
 * - {@link rememberMaterialAccountingPrintStartRequest}：K2/CFS印刷開始requestをpending登録
 * - {@link markMaterialAccountingPrintStartRequestSubmitted}：transport送信成功をpendingへ反映
 * - {@link recordObservedMaterialAccountingPrintStart}：観測済みprint-startをruntimeへ通知
 * - {@link recordObservedMaterialAccountingPrintCompletion}：観測済み完了をruntimeへ通知
 * - {@link getMaterialAccountingPrintBindingLiveBridgeSnapshot}：テスト/診断用snapshotを取得
 * - {@link forgetMaterialAccountingPrintStartRequest}：hostname単位のpending登録を破棄
 * - {@link clearMaterialAccountingPrintBindingLiveBridge}：テスト用にpending状態を初期化
 *
 * @version 1.390.1601 (PR #440)
 * @since   1.390.1595 (PR #440)
 * @lastModified 2026-09-01 21:03:29
 * -----------------------------------------------------------
 * @todo
 * - Gate 20 restart recoveryでpending print-startの再認証/再構築を永続session registryへ移す
 */

"use strict";

import {
  validateMaterialBindingPlan,
  validateMaterialBindingPlanCommandBinding,
} from "./dashboard_material_binding_plan.js";

/**
 * hostnameごとのpending K2/CFS print-start state。
 *
 * 【詳細説明】
 * - UI送信直後は実機の`printStartTime`が未確定なので、runtimeへは渡さずpendingに留める。
 * - 実機観測が来た後だけ`recordObservedPrintStart()`へ進める。
 *
 * @constant {Map<string,Object>}
 */
const PENDING_BY_HOST = new Map();

/**
 * prepared中に先着した観測で解決済みruntimeをhostname別に保持するMap。
 *
 * 【詳細説明】
 * - runtimeには関数を含むため、公開snapshotへ含めるpending recordには保存しない。
 * - 実運用ではstart観測側だけがruntimeを解決でき、transport送信成功側はruntimeを持たない。
 * - そのためPREPARED中の観測をreplayするときだけ、内部Mapから同じruntimeを取り出す。
 *
 * @constant {Map<string,Object>}
 */
const QUEUED_RUNTIME_BY_HOST = new Map();

/**
 * JSON互換値をdeep cloneする。
 *
 * @private
 * @function cloneJsonValue
 * @param {*} value - clone対象。
 * @returns {*} clone済み値。
 */
function cloneJsonValue(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * 文字列候補をtrim済み文字列へ正規化する。
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
 * 非空文字列を必須値として読み取る。
 *
 * @private
 * @function requireNonEmptyString
 * @param {*} value - 文字列候補。
 * @param {string} name - エラー表示用フィールド名。
 * @returns {string} 正規化済み文字列。
 * @throws {TypeError} 値が空の場合。
 */
function requireNonEmptyString(value, name) {
  const text = toTrimmedString(value);
  if (!text) {
    throw new TypeError(`Material print binding live bridge requires a non-empty ${name}.`);
  }
  return text;
}

/**
 * ISO時刻候補を正規化する。
 *
 * @private
 * @function normalizeIsoTime
 * @param {*} value - 時刻候補。
 * @returns {string|null} ISO文字列、またはnull。
 */
function normalizeIsoTime(value) {
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
 * 数値候補を正のconnectionGenerationへ正規化する。
 *
 * @private
 * @function normalizeConnectionGeneration
 * @param {*} value - 世代番号候補。
 * @returns {number|null} 正の有限数、またはnull。
 */
function normalizeConnectionGeneration(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

/**
 * pending登録へ渡されたMaterialBindingPlanを検証する。
 *
 * 【詳細説明】
 * - transport payloadからPrintPlanを再構築せず、UI composition時に発行された材料割当専用planだけを使う。
 * - 既存remote G-codeでは正式PrintPlanに必要なG-code content/upload receiptが無いことがあるため、
 *   MaterialBindingPlanをPrintBinding runtimeへ渡すroot evidenceとして扱う。
 *
 * @private
 * @function requireMaterialBindingPlan
 * @param {Object|null|undefined} plan - MaterialBindingPlan候補。
 * @returns {Object} 検証済みMaterialBindingPlan。
 * @throws {TypeError} MaterialBindingPlanとして不正な場合。
 */
function requireMaterialBindingPlan(plan) {
  if (!plan) {
    throw new TypeError("Material print binding live bridge requires MaterialBindingPlan: material-binding-plan-required");
  }
  const validation = validateMaterialBindingPlan(plan);
  if (!validation.ok) {
    throw new TypeError(`Material print binding live bridge requires MaterialBindingPlan: ${validation.errors.join(",")}`);
  }
  return plan;
}

/**
 * MaterialBindingPlanが実transport command requestへ結合されていることを検証する。
 *
 * 【詳細説明】
 * - MaterialBindingPlanは材料割当snapshotとして有効でも、別command requestへ横流しされると誤帰属になる。
 * - pending登録時にrequestからcommandBindingを再計算し、plan内digestと一致する場合だけ保持する。
 *
 * @private
 * @function requireMaterialBindingCommandBinding
 * @param {Object} plan - 検証済みMaterialBindingPlan。
 * @param {Object|null|undefined} commandRequest - 実送信予定のcommand request。
 * @returns {Object} commandBinding検証結果。
 * @throws {TypeError} commandBindingが一致しない場合。
 */
function requireMaterialBindingCommandBinding(plan, commandRequest) {
  const validation = validateMaterialBindingPlanCommandBinding(plan, commandRequest);
  if (!validation.ok) {
    throw new TypeError(`Material print binding live bridge requires command-bound MaterialBindingPlan: ${validation.errors.join(",")}`);
  }
  return validation.commandBinding;
}

/**
 * pending recordを公開/永続化しない診断用shapeへcloneする。
 *
 * @private
 * @function clonePendingRecord
 * @param {Object} record - pending record。
 * @returns {Object} clone済みpending record。
 */
function clonePendingRecord(record) {
  return cloneJsonValue(record);
}

/**
 * hostnameのpending recordを取得する。
 *
 * @private
 * @function getPendingRecord
 * @param {string} hostname - 対象ホスト名。
 * @returns {Object|null} pending record、またはnull。
 */
function getPendingRecord(hostname) {
  const key = toTrimmedString(hostname);
  return key ? (PENDING_BY_HOST.get(key) || null) : null;
}

/**
 * runtime resultが成功扱いできるか判定する。
 *
 * @private
 * @function isRuntimeAccepted
 * @param {*} result - runtime戻り値。
 * @returns {boolean} ok trueならtrue。
 */
function isRuntimeAccepted(result) {
  return Boolean(result && typeof result === "object" && result.ok === true);
}

/**
 * runtimeへ渡す共通requestを作成する。
 *
 * @private
 * @function createRuntimeRequest
 * @param {Object} pending - pending record。
 * @param {Object} input - 観測入力。
 * @returns {Object} runtime request。
 */
function createRuntimeRequest(pending, input) {
  const printJobId = requireNonEmptyString(input.printJobId || input.observedPrintJobId, "printJobId");
  return {
    hostname: pending.hostname,
    printPlan: pending.materialBindingPlan,
    printJobId,
    sessionId: pending.sessionId,
    connectionGeneration: pending.connectionGeneration,
    capturedAt: input.capturedAt || input.devicePrintStartTime || input.firstObservedAt || input.observedFirstObservedAt || null,
    observedReceivedAt: input.observedReceivedAt || input.receivedAt || input.observedAt || null,
  };
}

/**
 * 装置が報告したprint-start時刻を正規化する。
 *
 * @private
 * @function resolveDevicePrintStartTime
 * @param {Object} input - 観測入力。
 * @returns {string|null} ISO時刻、またはnull。
 */
function resolveDevicePrintStartTime(input) {
  return normalizeIsoTime(input.devicePrintStartTime || input.firstObservedAt || input.observedFirstObservedAt || input.capturedAt);
}

/**
 * 3DPmonがprint-start観測を受け取った時刻を正規化する。
 *
 * @private
 * @function resolveObservedReceivedAt
 * @param {Object} input - 観測入力。
 * @returns {string|null} ISO時刻、またはnull。
 */
function resolveObservedReceivedAt(input) {
  return normalizeIsoTime(input.observedReceivedAt || input.receivedAt || input.observedAt);
}

/**
 * pendingと観測jobの因果関係を検証する。
 *
 * 【詳細説明】
 * - 同一接続内で旧jobの`printStartTime`が再pushされても、新commandのMaterialBindingPlanへ誤bindしない。
 * - submittedAt以前の観測は送信前/旧観測として拒否し、runtimeへは流さない。
 *
 * @private
 * @function validateObservedStartCorrelation
 * @param {Object} pending - pending record。
 * @param {Object} input - 観測入力。
 * @returns {{ok:boolean,reasons:string[],devicePrintStartTime:string|null,observedReceivedAt:string|null,capturedAt:string|null}} 検証結果。
 */
function validateObservedStartCorrelation(pending, input) {
  const reasons = [];
  const printJobId = requireNonEmptyString(input.printJobId || input.observedPrintJobId, "printJobId");
  const devicePrintStartTime = resolveDevicePrintStartTime(input);
  const observedReceivedAt = resolveObservedReceivedAt(input);
  const submittedAt = normalizeIsoTime(pending.submittedAt);
  if (pending.baselinePrintJobId && printJobId === pending.baselinePrintJobId) {
    reasons.push("observed-job-matches-baseline");
  }
  if (!devicePrintStartTime) {
    reasons.push("device-print-start-time-required");
  }
  if (!observedReceivedAt) {
    reasons.push("observed-received-at-required");
  } else if (submittedAt && Date.parse(observedReceivedAt) < Date.parse(submittedAt)) {
    reasons.push("observed-received-before-command-submitted");
  }
  if (input.sessionId && pending.sessionId && input.sessionId !== pending.sessionId) {
    reasons.push("observed-session-mismatch");
  }
  const observedGeneration = normalizeConnectionGeneration(input.connectionGeneration);
  if (pending.connectionGeneration === null) {
    reasons.push("connection-generation-required");
  } else if (observedGeneration !== null && observedGeneration !== pending.connectionGeneration) {
    reasons.push("observed-connection-generation-mismatch");
  }
  return {
    ok: reasons.length === 0,
    reasons: [...new Set(reasons)],
    devicePrintStartTime,
    observedReceivedAt,
    capturedAt: devicePrintStartTime || observedReceivedAt,
  };
}

/**
 * queued print-start観測をsubmitted後に再評価する。
 *
 * @private
 * @function replayQueuedStartObservation
 * @param {Object} pending - pending record。
 * @param {Object} input - submitted入力。
 * @returns {Promise<Object|null>} 再評価結果、またはnull。
 */
async function replayQueuedStartObservation(pending, input) {
  if (!pending.queuedStartObservation) {
    return null;
  }
  const queued = pending.queuedStartObservation;
  const queuedRuntime = QUEUED_RUNTIME_BY_HOST.get(pending.hostname) || null;
  QUEUED_RUNTIME_BY_HOST.delete(pending.hostname);
  pending.queuedStartObservation = null;
  return recordObservedMaterialAccountingPrintStart({
    ...queued,
    runtime: input.runtime || queuedRuntime,
  });
}

/**
 * K2/CFS印刷開始requestをpending登録する。
 *
 * 【詳細説明】
 * - command requestはtransport用、MaterialBindingPlanは材料割当snapshot用として分けて保持する。
 * - transport送信成功前は`prepared`に留め、実機job観測が来てもruntimeへは流さない。
 * - 同じhostnameの古いpendingは、新しい印刷開始要求で置き換える。
 *
 * @function rememberMaterialAccountingPrintStartRequest
 * @param {Object} input - pending登録入力。
 * @param {string} input.hostname - 対象ホスト名。
 * @param {Object} input.commandRequest - Printer Core command request互換object。
 * @param {Object} input.materialBindingPlan - UI composition時に発行されたMaterialBindingPlan。
 * @param {string|Date|number=} input.preparedAt - pending準備時刻。
 * @param {string|Date|number=} input.submittedAt - 互換入力。送信成功前の時刻としては採用しない。
 * @returns {Object} 登録されたpending record。
 */
export function rememberMaterialAccountingPrintStartRequest(input = {}) {
  const hostname = requireNonEmptyString(input.hostname || input.host, "hostname");
  const commandRequest = input.commandRequest || input.request;
  const materialBindingPlan = requireMaterialBindingPlan(input.materialBindingPlan);
  const commandBinding = requireMaterialBindingCommandBinding(materialBindingPlan, commandRequest);
  const connectionGeneration = normalizeConnectionGeneration(
    materialBindingPlan?.startContext?.connectionGeneration ||
    commandRequest?.payload?.startContext?.connectionGeneration ||
    commandRequest?.connectionGeneration
  );
  if (connectionGeneration === null) {
    throw new TypeError("Material print binding live bridge requires connectionGeneration.");
  }
  const pending = {
    schemaVersion: 1,
    status: "prepared",
    hostname,
    commandId: toTrimmedString(commandRequest?.commandId) || null,
    commandBinding,
    deviceId: materialBindingPlan.deviceId,
    sessionId: requireNonEmptyString(
      materialBindingPlan?.startContext?.sessionId || commandRequest?.sessionId || commandRequest?.payload?.startContext?.sessionId,
      "sessionId",
    ),
    connectionGeneration,
    preparedAt: normalizeIsoTime(input.preparedAt || input.submittedAt) || new Date().toISOString(),
    submittedAt: null,
    baselinePrintJobId: toTrimmedString(
      input.baselinePrintJobId || commandRequest?.payload?.startContext?.baselinePrintJobId
    ) || null,
    baselinePrintStartTime: normalizeIsoTime(
      input.baselinePrintStartTime || commandRequest?.payload?.startContext?.baselinePrintStartTime
    ),
    materialBindingPlan,
    printPlan: materialBindingPlan,
    observedPrintJobId: null,
    startRecordedAt: null,
    completionRecordedAt: null,
    queuedStartObservation: null,
  };
  QUEUED_RUNTIME_BY_HOST.delete(hostname);
  PENDING_BY_HOST.set(hostname, pending);
  return clonePendingRecord(pending);
}

/**
 * transport送信成功をpendingへ反映する。
 *
 * 【詳細説明】
 * - 送信成功が確認されるまでprint-start観測はruntimeへ流さない。
 * - PREPARED中に実機観測が先着していた場合は、submittedAtを固定してから同じ観測を再評価する。
 *
 * @function markMaterialAccountingPrintStartRequestSubmitted
 * @param {Object} input - submitted入力。
 * @param {string} input.hostname - 対象ホスト名。
 * @param {string=} input.commandId - 対象command ID。
 * @param {string|Date|number=} input.submittedAt - 送信成功時刻。
 * @param {Object=} input.runtime - queued observation再評価用runtime。
 * @returns {Promise<Object>|Object} submitted result。
 */
export function markMaterialAccountingPrintStartRequestSubmitted(input = {}) {
  const hostname = requireNonEmptyString(input.hostname || input.host, "hostname");
  const pending = getPendingRecord(hostname);
  if (!pending) {
    return { ok: false, status: "blocked", reasons: ["pending-print-plan-required"] };
  }
  const commandId = toTrimmedString(input.commandId);
  if (commandId && pending.commandId && commandId !== pending.commandId) {
    return { ok: false, status: "blocked", reasons: ["pending-command-id-mismatch"], pending: clonePendingRecord(pending) };
  }
  pending.status = "submitted";
  pending.submittedAt = normalizeIsoTime(input.submittedAt) || new Date().toISOString();
  const replay = replayQueuedStartObservation(pending, input);
  if (replay && typeof replay.then === "function") {
    return replay.then((result) => result || { ok: true, status: "submitted", pending: clonePendingRecord(pending) });
  }
  return { ok: true, status: "submitted", pending: clonePendingRecord(pending) };
}

/**
 * 実機で観測したprint-startをpending MaterialBindingPlanとともにruntimeへ通知する。
 *
 * 【詳細説明】
 * - pendingが無い場合、または同じjobを既に記録済みの場合は副作用なしで返す。
 * - transport送信成功前に観測が先着した場合はqueued observationとして保持する。
 * - runtimeが拒否した場合はpending状態を進めず、次の観測で再試行できるようにする。
 *
 * @function recordObservedMaterialAccountingPrintStart
 * @param {Object} input - print-start観測入力。
 * @param {string} input.hostname - 対象ホスト名。
 * @param {string} input.printJobId - 実機観測済みPrintJob ID。
 * @param {Object} input.runtime - `recordObservedPrintStart`を持つruntime。
 * @returns {Promise<Object>} bridge/runtime result。
 */
export async function recordObservedMaterialAccountingPrintStart(input = {}) {
  const hostname = requireNonEmptyString(input.hostname || input.host, "hostname");
  const pending = getPendingRecord(hostname);
  const printJobId = requireNonEmptyString(input.printJobId || input.observedPrintJobId, "printJobId");
  if (!pending) {
    return { ok: false, status: "blocked", reasons: ["pending-print-plan-required"] };
  }
  if (pending.status === "prepared") {
    if (input.runtime) {
      QUEUED_RUNTIME_BY_HOST.set(hostname, input.runtime);
    } else {
      QUEUED_RUNTIME_BY_HOST.delete(hostname);
    }
    pending.queuedStartObservation = {
      hostname,
      printJobId,
      devicePrintStartTime: resolveDevicePrintStartTime(input),
      observedReceivedAt: resolveObservedReceivedAt(input),
      sessionId: input.sessionId || null,
      connectionGeneration: input.connectionGeneration ?? null,
    };
    return {
      ok: false,
      status: "pending",
      reasons: ["command-submit-not-confirmed"],
      pending: clonePendingRecord(pending),
    };
  }
  if (pending.startRecordedAt && pending.observedPrintJobId === printJobId) {
    return { ok: true, status: "already-recorded", pending: clonePendingRecord(pending) };
  }
  const correlation = validateObservedStartCorrelation(pending, input);
  if (!correlation.ok) {
    return { ok: false, status: "blocked", reasons: correlation.reasons, pending: clonePendingRecord(pending) };
  }
  const runtime = input.runtime;
  if (!runtime || typeof runtime.recordObservedPrintStart !== "function") {
    return { ok: false, status: "blocked", reasons: ["print-binding-runtime-required"] };
  }
  const result = await runtime.recordObservedPrintStart(createRuntimeRequest(pending, {
    printJobId,
    capturedAt: correlation.capturedAt,
    observedReceivedAt: correlation.observedReceivedAt,
  }));
  if (!isRuntimeAccepted(result)) {
    return { ...result, pending: clonePendingRecord(pending) };
  }
  pending.observedPrintJobId = printJobId;
  pending.status = "start-recorded";
  pending.startRecordedAt = new Date().toISOString();
  return { ...result, pending: clonePendingRecord(pending) };
}

/**
 * 実機で観測した完了履歴をpending MaterialBindingPlanとともにruntimeへ通知する。
 *
 * 【詳細説明】
 * - completionはprint-start snapshotが保存済みのpendingだけを対象にする。
 * - `resultSetCompleteness:"complete"`はruntime/repository側のsource coverage検査を通すための要求であり、
 *   caller宣言だけではtrusted completenessにはならない。
 *
 * @function recordObservedMaterialAccountingPrintCompletion
 * @param {Object} input - completion観測入力。
 * @param {string} input.hostname - 対象ホスト名。
 * @param {string} input.printJobId - 完了したPrintJob ID。
 * @param {Object} input.runtime - `recordObservedPrintCompletion`を持つruntime。
 * @returns {Promise<Object>} bridge/runtime result。
 */
export async function recordObservedMaterialAccountingPrintCompletion(input = {}) {
  const hostname = requireNonEmptyString(input.hostname || input.host, "hostname");
  const pending = getPendingRecord(hostname);
  const printJobId = requireNonEmptyString(input.printJobId || input.observedPrintJobId, "printJobId");
  if (!pending || !pending.startRecordedAt || pending.observedPrintJobId !== printJobId) {
    return { ok: false, status: "blocked", reasons: ["recorded-print-start-required"] };
  }
  if (pending.completionRecordedAt) {
    return { ok: true, status: "already-recorded", pending: clonePendingRecord(pending) };
  }
  const runtime = input.runtime;
  if (!runtime || typeof runtime.recordObservedPrintCompletion !== "function") {
    return { ok: false, status: "blocked", reasons: ["print-binding-runtime-required"] };
  }
  const result = await runtime.recordObservedPrintCompletion({
    ...createRuntimeRequest(pending, {
      printJobId,
      observedReceivedAt: input.observedReceivedAt || input.receivedAt || input.observedAt || new Date().toISOString(),
    }),
    resultSetCompleteness: "complete",
  });
  if (!isRuntimeAccepted(result)) {
    return { ...result, pending: clonePendingRecord(pending) };
  }
  pending.completionRecordedAt = new Date().toISOString();
  const completedPending = clonePendingRecord(pending);
  PENDING_BY_HOST.delete(hostname);
  return { ...result, pending: completedPending };
}

/**
 * live bridgeの診断用snapshotを取得する。
 *
 * @function getMaterialAccountingPrintBindingLiveBridgeSnapshot
 * @returns {{pendingByHost:Object<string,Object>}} pending一覧。
 */
export function getMaterialAccountingPrintBindingLiveBridgeSnapshot() {
  const pendingByHost = {};
  for (const [hostname, record] of PENDING_BY_HOST.entries()) {
    pendingByHost[hostname] = clonePendingRecord(record);
  }
  return { pendingByHost };
}

/**
 * hostname単位のpending print-start requestを破棄する。
 *
 * 【詳細説明】
 * - K2/CFS送信直前にpending登録したあとtransport送信が失敗した場合、
 *   未送信PrintPlanが後続の実機観測へ誤ってbindされないようにする。
 *
 * @function forgetMaterialAccountingPrintStartRequest
 * @param {Object} input - 破棄入力。
 * @param {string} input.hostname - 対象ホスト名。
 * @returns {boolean} pendingを削除した場合true。
 */
export function forgetMaterialAccountingPrintStartRequest(input = {}) {
  const hostname = toTrimmedString(input.hostname || input.host);
  const commandId = toTrimmedString(input.commandId);
  if (!hostname) {
    return false;
  }
  if (commandId) {
    const pending = PENDING_BY_HOST.get(hostname);
    if (!pending || (pending.commandId && pending.commandId !== commandId)) {
      return false;
    }
  }
  QUEUED_RUNTIME_BY_HOST.delete(hostname);
  return PENDING_BY_HOST.delete(hostname);
}

/**
 * live bridgeのpending状態を初期化する。
 *
 * 【詳細説明】
 * - 本番では使用せず、単体テストやhot reload時の診断に使う。
 *
 * @function clearMaterialAccountingPrintBindingLiveBridge
 * @returns {void}
 */
export function clearMaterialAccountingPrintBindingLiveBridge() {
  PENDING_BY_HOST.clear();
  QUEUED_RUNTIME_BY_HOST.clear();
}
