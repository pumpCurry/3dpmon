#!/usr/bin/env node
/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 K2 CFS slot control certification CLI
 * @file capture_k2_cfs_slot_control.mjs
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module capture_k2_cfs_slot_control
 *
 * 【機能内容サマリ】
 * - Gate19 K2/CFS slot control candidate transport plan をCLIからdry-run確認する
 * - `--send` が明示された場合だけWS9999へcertification-only `feedInOrOut` candidateを送る
 * - live送信にはhost一致、command一致、live確認を必須にし、UI本番操作とは分離する
 * - live certification時に任意で前後のread-only `boxsInfo` probeを行い、観測差分の材料を残す
 *
 * 【公開関数一覧】
 * - {@link parseArgs}：CLI引数を解析
 * - {@link buildK2CfsSlotControlRequest}：transport plan用requestを生成
 * - {@link sendBoxsInfoProbeAndWait}：read-only boxsInfo probeを送信して応答を待つ
 * - {@link runK2CfsSlotControlCertification}：dry-runまたは明示送信を実行
 *
 * @version 1.390.1523 (PR #439)
 * @since   1.390.1415 (PR #435)
 * @lastModified 2026-08-31 16:32:06
 * -----------------------------------------------------------
 * @todo
 * - 実機Gateでpost-command boxsInfo probeとscenario fixture保存を統合する
 */

import { WebSocket } from "ws";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createK2CfsCommandTransportPlan,
  sendK2CfsCommandTransportPlan,
} from "../3dp_lib/printer_core/dashboard_k2_cfs_command_transport.js";

/**
 * CLI usage text。
 *
 * 【詳細説明】
 * - 既定dry-runであることと、`--send` が実機へ送る危険境界であることを明示する。
 *
 * @constant {string}
 */
const USAGE = `
Usage:
  node scripts/capture_k2_cfs_slot_control.mjs --command <kind> --source <cfs-source-id>

Examples:
  node scripts/capture_k2_cfs_slot_control.mjs --command cfs-load --source cfs:1:slot:0 --pretty

Options:
  --command <kind>                One of cfs-slot-select, cfs-load, cfs-unload, cfs-feed, cfs-retract. Required.
  --source <source-id>            Normalized CFS source id, for example cfs:1:slot:0. Required.
  --host <ip-or-host>             K2 host. Required only when --send is used.
  --ws-port <number>              WebSocket port. Default: 9999.
  --send                          Actually send the candidate frame to the printer. Default is dry-run.
  --confirm-live                  Required with --send to acknowledge live CFS motion.
  --confirm-host <ip-or-host>      Required with --send and must match --host exactly.
  --confirm-command <kind>         Required with --send and must match --command exactly.
  --probe-before                  With --send, read boxsInfo before the command.
  --probe-after                   With --send, read boxsInfo after the command.
  --boxsinfo-timeout-ms <number>   Probe response timeout. Default: 5000.
  --output-dir <path>             Write certification-result.json under a timestamped directory.
  --pretty                        Pretty-print JSON result.
  --help                          Show this help.
`;

/**
 * Gate19でdry-run候補として扱うCFS command kind一覧。
 *
 * 【詳細説明】
 * - 本番UI操作で許可する一覧ではない。
 * - このCLIはcertification-only transport planを確認するための入口である。
 *
 * @constant {ReadonlySet<string>}
 */
const SUPPORTED_SLOT_CONTROL_COMMANDS = Object.freeze(new Set([
  "cfs-slot-select",
  "cfs-load",
  "cfs-unload",
  "cfs-feed",
  "cfs-retract",
]));

/**
 * F012 live certificationで送信候補として扱うCFS command kind一覧。
 *
 * 【詳細説明】
 * - 公開CrealityPrint bundle上で `feedInOrOut` との関係が最も強いload/unloadだけを初期live対象にする。
 * - select/feed/retractはdry-run候補としてshape確認だけ許し、実機送信は別途capture根拠が揃うまで閉じる。
 *
 * @constant {ReadonlySet<string>}
 */
const LIVE_CERTIFIABLE_SLOT_CONTROL_COMMANDS = Object.freeze(new Set([
  "cfs-load",
  "cfs-unload",
]));

/**
 * boxsInfo probe の既定待ち時間。
 *
 * 【詳細説明】
 * - 実機certificationでは送信直後の状態更新に少し遅延があるため、短すぎる待ち時間にしない。
 * - 一方でCLIが無限待ちになると危険なので、既定は5秒に固定する。
 *
 * @constant {number}
 */
const DEFAULT_BOXSINFO_TIMEOUT_MS = 5000;

/**
 * 任意値を空でない文字列へ正規化する。
 *
 * 【詳細説明】
 * - CLI境界で空白だけの値を欠落として扱う。
 *
 * @private
 * @param {*} value - 文字列候補
 * @returns {string|null} 空でない文字列、またはnull
 */
function toNonEmptyString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

/**
 * CLI引数を解析する。
 *
 * 【詳細説明】
 * - `--send` が無い限りhostやlive confirmationを要求しない。
 * - `--send` 時はhost一致に加えてcommand一致も要求し、コピーしたdry-run結果と別操作を誤送信しない。
 *
 * @function parseArgs
 * @param {string[]} argv - `process.argv.slice(2)` 相当
 * @returns {object} 解析済みオプション
 * @example
 * const options = parseArgs(["--command", "cfs-load", "--source", "cfs:1:slot:0"]);
 */
export function parseArgs(argv = []) {
  const options = {
    command: "",
    source: "",
    host: "",
    wsPort: 9999,
    send: false,
    confirmLive: false,
    confirmHost: "",
    confirmCommand: "",
    probeBefore: false,
    probeAfter: false,
    boxsInfoTimeoutMs: DEFAULT_BOXSINFO_TIMEOUT_MS,
    outputDir: "",
    pretty: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return argv[index];
    };
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--command") options.command = next();
    else if (arg === "--source") options.source = next();
    else if (arg === "--host") options.host = next();
    else if (arg === "--ws-port") options.wsPort = Number(next());
    else if (arg === "--send") options.send = true;
    else if (arg === "--confirm-live") options.confirmLive = true;
    else if (arg === "--confirm-host") options.confirmHost = next();
    else if (arg === "--confirm-command") options.confirmCommand = next();
    else if (arg === "--probe-before") options.probeBefore = true;
    else if (arg === "--probe-after") options.probeAfter = true;
    else if (arg === "--boxsinfo-timeout-ms") options.boxsInfoTimeoutMs = Number(next());
    else if (arg === "--output-dir") options.outputDir = next();
    else if (arg === "--pretty") options.pretty = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.wsPort) || options.wsPort <= 0 || options.wsPort > 65535) {
    throw new Error("--ws-port must be a valid TCP port.");
  }
  if (!Number.isInteger(options.boxsInfoTimeoutMs) ||
      options.boxsInfoTimeoutMs < 1000 ||
      options.boxsInfoTimeoutMs > 60000) {
    throw new Error("--boxsinfo-timeout-ms must be between 1000 and 60000.");
  }
  const command = toNonEmptyString(options.command);
  if (!options.help && !SUPPORTED_SLOT_CONTROL_COMMANDS.has(command)) {
    throw new Error("--command must be one of cfs-slot-select, cfs-load, cfs-unload, cfs-feed, cfs-retract.");
  }
  if (!options.help && !toNonEmptyString(options.source)) {
    throw new Error("--source is required.");
  }
  if (options.send && !toNonEmptyString(options.host)) {
    throw new Error("--host is required when --send is used.");
  }
  if (options.send && options.confirmLive !== true) {
    throw new Error("--confirm-live is required when --send is used.");
  }
  if (options.send && toNonEmptyString(options.confirmHost) !== toNonEmptyString(options.host)) {
    throw new Error("--confirm-host must exactly match --host when --send is used.");
  }
  if (options.send && toNonEmptyString(options.confirmCommand) !== command) {
    throw new Error("--confirm-command must exactly match --command when --send is used.");
  }
  if (options.send && !LIVE_CERTIFIABLE_SLOT_CONTROL_COMMANDS.has(command)) {
    throw new Error("--send is currently limited to cfs-load and cfs-unload for F012 live certification.");
  }
  if (toNonEmptyString(options.outputDir)) {
    options.outputDir = path.resolve(options.outputDir);
  }
  return options;
}

