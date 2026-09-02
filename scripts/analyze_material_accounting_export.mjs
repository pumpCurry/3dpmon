#!/usr/bin/env node
/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 MaterialSource accounting export analyzer
 * @file analyze_material_accounting_export.mjs
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module analyze_material_accounting_export
 *
 * 【機能内容サマリ】
 * - 3DPmon export JSONからK1/K2/CFS/CFS-CのMaterialSource accounting状態をread-only診断する
 * - legacy 1 device / 1 spool割当とUniversal source別SpoolMountを分離して表示する
 * - Gate 18.9I live certificationへ提出しやすいsummary/reason/warningを生成する
 *
 * 【公開関数一覧】
 * - {@link parseArgs}：CLI引数を解析
 * - {@link analyzeMaterialAccountingExport}：export payloadを診断reportへ変換
 * - {@link runMaterialAccountingExportAnalyzer}：CLI指定のJSONを読み込みreportを出力
 *
 * @version 1.390.1653 (PR #440)
 * @since   1.390.1620 (PR #440)
 * @lastModified 2026-09-02 16:45:11
 * -----------------------------------------------------------
 * @todo
 * - Gate 18.9I live certification fixtureが増えた後、known-good result setとの比較modeを追加する
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPrinterCoreV3DeterministicId,
  stableStringifyPrinterCoreV3Value,
} from "../3dp_lib/printer_core/dashboard_data_schema_v3.js";
import {
  parseK2MaterialUsedSourceCsv,
  resolveK2MaterialUsedSourceCsv,
} from "../3dp_lib/printer_core/dashboard_material_used_csv_parser.js";
import {
  doesCfsDeviceMatchCorrelationEvidence,
  doesCfsSessionMatchCorrelationEvidence,
  normalizeCfsDeviceCorrelationEvidence,
  normalizeCfsSessionCorrelationEvidence,
} from "../3dp_lib/printer_core/dashboard_cfs_session_correlation.js";

/**
 * ItemKeeper source-aware projectionのmodule-owned認証authority名。
 *
 * @constant {string}
 */
const ITEMKEEPER_SOURCE_USAGE_PROJECTION_AUTHORITY = "module-owned-live-certification-registry";

/**
 * ItemKeeper source usage live fixture receiptのauthority名。
 *
 * @constant {string}
 */
const ITEMKEEPER_SOURCE_USAGE_LIVE_FIXTURE_AUTHORITY = "itemkeeper-source-usage-live-fixture-evidence";

/**
 * CLI usage text。
 *
 * 【詳細説明】
 * - このanalyzerはexport/certification JSONを読むだけで、3DPmon storageや実機へは接続しない。
 *
 * @constant {string}
 */
const USAGE = `Usage:
  node scripts/analyze_material_accounting_export.mjs --export <3dpmon_export.json> [--certification <cfs-certification.json>] [--pretty]

Options:
  --export <path>         3DPmon all-data export JSON. Required.
  --certification <path>  Optional CFS certification panel export JSON.
  --output <path>         Optional report JSON output path.
  --pretty                Pretty-print stdout JSON.
  --help                  Show this help.
`;

/**
 * 任意値を空白除去済み文字列へ変換する。
 *
 * 【詳細説明】
 * - exportには古いschemaの値も混在するため、null/undefinedを空文字として扱う。
 *
 * @private
 * @function toText
 * @param {*} value - 文字列候補。
 * @returns {string} 空白除去済み文字列。
 */
function toText(value) {
  return String(value ?? "").trim();
}

/**
 * 任意値を有限数へ変換する。
 *
 * 【詳細説明】
 * - percentやslot番号のようなprotocol値は文字列で来る場合があるため、Number変換を許す。
 *
 * @private
 * @function toFiniteNumberOrNull
 * @param {*} value - 数値候補。
 * @returns {number|null} 有限数、またはnull。
 */
function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * export rootを取得する。
 *
 * 【詳細説明】
 * - 3DPmon exportはroot直下にdataを置く版と、root自体がmonitorData相当の版がある。
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
 * collection値を配列へ正規化する。
 *
 * 【詳細説明】
 * - export内のspoolやstoreは配列/辞書の両方があり得るため、diagnosticでは値配列へ寄せる。
 *
 * @private
 * @function valuesOfCollection
 * @param {*} collection - 配列またはobject辞書。
 * @returns {Array<Object>} object要素配列。
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
 * collection値を文字列候補も含む配列へ正規化する。
 *
 * 【詳細説明】
 * - MaterialSource aliasは`string[]`として保存されるため、object専用の`valuesOfCollection()`では落ちる。
 * - analyzerはread-only診断なので、ここでは文字列/数値/objectを保持し、呼び出し側で`toText()`へ寄せる。
 *
 * @private
 * @function valuesOfAnyCollection
 * @param {*} collection - 配列またはobject辞書。
 * @returns {Array<*>} collection内の値配列。
 */
function valuesOfAnyCollection(collection) {
  if (Array.isArray(collection)) {
    return collection.filter((entry) => entry !== null && entry !== undefined);
  }
  if (collection && typeof collection === "object") {
    return Object.values(collection).filter((entry) => entry !== null && entry !== undefined);
  }
  return [];
}

/**
 * candidate値をsource ID lookupへ追加する。
 *
 * 【詳細説明】
 * - candidateがobjectの場合は、sourceId/materialSourceId/id/value/key/nameもID候補として読む。
 * - candidateが文字列の場合は、そのままaliasとして追加する。
 *
 * @private
 * @function addSourceLookupCandidate
 * @param {Set<string>} ids - 追加先ID集合。
 * @param {*} candidate - ID候補。
 * @returns {void}
 */
function addSourceLookupCandidate(ids, candidate) {
  if (candidate && typeof candidate === "object") {
    [
      candidate.materialSourceId,
      candidate.sourceId,
      candidate.id,
      candidate.value,
      candidate.key,
      candidate.name,
    ].forEach((value) => {
      const text = toText(value);
      if (text) {
        ids.add(text);
      }
    });
    return;
  }
  const text = toText(candidate);
  if (text) {
    ids.add(text);
  }
}

/**
 * source/mount/segmentのID候補をcanonical IDとalias込みで収集する。
 *
 * 【詳細説明】
 * - exportにはraw protocol sourceId、Universal MaterialSource ID、open時binding aliasが混在する。
 * - reviewer向けdiagnosticでは同じ物理sourceを誤ってmissing扱いしないよう、保存済みaliasを全てlookup対象にする。
 *
 * @private
 * @function collectSourceLookupIds
 * @param {Object|null|undefined} record - MaterialSource / SpoolMount / JobMaterialSegment 候補。
 * @returns {Set<string>} lookup ID集合。
 */
function collectSourceLookupIds(record) {
  const ids = new Set();
  [
    record?.materialSourceId,
    record?.sourceId,
    record?.id,
    record?.sourceBindingAtOpen?.materialSourceId,
    record?.sourceBindingAtOpen?.sourceId,
    record?.sourceBindingAtOpen?.id,
    record?.materialSource?.materialSourceId,
    record?.materialSource?.sourceId,
    record?.materialSource?.id,
    record?.materialSourceSnapshot?.materialSourceId,
    record?.materialSourceSnapshot?.sourceId,
    record?.materialSourceSnapshot?.id,
  ].forEach((candidate) => addSourceLookupCandidate(ids, candidate));
  [
    record?.aliases,
    record?.sourceAliases,
    record?.sourceIdentity?.aliases,
    record?.sourceBindingAtOpen?.aliases,
    record?.materialSource?.aliases,
    record?.materialSourceSnapshot?.aliases,
  ].forEach((collection) => {
    valuesOfAnyCollection(collection).forEach((candidate) => addSourceLookupCandidate(ids, candidate));
  });
  return ids;
}

/**
 * canonical MaterialSource ID候補を収集する。
 *
 * 【詳細説明】
 * - raw source aliasだけで別deviceのsourceへ誤joinしないよう、canonical ID一致を別扱いする。
 *
 * @private
 * @function collectCanonicalMaterialSourceIds
 * @param {Object|null|undefined} record - MaterialSource / SpoolMount / JobMaterialSegment 候補。
 * @returns {Set<string>} canonical MaterialSource ID候補集合。
 */
function collectCanonicalMaterialSourceIds(record) {
  const ids = new Set();
  [
    record?.materialSourceId,
    record?.sourceBindingAtOpen?.materialSourceId,
    record?.materialSource?.materialSourceId,
    record?.materialSourceSnapshot?.materialSourceId,
  ].forEach((candidate) => {
    const text = toText(candidate);
    if (text) {
      ids.add(text);
    }
  });
  return ids;
}

/**
 * recordに保存されたdevice scopeを取得する。
 *
 * 【詳細説明】
 * - SpoolMountはopen時bindingにdeviceIdを持つため、alias joinではこのscopeを優先して見る。
 *
 * @private
 * @function resolveRecordDeviceId
 * @param {Object|null|undefined} record - source/mount/segment候補。
 * @returns {string} deviceId候補。
 */
function resolveRecordDeviceId(record) {
  return toText(
    record?.deviceId ||
    record?.sourceBindingAtOpen?.deviceId ||
    record?.materialSource?.deviceId ||
    record?.materialSourceSnapshot?.deviceId
  );
}

/**
 * 2つのID集合に共通要素があるか判定する。
 *
 * @private
 * @function hasSharedId
 * @param {Set<string>} left - 左辺ID集合。
 * @param {Set<string>} right - 右辺ID集合。
 * @returns {boolean} 共通IDがある場合true。
 */
function hasSharedId(left, right) {
  for (const id of left) {
    if (right.has(id)) {
      return true;
    }
  }
  return false;
}

/**
 * connection targetからPrinter Core v3 device IDを取得する。
 *
 * 【詳細説明】
 * - K2のWi-Fi運用ではMACが有線側になる場合があるため、MACではなくserial由来deviceIdSeedを優先する。
 *
 * @private
 * @function resolveTargetDeviceId
 * @param {Object|null|undefined} target - connectionTargets[]要素。
 * @param {Object|null|undefined} machine - monitorData.machines[hostname]。
 * @returns {string} deviceId候補。未取得時は空文字。
 */
function resolveTargetDeviceId(target, machine) {
  return toText(
    machine?.runtimeData?.printerCoreV3Shadow?.deviceId ||
    machine?.printerCoreV3Identity?.deviceId ||
    machine?.printerCoreV3Identity?.deviceIdSeed ||
    target?.printerCoreV3Identity?.deviceId ||
    target?.printerCoreV3Identity?.deviceIdSeed
  );
}

/**
 * MaterialSource表示名を生成する。
 *
 * 【詳細説明】
 * - durable IDやassignment aliasではなく、人間がレビューしやすいCFS slot名を優先する。
 *
 * @private
 * @function createSourceDisplayLabel
 * @param {Object} source - MaterialSource観測record。
 * @returns {string} 表示名。
 */
function createSourceDisplayLabel(source) {
  const label = toText(source.displayLabel || source.protocolSlotLabel || source.physicalLabel);
  if (label) {
    return label;
  }
  const kind = toText(source.kind);
  if (kind === "external-spool") {
    return "external";
  }
  const unitIndex = toFiniteNumberOrNull(source.unitIndex ?? source.boxId);
  const slotId = toFiniteNumberOrNull(source.slotId ?? source.protocolSlotId);
  if (unitIndex !== null && slotId !== null) {
    return `${unitIndex}${String.fromCharCode(65 + slotId)}`;
  }
  return toText(source.materialSourceId || source.sourceId) || "(unknown source)";
}

/**
 * MaterialSourceのpresenceを取得する。
 *
 * 【詳細説明】
 * - 新旧schema差異を吸収し、loaded/empty/unobserved/unknownの表示用文字列へ寄せる。
 *
 * @private
 * @function resolveSourcePresence
 * @param {Object} source - MaterialSource観測record。
 * @returns {string} presence。
 */
function resolveSourcePresence(source) {
  return toText(source.status?.presence || source.presence || source.materialPresence || "unknown") || "unknown";
}

/**
 * sourceに対応するopen mountを抽出する。
 *
 * 【詳細説明】
 * - canonical MaterialSource IDとtransport-local source aliasの両方を見る。
 * - mount側のsourceBindingAtOpen.aliasesにも過去aliasが残るため、そこも診断対象にする。
 *
 * @private
 * @function findOpenMountsForSource
 * @param {Object} source - MaterialSource観測record。
 * @param {Array<Object>} openMounts - OPEN SpoolMount配列。
 * @param {string=} deviceId - Printer Core v3 device ID。
 * @returns {Array<Object>} sourceに対応するOPEN mount配列。
 */
function findOpenMountsForSource(source, openMounts, deviceId = "") {
  const ids = collectSourceLookupIds(source);
  const canonicalIds = collectCanonicalMaterialSourceIds(source);
  return openMounts.filter((mount) => {
    const mountDeviceId = resolveRecordDeviceId(mount);
    if (deviceId && mountDeviceId && mountDeviceId !== deviceId) {
      return false;
    }
    const mountSourceIds = collectSourceLookupIds(mount);
    if (!hasSharedId(ids, mountSourceIds)) {
      return false;
    }
    if (hasSharedId(canonicalIds, collectCanonicalMaterialSourceIds(mount))) {
      return true;
    }
    return Boolean(deviceId && mountDeviceId === deviceId);
  });
}

/**
 * source-specific usage segmentをsource別に抽出する。
 *
 * 【詳細説明】
 * - printJobIdだけでは複数機器で衝突し得るため、deviceIdが入っているsegmentはdeviceIdも照合する。
 *
 * @private
 * @function findSegmentsForSource
 * @param {Object} source - MaterialSource観測record。
 * @param {Array<Object>} segments - JobMaterialSegment配列。
 * @param {string} deviceId - Printer Core v3 device ID。
 * @returns {Array<Object>} sourceに対応するsegment配列。
 */
function findSegmentsForSource(source, segments, deviceId) {
  const ids = collectSourceLookupIds(source);
  const canonicalIds = collectCanonicalMaterialSourceIds(source);
  return segments.filter((segment) => {
    const segmentDeviceId = toText(segment.deviceId);
    if (segmentDeviceId && deviceId && segmentDeviceId !== deviceId) {
      return false;
    }
    const segmentSourceIds = collectSourceLookupIds(segment);
    if (!hasSharedId(ids, segmentSourceIds)) {
      return false;
    }
    if (hasSharedId(canonicalIds, collectCanonicalMaterialSourceIds(segment))) {
      return true;
    }
    return Boolean(deviceId && segmentDeviceId === deviceId);
  });
}

/**
 * print-start snapshot / segmentからPrintJob IDを取得する。
 *
 * 【詳細説明】
 * - exportには`printJobId`/`jobId`/`printId`の揺れがあるため、ItemKeeper projection診断では
 *   これらを同じジョブID候補として扱う。
 *
 * @private
 * @function resolvePrintJobId
 * @param {Object|null|undefined} record - print-start snapshot または JobMaterialSegment。
 * @returns {string} PrintJob ID候補。
 */
function resolvePrintJobId(record) {
  return toText(record?.printJobId || record?.jobId || record?.printId || record?.id);
}

/**
 * ItemKeeper projection digest用の使用量を厳密に正規化する。
 *
 * 【詳細説明】
 * - `Number(null)`や`Number("")`を使うとunknownと0mmが同じdigestになるため、
 *   analyzerでもruntimeと同じkind付きpayloadへ寄せる。
 * - analyzerのeligible判定自体は別途`toFiniteNumberOrNull()`で非負数値だけを許可する。
 *
 * @private
 * @function normalizeItemKeeperProjectionUsedLengthForDigest
 * @param {*} value - JobMaterialSegment.usedLengthMm のraw値。
 * @returns {{kind:string,value?:number,raw?:string}} digestへ入れる正規化値。
 */
function normalizeItemKeeperProjectionUsedLengthForDigest(value) {
  if (value === undefined) {
    return Object.freeze({ kind: "missing" });
  }
  if (value === null) {
    return Object.freeze({ kind: "null" });
  }
  if (typeof value === "string" && value.trim() === "") {
    return Object.freeze({ kind: "empty-string" });
  }
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return Object.freeze({ kind: "invalid", raw: String(value) });
  }
  return Object.freeze({ kind: "finite", value: numericValue });
}

