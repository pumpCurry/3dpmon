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
 * - {@link validatePrinterCommandSendTime}：command request と送信時 context の整合性を検査
 * - {@link createBoundPrinterCommandDispatcher}：UIからcontext/transportを注入できないbound dispatcherを生成
 * - {@link isBoundPrinterCommandDispatcher}：bound dispatcher由来かを判定
 * - {@link dispatchPrinterCommand}：送信時再検証、transport送信、expected-state確認を一連で実行
 *
 * @version 1.390.1409 (PR #434)
 * @since   1.390.1342 (PR #432)
 * @lastModified 2026-08-26 16:18:02
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
 * Printer Core v3 production dispatcher context の schema version。
 *
 * 【詳細説明】
 * - command request とは別に、送信直前に再取得した active session / capability / topology の証跡を表す。
 *
 * @constant {number}
 */
export const PRINTER_COMMAND_DISPATCH_CONTEXT_SCHEMA_VERSION = 1;

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
 * command correlation evidence 用の module-private secret。
 *
 * 【詳細説明】
 * - caller が `commandCorrelation:true` を指定するだけで完了扱いにできないようにする。
 * - 実dispatcher接続時は dispatcher-owned evidence/signature に置き換える。
 *
 * @constant {string}
 */
const COMMAND_CORRELATION_EVIDENCE_SECRET = `printer-core-command-correlation:${Date.now()}:${Math.random()}`;

/**
 * send-time context attestation 用の module-private secret。
 *
 * 【詳細説明】
 * - caller が `active:true` や `canSend:true` を手書きしても production dispatcher を通過できないようにする。
 * - 実接続時は、接続層が現在のWebSocket session/capability/topologyからこのcontextを発行する。
 *
 * @constant {string}
 */
const COMMAND_DISPATCH_CONTEXT_SECRET = `printer-core-command-dispatch:${Date.now()}:${Math.random()}`;

/**
 * trusted command correlation 発行をbound dispatcher経由に限定するmodule-private token。
 *
 * 【詳細説明】
 * - 低レベルdispatcherのcallerがobservationへproof風objectを渡しても、このtokenが無ければ
 *   command correlation evidenceを発行しない。
 *
 * @constant {symbol}
 */
const TRUSTED_COMMAND_CORRELATION_ISSUER = Symbol("printer-core-trusted-command-correlation-issuer");

/**
 * createBoundPrinterCommandDispatcher() が生成したdispatcherだけを記録するWeakSet。
 *
 * 【詳細説明】
 * - CFS integrationなど上位のcomposition layerが、任意の`{ dispatch() {} }`を
 *   bound dispatcherとして誤採用しないよう、module-private証跡として使う。
 *
 * @constant {WeakSet<object>}
 */
const TRUSTED_BOUND_PRINTER_COMMAND_DISPATCHERS = new WeakSet();

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
  "cfs-slot-select": Object.freeze({
    sideEffect: true,
    idempotent: false,
    expectedStateRequired: true,
  }),
  "cfs-feed": Object.freeze({
    sideEffect: true,
    idempotent: false,
    expectedStateRequired: true,
  }),
  "cfs-retract": Object.freeze({
    sideEffect: true,
    idempotent: false,
    expectedStateRequired: true,
  }),
});

/**
 * command kind ごとに送信直前で必要な capability。
 *
 * 【詳細説明】
 * - Gate 19 では CFS 操作を、単なる CFS topology 観測ではなく明示的な制御 capability がある時だけ許可する。
 *
 * @constant {object}
 */
const PRINTER_COMMAND_REQUIRED_CAPABILITIES = Object.freeze({
  "print-start": Object.freeze(["command.print-start"]),
  "print-stop": Object.freeze(["command.print-stop"]),
  "file-delete": Object.freeze(["command.file-delete"]),
  "cfs-load": Object.freeze(["material.cfs", "material.cfsTopology", "command.cfs-control"]),
  "cfs-unload": Object.freeze(["material.cfs", "material.cfsTopology", "command.cfs-control"]),
  "cfs-slot-select": Object.freeze(["material.cfs", "material.cfsTopology", "command.cfs-control"]),
  "cfs-feed": Object.freeze(["material.cfs", "material.cfsTopology", "command.cfs-control"]),
  "cfs-retract": Object.freeze(["material.cfs", "material.cfsTopology", "command.cfs-control"]),
});

/**
 * production dispatcher から送信を許可するcommand kind一覧。
 *
 * 【詳細説明】
 * - request生成時は未知commandを監査用に表現できるが、production dispatcherでは未知commandを送信しない。
 *
 * @constant {Set<string>}
 */
const PRINTER_COMMAND_DISPATCHABLE_KINDS = Object.freeze(new Set(Object.keys(PRINTER_COMMAND_KIND_CONTRACTS)));

/**
 * command が transport level で受理されたとみなせる status。
 *
 * 【詳細説明】
 * - `unknown`、`transport-error`、`transient-error` は expected-state が偶然一致しても完了扱いにしない。
 *
 * @constant {ReadonlySet<string>}
 */
const COMMAND_TRANSPORT_ACCEPTED_STATUSES = Object.freeze(new Set([
  "accepted",
  "acknowledged",
  "ok",
  "success",
]));

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
 * sequence 値を有限数へ正規化する。
 *
 * 【詳細説明】
 * - command correlation で比較する state sequence を数値として固定する。
 *
 * @private
 * @param {*} value - sequence 候補
 * @returns {number|null} 正規化済み sequence
 */
