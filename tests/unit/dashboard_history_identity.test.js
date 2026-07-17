/**
 * @fileoverview dashboard_history_identity.js（#411 完了判定・複合キー・世代fingerprint）単体テスト
 */
import { describe, it, expect } from "vitest";
import {
  isCompletedHistoryEntry, canonicalJobKey, jobObservationKey,
  completedJobObservations, historyGenerationFingerprint, completedJobKeySet
} from "../../3dp_lib/dashboard_history_identity.js";

describe("isCompletedHistoryEntry", () => {
  it("printfinish/ finishTime/endtime/usagetime で完了判定、無ければ未完了", () => {
    expect(isCompletedHistoryEntry({ printfinish: 1 })).toBe(true);
    expect(isCompletedHistoryEntry({ printfinish: 0 })).toBe(true);
    expect(isCompletedHistoryEntry({ endtime: 123 })).toBe(true);
    expect(isCompletedHistoryEntry({ usagetime: 60 })).toBe(true);
    expect(isCompletedHistoryEntry({ printfinish: null })).toBe(false);
    expect(isCompletedHistoryEntry({})).toBe(false);
    expect(isCompletedHistoryEntry(null)).toBe(false);
  });
});

describe("canonicalJobKey（Number化しない・偽ID除外）", () => {
  it("有効IDは文字列のまま、0/空/全ゼロは null", () => {
    expect(canonicalJobKey({ id: "1749700000" })).toBe("1749700000");
    expect(canonicalJobKey("00123")).toBe("00123"); // leading zero 保持
    expect(canonicalJobKey(12345)).toBe("12345");
    expect(canonicalJobKey("0")).toBeNull();
    expect(canonicalJobKey("00")).toBeNull();
    expect(canonicalJobKey("")).toBeNull();
    expect(canonicalJobKey(null)).toBeNull();
  });
  it("2^53 超の巨大IDでも精度を失わない（文字列保持）", () => {
    const big = "900719925474099300001";
    expect(canonicalJobKey(big)).toBe(big);
  });
});

describe("jobObservationKey（複合観測キー）", () => {
  it("id＋開始/完了時刻＋ファイルで同一実行を識別、識別材料の有無を返す", () => {
    const o = jobObservationKey({ id: "1", finishTime: 500, filename: "a.gcode" });
    expect(o.id).toBe("1");
    expect(o.hasDistinguishing).toBe(true);
    expect(o.finishAt).toBe(500);
    // id 同じでも finishTime が違えば別キー（= ID 再利用を区別できる）
    const o2 = jobObservationKey({ id: "1", finishTime: 900, filename: "a.gcode" });
    expect(o2.key).not.toBe(o.key);
  });
  it("id のみ（start=id）は hasDistinguishing=false", () => {
    const o = jobObservationKey({ id: "1000", printfinish: 1 });
    expect(o.hasDistinguishing).toBe(false);
  });
});

describe("completedJobObservations / historyGenerationFingerprint", () => {
  it("completion 時系列で安定ソート・重複排除", () => {
    const hist = [job("3", 300), job("1", 100), job("1", 100), job("2", 200)];
    const obs = completedJobObservations(hist);
    expect(obs.map(o => o.finishAt)).toEqual([100, 200, 300]); // finishAt 昇順・重複排除
  });
  it("fingerprint は時系列（earliest/latest）＋ hash", () => {
    const fp = historyGenerationFingerprint([job("1", 100), job("2", 300)]);
    expect(fp.count).toBe(2);
    expect(fp.earliestAt).toBe(100);
    expect(fp.latestAt).toBe(300);
    expect(typeof fp.hash).toBe("string");
    // 内容が変われば hash も変わる
    const fp2 = historyGenerationFingerprint([job("1", 100), job("2", 999)]);
    expect(fp2.hash).not.toBe(fp.hash);
  });
});

describe("completedJobKeySet（表示用 id 集合）", () => {
  it("重複排除した canonical id 集合", () => {
    expect(completedJobKeySet([job("2", 2), job("1", 1), job("1", 1)])).toEqual(["1", "2"]);
  });
});

/** helper */
function job(id, finishAt) {
  return { id, materialUsedMm: 5000, printfinish: 1, finishTime: finishAt, filename: `f${id}.gcode` };
}
