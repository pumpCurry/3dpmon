/**
 * @fileoverview リレー子（satellite）でのスプール操作 RPC 委譲ガードの回帰テスト
 *
 * バグ: 旧実装ではサテライトのフィラメント操作（装着/取外し/追加/編集/削除等）が
 * すべてローカル状態だけを書き換え、親には一切届かなかった（sendRelayFilament は
 * 定義のみで呼び出し元ゼロのデッドコード）。その結果、
 *   (a) サテライトの操作が「見かけだけのUIモック」になる
 *   (b) サテライトローカルの台帳・serialNo カウンタが親と分岐し表示が乖離する
 *
 * 修正: dashboard_spool.js の各変更系関数がリレー子では sendRelayFilament で
 * 親へ RPC 委譲し、ローカル状態を一切変更しない。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.hoisted(() => {
  globalThis.window = globalThis.window || {};
});

const mockMonitorData = {
  machines: {},
  filamentSpools: [],
  usageHistory: [],
  mountHistory: [],
  hostSpoolMap: {},
  filamentEventContext: {},
  spoolSerialCounter: 0,
};

vi.mock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: mockMonitorData,
  setStoredDataForHost: vi.fn(),
  PLACEHOLDER_HOSTNAME: "_$_NO_MACHINE_$_",
}));
vi.mock("../../3dp_lib/dashboard_storage.js", () => ({
  saveUnifiedStorage: vi.fn(),
  trimUsageHistory: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_filament_inventory.js", () => ({ consumeInventory: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_ui.js", () => ({ updateStoredDataToDOM: vi.fn() }));
vi.mock("../../3dp_lib/dashboard_printmanager.js", () => ({
  updateHistoryList: vi.fn(),
  loadHistory: vi.fn(() => []),
  saveHistory: vi.fn(),
}));
vi.mock("../../3dp_lib/dashboard_connection.js", () => ({ getDisplayBaseUrl: vi.fn(() => "http://t") }));
// ★ リレー送信のスパイ（これが呼ばれること = 親へ委譲されたこと）
vi.mock("../../3dp_lib/dashboard_client_sync.js", () => ({
  sendRelayFilament: vi.fn(() => true),
}));

const {
  setCurrentSpoolId,
  addSpool,
  addSpoolFromPreset,
  mountNewSpoolFromPreset,
  updateSpool,
  deleteSpool,
  restoreSpool,
  confirmInferredSpool,
  revertInferredSpool,
} = await import("../../3dp_lib/dashboard_spool.js");
const { sendRelayFilament } = await import("../../3dp_lib/dashboard_client_sync.js");
const { consumeInventory } = await import("../../3dp_lib/dashboard_filament_inventory.js");

/** テスト共通リセット */
function reset() {
  mockMonitorData.machines = {};
  mockMonitorData.filamentSpools = [];
  mockMonitorData.usageHistory = [];
  mockMonitorData.mountHistory = [];
  mockMonitorData.hostSpoolMap = {};
  mockMonitorData.filamentEventContext = {};
  mockMonitorData.spoolSerialCounter = 0;
  vi.clearAllMocks();
  sendRelayFilament.mockReturnValue(true);
}

const PRESET = {
  presetId: "preset-x", name: "TestPLA", brand: "TB", color: "#fff",
  colorName: "White", material: "PLA", defaultLength: 330000,
};