function normalizeSequence(value) {
  if (value === undefined || value === null || typeof value === "boolean" || Array.isArray(value)) {
    return null;
  }
  if (typeof value === "string" && !/^(0|[1-9]\d*)$/u.test(value.trim())) {
    return null;
  }
  const sequence = typeof value === "string" ? Number(value.trim()) : value;
  return Number.isFinite(sequence) ? sequence : null;
}

/**
 * capability 候補を Set へ正規化する。
 *
 * 【詳細説明】
 * - NormalizedState の `capabilities.values`、単純配列、Set のいずれも受け付ける。
 * - 送信時検証では存在確認だけを行うため、値は文字列化して重複排除する。
 *
 * @private
 * @param {*} value - capability 候補
 * @returns {Set<string>} capability set
 */
function normalizeCapabilitySet(value) {
  const rawValues = value instanceof Set
    ? Array.from(value)
    : (Array.isArray(value) ? value : (Array.isArray(value?.values) ? value.values : []));
  return new Set(rawValues.map((entry) => String(entry || "").trim()).filter(Boolean));
}

/**
 * command kind に必要な capability を返す。
 *
 * 【詳細説明】
 * - 未登録 command は未知のside-effect commandとして扱うが、capability名は推測せず空配列を返す。
 *
 * @private
 * @param {string} commandKind - command 種別
 * @returns {string[]} 必須 capability 名配列
 */
function getRequiredCommandCapabilities(commandKind) {
  return Array.from(PRINTER_COMMAND_REQUIRED_CAPABILITIES[commandKind] || []);
}

/**
 * command kind がproduction dispatcher送信対象か判定する。
 *
 * 【詳細説明】
 * - 未知commandは request contract 上は非冪等side-effectへ倒すが、send-timeでは明示拒否する。
 *
 * @private
 * @param {string} commandKind - command 種別
 * @returns {boolean} dispatcher送信対象ならtrue
 */
function isDispatchableCommandKind(commandKind) {
  return PRINTER_COMMAND_DISPATCHABLE_KINDS.has(String(commandKind || ""));
}

/**
 * command correlation evidence signature を生成する。
 *
 * 【詳細説明】
 * - signature は module-private secret を含み、plain object 偽装を拒否する。
 *
 * @private
 * @param {object} evidence - correlation evidence
 * @returns {string} signature
 */
function createCommandCorrelationSignature(evidence) {
  return createCommandId({
    deviceId: evidence.deviceId,
    sessionId: evidence.sessionId,
    commandKind: "command-correlation",
    idempotencyKey: [
      COMMAND_CORRELATION_EVIDENCE_SECRET,
      evidence.commandId,
      evidence.sentSequence,
      evidence.observedSequence,
      evidence.observedSessionId,
      evidence.evidenceSource,
      evidence.protocolCommandId || "",
    ].join("|"),
    entropySource: () => evidence.correlationId,
  });
}

/**
 * command dispatch context の attestation signature を生成する。
 *
 * 【詳細説明】
 * - context の active/session/capability/topology/upload identity を署名対象に含める。
 * - caller が context を手書きしても module-private secret が無いため検証に失敗する。
 *
 * @private
 * @param {object} context - dispatch context
 * @returns {string} attestation signature
 */
function createCommandDispatchContextSignature(context) {
  return createCommandId({
    deviceId: context.deviceId,
    sessionId: context.sessionId,
    commandKind: "dispatch-context",
    idempotencyKey: [
      COMMAND_DISPATCH_CONTEXT_SECRET,
      context.contextId,
      context.transportKind,
      context.active === true ? "active" : "inactive",
      (context.capabilities || []).join(","),
      context.materialTopology?.cfsConnected === true ? "cfs-connected" : "cfs-not-connected",
      context.materialTopology?.topologyState || "",
      (context.materialTopology?.sources || [])
        .map((source) => [source.sourceId, source.kind, source.boxId ?? "", source.slotId ?? ""].join(":"))
        .join(","),
      context.uploadGeneration || "",
      context.fileIdentity?.remotePath || "",
      context.fileIdentity?.fileHash || "",
      context.stateSequence ?? "",
      context.createdAt || "",
      context.issuedAtMs ?? "",
      context.expiresAtMs ?? "",
    ].join("|"),
    entropySource: () => context.contextId,
  });
}

/**
 * command dispatch context が dispatcher 発行の証跡を持つか検査する。
 *
 * 【詳細説明】
 * - `authority.canSend=true` のような単純フラグだけでは信頼しない。
 *
 * @private
 * @param {object|null|undefined} context - dispatch context
 * @returns {boolean} 正しい attestation を持つ場合 true
 */
function hasTrustedDispatchContext(context) {
  if (!context || typeof context !== "object") {
    return false;
  }
  const expected = createCommandDispatchContextSignature(context);
  return context.authority?.source === "printer-core-command-dispatcher" &&
    context.authority?.canSend === true &&
    context.authority?.attestation === expected;
}

