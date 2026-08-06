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
 * - {@link captureProtocolFixture}：実機通信をキャプチャして fixture を保存
 * - {@link main}：CLI エントリポイント
 *
 * @version 1.390.1290 (PR #432)
 * @since   1.390.1290 (PR #432)
 * @lastModified 2026-08-06 22:53:37
 * -----------------------------------------------------------
 * @todo
 * - Electron UI からのキャプチャ開始・停止操作を追加
 */

import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
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
  --notes <text>            Operator notes for metadata.
  --help                    Show this help.
`;

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

  if (!options.skipHttp) {
    const infoUrl = `http://${options.host}:${options.httpPort}/info`;
    try {
      recorder.recordTransportEvent({ channel: "http-info", type: "request", details: { url: infoUrl } });
      const response = await fetchWithTimeout(infoUrl, 3000);
      const body = await readResponseBody(response);
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
      recorder.recordTransportEvent({ channel: "ws9999", type: "open", details: { url: wsUrl } });
      if (options.sendBoxsInfo) {
        const request = { method: "get", params: { boxsInfo: 1 } };
        recorder.recordOutbound("ws9999", request, { purpose: "read-only-boxsInfo-probe" });
        ws.send(JSON.stringify(request));
      }
    });
    ws.on("message", (data, isBinary) => {
      recorder.recordInbound("ws9999", normalizeWsPayload(data, isBinary));
    });
    ws.on("close", (code, reason) => {
      recorder.recordTransportEvent({
        channel: "ws9999",
        type: "close",
        details: { code, reason: reason ? reason.toString("utf8") : "" },
      });
    });
    ws.on("error", (error) => {
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
  recorder.stopSession();

  const fixture = recorder.exportFixture({ redact: true });
  const metadata = fixture.metadata;
  await fs.mkdir(options.outDir, { recursive: true });
  await fs.writeFile(path.join(options.outDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(options.outDir, "capture.json"), `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(options.outDir, "events.ndjson"), toFixtureNdjson(fixture.events), "utf8");

  return {
    captureId: started.captureId,
    outDir: options.outDir,
    eventCount: fixture.events.length,
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
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(HELP_TEXT);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
