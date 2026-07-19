/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用オフライン継続推定残量 projection モジュール
 * @file dashboard_offline_projection.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_offline_projection
 *
 * 【機能内容サマリ】
 * - #411-O3 の純粋 projection として、O2 の continuity candidate を確定残量へ直接混ぜず、
 *   未帰属のオフライン完了分だけを推定 debit として集計する。
 * - 確定済み履歴と observation key を照合し、同一スプール確定済み・別スプール確定済み・
 *   履歴消失・未帰属を分離することで、二重減算と誤帰属を防ぐ。
 * - spool.remainingLengthMm、mountHistory、usedLengthLog、filamentInfo などの確定台帳には
 *   一切書き込まない。UI・ライブ残量・不可逆操作への接続は O4/O5 以降で行う。
 *
 * 【公開関数一覧】
 * - {@link estimateHistoryEntryUsedMm}：履歴行から projection 用の消費量を抽出する。
 * - {@link evaluateCandidateObservationKey}：candidate の observation key 1件を履歴へ照合する。
 * - {@link buildInferredContinuityProjection}：candidate 全体から推定残量 projection を作る。
 *
 * @version 1.390.1244 (PR #411)
 * @since   1.390.1244 (PR #411)
 * @lastModified  2026-07-19 18:21:09
 * -----------------------------------------------------------
 * @todo
 * - O4 で candidate 永続化・状態遷移・親子同期へ接続する。
 * - O5 で確認・否認・再割当て UI と不可逆操作ゲートへ接続する。
 */

"use strict";

import { jobObservationIdentity } from "./dashboard_history_identity.js";

/** O2 continuity candidate の分類ラベル。classifier import による dashboard_data 依存を避けるため文字列を局所保持する。 */
const CONTINUITY_CANDIDATE = "continuity-candidate";

/**
 * projection で扱う observation key 1件の照合状態。
 *
 * @typedef {Object} CandidateDebitEvaluation
 * @property {string} observationKey - O1/O2 が生成した完了ジョブの複合 observation key。
 * @property {string} status - 照合結果。`inferred-debit` / `confirmed-same-spool` /
 *   `confirmed-other-spool` / `unresolved` / `no-usage` のいずれか。
 * @property {number} usedMm - この key に紐づく消費量 mm。推定 debit 対象外でも監査用に保持する。
 * @property {?string} candidateSpoolId - O2 が推定候補として提示したスプール ID。
 * @property {?Array<string>} confirmedSpoolIds - 履歴上で既に確定帰属しているスプール ID 一覧。
 * @property {?Object} entry - 照合した履歴行。見つからない場合は null。
 * @property {string} reason - status の理由を UI/監査へ渡すための短い識別子。
 */

/**
 * projection 全体の戻り値。
 *
 * @typedef {Object} InferredContinuityProjection
 * @property {?string} host - 対象ホスト名。
 * @property {?string} spoolId - projection 対象スプール ID。
 * @property {?string} windowId - O1/O2 の ObservationWindow ID。
 * @property {?string} classification - O2 分類ラベル。
 * @property {number} confirmedRemainingMm - 確定台帳だけから見た残量 mm。
 * @property {number} inferredContinuityUsedMm - 未帰属かつ継続候補として推定 debit する消費量 mm。
 * @property {number} projectedRemainingMm - `confirmedRemainingMm - inferredContinuityUsedMm` の表示用推定残量 mm。
 * @property {Array<CandidateDebitEvaluation>} candidateDebits - candidate key ごとの照合結果。
 * @property {Array<CandidateDebitEvaluation>} contradictions - 別スプール確定済みなど、推定と矛盾する key。
 * @property {Array<CandidateDebitEvaluation>} unresolved - 履歴消失・消費量不明など projection へ入れられない key。
 * @property {boolean} readOnly - この関数群が確定台帳へ書き込まないことを示す固定フラグ。
 */

/**
 * 数値を非負の mm 値へ正規化する。
 *
 * 【詳細説明】
 * - 履歴や spool に文字列値が混ざっても projection の合計値が NaN へ崩れないようにする。
 * - 負値や非数は「消費なし」として 0 に丸める。確定台帳の値自体は変更しない。
 *
 * @private
 * @function _nonNegativeMm
 * @param {*} value - mm として解釈したい任意値。
 * @returns {number} 0 以上の有限数。
 */
function _nonNegativeMm(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * observation key から lookup 用 Map を構築する。
 *
 * 【詳細説明】
 * - O1/O2 と同じ `jobObservationIdentity()` を使い、ID だけでなく開始/完了時刻・ファイル署名を
 *   含む複合 key で履歴行を検索できるようにする。
 * - 同一 key が複数ある場合は、最初に見つけた履歴行を保持する。重複がある時点で履歴側が
 *   既に曖昧なので、projection は台帳を書き換えず監査情報だけを返す。
 *
 * @private
 * @function _historyByObservationKey
 * @param {Array<Object>} history - printStore.history 相当の履歴配列。
 * @returns {Map<string,Object>} observation key から履歴行への Map。
 */
function _historyByObservationKey(history) {
  const map = new Map();
  if (!Array.isArray(history)) return map;
  for (const entry of history) {
    const identity = jobObservationIdentity(entry);
    if (!identity || !identity.key || map.has(identity.key)) continue;
    map.set(identity.key, entry);
  }
  return map;
}

/**
 * 履歴行の確定帰属スプール ID 一覧を返す。
 *
 * 【詳細説明】
 * - `filamentInfo[].spoolId` を最優先にし、配列にスプール情報が無い場合だけ `filamentId` を見る。
 * - `filamentId="none"` や空文字は確定スプールではないため除外する。
 * - 重複は Set で畳み、projection 側の二重判定を防ぐ。
 *
 * @private
 * @function _confirmedSpoolIds
 * @param {Object} entry - 履歴行。
 * @returns {Array<string>} 確定帰属済みのスプール ID 一覧。
 */
function _confirmedSpoolIds(entry) {
  const ids = new Set();
  const info = Array.isArray(entry?.filamentInfo) ? entry.filamentInfo : [];
  for (const item of info) {
    const id = item?.spoolId == null ? "" : String(item.spoolId).trim();
    if (id && id !== "none") ids.add(id);
  }
  if (ids.size === 0) {
    const id = entry?.filamentId == null ? "" : String(entry.filamentId).trim();
    if (id && id !== "none") ids.add(id);
  }
  return [...ids];
}

/**
 * 履歴行から projection 用の消費量を抽出する。
 *
 * 【詳細説明】
 * - `materialUsedMm` が正であればジョブ総消費として採用する。
 * - `materialUsedMm` が無い旧データでは `filamentInfo[].usedMm` の合計を fallback にする。
 * - ここで得た値は「推定 debit の素材量」であり、確定台帳へは書き戻さない。
 *
 * @function estimateHistoryEntryUsedMm
 * @param {Object} entry - printStore.history の履歴行。
 * @returns {number} projection に使える消費量 mm。判定不能や 0 以下は 0。
 * @example
 * const usedMm = estimateHistoryEntryUsedMm({ materialUsedMm: 1200 });
 */
export function estimateHistoryEntryUsedMm(entry) {
  const materialUsed = _nonNegativeMm(entry?.materialUsedMm);
  if (materialUsed > 0) return materialUsed;
  const info = Array.isArray(entry?.filamentInfo) ? entry.filamentInfo : [];
  let total = 0;
  for (const item of info) total += _nonNegativeMm(item?.usedMm);
  return total;
}

/**
 * candidate の observation key 1件を履歴へ照合し、推定 debit 対象か分類する。
 *
 * 【詳細説明】
 * - 履歴に存在しない key は `unresolved` とし、推定残量へ入れない。履歴切詰めや削除を
 *   「使ったはず」と決め打ちしないため。
 * - 候補スプールへ既に確定帰属済みなら `confirmed-same-spool` とし、二重減算を防ぐ。
 * - 別スプールへ確定帰属済みなら `confirmed-other-spool` とし、矛盾として返す。
 * - 未帰属で消費量がある場合だけ `inferred-debit` として projectedRemainingMm に反映する。
 *
 * @function evaluateCandidateObservationKey
 * @param {string} observationKey - O2 candidate の observation key。
 * @param {?Object} entry - observation key に一致した履歴行。見つからない場合は null。
 * @param {string} candidateSpoolId - O2 が提示した候補スプール ID。
 * @returns {CandidateDebitEvaluation} key 1件の projection 判定。
 * @example
 * const evaluation = evaluateCandidateObservationKey(key, historyEntry, "spool-1");
 */
export function evaluateCandidateObservationKey(observationKey, entry, candidateSpoolId) {
  const candidateId = candidateSpoolId == null ? null : String(candidateSpoolId);
  if (!entry) {
    return {
      observationKey,
      status: "unresolved",
      usedMm: 0,
      candidateSpoolId: candidateId,
      confirmedSpoolIds: [],
      entry: null,
      reason: "history-entry-missing"
    };
  }

  const usedMm = estimateHistoryEntryUsedMm(entry);
  const confirmedSpoolIds = _confirmedSpoolIds(entry);
  if (confirmedSpoolIds.includes(candidateId)) {
    return {
      observationKey,
      status: "confirmed-same-spool",
      usedMm,
      candidateSpoolId: candidateId,
      confirmedSpoolIds,
      entry,
      reason: "already-confirmed-on-candidate-spool"
    };
  }
  if (confirmedSpoolIds.length > 0) {
    return {
      observationKey,
      status: "confirmed-other-spool",
      usedMm,
      candidateSpoolId: candidateId,
      confirmedSpoolIds,
      entry,
      reason: "already-confirmed-on-other-spool"
    };
  }
  if (usedMm <= 0) {
    return {
      observationKey,
      status: "no-usage",
      usedMm: 0,
      candidateSpoolId: candidateId,
      confirmedSpoolIds,
      entry,
      reason: "usage-missing-or-zero"
    };
  }
  return {
    observationKey,
    status: "inferred-debit",
    usedMm,
    candidateSpoolId: candidateId,
    confirmedSpoolIds,
    entry,
    reason: "unattributed-usage"
  };
}

/**
 * O2 continuity candidate から O3 の純粋 projection を構築する。
 *
 * 【詳細説明】
 * - `classificationResult.classification` が `continuity-candidate` でない場合は推定 debit しない。
 * - `spool.remainingLengthMm` を `confirmedRemainingMm` として読み、未帰属 candidate の消費量だけを
 *   `inferredContinuityUsedMm` に集計する。
 * - `projectedRemainingMm` は表示・計画用の推定値であり、spool オブジェクトへは書き戻さない。
 * - 入力履歴に同一 observation key が既に候補スプールへ確定帰属している場合は対象外にし、
 *   別スプール確定済みなら contradictions に分離する。
 *
 * @function buildInferredContinuityProjection
 * @param {{classification:string, host?:?string, windowId?:?string, candidate?:?Object}} classificationResult -
 *   `classifyObservationWindow()` の戻り値。
 * @param {Object} spool - projection 対象スプール。`id` と `remainingLengthMm` を読む。
 * @param {Array<Object>} history - printStore.history 相当の履歴配列。
 * @returns {InferredContinuityProjection} O3 projection 結果。
 * @example
 * const projection = buildInferredContinuityProjection(classification, spool, history);
 */
export function buildInferredContinuityProjection(classificationResult, spool, history) {
  const confirmedRemainingMm = _nonNegativeMm(spool?.remainingLengthMm);
  const candidate = classificationResult?.candidate || null;
  const candidateSpoolId = candidate?.candidateSpoolId == null ? null : String(candidate.candidateSpoolId);
  const base = {
    host: classificationResult?.host ?? null,
    spoolId: spool?.id == null ? candidateSpoolId : String(spool.id),
    windowId: classificationResult?.windowId ?? candidate?.windowId ?? null,
    classification: classificationResult?.classification ?? null,
    confirmedRemainingMm,
    inferredContinuityUsedMm: 0,
    projectedRemainingMm: confirmedRemainingMm,
    candidateDebits: [],
    contradictions: [],
    unresolved: [],
    readOnly: true
  };

  // O2 が継続候補を出していない、または対象スプールが一致しない場合は debit しない。
  if (classificationResult?.classification !== CONTINUITY_CANDIDATE || !candidateSpoolId) {
    return base;
  }
  if (spool?.id != null && String(spool.id) !== candidateSpoolId) {
    return { ...base, contradictions: [{
      observationKey: "",
      status: "confirmed-other-spool",
      usedMm: 0,
      candidateSpoolId,
      confirmedSpoolIds: [String(spool.id)],
      entry: null,
      reason: "projection-spool-mismatch"
    }] };
  }

  const byKey = _historyByObservationKey(history);
  const keys = Array.isArray(candidate.offlineObservationKeys) ? candidate.offlineObservationKeys : [];
  const candidateDebits = keys.map(key => evaluateCandidateObservationKey(key, byKey.get(key) || null, candidateSpoolId));
  const contradictions = candidateDebits.filter(item => item.status === "confirmed-other-spool");
  const unresolved = candidateDebits.filter(item => item.status === "unresolved" || item.status === "no-usage");
  const inferredContinuityUsedMm = candidateDebits
    .filter(item => item.status === "inferred-debit")
    .reduce((sum, item) => sum + _nonNegativeMm(item.usedMm), 0);

  return {
    ...base,
    inferredContinuityUsedMm,
    projectedRemainingMm: Math.max(0, confirmedRemainingMm - inferredContinuityUsedMm),
    candidateDebits,
    contradictions,
    unresolved
  };
}
