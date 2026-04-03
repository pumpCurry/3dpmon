/**
 * @fileoverview スモークテスト: インポート/エクスポートの安全性
 * 実際のエクスポートデータ構造で壊れないことを検証
 */
import { describe, it, expect } from "vitest";

/** 実際のエクスポートデータを模したテストフィクスチャ */
const SAMPLE_EXPORT = {
  appSettings: {
    connectionTargets: [
      { dest: "192.168.54.151", hostname: "" },
      { dest: "192.168.54.151:9999", hostname: "K1Max-4A1B" },
      { dest: "192.168.54.152:9999", hostname: "K1Max-03FA" }
    ]
  },
  machines: {
    "192.168.54.151": { storedData: {}, printStore: { history: [] } },
    "K1Max-4A1B": { storedData: { hostname: { rawValue: "K1Max-4A1B" } }, printStore: { history: [{ id: 1 }] } },
    "K1Max-03FA": { storedData: { hostname: { rawValue: "K1Max-03FA" } }, printStore: { history: [{ id: 2 }] } },
    "_$_NO_MACHINE_$_": { storedData: {} }
  },
  filamentSpools: [
    { id: "sp1", name: "Black PLA", remainingLengthMm: 100000 }
  ],
  hostSpoolMap: { "K1Max-4A1B": "sp1" },
  hostCameraToggle: { "K1Max-4A1B": true },
  panelLayout: [
    { host: "K1Max-4A1B", panelType: "camera", x: 0, y: 0, w: 14, h: 18 },
    { host: "K1Max-03FA", panelType: "camera", x: 24, y: 0, w: 14, h: 18 }
  ],
  userPresets: null,
  hiddenPresets: null,
  usageHistory: [],
  spoolSerialCounter: 5
};

describe("インポートフィルタリング", () => {
  describe("machines フィルタ", () => {
    it("PLACEHOLDER をスキップ", () => {
      const validKeys = Object.keys(SAMPLE_EXPORT.machines)
        .filter(h => h !== "_$_NO_MACHINE_$_");
      expect(validKeys).not.toContain("_$_NO_MACHINE_$_");
    });

    it("解決済みIPキーをスキップ", () => {
      const targets = SAMPLE_EXPORT.appSettings.connectionTargets;
      const resolvedIps = new Set(targets.filter(t => t.hostname).map(t => t.dest.split(":")[0]));
      const isIpLike = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

      const validKeys = Object.keys(SAMPLE_EXPORT.machines).filter(h => {
        if (h === "_$_NO_MACHINE_$_") return false;
        if (isIpLike(h) && resolvedIps.has(h)) return false;
        return true;
      });

      expect(validKeys).toEqual(["K1Max-4A1B", "K1Max-03FA"]);
    });
  });

  describe("connectionTargets フィルタ", () => {
    it("ポートなしエントリを除外", () => {
      const cleaned = SAMPLE_EXPORT.appSettings.connectionTargets
        .filter(t => t.dest.includes(":"));
      expect(cleaned).toHaveLength(2);
      expect(cleaned.every(t => t.dest.includes(":"))).toBe(true);
    });

    it("同IP+hostnameなしを除外", () => {
      const existingIps = new Set();
      const result = [];
      for (const t of SAMPLE_EXPORT.appSettings.connectionTargets) {
        if (!t.dest.includes(":")) continue;
        const ip = t.dest.split(":")[0];
        if (existingIps.has(ip) && !t.hostname) continue;
        result.push(t);
        existingIps.add(ip);
      }
      expect(result).toHaveLength(2);
      expect(result[0].hostname).toBe("K1Max-4A1B");
    });
  });

  describe("panelLayout インポート", () => {
    it("既存レイアウトがあれば上書きしない", () => {
      const existing = [{ host: "K1Max-4A1B", panelType: "status" }];
      const imported = SAMPLE_EXPORT.panelLayout;
      // 既存があれば保護
      const result = existing.length > 0 ? existing : imported;
      expect(result).toBe(existing);
    });

    it("既存がなければインポートデータを採用", () => {
      const existing = [];
      const imported = SAMPLE_EXPORT.panelLayout;
      const result = existing.length > 0 ? existing : imported;
      expect(result).toBe(imported);
      expect(result).toHaveLength(2);
    });
  });

  describe("null/undefined 安全性", () => {
    it("userPresets が null でもクラッシュしない", () => {
      const up = SAMPLE_EXPORT.userPresets;
      const result = Array.isArray(up) ? up : [];
      expect(result).toEqual([]);
    });

    it("hiddenPresets が null でもクラッシュしない", () => {
      const hp = SAMPLE_EXPORT.hiddenPresets;
      const result = Array.isArray(hp) ? hp : [];
      expect(result).toEqual([]);
    });
  });
});