/**
 * ItemKeeper source-aware projection認証用の意味payloadを生成する。
 *
 * 【詳細説明】
 * - Runtime側と同じsource/slot/spool/usage意味をdigest入力にし、export analyzerでも
 *   plain `status:"certified"` をready evidenceとして扱わない。
 * - Analyzerはprocess-local registryを持たないため、authority名とdigest整合だけを
 *   read-only診断する。
 *
 * @private
 * @function createItemKeeperProjectionCertificationPayload
 * @param {Object|null|undefined} segment - JobMaterialSegment候補。
 * @returns {Object} 認証digest用payload。
 */
function createItemKeeperProjectionCertificationPayload(segment) {
  return {
    segmentId: toText(segment?.segmentId),
    printJobId: resolvePrintJobId(segment),
    printPlanId: toText(segment?.printPlanId),
    deviceId: toText(segment?.deviceId),
    spoolId: toText(segment?.spoolId),
    mountId: toText(segment?.mountId),
    materialSourceId: toText(segment?.materialSourceId),
    protocolToolAlias: toText(segment?.protocolToolAlias),
    usedLengthMm: normalizeItemKeeperProjectionUsedLengthForDigest(segment?.usedLengthMm),
    usageState: toText(segment?.usageState),
    confidence: toText(segment?.confidence),
    order: Number.isFinite(Number(segment?.order)) ? Number(segment.order) : 0,
    debitStatus: toText(segment?.debit?.status),
  };
}

