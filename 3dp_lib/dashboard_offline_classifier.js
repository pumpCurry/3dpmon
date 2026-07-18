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
 *   - 副作用なし（monitorData への書き込み・参照なし）。永続化・relay・確認UIは O4/O5。
 *
 *   ObservationWindow → classifyObservationWindow → { classification, candidate, confidence }
 *
 * 【継続候補(continuity-candidate)の必須条件（O2レビュー P0-1/P0-2）】
 *   「停止前に A が付いていた」だけでは不足。復帰後も**同じスプールが観測されている**事実が要る:
 *   ①current 観測が存在する ②baseline/current とも mounted ③spoolId 一致
 *   ④current の mount interval が corrupt/ambiguous でない。1つでも欠ければ candidate を出さない
 *   （current 未観測=observation-incomplete、相違/未装着/corrupt=continuity-contradicted）。
 *
 * @version 2.3.0
 * @since   2.3.0
 * -----------------------------------------------------------
 */

"use strict";

import { computeObservationWindow, buildConfidence } from "./dashboard_offline_observation.js";

/** 帰属分類（O2 の出力ラベル）。O3/O5 はこれで分岐する。 */
export const ATTR_CLASS = Object.freeze({
  CONTINUITY_CANDIDATE: "continuity-candidate",       // 停止前後で同一スプール装着継続を観測＝帰属候補
  CONTINUITY_CONTRADICTED: "continuity-contradicted", // 復帰後に別スプール/未装着/corrupt＝継続と矛盾
  NO_OFFLINE_ACTIVITY: "no-offline-activity",         // bounded だが offline 完了なし（帰属対象なし）
  NO_MOUNTED_SPOOL: "no-mounted-spool",               // baseline 未装着＝どのスプールへ継続か不明
  OBSERVATION_INCOMPLETE: "observation-incomplete",   // baseline あるが復帰後 current 未観測
  UNBOUNDED: "unbounded",                              // 世代交代/identity変化/巻き戻し＝窓を作れない
  INSUFFICIENT: "insufficient",                        // 識別材料不足/再利用ID未検証＝候補単位で判定不能
  NO_PRIOR: "no-prior"                                 // 前回観測なし（初回導入/移行）
});

/** 観測鮮度の劣化しきい値（これを超える古さは confidence を1段下げる）。 */
const STALE_DOWNGRADE_MS = 30 * 24 * 3600 * 1000; // 30日

const _LEVELS = ["high", "medium", "low", "none"];

/** confidence レベルを1段下げる（floor 指定で下限を固定）。 */
function _downgrade(level, floor = "none") {
  const i = _LEVELS.indexOf(level);
  const fi = _LEVELS.indexOf(floor);
  if (i < 0) return floor;
  const cap = fi < 0 ? _LEVELS.length - 1 : fi;
  return _LEVELS[Math.min(i + 1, cap)];
}

/** 2つの confidence レベルのうち低い方（index が大きい方）を返す。 */
function _levelMin(a, b) {
  const ia = _LEVELS.indexOf(a), ib = _LEVELS.indexOf(b);
  return _LEVELS[Math.max(ia < 0 ? 0 : ia, ib < 0 ? 0 : ib)];
}

/** 複合キー(JSON tuple)から canonicalJobId を取り出す。 */
function _idOfKey(key) {
  try { const a = JSON.parse(key); return Array.isArray(a) ? String(a[0]) : ""; } catch { return ""; }
}

/**
 * 停止前に印刷中だったジョブの完了を offline で観測できたか（＝開始をアプリが観測済み）。
 * ★ P1-B: ID 一致だけでは不十分（idle の残存 current・ID 再利用で誤判定）。印刷中に取得した
 *   複合 identity（canonicalJobId＋開始時刻＋file署名）が offline 完了と整合する場合のみ true。
 */
function _activeJobContinued(window) {
  const aj = window?.watermark?.activeJobObservation;
  if (!aj || aj.canonicalJobId == null) return false; // 印刷中に取得した証拠が無い＝high にしない
  const cid = String(aj.canonicalJobId);
  const startAt = Number(aj.startAt) || 0;
  const fileSig = aj.fileSignature || "";
  for (const key of window?.offlineObservationKeys || []) {
    let a; try { a = JSON.parse(key); } catch { continue; }
    if (!Array.isArray(a)) continue;
    // 複合一致: id＋開始時刻＋file（finishAt は active=未完了なので比較しない）。
    if (String(a[0]) === cid && (Number(a[1]) || 0) === startAt && (a[3] || "") === fileSig) return true;
  }
  return false;
}

