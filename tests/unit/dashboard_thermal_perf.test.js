/**
 * @fileoverview 温度セルの定常負荷対策（transition廃止＋同一論理色の再代入抑止）
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("thermal-cell performance guard (CSS)", () => {
  it(".thermal-cell に350ms color transitionを残さない", () => {
    const cssPath = path.resolve("3dp_monitor.css");
    const css = fs.readFileSync(cssPath, "utf8");
    const match = css.match(/\.thermal-cell\s*\{[^}]*\}/m);

    expect(match, ".thermal-cell rule should exist").not.toBeNull();
    expect(match[0]).toContain("transition: none");
    expect(match[0]).not.toMatch(/\.35s|350ms|background-color\s+\.35s|color\s+\.35s/);
  });
});

// 重い依存を切り離して _paintThermalCurrent(純DOM関数)だけ検証する
vi.mock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: { machines: {}, appSettings: {} },
  PLACEHOLDER_HOSTNAME: "_$_NO_MACHINE_$_",
  scopedById: vi.fn(),
  getDisplayValue: vi.fn(),
  consumeDirtyKeysForHost: vi.fn(() => []),
  getHostsWithDirtyKeys: vi.fn(() => []),
}));

const { _paintThermalCurrent } = await import("../../3dp_lib/dashboard_ui.js");

describe("_paintThermalCurrent — 同一論理色の再代入抑止 (dedup)", () => {
  it("同じ論理色を連続適用したら style を書き換えない", () => {
    const el = document.createElement("div");
    _paintThermalCurrent(el, { bg: "rgb(255, 0, 0)", fg: "rgb(255, 255, 255)" });
    expect(el.style.backgroundColor).toBe("rgb(255, 0, 0)");
    expect(el.dataset.thermalBg).toBe("rgb(255, 0, 0)");

    // 外部から style を書き換えておき、同一論理色の再適用で「書き換えられない」ことを確認
    el.style.backgroundColor = "rgb(1, 2, 3)";
    el.style.color = "rgb(4, 5, 6)";
    _paintThermalCurrent(el, { bg: "rgb(255, 0, 0)", fg: "rgb(255, 255, 255)" });
    expect(el.style.backgroundColor, "同一論理色は再代入されない").toBe("rgb(1, 2, 3)");
    expect(el.style.color).toBe("rgb(4, 5, 6)");
  });

  it("論理色が変わったときだけ style を更新する", () => {
    const el = document.createElement("div");
    _paintThermalCurrent(el, { bg: "rgb(255, 0, 0)", fg: "rgb(0, 0, 0)" });
    el.style.backgroundColor = "rgb(1, 2, 3)"; // 外部改変
    _paintThermalCurrent(el, { bg: "rgb(0, 128, 0)", fg: "rgb(0, 0, 0)" });
    expect(el.style.backgroundColor).toBe("rgb(0, 128, 0)");
    expect(el.dataset.thermalBg).toBe("rgb(0, 128, 0)");
  });

  it("style=null（解除）で色をクリアする", () => {
    const el = document.createElement("div");
    _paintThermalCurrent(el, { bg: "rgb(255, 0, 0)", fg: "rgb(0, 0, 0)" });
    _paintThermalCurrent(el, null);
    expect(el.style.backgroundColor).toBe("");
    expect(el.style.color).toBe("");
  });

  it("thermal-cell クラスが付与される", () => {
    const el = document.createElement("div");
    _paintThermalCurrent(el, { bg: "rgb(1, 1, 1)", fg: "rgb(2, 2, 2)" });
    expect(el.classList.contains("thermal-cell")).toBe(true);
  });
});
