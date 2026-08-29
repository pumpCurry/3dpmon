/**
 * @fileoverview カメラ接続スピナーの表示崩れ回帰テスト
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * CSSテキストから指定セレクタのルール本文を取得する。
 *
 * 【詳細説明】
 * - 静的CSSの回帰を検出するための軽量ヘルパー。
 * - セレクタ文字列は正規表現として扱わず、CSS上の完全一致セレクタを対象にする。
 *
 * @function getCssRuleBody
 * @param {string} css - 読み込んだCSS全体。
 * @param {string} selector - 検索するCSSセレクタ。
 * @returns {string|null} - ルール本文。見つからない場合はnull。
 * @example
 * const rule = getCssRuleBody(css, ".camera-connection-spinner");
 */
function getCssRuleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "m"));
  return match ? match[1] : null;
}

describe("camera connection spinner CSS guard", () => {
  it("カメラ接続スピナーは専用クラスで正円寸法を固定する", () => {
    const html = fs.readFileSync(path.resolve("3dp_monitor.html"), "utf8");
    const css = fs.readFileSync(path.resolve("3dp_panel.css"), "utf8");
    const rule = getCssRuleBody(css, ".camera-connection-spinner");

    expect(html).toContain("camera-connection-spinner");
    expect(rule, ".camera-connection-spinner rule should exist").not.toBeNull();
    expect(rule).toMatch(/inline-size:\s*14px/);
    expect(rule).toMatch(/block-size:\s*14px/);
    expect(rule).toMatch(/aspect-ratio:\s*1\s*\/\s*1/);
    expect(rule).toMatch(/flex:\s*0\s+0\s+14px/);
    expect(rule).toMatch(/border-radius:\s*50%/);
    expect(rule).toMatch(/box-sizing:\s*border-box/);
  });
});
