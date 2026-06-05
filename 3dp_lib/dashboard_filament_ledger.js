/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 フィラメント残量レジャー（mountHistory 権威・冪等再計算）
 * @file dashboard_filament_ledger.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_filament_ledger
 *
 * 【機能内容サマリ】
 * - ADR-0004: スプール残量 remainingLengthMm を「装着履歴(mountHistory)」と
 *   「プリンタ報告の消費量(printStore.history[].materialUsedMm)」の2つから冪等に再計算する。
 * - 累積減算(remaining -= x)を権威経路から排除し、二重減算を構造的に不能にする。
 * - 純関数群（import は monitorData のみ）。Date.now()/Math.random は使わず時刻は引数で受ける。
 *
 * 【公開関数一覧】
 * - {@link appendMountEvent}：装着イベントを mountHistory に追記
 * - {@link appendUnmountEvent}：取外しイベントを mountHistory に追記
 * - {@link attributedUsed}：ジョブが当該スプールに帰属させる消費量(mm)
 * - {@link getSpoolIntervals}：スプールの装着区間配列を構築
 * - {@link deriveSpoolRemaining}：信頼ソースから残量を冪等に導出
 * - {@link reconcileSpool}：導出値で spool.remainingLengthMm を補正（印刷中は触らない）
 * - {@link initLedgerAnchors}：装着中スプールにアンカー mount イベントを種付け（過去再計算しない）
 *
 * @version 2.2.1012
 * @since   2.2.1012
 * @lastModified 2026-06-05
 * -----------------------------------------------------------
 */

"use strict";

import { monitorData } from "./dashboard_data.js";

/**
 * 値を [min, max] の範囲にクランプする。
 *
 * @private
 * @param {number} min - 下限
 * @param {number} v - 対象値
 * @param {number} max - 上限
 * @returns {number} クランプ後の値
 */
function _clamp(min, v, max) {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(v, max));
}

/**
 * mountHistory 配列を取得する（無ければ初期化）。
 *
 * @private
 * @returns {Array<Object>} monitorData.mountHistory
 */
function _getMountHistory() {
  if (!Array.isArray(monitorData.mountHistory)) {
    monitorData.mountHistory = [];
  }
  return monitorData.mountHistory;
}

/**
 * 指定 host の printStore.history を取得する。
 *
 * @private
 * @param {string} host - ホスト名
 * @returns {Array<Object>} 履歴配列（無ければ空配列）
 */
function _historyForHost(host) {
  const machine = monitorData.machines?.[host];
  const hist = machine?.printStore?.history;
  return Array.isArray(hist) ? hist : [];
}

/**
 * ジョブの printId（数値）を取得する。printStore.history のエントリは
 * id = 開始 epoch 秒（parseRawHistoryEntry の出力）。
 *
 * @private
 * @param {Object} job - 履歴ジョブ
 * @returns {number} printId（数値）。取得不能なら NaN
 */
