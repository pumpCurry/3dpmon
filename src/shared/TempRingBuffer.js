/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 TempRingBuffer モジュール
 * @file TempRingBuffer.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * -----------------------------------------------------------
 * @module shared/TempRingBuffer
 *
 * 【機能内容サマリ】
 * - 温度とファン速度を固定長リングバッファで保持
 *
 * 【公開クラス一覧】
 * - {@link TempRingBuffer}：リングバッファクラス
 *
 * @version 1.390.563 (PR #259)
 * @since   1.390.563 (PR #259)
 * @lastModified 2025-06-29 13:09:40
 * -----------------------------------------------------------
 * @todo
 * - なし
 */

/**
 * 温度・ファン速度を一定数保持するリングバッファ。
 */
export class TempRingBuffer {
  /**
   * @param {number} size - バッファ容量
   */
  constructor(size = 4320) {
    /** @type {number} */
    this.size = size;
    /** @type {number[]} */
    this.times = new Array(size).fill(0);
    /** @type {number[]} */
    this.hot = new Array(size).fill(0);
    /** @type {number[]} */
    this.bed = new Array(size).fill(0);
    /** @type {number[]} */
    this.fan = new Array(size).fill(0);
    /** @type {number} */
    this.index = 0;
    /** @type {boolean} */
    this.filled = false;
  }

  /**
   * 新しいデータを追加する。
   *
   * @param {number} time - 取得時刻(ms)
   * @param {number} hotend - ホットエンド温度
   * @param {number} bed - ベッド温度
   * @param {number} fan - ファン速度
   * @returns {void}
   */
  push(time, hotend, bed, fan) {
    this.times[this.index] = time;
    this.hot[this.index] = hotend;
    this.bed[this.index] = bed;
    this.fan[this.index] = fan;
    this.index = (this.index + 1) % this.size;
    if (this.index === 0) this.filled = true;
  }

  /**
   * 全データを古い順に取得する。
   *
   * @returns {{time:number,hotend:number,bed:number,fan:number}[]} データ配列
   */
  toArray() {
    const out = [];
    const count = this.filled ? this.size : this.index;
    for (let i = 0; i < count; i++) {
      const idx = (this.index + i) % this.size;
      out.push({
        time: this.times[idx],
        hotend: this.hot[idx],
        bed: this.bed[idx],
        fan: this.fan[idx]
      });
    }
    return out;
  }
}