/**
 * ItemKeeper source-aware projection認証digestを生成する。
 *
 * @private
 * @function createItemKeeperProjectionCertificationDigest
 * @param {Object|null|undefined} segment - JobMaterialSegment候補。
 * @returns {string} 認証digest。
 */
function createItemKeeperProjectionCertificationDigest(segment) {
  return `fnv1a128:${createPrinterCoreV3DeterministicId(
    "itemkeeper-source-usage-projection-certification",
    [stableStringifyPrinterCoreV3Value(createItemKeeperProjectionCertificationPayload(segment))]
  )}`;
}

/**
 * export上のItemKeeper source-aware projection証跡種別を判定する。
 *
 * @private
 * @function getItemKeeperProjectionEvidenceStatus
 * @param {Object|null|undefined} segment - JobMaterialSegment候補。
 * @returns {string} `digest-consistent` / `fixture-accepted` / `none` のいずれか。
 */
function getItemKeeperProjectionEvidenceStatus(segment) {
  const projection = segment?.itemKeeperProjection || {};
  if (
    toText(projection.status) === "fixture-accepted" &&
    toText(projection.authority) === ITEMKEEPER_SOURCE_USAGE_LIVE_FIXTURE_AUTHORITY
  ) {
    return "fixture-accepted";
  }
  const expectedDigest = createItemKeeperProjectionCertificationDigest(segment);
  if (
    toText(projection.status) === "certified" &&
    toText(projection.authority) === ITEMKEEPER_SOURCE_USAGE_PROJECTION_AUTHORITY &&
    toText(projection.digest) === expectedDigest
  ) {
    return "digest-consistent";
  }
  return "none";
}

/**
 * segmentがItemKeeper projection digest-consistent evidence条件を満たすか判定する。
 *
 * 【詳細説明】
 * - export analyzerはread-only JSONだけを読むため、process-local registry membershipは証明できない。
 * - そのためここではruntime projection可能とは言わず、authority/digestがsegment内容と整合する
 *   read-only evidenceだけを数える。
 *
 * @private
 * @function isItemKeeperDigestConsistentSegment
 * @param {Object|null|undefined} segment - JobMaterialSegment候補。
 * @param {string} deviceId - Printer Core v3 device ID。
 * @returns {boolean} digest-consistent evidenceとして数えられるsegmentならtrue。
 */
function isItemKeeperDigestConsistentSegment(segment, deviceId) {
  const segmentDeviceId = toText(segment?.deviceId);
  const usageState = toText(segment?.usageState);
  const usedLengthMm = toFiniteNumberOrNull(segment?.usedLengthMm);
  const debitStatus = toText(segment?.debit?.status);
  if (!segment || typeof segment !== "object") {
    return false;
  }
  if (!deviceId || !segmentDeviceId || segmentDeviceId !== deviceId) {
    return false;
  }
  return Boolean(
    resolvePrintJobId(segment) &&
    toText(segment.spoolId) &&
    ["observed-used", "confirmed-unused"].includes(usageState) &&
    debitStatus === "eligible" &&
    getItemKeeperProjectionEvidenceStatus(segment) === "digest-consistent" &&
    usedLengthMm !== null &&
    usedLengthMm >= 0
  );
}

/**
 * source-specific segmentをItemKeeper fixture receipt条件で抽出する。
 *
 * 【詳細説明】
 * - fixture receiptはreview可能な証拠だがruntime registry membershipではない。
 * - 誤って`segment.itemKeeperProjection`へコピーされたfixture receiptを、production投影可能な
 *   certificationとして数えないため、digest-consistent/runtime-certifiedとは別枠で出す。
 *
 * @private
 * @function isItemKeeperFixtureAcceptedSegment
 * @param {Object|null|undefined} segment - JobMaterialSegment候補。
 * @param {string} deviceId - Printer Core v3 device ID。
 * @returns {boolean} fixture-accepted evidenceとして数えられるsegmentならtrue。
 */
function isItemKeeperFixtureAcceptedSegment(segment, deviceId) {
  const segmentDeviceId = toText(segment?.deviceId);
  if (!segment || typeof segment !== "object") {
    return false;
  }
  if (!deviceId || !segmentDeviceId || segmentDeviceId !== deviceId) {
    return false;
  }
  return Boolean(
    resolvePrintJobId(segment) &&
    getItemKeeperProjectionEvidenceStatus(segment) === "fixture-accepted"
  );
}

/**
 * segmentのprintPlan IDを取得する。
 *
 * @private
 * @function resolvePrintPlanId
 * @param {Object|null|undefined} record - snapshotまたはsegment候補。
 * @returns {string} PrintPlan ID。
 */
function resolvePrintPlanId(record) {
  return toText(record?.printPlanId || record?.planId);
}

/**
 * snapshot/segment/historyに残るsession IDを取得する。
 *
 * 【詳細説明】
 * - live captureでは同一deviceでも再接続を跨ぐと別sessionになり得るため、certification exportとの
 *   突き合わせに使える観測値を同一keyへ寄せる。
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
 * snapshotまたはsegmentのsource orderを取得する。
 *
 * @private
 * @function resolveSourceOrder
 * @param {Object|null|undefined} record - snapshotまたはsegment候補。
 * @returns {number|null} source order。
 */
function resolveSourceOrder(record) {
  const value = record?.bindingAuthority?.tool?.order ?? record?.order;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
}

/**
 * snapshotまたはsegmentのMaterialSource IDを取得する。
 *
 * @private
 * @function resolveBindingMaterialSourceId
 * @param {Object|null|undefined} record - snapshotまたはsegment候補。
 * @returns {string} MaterialSource ID。
 */
function resolveBindingMaterialSourceId(record) {
  return toText(record?.bindingAuthority?.source?.materialSourceId || record?.materialSourceId);
}

/**
 * snapshotまたはsegmentのmount IDを取得する。
 *
 * @private
 * @function resolveBindingMountId
 * @param {Object|null|undefined} record - snapshotまたはsegment候補。
 * @returns {string} mount ID。
 */
function resolveBindingMountId(record) {
  return toText(record?.bindingAuthority?.mount?.mountId || record?.mountId);
}

/**
 * snapshotまたはsegmentのspool IDを取得する。
 *
 * @private
 * @function resolveBindingSpoolId
 * @param {Object|null|undefined} record - snapshotまたはsegment候補。
 * @returns {string} spool ID。
 */
function resolveBindingSpoolId(record) {
  return toText(record?.bindingAuthority?.mount?.spoolId || record?.spoolId);
}

/**
 * segmentに対応するtrusted print-start snapshotが同一result setにあるか判定する。
 *
 * 【詳細説明】
 * - J-2 capture readinessは別jobのsnapshot/segmentを寄せ集めない。
 * - device、print job、print plan、source、mount、spool、orderが一致するsnapshotだけを対応証跡として扱う。
 *
 * @private
 * @function hasMatchingPrintStartSnapshotForSegment
 * @param {Object|null|undefined} segment - JobMaterialSegment候補。
 * @param {Object[]} snapshots - print-start snapshot配列。
 * @returns {boolean} 対応snapshotがある場合true。
 */
function hasMatchingPrintStartSnapshotForSegment(segment, snapshots) {
  return snapshots.some((snapshot) => (
    toText(snapshot.deviceId) === toText(segment?.deviceId) &&
    resolvePrintJobId(snapshot) === resolvePrintJobId(segment) &&
    resolvePrintPlanId(snapshot) === resolvePrintPlanId(segment) &&
    resolveBindingMaterialSourceId(snapshot) === resolveBindingMaterialSourceId(segment) &&
    resolveBindingMountId(snapshot) === resolveBindingMountId(segment) &&
    resolveBindingSpoolId(snapshot) === resolveBindingSpoolId(segment) &&
    resolveSourceOrder(snapshot) === resolveSourceOrder(segment)
  ));
}

/**
 * segmentがpre-issuer fixture reviewへ提出できるprojection候補か判定する。
 *
 * 【詳細説明】
 * - production ItemKeeper registryが空のcapture前段階では、`itemKeeperProjection.status:"certified"`を要求しない。
 * - 代わりにsource-aware projection digestを生成できるだけのsource/spool/usage/print-start対応を確認する。
 *
 * @private
 * @function isReviewableProjectionCandidateSegment
 * @param {Object|null|undefined} segment - JobMaterialSegment候補。
 * @param {string} deviceId - Printer Core v3 device ID。
 * @param {Object[]} snapshots - 同一deviceのprint-start snapshot配列。
 * @returns {boolean} reviewable projection候補ならtrue。
 */
