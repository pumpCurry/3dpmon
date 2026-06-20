/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 印刷ライフサイクル計測（観測フラグ＋区間時間）
 * @file dashboard_print_lifecycle.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_print_lifecycle
 *
 * 【機能内容サマリ】
 * - アプリが印刷の開始〜完了に「立ち会えたか」を per-host で追跡し、立ち会えた場合のみ
 *   区間時間（ウォームアップ／一時停止合計／印刷後処理）を実測する。
 * - 既定は "history"（取れなかった）。開始から観測できたジョブは "live"、途中参加は
 *   "partial"。これにより再構成値を実測値として誤表示しない（データ整合性）。
 * - aggregator から毎tick {@link recordPrintLifecycle} で状態/進捗を流し込み、完了確定時に
 *   {@link getPrintLifecycleMetrics} で metrics を取り出して履歴へ付与する設計。
 * - 時刻は呼び出し側から nowMs で受ける（Date 非依存＝再現性）。状態コードは K1 形
 *   （PRINT_STATE_CODE: 1=印刷中 / 5=一時停止 / 2=完了 / 4=失敗 / 0=停止）に統一。
 *
 * 【観測軸の定義】
 * - warmupSec       : 印刷開始(tStart) → 初進捗(progress>0) まで＝準備/ヒートソーク相当。
 * - pausedSec       : 一時停止していた合計時間。
 * - postProcessingTime: 進捗100%到達(tDone) → 完了確定(now) まで＝終了後処理（ベルト排出/
 *                       クールダウン等）。K1-Max はほぼ0、IR3 v2 等は実測値が乗る。
 *
 * 【公開関数一覧】
 * - {@link recordPrintLifecycle}：毎tickの状態/進捗を記録
 * - {@link getPrintLifecycleMetrics}：現/直近ジョブの観測 metrics を取得
 * - {@link resetPrintLifecycle}：per-host 追跡を破棄
 * - {@link _resetAllPrintLifecycle}：全破棄（テスト用）
 *
 * @version 2.2.1027
 * @since   2.2.1027
 * @lastModified 2026-06-17
 * -----------------------------------------------------------
 */

"use strict";

/** @typedef {Object} LifecycleTrack
 *  @property {?(number|string)} jobId
 *  @property {boolean} witnessedStart - 開始(progress≈0)から観測できたか
 *  @property {?number} tStart
 *  @property {?number} tFirstProgress
 *  @property {number} pausedMs
 *  @property {?number} _pauseStartedAt
 *  @property {?number} tDone
 */

/** @type {Object.<string, LifecycleTrack>} host -> track */
const _tracks = {};

/** @returns {LifecycleTrack} 新規トラック */
function _fresh() {
  return {
    jobId: null, witnessedStart: false,
    tStart: null, tFirstProgress: null,
    pausedMs: 0, _pauseStartedAt: null, tDone: null,
  };
}

/**
 * 毎tickの状態/進捗を記録する。新ジョブ(jobId変化)を検出したらトラックを作り直す。
 *
 * @function recordPrintLifecycle
 * @param {string} host - ホスト名
 * @param {Object} p
 * @param {number} p.state - K1 状態コード（1印刷中/5一時停止/2完了/4失敗/0停止）
 * @param {number} [p.progress=0] - 進捗(0-100)
 * @param {number|string} [p.jobId] - 現在ジョブID（printId）
 * @param {number} p.nowMs - 現在時刻(ms)
 * @returns {LifecycleTrack} 更新後トラック
 */
export function recordPrintLifecycle(host, { state, progress = 0, jobId, nowMs } = {}) {
  if (!host) return _fresh();
  const printing = Number(state) === 1;
  const paused = Number(state) === 5;
  const pct = Number(progress) || 0;

  // 新ジョブ検出 → リセット
  const prev = _tracks[host];
  if (prev && jobId != null && prev.jobId != null && String(jobId) !== String(prev.jobId)) {
    delete _tracks[host];
  }
  const tr = _tracks[host] || (_tracks[host] = _fresh());

  // ジョブID確定（最初に印刷/一時停止＋IDが得られた時点）
  if (jobId != null && tr.jobId == null && (printing || paused)) {
    tr.jobId = jobId;
    // 開始を最初から見られたか：初観測が印刷中かつ進捗ほぼ0なら "live"
    tr.witnessedStart = printing && pct <= 1;
    tr.tStart = nowMs;
  }

  // 初進捗（warmup 終了）
  if (tr.jobId != null && tr.tFirstProgress == null && pct > 0 && (printing || paused)) {
    tr.tFirstProgress = nowMs;
  }

  // 一時停止区間の積算
  if (paused && tr._pauseStartedAt == null) tr._pauseStartedAt = nowMs;
  if (!paused && tr._pauseStartedAt != null) {
    tr.pausedMs += Math.max(0, (Number(nowMs) || 0) - tr._pauseStartedAt);
    tr._pauseStartedAt = null;
  }

  // 進捗100%到達（後処理開始点）
  if (tr.jobId != null && tr.tDone == null && pct >= 100) tr.tDone = nowMs;

  return tr;
}

/**
 * 現/直近ジョブの観測 metrics を返す。立ち会えなかった軸は null（＝取れなかった）。
 *
 * @function getPrintLifecycleMetrics
 * @param {string} host - ホスト名
 * @param {Object} [opts]
 * @param {number} [opts.nowMs] - 完了時刻(ms)。postProcessingTime 算出に使う
 * @returns {{observed:string, warmupSec:?number, pausedSec:?number, postProcessingTime:?number}}
 *   observed: "live"（開始から観測）/ "partial"（途中参加）/ "history"（未追跡）
 */
export function getPrintLifecycleMetrics(host, { nowMs } = {}) {
  const tr = _tracks[host];
  if (!tr || tr.jobId == null) {
    return { observed: "history", warmupSec: null, pausedSec: null, postProcessingTime: null };
  }
  const sec = (ms) => (ms == null || !Number.isFinite(ms)) ? null : Math.max(0, Math.round(ms / 1000));

  const warmupSec = (tr.witnessedStart && tr.tStart != null && tr.tFirstProgress != null)
    ? sec(tr.tFirstProgress - tr.tStart) : null;

  let pausedMs = tr.pausedMs;
  if (tr._pauseStartedAt != null && nowMs != null) pausedMs += Math.max(0, nowMs - tr._pauseStartedAt);
  const pausedSec = tr.witnessedStart ? sec(pausedMs) : null;

  // 後処理 = 100%到達 → 完了(now)。100%を観測できていなければ null（取れなかった）。
  const postProcessingTime = (tr.tDone != null && nowMs != null) ? sec(nowMs - tr.tDone) : null;

  return {
    observed: tr.witnessedStart ? "live" : "partial",
    warmupSec, pausedSec, postProcessingTime,
  };
}

/**
 * per-host 追跡を破棄する（完了確定後や切断時に呼ぶ）。
 * @function resetPrintLifecycle
 * @param {string} host - ホスト名
 * @returns {void}
 */
export function resetPrintLifecycle(host) {
  if (host) delete _tracks[host];
}

/**
 * 全 per-host 追跡を破棄する（テスト用）。
 * @function _resetAllPrintLifecycle
 * @returns {void}
 */
export function _resetAllPrintLifecycle() {
  for (const k of Object.keys(_tracks)) delete _tracks[k];
}
