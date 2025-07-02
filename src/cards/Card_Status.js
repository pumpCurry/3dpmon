/**
 * @description 3Dプリンタ監視ツール 3dpmon 用 Card_Status コンポーネント
 * @file Card_Status.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module cards/Card_Status
 *
 * 【機能内容サマリ】
 * - Card_Status コンポーネントのひな形
 *
 * 【公開クラス一覧】
 * - {@link Card_Status}：UI コンポーネントクラス
 *
 * @version 1.390.637 (PR #296)
 * @since   1.390.531 (PR #1)
 * @lastModified 2025-07-03 12:00:00
 * -----------------------------------------------------------
 * @todo
* - 実装詳細を追加
*/

import BaseCard from './BaseCard.js';

/**
 * Card_Status コンポーネントクラス
 */
export class Card_Status extends BaseCard {
  /** @type {string} */
  static id = 'STAT';

  /**
   * @param {{deviceId:string,bus:Object,initialState?:Object}} cfg - 設定
   */
  constructor(cfg) {
    super(cfg.bus);
    /** @type {string} */
    this.id = cfg.deviceId;
    /** @private */
    this._onStatus = () => {};
  }

  /** @override */
  connected() {
    this.bus.on(`printer:${this.id}:status`, this._onStatus);
  }

  /** @override */
  destroy() {
    this.bus.off(`printer:${this.id}:status`, this._onStatus);
    super.destroy();
  }
}
