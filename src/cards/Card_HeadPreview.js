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
 * @version 1.390.560 (PR #257)
 * @since   1.390.560 (PR #257)
 * @lastModified 2025-06-29 12:14:44
 * -----------------------------------------------------------
 * @todo
 * - Three.js 対応
 */

import BaseCard from './BaseCard.js';
import { ModelAdapter } from '@shared/ModelAdapter.js';

/**
 * ヘッド位置プレビューカードクラス。
 */
export default class HeadPreviewCard extends BaseCard {
  /** @type {string} */
  static id = 'HDPV';

  /**
   * @param {Object} bus - EventBus インスタンス
   */
  constructor(bus) {
    super(bus);
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
    this.el.className = 'headpreview-card';
    this.el.dataset.cardId = HeadPreviewCard.id;

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.bed.w;
    this.canvas.height = this.bed.h;
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', this.#label());
    this.el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.bus.on('head:updatePos', this._onPos);
    this.bus.on('head:setModel', this._onModel);

    this.#loop();
    super.mount(root);
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
    if (this.canvas) {
      this.canvas.setAttribute('aria-label', this.#label());
    }
  }

  /**
   * 破棄処理を行う。
   *
   * @returns {void}
   */
  destroy() {
    cancelAnimationFrame(this._anim);
    this.bus.off('head:updatePos', this._onPos);
    this.bus.off('head:setModel', this._onModel);
    super.destroy();
  }

  /** @private */
  #loop() {
    this._anim = requestAnimationFrame(() => this.#loop());
    this.#draw();
  }

  /** @private */
  #draw() {
    if (!this.ctx || !this.canvas) return;
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
