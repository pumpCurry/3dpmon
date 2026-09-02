/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 K2 materialUsed CSV parser モジュール
 * @file dashboard_material_used_csv_parser.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_used_csv_parser
 *
 * 【機能内容サマリ】
 * - K2/Creality履歴のsource-specific materialUsed CSVをlosslessに解析する
 * - CSV解析versionとsource順序profileを分離してfixture/runtime双方へ提供する
 *
 * 【公開関数一覧】
 * - {@link resolveK2MaterialUsedSourceCsv}：K2履歴entryからmaterialUsed CSV候補を抽出
 * - {@link resolveK2MaterialUsedCompletionEvidenceCsv}：履歴rawとsegment完了rawを同じ規則で照合
 * - {@link parseK2MaterialUsedSourceCsv}：K2 materialUsed CSVをsource別使用量へ変換
 *
 * @version 1.390.1659 (PR #440)
 * @since   1.390.1632 (PR #440)
 * @lastModified 2026-09-02 18:09:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

/** K2 materialUsed CSV parserのversion。 */
export const K2_MATERIAL_USED_CSV_PARSER_VERSION = "k2-material-used-csv:v1";
/** CSV位置をprint-start binding authority orderへ割り当てるprofile。 */
export const K2_MATERIAL_USED_SOURCE_ORDERING_PROFILE = "print-start-binding-authority-order:v1";

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
 * 値を有限数へ変換し、不明値はnullへ正規化する。
 *
 * 【詳細説明】
 * - completionEvidenceに保存されたsourceCount/partCountはdurable fallbackの信頼境界であり、
 *   数値として解釈できる場合だけ現在のparser結果と照合する。
 * - 空文字やnullは「古い証跡でfield自体が無い」可能性があるため、ここでは0へ補正せずnullにする。
 *
 * @private
 * @function toFiniteNumberOrNull
 * @param {*} value - 数値候補。
 * @returns {number|null} 有限数、または不明を示すnull。
 */
function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * K2/Creality履歴entryからsource-specific materialUsed CSVを抽出する。
 *
 * 【詳細説明】
 * - runtimeとfixture validatorでraw field precedenceがずれると、fixtureで検証した文字列と
 *   本番runtimeが解析する文字列が変わってしまう。
 * - そのため、既存runtimeのprecedenceをこのpure helperへ集約し、両経路から同じ順序で参照する。
 *
 * @function resolveK2MaterialUsedSourceCsv
 * @param {Object|null|undefined} historyEntry - K2/Crealityのprint history entry候補。
 * @returns {string} 最初に見つかった空でないmaterialUsed CSV文字列。
 * @example
 * const raw = resolveK2MaterialUsedSourceCsv(historyEntry);
 */
export function resolveK2MaterialUsedSourceCsv(historyEntry) {
  const candidates = [
    historyEntry?.materialUsed,
    historyEntry?.materialUsedSourceCsv,
    historyEntry?.sourceMaterialUsedCsv,
    historyEntry?.raw?.materialUsed,
    historyEntry?.materialUsedCsv,
    historyEntry?.sourceMaterialUsed,
  ];
  for (const candidate of candidates) {
    const value = toTrimmedString(candidate);
    if (value) {
      return value;
    }
  }
  return "";
}

/**
 * segment側に保存されたK2 materialUsed completion raw CSV候補を収集する。
 *
 * 【詳細説明】
 * - JobMaterialSegmentの`evidence.completionEvidence.rawMaterialUsed`は、印刷履歴が
 *   retention済みの場合にfixture/analyzerが使う耐久証跡である。
 * - 履歴rawと比較する前に、同一job内のsegment rawが複数種類へ分岐していないかを
 *   pure helper側で一元的に確認する。
 *
 * @private
 * @function collectSegmentCompletionMaterialUsedCsvValues
 * @param {Array<Object>} segments - JobMaterialSegment候補配列。
 * @returns {string[]} 重複除去済みraw CSV候補配列。
 */
function collectSegmentCompletionMaterialUsedCsvValues(segments) {
  return [...new Set((Array.isArray(segments) ? segments : [])
    .map((segment) => toTrimmedString(segment?.evidence?.completionEvidence?.rawMaterialUsed))
    .filter(Boolean))];
}

/**
 * segment側completionEvidenceのmetadataを現在のparser contractと照合する。
 *
 * 【詳細説明】
 * - retention後にsegment completionEvidenceだけでfixtureを再構築する場合、raw CSVだけでなく、
 *   そのrawを作ったparser version/source order/source数/part数も同じcontractでなければならない。
 * - ここで返したreasonはcanonical raw CSVが履歴由来の場合も残す。履歴とdurable証跡が並存している
 *   ときの不一致は、あとで履歴がretentionされた瞬間にfallbackが別解釈へ変わる兆候だからである。
 *
 * @private
 * @function collectSegmentCompletionMaterialUsedEvidenceReasons
 * @param {Array<Object>} segments - JobMaterialSegment候補配列。
 * @param {Object=} options - 照合オプション。
 * @param {number=} options.expectedSourceCount - print-start snapshot等から得たsource数。
 * @returns {string[]} completionEvidence metadataに関するfail-closed理由配列。
 */
function collectSegmentCompletionMaterialUsedEvidenceReasons(segments, options = {}) {
  const reasons = [];
  const expectedSourceCount = Number.isFinite(Number(options.expectedSourceCount))
    ? Number(options.expectedSourceCount)
    : null;
  for (const segment of Array.isArray(segments) ? segments : []) {
    const evidence = segment?.evidence?.completionEvidence;
    const rawMaterialUsed = toTrimmedString(evidence?.rawMaterialUsed);
    if (!evidence || typeof evidence !== "object" || !rawMaterialUsed) continue;
    if (toTrimmedString(evidence.parserVersion) !== K2_MATERIAL_USED_CSV_PARSER_VERSION) {
      reasons.push("completion-evidence-parser-version-mismatch");
    }
    if (toTrimmedString(evidence.sourceOrderingProfile) !== K2_MATERIAL_USED_SOURCE_ORDERING_PROFILE) {
      reasons.push("completion-evidence-source-ordering-profile-mismatch");
    }
    const sourceCount = toFiniteNumberOrNull(evidence.sourceCount);
    if (expectedSourceCount !== null && sourceCount !== null && sourceCount !== expectedSourceCount) {
      reasons.push("completion-evidence-source-count-mismatch");
    }
    const partCount = toFiniteNumberOrNull(evidence.partCount);
    const observedPartCount = rawMaterialUsed.split(",").map((part) => part.trim()).length;
    if (partCount !== null && partCount !== observedPartCount) {
      reasons.push("completion-evidence-part-count-mismatch");
    }
  }
  return [...new Set(reasons)];
}

/**
 * 履歴rawとJobMaterialSegment completion rawからcanonical materialUsed CSVを解決する。
 *
 * 【詳細説明】
 * - print history rawが存在する場合は、プリンタ履歴由来のrawをcanonicalとして採用する。
 * - segment側completionEvidenceはretention後のfallbackだが、履歴rawと両方ある場合に
 *   不一致なら保存済みdurable evidenceが同じ完了観測を指していないためreasonを返す。
 * - segment側rawが複数種類ある場合は、どれか一つを選ばずconflictとしてfail-closedできる
 *   reasonを返す。履歴rawがある場合も、conflict自体は監査理由として残す。
 *
 * @function resolveK2MaterialUsedCompletionEvidenceCsv
 * @param {Object|null|undefined} historyEntry - K2/Crealityのprint history entry候補。
 * @param {Array<Object>} segments - 同一jobのJobMaterialSegment候補配列。
 * @param {Object=} options - durable completionEvidence照合オプション。
 * @param {number=} options.expectedSourceCount - print-start snapshot等から得たsource数。
 * @returns {{rawMaterialUsed:string,source:string,reasons:string[]}} canonical raw CSVと検証理由。
 * @example
 * const evidence = resolveK2MaterialUsedCompletionEvidenceCsv(historyEntry, segments, {
 *   expectedSourceCount: snapshots.length
 * });
 */
export function resolveK2MaterialUsedCompletionEvidenceCsv(historyEntry, segments, options = {}) {
  const historyRaw = resolveK2MaterialUsedSourceCsv(historyEntry);
  const segmentRawValues = collectSegmentCompletionMaterialUsedCsvValues(segments);
  const reasons = collectSegmentCompletionMaterialUsedEvidenceReasons(segments, options);
  if (segmentRawValues.length > 1) {
    reasons.push("raw-material-used-completion-evidence-conflict");
  }
  if (historyRaw) {
    if (segmentRawValues.length === 1 && segmentRawValues[0] !== historyRaw) {
      reasons.push("raw-material-used-completion-evidence-mismatch");
    }
    return Object.freeze({
      rawMaterialUsed: historyRaw,
      source: "print-history",
      reasons: Object.freeze([...new Set(reasons)]),
    });
  }
  if (segmentRawValues.length === 1) {
    return Object.freeze({
      rawMaterialUsed: segmentRawValues[0],
      source: "job-material-segment-completion-evidence",
      reasons: Object.freeze([...new Set(reasons)]),
    });
  }
  return Object.freeze({
    rawMaterialUsed: "",
    source: segmentRawValues.length > 1 ? "conflict" : "missing",
    reasons: Object.freeze([...new Set(reasons)]),
  });
}

/**
 * K2/Creality履歴のsource別materialUsed CSVを解析する。
 *
 * 【詳細説明】
 * - `3210,0,6543` のようなCSVを、print-start時点で固定されたsource orderへ対応する
 *   使用量配列へ変換する。
 * - この関数はCSVの解析だけを担当し、どのsourceへ割り当てるかは呼び出し側の
 *   `sourceOrderingProfile`で固定する。
 * - 空値や不正値を0mmへ補正せず、fixture/runtimeの両方で同じ失敗理由を返す。
 *
 * @function parseK2MaterialUsedSourceCsv
 * @param {*} rawValue - K2/Creality履歴のmaterialUsed CSV候補。
 * @param {Object=} options - 解析オプション。
 * @param {number=} options.expectedCount - print-start snapshotやexpectedSourceOrderから得たsource数。
 * @param {boolean=} options.requireWhenMultiple - 複数source時にCSV欠落を失敗理由へする場合true。
 * @returns {{ok:boolean,rawMaterialUsed:string,parts:string[],usedLengthMm:number[],parserVersion:string,sourceOrderingProfile:string,reasons:string[]}} 解析結果。
 * @example
 * const parsed = parseK2MaterialUsedSourceCsv("3210,0", { expectedCount: 2 });
 */
export function parseK2MaterialUsedSourceCsv(rawValue, options = {}) {
  const rawMaterialUsed = toTrimmedString(rawValue);
  const expectedCount = Number.isFinite(Number(options.expectedCount))
    ? Number(options.expectedCount)
    : null;
  const reasons = [];
  if (!rawMaterialUsed) {
    if (options.requireWhenMultiple === true || (expectedCount !== null && expectedCount > 1)) {
      reasons.push("observed-material-used-required");
    }
    return Object.freeze({
      ok: reasons.length === 0,
      rawMaterialUsed: "",
      parts: Object.freeze([]),
      usedLengthMm: Object.freeze([]),
      parserVersion: K2_MATERIAL_USED_CSV_PARSER_VERSION,
      sourceOrderingProfile: K2_MATERIAL_USED_SOURCE_ORDERING_PROFILE,
      reasons: Object.freeze([...new Set(reasons)]),
    });
  }

  const parts = rawMaterialUsed
    .split(",")
    .map((part) => part.trim());
  if (expectedCount !== null && parts.length !== expectedCount) {
    reasons.push("material-used-source-count-mismatch");
  }
  const usedLengthMm = [];
  for (const part of parts) {
    if (part === "") {
      reasons.push("material-used-source-empty-field");
      continue;
    }
    if (!/^\d+(?:\.\d+)?$/.test(part)) {
      reasons.push("usage-length-invalid");
      continue;
    }
    const numeric = Number(part);
    if (!Number.isFinite(numeric) || numeric < 0) {
      reasons.push("usage-length-invalid");
      continue;
    }
    usedLengthMm.push(numeric);
  }
  return Object.freeze({
    ok: reasons.length === 0,
    rawMaterialUsed,
    parts: Object.freeze([...parts]),
    usedLengthMm: Object.freeze(usedLengthMm),
    parserVersion: K2_MATERIAL_USED_CSV_PARSER_VERSION,
    sourceOrderingProfile: K2_MATERIAL_USED_SOURCE_ORDERING_PROFILE,
    reasons: Object.freeze([...new Set(reasons)]),
  });
}
