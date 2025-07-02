/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Card_CurrentPrint コンポーネント
 * @file Card_CurrentPrint.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module cards/Card_CurrentPrint
 *
 * 【機能内容サマリ】
 * - Card_CurrentPrint コンポーネントのひな形
 *
 * 【公開クラス一覧】
 * - {@link Card_CurrentPrint}：UI コンポーネントクラス
 *
 * @version 1.390.632 (PR #293)
 * @since   1.390.531 (PR #1)
 * @lastModified 2025-07-02 12:00:00
 * -----------------------------------------------------------
 * @todo
 * - 実装詳細を追加
 */

/**
 * Card_CurrentPrint コンポーネントクラス
 */
import BaseCard from './BaseCard.js';

export class Card_CurrentPrint extends BaseCard {
  /** @type {string} */
  static id = 'CURP';

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
    this.bus.on(`printer:${this.id}:current`, () => {});
  }

  /** @override */
  destroy() {
    this.bus.off(`printer:${this.id}:current`, () => {});
    super.destroy();
  }
}
