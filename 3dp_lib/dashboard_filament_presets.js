/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 フィラメントプリセットデータモジュール
 * @file dashboard_filament_presets.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_filament_presets
 *
 * 【機能内容サマリ】
 * - フィラメントスプール登録に使用するプリセット情報を提供
 *
 * 【公開関数一覧】
 * - {@link FILAMENT_PRESETS}: プリセットデータ配列
 *
 * @version 1.390.317 (PR #143)
 * @since   v1.390.0
 * @lastModified 2025-06-19 22:38:18
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

import { monitorData } from "./dashboard_data.js";

/** プリセットエクスポートのフォーマットバージョン */
const FORMAT_VERSION = 1;

/** カスタムプリセット作成に必須のフィールド */
const REQUIRED_FIELDS = ["brand", "material", "color", "colorName", "defaultLength"];

/**
 * フィラメントプリセット情報の配列（ビルトイン）。
 * @type {Array<Object>}
 */
export const FILAMENT_PRESETS = [
  {
    presetId: "preset-cc3d-sand-color",
    brand: "CC3D",
    material: "PLA+",
    color: "#FCC4B6",
    colorName: "サンドカラー",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B09B4WWM6C",
    price: 1699,
    priceCheckDate: "2025-06-15"
  },
  {
    presetId: "preset-cc3d-neon-green",
    brand: "CC3D",
    material: "PLA+",
    color: "#24F747",
    colorName: "蛍光緑",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B09C7FKDQR",
    price: 1699,
    priceCheckDate: "2025-06-15"
  },
  {
    presetId: "preset-unknown-somename-somecolor",
    name: "(不明なフィラメント)",
    brand: "(メーカー不明)",
    material: "PLA+",
    color: "#24F747",
    colorName: "蛍光緑",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B09C7FKDQR",
    price: 1699,
    priceCheckDate: "2025-06-15"
  },
  {
    presetId: "preset-cc3d-gold",
    brand: "CC3D",
    material: "PLA+",
    color: "#D19E38",
    colorName: "アンティークゴールド",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B099NBR9G1",
    price: 1699,
    priceCheckDate: "2025-06-15"
  },
  {
    presetId: "preset-cc3d-red",
    brand: "CC3D",
    material: "PLA+",
    color: "#FF2A24",
    colorName: "レッド",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B07QVHL3VW",
    price: 1699,
    priceCheckDate: "2025-06-15"
  },
  {
    presetId: "preset-cc3d-green",
    brand: "CC3D",
    material: "PLA+",
    color: "#099E5C",
    colorName: "グリーン",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B07R1R7VKZ",
    price: 1699,
    priceCheckDate: "2025-06-15"
  },
  {
    presetId: "preset-cc3d-lemon-yellow",
    brand: "CC3D",
    material: "PLA+",
    color: "#FFDE06",
    colorName: "レモンイエロー",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B09C81K5QH",
    price: 1599,
    priceCheckDate: "2025-06-15"
  },
  {
    presetId: "preset-cc3d-navy-blue",
    brand: "CC3D",
    material: "PLA+",
    color: "#3D50C8",
    colorName: "ネイビーブルー",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B09B4VCD4D",
    price: 1699,
    priceCheckDate: "2025-06-15"
  },
  {
    presetId: "preset-cc3d-orange",
    brand: "CC3D",
    material: "PLA+",
    color: "#F77F3E",
    colorName: "オレンジ",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B07R1SKY5M",
    price: 1599,
    priceCheckDate: "2025-06-15"
  },
  {
    presetId: "preset-cc3d-gray",
    brand: "CC3D",
    material: "PLA+",
    color: "#757776",
    colorName: "グレー",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B07R1RD72N",
    price: 1599,
    priceCheckDate: "2025-06-15"
  },
  {
    presetId: "preset-cc3d-purple",
    brand: "CC3D",
    material: "PLA+",
    color: "#C94AC8",
    colorName: "パープル",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B09C83CMF3",
    price: 1699,
    priceCheckDate: "2025-06-15"
  },
  {
    presetId: "preset-cc3d-blue",
    brand: "CC3D",
    material: "PLA+",
    color: "#0168F0",
    colorName: "ブルー",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B07R1SJCL6",
    price: 1599,
    priceCheckDate: "2025-06-15"
  },
  {
    presetId: "preset-cc3d-black",
    brand: "CC3D",
    material: "PLA+",
    color: "#2C2A2D",
    colorName: "ブラック",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B07R1L1J45",
    price: 1599,
    priceCheckDate: "2025-06-15"
  },
  {
    presetId: "preset-cc3d-marble",
    brand: "CC3D",
    material: "PLA+",
    color: "#BCBCC0",
    colorName: "大理石",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B09TPB336Y",
    price: 1899,
    priceCheckDate: "2025-06-15"
  },
  {
    presetId: "preset-cc3d-bone",
    brand: "CC3D",
    material: "PLA+",
    color: "#DEDCCC",
    colorName: "ボーンカラー",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B099MT5XST",
    price: 1699,
    priceCheckDate: "2025-06-15"
  },
  {
    presetId: "preset-cc3d-brick-red",
    brand: "CC3D",
    material: "PLA+",
    color: "#C75D5F",
    colorName: "ブリックレッド",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B09B3H7C4P",
    price: 1599,
    priceCheckDate: "2025-06-15"
  },
  {
    presetId: "preset-cc3d-yellow",
    brand: "CC3D",
    material: "PLA+",
    color: "#F7F427",
    colorName: "イエロー",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B07ZPLN87K",
    price: 1699,
    priceCheckDate: "2025-06-15"
  },
  {
    presetId: "preset-cc3d-classic-green",
    brand: "CC3D",
    material: "PLA+",
    color: "#228B22",
    colorName: "クラシックグリーン",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B09B3M2MTD",
    price: 1699,
    priceCheckDate: "2025-06-15"
  },
  {
    presetId: "preset-cc3d-turquoise",
    brand: "CC3D",
    material: "PLA+",
    color: "#32E2DE",
    colorName: "ターコイズ",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B09BKZF441",
    price: 1699,
    priceCheckDate: "2025-06-15"
  },
  {
    presetId: "preset-cc3d-blue-gray",
    brand: "CC3D",
    material: "PLA+",
    color: "#98A8B8",
    colorName: "ブルーグレー",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B0836FJ3G1",
    price: 1599,
    priceCheckDate: "2025-06-15"
  },
  {
    presetId: "preset-cc3d-snow-white",
    brand: "CC3D",
    material: "PLA+",
    color: "#DCECFA",
    colorName: "雪白ホワイト",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B09BQX2Y7G",
    price: 1699,
    priceCheckDate: "2025-06-15"
  },
  {
    presetId: "preset-cc3d-white",
    brand: "CC3D",
    material: "PLA+",
    color: "#F6F7EC",
    colorName: "ホワイト",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B06XW5B5TW",
    price: 1699,
    priceCheckDate: "2025-06-15"
  },
  {
    presetId: "preset-cc3d-lavender",
    brand: "CC3D",
    material: "PLA+",
    color: "#7D5F91",
    colorName: "ラベンダー",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B07QZP67Y6",
    price: 1599,
    priceCheckDate: "2025-06-15"
  },
  {
    presetId: "preset-cc3d-gold-gray",
    brand: "CC3D",
    material: "PLA+",
    color: "#95A0AB",
    colorName: "ゴールドグレー",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B099K27SQL",
    price: 1599,
    priceCheckDate: "2025-06-15"
  },
  {
    presetId: "preset-cc3d-lime-green",
    brand: "CC3D",
    material: "PLA+",
    color: "#8DC92B",
    colorName: "ライムグリーン",
    defaultLength: 336000,
    diameter: 1.75,
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    reelOuterDiameter: 195,
    reelThickness: 58,
    reelWindingInnerDiameter: 68,
    reelCenterHoleDiameter: 54,
    reelBodyColor: "#91919A",
    reelFlangeTransparency: 0.4,
    reelWindingForegroundColor: "#71717A",
    reelCenterHoleForegroundColor: "#F4F4F5",
    purchaseLink: "https://www.amazon.co.jp/dp/B09B4VDJHP",
    price: 1599,
    priceCheckDate: "2025-06-15"
  },
  // ── PRINSFIL PETG シリーズ ──
  { presetId: "preset-prinsfil-petg-green", brand: "PRINSFIL", name: "PRINSFIL PETG", material: "PETG", color: "#22C55E", colorName: "グリーン", defaultLength: 315000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 315000, filamentCurrentLength: 315000, density: 1.27, printTempMin: 220, printTempMax: 250, bedTempMin: 70, bedTempMax: 80, reelOuterDiameter: 197, reelThickness: 56, reelWindingInnerDiameter: 170, reelCenterHoleDiameter: 53, reelBodyColor: "#1A1A1A", reelFlangeTransparency: 0.4, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F1LPXGZ6?th=1" },
  { presetId: "preset-prinsfil-petg-white", brand: "PRINSFIL", name: "PRINSFIL PETG", material: "PETG", color: "#FFFFFF", colorName: "ホワイト", defaultLength: 315000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 315000, filamentCurrentLength: 315000, density: 1.27, printTempMin: 220, printTempMax: 250, bedTempMin: 70, bedTempMax: 80, reelOuterDiameter: 197, reelThickness: 56, reelWindingInnerDiameter: 170, reelCenterHoleDiameter: 53, reelBodyColor: "#1A1A1A", reelFlangeTransparency: 0.4, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F1JLCBC8?th=1" },
  { presetId: "preset-prinsfil-petg-vivid-yellow", brand: "PRINSFIL", name: "PRINSFIL PETG", material: "PETG", color: "#FFD700", colorName: "ビビッドイエロー", defaultLength: 315000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 315000, filamentCurrentLength: 315000, density: 1.27, printTempMin: 220, printTempMax: 250, bedTempMin: 70, bedTempMax: 80, reelOuterDiameter: 197, reelThickness: 56, reelWindingInnerDiameter: 170, reelCenterHoleDiameter: 53, reelBodyColor: "#1A1A1A", reelFlangeTransparency: 0.4, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F1LR5CDT?th=1" },
  { presetId: "preset-prinsfil-petg-red", brand: "PRINSFIL", name: "PRINSFIL PETG", material: "PETG", color: "#EF4444", colorName: "レッド", defaultLength: 315000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 315000, filamentCurrentLength: 315000, density: 1.27, printTempMin: 220, printTempMax: 250, bedTempMin: 70, bedTempMax: 80, reelOuterDiameter: 197, reelThickness: 56, reelWindingInnerDiameter: 170, reelCenterHoleDiameter: 53, reelBodyColor: "#1A1A1A", reelFlangeTransparency: 0.4, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F1LPK6B7" },
  { presetId: "preset-prinsfil-petg-clear", brand: "PRINSFIL", name: "PRINSFIL PETG", material: "PETG", color: "#E8E8E8", colorName: "透明", defaultLength: 315000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 315000, filamentCurrentLength: 315000, density: 1.27, printTempMin: 220, printTempMax: 250, bedTempMin: 70, bedTempMax: 80, reelOuterDiameter: 197, reelThickness: 56, reelWindingInnerDiameter: 170, reelCenterHoleDiameter: 53, reelBodyColor: "#1A1A1A", reelFlangeTransparency: 0.4, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F1LQ4QPL" },
  { presetId: "preset-prinsfil-petg-black", brand: "PRINSFIL", name: "PRINSFIL PETG", material: "PETG", color: "#1A1A1A", colorName: "ブラック", defaultLength: 315000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 315000, filamentCurrentLength: 315000, density: 1.27, printTempMin: 220, printTempMax: 250, bedTempMin: 70, bedTempMax: 80, reelOuterDiameter: 197, reelThickness: 56, reelWindingInnerDiameter: 170, reelCenterHoleDiameter: 53, reelBodyColor: "#1A1A1A", reelFlangeTransparency: 0.4, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F1DCSNMB" },
  { presetId: "preset-prinsfil-petg-light-gray", brand: "PRINSFIL", name: "PRINSFIL PETG", material: "PETG", color: "#C0C0C0", colorName: "ライトグレー", defaultLength: 315000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 315000, filamentCurrentLength: 315000, density: 1.27, printTempMin: 220, printTempMax: 250, bedTempMin: 70, bedTempMax: 80, reelOuterDiameter: 197, reelThickness: 56, reelWindingInnerDiameter: 170, reelCenterHoleDiameter: 53, reelBodyColor: "#1A1A1A", reelFlangeTransparency: 0.4, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F1LNFBBV" },
  { presetId: "preset-prinsfil-petg-sky-blue", brand: "PRINSFIL", name: "PRINSFIL PETG", material: "PETG", color: "#87CEEB", colorName: "スカイブルー", defaultLength: 315000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 315000, filamentCurrentLength: 315000, density: 1.27, printTempMin: 220, printTempMax: 250, bedTempMin: 70, bedTempMax: 80, reelOuterDiameter: 197, reelThickness: 56, reelWindingInnerDiameter: 170, reelCenterHoleDiameter: 53, reelBodyColor: "#1A1A1A", reelFlangeTransparency: 0.4, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F1LQR36S?th=1" },
  { presetId: "preset-prinsfil-petg-dark-gray", brand: "PRINSFIL", name: "PRINSFIL PETG", material: "PETG", color: "#505050", colorName: "ダークグレー", defaultLength: 315000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 315000, filamentCurrentLength: 315000, density: 1.27, printTempMin: 220, printTempMax: 250, bedTempMin: 70, bedTempMax: 80, reelOuterDiameter: 197, reelThickness: 56, reelWindingInnerDiameter: 170, reelCenterHoleDiameter: 53, reelBodyColor: "#1A1A1A", reelFlangeTransparency: 0.4, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5" },
  { presetId: "preset-prinsfil-petg-olive-green", brand: "PRINSFIL", name: "PRINSFIL PETG", material: "PETG", color: "#808000", colorName: "オリーブグリーン", defaultLength: 315000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 315000, filamentCurrentLength: 315000, density: 1.27, printTempMin: 220, printTempMax: 250, bedTempMin: 70, bedTempMax: 80, reelOuterDiameter: 197, reelThickness: 56, reelWindingInnerDiameter: 170, reelCenterHoleDiameter: 53, reelBodyColor: "#1A1A1A", reelFlangeTransparency: 0.4, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5" },
  { presetId: "preset-prinsfil-petg-pink", brand: "PRINSFIL", name: "PRINSFIL PETG", material: "PETG", color: "#FF69B4", colorName: "ピンク", defaultLength: 315000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 315000, filamentCurrentLength: 315000, density: 1.27, printTempMin: 220, printTempMax: 250, bedTempMin: 70, bedTempMax: 80, reelOuterDiameter: 197, reelThickness: 56, reelWindingInnerDiameter: 170, reelCenterHoleDiameter: 53, reelBodyColor: "#1A1A1A", reelFlangeTransparency: 0.4, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5" },
  { presetId: "preset-prinsfil-petg-clear-green", brand: "PRINSFIL", name: "PRINSFIL PETG", material: "PETG", color: "#90EE90", colorName: "クリアグリーン", defaultLength: 315000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 315000, filamentCurrentLength: 315000, density: 1.27, printTempMin: 220, printTempMax: 250, bedTempMin: 70, bedTempMax: 80, reelOuterDiameter: 197, reelThickness: 56, reelWindingInnerDiameter: 170, reelCenterHoleDiameter: 53, reelBodyColor: "#1A1A1A", reelFlangeTransparency: 0.4, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5" },
  { presetId: "preset-prinsfil-petg-clear-red", brand: "PRINSFIL", name: "PRINSFIL PETG", material: "PETG", color: "#FF6B6B", colorName: "クリアレッド", defaultLength: 315000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 315000, filamentCurrentLength: 315000, density: 1.27, printTempMin: 220, printTempMax: 250, bedTempMin: 70, bedTempMax: 80, reelOuterDiameter: 197, reelThickness: 56, reelWindingInnerDiameter: 170, reelCenterHoleDiameter: 53, reelBodyColor: "#1A1A1A", reelFlangeTransparency: 0.4, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5" },
  { presetId: "preset-prinsfil-petg-water-blue", brand: "PRINSFIL", name: "PRINSFIL PETG", material: "PETG", color: "#00BFFF", colorName: "ウォーターブルー", defaultLength: 315000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 315000, filamentCurrentLength: 315000, density: 1.27, printTempMin: 220, printTempMax: 250, bedTempMin: 70, bedTempMax: 80, reelOuterDiameter: 197, reelThickness: 56, reelWindingInnerDiameter: 170, reelCenterHoleDiameter: 53, reelBodyColor: "#1A1A1A", reelFlangeTransparency: 0.4, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5" },
  // ── PRINSFIL PETG-GF (ガラス繊維強化) ──
  { presetId: "preset-prinsfil-petg-gf-matte-black", brand: "PRINSFIL", name: "PRINSFIL PETG-GF", material: "PETG-GF", color: "#2D2D2D", colorName: "マットブラック", defaultLength: 315000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 315000, filamentCurrentLength: 315000, density: 1.35, printTempMin: 230, printTempMax: 260, bedTempMin: 70, bedTempMax: 80, reelOuterDiameter: 197, reelThickness: 56, reelWindingInnerDiameter: 170, reelCenterHoleDiameter: 53, reelBodyColor: "#1A1A1A", reelFlangeTransparency: 0.4, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F2LJKG8V" },
  { presetId: "preset-prinsfil-petg-gf-matte-white", brand: "PRINSFIL", name: "PRINSFIL PETG-GF", material: "PETG-GF", color: "#F0F0F0", colorName: "マットホワイト", defaultLength: 315000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 315000, filamentCurrentLength: 315000, density: 1.35, printTempMin: 230, printTempMax: 260, bedTempMin: 70, bedTempMax: 80, reelOuterDiameter: 197, reelThickness: 56, reelWindingInnerDiameter: 170, reelCenterHoleDiameter: 53, reelBodyColor: "#1A1A1A", reelFlangeTransparency: 0.4, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F2LJKG8V?th=1" },
  // ── PRINSFIL PETG-CF (カーボン繊維強化) ──
  { presetId: "preset-prinsfil-petg-cf-marble-gray", brand: "PRINSFIL", name: "PRINSFIL PETG-CF", material: "PETG-CF", color: "#8B8B8B", colorName: "マーブルグレー", defaultLength: 315000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 315000, filamentCurrentLength: 315000, density: 1.30, printTempMin: 230, printTempMax: 260, bedTempMin: 70, bedTempMax: 80, reelOuterDiameter: 197, reelThickness: 56, reelWindingInnerDiameter: 170, reelCenterHoleDiameter: 53, reelBodyColor: "#1A1A1A", reelFlangeTransparency: 0.4, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F2LWSRVL" },
  { presetId: "preset-prinsfil-petg-cf-black", brand: "PRINSFIL", name: "PRINSFIL PETG-CF", material: "PETG-CF", color: "#1A1A1A", colorName: "ブラック", defaultLength: 315000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 315000, filamentCurrentLength: 315000, density: 1.30, printTempMin: 230, printTempMax: 260, bedTempMin: 70, bedTempMax: 80, reelOuterDiameter: 197, reelThickness: 56, reelWindingInnerDiameter: 170, reelCenterHoleDiameter: 53, reelBodyColor: "#1A1A1A", reelFlangeTransparency: 0.4, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F2M93D1H?th=1" },
  { presetId: "preset-prinsfil-petg-cf-water-blue", brand: "PRINSFIL", name: "PRINSFIL PETG-CF", material: "PETG-CF", color: "#00BFFF", colorName: "ウォーターブルー", defaultLength: 315000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 315000, filamentCurrentLength: 315000, density: 1.30, printTempMin: 230, printTempMax: 260, bedTempMin: 70, bedTempMax: 80, reelOuterDiameter: 197, reelThickness: 56, reelWindingInnerDiameter: 170, reelCenterHoleDiameter: 53, reelBodyColor: "#1A1A1A", reelFlangeTransparency: 0.4, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5" },
  { presetId: "preset-prinsfil-petg-cf-sunflower", brand: "PRINSFIL", name: "PRINSFIL PETG-CF", material: "PETG-CF", color: "#FFB347", colorName: "サンフラワー", defaultLength: 315000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 315000, filamentCurrentLength: 315000, density: 1.30, printTempMin: 230, printTempMax: 260, bedTempMin: 70, bedTempMax: 80, reelOuterDiameter: 197, reelThickness: 56, reelWindingInnerDiameter: 170, reelCenterHoleDiameter: 53, reelBodyColor: "#1A1A1A", reelFlangeTransparency: 0.4, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5" },
  // ── PRINSFIL GO PLA+ シリーズ (透明リール) ──
  { presetId: "preset-prinsfil-go-pla-plus-black", brand: "PRINSFIL", name: "PRINSFIL GO PLA+", material: "PLA+", color: "#1A1A1A", colorName: "ブラック", defaultLength: 335000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 335000, filamentCurrentLength: 335000, density: 1.24, printTempMin: 200, printTempMax: 230, bedTempMin: 50, bedTempMax: 60, reelOuterDiameter: 200, reelThickness: 65, reelWindingInnerDiameter: 95, reelCenterHoleDiameter: 54, reelBodyColor: "#E8E8E8", reelFlangeTransparency: 0.7, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F9WJT32D" },
  { presetId: "preset-prinsfil-go-pla-plus-white", brand: "PRINSFIL", name: "PRINSFIL GO PLA+", material: "PLA+", color: "#FFFFFF", colorName: "ホワイト", defaultLength: 335000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 335000, filamentCurrentLength: 335000, density: 1.24, printTempMin: 200, printTempMax: 230, bedTempMin: 50, bedTempMax: 60, reelOuterDiameter: 200, reelThickness: 65, reelWindingInnerDiameter: 95, reelCenterHoleDiameter: 54, reelBodyColor: "#E8E8E8", reelFlangeTransparency: 0.7, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F9WLP394" },
  { presetId: "preset-prinsfil-go-pla-plus-gray", brand: "PRINSFIL", name: "PRINSFIL GO PLA+", material: "PLA+", color: "#808080", colorName: "グレー", defaultLength: 335000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 335000, filamentCurrentLength: 335000, density: 1.24, printTempMin: 200, printTempMax: 230, bedTempMin: 50, bedTempMax: 60, reelOuterDiameter: 200, reelThickness: 65, reelWindingInnerDiameter: 95, reelCenterHoleDiameter: 54, reelBodyColor: "#E8E8E8", reelFlangeTransparency: 0.7, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F9WN8KYY" },
  { presetId: "preset-prinsfil-go-pla-plus-red", brand: "PRINSFIL", name: "PRINSFIL GO PLA+", material: "PLA+", color: "#EF4444", colorName: "レッド", defaultLength: 335000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 335000, filamentCurrentLength: 335000, density: 1.24, printTempMin: 200, printTempMax: 230, bedTempMin: 50, bedTempMax: 60, reelOuterDiameter: 200, reelThickness: 65, reelWindingInnerDiameter: 95, reelCenterHoleDiameter: 54, reelBodyColor: "#E8E8E8", reelFlangeTransparency: 0.7, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F9WMVR79" },
  { presetId: "preset-prinsfil-go-pla-plus-blue", brand: "PRINSFIL", name: "PRINSFIL GO PLA+", material: "PLA+", color: "#3B82F6", colorName: "ブルー", defaultLength: 335000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 335000, filamentCurrentLength: 335000, density: 1.24, printTempMin: 200, printTempMax: 230, bedTempMin: 50, bedTempMax: 60, reelOuterDiameter: 200, reelThickness: 65, reelWindingInnerDiameter: 95, reelCenterHoleDiameter: 54, reelBodyColor: "#E8E8E8", reelFlangeTransparency: 0.7, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F9WLWVMT" },
  // ── PRINSFIL GO ABS+ ──
  { presetId: "preset-prinsfil-go-abs-plus-black", brand: "PRINSFIL", name: "PRINSFIL GO ABS+", material: "ABS+", color: "#1A1A1A", colorName: "ブラック", defaultLength: 385000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 385000, filamentCurrentLength: 385000, density: 1.04, printTempMin: 230, printTempMax: 260, bedTempMin: 90, bedTempMax: 110, reelOuterDiameter: 200, reelThickness: 65, reelWindingInnerDiameter: 95, reelCenterHoleDiameter: 54, reelBodyColor: "#E8E8E8", reelFlangeTransparency: 0.7, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F9WKF9QR" },
  { presetId: "preset-prinsfil-go-abs-plus-white", brand: "PRINSFIL", name: "PRINSFIL GO ABS+", material: "ABS+", color: "#FFFFFF", colorName: "ホワイト", defaultLength: 385000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 385000, filamentCurrentLength: 385000, density: 1.04, printTempMin: 230, printTempMax: 260, bedTempMin: 90, bedTempMax: 110, reelOuterDiameter: 200, reelThickness: 65, reelWindingInnerDiameter: 95, reelCenterHoleDiameter: 54, reelBodyColor: "#E8E8E8", reelFlangeTransparency: 0.7, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F9WL7LMM" },
  // ── PRINSFIL GO TPU ──
  { presetId: "preset-prinsfil-go-tpu-black", brand: "PRINSFIL", name: "PRINSFIL GO TPU", material: "TPU", color: "#1A1A1A", colorName: "ブラック", defaultLength: 335000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 335000, filamentCurrentLength: 335000, density: 1.21, printTempMin: 210, printTempMax: 230, bedTempMin: 40, bedTempMax: 60, reelOuterDiameter: 200, reelThickness: 65, reelWindingInnerDiameter: 95, reelCenterHoleDiameter: 54, reelBodyColor: "#E8E8E8", reelFlangeTransparency: 0.7, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F9WLBSVX" },
  { presetId: "preset-prinsfil-go-tpu-clear", brand: "PRINSFIL", name: "PRINSFIL GO TPU", material: "TPU", color: "#E8E8E8", colorName: "透明", defaultLength: 335000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 335000, filamentCurrentLength: 335000, density: 1.21, printTempMin: 210, printTempMax: 230, bedTempMin: 40, bedTempMax: 60, reelOuterDiameter: 200, reelThickness: 65, reelWindingInnerDiameter: 95, reelCenterHoleDiameter: 54, reelBodyColor: "#E8E8E8", reelFlangeTransparency: 0.7, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F9WJHDQQ" },
  // ── PRINSFIL GO ASA ──
  { presetId: "preset-prinsfil-go-asa-black", brand: "PRINSFIL", name: "PRINSFIL GO ASA", material: "ASA", color: "#1A1A1A", colorName: "ブラック", defaultLength: 385000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 385000, filamentCurrentLength: 385000, density: 1.07, printTempMin: 235, printTempMax: 260, bedTempMin: 90, bedTempMax: 110, reelOuterDiameter: 200, reelThickness: 65, reelWindingInnerDiameter: 95, reelCenterHoleDiameter: 54, reelBodyColor: "#E8E8E8", reelFlangeTransparency: 0.7, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F9WK381B" },
  { presetId: "preset-prinsfil-go-asa-white", brand: "PRINSFIL", name: "PRINSFIL GO ASA", material: "ASA", color: "#FFFFFF", colorName: "ホワイト", defaultLength: 385000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 385000, filamentCurrentLength: 385000, density: 1.07, printTempMin: 235, printTempMax: 260, bedTempMin: 90, bedTempMax: 110, reelOuterDiameter: 200, reelThickness: 65, reelWindingInnerDiameter: 95, reelCenterHoleDiameter: 54, reelBodyColor: "#E8E8E8", reelFlangeTransparency: 0.7, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F9WLT7SR" },
  // ── PRINSFIL GO PLA SILK ──
  { presetId: "preset-prinsfil-go-pla-silk-gold", brand: "PRINSFIL", name: "PRINSFIL GO PLA SILK", material: "PLA SILK", color: "#FFD700", colorName: "ゴールド", defaultLength: 340000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 340000, filamentCurrentLength: 340000, density: 1.24, printTempMin: 200, printTempMax: 230, bedTempMin: 50, bedTempMax: 60, reelOuterDiameter: 200, reelThickness: 65, reelWindingInnerDiameter: 95, reelCenterHoleDiameter: 54, reelBodyColor: "#E8E8E8", reelFlangeTransparency: 0.7, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F9WP9N2W" },
  { presetId: "preset-prinsfil-go-pla-silk-silver", brand: "PRINSFIL", name: "PRINSFIL GO PLA SILK", material: "PLA SILK", color: "#C0C0C0", colorName: "シルバー", defaultLength: 340000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 340000, filamentCurrentLength: 340000, density: 1.24, printTempMin: 200, printTempMax: 230, bedTempMin: 50, bedTempMax: 60, reelOuterDiameter: 200, reelThickness: 65, reelWindingInnerDiameter: 95, reelCenterHoleDiameter: 54, reelBodyColor: "#E8E8E8", reelFlangeTransparency: 0.7, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F9WNKWWH" },
  { presetId: "preset-prinsfil-go-pla-silk-copper", brand: "PRINSFIL", name: "PRINSFIL GO PLA SILK", material: "PLA SILK", color: "#B87333", colorName: "銅", defaultLength: 340000, diameter: 1.75, filamentDiameter: 1.75, filamentTotalLength: 340000, filamentCurrentLength: 340000, density: 1.24, printTempMin: 200, printTempMax: 230, bedTempMin: 50, bedTempMax: 60, reelOuterDiameter: 200, reelThickness: 65, reelWindingInnerDiameter: 95, reelCenterHoleDiameter: 54, reelBodyColor: "#E8E8E8", reelFlangeTransparency: 0.7, reelWindingForegroundColor: "#71717A", reelCenterHoleForegroundColor: "#F4F4F5", purchaseLink: "https://www.amazon.co.jp/dp/B0F9WMN5PX" }
];

/* ===================================================================
   カスタムプリセット管理 — ユーザー定義プリセットのCRUD + インポート/エクスポート
   =================================================================== */

/**
 * ビルトイン + ユーザー定義の全プリセットを統合して返す。
 * 非表示プリセットは含む（フィルタリングは呼び出し元で実施）。
 *
 * @param {{ includeHidden?: boolean }} [opts] - オプション
 * @returns {Array<Object>} 統合プリセット配列
 */
export function getAllPresets(opts = {}) {
  const builtin = FILAMENT_PRESETS.map(p => ({ ...p, isBuiltin: true, presetVersion: p.presetVersion || 1 }));
  const user = (monitorData.userPresets || []).map(p => ({ ...p, isBuiltin: false }));
  const all = [...builtin, ...user];
  if (opts.includeHidden) return all;
  const hidden = new Set(monitorData.hiddenPresets || []);
  return all.filter(p => !hidden.has(p.presetId));
}

/**
 * 指定プリセットIDが非表示かどうか判定する。
 * @param {string} presetId - プリセットID
 * @returns {boolean}
 */
export function isHiddenPreset(presetId) {
  return (monitorData.hiddenPresets || []).includes(presetId);
}

/**
 * プリセットの表示/非表示を切り替える。
 * @param {string} presetId - 対象プリセットID
 * @returns {boolean} 切替後の非表示状態
 */
export function togglePresetVisibility(presetId) {
  if (!monitorData.hiddenPresets) monitorData.hiddenPresets = [];
  const idx = monitorData.hiddenPresets.indexOf(presetId);
  if (idx >= 0) {
    monitorData.hiddenPresets.splice(idx, 1);
    return false; // 表示に戻った
  }
  monitorData.hiddenPresets.push(presetId);
  return true; // 非表示にした
}

/**
 * ブランド単位で一括非表示/表示を切り替える。
 * @param {string} brand - ブランド名
 * @returns {boolean} 切替後の非表示状態（true=全非表示にした）
 */
export function toggleBrandVisibility(brand) {
  if (!brand) return false;
  const all = getAllPresets({ includeHidden: true });
  const brandPresets = all.filter(p => (p.brand || "") === brand);
  if (brandPresets.length === 0) return false;

  if (!monitorData.hiddenPresets) monitorData.hiddenPresets = [];
  const hiddenSet = new Set(monitorData.hiddenPresets);
  const allHidden = brandPresets.every(p => hiddenSet.has(p.presetId));

  if (allHidden) {
    // 全非表示 → 全表示に戻す
    for (const p of brandPresets) hiddenSet.delete(p.presetId);
  } else {
    // 一部表示 or 全表示 → 全非表示にする
    for (const p of brandPresets) hiddenSet.add(p.presetId);
  }
  monitorData.hiddenPresets = [...hiddenSet];
  return !allHidden;
}

/**
 * プリセットのお気に入り状態を切り替える。
 * @param {string} presetId - 対象プリセットID
 * @returns {boolean} 切替後のお気に入り状態
 */
export function togglePresetFavorite(presetId) {
  if (!monitorData.favoritePresets) monitorData.favoritePresets = [];
  const idx = monitorData.favoritePresets.indexOf(presetId);
  if (idx >= 0) {
    monitorData.favoritePresets.splice(idx, 1);
    return false;
  }
  monitorData.favoritePresets.push(presetId);
  return true;
}

/**
 * プリセットがお気に入りかどうか返す。
 * @param {string} presetId
 * @returns {boolean}
 */
export function isPresetFavorite(presetId) {
  return (monitorData.favoritePresets || []).includes(presetId);
}

/**
 * カスタムプリセットのバリデーション。
 * @private
 * @param {Object} data - プリセットデータ
 * @returns {{ valid: boolean, errors: string[] }}
 */
function _validatePreset(data) {
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    if (!data[field] && data[field] !== 0) {
      errors.push(`必須フィールド '${field}' が未設定です`);
    }
  }
  if (data.defaultLength != null && data.defaultLength <= 0) {
    errors.push("defaultLength は正の数である必要があります");
  }
  return { valid: errors.length === 0, errors };
}

/**
 * ユーザー定義プリセットを新規追加する。
 * presetId は自動生成（user-{uuid}）。
 *
 * @param {Object} data - プリセットデータ（presetId不要）
 * @returns {{ success: boolean, preset?: Object, errors?: string[] }}
 */
export function addUserPreset(data) {
  const validation = _validatePreset(data);
  if (!validation.valid) return { success: false, errors: validation.errors };

  if (!monitorData.userPresets) monitorData.userPresets = [];

  const preset = {
    ...data,
    presetId: `user-${crypto.randomUUID()}`,
    isBuiltin: false,
    presetVersion: 1,
    source: "3dpmon-user",
    createdAt: new Date().toISOString(),
    // デフォルト値の補完
    diameter: data.diameter || 1.75,
    filamentDiameter: data.filamentDiameter || data.diameter || 1.75,
    filamentTotalLength: data.filamentTotalLength || data.defaultLength,
    filamentCurrentLength: data.filamentCurrentLength || data.defaultLength,
    reelOuterDiameter: data.reelOuterDiameter || 200,
    reelThickness: data.reelThickness || 65,
    reelWindingInnerDiameter: data.reelWindingInnerDiameter || 95,
    reelCenterHoleDiameter: data.reelCenterHoleDiameter || 54,
    reelBodyColor: data.reelBodyColor || "#A1A1AA",
    reelFlangeTransparency: data.reelFlangeTransparency ?? 0.4,
    reelWindingForegroundColor: data.reelWindingForegroundColor || "#71717A",
    reelCenterHoleForegroundColor: data.reelCenterHoleForegroundColor || "#F4F4F5"
  };

  monitorData.userPresets.push(preset);
  return { success: true, preset };
}

/**
 * 既存カスタムプリセットを更新する。
 * ビルトインプリセットは更新不可。
 *
 * @param {string} presetId - 更新対象のプリセットID
 * @param {Object} changes - 変更するフィールド
 * @returns {{ success: boolean, errors?: string[] }}
 */
export function updateUserPreset(presetId, changes) {
  if (!presetId.startsWith("user-")) {
    return { success: false, errors: ["ビルトインプリセットは編集できません"] };
  }
  const arr = monitorData.userPresets || [];
  const idx = arr.findIndex(p => p.presetId === presetId);
  if (idx < 0) return { success: false, errors: ["プリセットが見つかりません"] };

  const merged = { ...arr[idx], ...changes, presetId, isBuiltin: false };
  const validation = _validatePreset(merged);
  if (!validation.valid) return { success: false, errors: validation.errors };

  arr[idx] = merged;
  return { success: true };
}

/**
 * カスタムプリセットを削除する。
 * ビルトインプリセットは削除不可。
 *
 * @param {string} presetId - 削除対象のプリセットID
 * @returns {{ success: boolean, errors?: string[] }}
 */
export function deleteUserPreset(presetId) {
  if (!presetId.startsWith("user-")) {
    return { success: false, errors: ["ビルトインプリセットは削除できません"] };
  }
  const arr = monitorData.userPresets || [];
  const idx = arr.findIndex(p => p.presetId === presetId);
  if (idx < 0) return { success: false, errors: ["プリセットが見つかりません"] };

  arr.splice(idx, 1);
  // 非表示リストからも除去
  const hidIdx = (monitorData.hiddenPresets || []).indexOf(presetId);
  if (hidIdx >= 0) monitorData.hiddenPresets.splice(hidIdx, 1);
  return { success: true };
}

/**
 * ユーザー定義プリセットをJSON文字列としてエクスポートする。
 * フォーマットバージョンと由来情報を含む。
 *
 * @returns {string} JSON文字列
 */
export function exportUserPresets() {
  return JSON.stringify({
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: "3dpmon-user",
    presets: monitorData.userPresets || []
  }, null, 2);
}

/**
 * JSON文字列からユーザー定義プリセットをインポートする。
 * マージモード（デフォルト）ではID重複時に既存を優先し新規のみ追加。
 *
 * @param {string} jsonStr - JSON文字列
 * @param {{ merge?: boolean }} [opts] - merge: true（デフォルト）で既存に追加、falseで全置換
 * @returns {{ success: boolean, added: number, skipped: number, errors: string[] }}
 */
export function importUserPresets(jsonStr, opts = {}) {
  const merge = opts.merge !== false;
  const errors = [];
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    return { success: false, added: 0, skipped: 0, errors: ["JSONの解析に失敗しました: " + e.message] };
  }

  if (!parsed.presets || !Array.isArray(parsed.presets)) {
    return { success: false, added: 0, skipped: 0, errors: ["presets配列が見つかりません"] };
  }

  if (!monitorData.userPresets) monitorData.userPresets = [];
  const existingIds = new Set(monitorData.userPresets.map(p => p.presetId));
  let added = 0;
  let skipped = 0;

  if (!merge) {
    // 全置換モード
    monitorData.userPresets = [];
    existingIds.clear();
  }

  for (const p of parsed.presets) {
    const validation = _validatePreset(p);
    if (!validation.valid) {
      errors.push(`プリセット "${p.colorName || p.presetId || "不明"}": ${validation.errors.join(", ")}`);
      skipped++;
      continue;
    }
    if (existingIds.has(p.presetId)) {
      skipped++;
      continue;
    }
    // presetId がなければ自動生成
    if (!p.presetId) p.presetId = `user-${crypto.randomUUID()}`;
    p.isBuiltin = false;
    p.source = p.source || "3dpmon-user";
    monitorData.userPresets.push(p);
    existingIds.add(p.presetId);
    added++;
  }

  return { success: true, added, skipped, errors };
}

