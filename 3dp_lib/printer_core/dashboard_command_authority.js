/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 command authority contract モジュール
 * @file dashboard_command_authority.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_command_authority
 *
 * 【機能内容サマリ】
 * - Printer Core v3 command request/result の標準形を提供
 * - command ID、timeout、side-effect、expected-state confirmation を表現
 * - 非冪等 command の blind retry を禁止する判定を提供
 *
 * 【公開関数一覧】
 * - {@link createPrinterCommandRequest}：command request を生成
 * - {@link createPrinterCommandResult}：command result を生成
 * - {@link shouldRetryPrinterCommand}：command retry 可否を判定
 * - {@link evaluateExpectedStateConfirmation}：NormalizedState に対する期待状態確認を評価
 * - {@link validatePrinterCommandRequest}：command request の整合性を検査
 *
 * @version 1.390.1342 (PR #432)
 * @since   1.390.1342 (PR #432)
 * @lastModified 2026-08-09 01:35:57
 * -----------------------------------------------------------
 * @todo
 * - legacy dashboard_send_command.js / dashboard_printmanager.js の送信経路へ段階的に接続する
 */

"use strict";

/**
 * Printer Core v3 command contract の schema version。
 *
 * 【詳細説明】
 * - 実 transport protocol ではなく、Printer Core 内部の command envelope version として扱う。
 *
 * @constant {number}
 */
export const PRINTER_COMMAND_SCHEMA_VERSION = 1;

/**
 * 既定 command timeout。
 *
 * 【詳細説明】
 * - 実機 protocol ごとの timeout が未指定の場合に使う保守的な既定値。
 *
 * @constant {number}
 */
export const DEFAULT_PRINTER_COMMAND_TIMEOUT_MS = 30000;

/**
 * Printer Core v3 command kind の分類。
 *
 * 【詳細説明】
 * - `sideEffect` が true の command は、timeout や transport error だけでは blind retry しない。
 * - `expectedStateRequired` が true の command は result ack だけで完了扱いにせず、NormalizedState で確認する。
 *
 * @constant {object}
 */
export const PRINTER_COMMAND_KIND_CONTRACTS = Object.freeze({
  "read-status": Object.freeze({
    sideEffect: false,
    idempotent: true,
    expectedStateRequired: false,
  }),
  "read-files": Object.freeze({
    sideEffect: false,
    idempotent: true,
    expectedStateRequired: false,
  }),
  "set-led": Object.freeze({
    sideEffect: true,
    idempotent: true,
    expectedStateRequired: true,
  }),
  "print-start": Object.freeze({
    sideEffect: true,
    idempotent: false,
    expectedStateRequired: true,
  }),
  "print-stop": Object.freeze({
    sideEffect: true,
    idempotent: false,
    expectedStateRequired: true,
  }),
  "file-delete": Object.freeze({
    sideEffect: true,
    idempotent: false,
    expectedStateRequired: true,
  }),
  "cfs-load": Object.freeze({
    sideEffect: true,
    idempotent: false,
    expectedStateRequired: true,
  }),
  "cfs-unload": Object.freeze({
    sideEffect: true,
    idempotent: false,
    expectedStateRequired: true,
  }),
});

/**
 * JSON 互換値を deep clone する。
 *
 * 【詳細説明】
 * - request/result は監査ログへ保存し得る plain data として扱う。
 *
 * @private
 * @param {*} value - clone 対象
 * @returns {*} clone 済み値
 */
function cloneJsonValue(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * 文字列 ID を空でない値へ正規化する。
 *
 * 【詳細説明】
 * - command envelope が `unknown` bucket へ混ざることを防ぐため、必須 ID は空文字を拒否する。
 *
 * @private
 * @param {*} value - ID 候補
 * @param {string} name - エラー表示用の名前
 * @returns {string} 正規化済み ID
 * @throws {TypeError} 空 ID の場合
 */
function requireNonEmptyString(value, name) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new TypeError(`Printer command requires a non-empty ${name}.`);
  }
  return text;
}

/**
 * command contract を取得する。
 *
 * 【詳細説明】
 * - 未知 command は安全側で side-effect あり、非冪等、expected-state 必須として扱う。
 *
 * @private
 * @param {string} commandKind - command 種別
 * @returns {object} command contract
 */
function getCommandKindContract(commandKind) {
  return PRINTER_COMMAND_KIND_CONTRACTS[commandKind] || {
    sideEffect: true,
    idempotent: false,
    expectedStateRequired: true,
  };
}

/**
 * command ID を生成する。
 *
 * 【詳細説明】
 * - user supplied idempotencyKey がある場合は commandId にも反映し、同じ操作要求を追跡しやすくする。
 * - entropySource はテスト用に注入できる。
 *
 * @private
 * @param {object} options - ID 生成オプション
 * @param {string} options.deviceId - device ID
 * @param {string} options.sessionId - session ID
 * @param {string} options.commandKind - command 種別
 * @param {?string=} options.idempotencyKey - 冪等性 key
 * @param {Function=} options.entropySource - 乱数/時刻 source
 * @returns {string} command ID
 */
function createCommandId(options) {
  const entropy = typeof options.entropySource === "function"
    ? options.entropySource()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const idempotencyPart = options.idempotencyKey ? `:${options.idempotencyKey}` : "";
  return [
    "cmd",
    options.deviceId,
    options.sessionId,
    options.commandKind,
    `${entropy}${idempotencyPart}`,
  ].map((part) => encodeURIComponent(String(part))).join(":");
}

/**
 * Printer Core v3 command request を生成する。
 *
 * 【詳細説明】
 * - この関数は request envelope を作るだけで、プリンタへ送信しない。
 * - side-effect と idempotency は command kind の契約から補完し、呼び出し側が安全境界を確認できるようにする。
 *
 * @function createPrinterCommandRequest
 * @param {object} options - command request 生成オプション
 * @param {string} options.deviceId - 物理 device ID
 * @param {string} options.sessionId - active session ID
 * @param {string} options.commandKind - command 種別
 * @param {string=} options.transportKind - 送信 transport 種別
 * @param {object=} options.payload - transport へ渡す command payload
 * @param {Array<object>|object=} options.expectedState - 期待状態確認条件
 * @param {number=} options.timeoutMs - timeout milliseconds
 * @param {string=} options.idempotencyKey - 呼び出し側が指定する冪等性 key
 * @param {Function=} options.entropySource - commandId 生成用 source
 * @param {string=} options.createdAt - request 作成時刻 ISO 文字列
 * @returns {object} command request
 * @example
 * const request = createPrinterCommandRequest({ deviceId, sessionId, commandKind: "print-start" });
 */
export function createPrinterCommandRequest(options = {}) {
  const deviceId = requireNonEmptyString(options.deviceId, "deviceId");
  const sessionId = requireNonEmptyString(options.sessionId, "sessionId");
  const commandKind = requireNonEmptyString(options.commandKind, "commandKind");
  const contract = getCommandKindContract(commandKind);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : DEFAULT_PRINTER_COMMAND_TIMEOUT_MS;
  const expectedState = Array.isArray(options.expectedState)
    ? options.expectedState
    : (options.expectedState ? [options.expectedState] : []);
  const request = {
    schemaVersion: PRINTER_COMMAND_SCHEMA_VERSION,
    commandId: createCommandId({
      deviceId,
      sessionId,
      commandKind,
      idempotencyKey: options.idempotencyKey || null,
      entropySource: options.entropySource,
    }),
    deviceId,
    sessionId,
    commandKind,
    transportKind: options.transportKind || "unknown",
    payload: cloneJsonValue(options.payload || {}),
    sideEffect: Boolean(contract.sideEffect),
    idempotent: Boolean(contract.idempotent),
    expectedStateRequired: Boolean(contract.expectedStateRequired || expectedState.length > 0),
    expectedState: cloneJsonValue(expectedState),
    timeoutMs,
    idempotencyKey: options.idempotencyKey || null,
    createdAt: options.createdAt || null,
    authority: {
      mode: "contract-only",
      canSend: false,
      canBlindRetry: !contract.sideEffect && contract.idempotent,
    },
  };
  const validation = validatePrinterCommandRequest(request);
  if (!validation.ok) {
    throw new TypeError(`Invalid printer command request: ${validation.errors.join(",")}`);
  }
  return request;
}

/**
 * object path の値を取得する。
 *
 * 【詳細説明】
 * - expected-state confirmation で `print.stateLabel` のような path を評価する。
 *
 * @private
 * @param {object|null|undefined} source - 参照元 object
 * @param {string} path - dot-separated path
 * @returns {*} path の値
 */
function getPathValue(source, path) {
  const parts = String(path || "").split(".").filter(Boolean);
  let cursor = source;
  for (const part of parts) {
    if (!cursor || typeof cursor !== "object" || !Object.prototype.hasOwnProperty.call(cursor, part)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}

/**
 * expected-state 条件を1件評価する。
 *
 * 【詳細説明】
 * - operator は `equals` と `oneOf` だけに限定し、曖昧な文字列評価や正規表現評価を command authority に入れない。
 *
 * @private
 * @param {object} condition - 期待状態条件
 * @param {object|null|undefined} state - NormalizedPrinterState
 * @returns {object} 評価結果
 */
function evaluateExpectedStateCondition(condition, state) {
  const path = String(condition?.path || "");
  const actual = getPathValue(state, path);
  const operator = condition?.operator || "equals";
  let matched = false;
  if (operator === "equals") {
    matched = Object.is(actual, condition.expected);
  } else if (operator === "oneOf") {
    matched = Array.isArray(condition.expected) && condition.expected.some((entry) => Object.is(actual, entry));
  }
  return {
    path,
    operator,
    expected: cloneJsonValue(condition?.expected),
    actual: cloneJsonValue(actual),
    matched,
  };
}

/**
 * command request の expected-state confirmation を評価する。
 *
 * 【詳細説明】
 * - result ack だけでは危険な command について、NormalizedState が期待状態に到達したかを確認する。
 * - 条件が空の場合は `checked:false` とし、状態到達を証明しない。
 *
 * @function evaluateExpectedStateConfirmation
 * @param {object} request - command request
 * @param {object|null|undefined} state - NormalizedPrinterState
 * @returns {object} confirmation 結果
 * @example
 * const confirmation = evaluateExpectedStateConfirmation(request, normalizedState);
 */
export function evaluateExpectedStateConfirmation(request, state) {
  const conditions = Array.isArray(request?.expectedState) ? request.expectedState : [];
  const checks = conditions.map((condition) => evaluateExpectedStateCondition(condition, state));
  return {
    checked: checks.length > 0,
    confirmed: checks.length > 0 && checks.every((check) => check.matched),
    checks,
  };
}

/**
 * Printer Core v3 command result を生成する。
 *
 * 【詳細説明】
 * - transport response と expected-state confirmation を同じ result envelope にまとめる。
 * - request が expected-state を必要とする場合、confirmation が false のままでは `completed:false` とする。
 *
 * @function createPrinterCommandResult
 * @param {object} request - command request
 * @param {object=} options - result 生成オプション
 * @param {string=} options.status - result status
 * @param {object=} options.response - transport response
 * @param {object=} options.error - error 情報
 * @param {object=} options.observedState - confirmation に使う NormalizedPrinterState
 * @param {string=} options.completedAt - 完了時刻 ISO 文字列
 * @returns {object} command result
 * @example
 * const result = createPrinterCommandResult(request, { status: "acknowledged" });
 */
export function createPrinterCommandResult(request, options = {}) {
  const confirmation = evaluateExpectedStateConfirmation(request, options.observedState);
  const status = options.status || "unknown";
  const hasError = Boolean(options.error) || status === "failed" || status === "timeout";
  const completed = !hasError && (!request.expectedStateRequired || confirmation.confirmed);
  return {
    schemaVersion: PRINTER_COMMAND_SCHEMA_VERSION,
    commandId: request.commandId,
    deviceId: request.deviceId,
    sessionId: request.sessionId,
    commandKind: request.commandKind,
    status,
    completed,
    response: cloneJsonValue(options.response || null),
    error: cloneJsonValue(options.error || null),
    confirmation,
    completedAt: options.completedAt || null,
  };
}

/**
 * command retry 可否を判定する。
 *
 * 【詳細説明】
 * - side-effect のある command は、冪等と明示されたもの以外 blind retry しない。
 * - `print-start` / `print-stop` / `file-delete` / `cfs-load` / `cfs-unload` は timeout でも false を返す。
 *
 * @function shouldRetryPrinterCommand
 * @param {object} request - command request
 * @param {object=} result - command result
 * @returns {boolean} blind retry してよい場合 true
 * @example
 * const retry = shouldRetryPrinterCommand(request, result);
 */
export function shouldRetryPrinterCommand(request, result = {}) {
  if (!request || typeof request !== "object") {
    return false;
  }
  if (request.sideEffect && !request.idempotent) {
    return false;
  }
  if (request.sideEffect && request.expectedStateRequired && !result.confirmation?.confirmed) {
    return false;
  }
  return ["timeout", "transport-error", "transient-error"].includes(result.status);
}

/**
 * command request の整合性を検査する。
 *
 * 【詳細説明】
 * - request が送信可能かではなく、authority 化前に監査可能な envelope になっているかを確認する。
 *
 * @function validatePrinterCommandRequest
 * @param {object|null|undefined} request - command request
 * @returns {{ok: boolean, errors: string[]}} 検査結果
 * @example
 * const validation = validatePrinterCommandRequest(request);
 */
export function validatePrinterCommandRequest(request) {
  const errors = [];
  if (!request || typeof request !== "object") {
    return { ok: false, errors: ["request-not-object"] };
  }
  for (const key of ["commandId", "deviceId", "sessionId", "commandKind"]) {
    if (!String(request[key] || "").trim()) {
      errors.push(`missing-${key}`);
    }
  }
  if (request.schemaVersion !== PRINTER_COMMAND_SCHEMA_VERSION) {
    errors.push("unexpected-schema-version");
  }
  if (!Number.isFinite(Number(request.timeoutMs)) || Number(request.timeoutMs) <= 0) {
    errors.push("invalid-timeout");
  }
  if (!Array.isArray(request.expectedState)) {
    errors.push("expected-state-not-array");
  }
  if (request.sideEffect && !request.idempotent && request.authority?.canBlindRetry === true) {
    errors.push("non-idempotent-side-effect-can-blind-retry");
  }
  if (request.authority?.canSend === true) {
    errors.push("contract-request-can-send");
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}
