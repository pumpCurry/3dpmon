#!/usr/bin/env node
/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 K2 CFS print-start certification CLI
 * @file capture_k2_cfs_print_start.mjs
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module capture_k2_cfs_print_start
 *
 * 【機能内容サマリ】
 * - Gate20 K2/CFS command transport plan をCLIからdry-run確認する
 * - `--send` が明示された場合だけWS9999へ `colorMatch` -> `multiColorPrint` を送る
 * - live certification前にassignmentと送信frameをJSONで確認できるようにする
 *
 * 【公開関数一覧】
 * - {@link parseArgs}：CLI引数を解析
 * - {@link parseToolAssignmentOption}：assignment指定を解析
 * - {@link buildK2CfsPrintStartRequest}：transport plan用requestを生成
 * - {@link runK2CfsPrintStartCertification}：dry-runまたは明示送信を実行
 *
 * @version 1.390.1386 (PR #432)
 * @since   1.390.1385 (PR #432)
 * @lastModified 2026-08-26 00:40:00
 * -----------------------------------------------------------
 * @todo
 * - 実機Gateでpost-start boxsInfo probeとscenario fixture保存を統合する
 */

import { WebSocket } from "ws";
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
  node scripts/capture_k2_cfs_print_start.mjs --host <ip> --file-path <printer-local-gcode> --assignment <alias,sourceId,type,color> [--assignment ...]

Examples:
  node scripts/capture_k2_cfs_print_start.mjs --host 192.168.54.21 --file-path /mnt/UDISK/printer_data/gcodes/benchy.gcode --assignment T1A,cfs:1:slot:2,PLA,09ea7ae

Options:
  --host <ip-or-host>             K2 host. Required only when --send is used.
  --ws-port <number>              WebSocket port. Default: 9999.
  --file-path <path>              Printer-local G-code path. Required.
  --assignment <a,s,t,c>          Tool alias, material source id, material type, color. Repeatable.
  --enable-self-test <0|1>        K2 enableSelfTest value. Default: 0.
  --send                          Actually send frames to the printer. Default is dry-run.
  --pretty                        Pretty-print JSON result.
  --help                          Show this help.
`;

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
 * - `--assignment` は複数指定を許可する。
 * - 送信系の既定値は必ずdry-runにし、実機送信は `--send` だけで開く。
 *
 * @function parseArgs
 * @param {string[]} argv - `process.argv.slice(2)` 相当
 * @returns {object} 解析済みオプション
 * @example
 * const options = parseArgs(["--file-path", "/tmp/a.gcode", "--assignment", "T1A,cfs:1:slot:0,PLA,ffffff"]);
 */
export function parseArgs(argv = []) {
  const options = {
    host: "",
    wsPort: 9999,
    filePath: "",
    assignments: [],
    enableSelfTest: 0,
    send: false,
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
    else if (arg === "--file-path") options.filePath = next();
    else if (arg === "--assignment") options.assignments.push(parseToolAssignmentOption(next()));
    else if (arg === "--enable-self-test") options.enableSelfTest = Number(next());
    else if (arg === "--send") options.send = true;
    else if (arg === "--pretty") options.pretty = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.wsPort) || options.wsPort <= 0 || options.wsPort > 65535) {
    throw new Error("--ws-port must be a valid TCP port.");
  }
  if (![0, 1].includes(options.enableSelfTest)) {
    throw new Error("--enable-self-test must be 0 or 1.");
  }
  if (!options.help && !toNonEmptyString(options.filePath)) {
    throw new Error("--file-path is required.");
  }
  if (!options.help && options.assignments.length === 0) {
    throw new Error("At least one --assignment is required.");
  }
  if (options.send && !toNonEmptyString(options.host)) {
    throw new Error("--host is required when --send is used.");
  }
  return options;
}

/**
 * assignment指定を解析する。
 *
 * 【詳細説明】
 * - 形式は `alias,sourceId,type,color` に限定する。
 * - sourceIdは transport module 側で `cfs:<box>:slot:<slot>` として再検証する。
 *
 * @function parseToolAssignmentOption
 * @param {string} value - assignment指定文字列
 * @returns {object} tool assignment
 * @example
 * const assignment = parseToolAssignmentOption("T1C,cfs:1:slot:2,PLA,09ea7ae");
 */
export function parseToolAssignmentOption(value) {
  const parts = String(value || "").split(",").map((part) => part.trim());
  if (parts.length !== 4 || parts.some((part) => !part)) {
    throw new Error("--assignment must be alias,sourceId,type,color.");
  }
  return {
    protocolToolAlias: parts[0],
    materialSourceId: parts[1],
    protocol: {
      type: parts[2],
      color: parts[3].replace(/^#/u, ""),
    },
  };
}

/**
 * transport plan用のprint-start requestを生成する。
 *
 * 【詳細説明】
 * - 実PrintPlan authorityが発行するrequestとは別に、live certification用の最小shapeを作る。
 * - command authority本体へは通さず、transport mapping確認に限定する。
 *
 * @function buildK2CfsPrintStartRequest
 * @param {object} options - CLIオプション
 * @returns {object} Printer Core command request風object
 * @example
 * const request = buildK2CfsPrintStartRequest(options);
 */
export function buildK2CfsPrintStartRequest(options) {
  return {
    commandKind: "print-start",
    transportKind: "ws9999",
    payload: {
      printPlanId: `live-certification:${Date.now()}`,
      planKind: options.assignments.length > 1 ? "multicolor-cfs" : "single-color",
      asset: {
        path: options.filePath,
      },
      toolAssignments: options.assignments.map((assignment, index) => ({
        toolId: index,
        ...assignment,
      })),
      startOptions: {
        enableSelfTest: options.enableSelfTest,
      },
    },
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
 * WebSocketへ1frameを書き込み、library callback完了を待つ。
 *
 * 【詳細説明】
 * - `ws.send()` はcallbackを待たないと、bufferへ渡す前にCLI結果が成功扱いになる可能性がある。
 * - これはプリンタのprotocol ackではなく、ローカルtransport submitの証跡だけを意味する。
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
 * K2/CFS print-start certificationを実行する。
 *
 * 【詳細説明】
 * - dry-runではtransport planだけを返し、WSへ接続しない。
 * - `send:true` のときだけWebSocketへ接続し、frameを順序通りに送る。
 *
 * @function runK2CfsPrintStartCertification
 * @param {object} options - parseArgs済みオプション
 * @param {Function=} options.openWs - テスト用WebSocket factory override
 * @returns {Promise<object>} 実行結果
 * @example
 * const result = await runK2CfsPrintStartCertification(options);
 */
export async function runK2CfsPrintStartCertification(options) {
  const request = buildK2CfsPrintStartRequest(options);
  const plan = createK2CfsCommandTransportPlan(request);
  if (!plan.ok) {
    return {
      ok: false,
      sent: false,
      request,
      plan,
    };
  }
  if (!options.send) {
    return {
      ok: true,
      sent: false,
      dryRun: true,
      request,
      plan,
    };
  }
  const ws = await (options.openWs || openWs)(options.host, options.wsPort);
  try {
    const response = await sendK2CfsCommandTransportPlan(plan, async (frame) => {
      return sendWsFrameAndWait(ws, frame);
    });
    return {
      ok: true,
      sent: true,
      dryRun: false,
      request,
      plan,
      response,
    };
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
    const result = await runK2CfsPrintStartCertification(options);
    console.log(JSON.stringify(result, null, options.pretty ? 2 : 0));
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(error?.message || String(error));
    console.error(USAGE.trim());
    process.exit(1);
  }
}