/**
 * transport plan用のCFS slot control requestを生成する。
 *
 * 【詳細説明】
 * - command authority本体へは通さず、transport mapping確認に限定する。
 * - sourceIdはtransport module側でも `cfs:<box>:slot:<slot>` として再検証される。
 *
 * @function buildK2CfsSlotControlRequest
 * @param {object} options - CLIオプション
 * @returns {object} Printer Core command request風object
 * @example
 * const request = buildK2CfsSlotControlRequest(options);
 */
export function buildK2CfsSlotControlRequest(options) {
  return {
    commandKind: options.command,
    transportKind: "ws9999",
    payload: {
      sourceId: options.source,
      certificationIntentId: `live-certification:${Date.now()}`,
    },
  };
}

/**
 * 受信payload内から `boxsInfo` を再帰的に探す。
 *
 * 【詳細説明】
 * - WS9999の応答はroot直下、`result`、`data`、`params`など複数のenvelopeを取り得る。
 * - CLI certificationではschemaを固定せず、どこに現れたかと値を観測証拠として返す。
 *
 * @function findBoxsInfoEvidence
 * @param {*} value - 探索対象payload
 * @param {string=} pathPrefix - 再帰探索中のpath
 * @returns {object|null} `boxsInfo` を含む証拠、無い場合null
 * @example
 * const evidence = findBoxsInfoEvidence({ result: { boxsInfo: {} } });
 */
