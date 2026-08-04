/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 フィラメント残量モデル モジュール
 * @file dashboard_filament_remaining_model.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_filament_remaining_model
 *
 * 【機能内容サマリ】
 * - O8/O9 向けに、確定残量と推定残量を分離した Model 層 API を提供する。
 * - pending inferred candidate から表示用 projected 残量を集計する。
 * - runout、印刷可否、在庫消費、廃棄などの不可逆判断では confirmed 残量だけを返す。
 *
 * 【公開関数一覧】
 * - {@link buildFilamentRemainingModel}：確定残量・推定残量・不可逆ゲート情報を構築する
 * - {@link getIrreversibleFilamentRemaining}：不可逆判断用の確定残量だけを取得する
 * - {@link canExecuteIrreversibleRemainingAction}：必要量つき不可逆判断を confirmed 残量で検証する
 *
 * @version 1.390.1280 (PR #427)
 * @since   1.390.1280 (PR #427)
 * @lastModified 2026-08-04 14:20:23
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

import { monitorData } from "./dashboard_data.js";
import { INFERRED_CANDIDATE_STATUS } from "./dashboard_offline_candidate_store.js";

/**
 * 残量モデルの用途分類。
 *
 * 【詳細説明】
 * - `DISPLAY` は projected 残量を表示してよい用途を表す。
 * - `IRREVERSIBLE` は在庫や台帳、実行可否を変える用途を表し、confirmed 残量だけを使う。
 *
 * @enum {string}
 */
export const FILAMENT_REMAINING_USAGE_KIND = Object.freeze({
  DISPLAY: "display",
  IRREVERSIBLE: "irreversible"
});

/**
 * 不可逆残量判断の代表アクション。
 *
 * 【詳細説明】
 * - 文字列は監査ログや UI 表示に出しても意味が分かるよう、用途名をそのまま保持する。
 * - 新しい不可逆操作を追加する場合も、Model 層の confirmed-only ゲートを経由させる。
 *
 * @enum {string}
 */
export const IRREVERSIBLE_REMAINING_ACTION = Object.freeze({
  RUNOUT_DECISION: "runout-decision",
  PRINT_START_GATE: "print-start-gate",
  INVENTORY_CONSUMPTION: "inventory-consumption",
  SPOOL_DISCARD: "spool-discard",
  AUTO_SPOOL_SELECTION: "auto-spool-selection",
  ORDER_ALERT: "order-alert",
  PRODUCTION_PLANNING: "production-planning",
  LEDGER_MUTATION: "ledger-mutation"
});

/**
 * 値を有限な mm 数へ正規化する。
 *
 * 【詳細説明】
 * - signed 残量仕様では負値も有効なので、0 未満を拒否しない。
 * - `null` や非数は残量不明として `null` へ落とす。
 *
 * @private
 * @function _finiteMmOrNull
 * @param {*} value - mm 相当の値。
 * @returns {?number} 有限数なら number、不明なら null。
 */
function _finiteMmOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * スプール ID またはスプールオブジェクトから実スプールを解決する。
 *
 * 【詳細説明】
 * - UI からはオブジェクト、テストやドメイン処理からは ID が渡るため両方を受ける。
 * - 見つからない場合は `null` を返し、呼び出し側が fail-closed できるようにする。
 *
 * @private
 * @function _resolveSpool
 * @param {string|Object|null|undefined} spoolOrId - スプール ID またはスプールオブジェクト。
 * @returns {?Object} 解決済みスプール。
 */
function _resolveSpool(spoolOrId) {
  if (!spoolOrId) return null;
  if (typeof spoolOrId === "object") return spoolOrId;
  const id = String(spoolOrId);
  return (monitorData.filamentSpools || []).find(spool => String(spool?.id) === id || String(spool?.spoolId) === id) || null;
}

/**
 * candidate store の値配列を取得する。
 *
 * 【詳細説明】
 * - import/restore 直後などで store が未初期化でも空配列として扱う。
 * - テストでは `options.candidates` を渡すことで monitorData に依存せず検証できる。
 *
 * @private
 * @function _candidateRecords
 * @param {{candidates?:Array<Object>|Object.<string,Object>}} [options] - candidate 注入オプション。
 * @returns {Array<Object>} candidate record 配列。
 */
function _candidateRecords(options = {}) {
  const source = options.candidates ?? monitorData.inferredCandidateStore;
  if (Array.isArray(source)) return source.filter(Boolean);
  if (source && typeof source === "object") return Object.values(source).filter(Boolean);
  return [];
}

/**
 * スプールに紐付く pending inferred candidate を取得する。
 *
 * 【詳細説明】
 * - confirmed/rejected/reassigned/superseded/undone は確定済みまたは退避済みなので projected 残量へ含めない。
 * - candidate は host を跨いで同じ spool に積まれる可能性があるため、既定では spool 単位で合算する。
 * - `host` が指定された場合だけ host 単位の表示へ絞る。
 *
 * @private
 * @function _pendingCandidatesForSpool
 * @param {string} spoolId - 対象スプール ID。
 * @param {{host?:string,candidates?:Array<Object>|Object.<string,Object>}} [options] - 絞り込みオプション。
 * @returns {Array<Object>} pending candidate 配列。
 */
function _pendingCandidatesForSpool(spoolId, options = {}) {
  if (!spoolId) return [];
  const host = options.host != null ? String(options.host) : null;
  return _candidateRecords(options).filter(record => {
    if (!record || record.status !== INFERRED_CANDIDATE_STATUS.PENDING) return false;
    if (String(record.candidateSpoolId ?? "") !== String(spoolId)) return false;
    if (host && String(record.host ?? "") !== host) return false;
    const usedMm = _finiteMmOrNull(record.usedMm);
    return usedMm != null && usedMm > 0;
  });
}

/**
 * pending candidate の推定使用量を合計する。
 *
 * 【詳細説明】
 * - O8 表示用の projected 残量にだけ使う。
 * - 不正値や 0 以下の usedMm は候補表示対象にしない。
 *
 * @private
 * @function _sumPendingUsedMm
 * @param {Array<Object>} records - pending candidate 配列。
 * @returns {number} 推定使用量合計 mm。
 */
function _sumPendingUsedMm(records) {
  return records.reduce((sum, record) => {
    const usedMm = _finiteMmOrNull(record?.usedMm);
    return usedMm != null && usedMm > 0 ? sum + usedMm : sum;
  }, 0);
}

/**
 * 確定残量・推定残量・不可逆ゲート情報を構築する。
 *
 * 【詳細説明】
 * - `confirmedRemainingMm` は `spool.remainingLengthMm` の raw signed 値であり、台帳上の真値として扱う。
 * - `projectedRemainingMm` は pending inferred candidate を差し引いた表示・予測専用の値であり、保存しない。
 * - `irreversibleRemainingMm` は常に confirmed 残量と同じ値を返し、projected 値を不可逆判断へ混入させない。
 *
 * @function buildFilamentRemainingModel
 * @param {string|Object|null|undefined} spoolOrId - スプール ID またはスプールオブジェクト。
 * @param {{host?:string,candidates?:Array<Object>|Object.<string,Object>}} [options] - 表示対象の絞り込み。
 * @returns {{
 *   ok:boolean,
 *   reason:?string,
 *   spool:?Object,
 *   spoolId:?string,
 *   confirmedRemainingMm:?number,
 *   pendingInferredUsedMm:number,
 *   pendingCandidateCount:number,
 *   pendingCandidateHashes:Array<string>,
 *   projectedRemainingMm:?number,
 *   hasPendingInferredUsage:boolean,
 *   usageKind:string,
 *   irreversibleRemainingMm:?number,
 *   irreversibleSource:string,
 *   warnings:Array<string>
 * }} 残量 Model。
 * @example
 * const model = buildFilamentRemainingModel(spool);
 */
export function buildFilamentRemainingModel(spoolOrId, options = {}) {
  const spool = _resolveSpool(spoolOrId);
  if (!spool) {
    return {
      ok: false,
      reason: "spool_not_found",
      spool: null,
      spoolId: null,
      confirmedRemainingMm: null,
      pendingInferredUsedMm: 0,
      pendingCandidateCount: 0,
      pendingCandidateHashes: [],
      projectedRemainingMm: null,
      hasPendingInferredUsage: false,
      usageKind: FILAMENT_REMAINING_USAGE_KIND.DISPLAY,
      irreversibleRemainingMm: null,
      irreversibleSource: "confirmed-ledger",
      warnings: ["spool-not-found"]
    };
  }

  const spoolId = String(spool.id ?? spool.spoolId ?? "");
  const confirmedRemainingMm = _finiteMmOrNull(spool.remainingLengthMm);
  const pendingCandidates = _pendingCandidatesForSpool(spoolId, options);
  const pendingInferredUsedMm = _sumPendingUsedMm(pendingCandidates);
  const projectedRemainingMm = confirmedRemainingMm == null
    ? null
    : confirmedRemainingMm - pendingInferredUsedMm;
  const warnings = [];
  if (confirmedRemainingMm == null) warnings.push("confirmed-remaining-unknown");
  if (pendingInferredUsedMm > 0) warnings.push("projected-remaining-display-only");

  return {
    ok: confirmedRemainingMm != null,
    reason: confirmedRemainingMm == null ? "confirmed_remaining_unknown" : null,
    spool,
    spoolId,
    confirmedRemainingMm,
    pendingInferredUsedMm,
    pendingCandidateCount: pendingCandidates.length,
    pendingCandidateHashes: pendingCandidates.map(record => String(record.candidateHash ?? "")).filter(Boolean),
    projectedRemainingMm,
    hasPendingInferredUsage: pendingInferredUsedMm > 0,
    usageKind: FILAMENT_REMAINING_USAGE_KIND.DISPLAY,
    irreversibleRemainingMm: confirmedRemainingMm,
    irreversibleSource: "confirmed-ledger",
    warnings
  };
}

/**
 * 不可逆判断用の確定残量だけを取得する。
 *
 * 【詳細説明】
 * - O9 の中心契約として、pending inferred candidate が存在しても projected 残量は返すだけで判断値にしない。
 * - 呼び出し元は `remainingMm` のみを runout/廃棄/自動選択/在庫消費などの判定に使う。
 * - 確定残量が不明な場合は fail-closed で `ok:false` を返す。
 *
 * @function getIrreversibleFilamentRemaining
 * @param {string|Object|null|undefined} spoolOrId - スプール ID またはスプールオブジェクト。
 * @param {{action?:string,host?:string,candidates?:Array<Object>|Object.<string,Object>}} [options] - 判定文脈。
 * @returns {{
 *   ok:boolean,
 *   reason:?string,
 *   action:string,
 *   spoolId:?string,
 *   remainingMm:?number,
 *   source:string,
 *   projectedRemainingMm:?number,
 *   ignoredPendingInferredUsedMm:number
 * }} 不可逆判断用残量。
 * @example
 * const gate = getIrreversibleFilamentRemaining(spool, { action: IRREVERSIBLE_REMAINING_ACTION.RUNOUT_DECISION });
 */
export function getIrreversibleFilamentRemaining(spoolOrId, options = {}) {
  const model = buildFilamentRemainingModel(spoolOrId, options);
  const action = options.action || IRREVERSIBLE_REMAINING_ACTION.LEDGER_MUTATION;
  if (!model.ok) {
    return {
      ok: false,
      reason: model.reason || "confirmed_remaining_unknown",
      action,
      spoolId: model.spoolId,
      remainingMm: null,
      source: "confirmed-ledger",
      projectedRemainingMm: model.projectedRemainingMm,
      ignoredPendingInferredUsedMm: model.pendingInferredUsedMm
    };
  }
  return {
    ok: true,
    reason: null,
    action,
    spoolId: model.spoolId,
    remainingMm: model.confirmedRemainingMm,
    source: "confirmed-ledger",
    projectedRemainingMm: model.projectedRemainingMm,
    ignoredPendingInferredUsedMm: model.pendingInferredUsedMm
  };
}

/**
 * 必要量を伴う不可逆判断を confirmed 残量だけで検証する。
 *
 * 【詳細説明】
 * - print start gate や自動 spool 選択などで「指定量を満たすか」を確認するための Model API。
 * - pending inferred candidate で projected 残量が不足していても、この関数の判定は confirmed 残量だけで行う。
 * - 逆に projected 残量が足りていても confirmed が不足する場合は拒否する。
 *
 * @function canExecuteIrreversibleRemainingAction
 * @param {string|Object|null|undefined} spoolOrId - スプール ID またはスプールオブジェクト。
 * @param {*} requiredMm - 必要量 mm。
 * @param {{action?:string,host?:string,candidates?:Array<Object>|Object.<string,Object>}} [options] - 判定文脈。
 * @returns {{
 *   ok:boolean,
 *   reason:?string,
 *   action:string,
 *   spoolId:?string,
 *   remainingMm:?number,
 *   requiredMm:number,
 *   projectedRemainingMm:?number,
 *   ignoredPendingInferredUsedMm:number
 * }} 判定結果。
 * @example
 * const canPrint = canExecuteIrreversibleRemainingAction(spool, 12000, { action: "print-start-gate" });
 */
export function canExecuteIrreversibleRemainingAction(spoolOrId, requiredMm, options = {}) {
  const required = Math.max(0, Number(requiredMm) || 0);
  const gate = getIrreversibleFilamentRemaining(spoolOrId, options);
  if (!gate.ok) {
    return {
      ...gate,
      requiredMm: required
    };
  }
  const ok = gate.remainingMm >= required;
  return {
    ...gate,
    ok,
    reason: ok ? null : "confirmed_remaining_insufficient",
    requiredMm: required
  };
}
