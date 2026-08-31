#!/usr/bin/env node
/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 K2 CFS read-only calibration CLI
 * @file capture_k2_cfs_readonly_calibration.mjs
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module capture_k2_cfs_readonly_calibration
 *
 * 【機能内容サマリ】
 * - Gate19 K2/CFS live certification前に `/info`、printer status、`boxsInfo` をread-onlyで複数回観測する
 * - CFS操作frameや印刷開始frameを一切送らず、idle predicate調整用の証跡を保存する
 *
 * 【公開関数一覧】
 * - {@link parseArgs}：CLI引数を解析
 * - {@link runK2CfsReadOnlyCalibration}：read-only calibrationを実行
 *
 * @version 1.390.1551 (PR #439)
 * @since   1.390.1545 (PR #439)
 * @lastModified 2026-08-31 19:51:15
 * -----------------------------------------------------------
 * @todo
 * - Gate19実機calibration結果からK2 idle predicateのfixture化可否を判断する
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  sendBoxsInfoProbeAndWait,
  sendPrinterStatusProbeAndWait,
} from "./capture_k2_cfs_slot_control.mjs";

const DEFAULT_WS_PORT = 9999;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_STATUS_PROBE_COUNT = 5;
const DEFAULT_STATUS_PROBE_INTERVAL_MS = 1000;
const DEFAULT_BOXSINFO_PROBE_COUNT = 2;
const DEFAULT_BOXSINFO_PROBE_INTERVAL_MS = 1000;

const USAGE = `Usage:
  node scripts/capture_k2_cfs_readonly_calibration.mjs --host 192.168.54.153 --require-info-model F012 --pretty

Options:
  --host <ip-or-host>             Required. K2 host or IP address.
  --ws-port <number>              WebSocket port. Default: 9999.
  --info-timeout-ms <number>      /info timeout. Default: 5000.
  --probe-timeout-ms <number>     Each WS read-only probe timeout. Default: 5000.
  --status-probe-count <number>   Number of printer status GET probes. Default: 5.
  --status-probe-interval-ms <n>  Delay between status probes. Default: 1000.
  --boxsinfo-probe-count <number> Number of boxsInfo GET probes. Default: 2.
  --boxsinfo-probe-interval-ms <n>
                                  Delay between boxsInfo probes. Default: 1000.
  --require-info-model <model>    Mark result failed unless /info model matches.
  --output-dir <dir>              Save readonly-calibration-result.json under timestamped directory.
  --pretty                        Pretty-print stdout JSON.
  --help                          Show this help.
`;

/**
 * 文字列を空白除去した非空文字列へ正規化する。
 *
 * @private
 * @function toNonEmptyString
 * @param {*} value - 入力値
 * @returns {string} 非空文字列、または空文字
 */
function toNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * CLI数値optionを検証する。
 *
 * @private
 * @function assertIntegerBetween
 * @param {object} options - option object
 * @param {string} key - option key
 * @param {string} label - CLI表示名
 * @param {number} min - 最小値
 * @param {number} max - 最大値
 * @returns {void}
 * @throws {Error} 値が範囲外の場合
 */
function assertIntegerBetween(options, key, label, min, max) {
  if (!Number.isInteger(options[key]) || options[key] < min || options[key] > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
}

/**
 * CLI引数を解析する。
 *
 * 【詳細説明】
 * - このCLIはread-only calibration専用であり、CFS操作command/sourceは受け取らない。
 * - `--output-dir` はtimestamp付き子directoryにJSONを保存するだけで、fixture本体は生成しない。
 *
 * @function parseArgs
 * @param {string[]} argv - `process.argv.slice(2)` 相当
 * @returns {object} 解析済みoption
 * @throws {Error} 必須引数や数値範囲が不正な場合
 * @example
 * const options = parseArgs(["--host", "192.168.54.153", "--require-info-model", "F012"]);
 */
export function parseArgs(argv = []) {
  const options = {
    host: "",
    wsPort: DEFAULT_WS_PORT,
    infoTimeoutMs: DEFAULT_TIMEOUT_MS,
    probeTimeoutMs: DEFAULT_TIMEOUT_MS,
    statusProbeCount: DEFAULT_STATUS_PROBE_COUNT,
    statusProbeIntervalMs: DEFAULT_STATUS_PROBE_INTERVAL_MS,
    boxsInfoProbeCount: DEFAULT_BOXSINFO_PROBE_COUNT,
    boxsInfoProbeIntervalMs: DEFAULT_BOXSINFO_PROBE_INTERVAL_MS,
    requireInfoModel: "",
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
    else if (arg === "--host") options.host = next();
    else if (arg === "--ws-port") options.wsPort = Number(next());
    else if (arg === "--info-timeout-ms") options.infoTimeoutMs = Number(next());
    else if (arg === "--probe-timeout-ms") options.probeTimeoutMs = Number(next());
    else if (arg === "--status-probe-count") options.statusProbeCount = Number(next());
    else if (arg === "--status-probe-interval-ms") options.statusProbeIntervalMs = Number(next());
    else if (arg === "--boxsinfo-probe-count") options.boxsInfoProbeCount = Number(next());
    else if (arg === "--boxsinfo-probe-interval-ms") options.boxsInfoProbeIntervalMs = Number(next());
    else if (arg === "--require-info-model") options.requireInfoModel = next();
    else if (arg === "--output-dir") options.outputDir = next();
    else if (arg === "--pretty") options.pretty = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.help) {
    return options;
  }
  if (!toNonEmptyString(options.host)) {
    throw new Error("--host is required.");
  }
  assertIntegerBetween(options, "wsPort", "--ws-port", 1, 65535);
  assertIntegerBetween(options, "infoTimeoutMs", "--info-timeout-ms", 1000, 60000);
  assertIntegerBetween(options, "probeTimeoutMs", "--probe-timeout-ms", 1000, 60000);
  assertIntegerBetween(options, "statusProbeCount", "--status-probe-count", 1, 60);
  assertIntegerBetween(options, "statusProbeIntervalMs", "--status-probe-interval-ms", 0, 60000);
  assertIntegerBetween(options, "boxsInfoProbeCount", "--boxsinfo-probe-count", 0, 60);
  assertIntegerBetween(options, "boxsInfoProbeIntervalMs", "--boxsinfo-probe-interval-ms", 0, 60000);
  if (toNonEmptyString(options.outputDir)) {
    options.outputDir = path.resolve(options.outputDir);
  }
  return options;
}

/**
 * `/info` URLを生成する。
 *
 * @private
 * @function buildInfoUrl
 * @param {string} host - K2 host
 * @returns {string} `/info` URL
 */
function buildInfoUrl(host) {
  return `http://${host}/info`;
}

/**
 * `/info` をread-only取得する。
 *
 * 【詳細説明】
 * - model mismatchは例外ではなくresult上のfailure reasonにする。
 * - MACはidentity authorityに使わず、read-only evidenceとしてそのまま保持する。
 *
 * @private
 * @function fetchPrinterInfo
 * @param {object} options - calibration option
 * @returns {Promise<object>} `/info` 観測result
 */
async function fetchPrinterInfo(options) {
  const requestedAt = new Date().toISOString();
  const startedAt = Date.now();
  const url = buildInfoUrl(options.host);
  const fetcher = options.fetchInfo || globalThis.fetch;
  const expectedModel = toNonEmptyString(options.requireInfoModel) || null;
  if (typeof fetcher !== "function") {
    return {
      status: "error",
      url,
      requestedAt,
      observedAt: null,
      elapsedMs: Date.now() - startedAt,
      expectedModel,
      modelMatched: expectedModel ? false : null,
      info: null,
      error: { message: "fetch API is not available." },
    };
  }
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), options.infoTimeoutMs) : null;
  try {
    const response = await fetcher(url, controller ? { signal: controller.signal } : {});
    const payload = typeof response?.json === "function"
      ? await response.json()
      : JSON.parse(await response.text());
    const info = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
    const modelMatched = expectedModel ? info?.model === expectedModel : null;
    return {
      status: response?.ok === false || !info ? "error" : "observed",
      url,
      requestedAt,
      observedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      httpStatus: Number.isInteger(response?.status) ? response.status : null,
      expectedModel,
      modelMatched,
      info,
      error: info ? null : { message: "Invalid /info JSON payload." },
    };
  } catch (error) {
    return {
      status: error?.name === "AbortError" ? "timeout" : "error",
      url,
      requestedAt,
      observedAt: null,
      elapsedMs: Date.now() - startedAt,
      expectedModel,
      modelMatched: expectedModel ? false : null,
      info: null,
      error: { message: error?.message || String(error) },
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * WebSocketを開く。
 *
 * @private
 * @function openWs
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
 * 指定時間だけ待機する。
 *
 * @private
 * @function sleep
 * @param {number} milliseconds - 待機ミリ秒
 * @returns {Promise<void>} 待機完了promise
 */
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(milliseconds) || 0)));
}

