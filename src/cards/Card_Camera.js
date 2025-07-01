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
 * @version 1.390.615 (PR #285)
 * @since   1.390.557 (PR #255)
 * @lastModified 2025-07-01 06:19:39
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
    /** @type {number} */
    this._retryCount = 0;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._timer = null;
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
    this.el.className = 'card camera-card';
    this.el.dataset.cardId = CameraCard.id;
    this.el.style.minWidth = `${this.minSize[0]}px`;
    this.el.style.minHeight = `${this.minSize[1]}px`;
    this.el.style.aspectRatio = String(this.aspect);

    this.video = document.createElement('video');
    this.video.autoplay = true;
    this.video.src = this.streamUrl;
    this.video.setAttribute('aria-label', 'Printer camera stream');
    this.video.addEventListener('error', () => this.#handleError());
    this.video.addEventListener('stalled', () => this.#handleError());
    this.el.appendChild(this.video);

    const menu = document.createElement('div');
    menu.className = 'camera-menu';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0.5';
    slider.max = '2';
    slider.step = '0.1';
    slider.value = String(this.scaleValue);
    slider.addEventListener('input', () => {
      this.scale(parseFloat(slider.value));
    });
    const retryBtn = document.createElement('button');
    retryBtn.className = 'retry-btn';
    retryBtn.textContent = '⟳';
    const spin = document.createElement('div');
    spin.className = 'spinner hidden';
    retryBtn.appendChild(spin);
    retryBtn.addEventListener('click', () => {
      retryBtn.disabled = true;
      spin.classList.remove('hidden');
      this._retryCount = 0;
      this.retry().finally(() => {
        retryBtn.disabled = false;
        spin.classList.add('hidden');
      });
    });
    menu.appendChild(slider);
    menu.appendChild(retryBtn);
    this.el.appendChild(menu);

    this.video.addEventListener('loadeddata', () => {
      this._retryCount = 0;
      retryBtn.disabled = false;
      spin.classList.add('hidden');
    });

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
      this._retryCount = 0;
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
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
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
    const delay = Math.min(1000 * 2 ** this._retryCount, 60000);
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      if (this.video) {
        this.video.src = this.streamUrl;
      }
    }, delay);
    this._retryCount += 1;
    return delay;
  }
}
