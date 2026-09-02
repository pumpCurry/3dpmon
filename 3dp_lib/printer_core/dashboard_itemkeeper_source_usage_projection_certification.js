/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 ItemKeeper source usage projection 認証モジュール
 * @file dashboard_itemkeeper_source_usage_projection_certification.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_itemkeeper_source_usage_projection_certification
 *
 * 【機能内容サマリ】
 * - ItemKeeperへsource-aware usageを投影するためのdigestとprocess-local registryを管理
 * - production issuer未接続時はpublic registrationをfail-closedに保つ
 * - unit test専用issuerをItemKeeper連携UIモジュールから物理分離する
 * - Gate 18.9J-1のlive fixture receiptをruntime registryと分離して生成する
 *
 * 【公開関数一覧】
 * - {@link createItemKeeperSourceUsageProjectionCertificationDigest}：projection認証digestを生成
 * - {@link registerItemKeeperSourceUsageProjectionCertification}：production placeholder receiptを生成
 * - {@link registerItemKeeperSourceUsageProjectionCertificationForTest}：test専用にregistryへ登録
 * - {@link clearItemKeeperSourceUsageProjectionCertificationsForTest}：test専用registryを初期化
 * - {@link isExplicitNonNegativeItemKeeperUsedLength}：使用量が明示的な非負値か判定
 * - {@link toExplicitNonNegativeItemKeeperUsedLengthMm}：使用量をprojection用数値へ変換
 * - {@link isItemKeeperProjectionCertified}：segmentがregistry認証済みか判定
 * - {@link evaluateItemKeeperSourceUsageLiveFixture}：live fixture result setをreceipt化
 *
 * @version 1.390.1632 (PR #440)
 * @since   1.390.1631 (PR #440)
 * @lastModified 2026-09-02 10:33:00
 * -----------------------------------------------------------
 * @todo
 * - Gate 18.9J-2でreviewed fixture registryとproduction issuer enableを追加する
 */

"use strict";

/* global process */

import {
  createPrinterCoreV3DeterministicId,
  stableStringifyPrinterCoreV3Value,
} from "./dashboard_data_schema_v3.js";
import {
  K2_MATERIAL_USED_CSV_PARSER_VERSION,
  K2_MATERIAL_USED_SOURCE_ORDERING_PROFILE,
  parseK2MaterialUsedSourceCsv,
} from "./dashboard_material_used_csv_parser.js";

/** ItemKeeper source-aware projectionのmodule-owned認証authority名 */
const ITEMKEEPER_SOURCE_USAGE_PROJECTION_AUTHORITY = "module-owned-live-certification-registry";
/** Gate 18.9J-1 live fixture receiptのauthority名 */
const ITEMKEEPER_SOURCE_USAGE_LIVE_FIXTURE_AUTHORITY = "itemkeeper-source-usage-live-fixture-evidence";
/** Gate 18.9J-1 live fixture receiptのschema version */
const ITEMKEEPER_SOURCE_USAGE_LIVE_FIXTURE_SCHEMA_VERSION = 1;
/** ItemKeeper source-aware live fixtureのGate名 */
const ITEMKEEPER_SOURCE_USAGE_LIVE_FIXTURE_GATE = "18.9J-1";
/** live certification済みsource-aware projection digest集合 */
const ITEMKEEPER_SOURCE_USAGE_PROJECTION_CERTIFICATIONS = new Set();
/** productionでは未実装のlive issuerだけがregistryを更新できるようにする内部token */
const ITEMKEEPER_SOURCE_USAGE_PROJECTION_ISSUER_TOKEN = Object.freeze({
  authority: ITEMKEEPER_SOURCE_USAGE_PROJECTION_AUTHORITY,
});

/**
 * 値をtrim済み文字列へ変換する。
 *
 * @private
 * @function toTrimmedString
 * @param {*} value - 文字列候補。
 * @returns {string} trim済み文字列。
 */
function toTrimmedString(value) {
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
 * JSON互換値を再帰的にfreezeする。
 *
 * @private
 * @function deepFreezeJson
 * @param {*} value - freeze対象。
 * @returns {*} freeze済み値。
 */
function deepFreezeJson(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreezeJson(child);
  }
  return value;
}

/**
 * 文字列が空でないISO時刻として解釈できるか判定する。
 *
 * @private
 * @function isValidIsoLikeTimestamp
 * @param {*} value - 時刻候補。
 * @returns {boolean} ISO時刻として解釈可能ならtrue。
 */
function isValidIsoLikeTimestamp(value) {
  const text = toTrimmedString(value);
  return Boolean(text && Number.isFinite(Date.parse(text)));
}

/**
 * fixture capture hashがsha256証跡として扱えるか判定する。
 *
 * @private
 * @function isSha256Evidence
 * @param {*} value - hash候補。
 * @returns {boolean} sha256証跡ならtrue。
 */
function isSha256Evidence(value) {
  const text = toTrimmedString(value);
  return /^(sha256:)?[a-f0-9]{64}$/i.test(text);
}

/**
 * fixtureのprojection capabilityを生成する。
 *
 * @private
 * @function createFixtureCapability
 * @returns {{canRegisterProjection:boolean,canProjectItemKeeper:boolean}} capability。
 */
function createFixtureCapability() {
  return Object.freeze({
    canRegisterProjection: false,
    canProjectItemKeeper: false,
  });
}

/**
 * snapshotのauthority orderを取得する。
 *
 * @private
 * @function resolveFixtureSnapshotOrder
 * @param {Object|null|undefined} snapshot - print-start snapshot候補。
 * @param {number} fallbackOrder - fallback order。
 * @returns {number} source order。
 */
function resolveFixtureSnapshotOrder(snapshot, fallbackOrder) {
  const order = Number(snapshot?.bindingAuthority?.tool?.order ?? snapshot?.order);
  return Number.isFinite(order) ? order : fallbackOrder;
}

/**
 * snapshotのauthority tool aliasを取得する。
 *
 * @private
 * @function resolveFixtureSnapshotToolAlias
 * @param {Object|null|undefined} snapshot - print-start snapshot候補。
 * @returns {string} protocol tool alias。
 */
function resolveFixtureSnapshotToolAlias(snapshot) {
  return toTrimmedString(
    snapshot?.bindingAuthority?.tool?.protocolToolAlias ||
    snapshot?.protocolToolAlias ||
    snapshot?.toolAlias
  );
}

/**
 * snapshotのauthority tool IDを取得する。
 *
 * @private
 * @function resolveFixtureSnapshotToolId
 * @param {Object|null|undefined} snapshot - print-start snapshot候補。
 * @returns {number|null} tool ID。
 */
function resolveFixtureSnapshotToolId(snapshot) {
  const toolId = Number(snapshot?.bindingAuthority?.tool?.toolId ?? snapshot?.toolId);
  return Number.isFinite(toolId) ? toolId : null;
}

/**
 * snapshotのauthority material source IDを取得する。
 *
 * @private
 * @function resolveFixtureSnapshotMaterialSourceId
 * @param {Object|null|undefined} snapshot - print-start snapshot候補。
 * @returns {string} material source ID。
 */
function resolveFixtureSnapshotMaterialSourceId(snapshot) {
  return toTrimmedString(
    snapshot?.bindingAuthority?.source?.materialSourceId ||
    snapshot?.materialSourceId
  );
}

/**
 * snapshotのauthority mount IDを取得する。
 *
 * @private
 * @function resolveFixtureSnapshotMountId
 * @param {Object|null|undefined} snapshot - print-start snapshot候補。
 * @returns {string} mount ID。
 */
function resolveFixtureSnapshotMountId(snapshot) {
  return toTrimmedString(
    snapshot?.bindingAuthority?.mount?.mountId ||
    snapshot?.mountId
  );
}

/**
 * snapshotのauthority spool IDを取得する。
 *
 * @private
 * @function resolveFixtureSnapshotSpoolId
 * @param {Object|null|undefined} snapshot - print-start snapshot候補。
 * @returns {string} spool ID。
 */
function resolveFixtureSnapshotSpoolId(snapshot) {
  return toTrimmedString(
    snapshot?.bindingAuthority?.mount?.spoolId ||
    snapshot?.spoolId
  );
}

/**
 * source order entryを比較しやすいcanonical形へ正規化する。
 *
 * @private
 * @function normalizeFixtureExpectedSourceOrderEntry
 * @param {Object|null|undefined} entry - expectedSourceOrder候補。
 * @returns {Object} canonical expected source order entry。
 */
function normalizeFixtureExpectedSourceOrderEntry(entry) {
  return {
    order: Number.isFinite(Number(entry?.order)) ? Number(entry.order) : null,
    toolId: Number.isFinite(Number(entry?.toolId)) ? Number(entry.toolId) : null,
    protocolToolAlias: toTrimmedString(entry?.protocolToolAlias || entry?.toolAlias),
    materialSourceId: toTrimmedString(entry?.materialSourceId),
    mountId: toTrimmedString(entry?.mountId),
    spoolId: toTrimmedString(entry?.spoolId),
    snapshotId: toTrimmedString(entry?.snapshotId),
    bindingAuthorityDigest: toTrimmedString(entry?.bindingAuthorityDigest),
    usedLengthMm: Number.isFinite(Number(entry?.usedLengthMm)) ? Number(entry.usedLengthMm) : null,
    usageState: toTrimmedString(entry?.usageState),
    locator: entry?.locator && typeof entry.locator === "object" && !Array.isArray(entry.locator)
      ? cloneJsonValue(entry.locator)
      : {},
  };
}

/**
 * fixture receiptへ保存するsource order entryを作成する。
 *
 * @private
 * @function createFixtureObservedSourceOrderEntry
 * @param {Object} expected - canonical expected source order entry。
 * @returns {Object} receipt用source order entry。
 */
function createFixtureObservedSourceOrderEntry(expected) {
  return {
    order: expected.order,
    toolId: expected.toolId,
    protocolToolAlias: expected.protocolToolAlias,
    materialSourceId: expected.materialSourceId,
    mountId: expected.mountId,
    spoolId: expected.spoolId,
    snapshotId: expected.snapshotId,
    bindingAuthorityDigest: expected.bindingAuthorityDigest,
    usedLengthMm: expected.usedLengthMm,
    usageState: expected.usageState,
    locator: cloneJsonValue(expected.locator),
  };
}

/**
 * live fixture receiptのdigest payloadを作成する。
 *
 * @private
 * @function createItemKeeperSourceUsageLiveFixtureDigestPayload
 * @param {Object} input - digest入力。
 * @returns {Object} digest payload。
 */
function createItemKeeperSourceUsageLiveFixtureDigestPayload(input) {
  const evidence = input.fixtureEvidence || {};
  return {
    schemaVersion: ITEMKEEPER_SOURCE_USAGE_LIVE_FIXTURE_SCHEMA_VERSION,
    authority: ITEMKEEPER_SOURCE_USAGE_LIVE_FIXTURE_AUTHORITY,
    gate: ITEMKEEPER_SOURCE_USAGE_LIVE_FIXTURE_GATE,
    fixtureId: toTrimmedString(evidence.fixtureId),
    captureId: toTrimmedString(evidence.captureId),
    capturedAt: toTrimmedString(evidence.capturedAt),
    operatorActionId: toTrimmedString(evidence.operatorActionId),
    reviewedCommit: toTrimmedString(evidence.reviewedCommit).toLowerCase(),
    parserVersion: K2_MATERIAL_USED_CSV_PARSER_VERSION,
    sourceOrderingProfile: K2_MATERIAL_USED_SOURCE_ORDERING_PROFILE,
    device: {
      deviceId: toTrimmedString(evidence.device?.deviceId),
      printerType: toTrimmedString(evidence.device?.printerType),
      model: toTrimmedString(evidence.device?.model),
      firmwareVersion: toTrimmedString(evidence.device?.firmwareVersion),
    },
    print: {
      printJobId: toTrimmedString(evidence.print?.printJobId),
      printPlanId: toTrimmedString(evidence.print?.printPlanId),
    },
    rawMaterialUsed: input.parsedUsage?.rawMaterialUsed || "",
    parsedUsedLengthMm: Array.isArray(input.parsedUsage?.usedLengthMm)
      ? [...input.parsedUsage.usedLengthMm]
      : [],
    observedSourceOrder: Array.isArray(input.observedSourceOrder)
      ? input.observedSourceOrder.map((entry) => cloneJsonValue(entry))
      : [],
    artifact: {
      captureSha256: toTrimmedString(evidence.artifact?.captureSha256).toLowerCase(),
    },
  };
}

/**
 * ItemKeeper source usage live fixture digestを生成する。
 *
 * @function createItemKeeperSourceUsageLiveFixtureDigest
 * @param {Object} input - digest入力。
 * @returns {string} fixture digest。
 * @example
 * const digest = createItemKeeperSourceUsageLiveFixtureDigest({ fixtureEvidence, parsedUsage, observedSourceOrder });
 */
export function createItemKeeperSourceUsageLiveFixtureDigest(input = {}) {
  return `fnv1a128:${createPrinterCoreV3DeterministicId(
    "itemkeeper-source-usage-live-fixture",
    [stableStringifyPrinterCoreV3Value(createItemKeeperSourceUsageLiveFixtureDigestPayload(input))]
  )}`;
}

/**
 * fixture評価結果を作成する。
 *
 * @private
 * @function createLiveFixtureEvaluationResult
 * @param {Object} input - 評価結果入力。
 * @returns {Object} freeze済み評価結果。
 */
function createLiveFixtureEvaluationResult(input) {
  const errors = [...new Set(Array.isArray(input.errors) ? input.errors.filter(Boolean) : [])];
  const ok = errors.length === 0;
  const observedSourceOrder = Array.isArray(input.observedSourceOrder)
    ? input.observedSourceOrder.map((entry) => cloneJsonValue(entry))
    : [];
  const parsedUsedLengthMm = Array.isArray(input.parsedUsage?.usedLengthMm)
    ? [...input.parsedUsage.usedLengthMm]
    : [];
  const fixtureDigest = createItemKeeperSourceUsageLiveFixtureDigest({
    fixtureEvidence: input.fixtureEvidence,
    parsedUsage: input.parsedUsage,
    observedSourceOrder,
  });
  return deepFreezeJson({
    ok,
    status: ok ? "fixture-accepted" : "fixture-rejected",
    authority: ITEMKEEPER_SOURCE_USAGE_LIVE_FIXTURE_AUTHORITY,
    schemaVersion: ITEMKEEPER_SOURCE_USAGE_LIVE_FIXTURE_SCHEMA_VERSION,
    gate: ITEMKEEPER_SOURCE_USAGE_LIVE_FIXTURE_GATE,
    fixtureDigest,
    parserVersion: K2_MATERIAL_USED_CSV_PARSER_VERSION,
    sourceOrderingProfile: K2_MATERIAL_USED_SOURCE_ORDERING_PROFILE,
    rawMaterialUsed: input.parsedUsage?.rawMaterialUsed || "",
    parsedUsedLengthMm,
    observedSourceOrder,
    errors,
    capability: createFixtureCapability(),
  });
}

/**
 * fixture evidence自体の必須fieldを検査する。
 *
 * @private
 * @function validateLiveFixtureEvidenceEnvelope
 * @param {Object|null|undefined} fixtureEvidence - fixture evidence候補。
 * @returns {string[]} validation error配列。
 */
function validateLiveFixtureEvidenceEnvelope(fixtureEvidence) {
  const errors = [];
  if (!fixtureEvidence || typeof fixtureEvidence !== "object" || Array.isArray(fixtureEvidence)) {
    return ["fixture-evidence-required"];
  }
  if (Number(fixtureEvidence.schemaVersion) !== ITEMKEEPER_SOURCE_USAGE_LIVE_FIXTURE_SCHEMA_VERSION) {
    errors.push("fixture-schema-version-mismatch");
  }
  if (toTrimmedString(fixtureEvidence.authority) !== ITEMKEEPER_SOURCE_USAGE_LIVE_FIXTURE_AUTHORITY) {
    errors.push("fixture-authority-mismatch");
  }
  if (toTrimmedString(fixtureEvidence.gate) !== ITEMKEEPER_SOURCE_USAGE_LIVE_FIXTURE_GATE) {
    errors.push("fixture-gate-mismatch");
  }
  for (const key of ["fixtureId", "captureId", "operatorActionId"]) {
    if (!toTrimmedString(fixtureEvidence[key])) {
      errors.push(`${key}-required`);
    }
  }
  if (!isValidIsoLikeTimestamp(fixtureEvidence.capturedAt)) {
    errors.push("captured-at-required");
  }
  if (!/^[a-f0-9]{40}$/i.test(toTrimmedString(fixtureEvidence.reviewedCommit))) {
    errors.push("reviewed-commit-full-sha-required");
  }
  if (toTrimmedString(fixtureEvidence.parser?.parserVersion) !== K2_MATERIAL_USED_CSV_PARSER_VERSION) {
    errors.push("parser-version-mismatch");
  }
  if (toTrimmedString(fixtureEvidence.parser?.sourceOrderingProfile) !== K2_MATERIAL_USED_SOURCE_ORDERING_PROFILE) {
    errors.push("source-ordering-profile-mismatch");
  }
  for (const key of ["deviceId", "printerType", "model", "firmwareVersion"]) {
    if (!toTrimmedString(fixtureEvidence.device?.[key])) {
      errors.push(`device-${key}-required`);
    }
  }
  for (const key of ["printJobId", "printPlanId"]) {
    if (!toTrimmedString(fixtureEvidence.print?.[key])) {
      errors.push(`print-${key}-required`);
    }
  }
  if (!isSha256Evidence(fixtureEvidence.artifact?.captureSha256)) {
    errors.push("capture-sha256-required");
  }
  if (!Array.isArray(fixtureEvidence.expectedSourceOrder) || fixtureEvidence.expectedSourceOrder.length === 0) {
    errors.push("expected-source-order-required");
  }
  return errors;
}

/**
 * fixture evidence / snapshot / segment集合のsource順序整合を検査する。
 *
 * @private
 * @function validateLiveFixtureSourceOrder
 * @param {Object} input - 検査入力。
 * @param {Object} input.fixtureEvidence - fixture evidence。
 * @param {Object[]} input.printStartSnapshots - print-start snapshot配列。
 * @param {Object[]} input.jobMaterialSegments - JobMaterialSegment配列。
 * @param {Object} input.parsedUsage - CSV parse結果。
 * @returns {{errors:string[],observedSourceOrder:Object[]}} 検査結果。
 */
function validateLiveFixtureSourceOrder(input) {
  const fixtureEvidence = input.fixtureEvidence || {};
  const expectedOrder = (Array.isArray(fixtureEvidence.expectedSourceOrder) ? fixtureEvidence.expectedSourceOrder : [])
    .map(normalizeFixtureExpectedSourceOrderEntry)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const snapshots = (Array.isArray(input.printStartSnapshots) ? input.printStartSnapshots : [])
    .slice()
    .sort((a, b) => resolveFixtureSnapshotOrder(a, 0) - resolveFixtureSnapshotOrder(b, 0));
  const segments = (Array.isArray(input.jobMaterialSegments) ? input.jobMaterialSegments : [])
    .slice()
    .sort((a, b) => {
      const orderA = Number.isFinite(Number(a?.order)) ? Number(a.order) : 0;
      const orderB = Number.isFinite(Number(b?.order)) ? Number(b.order) : 0;
      if (orderA !== orderB) return orderA - orderB;
      return toTrimmedString(a?.segmentId).localeCompare(toTrimmedString(b?.segmentId));
    });
  const errors = [];
  const counts = [expectedOrder.length, snapshots.length, segments.length, input.parsedUsage.usedLengthMm.length];
  if (!counts.every((count) => count === expectedOrder.length)) {
    errors.push("source-result-set-count-mismatch");
  }
  const deviceId = toTrimmedString(fixtureEvidence.device?.deviceId);
  const printJobId = toTrimmedString(fixtureEvidence.print?.printJobId);
  const printPlanId = toTrimmedString(fixtureEvidence.print?.printPlanId);
  const observedSourceOrder = [];
  for (let index = 0; index < expectedOrder.length; index += 1) {
    const expected = expectedOrder[index];
    const snapshot = snapshots[index];
    const segment = segments[index];
    const parsedUsedLengthMm = input.parsedUsage.usedLengthMm[index];
    const snapshotMatches = snapshot &&
      toTrimmedString(snapshot.snapshotId) === expected.snapshotId &&
      toTrimmedString(snapshot.deviceId) === deviceId &&
      toTrimmedString(snapshot.printJobId) === printJobId &&
      toTrimmedString(snapshot.printPlanId) === printPlanId &&
      resolveFixtureSnapshotOrder(snapshot, index) === expected.order &&
      resolveFixtureSnapshotToolId(snapshot) === expected.toolId &&
      resolveFixtureSnapshotToolAlias(snapshot) === expected.protocolToolAlias &&
      resolveFixtureSnapshotMaterialSourceId(snapshot) === expected.materialSourceId &&
      resolveFixtureSnapshotMountId(snapshot) === expected.mountId &&
      resolveFixtureSnapshotSpoolId(snapshot) === expected.spoolId &&
      toTrimmedString(snapshot.bindingAuthorityDigest) === expected.bindingAuthorityDigest;
    const segmentMatches = segment &&
      toTrimmedString(segment.deviceId) === deviceId &&
      toTrimmedString(segment.printJobId) === printJobId &&
      toTrimmedString(segment.printPlanId) === printPlanId &&
      Number(segment.toolId) === expected.toolId &&
      toTrimmedString(segment.protocolToolAlias || segment.toolAlias) === expected.protocolToolAlias &&
      Number(segment.order) === expected.order &&
      toTrimmedString(segment.materialSourceId) === expected.materialSourceId &&
      toTrimmedString(segment.mountId) === expected.mountId &&
      toTrimmedString(segment.spoolId) === expected.spoolId &&
      Number(segment.usedLengthMm) === expected.usedLengthMm &&
      Number(parsedUsedLengthMm) === expected.usedLengthMm &&
      toTrimmedString(segment.usageState) === expected.usageState;
    if (!snapshotMatches || !segmentMatches) {
      errors.push("expected-source-order-mismatch");
    }
    if (toTrimmedString(segment?.debit?.status) !== "eligible") {
      errors.push("segment-debit-eligible-required");
    }
    if (expected.usageState === "observed-used" && expected.usedLengthMm <= 0) {
      errors.push("observed-used-positive-length-required");
    }
    if (expected.usageState === "confirmed-unused" && expected.usedLengthMm !== 0) {
      errors.push("confirmed-unused-zero-length-required");
    }
    if (!["observed-used", "confirmed-unused"].includes(expected.usageState)) {
      errors.push("usage-state-unsupported");
    }
    observedSourceOrder.push(createFixtureObservedSourceOrderEntry(expected));
  }
  return { errors, observedSourceOrder };
}

/**
 * ItemKeeper source-aware usage live fixtureを評価してreceiptを生成する。
 *
 * 【詳細説明】
 * - Gate 18.9J-1はreview可能なfixture receiptだけを作り、runtime projection registryへは
 *   書き込まない。
 * - caller supplied fixture evidenceだけでItemKeeperのsource-aware実送信を解禁しないため、
 *   戻り値のcapabilityは常に`canRegisterProjection:false` / `canProjectItemKeeper:false`である。
 * - source集合は単一segmentではなくprint result set全体で検査し、CSV数、snapshot数、
 *   JobMaterialSegment数、expectedSourceOrder数のズレをfail-closedにする。
 *
 * @function evaluateItemKeeperSourceUsageLiveFixture
 * @param {Object=} input - 評価入力。
 * @param {Object=} input.fixtureEvidence - live fixture evidence。
 * @param {Object[]=} input.printStartSnapshots - print-start snapshot配列。
 * @param {Object[]=} input.jobMaterialSegments - JobMaterialSegment配列。
 * @param {Object=} input.rawHistoryEntry - K2/Creality履歴entry候補。
 * @returns {Object} fixture receiptまたはreject診断。
 * @example
 * const receipt = evaluateItemKeeperSourceUsageLiveFixture({ fixtureEvidence, printStartSnapshots, jobMaterialSegments });
 */
export function evaluateItemKeeperSourceUsageLiveFixture(input = {}) {
  const fixtureEvidence = input.fixtureEvidence;
  const envelopeErrors = validateLiveFixtureEvidenceEnvelope(fixtureEvidence);
  const rawMaterialUsed = toTrimmedString(
    fixtureEvidence?.raw?.materialUsedSourceCsv ||
    input.rawHistoryEntry?.materialUsedSourceCsv ||
    input.rawHistoryEntry?.materialUsed ||
    input.rawHistoryEntry?.materialUsedCsv ||
    input.rawHistoryEntry?.sourceMaterialUsed
  );
  const expectedCount = Array.isArray(fixtureEvidence?.expectedSourceOrder)
    ? fixtureEvidence.expectedSourceOrder.length
    : null;
  const parsedUsage = parseK2MaterialUsedSourceCsv(rawMaterialUsed, {
    expectedCount,
    requireWhenMultiple: true,
  });
  const sourceOrderValidation = validateLiveFixtureSourceOrder({
    fixtureEvidence,
    printStartSnapshots: input.printStartSnapshots,
    jobMaterialSegments: input.jobMaterialSegments,
    parsedUsage,
  });
  return createLiveFixtureEvaluationResult({
    fixtureEvidence,
    parsedUsage,
    observedSourceOrder: sourceOrderValidation.observedSourceOrder,
    errors: [
      ...envelopeErrors,
      ...parsedUsage.reasons,
      ...sourceOrderValidation.errors,
    ],
  });
}

/**
 * ItemKeeper source-aware projection用の使用量をdigest向けに厳密正規化する。
 *
 * 【詳細説明】
 * - JavaScriptの`Number(null)`や`Number("")`は0になるが、Gate18.9では
 *   「明示0mm」と「未知/欠損」は別物として扱う必要がある。
 * - digest入力にもkindを含め、unknown値と0mmが同じ認証digestにならないようにする。
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
 * ItemKeeper source-aware projectionへ使える明示的な非負使用量か判定する。
 *
 * 【詳細説明】
 * - confirmed-unusedの0mmは許可するが、null/undefined/空文字/NaNを0mmへ補正しない。
 * - registry登録時とprojection時の両方で同じ条件を使い、認証後の解釈差を防ぐ。
 *
 * @function isExplicitNonNegativeItemKeeperUsedLength
 * @param {*} value - JobMaterialSegment.usedLengthMm のraw値。
 * @returns {boolean} 明示的な非負数値ならtrue。
 * @example
 * const ok = isExplicitNonNegativeItemKeeperUsedLength(segment.usedLengthMm);
 */
export function isExplicitNonNegativeItemKeeperUsedLength(value) {
  const normalized = normalizeItemKeeperProjectionUsedLengthForDigest(value);
  return normalized.kind === "finite" && normalized.value >= 0;
}

/**
 * ItemKeeper source-aware projection用の明示的な非負使用量を数値として取得する。
 *
 * 【詳細説明】
 * - projection生成時にも`Number(null) || 0`のような補正を使わず、事前filterと同じ
 *   strict normalizerから値を取り出す。
 * - 呼び出し側はnullをprojection不可として扱う。
 *
 * @function toExplicitNonNegativeItemKeeperUsedLengthMm
 * @param {*} value - JobMaterialSegment.usedLengthMm のraw値。
 * @returns {number|null} 明示的な非負数値、またはprojection不可を表すnull。
 * @example
 * const usedLengthMm = toExplicitNonNegativeItemKeeperUsedLengthMm(segment.usedLengthMm);
 */
export function toExplicitNonNegativeItemKeeperUsedLengthMm(value) {
  const normalized = normalizeItemKeeperProjectionUsedLengthForDigest(value);
  if (normalized.kind !== "finite" || normalized.value < 0) {
    return null;
  }
  return normalized.value;
}

/**
 * ItemKeeper source-aware projection認証用の意味payloadを生成する。
 *
 * 【詳細説明】
 * - imported JSONが`itemKeeperProjection.status="certified"`だけを偽装しても通らないように、
 *   実際にItemKeeperへ投影するsource/slot/spool/usageの意味だけをdigest化する。
 * - `itemKeeperProjection`自身はdigest入力へ含めず、認証証跡を付け直してもdigestが
 *   自己参照で変わらないようにする。
 *
 * @private
 * @function createItemKeeperSourceUsageProjectionCertificationPayload
 * @param {Object|null|undefined} segment - JobMaterialSegment候補。
 * @returns {Object} 認証digestの意味payload。
 */
function createItemKeeperSourceUsageProjectionCertificationPayload(segment) {
  return {
    segmentId: String(segment?.segmentId || "").trim(),
    printJobId: String(segment?.printJobId || segment?.jobId || segment?.printId || "").trim(),
    printPlanId: String(segment?.printPlanId || "").trim(),
    deviceId: String(segment?.deviceId || "").trim(),
    spoolId: String(segment?.spoolId || "").trim(),
    mountId: String(segment?.mountId || "").trim(),
    materialSourceId: String(segment?.materialSourceId || "").trim(),
    protocolToolAlias: String(segment?.protocolToolAlias || "").trim(),
    usedLengthMm: normalizeItemKeeperProjectionUsedLengthForDigest(segment?.usedLengthMm),
    usageState: String(segment?.usageState || "").trim(),
    confidence: String(segment?.confidence || "").trim(),
    order: Number.isFinite(Number(segment?.order)) ? Number(segment.order) : 0,
    debitStatus: String(segment?.debit?.status || "").trim(),
  };
}

/**
 * ItemKeeper source-aware projection認証digestを生成する。
 *
 * 【詳細説明】
 * - live certification gateで同じprocess内のmodule-owned registryへ登録されたdigestだけを
 *   runtime ItemKeeper projectionへ通す。
 * - digestには使用量とsource identityを含めるため、登録後にsource/order/usedLengthMmなどを
 *   改変したsegmentは認証済みとして扱わない。
 *
 * @function createItemKeeperSourceUsageProjectionCertificationDigest
 * @param {Object|null|undefined} segment - JobMaterialSegment候補。
 * @returns {string} source-aware projection認証digest。
 * @example
 * const digest = createItemKeeperSourceUsageProjectionCertificationDigest(segment);
 */
export function createItemKeeperSourceUsageProjectionCertificationDigest(segment) {
  return `fnv1a128:${createPrinterCoreV3DeterministicId(
    "itemkeeper-source-usage-projection-certification",
    [stableStringifyPrinterCoreV3Value(createItemKeeperSourceUsageProjectionCertificationPayload(segment))]
  )}`;
}

/**
 * 内部issuer tokenつきでItemKeeper source-aware projection registryへ登録する。
 *
 * 【詳細説明】
 * - module外から任意segmentをcertifiedへ昇格できないよう、tokenはexportしない。
 * - 現時点ではtest helperだけがこの関数を経由し、production live issuerは後続Gateで
 *   fixture/capture/reviewedCommit等の証跡検証と一緒に実装する。
 *
 * @private
 * @function registerItemKeeperSourceUsageProjectionCertificationWithIssuer
 * @param {Object|null|undefined} segment - 認証候補のJobMaterialSegment。
 * @param {Object} issuerToken - module-private issuer token。
 * @returns {Object} segmentへ付与するItemKeeper projection認証receipt。
 */
function registerItemKeeperSourceUsageProjectionCertificationWithIssuer(segment, issuerToken) {
  const digest = createItemKeeperSourceUsageProjectionCertificationDigest(segment);
  if (issuerToken !== ITEMKEEPER_SOURCE_USAGE_PROJECTION_ISSUER_TOKEN) {
    return Object.freeze({
      status: "uncertified",
      authority: ITEMKEEPER_SOURCE_USAGE_PROJECTION_AUTHORITY,
      digest,
      reason: "live-certification-issuer-required",
    });
  }
  if (!isExplicitNonNegativeItemKeeperUsedLength(segment?.usedLengthMm)) {
    return Object.freeze({
      status: "uncertified",
      authority: ITEMKEEPER_SOURCE_USAGE_PROJECTION_AUTHORITY,
      digest,
      reason: "used-length-mm-required",
    });
  }
  ITEMKEEPER_SOURCE_USAGE_PROJECTION_CERTIFICATIONS.add(digest);
  return Object.freeze({
    status: "certified",
    authority: ITEMKEEPER_SOURCE_USAGE_PROJECTION_AUTHORITY,
    digest,
  });
}

/**
 * ItemKeeper source-aware projection登録のproduction placeholder。
 *
 * 【詳細説明】
 * - live certification issuerが未実装の現段階では、外部callerがこの関数を呼んでも
 *   process-local registryへdigestを追加しない。
 * - 将来、fixture/capture/reviewedCommit等を検証するmodule-owned issuerを追加した時点で、
 *   そのissuerだけが内部tokenつきで登録する。
 *
 * @function registerItemKeeperSourceUsageProjectionCertification
 * @param {Object|null|undefined} segment - 認証候補のJobMaterialSegment。
 * @returns {Object} 未認証理由を含む診断用receipt。
 * @example
 * const receipt = registerItemKeeperSourceUsageProjectionCertification(segment);
 */
export function registerItemKeeperSourceUsageProjectionCertification(segment) {
  const digest = createItemKeeperSourceUsageProjectionCertificationDigest(segment);
  return Object.freeze({
    status: "uncertified",
    authority: ITEMKEEPER_SOURCE_USAGE_PROJECTION_AUTHORITY,
    digest,
    reason: "live-certification-issuer-required",
  });
}

/**
 * unit test専用にItemKeeper source-aware projection認証registryへ登録する。
 *
 * 【詳細説明】
 * - production codeが任意segmentを認証できないことを保ったまま、projection経路の
 *   regression testだけがmodule-owned issuer後の状態を再現するための入口。
 * - Vitest/Node test環境以外ではpublic mintとして機能しない。
 * - dashboard_integration_itemkeeper.jsからはexportせず、production importはESLintで禁止する。
 *
 * @function registerItemKeeperSourceUsageProjectionCertificationForTest
 * @param {Object|null|undefined} segment - 認証候補のJobMaterialSegment。
 * @returns {Object} test環境では認証receipt、それ以外では未認証receipt。
 * @example
 * segment.itemKeeperProjection = registerItemKeeperSourceUsageProjectionCertificationForTest(segment);
 */
export function registerItemKeeperSourceUsageProjectionCertificationForTest(segment) {
  const isTestEnvironment = typeof process !== "undefined" && process.env && process.env.NODE_ENV === "test";
  if (!isTestEnvironment) {
    return registerItemKeeperSourceUsageProjectionCertification(segment);
  }
  return registerItemKeeperSourceUsageProjectionCertificationWithIssuer(
    segment,
    ITEMKEEPER_SOURCE_USAGE_PROJECTION_ISSUER_TOKEN
  );
}

/**
 * テスト用にItemKeeper source-aware projection認証registryを空にする。
 *
 * 【詳細説明】
 * - module-owned registryはprocess-localなmutable authorityなので、unit test間の
 *   汚染を防ぐため明示的にresetできるようにする。
 * - production pathでは呼ばず、source-aware projectionの実解禁はregister関数経由に限定する。
 *
 * @function clearItemKeeperSourceUsageProjectionCertificationsForTest
 * @returns {void}
 * @example
 * clearItemKeeperSourceUsageProjectionCertificationsForTest();
 */
export function clearItemKeeperSourceUsageProjectionCertificationsForTest() {
  ITEMKEEPER_SOURCE_USAGE_PROJECTION_CERTIFICATIONS.clear();
}

/**
 * source-aware ItemKeeper projectionがlive certification済みか判定する。
 *
 * 【詳細説明】
 * - K2/CFSのsource別使用量は、materialUsed CSVとPrintPlan順序の対応を実機で証明するまで
 *   外部のspool使用実績として送らない。
 * - 将来のlive certification gateはJobMaterialSegmentをmodule-owned registryへ登録し、
 *   `authority`と`digest`を持つ証跡を付与する。
 * - imported JSONやlocalStorage restoreが`status:"certified"`だけを持っていても、
 *   process-local registryに一致digestが無ければprojectionしない。
 *
 * @function isItemKeeperProjectionCertified
 * @param {Object|null|undefined} segment - JobMaterialSegment候補。
 * @returns {boolean} ItemKeeper source-aware projectionへ使用可能ならtrue。
 * @example
 * const certified = isItemKeeperProjectionCertified(segment);
 */
export function isItemKeeperProjectionCertified(segment) {
  const projection = segment?.itemKeeperProjection || {};
  const digest = createItemKeeperSourceUsageProjectionCertificationDigest(segment);
  return (
    String(projection.status || "").trim() === "certified" &&
    String(projection.authority || "").trim() === ITEMKEEPER_SOURCE_USAGE_PROJECTION_AUTHORITY &&
    String(projection.digest || "").trim() === digest &&
    isExplicitNonNegativeItemKeeperUsedLength(segment?.usedLengthMm) &&
    ITEMKEEPER_SOURCE_USAGE_PROJECTION_CERTIFICATIONS.has(digest)
  );
}