function _jobId(job) {
  const n = Number(job?.id);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * ジョブが完了（materialUsedMm > 0）しているか判定する。
 *
 * @private
 * @param {Object} job - 履歴ジョブ
 * @returns {boolean} 完了していれば true
 */
function _isCompleted(job) {
  return Number(job?.materialUsedMm || 0) > 0;
}

/**
 * 装着イベントを mountHistory に追記する。
 *
 * @function appendMountEvent
 * @param {Object} params
 * @param {string} params.host - ホスト名
 * @param {string} params.spoolId - スプールID
 * @param {number} params.anchorRemainingMm - 装着時点のそのスプールの導出残量（繰越基点）
 * @param {number|string} params.sinceJobId - 装着時点でそのホストの最後に完了した printId（区間の下限・排他）
 * @param {number} params.ts - イベント時刻 ms（evId もこれから導出）
 * @returns {Object} 追記した MountEvent
 */
export function appendMountEvent({ host, spoolId, anchorRemainingMm, sinceJobId, ts } = {}) {
  const list = _getMountHistory();
  const ev = {
    // evId は内容ベースで一意かつ安定にする（同一 ts で複数ホストを種付けしても衝突せず、
    // 再 import 時は同一イベントが同一 evId になり dedup が正しく効く）
    evId: `mount_${spoolId}_${ts}`,
    ts,
    type: "mount",
    host,
    spoolId,
    anchorRemainingMm: Number(anchorRemainingMm) || 0,
    sinceJobId: Number(sinceJobId) || 0
  };
  list.push(ev);
  return ev;
}

/**
 * 取外しイベントを mountHistory に追記する。
 *
 * @function appendUnmountEvent
 * @param {Object} params
 * @param {string} params.host - ホスト名
 * @param {string} params.spoolId - スプールID
 * @param {number|string} params.untilJobId - 取外し時点の最後の完了 printId（区間の上限・包含）
 * @param {number} params.ts - イベント時刻 ms
 * @returns {Object} 追記した MountEvent
 */
export function appendUnmountEvent({ host, spoolId, untilJobId, ts } = {}) {
  const list = _getMountHistory();
  const ev = {
    evId: `unmount_${spoolId}_${ts}`,
    ts,
    type: "unmount",
    host,
    spoolId,
    untilJobId: Number(untilJobId) || 0
  };
  list.push(ev);
  return ev;
}

/**
 * ジョブが当該スプールに帰属させる消費量(mm)を返す純関数。
 *
 * - job.filamentInfo に spoolId のエントリ(usedMm)があればそれを採用。
 * - filamentInfo が無く（または当該 spoolId が無く）単一スプールジョブなら job.materialUsedMm。
 * - 該当しなければ 0。
 *
 * 「単一スプールジョブ」= filamentInfo が空/未定義、または filamentInfo の
 * 一意な spoolId が当該 spoolId のみ、のいずれか（複数スプールが記録されている
 * ジョブで当該 spoolId のエントリが無い場合は帰属させない）。
 *
 * @function attributedUsed
 * @param {Object} job - printStore.history のエントリ
 * @param {string} spoolId - 帰属を判定するスプールID
 * @returns {number} 当該スプールの消費量(mm)
 */
export function attributedUsed(job, spoolId) {
  if (!job) return 0;
  const info = Array.isArray(job.filamentInfo) ? job.filamentInfo : null;
  if (info && info.length > 0) {
    // filamentInfo に当該 spoolId のエントリがあればその usedMm を採用
    const entry = info.find(fi => fi && fi.spoolId === spoolId && fi.usedMm != null);
    if (entry) return Number(entry.usedMm) || 0;
    // filamentInfo はあるが当該 spoolId のエントリが無い:
    //   - 記録された一意 spoolId が当該 spoolId のみ（usedMm 欠落の単一スプール）なら
    //     job.materialUsedMm にフォールバック
    //   - それ以外（他スプールが記録されている / 複数スプール）は帰属させない
    const distinctIds = new Set(info.map(fi => fi && fi.spoolId).filter(Boolean));
    if (distinctIds.size === 1 && distinctIds.has(spoolId)) {
      return Number(job.materialUsedMm) || 0;
    }
    if (distinctIds.size === 0) {
      // spoolId 情報の無い filamentInfo（色のみ等）→ 単一スプール扱い
      return Number(job.materialUsedMm) || 0;
    }
    return 0;
  }
  // filamentInfo 無し = 単一スプールジョブとして materialUsedMm を帰属
  return Number(job.materialUsedMm) || 0;
}

/**
 * 当該スプールの装着区間配列を構築する。
 *
 * mountHistory から (host, spoolId) の mount→unmount を区間として組み立てる。
 * mountHistory に当該スプールの mount が無ければ空配列を返す
 * （レガシー printIdRanges からの区間捏造は廃止＝ADR-0004 純アンカー方式）。
 *
 * @function getSpoolIntervals
 * @param {string} spoolId - スプールID
 * @returns {Array<{host:string, sinceJobId:number, untilJobId:?number, anchorRemainingMm:number}>}
 *   装着区間配列（mount 時系列順）。untilJobId=null はオープン区間。mount 記録が無ければ []。
 */
export function getSpoolIntervals(spoolId) {
  const list = _getMountHistory();
  const events = list
    .filter(e => e && e.spoolId === spoolId && (e.type === "mount" || e.type === "unmount"))
    .slice()
    .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));

  const intervals = [];
  let open = null;
  for (const e of events) {
    if (e.type === "mount") {
      // 直前の mount がオープンのままなら（unmount を見届けず）クローズ扱いにせず置換せず、
      // 新規区間を開く（前の区間はオープンのまま残す＝最新 anchor を信頼）
      open = {
        host: e.host,
        sinceJobId: Number(e.sinceJobId) || 0,
        untilJobId: null,
        anchorRemainingMm: Number(e.anchorRemainingMm) || 0
      };
      intervals.push(open);
    } else if (e.type === "unmount") {
      // 直近のオープン区間（同一 host 優先）をクローズ
      let target = null;
      for (let i = intervals.length - 1; i >= 0; i--) {
        if (intervals[i].untilJobId == null) {
          if (intervals[i].host === e.host) { target = intervals[i]; break; }
          if (!target) target = intervals[i];
        }
      }
      if (target) {
        target.untilJobId = Number(e.untilJobId) || 0;
        if (target === open) open = null;
      }
    }
  }
  // mount 記録が無ければ空（レガシー printIdRanges からの区間捏造はしない）。
  return intervals;
}

