/**
 * @fileoverview
 * 3Dプリンタ監視ツール 3dpmon 用 材料仕様データ
 * material_specs.js
 * (c) pumpCurry 2025
 * -----------------------------------------------------------
 * @module material_specs
 *
 * 【機能内容サマリ】
 * - フィラメント種別ごとの推奨温度と密度を定義
 *
 * 【公開関数一覧】
 * - {@link MATERIAL_SPECS}：仕様データ定数
 *
 * @version 1.390.0
 * @since   v1.390.0
 */

"use strict";

export const MATERIAL_SPECS = {
  PLA:  { printTemp: [190, 220], bedTemp: [0, 60],  density: 1.24 },
  PETG: { printTemp: [220, 250], bedTemp: [60, 80], density: 1.27 },
  ABS:  { printTemp: [230, 260], bedTemp: [80, 110], density: 1.04 },
  TPU:  { printTemp: [210, 230], bedTemp: [0, 60],  density: 1.20 }
};
