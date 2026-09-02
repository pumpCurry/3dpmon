/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 CFS session correlation モジュール
 * @file dashboard_cfs_session_correlation.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_cfs_session_correlation
 *
 * 【機能内容サマリ】
 * - CFS certification exportでraw session IDを公開せずに同一session性を照合する
 * - export bundle / analyzer / fixture builderで共有できるsession correlation evidenceを生成する
 *
 * 【公開関数一覧】
 * - {@link createCfsSessionCorrelationSalt}：exportごとの公開saltを生成
 * - {@link createCfsSessionCorrelationEvidence}：session correlation evidenceを生成
 * - {@link normalizeCfsSessionCorrelationEvidence}：correlation evidenceを検査して正規化
 * - {@link doesCfsSessionMatchCorrelationEvidence}：session IDとcorrelation evidenceの一致を判定
 *
 * @version 1.390.1645 (PR #440)
 * @since   1.390.1645 (PR #440)
 * @lastModified 2026-09-02 15:26:05
 * -----------------------------------------------------------
 * @todo
 * - cryptographic hashが必要になった場合はWeb Crypto / Node cryptoを使うv2 algorithmへ移行する
 */

"use strict";

import {
  createPrinterCoreV3DeterministicId,
  stableStringifyPrinterCoreV3Value,
} from "./dashboard_data_schema_v3.js";

/**
 * CFS session correlation evidenceのalgorithm識別子。
 *
 * 【詳細説明】
 * - 現行実装はData Schema v3と同じ非暗号FNV-1a 128bit相当digestを使う。
 * - 秘匿・署名ではなく、redacted certification exportとlocal export内のsession証跡を
 *   同じoperator review文脈で照合するための識別子として扱う。
 *
 * @constant {string}
 */
export const CFS_SESSION_CORRELATION_ALGORITHM = "printer-core-cfs-session-correlation-fnv1a128:v1";

/**
 * 任意値をtrim済み文字列へ正規化する。
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
 * CFS certification export用の公開saltを生成する。
 *
 * 【詳細説明】
 * - saltは秘匿値ではなく、同じexport bundleを読むanalyzer/builderがraw session IDから
 *   同じcorrelation値を再計算するために保存する。
 * - テストや再現性が必要な呼び出しでは、呼び出し側が固定saltを渡せる。
 *
 * @function createCfsSessionCorrelationSalt
 * @param {Object=} options - salt生成options。
 * @param {number=} options.nowMs - 現在時刻ms。省略時はDate.now()。
 * @param {number=} options.randomValue - 0以上1未満の乱数。省略時はMath.random()。
 * @returns {string} export-local salt。
 * @example
 * const salt = createCfsSessionCorrelationSalt({ nowMs: 1, randomValue: 0.5 });
 */
export function createCfsSessionCorrelationSalt(options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const randomValue = Number.isFinite(Number(options.randomValue)) ? Number(options.randomValue) : Math.random();
  const randomPart = Math.floor(Math.abs(randomValue) * 0xffffffff).toString(36).padStart(7, "0");
  return `cfs-session-salt:${Math.max(0, Math.trunc(nowMs)).toString(36)}:${randomPart}`;
}

/**
 * session IDとsaltからcorrelation valueを生成する。
 *
 * 【詳細説明】
 * - raw session IDをexportへ残さず、同じsaltを持つartifact間でだけ同一性を比較できる値へ寄せる。
 * - 非暗号digestなので機密値の保護には使わず、redaction済みreview artifactの相関証跡に限定する。
 *
 * @function createCfsSessionCorrelationValue
 * @param {*} sessionId - raw session ID。
 * @param {*} salt - export-local salt。
 * @returns {string} correlation value。入力不足時は空文字。
 * @example
 * const value = createCfsSessionCorrelationValue("session-1", "salt-1");
 */
export function createCfsSessionCorrelationValue(sessionId, salt) {
  const normalizedSessionId = toText(sessionId);
  const normalizedSalt = toText(salt);
  if (!normalizedSessionId || !normalizedSalt) {
    return "";
  }
  return createPrinterCoreV3DeterministicId("cfs-session-correlation", [
    CFS_SESSION_CORRELATION_ALGORITHM,
    normalizedSalt,
    stableStringifyPrinterCoreV3Value(normalizedSessionId),
  ]);
}

/**
 * CFS session correlation evidenceを生成する。
 *
 * 【詳細説明】
 * - raw session IDは返さず、algorithm/salt/valueだけを返す。
 * - session IDが空の場合はvalueを空にして、呼び出し側がmissingとして扱えるようにする。
 *
 * @function createCfsSessionCorrelationEvidence
 * @param {*} sessionId - raw session ID。
 * @param {Object=} options - evidence生成options。
 * @param {string=} options.salt - export-local salt。省略時は新規生成。
 * @returns {{algorithm:string,salt:string,value:string}} correlation evidence。
 * @example
 * const evidence = createCfsSessionCorrelationEvidence("session-1", { salt: "salt-1" });
 */
export function createCfsSessionCorrelationEvidence(sessionId, options = {}) {
  const salt = toText(options.salt) || createCfsSessionCorrelationSalt();
  return {
    algorithm: CFS_SESSION_CORRELATION_ALGORITHM,
    salt,
    value: createCfsSessionCorrelationValue(sessionId, salt),
  };
}

/**
 * correlation evidence候補を正規化する。
 *
 * 【詳細説明】
 * - algorithm違い、salt欠落、value欠落は照合不可として空値へ落とす。
 * - 呼び出し側は`value`の有無だけでcorrelation照合可能性を判定できる。
 *
 * @function normalizeCfsSessionCorrelationEvidence
 * @param {*} evidence - correlation evidence候補。
 * @returns {{algorithm:string,salt:string,value:string}} 正規化済みevidence。
 * @example
 * const normalized = normalizeCfsSessionCorrelationEvidence(rawEvidence);
 */
export function normalizeCfsSessionCorrelationEvidence(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return { algorithm: "", salt: "", value: "" };
  }
  const algorithm = toText(evidence.algorithm);
  const salt = toText(evidence.salt);
  const value = toText(evidence.value);
  if (algorithm !== CFS_SESSION_CORRELATION_ALGORITHM || !salt || !value) {
    return { algorithm: "", salt: "", value: "" };
  }
  return { algorithm, salt, value };
}

/**
 * raw session IDがcorrelation evidenceに一致するか判定する。
 *
 * 【詳細説明】
 * - redacted certification exportとlocal exportのprint-start snapshot sessionを照合するために使う。
 * - evidenceが照合不可の場合やsession IDが空の場合はfalseを返す。
 *
 * @function doesCfsSessionMatchCorrelationEvidence
 * @param {*} sessionId - raw session ID。
 * @param {*} evidence - correlation evidence候補。
 * @returns {boolean} 同じsessionを示す場合true。
 * @example
 * const ok = doesCfsSessionMatchCorrelationEvidence("session-1", evidence);
 */
export function doesCfsSessionMatchCorrelationEvidence(sessionId, evidence) {
  const normalized = normalizeCfsSessionCorrelationEvidence(evidence);
  const sessionText = toText(sessionId);
  if (!sessionText || !normalized.value) {
    return false;
  }
  return createCfsSessionCorrelationValue(sessionText, normalized.salt) === normalized.value;
}
