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
 *   履歴消失・未帰属・履歴曖昧性を分離することで、二重減算と誤帰属を防ぐ。
 * - window 内に矛盾や曖昧性がある場合は projection 全体を fail-closed し、O4 永続化へ進ませない。
 * - spool.remainingLengthMm、mountHistory、usedLengthLog、filamentInfo などの確定台帳には
 *   一切書き込まない。UI・ライブ残量・不可逆操作への接続は O4/O5 以降で行う。
 *
 * 【公開関数一覧】
 * - {@link estimateHistoryEntryUsedMm}：履歴行から projection 用の消費量を抽出する。
 * - {@link evaluateCandidateObservationKey}：candidate の observation key 1件を履歴へ照合する。
 * - {@link buildInferredContinuityProjection}：candidate 全体から推定残量 projection を作る。
 *
 * @version 1.390.1278 (PR #426)
 * @since   1.390.1244 (PR #411)
 * @lastModified 2026-08-04 09:22:41
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
 * @property {boolean} ok - O4 永続化へ進められる projection なら true。
 * @property {string} status - `ok` / `not-continuity-candidate` / `contradicted` /
 *   `unresolved` / `remaining-unknown` / `ambiguous-history` / `projection-spool-mismatch` のいずれか。
 * @property {boolean} eligibleForPersistence - O4 candidate store へ保存可能なら true。
 * @property {?number} confirmedRemainingMm - 確定台帳だけから見た残量 mm。不明な場合は null。
 * @property {number} inferredContinuityUsedMm - 未帰属かつ継続候補として推定 debit する消費量 mm。
 * @property {?number} projectedRemainingMm - `confirmedRemainingMm - inferredContinuityUsedMm` の表示用推定残量 mm。
 *   確定残量が不明な場合は null。
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
 * 確定残量として使える値を正規化する。
 *
 * 【詳細説明】
 * - `remainingLengthMm` の負値は「使い切り後も印刷できた監査値」として有効に扱う。
 * - null/undefined/NaN は「不明」として扱う。
 * - O5 の UI や不可逆操作 gate が「空」と「不明」を混同しないよう、不明値は null のまま返す。
 *
 * @private
 * @function _remainingOrNull
 * @param {*} value - spool.remainingLengthMm 相当の値。
 * @returns {?number} 有効な有限数値。不明な場合は null。
 */
function _remainingOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * observation key から lookup 用 Map を構築する。
 *
 * 【詳細説明】
 * - O1/O2 と同じ `jobObservationIdentity()` を使い、ID だけでなく開始/完了時刻・ファイル署名を
 *   含む複合 key で履歴行を検索できるようにする。
 * - 同一 key が複数ある場合は ambiguous として記録し、履歴配列順に依存した first-wins を避ける。
 *
 * @private
 * @function _historyByObservationKey
 * @param {Array<Object>} history - printStore.history 相当の履歴配列。
 * @returns {Map<string,{status:string, entries:Array<Object>}>} observation key から履歴候補への Map。
 */
function _historyByObservationKey(history) {
  const map = new Map();
  if (!Array.isArray(history)) return map;
  for (const entry of history) {
    const identity = jobObservationIdentity(entry);
    if (!identity || !identity.key) continue;
    const current = map.get(identity.key);
    if (!current) {
      map.set(identity.key, { status: "unique", entries: [entry] });
      continue;
    }
    current.status = "ambiguous";
    current.entries.push(entry);
  }
  return map;
}

/**
 * 履歴 lookup レコードから一意の entry を取り出す。
 *
 * 【詳細説明】
 * - 履歴に key が無い場合は missing、同一 key が複数ある場合は ambiguous を返す。
 * - ambiguous は O3 window 全体の fail-closed 条件として扱う。
 *
 * @private
 * @function _entryLookupState
 * @param {?Object} lookup - `_historyByObservationKey()` の値、または後方互換用の履歴行。
 * @returns {{status:string, entry:?Object, entries:Array<Object>}}
 */
function _entryLookupState(lookup) {
  if (!lookup) return { status: "missing", entry: null, entries: [] };
  if (lookup.status === "ambiguous") return { status: "ambiguous", entry: null, entries: lookup.entries || [] };
  if (lookup.status === "unique") return { status: "unique", entry: lookup.entries?.[0] || null, entries: lookup.entries || [] };
  return { status: "unique", entry: lookup, entries: [lookup] };
}

/**
 * 値を有効な確定スプール ID として集合へ追加する。
 *
 * @private
 * @function _addConfirmedId
 * @param {Set<string>} ids - 追加先 Set。
 * @param {*} value - スプール ID 候補値。
 * @returns {void}
 */
function _addConfirmedId(ids, value) {
  const id = value == null ? "" : String(value).trim();
  if (id && id !== "none") ids.add(id);
}

/**
 * 履歴行の確定帰属スプール情報を、矛盾検出付きで返す。
 *
 * 【詳細説明】
 * - `filamentInfo[].spoolId` と `filamentId` の両方を同じ確定ソースとして集合化する。
 * - 複数の spool ID が同じ履歴行に現れた場合は、確定ソース同士が競合しているため ambiguous とする。
 *
 * @private
 * @function _confirmedSpoolState
 * @param {Object} entry - 履歴行。
 * @returns {{ids:Array<string>, ambiguous:boolean, reason:?string}} 確定スプール情報。
 */
function _confirmedSpoolState(entry) {
  const ids = new Set();
  const info = Array.isArray(entry?.filamentInfo) ? entry.filamentInfo : [];
  for (const item of info) _addConfirmedId(ids, item?.spoolId);
  _addConfirmedId(ids, entry?.filamentId);
  const out = [...ids];
  return {
    ids: out,
    ambiguous: out.length > 1,
    reason: out.length > 1 ? "conflicting-confirmed-spool-fields" : null
  };
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
 * @param {?Object} entry - observation key に一致した履歴行、または lookup レコード。見つからない場合は null。
 * @param {string} candidateSpoolId - O2 が提示した候補スプール ID。
 * @returns {CandidateDebitEvaluation} key 1件の projection 判定。
 * @example
 * const evaluation = evaluateCandidateObservationKey(key, historyEntry, "spool-1");
 */
export function evaluateCandidateObservationKey(observationKey, entry, candidateSpoolId) {
  const candidateId = candidateSpoolId == null ? null : String(candidateSpoolId);
  const lookup = _entryLookupState(entry);
  if (lookup.status === "ambiguous") {
    return {
      observationKey,
      status: "unresolved",
      usedMm: 0,
      candidateSpoolId: candidateId,
      confirmedSpoolIds: [],
      entry: null,
      reason: "duplicate-observation-key"
    };
  }
  const resolvedEntry = lookup.entry;
  if (!resolvedEntry) {
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

  const usedMm = estimateHistoryEntryUsedMm(resolvedEntry);
  const confirmedState = _confirmedSpoolState(resolvedEntry);
  const confirmedSpoolIds = confirmedState.ids;
  if (confirmedState.ambiguous) {
    return {
      observationKey,
      status: "unresolved",
      usedMm,
      candidateSpoolId: candidateId,
      confirmedSpoolIds,
      entry: resolvedEntry,
      reason: confirmedState.reason
    };
  }
  if (confirmedSpoolIds.includes(candidateId)) {
    return {
      observationKey,
      status: "confirmed-same-spool",
      usedMm,
      candidateSpoolId: candidateId,
      confirmedSpoolIds,
      entry: resolvedEntry,
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
      entry: resolvedEntry,
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
      entry: resolvedEntry,
      reason: "usage-missing-or-zero"
    };
  }
  return {
    observationKey,
    status: "inferred-debit",
    usedMm,
    candidateSpoolId: candidateId,
    confirmedSpoolIds,
    entry: resolvedEntry,
    reason: "unattributed-usage"
  };
}

/**
 * O2 continuity candidate から O3 の純粋 projection を構築する。
 *
 * 【詳細説明】
 * - `classificationResult.classification` が `continuity-candidate` でない場合は推定 debit しない。
 * - `spool.remainingLengthMm` が有限値の場合だけ `confirmedRemainingMm` として読み、不明値は null として返す。
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
  const confirmedRemainingMm = _remainingOrNull(spool?.remainingLengthMm);
  const candidate = classificationResult?.candidate || null;
  const candidateSpoolId = candidate?.candidateSpoolId == null ? null : String(candidate.candidateSpoolId);
  const base = {
    host: classificationResult?.host ?? null,
    spoolId: spool?.id == null ? candidateSpoolId : String(spool.id),
    windowId: classificationResult?.windowId ?? candidate?.windowId ?? null,
    classification: classificationResult?.classification ?? null,
    ok: false,
    status: "not-continuity-candidate",
    eligibleForPersistence: false,
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
    }], status: "projection-spool-mismatch" };
  }

  const byKey = _historyByObservationKey(history);
  const keys = Array.isArray(candidate.offlineObservationKeys) ? candidate.offlineObservationKeys : [];
  const candidateDebits = keys.map(key => evaluateCandidateObservationKey(key, byKey.get(key) || null, candidateSpoolId));
  const contradictions = candidateDebits.filter(item => item.status === "confirmed-other-spool");
  const unresolved = candidateDebits.filter(item => item.status === "unresolved" || item.status === "no-usage");
  const rawInferredContinuityUsedMm = candidateDebits
    .filter(item => item.status === "inferred-debit")
    .reduce((sum, item) => sum + _nonNegativeMm(item.usedMm), 0);
  const hasAmbiguousHistory = unresolved.some(item =>
    item.reason === "duplicate-observation-key" || item.reason === "conflicting-confirmed-spool-fields"
  );
  let status = "ok";
  if (contradictions.length > 0) status = "contradicted";
  else if (hasAmbiguousHistory) status = "ambiguous-history";
  else if (unresolved.length > 0) status = "unresolved";
  else if (confirmedRemainingMm == null) status = "remaining-unknown";

  const eligibleForPersistence = status === "ok" && rawInferredContinuityUsedMm > 0;
  const inferredContinuityUsedMm = eligibleForPersistence ? rawInferredContinuityUsedMm : 0;

  return {
    ...base,
    ok: eligibleForPersistence,
    status,
    eligibleForPersistence,
    inferredContinuityUsedMm,
    projectedRemainingMm: confirmedRemainingMm == null ? null : confirmedRemainingMm - inferredContinuityUsedMm,
    candidateDebits,
    contradictions,
    unresolved
  };
}