/**
 * command correlation evidence を生成する。
 *
 * 【詳細説明】
 * - dispatcher/transport層が command ID と観測 state を結び付けた証跡を表現する。
 * - caller が boolean を渡すだけでは post-command confirmation を満たさない。
 *
 * @private
 * @param {object} request - command request
 * @param {object} options - correlation 生成オプション
 * @param {number} options.sentSequence - command 送信時 sequence
 * @param {number} options.observedSequence - 観測時 sequence
 * @param {string} options.observedSessionId - 観測 session ID
 * @param {string} options.evidenceSource - evidence source
 * @param {string=} options.protocolCommandId - transport/protocol側の応答IDまたはtransition ID
 * @param {string=} options.observedJobId - 観測 job ID
 * @param {string=} options.fileIdentity - 観測 file identity
 * @returns {object} command correlation evidence
 * @example
 * const correlation = createPrinterCommandCorrelationEvidence(request, { sentSequence, observedSequence, observedSessionId, evidenceSource });
 */
function createPrinterCommandCorrelationEvidence(request, options = {}) {
  const sentSequence = normalizeSequence(options.sentSequence);
  const observedSequence = normalizeSequence(options.observedSequence);
  const observedSessionId = requireNonEmptyString(options.observedSessionId, "observedSessionId");
  const evidenceSource = requireNonEmptyString(options.evidenceSource, "evidenceSource");
  if (sentSequence === null || observedSequence === null) {
    throw new TypeError("Printer command correlation requires finite sent/observed sequences.");
  }
  const correlationId = createCommandId({
    deviceId: request.deviceId,
    sessionId: request.sessionId,
    commandKind: "correlation",
    idempotencyKey: [request.commandId, sentSequence, observedSequence, observedSessionId].join("|"),
    entropySource: () => evidenceSource,
  });
  const evidence = {
    correlationId,
    commandId: request.commandId,
    deviceId: request.deviceId,
    sessionId: request.sessionId,
    sentSequence,
    observedSequence,
    observedSessionId,
    evidenceSource,
    protocolCommandId: options.protocolCommandId || null,
    observedJobId: options.observedJobId || null,
    fileIdentity: options.fileIdentity || null,
    attestation: null,
  };
  evidence.attestation = createCommandCorrelationSignature(evidence);
  return evidence;
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
 * Printer Core v3 production dispatcher 用の送信直前 context を生成する。
 *
 * 【詳細説明】
 * - request 作成時点の古い判断ではなく、送信直前に再取得した active session / capability / topology を固定する。
 * - 生成した context は module-private attestation を持ち、`validatePrinterCommandSendTime()` で偽装を検出できる。
 * - context は永続保存する authority ではなく、現在の接続sessionにだけ有効な一時証跡として扱う。
 *
 * @param {object} options - dispatch context 生成オプション
 * @param {string} options.deviceId - 現在接続中の device ID
 * @param {string} options.sessionId - 現在接続中の session ID
 * @param {string=} options.transportKind - 送信 transport 種別
 * @param {boolean=} options.active - 現在のsessionが送信可能なら true
 * @param {Array<string>|Set<string>|object=} options.capabilities - 現在のcapability set
 * @param {object=} options.materialTopology - 現在のmaterial topology summary
 * @param {boolean=} options.materialTopology.cfsConnected - CFS/CFS-Cが現在接続中なら true
 * @param {string=} options.materialTopology.topologyState - `fresh` / `stale` 等のtopology鮮度
 * @param {string=} options.uploadGeneration - remote file の現在upload generation
 * @param {object=} options.fileIdentity - remote file identity
 * @param {string=} options.fileIdentity.remotePath - remote path
 * @param {string=} options.fileIdentity.fileHash - content hash
 * @param {number=} options.stateSequence - 送信前に観測済みのstate sequence
 * @param {object=} options.observedState - 送信前のNormalizedState
 * @param {string=} options.createdAt - context生成時刻ISO文字列
 * @param {number=} options.issuedAtMs - context発行epoch ms
 * @param {number=} options.expiresAtMs - context失効epoch ms
 * @param {Function=} options.entropySource - contextId生成用source
 * @returns {object} dispatch context
 * @example
 * const context = createPrinterCommandDispatchContext({ deviceId, sessionId, active: true });
 */
function createPrinterCommandDispatchContext(options = {}) {
  const deviceId = requireNonEmptyString(options.deviceId, "deviceId");
  const sessionId = requireNonEmptyString(options.sessionId, "sessionId");
  const capabilities = Array.from(normalizeCapabilitySet(options.capabilities)).sort();
  const materialTopology = options.materialTopology && typeof options.materialTopology === "object"
    ? {
        cfsConnected: options.materialTopology.cfsConnected === true,
        topologyState: String(options.materialTopology.topologyState || "unobserved"),
        sourceCount: Number.isFinite(Number(options.materialTopology.sourceCount))
          ? Number(options.materialTopology.sourceCount)
          : null,
        sources: normalizeMaterialTopologySources(options.materialTopology.sources),
      }
    : {
        cfsConnected: false,
        topologyState: "unobserved",
        sourceCount: null,
        sources: [],
      };
  const fileIdentity = options.fileIdentity && typeof options.fileIdentity === "object"
    ? {
        remotePath: String(options.fileIdentity.remotePath || options.fileIdentity.path || "").trim() || null,
        fileHash: String(options.fileIdentity.fileHash || options.fileIdentity.contentHash || options.fileIdentity.sha256 || "").trim() || null,
      }
    : {
        remotePath: null,
        fileHash: null,
      };
  const contextId = createCommandId({
    deviceId,
    sessionId,
    commandKind: "dispatch-context",
    idempotencyKey: options.uploadGeneration || null,
    entropySource: options.entropySource,
  });
  const context = {
    schemaVersion: PRINTER_COMMAND_DISPATCH_CONTEXT_SCHEMA_VERSION,
    contextId,
    deviceId,
    sessionId,
    transportKind: options.transportKind || "unknown",
    active: options.active === true,
    capabilities,
    materialTopology,
    uploadGeneration: String(options.uploadGeneration || "").trim() || null,
    fileIdentity,
    stateSequence: normalizeSequence(options.stateSequence ?? options.sequence),
    observedState: cloneJsonValue(options.observedState || null),
    createdAt: options.createdAt || null,
    issuedAtMs: Number.isFinite(Number(options.issuedAtMs)) ? Number(options.issuedAtMs) : null,
    expiresAtMs: Number.isFinite(Number(options.expiresAtMs)) ? Number(options.expiresAtMs) : null,
    authority: {
      source: "printer-core-command-dispatcher",
      canSend: true,
      attestation: null,
    },
  };
  context.authority.attestation = createCommandDispatchContextSignature(context);
  return context;
}

/**
 * material topology source 一覧をsend-time検証用へ正規化する。
 *
 * 【詳細説明】
 * - CFS操作targetを現在のtopologyへbindするため、sourceId/kind/boxId/slotId/presenceだけを保持する。
 *
 * @private
 * @param {*} sources - topology sources候補
 * @returns {Array<object>} 正規化済みsource一覧
 */
function normalizeMaterialTopologySources(sources) {
  return (Array.isArray(sources) ? sources : []).map((source) => ({
    sourceId: String(source?.sourceId || "").trim() || null,
    kind: String(source?.kind || "").trim() || null,
    boxId: normalizeSequence(source?.boxId),
    slotId: normalizeSequence(source?.slotId ?? source?.protocolSlotId),
    presence: String(source?.presence || source?.status?.presence || "").trim() || null,
  })).filter((source) => source.sourceId);
}

/**
 * print-start command の送信時 file/upload binding を検査する。
 *
 * 【詳細説明】
 * - upload receipt / file identity が古いまま再利用されると別fileを開始する危険があるため、
 *   command payload と送信時contextのidentityを照合する。
 *
 * @private
 * @param {object} request - command request
 * @param {object} context - dispatch context
 * @returns {string[]} 検査エラー
 */
function collectPrintStartSendTimeErrors(request, context) {
  if (request.commandKind !== "print-start") {
    return [];
  }
  const errors = [];
  const requestUploadGeneration = String(request.payload?.startContext?.uploadGeneration || "").trim();
  const contextUploadGeneration = String(context.uploadGeneration || "").trim();
  if (!requestUploadGeneration || !contextUploadGeneration || requestUploadGeneration !== contextUploadGeneration) {
    errors.push("upload-generation-mismatch");
  }
  const requestRemotePath = String(request.payload?.asset?.path || request.payload?.asset?.remotePath || "").trim();
  const contextRemotePath = String(context.fileIdentity?.remotePath || "").trim();
  if (!requestRemotePath || !contextRemotePath || requestRemotePath !== contextRemotePath) {
    errors.push("file-identity-path-mismatch");
  }
  const requestFileHash = String(request.payload?.asset?.fileHash || "").trim();
  const contextFileHash = String(context.fileIdentity?.fileHash || "").trim();
  if (!requestFileHash || !contextFileHash || requestFileHash !== contextFileHash) {
    errors.push("file-identity-hash-mismatch");
  }
  const materialSourceIds = Array.isArray(request.payload?.materialSourceIds)
    ? request.payload.materialSourceIds.map((sourceId) => String(sourceId || "").trim()).filter(Boolean)
    : [];
  if (materialSourceIds.length > 0) {
    if (context.materialTopology?.cfsConnected !== true) {
      errors.push("print-start-cfs-not-connected");
    }
    if (context.materialTopology?.topologyState !== "fresh") {
      errors.push("print-start-cfs-topology-not-fresh");
    }
    const currentSources = Array.isArray(context.materialTopology?.sources)
      ? context.materialTopology.sources
      : [];
    for (const sourceId of materialSourceIds) {
      const currentSource = currentSources.find((source) => source.sourceId === sourceId);
      if (!currentSource) {
        errors.push(`print-start-material-source-not-current:${sourceId}`);
      } else if (currentSource.kind !== "cfs-slot") {
        errors.push(`print-start-material-source-not-cfs-slot:${sourceId}`);
      } else if (currentSource.presence !== "loaded") {
        errors.push(`print-start-material-source-not-loaded:${sourceId}`);
      }
    }
  }
  return errors;
}

/**
 * CFS command の送信時 topology を検査する。
 *
 * 【詳細説明】
 * - CFS操作は最後に観測した古いtopologyではなく、現在freshかつconnectedなtopologyを要求する。
 *
 * @private
 * @param {object} request - command request
 * @param {object} context - dispatch context
 * @returns {string[]} 検査エラー
 */
function collectCfsSendTimeErrors(request, context) {
  if (!String(request.commandKind || "").startsWith("cfs-")) {
    return [];
  }
  const errors = [];
  if (context.materialTopology?.cfsConnected !== true) {
    errors.push("cfs-not-connected");
  }
  if (context.materialTopology?.topologyState !== "fresh") {
    errors.push("cfs-topology-not-fresh");
  }
  const targetSourceId = String(request.payload?.sourceId || "").trim();
  if (!targetSourceId) {
    errors.push("cfs-target-source-missing");
    return errors;
  }
  const currentSource = (Array.isArray(context.materialTopology?.sources) ? context.materialTopology.sources : [])
    .find((source) => source.sourceId === targetSourceId);
  if (!currentSource) {
    errors.push("cfs-target-source-not-current");
    return errors;
  }
  if (currentSource.kind !== "cfs-slot") {
    errors.push("cfs-target-not-cfs-slot");
  }
  const requestBoxId = normalizeSequence(request.payload?.boxId);
  if (requestBoxId !== null && currentSource.boxId !== null && requestBoxId !== currentSource.boxId) {
    errors.push("cfs-target-box-mismatch");
  }
  const requestSlotId = normalizeSequence(request.payload?.slotId ?? request.payload?.protocolSlotId ?? request.payload?.slotIndex);
  if (requestSlotId !== null && currentSource.slotId !== null && requestSlotId !== currentSource.slotId) {
    errors.push("cfs-target-slot-mismatch");
  }
  return errors;
}

/**
 * command request を送信直前contextで再検証する。
 *
 * 【詳細説明】
 * - request生成時点の判断を信用せず、active session / capability / material topology / upload identity を再確認する。
 * - contextはdispatcher発行のattestationを要求し、永続保存された古いauthorityやcaller手書きcontextを拒否する。
 *
 * @function validatePrinterCommandSendTime
 * @param {object|null|undefined} request - command request
 * @param {object|null|undefined} context - dispatch context
 * @returns {{ok: boolean, errors: string[]}} 検査結果
 * @example
 * const validation = validatePrinterCommandSendTime(request, context);
 */
export function validatePrinterCommandSendTime(request, context) {
  const errors = [];
  const requestValidation = validatePrinterCommandRequest(request);
  if (!requestValidation.ok) {
    errors.push(...requestValidation.errors.map((error) => `request:${error}`));
  }
  if (!context || typeof context !== "object") {
    return { ok: false, errors: [...errors, "missing-dispatch-context"] };
  }
  if (!isDispatchableCommandKind(request?.commandKind)) {
    errors.push("unsupported-command-kind");
  }
  if (context.schemaVersion !== PRINTER_COMMAND_DISPATCH_CONTEXT_SCHEMA_VERSION) {
    errors.push("unexpected-dispatch-context-schema-version");
  }
  if (!hasTrustedDispatchContext(context)) {
    errors.push("untrusted-dispatch-context");
  }
  if (context.active !== true) {
    errors.push("dispatch-context-not-active");
  }
  const nowMs = Date.now();
  if (Number.isFinite(Number(context.expiresAtMs)) && nowMs > Number(context.expiresAtMs)) {
    errors.push("dispatch-context-expired");
  }
  if (request?.deviceId && context.deviceId !== request.deviceId) {
    errors.push("device-mismatch");
  }
  if (request?.sessionId && context.sessionId !== request.sessionId) {
    errors.push("session-mismatch");
  }
  if (
    request?.transportKind &&
    request.transportKind !== "unknown" &&
    request.transportKind !== "pending-adapter" &&
    context.transportKind !== "unknown" &&
    context.transportKind !== request.transportKind
  ) {
    errors.push("transport-kind-mismatch");
  }
  const capabilities = normalizeCapabilitySet(context.capabilities);
  for (const capability of getRequiredCommandCapabilities(request?.commandKind)) {
    if (!capabilities.has(capability)) {
      errors.push(`missing-capability:${capability}`);
    }
  }
  errors.push(...collectCfsSendTimeErrors(request || {}, context));
  errors.push(...collectPrintStartSendTimeErrors(request || {}, context));
  return {
    ok: errors.length === 0,
    errors,
  };
}

/**
 * validation failure 用の command result を生成する。
 *
 * 【詳細説明】
 * - request自体が壊れている場合でも、dispatcher caller が同じshapeで失敗を扱えるようにする。
 *
 * @private
 * @param {object|null|undefined} request - command request
 * @param {string[]} errors - validation errors
 * @returns {object} rejected result
 */
function createRejectedCommandResult(request, errors) {
  return {
    schemaVersion: PRINTER_COMMAND_SCHEMA_VERSION,
    commandId: request?.commandId || null,
    deviceId: request?.deviceId || null,
    sessionId: request?.sessionId || null,
    commandKind: request?.commandKind || null,
    status: "rejected",
    transportAccepted: false,
    completed: false,
    response: null,
    error: {
      code: "send-time-validation-failed",
      errors: cloneJsonValue(errors),
    },
    confirmation: {
      checked: false,
      confirmed: false,
      checks: [],
    },
    postCommandObservation: {
      required: Boolean(request?.expectedStateRequired),
      confirmed: false,
      reason: "send-time-validation-failed",
    },
    completedAt: null,
  };
}

/**
 * transport response から result status を正規化する。
 *
 * 【詳細説明】
 * - 既存 `sendCommand()` は fire-and-forget で `null` を返すため、例外なく戻った場合は acknowledged とする。
 *
 * @private
 * @param {*} response - transport response
 * @returns {string} command result status
 */
function normalizeTransportStatus(response) {
  const status = String(response?.status || response?.result || "").trim();
  return status || "acknowledged";
}

/**
 * observeState hook の戻り値から観測情報を取り出す。
 *
 * 【詳細説明】
 * - test / connection layer / future PrinterSession のどれからでも使えるよう、複数aliasを受け付ける。
 *
 * @private
 * @param {*} observation - observeState hook の戻り値
 * @param {object} context - dispatch context
 * @returns {object} command result 用の観測情報
 */
function normalizeCommandObservation(observation, context) {
  const observedState = observation?.observedState || observation?.state || context.observedState || null;
  const observedSequence = normalizeSequence(
    observation?.observedSequence ??
    observation?.sequence ??
    observedState?.source?.sequence
  );
  const observedSessionId = String(
    observation?.observedSessionId ||
    observation?.sessionId ||
    observedState?.source?.sessionId ||
    context.sessionId ||
    ""
  ).trim();
  return {
    observedState,
    observedSequence,
    observedSessionId,
    observedJobId: observation?.observedJobId || observedState?.print?.jobId || null,
    fileIdentity: observation?.fileIdentity || context.fileIdentity || null,
    commandCorrelation: observation?.commandCorrelation || null,
    trustedCorrelationProof: observation?.trustedCorrelationProof || observation?.protocolCorrelation || null,
  };
}

/**
 * trusted command correlation proofを正規化する。
 *
 * 【詳細説明】
 * - protocol応答ID、またはadapter/sessionが発行したtransition IDが無いproofは採用しない。
 * - 単なるsequence進行だけでcorrelationを作らないための狭い入口にする。
 *
 * @private
 * @param {*} proof - observation provider が返したtrusted proof候補
 * @returns {object|null} 正規化済みproof、またはnull
 */
function normalizeTrustedCommandCorrelationProof(proof) {
  if (!proof || typeof proof !== "object") {
    return null;
  }
  const evidenceSource = String(proof.evidenceSource || proof.source || "").trim();
  const commandId = String(proof.commandId || "").trim();
  const sessionId = String(proof.sessionId || "").trim();
  const protocolCommandId = String(proof.protocolCommandId || proof.protocolResponseId || proof.responseId || "").trim();
  const transitionId = String(proof.transitionId || "").trim();
  const correlationBindingId = protocolCommandId || transitionId;
  if (!evidenceSource || !commandId || !sessionId || !correlationBindingId) {
    return null;
  }
  return {
    evidenceSource,
    protocolCommandId: correlationBindingId,
    bindingKind: protocolCommandId ? "protocol-response" : "state-transition",
    commandId,
    sessionId,
  };
}

/**
 * transport responseからprotocol command ID候補を取得する。
 *
 * 【詳細説明】
 * - trusted proofがprotocol response IDを根拠にする場合、transportの戻り値と同じIDであることを検査する。
 *
 * @private
 * @param {*} response - transport response
 * @returns {string|null} protocol command ID、未観測ならnull
 */
function getTransportProtocolCommandId(response) {
  const value = response?.protocolCommandId || response?.protocolResponseId || response?.responseId || response?.requestId || "";
  const text = String(value).trim();
  return text || null;
}

/**
 * trusted observation proofからcommand correlation evidenceを生成する。
 *
 * 【詳細説明】
 * - bound dispatcherだけが持つprivate tokenが無い場合は何も生成しない。
 * - session、commandId、sequence進行を再検査し、trusted proofと現在観測が矛盾する場合はfail-closedでnullにする。
 *
 * @private
 * @param {object} request - command request
 * @param {object} context - dispatcher内部発行context
 * @param {object} observation - 正規化済みobservation
 * @param {number|null} sentSequence - 送信時sequence
 * @param {*} transportResponse - transport response
 * @param {symbol=} issuerToken - trusted issuer token
 * @returns {object|null} command correlation evidence、またはnull
 */
function createTrustedCommandCorrelationFromObservation(request, context, observation, sentSequence, transportResponse, issuerToken) {
  if (issuerToken !== TRUSTED_COMMAND_CORRELATION_ISSUER) {
    return null;
  }
  const proof = normalizeTrustedCommandCorrelationProof(observation?.trustedCorrelationProof);
  if (!proof) {
    return null;
  }
  const observedSequence = normalizeSequence(observation?.observedSequence);
  const observedSessionId = String(observation?.observedSessionId || "").trim();
  if (sentSequence === null || observedSequence === null || observedSequence <= sentSequence) {
    return null;
  }
  if (!observedSessionId || observedSessionId !== context.sessionId || observedSessionId !== request.sessionId) {
    return null;
  }
  if (proof.commandId !== request.commandId) {
    return null;
  }
  if (proof.sessionId !== context.sessionId) {
    return null;
  }
  const transportProtocolCommandId = getTransportProtocolCommandId(transportResponse);
  if (
    proof.bindingKind === "protocol-response" &&
    (!transportProtocolCommandId || proof.protocolCommandId !== transportProtocolCommandId)
  ) {
    return null;
  }
  try {
    return createPrinterCommandCorrelationEvidence(request, {
      sentSequence,
      observedSequence,
      observedSessionId,
      evidenceSource: proof.evidenceSource,
      protocolCommandId: proof.protocolCommandId,
      observedJobId: observation?.observedJobId || undefined,
      fileIdentity: observation?.fileIdentity?.fileHash || observation?.fileIdentity?.remotePath || undefined,
    });
  } catch {
    return null;
  }
}

/**
 * UIへ安全に渡せるbound command dispatcherを生成する。
 *
 * 【詳細説明】
 * - UIは返却された`dispatch(request)`だけを呼び出し、send-time context providerやtransportを差し替えられない。
 * - trusted correlation proofはこのbound dispatcher経由の場合だけmodule-private token付きで評価される。
 * - この関数自体は実transportを開かず、composition layerが信頼済みproviderを束ねるための境界を作る。
 *
 * @function createBoundPrinterCommandDispatcher
 * @param {object} providers - trusted provider群
 * @param {Function} providers.getSendTimeContext - 送信直前snapshot provider
 * @param {Function} providers.sendTransport - transport送信provider
 * @param {Function=} providers.observeState - trusted observation provider
 * @param {Function=} providers.nowMs - epoch ms provider
 * @param {number=} providers.contextTtlMs - context TTL ms
 * @param {string=} providers.completedAt - 完了時刻ISO文字列
 * @returns {object} bound dispatcher
 * @example
 * const dispatcher = createBoundPrinterCommandDispatcher({ getSendTimeContext, sendTransport });
 * const result = await dispatcher.dispatch(request);
 */
export function createBoundPrinterCommandDispatcher(providers = {}) {
  if (typeof providers.getSendTimeContext !== "function") {
    throw new TypeError("Bound printer command dispatcher requires getSendTimeContext.");
  }
  if (typeof providers.sendTransport !== "function") {
    throw new TypeError("Bound printer command dispatcher requires sendTransport.");
  }
  const dispatcher = Object.freeze({
    dispatch(request) {
      return dispatchPrinterCommand(request, {
        getSendTimeContext: providers.getSendTimeContext,
        sendTransport: providers.sendTransport,
        observeState: providers.observeState,
        nowMs: providers.nowMs,
        contextTtlMs: providers.contextTtlMs,
        completedAt: providers.completedAt,
        trustedCorrelationIssuer: TRUSTED_COMMAND_CORRELATION_ISSUER,
      });
    },
  });
  TRUSTED_BOUND_PRINTER_COMMAND_DISPATCHERS.add(dispatcher);
  return dispatcher;
}

/**
 * 対象objectがPrinter Core v3のbound dispatcherかを判定する。
 *
 * 【詳細説明】
 * - 単に`dispatch()`を持つobjectではなく、`createBoundPrinterCommandDispatcher()`が生成した
 *   objectだけをtrueにする。
 * - rendererや任意callerがtransport/context providerを差し替えたdispatcher風objectを渡しても、
 *   上位integrationでfail-closedにできる。
 *
 * @function isBoundPrinterCommandDispatcher
 * @param {*} dispatcher - 判定対象
 * @returns {boolean} bound dispatcher由来ならtrue
 * @example
 * const ok = isBoundPrinterCommandDispatcher(dispatcher);
 */
export function isBoundPrinterCommandDispatcher(dispatcher) {
  return Boolean(
    dispatcher &&
    typeof dispatcher === "object" &&
    typeof dispatcher.dispatch === "function" &&
    TRUSTED_BOUND_PRINTER_COMMAND_DISPATCHERS.has(dispatcher)
  );
}

/**
 * Printer Core v3 command を production dispatcher 経由で実行する。
 *
 * 【詳細説明】
 * - 送信前に `validatePrinterCommandSendTime()` を必ず通し、失敗時はtransportを呼ばず rejected result を返す。
 * - transport成功後も、expected-state required command は観測state、sequence進行、session一致、command correlation が揃うまで completed にしない。
 * - side-effect command の blind retry はここでも実行せず、callerには result と `shouldRetryPrinterCommand()` の判定を委ねる。
 *
 * @function dispatchPrinterCommand
 * @param {object} request - command request
 * @param {object=} options - dispatcher options
 * @param {Function} options.getSendTimeContext - 送信直前snapshot取得hook
 * @param {Function} options.sendTransport - transport送信hook `(request, context) => Promise<*>`
 * @param {Function=} options.observeState - expected-state確認用観測hook `(request, context, response) => Promise<object>`
 * @param {string=} options.completedAt - result完了時刻ISO文字列
 * @returns {Promise<object>} command result
 * @example
 * const result = await dispatchPrinterCommand(request, { getSendTimeContext, sendTransport, observeState });
 */
export async function dispatchPrinterCommand(request, options = {}) {
  if (typeof options.getSendTimeContext !== "function") {
    return createRejectedCommandResult(request, ["missing-send-time-context"]);
  }
  const nowMs = typeof options.nowMs === "function" ? Number(options.nowMs()) : Date.now();
  let context = null;
  try {
    const rawContext = await options.getSendTimeContext(request);
    context = createPrinterCommandDispatchContext({
      ...(rawContext && typeof rawContext === "object" ? rawContext : {}),
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + (Number.isFinite(Number(options.contextTtlMs)) ? Number(options.contextTtlMs) : 1000),
    });
  } catch {
    return createRejectedCommandResult(request, ["invalid-send-time-context"]);
  }
  const sendTimeValidation = validatePrinterCommandSendTime(request, context);
  if (!sendTimeValidation.ok) {
    return createRejectedCommandResult(request, sendTimeValidation.errors);
  }
  if (typeof options.sendTransport !== "function") {
    return createRejectedCommandResult(request, ["missing-send-transport"]);
  }
  let response;
  try {
    response = await options.sendTransport(request, context);
  } catch (error) {
    return createPrinterCommandResult(request, {
      status: "transport-error",
      error: {
        code: "transport-error",
        message: error?.message || String(error),
      },
      completedAt: options.completedAt || null,
    });
  }
  let observation;
  try {
    observation = typeof options.observeState === "function"
      ? await options.observeState(request, context, response)
      : null;
  } catch (error) {
    return createPrinterCommandResult(request, {
      status: "confirmation-error",
      response,
      error: {
        code: "confirmation-error",
        message: error?.message || String(error),
      },
      completedAt: options.completedAt || null,
    });
  }
  const normalizedObservation = normalizeCommandObservation(observation, context);
  const sentSequence = normalizeSequence(context.stateSequence);
  const commandCorrelation = normalizedObservation.commandCorrelation ||
    createTrustedCommandCorrelationFromObservation(
      request,
      context,
      normalizedObservation,
      sentSequence,
      response,
      options.trustedCorrelationIssuer
    );
  return createPrinterCommandResult(request, {
    status: normalizeTransportStatus(response),
    response,
    observedState: normalizedObservation.observedState,
    sentSequence,
    observedSequence: normalizedObservation.observedSequence,
    observedSessionId: normalizedObservation.observedSessionId,
    commandCorrelation,
    completedAt: options.completedAt || null,
  });
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
 * command 後の観測であることを検査する。
 *
 * 【詳細説明】
 * - expected-state が一致しても、それが command 送信前から成立していた状態なら完了証拠にはならない。
 * - Gate 14 contract では sequence/session/correlation を呼び出し側に明示させ、欠落時は fail closed にする。
 *
 * @private
 * @param {object} request - command request
 * @param {object=} options - result 生成オプション
 * @param {number=} options.sentSequence - command 送信時の state sequence
 * @param {number=} options.observedSequence - confirmation 観測時の state sequence
 * @param {string=} options.observedSessionId - confirmation 観測の session ID
 * @param {object=} options.commandCorrelation - command correlation evidence
 * @returns {object} post-command observation 判定
 */
function evaluatePostCommandObservation(request, options = {}) {
  if (!request?.expectedStateRequired) {
    return {
      required: false,
      confirmed: true,
      reason: "not-required",
    };
  }
  const sentSequence = normalizeSequence(options.sentSequence);
  const observedSequence = normalizeSequence(options.observedSequence);
  const sequenceAdvanced = sentSequence !== null &&
    observedSequence !== null &&
    observedSequence > sentSequence;
  const observedSessionId = String(options.observedSessionId || "").trim();
  const sameSession = Boolean(observedSessionId) && observedSessionId === request.sessionId;
  const correlation = options.commandCorrelation;
  const expectedCorrelationSignature = correlation && typeof correlation === "object"
    ? createCommandCorrelationSignature(correlation)
    : null;
  const commandCorrelated = Boolean(
    correlation &&
    typeof correlation === "object" &&
    correlation.commandId === request.commandId &&
    correlation.sessionId === request.sessionId &&
    correlation.sentSequence === sentSequence &&
    correlation.observedSequence === observedSequence &&
    correlation.observedSessionId === observedSessionId &&
    correlation.attestation === expectedCorrelationSignature
  );
  const missing = [];
  if (!sequenceAdvanced) missing.push("sequence-not-advanced");
  if (!sameSession) missing.push("session-mismatch");
  if (!commandCorrelated) missing.push("command-correlation-missing");
  return {
    required: true,
    confirmed: missing.length === 0,
    sequenceAdvanced,
    sameSession,
    commandCorrelated,
    sentSequence,
    observedSequence,
    observedSessionId: observedSessionId || null,
    correlationId: commandCorrelated ? correlation.correlationId : null,
    reason: missing.length ? missing.join(",") : "confirmed",
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
 * @param {number=} options.sentSequence - command 送信時の state sequence
 * @param {number=} options.observedSequence - confirmation 観測時の state sequence
 * @param {string=} options.observedSessionId - confirmation 観測の session ID
 * @param {object=} options.commandCorrelation - command correlation evidence
 * @param {string=} options.completedAt - 完了時刻 ISO 文字列
 * @returns {object} command result
 * @example
 * const result = createPrinterCommandResult(request, { status: "acknowledged" });
 */
export function createPrinterCommandResult(request, options = {}) {
  const confirmation = evaluateExpectedStateConfirmation(request, options.observedState);
  const status = options.status || "unknown";
  const transportAccepted = !options.error && COMMAND_TRANSPORT_ACCEPTED_STATUSES.has(status);
  const hasError = Boolean(options.error) || !transportAccepted;
  const postCommandObservation = evaluatePostCommandObservation(request, options);
  const completed = transportAccepted &&
    (!request.expectedStateRequired || (confirmation.confirmed && postCommandObservation.confirmed));
  return {
    schemaVersion: PRINTER_COMMAND_SCHEMA_VERSION,
    commandId: request.commandId,
    deviceId: request.deviceId,
    sessionId: request.sessionId,
    commandKind: request.commandKind,
    status,
    transportAccepted,
    completed,
    response: cloneJsonValue(options.response || null),
    error: cloneJsonValue(options.error || null),
    confirmation,
    postCommandObservation,
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