describe("リレー子（window._3dpmonRelayChild=true）でのスプール操作", () => {
  beforeEach(() => {
    reset();
    window._3dpmonRelayChild = true;
  });

  it("setCurrentSpoolId: mount は RPC 委譲のみでローカル状態を変更しない", () => {
    mockMonitorData.filamentSpools.push({ id: "A", isActive: false, hostname: null });
    const ok = setCurrentSpoolId("A", "h1");
    expect(ok).toBe(true);
    expect(sendRelayFilament).toHaveBeenCalledWith("mount", { spoolId: "A", hostname: "h1" });
    // ローカルは未変更（親からの relay-delta 還流で反映される）
    expect(mockMonitorData.hostSpoolMap.h1).toBeUndefined();
    expect(mockMonitorData.filamentSpools[0].isActive).toBe(false);
    expect(mockMonitorData.mountHistory).toEqual([]);
  });

  it("setCurrentSpoolId: unmount は RPC 委譲される", () => {
    const ok = setCurrentSpoolId(null, "h1");
    expect(ok).toBe(true);
    expect(sendRelayFilament).toHaveBeenCalledWith("unmount", { hostname: "h1" });
  });

  it("setCurrentSpoolId: 他ホスト装着済みはローカル検査で即 false（RPC しない）", () => {
    mockMonitorData.filamentSpools.push({ id: "A" });
    mockMonitorData.hostSpoolMap.h2 = "A"; // 別ホストに装着中（同期済みデータ）
    const ok = setCurrentSpoolId("A", "h1");
    expect(ok).toBe(false);
    expect(sendRelayFilament).not.toHaveBeenCalled();
  });

  it("addSpoolFromPreset: RPC 委譲し null を返す（serialNo/在庫を子で消費しない）", () => {
    const sp = addSpoolFromPreset(PRESET);
    expect(sp).toBeNull();
    expect(sendRelayFilament).toHaveBeenCalledWith("addSpoolFromPreset", { preset: PRESET, override: {} });
    expect(mockMonitorData.filamentSpools.length).toBe(0);
    expect(mockMonitorData.spoolSerialCounter).toBe(0);
    expect(consumeInventory).not.toHaveBeenCalled();
  });

  it("mountNewSpoolFromPreset: 開封+装着を 1 RPC で委譲する", () => {
    const r = mountNewSpoolFromPreset(PRESET, {}, "h1");
    expect(r).toEqual({ ok: true, spool: null, relayed: true });
    expect(sendRelayFilament).toHaveBeenCalledWith("mountNewSpoolFromPreset", {
      preset: PRESET, override: {}, hostname: "h1",
    });
    expect(mockMonitorData.filamentSpools.length).toBe(0);
  });

  it("updateSpool: RPC 委譲のみでローカルパッチしない", () => {
    mockMonitorData.filamentSpools.push({ id: "A", remainingLengthMm: 1000 });
    updateSpool("A", { remainingLengthMm: 5000 });
    expect(sendRelayFilament).toHaveBeenCalledWith("updateSpool", { id: "A", patch: { remainingLengthMm: 5000 } });
    expect(mockMonitorData.filamentSpools[0].remainingLengthMm).toBe(1000);
  });

  it("deleteSpool / restoreSpool: RPC 委譲のみ", () => {
    mockMonitorData.filamentSpools.push({ id: "A", deleted: false });
    deleteSpool("A", "h1");
    expect(sendRelayFilament).toHaveBeenCalledWith("deleteSpool", { id: "A", hostname: "h1" });
    expect(mockMonitorData.filamentSpools[0].deleted).toBe(false);

    restoreSpool("A");
    expect(sendRelayFilament).toHaveBeenCalledWith("restoreSpool", { id: "A" });
  });

  it("confirmInferredSpool / revertInferredSpool: RPC 委譲し null を返す", () => {
    mockMonitorData.filamentSpools.push({ id: "INF", inferred: true });
    expect(confirmInferredSpool("INF")).toBeNull();
    expect(sendRelayFilament).toHaveBeenCalledWith("confirmInferredSpool", { id: "INF" });
    expect(mockMonitorData.filamentSpools[0].inferred).toBe(true);
    expect(mockMonitorData.spoolSerialCounter).toBe(0);

    expect(revertInferredSpool("INF")).toBeNull();
    expect(sendRelayFilament).toHaveBeenCalledWith("revertInferredSpool", { id: "INF" });
  });

  it("リレー未接続（sendRelayFilament=false）なら setCurrentSpoolId は false", () => {
    sendRelayFilament.mockReturnValue(false);
    mockMonitorData.filamentSpools.push({ id: "A" });
    expect(setCurrentSpoolId("A", "h1")).toBe(false);
  });
});

describe("親/スタンドアロン（フラグなし）では従来のローカル実行", () => {
  beforeEach(() => {
    reset();
    delete window._3dpmonRelayChild;
  });

  it("updateSpool はローカルへパッチを適用し RPC しない", () => {
    mockMonitorData.filamentSpools.push({ id: "A", remainingLengthMm: 1000 });
    updateSpool("A", { remainingLengthMm: 5000 });
    expect(sendRelayFilament).not.toHaveBeenCalled();
    expect(mockMonitorData.filamentSpools[0].remainingLengthMm).toBe(5000);
  });

  it("addSpool はローカルに生成し serialNo を採番する", () => {
    const sp = addSpool({ name: "local" });
    expect(sp).toBeTruthy();
    expect(mockMonitorData.filamentSpools.length).toBe(1);
    expect(mockMonitorData.spoolSerialCounter).toBe(1);
    expect(sendRelayFilament).not.toHaveBeenCalled();
  });

  it("mountNewSpoolFromPreset はローカルで開封+装着まで行う", () => {
    const r = mountNewSpoolFromPreset(PRESET, {}, "h1");
    expect(r.relayed).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.spool).toBeTruthy();
    expect(mockMonitorData.hostSpoolMap.h1).toBe(r.spool.id);
    expect(sendRelayFilament).not.toHaveBeenCalled();
  });
});
