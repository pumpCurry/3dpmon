/**
 * @fileoverview v2.2.0 レガシー駆除テスト
 * DHCP/IP遷移、hostname ガード、参照整合性、per-host 排他制御を検証。
 * 過去に障害が多発した条件下でデータが破壊されないことを確認する。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── monitorData モック ──
const mockMonitorData = {
  appSettings: { connectionTargets: [] },
  machines: {},
  filamentSpools: [],
  usageHistory: [],
  hostSpoolMap: {},
  hostCameraToggle: {},
  spoolSerialCounter: 0
};

vi.doMock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: mockMonitorData,
  PLACEHOLDER_HOSTNAME: "_$_NO_MACHINE_$_",
  ensureMachineData: vi.fn((host) => {
    if (!mockMonitorData.machines[host]) {
      mockMonitorData.machines[host] = { storedData: {}, printStore: { current: null, history: [], videos: {} } };
    }
  }),
  setStoredDataForHost: vi.fn(),
  markAllKeysDirty: vi.fn(),
  scopedById: vi.fn()
}));

vi.doMock("../../3dp_lib/dashboard_storage.js", () => ({
  saveUnifiedStorage: vi.fn(),
  trimUsageHistory: vi.fn()
}));
vi.doMock("../../3dp_lib/dashboard_filament_inventory.js", () => ({
  consumeInventory: vi.fn()
}));
vi.doMock("../../3dp_lib/dashboard_ui.js", () => ({
  updateStoredDataToDOM: vi.fn()
}));
vi.doMock("../../3dp_lib/dashboard_printmanager.js", () => ({
  updateHistoryList: vi.fn(),
  loadHistory: vi.fn(() => [])
}));
vi.doMock("../../3dp_lib/dashboard_connection.js", () => ({
  getDeviceIp: vi.fn(() => "192.168.1.1"),
  getHttpPort: vi.fn(() => 80)
}));

const {
  getCurrentSpoolId,
  getCurrentSpool,
  setCurrentSpoolId,
  addSpool,
  updateSpool,
  validateHostSpoolMap,
  getSpoolById
} = await import("../../3dp_lib/dashboard_spool.js");

// ── ヘルパー ──
function resetMonitorData() {
  mockMonitorData.machines = {};
  mockMonitorData.filamentSpools = [];
  mockMonitorData.usageHistory = [];
  mockMonitorData.hostSpoolMap = {};
  mockMonitorData.spoolSerialCounter = 0;
}

// ======================================================================
//  CRITICAL: hostname ガード
// ======================================================================

describe("hostname ガード (CRITICAL)", () => {
  beforeEach(resetMonitorData);

  describe("getCurrentSpoolId", () => {
    it("空文字 → null を返す", () => {
      expect(getCurrentSpoolId("")).toBeNull();
    });
    it("undefined → null を返す", () => {
      expect(getCurrentSpoolId(undefined)).toBeNull();
    });
    it("PLACEHOLDER → null を返す", () => {
      expect(getCurrentSpoolId("_$_NO_MACHINE_$_")).toBeNull();
    });
    it("有効な hostname でエントリなし → null を返す", () => {
      expect(getCurrentSpoolId("K1Max-4A1B")).toBeNull();
    });
    it("有効な hostname でエントリあり → スプールIDを返す", () => {
      mockMonitorData.hostSpoolMap["K1Max-4A1B"] = "sp-001";
      expect(getCurrentSpoolId("K1Max-4A1B")).toBe("sp-001");
    });
    it("hostSpoolMap[host] = null（取り外し済み）→ null を返す", () => {
      mockMonitorData.hostSpoolMap["K1Max-4A1B"] = null;
      expect(getCurrentSpoolId("K1Max-4A1B")).toBeNull();
    });
  });

  describe("setCurrentSpoolId", () => {
    it("hostname='' → false を返し hostSpoolMap を変更しない", () => {
      const result = setCurrentSpoolId("sp-001", "");
      expect(result).toBe(false);
      expect(Object.keys(mockMonitorData.hostSpoolMap)).toHaveLength(0);
    });
    it("hostname=undefined → false を返す", () => {
      expect(setCurrentSpoolId("sp-001", undefined)).toBe(false);
    });
    it("hostname=PLACEHOLDER → false を返す", () => {
      expect(setCurrentSpoolId("sp-001", "_$_NO_MACHINE_$_")).toBe(false);
    });
    it("存在しないスプールID → false を返し hostSpoolMap を汚染しない", () => {
      const result = setCurrentSpoolId("ghost-spool-id", "K1Max-4A1B");
      expect(result).toBe(false);
      expect(mockMonitorData.hostSpoolMap["K1Max-4A1B"]).toBeUndefined();
    });
    it("有効なスプール + 有効な hostname → true を返し hostSpoolMap に書き込む", () => {
      const spool = addSpool({ name: "Test", totalLengthMm: 336000, remainingLengthMm: 336000, purchasePrice: 1000 });
      const result = setCurrentSpoolId(spool.id, "K1Max-4A1B");
      expect(result).toBe(true);
      expect(mockMonitorData.hostSpoolMap["K1Max-4A1B"]).toBe(spool.id);
      expect(spool.isActive).toBe(true);
      expect(spool.hostname).toBe("K1Max-4A1B");
    });
    it("id=null（取り外し）→ true を返し hostSpoolMap を null にする", () => {
      const spool = addSpool({ name: "Test", totalLengthMm: 100000, remainingLengthMm: 100000 });
      setCurrentSpoolId(spool.id, "K1Max-4A1B");
      const result = setCurrentSpoolId(null, "K1Max-4A1B");
      expect(result).toBe(true);
      expect(mockMonitorData.hostSpoolMap["K1Max-4A1B"]).toBeNull();
    });
    it("別ホストに装着済みのスプール → false を返す", () => {
      const spool = addSpool({ name: "Shared", totalLengthMm: 100000, remainingLengthMm: 100000 });
      setCurrentSpoolId(spool.id, "K1Max-4A1B");
      const result = setCurrentSpoolId(spool.id, "K1Max-03FA");
      expect(result).toBe(false);
      // 4A1B の装着は維持される
      expect(mockMonitorData.hostSpoolMap["K1Max-4A1B"]).toBe(spool.id);
    });
  });
});

// ======================================================================
//  CRITICAL: validateHostSpoolMap 参照整合性
// ======================================================================

describe("validateHostSpoolMap (CRITICAL)", () => {
  beforeEach(resetMonitorData);

  it("孤立エントリ（存在しないスプール）→ null にクリアされる", () => {
    mockMonitorData.hostSpoolMap["K1Max-4A1B"] = "non-existent-spool";
    const repaired = validateHostSpoolMap();
    expect(repaired).toBe(1);
    expect(mockMonitorData.hostSpoolMap["K1Max-4A1B"]).toBeNull();
  });

  it("削除済みスプールを指すエントリ → null にクリアされる", () => {
    const spool = addSpool({ name: "Deleted", totalLengthMm: 100000, remainingLengthMm: 100000 });
    spool.deleted = true;
    spool.isDeleted = true;
    mockMonitorData.hostSpoolMap["K1Max-4A1B"] = spool.id;
    const repaired = validateHostSpoolMap();
    expect(repaired).toBe(1);
    expect(mockMonitorData.hostSpoolMap["K1Max-4A1B"]).toBeNull();
  });

  it("有効なスプールを指すエントリ → 変更されない", () => {
    const spool = addSpool({ name: "Valid", totalLengthMm: 100000, remainingLengthMm: 100000 });
    mockMonitorData.hostSpoolMap["K1Max-4A1B"] = spool.id;
    const repaired = validateHostSpoolMap();
    expect(repaired).toBe(0);
    expect(mockMonitorData.hostSpoolMap["K1Max-4A1B"]).toBe(spool.id);
  });

  it("空の hostSpoolMap → 0 を返す", () => {
    expect(validateHostSpoolMap()).toBe(0);
  });

  it("複数の孤立エントリ → 全て修復される", () => {
    mockMonitorData.hostSpoolMap["host-A"] = "ghost-1";
    mockMonitorData.hostSpoolMap["host-B"] = "ghost-2";
    mockMonitorData.hostSpoolMap["host-C"] = "ghost-3";
    expect(validateHostSpoolMap()).toBe(3);
  });
});

// ======================================================================
//  HIGH: IP→hostname 遷移でのデータ保護
// ======================================================================

describe("IP→hostname 遷移 (HIGH)", () => {
  beforeEach(resetMonitorData);

  it("hostSpoolMap の IP キーがホスト名キーに移行される（シミュレーション）", () => {
    // IP キーでスプールを装着
    const spool = addSpool({ name: "Test", totalLengthMm: 100000, remainingLengthMm: 100000 });
    setCurrentSpoolId(spool.id, "192.168.54.151");
    expect(mockMonitorData.hostSpoolMap["192.168.54.151"]).toBe(spool.id);
    expect(spool.hostname).toBe("192.168.54.151");

    // updateConnectionHost 相当の移行処理をシミュレート
    // (実際の updateConnectionHost は dashboard_connection.js の private 関数だが、
    //  ここではその結果として期待されるデータ状態を検証する)
    const oldHost = "192.168.54.151";
    const newHost = "K1Max-4A1B";

    // hostSpoolMap の移行
    if (mockMonitorData.hostSpoolMap[oldHost] !== undefined) {
      if (!mockMonitorData.hostSpoolMap[newHost]) {
        mockMonitorData.hostSpoolMap[newHost] = mockMonitorData.hostSpoolMap[oldHost];
      }
      delete mockMonitorData.hostSpoolMap[oldHost];
    }
    // spool.hostname の移行
    for (const sp of mockMonitorData.filamentSpools) {
      if (sp.hostname === oldHost) sp.hostname = newHost;
    }

    // 検証: 新キーに正しく移行されている
    expect(mockMonitorData.hostSpoolMap["K1Max-4A1B"]).toBe(spool.id);
    expect(mockMonitorData.hostSpoolMap["192.168.54.151"]).toBeUndefined();
    expect(spool.hostname).toBe("K1Max-4A1B");
    // getCurrentSpoolId は新キーで動作する
    expect(getCurrentSpoolId("K1Max-4A1B")).toBe(spool.id);
    expect(getCurrentSpoolId("192.168.54.151")).toBeNull();
  });

  it("既にホスト名キーにスプールがある場合、IPキーの値で上書きしない", () => {
    const spoolA = addSpool({ name: "SpoolA", totalLengthMm: 100000, remainingLengthMm: 100000 });
    const spoolB = addSpool({ name: "SpoolB", totalLengthMm: 100000, remainingLengthMm: 100000 });
    // ホスト名キーに先に装着済み
    setCurrentSpoolId(spoolA.id, "K1Max-4A1B");
    // IPキーにも別のスプール（古いセッションの残骸）
    mockMonitorData.hostSpoolMap["192.168.54.151"] = spoolB.id;

    // 移行: 既存キーがあればスキップ
    const oldHost = "192.168.54.151";
    const newHost = "K1Max-4A1B";
    if (mockMonitorData.hostSpoolMap[oldHost] !== undefined) {
      if (!mockMonitorData.hostSpoolMap[newHost]) {
        mockMonitorData.hostSpoolMap[newHost] = mockMonitorData.hostSpoolMap[oldHost];
      }
      delete mockMonitorData.hostSpoolMap[oldHost];
    }

    // spoolA が維持される（IPキーの spoolB で上書きされない）
    expect(mockMonitorData.hostSpoolMap["K1Max-4A1B"]).toBe(spoolA.id);
  });

  it("DHCP統合: 旧IPエントリが削除され現在のIPに統合される（ロジックテスト）", () => {
    const targets = [
      { dest: "192.168.1.10:9999", hostname: "K1Max-4A1B", color: "red", cameraPort: 8888 },
      { dest: "192.168.1.20:9999", hostname: "", color: "", cameraPort: null }
    ];
    mockMonitorData.appSettings.connectionTargets = targets;

    // _setConnectionTargetHostname 相当: 新 dest で同じ hostname が来た
    const newDest = "192.168.1.20:9999";
    const hostname = "K1Max-4A1B";
    const t = targets.find(e => e.dest === newDest);

    // 旧エントリを検出
    const staleEntries = targets.filter(e =>
      e !== t && e.hostname === hostname && e.dest !== newDest
    );
    expect(staleEntries).toHaveLength(1);
    expect(staleEntries[0].dest).toBe("192.168.1.10:9999");

    // 旧エントリの設定を引き継ぎ
    for (const stale of staleEntries) {
      if (stale.color && !t.color) t.color = stale.color;
      if (stale.cameraPort && !t.cameraPort) t.cameraPort = stale.cameraPort;
      const idx = targets.indexOf(stale);
      if (idx >= 0) targets.splice(idx, 1);
    }
    t.hostname = hostname;

    // 検証
    expect(targets).toHaveLength(1);
    expect(targets[0].dest).toBe("192.168.1.20:9999");
    expect(targets[0].hostname).toBe("K1Max-4A1B");
    expect(targets[0].color).toBe("red");       // 引き継ぎ
    expect(targets[0].cameraPort).toBe(8888);   // 引き継ぎ
  });
});

// ======================================================================
//  MEDIUM: costPerMm の自動算出
// ======================================================================

describe("costPerMm 自動算出 (MEDIUM)", () => {
  beforeEach(resetMonitorData);

  it("addSpool: 価格と全長が揃っていれば costPerMm が計算される", () => {
    const spool = addSpool({ name: "Test", purchasePrice: 1699, totalLengthMm: 336000, remainingLengthMm: 336000 });
    expect(spool.costPerMm).toBeCloseTo(1699 / 336000, 8);
  });

  it("addSpool: 価格=0 → costPerMm=0", () => {
    const spool = addSpool({ name: "Free", purchasePrice: 0, totalLengthMm: 336000, remainingLengthMm: 336000 });
    expect(spool.costPerMm).toBe(0);
  });

  it("addSpool: 全長=0 → costPerMm=0", () => {
    const spool = addSpool({ name: "NoLen", purchasePrice: 1699, totalLengthMm: 0, remainingLengthMm: 0 });
    expect(spool.costPerMm).toBe(0);
  });

  it("updateSpool: 価格変更で costPerMm が再計算される", () => {
    const spool = addSpool({ name: "Test", purchasePrice: 1000, totalLengthMm: 100000, remainingLengthMm: 100000 });
    expect(spool.costPerMm).toBeCloseTo(0.01, 6);
    updateSpool(spool.id, { purchasePrice: 2000 });
    expect(spool.costPerMm).toBeCloseTo(0.02, 6);
  });

  it("updateSpool: 名前変更では costPerMm は変わらない", () => {
    const spool = addSpool({ name: "Test", purchasePrice: 1000, totalLengthMm: 100000, remainingLengthMm: 100000 });
    const original = spool.costPerMm;
    updateSpool(spool.id, { name: "Renamed" });
    expect(spool.costPerMm).toBe(original);
  });
});

// ======================================================================
//  MEDIUM: buildJobCostReport 追加ケース
// ======================================================================

const { buildJobCostReport, buildHostRanking } = await import("../../3dp_lib/dashboard_production.js");

describe("buildJobCostReport 追加ケース", () => {
  beforeEach(resetMonitorData);

  it("printfinish=0（印刷中）は成功にも失敗にもカウントしない", () => {
    mockMonitorData.machines["host1"] = {
      printStore: { history: [
        { filename: "test.gcode", printfinish: 0, materialUsedMm: 500, materialCostYen: 25 }
      ]}
    };
    const result = buildJobCostReport("host1");
    const job = result.find(r => r.filename === "test.gcode");
    expect(job.printCount).toBe(1);
    expect(job.successCount).toBe(0);
    expect(job.failCount).toBe(0);
    expect(job.wastedCostYen).toBe(0);
  });

  it("フルパスファイル名は basename に変換される", () => {
    mockMonitorData.machines["host1"] = {
      printStore: { history: [
        { filename: "/data/gcode/subdir/part.gcode", printfinish: 1, materialUsedMm: 1000, materialCostYen: 50 }
      ]}
    };
    const result = buildJobCostReport("host1");
    expect(result[0].filename).toBe("part.gcode");
  });

  it("PLACEHOLDER ホストは除外される", () => {
    mockMonitorData.machines["_$_NO_MACHINE_$_"] = {
      printStore: { history: [
        { filename: "ghost.gcode", printfinish: 1, materialUsedMm: 1000, materialCostYen: 50 }
      ]}
    };
    const result = buildJobCostReport();
    expect(result).toHaveLength(0);
  });
});

// ======================================================================
//  MEDIUM: buildHostRanking 追加ケース
// ======================================================================

describe("buildHostRanking 追加ケース", () => {
  beforeEach(resetMonitorData);

  it("成功率0のホストは稼働率が高くてもランク下位", () => {
    // host1: 稼働率高いが成功率0
    const epochSec = (h) => Math.floor((Date.now() - h * 3600000) / 1000);
    mockMonitorData.machines["host1"] = {
      storedData: { hostname: { rawValue: "Busy-Fail" } },
      historyList: [{ startTime: epochSec(2), endtime: epochSec(1), printProgress: 30, usagematerial: 100 }],
      printStore: { history: [{ printfinish: -1, materialCostYen: 50 }] }
    };
    // host2: 稼働率低いが成功率100%
    mockMonitorData.machines["host2"] = {
      storedData: { hostname: { rawValue: "Slow-Success" } },
      historyList: [{ startTime: epochSec(23.5), endtime: epochSec(23), printProgress: 100, printfinish: 1, usagematerial: 50 }],
      printStore: { history: [{ printfinish: 1, materialCostYen: 30 }] }
    };
    const result = buildHostRanking();
    expect(result[0].hostname).toBe("host2"); // 成功率 > 0 なのでスコア上
    expect(result[1].hostname).toBe("host1"); // スコア 0 (稼働率 * 0)
  });

  it("costPerSuccessPrint: 成功0のとき NaN/Infinity ではなく 0", () => {
    mockMonitorData.machines["host1"] = {
      storedData: {},
      historyList: [],
      printStore: { history: [{ printfinish: -1, materialCostYen: 100 }] }
    };
    const result = buildHostRanking();
    expect(result[0].costPerSuccessPrint).toBe(0);
    expect(Number.isFinite(result[0].costPerSuccessPrint)).toBe(true);
  });
});

// ======================================================================
//  usageHistory に hostname が含まれるか
// ======================================================================

describe("usageHistory hostname フィールド", () => {
  beforeEach(resetMonitorData);

  it("addSpool + setCurrentSpoolId で usageHistory に hostname が記録される", () => {
    const spool = addSpool({ name: "Test", totalLengthMm: 100000, remainingLengthMm: 100000 });
    setCurrentSpoolId(spool.id, "K1Max-4A1B");
    // setCurrentSpoolId 内の logSpoolChange が usageHistory に追加する
    const entries = mockMonitorData.usageHistory.filter(e => e.spoolId === spool.id);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].hostname).toBe("K1Max-4A1B");
  });
});

// ======================================================================
//  ポート定数化の検証
// ======================================================================

describe("ポート定数", () => {
  it("DEFAULT_WS_PORT / DEFAULT_CAMERA_PORT が定義されていること（コード検証）", async () => {
    // dashboard_connection.js のソースコードから定数を確認
    const fs = await import("fs");
    const src = fs.readFileSync("3dp_lib/dashboard_connection.js", "utf-8");
    expect(src).toContain("const DEFAULT_WS_PORT = 9999");
    expect(src).toContain("const DEFAULT_CAMERA_PORT = 8080");
    // ハードコードされた :9999 が定数参照に置き換わっていること
    // (コメント内の例示は許容)
    const codeLines = src.split("\n").filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    const hardcoded9999 = codeLines.filter(l => l.includes('":9999"') || l.includes("':9999'"));
    expect(hardcoded9999).toHaveLength(0);
  });
});

// ======================================================================
//  v2.2.0: 旧フォーマットサポート終了の検証
// ======================================================================

describe("v2.2.0 旧フォーマットサポート終了", () => {
  it("exportAllData のバージョンが 2.20 であること（コード検証）", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("3dp_lib/dashboard_storage.js", "utf-8");
    expect(src).toContain('_exportVersion = "2.20"');
  });

  it("STORAGE_KEY (3dp-monitor_1.400) への参照がコード上に存在しないこと", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("3dp_lib/dashboard_storage.js", "utf-8");
    const codeLines = src.split("\n").filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    const refs = codeLines.filter(l => l.includes('"3dp-monitor_1.400"') || l.includes("STORAGE_KEY"));
    expect(refs).toHaveLength(0);
  });

  it("currentHostname / setCurrentHostname が export されていないこと（コード検証）", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("3dp_lib/dashboard_data.js", "utf-8");
    const exportLines = src.split("\n").filter(l => l.startsWith("export"));
    const hasCurrentHostname = exportLines.some(l => l.includes("currentHostname"));
    const hasSetCurrentHostname = exportLines.some(l => l.includes("setCurrentHostname"));
    expect(hasCurrentHostname).toBe(false);
    expect(hasSetCurrentHostname).toBe(false);
  });
});
