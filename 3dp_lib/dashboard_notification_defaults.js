/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 通知デフォルト定義モジュール
 * @file dashboard_notification_defaults.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_notification_defaults
 *
 * 【機能内容サマリ】
 * - 通知タイプごとの既定設定を定義
 *
 * 【公開関数一覧】
 * - {@link DEFAULT_SOUND}：既定サウンドファイル名
 * - {@link defaultNotificationMap}：通知設定マップ
 *
* @version 1.390.368 (PR #164)
* @since   1.390.193 (PR #86)
* @lastModified 2025-06-22 05:10:00
* -----------------------------------------------------------
* @todo
* - none
*/

"use strict";

/**
 * デフォルトで再生するサウンドファイル名
 */
export const DEFAULT_SOUND = "3dp_lib/res/sound/notice.mp3";

/**
 * 通知タイプごとの既定設定
 */
export const defaultNotificationMap = {
  // ──────────────────────────────────────────────────────────────────────────
  // 既存の通知
  // ──────────────────────────────────────────────────────────────────────────
  printStarted:     { talk: "{hostname} で印刷を開始しました ({now})",                             sound: DEFAULT_SOUND, enabled: true, level: "info"    },
  printCompleted:   { talk: "{hostname} で印刷が完了しました ({now})",                             sound: DEFAULT_SOUND, enabled: true, level: "success" },
  printFailed:      { talk: "{hostname} の印刷が失敗しました ({now})",                             sound: DEFAULT_SOUND, enabled: true, level: "error"   },
  printPaused:      { talk: "{hostname} の印刷が一時停止しました ({now})",                         sound: DEFAULT_SOUND, enabled: true, level: "warn"    },
  errorOccurred:    { talk: "{hostname} でエラー発生：コード${error_code}, キー${error_key}, メッセージ${error_msg} ({now})", sound: DEFAULT_SOUND, enabled: true, level: "error"   },
  errorResolved:    { talk: "{hostname} のエラーは解消しました ({now})",                           sound: DEFAULT_SOUND, enabled: true, level: "success" },
  filamentOut:      { talk: "{hostname} のフィラメントが切れました",                               sound: DEFAULT_SOUND, enabled: true, level: "warn"    },
  filamentReplaced: { talk: "{hostname} にフィラメントが補充されました",                         sound: DEFAULT_SOUND, enabled: true, level: "success" },
  timeLeft10:       { talk: "{hostname} 印刷終了まで残り10分です",                                 sound: DEFAULT_SOUND, enabled: true, level: "info"    },
  timeLeft5:        { talk: "{hostname} 印刷終了まで残り5分です",                                  sound: DEFAULT_SOUND, enabled: true, level: "info"    },
  timeLeft1:        { talk: "{hostname} 印刷終了まで残り1分です",                                  sound: DEFAULT_SOUND, enabled: true, level: "info"    },
  cameraServiceStopped: { talk: "{hostname} の動画配信サービスが異常停止しています ({now})",
                   sound: DEFAULT_SOUND, enabled: true, level: "error"   },

  // ──────────────────────────────────────────────────────────────────────────
  // 追加：ノズル／ベッドそれぞれの「上限温度に対する達成度」アラート
  // ──────────────────────────────────────────────────────────────────────────

  // 80%
  tempNearNozzle80: {
    talk: "警告：ノズル温度が上限 ${maxTemp}℃ に対し ${ratio * 100}% の ${currentTemp}℃ に達しています",
    sound: DEFAULT_SOUND,
    enabled: true,
    level: "warn"
  },
  tempNearBed80: {
    talk: "警告：ベッド温度が上限 ${maxTemp}℃ に対し ${ratio * 100}% の ${currentTemp}℃ に達しています",
    sound: DEFAULT_SOUND,
    enabled: true,
    level: "warn"
  },

  // 90%
  tempNearNozzle90: {
    talk: "警告：ノズル温度が上限 ${maxTemp}℃ に対し ${ratio * 100}% の ${currentTemp}℃ に達しています",
    sound: DEFAULT_SOUND,
    enabled: true,
    level: "warn"
  },
  tempNearBed90: {
    talk: "警告：ベッド温度が上限 ${maxTemp}℃ に対し ${ratio * 100}% の ${currentTemp}℃ に達しています",
    sound: DEFAULT_SOUND,
    enabled: true,
    level: "warn"
  },

  // 95%
  tempNearNozzle95: {
    talk: "警告：ノズル温度が上限 ${maxTemp}℃ に対し ${ratio * 100}% の ${currentTemp}℃ に達しています",
    sound: DEFAULT_SOUND,
    enabled: true,
    level: "warn"
  },
  tempNearBed95: {
    talk: "警告：ベッド温度が上限 ${maxTemp}℃ に対し ${ratio * 100}% の ${currentTemp}℃ に達しています",
    sound: DEFAULT_SOUND,
    enabled: true,
    level: "warn"
  },

  // 98%
  tempNearNozzle98: {
    talk: "警告：ノズル温度が上限 ${maxTemp}℃ に対し ${ratio * 100}% の ${currentTemp}℃ に達しています",
    sound: DEFAULT_SOUND,
    enabled: true,
    level: "error"
  },
  tempNearBed98: {
    talk: "警告：ベッド温度が上限 ${maxTemp}℃ に対し ${ratio * 100}% の ${currentTemp}℃ に達しています",
    sound: DEFAULT_SOUND,
    enabled: true,
    level: "error"
  },

  // 100%
  tempNearNozzle100: {
    talk: "警告：ノズル温度が上限 ${maxTemp}℃ に対し ${ratio * 100}% の ${currentTemp}℃ に達しています",
    sound: DEFAULT_SOUND,
    enabled: true,
    level: "error"
  },
  tempNearBed100: {
    talk: "警告：ベッド温度が上限 ${maxTemp}℃ に対し ${ratio * 100}% の ${currentTemp}℃ に達しています",
    sound: DEFAULT_SOUND,
    enabled: true,
    level: "error"
  }
};
