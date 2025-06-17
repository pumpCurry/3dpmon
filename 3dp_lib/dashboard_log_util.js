/**
 * @fileoverview
 * 3Dプリンタ監視ツール 3dpmon 用 ログ管理モジュール
 * dashboard_log_util.js
 * (c) pumpCurry 2025
 * -----------------------------------------------------------
 * @module dashboard_log_util
 *
 * 【機能内容サマリ】
 * - LogManager によるログと通知ログの保持
 * - 自動スクロールと差分描画支援
 * - ログ追加ユーティリティを提供
 *
 * 【公開関数一覧】
 * - {@link getMaxLogLines}：最大保持件数取得
 * - {@link LogManager}：ログ管理クラス
 * - {@link logManager}：共有インスタンス
 * - {@link initLogAutoScroll}：自動スクロール設定
 * - {@link initLogRenderer}：レンダラー初期化
 * - {@link flushNormalLogsToDom}：通常ログ描画
 * - {@link flushNotificationLogsToDom}：通知ログ描画
 * - {@link pushLog}：ログ追加
 * - {@link pushNotificationLog}：通知レベルログ追加
 *
 * @version 1.390.193 (PR #86)
 * @since   1.390.193 (PR #86)
 *
 * 長期稼働でもブラウザクラッシュを防ぐため、最新 MAX_LOG_LINES 件のみ保持します。
 */

"use strict";

import { getCurrentTimestamp } from "./dashboard_utils.js";
import { LEVELS } from "./dashboard_constants.js";
import { monitorData } from "./dashboard_data.js";

/** 最大保持ログ行数 */
// const MAX_LOG_LINES = 1000; // monitorDataからもってくることになりました


/* ============================================================================
 * Function: ログ保存件数最大数取得
 * ============================================================================ */
/**
 * @function getMaxLogLines
 * @description
 *   アプリ設定（monitorData.appSettings.logMaxLines）から
 *   ログの最大行数を取得します。
 *   - 正の整数であればその値を返す
 *   - それ以外（未設定・不正値）の場合はデフォルトの1000を返す
 *
 * @returns {number} 表示する最大ログ行数
 */
export function getMaxLogLines() {
  const raw = monitorData.appSettings.logMaxLines;
  const v   = Number(raw);
  // 正の整数かどうかチェック
  if (Number.isInteger(v) && v > 0) {
    return v;
  }
  // デフォルト値
  return 1000;
}

/* ============================================================================
 * Class: LogManager
 * ============================================================================ */
/**
 * @typedef {Object} LogEntry
 * @property {string} timestamp - ISO8601形式などのログ時刻文字列
 * @property {string} level     - ログレベル (LEVELS に含まれる文字列)
 * @property {string} msg       - ログメッセージ本文
 */

/**
 * ログ管理クラス。
 * - 全ログ (`logsAll`) と、通知ログ (`logsNotifications`) を保持。
 * - メモリ上限を超えたら古いエントリを破棄。
 * - "log:added"/"log:cleared" カスタムイベントで UI と連携。
 */
export class LogManager {
  constructor() {
    /** @type {LogEntry[]} 全ログ */
    this.logsAll = [];
    /** @type {LogEntry[]} 通知ログ */
    this.logsNotifications = [];
  }

  /**
   * ログを追加し、"log:added" イベントを発火。
   * - メモリ上限を超えたら先頭エントリを破棄。
   *
   * @param {LogEntry} entry - 追加するログエントリ
   * @fires window#log:added
   */
  add(entry) {
    this.logsAll.push(entry);
    if (entry.notify) {
      this.logsNotifications.push(entry);
    }
  
    // 設定に応じてメモリ内ログをトリミング
    const max = getMaxLogLines();
    if (this.logsAll.length > max) {
      this.logsAll.shift();
    }
    if (this.logsNotifications.length > max) {
      this.logsNotifications.shift();
    }
  
    window.dispatchEvent(new CustomEvent("log:added", { detail: entry }));
  }

  /**
   * 全ログをクリアし、"log:cleared" イベントを発火。
   *
   * @fires window#log:cleared
   */
  clear() {
    this.logsAll.length = 0;
    this.logsNotifications.length = 0;
    window.dispatchEvent(new Event("log:cleared"));
  }

