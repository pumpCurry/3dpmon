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
 *
 * 【公開関数一覧】
 * - {@link parseArgs}：CLI引数を解析
 * - {@link buildK2CfsSlotControlRequest}：transport plan用requestを生成
 * - {@link runK2CfsSlotControlCertification}：dry-runまたは明示送信を実行
 *
 * @version 1.390.1415 (PR #435)
 * @since   1.390.1415 (PR #435)
 * @lastModified 2026-08-27 05:32:29
 * -----------------------------------------------------------
 * @todo
 * - 実機Gateでpost-command boxsInfo probeとscenario fixture保存を統合する
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
    else if (arg === "--pretty") options.pretty = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.wsPort) || options.wsPort <= 0 || options.wsPort > 65535) {
    throw new Error("--ws-port must be a valid TCP port.");
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
 * K2/CFS slot control certificationを実行する。
 *
 * 【詳細説明】
 * - dry-runではtransport planだけを返し、WSへ接続しない。
 * - `send:true` のときだけWebSocketへ接続し、certification-only planの送信を明示許可する。
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
    }, {
      allowCertificationOnly: true,
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
    const result = await runK2CfsSlotControlCertification(options);
    console.log(JSON.stringify(result, null, options.pretty ? 2 : 0));
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(error?.message || String(error));
    console.error(USAGE.trim());
    process.exit(1);
  }
}
