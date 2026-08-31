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
 * - {@link summarizeBoxsInfoEvidence}：boxsInfoからsource summaryを生成
 * - {@link sendBoxsInfoProbeAndWait}：read-only boxsInfo probeを送信して応答を待つ
 * - {@link runK2CfsSlotControlCertification}：dry-runまたは明示送信を実行
 *
 * @version 1.390.1533 (PR #439)
 * @since   1.390.1415 (PR #435)
 * @lastModified 2026-08-31 17:28:40
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
  --probe-after-delay-ms <number>  Delay before post-command probe. Default: 1500.
  --probe-after-count <number>     Number of post-command probes. Default: 1.
  --probe-after-interval-ms <number> Interval between post-command probes. Default: 1000.
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
 * - 既定は後方互換のため1回にする。
 * - 実機debug時は複数回に増やし、CFS commandを再送せずread-only観測だけを時系列化できる。
 *
 * @constant {number}
 */
const DEFAULT_POST_COMMAND_PROBE_COUNT = 1;

/**
 * 複数after-probe間の既定待機時間。
 *
 * 【詳細説明】
 * - command後の状態変化が段階的に届く場合に備え、連続read-only probeの間隔を明示する。
 *
 * @constant {number}
 */
const DEFAULT_POST_COMMAND_PROBE_INTERVAL_MS = 1000;

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
    else if (arg === "--probe-before") options.probeBefore = true;
    else if (arg === "--probe-after") options.probeAfter = true;
    else if (arg === "--boxsinfo-timeout-ms") options.boxsInfoTimeoutMs = Number(next());
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
    boxsInfoTimeoutMs: options.boxsInfoTimeoutMs,
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
  const observedBoxIds = new Set();
  const observedSourceIds = new Set();
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
    if (observedBoxIds.has(boxId)) {
      pushBoxsInfoDiagnostic(diagnostics, "box-id-duplicate", boxPath, boxId);
      continue;
    }
    observedBoxIds.add(boxId);
    const external = boxType === 1;
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
      if (observedSourceIds.has(sourceId)) {
        pushBoxsInfoDiagnostic(diagnostics, "source-id-duplicate", materialPath, sourceId);
        continue;
      }
      observedSourceIds.add(sourceId);
      const stateCode = material?.state ?? null;
      sources.push({
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
        selected: material?.selected === true || material?.selected === 1 || material?.selected === "1",
        percent: material?.percent ?? null,
        materialType: material?.type || "",
        materialName: material?.name || "",
        color: material?.color || "",
        rfidPresent: Boolean(toNonEmptyString(material?.rfid)),
      });
    }
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
    sources,
    colorMatches,
    diagnostics,
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
      probePlan: createProbePlanSummary(options),
    }, options);
  }
  const ws = await (options.openWs || openWs)(options.host, options.wsPort);
  try {
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
        probePlan: createProbePlanSummary(options),
        response: null,
        probes,
        error: serializeCertificationError(error),
      }, options);
    }
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
        if (probe.status !== "observed") {
          break;
        }
      }
      if (lastAfterProbe?.status !== "observed") {
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
          probes,
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
      probePlan: createProbePlanSummary(options),
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