function isReviewableProjectionCandidateSegment(segment, deviceId, snapshots) {
  const segmentDeviceId = toText(segment?.deviceId);
  const usageState = toText(segment?.usageState);
  const usedLengthMm = toFiniteNumberOrNull(segment?.usedLengthMm);
  const debitStatus = toText(segment?.debit?.status);
  if (!segment || typeof segment !== "object") {
    return false;
  }
  if (!deviceId || !segmentDeviceId || segmentDeviceId !== deviceId) {
    return false;
  }
  const usageLengthAllowed =
    (usageState === "observed-used" && usedLengthMm !== null && usedLengthMm > 0) ||
    (usageState === "confirmed-unused" && usedLengthMm === 0);
  return Boolean(
    resolvePrintJobId(segment) &&
    resolvePrintPlanId(segment) &&
    toText(segment.spoolId) &&
    toText(segment.mountId) &&
    toText(segment.materialSourceId) &&
    usageLengthAllowed &&
    debitStatus === "eligible" &&
    hasMatchingPrintStartSnapshotForSegment(segment, snapshots)
  );
}

/**
 * print binding job keyを作成する。
 *
 * @private
 * @function createPrintBindingJobKey
 * @param {Object|null|undefined} record - snapshotまたはsegment候補。
 * @returns {string} device + job + plan key。
 */
function createPrintBindingJobKey(record) {
  return [
    toText(record?.deviceId),
    resolvePrintJobId(record),
    resolvePrintPlanId(record),
  ].join("\u0000");
}

/**
 * JobMaterialSegmentへ保存されたcompletion raw CSV証跡を取得する。
 *
 * 【詳細説明】
 * - 印刷履歴は保持上限により削除される場合があるため、Gate 18.9J-2 fixture判定では
 *   segment側に保存されたcompletionEvidenceを履歴CSVの代替証跡として扱う。
 * - 同一job内で複数のraw CSVが混ざる場合は、後続のparserで偶然readyにならないよう
 *   conflict理由を返し、raw CSVは採用しない。
 *
 * @private
 * @function resolveSegmentCompletionMaterialUsedCsv
 * @param {Object[]} segments - JobMaterialSegment配列。
 * @returns {{rawMaterialUsed:string,reasons:string[]}} segment completion evidence。
 */
function resolveSegmentCompletionMaterialUsedCsv(segments) {
  const rawValues = [...new Set((Array.isArray(segments) ? segments : [])
    .map((segment) => toText(segment?.evidence?.completionEvidence?.rawMaterialUsed))
    .filter(Boolean))];
  if (rawValues.length === 0) {
    return { rawMaterialUsed: "", reasons: [] };
  }
  if (rawValues.length > 1) {
    return { rawMaterialUsed: "", reasons: ["raw-material-used-completion-evidence-conflict"] };
  }
  return { rawMaterialUsed: rawValues[0], reasons: [] };
}

/**
 * print binding evidenceを同一print result set単位へ集約する。
 *
 * @private
 * @function createPrintBindingCandidateJobs
 * @param {Object[]} snapshots - 対象device snapshot配列。
 * @param {Object[]} segments - 対象device segment配列。
 * @param {string} deviceId - Printer Core v3 device ID。
 * @param {Object[]=} histories - 対象machineのprint history配列。
 * @returns {Object[]} candidate job summary配列。
 */
function createPrintBindingCandidateJobs(snapshots, segments, deviceId, histories = []) {
  const groups = new Map();
  const ensureGroup = (record) => {
    const key = createPrintBindingJobKey(record);
    if (!groups.has(key)) {
      groups.set(key, {
        deviceId: toText(record?.deviceId),
        printJobId: resolvePrintJobId(record),
        printPlanId: resolvePrintPlanId(record),
        snapshots: [],
        segments: [],
        histories: [],
      });
    }
    return groups.get(key);
  };
  snapshots.forEach((snapshot) => ensureGroup(snapshot).snapshots.push(snapshot));
  segments.forEach((segment) => ensureGroup(segment).segments.push(segment));
  for (const history of histories) {
    const historyPrintJobId = resolvePrintJobId(history);
    const historyPrintPlanId = resolvePrintPlanId(history);
    for (const group of groups.values()) {
      if (historyPrintJobId !== group.printJobId) {
        continue;
      }
      if (historyPrintPlanId && group.printPlanId && historyPrintPlanId !== group.printPlanId) {
        continue;
      }
      group.histories.push(history);
    }
  }
  return [...groups.values()]
    .filter((group) => group.deviceId === deviceId && group.printJobId && group.printPlanId)
    .map((group) => {
      const sessionIds = [...new Set(group.snapshots.map(resolveRecordSessionId).filter(Boolean))];
      const observedOtherSessionIds = [...new Set([
        ...group.segments.map(resolveRecordSessionId),
        ...group.histories.map(resolveRecordSessionId),
      ].filter(Boolean))];
      const rawHistoryEntry = group.histories.find((history) => Boolean(resolveK2MaterialUsedSourceCsv(history))) || null;
      const segmentCompletionEvidence = rawHistoryEntry
        ? { rawMaterialUsed: "", reasons: [] }
        : resolveSegmentCompletionMaterialUsedCsv(group.segments);
      const parsedMaterialUsed = parseK2MaterialUsedSourceCsv(
        resolveK2MaterialUsedSourceCsv(rawHistoryEntry) || segmentCompletionEvidence.rawMaterialUsed,
        {
          expectedCount: group.snapshots.length,
          requireWhenMultiple: group.snapshots.length > 1 || group.segments.length > 1,
        },
      );
      const rawMaterialUsedParserReasons = [
        ...parsedMaterialUsed.reasons,
        ...segmentCompletionEvidence.reasons,
      ];
      const observedUsedSegments = group.segments.filter((segment) => (
        toText(segment.usageState) === "observed-used" &&
        toFiniteNumberOrNull(segment.usedLengthMm) !== null &&
        toFiniteNumberOrNull(segment.usedLengthMm) > 0
      ));
      const invalidObservedUsedSegments = group.segments.filter((segment) => (
        toText(segment.usageState) === "observed-used" &&
        (
          toFiniteNumberOrNull(segment.usedLengthMm) === null ||
          toFiniteNumberOrNull(segment.usedLengthMm) <= 0
        )
      ));
      const confirmedUnusedSegments = group.segments.filter((segment) => (
        toText(segment.usageState) === "confirmed-unused" &&
        toFiniteNumberOrNull(segment.usedLengthMm) === 0
      ));
      const invalidConfirmedUnusedSegments = group.segments.filter((segment) => (
        toText(segment.usageState) === "confirmed-unused" &&
        toFiniteNumberOrNull(segment.usedLengthMm) !== 0
      ));
      const reviewableProjectionCandidateSegments = group.segments.filter((segment) => (
        isReviewableProjectionCandidateSegment(segment, deviceId, group.snapshots)
      ));
      return {
        deviceId: group.deviceId,
        printJobId: group.printJobId,
        printPlanId: group.printPlanId,
        sessionIds,
        observedOtherSessionIds,
        printStartSnapshotCount: group.snapshots.length,
        jobMaterialSegmentCount: group.segments.length,
        rawMaterialUsedPresent: Boolean(parsedMaterialUsed.rawMaterialUsed),
        rawMaterialUsedSourceCount: parsedMaterialUsed.parts.length,
        rawMaterialUsedParserReasons: [...new Set(rawMaterialUsedParserReasons)],
        observedUsedSegmentCount: observedUsedSegments.length,
        invalidObservedUsedSegmentCount: invalidObservedUsedSegments.length,
        confirmedUnusedSegmentCount: confirmedUnusedSegments.length,
        invalidConfirmedUnusedSegmentCount: invalidConfirmedUnusedSegments.length,
        reviewableProjectionCandidateSegmentCount: reviewableProjectionCandidateSegments.length,
        itemKeeperDigestConsistentSegmentCount: group.segments.filter((segment) => (
          isItemKeeperDigestConsistentSegment(segment, deviceId) &&
          hasMatchingPrintStartSnapshotForSegment(segment, group.snapshots)
        )).length,
      };
    });
}

/**
 * source-specific segmentをItemKeeper evidence条件で抽出する。
 *
 * 【詳細説明】
 * - print-start snapshotと同じPrintJob IDを持つsegmentだけをread-only証跡にする。
 * - snapshotが存在しないsegmentは、後から履歴だけで偶然混ざった可能性があるためGate18.9I readyには使わない。
 *
 * @private
 * @function findItemKeeperEvidenceSegmentsForSource
 * @param {Object} source - MaterialSource観測record。
 * @param {Array<Object>} segments - JobMaterialSegment配列。
 * @param {string} deviceId - Printer Core v3 device ID。
 * @param {Array<Object>} snapshots - print-start snapshot配列。
 * @param {Function} predicate - evidence種別ごとの判定関数。
 * @returns {Array<Object>} source-specific evidence segment配列。
 */
