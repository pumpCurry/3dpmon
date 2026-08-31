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
 * - live certification時に任意で `/info` を取得し、F012などの機種証跡をWS接続前に固定する
 *
 * 【公開関数一覧】
 * - {@link parseArgs}：CLI引数を解析
 * - {@link buildK2CfsSlotControlRequest}：transport plan用requestを生成
 * - {@link summarizeBoxsInfoEvidence}：boxsInfoからsource summaryを生成
 * - {@link sendBoxsInfoProbeAndWait}：read-only boxsInfo probeを送信して応答を待つ
 * - {@link runK2CfsSlotControlCertification}：dry-runまたは明示送信を実行
 *
 * @version 1.390.1554 (PR #439)
 * @since   1.390.1415 (PR #435)
 * @lastModified 2026-08-31 20:08:31
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
  --confirm-source <source-id>     Required with --send and must match --source exactly.
  --probe-before                  Required with --send. Read boxsInfo before the command.
  --probe-after                   Required with --send. Read boxsInfo after the command.
  --probe-info                    With --send, read http://<host>/info before opening WS9999.
  --require-info-model <model>     With --send, reject unless /info.model exactly matches this value.
  --require-printer-idle           With --send, reject unless read-only printer status shows idle before CFS motion.
  --operator-marker <text>         Add an operator observation marker to the certification result.
  --boxsinfo-timeout-ms <number>   Probe response timeout. Default: 5000.
  --printer-status-timeout-ms <number> Printer status probe timeout. Default: 5000.
  --info-timeout-ms <number>       /info response timeout. Default: 5000.
  --probe-after-delay-ms <number>  Delay before post-command probe. Default: 1500.
  --probe-after-count <number>     Number of post-command probes. Default: 6.
  --probe-after-interval-ms <number> Interval between post-command probes. Default: 5000.
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
 * printer status probe の既定待ち時間。
 *
 * 【詳細説明】
 * - CFS物理操作の直前にK2本体が印刷/加熱/ジョブ中ではないことを確認するためのread-only timeout。
 * - 実機が応答しない場合は送信せずfail-closedに倒すため、boxsInfoと同じ5秒にする。
 *
 * @constant {number}
 */
const DEFAULT_PRINTER_STATUS_TIMEOUT_MS = 5000;

/**
 * K2 printer status probeで取得するroot scalar一覧。
 *
 * 【詳細説明】
 * - `state`/`deviceState`/時間/target温度を保守的なidle判定に使う。
 * - `printProgress`はidle時に0または100のstale値を返し得るため、単独ではactive根拠にしない。
 *
 * @constant {ReadonlyArray<string>}
 */
const PRINTER_STATUS_KEYS = Object.freeze([
  "state",
  "deviceState",
  "printProgress",
  "printJobTime",
  "printLeftTime",
  "printFileName",
  "fileName",
  "printId",
  "targetNozzleTemp",
  "targetBedTemp0",
]);

/**
 * `/info` probe の既定待ち時間。
 *
 * 【詳細説明】
 * - WS9999接続前に機種確認を固定するためのHTTP timeout。
 * - CFS物理操作の前段guardなので、無限待ちは許さずboxsInfoと同じ5秒にする。
 *
 * @constant {number}
 */
const DEFAULT_INFO_TIMEOUT_MS = 5000;

/**
 * command送信後、after-probeを開始するまでの既定待機時間。
 *
 * 【詳細説明】
 * - K2/CFSの物理状態反映は送信callback直後に完了するとは限らない。
 * - timeout前に古い状態だけを拾ってunknown化しないよう、probe自体のtimeoutとは別にsettling timeを持つ。
 *
 * @constant {number}
 */
const DEFAULT_POST_COMMAND_PROBE_DELAY_MS = 1500;

/**
 * command送信後に実行するafter-probe回数の既定値。
 *
 * 【詳細説明】
 * - 実機debug時にCFS commandを再送せずread-only観測だけを時系列化できるよう、既定を複数回にする。
 *
 * @constant {number}
 */
const DEFAULT_POST_COMMAND_PROBE_COUNT = 6;

/**
 * 複数after-probe間の既定待機時間。
 *
 * 【詳細説明】
 * - command後の状態変化が段階的に届く場合に備え、連続read-only probeの間隔を明示する。
 *
 * @constant {number}
 */
const DEFAULT_POST_COMMAND_PROBE_INTERVAL_MS = 5000;

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
    confirmSource: "",
    probeBefore: false,
    probeAfter: false,
    probeInfo: false,
    requireInfoModel: "",
    requirePrinterIdle: false,
    operatorMarker: "",
    boxsInfoTimeoutMs: DEFAULT_BOXSINFO_TIMEOUT_MS,
    printerStatusTimeoutMs: DEFAULT_PRINTER_STATUS_TIMEOUT_MS,
    infoTimeoutMs: DEFAULT_INFO_TIMEOUT_MS,
    postCommandProbeDelayMs: DEFAULT_POST_COMMAND_PROBE_DELAY_MS,
    postCommandProbeCount: DEFAULT_POST_COMMAND_PROBE_COUNT,
    postCommandProbeIntervalMs: DEFAULT_POST_COMMAND_PROBE_INTERVAL_MS,
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
    else if (arg === "--confirm-source") options.confirmSource = next();
    else if (arg === "--probe-before") options.probeBefore = true;
    else if (arg === "--probe-after") options.probeAfter = true;
    else if (arg === "--probe-info") options.probeInfo = true;
    else if (arg === "--require-printer-idle") options.requirePrinterIdle = true;
    else if (arg === "--require-info-model") {
      options.requireInfoModel = next();
      options.probeInfo = true;
    }
    else if (arg === "--operator-marker") options.operatorMarker = next();
    else if (arg === "--boxsinfo-timeout-ms") options.boxsInfoTimeoutMs = Number(next());
    else if (arg === "--printer-status-timeout-ms") options.printerStatusTimeoutMs = Number(next());
    else if (arg === "--info-timeout-ms") options.infoTimeoutMs = Number(next());
    else if (arg === "--probe-after-delay-ms") options.postCommandProbeDelayMs = Number(next());
    else if (arg === "--probe-after-count") options.postCommandProbeCount = Number(next());
    else if (arg === "--probe-after-interval-ms") options.postCommandProbeIntervalMs = Number(next());
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
  if (!Number.isInteger(options.printerStatusTimeoutMs) ||
      options.printerStatusTimeoutMs < 1000 ||
      options.printerStatusTimeoutMs > 60000) {
    throw new Error("--printer-status-timeout-ms must be between 1000 and 60000.");
  }
  if (!Number.isInteger(options.infoTimeoutMs) ||
      options.infoTimeoutMs < 1000 ||
      options.infoTimeoutMs > 60000) {
    throw new Error("--info-timeout-ms must be between 1000 and 60000.");
  }
  if (!Number.isInteger(options.postCommandProbeDelayMs) ||
      options.postCommandProbeDelayMs < 0 ||
      options.postCommandProbeDelayMs > 60000) {
    throw new Error("--probe-after-delay-ms must be between 0 and 60000.");
  }
  if (!Number.isInteger(options.postCommandProbeCount) ||
      options.postCommandProbeCount < 1 ||
      options.postCommandProbeCount > 60) {
    throw new Error("--probe-after-count must be between 1 and 60.");
  }
  if (!Number.isInteger(options.postCommandProbeIntervalMs) ||
      options.postCommandProbeIntervalMs < 100 ||
      options.postCommandProbeIntervalMs > 60000) {
    throw new Error("--probe-after-interval-ms must be between 100 and 60000.");
  }
  const command = toNonEmptyString(options.command);
  if (!options.help && !SUPPORTED_SLOT_CONTROL_COMMANDS.has(command)) {
    throw new Error("--command must be one of cfs-slot-select, cfs-load, cfs-unload, cfs-feed, cfs-retract.");
  }
  if (!options.help && !toNonEmptyString(options.source)) {
    throw new Error("--source is required.");
  }
  const liveValidation = validateLiveCertificationOptions(options);
  if (!liveValidation.ok) {
    throw new Error(liveValidation.message);
  }
  if (toNonEmptyString(options.outputDir)) {
    options.outputDir = path.resolve(options.outputDir);
  }
  return options;
}

/**
 * live certification送信時の安全条件を検査する。
 *
 * 【詳細説明】
 * - CLI引数の検証とexported runner直呼びの検証を同じ関数へ集約する。
 * - 物理side-effectを伴う `--send` は、host/command/sourceの明示確認、F012 `/info`、printer idle guard、前後probeが揃う場合だけ許可する。
 * - boxsInfo内のloaded/selectedは、WS接続後のread-only観測で別途fail-closedにする。
 *
 * @private
 * @function validateLiveCertificationOptions
 * @param {object} options - CLIまたはprogrammatic runner option
 * @returns {{ok:boolean, reason:?string, message:string}} live送信option検査結果
 */
function validateLiveCertificationOptions(options) {
  if (options?.send !== true) {
    return { ok: true, reason: null, message: "" };
  }
  const command = toNonEmptyString(options.command);
  const source = toNonEmptyString(options.source);
  const host = toNonEmptyString(options.host);
  if (!host) {
    return {
      ok: false,
      reason: "live-certification-host-required",
      message: "--host is required when --send is used.",
    };
  }
  if (options.confirmLive !== true) {
    return {
      ok: false,
      reason: "live-certification-confirm-live-required",
      message: "--confirm-live is required when --send is used.",
    };
  }
  if (toNonEmptyString(options.confirmHost) !== host) {
    return {
      ok: false,
      reason: "live-certification-confirm-host-mismatch",
      message: "--confirm-host must exactly match --host when --send is used.",
    };
  }
  if (toNonEmptyString(options.confirmCommand) !== command) {
    return {
      ok: false,
      reason: "live-certification-confirm-command-mismatch",
      message: "--confirm-command must exactly match --command when --send is used.",
    };
  }
  if (!LIVE_CERTIFIABLE_SLOT_CONTROL_COMMANDS.has(command)) {
    return {
      ok: false,
      reason: "live-certification-command-not-live-certifiable",
      message: "--send is currently limited to cfs-load and cfs-unload for F012 live certification.",
    };
  }
  if (options.probeBefore !== true || options.probeAfter !== true) {
    return {
      ok: false,
      reason: "live-certification-probes-required",
      message: "--probe-before and --probe-after are required when --send is used.",
    };
  }
  if (toNonEmptyString(options.confirmSource) !== source) {
    return {
      ok: false,
      reason: "live-certification-confirm-source-mismatch",
      message: "--confirm-source must exactly match --source when --send is used.",
    };
  }
  if (options.probeInfo !== true || toNonEmptyString(options.requireInfoModel) !== "F012") {
    return {
      ok: false,
      reason: "live-certification-f012-info-required",
      message: "--probe-info and --require-info-model F012 are required when --send is used.",
    };
  }
  if (options.requirePrinterIdle !== true) {
    return {
      ok: false,
      reason: "live-certification-printer-idle-required",
      message: "--require-printer-idle is required when --send is used.",
    };
  }
  return { ok: true, reason: null, message: "" };
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
 * certification resultへ入れるprobe計画summaryを生成する。
 *
 * 【詳細説明】
 * - dry-runとlive resultで同じ形の計画情報を返し、レビュー時にtimeoutとsettling delayを読み取れるようにする。
 *
 * @private
 * @function createProbePlanSummary
 * @param {object} options - CLIオプション
 * @returns {object} probe計画summary
 */
function createProbePlanSummary(options) {
  return {
    before: Boolean(options.probeBefore),
    after: Boolean(options.probeAfter),
    info: Boolean(options.probeInfo || toNonEmptyString(options.requireInfoModel)),
    requireInfoModel: toNonEmptyString(options.requireInfoModel) || null,
    confirmSource: toNonEmptyString(options.confirmSource) || null,
    requirePrinterIdle: Boolean(options.requirePrinterIdle),
    boxsInfoTimeoutMs: options.boxsInfoTimeoutMs,
    printerStatusTimeoutMs: options.printerStatusTimeoutMs,
    infoTimeoutMs: options.infoTimeoutMs,
    postCommandProbeDelayMs: options.postCommandProbeDelayMs,
    postCommandProbeCount: options.postCommandProbeCount,
    postCommandProbeIntervalMs: options.postCommandProbeIntervalMs,
  };
}

/**
 * 指定millisecondsだけ待機する。
 *
 * 【詳細説明】
 * - 実機commandの物理反映待ちに使う。
 * - 0以下の場合は即時resolveし、テストや緊急captureで遅延を外せるようにする。
 *
 * @private
 * @function delayMs
 * @param {number} milliseconds - 待機milliseconds
 * @returns {Promise<void>} 待機完了でresolveするPromise
 */
function delayMs(milliseconds) {
  const delay = Math.max(0, Number(milliseconds) || 0);
  if (delay <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * `/info` endpoint URLを生成する。
 *
 * 【詳細説明】
 * - CLIではhostにIP/hostnameだけを渡す運用を基本にする。
 * - 既にhttp/https URLが渡された場合は、末尾を `/info` へ正規化して事故を避ける。
 *
 * @private
 * @function buildPrinterInfoUrl
 * @param {string} host - プリンタhostまたはURL
 * @returns {string} `/info` endpoint URL
 */
function buildPrinterInfoUrl(host) {
  const text = toNonEmptyString(host);
  if (/^https?:\/\//iu.test(text)) {
    const url = new URL(text);
    url.pathname = "/info";
    url.search = "";
    url.hash = "";
    return url.toString();
  }
  return `http://${text}/info`;
}

/**
 * `/info` 応答を安全な証跡objectへ正規化する。
 *
 * 【詳細説明】
 * - `/info` のMACは有線/無線で一致しないことがあるため、ここではidentity authorityへ昇格しない。
 * - live certification前の機種・firmware・transport hint確認に必要な最小情報だけを保持する。
 *
 * @private
 * @function normalizePrinterInfoPayload
 * @param {*} value - `/info` JSON payload
 * @returns {object|null} 正規化済みpayload、または不正値ならnull
 */
function normalizePrinterInfoPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    mac: toNonEmptyString(value.mac),
    model: toNonEmptyString(value.model),
    sn: toNonEmptyString(value.sn),
    version: toNonEmptyString(value.version),
    videoPort: Number.isInteger(value.videoPort) ? value.videoPort : null,
    wssPort: Number.isInteger(value.wssPort) ? value.wssPort : null,
  };
}

/**
 * HTTP responseからJSON payloadを読み取る。
 *
 * 【詳細説明】
 * - テストdoubleでは `json()` だけ、実fetchでは `text()` だけを使いたい場合があるため両方に対応する。
 * - JSON parse不能時は呼び出し元で構造化errorへ変換する。
 *
 * @private
 * @function readPrinterInfoJson
 * @param {object} response - fetch response風object
 * @returns {Promise<object>} JSON payload
 */
async function readPrinterInfoJson(response) {
  if (typeof response?.json === "function") {
    return response.json();
  }
  if (typeof response?.text === "function") {
    return JSON.parse(await response.text());
  }
  return {};
}

/**
 * `/info` を取得し、certification用の機種証跡を生成する。
 *
 * 【詳細説明】
 * - side-effect command送信前に実行し、機種不一致ならWS9999を開く前に拒否できるようにする。
 * - timeout/errorはthrowせず構造化resultとして返し、result JSONへ残せる形にする。
 *
 * @private
 * @function fetchPrinterInfoEvidence
 * @param {object} options - CLIオプション
 * @returns {Promise<object>} `/info` 観測結果
 */
async function fetchPrinterInfoEvidence(options) {
  const url = buildPrinterInfoUrl(options.host);
  const requestedAt = new Date().toISOString();
  const startedAt = Date.now();
  const expectedModel = toNonEmptyString(options.requireInfoModel) || null;
  const fetcher = options.fetchInfo || globalThis.fetch;
  if (typeof fetcher !== "function") {
    return {
      status: "error",
      url,
      requestedAt,
      observedAt: null,
      elapsedMs: Date.now() - startedAt,
      expectedModel,
      modelMatched: false,
      info: null,
      error: { message: "fetch API is not available." },
    };
  }
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), options.infoTimeoutMs || DEFAULT_INFO_TIMEOUT_MS)
    : null;
  try {
    const response = await fetcher(url, controller ? { signal: controller.signal } : {});
    const payload = normalizePrinterInfoPayload(await readPrinterInfoJson(response));
    const modelMatched = expectedModel ? payload?.model === expectedModel : null;
    return {
      status: response?.ok === false || !payload ? "error" : "observed",
      url,
      requestedAt,
      observedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      httpStatus: Number.isInteger(response?.status) ? response.status : null,
      expectedModel,
      modelMatched,
      info: payload,
      error: payload ? null : { message: "Invalid /info JSON payload." },
    };
  } catch (error) {
    const serialized = serializeCertificationError(error);
    return {
      status: error?.name === "AbortError" ? "timeout" : "error",
      url,
      requestedAt,
      observedAt: null,
      elapsedMs: Date.now() - startedAt,
      expectedModel,
      modelMatched: false,
      info: null,
      error: serialized,
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * `/info` 機種必須条件を検査する。
 *
 * @private
 * @function validatePrinterInfoRequirement
 * @param {object|null|undefined} printerInfo - `/info` 観測結果
 * @param {string} expectedModel - 期待するmodel
 * @returns {{ok:boolean, reason:?string}} 検査結果
 */
function validatePrinterInfoRequirement(printerInfo, expectedModel) {
  const model = toNonEmptyString(expectedModel);
  if (!model) {
    return { ok: true, reason: null };
  }
  if (printerInfo?.status !== "observed") {
    return { ok: false, reason: "printer-info-observation-failed" };
  }
  if (printerInfo?.info?.model !== model) {
    return { ok: false, reason: "printer-info-model-mismatch" };
  }
  return { ok: true, reason: null };
}

/**
 * operator markerをcertification resultへ入れる形へ正規化する。
 *
 * @private
 * @function createOperatorMarkerEvidence
 * @param {string} marker - operator marker文字列
 * @param {string} capturedAt - result開始時刻
 * @returns {object|null} marker evidence、またはnull
 */
function createOperatorMarkerEvidence(marker, capturedAt) {
  const value = toNonEmptyString(marker);
  if (!value) {
    return null;
  }
  return {
    source: "operator-cli",
    value,
    capturedAt,
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
 * box/material idから表示slot名を生成する。
 *
 * 【詳細説明】
 * - K2/CFSではboxId 1 + materialId 0 を 1A と表示する。
 * - 外部スプールはCFS slotと混ぜず `external` として扱う。
 *
 * @private
 * @function formatSourceDisplaySlot
 * @param {number|string|null} boxId - box id
 * @param {number|string|null} materialId - material id
 * @param {boolean} external - 外部スプールの場合true
 * @returns {string} 表示slot名
 */
function formatSourceDisplaySlot(boxId, materialId, external) {
  if (external) {
    return "external";
  }
  const numericSlot = Number(materialId);
  const suffix = Number.isInteger(numericSlot) && numericSlot >= 0 && numericSlot < 26
    ? String.fromCharCode(65 + numericSlot)
    : String(materialId ?? "?");
  return `${boxId}${suffix}`;
}

/**
 * box/material idからNormalized MaterialSource idを生成する。
 *
 * 【詳細説明】
 * - CFS slot control対象は `cfs:<boxId>:slot:<materialId>` に限定する。
 * - 外部スプールは観測summaryでは `external:<boxId>` とし、CFS sourceと衝突しないようにする。
 *
 * @private
 * @function formatBoxsInfoSourceId
 * @param {number|string|null} boxId - box id
 * @param {number|string|null} materialId - material id
 * @param {boolean} external - 外部スプールの場合true
 * @returns {string} source id
 */
function formatBoxsInfoSourceId(boxId, materialId, external) {
  if (external) {
    return `external:${boxId}`;
  }
  return `cfs:${boxId}:slot:${materialId}`;
}

/**
 * K2/CFS locator用の非負整数を厳密に解析する。
 *
 * 【詳細説明】
 * - `Number()` による暗黙変換を使うと `null` や空文字が 0 になり、存在しないslotを
 *   正常な `cfs:<boxId>:slot:<materialId>` と誤認してしまう。
 * - Gate19 certificationでは、protocolに明示された整数または10進数文字列だけを採用する。
 * - `01` のようなゼロ埋め文字列は、firmware差異か壊れた値かをここでは判断できないため無効扱いにする。
 *
 * @private
 * @function parseStrictNonNegativeInteger
 * @param {*} value - 解析対象値
 * @returns {number|null} 正常な非負整数、またはnull
 * @example
 * const id = parseStrictNonNegativeInteger("1");
 */
function parseStrictNonNegativeInteger(value) {
  if (Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^(0|[1-9]\d*)$/u.test(value)) {
    return Number(value);
  }
  return null;
}

/**
 * K2/CFS box typeを厳密に解析する。
 *
 * 【詳細説明】
 * - 現時点でreview evidenceとして扱うbox typeは、CFS unitの0と外部スプールendpointの1だけに限定する。
 * - 欠落や未知値はdiagnosticsへ逃がし、後続のsource id生成へ混ぜない。
 *
 * @private
 * @function parseStrictBoxType
 * @param {*} value - box.type 候補
 * @returns {number|null} 0または1、もしくはnull
 * @example
 * const boxType = parseStrictBoxType("1");
 */
function parseStrictBoxType(value) {
  const numericValue = parseStrictNonNegativeInteger(value);
  return numericValue === 0 || numericValue === 1 ? numericValue : null;
}

/**
 * K2 material state codeから存在状態を推定する。
 *
 * 【詳細説明】
 * - Gate19 certificationでは材料名や色などの残留metadataでloaded推測しない。
 * - 明示state codeだけを使い、不明値はunknownに倒す。
 *
 * @private
 * @function summarizeMaterialPresence
 * @param {*} stateCode - material.state 候補
 * @returns {string} loaded/empty/unknown
 */
function summarizeMaterialPresence(stateCode) {
  if (stateCode === 1 || stateCode === "1") {
    return "loaded";
  }
  if (stateCode === 0 || stateCode === "0") {
    return "empty";
  }
  return "unknown";
}

/**
 * material.selected値をreview evidence用に分類する。
 *
 * 【詳細説明】
 * - K2実機調査では `selected` が0/1以外になった場合、未選択と同義にしてしまうと原因調査が難しくなる。
 * - 未観測、明示selected、明示unselected、不正値を分け、送信前guardとreview summaryの両方で同じ意味を使う。
 *
 * @private
 * @function classifyMaterialSelection
 * @param {*} selectedRaw - material.selected raw値
 * @returns {{selected:boolean, selectedObserved:boolean, selectionState:string, selectionValid:(boolean|null), selectionRaw:*}} 分類結果
 * @example
 * const selection = classifyMaterialSelection(1);
 */
function classifyMaterialSelection(selectedRaw) {
  const selectedObserved = selectedRaw !== undefined && selectedRaw !== null && selectedRaw !== "";
  if (!selectedObserved) {
    return {
      selected: false,
      selectedObserved: false,
      selectionState: "unobserved",
      selectionValid: null,
      selectionRaw: selectedRaw,
    };
  }
  if (selectedRaw === true || selectedRaw === 1 || selectedRaw === "1") {
    return {
      selected: true,
      selectedObserved: true,
      selectionState: "selected",
      selectionValid: true,
      selectionRaw: selectedRaw,
    };
  }
  if (selectedRaw === false || selectedRaw === 0 || selectedRaw === "0") {
    return {
      selected: false,
      selectedObserved: true,
      selectionState: "unselected",
      selectionValid: true,
      selectionRaw: selectedRaw,
    };
  }
  return {
    selected: false,
    selectedObserved: true,
    selectionState: "invalid",
    selectionValid: false,
    selectionRaw: selectedRaw,
  };
}

/**
 * certification summary diagnosticを追加する。
 *
 * 【詳細説明】
 * - 壊れたlocatorをsource idへ補完せず、reviewer/operatorがあとからraw payloadへ戻れるように
 *   reason/path/valueを証跡として残す。
 *
 * @private
 * @function pushBoxsInfoDiagnostic
 * @param {Array<object>} diagnostics - 追加先diagnostics配列
 * @param {string} reason - diagnostic reason
 * @param {string} path - payload内の位置
 * @param {*} value - 問題になった値
 * @returns {void}
 * @example
 * pushBoxsInfoDiagnostic(diagnostics, "box-id-missing", "materialBoxs[0]", undefined);
 */
function pushBoxsInfoDiagnostic(diagnostics, reason, path, value) {
  const diagnostic = { reason, path };
  if (value !== undefined) {
    diagnostic.value = value;
  }
  diagnostics.push(diagnostic);
}

/**
 * K2 `boxsInfo` payloadからCFS/external source summaryを生成する。
 *
 * 【詳細説明】
 * - 実機certificationでraw payloadを全て読まなくても、前後のloaded/selected/percent/color/RFID有無を
 *   すばやく比較できるようにする。
 * - 外部スプールとCFS slotは別kind/sourceIdとして保持し、CFS操作対象へ混ざらないようにする。
 * - このsummaryはreview evidenceであり、production authorityや自動debitの根拠にはしない。
 *
 * @function summarizeBoxsInfoEvidence
 * @param {object|null|undefined} boxsInfo - K2 `boxsInfo` payload
 * @param {string=} targetSourceId - 注目source id
 * @returns {object} boxsInfo summary
 * @example
 * const summary = summarizeBoxsInfoEvidence(boxsInfo, "cfs:1:slot:2");
 */
export function summarizeBoxsInfoEvidence(boxsInfo, targetSourceId = "") {
  const boxes = Array.isArray(boxsInfo?.materialBoxs) ? boxsInfo.materialBoxs : [];
  const sources = [];
  const diagnostics = [];
  const validBoxes = [];
  const boxCandidates = [];
  const boxIdCounts = new Map();
  const materialCandidates = [];
  const sourceIdCounts = new Map();
  for (const [boxIndex, box] of boxes.entries()) {
    const boxPath = `materialBoxs[${boxIndex}]`;
    const boxId = parseStrictNonNegativeInteger(box?.id);
    const boxType = parseStrictBoxType(box?.type);
    if (box?.id === undefined || box?.id === null || box?.id === "") {
      pushBoxsInfoDiagnostic(diagnostics, "box-id-missing", boxPath, box?.id);
      continue;
    }
    if (boxId === null) {
      pushBoxsInfoDiagnostic(diagnostics, "box-id-invalid", boxPath, box?.id);
      continue;
    }
    if (box?.type === undefined || box?.type === null || box?.type === "") {
      pushBoxsInfoDiagnostic(diagnostics, "box-type-missing", boxPath, box?.type);
      continue;
    }
    if (boxType === null) {
      pushBoxsInfoDiagnostic(diagnostics, "box-type-invalid", boxPath, box?.type);
      continue;
    }
    const external = boxType === 1;
    boxCandidates.push({ box, boxId, boxType, external, boxPath });
    boxIdCounts.set(boxId, (boxIdCounts.get(boxId) || 0) + 1);
  }
  const duplicateBoxIds = new Set([...boxIdCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([boxId]) => boxId));
  const reportedDuplicateBoxIds = new Set();
  for (const { box, boxId, boxType, external, boxPath } of boxCandidates) {
    if (duplicateBoxIds.has(boxId)) {
      if (reportedDuplicateBoxIds.has(boxId)) {
        pushBoxsInfoDiagnostic(diagnostics, "box-id-duplicate", boxPath, boxId);
      }
      reportedDuplicateBoxIds.add(boxId);
      continue;
    }
    validBoxes.push({ box, boxId, boxType, external });
    const materials = Array.isArray(box?.materials) ? box.materials : [];
    for (const [materialIndex, material] of materials.entries()) {
      const materialPath = `${boxPath}.materials[${materialIndex}]`;
      const materialId = parseStrictNonNegativeInteger(material?.id);
      if (material?.id === undefined || material?.id === null || material?.id === "") {
        pushBoxsInfoDiagnostic(diagnostics, "material-id-missing", materialPath, material?.id);
        continue;
      }
      if (materialId === null) {
        pushBoxsInfoDiagnostic(diagnostics, "material-id-invalid", materialPath, material?.id);
        continue;
      }
      const sourceId = formatBoxsInfoSourceId(boxId, materialId, external);
      const stateCode = material?.state ?? null;
      const selection = classifyMaterialSelection(material?.selected);
      if (selection.selectionState === "invalid") {
        pushBoxsInfoDiagnostic(diagnostics, "selected-value-invalid", `${materialPath}.selected`, material?.selected);
      }
      materialCandidates.push({
        materialPath,
        sourceId,
        kind: external ? "external-spool" : "cfs-slot",
        boxId,
        boxType,
        boxState: box?.state ?? null,
        boxTemp: box?.temp ?? box?.boxTemp ?? box?.temperature ?? null,
        humidity: box?.humidity ?? box?.boxHumidity ?? null,
        materialId,
        displaySlot: formatSourceDisplaySlot(boxId, materialId, external),
        stateCode,
        presence: summarizeMaterialPresence(stateCode),
        selected: selection.selected,
        selectedObserved: selection.selectedObserved,
        selectionState: selection.selectionState,
        selectionValid: selection.selectionValid,
        selectionRaw: selection.selectionRaw,
        percent: material?.percent ?? null,
        materialType: material?.type || "",
        materialName: material?.name || "",
        color: material?.color || "",
        rfidPresent: Boolean(toNonEmptyString(material?.rfid)),
      });
      sourceIdCounts.set(sourceId, (sourceIdCounts.get(sourceId) || 0) + 1);
    }
  }
  const duplicateSourceIds = new Set([...sourceIdCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([sourceId]) => sourceId));
  const reportedDuplicateSourceIds = new Set();
  for (const candidate of materialCandidates) {
    if (duplicateSourceIds.has(candidate.sourceId)) {
      if (reportedDuplicateSourceIds.has(candidate.sourceId)) {
        pushBoxsInfoDiagnostic(diagnostics, "source-id-duplicate", candidate.materialPath, candidate.sourceId);
      }
      reportedDuplicateSourceIds.add(candidate.sourceId);
      continue;
    }
    const { materialPath: _materialPath, ...source } = candidate;
    sources.push(source);
  }
  const sourceIdSet = new Set(sources.map((source) => source.sourceId));
  const colorMatches = [];
  for (const [assignmentIndex, assignment] of (Array.isArray(boxsInfo?.colorMatch) ? boxsInfo.colorMatch : []).entries()) {
    const assignmentPath = `colorMatch[${assignmentIndex}]`;
    const assignmentId = assignment?.id || "";
    if (!assignmentId) {
      continue;
    }
    const boxId = parseStrictNonNegativeInteger(assignment?.boxId);
    const materialId = parseStrictNonNegativeInteger(assignment?.materialId);
    if (assignment?.boxId === undefined || assignment?.boxId === null || assignment?.boxId === "") {
      pushBoxsInfoDiagnostic(diagnostics, "color-match-box-id-missing", assignmentPath, assignment?.boxId);
      continue;
    }
    if (boxId === null) {
      pushBoxsInfoDiagnostic(diagnostics, "color-match-box-id-invalid", assignmentPath, assignment?.boxId);
      continue;
    }
    if (assignment?.materialId === undefined || assignment?.materialId === null || assignment?.materialId === "") {
      pushBoxsInfoDiagnostic(diagnostics, "color-match-material-id-missing", assignmentPath, assignment?.materialId);
      continue;
    }
    if (materialId === null) {
      pushBoxsInfoDiagnostic(diagnostics, "color-match-material-id-invalid", assignmentPath, assignment?.materialId);
      continue;
    }
    const matchedBox = validBoxes.find((entry) => entry.boxId === boxId);
    if (!matchedBox) {
      pushBoxsInfoDiagnostic(diagnostics, "color-match-box-unresolved", assignmentPath, assignment?.boxId);
      continue;
    }
    const sourceId = formatBoxsInfoSourceId(boxId, materialId, matchedBox.external);
    if (!sourceIdSet.has(sourceId)) {
      pushBoxsInfoDiagnostic(diagnostics, "color-match-source-unresolved", assignmentPath, sourceId);
      continue;
    }
    colorMatches.push({
      assignmentId,
      sourceId,
      boxId,
      materialId,
    });
  }
  const selectedSourceIds = sources
    .filter((source) => source.selected)
    .map((source) => source.sourceId);
  return {
    boxCount: boxes.length,
    cfsUnitCount: validBoxes.filter((entry) => entry.boxType !== 1).length,
    externalEndpointCount: validBoxes.filter((entry) => entry.boxType === 1).length,
    loadedSourceCount: sources.filter((source) => source.presence === "loaded").length,
    selectedSourceIds,
    targetSource: sources.find((source) => source.sourceId === targetSourceId) || null,
    targetSourceCandidateCount: sources.filter((source) => source.sourceId === targetSourceId).length,
    sources,
    colorMatches,
    diagnostics,
  };
}

/**
 * boxsInfo summary内にduplicate locator診断があるか判定する。
 *
 * @private
 * @function hasDuplicateLocatorDiagnostic
 * @param {object|null|undefined} summary - boxsInfo summary
 * @returns {boolean} duplicate診断がある場合はtrue
 */
function hasDuplicateLocatorDiagnostic(summary) {
  return (summary?.diagnostics || []).some((diagnostic) => {
    return diagnostic?.reason === "box-id-duplicate" || diagnostic?.reason === "source-id-duplicate";
  });
}

/**
 * live送信前にselection観測が不完全なsourceを抽出する。
 *
 * 【詳細説明】
 * - CFS物理操作では「targetだけが選択中」と証明できることを前提にする。
 * - 明示emptyのsourceは選択対象外として扱えるが、loaded/unknownのsourceはselection値が0/1系として観測済みでなければ不定である。
 * - 不定sourceを無視すると、target以外が実際にはselectedである可能性を消せないため、pre-command段階でfail-closedする。
 *
 * @private
 * @function findPreCommandIndeterminateSelectionSources
 * @param {object|null|undefined} summary - pre-command boxsInfo summary
 * @returns {Array<object>} selection authorityが不定なsource一覧
 */
function findPreCommandIndeterminateSelectionSources(summary) {
  const sources = Array.isArray(summary?.sources) ? summary.sources : [];
  return sources.filter((source) => {
    if (!source || source.presence === "empty") {
      return false;
    }
    return source.selectionValid !== true;
  });
}

/**
 * live送信前のboxsInfo probe summaryを検査する。
 *
 * 【詳細説明】
 * - certification runnerは、通信応答があっただけでは送信してよいとは扱わない。
 * - 対象sourceが一意で、duplicate locatorがなく、明示loadedかつselectedが一意である場合だけCFS操作frameを送る。
 *
 * @private
 * @function validatePreCommandProbeSummary
 * @param {object|null|undefined} summary - pre-command boxsInfo summary
 * @param {string} targetSourceId - 操作対象source ID
 * @returns {{ok:boolean, reason:?string}} 検査結果
 */
function validatePreCommandProbeSummary(summary, targetSourceId) {
  if (!summary || typeof summary !== "object") {
    return { ok: false, reason: "pre-command-observation-failed" };
  }
  if (hasDuplicateLocatorDiagnostic(summary)) {
    return { ok: false, reason: "pre-command-target-source-ambiguous" };
  }
  const targetSources = (summary.sources || []).filter((source) => source?.sourceId === targetSourceId);
  if (targetSources.length !== 1) {
    return { ok: false, reason: "pre-command-target-source-missing" };
  }
  if (targetSources[0].presence !== "loaded") {
    return { ok: false, reason: "pre-command-target-source-not-loaded" };
  }
  if (targetSources[0].selected !== true) {
    return { ok: false, reason: "pre-command-target-source-not-selected" };
  }
  const indeterminateSelectionSources = findPreCommandIndeterminateSelectionSources(summary);
  if (indeterminateSelectionSources.some((source) => source?.selectionValid === false)) {
    return { ok: false, reason: "pre-command-selected-value-invalid" };
  }
  if (indeterminateSelectionSources.length > 0) {
    return { ok: false, reason: "pre-command-selected-source-observation-incomplete" };
  }
  if (!Array.isArray(summary.selectedSourceIds) ||
      summary.selectedSourceIds.length !== 1 ||
      summary.selectedSourceIds[0] !== targetSourceId) {
    return { ok: false, reason: "pre-command-selected-source-ambiguous" };
  }
  return { ok: true, reason: null };
}

/**
 * before/after probeの実行数summaryを生成する。
 *
 * @private
 * @function summarizeProbeAttempts
 * @param {object} probes - probe collection
 * @returns {{probeAttemptCount:number, observedProbeCount:number, failedProbeCount:number}} probe集計
 */
function summarizeProbeAttempts(probes) {
  const allProbes = [
    probes?.before,
    ...(Array.isArray(probes?.afterSeries) ? probes.afterSeries : []),
  ].filter(Boolean);
  const observedProbeCount = allProbes.filter((probe) => probe?.status === "observed").length;
  return {
    probeAttemptCount: allProbes.length,
    observedProbeCount,
    failedProbeCount: allProbes.length - observedProbeCount,
  };
}

/**
 * target source比較用の小さなsnapshotを生成する。
 *
 * 【詳細説明】
 * - raw `boxsInfo` 全体はprobe evidenceへ残るため、ここではレビューで見たいslot状態だけを抜き出す。
 * - source固有の使用/選択/残量変化を追う目的なので、box温湿度などsource外の値は含めない。
 *
 * @private
 * @function createComparableTargetSourceSnapshot
 * @param {object|null|undefined} source - summary内のtarget source
 * @returns {object|null} 比較用snapshot
 */
function createComparableTargetSourceSnapshot(source) {
  if (!source || typeof source !== "object") {
    return null;
  }
  return {
    sourceId: source.sourceId,
    presence: source.presence,
    stateCode: source.stateCode,
    selected: Boolean(source.selected),
    selectedObserved: Boolean(source.selectedObserved),
    selectionState: source.selectionState || "unobserved",
    selectionValid: source.selectionValid ?? null,
    selectionRaw: source.selectionRaw,
    percent: source.percent,
    materialType: source.materialType,
    materialName: source.materialName,
    color: source.color,
    rfidPresent: Boolean(source.rfidPresent),
  };
}

/**
 * 最後に観測できたafter probeを取得する。
 *
 * @private
 * @function findLastObservedAfterProbe
 * @param {Array<object>} afterSeries - after probe配列
 * @returns {object|null} 最後のobserved probe
 */
function findLastObservedAfterProbe(afterSeries) {
  for (let index = (afterSeries || []).length - 1; index >= 0; index -= 1) {
    if (afterSeries[index]?.status === "observed") {
      return afterSeries[index];
    }
  }
  return null;
}

/**
 * command前後のtarget source差分を生成する。
 *
 * 【詳細説明】
 * - post-command telemetryは物理成功の証明ではないが、対象sourceの変化をreviewer/operatorが追えるようにする。
 * - beforeまたはafterが欠ける場合も `observed:false` とreasonで返し、JSON shapeを安定させる。
 *
 * @private
 * @function createTargetSourceDelta
 * @param {object|null|undefined} beforeProbe - before probe result
 * @param {object|null|undefined} afterProbe - after probe result
 * @param {string} sourceId - 操作対象source id
 * @returns {object} target source差分summary
 */
function createTargetSourceDelta(beforeProbe, afterProbe, sourceId) {
  const before = createComparableTargetSourceSnapshot(beforeProbe?.summary?.targetSource);
  const after = createComparableTargetSourceSnapshot(afterProbe?.summary?.targetSource);
  if (!before || !after) {
    return {
      sourceId,
      observed: false,
      beforeProbe: beforeProbe?.probeMode || null,
      afterProbe: afterProbe?.probeMode || null,
      before,
      after,
      changedFields: [],
      reason: before ? "after-target-source-missing" : "before-target-source-missing",
    };
  }
  const comparableFields = [
    "presence",
    "stateCode",
    "selected",
    "selectedObserved",
    "selectionState",
    "selectionValid",
    "selectionRaw",
    "percent",
    "materialType",
    "materialName",
    "color",
    "rfidPresent",
  ];
  const changedFields = comparableFields.filter((field) => before[field] !== after[field]);
  return {
    sourceId,
    observed: true,
    beforeProbe: beforeProbe?.probeMode || null,
    afterProbe: afterProbe?.probeMode || null,
    before,
    after,
    changedFields,
  };
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
 * WebSocket payloadからprinter status scalar候補を取り出す。
 *
 * 【詳細説明】
 * - K2はroot直下、`params`、`data`、`result`のいずれかへ状態値を返す可能性があるため、
 *   shallow envelopeだけを順番に調べる。
 * - printer status probeはCFS操作前の安全確認専用なので、`boxsInfo`だけの応答は採用しない。
 *
 * @private
 * @function extractPrinterStatusPayload
 * @param {object|null|undefined} payload - JSON parse済みWS payload
 * @returns {object|null} status scalarを含むpayload、またはnull
 */
function extractPrinterStatusPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const candidates = [payload, payload.params, payload.data, payload.result]
    .filter((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate));
  for (const candidate of candidates) {
    const status = {};
    for (const key of PRINTER_STATUS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(candidate, key)) {
        status[key] = candidate[key];
      }
    }
    if (Object.keys(status).length > 0) {
      return status;
    }
  }
  return null;
}

/**
 * 任意値を有限数へ正規化する。
 *
 * @private
 * @function toFiniteNumberOrNull
 * @param {*} value - 数値候補
 * @returns {number|null} 有限数、またはnull
 */
function toFiniteNumberOrNull(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  const numberValue = Number(trimmed);
  return Number.isFinite(numberValue) ? numberValue : null;
}

/**
 * printer status scalarから保守的なidle summaryを生成する。
 *
 * 【詳細説明】
 * - CFS物理操作の直前guardなので、不明値を成功根拠には使わない。
 * - `printProgress`はidle時にも0/100のstale値があり得るため、単独ではactive判定に使わない。
 * - `state/deviceState`、ジョブ時間、残り時間、target温度のいずれかが活動を示す場合はidleではない。
 *
 * @private
 * @function summarizePrinterStatusPayload
 * @param {object} statusPayload - printer status scalar
 * @returns {object} idle判定summary
 */
function summarizePrinterStatusPayload(statusPayload) {
  const state = toFiniteNumberOrNull(statusPayload?.state);
  const deviceState = toFiniteNumberOrNull(statusPayload?.deviceState);
  const printProgress = toFiniteNumberOrNull(statusPayload?.printProgress);
  const printJobTime = toFiniteNumberOrNull(statusPayload?.printJobTime);
  const printLeftTime = toFiniteNumberOrNull(statusPayload?.printLeftTime);
  const targetNozzleTemp = toFiniteNumberOrNull(statusPayload?.targetNozzleTemp);
  const targetBedTemp0 = toFiniteNumberOrNull(statusPayload?.targetBedTemp0);
  const printFileName = toNonEmptyString(statusPayload?.printFileName) ||
    toNonEmptyString(statusPayload?.fileName);
  const printId = toNonEmptyString(statusPayload?.printId);
  const active = state !== 0 ||
    deviceState !== 0 ||
    (printJobTime !== null && printJobTime > 0) ||
    (printLeftTime !== null && printLeftTime > 0) ||
    (targetNozzleTemp !== null && targetNozzleTemp > 0) ||
    (targetBedTemp0 !== null && targetBedTemp0 > 0);
  const hasCoreState = state !== null && deviceState !== null;
  return {
    observed: true,
    idle: hasCoreState && !active,
    active,
    state,
    deviceState,
    printProgress,
    printJobTime,
    printLeftTime,
    targetNozzleTemp,
    targetBedTemp0,
    printFileName,
    printId,
  };
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
 * read-only printer status probeを送信し、応答を待つ。
 *
 * 【詳細説明】
 * - CFS load/unloadなどの物理操作前に、K2本体が印刷/加熱/ジョブ中ではないことを確認する。
 * - 送るframeはroot scalar取得だけで、CFS操作や印刷開始は含めない。
 * - timeout/error時は呼び出し側で送信前rejectへ変換する。
 *
 * @function sendPrinterStatusProbeAndWait
 * @param {WebSocket} ws - OPEN済みWebSocket
 * @param {object=} options - probe option
 * @param {string=} options.probeMode - 観測ラベル
 * @param {number=} options.timeoutMs - 応答待ちtimeout
 * @returns {Promise<object>} printer status観測結果
 */
export function sendPrinterStatusProbeAndWait(ws, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_PRINTER_STATUS_TIMEOUT_MS;
  const probeMode = toNonEmptyString(options.probeMode) || "printer-status";
  const request = {
    method: "get",
    params: Object.fromEntries(PRINTER_STATUS_KEYS.map((key) => [key, 1])),
  };
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
      const statusPayload = extractPrinterStatusPayload(payload);
      if (!statusPayload) {
        return;
      }
      settle(resolve, {
        status: "observed",
        probeMode,
        observedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        request,
        summary: summarizePrinterStatusPayload(statusPayload),
        payload,
      });
    };
    const timer = setTimeout(() => {
      settle(reject, new Error(`printer status probe timeout after ${timeoutMs}ms.`));
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
        observedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        request,
        evidence,
        summary: summarizeBoxsInfoEvidence(evidence.value, options.targetSourceId),
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
      observedAt: null,
      completedAt: new Date().toISOString(),
      elapsedMs: null,
      request: { method: "get", params: { boxsInfo: 1 } },
      evidence: null,
      message: summary.message,
      error: summary,
    };
  }
}

/**
 * printer status probeを実行し、失敗も構造化resultとして返す。
 *
 * 【詳細説明】
 * - `--require-printer-idle` の送信前guardで利用する。
 * - timeout/error時はCFS操作を送らず、result JSONへ失敗理由を残す。
 *
 * @private
 * @function runStructuredPrinterStatusProbe
 * @param {WebSocket} ws - OPEN済みWebSocket
 * @param {object} options - probe option
 * @param {string} options.probeMode - 観測ラベル
 * @param {number} options.timeoutMs - 応答待ちtimeout
 * @returns {Promise<object>} observed/timeout/errorのprinter status probe result
 */
async function runStructuredPrinterStatusProbe(ws, options) {
  try {
    return await sendPrinterStatusProbeAndWait(ws, options);
  } catch (error) {
    const summary = serializeCertificationError(error);
    return {
      status: summary.message.includes("timeout") ? "timeout" : "error",
      probeMode: toNonEmptyString(options?.probeMode) || "printer-status",
      observedAt: null,
      completedAt: new Date().toISOString(),
      elapsedMs: null,
      request: {
        method: "get",
        params: Object.fromEntries(PRINTER_STATUS_KEYS.map((key) => [key, 1])),
      },
      summary: null,
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
 * - 保存失敗時も物理command結果を失わないよう、result本体へevidence write failureを畳み込む。
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
  try {
    const evidence = await writeCertificationResultEvidence(result, outputDir);
    return {
      ...result,
      evidence,
    };
  } catch (error) {
    return {
      ...result,
      ok: false,
      evidenceWriteFailed: true,
      evidence: {
        written: false,
        directory: path.resolve(outputDir),
        files: [],
        error: serializeCertificationError(error),
      },
      commandResult: {
        ok: result?.ok === true,
        sent: result?.sent === true,
        status: result?.status || null,
        reason: result?.reason || null,
      },
    };
  }
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
  const operatorMarker = createOperatorMarkerEvidence(options.operatorMarker, startedAt);
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
      probePlan: createProbePlanSummary(options),
    }, options);
  }
  const liveValidation = validateLiveCertificationOptions(options);
  if (!liveValidation.ok) {
    return finalizeCertificationResult({
      ok: false,
      sent: false,
      dryRun: false,
      status: "rejected",
      reason: liveValidation.reason,
      blindRetryAllowed: false,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      host: options.host,
      wsPort: options.wsPort,
      request,
      plan,
      probePlan: createProbePlanSummary(options),
      response: null,
      probes: {
        before: null,
        after: null,
        afterSeries: [],
      },
      printerInfo: null,
      operatorMarker,
      targetSourceDelta: null,
    }, options);
  }
  let printerInfo = null;
  if (options.probeInfo || toNonEmptyString(options.requireInfoModel)) {
    printerInfo = await fetchPrinterInfoEvidence(options);
    const printerInfoValidation = validatePrinterInfoRequirement(printerInfo, options.requireInfoModel);
    if (!printerInfoValidation.ok) {
      return finalizeCertificationResult({
        ok: false,
        sent: false,
        dryRun: false,
        status: "rejected",
        reason: printerInfoValidation.reason,
        blindRetryAllowed: false,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        host: options.host,
        wsPort: options.wsPort,
        request,
        plan,
        probePlan: createProbePlanSummary(options),
        response: null,
        probes: {
          before: null,
          after: null,
          afterSeries: [],
        },
        printerInfo,
        operatorMarker,
        targetSourceDelta: null,
      }, options);
    }
  }
  const ws = await (options.openWs || openWs)(options.host, options.wsPort);
  try {
    let printerStatus = null;
    if (options.requirePrinterIdle === true) {
      printerStatus = await runStructuredPrinterStatusProbe(ws, {
        probeMode: "pre-command-printer-status",
        timeoutMs: options.printerStatusTimeoutMs,
      });
      if (printerStatus.status !== "observed") {
        return finalizeCertificationResult({
          ok: false,
          sent: false,
          dryRun: false,
          status: "rejected",
          reason: "pre-command-printer-status-observation-failed",
          blindRetryAllowed: false,
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAtMs,
          host: options.host,
          wsPort: options.wsPort,
          request,
          plan,
          probePlan: createProbePlanSummary(options),
          response: null,
          printerStatus,
          probes: {
            before: null,
            after: null,
            afterSeries: [],
          },
          printerInfo,
          operatorMarker,
          targetSourceDelta: null,
        }, options);
      }
      if (printerStatus.summary?.idle !== true) {
        return finalizeCertificationResult({
          ok: false,
          sent: false,
          dryRun: false,
          status: "rejected",
          reason: "pre-command-printer-not-idle",
          blindRetryAllowed: false,
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAtMs,
          host: options.host,
          wsPort: options.wsPort,
          request,
          plan,
          probePlan: createProbePlanSummary(options),
          response: null,
          printerStatus,
          probes: {
            before: null,
            after: null,
            afterSeries: [],
          },
          printerInfo,
          operatorMarker,
          targetSourceDelta: null,
        }, options);
      }
    }
    const probes = {
      before: null,
      after: null,
      afterSeries: [],
    };
    if (options.probeBefore) {
      probes.before = await runStructuredBoxsInfoProbe(ws, {
        probeMode: "before",
        timeoutMs: options.boxsInfoTimeoutMs,
        targetSourceId: request.payload.sourceId,
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
          probePlan: createProbePlanSummary(options),
          response: null,
          printerStatus,
          probes,
          printerInfo,
          operatorMarker,
          targetSourceDelta: null,
          ...summarizeProbeAttempts(probes),
        }, options);
      }
      const preCommandValidation = validatePreCommandProbeSummary(
        probes.before.summary,
        request.payload.sourceId
      );
      if (!preCommandValidation.ok) {
        return finalizeCertificationResult({
          ok: false,
          sent: false,
          dryRun: false,
          status: "rejected",
          reason: preCommandValidation.reason,
          blindRetryAllowed: false,
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAtMs,
          host: options.host,
          wsPort: options.wsPort,
          request,
          plan,
          probePlan: createProbePlanSummary(options),
          response: null,
          printerStatus,
          probes,
          printerInfo,
          operatorMarker,
          targetSourceDelta: null,
          ...summarizeProbeAttempts(probes),
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
        sent: true,
        sendAttempted: true,
        dryRun: false,
        status: "unknown",
        reason: "command-submit-outcome-unknown",
        blindRetryAllowed: false,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        host: options.host,
        wsPort: options.wsPort,
        request,
        plan,
        probePlan: createProbePlanSummary(options),
        response: null,
        printerStatus,
        probes,
        printerInfo,
        operatorMarker,
        targetSourceDelta: null,
        error: serializeCertificationError(error),
      }, options);
    }
    let targetSourceDelta = null;
    if (options.probeAfter) {
      await delayMs(options.postCommandProbeDelayMs);
      let lastAfterProbe = null;
      for (let index = 0; index < options.postCommandProbeCount; index += 1) {
        if (index > 0) {
          await delayMs(options.postCommandProbeIntervalMs);
        }
        const probe = await runStructuredBoxsInfoProbe(ws, {
          probeMode: options.postCommandProbeCount === 1 ? "after" : `after:${index + 1}`,
          timeoutMs: options.boxsInfoTimeoutMs,
          targetSourceId: request.payload.sourceId,
        });
        probes.afterSeries.push(probe);
        if (!probes.after) {
          probes.after = probe;
        }
        lastAfterProbe = probe;
      }
      targetSourceDelta = createTargetSourceDelta(
        probes.before,
        findLastObservedAfterProbe(probes.afterSeries),
        request.payload.sourceId
      );
      const hasFailedAfterProbe = probes.afterSeries.some((probe) => probe?.status !== "observed");
      if (hasFailedAfterProbe || lastAfterProbe?.status !== "observed") {
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
          probePlan: createProbePlanSummary(options),
          response,
          printerStatus,
          probes,
          printerInfo,
          operatorMarker,
          targetSourceDelta,
          ...summarizeProbeAttempts(probes),
        }, options);
      }
    }
    const postCommandObserved = options.probeAfter === true &&
      probes.afterSeries.length > 0 &&
      probes.afterSeries.every((probe) => probe?.status === "observed");
    return finalizeCertificationResult({
      ok: true,
      sent: true,
      dryRun: false,
      status: postCommandObserved ? "post-observed" : "submitted",
      reason: postCommandObserved ? "post-command-telemetry-observed" : "post-command-observation-not-requested",
      blindRetryAllowed: false,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      host: options.host,
      wsPort: options.wsPort,
      request,
      plan,
      probePlan: createProbePlanSummary(options),
      response,
      printerStatus,
      probes,
      printerInfo,
      operatorMarker,
      targetSourceDelta,
      ...summarizeProbeAttempts(probes),
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
