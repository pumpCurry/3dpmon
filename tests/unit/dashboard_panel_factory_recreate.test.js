/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 パネル再生成永続化テスト モジュール
 * @file dashboard_panel_factory_recreate.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_panel_factory_recreate_test
 *
 * 【機能内容サマリ】
 * - dashboard_panel_factory.js のパネル再生成時レイアウト保存を検証
 * - filament panel の再生成後もフォントサイズが永続化されることを確認
 *
 * 【公開関数一覧】
 * - {@link createGridStackMock}：GridStack の最小モックを生成
 *
 * @version 1.390.1365 (PR #432)
 * @since   1.390.1365 (PR #432)
 * @lastModified 2026-08-09 16:21:02
 * -----------------------------------------------------------
 * @todo
 * - なし
 *
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  saveUnifiedStorage: vi.fn(),
  initializePanel: vi.fn(),
  destroyPanel: vi.fn(),
  monitorData: {
    appSettings: {
      showHostTag: true,
      connectionTargets: [],
      panelLayout: [],
    },
    machines: {},
  },
}));

vi.mock("../../3dp_lib/dashboard_panel_init.js", () => ({
  initializePanel: mockState.initializePanel,
  destroyPanel: mockState.destroyPanel,
}));

vi.mock("../../3dp_lib/dashboard_storage.js", () => ({
  saveUnifiedStorage: mockState.saveUnifiedStorage,
}));

vi.mock("../../3dp_lib/dashboard_data.js", () => ({
  PLACEHOLDER_HOSTNAME: "__placeholder__",
  markAllKeysDirty: vi.fn(),
  monitorData: mockState.monitorData,
}));

vi.mock("../../3dp_lib/dashboard_target_identity.js", () => ({
  extractHost: (value) => value,
}));

vi.mock("../../3dp_lib/dashboard_ui.js", () => ({
  registerFieldElements: vi.fn(),
  unregisterFieldElements: vi.fn(),
}));

/**
 * GridStack の最小モックを生成する。
 *
 * 【詳細説明】
 * - dashboard_panel_factory が使用する addWidget/removeWidget/getGridItems/update/on だけを提供する。
 * - 実DOMへ .grid-stack-item-content を持つ要素を追加し、saveLayout() が実際のDOM属性を読めるようにする。
 * - 本テストでは GridStack の配置計算ではなく、再生成後の保存内容だけを検証する。
 *
 * @function createGridStackMock
 * @param {HTMLElement} container - GridStack アイテムを追加するテスト用コンテナ
 * @returns {{init: Function}} GridStack.init を持つ最小モック
 * @example
 * globalThis.GridStack = createGridStackMock(document.querySelector("#grid"));
 */
function createGridStackMock(container) {
  const items = [];
  let changeHandler = null;
  return {
    init() {
      return {
        addWidget(options) {
          const widget = document.createElement("div");
          widget.className = "grid-stack-item";
          widget.gridstackNode = {
            x: options.x ?? 0,
            y: options.y ?? 0,
            w: options.w ?? 4,
            h: options.h ?? 4,
            id: options.id,
            noMove: false,
            noResize: false,
          };
          const content = document.createElement("div");
          content.className = "grid-stack-item-content";
          widget.appendChild(content);
          container.appendChild(widget);
          items.push(widget);
          return widget;
        },
        removeWidget(widget) {
          const index = items.indexOf(widget);
          if (index >= 0) {
            items.splice(index, 1);
          }
          widget.remove();
        },
        getGridItems() {
          return items.slice();
        },
        update(widget, options) {
          Object.assign(widget.gridstackNode, options);
          if (typeof changeHandler === "function") {
            changeHandler();
          }
        },
        on(eventName, handler) {
          if (eventName === "change") {
            changeHandler = handler;
          }
        },
        enableMove() {},
        enableResize() {},
      };
    },
  };
}

describe("dashboard_panel_factory recreatePanelsForHost", () => {
  beforeEach(() => {
    vi.resetModules();
    mockState.saveUnifiedStorage.mockClear();
    mockState.initializePanel.mockClear();
    mockState.destroyPanel.mockClear();
    mockState.monitorData.appSettings = {
      showHostTag: true,
      connectionTargets: [],
      panelLayout: [],
    };
    mockState.monitorData.machines = {};
    document.body.innerHTML = `
      <div id="grid"></div>
      <template id="panel-tpl-filament">
        <div data-field="filament"></div>
      </template>
    `;
    localStorage.clear();
    globalThis.GridStack = createGridStackMock(document.querySelector("#grid"));
  });

  it("未ロックのカスタムfontSize付きパネルを再生成後に最終保存する", async () => {
    const {
      addPanel,
      initGridStack,
      recreatePanelsForHost,
      setPanelFontSize,
    } = await import("../../3dp_lib/dashboard_panel_factory.js");

    initGridStack("#grid");
    const panelId = addPanel("filament", "K2Pro-69E7", { x: 1, y: 2, w: 12, h: 16 });
    setPanelFontSize(panelId, "14px");

    const recreatedCount = recreatePanelsForHost("filament", "K2Pro-69E7");
    const savedLayout = JSON.parse(localStorage.getItem("3dpmon_panel_layout_v5"));

    expect(recreatedCount).toBe(1);
    expect(savedLayout).toHaveLength(1);
    expect(savedLayout[0]).toMatchObject({
      panelId: "filament:K2Pro-69E7",
      panelType: "filament",
      host: "K2Pro-69E7",
      x: 1,
      y: 2,
      w: 12,
      h: 16,
      locked: false,
      fontSize: "14px",
    });
    expect(mockState.monitorData.appSettings.panelLayout[0].fontSize).toBe("14px");
  });
});
