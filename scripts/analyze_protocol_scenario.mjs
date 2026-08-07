/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Protocol Scenario Analyzer CLI
 * @file analyze_protocol_scenario.mjs
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module analyze_protocol_scenario
 *
 * 【機能内容サマリ】
 * - ProtocolRecorder fixture directory を読み込み scenario report を出力
 * - 必須 marker / payload key / capture validation を CLI から検査
 * - K2 Pro Combo 物理状態 fixture の受け入れ前チェックに使う
 *
 * 【公開関数一覧】
 * - {@link parseArgs}：CLI 引数を解析
 * - {@link readScenarioFixture}：fixture directory から metadata/events を読み込む
 * - {@link analyzeProtocolScenarioFromCli}：CLI options で scenario fixture を解析
 * - {@link main}：CLI エントリポイント
 *
 * @version 1.390.1316 (PR #432)
 * @since   1.390.1314 (PR #432)
 * @lastModified 2026-08-08 08:19:49
 * -----------------------------------------------------------
 * @todo
 * - 標準 scenario profile を導入し、`--profile k2-printing` だけで必須条件を展開できるようにする
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeProtocolScenarioFixture } from "../3dp_lib/printer_core/dashboard_protocol_scenario_analyzer.js";

/**
 * CLI ヘルプテキスト。
 *
 * 【詳細説明】
 * - 実機へ接続せず、既存 fixture directory だけを読む offline analyzer であることを明示する。
 *
 * @constant {string}
 */
const HELP_TEXT = `Usage:
  node scripts/analyze_protocol_scenario.mjs --fixture tests/fixtures/printers/k2-pro-cfs/scenarios/printing --require-observed-marker observed-printing --require-payload-key printProgress

Options:
  --fixture <dir>              Required. Fixture directory containing metadata.json and events.ndjson.
  --expected-scenario <name>   Require metadata.capture.scenario to match.
  --require-validation-success Require metadata.validation.success === true.
  --require-marker <name>      Require a marker by name with any source. Repeatable.
  --require-observed-marker <name>
                               Require a stdin/operator-observed marker by name. Repeatable.
  --require-scheduled-marker <name>
                               Require a scheduled-cli marker by name. Repeatable.
  --require-payload-key <key>  Require a protocol payload key such as boxsInfo or printProgress. Repeatable.
  --pretty                    Print indented JSON.
  --help                      Show this help.
`;

/**
 * CLI 引数を解析する。
 *
 * 【詳細説明】
 * - 依存を増やさず、repeatable option だけを手動で処理する。
 *
 * @function parseArgs
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {object} 解析済み options
 * @throws {Error} 必須引数が不足している場合
 * @example
 * const options = parseArgs(["--fixture", "tests/fixtures/printers/k2-pro-cfs"]);
 */
export function parseArgs(argv) {
  const options = {
    fixtureDir: "",
    expectedScenario: "",
    requireValidationSuccess: false,
    requiredMarkers: [],
    requiredObservedMarkers: [],
    requiredScheduledMarkers: [],
    requiredPayloadKeys: [],
    pretty: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--pretty") {
      options.pretty = true;
      continue;
    }
    if (arg === "--require-validation-success") {
      options.requireValidationSuccess = true;
      continue;
    }
    if (arg === "--fixture") {
      options.fixtureDir = argv[++index] || "";
      continue;
    }
    if (arg === "--expected-scenario") {
      options.expectedScenario = argv[++index] || "";
      continue;
    }
    if (arg === "--require-marker") {
      options.requiredMarkers.push(argv[++index] || "");
      continue;
    }
    if (arg === "--require-observed-marker") {
      options.requiredObservedMarkers.push(argv[++index] || "");
      continue;
    }
    if (arg === "--require-scheduled-marker") {
      options.requiredScheduledMarkers.push(argv[++index] || "");
      continue;
    }
    if (arg === "--require-payload-key") {
      options.requiredPayloadKeys.push(argv[++index] || "");
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.help && !options.fixtureDir) {
    throw new Error("--fixture is required");
  }
  return options;
}

/**
 * NDJSON file を event 配列として読み込む。
 *
 * 【詳細説明】
 * - 空行は無視し、行単位 JSON として parse する。
 *
 * @private
 * @param {string} filePath - events.ndjson の path
 * @returns {Promise<Array<object>>} event 配列
 */
async function readNdjson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return text
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * fixture directory から metadata/events を読み込む。
 *
 * 【詳細説明】
 * - `capture.json` ではなく `metadata.json` と `events.ndjson` を直接読むことで、
 *   付随資料や capture wrapper に依存せず scenario evidence だけを検査する。
 *
 * @function readScenarioFixture
 * @param {string} fixtureDir - fixture directory
 * @returns {Promise<object>} metadata と events
 * @example
 * const fixture = await readScenarioFixture("tests/fixtures/printers/k2-pro-cfs");
 */
export async function readScenarioFixture(fixtureDir) {
  const root = path.resolve(fixtureDir);
  const metadata = JSON.parse(await fs.readFile(path.join(root, "metadata.json"), "utf8"));
  const events = await readNdjson(path.join(root, "events.ndjson"));
  return {
    metadata,
    events,
  };
}

/**
 * CLI options から scenario fixture を解析する。
 *
 * 【詳細説明】
 * - 戻り値は JSON にそのまま出力できる plain object に限定する。
 *
 * @function analyzeProtocolScenarioFromCli
 * @param {object} options - parseArgs の戻り値
 * @returns {Promise<object>} scenario report
 * @example
 * const report = await analyzeProtocolScenarioFromCli(options);
 */
export async function analyzeProtocolScenarioFromCli(options) {
  const fixture = await readScenarioFixture(options.fixtureDir);
  const anySourceMarkers = Array.isArray(options.requiredMarkers) ? options.requiredMarkers : [];
  const observedMarkers = Array.isArray(options.requiredObservedMarkers) ? options.requiredObservedMarkers : [];
  const scheduledMarkers = Array.isArray(options.requiredScheduledMarkers) ? options.requiredScheduledMarkers : [];
  const requiredMarkers = [
    ...anySourceMarkers,
    ...observedMarkers.map((name) => ({ name, source: "stdin" })),
    ...scheduledMarkers.map((name) => ({ name, source: "scheduled-cli" })),
  ];
  return analyzeProtocolScenarioFixture(fixture, {
    expectedScenario: options.expectedScenario || undefined,
    requireValidationSuccess: options.requireValidationSuccess,
    requiredMarkers,
    requiredPayloadKeys: options.requiredPayloadKeys,
  });
}

/**
 * CLI エントリポイント。
 *
 * 【詳細説明】
 * - report.success が false の場合は exit code 1 にして CI で検出できるようにする。
 *
 * @function main
 * @param {string[]=} argv - CLI 引数
 * @returns {Promise<number>} process exit code
 * @example
 * await main(process.argv.slice(2));
 */
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(HELP_TEXT);
    return 0;
  }
  const report = await analyzeProtocolScenarioFromCli(options);
  console.log(JSON.stringify(report, null, options.pretty ? 2 : 0));
  return report.success ? 0 : 1;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