/**
 * JSON文字列を安全にparseする。
 *
 * @private
 * @function parseJsonSafely
 * @param {*} payload - WebSocket payload候補。
 * @returns {?Object} parse済みobject、またはnull。
 */
function parseJsonSafely(payload) {
  try {
    const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload ?? "");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * outbound WebSocket frame種別を分類する。
 *
 * @private
 * @function classifyOutboundFrame
 * @param {?Object} frame - parse済みoutbound frame。
 * @returns {string} timeline用kind。
 */
function classifyOutboundFrame(frame) {
  if (frame?.method === "get" && frame?.params?.boxsInfo === 1) {
    return "boxsInfo-get";
  }
  if (frame?.method === "get" && frame?.params?.state === 1) {
    return "printer-status-get";
  }
  return frame?.method ? `${frame.method}-frame` : "ws-out";
}

/**
 * inbound WebSocket frame種別を分類する。
 *
 * @private
 * @function classifyInboundFrame
 * @param {?Object} frame - parse済みinbound frame。
 * @returns {string} timeline用kind。
 */
function classifyInboundFrame(frame) {
  const root = frame?.result && typeof frame.result === "object" ? frame.result : frame;
  if (root?.boxsInfo) {
    return "boxsInfo";
  }
  if (Object.prototype.hasOwnProperty.call(root || {}, "state") ||
      Object.prototype.hasOwnProperty.call(root || {}, "deviceState")) {
    return "printer-status";
  }
  return "ws-in";
}

/**
 * WebSocket送受信timeline recorderを作成する。
 *
 * 【詳細説明】
 * - CFS操作frameやraw payloadを保存せず、read-only calibration中の送受信順序だけを記録する。
 * - probe番号を付けることで、timeout後の遅延応答が次probe windowへ紛れた可能性をレビューできる。
 *
 * @private
 * @function createWsTimelineRecorder
 * @param {Object} ws - OPEN済みWebSocket。
 * @returns {{timeline:Array<Object>, beginProbe:Function}} timeline recorder。
 */
function createWsTimelineRecorder(ws) {
  const timeline = [];
  let activeProbe = null;
  const originalSend = typeof ws?.send === "function" ? ws.send.bind(ws) : null;
  if (originalSend) {
    ws.send = (payload, ...args) => {
      const frame = parseJsonSafely(payload);
      timeline.push({
        at: new Date().toISOString(),
        direction: "out",
        kind: classifyOutboundFrame(frame),
        probe: activeProbe?.index ?? null,
        probeKind: activeProbe?.kind ?? null,
        method: frame?.method || null,
        paramKeys: frame?.params && typeof frame.params === "object" && !Array.isArray(frame.params)
          ? Object.keys(frame.params).sort()
          : [],
        byteLength: Buffer.byteLength(String(payload ?? ""), "utf8"),
      });
      return originalSend(payload, ...args);
    };
  }
  if (typeof ws?.on === "function") {
    ws.on("message", (payload) => {
      const frame = parseJsonSafely(payload);
      const root = frame?.result && typeof frame.result === "object" ? frame.result : frame;
      timeline.push({
        at: new Date().toISOString(),
        direction: "in",
        kind: classifyInboundFrame(frame),
        probe: activeProbe?.index ?? null,
        probeKind: activeProbe?.kind ?? null,
        method: frame?.method || null,
        payloadKeys: root && typeof root === "object" && !Array.isArray(root)
          ? Object.keys(root).sort()
          : [],
        byteLength: Buffer.byteLength(Buffer.isBuffer(payload) ? payload : String(payload ?? ""), "utf8"),
      });
    });
  }
  return {
    timeline,
    beginProbe(kind, index) {
      activeProbe = { kind, index };
      return () => {
        if (activeProbe?.kind === kind && activeProbe?.index === index) {
          activeProbe = null;
        }
      };
    },
  };
}

/**
 * probeを失敗込みのJSON resultへ変換して実行する。
 *
 * @private
 * @function runProbeSafely
 * @param {Function} probeFn - read-only probe関数
 * @param {object} ws - OPEN済みWebSocket
 * @param {object} options - probe option
 * @param {?Object=} recorder - timeline recorder。
 * @param {string=} timelineKind - timeline用probe種別。
 * @param {number=} timelineIndex - timeline用probe番号。
 * @returns {Promise<object>} observed/timeout/error result
 */
async function runProbeSafely(probeFn, ws, options, recorder = null, timelineKind = "", timelineIndex = null) {
  const finishProbe = recorder?.beginProbe
    ? recorder.beginProbe(timelineKind || options.probeMode || "probe", timelineIndex)
    : null;
  try {
    return await probeFn(ws, options);
  } catch (error) {
    return {
      status: error?.message?.includes("timeout") ? "timeout" : "error",
      probeMode: options.probeMode,
      observedAt: null,
      completedAt: new Date().toISOString(),
      elapsedMs: null,
      request: options.request || null,
      summary: null,
      evidence: null,
      message: error?.message || String(error),
      error: { message: error?.message || String(error) },
    };
  } finally {
    if (typeof finishProbe === "function") {
      finishProbe();
    }
  }
}

/**
 * calibration result JSONをtimestamp付きdirectoryへ保存する。
 *
 * @private
 * @function writeCalibrationEvidence
 * @param {object} result - calibration result
 * @param {string} outputDir - 保存先root
 * @returns {Promise<object>} 保存先summary
 */
async function writeCalibrationEvidence(result, outputDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = path.join(path.resolve(outputDir), stamp);
  const evidence = {
    written: true,
    directory,
    files: ["readonly-calibration-result.json"],
  };
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "readonly-calibration-result.json"),
    `${JSON.stringify({ ...result, evidence }, null, 2)}\n`,
    "utf8",
  );
  return evidence;
}

