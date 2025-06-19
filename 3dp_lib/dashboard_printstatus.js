/**
 * @fileoverview
 *  @description 3Dプリンタ監視ツール 3dpmon 用 印刷状態管理ユーティリティ モジュール
 * @file dashboard_printstatus.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_printstatus
 * 【機能内容サマリ】
 * - 印刷ステート履歴を最大4件保持
 * - 特定のステート遷移で通知とログを出力
 *
 * 【公開関数一覧】
 * - {@link handlePrintStateTransition}：状態遷移処理
 *
 * @version 1.390.315 (PR #143)
 * @since   1.390.193 (PR #86)
 * @lastModified 2025-06-19 22:01:15
 * -----------------------------------------------------------
 * @todo
 * - なし
 */

const MAX_HISTORY_LENGTH = 4;

const transitionMessages = {
  // 単発ステート
  "0": "印刷は停止しました。",
  "1": "印刷は開始しました。",
  "2": "印刷は正常に終了しました。",
  "4": "印刷は異常終了しました。",
  "5": "一時停止状態になりました。",
  // 通常2コンボ
  "0→1": "印刷が開始されました。",
  "2→1": "印刷が開始されました。",
  "4→1": "印刷が開始されました。",
  "1→2": "印刷が正常終了しました。",
  "1→4": "印刷が失敗しました。",
  // 3コンボ以上の特殊パターン
  "1→5→4": "一時停止後、印刷は異常終了しました。",
  "1→5→1": "一時停止から印刷を再開しました。",
  "1→5→0→1": "一時停止後、停止してから印刷を再開しました。"
};

// 内部履歴管理（外部からは触れないようスコープ限定）
let stateHistory = [];

/**
 * ステート履歴をクリアする
 */
function resetStateHistory() {
  stateHistory.length = 0;
}

/**
 * ステート遷移イベントを処理し、ログ・通知を行う
 * 
 * @param {number|string} prev - 直前の状態コード
 * @param {number|string} curr - 現在の状態コード
 * @param {function} pushLog - ログ出力関数（テキスト, isError）
 * @param {function} playNotification - 通知音再生関数（テキスト）
 */
export function handlePrintStateTransition(prev, curr, pushLog, playNotification) {
  stateHistory.push(curr);
  if (stateHistory.length > MAX_HISTORY_LENGTH) stateHistory.shift();

  const comboPattern = stateHistory.join("→");
  const directPattern = `${prev}→${curr}`;
  const currentAlone = String(curr);

  // 優先度1：履歴パターン（3〜4遷移）
  if (transitionMessages[comboPattern]) {
    const msg = transitionMessages[comboPattern];
    pushLog(msg, "info");
    playNotification(msg);
    resetStateHistory();
    return;
  }

  // 優先度2：通常2ステップ
  if (transitionMessages[directPattern]) {
    const msg = transitionMessages[directPattern];
    pushLog(msg, "info");
    playNotification(msg);
    resetStateHistory();
    return;
  }

  // 優先度3：単体ステート
  if (transitionMessages[currentAlone]) {
    const msg = transitionMessages[currentAlone];
    pushLog(msg, "info");
    playNotification(msg);
    resetStateHistory();
    return;
  }
}
