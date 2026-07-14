/**
 * @fileoverview dashboard_time.js（時計の用途分離 境界モジュール）の単体テスト
 */
import { describe, it, expect } from "vitest";
import {
  wallNowMs, monotonicNowMs, resolvedLocalTimeZone,
  dateKey, monthKey, parseInstantStrict, shiftDateKey, epochMsFromWallClock
} from "../../3dp_lib/dashboard_time.js";

describe("dashboard_time", () => {
  it("wallNowMs は epoch ミリ秒（数値・現在付近）", () => {
    const t = wallNowMs();
    expect(typeof t).toBe("number");
    expect(t).toBeGreaterThan(1_600_000_000_000);
  });

  it("monotonicNowMs は数値で単調非減少", () => {
    const a = monotonicNowMs();
    const b = monotonicNowMs();
    expect(typeof a).toBe("number");
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it("resolvedLocalTimeZone は文字列を返す", () => {
    expect(typeof resolvedLocalTimeZone()).toBe("string");
  });

  describe("dateKey / monthKey（明示IANAゾーン）", () => {
    // 2026-07-15 00:30 JST = 2026-07-14 15:30 UTC = 2026-07-14 08:30 LA(PDT)
    const epoch = Date.parse("2026-07-15T00:30:00+09:00");

    it("Asia/Tokyo では当日", () => {
      expect(dateKey(epoch, "Asia/Tokyo")).toBe("2026-07-15");
      expect(monthKey(epoch, "Asia/Tokyo")).toBe("2026-07");
    });
    it("UTC では前日", () => {
      expect(dateKey(epoch, "UTC")).toBe("2026-07-14");
    });
    it("America/Los_Angeles では前日", () => {
      expect(dateKey(epoch, "America/Los_Angeles")).toBe("2026-07-14");
    });
    it("月末→翌月の境界（JST 2026-08-01 00:30 は UTC では 07-31）", () => {
      const e2 = Date.parse("2026-08-01T00:30:00+09:00");
      expect(monthKey(e2, "Asia/Tokyo")).toBe("2026-08");
      expect(monthKey(e2, "UTC")).toBe("2026-07");
    });
  });

  describe("parseInstantStrict（epoch数値 / Z・offset付きISOのみ）", () => {
    it("epoch 数値はそのまま", () => {
      expect(parseInstantStrict(1784000000000)).toBe(1784000000000);
    });
    it("Z 付き ISO を受理", () => {
      expect(parseInstantStrict("2026-04-01T10:00:00.000Z")).toBe(Date.parse("2026-04-01T10:00:00.000Z"));
    });
    it("オフセット付き ISO を受理", () => {
      expect(parseInstantStrict("2026-04-01T10:00:00+09:00")).toBe(Date.parse("2026-04-01T10:00:00+09:00"));
    });
    it("タイムゾーンなし文字列は曖昧なので null", () => {
      expect(parseInstantStrict("2026-04-01")).toBeNull();
      expect(parseInstantStrict("2026-04-01T10:00:00")).toBeNull();
    });
    it("null/不正値は null", () => {
      expect(parseInstantStrict(null)).toBeNull();
      expect(parseInstantStrict(undefined)).toBeNull();
      expect(parseInstantStrict(NaN)).toBeNull();
      expect(parseInstantStrict("not-a-date")).toBeNull();
    });
    it("完全なISO形式でない offset 付き文字列も弾く（P2 厳格化）", () => {
      expect(parseInstantStrict("2026-04-01 10:00:00+09:00")).toBeNull(); // T 無し(スペース)
      expect(parseInstantStrict("garbage+09:00")).toBeNull();
    });
  });

  describe("shiftDateKey（DST安全なカレンダー日減算）", () => {
    it("単純な前日/翌日", () => {
      expect(shiftDateKey("2026-07-15", -1)).toBe("2026-07-14");
      expect(shiftDateKey("2026-07-15", 1)).toBe("2026-07-16");
    });
    it("月/年の境界を跨ぐ", () => {
      expect(shiftDateKey("2026-03-01", -1)).toBe("2026-02-28");
      expect(shiftDateKey("2026-01-01", -1)).toBe("2025-12-31");
    });
    it("うるう年 2/29", () => {
      expect(shiftDateKey("2028-03-01", -1)).toBe("2028-02-29");
    });
    it("DST開始日(LA 2026-03-08)を跨いでもカレンダー日で減算する", () => {
      // 24時間減算だと 3/8 を飛ばすが、shiftDateKey は必ず 3/8 を返す
      expect(shiftDateKey("2026-03-09", -1)).toBe("2026-03-08");
      expect(shiftDateKey("2026-03-08", -1)).toBe("2026-03-07");
    });
  });

  describe("epochMsFromWallClock（旧履歴の明示ゾーン移行）", () => {
    it("壁時計文字列を指定ゾーンの実時刻へ変換", () => {
      // JST 10:00 は UTC 01:00
      expect(epochMsFromWallClock("2026-04-01T10:00:00", "Asia/Tokyo"))
        .toBe(Date.parse("2026-04-01T10:00:00+09:00"));
      // UTC ゾーンなら そのまま UTC
      expect(epochMsFromWallClock("2026-04-01T10:00:00", "UTC"))
        .toBe(Date.parse("2026-04-01T10:00:00Z"));
    });
    it("offset/Z 付きや不正形式は null（本関数は offset なし専用）", () => {
      expect(epochMsFromWallClock("2026-04-01T10:00:00+09:00", "Asia/Tokyo")).toBeNull();
      expect(epochMsFromWallClock("2026-04-01", "UTC")).toBeNull();
    });
  });
});
