/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Protocol Recorder CLI
 * @file capture_protocol_fixture.mjs
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module capture_protocol_fixture
 *
 * 【機能内容サマリ】
 * - 実機の /info と WebSocket 9999 を読み取り中心で観測
 * - ProtocolRecorder で redaction 済み fixture を生成
 * - metadata.json、capture.json、events.ndjson を指定ディレクトリへ保存
 *
 * 【公開関数一覧】
 * - {@link parseArgs}：CLI 引数を解析
 * - {@link parseMarkerScheduleItem}：予約 marker 指定を解析
 * - {@link parseInteractiveMarkerLine}：標準入力 marker 行を解析
 * - {@link recordInteractiveMarkerLine}：標準入力 marker を recorder へ記録
 * - {@link captureProtocolFixture}：実機通信をキャプチャして fixture を保存
 * - {@link main}：CLI エントリポイント
 *
 * @version 1.390.1311 (PR #432)
 * @since   1.390.1290 (PR #432)
 * @lastModified 2026-08-08 07:20:59
 * -----------------------------------------------------------
 * @todo
 * - Electron UI からのキャプチャ開始・停止操作を追加
 */

import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createProtocolRecorder, toFixtureNdjson } from "../3dp_lib/printer_core/dashboard_protocol_recorder.js";

/**
 * CLI ヘルプテキスト。
 *
 * 【詳細説明】
 * - 実機へ危険な制御を送らないため、boxsInfo request は明示オプションにする。
 *
 * @constant {string}
 */
const HELP_TEXT = `Usage:
  node scripts/capture_protocol_fixture.mjs --host 192.168.54.151 --model "K1 Max" --scenario idle --out tests/fixtures/printers/k1-max/device-a

Options:
  --host <ip-or-host>       Required. Printer host or IP address.
  --model <name>            Device model label for metadata.
  --attachment <name>       Attachment label, e.g. none, CFS, CFS-C.
  --scenario <name>         Capture scenario label.
  --out <dir>               Output fixture directory.
  --duration-ms <number>    WebSocket observation duration. Default: 5000.
  --ws-port <number>        WebSocket port. Default: 9999.
  --http-port <number>      HTTP port. Default: 80.
  --send-boxsinfo           Send read-only {"method":"get","params":{"boxsInfo":1}} after WS open.
  --skip-http               Skip GET /info.
  --skip-ws                 Skip WebSocket observation.
  --require-http            Fail the result if /info was not observed successfully.
  --require-ws              Fail the result if WS did not open.
  --require-boxsinfo        Fail the result if boxsInfo was not observed.
  --minimum-events <number> Fail the result if fewer events were captured. Default: 0.
  --marker-at <ms:name[:json-details]>
                            Add an operator marker after elapsed milliseconds. Repeatable.
  --interactive-markers     Read marker lines from stdin while capturing. Format: name or name {"json":true}.
  --keep-failed             Write failed captures under tmp/failed-captures instead of discarding them.
  --notes <text>            Operator notes for metadata.
  --help                    Show this help.
`;

/**
 * marker details の JSON 文字列を解析する。
 *
 * 【詳細説明】
 * - CLI 入力の details は fixture 化時に recorder 側で redaction される。
 * - details は marker の補助情報として扱うため、配列や null ではなく object に限定する。
 *
 * @function parseMarkerDetails
 * @param {string} text - JSON object 文字列
 * @returns {Object} 解析した details
 * @throws {Error} JSON が object でない場合
 * @example
 * const details = parseMarkerDetails("{\"phase\":\"start\"}");
 */
export function parseMarkerDetails(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("marker details must be a JSON object");
  }
  return parsed;
}

