/**
 * @fileoverview
 * 3Dプリンタ監視ツール 3dpmon 用 汎用ユーティリティ群
 * dashboard_utils.js
 * (c) pumpCurry 2025
 * -----------------------------------------------------------
 * @module dashboard_utils
 *
 * 【機能内容サマリ】
 * - ログコピーや時間フォーマットなど多目的関数
 * - Clipboard API のフォールバックを含む
 * - 座標解析や更新チェック等を提供
 *
 * 【公開関数一覧】
 * - {@link formatDuration} ほか複数をエクスポート
 *
 * @version 1.390.193 (PR #86)
 * @since   1.390.193 (PR #86)
 */

"use strict";

import { monitorData, currentHostname, PLACEHOLDER_HOSTNAME } from "./dashboard_data.js";
import { showAlert } from "./dashboard_notification_manager.js";

/**
 * 秒数を「時間 分 秒 (総秒数)」形式に変換します。
 * @param {number} seconds - 秒数
 * @returns {string} フォーマットされた文字列 (例: "   2時間 03分 15秒 (   7395秒 )")
 */
function formatDuration(seconds) {
  const s = parseInt(seconds, 10);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(4, " ")}時間 ${String(m).padStart(2, "0")}分 ${String(sec).padStart(2, "0")}秒 (${String(s).padStart(6, " ")} 秒)`;
}

/**
 * 秒数を簡易形式に変換します。(例: "1時間23分45秒")
 * @param {number} seconds
 * @returns {string}
 */
function formatDurationSimple(seconds) {
  const s = parseInt(seconds, 10);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}時間${String(m).padStart(2, "0")}分${String(sec).padStart(2, "0")}秒`;
}

/**
 * 与えられたUNIX時間（秒）を "YYYY/MM/DD hh:mm:ss" に整形して返す
 * @param {number} epochSec - UNIXエポック秒
 * @returns {string} フォーマット済み日時 or "----"
 */