/**
 * 信頼ソース（mountHistory + printStore.history）からスプール残量を冪等に導出する。
 *
 * 【純アンカー方式（ADR-0004 是正版）】
 * 過去を再計算せず、最新区間の anchorRemainingMm を基点に「以後の完了ジョブ消費」だけを引く。
 * - 使う区間は**最新区間1つだけ**（open があれば open、無ければ最終区間）。
 * - remaining = anchorRemainingMm − Σ(attributedUsed for 完了ジョブ:
 *     printId(=job.id) > 区間.sinceJobId【厳密大なり】 かつ（open または ≤ untilJobId））。
 * - totalLengthMm からの再計算（total − Σ全区間）も printIdRanges からの区間捏造も**行わない**。
 *   → 別スプール／重複区間に引きずられて過去を巻き込む事故を構造的に排除。
 *
 * 被覆チェック（安全側フラグのみ）: 最新区間 host の printStore.history の最小 printId O が
 *   当該区間 sinceJobId より新しい（O > sinceJobId + 1 相当）なら取りこぼしの可能性 →
 *   verified=false。ただし remaining は引き続きアンカー基準で計算する（過剰減算しない）。
 *
 * 区間が空（mountHistory に mount 記録なし）→ spool.remainingLengthMm（現在値）をそのまま返す
 *   （mode:"none", verified:false）。勝手に total へリセットしない。
 *
 * @function deriveSpoolRemaining
 * @param {string} spoolId - スプールID
 * @param {Object} [opts]
 * @param {number} [opts.liveUsedMm=0] - 進行中ジョブの暫定消費（表示用オーバーレイ）。権威 reconcile では 0
 * @returns {{remainingMm:number, verified:boolean, mode:string, usedMm:number}}
 *   mode は "anchor"（通常）／"none"（区間なし）。
 */
