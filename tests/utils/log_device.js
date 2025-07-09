/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 ログ再生モックデバイス
 * @file log_device.js
 * -----------------------------------------------------------
 * @module tests/log_device
 *
 * 【機能内容サマリ】
 * - ログファイルを元に WebSocket 受信JSONを時系列で提供するモック
 *
 * 【公開関数一覧】
 * - {@link createLogDevice}：モックデバイス生成
 *
 * @version 1.390.675 (PR #312)
 * @since   1.390.675 (PR #312)
 * @lastModified 2025-07-10 06:45:45
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import fs from 'fs';
import path from 'path';

/**
 * ログファイルを解析し時刻付きフレーム配列へ変換する。
 *
 * @private
 * @param {string} logPath - ログファイルパス
 * @returns {{time:number, json:Object}[]} 解析結果配列
 */
function parseLog(logPath) {
  const text = fs.readFileSync(logPath, 'utf8');
  const frames = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\[(.+?)\].*?受信:\s*(.+)$/);
    if (!m) continue;
    const time = Date.parse(m[1]) / 1000;
    const payload = m[2].trim();
    if (payload.startsWith('{')) {
      try {
        frames.push({ time, json: JSON.parse(payload) });
      } catch {
        /* 無効な JSON は無視 */
      }
    } else if (payload.startsWith('heart beat:ok')) {
      frames.push({ time, json: { ModeCode: 'heart_beat' } });
    }
  }
  return frames;
}

/**
 * ログ再生用モックデバイスクラス。
 * create の戻り値として利用する。
 *
 * @private
 */
class LogDevice {
  /**
   * @param {{time:number, json:Object}[]} frames - フレーム一覧
   * @param {number} offset - epoc 変換用オフセット
   * @param {number} lastEpoc - 最終取得時刻
   */
  constructor(frames, offset, lastEpoc) {
    this._frames = frames;
    this._offset = offset;
    this._lastEpoc = lastEpoc;
    this._index = 0;
    this._finalEpoc = frames.length
      ? frames[frames.length - 1].time - offset
      : 0;
  }

  /**
   * 指定範囲のフレームを取得する。
   *
   * @param {number} nowEpoc - 現在時刻とみなす epoc 秒
   * @param {number} [lastEpoc=this._lastEpoc] - 前回取得時刻
   * @returns {{json:Object[], is_finished:boolean}} 取得結果
   */
  get(nowEpoc, lastEpoc = this._lastEpoc) {
    this._lastEpoc = lastEpoc;
    const startTime = lastEpoc + this._offset;
    const endTime = nowEpoc + this._offset;
    const json = [];
    while (this._index < this._frames.length &&
           this._frames[this._index].time <= endTime) {
      const f = this._frames[this._index];
      if (f.time > startTime) {
        json.push(f.json);
      }
      this._index++;
    }
    this._lastEpoc = nowEpoc;
    return { json, is_finished: nowEpoc >= this._finalEpoc };
  }
}

/**
 * 指定ログファイルを使用したモックデバイスを生成する。
 *
 * @function createLogDevice
 * @param {string} testlog - 対象ログID (例: '001')
 * @param {number} now_epoc - 現在時刻とみなす epoc 秒
 * @param {number} [last_epoc=0] - 最後に問い合わせた時刻
 * @param {boolean} [is_offset_epoc=false] - epoc オフセット利用有無
 * @returns {Object} LogDevice インスタンス
 */
export function createLogDevice(testlog, now_epoc, last_epoc = 0, is_offset_epoc = false) {
  const logPath = path.resolve('tests', 'data', `printinglog_sample_test_${testlog}.log`);
  const frames = parseLog(logPath);
  const firstTime = frames.length ? frames[0].time : 0;
  const offset = is_offset_epoc ? firstTime - now_epoc : 0;
  return new LogDevice(frames, offset, last_epoc);
}

export default { createLogDevice };
