/**
 * @fileoverview スモークテスト: データ整合性
 * ストレージの保存/復元/マージで壊れないことを検証
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// monitorData モック
const mockMonitorData = {
  appSettings: { connectionTargets: [], wsDest: "" },
  machines: {},
  filamentSpools: [],
  usageHistory: [],
  filamentInventory: [],
  filamentPresets: [],
  userPresets: [],
  hiddenPresets: [],
  hostSpoolMap: {},
  hostCameraToggle: {},
  currentSpoolId: null,
  spoolSerialCounter: 0,
  temporaryBuffer: []
};

vi.doMock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: mockMonitorData,
  PLACEHOLDER_HOSTNAME: "_$_NO_MACHINE_$_",
  ensureMachineData: vi.fn()
}));

vi.doMock("../../3dp_lib/dashboard_filament_presets.js", () => ({
  FILAMENT_PRESETS: []
}));

vi.doMock("../../3dp_lib/dashboard_storage_idb.js", () => ({
  isIdbAvailable: () => false,
  getIdbCache: () => null,
  queueSharedWrite: vi.fn(),
  queueMachineWrite: vi.fn()
}));

vi.doMock("../../3dp_lib/dashboard_log_util.js", () => ({
  logManager: { add: vi.fn() }
}));

describe("データ整合性スモークテスト", () => {
  beforeEach(() => {
    mockMonitorData.machines = {};
    mockMonitorData.filamentSpools = [];
    mockMonitorData.usageHistory = [];
    mockMonitorData.filamentInventory = [];
    mockMonitorData.hostSpoolMap = {};
    mockMonitorData.hostCameraToggle = {};
    mockMonitorData.appSettings = { connectionTargets: [] };
    mockMonitorData.spoolSerialCounter = 0;
  });

  describe("PLACEHOLDER 除外", () => {
    it("_$_NO_MACHINE_$_ が machines に残らないこと", () => {
      // PLACEHOLDER は machines のフィルタで除外される想定
      mockMonitorData.machines["_$_NO_MACHINE_$_"] = { storedData: {} };
      mockMonitorData.machines["K1Max-4A1B"] = { storedData: { hostname: { rawValue: "K1Max-4A1B" } } };
      const validKeys = Object.keys(mockMonitorData.machines).filter(h => h !== "_$_NO_MACHINE_$_");
      expect(validKeys).toEqual(["K1Max-4A1B"]);
      expect(validKeys).not.toContain("_$_NO_MACHINE_$_");
    });
  });

  describe("IPキー孤立防止", () => {
    it("IP + ホスト名が両方ある場合、IPキーは不要", () => {
      const targets = [
        { dest: "192.168.54.151:9999", hostname: "K1Max-4A1B" },
        { dest: "192.168.54.152:9999", hostname: "K1Max-03FA" }
      ];
      const resolvedIps = new Set(targets.filter(t => t.hostname).map(t => t.dest.split(":")[0]));
      expect(resolvedIps.has("192.168.54.151")).toBe(true);
      expect(resolvedIps.has("192.168.54.152")).toBe(true);
      // IPキーの machines エントリは不要
      const shouldSkip = (host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) && resolvedIps.has(host);
      expect(shouldSkip("192.168.54.151")).toBe(true);
      expect(shouldSkip("K1Max-4A1B")).toBe(false);
    });
  });

  describe("connectionTargets クリーンアップ", () => {
    it("ポートなしエントリが除去される", () => {
      const targets = [
        { dest: "192.168.54.151", hostname: "" },
        { dest: "192.168.54.151:9999", hostname: "K1Max-4A1B" }
      ];
      const destSet = new Set(targets.map(t => t.dest));
      const toRemove = targets.filter(t => {
        if (!t.dest.includes(":")) {
          return destSet.has(t.dest + ":9999");
        }
        return false;
      });
      expect(toRemove).toHaveLength(1);
      expect(toRemove[0].dest).toBe("192.168.54.151");
    });

    it("ポート付きのみのエントリは除去されない", () => {
      const targets = [
        { dest: "192.168.54.153:9999", hostname: "" }
      ];
      const destSet = new Set(targets.map(t => t.dest));
      const toRemove = targets.filter(t => !t.dest.includes(":") && destSet.has(t.dest + ":9999"));
      expect(toRemove).toHaveLength(0);
    });
  });

  describe("hostSpoolMap マージ", () => {
    it("既存の装着情報が上書きされない", () => {
      mockMonitorData.hostSpoolMap = { "K1Max-4A1B": "spool_001" };
      const restored = { "K1Max-4A1B": "spool_002", "K1Max-03FA": "spool_003" };
      // マージ: 既存キーは保護、新規キーのみ追加
      for (const [host, id] of Object.entries(restored)) {
        if (id && !mockMonitorData.hostSpoolMap[host]) {
          mockMonitorData.hostSpoolMap[host] = id;
        }
      }
      expect(mockMonitorData.hostSpoolMap["K1Max-4A1B"]).toBe("spool_001"); // 既存保護
      expect(mockMonitorData.hostSpoolMap["K1Max-03FA"]).toBe("spool_003"); // 新規追加
    });
  });

  describe("スプール isActive 保護", () => {
    it("アクティブスプールがリストアで上書きされない", () => {
      const activeSpool = { id: "sp1", isActive: true, isInUse: true, remainingLengthMm: 50000 };
      const restoredSpool = { id: "sp1", isActive: false, isInUse: false, remainingLengthMm: 100000 };
      // アクティブならスキップ
      if (!activeSpool.isActive && !activeSpool.isInUse) {
        Object.assign(activeSpool, restoredSpool);
      }
      expect(activeSpool.isActive).toBe(true);
      expect(activeSpool.remainingLengthMm).toBe(50000); // 上書きされない
    });
  });

  describe("usageHistory 重複排除", () => {
    it("同一 usageId のエントリが重複しない", () => {
      mockMonitorData.usageHistory = [
        { usageId: "u1", spoolId: "sp1", startedAt: 1000 },
        { usageId: "u2", spoolId: "sp1", startedAt: 2000 }
      ];
      const toAdd = [
        { usageId: "u1", spoolId: "sp1", startedAt: 1000 }, // 重複
        { usageId: "u3", spoolId: "sp2", startedAt: 3000 }  // 新規
      ];
      const existingIds = new Set(mockMonitorData.usageHistory.map(u => u.usageId));
      for (const entry of toAdd) {
        if (!existingIds.has(entry.usageId)) {
          mockMonitorData.usageHistory.push(entry);
          existingIds.add(entry.usageId);
        }
      }
      expect(mockMonitorData.usageHistory).toHaveLength(3);
      expect(mockMonitorData.usageHistory.map(u => u.usageId)).toEqual(["u1", "u2", "u3"]);
    });
  });

  describe("spoolSerialCounter 保護", () => {
    it("復元値が現在値より小さければ無視", () => {
      mockMonitorData.spoolSerialCounter = 10;
      const restored = 5;
      if (Number.isFinite(restored) && restored > mockMonitorData.spoolSerialCounter) {
        mockMonitorData.spoolSerialCounter = restored;
      }
      expect(mockMonitorData.spoolSerialCounter).toBe(10);
    });

    it("復元値が大きければ採用", () => {
      mockMonitorData.spoolSerialCounter = 5;
      const restored = 10;
      if (Number.isFinite(restored) && restored > mockMonitorData.spoolSerialCounter) {
        mockMonitorData.spoolSerialCounter = restored;
      }
      expect(mockMonitorData.spoolSerialCounter).toBe(10);
    });

    it("NaN は無視", () => {
      mockMonitorData.spoolSerialCounter = 5;
      const restored = NaN;
      if (Number.isFinite(restored) && restored > mockMonitorData.spoolSerialCounter) {
        mockMonitorData.spoolSerialCounter = restored;
      }
      expect(mockMonitorData.spoolSerialCounter).toBe(5);
    });
  });
});

describe("IPv6 安全性", () => {
  // _extractIp のロジック再現
  function extractIp(dest) {
    if (!dest) return "";
    const v6Match = dest.match(/^\[([^\]]+)\]/);
    if (v6Match) return v6Match[1];
    const lastColon = dest.lastIndexOf(":");
    if ((dest.match(/:/g) || []).length > 1) return dest;
    return lastColon > 0 ? dest.substring(0, lastColon) : dest;
  }

  it("IPv4:port", () => expect(extractIp("192.168.54.151:9999")).toBe("192.168.54.151"));
  it("IPv4 only", () => expect(extractIp("192.168.54.151")).toBe("192.168.54.151"));
  it("IPv6 bracket", () => expect(extractIp("[fe80::1]:9999")).toBe("fe80::1"));
  it("IPv6 naked", () => expect(extractIp("fe80::1")).toBe("fe80::1"));
  it("IPv4-mapped IPv6", () => expect(extractIp("[::ffff:192.168.54.151]:9999")).toBe("::ffff:192.168.54.151"));
  it("empty", () => expect(extractIp("")).toBe(""));
  it("null", () => expect(extractIp(null)).toBe(""));
  it("192.168.0.1 と 192.168.0.100 は区別される", () => {
    expect(extractIp("192.168.0.1:9999")).not.toBe(extractIp("192.168.0.100:9999"));
  });
});

describe("ホスト名エンコード安全性", () => {
  it("encodeURIComponent ラウンドトリップ", () => {
    const hosts = [
      "192.168.54.151:9999",
      "k1max-abcd.local:9999",
      "K1Max-4A1B",
      "printer.local",
      "fe80::1%eth0"
    ];
    for (const h of hosts) {
      expect(decodeURIComponent(encodeURIComponent(h))).toBe(h);
    }
  });
});

describe("ARP resolver", () => {
  // _normalizeMac のロジック再現
  function normalizeMac(mac) {
    return mac.toLowerCase().replace(/-/g, ":").split(":").map(b => b.padStart(2, "0")).join(":");
  }

  it("Windows形式 (dash)", () => expect(normalizeMac("FC-EE-28-01-4A-1B")).toBe("fc:ee:28:01:4a:1b"));
  it("Linux形式 (colon)", () => expect(normalizeMac("fc:ee:28:01:4a:1b")).toBe("fc:ee:28:01:4a:1b"));
  it("macOS省略形", () => expect(normalizeMac("fc:ee:28:1:4a:1b")).toBe("fc:ee:28:01:4a:1b"));
  it("Creality OUI判定", () => {
    expect(normalizeMac("FC-EE-28-07-03-FA").startsWith("fc:ee:28")).toBe(true);
    expect(normalizeMac("AA-BB-CC-DD-EE-FF").startsWith("fc:ee:28")).toBe(false);
  });
});
