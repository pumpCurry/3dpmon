/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 推定 candidate 確定台帳反映モジュール
 * @file dashboard_inferred_candidate_ledger.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_inferred_candidate_ledger
 *
 * 【機能内容サマリ】
 * - O5 Human Decision Layer で承認された inferredCandidate を、確定台帳へ反映する。
 * - 確定残量、印刷履歴 filamentInfo、spool.usedLengthLog を同じ決定単位で更新する。
 * - Undo 時は candidateHash で照合できる O5 確定 event と履歴 attribution だけを逆反映する。
 * - Undo は確定 event を物理削除せず、逆仕訳 event を追記して監査証跡を残す。
 * - 保存失敗時にメモリ状態を元へ戻せるよう、反映前 snapshot と rollback API を提供する。
 *
 * 【公開関数一覧】
 * - {@link applyInferredCandidateLedger}：pending candidate を指定スプールへ確定反映する
 * - {@link undoInferredCandidateLedger}：確定済み candidate の台帳反映を取り消す
 * - {@link rollbackInferredCandidateLedger}：確定反映前 snapshot へメモリ状態を戻す
 *
 * @version 1.390.1268 (PR #419)
 * @since   1.390.1261 (PR #414)
 * @lastModified 2026-07-29 17:25:57
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

import { monitorData } from "./dashboard_data.js";
import { jobObservationIdentity } from "./dashboard_history_identity.js";
import { buildOfflineFilamentInfo, getSpoolById, shouldLinkOfflineJob } from "./dashboard_spool.js";
import { randomEventId, wallNowMs } from "./dashboard_time.js";

/**
 * 確定反映できる candidate debit の状態。
 *
 * @constant {string}
 */
const INFERRED_DEBIT_STATUS = "inferred-debit";

/**
 * O5 が spool.usedLengthLog へ追記する確定使用量 event の種別。
 *
 * @constant {string}
 */
export const INFERRED_DECISION_LEDGER_EVENT_TYPE = "inferred-continuity-confirmed";

/**
 * O5 Undo が spool.usedLengthLog へ追記する逆仕訳 event の種別。
 *
 * @constant {string}
 */
export const INFERRED_DECISION_UNDO_LEDGER_EVENT_TYPE = "inferred-continuity-undone";

/**
 * O5 attribution として履歴行へ追加され得るキー。
 *
 * 【詳細説明】
 * - Undo 前に Confirm/Reassign 後の履歴行が期待状態から変化していないか検証するために使う。
 * - Confirm 前から存在したキーは snapshot 側の値と比較し、O5 が追加したキーだけを許容する。
 *
 * @constant {Set<string>}
 */
const O5_ATTRIBUTION_KEYS = new Set([
  "spoolId",
  "serialNo",
  "spoolName",
  "colorName",
  "filamentColor",
  "material",
  "spoolCount",
  "expectedRemain",
  "usedMm",
  "isOfflineInferred",
  "isInferredContinuityConfirmed",
  "candidateHash",
  "decisionType",
  "originalCandidateSpoolId",
  "confirmedAt",
  "confirmedBy"
]);

/**
 * JSON 互換オブジェクトを deep clone する。
 *
 * 【詳細説明】
 * - rollback 用 snapshot は monitorData の参照変異から独立している必要がある。
 * - structuredClone が使える実行環境ではそれを優先し、テスト環境や古い WebView では JSON clone へ
 *   フォールバックする。
 *
 * @private
 * @function _clone
 * @param {*} value - clone 対象。
 * @returns {*} clone 済みの値。
 */
function _clone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/**
 * epoch ms の現在時刻を返す。
 *
 * 【詳細説明】
 * - テストでは `options.nowMs` を注入し、実行環境では `wallNowMs()` を使う。
 *
 * @private
 * @function _nowMs
 * @param {{nowMs?:number}} [options] - clock 注入オプション。
 * @returns {number} epoch ms。
 */
function _nowMs(options = {}) {
  const injected = Number(options.nowMs);
  if (Number.isFinite(injected) && injected > 0) return injected;
  return wallNowMs();
}

/**
 * 正の有限 mm 値へ正規化する。
 *
 * 【詳細説明】
 * - candidate store や履歴から来る値は文字列化されている可能性があるため Number 化する。
 * - 0 以下、NaN、Infinity は確定消費として扱わない。
 *
 * @private
 * @function _positiveMm
 * @param {*} value - mm 値候補。
 * @returns {number} 正の有限値。不正値は 0。
 */
function _positiveMm(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 残量として使用可能な mm 値へ正規化する。
 *
 * 【詳細説明】
 * - O5 の Confirm/Reassign は確定台帳を書き換えるため、残量不明の spool には適用しない。
 * - null/undefined/空文字/NaN/負値は不明扱いで null を返す。
 *
 * @private
 * @function _remainingOrNull
 * @param {*} value - spool.remainingLengthMm 相当の値。
 * @returns {?number} 0 以上の有限値。不明値は null。
 */
function _remainingOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * host の履歴配列を取得する。
 *
 * 【詳細説明】
 * - O5 は `monitorData.machines[host].printStore.history` を確定対象として扱う。
 * - 対象 host が無い場合や履歴配列が無い場合は null を返し、呼び出し元で fail-closed する。
 *
 * @private
 * @function _historyForHost
 * @param {string} host - 対象ホスト名。
 * @returns {?Array<Object>} 履歴配列。存在しない場合は null。
 */
function _historyForHost(host) {
  const history = monitorData.machines?.[host]?.printStore?.history;
  return Array.isArray(history) ? history : null;
}

/**
 * observation key から履歴 index を一意に引ける Map を作る。
 *
 * 【詳細説明】
 * - O3 と同じ `jobObservationIdentity()` を使い、candidate の observationKey と履歴行を照合する。
 * - fixture や旧保存データ向けに、履歴行が `observationKey` を直接持つ場合も補助キーとして採用する。
 * - 同じ key が複数行へ一致した場合は ambiguous とし、履歴順に依存した first-wins を避ける。
 *
 * @private
 * @function _historyIndexByObservationKey
 * @param {Array<Object>} history - printStore.history 相当の履歴配列。
 * @returns {Map<string,{status:string,indexes:Array<number>}>} observation key から履歴 index への Map。
 */
function _historyIndexByObservationKey(history) {
  const map = new Map();
  for (let index = 0; index < history.length; index++) {
    const entry = history[index];
    const keys = new Set();
    const identity = jobObservationIdentity(entry);
    if (identity?.key) keys.add(String(identity.key));
    if (entry?.observationKey != null) keys.add(String(entry.observationKey));
    if (entry?._observationKey != null) keys.add(String(entry._observationKey));
    for (const key of keys) {
      const current = map.get(key);
      if (!current) {
        map.set(key, { status: "unique", indexes: [index] });
        continue;
      }
      current.status = "ambiguous";
      current.indexes.push(index);
    }
  }
  return map;
}

/**
 * candidate record から確定対象 debit を抽出する。
 *
 * 【詳細説明】
 * - O3 projection で `inferred-debit` と判定済みの行だけを確定対象にする。
 * - 履歴へ書く usedMm は candidateDebits の値を使い、合計は candidate.usedMm と一致することを検証する。
 *
 * @private
 * @function _candidateDebits
 * @param {Object} candidateRecord - inferredCandidateStore の record。
 * @returns {Array<Object>} 確定対象 debit 配列。
 */
function _candidateDebits(candidateRecord) {
  return Array.isArray(candidateRecord?.candidateDebits)
    ? candidateRecord.candidateDebits.filter(item => item?.status === INFERRED_DEBIT_STATUS)
    : [];
}

/**
 * candidate の合計使用量と debit 合計が安全に一致するか検証する。
 *
 * 【詳細説明】
 * - candidate.usedMm と個別 debit の合計が大きくずれている場合は、保存済み candidate が壊れているか、
 *   将来の形式変更で O5 が理解できないため fail-closed する。
 *
 * @private
 * @function _validateDebitTotal
 * @param {Object} candidateRecord - inferredCandidateStore の record。
 * @param {Array<Object>} debits - 確定対象 debit 配列。
 * @returns {{ok:boolean, usedMm:number, debitTotalMm:number, reason:?string}} 検証結果。
 */
function _validateDebitTotal(candidateRecord, debits) {
  const usedMm = _positiveMm(candidateRecord?.usedMm);
  const debitTotalMm = debits.reduce((sum, item) => sum + _positiveMm(item?.usedMm), 0);
  if (usedMm <= 0) return { ok: false, usedMm, debitTotalMm, reason: "candidate_used_mm_missing" };
  if (debits.length === 0 || debitTotalMm <= 0) {
    return { ok: false, usedMm, debitTotalMm, reason: "candidate_debits_missing" };
  }
  if (Math.abs(usedMm - debitTotalMm) > 0.001) {
    return { ok: false, usedMm, debitTotalMm, reason: "candidate_debit_total_mismatch" };
  }
  return { ok: true, usedMm, debitTotalMm, reason: null };
}

/**
 * spool.usedLengthLog に同じ candidate の確定 event が既にあるか判定する。
 *
 * 【詳細説明】
 * - O5 の decision は candidate status 側でも二重適用を防ぐが、台帳側でも同じ candidateHash の
 *   確定 event が存在する場合は fail-closed し、残量の二重減算を防ぐ。
 *
 * @private
 * @function _hasExistingDecisionEvent
 * @param {Object} spool - 対象 spool。
 * @param {string} candidateHash - candidateHash。
 * @returns {boolean} 既存 event がある場合 true。
 */
function _hasExistingDecisionEvent(spool, candidateHash) {
  const log = Array.isArray(spool?.usedLengthLog) ? spool.usedLengthLog : [];
  return log.some(item =>
    item
    && item.type === INFERRED_DECISION_LEDGER_EVENT_TYPE
    && item.candidateHash === candidateHash
  );
}

/**
 * 指定した確定 event が既に Undo 済みか判定する。
 *
 * 【詳細説明】
 * - Undo は candidate status 側でも多重実行を防ぐが、台帳側にも逆仕訳 event を残すため、
 *   usedLengthLog だけを見ても二重Undoを検出できるようにする。
 *
 * @private
 * @function _hasUndoEventForDecisionEvent
 * @param {Object} spool - 対象 spool。
 * @param {Object} decisionEvent - 元の O5 確定 event。
 * @returns {boolean} 既に逆仕訳 event がある場合 true。
 */
function _hasUndoEventForDecisionEvent(spool, decisionEvent) {
  const log = Array.isArray(spool?.usedLengthLog) ? spool.usedLengthLog : [];
  const eventId = decisionEvent?.eventId;
  if (!eventId) return false;
  return log.some(item =>
    item
    && item.type === INFERRED_DECISION_UNDO_LEDGER_EVENT_TYPE
    && item.reversesEventId === eventId
  );
}

/**
 * spool.usedLengthLog から同じ candidate の O5 確定 event を列挙する。
 *
 * 【詳細説明】
 * - Undo は「どの event を戻すか」が一意に決まらない場合に残量を戻してはいけない。
 * - 同一 candidateHash の O5 event が複数ある場合は監査台帳の破損または手動編集とみなし、
 *   呼び出し元で fail-closed する。
 *
 * @private
 * @function _decisionEventsForCandidate
 * @param {Object} spool - 対象 spool。
 * @param {string} candidateHash - candidateHash。
 * @returns {Array<{event:Object,index:number}>} matching event と index の配列。
 */
function _decisionEventsForCandidate(spool, candidateHash) {
  const log = Array.isArray(spool?.usedLengthLog) ? spool.usedLengthLog : [];
  const matches = [];
  for (let index = 0; index < log.length; index++) {
    const item = log[index];
    if (item
        && item.type === INFERRED_DECISION_LEDGER_EVENT_TYPE
        && item.candidateHash === candidateHash) {
      matches.push({ event: item, index });
    }
  }
  return matches;
}

/**
 * O5 が履歴行へ attribution を書く前の表示・後方互換フィールドを snapshot 化する。
 *
 * 【詳細説明】
 * - Undo は O5 が上書きした情報だけを推測削除すると、Confirm 前から存在していた色・素材などの
 *   表示用 `filamentInfo` を失う可能性がある。
 * - `filamentInfo` と `filamentId` は「プロパティが存在しなかった」状態も意味を持つため、
 *   値だけでなく存在フラグも保存する。
 *
 * @private
 * @function _captureHistoryBefore
 * @param {Object} entry - Confirm/Reassign 前の履歴行。
 * @param {string} observationKey - candidate debit の observation key。
 * @returns {Object} Undo 復元用 snapshot。
 */
function _captureHistoryBefore(entry, observationKey) {
  const hasFilamentInfo = Object.hasOwn(entry, "filamentInfo");
  const hasFilamentId = Object.hasOwn(entry, "filamentId");
  return {
    observationKey: String(observationKey ?? ""),
    filamentInfoPresent: hasFilamentInfo,
    filamentInfo: hasFilamentInfo ? _clone(entry.filamentInfo) : null,
    filamentIdPresent: hasFilamentId,
    filamentId: hasFilamentId ? _clone(entry.filamentId) : null
  };
}

/**
 * ledger event の履歴snapshotを observation key で一意に引ける Map へ変換する。
 *
 * 【詳細説明】
 * - snapshot が無い旧形式 event では、Undo 後の履歴表示を完全復元できないため fail-closed する。
 * - 同一 observation key が複数ある場合も、どの変更前状態へ戻すべきか決められないため拒否する。
 *
 * @private
 * @function _historyBeforeMap
 * @param {Object} event - spool.usedLengthLog 内の O5 decision event。
 * @returns {{ok:boolean,reason:?string,map:Map<string,Object>}} snapshot Map。
 */
function _historyBeforeMap(event) {
  if (!Array.isArray(event?.historyBefore)) {
    return { ok: false, reason: "candidate_history_snapshot_missing", map: new Map() };
  }
  const map = new Map();
  for (const item of event.historyBefore) {
    const key = String(item?.observationKey ?? "");
    if (!key) return { ok: false, reason: "candidate_history_snapshot_invalid", map: new Map() };
    if (map.has(key)) return { ok: false, reason: "candidate_history_snapshot_ambiguous", map: new Map() };
    map.set(key, item);
  }
  return { ok: true, reason: null, map };
}

/**
 * 履歴行の O5 attribution 対象フィールドを snapshot から復元する。
 *
 * 【詳細説明】
 * - `filamentInfoPresent=false` の場合はプロパティを削除し、Confirm 前に存在しなかった状態へ戻す。
 * - `filamentIdPresent=true` の場合は `"none"` や `null` も含めて元値を復元する。
 *
 * @private
 * @function _restoreHistoryAttributionFromBefore
 * @param {Object} entry - 復元対象履歴行。
 * @param {Object} before - {@link _captureHistoryBefore} が作成した snapshot。
 * @returns {void}
 */
function _restoreHistoryAttributionFromBefore(entry, before) {
  if (before?.filamentInfoPresent === true) {
    entry.filamentInfo = _clone(before.filamentInfo);
  } else {
    delete entry.filamentInfo;
  }

  if (before?.filamentIdPresent === true) {
    entry.filamentId = _clone(before.filamentId);
  } else {
    delete entry.filamentId;
  }
}

/**
 * 2つの JSON 互換値が同じ内容か判定する。
 *
 * @private
 * @function _sameJson
 * @param {*} a - 比較値。
 * @param {*} b - 比較値。
 * @returns {boolean} JSON 表現が一致する場合 true。
 */
function _sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Undo 対象履歴行が Confirm/Reassign 直後の期待状態から変化していないか検証する。
 *
 * 【詳細説明】
 * - Undo は Confirm 前 snapshot へ戻すため、Confirm 後に別経路が合法 metadata を追加している場合、
 *   無条件に復元するとその変更を消してしまう。
 * - そこで、現在の履歴行が「snapshot + O5 attribution」だけで構成されているかを確認する。
 * - 色だけの既存 filamentInfo を同じ行へ昇格したケースと、O5 attribution を末尾追加したケースの
 *   両方を許容する。
 *
 * @private
 * @function _validateHistoryPostStateBeforeUndo
 * @param {Object} entry - 現在の履歴行。
 * @param {Object} before - Confirm/Reassign 前 snapshot。
 * @param {string} targetSpoolId - Undo 対象 spool ID。
 * @param {string} candidateHash - Undo 対象 candidateHash。
 * @returns {{ok:boolean,reason:string}} 検証結果。
 */
function _validateHistoryPostStateBeforeUndo(entry, before, targetSpoolId, candidateHash) {
  const info = Array.isArray(entry?.filamentInfo) ? entry.filamentInfo : [];
  const targetId = String(targetSpoolId);
  const matches = [];
  for (let index = 0; index < info.length; index++) {
    const item = info[index];
    if (item
        && item.isInferredContinuityConfirmed === true
        && item.candidateHash === candidateHash
        && String(item.spoolId) === targetId) {
      matches.push(index);
    }
  }
  if (matches.length === 0) return { ok: false, reason: "candidate_history_link_missing" };
  if (matches.length > 1) return { ok: false, reason: "candidate_history_link_ambiguous" };
  if (entry.filamentId != null && String(entry.filamentId) !== targetId) {
    return { ok: false, reason: "candidate_history_post_state_changed" };
  }

  const beforeInfo = before?.filamentInfoPresent === true && Array.isArray(before.filamentInfo)
    ? before.filamentInfo
    : [];
  const targetIndex = matches[0];
  const withoutTarget = info.filter((_, index) => index !== targetIndex);
  if (_sameJson(withoutTarget, beforeInfo)) return { ok: true, reason: "history_post_state_ok" };
  if (info.length !== beforeInfo.length) return { ok: false, reason: "candidate_history_post_state_changed" };

  for (let index = 0; index < info.length; index++) {
    const current = info[index] || {};
    const expected = beforeInfo[index] || {};
    if (index !== targetIndex) {
      if (!_sameJson(current, expected)) return { ok: false, reason: "candidate_history_post_state_changed" };
      continue;
    }
    for (const key of Object.keys(expected)) {
      if (O5_ATTRIBUTION_KEYS.has(key)) continue;
      if (!_sameJson(current[key], expected[key])) return { ok: false, reason: "candidate_history_post_state_changed" };
    }
    for (const key of Object.keys(current)) {
      if (!(key in expected) && !O5_ATTRIBUTION_KEYS.has(key)) {
        return { ok: false, reason: "candidate_history_post_state_changed" };
      }
    }
  }
  return { ok: true, reason: "history_post_state_ok" };
}

/**
 * candidate record から確定先 spool ID を取得する。
 *
 * 【詳細説明】
 * - Confirm 済み candidate は `candidateSpoolId`、Reassign 済み candidate は `assignedSpoolId` が
 *   実際に台帳へ反映された spool になる。
 * - Undo はこの spool の usedLengthLog と履歴 attribution を照合してから逆反映する。
 *
 * @private
 * @function _resolvedSpoolId
 * @param {Object} candidateRecord - inferredCandidateStore の record。
 * @returns {?string} 確定反映先 spool ID。
 */
function _resolvedSpoolId(candidateRecord) {
  const id = candidateRecord?.assignedSpoolId || candidateRecord?.candidateSpoolId;
  return id == null ? null : String(id);
}

/**
 * history entry へ O5 確定 filamentInfo を upsert する。
 *
 * 【詳細説明】
 * - 色だけの `filamentInfo` が1件ある場合は、その同じ行へ spool 情報を補完し、UI が2行表示に
 *   ならないようにする。
 * - spoolId 付きの既存帰属がある場合は呼び出し前 validation で拒否されるため、ここでは
 *   未帰属履歴だけを更新する。
 *
 * @private
 * @function _linkHistoryEntryToSpool
 * @param {Object} entry - 更新対象履歴行。
 * @param {Object} spool - 確定対象 spool。
 * @param {number} usedMm - この履歴行に帰属させる使用量 mm。
 * @param {Object} metadata - O5 decision の監査 metadata。
 * @returns {void}
 */
function _linkHistoryEntryToSpool(entry, spool, usedMm, metadata) {
  const info = {
    ...buildOfflineFilamentInfo(spool, usedMm),
    isOfflineInferred: false,
    isInferredContinuityConfirmed: true,
    candidateHash: metadata.candidateHash,
    decisionType: metadata.decisionType,
    originalCandidateSpoolId: metadata.originalCandidateSpoolId ?? null,
    confirmedAt: metadata.createdAt,
    confirmedBy: metadata.actor
  };
  const prev = Array.isArray(entry.filamentInfo) ? entry.filamentInfo : [];
  if (prev.length === 1 && prev[0] && !prev[0].spoolId) {
    Object.assign(prev[0], info);
    entry.filamentInfo = prev;
  } else {
    entry.filamentInfo = [...prev, info];
  }
  entry.filamentId = spool.id;
}

/**
 * snapshot 内の spool オブジェクトへ保存前状態を復元する。
 *
 * 【詳細説明】
 * - monitorData 内の spool 配列要素参照を保つため、配列要素を差し替えずにプロパティを復元する。
 * - 既存プロパティを一度削除してから snapshot を代入し、保存失敗中に追加された O5 専用フィールドも
 *   残らないようにする。
 *
 * @private
 * @function _restoreObjectInPlace
 * @param {Object} target - 復元対象オブジェクト。
 * @param {Object} snapshot - 保存前 snapshot。
 * @returns {void}
 */
function _restoreObjectInPlace(target, snapshot) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, _clone(snapshot));
}

/**
 * pending candidate を指定スプールへ確定反映する。
 *
 * 【詳細説明】
 * - O5 Decision Core が Confirm/Reassign のために呼ぶ低レベル API。
 * - この関数はメモリ上の台帳だけを更新し、保存は行わない。保存失敗時は戻り値の snapshot を
 *   {@link rollbackInferredCandidateLedger} へ渡して復元する。
 * - 確定対象は `candidateDebits[].status === "inferred-debit"` の履歴だけであり、既に spoolId や
 *   filamentId を持つ履歴は二重帰属防止のため拒否する。
 *
 * @function applyInferredCandidateLedger
 * @param {Object} candidateRecord - inferredCandidateStore の pending candidate record。
 * @param {string} targetSpoolId - 確定先 spool ID。Confirm では candidateSpoolId、Reassign では再割当先。
 * @param {{nowMs?:number, actor?:string, decisionType?:string, originalCandidateSpoolId?:?string, eventId?:string}} [options]
 *   - decision metadata。
 * @returns {{ok:boolean, reason:string, snapshot:?Object, spool:?Object, historyEntries?:Array<Object>, event?:Object}}
 *   反映結果。保存失敗 rollback に必要な snapshot を含む。
 * @example
 * const applied = applyInferredCandidateLedger(record, record.candidateSpoolId);
 */
export function applyInferredCandidateLedger(candidateRecord, targetSpoolId, options = {}) {
  if (!candidateRecord?.candidateHash) return { ok: false, reason: "candidate_required", snapshot: null, spool: null };
  const host = candidateRecord.host;
  if (!host) return { ok: false, reason: "candidate_host_missing", snapshot: null, spool: null };
  const spool = getSpoolById(targetSpoolId);
  if (!spool) return { ok: false, reason: "target_spool_not_found", snapshot: null, spool: null };
  const remaining = _remainingOrNull(spool.remainingLengthMm);
  if (remaining == null) return { ok: false, reason: "confirmed_remaining_unknown", snapshot: null, spool };
  if (_hasExistingDecisionEvent(spool, candidateRecord.candidateHash)) {
    return { ok: false, reason: "candidate_ledger_event_exists", snapshot: null, spool };
  }

  const history = _historyForHost(host);
  if (!history) return { ok: false, reason: "history_not_found", snapshot: null, spool };
  const debits = _candidateDebits(candidateRecord);
  const total = _validateDebitTotal(candidateRecord, debits);
  if (!total.ok) return { ok: false, reason: total.reason, snapshot: null, spool };
  if (remaining < total.usedMm) {
    return { ok: false, reason: "confirmed_remaining_insufficient", snapshot: null, spool };
  }

  const byKey = _historyIndexByObservationKey(history);
  const updates = [];
  const seenIndexes = new Set();
  for (const debit of debits) {
    const key = String(debit.observationKey ?? "");
    const lookup = byKey.get(key);
    if (!lookup) return { ok: false, reason: "history_entry_missing", snapshot: null, spool, observationKey: key };
    if (lookup.status !== "unique" || lookup.indexes.length !== 1) {
      return { ok: false, reason: "history_observation_ambiguous", snapshot: null, spool, observationKey: key };
    }
    const index = lookup.indexes[0];
    if (seenIndexes.has(index)) {
      return { ok: false, reason: "candidate_debits_duplicate_history_entry", snapshot: null, spool, observationKey: key };
    }
    seenIndexes.add(index);
    const entry = history[index];
    if (!shouldLinkOfflineJob(entry)) {
      return { ok: false, reason: "history_already_attributed", snapshot: null, spool, observationKey: key };
    }
    const usedMm = _positiveMm(debit.usedMm);
    if (usedMm <= 0) return { ok: false, reason: "candidate_debit_used_mm_missing", snapshot: null, spool, observationKey: key };
    updates.push({ index, entry, debit, usedMm });
  }

  const snapshot = {
    candidateHash: candidateRecord.candidateHash,
    spoolId: spool.id,
    spool: _clone(spool),
    host,
    historyEntries: updates.map(item => ({ index: item.index, entry: _clone(item.entry) }))
  };
  const now = _nowMs(options);
  const actor = options.actor || "user";
  const decisionType = options.decisionType || "confirm";
  const metadata = {
    candidateHash: candidateRecord.candidateHash,
    decisionType,
    originalCandidateSpoolId: options.originalCandidateSpoolId ?? candidateRecord.candidateSpoolId ?? null,
    createdAt: now,
    actor
  };
  const historyBefore = updates.map(item => _captureHistoryBefore(item.entry, item.debit.observationKey));

  for (const item of updates) {
    _linkHistoryEntryToSpool(item.entry, spool, item.usedMm, metadata);
  }

  spool.remainingLengthMm = Math.max(0, remaining - total.usedMm);
  if (!Array.isArray(spool.usedLengthLog)) spool.usedLengthLog = [];
  const event = {
    eventId: options.eventId || randomEventId("icd"),
    type: INFERRED_DECISION_LEDGER_EVENT_TYPE,
    candidateHash: candidateRecord.candidateHash,
    host,
    spoolId: spool.id,
    originalCandidateSpoolId: metadata.originalCandidateSpoolId,
    decisionType,
    actor,
    usedMm: total.usedMm,
    observationKeys: Array.isArray(candidateRecord.observationKeys) ? candidateRecord.observationKeys.map(String).sort() : [],
    historyBefore,
    createdAt: now
  };
  spool.usedLengthLog.push(event);

  return {
    ok: true,
    reason: "ledger_applied",
    snapshot,
    spool,
    historyEntries: updates.map(item => item.entry),
    event
  };
}

/**
 * 確定済み candidate の台帳反映を取り消す。
 *
 * 【詳細説明】
 * - O5 Decision Core が Undo のために呼ぶ低レベル API。
 * - candidateHash で一意に照合できる `spool.usedLengthLog` event があり、対象履歴にも同じ
 *   candidateHash の O5 attribution が残っている場合だけ逆反映する。
 * - この関数はメモリ上の台帳だけを更新し、保存は行わない。保存失敗時は戻り値の snapshot を
 *   {@link rollbackInferredCandidateLedger} へ渡して復元する。
 *
 * @function undoInferredCandidateLedger
 * @param {Object} candidateRecord - inferredCandidateStore の confirmed/reassigned candidate record。
 * @param {{nowMs?:number, actor?:string}} [options] - 操作者・clock オプション。
 * @returns {{ok:boolean,reason:string,snapshot:?Object,spool:?Object,historyEntries?:Array<Object>,event?:Object}}
 *   Undo 結果。保存失敗 rollback に必要な snapshot を含む。
 * @example
 * const undone = undoInferredCandidateLedger(record);
 */
export function undoInferredCandidateLedger(candidateRecord, options = {}) {
  void options;
  if (!candidateRecord?.candidateHash) return { ok: false, reason: "candidate_required", snapshot: null, spool: null };
  const host = candidateRecord.host;
  if (!host) return { ok: false, reason: "candidate_host_missing", snapshot: null, spool: null };
  const targetSpoolId = _resolvedSpoolId(candidateRecord);
  if (!targetSpoolId) return { ok: false, reason: "resolved_spool_missing", snapshot: null, spool: null };
  const spool = getSpoolById(targetSpoolId);
  if (!spool) return { ok: false, reason: "target_spool_not_found", snapshot: null, spool: null };
  const remaining = _remainingOrNull(spool.remainingLengthMm);
  if (remaining == null) return { ok: false, reason: "confirmed_remaining_unknown", snapshot: null, spool };

  const events = _decisionEventsForCandidate(spool, candidateRecord.candidateHash);
  if (events.length === 0) return { ok: false, reason: "candidate_ledger_event_missing", snapshot: null, spool };
  if (events.length > 1) return { ok: false, reason: "candidate_ledger_event_ambiguous", snapshot: null, spool };
  if (String(events[0].event.spoolId ?? "") !== String(spool.id ?? "")) {
    return { ok: false, reason: "candidate_ledger_event_spool_mismatch", snapshot: null, spool };
  }
  if (String(events[0].event.host ?? "") !== String(host)) {
    return { ok: false, reason: "candidate_ledger_event_host_mismatch", snapshot: null, spool };
  }
  if (_hasUndoEventForDecisionEvent(spool, events[0].event)) {
    return { ok: false, reason: "candidate_ledger_event_already_undone", snapshot: null, spool };
  }
  const eventUsedMm = _positiveMm(events[0].event.usedMm);
  if (eventUsedMm <= 0) return { ok: false, reason: "candidate_ledger_event_used_mm_missing", snapshot: null, spool };

  const history = _historyForHost(host);
  if (!history) return { ok: false, reason: "history_not_found", snapshot: null, spool };
  const debits = _candidateDebits(candidateRecord);
  const total = _validateDebitTotal(candidateRecord, debits);
  if (!total.ok) return { ok: false, reason: total.reason, snapshot: null, spool };
  if (Math.abs(eventUsedMm - total.usedMm) > 0.001) {
    return { ok: false, reason: "candidate_ledger_event_total_mismatch", snapshot: null, spool };
  }
  const beforeMap = _historyBeforeMap(events[0].event);
  if (!beforeMap.ok) return { ok: false, reason: beforeMap.reason, snapshot: null, spool };

  const byKey = _historyIndexByObservationKey(history);
  const updates = [];
  const seenIndexes = new Set();
  for (const debit of debits) {
    const key = String(debit.observationKey ?? "");
    const lookup = byKey.get(key);
    if (!lookup) return { ok: false, reason: "history_entry_missing", snapshot: null, spool, observationKey: key };
    if (lookup.status !== "unique" || lookup.indexes.length !== 1) {
      return { ok: false, reason: "history_observation_ambiguous", snapshot: null, spool, observationKey: key };
    }
    const index = lookup.indexes[0];
    if (seenIndexes.has(index)) {
      return { ok: false, reason: "candidate_debits_duplicate_history_entry", snapshot: null, spool, observationKey: key };
    }
    seenIndexes.add(index);
    const entry = history[index];
    const before = beforeMap.map.get(key);
    if (!before) return { ok: false, reason: "candidate_history_snapshot_missing", snapshot: null, spool, observationKey: key };
    const probe = _validateHistoryPostStateBeforeUndo(entry, before, targetSpoolId, candidateRecord.candidateHash);
    if (!probe.ok) return { ok: false, reason: probe.reason, snapshot: null, spool, observationKey: key };
    updates.push({ index, entry, debit, before });
  }

  const snapshot = {
    candidateHash: candidateRecord.candidateHash,
    spoolId: spool.id,
    spool: _clone(spool),
    host,
    historyEntries: updates.map(item => ({ index: item.index, entry: _clone(item.entry) }))
  };

  for (const item of updates) {
    _restoreHistoryAttributionFromBefore(item.entry, item.before);
  }
  const now = _nowMs(options);
  const actor = options.actor || "user";
  const undoEvent = {
    eventId: options.eventId || randomEventId("icdu"),
    type: INFERRED_DECISION_UNDO_LEDGER_EVENT_TYPE,
    reversesEventId: events[0].event.eventId ?? null,
    candidateHash: candidateRecord.candidateHash,
    host,
    spoolId: spool.id,
    actor,
    usedMm: eventUsedMm,
    observationKeys: Array.isArray(events[0].event.observationKeys) ? events[0].event.observationKeys.slice() : [],
    createdAt: now
  };
  if (!Array.isArray(spool.usedLengthLog)) spool.usedLengthLog = [];
  spool.usedLengthLog.push(undoEvent);
  spool.remainingLengthMm = remaining + eventUsedMm;

  return {
    ok: true,
    reason: "ledger_undone",
    snapshot,
    spool,
    historyEntries: updates.map(item => item.entry),
    event: undoEvent,
    reversedEvent: events[0].event
  };
}

/**
 * 確定反映前 snapshot へメモリ台帳を戻す。
 *
 * 【詳細説明】
 * - Confirm/Reassign 後の耐久保存に失敗した場合、Decision Core がこの関数で spool と履歴を
 *   保存前状態へ戻す。
 * - rollback 自体はメモリ操作であり、呼び出し元が再度 `saveUnifiedStorageDurably()` を実行して
 *   rollback 状態を耐久化する。
 *
 * @function rollbackInferredCandidateLedger
 * @param {?Object} snapshot - {@link applyInferredCandidateLedger} が返した snapshot。
 * @returns {{ok:boolean, reason:string}} rollback 結果。
 * @example
 * const rollback = rollbackInferredCandidateLedger(applied.snapshot);
 */
export function rollbackInferredCandidateLedger(snapshot) {
  if (!snapshot?.spoolId || !snapshot?.host) return { ok: false, reason: "snapshot_required" };
  const spool = getSpoolById(snapshot.spoolId);
  const history = _historyForHost(snapshot.host);
  if (!spool || !history) return { ok: false, reason: "rollback_target_missing" };
  _restoreObjectInPlace(spool, snapshot.spool);
  for (const item of snapshot.historyEntries || []) {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= history.length) {
      return { ok: false, reason: "rollback_history_index_missing" };
    }
    _restoreObjectInPlace(history[item.index], item.entry);
  }
  return { ok: true, reason: "rolled_back" };
}