/**
 * 予約 marker 指定を解析する。
 *
 * 【詳細説明】
 * - `ms:name` または `ms:name:json-details` の形式を扱う。
 * - 物理操作の境界を通信ログと同じ時系列へ残すため、経過ミリ秒と marker 名を必須にする。
 *
 * @function parseMarkerScheduleItem
 * @param {string} value - `ms:name[:json-details]` 形式の CLI 値
 * @returns {Object} 予約 marker 情報
 * @throws {Error} 形式が不正な場合
 * @example
 * const marker = parseMarkerScheduleItem("1500:print-start:{\"source\":\"operator\"}");
 */
export function parseMarkerScheduleItem(value) {
  const firstSeparator = String(value || "").indexOf(":");
  if (firstSeparator <= 0) {
    throw new Error("--marker-at must be formatted as ms:name[:json-details]");
  }
  const atMs = Number(String(value).slice(0, firstSeparator));
  const remainder = String(value).slice(firstSeparator + 1);
  const detailsSeparator = remainder.indexOf(":");
  const name = detailsSeparator >= 0 ? remainder.slice(0, detailsSeparator).trim() : remainder.trim();
  const detailsText = detailsSeparator >= 0 ? remainder.slice(detailsSeparator + 1).trim() : "";
  if (!Number.isFinite(atMs) || atMs < 0) {
    throw new Error("--marker-at elapsed milliseconds must be a number >= 0");
  }
  if (!name) {
    throw new Error("--marker-at marker name is required");
  }
  return {
    atMs,
    name,
    details: detailsText ? parseMarkerDetails(detailsText) : { source: "scheduled-cli" },
  };
}

/**
 * 標準入力から受け取った marker 行を解析する。
 *
 * 【詳細説明】
 * - 空行は marker として扱わず、操作者が改行を誤入力しても capture にノイズを残さない。
 * - JSON details は最初の `{` 以降として読み取り、marker 名に空白を含められるようにする。
 *
 * @function parseInteractiveMarkerLine
 * @param {string} line - 標準入力から受け取った 1 行
 * @returns {Object|null} marker 情報、空行の場合 null
 * @throws {Error} JSON details が不正な場合
 * @example
 * const marker = parseInteractiveMarkerLine("print-start {\"phase\":\"start\"}");
 */
export function parseInteractiveMarkerLine(line) {
  const text = String(line || "").trim();
  if (!text) {
    return null;
  }
  const detailsStart = text.indexOf("{");
  if (detailsStart < 0) {
    return {
      name: text,
      details: { source: "stdin" },
    };
  }
  const name = text.slice(0, detailsStart).trim();
  if (!name) {
    throw new Error("interactive marker name is required");
  }
  return {
    name,
    details: parseMarkerDetails(text.slice(detailsStart)),
  };
}

/**
 * CLI 引数を解析する。
 *
 * 【詳細説明】
 * - 依存を増やさず、Gate 0 用の単純な key-value オプションだけを扱う。
 *
 * @function parseArgs
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {Object} 解析済みオプション
 * @throws {Error} 必須引数が不足している場合
 * @example
 * const options = parseArgs(["--host", "192.168.54.151"]);
 */
