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
 *
 * 【公開関数一覧】
 * - {@link createItemKeeperSourceUsageProjectionCertificationDigest}：projection認証digestを生成
 * - {@link registerItemKeeperSourceUsageProjectionCertification}：production placeholder receiptを生成
 * - {@link registerItemKeeperSourceUsageProjectionCertificationForTest}：test専用にregistryへ登録
 * - {@link clearItemKeeperSourceUsageProjectionCertificationsForTest}：test専用registryを初期化
 * - {@link isExplicitNonNegativeItemKeeperUsedLength}：使用量が明示的な非負値か判定
 * - {@link toExplicitNonNegativeItemKeeperUsedLengthMm}：使用量をprojection用数値へ変換
 * - {@link isItemKeeperProjectionCertified}：segmentがregistry認証済みか判定
 *
 * @version 1.390.1631 (PR #440)
 * @since   1.390.1631 (PR #440)
 * @lastModified 2026-09-02 09:28:00
 * -----------------------------------------------------------
 * @todo
 * - Gate 18.9Jでfixture evidence receiptとproduction issuer enableの境界を追加する
 */

"use strict";

/* global process */

import {
  createPrinterCoreV3DeterministicId,
  stableStringifyPrinterCoreV3Value,
} from "./dashboard_data_schema_v3.js";

/** ItemKeeper source-aware projectionのmodule-owned認証authority名 */
const ITEMKEEPER_SOURCE_USAGE_PROJECTION_AUTHORITY = "module-owned-live-certification-registry";
/** live certification済みsource-aware projection digest集合 */
const ITEMKEEPER_SOURCE_USAGE_PROJECTION_CERTIFICATIONS = new Set();
/** productionでは未実装のlive issuerだけがregistryを更新できるようにする内部token */
const ITEMKEEPER_SOURCE_USAGE_PROJECTION_ISSUER_TOKEN = Object.freeze({
  authority: ITEMKEEPER_SOURCE_USAGE_PROJECTION_AUTHORITY,
});

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