  /** @returns {LogEntry[]} 全ログのコピー */
  getAll() {
    return [...this.logsAll];
  }

  /** @returns {LogEntry[]} 通知ログのコピー */
  getNotifications() {
    return [...this.logsNotifications];
  }
}

/** グローバル LogManager インスタンス */
export const logManager = new LogManager();

/* ============================================================================
 * Function: initLogAutoScroll
 * ============================================================================ */
/**
 * ログ表示要素に自動スクロール機能を付加。
 * - ユーザが下端にいる場合のみ追従。
 * - scroll/resize を rAF スロットリングで処理。
 *
 * @param {HTMLElement} containerEl - ログビューのコンテナ要素
 * @returns {Function} destroy - 登録リスナー解除用クリーンアップ関数
 */
export function initLogAutoScroll(containerEl) {
  let scheduled = false;
  const SCROLL_THRESHOLD_PX = 50;

  function isScrolledCloseToBottom() {
    if (containerEl.scrollHeight <= containerEl.clientHeight) return true;
    return (containerEl.scrollHeight - (containerEl.scrollTop + containerEl.clientHeight)) < SCROLL_THRESHOLD_PX;
  }

  function updateScroll() {
    scheduled = false;
    if (isScrolledCloseToBottom()) {
      containerEl.scrollTop = containerEl.scrollHeight;
    }
  }

  function requestUpdate() {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(updateScroll);
    }
  }

  function cleanup() {
    containerEl.removeEventListener("scroll", requestUpdate);
    window.removeEventListener("resize", requestUpdate);
    window.removeEventListener("beforeunload", cleanup);
  }

  containerEl.addEventListener("scroll", requestUpdate);
  window.addEventListener("resize", requestUpdate);
  window.addEventListener("beforeunload", cleanup);

  requestUpdate();
  return cleanup;
}

/* ============================================================================
 * Function: initLogRenderer
 * ============================================================================ */
/*
 * @function initLogRenderer
 * @description
 *   指定したコンテナ要素にログの描画機能を初期化します。
 *   - `log:added` イベントを購読し、新規ログを追加
 *   - `log:cleared` イベントでログをクリア
 *   - メモリ上の既存ログを一括描画
 *   - 最大行数を超えた古いログは自動で削除
 *
 * @param {HTMLElement} containerEl - ログを表示するコンテナ要素
 * @returns {Function} イベントハンドラを解除するクリーンアップ関数
 */
export function initLogRenderer(containerEl) {
  if (!containerEl) return () => {};

  // 自動スクロール許容のしきい値(px)
  const SCROLL_THRESHOLD = 50;

  /**
   * ログエントリを表示コンテナに追加し、
   * 通知ログの場合は通知履歴にも追加、
   * 行数オーバーした古いものを削除、
   * 自動スクロールを制御します。
   *
   * @param {{ level: string, timestamp: string, msg: string }} entry
   */
  function appendLog(entry) {
    // スクロール位置が最下部付近かを判定
    const atBottom = 
      containerEl.scrollHeight <= containerEl.clientHeight ||
      containerEl.scrollHeight - (containerEl.scrollTop + containerEl.clientHeight) < SCROLL_THRESHOLD;

    // p.log-line.new.log-{level} 要素を作成
    const p = document.createElement("p");
    p.className = `log-line new log-${entry.level}`;
    p.textContent = `[${entry.timestamp}] ${entry.msg}`;
    containerEl.appendChild(p);

    // 通知ログなら notification-history にも複製追加
    if (entry.notify) {
      const errBox = document.getElementById("notification-history");
      if (errBox) {
        const clone = p.cloneNode(true);
        clone.className = `notification-entry log-${entry.level}`;
        errBox.appendChild(clone);
      }
    }


    // 行数制限を超えた分だけ古い通常ログを削除
    const max = getMaxLogLines();
    const lines = containerEl.querySelectorAll("p.log-line");
    if (lines.length > max) {
      const removeCount = lines.length - max;
      for (let i = 0; i < removeCount; i++) {
        containerEl.removeChild(lines[i]);
      }
    }

    // 行数制限を超えた分だけ古い通知ログを削除
    if (entry.notify) {
      const errBox = document.getElementById("notification-history");
      if (errBox) {
        const errLines = errBox.querySelectorAll("p.notification-entry");
        if (errLines.length > max) {
          const removeErrCount = errLines.length - max;
          for (let i = 0; i < removeErrCount; i++) {
            errBox.removeChild(errLines[i]);
          }
        }
      }
    }


    // 自動スクロール
    if (atBottom) {
      containerEl.scrollTop = containerEl.scrollHeight - containerEl.clientHeight;
    }
  }

  /**
   * ログ表示エリアと通知履歴エリアをクリアします。
  */
  function clearLogs() {
    containerEl.innerHTML = "";
    const errBox = document.getElementById("notification-history");
    if (errBox) errBox.innerHTML = "";
  }

  /**
   * `log:added` イベントハンドラ。
   * 既存の「new」を「old」に切り替えてから新規ログを追加。
   *
   * @param {CustomEvent} ev - ev.detail にログエントリが入っています
   */
  function onAdded(ev) {
    containerEl.querySelectorAll("p.new")
      .forEach(el => el.classList.replace("new", "old"));
    appendLog(ev.detail);
  }

  // イベント購読
  window.addEventListener("log:added", onAdded);
  window.addEventListener("log:cleared", clearLogs);

  // 起動時にメモリ上の既存ログを一括描画
  logManager.getAll().forEach(appendLog);

  // クリーンアップ関数を返す
  return () => {
    window.removeEventListener("log:added", onAdded);
    window.removeEventListener("log:cleared", clearLogs);
  };
}