export function parseArgs(argv) {
  const options = {
    durationMs: 5000,
    wsPort: 9999,
    httpPort: 80,
    sendBoxsInfo: false,
    skipHttp: false,
    skipWs: false,
    requireHttp: false,
    requireWs: false,
    requireBoxsInfo: false,
    minimumEvents: 0,
    markerSchedule: [],
    interactiveMarkers: false,
    keepFailed: false,
    model: "unknown",
    attachment: "unknown",
    scenario: "unspecified",
    notes: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--send-boxsinfo") {
      options.sendBoxsInfo = true;
      continue;
    }
    if (arg === "--skip-http") {
      options.skipHttp = true;
      continue;
    }
    if (arg === "--skip-ws") {
      options.skipWs = true;
      continue;
    }
    if (arg === "--require-http") {
      options.requireHttp = true;
      continue;
    }
    if (arg === "--require-ws") {
      options.requireWs = true;
      continue;
    }
    if (arg === "--require-boxsinfo") {
      options.requireBoxsInfo = true;
      continue;
    }
    if (arg === "--keep-failed") {
      options.keepFailed = true;
      continue;
    }
    if (arg === "--interactive-markers") {
      options.interactiveMarkers = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    index += 1;
    if (arg === "--host") options.host = next;
    else if (arg === "--model") options.model = next;
    else if (arg === "--attachment") options.attachment = next;
    else if (arg === "--scenario") options.scenario = next;
    else if (arg === "--out") options.outDir = next;
    else if (arg === "--duration-ms") options.durationMs = Number(next);
    else if (arg === "--ws-port") options.wsPort = Number(next);
    else if (arg === "--http-port") options.httpPort = Number(next);
    else if (arg === "--minimum-events") options.minimumEvents = Number(next);
    else if (arg === "--marker-at") options.markerSchedule.push(parseMarkerScheduleItem(next));
    else if (arg === "--notes") options.notes = next;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (options.help) {
    return options;
  }
  if (!options.host) {
    throw new Error("--host is required");
  }
  if (!options.outDir) {
    throw new Error("--out is required");
  }
  if (!Number.isFinite(options.durationMs) || options.durationMs < 100) {
    throw new Error("--duration-ms must be a number >= 100");
  }
  if (!Number.isFinite(options.wsPort) || options.wsPort <= 0) {
    throw new Error("--ws-port must be a positive number");
  }
  if (!Number.isFinite(options.httpPort) || options.httpPort <= 0) {
    throw new Error("--http-port must be a positive number");
  }
  if (!Number.isFinite(options.minimumEvents) || options.minimumEvents < 0) {
    throw new Error("--minimum-events must be a number >= 0");
  }
  return options;
}

/**
 * HTTP GET に timeout を付けて実行する。
 *
 * 【詳細説明】
 * - 応答しない実機や閉じたポートで capture 全体が止まらないようにする。
 *
 * @function fetchWithTimeout
 * @param {string} url - 取得 URL
 * @param {number} timeoutMs - timeout ミリ秒
 * @returns {Promise<Object>} response 互換オブジェクト
 * @throws {Error} timeout または HTTP 失敗
 * @example
 * const response = await fetchWithTimeout("http://192.168.54.151/info", 3000);
 */
export async function fetchWithTimeout(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "https:" ? https : http;
    const request = client.request(parsedUrl, { method: "GET", timeout: timeoutMs }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode || 0,
          statusText: response.statusMessage || "",
          text: async () => text,
        });
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error(`HTTP timeout after ${timeoutMs}ms`));
    });
    request.on("error", reject);
    request.end();
  });
}

/**
 * response body を JSON 優先で読み取る。
 *
 * 【詳細説明】
 * - /info が JSON でない場合も raw text として fixture に残す。
 *
 * @function readResponseBody
 * @param {Response} response - fetch response
 * @returns {Promise<Object>} body 情報
 * @example
 * const body = await readResponseBody(response);
 */
export async function readResponseBody(response) {
  const text = await response.text();
  try {
    return {
      bodyKind: "json",
      body: JSON.parse(text),
    };
  } catch {
    return {
      bodyKind: "text",
      body: text,
    };
  }
}

/**
 * WebSocket payload を fixture 保存向けに整形する。
 *
 * 【詳細説明】
 * - text は JSON として読める場合のみ JSON 化し、それ以外は raw text として残す。
 * - binary は base64 文字列にして、TEXT/BINARY 種別を失わない。
 *
 * @function normalizeWsPayload
 * @param {*} data - ws message data
 * @param {boolean} isBinary - binary frame かどうか
 * @returns {Object} 正規化した frame payload
 * @example
 * const payload = normalizeWsPayload(Buffer.from("{}"), false);
 */
