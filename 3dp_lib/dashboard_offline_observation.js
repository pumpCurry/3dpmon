/**
 * @fileoverview オフライン推定帰属(Option4)の観測 watermark 層 — #411-O1
 * @file dashboard_offline_observation.js
 * @copyright (c) pumpCurry 2026 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_offline_observation
 *
 * 【役割】アプリ稼働中に per-host で「見えていた状態」を記録し（観測 watermark）、
 *   再起動後に「現在の完了履歴 − 前回観測済み集合」で “アプリ停止中に新たに現れた
 *   完了ジョブ” を特定できるようにする（= オフライン窓）。ID の巻き戻り（プリンタ再起動/
 *   時計補正）に強くするため、last-seen-id 比較ではなく **集合差分** を用いる。
 *
 * 【安全境界（レビュー4の絶対条件）】本モジュールは **read-only**。
 *   - 参照のみ: mountHistory / hostSpoolMap / printStore.history / machine 情報。
 *   - 書き込みは monitorData.hostObservationWatermark（本 Option4 専用の新規フィールド）のみ。
 *   - completionObservationId / completionOpId / opId / intervalId /
 *     pendingUnattributedUsage / mountHistoryRejectedEvents / ledgerRepairRequired /
 *     mountHistory / usedLengthLog / remainingLengthMm には一切触れない。
 *   - 残量は減らさない。推定帰属・confidence の実利用は O2 以降。
 *
 * @version 2.3.0
 * @since   2.3.0
 * -----------------------------------------------------------
 */

"use strict";

import { monitorData } from "./dashboard_data.js";
import { wallNowMs } from "./dashboard_time.js";

/**
 * 完了ジョブ判定（printfinish 欠落の旧データも finishTime/endtime/usagetime で完了扱い）。
 * dashboard_spool.isCompletedHistoryEntry と同義だが、本モジュールを安全境界内で
 * self-contained に保つため read-only 判定を内製する（依存を増やさない）。
 *
 * @private
 * @param {Object} j - 履歴ジョブ
 * @returns {boolean}
 */
function _isCompleted(j) {
  if (!j) return false;
  if (j.printfinish != null) return true;
  return (Number(j.finishTime) > 0) || (Number(j.finishTimeSec) > 0)
    || (Number(j.endtime) > 0) || (Number(j.usagetime) > 0);
}

/**
 * 指定ホストの printStore.history から「完了ジョブの printId 集合」を返す（read-only）。
 *
 * @private
 * @param {string} host
 * @returns {number[]} 完了 printId の配列（数値・昇順）
 */
function _completedJobIds(host) {
  const hist = monitorData.machines?.[host]?.printStore?.history;
  if (!Array.isArray(hist)) return [];
  const ids = [];
  for (const j of hist) {
    if (!_isCompleted(j)) continue;
    const n = Number(j?.id);
    if (Number.isFinite(n) && n > 0) ids.push(n);
  }
  ids.sort((a, b) => a - b);
  return ids;
}

/**
 * 指定ホストのプリンタ同一性シグネチャ（read-only）。取得できる範囲で構成する。
 * boot/session ID が将来取れれば加える。現状は model/type/接続識別で近似する。
 *
 * @private
 * @param {string} host
 * @returns {string}
 */
function _printerIdentity(host) {
  const sd = monitorData.machines?.[host]?.storedData || {};
  const model = sd.model?.rawValue ?? "";
  const type = monitorData.appSettings?.connectionTargets?.find?.(
    t => t && (t.hostname === host))?.printerType ?? "";
  return `${host}|${type}|${model}`;
}

/**
 * アプリ稼働中の観測 watermark を per-host に記録/更新する（#411-O1・read-only 追加専用）。
 *
 * 記録内容:
 * - seenCompletedJobIds: そのホストで観測できた完了 printId 集合（再起動後の差分の基準）。
 * - mountedSpoolId / mountIntervalId: 現在装着スプールとその open 区間（継続推定の候補）。
 * - printerIdentity: プリンタ同一性（再起動/交換の反証検出材料）。
 * - observedAtEpochMs / historyCount: 監査用。
 *
 * @function recordHostObservation
 * @param {string} host - ホスト名
 * @param {Object} [opts]
 * @param {?string} [opts.mountIntervalId] - 呼び出し側が把握している open 区間ID（任意）。
 * @returns {?Object} 更新後の watermark（host 未指定なら null）
 */
export function recordHostObservation(host, { mountIntervalId = null } = {}) {
  if (!host) return null;
  if (!monitorData.hostObservationWatermark || typeof monitorData.hostObservationWatermark !== "object") {
    monitorData.hostObservationWatermark = {};
  }
  const ids = _completedJobIds(host);
  const wm = {
    observedAtEpochMs: wallNowMs(),
    mountedSpoolId: monitorData.hostSpoolMap?.[host] ?? null,
    mountIntervalId: mountIntervalId ?? null,
    printerIdentity: _printerIdentity(host),
    seenCompletedJobIds: ids,
    historyCount: ids.length
  };
  monitorData.hostObservationWatermark[host] = wm;
  return wm;
}

/**
 * 「アプリ停止中に新たに現れた完了ジョブ」を集合差分で求める純関数（#411-O1/O2 の基盤）。
 *
 * offlineJobIds = 現在の完了 printId 集合 − 前回観測済み集合。
 * ID の巻き戻り（プリンタ再起動・時計補正）に強いよう last-seen-id 比較を使わない。
 * 前回観測が無い（初回導入/移行/履歴全置換）場合は bounded=false を返す
 * （= どれがオフライン窓のジョブか特定できない＝安全側。O2 で unbounded 分類に使う）。
 *
 * @function computeOfflineWindow
 * @param {string} host - ホスト名
 * @returns {{bounded:boolean, offlineJobIds:number[], reason:string,
 *            identityChanged:boolean, watermark:?Object}}
 */
export function computeOfflineWindow(host) {
  const wm = monitorData.hostObservationWatermark?.[host] || null;
  const current = _completedJobIds(host);
  if (!wm || !Array.isArray(wm.seenCompletedJobIds)) {
    return { bounded: false, offlineJobIds: [], reason: "no-prior-observation", identityChanged: false, watermark: wm };
  }
  const identityChanged = wm.printerIdentity !== _printerIdentity(host);
  const seen = new Set(wm.seenCompletedJobIds.map(Number));
  const offlineJobIds = current.filter(id => !seen.has(id));
  return {
    // identity が変わっていたら「同じ窓」と断定できない＝bounded にしない（O2 で unbounded/反証へ）。
    bounded: !identityChanged,
    offlineJobIds,
    reason: identityChanged ? "printer-identity-changed" : "diff-ok",
    identityChanged,
    watermark: wm
  };
}

/**
 * confidence（推定確度）オブジェクトを reasons 付きで組み立てる純関数（#411-O1 で schema 先行導入）。
 *
 * レビュー4提案: 「なぜその確度なのか」を後から説明できるよう、最初から理由を保持する。
 * O2 以降の分類器がこれを埋める。remaining には一切影響しない（表示・監査用の宣言のみ）。
 *
 * @function buildConfidence
 * @param {"high"|"medium"|"low"|"none"} level - 確度レベル
 * @param {string[]} [reasons] - 根拠コード（例: "seen-job","continuous-print","no-spool-change","elapsed-time"）
 * @returns {{level:string, reasons:string[]}}
 */
export function buildConfidence(level, reasons = []) {
  const lv = ["high", "medium", "low", "none"].includes(level) ? level : "none";
  return { level: lv, reasons: Array.isArray(reasons) ? reasons.slice() : [] };
}
