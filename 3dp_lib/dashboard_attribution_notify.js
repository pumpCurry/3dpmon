/**
 * @fileoverview 帰属未確認（未帰属フィラメント消費）の重複抑制通知（Phase5 U3）
 * @file dashboard_attribution_notify.js
 * @copyright (c) pumpCurry 2026 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_attribution_notify
 *
 * 【方針（ChatGPTレビュー Option1/U3）】
 * - 通知判定は「件数」ではなく pending 課題ID集合の**差分**（新規のみ）で行う。
 *   件数比較では「1件解決＋1件新規」で件数不変のとき新規を見逃すため。
 * - ホスト単位で集約し、短い quiet 窓（起動時の復元/同期バースト）を1回に畳む。
 * - 起動/初回同期は、落ち着いた後に既存分を1回だけ集約通知（初回だけ startup 種別）。
 * - 低優先・**画面内のみ**（showAlert トースト＝音/OS通知/webhook を伴わない）。
 * - **親のみ通知権威**。リレー子（satellite/readonly）はバッジ/チップ表示のみで通知しない。
 * - UI 描画（updateAttributionBadge）と通知判定（本モジュール）は分離する。
 *
 * @version 2.3.0
 * @since   2.3.0
 * -----------------------------------------------------------
 */

"use strict";

import { getAttributionIssueIdsForHost, countAttributionIssuesForHost } from "./dashboard_spool.js";
import { getHostDisplayName } from "./dashboard_data.js";
import { showAlert } from "./dashboard_notification_manager.js";
import { monotonicNowMs } from "./dashboard_time.js";

/** 起動時の復元/同期バーストを1回へ畳む集約窓（ms）。 */
const DEBOUNCE_MS = 6000;

/** host -> { initialized:boolean, observed:Set<string>, lastNotifiedAt:number } */
const _state = new Map();
/** host -> { timer, sig } debounce タイマーと、その時点の課題ID集合シグネチャ */
const _sched = new Map();

/**
 * 課題ID集合の安定シグネチャ（順不同で一意）。
 * @private
 * @param {Set<string>} idSet
 * @returns {string}
 */
function _sigOf(idSet) {
  return [...idSet].sort().join("\n");
}

/**
 * per-host 通知状態を取得（無ければ初期化）。
 * @private
 * @param {string} host
 * @returns {{initialized:boolean, observed:Set<string>, lastNotifiedAt:number}}
 */
function _getState(host) {
  let s = _state.get(host);
  if (!s) {
    s = { initialized: false, observed: new Set(), lastNotifiedAt: 0 };
    _state.set(host, s);
  }
  return s;
}

/**
 * リレー子かどうか（親のみ通知権威）。
 * @private
 * @returns {boolean}
 */
function _isRelayChild() {
  return typeof window !== "undefined" && window._3dpmonRelayChild === true;
}

/**
 * 帰属未確認 課題の新規発生を集合差分で判定する（副作用は per-host 観測状態の更新のみ）。
 *
 * - 初回（未初期化）: 既存の課題ID集合を観測済みとして取り込み、0件でなければ
 *   startup 種別の集約通知を1回返す（＝「前回までの未確認記録がN件」）。
 * - 2回目以降: current − observed が非空なら new 種別を返す。observed は常に current へ
 *   更新するため、解決された課題は再通知の対象にならない。
 *
 * @function evaluateAttributionNotice
 * @param {string} host - ホスト名
 * @param {Object} [opts]
 * @param {number} [opts.nowMs=0] - 監査用の時刻（monotonic 推奨）。判定には使わない。
 * @returns {?{host:string, newIds:string[], total:number, kind:"startup"|"new"}} 通知不要なら null
 */
export function evaluateAttributionNotice(host, { nowMs = 0 } = {}) {
  if (!host) return null;
  const st = _getState(host);
  const current = getAttributionIssueIdsForHost(host);

  // ★ #410-7: 通知の total はバッジと一致させるため countAttributionIssuesForHost（詳細＋集約済み）。
  //   新規判定(newIds)は詳細IDの集合差分で行う（集約済みは詳細IDを持たないため差分対象外）。
  const total = countAttributionIssuesForHost(host);

  if (!st.initialized) {
    st.initialized = true;
    st.observed = new Set(current);
    if (current.size > 0) {
      st.lastNotifiedAt = nowMs;
      return { host, newIds: [...current], total, kind: "startup" };
    }
    return null;
  }

  const newIds = [...current].filter(id => !st.observed.has(id));
  st.observed = new Set(current); // 解決分も反映（再通知しない）
  if (newIds.length === 0) return null;
  st.lastNotifiedAt = nowMs;
  return { host, newIds, total, kind: "new" };
}

/**
 * 通知ペイロードを画面内トーストで発火する（低優先・音/OS/webhook 無し）。
 * @private
 * @param {{host:string, total:number, kind:string}} notice
 * @returns {void}
 */
function _emit(notice) {
  const label = getHostDisplayName(notice.host) || notice.host;
  const msg = notice.kind === "startup"
    ? `${label}: 前回までの未確認フィラメント記録が ${notice.total} 件あります（印刷履歴を確認してください）`
    : `${label}: フィラメント帰属を確認できない記録が ${notice.total} 件あります（印刷履歴を確認してください）`;
  try {
    // showAlert は通知コンテナへのトーストのみ（notificationManager の音/webhook 経路は通らない）。
    showAlert(msg, "warn", false, notice.host);
  } catch { /* 非DOM/未構築環境は無視 */ }
}

/**
 * 帰属未確認の通知を（親のみ・debounce 集約で）スケジュールする。
 *
 * renderHistoryTable など状態が変わり得る箇所から呼ぶ。復元/同期のバーストで連続呼び出し
 * されても、最後の呼び出しから DEBOUNCE_MS の quiet 後に1回だけ評価・発火する。
 *
 * @function scheduleAttributionNotice
 * @param {string} host - ホスト名
 * @returns {void}
 */
export function scheduleAttributionNotice(host) {
  if (!host) return;
  if (_isRelayChild()) return; // 子は表示のみ。親が通知権威。
  const sig = _sigOf(getAttributionIssueIdsForHost(host));
  const st = _sched.get(host);
  // ★ P1-4(レビュー): 課題ID集合が前回スケジュール時から変わっていなければ、
  //   既存タイマーを延長しない（renderHistoryTable の連続呼び出しで debounce が
  //   永久に延期＝通知が永遠に出ない、を防ぐ）。新規/解決で集合が変わったときだけ再設定する。
  if (st && st.timer && st.sig === sig) return;
  if (st && st.timer) clearTimeout(st.timer);
  const timer = setTimeout(() => {
    _sched.delete(host);
    const notice = evaluateAttributionNotice(host, { nowMs: monotonicNowMs() });
    if (notice) _emit(notice);
  }, DEBOUNCE_MS);
  if (timer && typeof timer.unref === "function") timer.unref(); // プロセスを引き止めない
  _sched.set(host, { timer, sig });
}

/**
 * per-host 通知状態とタイマーを全消去する（主にテスト用）。
 * @function resetAttributionNoticeState
 * @returns {void}
 */
export function resetAttributionNoticeState() {
  for (const s of _sched.values()) { if (s && s.timer) clearTimeout(s.timer); }
  _sched.clear();
  _state.clear();
}
