/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 ログ→WSフレーム変換ユーティリティ
 * @file log_replay.js
 * -----------------------------------------------------------
 * @module tests/log_replay
 *
 * 【機能内容サマリ】
 * - ログファイルから WebSocket 受信データを復元
 *
 * 【公開関数一覧】
 * - {@link parseLogToFrames}：ログ行をJSONフレーム配列へ変換
 *
 * @version 1.390.669 (PR #310)
 * @since   1.390.669 (PR #310)
 * @lastModified 2025-07-09 00:00:00
 * -----------------------------------------------------------
 * @todo
 * - 正規表現強化
 */

import fs from 'fs';

/**
 * ログファイルから WebSocket メッセージ配列を生成する。
 * - "受信:" に続く JSON を解析
 * - "heart beat:ok" は heart_beat フレームへ変換
 *
 * @function parseLogToFrames
 * @param {string} path - ログファイルパス
 * @returns {Object[]} 解析された WebSocket フレーム配列
 */
export function parseLogToFrames(path) {
  const text = fs.readFileSync(path, 'utf8');
  const frames = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/受信:\s*(.+)$/);
    if (!m) continue;
    const payload = m[1].trim();
    if (payload.startsWith('{')) {
      try {
        frames.push(JSON.parse(payload));
      } catch {
        /* JSON parse error ignored */
      }
    } else if (payload.startsWith('heart beat:ok')) {
      frames.push({ ModeCode: 'heart_beat' });
    }
  }
  return frames;
}