export function normalizeWsPayload(data, isBinary) {
  if (isBinary) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return {
      frameType: "binary",
      encoding: "base64",
      body: buffer.toString("base64"),
    };
  }

  const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  try {
    return {
      frameType: "text",
      bodyKind: "json",
      body: JSON.parse(text),
    };
  } catch {
    return {
      frameType: "text",
      bodyKind: "text",
      body: text,
    };
  }
}

/**
 * payload 内に指定キーが含まれるか再帰的に判定する。
 *
 * 【詳細説明】
 * - boxsInfo は root 直下だけでなく、レスポンス envelope の params/data 内に入ることがある。
 * - capture の成功判定にだけ使うため、値の内容ではなくキーの存在を確認する。
 *
 * @function payloadHasKey
 * @param {*} value - 検査対象 payload
 * @param {string} keyName - 探すキー名
 * @returns {boolean} キーが存在する場合 true
 * @example
 * const hasBoxsInfo = payloadHasKey({ data: { boxsInfo: {} } }, "boxsInfo");
 */
export function payloadHasKey(value, keyName) {
  if (Array.isArray(value)) {
    return value.some((entry) => payloadHasKey(entry, keyName));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.entries(value).some(([childKey, childValue]) => {
    return childKey === keyName || payloadHasKey(childValue, keyName);
  });
}

/**
 * WebSocket heartbeat frame かどうかを判定する。
 *
 * 【詳細説明】
 * - Creality K1/K2 系の `heart_beat` text frame へ read-only な `ok` を返すために使う。
 * - JSON envelope 化された文字列も安全側で認識する。
 *
 * @function isHeartbeatPayload
 * @param {Object} payload - normalizeWsPayload の戻り値
 * @returns {boolean} heartbeat の場合 true
 * @example
 * const isHeartbeat = isHeartbeatPayload(normalizeWsPayload("heart_beat", false));
 */
export function isHeartbeatPayload(payload) {
  return payload?.frameType === "text" &&
    payload.bodyKind === "text" &&
    String(payload.body || "").trim() === "heart_beat";
}

/**
 * 指定時間だけ待機する。
 *
 * 【詳細説明】
 * - WebSocket 観測時間を単純に表現するための Promise helper。
 *
 * @function sleep
 * @param {number} ms - 待機ミリ秒
 * @returns {Promise<void>} 待機完了
 * @example
 * await sleep(1000);
 */
export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * scheduled marker の発火状態を追跡する。
 *
 * 【詳細説明】
 * - 予約した marker が capture 内で実際に event 化されたかを validation へ反映する。
 * - marker 名は公開 fixture に入る情報だが、未発火一覧では過剰な文字列露出を避けるため index と時刻だけを保持する。
 *
 * @function createMarkerTracker
 * @param {Object[]} markerSchedule - 予約 marker 一覧
 * @returns {Object} marker 追跡状態
 * @example
 * const tracker = createMarkerTracker([{ atMs: 1000, name: "print-start" }]);
 */
export function createMarkerTracker(markerSchedule = []) {
  return {
    scheduled: markerSchedule.map((marker, index) => ({
      index,
      atMs: marker.atMs,
      observed: false,
    })),
    parseErrors: 0,
  };
}

/**
 * capture 中に実行する予約 marker timer を登録する。
 *
 * 【詳細説明】
 * - timer は capture 終了時に呼び出し側で clear できるように handle 配列として返す。
 * - recorder への marker 追加だけを行い、実機通信には一切影響させない。
 *
 * @function scheduleCaptureMarkers
 * @param {Object} recorder - ProtocolRecorder instance
 * @param {Object[]} markerSchedule - 予約 marker 一覧
 * @param {Object=} markerTracker - marker 発火状態の追跡先
 * @returns {Object[]} clearTimeout に渡せる timer handle 一覧
 * @example
 * const timers = scheduleCaptureMarkers(recorder, [{ atMs: 1000, name: "print-start", details: {} }]);
 */
export function scheduleCaptureMarkers(recorder, markerSchedule = [], markerTracker = null) {
  return markerSchedule.map((marker, index) => {
    return setTimeout(() => {
      recorder.addMarker(marker.name, {
        ...marker.details,
        source: "scheduled-cli",
        scheduledAtMs: marker.atMs,
      });
      if (markerTracker?.scheduled?.[index]) {
        markerTracker.scheduled[index].observed = true;
      }
    }, marker.atMs);
  });
}

/**
 * 標準入力 marker 行を recorder へ記録する。
 *
 * 【詳細説明】
 * - details 内の source は操作者入力で上書きさせず、最後に `stdin` を固定する。
 * - JSON 解析失敗時は入力断片を fixture へ残さず、固定 errorCode だけを marker として保存する。
 *
 * @function recordInteractiveMarkerLine
 * @param {Object} recorder - ProtocolRecorder instance
 * @param {string} line - 標準入力から受け取った 1 行
 * @param {Object=} markerTracker - marker parse error 数の追跡先
 * @returns {boolean} marker を正常に記録した場合 true、空行または解析失敗時 false
 * @example
 * recordInteractiveMarkerLine(recorder, "operator pause {\"phase\":\"pause\"}");
 */
export function recordInteractiveMarkerLine(recorder, line, markerTracker = null) {
  try {
    const marker = parseInteractiveMarkerLine(line);
    if (!marker) {
      return false;
    }
    recorder.addMarker(marker.name, {
      ...marker.details,
      source: "stdin",
    });
    return true;
  } catch {
    if (markerTracker) {
      markerTracker.parseErrors += 1;
    }
    recorder.addMarker("marker-parse-error", {
      source: "stdin",
      errorCode: "invalid-marker-json",
    });
    return false;
  }
}

/**
 * capture 中だけ標準入力 marker reader を接続する。
 *
 * 【詳細説明】
 * - `--interactive-markers` 指定時だけ readline を開き、操作者の物理操作メモを marker event に変換する。
 * - marker 行の解析に失敗した場合も capture 自体は止めず、解析失敗 marker として記録する。
 *
 * @function attachInteractiveMarkerReader
 * @param {Object} recorder - ProtocolRecorder instance
 * @param {boolean} enabled - 標準入力 marker を有効化するか
 * @param {Object=} markerTracker - marker parse error 数の追跡先
 * @returns {Object|null} close() を持つ reader、無効時は null
 * @example
 * const reader = attachInteractiveMarkerReader(recorder, true);
 */
export function attachInteractiveMarkerReader(recorder, enabled, markerTracker = null) {
  if (!enabled) {
    return null;
  }
  const reader = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });
  reader.on("line", (line) => {
    recordInteractiveMarkerLine(recorder, line, markerTracker);
  });
  return reader;
}

