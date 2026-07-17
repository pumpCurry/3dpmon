/**
 * @fileoverview dashboard_history_identity.js（#411 完了判定・複合 identity・世代fingerprint）単体テスト
 */
import { describe, it, expect } from "vitest";
import {
  isCompletedHistoryEntry, canonicalJobKey, jobTemporal, jobObservationIdentity,
  completedJobObservations, historyGenerationFingerprint, completedJobKeySet
} from "../../3dp_lib/dashboard_history_identity.js";

const BASE = 1_700_000_000_000; // epoch ms

describe("isCompletedHistoryEntry", () => {
  it("printfinish 数値/真偽・finishTime/endtime/usagetime で完了判定", () => {
    expect(isCompletedHistoryEntry({ printfinish: 1 })).toBe(true);
    expect(isCompletedHistoryEntry({ printfinish: 0 })).toBe(true);   // 失敗も「完了」
    expect(isCompletedHistoryEntry({ printfinish: false })).toBe(true);
    expect(isCompletedHistoryEntry({ endtime: BASE })).toBe(true);
    expect(isCompletedHistoryEntry({ usagetime: 60 })).toBe(true);
    expect(isCompletedHistoryEntry({ printfinish: null })).toBe(false); // 未完了
    expect(isCompletedHistoryEntry({ printfinish: "" })).toBe(false);   // 曖昧値は完了証拠にしない
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

describe("jobTemporal（P1-1: id を時刻 fallback にしない / P1-3: 単位正規化）", () => {
  it("finishTime(ms)・finishTimeSec(秒→ms)・endtime を epoch ms へ正規化し timeSource を返す", () => {
    expect(jobTemporal({ finishTime: BASE }).finishAt).toBe(BASE);
    expect(jobTemporal({ finishTime: BASE }).timeSource).toBe("finishTime");
    // 秒指定は *1000
    expect(jobTemporal({ finishTimeSec: 1_700_000_000 }).finishAt).toBe(1_700_000_000_000);
    expect(jobTemporal({ finishTimeSec: 1_700_000_000 }).timeSource).toBe("finishTimeSec");
    // 秒レンジの finishTime も自動で ms 化
    expect(jobTemporal({ endtime: 1_700_000_000 }).finishAt).toBe(1_700_000_000_000);
  });
  it("★ id を時刻 fallback にしない（巨大 id でも finishAt は 0/unknown）", () => {
    const t = jobTemporal({ id: "900719925474099300001" });
    expect(t.finishAt).toBe(0);
    expect(t.startAt).toBe(0);
    expect(t.timeSource).toBe("unknown");
  });
  it("単位不明な小さい値は 0（誤って秒/ms 化しない）", () => {
    expect(jobTemporal({ finishTime: 500 }).finishAt).toBe(0);
  });
});

describe("jobObservationIdentity（複合 identity・安全 encode）", () => {
  it("id＋開始/完了時刻＋ファイルで同一実行を識別、id 再利用（別完了時刻）は別キー", () => {
    const o = jobObservationIdentity({ id: "1", finishTime: BASE + 500, filename: "a.gcode" });
    expect(o.canonicalJobId).toBe("1");
    expect(o.hasDistinguishing).toBe(true);
    expect(o.finishAt).toBe(BASE + 500);
    const o2 = jobObservationIdentity({ id: "1", finishTime: BASE + 900, filename: "a.gcode" });
    expect(o2.key).not.toBe(o.key); // 同 id・別完了時刻＝別キー（ID 再利用を区別）
  });
  it("★ P1-2: 区切り文字を含む値でもキー衝突しない（JSON tuple encode）", () => {
    // id や file に '|' を仕込んでも別 identity は別キーのまま
    const a = jobObservationIdentity({ id: "1|2", finishTime: BASE, filename: "3.gcode" });
    const b = jobObservationIdentity({ id: "1", finishTime: BASE, filename: "2|3.gcode" });
    expect(a.key).not.toBe(b.key);
  });
  it("ファイル同一性を正規化（大小・バックスラッシュ・URLエンコード）", () => {
    const a = jobObservationIdentity({ id: "1", finishTime: BASE, filename: "A\\Dir\\File.GCODE" });
    const b = jobObservationIdentity({ id: "1", finishTime: BASE, filename: "a/dir/file.gcode" });
    expect(a.key).toBe(b.key);
  });
  it("識別材料が無い（id のみ）は hasDistinguishing=false", () => {
    const o = jobObservationIdentity({ id: "1000", printfinish: 1 });
    expect(o.hasDistinguishing).toBe(false);
  });
});

describe("completedJobObservations / historyGenerationFingerprint", () => {
  it("completion 時系列で安定ソート・重複排除", () => {
    const hist = [job("3", 300), job("1", 100), job("1", 100), job("2", 200)];
    const obs = completedJobObservations(hist);
    expect(obs.map(o => o.finishAt)).toEqual([BASE + 100000, BASE + 200000, BASE + 300000]);
  });
  it("fingerprint は completion 時系列（earliest/latest）＋順序 hash", () => {
    const fp = historyGenerationFingerprint([job("1", 100), job("2", 300)]);
    expect(fp.completedCount).toBe(2);
    expect(fp.earliestCompletedAt).toBe(BASE + 100000);
    expect(fp.latestCompletedAt).toBe(BASE + 300000);
    expect(typeof fp.retainedHash).toBe("string");
    const fp2 = historyGenerationFingerprint([job("1", 100), job("2", 999)]);
    expect(fp2.retainedHash).not.toBe(fp.retainedHash);
  });
});

describe("completedJobKeySet（表示用 id 集合）", () => {
  it("重複排除した canonical id 集合", () => {
    expect(completedJobKeySet([job("2", 2), job("1", 1), job("1", 1)])).toEqual(["1", "2"]);
  });
});

/** helper: t は基準からの相対秒 */
function job(id, t) {
  return { id, materialUsedMm: 5000, printfinish: 1, finishTime: BASE + t * 1000, filename: `f${id}.gcode` };
}
