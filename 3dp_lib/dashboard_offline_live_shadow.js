/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用オフライン継続推定 live shadow 配線モジュール
 * @file dashboard_offline_live_shadow.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_offline_live_shadow
 *
 * 【機能内容サマリ】
 * - O1/O2/O3/O4 を aggregator から shadow mode で呼び出し、未帰属のオフライン完了だけを
 *   inferredCandidateStore へ冪等保存する。
 * - candidate の永続保存が成功した場合だけ ObservationWindow の baseline を昇格し、再起動後の
 *   二重候補化を防ぐ。
 * - 確定台帳、spool.remainingLengthMm、履歴の filamentInfo には書き込まず、O5 の確認 UI へ渡す
 *   pending candidate のみを作成する。
 *
 * 【公開関数一覧】
 * - {@link runInferredContinuityShadow}：host 単位で O2/O3/O4 の shadow 評価を実行する。
 *
 * @version 1.390.1255 (PR #413)
 * @since   1.390.1246 (PR #413)
 * @lastModified 2026-07-23 15:29:05
 * -----------------------------------------------------------
 * @todo
 * - O5 で UI 確認・否認・再割当てから candidate status を遷移させる。
 */

"use strict";

import { monitorData } from "./dashboard_data.js";
import { saveUnifiedStorageDurably } from "./dashboard_storage.js";
import { ATTR_CLASS, classifyHostAttribution } from "./dashboard_offline_classifier.js";
import { commitObservationWindow, rollbackObservationWindowCommit } from "./dashboard_offline_observation.js";
import { buildInferredContinuityProjection } from "./dashboard_offline_projection.js";
import { persistInferredCandidate } from "./dashboard_offline_candidate_store.js";
import { wallNowMs } from "./dashboard_time.js";

/** host 単位で live shadow の多重実行を防ぐ in-flight registry。 */
const _shadowInflightByHost = new Map();

/**
 * 現在の観測スナップショットから app session ID を取り出す。
 *
 * 【詳細説明】
 * - `commitObservationWindow()` は `expectedAppSessionId` を指定すると、評価後に current が
 *   差し替わった場合の baseline 昇格を拒否する。
 * - hostObservationCurrent が無い場合は null を返し、commit 側の既存 fail-closed 判定へ委ねる。
 *
 * @private
 * @function _currentAppSessionId
 * @param {string} host - 対象ホスト名。
 * @returns {?string} current 観測の appSessionId。存在しない場合は null。
 */
function _currentAppSessionId(host) {
  return monitorData.hostObservationCurrent?.[host]?.appSessionId ?? null;
}

/**
 * host の print history 配列を取得する。
 *
 * 【詳細説明】
 * - O3 projection は履歴を read-only に照合するため、存在しない場合は空配列を渡す。
 * - 戻り値の配列自体はコピーせず、projection 側が変更しない契約に合わせて参照を渡す。
 *
 * @private
 * @function _historyForHost
 * @param {string} host - 対象ホスト名。
 * @returns {Array<Object>} printStore.history 相当の配列。
 */
function _historyForHost(host) {
  const history = monitorData.machines?.[host]?.printStore?.history;
  return Array.isArray(history) ? history : [];
}

/**
 * offline observation key 配列が同じ候補窓を表すか判定する。
 *
 * 【詳細説明】
 * - O2 の candidate identity は observation key 集合で決まるため、順序差は同一とみなす。
 * - 保存待ち中に新しい offline job が増えた場合は別窓として扱い、baseline commit を止める。
 *
 * @private
 * @function _sameObservationKeys
 * @param {Array<string>} a - 比較元 key 配列。
 * @param {Array<string>} b - 比較先 key 配列。
 * @returns {boolean} 同じ key 集合なら true。
 */
function _sameObservationKeys(a, b) {
  const left = Array.isArray(a) ? a.map(String).sort() : [];
  const right = Array.isArray(b) ? b.map(String).sort() : [];
  if (left.length !== right.length) return false;
  return left.every((key, index) => key === right[index]);
}

/**
 * candidate 保存後の再分類結果が、保存済み candidate と同じ窓 identity を保っているか判定する。
 *
 * 【詳細説明】
 * - `saveUnifiedStorageDurably()` の await 中に observationSequence だけが進んだ場合は、
 *   同一窓として最新 sequence で baseline commit してよい。
 * - spool、mount interval、windowId、offline key 集合のいずれかが変わった場合は、保存済み
 *   candidate と現在窓が一致しないため fail-closed する。
 *
 * @private
 * @function _sameCandidateIdentity
 * @param {Object} before - candidate 保存前に使った classification。
 * @param {Object} after - candidate 保存後に再取得した classification。
 * @returns {boolean} baseline commit に同じ candidateHash を使えるなら true。
 */
function _sameCandidateIdentity(before, after) {
  if (after?.classification !== ATTR_CLASS.CONTINUITY_CANDIDATE) return false;
  const b = before?.candidate || {};
  const a = after?.candidate || {};
  return (before?.windowId ?? b.windowId ?? null) === (after?.windowId ?? a.windowId ?? null)
    && (b.candidateSpoolId ?? null) === (a.candidateSpoolId ?? null)
    && (b.candidateBaselineIntervalId ?? null) === (a.candidateBaselineIntervalId ?? null)
    && (b.candidateCurrentIntervalId ?? null) === (a.candidateCurrentIntervalId ?? null)
    && _sameObservationKeys(b.offlineObservationKeys, a.offlineObservationKeys);
}

/**
 * candidate 保存後に永続化を即時 flush する。
 *
 * 【詳細説明】
 * - `candidate保存 → baseline commit` の順序を守るため、commit 前に一度保存する。
 * - テストでは `save:false` を渡すことで副作用を抑止できる。
 *
 * @private
 * @function _saveIfEnabled
 * @param {Object} options - 実行オプション。
 * @param {boolean} [options.save=true] - false の場合は保存をスキップする。
 * @returns {Promise<*>} saveUnifiedStorageDurably の戻り値。保存しない場合は null。
 */
async function _saveIfEnabled(options) {
  if (options?.save === false) return null;
  return await saveUnifiedStorageDurably();
}

/**
 * オフライン継続候補を live shadow mode で評価し、pending candidate と baseline commit を冪等に作成する。
 *
 * 【詳細説明】
 * - O2 が `continuity-candidate` を返した場合だけ O3 projection と O4 candidate store へ進む。
 * - O3 で推定 debit が 0 の場合は、既に catch-up で同一スプールへ確定済み、または消費量不明のため
 *   candidate を保存せず、baseline も進めない。
 * - candidate 永続化の直後に耐久保存を待ち、その保存が成功した後で `commitObservationWindow()` を呼ぶ。
 * - aggregator から呼ばれる shadow 経路なので、例外は返り値へ畳み、本流の帰属・消費処理を止めない。
 *
 * @function runInferredContinuityShadow
 * @param {string} host - 対象ホスト名。
 * @param {?Object} spool - 現在選択中の spool オブジェクト。
 * @param {{save?:boolean}} [options] - テスト用オプション。
 * @returns {Promise<{ok:boolean, reason:string, classification?:Object, projection?:Object, persist?:Object, commit?:Object, save?:Object, error?:string}>}
 *   shadow 評価結果。
 * @example
 * const result = await runInferredContinuityShadow("printer-a", spool);
 */
export async function runInferredContinuityShadow(host, spool, options = {}) {
  if (host && _shadowInflightByHost.has(host)) {
    return { ok: false, reason: "shadow_in_flight" };
  }
  const run = _runInferredContinuityShadow(host, spool, options);
  if (host) _shadowInflightByHost.set(host, run);
  try {
    return await run;
  } finally {
    if (host && _shadowInflightByHost.get(host) === run) _shadowInflightByHost.delete(host);
  }
}

/**
 * オフライン継続候補を live shadow mode で評価する内部実装。
 *
 * 【詳細説明】
 * - 公開関数側で host 単位の in-flight 直列化を行い、この関数は1回分の評価だけを担当する。
 *
 * @private
 * @function _runInferredContinuityShadow
 * @param {string} host - 対象ホスト名。
 * @param {?Object} spool - 現在選択中の spool オブジェクト。
 * @param {{save?:boolean}} [options] - テスト用オプション。
 * @returns {Promise<{ok:boolean, reason:string, classification?:Object, projection?:Object, persist?:Object, commit?:Object, save?:Object, rollback?:Object, error?:string}>}
 *   shadow 評価結果。
 */
async function _runInferredContinuityShadow(host, spool, options = {}) {
  try {
    if (!host) return { ok: false, reason: "host_required" };
    if (!spool || !spool.id) return { ok: false, reason: "spool_required" };

    const classification = classifyHostAttribution(host);
    if (classification?.classification !== ATTR_CLASS.CONTINUITY_CANDIDATE) {
      return { ok: false, reason: classification?.classification || "not_continuity_candidate", classification };
    }

    const projection = buildInferredContinuityProjection(classification, spool, _historyForHost(host));
    if (projection?.eligibleForPersistence !== true) {
      return { ok: false, reason: projection?.status || "projection_not_eligible", classification, projection };
    }
    const persist = persistInferredCandidate(classification, projection);
    if (!persist?.ok) {
      return { ok: false, reason: persist?.reason || "candidate_not_persisted", classification, projection, persist };
    }

    const save = await _saveIfEnabled(options);
    if (save && save.ok === false) {
      return { ok: false, reason: save.reason || "candidate_not_durably_saved", classification, projection, persist, save };
    }
    const commitClassification = classifyHostAttribution(host);
    if (!_sameCandidateIdentity(classification, commitClassification)) {
      return {
        ok: false,
        reason: "classification_changed_since_candidate_persisted",
        classification,
        commitClassification,
        projection,
        persist,
        save
      };
    }
    const persistedAt = Number(persist.record?.createdAt) || Number(persist.record?.updatedAt) || wallNowMs();
    const commit = commitObservationWindow(host, {
      windowId: commitClassification.windowId,
      expectedSequence: commitClassification.currentSequence,
      candidatePersistedAt: persistedAt,
      candidateHash: persist.candidateHash,
      expectedAppSessionId: _currentAppSessionId(host)
    });
    const commitSave = commit?.ok && !commit.idempotent ? await _saveIfEnabled(options) : null;
    if (commit?.ok && commitSave && commitSave.ok === false) {
      const rollback = rollbackObservationWindowCommit(host, {
        windowId: commitClassification.windowId,
        previousBaseline: commit.previousBaseline
      });
      return { ok: false, reason: commitSave.reason || "baseline_not_durably_saved", classification, projection, persist, commit, save: commitSave, rollback };
    }

    return {
      ok: !!commit?.ok,
      reason: commit?.reason || "commit_failed",
      classification,
      projection,
      persist,
      commit,
      save: commitSave || save
    };
  } catch (e) {
    return { ok: false, reason: "shadow_failed", error: e?.message || String(e) };
  }
}