function findItemKeeperEvidenceSegmentsForSource(source, segments, deviceId, snapshots, predicate) {
  const snapshotJobIds = new Set(
    snapshots
      .filter((snapshot) => {
        const snapshotDeviceId = toText(snapshot.deviceId);
        return Boolean(deviceId && snapshotDeviceId && snapshotDeviceId === deviceId);
      })
      .map(resolvePrintJobId)
      .filter(Boolean)
  );
  if (snapshotJobIds.size === 0) {
    return [];
  }
  return findSegmentsForSource(source, segments, deviceId)
    .filter((segment) => predicate(segment, deviceId))
    .filter((segment) => snapshotJobIds.has(resolvePrintJobId(segment)));
}

/**
 * connection targetがmulti-source material systemを期待するか判定する。
 *
 * 【詳細説明】
 * - K1 legacy direct spoolは現時点では1 device / 1 spool互換が正常系であり、MaterialSource未観測を
 *   Gate 18.9Iの警告にはしない。
 * - K2、CFS/CFS-C provider、CFS unit数がある設定はmulti-sourceとして診断対象にする。
 *
 * @private
 * @function isMultiSourceTarget
 * @param {Object|null|undefined} target - connection target。
 * @returns {boolean} multi-source対象ならtrue。
 */
function isMultiSourceTarget(target) {
  const printerType = toText(target?.printerType);
  const materialSystem = target?.materialSystem || {};
  const provider = toText(materialSystem.provider || materialSystem.mode);
  const unitLimit = toFiniteNumberOrNull(materialSystem.unitLimit);
  const externalSourceLimit = toFiniteNumberOrNull(materialSystem.externalSourceLimit);
  if (printerType === "creality-k2") {
    return true;
  }
  if (provider.includes("cfs")) {
    return true;
  }
  return (unitLimit !== null && unitLimit > 0) || (externalSourceLimit !== null && externalSourceLimit > 1);
}

/**
 * source observation recordをsummaryへ変換する。
 *
 * 【詳細説明】
 * - 機器reported remainingと3DPmon managed mountは別物として分けて出す。
 *
 * @private
 * @function summarizeSource
 * @param {Object} source - MaterialSource観測record。
 * @param {Array<Object>} openMounts - OPEN SpoolMount配列。
 * @param {Array<Object>} segments - JobMaterialSegment配列。
 * @param {string} deviceId - Printer Core v3 device ID。
 * @param {Array<Object>} snapshots - print-start snapshot配列。
 * @returns {Object} source診断summary。
 */
function summarizeSource(source, openMounts, segments, deviceId, snapshots) {
  const matchingMounts = findOpenMountsForSource(source, openMounts, deviceId);
  const matchingSegments = findSegmentsForSource(source, segments, deviceId);
  const itemKeeperDigestConsistentSegments = findItemKeeperEvidenceSegmentsForSource(
    source,
    segments,
    deviceId,
    snapshots,
    isItemKeeperDigestConsistentSegment
  );
  const itemKeeperFixtureAcceptedSegments = findItemKeeperEvidenceSegmentsForSource(
    source,
    segments,
    deviceId,
    snapshots,
    isItemKeeperFixtureAcceptedSegment
  );
  const itemKeeperRuntimeCertifiedSegments = [];
  const reportedRemainingPercent = toFiniteNumberOrNull(
    source.remaining?.percent ??
    source.remaining?.normalizedPercent ??
    source.remaining?.rawPercent ??
    source.status?.remainingPercent ??
    source.remainingPercent ??
    source.percent
  );
  return {
    sourceId: toText(source.sourceId),
    materialSourceId: toText(source.materialSourceId),
    displayLabel: createSourceDisplayLabel(source),
    kind: toText(source.kind) || "unknown",
    presence: resolveSourcePresence(source),
    selected: Boolean(source.status?.selected ?? source.selected),
    protocolSlotId: source.protocolSlotId ?? null,
    material: {
      vendor: toText(source.material?.vendor),
      type: toText(source.material?.type),
      name: toText(source.material?.name),
      color: source.material?.color?.cssColor || source.material?.color?.displayHex || source.material?.color?.raw || "",
      rfidPresent: Boolean(toText(source.material?.rfid)),
    },
    deviceReportedRemainingPercent: reportedRemainingPercent,
    observedAt: toText(source.lastObservedAt || source.observedAt),
    managedMountCount: matchingMounts.length,
    managedMounts: matchingMounts.map((mount) => ({
      mountId: toText(mount.mountId),
      spoolId: toText(mount.spoolId),
      status: toText(mount.status),
      openedAt: toText(mount.openedAt),
      verification: toText(mount.verification),
    })),
    sourceSpecificUsageCount: matchingSegments.length,
    sourceSpecificUsedLengthMm: matchingSegments.reduce((sum, segment) => {
      const used = toFiniteNumberOrNull(segment.usedLengthMm);
      return sum + (used ?? 0);
    }, 0),
    itemKeeperDigestConsistentUsageCount: itemKeeperDigestConsistentSegments.length,
    itemKeeperDigestConsistentUsedLengthMm: itemKeeperDigestConsistentSegments.reduce((sum, segment) => {
      const used = toFiniteNumberOrNull(segment.usedLengthMm);
      return sum + (used ?? 0);
    }, 0),
    itemKeeperFixtureAcceptedUsageCount: itemKeeperFixtureAcceptedSegments.length,
    itemKeeperRuntimeCertifiedUsageCount: itemKeeperRuntimeCertifiedSegments.length,
    itemKeeperRuntimeCertifiedUsedLengthMm: 0,
    itemKeeperEligibleUsageCount: itemKeeperRuntimeCertifiedSegments.length,
    itemKeeperEligibleUsedLengthMm: 0,
    latestUsageSegments: matchingSegments.slice(-5).map((segment) => ({
      segmentId: toText(segment.segmentId),
      printJobId: toText(segment.printJobId),
      spoolId: toText(segment.spoolId),
      protocolToolAlias: toText(segment.protocolToolAlias),
      usageState: toText(segment.usageState),
      confidence: toText(segment.confidence),
      usedLengthMm: toFiniteNumberOrNull(segment.usedLengthMm),
    })),
  };
}

/**
 * sourceがCFS系sourceか判定する。
 *
 * @private
 * @function isCfsSourceSummary
 * @param {Object} source - source summary。
 * @returns {boolean} CFS sourceならtrue。
 */
function isCfsSourceSummary(source) {
  return source.kind === "cfs-slot";
}

/**
 * sourceがloadedか判定する。
 *
 * @private
 * @function isLoadedSourceSummary
 * @param {Object} source - source summary。
 * @returns {boolean} loaded sourceならtrue。
 */
function isLoadedSourceSummary(source) {
  return source.presence === "loaded";
}

/**
 * certification panel exportをsummaryへ変換する。
 *
 * 【詳細説明】
 * - デバッグカードexportはredactedであることが多いので、identity値ではなく状態とpreflight結果だけを読む。
 *
 * @private
 * @function summarizeCertification
 * @param {Object|null|undefined} payload - certification JSON payload。
 * @returns {Object|null} certification summary。
 */
function summarizeCertification(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const preflight = Array.isArray(payload.preflight)
    ? payload.preflight
    : (Array.isArray(payload.summary?.preflight) ? payload.summary.preflight : []);
  return {
    panel: toText(payload.manifest?.panel),
    generatedAt: toText(payload.manifest?.generatedAt),
    printerModel: toText(payload.manifest?.printer?.model),
    printerDeviceId: toText(payload.manifest?.printer?.deviceId),
    printerDeviceIdRedacted: toText(payload.manifest?.printer?.deviceId).startsWith("<"),
    printerDeviceCorrelation: normalizeCfsDeviceCorrelationEvidence(payload.manifest?.deviceCorrelation),
    printerFirmwareVersion: toText(payload.manifest?.printer?.firmwareVersion),
    printerSessionId: toText(payload.manifest?.printer?.sessionId),
    printerSessionIdRedacted: toText(payload.manifest?.printer?.sessionId).startsWith("<"),
    printerSessionCorrelation: normalizeCfsSessionCorrelationEvidence(payload.manifest?.sessionCorrelation),
    sourceId: toText(payload.manifest?.sourceId),
    displaySlot: toText(payload.manifest?.displaySlot),
    commandKind: toText(payload.manifest?.commandKind),
    dryRunStatus: toText(payload.manifest?.dryRunStatus),
    liveSendEnabled: payload.manifest?.liveSendEnabled === true,
    targetPresence: toText(payload.summary?.material?.targetSource?.presence),
    targetSelected: payload.summary?.material?.targetSource?.selected === true,
    loadedSourceCount: toFiniteNumberOrNull(payload.summary?.material?.summary?.loadedSourceCount),
    selectedSourceCount: toFiniteNumberOrNull(payload.summary?.material?.summary?.selectedSourceCount),
    preflight: preflight.map((item) => ({
      key: toText(item.key),
      state: toText(item.state),
      detail: toText(item.detail),
    })),
  };
}

/**
 * redaction placeholderではないidentity文字列か判定する。
 *
 * 【詳細説明】
 * - certification exportはprivacy保護のため`<redacted>`風の値を持つ場合がある。
 * - 実identityがある場合だけtarget絞り込みやmismatch判定へ使う。
 *
 * @private
 * @function isConcreteIdentityText
 * @param {*} value - identity候補。
 * @returns {boolean} 実identityとして比較できる場合true。
 */
