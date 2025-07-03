/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 MiniMap ウィジェット
 * @file MiniMap.js
 * -----------------------------------------------------------
 * @module widgets/MiniMap
 *
 * 【機能内容サマリ】
 * - レイアウト全体を縮小表示するミニマップを生成しカードサムネイルを更新
 *
 * 【公開クラス一覧】
 * - {@link MiniMap}：ミニマップクラス
 *
 * @version 1.390.649 (PR #301)
 * @since   1.390.649 (PR #301)
 * @lastModified 2025-07-03 15:00:00
 * -----------------------------------------------------------
 * @todo
 * - なし
 */

export class MiniMap {
  /**
   * @param {{container:HTMLElement,store:import('../core/LayoutStore.js').LayoutStore,bus:Object}} opt - オプション
   */
  constructor({ container, store, bus }) {
    /** @type {HTMLElement} */
    this.container = container;
    /** @type {import('../core/LayoutStore.js').LayoutStore} */
    this.store = store;
    /** @type {Object} */
    this.bus = bus;
    /** @type {HTMLElement|null} */
    this.el = null;
    /** @type {SVGSVGElement|null} */
    this.svg = null;
    /** @type {Map<string,HTMLImageElement>} */
    this.thumbs = new Map();
    /** @private */
    this._debounce = null;
    /** @private */
    this._dragOff = [0, 0];
    /** @private */
    this._onMove = (e) => this.#move(e);
    /** @private */
    this._onUp = () => this.#endDrag();
    this.#init();
  }

  /**
   * 初期化処理を行う。
   * @private
   * @returns {void}
   */
  #init() {
    this.el = document.createElement('div');
    this.el.className = 'minimap';
    this.el.setAttribute('role', 'application');
    this.el.tabIndex = 0;
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('width', '160');
    this.svg.setAttribute('height', '120');
    this.el.appendChild(this.svg);
    this.container.appendChild(this.el);
    this.el.addEventListener('mousedown', (e) => this.#startDrag(e));
    document.addEventListener('keydown', (e) => this.#key(e));
    this.bus.on('layout:update', () => this.#schedule());
    this.bus.on('card:snapshot', (d) => this.#updateThumb(d));
    this.#render();
  }

  /**
   * 描画をスケジューリングする。
   * @private
   * @returns {void}
   */
  #schedule() {
    if (this._debounce) clearTimeout(this._debounce);
    this._debounce = setTimeout(() => this.#render(), 500);
  }

  /**
   * ミニマップを描画する。
   * @private
   * @returns {void}
   */
  #render() {
    if (!this.svg) return;
    const layout = this.store.getCurrentLayout();
    const grid = layout?.grid || [];
    const maxX = Math.max(1, ...grid.map(c => c.x + c.w));
    const maxY = Math.max(1, ...grid.map(c => c.y + c.h));
    this.svg.innerHTML = '';
    this.svg.setAttribute('viewBox', `0 0 ${maxX} ${maxY}`);
    grid.forEach((c) => {
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r.setAttribute('data-id', c.id);
      r.setAttribute('x', c.x);
      r.setAttribute('y', c.y);
      r.setAttribute('width', c.w);
      r.setAttribute('height', c.h);
      r.setAttribute('fill', 'transparent');
      r.setAttribute('stroke', '#fff3');
      r.addEventListener('click', () => this.#focusCard(c.id));
      this.svg.appendChild(r);
      const img = this.thumbs.get(c.id);
      if (img) {
        img.style.left = `${(c.x / maxX) * 100}%`;
        img.style.top = `${(c.y / maxY) * 100}%`;
        img.style.width = `${(c.w / maxX) * 100}%`;
        img.style.height = `${(c.h / maxY) * 100}%`;
      }
    });
  }

  /**
   * サムネイル画像を更新する。
   * @private
   * @param {{id:string,dataUrl:string}} d - スナップショット情報
   * @returns {void}
   */
  #updateThumb(d) {
    if (!this.el) return;
    let img = this.thumbs.get(d.id);
    if (!img) {
      img = document.createElement('img');
      img.className = 'thumb';
      img.dataset.id = d.id;
      img.alt = d.id;
      this.el.appendChild(img);
      this.thumbs.set(d.id, img);
    }
    img.src = d.dataUrl;
  }

  /**
   * カードへスクロールしてハイライトする。
   * @private
   * @param {string} id - カードID
   * @returns {void}
   */
  #focusCard(id) {
    const el = document.querySelector(`[data-card-inst="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('highlight');
    setTimeout(() => el.classList.remove('highlight'), 500);
  }

  /**
   * キーボードハンドラ。
   * @private
   * @param {KeyboardEvent} e - キーイベント
   * @returns {void}
   */
  #key(e) {
    if (e.altKey && e.key.toLowerCase() === 'm') {
      if (this.el) this.el.classList.toggle('hidden');
    } else if (e.key === 'Escape') {
      if (this.el) this.el.classList.add('hidden');
    }
  }

  /**
   * ドラッグ開始処理。
   * @private
   * @param {MouseEvent} e - マウスイベント
   * @returns {void}
   */
  #startDrag(e) {
    if (!this.el) return;
    this.el.classList.add('dragging');
    const rect = this.el.getBoundingClientRect();
    this._dragOff = [e.clientX - rect.left, e.clientY - rect.top];
    document.addEventListener('mousemove', this._onMove);
    document.addEventListener('mouseup', this._onUp);
  }

  /** @private */
  #move(e) {
    if (!this.el) return;
    this.el.style.left = `${e.clientX - this._dragOff[0]}px`;
    this.el.style.top = `${e.clientY - this._dragOff[1]}px`;
    this.el.style.right = 'auto';
    this.el.style.bottom = 'auto';
  }

  /** @private */
  #endDrag() {
    if (!this.el) return;
    this.el.classList.remove('dragging');
    document.removeEventListener('mousemove', this._onMove);
    document.removeEventListener('mouseup', this._onUp);
  }

  /**
   * 破棄処理。
   * @returns {void}
   */
  destroy() {
    if (!this.el) return;
    this.bus.off('layout:update', () => this.#schedule());
    this.bus.off('card:snapshot', (d) => this.#updateThumb(d));
    this.el.remove();
    this.el = null;
  }
}

export default MiniMap;