export function findBoxsInfoEvidence(value, pathPrefix = "$") {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(value, "boxsInfo")) {
    return {
      path: `${pathPrefix}.boxsInfo`,
      value: value.boxsInfo,
    };
  }
  for (const [key, child] of Object.entries(value)) {
    const evidence = findBoxsInfoEvidence(child, `${pathPrefix}.${key}`);
    if (evidence) {
      return evidence;
    }
  }
  return null;
}

/**
 * WebSocket message payloadをJSON候補として解析する。
 *
 * 【詳細説明】
 * - `ws` はBuffer/stringの両方を返し得るため、JSON parse可能なtextだけを採用する。
 * - parse不能なheartbeat等はprobe応答として扱わず、待機を継続する。
 *
 * @private
 * @param {*} data - WebSocket message data
 * @returns {object|null} JSON object、またはnull
 */
function parseJsonMessage(data) {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data ?? "");
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * WebSocketを開く。
 *
 * 【詳細説明】
 * - CLIの明示 `--send` 時だけ呼ばれる。
 * - 接続失敗は呼び出し元へ例外として返し、blind retryはしない。
 *
 * @private
 * @param {string} host - K2 host
 * @param {number} port - WS port
 * @returns {Promise<WebSocket>} OPEN済みWebSocket
 */
