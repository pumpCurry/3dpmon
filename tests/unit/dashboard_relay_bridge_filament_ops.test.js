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
  addSpoolFromPreset: vi.fn(() => ({ id: "NEW" })),
  mountNewSpoolFromPreset: vi.fn(() => ({ ok: true, spool: { id: "NEW" }, relayed: false })),
  updateSpool: vi.fn(),
  deleteSpool: vi.fn(),
  restoreSpool: vi.fn(),
  confirmInferredSpool: vi.fn(() => ({ id: "INF" })),
  revertInferredSpool: vi.fn(() => null),
}));
vi.mock("../../3dp_lib/dashboard_storage.js", () => ({
  saveUnifiedStorage: vi.fn(),
}));

const { handleRelayFilamentAction } = await import("../../3dp_lib/dashboard_relay_bridge.js");
const spool = await import("../../3dp_lib/dashboard_spool.js");
const { saveUnifiedStorage } = await import("../../3dp_lib/dashboard_storage.js");

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

  it("addSpoolFromPreset → 親で開封（在庫消費・採番は親側）", async () => {
    await handleRelayFilamentAction("addSpoolFromPreset", { preset: PRESET, override: { note: "n" } });
    expect(spool.addSpoolFromPreset).toHaveBeenCalledWith(PRESET, { note: "n" });
  });

  it("mountNewSpoolFromPreset → 親で開封+装着の複合操作", async () => {
    await handleRelayFilamentAction("mountNewSpoolFromPreset", { preset: PRESET, override: {}, hostname: "h1" });
    expect(spool.mountNewSpoolFromPreset).toHaveBeenCalledWith(PRESET, {}, "h1");
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
