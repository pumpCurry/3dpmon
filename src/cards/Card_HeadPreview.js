/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 HeadPreviewCard コンポーネント
 * @file Card_HeadPreview.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * -----------------------------------------------------------
 * @module cards/Card_HeadPreview
 *
 * 【機能内容サマリ】
 * - ホットエンド位置を Canvas2D で可視化
 * - モデルに応じたベッドサイズを自動取得
 *
 * 【公開クラス一覧】
 * - {@link HeadPreviewCard}：ヘッド位置プレビューカード
 *
 * @version 1.390.632 (PR #293)
 * @since   1.390.561 (PR #258)
 * @lastModified 2025-07-02 12:00:00
 * -----------------------------------------------------------
 * @todo
 * - Three.js 対応
 */

import BaseCard from './BaseCard.js';
import { ModelAdapter } from '../shared/ModelAdapter.js';

/**
 * ヘッド位置プレビューカードクラス。
 */
export default class HeadPreviewCard extends BaseCard {
  /** @type {string} */
  static id = 'HDPV';

  /**
   * @param {{deviceId:string,bus:Object,initialState?:Object}} cfg - 設定
   */
  constructor(cfg) {
    super(cfg.bus);
    /** @type {string} */
    this.id = cfg.deviceId;
    if (cfg.initialState) this.init(cfg.initialState);
    /** @type {{x:number,y:number,z:number}} */
    this.position = { x: 0, y: 0, z: 0 };
    /** @type {string} */
    this.model = 'K1';
    /** @type {{w:number,h:number,zMax:number}} */
    this.bed = { w: 200, h: 200, zMax: 200 };
    /** @type {HTMLCanvasElement|null} */
    this.canvas = null;
    /** @type {CanvasRenderingContext2D|null} */
    this.ctx = null;
    /** @type {number} */
    this._anim = 0;
    /** @type {((()=>void)|null)} */
    this.onFrame = null;
    /** @private */
    this._onPos = (p) => this.update({ position: p });
    /** @private */
    this._onModel = (m) => {
      this.model = m;
      this.bed = ModelAdapter.getBedSize(m);
      if (this.canvas) {
        this.canvas.width = this.bed.w;
        this.canvas.height = this.bed.h;
      }
    };
  }

  /**
   * 初期化を行う。
   *
   * @param {{position:{x:number,y:number,z:number},model:string}} opt - 設定
   * @returns {void}
   */
  init({ position, model }) {
    this.position = position;
    this.model = model;
    this.bed = ModelAdapter.getBedSize(model);
  }

  /**
   * DOM へカードを挿入する。
   *
   * @param {HTMLElement} root - 親要素
   * @returns {void}
   */
  mount(root) {
    this.el = document.createElement('div');
    this.el.className = 'card headpreview-card';
    this.el.dataset.cardId = HeadPreviewCard.id;
    this.el.setAttribute('tabindex', '0');
    this.el.setAttribute('role', 'img');
    this.el.setAttribute('aria-label', this.#label());
    this.el.setAttribute('aria-keyshortcuts', 'Space,?');
    this.el.addEventListener('keydown', (e) => {
      if (e.key === ' ') this.resetZoom();
      if (e.key === '?') this.showHelp();
    });

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.bed.w;
    this.canvas.height = this.bed.h;
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', this.#label());
    this.el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.#loop();
    super.mount(root);
  }

  /**
   * Bus イベント購読を開始する。
   *
   * @override
   * @returns {void}
   */
  connected() {
    this.bus.on(`printer:${this.id}:gcode-pos`, this._onPos);
    this.bus.on(`printer:${this.id}:model`, this._onModel);
  }

  /**
   * 座標を更新する。
   *
   * @param {{position:{x:number,y:number,z:number}}} param0 - 座標
   * @returns {void}
   */
  update({ position }) {
    if (Number.isNaN(position.x) || Number.isNaN(position.y) || Number.isNaN(position.z)) {
      return;
    }
    this.position = position;
    if (this.el) {
      this.el.setAttribute('aria-label', this.#label());
    }
  }

  /**
   * 破棄処理を行う。
   *
   * @returns {void}
   */
  destroy() {
    cancelAnimationFrame(this._anim);
    this.bus.off(`printer:${this.id}:gcode-pos`, this._onPos);
    this.bus.off(`printer:${this.id}:model`, this._onModel);
    super.destroy();
  }

  /**
   * カード倍率をリセットする。
   *
   * @function resetZoom
   * @returns {void}
   */
  resetZoom() {
    this.scale(1);
  }

  /**
   * ショートカットガイドを表示する。
   *
   * @function showHelp
   * @returns {void}
   */
  showHelp() {
    // 実装簡略化のため alert で一覧を提示する
    alert('Space: reset zoom\n?: show this help');
  }

  /** @private */
  #loop() {
    this._anim = requestAnimationFrame(() => this.#loop());
    this.#draw();
  }

  /** @private */
  #draw() {
    if (!this.ctx || !this.canvas) return;
    if (this.onFrame) this.onFrame();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1;
    // grid
    for (let x = 0; x < this.canvas.width; x += 20) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y < this.canvas.height; y += 20) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.canvas.width, y);
      ctx.stroke();
    }
    // head
    ctx.fillStyle = '#f44';
    const px = (this.position.x / this.bed.w) * this.canvas.width;
    const py = (this.position.y / this.bed.h) * this.canvas.height;
    ctx.beginPath();
    ctx.arc(px, this.canvas.height - py, 5, 0, Math.PI * 2);
    ctx.fill();
    this.canvas.setAttribute('aria-label', this.#label());
  }

  /**
   * 現在位置を ARIA ラベル用に整形する。
   * @private
   * @returns {string}
   */
  #label() {
    const { x, y, z } = this.position;
    return `Head position ${x},${y},${z}`;
  }
}