function isConcreteIdentityText(value) {
  const text = toText(value);
  return Boolean(text && !text.startsWith("<"));
}

/**
 * certification exportに対応する対象deviceだけを選ぶ。
 *
 * 【詳細説明】
 * - multi-printer exportでは、同時に監視している別K2の不足理由をtarget fixtureのoverall readinessへ
 *   混ぜない。
 * - certification側にdevice IDがない場合は従来どおりK2候補全体をreview対象に残す。
 *
 * @private
 * @function selectGate18_9J2TargetDevices
 * @param {Object[]} candidateDevices - K2/CFS候補device summary配列。
 * @param {Object|null} certificationSummary - certification summary。
 * @returns {Object[]} readiness判定対象device配列。
 */
function selectGate18_9J2TargetDevices(candidateDevices, certificationSummary) {
  if (isConcreteIdentityText(certificationSummary?.printerDeviceId)) {
    return candidateDevices.filter((device) => device.deviceId === certificationSummary.printerDeviceId);
  }
  const deviceCorrelation = normalizeCfsDeviceCorrelationEvidence(certificationSummary?.printerDeviceCorrelation);
  if (deviceCorrelation.value) {
    return candidateDevices.filter((device) => (
      doesCfsDeviceMatchCorrelationEvidence(device.deviceId, deviceCorrelation)
    ));
  }
  return candidateDevices;
}

/**
 * 機器単位のMaterialSource accounting状態を診断する。
 *
 * 【詳細説明】
 * - K1 direct spoolとK2/CFS multi-sourceの両方を同じMaterialSource modelとして扱う。
 * - legacy `hostSpoolMap` は互換情報としてだけ示し、source別管理が成立したとは見なさない。
 *
 * @private
 * @function summarizeDevice
 * @param {Object} params - 入力context。
 * @param {Object} params.data - monitorData相当root。
 * @param {Object} params.target - connection target。
 * @param {Object} params.machine - monitorData.machines[hostname]。
 * @param {Array<Object>} params.openMounts - OPEN SpoolMount配列。
 * @param {Array<Object>} params.segments - JobMaterialSegment配列。
 * @returns {Object} device診断summary。
 */
function summarizeDevice({ data, target, machine, openMounts, snapshots, segments }) {
  const hostname = toText(target.hostname) || toText(target.dest);
  const deviceId = resolveTargetDeviceId(target, machine);
  const multiSourceExpected = isMultiSourceTarget(target);
  const observationRecord = deviceId
    ? data.materialSourceObservations?.byDeviceId?.[deviceId]
    : null;
  const sources = valuesOfCollection(observationRecord?.latestBySourceId)
    .map((source) => summarizeSource(source, openMounts, segments, deviceId, snapshots))
    .sort((a, b) => a.displayLabel.localeCompare(b.displayLabel, "en", { numeric: true }));
  const loadedSources = sources.filter((source) => source.presence === "loaded");
  const loadedCfsSources = sources.filter((source) => isCfsSourceSummary(source) && isLoadedSourceSummary(source));
  const legacySpoolId = toText(data.hostSpoolMap?.[hostname]);
  const sourceAwareMountedCount = sources.filter((source) => source.managedMountCount > 0).length;
  const loadedWithoutManagedMountCount = loadedSources.filter((source) => source.managedMountCount === 0).length;
  const scopedSnapshots = snapshots.filter((snapshot) => {
    const snapshotDeviceId = toText(snapshot.deviceId);
    return !snapshotDeviceId || !deviceId || snapshotDeviceId === deviceId;
  });
  const scopedSegments = segments.filter((segment) => {
    const segmentDeviceId = toText(segment.deviceId);
    return !segmentDeviceId || !deviceId || segmentDeviceId === deviceId;
  });
  const historyEntries = valuesOfCollection(machine?.printStore?.history);
  const candidateJobs = createPrintBindingCandidateJobs(scopedSnapshots, scopedSegments, deviceId, historyEntries);
  const observedUsedSegments = scopedSegments.filter((segment) => (
    toText(segment.usageState) === "observed-used" &&
    toFiniteNumberOrNull(segment.usedLengthMm) !== null &&
    toFiniteNumberOrNull(segment.usedLengthMm) > 0
  ));
  const confirmedUnusedSegments = scopedSegments.filter((segment) => (
    toText(segment.usageState) === "confirmed-unused" &&
    toFiniteNumberOrNull(segment.usedLengthMm) === 0
  ));
  const reasons = [];
  if (multiSourceExpected && sources.length === 0) {
    reasons.push("material-sources-not-observed");
  }
  if (loadedWithoutManagedMountCount > 0) {
    reasons.push("loaded-source-managed-mount-missing");
  }
  if (legacySpoolId && sources.length > 1 && sourceAwareMountedCount === 0) {
    reasons.push("legacy-single-spool-map-present-for-multi-source-device");
  }
  return {
    hostname,
    label: toText(target.label),
    printerType: toText(target.printerType),
    deviceId,
    model: toText(target.printerCoreV3Identity?.reportedModel || machine?.storedData?.model?.rawValue),
    firmwareVersion: toText(
      target.printerCoreV3Identity?.firmwareVersion ||
      machine?.printerCoreV3Identity?.firmwareVersion ||
      machine?.storedData?.firmwareVersion?.rawValue ||
      machine?.storedData?.modelver?.rawValue ||
      machine?.storedData?.fwVersion?.rawValue
    ),
    materialSystem: target.materialSystem || null,
    multiSourceExpected,
    sourceObservation: {
      observed: Boolean(observationRecord),
      lastObservedAt: toText(observationRecord?.lastObservedAt),
      restoredFromStorage: observationRecord?.restoredFromStorage === true,
      providerDisconnectedAt: toText(observationRecord?.providerDisconnectedAt),
      eventCoverageStartedAt: toText(observationRecord?.eventCoverageStartedAt),
    },
    sourceCounts: {
      total: sources.length,
      external: sources.filter((source) => source.kind === "external-spool").length,
      cfs: sources.filter((source) => source.kind === "cfs-slot").length,
      loaded: loadedSources.length,
      loadedCfs: loadedCfsSources.length,
      selected: sources.filter((source) => source.selected).length,
      managedMounted: sourceAwareMountedCount,
      loadedWithoutManagedMount: loadedWithoutManagedMountCount,
      loadedCfsWithoutManagedMount: loadedCfsSources.filter((source) => source.managedMountCount === 0).length,
    },
    legacyCompatibility: {
      hostSpoolMapSpoolId: legacySpoolId,
      isSourceAware: false,
    },
    printBinding: {
      printStartSnapshotCount: scopedSnapshots.length,
      jobMaterialSegmentCount: scopedSegments.length,
      sourceSpecificUsageCount: sources.reduce((sum, source) => sum + source.sourceSpecificUsageCount, 0),
      sourceSpecificUsedLengthMm: sources.reduce((sum, source) => sum + source.sourceSpecificUsedLengthMm, 0),
      observedUsedSegmentCount: observedUsedSegments.length,
      confirmedUnusedSegmentCount: confirmedUnusedSegments.length,
      reviewableProjectionCandidateSegmentCount: candidateJobs.reduce((sum, job) => sum + job.reviewableProjectionCandidateSegmentCount, 0),
      itemKeeperDigestConsistentSegmentCount: sources.reduce((sum, source) => sum + source.itemKeeperDigestConsistentUsageCount, 0),
      itemKeeperDigestConsistentUsedLengthMm: sources.reduce((sum, source) => sum + source.itemKeeperDigestConsistentUsedLengthMm, 0),
      itemKeeperFixtureAcceptedSegmentCount: sources.reduce((sum, source) => sum + source.itemKeeperFixtureAcceptedUsageCount, 0),
      itemKeeperRuntimeCertifiedSegmentCount: sources.reduce((sum, source) => sum + source.itemKeeperRuntimeCertifiedUsageCount, 0),
      itemKeeperRuntimeCertifiedUsedLengthMm: sources.reduce((sum, source) => sum + source.itemKeeperRuntimeCertifiedUsedLengthMm, 0),
      itemKeeperEligibleSegmentCount: sources.reduce((sum, source) => sum + source.itemKeeperEligibleUsageCount, 0),
      itemKeeperEligibleUsedLengthMm: sources.reduce((sum, source) => sum + source.itemKeeperEligibleUsedLengthMm, 0),
      candidateJobs,
    },
    certificationReadiness: {
      canRunGate18_9IShadowAccounting: multiSourceExpected && sources.length > 0 && loadedWithoutManagedMountCount === 0 && sourceAwareMountedCount > 0,
      canProjectItemKeeperSourceUsage: sources.some((source) => source.itemKeeperRuntimeCertifiedUsageCount > 0),
      itemKeeperProjectionEvidenceStatus: sources.some((source) => source.itemKeeperRuntimeCertifiedUsageCount > 0)
        ? "runtime-registry-certified"
        : sources.some((source) => source.itemKeeperDigestConsistentUsageCount > 0)
          ? "digest-consistent-only"
          : sources.some((source) => source.itemKeeperFixtureAcceptedUsageCount > 0)
            ? "fixture-accepted-only"
            : "none",
      managedRemainingDebitAllowed: false,
      reasons,
    },
    sources,
  };
}

