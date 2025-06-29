/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 ModelAdapter モジュール
 * @file ModelAdapter.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * -----------------------------------------------------------
 * @module shared/ModelAdapter
 *
 * 【機能内容サマリ】
 * - プリンタモデルごとのベッドサイズ情報を提供する
 *
 * 【公開クラス一覧】
 * - {@link ModelAdapter}：モデル情報取得クラス
 *
 * @version 1.390.560 (PR #257)
 * @since   1.390.560 (PR #257)
 * @lastModified 2025-06-28 21:00:00
 * -----------------------------------------------------------
 * @todo
 * - 追加モデルの寸法対応
 */

/**
 * モデル情報取得ユーティリティクラス。
 */
export class ModelAdapter {
  /**
   * プリンタモデル名からベッドサイズを取得する。
   *
   * @param {string} model - プリンタモデル名
   * @returns {{w:number,h:number,zMax:number}} 寸法オブジェクト
   */
  static getBedSize(model) {
    const table = {
      'K1': { w: 220, h: 220, zMax: 250 },
      'K1 MAX': { w: 300, h: 300, zMax: 300 },
      'K1C': { w: 220, h: 220, zMax: 250 },
      'K1 SE': { w: 220, h: 220, zMax: 250 },
      'CR-30': { w: 220, h: 36, zMax: 9999 }
    };
    return table[model] ?? { w: 200, h: 200, zMax: 200 };
  }
}
