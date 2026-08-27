/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 material color 正規化単体テスト
 * @file printer_core_material_color.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_material_color_test
 *
 * 【機能内容サマリ】
 * - K2/CFS の7桁HEX風colorを MaterialColor object へ正規化できることを検証
 * - protocol送信用、CSS表示用、比較用の色値が混ざらないことを検証
 *
 * 【公開関数一覧】
 * - なし：Vitest による単体テストのみを提供
 *
 * @version 1.390.1420 (PR #434)
 * @since   1.390.1420 (PR #434)
 * @lastModified 2026-08-27 12:22:38
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { describe, expect, it } from "vitest";
import {
  getComparableMaterialColor,
  getMaterialCssColor,
  getMaterialProtocolColor,
  normalizeMaterialColor,
} from "../../3dp_lib/printer_core/dashboard_material_color.js";

describe("dashboard_material_color", () => {
  it("K2/CFSの#0RRGGBB表現はraw/protocol/displayを分離する", () => {
    const color = normalizeMaterialColor("#09ea7ae", {
      source: "boxsInfo.materialBoxs[].materials[].color",
      vendor: "creality",
    });

    expect(color).toMatchObject({
      raw: "#09ea7ae",
      normalized: "09ea7ae",
      displayHex: "9ea7ae",
      cssColor: "#9ea7ae",
      format: "creality-0rrggbb",
      valid: true,
      provenance: {
        source: "boxsInfo.materialBoxs[].materials[].color",
        vendor: "creality",
      },
    });
    expect(getMaterialProtocolColor(color)).toBe("09ea7ae");
    expect(getMaterialCssColor(color)).toBe("#9ea7ae");
    expect(getComparableMaterialColor(color)).toBe("9ea7ae");
  });

  it("通常6桁HEXはprotocol/display/compareで同じRGB値として扱う", () => {
    const color = normalizeMaterialColor("#72A530");

    expect(color).toMatchObject({
      raw: "#72A530",
      normalized: "72a530",
      displayHex: "72a530",
      cssColor: "#72a530",
      format: "rgb-hex",
      valid: true,
    });
    expect(getMaterialProtocolColor(color)).toBe("72a530");
    expect(getMaterialCssColor(color)).toBe("#72a530");
    expect(getComparableMaterialColor(color)).toBe("72a530");
  });

  it("不正色はprotocol証跡を保持しつつCSS色としては使わない", () => {
    const color = normalizeMaterialColor("not-a-color");

    expect(color).toMatchObject({
      raw: "not-a-color",
      normalized: "not-a-color",
      displayHex: "not-a-color",
      cssColor: null,
      format: "unknown",
      valid: false,
    });
    expect(getMaterialProtocolColor(color)).toBe("not-a-color");
    expect(getMaterialCssColor(color)).toBeNull();
    expect(getComparableMaterialColor(color)).toBe("not-a-color");
  });

  it("未観測と空文字を区別して保持する", () => {
    expect(normalizeMaterialColor(null)).toMatchObject({
      raw: null,
      normalized: null,
      displayHex: null,
      cssColor: null,
      format: "missing",
      valid: null,
    });
    expect(normalizeMaterialColor("")).toMatchObject({
      raw: "",
      normalized: "",
      displayHex: "",
      cssColor: null,
      format: "empty",
      valid: null,
    });
  });
});
