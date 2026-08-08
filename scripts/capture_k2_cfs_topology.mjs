/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 K2 CFS 物理トポロジ記録 CLI
 * @file capture_k2_cfs_topology.mjs
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module capture_k2_cfs_topology
 *
 * 【機能内容サマリ】
 * - Gate 10 の K2 Pro Combo + CFS 物理トポロジ検証 fixture を取得
 * - 汎用 Protocol Recorder を read-only `boxsInfo` probe 付きの安全な既定値で呼び出す
 * - 操作者 marker を同一 WS session の時系列へ残し、offline Analyzer で検証しやすくする
 *
 * 【公開関数一覧】
 * - {@link parseArgs}：CLI 引数を解析
 * - {@link buildK2CfsTopologyCaptureOptions}：汎用 capture option へ変換
 * - {@link captureK2CfsTopology}：Gate 10 fixture を取得
 * - {@link main}：CLI エントリポイント
 *
 * @version 1.390.1326 (PR #432)
 * @since   1.390.1326 (PR #432)
 * @lastModified 2026-08-08 20:04:39
 * -----------------------------------------------------------
 * @todo
 * - Gate 10 実機 fixture 取得後、観測された marker timing の推奨例を docs へ追記する
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureProtocolFixture,
  parseMarkerScheduleItem,
} from "./capture_protocol_fixture.mjs";

/**
 * Gate 10 で必要な operator marker 名。
 *
 * 【詳細説明】
 * - marker 名は `k2-cfs-topology` profile の requiredMarkers と揃える。
 * - 実際の物理操作は操作者が行い、この CLI は read-only 通信観測と marker 記録だけを担当する。
 *
 * @constant {string[]}
 */
export const REQUIRED_GATE10_MARKERS = Object.freeze([
  "observed-cfs-connected",
  "operator-cfs-disconnect",
  "observed-cfs-disconnected",
  "operator-cfs-reconnect",
  "observed-cfs-reconnected",
  "observed-slot-change",
  "observed-material-change",
  "observed-external-spool",
  "observed-color-assignment-change",
]);

/**
 * CLI ヘルプテキスト。
 *
 * 【詳細説明】
 * - Gate 10 の fixture 取得に必要な read-only option を既定化するため、通常は host/out/duration だけ指定する。
 *
 * @constant {string}
 */
const HELP_TEXT = `Usage:
  node scripts/capture_k2_cfs_topology.mjs --host 192.168.54.21 --out tests/fixtures/printers/k2-pro-cfs/scenarios/cfs-topology --duration-ms 900000

Options:
  --host <ip-or-host>       Required. K2 Pro Combo host or IP address.
  --out <dir>               Required. Output fixture directory.
  --duration-ms <number>    Observation duration. Default: 900000.
  --ws-port <number>        WebSocket port. Default: 9999.
  --http-port <number>      HTTP port. Default: 80.
  --minimum-events <number> Minimum required events. Default: 20.
  --marker-at <ms:name[:json-details]>
                            Optional scheduled marker. Repeatable.
  --no-interactive-markers  Disable stdin markers. Interactive markers are enabled by default.
  --no-keep-failed          Do not keep failed captures under tmp/failed-captures.
  --notes <text>            Operator notes for metadata.
  --help                    Show this help.

Required interactive markers:
  ${REQUIRED_GATE10_MARKERS.join("\n  ")}
`;

/**
 * CLI 引数を解析する。
 *
 * 【詳細説明】
 * - この CLI は command authority を持たないため、プリンタ制御 option は受け取らない。
 * - `--marker-at` は汎用 recorder と同じ形式をそのまま使い、stdin marker と併用できる。
 *
 * @function parseArgs
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {Object} 解析済みオプション
 * @throws {Error} 必須引数または数値引数が不正な場合
 * @example
 * const options = parseArgs(["--host", "192.168.54.21", "--out", "tmp/cfs"]);
 */
export function parseArgs(argv) {
  const options = {
    durationMs: 900000,
    wsPort: 9999,
    httpPort: 80,
    minimumEvents: 20,
    markerSchedule: [],
    interactiveMarkers: true,
    keepFailed: true,
    notes: "Gate 10 K2 Pro Combo CFS physical topology",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--no-interactive-markers") {
      options.interactiveMarkers = false;
      continue;
    }
    if (arg === "--no-keep-failed") {
      options.keepFailed = false;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    index += 1;
    if (arg === "--host") options.host = next;
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
  if (!Number.isFinite(options.durationMs) || options.durationMs < 10000) {
    throw new Error("--duration-ms must be a number >= 10000");
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
 * Gate 10 専用 option を汎用 Protocol Recorder option へ変換する。
 *
 * 【詳細説明】
 * - K2 Pro Combo + CFS の固定 metadata と read-only 検証条件をここで付与する。
 * - `sendBoxsInfo` だけを true にし、印刷開始・停止・CFS制御などの command は一切含めない。
 *
 * @function buildK2CfsTopologyCaptureOptions
 * @param {Object} options - Gate 10 CLI option
 * @returns {Object} captureProtocolFixture に渡す option
 * @example
 * const captureOptions = buildK2CfsTopologyCaptureOptions({ host: "192.168.54.21", outDir: "tmp/cfs" });
 */
export function buildK2CfsTopologyCaptureOptions(options) {
  return {
    host: options.host,
    outDir: options.outDir,
    durationMs: options.durationMs,
    wsPort: options.wsPort,
    httpPort: options.httpPort,
    minimumEvents: options.minimumEvents,
    markerSchedule: options.markerSchedule,
    interactiveMarkers: options.interactiveMarkers,
    keepFailed: options.keepFailed,
    model: "K2 Pro Combo",
    attachment: "CFS",
    scenario: "k2-cfs-topology-validation",
    notes: options.notes,
    sendBoxsInfo: true,
    skipHttp: false,
    skipWs: false,
    requireHttp: true,
    requireWs: true,
    requireBoxsInfo: true,
  };
}

/**
 * Gate 10 K2 CFS topology fixture を取得する。
 *
 * 【詳細説明】
 * - 汎用 recorder の戻り値に Analyzer 実行コマンドを付与し、capture 後の確認作業を明示する。
 *
 * @function captureK2CfsTopology
 * @param {Object} options - Gate 10 CLI option
 * @returns {Promise<Object>} capture 結果
 * @throws {Error} 接続または保存に失敗した場合
 * @example
 * const result = await captureK2CfsTopology({ host: "192.168.54.21", outDir: "tmp/cfs" });
 */
export async function captureK2CfsTopology(options) {
  const captureOptions = buildK2CfsTopologyCaptureOptions(options);
  const result = await captureProtocolFixture(captureOptions);
  return {
    ...result,
    analyzerCommand: [
      "node",
      "scripts/analyze_protocol_scenario.mjs",
      "--fixture",
      options.outDir,
      "--profile",
      "k2-cfs-topology",
      "--pretty",
    ].join(" "),
  };
}

/**
 * CLI エントリポイント。
 *
 * 【詳細説明】
 * - 結果 summary を JSON で stdout へ出力し、validation 失敗時は非ゼロ終了する。
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
    const result = await captureK2CfsTopology(options);
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