export function deriveSpoolRemaining(spoolId, { liveUsedMm = 0 } = {}) {
  const spool = (monitorData.filamentSpools || []).find(s => s.id === spoolId);
  const total = Number(spool?.totalLengthMm) || 0;
  const intervals = getSpoolIntervals(spoolId);

  if (intervals.length === 0) {
    // 装着履歴が無い → 現在値をそのまま維持（total へリセットしない）
    const cur = Number(spool?.remainingLengthMm);
    const base = Number.isFinite(cur) ? cur : total;
    const cap = total > 0 ? total : base;
    const remaining = _clamp(0, base - (Number(liveUsedMm) || 0), cap);
    return { remainingMm: remaining, verified: false, mode: "none", usedMm: 0 };
  }

  // 最新区間（open があれば open、無ければ最終区間）だけを使う
  let anchorIv = null;
  for (let i = intervals.length - 1; i >= 0; i--) {
    if (intervals[i].untilJobId == null) { anchorIv = intervals[i]; break; }
  }
  if (!anchorIv) anchorIv = intervals[intervals.length - 1];

  // 当該区間の帰属消費 Σ と、被覆チェック用の最小 printId
  const hist = _historyForHost(anchorIv.host);
  let used = 0;
  let minPrintId = Infinity;
  for (const job of hist) {
    const pid = _jobId(job);
    if (!Number.isFinite(pid)) continue;
    if (pid < minPrintId) minPrintId = pid;
  }
  for (const job of hist) {
    const pid = _jobId(job);
    if (!Number.isFinite(pid)) continue;
    // printId > sinceJobId（厳密大なり）かつ（open or <= untilJobId）かつ完了
    if (pid <= anchorIv.sinceJobId) continue;
    if (anchorIv.untilJobId != null && pid > anchorIv.untilJobId) continue;
    if (!_isCompleted(job)) continue;
    used += attributedUsed(job, spoolId);
  }

  // 被覆チェック: 最新区間 host の最小 printId O が sinceJobId より「新しい」なら未検証
  // （O > sinceJobId + 1 相当 ⇒ since と O の間に取りこぼしジョブがありうる）。
  // verified=false でも remaining はアンカー基準で計算（安全側＝過剰減算しない）。
  const since = anchorIv.sinceJobId;
  const O = minPrintId;
  let verified = true;
  if (since > 0 && Number.isFinite(O) && O > since + 1) {
    verified = false;
  }

  // 純アンカー: remaining = anchorRemainingMm − Σ(当該区間の完了ジョブ消費)
  const anchor = Number(anchorIv.anchorRemainingMm) || 0;
  let remaining = anchor - used;

  // clamp(0, remaining, total>0?total:anchor)。liveUsedMm はオーバーレイで追加減算。
  const cap = total > 0 ? total : Math.max(anchor, 0);
  remaining = _clamp(0, remaining, cap);
  if (liveUsedMm > 0) {
    remaining = _clamp(0, remaining - liveUsedMm, cap);
  }

  return { remainingMm: remaining, verified, mode: "anchor", usedMm: used };
}

/**
 * 導出値で spool.remainingLengthMm を補正する（権威 reconcile）。
 *
 * 印刷中(currentPrintID あり)のスプールは触らない（オシレーション回避）。
 * ts が与えられた場合のみ updatedAt を更新する（Date.now は使わない＝再現性優先）。
 *
 * @function reconcileSpool
 * @param {string} spoolId - スプールID
 * @param {Object} [opts]
 * @param {number} [opts.ts] - 更新時刻 ms（省略時は updatedAt を触らない）
 * @returns {?{before:number, after:number, verified:boolean, mode:string, skipped?:boolean}}
 *   補正結果。スプール未発見時は null
 */
export function reconcileSpool(spoolId, { ts } = {}) {
  const spool = (monitorData.filamentSpools || []).find(s => s.id === spoolId);
  if (!spool) return null;
  const before = Number(spool.remainingLengthMm);
  // ★ 印刷中スプールは触らない（二重防御。呼び出し側でも守る）
  if (spool.currentPrintID) {
    return { before, after: before, verified: spool._remainingVerified ?? false, mode: "skip", skipped: true };
  }
  const { remainingMm, verified, mode } = deriveSpoolRemaining(spoolId);
  spool.remainingLengthMm = remainingMm;
  spool._remainingVerified = verified;
  if (ts != null) spool.updatedAt = ts;
  return { before, after: remainingMm, verified, mode };
}