/**
 * calibration evidenceを保存し、失敗時も観測resultを保持する。
 *
 * 【詳細説明】
 * - 実機calibrationでは通信観測そのものが最重要証跡になる。
 * - 保存先pathや権限の問題でJSON保存に失敗しても、観測済みstatus/boxsInfo/timelineを呼び出し側へ返す。
 * - 失敗は `evidenceWriteFailed` と `evidence.written=false` で明示し、正常保存と混同しない。
 *
 * @private
 * @function attachCalibrationEvidence
 * @param {object} result - calibration result
 * @param {string} outputDir - 保存先root
 * @returns {Promise<object>} evidence情報を付与したcalibration result
 */
async function attachCalibrationEvidence(result, outputDir) {
  try {
    result.evidence = await writeCalibrationEvidence(result, outputDir);
  } catch (error) {
    result.evidenceWriteFailed = true;
    result.evidence = {
      written: false,
      reason: "evidence-write-failed",
      directory: path.resolve(outputDir),
      files: ["readonly-calibration-result.json"],
      error: { message: error?.message || String(error) },
    };
  }
  return result;
}

/**
 * K2 CFS read-only calibrationを実行する。
 *
 * 【詳細説明】
 * - `/info`、printer status、boxsInfoを順番に観測する。
 * - この関数は `set` frameを送らず、CFS load/unload/selectなどの副作用を発生させない。
 * - statusやboxsInfoの一部がtimeoutしても、観測できた結果を保持して `partial` として返す。
 *
 * @function runK2CfsReadOnlyCalibration
 * @param {object} options - calibration option
 * @returns {Promise<object>} calibration result
 * @example
 * const result = await runK2CfsReadOnlyCalibration(parseArgs(["--host", "192.168.54.153"]));
 */
