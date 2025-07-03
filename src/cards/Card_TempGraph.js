/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Card_TempGraph コンポーネント
 * @file Card_TempGraph.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * -----------------------------------------------------------
 * @module cards/Card_TempGraph
 *
 * 【機能内容サマリ】
 * - 温度とファン速度を簡易折れ線で描画するカード
 *
 * 【公開クラス一覧】
 * - {@link Card_TempGraph}：UI コンポーネントクラス
 *
* @version 1.390.649 (PR #301)
* @since   1.390.563 (PR #259)
* @lastModified 2025-07-03 15:00:00
 * -----------------------------------------------------------
 * @todo
 * - ズーム機能の高度化
 */

import BaseCard from './BaseCard.js';
import { TempRingBuffer } from '../shared/TempRingBuffer.js';

/**
 * 温度グラフ描画カード。
 */
export default class Card_TempGraph extends BaseCard {
  /** @type {string} */
  static id = 'TEMP';
  /** @private */
  #onTemp;

  constructor(cfg) {
    super(cfg.bus);
    /** @type {string} */
    this.id = cfg.deviceId;
    if (cfg.initialState) this.init(cfg.initialState);
    /** @type {TempRingBuffer} */
    this.buffer = new TempRingBuffer();
    /** @type {HTMLCanvasElement|null} */
    this.canvas = null;
    /** @type {CanvasRenderingContext2D|null} */
    this.ctx = null;
    /** @type {number} */
    this.lastDraw = 0;
    /** @type {HTMLElement|null} */
    this.tooltip = null;
    /** @type {boolean} */
    this.showFan = true;
    /** @type {ReturnType<typeof setInterval>|null} */
    this._snapInterval = null;
    /** @private */
    this.#onTemp = (d) => this.update(d);
  }

  /**
   * 初期化
   * @param {{dataset?:Array<{time:number,hotend:number,bed:number,fan:number}>}} conf - 初期データ
   * @returns {void}
   */
  init(conf = {}) {
    if (Array.isArray(conf.dataset)) {
      conf.dataset.forEach(d => this.buffer.push(d.time, d.hotend, d.bed, d.fan));
    }
  }

  /**
   * DOM に描画する。
   * @param {HTMLElement} root - 追加先
   * @returns {void}
   */
  mount(root) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 300;
    this.canvas.height = 150;
    this.canvas.className = 'temp-graph';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Temperature graph');
    this.canvas.addEventListener('mousemove', (e) => this.#onHover(e));
    this.el = document.createElement('div');
    this.el.className = 'card temp-card';
    this.el.appendChild(this.canvas);
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'tooltip';
    this.el.appendChild(this.tooltip);
    super.mount(root);
    this.ctx = this.canvas.getContext('2d');
    this.#loop();
    this._snapInterval = setInterval(() => {
      if (!this.canvas) return;
      const c = document.createElement('canvas');
      c.width = 64; c.height = 48;
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.drawImage(this.canvas, 0, 0, 64, 48);
        this.bus.emit('card:snapshot', { id: this.id, dataUrl: c.toDataURL('image/png') });
      }
    }, 5000);
  }

  /**
   * Bus イベント購読を開始する。
   *
   * @override
   * @returns {void}
   */
  connected() {
    this.bus.on(`printer:${this.id}:temps`, this.#onTemp);
  }

  /**
   * 新データを追加して描画を要求する。
   * @param {{time:number,hotend:number,bed:number,fan:number}} d - データ
   * @returns {void}
   */
  update(d) {
    this.buffer.push(d.time, d.hotend, d.bed, d.fan);
  }

  /**
   * 描画ループ
   * @private
   * @returns {void}
   */
  #loop() {
    const now = Date.now();
    if (now - this.lastDraw > 1000 / 60) {
      this.#draw();
      this.lastDraw = now;
    }
    this.frame = requestAnimationFrame(() => this.#loop());
  }

  /**
   * バッファ内容から線を描画する。
   * @private
   * @returns {void}
   */
  #draw() {
    if (!this.ctx || !this.canvas) return;
    if (typeof this.onFrame === 'function') this.onFrame();
    const { width, height } = this.canvas;
    this.ctx.clearRect(0, 0, width, height);
    const data = this.buffer.toArray();
    if (data.length === 0) return;
    const maxT = Math.max(...data.map(d => Math.max(d.hotend, d.bed))) + 10;
    const maxF = Math.max(...data.map(d => d.fan));
    const stepX = width / (data.length - 1);
    this.ctx.strokeStyle = getComputedStyle(this.canvas).getPropertyValue('--temp-hot-color') || 'red';
    this.ctx.beginPath();
    data.forEach((d, i) => {
      const x = i * stepX;
      const y = height - (d.hotend / maxT) * height;
      i ? this.ctx.lineTo(x, y) : this.ctx.moveTo(x, y);
    });
    this.ctx.stroke();
    this.ctx.strokeStyle = getComputedStyle(this.canvas).getPropertyValue('--temp-bed-color') || 'orange';
    this.ctx.beginPath();
    data.forEach((d, i) => {
      const x = i * stepX;
      const y = height - (d.bed / maxT) * height;
      i ? this.ctx.lineTo(x, y) : this.ctx.moveTo(x, y);
    });
    this.ctx.stroke();
    if (this.showFan) {
      this.ctx.strokeStyle = getComputedStyle(this.canvas).getPropertyValue('--temp-fan-color') || 'blue';
      this.ctx.beginPath();
      data.forEach((d, i) => {
        const x = i * stepX;
        const y = height - (d.fan / maxF) * height;
        i ? this.ctx.lineTo(x, y) : this.ctx.moveTo(x, y);
      });
      this.ctx.stroke();
    }
  }

  /**
   * ホバー時のツールチップ表示
   * @private
   * @param {MouseEvent} e - マウスイベント
   * @returns {void}
   */
  #onHover(e) {
    if (!this.canvas || !this.tooltip) return;
    const rect = this.canvas.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const index = Math.floor(ratio * this.buffer.toArray().length);
    const d = this.buffer.toArray()[index];
    if (!d) return;
    this.tooltip.textContent = `H:${d.hotend} B:${d.bed} F:${d.fan}`;
    this.tooltip.style.left = `${e.clientX - rect.left}px`;
    this.tooltip.style.top = `${e.clientY - rect.top}px`;
  }

  /**
   * 破棄処理
   * @returns {void}
   */
  destroy() {
    this.bus.off(`printer:${this.id}:temps`, this.#onTemp);
    cancelAnimationFrame(this.frame);
    if (this._snapInterval) {
      clearInterval(this._snapInterval);
      this._snapInterval = null;
    }
    super.destroy();
  }
}