function formatEpochToDateTime(epochSec) {
  if (!epochSec || epochSec <= 0) return "----";
  const dt = new Date(epochSec * 1000);
  const pad = (n) => n.toString().padStart(2, '0');
  return `${dt.getFullYear()}/${pad(dt.getMonth() + 1)}/${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
}

/**
 * 印刷終了見込み日時を算出する
 * ※aggregator側では不要になり、mapping側で代替できるためオプション扱い
 * @param {number} startEpoch - 印刷開始エポック秒
 * @param {number} remainingSec - 残り時間（秒）
 * @returns {string} フォーマット済み日時 or "----"
 */
function getEstimatedEndTime(startEpoch, remainingSec) {
  if (!startEpoch || startEpoch <= 0 || !remainingSec || remainingSec <= 0) return "----";
  return formatEpochToDateTime(startEpoch + remainingSec);
}

/**
 * 指定された Date オブジェクトから予想終了時刻の文字列を生成します。
 * @param {Date} date
 * @returns {string} 例: "7月20日 14時53分10秒ごろ"
 */
function formatExpectedEndTime(date) {
  return `${date.getMonth() + 1}月${date.getDate()}日 ${date.getHours()}時${date.getMinutes()}分${date.getSeconds()}秒ごろ`;
}

/**
 * 真偽値や0/1を "0:OFF" / "1:ON" のように整形します。
 * @param {*} value
 * @returns {string}
 */
function formatBinary(value) {
  if (value === 0 || value === "0" || value === false) return "0:OFF";
  if (value === 1 || value === "1" || value === true) return "1:ON";
  return String(value);
}

/**
 * 現在のISO8601形式タイムスタンプを返します。
 * @returns {string}
 */
function getCurrentTimestamp() {
  const d = new Date();
  const pad = (num, size) => ("000000" + num).slice(-size);
  return (
    d.getFullYear() + "-" +
    pad(d.getMonth() + 1, 2) + "-" +
    pad(d.getDate(), 2) + "T" +
    pad(d.getHours(), 2) + ":" +
    pad(d.getMinutes(), 2) + ":" +
    pad(d.getSeconds(), 2) + "." +
    pad(d.getMilliseconds(), 3) +
    "Z"
  );
}

/**
 * curPosition 文字列から { x, y, z } を抽出します。
 * 例："X:12.34 Y:56.78 Z:90.12"
 * @param {string} curPosStr
 * @returns {{x:number, y:number, z:number}|null}
 */
function parseCurPosition(curPosStr) {
  const regex = /X:\s*([\d.-]+)\s+Y:\s*([\d.-]+)\s+Z:\s*([\d.-]+)/i;
  const match = curPosStr.match(regex);
  if (match) {
    return {
      x: parseFloat(match[1]),
      y: parseFloat(match[2]),
      z: parseFloat(match[3])
    };
  }
  return null;
}

/**
 * 一時的にボタンにチェックマークを表示する (コピー成功時のUI演出など)
 * @param {HTMLElement} button
 * @returns {void}
*/
function showTempCheckMark(button) {
  const originalText = button.dataset.original || button.innerText;
  button.innerText = "✅ " + originalText;
  setTimeout(() => {
    button.innerText = originalText;
  }, 2000);
}

/**
 * Clipboard APIが使えない場合のフォールバックコピー
 * @param {string} text
 * @returns {boolean} true=成功, false=失敗
 */
function fallbackCopyTextToClipboard(text) {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.top = "0";
  textArea.style.left = "0";
  textArea.style.position = "fixed";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  let successful = false;
  try {
    successful = document.execCommand('copy');
  } catch (err) {
    console.error("document.execCommand('copy') の実行中にエラー", err);
  }
  document.body.removeChild(textArea);
  return successful;
}

/**
 * ログ配列 (logsAll, logsError など) から、指定件数または全件をクリップボードにコピーします。
 * @param {Array<{ timestamp: string, msg: string }>} logArray - コピー元ログ配列
 * @param {number|null} lastN - 最後 N 件のみコピー (null の場合は全件)
 * @param {HTMLElement} buttonEl - ボタン要素 (showTempCheckMark 用)
 * @returns {void}
 */
function copyLogsToClipboard(logArray, lastN, buttonEl) {
  // 対象ログをスライス
  let slice = logArray;
  if (lastN !== null) {
    const start = Math.max(0, logArray.length - lastN);
    slice = logArray.slice(start);
  }

  // テキスト化
  const text = slice.map(item => `[${item.timestamp}] ${item.msg}`).join("\n");

  const successMsg = "ログをクリップボードにコピーしました";
  const fallbackSuccessMsg = "ログをクリップボードにコピーしました (fallback)";
  const failMsg = "ログのコピーに失敗しました";

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      // 標準 Clipboard API
      navigator.clipboard.writeText(text)
        .then(() => {
          showTempCheckMark(buttonEl);
          showAlert(successMsg, "success", false);
          console.log("[copyLogsToClipboard] コピー成功");
        })
        .catch((err) => {
          console.warn("[copyLogsToClipboard] Clipboard API に失敗:", err);
          // フォールバック
          if (fallbackCopyTextToClipboard(text)) {
            showTempCheckMark(buttonEl);
            showAlert(fallbackSuccessMsg, "success", false);
            console.log("[copyLogsToClipboard] fallback によるコピー成功");
          } else {
            showAlert(failMsg, "warn", true);
            console.error("[copyLogsToClipboard] コピーに失敗");
          }
        });
    } else {
      console.warn("[copyLogsToClipboard] Clipboard API 非対応。fallback 使用");
      // フォールバック
      if (fallbackCopyTextToClipboard(text)) {
        showTempCheckMark(buttonEl);
        showAlert(fallbackSuccessMsg, "success", false);
        console.log("[copyLogsToClipboard] fallback によるコピー成功");
      } else {
        showAlert(failMsg, "warn", true);
        console.error("[copyLogsToClipboard] コピーに失敗");
      }
    }
  } catch (err) {
    console.error("[copyLogsToClipboard] 例外発生:", err);
    // 例外時もフォールバック
    if (fallbackCopyTextToClipboard(text)) {
      showTempCheckMark(buttonEl);
      showAlert(fallbackSuccessMsg, "success", false);
      console.log("[copyLogsToClipboard] fallback によるコピー成功");
    } else {
      showAlert(failMsg, "warn", true);
      console.error("[copyLogsToClipboard] コピーに失敗");
    }
  }
}


/**
 * 現在の機器の storedData を JSON 形式でクリップボードにコピーします。
 * @returns {void}
 */
function copyStoredDataToClipboard() {
  // プレースホルダーの場合は何もしない（ログ出力付き）
  if (currentHostname === PLACEHOLDER_HOSTNAME) {
    console.warn(`[copyStoredDataToClipboard] 未選択状態（${PLACEHOLDER_HOSTNAME}）のため中断`);
    showAlert( "機器が未選択状態で storedData が存在しません。コピーできません","warn", false);
    return;
  }

  const dataStore = monitorData.machines[currentHostname]?.storedData;
  const btn = document.getElementById("copy-storeddata-button");

  if (!dataStore || Object.keys(dataStore).length === 0) {
    console.warn(`[copyStoredDataToClipboard] "${currentHostname}" に storedData が存在しません`);
    showAlert( `${currentHostname}" に storedData が存在しません。コピーできません`,"warn", false);
    return;
  }

  const jsonStr = JSON.stringify(dataStore, null, 2);

  // Clipboard API 対応チェック + コピー処理
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(jsonStr)
      .then(() => {
        showTempCheckMark(btn);
        showAlert("storedData をクリップボードにコピーしました","success", false);
        console.log("[copyStoredDataToClipboard] コピー成功");
      })
      .catch((err) => {
        console.warn("[copyStoredDataToClipboard] Clipboard API に失敗:", err);
        tryFallback(jsonStr, btn);
      });
  } else {
    console.warn("[copyStoredDataToClipboard] Clipboard API 非対応。fallback 使用");

    tryFallback(jsonStr, btn);
  }
}

