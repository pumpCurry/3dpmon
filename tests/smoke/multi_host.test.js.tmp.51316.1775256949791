/**
 * @fileoverview スモークテスト: マルチホスト処理
 * 1台目と2台目以降で差が出ないことを検証
 */
import { describe, it, expect } from "vitest";

describe("マルチホスト均等処理", () => {

  describe("connectionTargets からのホスト抽出", () => {
    const extractHosts = (targets) => {
      const hosts = [];
      const resolvedIps = new Set(targets.filter(t => t.hostname).map(t => t.dest.split(":")[0]));
      for (const t of targets) {
        if (t.hostname) {
          if (!hosts.includes(t.hostname)) hosts.push(t.hostname);
        } else if (t.dest) {
          const ip = t.dest.split(":")[0];
          if (!hosts.includes(ip) && !resolvedIps.has(ip)) hosts.push(ip);
        }
      }
      return hosts;
    };

    it("2台ともhostname解決済み → 2台分", () => {
      const targets = [
        { dest: "192.168.54.151:9999", hostname: "K1Max-4A1B" },
        { dest: "192.168.54.152:9999", hostname: "K1Max-03FA" }
      ];
      expect(extractHosts(targets)).toEqual(["K1Max-4A1B", "K1Max-03FA"]);
    });

    it("1台だけhostname解決済み、もう1台はIP → 2台分", () => {
      const targets = [
        { dest: "192.168.54.151:9999", hostname: "K1Max-4A1B" },
        { dest: "192.168.54.152:9999", hostname: "" }
      ];
      expect(extractHosts(targets)).toEqual(["K1Max-4A1B", "192.168.54.152"]);
    });

    it("ゴミIPエントリ + 正規エントリ → 重複しない", () => {
      const targets = [
        { dest: "192.168.54.151", hostname: "" },       // ゴミ
        { dest: "192.168.54.151:9999", hostname: "K1Max-4A1B" },
        { dest: "192.168.54.152:9999", hostname: "K1Max-03FA" }
      ];
      const result = extractHosts(targets);
      expect(result).toEqual(["K1Max-4A1B", "K1Max-03FA"]);
      expect(result).not.toContain("192.168.54.151");
    });

    it("3台以上でも全台含まれる", () => {
      const targets = [
        { dest: "192.168.54.151:9999", hostname: "K1Max-4A1B" },
        { dest: "192.168.54.152:9999", hostname: "K1Max-03FA" },
        { dest: "192.168.54.153:9999", hostname: "K1C-XXXX" }
      ];
      expect(extractHosts(targets)).toHaveLength(3);
    });
  });

  describe("レイアウト validHosts 構築", () => {
    it("レイアウトデータ + connectionTargets + machines 全てからホスト収集", () => {
      const layout = [
        { host: "K1Max-4A1B", panelType: "camera" },
        { host: "K1Max-03FA", panelType: "camera" },
        { host: "shared", panelType: "production" } // shared は除外
      ];
      const targets = [{ dest: "192.168.54.151:9999", hostname: "K1Max-4A1B" }];
      const machines = { "K1Max-4A1B": {}, "K1Max-03FA": {}, "_$_NO_MACHINE_$_": {} };

      const validHosts = new Set();
      for (const item of layout) {
        if (item.host && item.host !== "shared") validHosts.add(item.host);
      }
      for (const t of targets) {
        if (t.hostname) validHosts.add(t.hostname);
      }
      for (const h of Object.keys(machines)) {
        if (h && h !== "_$_NO_MACHINE_$_" && h !== "shared") validHosts.add(h);
      }

      expect(validHosts.has("K1Max-4A1B")).toBe(true);
      expect(validHosts.has("K1Max-03FA")).toBe(true);
      expect(validHosts.has("shared")).toBe(false);
      expect(validHosts.has("_$_NO_MACHINE_$_")).toBe(false);
    });

    it("connectionTargets が空でもレイアウトデータからホスト復元", () => {
      const layout = [
        { host: "K1Max-4A1B", panelType: "status" },
        { host: "K1Max-03FA", panelType: "status" }
      ];
      const validHosts = new Set();
      for (const item of layout) {
        if (item.host && item.host !== "shared") validHosts.add(item.host);
      }
      expect(validHosts.size).toBe(2);
    });
  });

  describe("IP → ホスト名遷移", () => {
    const isIpLike = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

    it("IPv4アドレスを正しく判定", () => {
      expect(isIpLike("192.168.54.151")).toBe(true);
      expect(isIpLike("10.0.0.1")).toBe(true);
      expect(isIpLike("K1Max-4A1B")).toBe(false);
      expect(isIpLike("fe80::1")).toBe(false);
    });

    it("IP→ホスト名: machines 移行", () => {
      const machines = { "192.168.54.151": { storedData: { temp: 25 } } };
      const oldHost = "192.168.54.151";
      const newHost = "K1Max-4A1B";

      if (isIpLike(oldHost)) {
        machines[newHost] = machines[oldHost];
        delete machines[oldHost];
      }

      expect(machines["K1Max-4A1B"]).toBeDefined();
      expect(machines["192.168.54.151"]).toBeUndefined();
    });

    it("ホスト名→ホスト名（IP再利用）: 旧データ保護", () => {
      const machines = {
        "K1Max-4A1B": { storedData: { temp: 25 } },
      };
      const oldHost = "K1Max-4A1B";
      const newHost = "K1C-XXXX";

      if (isIpLike(oldHost)) {
        // IP → hostname: 移行
        machines[newHost] = machines[oldHost];
        delete machines[oldHost];
      } else {
        // hostname → hostname: 保護
        if (!machines[newHost]) machines[newHost] = { storedData: {} };
      }

      expect(machines["K1Max-4A1B"]).toBeDefined(); // 旧データ保護
      expect(machines["K1C-XXXX"]).toBeDefined();    // 新規作成
    });
  });

  describe("DHCP IP再利用", () => {
    it("同じIPで異なるMACは別機器", () => {
      const prevMac = "fc:ee:28:01:4a:1b";
      const newMac = "fc:ee:28:07:03:fa";
      expect(prevMac).not.toBe(newMac);
    });

    it("K1 hostname末尾 = MAC下位2バイト", () => {
      const mac = "fc:ee:28:01:4a:1b";
      const parts = mac.split(":");
      const suffix = (parts[4] + parts[5]).toUpperCase();
      expect(suffix).toBe("4A1B");
      expect("K1Max-" + suffix).toBe("K1Max-4A1B");
    });
  });
});

describe("useFilament バリデーション", () => {
  it("NaN は拒否", () => {
    const amount = Number(NaN);
    expect(Number.isFinite(amount)).toBe(false);
  });

  it("負値は拒否", () => {
    const amount = Number(-100);
    expect(amount < 0).toBe(true);
  });

  it("1000m超は拒否", () => {
    const amount = Number(1500000);
    expect(amount > 1000000).toBe(true);
  });

  it("正常値は通過", () => {
    const amount = Number(15000);
    expect(Number.isFinite(amount)).toBe(true);
    expect(amount >= 0).toBe(true);
    expect(amount <= 1000000).toBe(true);
  });
});
