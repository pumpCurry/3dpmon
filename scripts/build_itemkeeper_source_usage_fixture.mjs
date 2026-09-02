#!/usr/bin/env node
/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 ItemKeeper source usage fixture builder
 * @file build_itemkeeper_source_usage_fixture.mjs
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module build_itemkeeper_source_usage_fixture
 *
 * 【機能内容サマリ】
 * - 3DPmon export JSONからGate 18.9J-1/J-2レビュー用fixture artifactをread-only生成する
 * - K2/CFSのprint-start snapshot、JobMaterialSegment、raw materialUsed CSVを同一jobへ束ねる
 * - fixture evidence、fixture receipt、projection digest一覧、capture manifestを出力する
 *
 * 【公開関数一覧】
 * - {@link parseArgs}：CLI引数を解析
 * - {@link buildItemKeeperSourceUsageFixture}：export payloadからfixture artifactを生成
 * - {@link runItemKeeperSourceUsageFixtureBuilder}：CLI指定ファイルを読み書きする
 *
 * @version 1.390.1646 (PR #440)
 * @since   1.390.1639 (PR #440)
 * @lastModified 2026-09-02 15:42:55
 * -----------------------------------------------------------
 * @todo
 * - Gate 18.9J-2 registry entry追加時にreviewed registry entry skeleton出力を追加する
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPrinterCoreV3DeterministicId,
  stableStringifyPrinterCoreV3Value,
} from "../3dp_lib/printer_core/dashboard_data_schema_v3.js";
import {
  createItemKeeperSourceUsageProjectionCertificationDigest,
  evaluateItemKeeperSourceUsageLiveFixture,
} from "../3dp_lib/printer_core/dashboard_itemkeeper_source_usage_projection_certification.js";
import {
  K2_MATERIAL_USED_CSV_PARSER_VERSION,
  K2_MATERIAL_USED_SOURCE_ORDERING_PROFILE,
  resolveK2MaterialUsedSourceCsv,
} from "../3dp_lib/printer_core/dashboard_material_used_csv_parser.js";
import {
  doesCfsDeviceMatchCorrelationEvidence,
  doesCfsSessionMatchCorrelationEvidence,
  normalizeCfsDeviceCorrelationEvidence,
  normalizeCfsSessionCorrelationEvidence,
} from "../3dp_lib/printer_core/dashboard_cfs_session_correlation.js";

/**
 * CLI usage text。
 *
 * @constant {string}
 */
const USAGE = `Usage:
  node scripts/build_itemkeeper_source_usage_fixture.mjs --export <post-export.json> --device-id <device> --print-job-id <job> --reviewed-commit <sha> --operator-action-id <id> --output-dir <dir> [options]

Options:
  --export <path>              3DPmon all-data export JSON. Required.
  --certification <path>       Optional CFS Debug / Certification panel export JSON.
  --device-id <id>             Printer Core v3 device ID for the fixture. Required.
  --print-job-id <id>          Target print job ID. Required.
  --reviewed-commit <sha>      Full 40-character git SHA of the tested build. Required.
  --operator-action-id <id>    Operator-confirmed capture action ID. Required.
  --output-dir <path>          Directory where fixture files are written. Required.
  --hostname <name>            Optional printer hostname/display name.
  --model <model>              Optional printer model override.
  --firmware-version <value>   Optional firmware version override.
  --printer-type <type>        Optional printer type. Defaults to creality-k2.
  --fixture-id <id>            Optional fixture ID. Generated when omitted.
  --capture-id <id>            Optional capture ID. Generated when omitted.
  --captured-at <iso>          Optional capture timestamp. Defaults to certification/export timestamp or now.
  --pretty                     Pretty-print stdout JSON.
  --help                       Show this help.
`;

/**
 * 任意値をtrim済み文字列へ変換する。
 *
 * @private
 * @function toText
 * @param {*} value - 文字列候補。
 * @returns {string} trim済み文字列。
 */
function toText(value) {
  return String(value ?? "").trim();
}

/**
 * JSON互換値をcloneする。
 *
 * @private
 * @function cloneJsonValue
 * @param {*} value - clone対象。
 * @returns {*} clone済み値。
 */
function cloneJsonValue(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * export rootを取得する。
 *
 * @private
 * @function getExportDataRoot
 * @param {Object|null|undefined} payload - export JSON payload。
 * @returns {Object} monitorData相当root。
 */
function getExportDataRoot(payload) {
  if (payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
    return payload.data;
  }
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

/**
 * collectionをobject配列へ正規化する。
 *
 * @private
 * @function valuesOfCollection
 * @param {*} collection - 配列またはobject辞書。
 * @returns {Object[]} object要素配列。
 */
function valuesOfCollection(collection) {
  if (Array.isArray(collection)) {
    return collection.filter((entry) => entry && typeof entry === "object");
  }
  if (collection && typeof collection === "object") {
    return Object.values(collection).filter((entry) => entry && typeof entry === "object");
  }
  return [];
}

/**
 * rawValue wrapperを含む値を文字列へ変換する。
 *
 * @private
 * @function unwrapText
 * @param {*} value - 文字列またはrawValue wrapper。
 * @returns {string} trim済み文字列。
 */
function unwrapText(value) {
  if (value && typeof value === "object" && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "rawValue")) {
    return toText(value.rawValue);
  }
  return toText(value);
}

/**
 * PrintJob ID候補を取得する。
 *
 * @private
 * @function resolvePrintJobId
 * @param {Object|null|undefined} record - snapshot / segment / history候補。
 * @returns {string} PrintJob ID。
 */
function resolvePrintJobId(record) {
  return toText(record?.printJobId || record?.jobId || record?.printId || record?.id);
}

/**
 * PrintPlan ID候補を取得する。
 *
 * @private
 * @function resolvePrintPlanId
 * @param {Object|null|undefined} record - snapshot / segment / history候補。
 * @returns {string} PrintPlan ID。
 */
function resolvePrintPlanId(record) {
  return toText(record?.printPlanId || record?.planId);
}

/**
 * snapshot/segment/historyに残るsession IDを取得する。
 *
 * 【詳細説明】
 * - live captureでは同一deviceでも再接続を跨ぐと別sessionになり得るため、fixture単体で
 *   certification exportとの同一session性を説明できる観測値を同一keyへ寄せる。
 *
 * @private
 * @function resolveRecordSessionId
 * @param {Object|null|undefined} record - snapshot / segment / history候補。
 * @returns {string} session ID。
 */
function resolveRecordSessionId(record) {
  return toText(
    record?.sessionId ||
    record?.printerSessionId ||
    record?.commandSessionId ||
    record?.startContext?.sessionId ||
    record?.issuanceEvidence?.sessionId ||
    record?.uploadReceipt?.sessionId
  );
}

/**
 * snapshotのauthority orderを取得する。
 *
 * @private
 * @function resolveSnapshotOrder
 * @param {Object|null|undefined} snapshot - print-start snapshot候補。
 * @param {number} fallback - fallback順序。
 * @returns {number} source order。
 */
function resolveSnapshotOrder(snapshot, fallback) {
  const value = snapshot?.bindingAuthority?.tool?.order ?? snapshot?.order;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

/**
 * segmentのauthority orderを取得する。
 *
 * @private
 * @function resolveSegmentOrder
 * @param {Object|null|undefined} segment - JobMaterialSegment候補。
 * @param {number} fallback - fallback順序。
 * @returns {number} source order。
 */
function resolveSegmentOrder(segment, fallback) {
  const numeric = Number(segment?.order);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

/**
 * snapshotのprotocol tool aliasを取得する。
 *
 * @private
 * @function resolveSnapshotToolAlias
 * @param {Object|null|undefined} snapshot - print-start snapshot候補。
 * @returns {string} protocol tool alias。
 */
function resolveSnapshotToolAlias(snapshot) {
  return toText(snapshot?.bindingAuthority?.tool?.protocolToolAlias || snapshot?.protocolToolAlias || snapshot?.toolAlias);
}

/**
 * snapshotのtool IDを取得する。
 *
 * @private
 * @function resolveSnapshotToolId
 * @param {Object|null|undefined} snapshot - print-start snapshot候補。
 * @returns {number|null} tool ID。
 */
function resolveSnapshotToolId(snapshot) {
  const numeric = Number(snapshot?.bindingAuthority?.tool?.toolId ?? snapshot?.toolId);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
}

/**
 * snapshotのMaterialSource IDを取得する。
 *
 * @private
 * @function resolveSnapshotMaterialSourceId
 * @param {Object|null|undefined} snapshot - print-start snapshot候補。
 * @returns {string} MaterialSource ID。
 */
function resolveSnapshotMaterialSourceId(snapshot) {
  return toText(snapshot?.bindingAuthority?.source?.materialSourceId || snapshot?.materialSourceId);
}

/**
 * snapshotのmount IDを取得する。
 *
 * @private
 * @function resolveSnapshotMountId
 * @param {Object|null|undefined} snapshot - print-start snapshot候補。
 * @returns {string} mount ID。
 */
function resolveSnapshotMountId(snapshot) {
  return toText(snapshot?.bindingAuthority?.mount?.mountId || snapshot?.mountId);
}

/**
 * snapshotのspool IDを取得する。
 *
 * @private
 * @function resolveSnapshotSpoolId
 * @param {Object|null|undefined} snapshot - print-start snapshot候補。
 * @returns {string} spool ID。
 */
function resolveSnapshotSpoolId(snapshot) {
  return toText(snapshot?.bindingAuthority?.mount?.spoolId || snapshot?.spoolId);
}

/**
 * fixture IDへ使える短いslugを生成する。
 *
 * @private
 * @function createSlug
 * @param {string} value - slug候補。
 * @returns {string} slug。
 */
function createSlug(value) {
  return toText(value).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "") || "unknown";
}

/**
 * SHA-256文字列を生成する。
 *
 * @private
 * @function createSha256
 * @param {string|Buffer} value - hash対象。
 * @returns {string} sha256証跡。
 */
function createSha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * JSON値を安定化してSHA-256文字列を生成する。
 *
 * @private
 * @function createStableJsonSha256
 * @param {*} value - hash対象JSON値。
 * @returns {string} sha256証跡。
 */
function createStableJsonSha256(value) {
  return createSha256(stableStringifyPrinterCoreV3Value(value));
}

/**
 * JSONを改行付きで整形する。
 *
 * @private
 * @function stringifyJsonFile
 * @param {*} value - JSON値。
 * @returns {string} ファイル出力文字列。
 */
function stringifyJsonFile(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * CLI引数を解析する。
 *
 * @function parseArgs
 * @param {string[]} argv - `process.argv.slice(2)` 相当。
 * @returns {Object} CLI options。
 * @throws {Error} 必須引数が欠落する場合。
 * @example
 * const options = parseArgs(["--export", "export.json", "--device-id", "serial:k2"]);
 */
export function parseArgs(argv = []) {
  const options = {
    exportPath: "",
    certificationPath: "",
    deviceId: "",
    printJobId: "",
    reviewedCommit: "",
    operatorActionId: "",
    outputDir: "",
    hostname: "",
    model: "",
    firmwareVersion: "",
    printerType: "creality-k2",
    fixtureId: "",
    captureId: "",
    capturedAt: "",
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
    else if (arg === "--export") options.exportPath = next();
    else if (arg === "--certification") options.certificationPath = next();
    else if (arg === "--device-id") options.deviceId = next();
    else if (arg === "--print-job-id") options.printJobId = next();
    else if (arg === "--reviewed-commit") options.reviewedCommit = next();
    else if (arg === "--operator-action-id") options.operatorActionId = next();
    else if (arg === "--output-dir") options.outputDir = next();
    else if (arg === "--hostname") options.hostname = next();
    else if (arg === "--model") options.model = next();
    else if (arg === "--firmware-version") options.firmwareVersion = next();
    else if (arg === "--printer-type") options.printerType = next();
    else if (arg === "--fixture-id") options.fixtureId = next();
    else if (arg === "--capture-id") options.captureId = next();
    else if (arg === "--captured-at") options.capturedAt = next();
    else if (arg === "--pretty") options.pretty = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.help) {
    return options;
  }
  const required = ["exportPath", "deviceId", "printJobId", "reviewedCommit", "operatorActionId", "outputDir"];
  for (const key of required) {
    if (!toText(options[key])) {
      throw new Error(`--${key.replace(/[A-Z]/gu, (match) => `-${match.toLowerCase()}`)} is required.`);
    }
  }
  if (!/^[a-f0-9]{40}$/iu.test(toText(options.reviewedCommit))) {
    throw new Error("--reviewed-commit must be a full 40-character SHA.");
  }
  return options;
}

/**
 * 対象deviceのconnection targetを検索する。
 *
 * @private
 * @function findTargetForDevice
 * @param {Object} data - monitorData相当root。
 * @param {Object} options - CLI/build options。
 * @returns {Object|null} connection target。
 */
function findTargetForDevice(data, options) {
  const targets = valuesOfCollection(data.appSettings?.connectionTargets);
  return targets.find((target) => (
    toText(target?.printerCoreV3Identity?.deviceId || target?.printerCoreV3Identity?.deviceIdSeed) === options.deviceId ||
    toText(target?.hostname) === options.hostname ||
    toText(target?.label) === options.hostname
  )) || null;
}

/**
 * 対象machineを検索する。
 *
 * @private
 * @function findMachineForTarget
 * @param {Object} data - monitorData相当root。
 * @param {Object|null} target - connection target。
 * @param {Object} options - CLI/build options。
 * @returns {Object|null} machine record。
 */
function findMachineForTarget(data, target, options) {
  const machines = data.machines && typeof data.machines === "object" ? data.machines : {};
  if (target && machines[toText(target.hostname)]) {
    return machines[toText(target.hostname)];
  }
  if (options.hostname && machines[options.hostname]) {
    return machines[options.hostname];
  }
  return valuesOfCollection(machines).find((machine) => (
    toText(machine?.runtimeData?.printerCoreV3Shadow?.deviceId) === options.deviceId ||
    toText(machine?.printerCoreV3Identity?.deviceId || machine?.printerCoreV3Identity?.deviceIdSeed) === options.deviceId
  )) || null;
}

/**
 * certification panel exportからprinter情報を取得する。
 *
 * @private
 * @function resolveCertificationPrinter
 * @param {Object|null|undefined} certificationPayload - CFS certification panel export。
 * @returns {Object} printer情報。
 */
function resolveCertificationPrinter(certificationPayload) {
  return certificationPayload?.manifest?.printer &&
    typeof certificationPayload.manifest.printer === "object" &&
    !Array.isArray(certificationPayload.manifest.printer)
    ? certificationPayload.manifest.printer
    : {};
}

/**
 * fixture用device metadataを生成する。
 *
 * @private
 * @function createFixtureDeviceMetadata
 * @param {Object} input - 入力context。
 * @param {Object} input.data - monitorData相当root。
 * @param {Object|null} input.certificationPayload - certification payload。
 * @param {Object} input.options - CLI/build options。
 * @returns {Object} device metadata。
 */
function createFixtureDeviceMetadata({ data, certificationPayload, options, target = null, machine = null }) {
  const resolvedTarget = target || findTargetForDevice(data, options);
  const resolvedMachine = machine || findMachineForTarget(data, resolvedTarget, options);
  const certificationPrinter = resolveCertificationPrinter(certificationPayload);
  return {
    deviceId: toText(options.deviceId),
    printerType: toText(options.printerType || resolvedTarget?.printerType || "creality-k2"),
    model: toText(
      resolvedTarget?.printerCoreV3Identity?.reportedModel ||
      resolvedMachine?.printerCoreV3Identity?.reportedModel ||
      unwrapText(resolvedMachine?.storedData?.model) ||
      certificationPrinter.model ||
      options.model
    ),
    firmwareVersion: toText(
      resolvedTarget?.printerCoreV3Identity?.firmwareVersion ||
      resolvedMachine?.printerCoreV3Identity?.firmwareVersion ||
      unwrapText(resolvedMachine?.storedData?.firmwareVersion) ||
      unwrapText(resolvedMachine?.storedData?.modelver) ||
      unwrapText(resolvedMachine?.storedData?.fwVersion) ||
      certificationPrinter.firmwareVersion ||
      options.firmwareVersion
    ),
  };
}

/**
 * redaction placeholderではないidentity文字列か判定する。
 *
 * 【詳細説明】
 * - certification exportはredacted placeholderを含む場合があるため、実値だけをconflict判定へ使う。
 *
 * @private
 * @function isConcreteIdentityText
 * @param {*} value - identity候補。
 * @returns {boolean} 比較可能なidentity文字列ならtrue。
 */
function isConcreteIdentityText(value) {
  const text = toText(value);
  return Boolean(text && !text.startsWith("<"));
}

/**
 * fixture builderのidentity conflictを検査する。
 *
 * 【詳細説明】
 * - fixture evidenceのdevice metadataはexport target/machineを基準にする。
 * - certification JSONやCLI overrideは、欠落値の補完には使えるが、exportで観測済みのidentityと
 *   矛盾する場合はreview不可として隔離する。
 *
 * @private
 * @function createIdentityReviewBlockers
 * @param {Object} input - 入力context。
 * @param {Object} input.device - fixture device metadata。
 * @param {Object|null|undefined} input.certificationPayload - certification payload。
 * @param {Object} input.options - CLI/build options。
 * @param {Object|null|undefined} input.sessionEvidence - 対象jobのsession evidence。
 * @returns {string[]} identity review blocker配列。
 */
function createIdentityReviewBlockers({ device, certificationPayload, options, sessionEvidence = null }) {
  const blockers = [];
  const certificationPrinter = resolveCertificationPrinter(certificationPayload);
  const certificationDeviceCorrelation = normalizeCfsDeviceCorrelationEvidence(
    certificationPayload?.manifest?.deviceCorrelation
  );
  const certificationDeviceRedacted = toText(certificationPrinter.deviceId).startsWith("<");
  if (certificationDeviceRedacted && !certificationDeviceCorrelation.value) {
    blockers.push("certification-device-correlation-missing");
  }
  if (
    isConcreteIdentityText(certificationPrinter.deviceId) &&
    device.deviceId &&
    certificationPrinter.deviceId !== device.deviceId
  ) {
    blockers.push("certification-device-id-mismatch");
  }
  if (
    certificationDeviceCorrelation.value &&
    device.deviceId &&
    !doesCfsDeviceMatchCorrelationEvidence(device.deviceId, certificationDeviceCorrelation)
  ) {
    blockers.push("certification-device-id-mismatch");
  }
  if (
    isConcreteIdentityText(certificationPrinter.model) &&
    device.model &&
    certificationPrinter.model !== device.model
  ) {
    blockers.push("certification-model-mismatch");
  }
  if (
    isConcreteIdentityText(certificationPrinter.firmwareVersion) &&
    device.firmwareVersion &&
    certificationPrinter.firmwareVersion !== device.firmwareVersion
  ) {
    blockers.push("certification-firmware-version-mismatch");
  }
  if (toText(options.model) && device.model && options.model !== device.model) {
    blockers.push("cli-model-override-conflicts-with-export");
  }
  if (toText(options.firmwareVersion) && device.firmwareVersion && options.firmwareVersion !== device.firmwareVersion) {
    blockers.push("cli-firmware-version-override-conflicts-with-export");
  }
  const certificationSessionId = isConcreteIdentityText(certificationPrinter.sessionId)
    ? toText(certificationPrinter.sessionId)
    : "";
  const certificationSessionCorrelation = normalizeCfsSessionCorrelationEvidence(
    certificationPayload?.manifest?.sessionCorrelation
  );
  const certificationSessionRedacted = toText(certificationPrinter.sessionId).startsWith("<");
  const certificationSessionCorrelationMissing = certificationSessionRedacted && !certificationSessionCorrelation.value;
  const requiresCertificationSession = Boolean(
    certificationSessionId ||
    certificationSessionCorrelation.value ||
    certificationSessionRedacted
  );
  const sessionIds = Array.isArray(sessionEvidence?.sessionIds) ? sessionEvidence.sessionIds : [];
  if (certificationSessionCorrelationMissing) {
    blockers.push("certification-session-correlation-missing");
  }
  if (requiresCertificationSession && sessionIds.length <= 0) {
    blockers.push("certification-session-id-missing");
  } else if (requiresCertificationSession && sessionIds.length > 1) {
    blockers.push("candidate-session-id-ambiguous");
  } else if (certificationSessionId && sessionIds[0] !== certificationSessionId) {
    blockers.push("certification-session-id-mismatch");
  } else if (
    certificationSessionCorrelation.value &&
    !doesCfsSessionMatchCorrelationEvidence(sessionIds[0], certificationSessionCorrelation)
  ) {
    blockers.push("certification-session-id-mismatch");
  }
  return blockers;
}

/**
 * 対象jobに紐づくsession evidenceを生成する。
 *
 * 【詳細説明】
 * - print-start snapshot、JobMaterialSegment、print historyの順でsession IDを収集する。
 * - 1件だけならfixtureの代表sessionIdとして採用し、0件または複数件はreview blocker側で
 *   certification sessionとの照合理由として扱う。
 *
 * @private
 * @function createFixtureSessionEvidence
 * @param {Object} input - 入力context。
 * @param {Object[]} input.snapshots - 対象print-start snapshot配列。
 * @param {Object[]} input.segments - 対象JobMaterialSegment配列。
 * @param {Object|null} input.historyEntry - 対象print history entry。
 * @returns {Object} session evidence。
 */
function createFixtureSessionEvidence({ snapshots, segments, historyEntry }) {
  const sessionIds = [...new Set(snapshots.map(resolveRecordSessionId).filter(Boolean))];
  const observedOtherSessionIds = [...new Set([
    ...segments.map(resolveRecordSessionId),
    resolveRecordSessionId(historyEntry),
  ].filter(Boolean))];
  return {
    sessionId: sessionIds.length === 1 ? sessionIds[0] : "",
    sessionIds,
    observedOtherSessionIds,
  };
}

/**
 * 対象jobのprint-start snapshotを抽出する。
 *
 * @private
 * @function collectTargetSnapshots
 * @param {Object} data - monitorData相当root。
 * @param {Object} options - CLI/build options。
 * @returns {Object[]} 対象snapshot配列。
 */
function collectTargetSnapshots(data, options) {
  return valuesOfCollection(data.materialAccountingPrintBindingStore?.printStartSnapshots)
    .filter((snapshot) => (
      toText(snapshot.deviceId) === options.deviceId &&
      resolvePrintJobId(snapshot) === options.printJobId
    ))
    .sort((a, b) => resolveSnapshotOrder(a, 0) - resolveSnapshotOrder(b, 0));
}

/**
 * 対象jobのJobMaterialSegmentを抽出する。
 *
 * @private
 * @function collectTargetSegments
 * @param {Object} data - monitorData相当root。
 * @param {Object} options - CLI/build options。
 * @returns {Object[]} 対象segment配列。
 */
function collectTargetSegments(data, options) {
  return valuesOfCollection(data.materialAccountingPrintBindingStore?.jobMaterialSegments)
    .filter((segment) => (
      toText(segment.deviceId) === options.deviceId &&
      resolvePrintJobId(segment) === options.printJobId
    ))
    .sort((a, b) => resolveSegmentOrder(a, 0) - resolveSegmentOrder(b, 0));
}

/**
 * 対象jobのprint history entryを抽出する。
 *
 * @private
 * @function findTargetHistoryEntry
 * @param {Object} data - monitorData相当root。
 * @param {Object} options - CLI/build options。
 * @returns {Object|null} print history entry。
 */
function findTargetHistoryEntry(data, options, target = null, expectedPrintPlanId = "") {
  const machine = findMachineForTarget(data, target || findTargetForDevice(data, options), options);
  const history = valuesOfCollection(machine?.printStore?.history);
  const matchingEntries = history.filter((entry) => resolvePrintJobId(entry) === options.printJobId);
  if (!toText(expectedPrintPlanId)) {
    return matchingEntries[0] || null;
  }
  for (const entry of matchingEntries) {
    if (resolvePrintPlanId(entry) === expectedPrintPlanId) {
      return entry;
    }
  }
  return null;
}

/**
 * snapshotに対応するsegmentを検索する。
 *
 * @private
 * @function findSegmentForSnapshot
 * @param {Object} snapshot - print-start snapshot。
 * @param {Object[]} segments - JobMaterialSegment配列。
 * @returns {Object|null} 対応segment。
 */
function findSegmentForSnapshot(snapshot, segments) {
  const sourceId = resolveSnapshotMaterialSourceId(snapshot);
  const mountId = resolveSnapshotMountId(snapshot);
  const spoolId = resolveSnapshotSpoolId(snapshot);
  const order = resolveSnapshotOrder(snapshot, -1);
  return segments.find((segment) => (
    toText(segment.materialSourceId) === sourceId &&
    toText(segment.mountId) === mountId &&
    toText(segment.spoolId) === spoolId &&
    resolveSegmentOrder(segment, -1) === order
  )) || null;
}

/**
 * expectedSourceOrderをsnapshotとsegmentから生成する。
 *
 * @private
 * @function createExpectedSourceOrder
 * @param {Object[]} snapshots - print-start snapshot配列。
 * @param {Object[]} segments - JobMaterialSegment配列。
 * @returns {Object[]} expected source order配列。
 */
function createExpectedSourceOrder(snapshots, segments) {
  return snapshots.map((snapshot, index) => {
    const segment = findSegmentForSnapshot(snapshot, segments) || segments[index] || {};
    return {
      order: resolveSnapshotOrder(snapshot, index),
      toolId: resolveSnapshotToolId(snapshot),
      protocolToolAlias: resolveSnapshotToolAlias(snapshot),
      materialSourceId: resolveSnapshotMaterialSourceId(snapshot),
      mountId: resolveSnapshotMountId(snapshot),
      spoolId: resolveSnapshotSpoolId(snapshot),
      snapshotId: toText(snapshot.snapshotId),
      bindingAuthorityDigest: toText(snapshot.bindingAuthorityDigest),
      usedLengthMm: segment.usedLengthMm,
      usageState: toText(segment.usageState),
      locator: cloneJsonValue(
        snapshot.bindingAuthority?.source?.locator ||
        snapshot.materialSource?.locator ||
        snapshot.materialSourceSnapshot?.locator ||
        {}
      ),
    };
  });
}

/**
 * fixture evidence envelopeを生成する。
 *
 * @private
 * @function createFixtureEvidence
 * @param {Object} input - 入力context。
 * @param {Object} input.options - CLI/build options。
 * @param {Object} input.device - device metadata。
 * @param {Object|null} input.historyEntry - print history entry。
 * @param {Object[]} input.expectedSourceOrder - expected source order配列。
 * @param {string} input.captureSha256 - capture artifact SHA-256。
 * @param {Object|null} input.certificationPayload - certification payload。
 * @param {Object} input.sessionEvidence - 対象jobのsession evidence。
 * @returns {Object} fixture evidence。
 */
function createFixtureEvidence({
  options,
  device,
  historyEntry,
  expectedSourceOrder,
  captureSha256,
  certificationPayload,
  sessionEvidence,
}) {
  const capturedAt = toText(
    options.capturedAt ||
    certificationPayload?.manifest?.generatedAt ||
    historyEntry?.historyObservedReceivedAt ||
    historyEntry?.endTime ||
    historyEntry?.finishTime ||
    new Date().toISOString()
  );
  const fixtureSeed = `${createSlug(device.model)}-${createSlug(options.deviceId)}-${createSlug(options.printJobId)}`;
  return {
    schemaVersion: 1,
    authority: "itemkeeper-source-usage-live-fixture-evidence",
    gate: "18.9J-1",
    fixtureId: toText(options.fixtureId) || `fixture:${fixtureSeed}`,
    captureId: toText(options.captureId) || `capture:${fixtureSeed}`,
    capturedAt,
    operatorActionId: toText(options.operatorActionId),
    reviewedCommit: toText(options.reviewedCommit).toLowerCase(),
    parser: {
      parserVersion: K2_MATERIAL_USED_CSV_PARSER_VERSION,
      sourceOrderingProfile: K2_MATERIAL_USED_SOURCE_ORDERING_PROFILE,
    },
    device,
    print: {
      printJobId: toText(options.printJobId),
      printPlanId: toText(expectedSourceOrder[0]?.printPlanId || historyEntry?.printPlanId || ""),
      sessionId: toText(sessionEvidence?.sessionId),
      sessionIds: Array.isArray(sessionEvidence?.sessionIds) ? [...sessionEvidence.sessionIds] : [],
      observedOtherSessionIds: Array.isArray(sessionEvidence?.observedOtherSessionIds)
        ? [...sessionEvidence.observedOtherSessionIds]
        : [],
    },
    raw: {
      materialUsedSourceCsv: resolveK2MaterialUsedSourceCsv(historyEntry),
    },
    artifact: {
      captureSha256,
    },
    expectedSourceOrder,
  };
}

/**
 * expectedSourceOrderへprintPlanIdを補完する。
 *
 * @private
 * @function attachPrintPlanIdToExpectedSourceOrder
 * @param {Object[]} expectedSourceOrder - expected source order配列。
 * @param {Object[]} snapshots - print-start snapshot配列。
 * @returns {Object[]} printPlanId補完済み配列。
 */
function attachPrintPlanIdToExpectedSourceOrder(expectedSourceOrder, snapshots) {
  return expectedSourceOrder.map((entry, index) => ({
    ...entry,
    printPlanId: toText(snapshots[index]?.printPlanId),
  }));
}

/**
 * build結果の警告を生成する。
 *
 * @private
 * @function createBuildWarnings
 * @param {Object} input - 入力context。
 * @param {Object} input.device - device metadata。
 * @param {Object[]} input.snapshots - print-start snapshot配列。
 * @param {Object[]} input.segments - JobMaterialSegment配列。
 * @param {Object|null} input.historyEntry - print history entry。
 * @param {Object|null} input.certificationPayload - certification payload。
 * @returns {string[]} warning配列。
 */
function createBuildWarnings({ device, snapshots, segments, historyEntry, certificationPayload }) {
  const warnings = [];
  if (!device.model) warnings.push("device-model-missing");
  if (!device.firmwareVersion) warnings.push("device-firmware-version-missing");
  if (snapshots.length === 0) warnings.push("print-start-snapshot-missing");
  if (segments.length === 0) warnings.push("job-material-segment-missing");
  if (!historyEntry) warnings.push("print-history-entry-missing");
  if (!resolveK2MaterialUsedSourceCsv(historyEntry)) warnings.push("raw-material-used-source-csv-missing");
  if (!certificationPayload) warnings.push("cfs-certification-panel-export-missing");
  return warnings;
}

/**
 * export payloadからfixture artifactを生成する。
 *
 * 【詳細説明】
 * - この関数はread-onlyであり、monitorDataや実機へ副作用を持たない。
 * - fixture receiptがrejectedになってもartifactを返し、capture不足理由をレビューへ渡せるようにする。
 *
 * @function buildItemKeeperSourceUsageFixture
 * @param {Object} input - 入力context。
 * @param {Object} input.exportPayload - 3DPmon all-data export JSON。
 * @param {Object|null=} input.certificationPayload - CFS certification panel export JSON。
 * @param {Object} input.options - CLI/build options。
 * @param {Object=} input.inputHashes - 入力ファイルhash情報。
 * @returns {Object} fixture build result。
 */
export function buildItemKeeperSourceUsageFixture({
  exportPayload,
  certificationPayload = null,
  options,
  inputHashes = {},
}) {
  const data = getExportDataRoot(exportPayload);
  const target = findTargetForDevice(data, options);
  const machine = findMachineForTarget(data, target, options);
  const device = createFixtureDeviceMetadata({ data, certificationPayload, options, target, machine });
  const snapshots = collectTargetSnapshots(data, options);
  const segments = collectTargetSegments(data, options);
  const snapshotPrintPlanId = toText(snapshots[0]?.printPlanId);
  const historyEntry = findTargetHistoryEntry(data, options, target, snapshotPrintPlanId);
  const expectedSourceOrder = attachPrintPlanIdToExpectedSourceOrder(
    createExpectedSourceOrder(snapshots, segments),
    snapshots
  );
  const printPlanId = toText(expectedSourceOrder[0]?.printPlanId || historyEntry?.printPlanId || "");
  const sessionEvidence = createFixtureSessionEvidence({ snapshots, segments, historyEntry });
  const captureBundle = {
    schemaVersion: 1,
    authority: "itemkeeper-source-usage-capture-bundle",
    reviewedCommit: toText(options.reviewedCommit).toLowerCase(),
    operatorActionId: toText(options.operatorActionId),
    device,
    print: {
      printJobId: toText(options.printJobId),
      printPlanId,
      sessionId: sessionEvidence.sessionId,
      sessionIds: [...sessionEvidence.sessionIds],
      observedOtherSessionIds: [...sessionEvidence.observedOtherSessionIds],
    },
    inputHashes,
    snapshotIds: snapshots.map((snapshot) => toText(snapshot.snapshotId)),
    segmentIds: segments.map((segment) => toText(segment.segmentId)),
    rawMaterialUsed: resolveK2MaterialUsedSourceCsv(historyEntry),
  };
  const captureSha256 = createStableJsonSha256(captureBundle);
  const fixtureEvidence = createFixtureEvidence({
    options,
    device,
    historyEntry,
    expectedSourceOrder,
    captureSha256,
    certificationPayload,
    sessionEvidence,
  });
  fixtureEvidence.print.printPlanId = printPlanId;
  const fixtureReceipt = evaluateItemKeeperSourceUsageLiveFixture({
    fixtureEvidence,
    printStartSnapshots: snapshots,
    jobMaterialSegments: segments,
    rawHistoryEntry: historyEntry,
  });
  const projectionDigests = segments.map((segment) => ({
    segmentId: toText(segment.segmentId),
    printJobId: resolvePrintJobId(segment),
    materialSourceId: toText(segment.materialSourceId),
    mountId: toText(segment.mountId),
    spoolId: toText(segment.spoolId),
    protocolToolAlias: toText(segment.protocolToolAlias),
    usedLengthMm: segment.usedLengthMm,
    usageState: toText(segment.usageState),
    projectionDigest: createItemKeeperSourceUsageProjectionCertificationDigest(segment),
  }));
  const warnings = createBuildWarnings({ device, snapshots, segments, historyEntry, certificationPayload });
  const reviewBlockers = createIdentityReviewBlockers({ device, certificationPayload, options, sessionEvidence });
  return {
    schemaVersion: 1,
    builder: "itemkeeper-source-usage-fixture-builder",
    status: reviewBlockers.length > 0
      ? "fixture-review-not-ready"
      : fixtureReceipt.ok ? "fixture-accepted" : "fixture-rejected",
    generatedAt: new Date().toISOString(),
    warnings,
    reviewBlockers,
    captureBundle,
    fixtureEvidence,
    fixtureReceipt,
    projectionDigests,
  };
}

/**
 * JSONファイルを読み込む。
 *
 * @private
 * @function readJsonFile
 * @param {string} filePath - JSONファイルpath。
 * @returns {Promise<Object>} parse済みJSON。
 */
async function readJsonFile(filePath) {
  return JSON.parse(await readFile(path.resolve(filePath), "utf8"));
}

/**
 * 入力ファイルのSHA-256を計算する。
 *
 * @private
 * @function createInputFileHash
 * @param {string} filePath - 入力ファイルpath。
 * @returns {Promise<Object>} 入力ファイルhash情報。
 */
async function createInputFileHash(filePath) {
  const resolvedPath = path.resolve(filePath);
  const content = await readFile(resolvedPath);
  return {
    path: resolvedPath,
    sha256: createSha256(content),
    bytes: content.length,
  };
}

/**
 * JSON artifactを書き出す。
 *
 * @private
 * @function writeJsonArtifact
 * @param {string} outputDir - 出力directory。
 * @param {string} filename - 出力ファイル名。
 * @param {*} payload - JSON payload。
 * @returns {Promise<Object>} 書き出し結果。
 */
async function writeJsonArtifact(outputDir, filename, payload) {
  const content = stringifyJsonFile(payload);
  const outputPath = path.join(outputDir, filename);
  await writeFile(outputPath, content, "utf8");
  return {
    filename,
    path: outputPath,
    sha256: createSha256(content),
    bytes: Buffer.byteLength(content, "utf8"),
  };
}

/**
 * CLI指定ファイルからfixture artifactを生成する。
 *
 * @function runItemKeeperSourceUsageFixtureBuilder
 * @param {Object} options - parseArgs済みCLI options。
 * @returns {Promise<Object>} build summary。
 * @example
 * const result = await runItemKeeperSourceUsageFixtureBuilder(parseArgs(process.argv.slice(2)));
 */
export async function runItemKeeperSourceUsageFixtureBuilder(options) {
  const exportPayload = await readJsonFile(options.exportPath);
  const certificationPayload = toText(options.certificationPath)
    ? await readJsonFile(options.certificationPath)
    : null;
  const inputHashes = {
    export: await createInputFileHash(options.exportPath),
    certification: toText(options.certificationPath)
      ? await createInputFileHash(options.certificationPath)
      : null,
  };
  const result = buildItemKeeperSourceUsageFixture({
    exportPayload,
    certificationPayload,
    options,
    inputHashes,
  });
  const outputDir = path.resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const evidenceArtifact = await writeJsonArtifact(outputDir, "fixture-evidence.json", result.fixtureEvidence);
  const receiptArtifact = await writeJsonArtifact(outputDir, "fixture-receipt.json", result.fixtureReceipt);
  const projectionArtifact = await writeJsonArtifact(outputDir, "projection-digests.json", result.projectionDigests);
  const manifest = {
    schemaVersion: 1,
    authority: "itemkeeper-source-usage-capture-manifest",
    generatedAt: result.generatedAt,
    status: result.status,
    captureSha256: result.fixtureEvidence.artifact.captureSha256,
    fixtureDigest: result.fixtureReceipt.fixtureDigest,
    fixtureAccepted: result.fixtureReceipt.ok,
    reviewedCommit: result.fixtureEvidence.reviewedCommit,
    device: result.fixtureEvidence.device,
    print: result.fixtureEvidence.print,
    inputArtifacts: inputHashes,
    generatedArtifacts: {
      fixtureEvidence: evidenceArtifact,
      fixtureReceipt: receiptArtifact,
      projectionDigests: projectionArtifact,
    },
    warnings: result.warnings,
    errors: result.fixtureReceipt.errors,
  };
  const manifestArtifact = await writeJsonArtifact(outputDir, "capture-manifest.json", manifest);
  return {
    schemaVersion: 1,
    builder: result.builder,
    status: result.status,
    outputDir,
    fixtureAccepted: result.fixtureReceipt.ok,
    fixtureDigest: result.fixtureReceipt.fixtureDigest,
    captureSha256: result.fixtureEvidence.artifact.captureSha256,
    manifestSha256: manifestArtifact.sha256,
    artifacts: {
      fixtureEvidence: evidenceArtifact,
      fixtureReceipt: receiptArtifact,
      projectionDigests: projectionArtifact,
      captureManifest: manifestArtifact,
    },
    warnings: result.warnings,
    errors: result.fixtureReceipt.errors,
  };
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "")) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(USAGE.trim());
      process.exit(0);
    }
    const result = await runItemKeeperSourceUsageFixtureBuilder(options);
    console.log(JSON.stringify(result, null, options.pretty ? 2 : 0));
  } catch (error) {
    console.error(error?.message || String(error));
    console.error(USAGE.trim());
    process.exit(1);
  }
}