/**
 * Clipboard API が使えない場合のフォールバック処理
 * @param {string} text - コピー対象の文字列
 * @param {HTMLElement} btn - チェックマーク表示用ボタン要素
 * @returns {void}
 */
function tryFallback(text, btn) {
  if (fallbackCopyTextToClipboard(text)) {
    showTempCheckMark(btn);
    showAlert("storedData をクリップボードにコピーしました (fallback)","success", false);
    console.log("[copyStoredDataToClipboard] fallback によるコピー成功");
  } else {
    showAlert("コピーに失敗しました","warn", true);
    console.error("[copyStoredDataToClipboard] fallback でもコピーに失敗しました");
  }
}



/**
 * checkUpdatedFields:
 * 指定されたフィールド群のどれかが isNew === true の場合に callback を実行し、結果を返す。
 * @param {string[]} fieldNames
 * @param {Function} callback
 * @param {Object} dataStore
 * @returns {boolean}
 */
function checkUpdatedFields(fieldNames, callback, dataStore) {
  const updated = fieldNames.some(fname => dataStore?.[fname]?.isNew === true);
  if (updated && typeof callback === 'function') callback();
  return updated;
}

export {
  formatDuration,
  formatDurationSimple,
  formatEpochToDateTime,
  getEstimatedEndTime,
  formatExpectedEndTime,
  formatBinary,
  getCurrentTimestamp,
  parseCurPosition,
  showTempCheckMark,
  fallbackCopyTextToClipboard,
  copyLogsToClipboard,
  copyStoredDataToClipboard,
  checkUpdatedFields
};