/* ============================================================================
 * Function: flushNormalLogsToDom / flushNotificationLogsToDom
 * ============================================================================ */
/**
 * 指定ログ配列を一括描画する共通処理
 * @param {LogEntry[]} logs
 * @param {HTMLElement} container
 * @param {string} className
 */
function writeLogsToContainer(logs, container, className) {
  if (!container) return;
  container.innerHTML = "";
  logs.forEach(e => {
    const p = document.createElement("p");
    p.className = `${className} log-${e.level}`;
    p.textContent = `[${e.timestamp}] ${e.msg}`;
    container.appendChild(p);
  });
}

/**
 * 通常/情報ログを再描画
 */
export function flushNormalLogsToDom() {
  writeLogsToContainer(
    logManager.getAll().filter(e => ["info", "normal"].includes(e.level)),
    document.getElementById("log"),
    "log-line"
  );
}

/**
 * 通知ログを再描画
 */
export function flushNotificationLogsToDom() {
  const logs = logManager.getNotifications();
  writeLogsToContainer(
    logs,
    document.getElementById("notification-history"),
    "notification-entry"
  );
  if (logs.length) {
    const tsField = document.querySelector('[data-field="lastNotificationTimestamp"] .value');
    if (tsField) tsField.textContent = logs[logs.length - 1].timestamp;
  }
}

/* ============================================================================
 * Function: pushLog
 * ============================================================================ */
/**
 * ログを追加し、差分レンダリングをキック。
 *
 * @param {string|number|Object} msg - ログ内容
 * @param {string} [level="info"]    - ログレベル (LEVELS から選択)
 */
export function pushLog(msg, level = "info", notify = false) {
  let safeMessage;
  if (msg == null || msg === "") {
    safeMessage = "(空メッセージ)";
    level = "debug";
  } else if (typeof msg === "object") {
    try {
      safeMessage = JSON.stringify(msg);
    } catch {
      safeMessage = String(msg);
      level = "debug";
    }
  } else {
    safeMessage = String(msg);
  }

  if (!LEVELS.includes(level)) level = "normal";

  const entry = {
    timestamp: getCurrentTimestamp(),
    level,
    msg: safeMessage,
    notify
  };
  logManager.add(entry);
}

/**
 * 通知ログ専用のユーティリティ
 * @param {string|number|Object} msg
 * @param {string} [level="info"]
 */
export function pushNotificationLog(msg, level = "info") {
  pushLog(msg, level, true);
  const tsField = document.querySelector('[data-field="lastNotificationTimestamp"] .value');
  if (tsField) tsField.textContent = getCurrentTimestamp();
}