/**
 * 当該スプールの mount イベントが mountHistory に既に存在するか判定する。
 *
 * @private
 * @param {string} spoolId - スプールID
 * @returns {boolean} mount イベントがあれば true
 */
function _hasMountEvent(spoolId) {
  const list = _getMountHistory();
  return list.some(e => e && e.type === "mount" && e.spoolId === spoolId);
}

/**
 * そのホストの最後に完了した printId（= materialUsedMm>0 の最大 id）を返す。
 * 進行中ジョブは materialUsedMm=0 のため自然に除外される。
 *
 * @private
 * @param {string} host - ホスト名
 * @returns {number} 最後に完了した printId（無ければ 0）
 */
function _latestCompletedPrintId(host) {
  const hist = _historyForHost(host);
  let max = 0;
  for (const job of hist) {
    if (!_isCompleted(job)) continue;
    const pid = _jobId(job);
    if (Number.isFinite(pid) && pid > max) max = pid;
  }
  return max;
}

/**
 * 装着中スプールにアンカー mount イベントを1回だけ種付けする（ADR-0004 是正版）。
 *
 * 過去の再計算はしない。`hostSpoolMap` に載っている（装着中の）スプールのうち、
 * まだ mountHistory に mount イベントを持たないものに対し、以後の導出が
 * 「現在値（または現在ジョブ開始時残量）− 以後の完了ジョブ消費」で正しくなるよう
 * mount イベントを1件追記する。取り外し済み（hostSpoolMap に無い）スプールは
 * 一切触らない（remaining を維持。total へリセットしない）。
 *
 * - sinceJobId：そのホストの完了ジョブ（materialUsedMm>0）の最大 printId
 *   （進行中ジョブは materialUsedMm=0 で自然に除外）。
 * - anchorRemainingMm：
 *     印刷中（spool.currentPrintID あり かつ currentJobStartLength が有限）なら
 *       spool.currentJobStartLength（現在ジョブ開始時の残量）。
 *       ※ mid-job の live 残量をアンカーにすると現在ジョブ分を二重計上するため使わない。
 *     そうでなければ spool.remainingLengthMm（現在値）。
 * - 種付けしたスプールには spool._remainingVerified=false（推定繰越）を立てる。
 *
 * @function initLedgerAnchors
 * @param {Object} [opts]
 * @param {number} [opts.nowMs] - 種付けイベントの ts（モジュールは Date を使わない）
 * @returns {{seeded:number, report:Array<{spoolId:string, host:string, anchorRemainingMm:number, sinceJobId:number}>}}
 */
export function initLedgerAnchors({ nowMs } = {}) {
  const hostSpoolMap = monitorData.hostSpoolMap || {};
  const report = [];
  let seeded = 0;

  for (const [host, spoolId] of Object.entries(hostSpoolMap)) {
    if (!host || !spoolId) continue;
    if (_hasMountEvent(spoolId)) continue;
    const spool = (monitorData.filamentSpools || []).find(s => s.id === spoolId);
    if (!spool || spool.deleted || spool.isDeleted) continue;

    const sinceJobId = _latestCompletedPrintId(host);

    // 印刷中（currentPrintID あり かつ currentJobStartLength 有限）は現在ジョブ開始時残量を
    // アンカーにする（mid-job の現在値は現在ジョブ分を含むため二重計上になる）。
    const startLen = Number(spool.currentJobStartLength);
    const printing = !!spool.currentPrintID && Number.isFinite(startLen);
    const anchorRemainingMm = printing ? startLen : (Number(spool.remainingLengthMm) || 0);

    appendMountEvent({ host, spoolId, anchorRemainingMm, sinceJobId, ts: nowMs });
    spool._remainingVerified = false; // 推定繰越

    seeded++;
    report.push({ spoolId, host, anchorRemainingMm, sinceJobId });
  }

  return { seeded, report };
}
