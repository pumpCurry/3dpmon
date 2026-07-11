/**
 * @fileoverview dashboard_filament_view.js の警告表示と回転API回帰テスト
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFilamentPreview } from "../../3dp_lib/dashboard_filament_view.js";

function baseOptions() {
  return {
    filamentDiameter: 1.75,
    filamentTotalLength: 330000,
    filamentCurrentLength: 120000,
    filamentColor: "#22C55E",
    reelOuterDiameter: 200,
    reelThickness: 68,
    reelWindingInnerDiameter: 95,
    reelCenterHoleDiameter: 54,
    showSlider: false,
    showResetButton: false,
    showProfileViewButton: false,
    showSideViewButton: false,
    showFrontViewButton: false,
    showAutoRotateButton: false,
    showInfoLength: false,
    showInfoPercent: false,
    showInfoLayers: false,
    showOverlayLength: false,
    showOverlayPercent: false,
    showOverlayBar: false,
    enableDrag: false
  };
}

function createMount() {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  return mount;
}

let rafQueue;

beforeEach(() => {
  rafQueue = [];
  vi.stubGlobal("requestAnimationFrame", (cb) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (id) => {
    rafQueue[id - 1] = null;
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("createFilamentPreview 警告表示", () => {
  it("missing状態は有限pulse後も静的警告を残し、同一状態redrawではpulseを再開しない", () => {
    const preview = createFilamentPreview(createMount(), baseOptions());
    preview.setState({ isFilamentPresent: false, showUsedUpIndicator: true });

    const slash = document.querySelector(".slash");
    const light = document.querySelector(".light");
    expect(slash.classList.contains("dfv-alert-slash")).toBe(true);
    expect(light.classList.contains("dfv-alert-light")).toBe(true);
    expect(slash.classList.contains("dfv-alert-pulse")).toBe(true);

    slash.dispatchEvent(new Event("animationend"));
    light.dispatchEvent(new Event("animationend"));
    expect(slash.classList.contains("dfv-alert-pulse")).toBe(false);
    expect(slash.classList.contains("dfv-alert-slash")).toBe(true);

    preview.setState({ isFilamentPresent: false, showUsedUpIndicator: true });
    expect(slash.classList.contains("dfv-alert-pulse")).toBe(false);
  });

  it("reduced-motion時はpulseを付けず、静的警告だけを表示する", () => {
    window.matchMedia = vi.fn(() => ({ matches: true }));
    const preview = createFilamentPreview(createMount(), baseOptions());
    preview.setState({ isFilamentPresent: false, showUsedUpIndicator: true });

    const slash = document.querySelector(".slash");
    expect(slash.classList.contains("dfv-alert-slash")).toBe(true);
    expect(slash.classList.contains("dfv-alert-pulse")).toBe(false);
  });
});

describe("createFilamentPreview 回転API", () => {
  it("フッターが呼ぶ回転APIを公開し、固定ビューはtransformだけを更新する", () => {
    const preview = createFilamentPreview(createMount(), baseOptions());
    const scene = document.querySelector(".dfv-scene");
    const before = scene.style.transform;

    expect(typeof preview.toggleAutoRotate).toBe("function");
    expect(typeof preview.setFrontView).toBe("function");
    expect(typeof preview.setSideView).toBe("function");
    expect(typeof preview.setProfileView).toBe("function");
    expect(typeof preview.destroy).toBe("function");

    preview.setFrontView();
    expect(scene.style.transform).not.toBe(before);
  });

  it("自動回転はdestroyで停止し、destroy後に再起動しない", () => {
    const preview = createFilamentPreview(createMount(), baseOptions());
    expect(preview.startAutoRotate()).toBe(true);
    expect(preview.isAutoRotating()).toBe(true);
    expect(rafQueue.filter(Boolean).length).toBe(1);

    preview.destroy();
    expect(preview.isAutoRotating()).toBe(false);
    expect(rafQueue.filter(Boolean).length).toBe(0);
    expect(preview.startAutoRotate()).toBe(false);
  });
});
