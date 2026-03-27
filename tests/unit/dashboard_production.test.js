/**
 * @fileoverview dashboard_production.js の単体テスト
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// monitorData モック
const mockMonitorData = {
  machines: {}
};

vi.doMock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: mockMonitorData,
  PLACEHOLDER_HOSTNAME: "_$_NO_MACHINE_$_"
}));

const {
  buildHostUtilization,
  buildDailyProductionReport,
  buildEstimateVsActual,
  buildFleetSummary
} = await import("../../3dp_lib/dashboard_production.js");

/** ヘルパー: エポック秒を生成 */
function epochSec(hoursAgo) {
  return Math.floor((Date.now() - hoursAgo * 3600000) / 1000);
}

describe("buildHostUtilization", () => {
  beforeEach(() => {
    mockMonitorData.machines = {};
  });

  it("空の履歴で稼働率0%を返す", () => {
    mockMonitorData.machines["host1"] = {
      storedData: { hostname: { rawValue: "K1Max-1" } },
      historyList: []
    };
    const result = buildHostUtilization("host1");
    expect(result.utilizationPct).toBe(0);
    expect(result.printCount).toBe(0);
    expect(result.displayName).toBe("K1Max-1");
  });

  it("成功した印刷の稼働率を正しく計算", () => {
    const start = epochSec(2);  // 2時間前開始
    const end = epochSec(1);    // 1時間前完了 → 1時間印刷
    mockMonitorData.machines["host1"] = {
      storedData: { hostname: { rawValue: "K1Max-1" } },
      historyList: [{
        startTime: start,
        endtime: end,
        printProgress: 100,
        filamentInfo: [{ length: 5000, materialName: "PLA" }]
      }]
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
    const start = epochSec(3);
    const end = epochSec(2.5);
    mockMonitorData.machines["host1"] = {
      storedData: {},
      historyList: [{
        startTime: start,
        endtime: end,
        printProgress: 35,
        filamentInfo: []
      }]
    };
    const result = buildHostUtilization("host1");
    expect(result.printCount).toBe(1);
    expect(result.successCount).toBe(0);
    expect(result.failCount).toBe(1);
  });

  it("期間外の印刷を除外", () => {
    const oldStart = epochSec(48); // 2日前
    const oldEnd = epochSec(47);
    mockMonitorData.machines["host1"] = {
      storedData: {},
      historyList: [{
        startTime: oldStart,
        endtime: oldEnd,
        printProgress: 100,
        filamentInfo: []
      }]
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
    const start = epochSec(1);
    const end = epochSec(0.5);
    mockMonitorData.machines["host1"] = {
      historyList: [{
        startTime: start,
        endtime: end,
        printProgress: 100,
        filamentInfo: [{ length: 3000 }]
      }]
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
    const start = epochSec(1);
    const end = epochSec(0.5);
    mockMonitorData.machines["host1"] = {
      historyList: [{
        startTime: start, endtime: end, printProgress: 100, filamentInfo: []
      }]
    };
    mockMonitorData.machines["host2"] = {
      historyList: [{
        startTime: start, endtime: end, printProgress: 100, filamentInfo: []
      }]
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

  it("予定vs実績の差分を計算", () => {
    mockMonitorData.machines["host1"] = {
      historyList: [
        {
          filename: "/data/gcode/test.gcode",
          startTime: epochSec(2),
          endtime: epochSec(1), // 実績: 3600秒
          printProgress: 100,
          usagetime: 3000 // 見積: 3000秒
        },
        {
          filename: "/data/gcode/test.gcode",
          startTime: epochSec(5),
          endtime: epochSec(4), // 実績: 3600秒
          printProgress: 100,
          usagetime: 3000
        }
      ]
    };
    const result = buildEstimateVsActual("host1");
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe("test.gcode");
    expect(result[0].printCount).toBe(2);
    expect(result[0].estimatedSec).toBe(3000);
    expect(result[0].actualAvgSec).toBe(3600);
    expect(result[0].diffPct).toBe(20.0); // 20%超過
  });

  it("空の履歴で空配列を返す", () => {
    mockMonitorData.machines["host1"] = { historyList: [] };
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
        historyList: [{
          startTime: epochSec(2),
          endtime: epochSec(1),
          printProgress: 100,
          filamentInfo: [{ length: 1000 }]
        }]
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
      historyList: []
    };
    mockMonitorData.machines["real-host"] = {
      storedData: { hostname: { rawValue: "Real" } },
      historyList: []
    };
    const result = buildFleetSummary();
    expect(result.totalHosts).toBe(1);
  });
});