/**
 * marker validation 用の集計を作成する。
 *
 * 【詳細説明】
 * - scheduled marker の未発火を success 判定に使えるように、予定数・観測数・未発火一覧を返す。
 * - 未発火一覧は marker 名を含めず、CLI 入力に秘密情報が混ざった場合の露出面を小さくする。
 *
 * @function summarizeMarkerValidation
 * @param {Object} markerTracker - createMarkerTracker の戻り値
 * @param {Object[]} markerEvents - fixture 内の marker event 一覧
 * @returns {Object} marker validation 集計
 * @example
 * const summary = summarizeMarkerValidation(markerTracker, fixture.events.filter((event) => event.direction === "marker"));
 */
export function summarizeMarkerValidation(markerTracker, markerEvents) {
  const missing = (markerTracker?.scheduled || [])
    .filter((marker) => !marker.observed)
    .map((marker) => ({
      index: marker.index,
      atMs: marker.atMs,
    }));
  return {
    scheduled: markerTracker?.scheduled?.length || 0,
    observedScheduled: (markerTracker?.scheduled || []).filter((marker) => marker.observed).length,
    markerCount: markerEvents.length,
    parseErrors: markerTracker?.parseErrors || 0,
    missing,
  };
}

/**
 * テキストファイルを同一ディレクトリ内の一時ファイル経由で置換する。
 *
 * 【詳細説明】
 * - capture 成功時の正式 fixture 更新で、途中失敗時に壊れた部分ファイルを残しにくくする。
 * - 置換対象ファイル以外の notes.md や photos/ などの付随ファイルには一切触れない。
 *
 * @function writeTextFileAtomically
 * @param {string} filePath - 置換するファイルパス
 * @param {string} text - 書き込むテキスト
 * @returns {Promise<void>} 書き込み完了
 * @throws {Error} 一時ファイル作成または rename に失敗した場合
 * @example
 * await writeTextFileAtomically("tests/fixtures/printers/k2-pro-cfs/capture.json", "{}\n");
 */
