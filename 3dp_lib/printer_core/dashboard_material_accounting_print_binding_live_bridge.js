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
 * - {@link recordObservedMaterialAccountingPrintStart}：観測済みprint-startをruntimeへ通知
 * - {@link recordObservedMaterialAccountingPrintCompletion}：観測済み完了をruntimeへ通知
 * - {@link getMaterialAccountingPrintBindingLiveBridgeSnapshot}：テスト/診断用snapshotを取得
 * - {@link forgetMaterialAccountingPrintStartRequest}：hostname単位のpending登録を破棄
 * - {@link clearMaterialAccountingPrintBindingLiveBridge}：テスト用にpending状態を初期化
 *
 * @version 1.390.1595 (PR #440)
 * @since   1.390.1595 (PR #440)
 * @lastModified 2026-09-01 19:17:01
 * -----------------------------------------------------------
 * @todo
 * - Gate 20 restart recoveryでpending print-startの再認証/再構築を永続session registryへ移す
 */

"use strict";

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
 * command requestからPrintPlan snapshotを構築する。
 *
 * 【詳細説明】
 * - printmanagerのK2/CFS requestはdevice/sessionをenvelope直下、PrintPlan相当値をpayloadへ持つ。
 * - runtime/repositoryは`printPlan.deviceId`をdevice境界として使うため、bridgeで合成して保持する。
 *
 * @private
 * @function createPrintPlanFromCommandRequest
 * @param {Object} commandRequest - Printer Core command request互換object。
 * @returns {Object} PrintBinding runtimeへ渡すPrintPlan snapshot。
 */
function createPrintPlanFromCommandRequest(commandRequest) {
  const payload = commandRequest?.payload || {};
  const toolAssignments = Array.isArray(payload.toolAssignments)
    ? payload.toolAssignments.map((assignment, index) => ({
        ...cloneJsonValue(assignment),
        order: Number.isFinite(Number(assignment?.order)) ? Number(assignment.order) : index,
      }))
    : [];
  return {
    ...cloneJsonValue(payload),
    deviceId: requireNonEmptyString(commandRequest?.deviceId || payload.deviceId, "commandRequest.deviceId"),
    sessionId: requireNonEmptyString(commandRequest?.sessionId || payload?.startContext?.sessionId, "commandRequest.sessionId"),
    printPlanId: requireNonEmptyString(payload.printPlanId, "payload.printPlanId"),
    planKind: toTrimmedString(payload.planKind) || "unknown",
    asset: cloneJsonValue(payload.asset || {}),
    toolAssignments,
    materialSourceIds: Array.isArray(payload.materialSourceIds)
      ? payload.materialSourceIds.map(toTrimmedString).filter(Boolean)
      : [...new Set(toolAssignments.map((assignment) => toTrimmedString(assignment.materialSourceId)).filter(Boolean))],
    startContext: {
      ...cloneJsonValue(payload.startContext || {}),
      sessionId: requireNonEmptyString(commandRequest?.sessionId || payload?.startContext?.sessionId, "payload.startContext.sessionId"),
      connectionGeneration: normalizeConnectionGeneration(
        payload?.startContext?.connectionGeneration || commandRequest?.connectionGeneration
      ),
    },
  };
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
    printPlan: cloneJsonValue(pending.printPlan),
    printJobId,
    sessionId: pending.sessionId,
    connectionGeneration: pending.connectionGeneration,
  };
}

/**
 * K2/CFS印刷開始requestをpending登録する。
 *
 * 【詳細説明】
 * - 送信済みcommand requestは実機job IDではないため、ここではruntimeを呼ばない。
 * - 同じhostnameの古いpendingは、新しい印刷開始要求で置き換える。
 *
 * @function rememberMaterialAccountingPrintStartRequest
 * @param {Object} input - pending登録入力。
 * @param {string} input.hostname - 対象ホスト名。
 * @param {Object} input.commandRequest - Printer Core command request互換object。
 * @param {string|Date|number=} input.submittedAt - 送信受付時刻。
 * @returns {Object} 登録されたpending record。
 */
export function rememberMaterialAccountingPrintStartRequest(input = {}) {
  const hostname = requireNonEmptyString(input.hostname || input.host, "hostname");
  const commandRequest = input.commandRequest || input.request;
  const printPlan = createPrintPlanFromCommandRequest(commandRequest);
  const pending = {
    schemaVersion: 1,
    hostname,
    commandId: toTrimmedString(commandRequest?.commandId) || null,
    deviceId: printPlan.deviceId,
    sessionId: printPlan.sessionId,
    connectionGeneration: normalizeConnectionGeneration(printPlan?.startContext?.connectionGeneration),
    submittedAt: normalizeIsoTime(input.submittedAt) || new Date().toISOString(),
    printPlan,
    observedPrintJobId: null,
    startRecordedAt: null,
    completionRecordedAt: null,
  };
  PENDING_BY_HOST.set(hostname, pending);
  return clonePendingRecord(pending);
}

/**
 * 実機で観測したprint-startをpending PrintPlanとともにruntimeへ通知する。
 *
 * 【詳細説明】
 * - pendingが無い場合、または同じjobを既に記録済みの場合は副作用なしで返す。
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
  if (pending.startRecordedAt && pending.observedPrintJobId === printJobId) {
    return { ok: true, status: "already-recorded", pending: clonePendingRecord(pending) };
  }
  const runtime = input.runtime;
  if (!runtime || typeof runtime.recordObservedPrintStart !== "function") {
    return { ok: false, status: "blocked", reasons: ["print-binding-runtime-required"] };
  }
  const result = await runtime.recordObservedPrintStart(createRuntimeRequest(pending, { printJobId }));
  if (!isRuntimeAccepted(result)) {
    return { ...result, pending: clonePendingRecord(pending) };
  }
  pending.observedPrintJobId = printJobId;
  pending.startRecordedAt = new Date().toISOString();
  return { ...result, pending: clonePendingRecord(pending) };
}

/**
 * 実機で観測した完了履歴をpending PrintPlanとともにruntimeへ通知する。
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
    ...createRuntimeRequest(pending, { printJobId }),
    resultSetCompleteness: "complete",
  });
  if (!isRuntimeAccepted(result)) {
    return { ...result, pending: clonePendingRecord(pending) };
  }
  pending.completionRecordedAt = new Date().toISOString();
  return { ...result, pending: clonePendingRecord(pending) };
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
  return hostname ? PENDING_BY_HOST.delete(hostname) : false;
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
}