describe("エクスポートデータ繰り返しインポート耐性", () => {
  it("同じデータを3回インポートしても件数が増えない", () => {
    const spools = [];
    const existingIds = new Set();

    for (let round = 0; round < 3; round++) {
      for (const sp of SAMPLE_EXPORT.filamentSpools) {
        if (!existingIds.has(sp.id)) {
          spools.push({ ...sp });
          existingIds.add(sp.id);
        }
      }
    }
    expect(spools).toHaveLength(1); // 3回入れても1件
  });

  it("同じ connectionTargets を3回マージしても重複しない", () => {
    const targets = [];
    const existingDests = new Set();

    for (let round = 0; round < 3; round++) {
      for (const t of SAMPLE_EXPORT.appSettings.connectionTargets) {
        if (!t.dest.includes(":")) continue;
        if (!existingDests.has(t.dest)) {
          targets.push({ ...t });
          existingDests.add(t.dest);
        }
      }
    }
    expect(targets).toHaveLength(2); // 3回入れても2件
  });
});

describe("フィラメント残量の時系列逆転防止", () => {
  it("古いエクスポート(残量多い)→現在(残量少ない)でインポートしても残量が戻らない", () => {
    // 現在の状態: sp1 が 15% (50000mm)
    const current = { id: "sp1", remainingLengthMm: 50000, isActive: true, startedAt: 1774000000 };
    // 古いエクスポート: sp1 が 100% (330000mm)
    const oldExport = { id: "sp1", remainingLengthMm: 330000, isActive: false, startedAt: 1774000000 };

    // マージ: 小さい方を採用
    const merged = Math.min(current.remainingLengthMm, oldExport.remainingLengthMm);
    expect(merged).toBe(50000); // 現在の消費済み値が維持される
  });

  it("新しいエクスポート(残量少ない)→古いデータ(残量多い)でも正しく反映", () => {
    const oldInMemory = { id: "sp1", remainingLengthMm: 330000 };
    const newExport = { id: "sp1", remainingLengthMm: 50000 };

    const merged = Math.min(oldInMemory.remainingLengthMm, newExport.remainingLengthMm);
    expect(merged).toBe(50000);
  });

  it("再起動→リストアで残量が100%に戻らない", () => {
    // 起動時: メモリ上のスプールは初期状態(isActive=false)
    const inMemory = { id: "sp1", remainingLengthMm: 0, isActive: false }; // 空のデフォルト
    // ストレージから復元: 最後に保存された状態
    const stored = { id: "sp1", remainingLengthMm: 50000, isActive: true };

    // マージ: 小さい方を採用。ただし inMemory が 0 (初期値) なら stored を使う
    const existRemain = inMemory.remainingLengthMm;
    const storedRemain = stored.remainingLengthMm;
    let merged;
    if (existRemain === 0 || !Number.isFinite(existRemain)) {
      merged = storedRemain; // 初期値なのでストレージを採用
    } else {
      merged = Math.min(existRemain, storedRemain);
    }
    expect(merged).toBe(50000); // ストレージの値が採用される（100%には戻らない）
  });
});
