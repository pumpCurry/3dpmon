/**
 * @fileoverview オフライン推定帰属(Option4)の分類レイヤ — #411-O2
 * @file dashboard_offline_classifier.js
 * @copyright (c) pumpCurry 2026 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_offline_classifier
 *
 * 【責務（レビュー#411 で固定）】O2 は Observation 層が返す ObservationWindow を入力に、
 *   純関数で「分類 → candidate → confidence(理由付き)」を生成するだけの Classification レイヤ。
 *   - 入力は ObservationWindow のみ（computeObservationWindow は USE のみ・変更しない）。
 *   - remaining / projected / 安全基盤には一切触れない（それは O3 以降）。
 *   - 副作用なし（monitorData への書き込みなし）。永続化・relay・確認UIは O4/O5。
 *
 *   ObservationWindow → classifyObservationWindow → { classification, candidate, confidence }
 *
 * @version 2.3.0
 * @since   2.3.0
 * -----------------------------------------------------------
 */

"use strict";

import { computeObservationWindow, buildConfidence } from "./dashboard_offline_observation.js";

/** 帰属分類（O2 の出力ラベル）。O3/O5 はこれで分岐する。 */
export const ATTR_CLASS = Object.freeze({
  CONTINUITY_CANDIDATE: "continuity-candidate", // bounded＋offline完了あり＋装着スプール既知
  NO_OFFLINE_ACTIVITY: "no-offline-activity",   // bounded だが offline 完了なし（帰属対象なし）
  NO_MOUNTED_SPOOL: "no-mounted-spool",         // bounded＋offline あるが baseline 未装着＝継続不能
  UNBOUNDED: "unbounded",                        // 世代交代/identity変化/巻き戻し＝窓を作れない
  INSUFFICIENT: "insufficient",                  // 識別材料不足/再利用ID未検証＝候補単位で判定不能
  NO_PRIOR: "no-prior"                           // 前回観測なし（初回導入/移行）
});

/** 観測鮮度の劣化しきい値（これを超える古さは confidence を1段下げる）。 */
const STALE_DOWNGRADE_MS = 30 * 24 * 3600 * 1000; // 30日

const _LEVELS = ["high", "medium", "low", "none"];

/** confidence レベルを1段下げる（floor 指定で下限を固定）。 */
function _downgrade(level, floor = "none") {
  const i = _LEVELS.indexOf(level);
  const fi = _LEVELS.indexOf(floor);
  if (i < 0) return floor;
  return _LEVELS[Math.min(Math.max(i + 1, 0), fi < 0 ? _LEVELS.length - 1 : fi)];
}

/** 分類結果オブジェクトを一定形で組み立てる。 */
function _result(classification, candidate, confidence, window) {
  return {
    classification,
    windowId: window?.windowId ?? null,
    bounded: !!window?.bounded,
    reason: window?.reason ?? null,
    candidate: candidate || null,
    confidence,
    offlineObservationKeys: Array.isArray(window?.offlineObservationKeys) ? window.offlineObservationKeys.slice() : [],
    unresolvedJobIds: Array.isArray(window?.unresolvedJobIds) ? window.unresolvedJobIds.slice() : []
  };
}

/**
 * ObservationWindow を分類し candidate + confidence を返す純関数（O2 の中核）。
 * Observation 層・remaining・安全基盤には触れない。
 *
 * @function classifyObservationWindow
 * @param {Object} window computeObservationWindow の戻り値（ObservationWindow）
 * @returns {{classification:string, windowId:?string, bounded:boolean, reason:?string,
 *   candidate:?Object, confidence:{level:string, reasons:string[]},
 *   offlineObservationKeys:string[], unresolvedJobIds:string[]}}
 */
export function classifyObservationWindow(window) {
  if (!window || typeof window !== "object") {
    return _result(ATTR_CLASS.NO_PRIOR, null, buildConfidence("none", ["no-window"]), window);
  }
  const wm = window.watermark || null;
  const offline = Array.isArray(window.offlineObservationKeys) ? window.offlineObservationKeys : [];
  const unresolved = Array.isArray(window.unresolvedJobIds) ? window.unresolvedJobIds : [];

  // 前回観測なし（初回導入・移行）
  if (window.reason === "no-prior-observation") {
    return _result(ATTR_CLASS.NO_PRIOR, null, buildConfidence("none", ["no-prior-observation"]), window);
  }

  // 窓を作れない（bounded=false）
  if (!window.bounded) {
    if (window.reason === "reused-job-id-unverifiable" || window.reason === "job-identity-insufficient") {
      // 候補単位で識別不能：継続推定せず、未解決 id を持ち越す
      return _result(ATTR_CLASS.INSUFFICIENT, null, buildConfidence("none", [window.reason]), window);
    }
    // identity 変化 / 時刻巻き戻し / 世代交代 / 大幅縮小＝境界不成立
    return _result(ATTR_CLASS.UNBOUNDED, null, buildConfidence("none", [window.reason || "unbounded"]), window);
  }

  // bounded だが offline 完了なし＝帰属対象なし（正常）
  if (offline.length === 0) {
    return _result(ATTR_CLASS.NO_OFFLINE_ACTIVITY, null, buildConfidence("high", ["bounded", "no-offline-jobs"]), window);
  }

  // bounded かつ offline 完了あり
  const spoolId = wm?.mountedSpoolId ?? null;
  if (spoolId == null) {
    // オフライン期間に装着スプール不明＝どのスプールへ継続帰属すべきか決められない
    return _result(ATTR_CLASS.NO_MOUNTED_SPOOL, null, buildConfidence("none", ["bounded", "no-mounted-spool-at-baseline"]), window);
  }

  // 継続候補：装着スプールを candidate に、証拠に応じて confidence を段階付け（下限 low）
  const reasons = ["bounded", "same-mounted-spool"];
  let level = "high";
  const ivStatus = wm?.mountIntervalStatus || "unknown";
  if (ivStatus === "ok") {
    reasons.push("mount-interval-ok");
  } else {
    reasons.push(`mount-interval-${ivStatus}`);
    level = _downgrade(level, "low");
  }
  if (window.truncated) { reasons.push("history-truncated"); level = _downgrade(level, "low"); }
  if (unresolved.length > 0) { reasons.push("some-unresolved-jobs"); level = _downgrade(level, "low"); }
  if ((Number(window.stalenessMs) || 0) > STALE_DOWNGRADE_MS) { reasons.push("stale-observation"); level = _downgrade(level, "low"); }

  const candidate = {
    candidateSpoolId: spoolId,
    candidateIntervalId: wm?.mountIntervalId ?? null,
    offlineObservationKeys: offline.slice(),
    unresolvedJobIds: unresolved.slice(),
    windowId: window.windowId ?? null
  };
  return _result(ATTR_CLASS.CONTINUITY_CANDIDATE, candidate, buildConfidence(level, reasons), window);
}

/**
 * host の観測窓を計算して分類する（O2 の公開エントリ）。
 * computeObservationWindow を利用するのみで、Observation 層は変更しない。read-only。
 *
 * @function classifyHostAttribution
 * @param {string} host
 * @returns {Object} classifyObservationWindow の戻り値
 */
export function classifyHostAttribution(host) {
  return classifyObservationWindow(computeObservationWindow(host));
}
