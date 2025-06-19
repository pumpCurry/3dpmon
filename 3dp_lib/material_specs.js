/**
 * @fileoverview
 *  @description 3Dプリンタ監視ツール 3dpmon 用 材料仕様データ モジュール
 * @file material_specs.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module material_specs
 * 【機能内容サマリ】
 * - フィラメント種別ごとの推奨温度と密度を定義
 *
 * 【公開関数一覧】
 * - {@link MATERIAL_SPECS}：仕様データ定数
 *
 * @version 1.390.315 (PR #143)
 * @since   1.390.193 (PR #86)
 * @lastModified 2025-06-19 22:01:15
 * -----------------------------------------------------------
 * @todo
 * - なし
 */

"use strict";

export const MATERIAL_SPECS = {
  PLA:  { printTemp: [190, 220], bedTemp: [0, 60],  density: 1.24 },
  PETG: { printTemp: [220, 250], bedTemp: [60, 80], density: 1.27 },
  ABS:  { printTemp: [230, 260], bedTemp: [80, 110], density: 1.04 },
  TPU:  { printTemp: [210, 230], bedTemp: [0, 60],  density: 1.20 }
};
