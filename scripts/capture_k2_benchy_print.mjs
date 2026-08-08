/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 K2 Benchy 印刷ライフサイクル記録 CLI
 * @file capture_k2_benchy_print.mjs
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module capture_k2_benchy_print
 *
 * 【機能内容サマリ】
 * - K2 Pro Combo + CFS のローカル G-code 一覧と CFS 状態を取得
 * - Benchy 候補を選択し、明示許可がある場合だけ印刷開始 command を1回だけ送信
 * - 印刷開始から完了までの WS9999 状態遷移を ProtocolRecorder fixture として保存
 *
 * 【公開関数一覧】
 * - {@link parseArgs}：CLI 引数を解析
 * - {@link normalizeK2GcodeFiles}：K2 file list payload を配列へ正規化
 * - {@link isCfsAttachmentLabel}：attachment label が CFS 系か判定
 * - {@link hasObservedCfsUnit}：boxsInfo に CFS unit が含まれるか判定
 * - {@link shouldBlockUnsafeOpgcodeFileCfsStart}：CFS の unsafe `opGcodeFile` 開始をブロックするか判定
 * - {@link selectK2GcodeFile}：印刷対象の G-code を選択
 * - {@link summarizeK2ToolSource}：CFS tool alias に対応する材料 source を要約
 * - {@link captureK2BenchyPrint}：実機印刷と通信キャプチャを実行
 * - {@link main}：CLI エントリポイント
 *
 * @version 1.390.1328 (PR #432)
 * @since   1.390.1323 (PR #432)
 * @lastModified 2026-08-08 20:55:33
 * -----------------------------------------------------------
 * @todo
 * - K2 の公式 tool assignment 付き印刷 command が確定したら、slot override を dry-run PrintPlan 経由へ移す
 * - `opGcodeFile` 単独開始は CFS selected source を作らない negative evidence 再現時だけ許可する
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  createProtocolRecorder,
  redactProtocolValue,
} from "../3dp_lib/printer_core/dashboard_protocol_recorder.js";
import {
  fetchWithTimeout,
  isHeartbeatPayload,
  normalizeWsPayload,
  readResponseBody,
  sleep,
  writeProtocolFixtureFiles,
} from "./capture_protocol_fixture.mjs";

/**
 * CLI ヘルプテキスト。
 *
 * 【詳細説明】
 * - この CLI は明示的に印刷開始 command を送るため、既定値でも出力先と host を必須にする。
 *
 * @constant {string}
 */
const HELP_TEXT = `Usage:
  node scripts/capture_k2_benchy_print.mjs --host 192.168.54.21 --out tests/fixtures/printers/k2-pro-cfs/scenarios/benchy-print-command

Options:
  --host <ip-or-host>             Required. K2 Pro Combo host or IP address.
  --out <dir>                     Output fixture directory for successful capture.
  --file-contains <text>          G-code name/path substring. Default: bench.
  --file-path <path>              Exact printer-local G-code path. Skips automatic selection when provided.
  --preferred-tool <alias>        Expected CFS tool alias to summarize, e.g. T1C. Default: T1C.
  --scenario <name>               Capture scenario label. Default: k2-benchy-print-command.
  --model <name>                  Device model label. Default: K2 Pro Combo.
  --attachment <name>             Attachment label. Default: CFS.
  --ws-port <number>              WebSocket port. Default: 9999.
  --http-port <number>            HTTP port. Default: 80.
  --max-duration-ms <number>      Maximum observation window. Default: 2700000.
  --poll-ms <number>              Periodic read-only probe interval. Default: 60000.
  --keep-failed                   Write failed captures under tmp/failed-captures.
  --allow-mismatched-tool         Continue when selected file match does not target --preferred-tool.
  --allow-unsafe-opgcodefile-cfs-start
                                  Send opGcodeFile even when attachment is CFS. For negative evidence only.
  --notes <text>                  Operator notes for metadata.
  --help                          Show this help.
`;

/**
 * CLI 引数を解析する。
 *
 * 【詳細説明】
 * - destructive な delete/rename/stop 系 command は扱わず、印刷開始 command に必要な最小引数だけを受け取る。
 *
 * @function parseArgs
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {Object} 解析済みオプション
 * @throws {Error} 必須引数または数値引数が不正な場合
 * @example
 * const options = parseArgs(["--host", "192.168.54.21", "--out", "tmp/capture"]);
 */
export function parseArgs(argv) {
  const options = {
    fileContains: "bench",
    filePath: "",
    preferredTool: "T1C",
    scenario: "k2-benchy-print-command",
    model: "K2 Pro Combo",
    attachment: "CFS",
    wsPort: 9999,
    httpPort: 80,
    maxDurationMs: 2700000,
    pollMs: 60000,
    keepFailed: false,
    allowMismatchedTool: false,
    allowUnsafeOpgcodeFileCfsStart: false,
    notes: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--keep-failed") {
      options.keepFailed = true;
      continue;
    }
    if (arg === "--allow-mismatched-tool") {
      options.allowMismatchedTool = true;
      continue;
    }
    if (arg === "--allow-unsafe-opgcodefile-cfs-start") {
      options.allowUnsafeOpgcodeFileCfsStart = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    index += 1;
    if (arg === "--host") options.host = next;
    else if (arg === "--out") options.outDir = next;
    else if (arg === "--file-contains") options.fileContains = next;
    else if (arg === "--file-path") options.filePath = next;
    else if (arg === "--preferred-tool") options.preferredTool = next;
    else if (arg === "--scenario") options.scenario = next;
    else if (arg === "--model") options.model = next;
    else if (arg === "--attachment") options.attachment = next;
    else if (arg === "--ws-port") options.wsPort = Number(next);
    else if (arg === "--http-port") options.httpPort = Number(next);
    else if (arg === "--max-duration-ms") options.maxDurationMs = Number(next);
    else if (arg === "--poll-ms") options.pollMs = Number(next);
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
  if (!Number.isFinite(options.wsPort) || options.wsPort <= 0) {
    throw new Error("--ws-port must be a positive number");
  }
  if (!Number.isFinite(options.httpPort) || options.httpPort <= 0) {
    throw new Error("--http-port must be a positive number");
  }
  if (!Number.isFinite(options.maxDurationMs) || options.maxDurationMs < 10000) {
    throw new Error("--max-duration-ms must be a number >= 10000");
  }
  if (!Number.isFinite(options.pollMs) || options.pollMs < 5000) {
    throw new Error("--poll-ms must be a number >= 5000");
  }
  return options;
}

/**
 * attachment 名が CFS 系を示すか判定する。
 *
 * 【詳細説明】
 * - Gate 9.5 で `opGcodeFile` 単独開始が CFS slot を選択しないまま印刷状態だけ進めることを確認した。
 * - 実行系の安全境界では CFS / CFS-C / CFS_C / K1_CFS-C / Combo などの表記ゆれを CFS 系として扱い、
 *   外部リール専用の再現実験と区別する。
 *
 * @function isCfsAttachmentLabel
 * @param {string|null|undefined} attachment - metadata に記録する attachment label
 * @returns {boolean} CFS 系 attachment と見なす場合 true
 * @example
 * const isCfs = isCfsAttachmentLabel("CFS");
 */
export function isCfsAttachmentLabel(attachment) {
  const normalized = String(attachment || "").trim().toLowerCase();
  if (!normalized ||
      normalized === "none" ||
      normalized === "external" ||
      normalized === "external-spool" ||
      normalized === "external spool") {
    return false;
  }
  return /(^|[^a-z0-9])cfs([^a-z0-9]|$)/i.test(normalized) ||
    /(^|[^a-z0-9])combo([^a-z0-9]|$)/i.test(normalized);
}

/**
 * protocol index を安全側で非負整数へ変換する。
 *
 * 【詳細説明】
 * - 実機 payload の `type` は数値または数字文字列として観測される可能性がある。
 * - false / 空白 / 配列などを JavaScript の暗黙変換で 0 扱いすると CFS 誤検出になるため、
 *   number と数字だけの string 以外は不正値として扱う。
 *
 * @private
 * @param {*} value - protocol index 値
 * @returns {number|null} 非負整数、または不正値の場合 null
 * @example
 * const index = toProtocolIndex("0");
 */
function toProtocolIndex(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^\d+$/.test(text)) {
      return null;
    }
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * `boxsInfo` に CFS unit が観測されているか判定する。
 *
 * 【詳細説明】
 * - `--attachment` は操作者の自己申告なので、安全境界では実機の read-only evidence も見る。
 * - F012 実機では external spool が `type=1`、CFS unit が `type=0` として観測されるため、
 *   malformed type を暗黙変換せず `type=0` の box だけを CFS unit とする。
 *
 * @function hasObservedCfsUnit
 * @param {Object|null|undefined} boxsInfo - K2 `boxsInfo` payload
 * @returns {boolean} CFS unit を観測した場合 true
 * @example
 * const hasCfs = hasObservedCfsUnit({ materialBoxs: [{ type: 0, materials: [] }] });
 */
export function hasObservedCfsUnit(boxsInfo) {
  const boxes = Array.isArray(boxsInfo?.materialBoxs) ? boxsInfo.materialBoxs : [];
  return boxes.some((box) => toProtocolIndex(box?.type) === 0);
}

/**
 * `opGcodeFile` 単独開始を CFS 対象でブロックすべきか判定する。
 *
 * 【詳細説明】
 * - `opGcodeFile` は K2 の状態遷移 evidence を得るには有用だが、CFS の `selected` evidence を伴わない。
 * - CFS 対象では明示フラグなしに送信せず、negative evidence の再現や外部リール検証だけを意図的に許可する。
 * - 判定は attachment label だけに依存せず、取得済み `boxsInfo` に CFS unit がある場合もブロックする。
 *
 * @function shouldBlockUnsafeOpgcodeFileCfsStart
 * @param {Object} options - capture オプション
 * @param {string=} options.attachment - attachment label
 * @param {Object|null|undefined=} options.boxsInfo - 取得済み K2 `boxsInfo`
 * @param {boolean=} options.allowUnsafeOpgcodeFileCfsStart - 明示許可フラグ
 * @returns {boolean} 送信をブロックすべき場合 true
 * @example
 * const blocked = shouldBlockUnsafeOpgcodeFileCfsStart({ attachment: "CFS" });
 */
export function shouldBlockUnsafeOpgcodeFileCfsStart(options) {
  const cfsTarget = isCfsAttachmentLabel(options?.attachment) || hasObservedCfsUnit(options?.boxsInfo);
  return cfsTarget && !options?.allowUnsafeOpgcodeFileCfsStart;
}

/**
 * K2 file list payload を配列へ正規化する。
 *
 * 【詳細説明】
 * - K2 Pro Combo 実機は `retGcodeFileInfo2` を配列で返す。
 * - 旧 K1 互換の `retGcodeFileInfo` 文字列はここでは解釈せず、配列または entries 形だけを安全に扱う。
 *
 * @function normalizeK2GcodeFiles
 * @param {Object|null|undefined} payload - WS9999 受信 payload
 * @returns {Object[]} 正規化した G-code file entry 配列
 * @example
 * const files = normalizeK2GcodeFiles({ retGcodeFileInfo2: [{ name: "3DBench.gcode" }] });
 */
export function normalizeK2GcodeFiles(payload) {
  if (Array.isArray(payload?.retGcodeFileInfo2)) {
    return payload.retGcodeFileInfo2.map((entry) => ({ ...entry }));
  }
  if (Array.isArray(payload?.retGcodeFileInfo)) {
    return payload.retGcodeFileInfo.map((entry) => ({ ...entry }));
  }
  if (Array.isArray(payload?.entries)) {
    return payload.entries.map((entry) => ({ ...entry }));
  }
  return [];
}

/**
 * material 文字列を tool 数として数える。
 *
 * 【詳細説明】
 * - `PLA;PLA;PLA;PLA` のような複数 tool file と `PLA` の単色 file を区別する。
 *
 * @private
 * @param {string|null|undefined} material - file entry の material 文字列
 * @returns {number} 推定 tool 数
 */
function countMaterialTools(material) {
  const parts = String(material || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  return Math.max(1, parts.length);
}

/**
 * 印刷対象の K2 G-code entry を選択する。
 *
 * 【詳細説明】
 * - 明示 path がある場合は完全一致を優先する。
 * - 自動選択では name/path に substring を含む候補を探し、単色 file を優先する。
 *
 * @function selectK2GcodeFile
 * @param {Object[]} files - G-code file entry 配列
 * @param {Object=} options - 選択オプション
 * @param {string=} options.filePath - 完全一致させる printer-local path
 * @param {string=} options.fileContains - name/path に含める文字列
 * @returns {Object|null} 選択した file entry、見つからない場合 null
 * @example
 * const file = selectK2GcodeFile(files, { fileContains: "bench" });
 */
export function selectK2GcodeFile(files, options = {}) {
  const list = Array.isArray(files) ? files : [];
  const exactPath = String(options.filePath || "").trim();
  if (exactPath) {
    return list.find((entry) => String(entry?.path || entry?.filename || "") === exactPath) || null;
  }

  const needle = String(options.fileContains || "bench").toLowerCase();
  const candidates = list.filter((entry) => {
    const name = `${entry?.name || ""} ${entry?.path || ""} ${entry?.filename || ""}`.toLowerCase();
    return name.includes(needle);
  });
  if (candidates.length === 0) {
    return null;
  }

  const withScore = candidates.map((entry, index) => {
    const materialToolCount = countMaterialTools(entry?.material);
    const name = String(entry?.name || entry?.path || entry?.filename || "").toLowerCase();
    const multiPenalty = name.includes("4color") || name.includes("multi") ? 10 : 0;
    return {
      entry,
      index,
      score: materialToolCount + multiPenalty,
    };
  });
  withScore.sort((left, right) => left.score - right.score || left.index - right.index);
  return withScore[0].entry;
}

/**
 * `match` 文字列から指定 tool の割当先を抽出する。
 *
 * 【詳細説明】
 * - K2 file list は `T1A=T1B` のように file tool と CFS tool の対応を文字列で返す。
 *
 * @function extractMatchedTool
 * @param {Object|null|undefined} fileEntry - G-code file entry
 * @param {string} fileTool - file 側 tool alias
 * @returns {string|null} CFS 側 tool alias、見つからない場合 null
 * @example
 * const target = extractMatchedTool({ match: "T1A=T1B " }, "T1A");
 */
export function extractMatchedTool(fileEntry, fileTool) {
  const matchText = String(fileEntry?.match || "");
  const wanted = String(fileTool || "").trim();
  if (!wanted) {
    return null;
  }
  const parts = matchText.split(/\s+/).filter(Boolean);
  for (const part of parts) {
    const [left, right] = part.split("=");
    if (left === wanted && right) {
      return right;
    }
  }
  return null;
}

/**
 * CFS tool alias に対応する材料 source を要約する。
 *
 * 【詳細説明】
 * - `boxsInfo.colorMatch` で alias から box/material id を引き、`materialBoxs[].materials[]` から色や残量を拾う。
 *
 * @function summarizeK2ToolSource
 * @param {Object|null|undefined} boxsInfo - K2 `boxsInfo` payload
 * @param {string} toolAlias - `T1C` などの tool alias
 * @returns {Object|null} source summary、見つからない場合 null
 * @example
 * const source = summarizeK2ToolSource(boxsInfo, "T1C");
 */
export function summarizeK2ToolSource(boxsInfo, toolAlias) {
  const assignments = Array.isArray(boxsInfo?.colorMatch) ? boxsInfo.colorMatch : [];
  const boxes = Array.isArray(boxsInfo?.materialBoxs) ? boxsInfo.materialBoxs : [];
  const assignment = assignments.find((entry) => entry?.id === toolAlias);
  if (!assignment) {
    return null;
  }
  const box = boxes.find((entry) => Number(entry?.id) === Number(assignment.boxId));
  const material = (Array.isArray(box?.materials) ? box.materials : [])
    .find((entry) => Number(entry?.id) === Number(assignment.materialId));
  return {
    toolAlias,
    boxId: assignment.boxId,
    materialId: assignment.materialId,
    boxType: box?.type ?? null,
    boxState: box?.state ?? null,
    materialName: material?.name || "",
    materialType: material?.type || "",
    color: material?.color || "",
    percent: material?.percent ?? null,
    materialState: material?.state ?? null,
  };
}

/**
 * JSON body を持つ WS payload から protocol object を取り出す。
 *
 * 【詳細説明】
 * - normalizeWsPayload の wrapper と、テスト用に直接渡された object の両方を扱う。
 *
 * @private
 * @param {*} payload - WS payload
 * @returns {Object|null} protocol object
 */
function unwrapWsJsonPayload(payload) {
  if (payload?.frameType === "text" && payload.bodyKind === "json" && payload.body && typeof payload.body === "object") {
    return payload.body;
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload;
  }
  return null;
}

/**
 * 印刷状態の観測 snapshot を更新する。
 *
 * 【詳細説明】
 * - K2/K1 系は sparse delta を送るため、重要 key だけ前回値を保持する。
 *
 * @private
 * @param {Object} snapshot - 更新先 snapshot
 * @param {Object|null} payload - 今回の protocol payload
 * @returns {Object} 更新後 snapshot
 */
function mergePrintSnapshot(snapshot, payload) {
  if (!payload || typeof payload !== "object") {
    return snapshot;
  }
  for (const key of [
    "state",
    "deviceState",
    "printProgress",
    "printFileName",
    "fileName",
    "printId",
    "printJobTime",
    "printLeftTime",
    "usedMaterialLength",
    "nozzleTemp",
    "targetNozzleTemp",
    "bedTemp0",
    "targetBedTemp0",
    "layer",
    "TotalLayer",
    "cfsConnect",
  ]) {
    if (Object.hasOwn(payload, key)) {
      snapshot[key] = payload[key];
    }
  }
  return snapshot;
}

/**
 * 現在 snapshot が印刷中または印刷準備中を示すか判定する。
 *
 * 【詳細説明】
 * - K2 の state semantics はまだ認定前なので、複数の root scalar を使って保守的に判定する。
 *
 * @private
 * @param {Object} snapshot - 状態 snapshot
 * @returns {boolean} 印刷活動が観測された場合 true
 */
function isActivePrintSnapshot(snapshot) {
  const state = Number(snapshot.state ?? 0);
  const deviceState = Number(snapshot.deviceState ?? 0);
  const progress = Number(snapshot.printProgress ?? 100);
  const jobTime = Number(snapshot.printJobTime ?? 0);
  const leftTime = Number(snapshot.printLeftTime ?? 0);
  return state !== 0 || deviceState !== 0 || (progress >= 0 && progress < 100) || jobTime > 0 || leftTime > 0;
}

/**
 * 現在 snapshot が完了後 idle を示すか判定する。
 *
 * 【詳細説明】
 * - progress は idle でも stale な 100 を返すため、活動観測後であることを呼び出し側で条件にする。
 *
 * @private
 * @param {Object} snapshot - 状態 snapshot
 * @returns {boolean} 完了後 idle と見なせる場合 true
 */
function isCompletedIdleSnapshot(snapshot) {
  const state = Number(snapshot.state ?? 0);
  const deviceState = Number(snapshot.deviceState ?? 0);
  const progress = Number(snapshot.printProgress ?? 0);
  return state === 0 && deviceState === 0 && progress >= 100;
}

/**
 * 失敗 capture を tmp 配下に保存する。
 *
 * 【詳細説明】
 * - 実印刷が発生した場合、検証失敗でも通信証拠を残すために利用する。
 *
 * @private
 * @param {Object} fixture - 書き込む fixture
 * @param {string} captureId - capture ID
 * @returns {Promise<string>} 退避先 directory
 */
async function writeFailedCapture(fixture, captureId) {
  const failedOutDir = path.resolve("tmp", "failed-captures", captureId);
  await writeProtocolFixtureFiles(failedOutDir, fixture);
  return failedOutDir;
}

/**
 * K2 Benchy 印刷 command とライフサイクルを capture する。
 *
 * 【詳細説明】
 * - 開始前に `/info`、`boxsInfo`、`reqHistory`、`reqGcodeFile` を取得する。
 * - CFS attachment では既定で `opGcodeFile` 単独開始を拒否する。
 * - `--allow-unsafe-opgcodefile-cfs-start` がある場合だけ、選択した G-code に対して
 *   `set { opGcodeFile: "printprt:<path>" }` を1回だけ送る。
 * - 完了検出後に history/boxsInfo を再取得し、fixture を保存する。
 *
 * @function captureK2BenchyPrint
 * @param {Object} options - capture オプション
 * @returns {Promise<Object>} capture 結果
 * @throws {Error} 接続または保存に失敗した場合
 * @example
 * await captureK2BenchyPrint({ host: "192.168.54.21", outDir: "tmp/benchy" });
 */
export async function captureK2BenchyPrint(options) {
  const recorder = createProtocolRecorder();
  const errors = [];
  const observations = {
    httpObserved: false,
    wsOpened: false,
    boxsInfoObserved: false,
    fileListObserved: false,
    historyObserved: false,
    commandSent: false,
    activeObserved: false,
    completedObserved: false,
    heartbeatAcked: false,
    printStartBlocked: false,
  };
  const state = {
    boxsInfo: null,
    files: [],
    selectedFile: null,
    selectedFilePath: "",
    selectedFileMatchedTool: null,
    preferredToolSource: null,
    printSnapshot: {},
    markers: new Set(),
  };
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

  /**
   * 重複を避けて automation marker を追加する。
   *
   * @param {string} name - marker 名
   * @param {Object=} details - 補助 details
   * @returns {void}
   */
  function addAutomationMarker(name, details = {}) {
    if (state.markers.has(name)) {
      return;
    }
    state.markers.add(name);
    recorder.addMarker(name, {
      ...details,
      source: "automation-cli",
    });
  }

  /**
   * WS へ JSON request を送信し、送信内容を recorder に残す。
   *
   * @param {WebSocket} ws - 接続済み WebSocket
   * @param {Object} payload - 送信 payload
   * @param {string} purpose - 送信目的
   * @returns {void}
   */
  function sendJson(ws, payload, purpose) {
    recorder.recordOutbound("ws9999", payload, { purpose });
    ws.send(JSON.stringify(payload));
  }

  try {
    const infoUrl = `http://${options.host}:${options.httpPort}/info`;
    recorder.recordTransportEvent({ channel: "http-info", type: "request", details: { url: infoUrl } });
    try {
      const response = await fetchWithTimeout(infoUrl, 3000);
      const body = await readResponseBody(response);
      observations.httpObserved = response.status >= 200 && response.status < 300;
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
      errors.push({ channel: "http-info", message: error instanceof Error ? error.message : String(error) });
      recorder.recordTransportEvent({
        channel: "http-info",
        type: "error",
        details: { message: error instanceof Error ? error.message : String(error) },
      });
    }

    await new Promise((resolve, reject) => {
      const wsUrl = `ws://${options.host}:${options.wsPort}`;
      const ws = new WebSocket(wsUrl, { handshakeTimeout: 3000 });
      const startedAt = Date.now();
      let interval = null;
      let timeout = null;
      let settled = false;
      let commandAttempted = false;
      let commandSentAt = 0;

      /**
       * capture を終了する。
       *
       * @param {Error|null} error - 終了 error
       * @returns {void}
       */
      function finish(error = null) {
        if (settled) {
          return;
        }
        settled = true;
        if (interval) {
          clearInterval(interval);
        }
        if (timeout) {
          clearTimeout(timeout);
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        } else if (ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
        }
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }

      ws.on("open", () => {
        observations.wsOpened = true;
        recorder.recordTransportEvent({ channel: "ws9999", type: "open", details: { url: wsUrl } });
        addAutomationMarker("observed-idle-before-start", { reason: "ws-open-preflight" });
        sendJson(ws, { method: "get", params: { boxsInfo: 1 } }, "preflight-boxsInfo");
        setTimeout(() => sendJson(ws, { method: "get", params: { reqHistory: 1 } }, "preflight-history"), 800);
        setTimeout(() => sendJson(ws, { method: "get", params: { reqGcodeFile: 1 } }, "preflight-gcode-list"), 7200);
        interval = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) {
            return;
          }
          sendJson(ws, { method: "get", params: { boxsInfo: 1 } }, "periodic-boxsInfo");
          sendJson(ws, { method: "get", params: { reqHistory: 1 } }, "periodic-history");
        }, options.pollMs);
      });

      ws.on("message", (data, isBinary) => {
        const payload = normalizeWsPayload(data, isBinary);
        recorder.recordInbound("ws9999", payload);
        if (isHeartbeatPayload(payload) && ws.readyState === WebSocket.OPEN) {
          const ackPayload = { frameType: "text", bodyKind: "text", body: "ok" };
          recorder.recordOutbound("ws9999", ackPayload, { purpose: "heartbeat-ack" });
          ws.send("ok");
          observations.heartbeatAcked = true;
          return;
        }

        const body = unwrapWsJsonPayload(payload);
        mergePrintSnapshot(state.printSnapshot, body);
        if (body?.boxsInfo && typeof body.boxsInfo === "object") {
          observations.boxsInfoObserved = true;
          state.boxsInfo = body.boxsInfo;
          const nextPreferredToolSource = summarizeK2ToolSource(body.boxsInfo, options.preferredTool);
          if (nextPreferredToolSource) {
            state.preferredToolSource = nextPreferredToolSource;
          }
        }
        const files = normalizeK2GcodeFiles(body);
        if (files.length > 0) {
          observations.fileListObserved = true;
          state.files = files;
          state.selectedFile = selectK2GcodeFile(files, {
            filePath: options.filePath,
            fileContains: options.fileContains,
          });
          state.selectedFilePath = state.selectedFile?.path || state.selectedFile?.filename || "";
          state.selectedFileMatchedTool = extractMatchedTool(state.selectedFile, "T1A");
        }
        if (Array.isArray(body?.historyList)) {
          observations.historyObserved = true;
        }

        if (!commandAttempted &&
            observations.boxsInfoObserved &&
            observations.fileListObserved &&
            state.selectedFilePath) {
          commandAttempted = true;
          if (!options.allowMismatchedTool &&
              state.selectedFileMatchedTool &&
              state.selectedFileMatchedTool !== options.preferredTool) {
            finish(new Error(
              `selected file maps T1A to ${state.selectedFileMatchedTool}, not ${options.preferredTool}; ` +
              "rerun with --allow-mismatched-tool to capture the currently matched single-color Benchy",
            ));
            return;
          }
          if (shouldBlockUnsafeOpgcodeFileCfsStart({
            ...options,
            boxsInfo: state.boxsInfo,
          })) {
            observations.printStartBlocked = true;
            addAutomationMarker("operator-print-start-blocked", {
              reason: "unsafe-opgcodefile-cfs-start",
              selectedFile: state.selectedFile?.name || path.basename(state.selectedFilePath),
              selectedFilePath: state.selectedFilePath,
              preferredTool: options.preferredTool,
              selectedFileMatchedTool: state.selectedFileMatchedTool,
              preferredToolSource: state.preferredToolSource,
            });
            finish(new Error(
              "refusing to send opGcodeFile for CFS attachment without " +
              "--allow-unsafe-opgcodefile-cfs-start; use selected-source evidence or a future PrintPlan command path",
            ));
            return;
          }
          const command = { method: "set", params: { opGcodeFile: `printprt:${state.selectedFilePath}` } };
          addAutomationMarker("operator-print-start", {
            selectedFile: state.selectedFile?.name || path.basename(state.selectedFilePath),
            selectedFilePath: state.selectedFilePath,
            preferredTool: options.preferredTool,
            selectedFileMatchedTool: state.selectedFileMatchedTool,
            preferredToolSource: state.preferredToolSource,
          });
          sendJson(ws, command, "print-start-command");
          observations.commandSent = true;
          commandSentAt = Date.now();
        }

        if (observations.commandSent && isActivePrintSnapshot(state.printSnapshot)) {
          observations.activeObserved = true;
          addAutomationMarker("observed-printing", {
            state: state.printSnapshot.state ?? null,
            deviceState: state.printSnapshot.deviceState ?? null,
            progress: state.printSnapshot.printProgress ?? null,
          });
          const targetNozzle = Number(state.printSnapshot.targetNozzleTemp ?? 0);
          const targetBed = Number(state.printSnapshot.targetBedTemp0 ?? 0);
          if (targetNozzle > 0 || targetBed > 0) {
            addAutomationMarker("observed-heating", {
              targetNozzleTemp: state.printSnapshot.targetNozzleTemp ?? null,
              targetBedTemp0: state.printSnapshot.targetBedTemp0 ?? null,
            });
          }
        }

        if (observations.activeObserved && isCompletedIdleSnapshot(state.printSnapshot)) {
          observations.completedObserved = true;
          addAutomationMarker("observed-completed", {
            state: state.printSnapshot.state ?? null,
            deviceState: state.printSnapshot.deviceState ?? null,
            progress: state.printSnapshot.printProgress ?? null,
            printJobTime: state.printSnapshot.printJobTime ?? null,
            usedMaterialLength: state.printSnapshot.usedMaterialLength ?? null,
          });
          addAutomationMarker("observed-idle-after-completed", { reason: "completed-idle-snapshot" });
          if (ws.readyState === WebSocket.OPEN) {
            sendJson(ws, { method: "get", params: { reqHistory: 1 } }, "post-complete-history");
            sendJson(ws, { method: "get", params: { boxsInfo: 1 } }, "post-complete-boxsInfo");
          }
          setTimeout(() => finish(), 5000);
        }

        if (observations.commandSent && !observations.activeObserved && Date.now() - commandSentAt > 180000) {
          finish(new Error("print command was sent but active print state was not observed within 180000ms"));
        }
      });

      ws.on("close", (code, reason) => {
        recorder.recordTransportEvent({
          channel: "ws9999",
          type: "close",
          details: { code, reason: reason ? reason.toString("utf8") : "" },
        });
        if (!settled && !observations.completedObserved) {
          finish(new Error(`WebSocket closed before completion: ${code}`));
        }
      });

      ws.on("error", (error) => {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ channel: "ws9999", message });
        recorder.recordTransportEvent({ channel: "ws9999", type: "error", details: { message } });
        finish(error instanceof Error ? error : new Error(message));
      });

      timeout = setTimeout(() => {
        const elapsedMs = Date.now() - startedAt;
        finish(new Error(`capture timed out after ${elapsedMs}ms`));
      }, options.maxDurationMs);
    });
  } catch (error) {
    errors.push({ channel: "capture", message: error instanceof Error ? error.message : String(error) });
    recorder.recordTransportEvent({
      channel: "capture",
      type: "error",
      details: { message: error instanceof Error ? error.message : String(error) },
    });
  }

  await sleep(100);
  recorder.stopSession();
  const rawFixture = recorder.exportFixture({ redact: false });
  const markerEvents = rawFixture.events.filter((event) => event.direction === "marker");
  const protocolEventCount = rawFixture.events.length - markerEvents.length;
  const failureReasons = [];
  if (!observations.httpObserved) failureReasons.push("required-http-not-observed");
  if (!observations.wsOpened) failureReasons.push("required-ws-not-opened");
  if (!observations.boxsInfoObserved) failureReasons.push("required-boxsinfo-not-observed");
  if (!observations.fileListObserved) failureReasons.push("required-gcode-list-not-observed");
  if (!state.selectedFilePath) failureReasons.push("required-benchy-file-not-selected");
  if (!observations.commandSent) failureReasons.push("required-print-command-not-sent");
  if (!observations.activeObserved) failureReasons.push("required-active-print-not-observed");
  if (!observations.completedObserved) failureReasons.push("required-completed-print-not-observed");
  if (errors.length > 0) failureReasons.push("capture-errors-observed");
  const success = failureReasons.length === 0;
  rawFixture.metadata.validation = {
    success,
    failureReasons,
    eventCount: rawFixture.events.length,
    protocolEventCount,
    markerCount: markerEvents.length,
    required: {
      http: true,
      ws: true,
      boxsInfo: true,
      gcodeList: true,
      printCommand: true,
      completedPrint: true,
    },
    observations: {
      ...observations,
      selectedFilePath: state.selectedFilePath,
      selectedFileName: state.selectedFile?.name || "",
      selectedFileMatchedTool: state.selectedFileMatchedTool,
      preferredTool: options.preferredTool,
      preferredToolSource: state.preferredToolSource,
      finalPrintSnapshot: state.printSnapshot,
      errorCount: errors.length,
    },
    errors,
  };
  const fixture = redactProtocolValue(rawFixture);

  const writtenOutDir = success ? options.outDir : null;
  const failedOutDir = success
    ? null
    : (options.keepFailed || observations.commandSent || observations.printStartBlocked
        ? await writeFailedCapture(fixture, started.captureId)
        : null);
  if (success) {
    await writeProtocolFixtureFiles(options.outDir, fixture, { atomic: true });
  }

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
    observations: fixture.metadata.validation.observations,
    errors,
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
    const result = await captureK2BenchyPrint(options);
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
