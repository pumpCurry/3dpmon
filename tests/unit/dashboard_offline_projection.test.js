/**
 * @fileoverview dashboard_offline_projection.js（#411-O3 純粋 projection）の単体テスト
 * O2 continuity candidate から、確定残量を壊さず projectedRemainingMm だけを導出することを検証する。
 */
import { describe, it, expect } from "vitest";

import {
  buildInferredContinuityProjection,
  estimateHistoryEntryUsedMm,
  evaluateCandidateObservationKey
} from "../../3dp_lib/dashboard_offline_projection.js";
import { jobObservationIdentity } from "../../3dp_lib/dashboard_history_identity.js";

const ATTR_CLASS = Object.freeze({
  CONTINUITY_CANDIDATE: "continuity-candidate",
  CONTINUITY_CONTRADICTED: "continuity-contradicted"
});

const BASE = 1_700_000_000_000;

/**
 * 完了履歴 fixture を作る。
 *
 * 【詳細説明】
 * - O1/O2 と同じ複合 observation key を作れるよう、id・開始時刻・完了時刻・ファイル名を固定する。
 * - 帰属済みテストでは filamentInfo / filamentId を後から上書きして使う。
 *
 * @function job
 * @param {string} id - ジョブ ID。
 * @param {number} usedMm - 消費量 mm。
 * @param {number} offsetSec - BASE からの完了時刻差分秒。
 * @param {Object} [over] - 履歴行へ追加するプロパティ。
 * @returns {Object} printStore.history 相当の履歴行。
 */
function job(id, usedMm, offsetSec, over = {}) {
  return {
    id,
    printStartTime: BASE + offsetSec * 1000 - 20_000,
    finishTime: BASE + offsetSec * 1000,
    filename: `plate-${id}.gcode`,
    printfinish: 1,
    materialUsedMm: usedMm,
    ...over
  };
}

/**
 * 履歴行から observation key を返す。
 *
 * @function keyOf
 * @param {Object} entry - 履歴行。
 * @returns {string} 複合 observation key。
 */
function keyOf(entry) {
  return jobObservationIdentity(entry).key;
}

/**
 * continuity-candidate の fixture を作る。
 *
 * @function classification
 * @param {Array<string>} keys - candidate offline observation keys。
 * @param {Object} [over] - 分類結果へ追加するプロパティ。
 * @returns {Object} classifyObservationWindow の戻り値相当。
 */
function classification(keys, over = {}) {
  return {
    classification: ATTR_CLASS.CONTINUITY_CANDIDATE,
    host: "k1",
    windowId: "k1|b1|c2",
    candidate: {
      candidateSpoolId: "S1",
      candidateBaselineIntervalId: "iv1",
      candidateCurrentIntervalId: "iv1",
      offlineObservationKeys: keys,
      windowId: "k1|b1|c2"
    },
    ...over
  };
}

describe("estimateHistoryEntryUsedMm", () => {
  it("materialUsedMm を優先して消費量を返す", () => {
    expect(estimateHistoryEntryUsedMm({ materialUsedMm: "123.4", filamentInfo: [{ usedMm: 999 }] })).toBe(123.4);
  });

  it("materialUsedMm が無い旧履歴では filamentInfo[].usedMm を合算する", () => {
    expect(estimateHistoryEntryUsedMm({ filamentInfo: [{ usedMm: 100 }, { usedMm: "250" }, { usedMm: -1 }] })).toBe(350);
  });

  it("消費量が判定できなければ 0 を返す", () => {
    expect(estimateHistoryEntryUsedMm({ materialUsedMm: "bad" })).toBe(0);
  });
});

describe("evaluateCandidateObservationKey", () => {
  it("未帰属かつ消費量ありなら inferred-debit", () => {
    const entry = job("101", 1200, 101);
    const r = evaluateCandidateObservationKey(keyOf(entry), entry, "S1");
    expect(r.status).toBe("inferred-debit");
    expect(r.usedMm).toBe(1200);
    expect(r.reason).toBe("unattributed-usage");
  });

  it("候補スプールへ確定済みなら confirmed-same-spool（二重減算しない）", () => {
    const entry = job("102", 2200, 102, { filamentInfo: [{ spoolId: "S1", usedMm: 2200 }] });
    const r = evaluateCandidateObservationKey(keyOf(entry), entry, "S1");
    expect(r.status).toBe("confirmed-same-spool");
    expect(r.confirmedSpoolIds).toEqual(["S1"]);
  });

  it("別スプールへ確定済みなら confirmed-other-spool（矛盾）", () => {
    const entry = job("103", 3300, 103, { filamentId: "S2" });
    const r = evaluateCandidateObservationKey(keyOf(entry), entry, "S1");
    expect(r.status).toBe("confirmed-other-spool");
    expect(r.confirmedSpoolIds).toEqual(["S2"]);
  });

  it("履歴から消えた key は unresolved として推定しない", () => {
    const r = evaluateCandidateObservationKey("[\"missing\",0,0,\"\"]", null, "S1");
    expect(r.status).toBe("unresolved");
    expect(r.usedMm).toBe(0);
  });
});

