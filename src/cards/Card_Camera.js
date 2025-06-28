/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 CameraCard コンポーネント
 * @file Card_Camera.js
 * -----------------------------------------------------------
 * @module cards/Card_Camera
 *
 * 【機能内容サマリ】
 * - 映像プレビュー表示と再接続処理
 *
 * 【公開クラス一覧】
 * - {@link CameraCard}：カメラプレビューカード
 *
 * @version 1.390.554 (PR #254)
 * @since   1.390.554 (PR #254)
 * @lastModified 2025-06-28 12:39:10
 * -----------------------------------------------------------
 * @todo
 * - WebSocket 連携
 */

import BaseCard from './BaseCard.js';

/**
 * カメラプレビューカードクラス。
 */
export default class CameraCard extends BaseCard {
  /** @type {string} */
  static id = 'CAMV';

  /**
   * @param {Object} bus - EventBus インスタンス
   */
  constructor(bus) {
    super(bus);
    /** @type {string} */
    this.streamUrl = '';
    /** @type {[number, number]} */
    this.minSize = [160, 120];
    /** @type {string|number} */
    this.aspect = '4/3';
    /** @type {number} */
    this._errors = 0;
    /** @type {HTMLVideoElement|null} */
    this.video = null;
  }

  /**
   * 初期設定を行う。
   *
   * @param {{streamUrl:string,minSize?:[number,number],aspect?:string|number}} opt - 設定オブジェクト
   * @returns {void}
   */
  init({ streamUrl, minSize = [160, 120], aspect = '4/3' }) {
    this.streamUrl = streamUrl;
    this.minSize = minSize;
    this.aspect = aspect;
  }

  /**
   * DOM へカードを挿入する。
   *
   * @param {HTMLElement} root - 追加先
   * @returns {void}
   */
  mount(root) {
    this.el = document.createElement('div');
    this.el.className = 'camera-card';
    this.el.dataset.cardId = CameraCard.id;
    this.el.style.minWidth = `${this.minSize[0]}px`;
    this.el.style.minHeight = `${this.minSize[1]}px`;
    this.el.style.aspectRatio = String(this.aspect);

    this.video = document.createElement('video');
    this.video.autoplay = true;
    this.video.src = this.streamUrl;
    this.video.addEventListener('error', () => this.#handleError());
    this.video.addEventListener('stalled', () => this.#handleError());
    this.el.appendChild(this.video);

    super.mount(root);
  }

  /**
   * ストリーム URL を更新する。
   *
   * @param {{streamUrl:string}} param0 - 新URL
   * @returns {void}
   */
  update({ streamUrl }) {
    if (streamUrl && this.video) {
      this.streamUrl = streamUrl;
      this.video.src = streamUrl;
    }
  }

  /**
   * 破棄処理。
   *
   * @returns {void}
   */
  destroy() {
    if (this.video) {
      this.video.src = '';
      this.video = null;
    }
    super.destroy();
  }

  /**
   * エラー検知時の処理。
   *
   * @private
   * @returns {void}
   */
  #handleError() {
    this._errors += 1;
    if (this._errors >= 3) {
      this.bus.emit('camera:retry');
      this.retry();
      this._errors = 0;
    }
  }

  /**
   * 再接続を試みる。
   *
   * @returns {void}
   */
  retry() {
    if (this.video) {
      this.video.src = this.streamUrl;
    }
  }
}
