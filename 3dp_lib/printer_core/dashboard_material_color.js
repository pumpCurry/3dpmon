/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 material color 正規化モジュール
 * @file dashboard_material_color.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_color
 *
 * 【機能内容サマリ】
 * - Creality K2/CFS の `#0RRGGBB` を含むmaterial color表現を一元的に正規化
 * - protocol evidence、比較用値、CSS表示値を分離した MaterialColor value object を生成
 * - UI/command/confirmation層が7桁HEXの意味を個別解釈しないためのhelperを提供
 *
 * 【公開関数一覧】
 * - {@link normalizeMaterialColor}：protocol色値を MaterialColor object へ正規化
 * - {@link getMaterialCssColor}：MaterialColorからCSSで安全に使える色値を取得
 * - {@link getMaterialProtocolColor}：MaterialColorからprotocol送信用の色証跡を取得
 * - {@link getComparableMaterialColor}：MaterialColorから比較用6桁色を取得
 *
 * @version 1.390.1420 (PR #434)
 * @since   1.390.1420 (PR #434)
 * @lastModified 2026-08-27 12:22:38
 * -----------------------------------------------------------
 * @todo
 * - 実機captureで `modifyMaterial` の送信色が `#0RRGGBB` 固定か確認する
 */

"use strict";

/**
 * material color の正規化結果。
 *
 * 【詳細説明】
 * - `raw` は機器・スライサ・fixtureから来た元値を証跡として保持する。
 * - `normalized` は `#` を除いた小文字表現で、K2/CFSの `0RRGGBB` 形式も保持する。
 * - `displayHex` / `cssColor` はUI表示専用で、CSSへ直接渡せる6桁RGBへ制限する。
 *
 * @typedef {Object} MaterialColor
 * @property {?string} raw - 元のprotocol/UI入力値。
 * @property {?string} normalized - `#` を除去し小文字化したprotocol証跡。
 * @property {?string} displayHex - UI表示用6桁HEX。表示不能な場合は正規化文字列または空値。
 * @property {?string} cssColor - CSSへ安全に渡せる `#RRGGBB`。表示不能な場合は null。
 * @property {string} format - 判定した色形式。
 * @property {?boolean} valid - 表示色として安全に解釈できる場合 true、不正値は false、未観測は null。
 * @property {Object} provenance - 色値の由来情報。
 * @property {string} provenance.source - 正規化元のprotocol/UI境界。
 * @property {string} provenance.vendor - vendor名または `unknown`。
 */

/**
 * 任意値を空値を保持した文字列へ変換する。
 *
 * 【詳細説明】
 * - null/undefined は未観測として null を返す。
 * - 空文字は「観測されたが空」として空文字のまま保持する。
 *
 * @private
 * @function toNullableMaterialColorString
 * @param {*} value - 文字列候補。
 * @returns {?string} 文字列、または null。
 */
function toNullableMaterialColorString(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value).trim();
}

/**
 * MaterialColorらしいobjectからraw候補を取り出す。
 *
 * 【詳細説明】
 * - 既に正規化済みの値を再正規化する場合は `raw` を最優先にしてprotocol証跡を保つ。
 * - rawがない古いfixtureやUI入力では `normalized` / `displayHex` / `cssColor` へ順にfallbackする。
 *
 * @private
 * @function pickMaterialColorRawValue
 * @param {*} value - 色値候補。
 * @returns {*} raw候補。
 */
function pickMaterialColorRawValue(value) {
  if (!value || typeof value !== "object") {
    return value;
  }
  return value.raw ?? value.normalized ?? value.displayHex ?? value.cssColor ?? null;
}

/**
 * protocol色値を MaterialColor object へ正規化する。
 *
 * 【詳細説明】
 * - K2/CFS firmware は `#09ea7ae` のような `#0RRGGBB` 形式を返すため、
 *   protocol証跡は `09ea7ae` として保持し、UI表示だけ `9ea7ae` へ変換する。
 * - `#RRGGBB` / `RRGGBB` は通常RGBとして扱う。
 * - 不正値は丸めず、CSS色を null にして呼び出し側が「不明」と扱えるようにする。
 *
 * @function normalizeMaterialColor
 * @param {*} value - protocolまたはUI由来の色値。
 * @param {Object=} options - 正規化オプション。
 * @param {string=} options.source - 色値の由来。
 * @param {string=} options.vendor - vendor名。
 * @returns {MaterialColor} 正規化済みmaterial color。
 * @example
 * const color = normalizeMaterialColor("#09ea7ae", { source: "boxsInfo", vendor: "creality" });
 */
export function normalizeMaterialColor(value, options = {}) {
  const raw = toNullableMaterialColorString(pickMaterialColorRawValue(value));
  const provenance = {
    source: String(options.source || "unknown"),
    vendor: String(options.vendor || "unknown"),
  };
  if (raw === null) {
    return {
      raw,
      normalized: null,
      displayHex: null,
      cssColor: null,
      format: "missing",
      valid: null,
      provenance,
    };
  }
  if (raw === "") {
    return {
      raw,
      normalized: "",
      displayHex: "",
      cssColor: null,
      format: "empty",
      valid: null,
      provenance,
    };
  }

  const normalized = raw.replace(/^#/u, "").toLowerCase();
  if (/^0[0-9a-f]{6}$/u.test(normalized)) {
    const displayHex = normalized.slice(1);
    return {
      raw,
      normalized,
      displayHex,
      cssColor: `#${displayHex}`,
      format: "creality-0rrggbb",
      valid: true,
      provenance,
    };
  }
  if (/^[0-9a-f]{6}$/u.test(normalized)) {
    return {
      raw,
      normalized,
      displayHex: normalized,
      cssColor: `#${normalized}`,
      format: "rgb-hex",
      valid: true,
      provenance,
    };
  }
  return {
    raw,
    normalized,
    displayHex: normalized,
    cssColor: null,
    format: "unknown",
    valid: false,
    provenance,
  };
}

/**
 * MaterialColorからCSSで安全に使える色値を取得する。
 *
 * 【詳細説明】
 * - UI側が `#0RRGGBB` や不正値を個別解釈しないよう、この関数だけでCSS化を行う。
 * - 既に `cssColor` を持つobjectでも、最終的に6桁HEXだけを許可する。
 *
 * @function getMaterialCssColor
 * @param {*} color - MaterialColorまたは色値候補。
 * @returns {string|null} CSS `#RRGGBB`、または null。
 * @example
 * const cssColor = getMaterialCssColor(material.color);
 */
export function getMaterialCssColor(color) {
  const normalized = color && typeof color === "object" && color.cssColor
    ? String(color.cssColor).trim()
    : normalizeMaterialColor(color).cssColor;
  return /^#[0-9a-fA-F]{6}$/u.test(normalized) ? normalized : null;
}

/**
 * MaterialColorからprotocol送信用の色証跡を取得する。
 *
 * 【詳細説明】
 * - `colorMatch.list[].color` のようなprinter protocol境界では、UI表示用6桁ではなく
 *   `normalized` に保持した `0RRGGBB` 形式を優先する。
 * - 不正値でも既存挙動との互換性のため非空文字は返し、送信可否は上位のcommand validationに委ねる。
 *
 * @function getMaterialProtocolColor
 * @param {*} color - MaterialColorまたは色値候補。
 * @returns {string|null} `#` なしprotocol色証跡、または null。
 * @example
 * const protocolColor = getMaterialProtocolColor(material.color);
 */
export function getMaterialProtocolColor(color) {
  const materialColor = normalizeMaterialColor(color);
  const text = String(materialColor.normalized ?? "").trim().replace(/^#/u, "");
  return text || null;
}

/**
 * MaterialColorから比較用色を取得する。
 *
 * 【詳細説明】
 * - expected-state confirmationやUI一致判定では、Creality固有の先頭0を表示RGBと同じ6桁へ寄せる。
 * - protocol送信用値とは異なり、`#09ea7ae` と `#9ea7ae` を同じ色として比較する。
 *
 * @function getComparableMaterialColor
 * @param {*} color - MaterialColorまたは色値候補。
 * @returns {string|null} 比較用6桁色、または比較不能な非空normalized値。
 * @example
 * const comparable = getComparableMaterialColor("#09ea7ae");
 */
export function getComparableMaterialColor(color) {
  const materialColor = normalizeMaterialColor(color);
  const text = String(materialColor.displayHex || materialColor.normalized || "").trim().replace(/^#/u, "").toLowerCase();
  return text || null;
}
