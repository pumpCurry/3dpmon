/**
 * @fileoverview dashboard_production.js の単体テスト
 *
 * ★ v2.2.1012: 統計の参照元を「存在しない machine.historyList（生データ形式）」から
 *    「machine.printStore.history（parseRawHistoryEntry 済みスキーマ）」へ修正したのに伴い、
 *    テストデータも parse 後スキーマ（startTimeSec=epoch秒 / finishTime=ISO文字列 /
 *    materialUsedMm / printfinish）へ全面的に更新した。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// monitorData モック
const mockMonitorData = {
  machines: {},
  filamentSpools: [],
  usageHistory: []
};

vi.doMock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: mockMonitorData,
  PLACEHOLDER_HOSTNAME: "_$_NO_MACHINE_$_"
}));

const {
  buildHostUtilization,
  buildDailyProductionReport,
  buildEstimateVsActual,
  buildFleetSummary,
  buildJobCostReport,
  buildHostRanking,
  buildMaterialReport
} = await import("../../3dp_lib/dashboard_production.js");

/** ヘルパー: エポック秒を生成 */
function epochSec(hoursAgo) {
  return Math.floor((Date.now() - hoursAgo * 3600000) / 1000);
}

/** ヘルパー: エポック秒 → ISO文字列（parseRawHistoryEntry の finishTime 形式） */
function isoFromEpoch(sec) {
  return new Date(sec * 1000).toISOString();
}

/**
 * ヘルパー: printStore.history 形式（parse後スキーマ）のエントリを生成する。
 * @param {{startHoursAgo:number, endHoursAgo?:number, ok?:boolean,
 *          materialMm?:number, filename?:string}} o
 */
function histEntry(o) {
  const startSec = epochSec(o.startHoursAgo);
  const entry = {
    startTimeSec: startSec,
    printfinish: o.ok === false ? 0 : 1
  };
  if (o.endHoursAgo != null) entry.finishTime = isoFromEpoch(epochSec(o.endHoursAgo));
  if (o.materialMm != null) entry.materialUsedMm = o.materialMm;
  if (o.filename != null) entry.filename = o.filename;
  return entry;
}

describe("buildHostUtilization", () => {
  beforeEach(() => {
    mockMonitorData.machines = {};
  });

  it("空の履歴で稼働率0%を返す", () => {
    mockMonitorData.machines["host1"] = {
      storedData: { hostname: { rawValue: "K1Max-1" } },
      printStore: { history: [] }
    };
    const result = buildHostUtilization("host1");
    expect(result.utilizationPct).toBe(0);
    expect(result.printCount).toBe(0);
    expect(result.displayName).toBe("K1Max-1");
  });

  it("成功した印刷の稼働率を正しく計算", () => {
    // 2時間前開始 → 1時間前完了 → 1時間印刷
    mockMonitorData.machines["host1"] = {
      storedData: { hostname: { rawValue: "K1Max-1" } },
      printStore: {
        history: [histEntry({ startHoursAgo: 2, endHoursAgo: 1, ok: true, materialMm: 5000 })]
      }
    };
    const result = buildHostUtilization("host1");
    expect(result.printCount).toBe(1);
    expect(result.successCount).toBe(1);
    expect(result.failCount).toBe(0);
    expect(result.totalFilamentMm).toBe(5000);
    // 1時間 / 24時間 ≈ 4.2%
    expect(result.utilizationPct).toBeGreaterThan(3);
    expect(result.utilizationPct).toBeLessThan(6);
  });

  it("失敗した印刷をカウント", () => {
    mockMonitorData.machines["host1"] = {
      storedData: {},
      printStore: {
        history: [histEntry({ startHoursAgo: 3, endHoursAgo: 2.5, ok: false })]
      }
    };
    const result = buildHostUtilization("host1");
    expect(result.printCount).toBe(1);
    expect(result.successCount).toBe(0);
    expect(result.failCount).toBe(1);
  });

  it("期間外の印刷を除外", () => {
    mockMonitorData.machines["host1"] = {
      storedData: {},
      printStore: {
        history: [histEntry({ startHoursAgo: 48, endHoursAgo: 47, ok: true })] // 2日前
      }
    };
    const result = buildHostUtilization("host1");
    expect(result.printCount).toBe(0);
  });

  it("存在しないホストでもクラッシュしない", () => {
    const result = buildHostUtilization("nonexistent");
    expect(result.utilizationPct).toBe(0);
    expect(result.hostname).toBe("nonexistent");
  });
});