/**
 * Gate 18.9J-2 live fixture capture readinessを診断する。
 *
 * 【詳細説明】
 * - Gate 18.9Iの「source別shadow evidenceがある」判定とは別に、review済みfixture registryへ進むための
 *   operator-facing checklistをread-only reportへ追加する。
 * - ここではproduction issuerを開かず、足りないartifactと未充足理由だけを列挙する。
 *
 * @private
 * @function createGate18_9J2CaptureReadinessReport
 * @param {Object} input - 入力context。
 * @param {Array<Object>} input.deviceSummaries - device summary配列。
 * @param {Object|null} input.certificationSummary - CFS certification panel summary。
 * @returns {Object} Gate18.9J-2 capture readiness summary。
 */
function createGate18_9J2CaptureReadinessReport({ deviceSummaries, certificationSummary }) {
  const candidateDevices = deviceSummaries.filter((device) => (
    device.printerType === "creality-k2" &&
    (device.multiSourceExpected || device.sourceCounts.cfs > 0)
  ));
  const targetDevices = selectGate18_9J2TargetDevices(candidateDevices, certificationSummary);
  const deviceReports = targetDevices.map((device) => {
    const reasons = [];
    if (device.sourceCounts.loadedCfs < 2) {
      reasons.push("loaded-cfs-source-count-less-than-two");
    }
    if (device.sourceCounts.loadedCfsWithoutManagedMount > 0) {
      reasons.push("loaded-cfs-source-managed-mount-missing");
    }
    if (device.printBinding.candidateJobs.length === 0) {
      reasons.push("candidate-print-result-set-missing");
    }
    const certificationSessionId = isConcreteIdentityText(certificationSummary?.printerSessionId)
      ? certificationSummary.printerSessionId
      : "";
    const certificationSessionCorrelation = normalizeCfsSessionCorrelationEvidence(
      certificationSummary?.printerSessionCorrelation
    );
    const certificationSessionCorrelationMissing = certificationSummary?.printerSessionIdRedacted === true &&
      !certificationSessionCorrelation.value;
    const requiresCertificationSession = Boolean(
      certificationSessionId ||
      certificationSessionCorrelation.value ||
      certificationSummary?.printerSessionIdRedacted === true
    );
    const jobReports = device.printBinding.candidateJobs.map((job) => {
      const jobReasons = [];
      if (job.printStartSnapshotCount <= 0) {
        jobReasons.push("print-start-snapshot-missing");
      }
      if (job.jobMaterialSegmentCount <= 0) {
        jobReasons.push("job-material-segment-missing");
      }
      if (!job.rawMaterialUsedPresent) {
        jobReasons.push("raw-material-used-source-csv-missing");
      }
      if (job.rawMaterialUsedParserReasons.length > 0) {
        jobReasons.push("raw-material-used-parser-reasons-present");
      }
      if (
        job.printStartSnapshotCount !== job.jobMaterialSegmentCount ||
        (
          job.rawMaterialUsedSourceCount > 0 &&
          job.rawMaterialUsedSourceCount !== job.printStartSnapshotCount
        )
      ) {
        jobReasons.push("source-result-set-count-mismatch");
      }
      if (job.observedUsedSegmentCount <= 0) {
        jobReasons.push("observed-used-segment-missing");
      }
      if (job.invalidObservedUsedSegmentCount > 0) {
        jobReasons.push("observed-used-zero-segment-invalid");
      }
      if (job.confirmedUnusedSegmentCount <= 0) {
        jobReasons.push("confirmed-unused-zero-segment-missing");
      }
      if (job.invalidConfirmedUnusedSegmentCount > 0) {
        jobReasons.push("confirmed-unused-positive-usage-invalid");
      }
      if (job.reviewableProjectionCandidateSegmentCount <= 0) {
        jobReasons.push("reviewable-projection-candidate-segment-missing");
      }
      if (job.reviewableProjectionCandidateSegmentCount !== job.jobMaterialSegmentCount) {
        jobReasons.push("reviewable-projection-candidate-result-set-incomplete");
      }
      if (certificationSessionCorrelationMissing) {
        jobReasons.push("certification-session-correlation-missing");
      }
      if (requiresCertificationSession && job.sessionIds.length <= 0) {
        jobReasons.push("certification-session-id-missing");
      } else if (requiresCertificationSession && job.sessionIds.length > 1) {
        jobReasons.push("candidate-session-id-ambiguous");
      } else if (certificationSessionId && job.sessionIds[0] !== certificationSessionId) {
        jobReasons.push("certification-session-id-mismatch");
      } else if (
        certificationSessionCorrelation.value &&
        !doesCfsSessionMatchCorrelationEvidence(job.sessionIds[0], certificationSessionCorrelation)
      ) {
        jobReasons.push("certification-session-id-mismatch");
      }
      return {
        printJobId: job.printJobId,
        printPlanId: job.printPlanId,
        readyForFixtureReview: jobReasons.length === 0,
        reasons: jobReasons,
        printStartSnapshotCount: job.printStartSnapshotCount,
        jobMaterialSegmentCount: job.jobMaterialSegmentCount,
        rawMaterialUsedPresent: job.rawMaterialUsedPresent,
        rawMaterialUsedSourceCount: job.rawMaterialUsedSourceCount,
        rawMaterialUsedParserReasons: job.rawMaterialUsedParserReasons,
        sessionIds: job.sessionIds,
        observedOtherSessionIds: job.observedOtherSessionIds,
        observedUsedSegmentCount: job.observedUsedSegmentCount,
        invalidObservedUsedSegmentCount: job.invalidObservedUsedSegmentCount,
        confirmedUnusedSegmentCount: job.confirmedUnusedSegmentCount,
        invalidConfirmedUnusedSegmentCount: job.invalidConfirmedUnusedSegmentCount,
        reviewableProjectionCandidateSegmentCount: job.reviewableProjectionCandidateSegmentCount,
        itemKeeperDigestConsistentSegmentCount: job.itemKeeperDigestConsistentSegmentCount,
      };
    });
    const hasReadyJob = jobReports.some((job) => job.readyForFixtureReview);
    if (!hasReadyJob) {
      reasons.push("ready-candidate-print-result-set-missing");
    }
    if (!hasReadyJob && jobReports.some((job) => job.reasons.includes("certification-session-id-missing"))) {
      reasons.push("certification-session-id-missing");
    }
    if (!hasReadyJob && jobReports.some((job) => job.reasons.includes("candidate-session-id-ambiguous"))) {
      reasons.push("candidate-session-id-ambiguous");
    }
    if (!hasReadyJob && jobReports.some((job) => job.reasons.includes("certification-session-correlation-missing"))) {
      reasons.push("certification-session-correlation-missing");
    }
    if (!hasReadyJob && jobReports.some((job) => job.reasons.includes("certification-session-id-mismatch"))) {
      reasons.push("certification-session-id-mismatch");
    }
    return {
      hostname: device.hostname,
      deviceId: device.deviceId,
      model: device.model,
      firmwareVersion: device.firmwareVersion,
      sourceCounts: device.sourceCounts,
      printBinding: device.printBinding,
      candidateJobs: jobReports,
      readyForFixtureReview: reasons.length === 0,
      reasons,
    };
  });
  const reasons = [];
  if (candidateDevices.length === 0) {
    reasons.push("k2-cfs-device-not-found");
  }
  if (candidateDevices.length > 0 && targetDevices.length === 0) {
    reasons.push("certification-target-device-not-found");
  }
  if (!certificationSummary) {
    reasons.push("cfs-certification-panel-export-missing");
  } else {
    const certificationDeviceCorrelation = normalizeCfsDeviceCorrelationEvidence(
      certificationSummary.printerDeviceCorrelation
    );
    if (certificationSummary.panel !== "cfs-debug-certification") {
      reasons.push("certification-panel-kind-mismatch");
    }
    if (certificationSummary.printerDeviceIdRedacted === true && !certificationDeviceCorrelation.value) {
      reasons.push("certification-device-correlation-missing");
    }
    if (certificationSummary.liveSendEnabled) {
      reasons.push("certification-panel-live-send-enabled");
    }
    if (certificationSummary.loadedSourceCount !== null && certificationSummary.loadedSourceCount < 2) {
      reasons.push("certification-panel-loaded-source-count-less-than-two");
    }
    for (const device of targetDevices.length > 0 ? targetDevices : candidateDevices) {
      const certificationDeviceId = certificationSummary.printerDeviceId;
      if (
        isConcreteIdentityText(certificationDeviceId) &&
        device.deviceId &&
        certificationDeviceId !== device.deviceId
      ) {
        reasons.push(`${device.hostname}:certification-device-id-mismatch`);
      }
      if (
        certificationDeviceCorrelation.value &&
        device.deviceId &&
        !doesCfsDeviceMatchCorrelationEvidence(device.deviceId, certificationDeviceCorrelation)
      ) {
        reasons.push(`${device.hostname}:certification-device-id-mismatch`);
      }
      if (certificationSummary.printerModel && device.model && certificationSummary.printerModel !== device.model) {
        reasons.push(`${device.hostname}:certification-model-mismatch`);
      }
      if (
        certificationSummary.printerFirmwareVersion &&
        isConcreteIdentityText(certificationSummary.printerFirmwareVersion) &&
        device.firmwareVersion &&
        certificationSummary.printerFirmwareVersion !== device.firmwareVersion
      ) {
        reasons.push(`${device.hostname}:certification-firmware-version-mismatch`);
      }
    }
  }
  for (const device of deviceReports) {
    for (const reason of device.reasons) {
      reasons.push(`${device.hostname}:${reason}`);
    }
  }
  const ready = targetDevices.length > 0 &&
    Boolean(certificationSummary) &&
    deviceReports.some((device) => device.readyForFixtureReview) &&
    !certificationSummary.liveSendEnabled &&
    reasons.length === 0;
  return {
    status: ready ? "candidate-ready-for-fixture-review" : "waiting-live-fixture-capture",
    canRegisterReviewedFixtureEntry: false,
    canProjectItemKeeperSourceUsage: false,
    readyForFixtureReview: ready,
    requiredArtifacts: [
      "3dpmon all-data export after completed K2/CFS print",
      "CFS Debug / Certification panel export from the same printer/session window",
      "fixture capture sha256",
      "reviewed commit full SHA",
      "operator physical observation notes for used and unused loaded sources",
    ],
    checklist: [
      "Mount managed 3DPmon spools to every loaded CFS source included in the fixture.",
      "Keep at least two CFS sources loaded so used and unused source handling can both be reviewed.",
      "Start the print through the guarded 3DPmon K2/CFS print-start flow.",
      "Observe completion and export all data after print history has merged.",
      "Run this analyzer with both --export and --certification.",
      "Do not add a production reviewed registry entry until the exported fixture is reviewed.",
    ],
    devices: deviceReports,
    reasons,
  };
}

