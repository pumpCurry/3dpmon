/**
 * @fileoverview 温度セルの定常transition再発防止ガード
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("thermal-cell performance guard", () => {
  it(".thermal-cell に350ms color transitionを残さない", () => {
    const cssPath = path.resolve("3dp_monitor.css");
    const css = fs.readFileSync(cssPath, "utf8");
    const match = css.match(/\.thermal-cell\s*\{[^}]*\}/m);

    expect(match, ".thermal-cell rule should exist").not.toBeNull();
    expect(match[0]).toContain("transition: none");
    expect(match[0]).not.toMatch(/\.35s|350ms|background-color\s+\.35s|color\s+\.35s/);
  });
});
