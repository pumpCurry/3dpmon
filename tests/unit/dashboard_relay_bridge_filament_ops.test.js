/**
 * @fileoverview 親側リレーブリッジのフィラメント操作 RPC ハンドラ回帰テスト
 *
 * サテライトから relay-filament で届く各 action が、親側で正しい実関数へ
 * ディスパッチされることを検証する（switch がホワイトリストを兼ねる）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.hoisted(() => {
  globalThis.window = globalThis.window || {};
});

vi.mock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: {
    machines: {},
    filamentSpools: [],
    hostSpoolMap: {},
    mountHistory: [],
    appSettings: { connectionTargets: [] },
  },
  PLACEHOLDER_HOSTNAME: "_$_NO_MACHINE_$_",
}));
vi.mock("../../3dp_lib/dashboard_connection.js", () => ({
  sendCommand: vi.fn(),
  getHttpPort: vi.fn(() => 80),
}));
vi.mock("../../3dp_lib/dashboard_spool.js", () => ({
  setCurrentSpoolId: vi.fn(() => true),
  addSpool: vi.fn(() => ({ id: "NEW" })),
  addSpoolFromPreset: vi.fn(() => ({ id: "NEW" })),
  mountNewSpoolFromPreset: vi.fn(() => ({ ok: true, spool: { id: "NEW" }, relayed: false })),
  updateSpool: vi.fn(),
  deleteSpool: vi.fn(),
  restoreSpool: vi.fn(),
  confirmInferredSpool: vi.fn(() => ({ id: "INF" })),
  revertInferredSpool: vi.fn(() => null),
}));
vi.mock("../../3dp_lib/dashboard_filament_ledger.js", () => ({
  resolveFilamentEvent: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_filament_inventory.js", () => ({
  setInventoryQuantity: vi.fn(),
  adjustInventory: vi.fn(),
  setMinStockAlert: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_filament_presets.js", () => ({
  togglePresetVisibility: vi.fn(),
  toggleBrandVisibility: vi.fn(),
  togglePresetFavorite: vi.fn(),
  addUserPreset: vi.fn(() => ({ success: true })),
  updateUserPreset: vi.fn(() => ({ success: true })),
  deleteUserPreset: vi.fn(() => ({ success: true })),
  importUserPresets: vi.fn(() => ({ success: true, added: 1, skipped: 0, errors: [] })),
  getAllPresets: vi.fn(() => [{ presetId: "p1", name: "PLA" }]),
}));
vi.mock("../../3dp_lib/dashboard_storage.js", () => ({
  saveUnifiedStorage: vi.fn(),
}));

const { handleRelayFilamentAction } = await import("../../3dp_lib/dashboard_relay_bridge.js");
const spool = await import("../../3dp_lib/dashboard_spool.js");
const ledger = await import("../../3dp_lib/dashboard_filament_ledger.js");
const inventory = await import("../../3dp_lib/dashboard_filament_inventory.js");
const presets = await import("../../3dp_lib/dashboard_filament_presets.js");
const { saveUnifiedStorage } = await import("../../3dp_lib/dashboard_storage.js");

const RESOLVED_PRESET = { presetId: "p1", name: "PLA" };

const PRESET = { presetId: "p1", name: "PLA" };

describe("handleRelayFilamentAction — 親側 RPC ディスパッチ", () => {
  beforeEach(() => vi.clearAllMocks());

  it("mount → setCurrentSpoolId + 保存", async () => {
    await handleRelayFilamentAction("mount", { spoolId: "A", hostname: "h1" });
    expect(spool.setCurrentSpoolId).toHaveBeenCalledWith("A", "h1");
    expect(saveUnifiedStorage).toHaveBeenCalled();
  });

  it("unmount → setCurrentSpoolId(null) + 保存", async () => {
    await handleRelayFilamentAction("unmount", { hostname: "h1" });
    expect(spool.setCurrentSpoolId).toHaveBeenCalledWith(null, "h1");
    expect(saveUnifiedStorage).toHaveBeenCalled();
  });

  it("addSpoolFromPreset → presetId を親の正本(getAllPresets)から解決して開封", async () => {
    await handleRelayFilamentAction("addSpoolFromPreset", { presetId: "p1", override: { note: "n" } });
    expect(presets.getAllPresets).toHaveBeenCalled();
    expect(spool.addSpoolFromPreset).toHaveBeenCalledWith(RESOLVED_PRESET, { note: "n" });
  });

  it("addSpoolFromPreset → presetId 未解決なら開封しない（孤児生成防止）", async () => {
    presets.getAllPresets.mockReturnValueOnce([]);
    await handleRelayFilamentAction("addSpoolFromPreset", { presetId: "nope", override: {} });
    expect(spool.addSpoolFromPreset).not.toHaveBeenCalled();
  });

  it("addSpoolFromPreset → 旧クライアント本体でも presetId が正本にあれば正本へ置換して受理", async () => {
    await handleRelayFilamentAction("addSpoolFromPreset", { preset: PRESET, override: {} });
    expect(spool.addSpoolFromPreset).toHaveBeenCalledWith(RESOLVED_PRESET, {});
  });

  it("addSpoolFromPreset → 未登録 presetId の本体は受理しない（孤児化防止 #5）", async () => {
    presets.getAllPresets.mockReturnValueOnce([{ presetId: "p1", name: "PLA" }]);
    await handleRelayFilamentAction("addSpoolFromPreset", { preset: { presetId: "orphan", name: "X" } });
    expect(spool.addSpoolFromPreset).not.toHaveBeenCalled();
  });

  it("mountNewSpoolFromPreset → presetId 解決 + 装着の複合操作", async () => {
    await handleRelayFilamentAction("mountNewSpoolFromPreset", { presetId: "p1", override: {}, hostname: "h1" });
    expect(spool.mountNewSpoolFromPreset).toHaveBeenCalledWith(RESOLVED_PRESET, {}, "h1");
  });

  it("updateSpool / deleteSpool / restoreSpool / confirmInferredSpool / revertInferredSpool", async () => {
    await handleRelayFilamentAction("updateSpool", { id: "A", patch: { remainingLengthMm: 1 } });
    expect(spool.updateSpool).toHaveBeenCalledWith("A", { remainingLengthMm: 1 });

    await handleRelayFilamentAction("deleteSpool", { id: "A", hostname: "h1" });
    expect(spool.deleteSpool).toHaveBeenCalledWith("A", "h1");

    await handleRelayFilamentAction("restoreSpool", { id: "A" });
    expect(spool.restoreSpool).toHaveBeenCalledWith("A");

    await handleRelayFilamentAction("confirmInferredSpool", { id: "I" });
    expect(spool.confirmInferredSpool).toHaveBeenCalledWith("I");

    await handleRelayFilamentAction("revertInferredSpool", { id: "I" });
    expect(spool.revertInferredSpool).toHaveBeenCalledWith("I");
  });

  it("addSpool → 親で新規登録（採番は親側）", async () => {
    await handleRelayFilamentAction("addSpool", { data: { name: "x" }, inferred: false });
    expect(spool.addSpool).toHaveBeenCalledWith({ name: "x" }, { inferred: false });
    expect(saveUnifiedStorage).toHaveBeenCalled();
  });

  it("resolveFilamentEvent → 親で切れ文脈を解決(evId照合付き) + 保存", async () => {
    await handleRelayFilamentAction("resolveFilamentEvent", { host: "h1", resolution: "reseat", evId: "fctx_h1_100" });
    expect(ledger.resolveFilamentEvent).toHaveBeenCalledWith("h1", "reseat", { expectedEvId: "fctx_h1_100" });
    expect(saveUnifiedStorage).toHaveBeenCalled();
  });

  it("opId 重複排除: 同一 opId の非冪等操作は2回目を実行しない (#1)", async () => {
    await handleRelayFilamentAction("addSpool", { data: { name: "x" }, _opId: "op-1" });
    await handleRelayFilamentAction("addSpool", { data: { name: "x" }, _opId: "op-1" }); // 再配信
    expect(spool.addSpool).toHaveBeenCalledTimes(1); // 2回目は無視
  });

  it("opId 無し/異なる opId は通常どおり実行される (#1)", async () => {
    await handleRelayFilamentAction("addSpool", { data: { name: "a" }, _opId: "op-2" });
    await handleRelayFilamentAction("addSpool", { data: { name: "b" }, _opId: "op-3" });
    expect(spool.addSpool).toHaveBeenCalledTimes(2);
  });

  it("同一 opId で異なる payload は実行しない (#2)", async () => {
    await handleRelayFilamentAction("addSpool", { data: { name: "a" }, _opId: "dup" });
    await handleRelayFilamentAction("addSpool", { data: { name: "DIFFERENT" }, _opId: "dup" });
    expect(spool.addSpool).toHaveBeenCalledTimes(1);
    expect(spool.addSpool).toHaveBeenCalledWith({ name: "a" }, { inferred: false });
  });

  it("importUserPresets も opId 重複排除の対象 (#3)", async () => {
    await handleRelayFilamentAction("importUserPresets", { jsonStr: '{"presets":[]}', opts: {}, _opId: "imp-1" });
    await handleRelayFilamentAction("importUserPresets", { jsonStr: '{"presets":[]}', opts: {}, _opId: "imp-1" });
    expect(presets.importUserPresets).toHaveBeenCalledTimes(1);
  });

  it("resolveFilamentEvent → evId 欠落のリレー解決は拒否 (#5)", async () => {
    await handleRelayFilamentAction("resolveFilamentEvent", { host: "h1", resolution: "reseat" });
    expect(ledger.resolveFilamentEvent).not.toHaveBeenCalled();
  });

  it("在庫 RPC（setInventoryQuantity / adjustInventory / setMinStockAlert）", async () => {
    await handleRelayFilamentAction("setInventoryQuantity", { modelId: "m", quantity: 3 });
    expect(inventory.setInventoryQuantity).toHaveBeenCalledWith("m", 3);
    await handleRelayFilamentAction("adjustInventory", { modelId: "m", delta: -1 });
    expect(inventory.adjustInventory).toHaveBeenCalledWith("m", -1);
    await handleRelayFilamentAction("setMinStockAlert", { modelId: "m", threshold: 2 });
    expect(inventory.setMinStockAlert).toHaveBeenCalledWith("m", 2);
  });

  it("プリセット RPC（表示/お気に入り/追加/更新/削除）+ 保存", async () => {
    await handleRelayFilamentAction("togglePresetVisibility", { presetId: "p" });
    expect(presets.togglePresetVisibility).toHaveBeenCalledWith("p");
    await handleRelayFilamentAction("toggleBrandVisibility", { brand: "B" });
    expect(presets.toggleBrandVisibility).toHaveBeenCalledWith("B");
    await handleRelayFilamentAction("togglePresetFavorite", { presetId: "p" });
    expect(presets.togglePresetFavorite).toHaveBeenCalledWith("p");
    await handleRelayFilamentAction("addUserPreset", { data: { brand: "B" } });
    expect(presets.addUserPreset).toHaveBeenCalledWith({ brand: "B" });
    await handleRelayFilamentAction("updateUserPreset", { presetId: "user-1", changes: { color: "#fff" } });
    expect(presets.updateUserPreset).toHaveBeenCalledWith("user-1", { color: "#fff" });
    await handleRelayFilamentAction("deleteUserPreset", { presetId: "user-1" });
    expect(presets.deleteUserPreset).toHaveBeenCalledWith("user-1");
    await handleRelayFilamentAction("importUserPresets", { jsonStr: '{"presets":[]}', opts: { merge: true } });
    expect(presets.importUserPresets).toHaveBeenCalledWith('{"presets":[]}', { merge: true });
    expect(saveUnifiedStorage).toHaveBeenCalled();
  });

  it("不正ペイロードは実行しない（mount: spoolId/hostname 欠落）", async () => {
    await handleRelayFilamentAction("mount", { spoolId: "A" });          // hostname なし
    await handleRelayFilamentAction("mount", { hostname: "h1" });        // spoolId なし
    await handleRelayFilamentAction("updateSpool", { id: "A" });         // patch なし
    await handleRelayFilamentAction("mountNewSpoolFromPreset", { preset: PRESET }); // hostname なし
    expect(spool.setCurrentSpoolId).not.toHaveBeenCalled();
    expect(spool.updateSpool).not.toHaveBeenCalled();
    expect(spool.mountNewSpoolFromPreset).not.toHaveBeenCalled();
  });

  it("未知 action は無視される（ホワイトリスト）", async () => {
    await handleRelayFilamentAction("formatHardDisk", { id: "A" });
    expect(spool.setCurrentSpoolId).not.toHaveBeenCalled();
    expect(spool.updateSpool).not.toHaveBeenCalled();
    expect(spool.deleteSpool).not.toHaveBeenCalled();
  });

  it("実行中の例外はログのみで解決する（リレーを落とさない）", async () => {
    spool.updateSpool.mockImplementation(() => { throw new Error("boom"); });
    await expect(
      handleRelayFilamentAction("updateSpool", { id: "A", patch: { x: 1 } })
    ).resolves.toBeUndefined();
  });
});
