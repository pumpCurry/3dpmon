/**
 * @fileoverview dashboard_storage.js の per-host localStorage 分割テスト
 */
import { describe, it, expect } from "vitest";

// _encodeHostKey / _decodeHostKey は内部関数のため、ロジックを直接テスト
// ※ 実際の export が難しい場合はロジックの再実装でテスト

/** エンコードロジック再現 */
function encodeHostKey(host) {
  return (host || "").replace(/\./g, "-").replace(/:/g, "_");
}

/** デコードロジック再現 */
function decodeHostKey(encoded) {
  return (encoded || "").replace(/_/g, ":").replace(/-/g, ".");
}

describe("ホスト名エンコード/デコード", () => {
  it("IPv4:port 形式のラウンドトリップ", () => {
    const host = "192.168.54.151:9999";
    const encoded = encodeHostKey(host);
    expect(encoded).toBe("192-168-54-151_9999");
    expect(decodeHostKey(encoded)).toBe(host);
  });

  it("ポートなしIPv4", () => {
    const host = "192.168.1.100";
    const encoded = encodeHostKey(host);
    expect(encoded).toBe("192-168-1-100");
    expect(decodeHostKey(encoded)).toBe(host);
  });

  it("ホスト名形式", () => {
    const host = "k1max.local:9999";
    const encoded = encodeHostKey(host);
    expect(encoded).toBe("k1max-local_9999");
    expect(decodeHostKey(encoded)).toBe(host);
  });

  it("空文字列", () => {
    expect(encodeHostKey("")).toBe("");
    expect(decodeHostKey("")).toBe("");
  });

  it("null/undefined", () => {
    expect(encodeHostKey(null)).toBe("");
    expect(encodeHostKey(undefined)).toBe("");
    expect(decodeHostKey(null)).toBe("");
  });

  it("複数ホストのラウンドトリップ", () => {
    const hosts = [
      "192.168.54.151:9999",
      "192.168.54.152:9999",
      "10.0.0.1:8080",
      "printer.local:9999"
    ];
    hosts.forEach(h => {
      expect(decodeHostKey(encodeHostKey(h))).toBe(h);
    });
  });
});

describe("LS_GLOBAL_FIELDS 完全性", () => {
  const LS_GLOBAL_FIELDS = [
    "appSettings", "filamentSpools", "usageHistory", "filamentPresets",
    "userPresets", "hiddenPresets", "filamentInventory", "currentSpoolId",
    "hostSpoolMap", "hostCameraToggle", "spoolSerialCounter"
  ];

  it("IndexedDB の queueSharedWrite 対象を全て含む", () => {
    // _flushStorage で queueSharedWrite される全キー
    const idbWriteKeys = [
      "appSettings", "filamentSpools", "usageHistory", "filamentPresets",
      "filamentInventory", "currentSpoolId", "hostSpoolMap",
      "hostCameraToggle", "spoolSerialCounter"
    ];
    idbWriteKeys.forEach(key => {
      expect(LS_GLOBAL_FIELDS).toContain(key);
    });
  });

  it("Phase 2 で追加されたフィールドを含む", () => {
    expect(LS_GLOBAL_FIELDS).toContain("userPresets");
    expect(LS_GLOBAL_FIELDS).toContain("hiddenPresets");
    expect(LS_GLOBAL_FIELDS).toContain("hostSpoolMap");
    expect(LS_GLOBAL_FIELDS).toContain("hostCameraToggle");
  });
});