describe("buildDailyProductionReport", () => {
  beforeEach(() => {
    mockMonitorData.machines = {};
  });

  it("7日分の空データを返す", () => {
    const result = buildDailyProductionReport({ days: 7 });
    expect(result).toHaveLength(7);
    result.forEach(day => {
      expect(day.printCount).toBe(0);
      expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  it("今日の印刷をカウント", () => {
    // 18分前開始 / 6分前完了（日付境界問題を回避）
    mockMonitorData.machines["host1"] = {
      printStore: {
        history: [histEntry({ startHoursAgo: 0.3, endHoursAgo: 0.1, ok: true, materialMm: 3000 })]
      }
    };
    const result = buildDailyProductionReport({ days: 1 });
    // _localDateKey と同じロジック（ローカルタイムゾーン）
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
    const today = result.find(d => d.date === todayKey);
    expect(today).toBeDefined();
    expect(today.printCount).toBe(1);
    expect(today.successCount).toBe(1);
    expect(today.totalFilamentMm).toBe(3000);
  });

  it("マルチホストを集計", () => {
    mockMonitorData.machines["host1"] = {
      printStore: { history: [histEntry({ startHoursAgo: 0.3, endHoursAgo: 0.1, ok: true })] }
    };
    mockMonitorData.machines["host2"] = {
      printStore: { history: [histEntry({ startHoursAgo: 0.3, endHoursAgo: 0.1, ok: true })] }
    };
    const result = buildDailyProductionReport({ days: 1 });
    const today = result[0];
    expect(today.printCount).toBe(2);
    expect(Object.keys(today.byHost)).toHaveLength(2);
  });
});

describe("buildEstimateVsActual", () => {
  beforeEach(() => {
    mockMonitorData.machines = {};
  });
  afterEach(() => {
    // localStorage モックの後始末
    if (Object.prototype.hasOwnProperty.call(globalThis, "localStorage")) {
      delete globalThis.localStorage;
    }
  });

  it("予定vs実績の差分を計算", () => {
    // GCode 見積時間は printmanager が localStorage に保存した gcode メタキャッシュから引く
    globalThis.localStorage = {
      getItem: (k) => k === "3dpmon_gcode_meta_cache"
        ? JSON.stringify({ "host1:test.gcode": { timeSec: 3000 } })  // 見積: 3000秒
        : null
    };
    mockMonitorData.machines["host1"] = {
      printStore: {
        history: [
          // 実績: 3600秒 ×2回
          histEntry({ startHoursAgo: 2, endHoursAgo: 1, ok: true, filename: "/data/gcode/test.gcode" }),
          histEntry({ startHoursAgo: 5, endHoursAgo: 4, ok: true, filename: "/data/gcode/test.gcode" })
        ]
      }
    };
    const result = buildEstimateVsActual("host1");
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe("test.gcode");
    expect(result[0].printCount).toBe(2);
    expect(result[0].estimatedSec).toBe(3000);
    expect(result[0].actualAvgSec).toBe(3600);
    expect(result[0].diffPct).toBe(20.0); // 20%超過
  });

  it("見積データが無ければ実測のみ算出し見積は0", () => {
    // localStorage 未設定 → 見積取得不可
    mockMonitorData.machines["host1"] = {
      printStore: {
        history: [histEntry({ startHoursAgo: 2, endHoursAgo: 1, ok: true, filename: "x.gcode" })]
      }
    };
    const result = buildEstimateVsActual("host1");
    expect(result).toHaveLength(1);
    expect(result[0].actualAvgSec).toBe(3600);
    expect(result[0].estimatedSec).toBe(0);
    expect(result[0].diffPct).toBe(0);
  });

  it("空の履歴で空配列を返す", () => {
    mockMonitorData.machines["host1"] = { printStore: { history: [] } };
    const result = buildEstimateVsActual("host1");
    expect(result).toHaveLength(0);
  });
});

describe("buildFleetSummary", () => {
  beforeEach(() => {
    mockMonitorData.machines = {};
  });

  it("6台のフリートサマリーを生成", () => {
    for (let i = 1; i <= 6; i++) {
      mockMonitorData.machines[`host${i}`] = {
        storedData: { hostname: { rawValue: `Printer-${i}` } },
        printStore: {
          history: [histEntry({ startHoursAgo: 2, endHoursAgo: 1, ok: true, materialMm: 1000 })]
        }
      };
    }
    const result = buildFleetSummary();
    expect(result.totalHosts).toBe(6);
    expect(result.activeHosts).toBe(6);
    expect(result.totalPrintCount).toBe(6);
    expect(result.totalSuccessCount).toBe(6);
    expect(result.totalFilamentMm).toBe(6000);
    expect(result.hosts).toHaveLength(6);
    // 各ホスト 1時間/24時間 ≈ 4.2% → フリート合計も同程度
    expect(result.fleetUtilizationPct).toBeGreaterThan(3);
    expect(result.fleetUtilizationPct).toBeLessThan(6);
  });

  it("PLACEHOLDERホストを除外", () => {
    mockMonitorData.machines["_$_NO_MACHINE_$_"] = {
      storedData: {},
      printStore: { history: [] }
    };
    mockMonitorData.machines["real-host"] = {
      storedData: { hostname: { rawValue: "Real" } },
      printStore: { history: [] }
    };
    const result = buildFleetSummary();
    expect(result.totalHosts).toBe(1);
  });
});

// ======================================================================
//  Phase 2: 高度な統計集計関数のテスト
// ======================================================================

describe("buildJobCostReport", () => {
  beforeEach(() => {
    mockMonitorData.machines = {};
    mockMonitorData.filamentSpools = [];
  });

  it("空の履歴で空配列を返す", () => {
    mockMonitorData.machines["host1"] = { printStore: { history: [] } };
    const result = buildJobCostReport("host1");
    expect(result).toHaveLength(0);
  });

  it("ファイル名ごとにコスト・成功率を計算", () => {
    mockMonitorData.machines["host1"] = {
      printStore: {
        history: [
          { filename: "part_A.gcode", printfinish: 1, materialUsedMm: 1000, materialCostYen: 50, startTime: "2026-04-01T10:00:00", finishTime: "2026-04-01T11:00:00" },
          { filename: "part_A.gcode", printfinish: 1, materialUsedMm: 1100, materialCostYen: 55, startTime: "2026-04-02T10:00:00", finishTime: "2026-04-02T11:00:00" },
          { filename: "part_A.gcode", printfinish: -1, materialUsedMm: 500, materialCostYen: 25, startTime: "2026-04-03T10:00:00", finishTime: "2026-04-03T10:30:00" },
          { filename: "part_B.gcode", printfinish: 1, materialUsedMm: 2000, materialCostYen: 100, startTime: "2026-04-01T12:00:00", finishTime: "2026-04-01T14:00:00" }
        ]
      }
    };
    const result = buildJobCostReport("host1");
    expect(result).toHaveLength(2);

    // part_A: 3回、成功2回、失敗1回
    const partA = result.find(r => r.filename === "part_A.gcode");
    expect(partA).toBeDefined();
    expect(partA.printCount).toBe(3);
    expect(partA.successCount).toBe(2);
    expect(partA.failCount).toBe(1);
    expect(partA.successRate).toBeCloseTo(0.667, 2);
    expect(partA.avgMaterialMm).toBe(1050); // (1000+1100)/2
    expect(partA.totalCostYen).toBe(130); // 50+55+25
    expect(partA.wastedCostYen).toBe(25);
    // 1個あたり真のコスト = 130 / 2 = 65
    expect(partA.costPerSuccess).toBe(65);

    // part_B: 1回成功
    const partB = result.find(r => r.filename === "part_B.gcode");
    expect(partB.printCount).toBe(1);
    expect(partB.successRate).toBe(1);
    expect(partB.avgCostYen).toBe(100);
  });

  it("全ホスト合算で集計できる", () => {
    mockMonitorData.machines["host1"] = {
      printStore: { history: [
        { filename: "shared.gcode", printfinish: 1, materialUsedMm: 1000, materialCostYen: 50 }
      ]}
    };
    mockMonitorData.machines["host2"] = {
      printStore: { history: [
        { filename: "shared.gcode", printfinish: 1, materialUsedMm: 1200, materialCostYen: 60 }
      ]}
    };
    // hostname 省略で全ホスト合算
    const result = buildJobCostReport();
    const shared = result.find(r => r.filename === "shared.gcode");
    expect(shared.printCount).toBe(2);
    expect(shared.totalCostYen).toBe(110);
  });

  it("materialCostYen 未設定でも使用量×スプール単価でコスト算出", () => {
    mockMonitorData.filamentSpools = [
      { id: "sp1", costPerMm: 0.05 }   // 0.05円/mm
    ];
    mockMonitorData.machines["host1"] = {
      printStore: { history: [
        { filename: "c.gcode", printfinish: 1, materialUsedMm: 1000, filamentId: "sp1" } // 1000×0.05=50
      ]}
    };
    const result = buildJobCostReport("host1");
    const c = result.find(r => r.filename === "c.gcode");
    expect(c.totalCostYen).toBe(50);
  });
});

describe("buildHostRanking", () => {
  beforeEach(() => {
    mockMonitorData.machines = {};
    mockMonitorData.filamentSpools = [];
  });

  it("空のホストで空配列を返す", () => {
    const result = buildHostRanking();
    expect(result).toHaveLength(0);
  });

  it("累計成功数でランキングする", () => {
    // host1: 成功印刷あり
    mockMonitorData.machines["host1"] = {
      storedData: { hostname: { rawValue: "Printer-1" } },
      printStore: {
        history: [histEntry({ startHoursAgo: 2, endHoursAgo: 1, ok: true, materialMm: 2000 })]
      }
    };
    // host2: 印刷実績なし
    mockMonitorData.machines["host2"] = {
      storedData: { hostname: { rawValue: "Printer-2" } },
      printStore: { history: [] }
    };
    const result = buildHostRanking();
    expect(result).toHaveLength(2);
    expect(result[0].hostname).toBe("host1"); // host1がランク1
    expect(result[0].rank).toBe(1);
    expect(result[0].totalPrintCount).toBe(1);
    expect(result[0].totalMaterialMm).toBe(2000);
    expect(result[1].hostname).toBe("host2");
    expect(result[1].rank).toBe(2);
  });

  it("コスト効率を計算する（materialCostYen 優先）", () => {
    mockMonitorData.machines["host1"] = {
      storedData: { hostname: { rawValue: "P1" } },
      printStore: { history: [
        { printfinish: 1, materialCostYen: 80 },
        { printfinish: 1, materialCostYen: 120 }
      ]}
    };
    const result = buildHostRanking();
    expect(result[0].totalPrintCount).toBe(2);
    expect(result[0].totalCostYen).toBe(200);
    expect(result[0].costPerSuccessPrint).toBe(100); // 200/2
  });
});

describe("buildMaterialReport", () => {
  beforeEach(() => {
    mockMonitorData.machines = {};
    mockMonitorData.filamentSpools = [];
  });

  it("スプールなしで空配列を返す", () => {
    const result = buildMaterialReport();
    expect(result).toHaveLength(0);
  });

  it("素材別に消費量・コストを集計する", () => {
    mockMonitorData.filamentSpools = [
      {
        id: "sp1", brand: "CC3D", material: "PLA+", colorName: "レモンイエロー",
        filamentColor: "#FFDE06", totalLengthMm: 336000, remainingLengthMm: 200000,
        purchasePrice: 1699, costPerMm: 1699/336000, printCount: 5,
        usedLengthLog: [
          { jobId: String(Math.floor(new Date("2026-03-15").getTime()/1000)), used: 50000 },
          { jobId: String(Math.floor(new Date("2026-04-01").getTime()/1000)), used: 86000 }
        ]
      },
      {
        id: "sp2", brand: "CC3D", material: "PLA+", colorName: "レモンイエロー",
        filamentColor: "#FFDE06", totalLengthMm: 336000, remainingLengthMm: 336000,
        purchasePrice: 1699, costPerMm: 1699/336000, printCount: 0,
        usedLengthLog: []
      }
    ];
    const result = buildMaterialReport();
    expect(result).toHaveLength(1); // 同じブランド×素材×色はグループ化
    const pla = result[0];
    expect(pla.brand).toBe("CC3D");
    expect(pla.spoolCount).toBe(2);
    expect(pla.totalConsumedMm).toBe(136000); // (336000-200000) + (336000-336000)
    expect(pla.printCount).toBe(5);
    expect(pla.totalCostYen).toBeGreaterThan(0);
    // 月別推移が存在する
    expect(pla.monthlyTrend.length).toBeGreaterThanOrEqual(1);
  });

  it("削除済みスプールを除外する", () => {
    mockMonitorData.filamentSpools = [
      {
        id: "sp1", brand: "Test", material: "ABS", colorName: "白",
        filamentColor: "#FFF", totalLengthMm: 100000, remainingLengthMm: 50000,
        purchasePrice: 1000, costPerMm: 0.01, printCount: 3,
        usedLengthLog: [], deleted: true, isDeleted: true
      }
    ];
    const result = buildMaterialReport();
    expect(result).toHaveLength(0);
  });

  it("消費量が多い順にソートされる", () => {
    mockMonitorData.filamentSpools = [
      {
        id: "sp1", brand: "A", material: "PLA", colorName: "白",
        filamentColor: "#FFF", totalLengthMm: 100000, remainingLengthMm: 90000,
        purchasePrice: 1000, printCount: 1, usedLengthLog: []
      },
      {
        id: "sp2", brand: "B", material: "PETG", colorName: "黒",
        filamentColor: "#000", totalLengthMm: 100000, remainingLengthMm: 10000,
        purchasePrice: 2000, printCount: 10, usedLengthLog: []
      }
    ];
    const result = buildMaterialReport();
    expect(result).toHaveLength(2);
    expect(result[0].brand).toBe("B"); // PETG 90000mm消費 > PLA 10000mm消費
    expect(result[1].brand).toBe("A");
  });
});
