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
 * @version 1.390.1246 (PR #413)
 * @since   1.390.1246 (PR #413)
 * @lastModified 2026-07-22 02:00:00
 * -----------------------------------------------------------
 * @todo
 * - O5 で UI 確認・否認・再割当てから candidate status を遷移させる。
 */

"use strict";

import { monitorData } from "./dashboard_data.js";
import { saveUnifiedStorage } from "./dashboard_storage.js";
import { ATTR_CLASS, classifyHostAttribution } from "./dashboard_offline_classifier.js";
import { commitObservationWindow } from "./dashboard_offline_observation.js";
import { buildInferredContinuityProjection } from "./dashboard_offline_projection.js";
import { persistInferredCandidate } from "./dashboard_offline_candidate_store.js";

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
 * @returns {*} saveUnifiedStorage の戻り値。保存しない場合は null。
 */
function _saveIfEnabled(options) {
  if (options?.save === false) return null;
  return saveUnifiedStorage(true);
}

/**
 * オフライン継続候補を live shadow mode で評価し、pending candidate と baseline commit を冪等に作成する。
 *
 * 【詳細説明】
 * - O2 が `continuity-candidate` を返した場合だけ O3 projection と O4 candidate store へ進む。
 * - O3 で推定 debit が 0 の場合は、既に catch-up で同一スプールへ確定済み、または消費量不明のため
 *   candidate を保存せず、baseline も進めない。
 * - candidate 永続化の直後に保存し、その保存が例外なく終わった後で `commitObservationWindow()` を呼ぶ。
 * - aggregator から呼ばれる shadow 経路なので、例外は返り値へ畳み、本流の帰属・消費処理を止めない。
 *
 * @function runInferredContinuityShadow
 * @param {string} host - 対象ホスト名。
 * @param {?Object} spool - 現在選択中の spool オブジェクト。
 * @param {{save?:boolean}} [options] - テスト用オプション。
 * @returns {{ok:boolean, reason:string, classification?:Object, projection?:Object, persist?:Object, commit?:Object, error?:string}}
 *   shadow 評価結果。
 * @example
 * const result = runInferredContinuityShadow("printer-a", spool);
 */
export function runInferredContinuityShadow(host, spool, options = {}) {
  try {
    if (!host) return { ok: false, reason: "host_required" };
    if (!spool || !spool.id) return { ok: false, reason: "spool_required" };

    const classification = classifyHostAttribution(host);
    if (classification?.classification !== ATTR_CLASS.CONTINUITY_CANDIDATE) {
      return { ok: false, reason: classification?.classification || "not_continuity_candidate", classification };
    }

    const expectedAppSessionId = _currentAppSessionId(host);
    const projection = buildInferredContinuityProjection(classification, spool, _historyForHost(host));
    const persist = persistInferredCandidate(classification, projection);
    if (!persist?.ok) {
      return { ok: false, reason: persist?.reason || "candidate_not_persisted", classification, projection, persist };
    }

    _saveIfEnabled(options);
    const persistedAt = Number(persist.record?.createdAt) || Number(persist.record?.updatedAt) || Date.now();
    const commit = commitObservationWindow(host, {
      windowId: classification.windowId,
      expectedSequence: classification.currentSequence,
      candidatePersistedAt: persistedAt,
      candidateHash: persist.candidateHash,
      expectedAppSessionId
    });
    if (commit?.ok) _saveIfEnabled(options);

    return {
      ok: !!commit?.ok,
      reason: commit?.reason || "commit_failed",
      classification,
      projection,
      persist,
      commit
    };
  } catch (e) {
    return { ok: false, reason: "shadow_failed", error: e?.message || String(e) };
  }
}
