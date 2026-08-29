/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Creality エラー解決モジュール
 * @file creality_error_resolver.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module creality_error_resolver
 *
 * 【機能内容サマリ】
 * - K1 numeric / Creality OS / CFS のエラーコード名前空間を分離して解決
 * - raw errcode/key/value と表示用 canonical code を混同しない
 * - 機種不明時に K1 辞書へフォールバックしない fail-safe resolver を提供
 *
 * 【公開関数一覧】
 * - {@link resolveCrealityError}：raw error と機種文脈から canonical error を解決
 * - {@link formatCrealityError}：解決結果をユーザー向け日本語表示へ整形
 *
 * @version 1.390.1487 (PR #437)
 * @since   1.390.1486 (PR #437)
 * @lastModified 2026-08-30 03:06:29
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

import legacyErrorMap from "../3dp_errorcode.js";
import { CREALITY_ERROR_RECORDS } from "./data/creality_error_master.js";

const CANONICAL_CODE_PATTERN = /^[A-Z]{2}\d{4}$/u;
const PRINTER_TYPES = new Set(["creality-k1", "creality-k2", "moonraker", "unknown"]);

/**
 * 数値へ安全に正規化する。
 *
 * 【詳細説明】
 * - 空文字、null、undefined、NaN は null にする。
 * - raw transport evidence は別途保持するため、ここでは比較可能な有限数だけを返す。
 *
 * @private
 * @function toFiniteNumberOrNull
 * @param {*} value - 正規化対象値
 * @returns {number|null} 有限数、または null
 */
function toFiniteNumberOrNull(value) {
  if (value === "" || value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * canonical code 文字列へ正規化する。
 *
 * 【詳細説明】
 * - Creality OS / HMS 系の `FS2843` のような英字prefix付きコードだけを採用する。
 * - 数値suffixだけからprefixを生成しない。誤った断定表示を避けるため。
 *
 * @private
 * @function normalizeCanonicalCode
 * @param {*} value - raw value または caller supplied canonical code
 * @returns {string|null} 正規化済み canonical code、または null
 */
function normalizeCanonicalCode(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return CANONICAL_CODE_PATTERN.test(normalized) ? normalized : null;
}

/**
 * printerType を error resolver 用の厳密値へ正規化する。
 *
 * 【詳細説明】
 * - UI互換の「未設定ならK1」はここでは行わない。
 * - resolverで機種不明をK1扱いすると、K2/CFSのraw errcodeをK1辞書で誤表示するため。
 *
 * @private
 * @function normalizePrinterType
 * @param {*} value - printerType 値
 * @returns {"creality-k1"|"creality-k2"|"moonraker"|"unknown"} 正規化済みprinterType
 */
function normalizePrinterType(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return PRINTER_TYPES.has(text) ? text : "unknown";
}

/**
 * model文字列からprinter familyを推定する。
 *
 * 【詳細説明】
 * - F012 は手元実機の K2 Pro Combo として観測済みのため K2 family とする。
 * - modelだけで判定できない場合は unknown のままにし、K1へ倒さない。
 *
 * @private
 * @function inferPrinterTypeFromModel
 * @param {*} model - 機器から報告された model / display model
 * @returns {"creality-k1"|"creality-k2"|"unknown"} 推定printerType
 */
function inferPrinterTypeFromModel(model) {
  const text = String(model || "").trim().toLowerCase();
  if (!text) return "unknown";
  if (text === "f012" || text.includes("k2")) return "creality-k2";
  if (text.includes("k1")) return "creality-k1";
  return "unknown";
}

/**
 * 明示printerTypeとmodel由来のprinter familyを統合する。
 *
 * 【詳細説明】
 * - connection target に古いprinterTypeが残っていても、F012/K2などpayload側の強い機種証拠を優先する。
 * - Moonraker/IR3 V2 はCreality OS error resolverの対象外なので、明示moonrakerは上書きしない。
 * - どちらか片方だけが判明している場合は判明している値を使い、両方不明ならunknownを返す。
 *
 * @private
 * @function resolveEffectivePrinterType
 * @param {"creality-k1"|"creality-k2"|"moonraker"|"unknown"} explicitType - connection設定などから得た明示printerType
 * @param {"creality-k1"|"creality-k2"|"unknown"} inferredType - payload modelから推定したprinterType
 * @returns {"creality-k1"|"creality-k2"|"moonraker"|"unknown"} resolverで採用するprinterType
 */
function resolveEffectivePrinterType(explicitType, inferredType) {
  if (explicitType === "moonraker") {
    return "moonraker";
  }
  if (inferredType !== "unknown" && explicitType !== "unknown" && inferredType !== explicitType) {
    return inferredType;
  }
  return explicitType !== "unknown" ? explicitType : inferredType;
}

/**
 * features配列を小文字Setへ正規化する。
 *
 * 【詳細説明】
 * - CFS有無などのfeature applicability判定で使う。
 * - 文字列以外は無視し、feature不明時は空Setにする。
 *
 * @private
 * @function normalizeFeatureSet
 * @param {*} features - feature一覧
 * @returns {Set<string>} 正規化済みfeature集合
 */
function normalizeFeatureSet(features) {
  const set = new Set();
  if (Array.isArray(features)) {
    for (const feature of features) {
      if (typeof feature === "string" && feature.trim()) {
        set.add(feature.trim().toLowerCase());
      }
    }
  }
  return set;
}

/**
 * recordがprinter familyへ適用可能か判定する。
 *
 * 【詳細説明】
 * - k1/k2 applicability が `yes` のものを優先する。
 * - unknown を広く採用すると誤断定につながるため、family確定時も明示yesのみを許可する。
 *
 * @private
 * @function recordMatchesPrinterType
 * @param {Object} record - error master record
 * @param {string} printerType - 正規化済みprinterType
 * @returns {boolean} 適用可能なら true
 */
function recordMatchesPrinterType(record, printerType) {
  if (printerType === "creality-k1") {
    return record?.applicability?.k1 === "yes";
  }
  if (printerType === "creality-k2") {
    return record?.applicability?.k2 === "yes";
  }
  return false;
}

/**
 * feature文脈で候補を絞り込む。
 *
 * 【詳細説明】
 * - CFS接続が観測されている場合、CFS feature付き候補を優先する。
 * - ただし候補が消える場合は元候補を保持し、feature不足だけで unknown にしない。
 *
 * @private
 * @function filterByFeatures
 * @param {Object[]} candidates - error候補
 * @param {Set<string>} features - 正規化済みfeature集合
 * @returns {Object[]} featureで絞り込んだ候補
 */
function filterByFeatures(candidates, features) {
  if (!features.has("cfs")) return candidates;
  const withCfs = candidates.filter((record) => (
    Array.isArray(record?.applicability?.features)
      && record.applicability.features.some((feature) => String(feature).toLowerCase() === "cfs")
  ));
  return withCfs.length > 0 ? withCfs : candidates;
}

/**
 * legacy K1 numeric error を解決する。
 *
 * 【詳細説明】
 * - K1 legacy payload では errcode 側でエラー番号が来る既存fixtureがある。
 * - keyが非0かつ辞書に存在する場合はkeyを優先し、それ以外はerrcodeを使う。
 *
 * @private
 * @function resolveK1NumericError
 * @param {number|null} errcode - raw errcode
 * @param {number|null} key - raw key
 * @returns {Object|null} K1 numeric record、または null
 */
function resolveK1NumericError(errcode, key) {
  const keyRecord = key != null && key !== 0
    ? CREALITY_ERROR_RECORDS.find((record) => record.namespace === "k1-numeric" && record.numericCode === key)
    : null;
  if (keyRecord) return keyRecord;
  const errcodeRecord = CREALITY_ERROR_RECORDS.find((record) => record.namespace === "k1-numeric" && record.numericCode === errcode)
    || null;
  if (errcodeRecord) return errcodeRecord;
  const fallbackCode = key != null && key !== 0 && typeof legacyErrorMap[key] === "function" ? key : errcode;
  if (fallbackCode != null && typeof legacyErrorMap[fallbackCode] === "function") {
    return {
      id: `legacy-k1-local:${fallbackCode}`,
      namespace: "k1-numeric",
      catalogs: ["legacy-local"],
      canonicalCode: String(fallbackCode),
      numericCode: fallbackCode,
      prefix: null,
      subsystem: "legacy-k1",
      messageJa: legacyErrorMap[fallbackCode]([fallbackCode]),
      transportRole: "legacy-local-fallback",
      applicability: {
        models: ["K1 series"],
        k1: "yes",
        k2: "no-as-k1-numeric-namespace",
        features: [],
        status: "legacy-local-fallback",
      },
      sources: ["3dp_errorcode.js"],
      confidence: "legacy",
      notes: ["Kept only for explicit K1 printerType compatibility."],
    };
  }
  return null;
}

/**
 * Creality OS / CFS numeric suffix error を解決する。
 *
 * 【詳細説明】
 * - K2 WS9999 の raw errcode は transport上の状態値として扱い、canonical suffix推定にはkeyを使う。
 * - keyがない場合にerrcode=1001等をK1 legacy file errorへ誤解釈しないよう unknown に寄せる。
 *
 * @private
 * @function resolveCrealityOsNumericError
 * @param {number|null} key - raw key
 * @param {string} printerType - 正規化済みprinterType
 * @param {Set<string>} features - 正規化済みfeature集合
 * @returns {{record:Object|null, candidates:Object[]}} 解決recordと候補
 */
function resolveCrealityOsNumericError(key, printerType, features) {
  if (key == null || key === 0) {
    return { record: null, candidates: [] };
  }
  let candidates = CREALITY_ERROR_RECORDS.filter((record) => (
    record.namespace === "creality-os"
      && record.numericCode === key
      && recordMatchesPrinterType(record, printerType)
  ));
  candidates = filterByFeatures(candidates, features);
  return {
    record: candidates.length === 1 ? candidates[0] : null,
    candidates,
  };
}

/**
 * Creality error master record から公開表示用summaryを作る。
 *
 * 【詳細説明】
 * - UIや通知側が巨大なmaster recordへ依存しすぎないよう、必要な情報だけを複製する。
 * - sourcesは出典IDとして残し、詳細資料への導線を失わない。
 *
 * @private
 * @function summarizeRecord
 * @param {Object|null} record - error master record
 * @returns {Object|null} summary、または null
 */
function summarizeRecord(record) {
  if (!record) return null;
  return {
    id: record.id,
    namespace: record.namespace,
    canonicalCode: record.canonicalCode,
    numericCode: record.numericCode,
    prefix: record.prefix,
    subsystem: record.subsystem,
    messageJa: record.messageJa,
    applicability: record.applicability,
    sources: record.sources,
    confidence: record.confidence,
  };
}

/**
 * Creality系エラーを namespace-aware に解決する。
 *
 * 【詳細説明】
 * - raw errcode/key/value は必ずそのまま戻り値に保持する。
 * - canonical英字コードが明示されている場合はexact matchを先に使う。
 * - K1 numeric と Creality OS/CFS を同じ数値辞書へ潰さない。
 * - 機種不明時はK1へフォールバックせず unknown/ambiguous とする。
 *
 * @function resolveCrealityError
 * @param {Object} input - 解決入力
 * @param {Object=} input.raw - raw error object
 * @param {number|string=} input.raw.errcode - raw errcode
 * @param {number|string=} input.raw.key - raw key
 * @param {string=} input.raw.value - raw value
 * @param {string=} input.printerType - creality-k1 / creality-k2 / moonraker / unknown
 * @param {string=} input.model - 機器model文字列
 * @param {string[]=} input.features - 観測済みfeature一覧
 * @param {string=} input.canonicalCode - caller supplied canonical code
 * @returns {Object} 解決結果
 */
export function resolveCrealityError(input = {}) {
  const raw = input.raw && typeof input.raw === "object" ? input.raw : {};
  const errcode = toFiniteNumberOrNull(raw.errcode);
  const key = toFiniteNumberOrNull(raw.key);
  const value = Object.prototype.hasOwnProperty.call(raw, "value") ? raw.value : null;
  const rawSummary = { errcode, key, value };
  if ((errcode == null || errcode === 0) && (key == null || key === 0)) {
    return {
      status: "inactive",
      active: false,
      raw: rawSummary,
      record: null,
      candidates: [],
      reason: "no-error",
    };
  }

  const explicitType = normalizePrinterType(input.printerType);
  const inferredType = inferPrinterTypeFromModel(input.model);
  const printerType = resolveEffectivePrinterType(explicitType, inferredType);
  const features = normalizeFeatureSet(input.features);
  const canonicalCode = normalizeCanonicalCode(input.canonicalCode) || normalizeCanonicalCode(value);
  if (canonicalCode) {
    const record = CREALITY_ERROR_RECORDS.find((entry) => entry.canonicalCode === canonicalCode) || null;
    if (record) {
      return {
        status: "resolved",
        active: true,
        raw: rawSummary,
        printerType,
        canonicalCode,
        record: summarizeRecord(record),
        candidates: [summarizeRecord(record)],
        reason: "canonical-exact-match",
      };
    }
  }

  if (printerType === "creality-k1") {
    const record = resolveK1NumericError(errcode, key);
    return {
      status: record ? "resolved" : "unknown",
      active: true,
      raw: rawSummary,
      printerType,
      canonicalCode: record?.canonicalCode || null,
      record: summarizeRecord(record),
      candidates: record ? [summarizeRecord(record)] : [],
      reason: record ? "k1-numeric-match" : "k1-numeric-not-found",
    };
  }

  if (printerType === "creality-k2") {
    const { record, candidates } = resolveCrealityOsNumericError(key, printerType, features);
    return {
      status: record ? "resolved" : (candidates.length > 1 ? "ambiguous" : "unknown"),
      active: true,
      raw: rawSummary,
      printerType,
      canonicalCode: record?.canonicalCode || null,
      record: summarizeRecord(record),
      candidates: candidates.map(summarizeRecord),
      reason: record
        ? "creality-os-key-suffix-match"
        : (candidates.length > 1 ? "creality-os-key-ambiguous" : "creality-os-key-not-found"),
    };
  }

  return {
    status: "unknown",
    active: true,
    raw: rawSummary,
    printerType,
    canonicalCode: null,
    record: null,
    candidates: [],
    reason: printerType === "moonraker" ? "moonraker-not-creality-os" : "printer-type-unknown-no-k1-fallback",
  };
}

/**
 * 既存K1辞書互換のメッセージを生成する。
 *
 * 【詳細説明】
 * - resolverでK1 numeric recordが見つからない古いコード向けの互換fallback。
 * - K2/CFS経路ではこのfallbackを使わない。
 *
 * @private
 * @function formatLegacyK1Fallback
 * @param {number|null} errcode - raw errcode
 * @param {number|null} key - raw key
 * @returns {string} 既存辞書互換メッセージ
 */
function formatLegacyK1Fallback(errcode, key) {
  let msg = `エラー コード${errcode}, キー${key}: `;
  msg += typeof legacyErrorMap[errcode] === "function"
    ? legacyErrorMap[errcode]([errcode])
    : `不明なコード:${errcode}`;
  msg += " ";
  msg += typeof legacyErrorMap[key] === "function"
    ? legacyErrorMap[key]([key])
    : `不明なキー:${key}`;
  return msg.trim();
}

/**
 * Creality error resolver の結果を日本語表示へ整形する。
 *
 * 【詳細説明】
 * - 解決済みなら canonical code と公式/調査メッセージを表示する。
 * - unknown/ambiguousではraw値を必ず表示し、誤った断定を避ける。
 * - K1 legacyでmaster未収録の場合だけ旧辞書表示へ戻す。
 *
 * @function formatCrealityError
 * @param {Object} input - 整形入力
 * @param {Object=} input.resolution - resolveCrealityError の戻り値
 * @param {Object=} input.raw - raw error object
 * @param {string=} input.printerType - printerType
 * @param {string=} input.model - model
 * @param {string[]=} input.features - feature一覧
 * @returns {string} 日本語表示メッセージ
 */
export function formatCrealityError(input = {}) {
  const resolution = input.resolution || resolveCrealityError(input);
  const raw = resolution.raw || {};
  if (resolution.status === "inactive") {
    return `コード${raw.errcode ?? 0}, キー${raw.key ?? 0}`;
  }
  if (resolution.printerType === "creality-k1") {
    return formatLegacyK1Fallback(raw.errcode, raw.key);
  }
  if (resolution.status === "resolved" && resolution.record) {
    const code = resolution.record.canonicalCode || resolution.canonicalCode || "unknown";
    const message = resolution.record.messageJa || "詳細未設定";
    return `${code} — ${message} (raw: errcode=${raw.errcode ?? "?"}, key=${raw.key ?? "?"})`;
  }
  if (resolution.status === "ambiguous") {
    const codes = resolution.candidates.map((candidate) => candidate?.canonicalCode).filter(Boolean).join(", ");
    return `エラー候補が複数あります: ${codes || "候補不明"} (raw: errcode=${raw.errcode ?? "?"}, key=${raw.key ?? "?"})`;
  }
  return `未分類のCrealityエラー (raw: errcode=${raw.errcode ?? "?"}, key=${raw.key ?? "?"})`;
}