/**
 * MaterialAccounting exportをread-only診断reportへ変換する。
 *
 * 【詳細説明】
 * - 実機commandやstorage writeは行わない。
 * - Gate 18.9Iの目的に合わせ、source観測、operator-managed mount、print binding segment、
 *   ItemKeeper read-only projection可否を分けて表示する。
 *
 * @function analyzeMaterialAccountingExport
 * @param {Object} exportPayload - 3DPmon export JSON。
 * @param {Object=} options - 解析オプション。
 * @param {Object|null=} options.certificationPayload - CFS certification panel export JSON。
 * @returns {Object} diagnostic report。
 * @example
 * const report = analyzeMaterialAccountingExport(exportJson, { certificationPayload });
 */
export function analyzeMaterialAccountingExport(exportPayload, options = {}) {
  const data = getExportDataRoot(exportPayload);
  const targets = valuesOfCollection(data.appSettings?.connectionTargets);
  const machines = data.machines && typeof data.machines === "object" ? data.machines : {};
  const spoolMountStore = data.materialAccountingSpoolMountStore || {};
  const openMounts = valuesOfCollection(spoolMountStore.spoolMounts)
    .filter((mount) => toText(mount.status || "open").toLowerCase() === "open");
  const printBindingStore = data.materialAccountingPrintBindingStore || {};
  const printStartSnapshots = valuesOfCollection(printBindingStore.printStartSnapshots);
  const jobMaterialSegments = valuesOfCollection(printBindingStore.jobMaterialSegments);
  const deviceSummaries = targets.map((target) => summarizeDevice({
    data,
    target,
    machine: machines[toText(target.hostname)] || null,
    openMounts,
    snapshots: printStartSnapshots,
    segments: jobMaterialSegments,
  }));
  const certificationSummary = summarizeCertification(options.certificationPayload);
  const warnings = [];
  for (const device of deviceSummaries) {
    for (const reason of device.certificationReadiness.reasons) {
      warnings.push({
        device: device.hostname,
        reason,
      });
    }
  }
  const hasMultiSourceAccountingTarget = deviceSummaries.some((device) => (
    device.multiSourceExpected || device.sourceCounts.total > 1
  ));
  const hasGate18_9IEvidence = deviceSummaries.some((device) => (
    device.multiSourceExpected &&
    device.printBinding.printStartSnapshotCount > 0 &&
    device.printBinding.itemKeeperDigestConsistentSegmentCount > 0
  ));
  if (hasMultiSourceAccountingTarget && !data.materialAccountingSpoolMountStore) {
    warnings.push({
      device: "*",
      reason: "material-accounting-spool-mount-store-missing",
    });
  }
  return {
    schemaVersion: 1,
    analyzer: "material-accounting-export-analyzer",
    generatedAt: new Date().toISOString(),
    exportMetadata: {
      exportVersion: data._exportVersion || exportPayload?._exportVersion || null,
      exportDate: data._exportDate || exportPayload?._exportDate || null,
      machineCount: Object.keys(machines).length,
      connectionTargetCount: targets.length,
      spoolCount: valuesOfCollection(data.filamentSpools).length,
    },
    stores: {
      materialSourceObservationDeviceCount: Object.keys(data.materialSourceObservations?.byDeviceId || {}).length,
      spoolMountStorePresent: Boolean(data.materialAccountingSpoolMountStore),
      openSpoolMountCount: openMounts.length,
      printStartSnapshotCount: printStartSnapshots.length,
      jobMaterialSegmentCount: jobMaterialSegments.length,
      unattributedUsageCount: valuesOfCollection(printBindingStore.unattributedUsage).length,
    },
    devices: deviceSummaries,
    certification: certificationSummary,
    gate18_9I: {
      status: hasGate18_9IEvidence ? "evidence-present" : "waiting-live-shadow-accounting",
      canDebitManagedRemaining: false,
      canUsePhysicalCfsSend: false,
      notes: [
        "This analyzer is read-only.",
        "Legacy hostSpoolMap is not treated as a source-specific mount.",
        "Managed remaining debit stays disabled until a later authority gate.",
      ],
    },
    gate18_9J2: createGate18_9J2CaptureReadinessReport({
      deviceSummaries,
      certificationSummary,
    }),
    warnings,
  };
}

/**
 * CLI引数を解析する。
 *
 * 【詳細説明】
 * - `--export` 以外は任意で、既定はstdoutへのminified JSON出力にする。
 *
 * @function parseArgs
 * @param {string[]} argv - `process.argv.slice(2)` 相当。
 * @returns {Object} CLI options。
 * @throws {Error} 必須引数が欠落する場合。
 * @example
 * const options = parseArgs(["--export", "backup.json", "--pretty"]);
 */
export function parseArgs(argv = []) {
  const options = {
    exportPath: "",
    certificationPath: "",
    outputPath: "",
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
    else if (arg === "--output") options.outputPath = next();
    else if (arg === "--pretty") options.pretty = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.help && !toText(options.exportPath)) {
    throw new Error("--export is required.");
  }
  return options;
}

/**
 * JSONファイルを読み込む。
 *
 * 【詳細説明】
 * - ファイル読込失敗やJSON parse失敗はCLI errorとして呼び出し元へ返す。
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
 * MaterialAccounting export analyzerを実行する。
 *
 * 【詳細説明】
 * - export JSONと任意のcertification panel JSONを読み、reportを生成する。
 * - `--output` 指定時はreportをファイルへも保存する。
 *
 * @function runMaterialAccountingExportAnalyzer
 * @param {Object} options - parseArgs済みCLI options。
 * @returns {Promise<Object>} diagnostic report。
 * @example
 * const report = await runMaterialAccountingExportAnalyzer(parseArgs(["--export", "backup.json"]));
 */
export async function runMaterialAccountingExportAnalyzer(options) {
  const exportPayload = await readJsonFile(options.exportPath);
  const certificationPayload = toText(options.certificationPath)
    ? await readJsonFile(options.certificationPath)
    : null;
  const report = analyzeMaterialAccountingExport(exportPayload, { certificationPayload });
  if (toText(options.outputPath)) {
    await writeFile(path.resolve(options.outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "")) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(USAGE.trim());
      process.exit(0);
    }
    const report = await runMaterialAccountingExportAnalyzer(options);
    console.log(JSON.stringify(report, null, options.pretty ? 2 : 0));
  } catch (error) {
    console.error(error?.message || String(error));
    console.error(USAGE.trim());
    process.exit(1);
  }
}
