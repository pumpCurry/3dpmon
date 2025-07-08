/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 ログ解析ユーティリティ
 * @file log_analyzer.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module log_analyzer
 *
 * 【機能内容サマリ】
 * - ログファイルから印刷状態遷移や履歴保存イベントを抽出
 * - タイマー開始/終了タイミングの解析
 *
 * 【公開関数一覧】
 * - {@link analyzeLogFile}: ログを解析しイベント配列を返す
 *
 * @version 1.390.0 (PR #99999)
 * @since   1.390.0 (PR #99999)
 * @lastModified  2025-01-01 00:00:00
 * -----------------------------------------------------------
 * @todo
 * - 解析精度向上のための正規表現追加
 */

import fs from 'fs';

/**
 * ログ解析結果エントリ型
 * @typedef {Object} LogEvent
 * @property {string} timestamp  - ISO 形式日時文字列
 * @property {string} type       - イベント種別
 * @property {string} message    - 追加メッセージ
 */

/**
 * ログファイルを解析し状態遷移イベントを抽出する。
 *
 * @function analyzeLogFile
 * @param {string} path - 解析するログファイルパス
 * @returns {LogEvent[]} 抽出されたイベント配列
 */
export function analyzeLogFile(path) {
  const text = fs.readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/);
  const events = [];
  for (const line of lines) {
    const m = line.match(/^\[(.+?)\] (.+)$/);
    if (!m) continue;
    const [, ts, rest] = m;
    if (rest.includes('印刷開始')) {
      events.push({ timestamp: ts, type: 'start', message: rest });
    } else if (rest.includes('印刷は停止しました')) {
      events.push({ timestamp: ts, type: 'stop', message: rest });
    } else if (rest.includes('updateHistoryList')) {
      events.push({ timestamp: ts, type: 'history', message: rest });
    } else if (/preparationTime|firstLayerCheckTime|pauseTime/.test(rest)) {
      events.push({ timestamp: ts, type: 'timer', message: rest });
    }
  }
  return events;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node log_analyzer.js <logfile>');
    process.exit(1);
  }
  const result = analyzeLogFile(file);
  console.log(JSON.stringify(result, null, 2));
}
