/**
 * @fileoverview リレー子（satellite）での在庫・プリセット操作 RPC 委譲ガードの回帰テスト
 *
 * バグ（監査 第2報 P0）: 在庫（setInventoryQuantity/adjustInventory/setMinStockAlert）と
 * カスタムプリセット（表示/お気に入り/追加/更新/削除）は、リレー子でもローカル状態を
 * 直接書き換えるだけで親へ一切届かず、親→子デルタにも含まれていなかった。その結果、
 * 在庫・プリセットが親子で完全に別管理となり乖離していた。
 *
 * 修正: 各変更系関数がリレー子では sendRelayFilament で親へ RPC 委譲し、ローカル状態を
 * 変更しない（結果は relay-delta の filamentInventory/userPresets/... 還流で反映）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.hoisted(() => {
  globalThis.window = globalThis.window || {};
});

const mockMonitorData = {
  filamentInventory: [],
  userPresets: [],
  hiddenPresets: [],
  favoritePresets: [],
};

vi.mock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: mockMonitorData,
}));
vi.mock("../../3dp_lib/dashboard_storage.js", () => ({
  saveUnifiedStorage: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_client_sync.js", () => ({
  sendRelayFilament: vi.fn(() => true),
}));

const inventory = await import("../../3dp_lib/dashboard_filament_inventory.js");
const presets = await import("../../3dp_lib/dashboard_filament_presets.js");
const { sendRelayFilament } = await import("../../3dp_lib/dashboard_client_sync.js");
const { saveUnifiedStorage } = await import("../../3dp_lib/dashboard_storage.js");

function reset() {
  mockMonitorData.filamentInventory = [];
  mockMonitorData.userPresets = [];
  mockMonitorData.hiddenPresets = [];
  mockMonitorData.favoritePresets = [];
  vi.clearAllMocks();
  sendRelayFilament.mockReturnValue(true);
}

const VALID_PRESET = {
  brand: "eSUN", material: "PLA", color: "#fff", colorName: "White", defaultLength: 330000,
};

describe("リレー子: 在庫操作は親へ RPC 委譲（ローカル不変）", () => {
  beforeEach(() => {
    reset();
    window._3dpmonRelayChild = true;
  });

  it("setInventoryQuantity は RPC 委譲しローカル在庫を作らない", () => {
    const q = inventory.setInventoryQuantity("m1", 5);
    expect(q).toBe(5); // 楽観値
    expect(sendRelayFilament).toHaveBeenCalledWith("setInventoryQuantity", { modelId: "m1", quantity: 5 });
    expect(mockMonitorData.filamentInventory.length).toBe(0);
    expect(saveUnifiedStorage).not.toHaveBeenCalled();
  });

  it("adjustInventory は RPC 委譲する（楽観値=現数量+delta）", () => {
    mockMonitorData.filamentInventory.push({ modelId: "m1", quantity: 4 });
    const q = inventory.adjustInventory("m1", -1);
    expect(q).toBe(3);
    expect(sendRelayFilament).toHaveBeenCalledWith("adjustInventory", { modelId: "m1", delta: -1 });
    expect(mockMonitorData.filamentInventory[0].quantity).toBe(4); // ローカル不変
  });

  it("setMinStockAlert は RPC 委譲する", () => {
    inventory.setMinStockAlert("m1", 2);
    expect(sendRelayFilament).toHaveBeenCalledWith("setMinStockAlert", { modelId: "m1", threshold: 2 });
    expect(mockMonitorData.filamentInventory.length).toBe(0);
  });
});

describe("リレー子: プリセット操作は親へ RPC 委譲（ローカル不変）", () => {
  beforeEach(() => {
    reset();
    window._3dpmonRelayChild = true;
  });

  it("togglePresetVisibility は RPC 委譲しローカル hiddenPresets を変更しない", () => {
    presets.togglePresetVisibility("p1");
    expect(sendRelayFilament).toHaveBeenCalledWith("togglePresetVisibility", { presetId: "p1" });
    expect(mockMonitorData.hiddenPresets.length).toBe(0);
  });

  it("togglePresetFavorite は RPC 委譲しローカル favoritePresets を変更しない", () => {
    presets.togglePresetFavorite("p1");
    expect(sendRelayFilament).toHaveBeenCalledWith("togglePresetFavorite", { presetId: "p1" });
    expect(mockMonitorData.favoritePresets.length).toBe(0);
  });

  it("addUserPreset は検証後 RPC 委譲し、ローカル userPresets を作らない", () => {
    const res = presets.addUserPreset(VALID_PRESET);
    expect(res.success).toBe(true);
    expect(sendRelayFilament).toHaveBeenCalledWith("addUserPreset", { data: VALID_PRESET });
    expect(mockMonitorData.userPresets.length).toBe(0);
  });

  it("addUserPreset は無効データなら子側検証で弾き RPC しない", () => {
    const res = presets.addUserPreset({ brand: "x" }); // 必須欠落
    expect(res.success).toBe(false);
    expect(sendRelayFilament).not.toHaveBeenCalled();
  });

  it("updateUserPreset / deleteUserPreset は RPC 委譲しローカルを変更しない", () => {
    mockMonitorData.userPresets.push({ presetId: "user-1", ...VALID_PRESET });
    presets.updateUserPreset("user-1", { colorName: "Black" });
    expect(sendRelayFilament).toHaveBeenCalledWith("updateUserPreset", { presetId: "user-1", changes: { colorName: "Black" } });
    expect(mockMonitorData.userPresets[0].colorName).toBe("White"); // ローカル不変

    presets.deleteUserPreset("user-1");
    expect(sendRelayFilament).toHaveBeenCalledWith("deleteUserPreset", { presetId: "user-1" });
    expect(mockMonitorData.userPresets.length).toBe(1); // ローカル不変
  });

  it("importUserPresets(一括) は生JSONを RPC 委譲し、件数見積りを返しローカルを変更しない (B7)", () => {
    const json = JSON.stringify({ presets: [
      VALID_PRESET,          // valid → added
      { brand: "x" }         // 必須欠落 → skipped
    ] });
    const res = presets.importUserPresets(json, { merge: true });
    expect(res.success).toBe(true);
    expect(res.added).toBe(1);
    expect(res.skipped).toBe(1);
    expect(sendRelayFilament).toHaveBeenCalledWith("importUserPresets", { jsonStr: json, opts: { merge: true } });
    expect(mockMonitorData.userPresets.length).toBe(0); // ローカル不変
  });
});

describe("親/スタンドアロン（フラグなし）ではローカル実行", () => {
  beforeEach(() => {
    reset();
    delete window._3dpmonRelayChild;
  });

  it("setInventoryQuantity はローカル在庫を作り RPC しない", () => {
    inventory.setInventoryQuantity("m1", 5);
    expect(sendRelayFilament).not.toHaveBeenCalled();
    expect(mockMonitorData.filamentInventory[0]).toMatchObject({ modelId: "m1", quantity: 5 });
    expect(saveUnifiedStorage).toHaveBeenCalled();
  });

  it("togglePresetVisibility はローカル hiddenPresets を変更する", () => {
    presets.togglePresetVisibility("p1");
    expect(sendRelayFilament).not.toHaveBeenCalled();
    expect(mockMonitorData.hiddenPresets).toContain("p1");
  });
});