describe("buildInferredContinuityProjection", () => {
  it("未帰属 candidate だけを inferredContinuityUsedMm に集計し projectedRemainingMm を下げる", () => {
    const j1 = job("201", 1000, 201);
    const j2 = job("202", 2500, 202);
    const spool = { id: "S1", remainingLengthMm: 10_000 };

    const before = JSON.parse(JSON.stringify(spool));
    const result = buildInferredContinuityProjection(classification([keyOf(j1), keyOf(j2)]), spool, [j1, j2]);

    expect(result.confirmedRemainingMm).toBe(10_000);
    expect(result.inferredContinuityUsedMm).toBe(3500);
    expect(result.projectedRemainingMm).toBe(6500);
    expect(result.candidateDebits.map(d => d.status)).toEqual(["inferred-debit", "inferred-debit"]);
    expect(result.readOnly).toBe(true);
    expect(spool).toEqual(before);
  });

  it("候補スプールへ確定帰属済みの履歴は projected から除外して二重減算しない", () => {
    const pending = job("301", 1000, 301);
    const confirmed = job("302", 2000, 302, { filamentInfo: [{ spoolId: "S1", usedMm: 2000 }] });
    const result = buildInferredContinuityProjection(
      classification([keyOf(pending), keyOf(confirmed)]),
      { id: "S1", remainingLengthMm: 8000 },
      [pending, confirmed]
    );

    expect(result.inferredContinuityUsedMm).toBe(1000);
    expect(result.projectedRemainingMm).toBe(7000);
    expect(result.candidateDebits.map(d => d.status)).toEqual(["inferred-debit", "confirmed-same-spool"]);
  });

  it("別スプール確定済みは contradiction に分離し projected へ入れない", () => {
    const other = job("401", 4000, 401, { filamentInfo: [{ spoolId: "S2", usedMm: 4000 }] });
    const result = buildInferredContinuityProjection(
      classification([keyOf(other)]),
      { id: "S1", remainingLengthMm: 9000 },
      [other]
    );

    expect(result.inferredContinuityUsedMm).toBe(0);
    expect(result.projectedRemainingMm).toBe(9000);
    expect(result.contradictions).toHaveLength(1);
    expect(result.contradictions[0].reason).toBe("already-confirmed-on-other-spool");
  });

  it("履歴消失と使用量不明は unresolved に分離し projected へ入れない", () => {
    const zero = job("501", 0, 501);
    const result = buildInferredContinuityProjection(
      classification([keyOf(zero), "[\"gone\",0,999,\"\"]"]),
      { id: "S1", remainingLengthMm: 5000 },
      [zero]
    );

    expect(result.inferredContinuityUsedMm).toBe(0);
    expect(result.projectedRemainingMm).toBe(5000);
    expect(result.unresolved.map(d => d.status)).toEqual(["no-usage", "unresolved"]);
  });

  it("continuity-candidate 以外の分類では推定 debit しない", () => {
    const entry = job("601", 1600, 601);
    const result = buildInferredContinuityProjection(
      classification([keyOf(entry)], { classification: ATTR_CLASS.CONTINUITY_CONTRADICTED, candidate: null }),
      { id: "S1", remainingLengthMm: 7000 },
      [entry]
    );

    expect(result.inferredContinuityUsedMm).toBe(0);
    expect(result.candidateDebits).toEqual([]);
    expect(result.projectedRemainingMm).toBe(7000);
  });

  it("projection 対象 spool と candidate spool が違う場合は矛盾として debit しない", () => {
    const entry = job("701", 1600, 701);
    const result = buildInferredContinuityProjection(
      classification([keyOf(entry)]),
      { id: "S2", remainingLengthMm: 7000 },
      [entry]
    );

    expect(result.inferredContinuityUsedMm).toBe(0);
    expect(result.candidateDebits).toEqual([]);
    expect(result.contradictions[0].reason).toBe("projection-spool-mismatch");
    expect(result.projectedRemainingMm).toBe(7000);
  });

  it("推定 debit が確定残量を超えても projectedRemainingMm は 0 未満にしない", () => {
    const entry = job("801", 9000, 801);
    const result = buildInferredContinuityProjection(
      classification([keyOf(entry)]),
      { id: "S1", remainingLengthMm: 1000 },
      [entry]
    );

    expect(result.inferredContinuityUsedMm).toBe(9000);
    expect(result.projectedRemainingMm).toBe(0);
  });
});