function openWs(host, port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}:${port}`, { handshakeTimeout: 5000 });
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket open timeout."));
    }, 7000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * WebSocketへ1frameを書き込み、library callback完了を待つ。
 *
 * 【詳細説明】
 * - これはプリンタのprotocol ackではなく、ローカルtransport submitの証跡だけを意味する。
 * - CFS物理操作はside-effect commandなので、ここではblind retryを行わない。
 *
 * @private
 * @param {WebSocket} ws - OPEN済みWebSocket
 * @param {object} frame - WS9999へ送るframe
 * @returns {Promise<object>} local submit response
 */
function sendWsFrameAndWait(ws, frame) {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify(frame), (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({
        status: "submitted",
        frame,
      });
    });
  });
}

/**
 * read-only `boxsInfo` probeを送信し、応答を待つ。
 *
 * 【詳細説明】
 * - 送るframeは `get { boxsInfo: 1 }` のみで、CFS操作や印刷開始は含めない。
 * - listenerをprobeごとに付け外しし、timeout時にも残留listenerを作らない。
 * - これは実機状態の観測補助であり、command成功証明そのものではない。
 *
 * @function sendBoxsInfoProbeAndWait
 * @param {WebSocket} ws - OPEN済みWebSocket
 * @param {object=} options - probe option
 * @param {string=} options.probeMode - `before` または `after` などの観測ラベル
 * @param {number=} options.timeoutMs - 応答待ちtimeout
 * @returns {Promise<object>} boxsInfo観測結果
 * @example
 * const probe = await sendBoxsInfoProbeAndWait(ws, { probeMode: "before" });
 */
export function sendBoxsInfoProbeAndWait(ws, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_BOXSINFO_TIMEOUT_MS;
  const probeMode = toNonEmptyString(options.probeMode) || "manual";
  const request = { method: "get", params: { boxsInfo: 1 } };
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (typeof ws.off === "function") {
        ws.off("message", handleMessage);
        ws.off("error", handleError);
      } else if (typeof ws.removeListener === "function") {
        ws.removeListener("message", handleMessage);
        ws.removeListener("error", handleError);
      }
      clearTimeout(timer);
    };
    const settle = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn(value);
    };
    const handleError = (error) => {
      settle(reject, error);
    };
    const handleMessage = (data) => {
      const payload = parseJsonMessage(data);
      const evidence = findBoxsInfoEvidence(payload);
      if (!evidence) {
        return;
      }
      settle(resolve, {
        status: "observed",
        probeMode,
        elapsedMs: Date.now() - startedAt,
        request,
        evidence,
        payload,
      });
    };
    const timer = setTimeout(() => {
      settle(reject, new Error(`boxsInfo probe timeout after ${timeoutMs}ms.`));
    }, timeoutMs);
    if (typeof ws.on === "function") {
      ws.on("message", handleMessage);
      ws.on("error", handleError);
    }
    ws.send(JSON.stringify(request), (error) => {
      if (error) {
        settle(reject, error);
      }
    });
  });
}

/**
 * Error objectをcertification JSONへ残せる形へ変換する。
 *
 * 【詳細説明】
 * - live command後の観測失敗はside-effect有無が不明なため、CLI processの例外表示だけで捨てず、
 *   `unknown` resultの一部としてmessage/reason/statusを保持する。
 *
 * @private
 * @function serializeCertificationError
 * @param {*} error - 例外または失敗値
 * @returns {object} JSON保存用のerror summary
 */
function serializeCertificationError(error) {
  return {
    message: error?.message || String(error),
    reason: error?.reason || null,
    status: error?.frameStatus || error?.status || null,
    frameIndex: Number.isInteger(error?.frameIndex) ? error.frameIndex : null,
  };
}

/**
 * boxsInfo probeを実行し、失敗も構造化resultとして返す。
 *
 * 【詳細説明】
 * - command送信前probeの失敗はcommand未送信として扱う。
 * - command送信後probeの失敗は、物理side-effectが起きた可能性を残すためthrowせず呼び出し元へ返す。
 *
 * @private
 * @function runStructuredBoxsInfoProbe
 * @param {WebSocket} ws - OPEN済みWebSocket
 * @param {object} options - probe option
 * @param {string} options.probeMode - `before` または `after`
 * @param {number} options.timeoutMs - 応答待ちtimeout
 * @returns {Promise<object>} observed/timeout/errorのprobe result
 */
async function runStructuredBoxsInfoProbe(ws, options) {
  try {
    return await sendBoxsInfoProbeAndWait(ws, options);
  } catch (error) {
    const summary = serializeCertificationError(error);
    return {
      status: summary.message.includes("timeout") ? "timeout" : "error",
      probeMode: toNonEmptyString(options?.probeMode) || "manual",
      elapsedMs: null,
      request: { method: "get", params: { boxsInfo: 1 } },
      evidence: null,
      message: summary.message,
      error: summary,
    };
  }
}

/**
 * certification result JSONをtimestamp付きdirectoryへ保存する。
 *
 * 【詳細説明】
 * - stdoutだけでは実機作業後のレビュー証跡が失われやすいため、明示 `--output-dir` 指定時だけ保存する。
 * - 保存するJSONには保存先summary自体も含め、reviewerへ渡した単体fileから由来directoryを追えるようにする。
 *
 * @private
 * @function writeCertificationResultEvidence
 * @param {object} result - certification実行結果
 * @param {string} outputDir - 保存先root directory
 * @returns {Promise<object>} 保存先summary
 */
async function writeCertificationResultEvidence(result, outputDir) {
  const rootDir = path.resolve(outputDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(rootDir, stamp);
  const evidence = {
    written: true,
    directory: runDir,
    files: ["certification-result.json"],
  };
  await mkdir(runDir, { recursive: true });
  const savedResult = {
    ...result,
    evidence,
  };
  await writeFile(
    path.join(runDir, "certification-result.json"),
    `${JSON.stringify(savedResult, null, 2)}\n`,
    "utf8",
  );
  return evidence;
}

/**
 * 必要に応じてcertification resultへ保存証跡を付与する。
 *
 * 【詳細説明】
 * - `--output-dir` 未指定時は副作用なしでresultをそのまま返す。
 * - 保存失敗はCLIの成功/失敗判定を曖昧にしないため例外として呼び出し元へ返す。
 *
 * @private
 * @function finalizeCertificationResult
 * @param {object} result - certification実行結果
 * @param {object} options - CLIオプション
 * @returns {Promise<object>} evidence情報を付与したresult
 */
async function finalizeCertificationResult(result, options) {
  const outputDir = toNonEmptyString(options?.outputDir);
  if (!outputDir) {
    return result;
  }
  const evidence = await writeCertificationResultEvidence(result, outputDir);
  return {
    ...result,
    evidence,
  };
}

/**
 * K2/CFS slot control certificationを実行する。
 *
 * 【詳細説明】
 * - dry-runではtransport planだけを返し、WSへ接続しない。
 * - `send:true` のときだけWebSocketへ接続し、certification-only planの送信を明示許可する。
 * - command送信後の観測失敗は、送信済みの可能性を保持した `unknown` resultとして返す。
 *
 * @function runK2CfsSlotControlCertification
 * @param {object} options - parseArgs済みオプション
 * @param {Function=} options.openWs - テスト用WebSocket factory override
 * @returns {Promise<object>} 実行結果
 * @example
 * const result = await runK2CfsSlotControlCertification(options);
 */
export async function runK2CfsSlotControlCertification(options) {
  const request = buildK2CfsSlotControlRequest(options);
  const plan = createK2CfsCommandTransportPlan(request, {
    allowUncertifiedCfsSlotCommandCandidates: true,
  });
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  if (!plan.ok) {
    return finalizeCertificationResult({
      ok: false,
      sent: false,
      request,
      plan,
    }, options);
  }
  if (!options.send) {
    return finalizeCertificationResult({
      ok: true,
      sent: false,
      dryRun: true,
      request,
      plan,
      probePlan: {
        before: Boolean(options.probeBefore),
        after: Boolean(options.probeAfter),
        boxsInfoTimeoutMs: options.boxsInfoTimeoutMs,
      },
    }, options);
  }
  const ws = await (options.openWs || openWs)(options.host, options.wsPort);
  try {
    const probes = {
      before: null,
      after: null,
    };
    if (options.probeBefore) {
      probes.before = await runStructuredBoxsInfoProbe(ws, {
        probeMode: "before",
        timeoutMs: options.boxsInfoTimeoutMs,
      });
      if (probes.before.status !== "observed") {
        return finalizeCertificationResult({
          ok: false,
          sent: false,
          dryRun: false,
          status: "rejected",
          reason: "pre-command-observation-failed",
          blindRetryAllowed: false,
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAtMs,
          host: options.host,
          wsPort: options.wsPort,
          request,
          plan,
          response: null,
          probes,
        }, options);
      }
    }
    let response = null;
    try {
      response = await sendK2CfsCommandTransportPlan(plan, async (frame) => {
        return sendWsFrameAndWait(ws, frame);
      }, {
        allowCertificationOnly: true,
      });
    } catch (error) {
      return finalizeCertificationResult({
        ok: false,
        sent: false,
        dryRun: false,
        status: "rejected",
        reason: "command-submit-failed",
        blindRetryAllowed: false,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        host: options.host,
        wsPort: options.wsPort,
        request,
        plan,
        response: null,
        probes,
        error: serializeCertificationError(error),
      }, options);
    }
    if (options.probeAfter) {
      probes.after = await runStructuredBoxsInfoProbe(ws, {
        probeMode: "after",
        timeoutMs: options.boxsInfoTimeoutMs,
      });
      if (probes.after.status !== "observed") {
        return finalizeCertificationResult({
          ok: false,
          sent: true,
          dryRun: false,
          status: "unknown",
          reason: "post-command-observation-failed",
          blindRetryAllowed: false,
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAtMs,
          host: options.host,
          wsPort: options.wsPort,
          request,
          plan,
          response,
          probes,
        }, options);
      }
    }
    const postCommandObserved = options.probeAfter === true && probes.after?.status === "observed";
    return finalizeCertificationResult({
      ok: true,
      sent: true,
      dryRun: false,
      status: postCommandObserved ? "confirmed" : "submitted",
      reason: postCommandObserved ? null : "post-command-observation-not-requested",
      blindRetryAllowed: false,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      host: options.host,
      wsPort: options.wsPort,
      request,
      plan,
      response,
      probes,
    }, options);
  } finally {
    ws.close();
  }
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "")) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(USAGE.trim());
      process.exit(0);
    }
    const result = await runK2CfsSlotControlCertification(options);
    console.log(JSON.stringify(result, null, options.pretty ? 2 : 0));
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(error?.message || String(error));
    console.error(USAGE.trim());
    process.exit(1);
  }
}
