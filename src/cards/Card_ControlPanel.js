/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Card_ControlPanel コンポーネント
 * @file Card_ControlPanel.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module cards/Card_ControlPanel
 *
 * 【機能内容サマリ】
 * - Card_ControlPanel コンポーネントのひな形
 *
 * 【公開クラス一覧】
 * - {@link Card_ControlPanel}：UI コンポーネントクラス
 *
 * @version 1.390.632 (PR #293)
 * @since   1.390.531 (PR #1)
 * @lastModified 2025-07-02 12:00:00
 * -----------------------------------------------------------
 * @todo
 * - 実装詳細を追加
 */

/**
 * Card_ControlPanel コンポーネントクラス
*/
import BaseCard from './BaseCard.js';

export class Card_ControlPanel extends BaseCard {
  /** @type {string} */
  static id = 'CTRL';

  /**
   * @param {{deviceId:string,bus:Object,initialState?:Object}} cfg - 設定
   */
  constructor(cfg) {
    super(cfg.bus);
    /** @type {string} */
    this.id = cfg.deviceId;
  }

  /** @override */
  connected() {
    this.bus.on(`printer:${this.id}:control`, () => {});
  }

  /** @override */
  destroy() {
    this.bus.off(`printer:${this.id}:control`, () => {});
    super.destroy();
  }
}