export async function runK2CfsReadOnlyCalibration(options) {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const printerInfo = await fetchPrinterInfo(options);
  let ws = null;
  let wsOpen = false;
  const printerStatusSeries = [];
  const boxsInfoSeries = [];
  let timelineRecorder = { timeline: [] };
  try {
    ws = await (options.openWs || openWs)(options.host, options.wsPort);
    wsOpen = true;
    timelineRecorder = createWsTimelineRecorder(ws);
    for (let index = 0; index < options.statusProbeCount; index += 1) {
      if (index > 0) {
        await sleep(options.statusProbeIntervalMs);
      }
      printerStatusSeries.push(await runProbeSafely(sendPrinterStatusProbeAndWait, ws, {
        probeMode: `printer-status:${index + 1}`,
        timeoutMs: options.probeTimeoutMs,
      }, timelineRecorder, "printer-status", index + 1));
    }
    for (let index = 0; index < options.boxsInfoProbeCount; index += 1) {
      if (index > 0) {
        await sleep(options.boxsInfoProbeIntervalMs);
      }
      boxsInfoSeries.push(await runProbeSafely(sendBoxsInfoProbeAndWait, ws, {
        probeMode: `boxsInfo:${index + 1}`,
        timeoutMs: options.probeTimeoutMs,
      }, timelineRecorder, "boxsInfo", index + 1));
    }
  } catch (error) {
    const result = {
      ok: false,
      sent: false,
      status: "error",
      reason: "read-only-calibration-error",
      blindRetryAllowed: false,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      host: options.host,
      wsPort: options.wsPort,
      printerInfo,
      wsOpen,
      wsTimeline: timelineRecorder.timeline,
      printerStatusSeries,
      boxsInfoSeries,
      statusProbeCount: printerStatusSeries.length,
      boxsInfoProbeCount: boxsInfoSeries.length,
      error: { message: error?.message || String(error) },
    };
    if (toNonEmptyString(options.outputDir)) {
      await attachCalibrationEvidence(result, options.outputDir);
    }
    return result;
  } finally {
    if (ws && typeof ws.close === "function") {
      ws.close();
    }
  }
  const infoOk = !options.requireInfoModel || printerInfo?.modelMatched === true;
  const observedStatusProbeCount = printerStatusSeries.filter((probe) => probe.status === "observed").length;
  const observedBoxsInfoProbeCount = boxsInfoSeries.filter((probe) => probe.status === "observed").length;
  const failedStatusProbeCount = printerStatusSeries.length - observedStatusProbeCount;
  const failedBoxsInfoProbeCount = boxsInfoSeries.length - observedBoxsInfoProbeCount;
  const allRequestedProbesObserved = observedStatusProbeCount === options.statusProbeCount
    && observedBoxsInfoProbeCount === options.boxsInfoProbeCount;
  const ok = printerInfo?.status === "observed" && infoOk && allRequestedProbesObserved;
  const result = {
    ok,
    sent: false,
    status: ok ? "observed" : "partial",
    reason: ok ? "read-only-calibration-observed" : "read-only-calibration-incomplete",
    blindRetryAllowed: false,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAtMs,
    host: options.host,
    wsPort: options.wsPort,
    printerInfo,
    wsOpen,
    wsTimeline: timelineRecorder.timeline,
    printerStatusSeries,
    boxsInfoSeries,
    statusProbeCount: printerStatusSeries.length,
    observedStatusProbeCount,
    failedStatusProbeCount,
    boxsInfoProbeCount: boxsInfoSeries.length,
    observedBoxsInfoProbeCount,
    failedBoxsInfoProbeCount,
  };
  if (toNonEmptyString(options.outputDir)) {
    await attachCalibrationEvidence(result, options.outputDir);
  }
  return result;
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "")) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(USAGE.trim());
      process.exit(0);
    }
    const result = await runK2CfsReadOnlyCalibration(options);
    console.log(JSON.stringify(result, null, options.pretty ? 2 : 0));
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(error?.message || String(error));
    console.error(USAGE.trim());
    process.exit(1);
  }
}