export async function writeTextFileAtomically(filePath, text) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(dir, `.${base}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(tempPath, text, "utf8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

/**
 * fixture 3ファイルを指定ディレクトリへ書き込む。
 *
 * 【詳細説明】
 * - metadata.json / capture.json / events.ndjson を同じ fixture オブジェクトから生成し、
 *   3ファイルが相互に同じ内容を指す状態を保つ。
 *
 * @function writeProtocolFixtureFiles
 * @param {string} outDir - 書き込み先ディレクトリ
 * @param {Object} fixture - ProtocolRecorder が export した fixture
 * @param {Object=} options - 書き込みオプション
 * @param {boolean=} options.atomic - 3ファイルを一時ファイル経由で置換する場合 true
 * @returns {Promise<void>} 書き込み完了
 * @throws {Error} ディレクトリ作成またはファイル書き込みに失敗した場合
 * @example
 * await writeProtocolFixtureFiles("tests/fixtures/printers/k2-pro-cfs", fixture);
 */
export async function writeProtocolFixtureFiles(outDir, fixture, options = {}) {
  const metadata = fixture.metadata;
  await fs.mkdir(outDir, { recursive: true });
  const files = [
    ["metadata.json", `${JSON.stringify(metadata, null, 2)}\n`],
    ["capture.json", `${JSON.stringify(fixture, null, 2)}\n`],
    ["events.ndjson", toFixtureNdjson(fixture.events)],
  ];
  for (const [fileName, text] of files) {
    const filePath = path.join(outDir, fileName);
    if (options.atomic) {
      await writeTextFileAtomically(filePath, text);
    } else {
      await fs.writeFile(filePath, text, "utf8");
    }
  }
}

/**
 * 成功した capture fixture の3ファイルだけを正式出力先へ置換する。
 *
 * 【詳細説明】
 * - require 条件に失敗した capture は正式 fixture を上書きしない。
 * - 成功時でも notes.md や photos/ などの付随ファイルは残し、capture 由来の3ファイルだけを置換する。
 *
 * @function replaceProtocolFixtureDirectory
 * @param {string} outDir - 正式 fixture ディレクトリ
 * @param {Object} fixture - 書き込む fixture
 * @returns {Promise<string>} 書き込み済み正式ディレクトリ
 * @throws {Error} 書き込みまたは置換に失敗した場合
 * @example
 * await replaceProtocolFixtureDirectory("tests/fixtures/printers/k2-pro-cfs", fixture);
 */
export async function replaceProtocolFixtureDirectory(outDir, fixture) {
  await writeProtocolFixtureFiles(outDir, fixture, { atomic: true });
  return outDir;
}

/**
 * 失敗 capture を任意で退避する。
 *
 * 【詳細説明】
 * - 正式 fixture は成功 capture だけで更新し、失敗時の調査材料は tmp 配下へ分離する。
 *
 * @function writeFailedProtocolFixtureIfRequested
 * @param {Object} options - capture オプション
 * @param {Object} fixture - 失敗 capture fixture
 * @param {string} captureId - capture ID
 * @returns {Promise<string|null>} 退避先、または退避しない場合 null
 * @example
 * const failedOutDir = await writeFailedProtocolFixtureIfRequested(options, fixture, captureId);
 */
export async function writeFailedProtocolFixtureIfRequested(options, fixture, captureId) {
  if (!options.keepFailed) {
    return null;
  }
  const failedOutDir = path.resolve("tmp", "failed-captures", captureId);
  await writeProtocolFixtureFiles(failedOutDir, fixture);
  return failedOutDir;
}

/**
 * 実機通信をキャプチャして fixture ファイルへ保存する。
 *
 * 【詳細説明】
 * - 既定では /info と WebSocket 接続観測のみを行う。
 * - --send-boxsinfo が指定された場合だけ、CFS情報取得用の read-only request を送信する。
 *
 * @function captureProtocolFixture
 * @param {Object} options - capture オプション
 * @returns {Promise<Object>} 保存結果
 * @throws {Error} 出力先作成や保存に失敗した場合
 * @example
 * await captureProtocolFixture({ host: "192.168.54.151", outDir: "tests/fixtures/printers/k1-max/device-a" });
 */
export async function captureProtocolFixture(options) {
  const recorder = createProtocolRecorder();
  const errors = [];
  let httpObserved = false;
  let wsOpened = false;
  let boxsInfoObserved = false;
  let heartbeatAcked = false;
  let markerTimers = [];
  let interactiveMarkerReader = null;
  const markerTracker = createMarkerTracker(options.markerSchedule);
  const started = recorder.startSession({
    device: {
      model: options.model,
      attachment: options.attachment,
    },
    capture: {
      scenario: options.scenario,
      operatorNotes: options.notes,
    },
    endpoints: [
      {
        address: options.host,
        httpPort: options.httpPort,
        wsPort: options.wsPort,
      },
    ],
  });
  try {
    markerTimers = scheduleCaptureMarkers(recorder, options.markerSchedule, markerTracker);
    interactiveMarkerReader = attachInteractiveMarkerReader(recorder, options.interactiveMarkers, markerTracker);

    if (!options.skipHttp) {
      const infoUrl = `http://${options.host}:${options.httpPort}/info`;
      try {
        recorder.recordTransportEvent({ channel: "http-info", type: "request", details: { url: infoUrl } });
        const response = await fetchWithTimeout(infoUrl, 3000);
        const body = await readResponseBody(response);
        httpObserved = response.status >= 200 && response.status < 300;
        if (body.bodyKind === "json" && body.body && typeof body.body === "object") {
          recorder.mergeMetadata({
            device: {
              reportedModel: body.body.model || null,
              reportedHostname: body.body.hostname || body.body.deviceName || null,
              firmwareVersion: body.body.version || "unknown",
            },
          });
        }
        recorder.recordInbound("http-info", {
          status: response.status,
          statusText: response.statusText,
          ...body,
        });
      } catch (error) {
        errors.push({
          channel: "http-info",
          message: error instanceof Error ? error.message : String(error),
        });
        recorder.recordTransportEvent({
          channel: "http-info",
          type: "error",
          details: { message: error instanceof Error ? error.message : String(error) },
        });
      }
    }

    if (!options.skipWs) {
      const wsUrl = `ws://${options.host}:${options.wsPort}`;
      const ws = new WebSocket(wsUrl, { handshakeTimeout: 3000 });
      ws.on("open", () => {
        wsOpened = true;
        recorder.recordTransportEvent({ channel: "ws9999", type: "open", details: { url: wsUrl } });
        if (options.sendBoxsInfo) {
          const request = { method: "get", params: { boxsInfo: 1 } };
          recorder.recordOutbound("ws9999", request, { purpose: "read-only-boxsInfo-probe" });
          ws.send(JSON.stringify(request));
        }
      });
      ws.on("message", (data, isBinary) => {
        const payload = normalizeWsPayload(data, isBinary);
        recorder.recordInbound("ws9999", payload);
        boxsInfoObserved = boxsInfoObserved || payloadHasKey(payload, "boxsInfo");
        if (isHeartbeatPayload(payload) && ws.readyState === WebSocket.OPEN) {
          const ackPayload = { frameType: "text", bodyKind: "text", body: "ok" };
          recorder.recordOutbound("ws9999", ackPayload, { purpose: "heartbeat-ack" });
          ws.send("ok");
          heartbeatAcked = true;
        }
      });
      ws.on("close", (code, reason) => {
        recorder.recordTransportEvent({
          channel: "ws9999",
          type: "close",
          details: { code, reason: reason ? reason.toString("utf8") : "" },
        });
      });
      ws.on("error", (error) => {
        errors.push({
          channel: "ws9999",
          message: error instanceof Error ? error.message : String(error),
        });
        recorder.recordTransportEvent({
          channel: "ws9999",
          type: "error",
          details: { message: error instanceof Error ? error.message : String(error) },
        });
      });

      await sleep(options.durationMs);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      } else if (ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      }
      await sleep(100);
    }
    if (options.skipWs && (markerTimers.length > 0 || interactiveMarkerReader)) {
      await sleep(options.durationMs);
    }
  } finally {
    markerTimers.forEach((timer) => {
      clearTimeout(timer);
    });
    if (interactiveMarkerReader) {
      interactiveMarkerReader.close();
    }
  }
  recorder.stopSession();

  const fixture = recorder.exportFixture({ redact: true });
  const markerEvents = fixture.events.filter((event) => event.direction === "marker");
  const protocolEventCount = fixture.events.length - markerEvents.length;
  const markerValidation = summarizeMarkerValidation(markerTracker, markerEvents);
  const failureReasons = [];
  if (options.requireHttp && !httpObserved) failureReasons.push("required-http-not-observed");
  if (options.requireWs && !wsOpened) failureReasons.push("required-ws-not-opened");
  if (options.requireBoxsInfo && !boxsInfoObserved) failureReasons.push("required-boxsinfo-not-observed");
  if (markerValidation.missing.length > 0) failureReasons.push("required-marker-not-observed");
  if (fixture.events.length < options.minimumEvents) failureReasons.push("minimum-events-not-met");
  const success = failureReasons.length === 0;
  fixture.metadata.validation = {
    success,
    failureReasons,
    eventCount: fixture.events.length,
    protocolEventCount,
    markerCount: markerEvents.length,
    required: {
      http: Boolean(options.requireHttp),
      ws: Boolean(options.requireWs),
      boxsInfo: Boolean(options.requireBoxsInfo),
      minimumEvents: options.minimumEvents,
      scheduledMarkers: markerTracker.scheduled.length,
    },
    observations: {
      httpObserved,
      wsOpened,
      boxsInfoObserved,
      heartbeatAcked,
      errorCount: errors.length,
    },
    markers: markerValidation,
  };
  const failedOutDir = success
    ? null
    : await writeFailedProtocolFixtureIfRequested(options, fixture, started.captureId);
  const writtenOutDir = success
    ? await replaceProtocolFixtureDirectory(options.outDir, fixture)
    : null;

  return {
    captureId: started.captureId,
    outDir: options.outDir,
    writtenOutDir,
    failedOutDir,
    eventCount: fixture.events.length,
    protocolEventCount,
    markerCount: markerEvents.length,
    success,
    failureReasons,
    observations: {
      httpObserved,
      wsOpened,
      boxsInfoObserved,
      heartbeatAcked,
      errors,
    },
    markers: markerValidation,
  };
}

/**
 * CLI エントリポイント。
 *
 * 【詳細説明】
 * - エラー時は stderr に理由を表示し、非ゼロ終了する。
 *
 * @function main
 * @returns {Promise<void>} CLI 完了
 * @example
 * await main();
 */
export async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(HELP_TEXT);
      return;
    }
    const result = await captureProtocolFixture(options);
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(HELP_TEXT);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