/** ObservationWindow から証拠（解釈済みの事実サマリ）を組み立てる。 */
function _evidence(window) {
  const bm = window?.baselineMount || {}, cm = window?.currentMount || {};
  const idMatch = window?.printerIdentityMatch || { status: "unverifiable", matchedBy: null };
  return {
    printerIdentityMatch: idMatch,
    // ★ P1-1: model 一致だけでは筐体同一を保証しない＝serial/deviceId 一致(same-strong)のみ true。
    sameStrongPrinterIdentity: idMatch.status === "same-strong",
    sameMountedSpool: bm.spoolId != null && bm.spoolId === cm.spoolId,
    sameMountInterval: bm.intervalId != null && bm.intervalId === cm.intervalId,
    activeJobContinued: _activeJobContinued(window),
    historyShrank: !!window?.shrunk,
    mountStatus: cm.intervalStatus ?? "unknown",
    baselineMountStatus: bm.intervalStatus ?? "unknown",
    elapsedMs: window?.stalenessMs ?? null
  };
}

/** 分類結果オブジェクトを一定形で組み立てる。 */
function _result(classification, candidate, confidence, window) {
  return {
    classification,
    windowId: window?.windowId ?? null,
    windowKind: window?.windowKind ?? null,
    host: window?.host ?? null,
    baselineSequence: window?.baselineSequence ?? 0,
    currentSequence: window?.currentSequence ?? 0,
    bounded: !!window?.bounded,
    reason: window?.reason ?? null,
    candidate: candidate || null,
    confidence,
    evidence: _evidence(window),
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
 * @returns {{classification:string, windowId:?string, windowKind:?string, bounded:boolean, reason:?string,
 *   candidate:?Object, confidence:{level:string, reasons:string[]},
 *   offlineObservationKeys:string[], unresolvedJobIds:string[]}}
 */
export function classifyObservationWindow(window) {
  if (!window || typeof window !== "object") {
    return _result(ATTR_CLASS.NO_PRIOR, null, buildConfidence("none", ["no-window"]), window);
  }
  const kind = window.windowKind;
  const offline = Array.isArray(window.offlineObservationKeys) ? window.offlineObservationKeys : [];
  const baselineMount = window.baselineMount || {};
  const currentMount = window.currentMount || {};

  // 前回観測なし（baseline がない）
  if (kind === "no-prior" || window.reason === "no-prior-observation") {
    return _result(ATTR_CLASS.NO_PRIOR, null, buildConfidence("none", ["no-prior-observation"]), window);
  }
  // baseline はあるが復帰後 current 観測がまだ無い（装着状態を検証できない）
  if (kind === "incomplete" || window.hasCurrentObservation === false) {
    return _result(ATTR_CLASS.OBSERVATION_INCOMPLETE, null, buildConfidence("none", ["current-observation-missing"]), window);
  }
  // 候補単位で識別不能（再利用ID未検証/識別材料不足）
  if (kind === "insufficient") {
    return _result(ATTR_CLASS.INSUFFICIENT, null, buildConfidence("none", [window.reason || "insufficient"], [window.reason || "insufficient"]), window);
  }
  // 世代交代/identity変化/時刻巻き戻し/大幅縮小＝境界不成立
  if (kind === "unbounded" || !window.bounded) {
    return _result(ATTR_CLASS.UNBOUNDED, null, buildConfidence("none", [window.reason || "unbounded"], [window.reason || "unbounded"]), window);
  }

  // ここから bounded 確定。まず offline 完了の有無。
  if (offline.length === 0) {
    // 帰属対象なし（正常）。ただし truncated/stale は監査用に理由へ残し軽く降格。
    const reasons = ["bounded", "no-offline-jobs"];
    let level = "high";
    if (window.truncated) { reasons.push("history-truncated"); level = _downgrade(level, "medium"); }
    if ((Number(window.stalenessMs) || 0) > STALE_DOWNGRADE_MS) { reasons.push("stale-observation"); level = _downgrade(level, "medium"); }
    return _result(ATTR_CLASS.NO_OFFLINE_ACTIVITY, null, buildConfidence(level, reasons), window);
  }

  // offline 完了あり → 停止前後の装着一致を必須検証。
  // ① baseline 未装着＝どのスプールへ継続か決められない
  if (baselineMount.observationState !== "mounted" || baselineMount.spoolId == null) {
    return _result(ATTR_CLASS.NO_MOUNTED_SPOOL, null, buildConfidence("none", ["bounded", "no-mounted-spool-at-baseline"]), window);
  }
  // ★ P0-2 ①' baseline の mount interval が corrupt/ambiguous＝台帳破損。破損 baseline を
  //   推定 debit の根拠（candidate の baseline interval）にしてはいけない＝矛盾扱い。
  if (baselineMount.intervalStatus === "corrupt" || baselineMount.intervalStatus === "ambiguous") {
    const c = `baseline-interval-${baselineMount.intervalStatus}`;
    return _result(ATTR_CLASS.CONTINUITY_CONTRADICTED, null, buildConfidence("none", [c], [c]), window);
  }
  // ② current 未装着＝復帰後にスプールが外れている＝継続と矛盾
  if (currentMount.observationState !== "mounted" || currentMount.spoolId == null) {
    return _result(ATTR_CLASS.CONTINUITY_CONTRADICTED, null, buildConfidence("none", ["current-unmounted"], ["current-unmounted"]), window);
  }
  // ③ spoolId 相違＝停止中に別スプールへ交換された＝継続と矛盾（最重要）
  if (baselineMount.spoolId !== currentMount.spoolId) {
    return _result(ATTR_CLASS.CONTINUITY_CONTRADICTED, null, buildConfidence("none", ["mounted-spool-changed"], ["mounted-spool-changed"]), window);
  }
  // ④ current の mount interval が corrupt/ambiguous＝装着継続を信頼できない＝矛盾扱い
  if (currentMount.intervalStatus === "corrupt" || currentMount.intervalStatus === "ambiguous") {
    const c = `current-interval-${currentMount.intervalStatus}`;
    return _result(ATTR_CLASS.CONTINUITY_CONTRADICTED, null, buildConfidence("none", [c], [c]), window);
  }

  // 停止前後で同一スプールが装着継続＝continuity candidate。confidence は cap 方式で段階付け。
  // ★ P0-3 の tier 定義（reviewer）:
  //   high  : activeJobContinued＝停止前ジョブの完了を観測＋同一 interval＋前後 interval=ok
  //   medium: 完全オフライン（開始をアプリが観測していない）だが same spool/same interval・反証なし
  //   low   : interval none/unknown／interval id 変化／truncated／stale
  //   （identity 反証は既に unbounded で除外済み。identity の強さは evidence に残す。）
  const reasons = ["bounded", "same-mounted-spool"];
  let level = "high";
  const cap = (t) => { level = _levelMin(level, t); };
  if (_activeJobContinued(window)) { reasons.push("active-job-continued"); }
  else { reasons.push("fully-offline"); cap("medium"); }             // 完全オフラインは high にしない
  if (currentMount.intervalStatus === "ok") { reasons.push("current-interval-ok"); }
  else { reasons.push(`current-interval-${currentMount.intervalStatus || "unknown"}`); cap("low"); }
  if (baselineMount.intervalStatus === "ok") { reasons.push("baseline-interval-ok"); }
  else { reasons.push(`baseline-interval-${baselineMount.intervalStatus || "unknown"}`); cap("low"); }
  const sameInterval = baselineMount.intervalId != null && baselineMount.intervalId === currentMount.intervalId;
  if (sameInterval) { reasons.push("same-mount-interval"); }
  else { reasons.push("mount-interval-changed"); cap("low"); }        // detach/reattach 疑い
  if (window.truncated) { reasons.push("history-truncated"); cap("low"); }
  if ((Number(window.stalenessMs) || 0) > STALE_DOWNGRADE_MS) { reasons.push("stale-observation"); cap("low"); }
  reasons.push(`printer-identity-${window?.printerIdentityMatch?.status || "unverifiable"}`);

  const candidate = {
    candidateSpoolId: baselineMount.spoolId,
    candidateBaselineIntervalId: baselineMount.intervalId ?? null,
    candidateCurrentIntervalId: currentMount.intervalId ?? null,
    offlineObservationKeys: offline.slice(),
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
