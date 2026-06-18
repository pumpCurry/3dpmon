/**
 * @fileoverview dashboard_filament_ledger.js の単体テスト（ADR-0004）
 *
 * 残量 remainingLengthMm を「mountHistory + printStore.history[].materialUsedMm」から
 * 冪等に再計算する純関数群を検証する。
 *
 * monitorData は dashboard_production.test.js と同じ手法で vi.doMock してモックする。
 * 時刻は引数で渡す設計（Date.now/Math.random 不使用）なので決定論的に検証できる。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// monitorData モック
const mockMonitorData = {
  machines: {},
  filamentSpools: [],
  usageHistory: [],
  mountHistory: [],
  hostSpoolMap: {},
  filamentEventContext: {}
};

vi.doMock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: mockMonitorData,
  PLACEHOLDER_HOSTNAME: "_$_NO_MACHINE_$_"
}));

const {
  appendMountEvent,
  appendUnmountEvent,
  attributedUsed,
  getSpoolIntervals,
  deriveSpoolRemaining,
  reconcileSpool,
  recomputeSpoolFromManualEdit,
  initLedgerAnchors,
  recordFilamentEvent,
  getOpenFilamentEvent,
  resolveFilamentEvent,
  runoutGateHeld
} = await import("../../3dp_lib/dashboard_filament_ledger.js");

/**
 * ヘルパー: printStore.history エントリ（parse 後スキーマ）を生成。
 * @param {number} id - printId（= 開始 epoch 秒）
 * @param {number} usedMm - materialUsedMm
 * @param {Object} [extra] - 追加フィールド（filamentInfo, printfinish 等）
 */
function job(id, usedMm, extra = {}) {
  return {
    id,
    materialUsedMm: usedMm,
    printfinish: extra.printfinish ?? (usedMm > 0 ? 1 : 0),
    ...extra
  };
}

/** ヘルパー: ホストに printStore.history をセット */
function setHistory(host, entries) {
  mockMonitorData.machines[host] = { printStore: { history: entries } };
}

/** ヘルパー: スプールを登録 */
function addSpool(sp) {
  mockMonitorData.filamentSpools.push(sp);
  return sp;
}

function reset() {
  mockMonitorData.machines = {};
  mockMonitorData.filamentSpools = [];
  mockMonitorData.usageHistory = [];
  mockMonitorData.mountHistory = [];
  mockMonitorData.hostSpoolMap = {};
  mockMonitorData.filamentEventContext = {};
}

// =====================================================================
// 1. attributedUsed
// =====================================================================
describe("attributedUsed", () => {
  it("単一スプールジョブ（filamentInfo なし）→ materialUsedMm を帰属", () => {
    expect(attributedUsed(job(100, 5000), "sp1")).toBe(5000);
  });

  it("filamentInfo 複数スプール → 当該 spoolId の usedMm を帰属", () => {
    const j = job(100, 7000, {
      filamentInfo: [
        { spoolId: "sp1", usedMm: 3000 },
        { spoolId: "sp2", usedMm: 4000 }
      ]
    });
    expect(attributedUsed(j, "sp1")).toBe(3000);
    expect(attributedUsed(j, "sp2")).toBe(4000);
  });

  it("該当スプールが filamentInfo（複数）に無い → 0", () => {
    const j = job(100, 7000, {
      filamentInfo: [
        { spoolId: "sp1", usedMm: 3000 },
        { spoolId: "sp2", usedMm: 4000 }
      ]
    });
    expect(attributedUsed(j, "sp9")).toBe(0);
  });

  it("filamentInfo が当該 spoolId のみ（usedMm 欠落）→ materialUsedMm フォールバック", () => {
    const j = job(100, 5000, { filamentInfo: [{ spoolId: "sp1" }] });
    expect(attributedUsed(j, "sp1")).toBe(5000);
  });

  it("null ジョブ → 0", () => {
    expect(attributedUsed(null, "sp1")).toBe(0);
  });
});

// =====================================================================
// 2. deriveSpoolRemaining 冪等性
// =====================================================================
describe("deriveSpoolRemaining 冪等性", () => {
  beforeEach(reset);

  it("同入力で10回呼んで同値（純アンカー）", () => {
    addSpool({ id: "sp1", totalLengthMm: 100000, remainingLengthMm: 0 });
    setHistory("hostA", [job(10, 20000), job(20, 30000)]);
    appendMountEvent({ host: "hostA", spoolId: "sp1", anchorRemainingMm: 100000, sinceJobId: 0, ts: 1000 });

    const first = deriveSpoolRemaining("sp1");
    for (let i = 0; i < 10; i++) {
      const r = deriveSpoolRemaining("sp1");
      expect(r.remainingMm).toBe(first.remainingMm);
      expect(r.usedMm).toBe(first.usedMm);
      expect(r.mode).toBe(first.mode);
      expect(r.verified).toBe(first.verified);
    }
    // anchor(100000) - (20000+30000) = 50000
    expect(first.remainingMm).toBe(50000);
    expect(first.mode).toBe("anchor");
  });
});

// =====================================================================
// 3. 複数区間（A→B→A 再装着）で各区間のジョブのみ計上
// =====================================================================
describe("複数区間（A→B→A 再装着）", () => {
  beforeEach(reset);

  it("再装着スプール A は自分の2区間のジョブのみ計上", () => {
    // A 装着(since=0) → ジョブ10,20 → A 取外し(until=20) → B → A 再装着(since=30) → ジョブ40
    addSpool({ id: "A", totalLengthMm: 100000, remainingLengthMm: 0 });
    addSpool({ id: "B", totalLengthMm: 100000, remainingLengthMm: 0 });
    setHistory("h", [job(10, 5000), job(20, 6000), job(30, 7000), job(40, 8000)]);

    appendMountEvent({ host: "h", spoolId: "A", anchorRemainingMm: 100000, sinceJobId: 0, ts: 100 });
    appendUnmountEvent({ host: "h", spoolId: "A", untilJobId: 20, ts: 200 });
    appendMountEvent({ host: "h", spoolId: "B", anchorRemainingMm: 100000, sinceJobId: 20, ts: 300 });
    appendUnmountEvent({ host: "h", spoolId: "B", untilJobId: 30, ts: 400 });
    appendMountEvent({ host: "h", spoolId: "A", anchorRemainingMm: 89000, sinceJobId: 30, ts: 500 });

    const ivA = getSpoolIntervals("A");
    expect(ivA).toHaveLength(2);
    expect(ivA[0]).toMatchObject({ sinceJobId: 0, untilJobId: 20 });
    expect(ivA[1]).toMatchObject({ sinceJobId: 30, untilJobId: null });

    // 純アンカー: 最新区間（区間2 since=30 open, anchor=89000）だけを使う。
    // 区間2 のジョブは job40(8000) のみ（job30 は B 区間）。derive = 89000 - 8000 = 81000。
    // usedMm は最新区間ぶんのみ = 8000（過去区間 job10/20 は再計算しない）。
    const rA = deriveSpoolRemaining("A");
    expect(rA.usedMm).toBe(8000);
    expect(rA.remainingMm).toBe(81000);
    expect(rA.mode).toBe("anchor");

    // B: 最新（唯一）区間 since=20..until=30, anchor=100000。job30(7000) のみ。
    // derive = 100000 - 7000 = 93000。
    const rB = deriveSpoolRemaining("B");
    expect(rB.usedMm).toBe(7000);
    expect(rB.remainingMm).toBe(93000);
  });
});

// =====================================================================
// 4. printId > sinceJobId 厳密境界
// =====================================================================
describe("printId > sinceJobId 厳密境界", () => {
  beforeEach(reset);

  it("sinceJobId と同値のジョブは計上しない", () => {
    addSpool({ id: "sp1", totalLengthMm: 100000, remainingLengthMm: 0 });
    // job id=50 は sinceJobId=50 と同値 → 除外。job id=51 のみ計上。
    setHistory("h", [job(50, 9999), job(51, 4000)]);
    appendMountEvent({ host: "h", spoolId: "sp1", anchorRemainingMm: 40000, sinceJobId: 50, ts: 100 });

    const r = deriveSpoolRemaining("sp1");
    expect(r.usedMm).toBe(4000); // job50 は計上されない
  });
});

// =====================================================================
// 5. オフラインギャップ：last-known 以降の複数ジョブを Σ で計上（件数非依存）
// =====================================================================
describe("オフラインギャップ（件数非依存）", () => {
  beforeEach(reset);

  it("1件のギャップ", () => {
    addSpool({ id: "sp1", totalLengthMm: 100000, remainingLengthMm: 0 });
    setHistory("h", [job(10, 3000)]);
    appendMountEvent({ host: "h", spoolId: "sp1", anchorRemainingMm: 100000, sinceJobId: 0, ts: 100 });
    expect(deriveSpoolRemaining("sp1").usedMm).toBe(3000);
  });

  it("3件のギャップ → 全て合計（累積減算ではなく総和）", () => {
    addSpool({ id: "sp1", totalLengthMm: 100000, remainingLengthMm: 0 });
    setHistory("h", [job(10, 3000), job(11, 4000), job(12, 5000)]);
    appendMountEvent({ host: "h", spoolId: "sp1", anchorRemainingMm: 100000, sinceJobId: 0, ts: 100 });
    const r = deriveSpoolRemaining("sp1");
    expect(r.usedMm).toBe(12000);
    expect(r.remainingMm).toBe(88000);
  });
});

// =====================================================================
// 6. 被覆ギャップ(F2)：history 最古 printId > sinceJobId → verified=false かつ過剰減算しない
// =====================================================================
describe("被覆ギャップ F2", () => {
  beforeEach(reset);

  it("history 最古 printId が sinceJobId より新しい → verified=false（remaining はアンカー基準）", () => {
    // 装着 since=100 だが history 最古は id=500（O=500 > 100+1）→ 取りこぼし疑い
    addSpool({ id: "sp1", totalLengthMm: 100000, remainingLengthMm: 60000 });
    setHistory("h", [job(500, 4000), job(600, 5000)]);
    appendMountEvent({ host: "h", spoolId: "sp1", anchorRemainingMm: 50000, sinceJobId: 100, ts: 100 });

    const r = deriveSpoolRemaining("sp1");
    expect(r.verified).toBe(false);
    expect(r.mode).toBe("anchor");
    // anchor(50000) - 区間 used(4000+5000=9000) = 41000（total から全引きの過剰減算をしない）
    expect(r.remainingMm).toBe(41000);
  });

  it("since=0（ブートストラップ全history基準）は O>1 でも verified=true", () => {
    addSpool({ id: "sp1", totalLengthMm: 100000, remainingLengthMm: 0 });
    setHistory("h", [job(500, 4000), job(600, 5000)]);
    appendMountEvent({ host: "h", spoolId: "sp1", anchorRemainingMm: 100000, sinceJobId: 0, ts: 100 });

    const r = deriveSpoolRemaining("sp1");
    expect(r.verified).toBe(true);
    expect(r.mode).toBe("anchor");
    // anchor(100000) - (4000+5000) = 91000
    expect(r.remainingMm).toBe(91000);
  });
});

// =====================================================================
// 7. 純アンカー: total ではなく anchor を基点にする（被覆状態に依存しない）
// =====================================================================
describe("純アンカー（total ではなく anchor 基点）", () => {
  beforeEach(reset);

  it("anchor < total でも total ではなく anchor から引く", () => {
    // anchor=90000（total=100000 より小）。total 基準なら 90000、anchor 基準なら 80000。
    addSpool({ id: "sp1", totalLengthMm: 100000, remainingLengthMm: 0 });
    setHistory("h", [job(10, 10000)]);
    appendMountEvent({ host: "h", spoolId: "sp1", anchorRemainingMm: 90000, sinceJobId: 0, ts: 100 });
    const r = deriveSpoolRemaining("sp1");
    expect(r.mode).toBe("anchor");
    expect(r.remainingMm).toBe(80000); // anchor(90000) - 10000（total 基準の 90000 ではない）
  });

  it("被覆ギャップでも anchor 基準（過剰減算しない）", () => {
    addSpool({ id: "sp1", totalLengthMm: 100000, remainingLengthMm: 0 });
    setHistory("h", [job(900, 10000)]);
    appendMountEvent({ host: "h", spoolId: "sp1", anchorRemainingMm: 50000, sinceJobId: 100, ts: 100 });
    const r = deriveSpoolRemaining("sp1");
    expect(r.mode).toBe("anchor");
    expect(r.remainingMm).toBe(40000); // anchor - 10000
  });
});

// =====================================================================
// 8. reconcileSpool が印刷中スプールを触らない
// =====================================================================
describe("reconcileSpool 印刷中スキップ", () => {
  beforeEach(reset);

  it("currentPrintID あり → 残量を変更しない", () => {
    const sp = addSpool({
      id: "sp1", totalLengthMm: 100000, remainingLengthMm: 33333,
      currentPrintID: "999"
    });
    setHistory("h", [job(10, 5000)]);
    appendMountEvent({ host: "h", spoolId: "sp1", anchorRemainingMm: 100000, sinceJobId: 0, ts: 100 });

    const res = reconcileSpool("sp1", { ts: 12345 });
    expect(res.skipped).toBe(true);
    expect(sp.remainingLengthMm).toBe(33333); // 不変
  });

  it("非印刷スプール → 残量と updatedAt を更新", () => {
    const sp = addSpool({ id: "sp1", totalLengthMm: 100000, remainingLengthMm: 0 });
    setHistory("h", [job(10, 5000)]);
    appendMountEvent({ host: "h", spoolId: "sp1", anchorRemainingMm: 100000, sinceJobId: 0, ts: 100 });

    const res = reconcileSpool("sp1", { ts: 67890 });
    expect(res.skipped).toBeFalsy();
    expect(sp.remainingLengthMm).toBe(95000);
    expect(sp.updatedAt).toBe(67890);
    expect(sp._remainingVerified).toBe(true);
  });

  it("ts 省略時は updatedAt を触らない", () => {
    const sp = addSpool({ id: "sp1", totalLengthMm: 100000, remainingLengthMm: 0, updatedAt: 111 });
    setHistory("h", [job(10, 5000)]);
    appendMountEvent({ host: "h", spoolId: "sp1", anchorRemainingMm: 100000, sinceJobId: 0, ts: 100 });
    reconcileSpool("sp1");
    expect(sp.updatedAt).toBe(111);
  });
});

// =====================================================================
// 9. ライブオーバーレイ：liveUsedMm 指定時の追加減算
// =====================================================================
describe("ライブオーバーレイ", () => {
  beforeEach(reset);

  it("liveUsedMm を残量からさらに引く", () => {
    addSpool({ id: "sp1", totalLengthMm: 100000, remainingLengthMm: 0 });
    setHistory("h", [job(10, 5000)]);
    appendMountEvent({ host: "h", spoolId: "sp1", anchorRemainingMm: 100000, sinceJobId: 0, ts: 100 });

    const base = deriveSpoolRemaining("sp1");
    expect(base.remainingMm).toBe(95000);
    const withLive = deriveSpoolRemaining("sp1", { liveUsedMm: 1200 });
    expect(withLive.remainingMm).toBe(95000 - 1200);
  });

  it("liveUsedMm は 0 未満にクランプ", () => {
    addSpool({ id: "sp1", totalLengthMm: 100000, remainingLengthMm: 0 });
    setHistory("h", [job(10, 99000)]);
    appendMountEvent({ host: "h", spoolId: "sp1", anchorRemainingMm: 100000, sinceJobId: 0, ts: 100 });
    const r = deriveSpoolRemaining("sp1", { liveUsedMm: 5000 });
    expect(r.remainingMm).toBe(0);
  });
});

// =====================================================================
// 10. レガシー fallback 廃止：mountHistory が無ければ区間 [] / 現在値維持
// =====================================================================
describe("レガシー fallback 廃止（純アンカー）", () => {
  beforeEach(reset);

  it("mountHistory 無し → getSpoolIntervals は [] を返す（startPrintID から捏造しない）", () => {
    addSpool({
      id: "sp1", totalLengthMm: 100000, remainingLengthMm: 0,
      hostname: "h", startPrintID: "50", startLength: 80000
    });
    setHistory("h", [job(40, 1000), job(60, 7000)]);

    const iv = getSpoolIntervals("sp1");
    expect(iv).toEqual([]);
  });

  it("printIdRanges があっても区間を捏造しない（[] のまま）", () => {
    addSpool({
      id: "sp1", totalLengthMm: 100000, remainingLengthMm: 0,
      hostname: "h", startPrintID: "10", startLength: 100000,
      printIdRanges: [
        { startPrintID: "10", endPrintID: "20" },
        { startPrintID: "30", endPrintID: null }
      ]
    });
    setHistory("h", [job(15, 5000), job(25, 9999), job(35, 6000)]);

    expect(getSpoolIntervals("sp1")).toEqual([]);
  });

  it("区間なし → 現在値をそのまま返す（total へリセットしない / mode:none）", () => {
    addSpool({ id: "sp1", totalLengthMm: 100000, remainingLengthMm: 42000 });
    setHistory("h", [job(60, 7000)]);

    const r = deriveSpoolRemaining("sp1");
    expect(r.mode).toBe("none");
    expect(r.verified).toBe(false);
    expect(r.usedMm).toBe(0);
    expect(r.remainingMm).toBe(42000); // 勝手に total(100000) にしない
  });
});

// =====================================================================
// 11. initLedgerAnchors：装着中スプールにアンカー mount を1回だけ種付け
// =====================================================================
describe("initLedgerAnchors", () => {
  beforeEach(reset);

  it("印刷中スプール → anchor=currentJobStartLength で種付け（mid-job 二重計上を回避）", () => {
    // 現在ジョブ開始時 221893 → live 残量は減っていく途中。アンカーには開始値を使う。
    const sp = addSpool({
      id: "a6ae00", totalLengthMm: 330000, remainingLengthMm: 210000,
      currentPrintID: "1774000000", currentJobStartLength: 221893
    });
    setHistory("h", [job(1773000000, 50000)]); // 完了済み（sinceJobId 用）
    mockMonitorData.hostSpoolMap = { h: "a6ae00" };

    const { seeded, report } = initLedgerAnchors({ nowMs: 999 });
    expect(seeded).toBe(1);
    const ev = mockMonitorData.mountHistory.find(e => e.type === "mount" && e.spoolId === "a6ae00");
    expect(ev).toBeTruthy();
    expect(ev.anchorRemainingMm).toBe(221893); // currentJobStartLength（remainingLengthMm ではない）
    expect(ev.sinceJobId).toBe(1773000000);    // 完了ジョブの最大 printId
    expect(ev.ts).toBe(999);
    expect(sp._remainingVerified).toBe(false);
    expect(report[0]).toMatchObject({ spoolId: "a6ae00", host: "h", anchorRemainingMm: 221893 });
  });

  it("非印刷の装着中スプール → anchor=remainingLengthMm で種付け", () => {
    addSpool({ id: "m1", totalLengthMm: 330000, remainingLengthMm: 175000 });
    setHistory("h", [job(100, 5000), job(200, 6000)]);
    mockMonitorData.hostSpoolMap = { h: "m1" };

    initLedgerAnchors({ nowMs: 5 });
    const ev = mockMonitorData.mountHistory.find(e => e.type === "mount" && e.spoolId === "m1");
    expect(ev.anchorRemainingMm).toBe(175000);
    expect(ev.sinceJobId).toBe(200);
  });

  it("取り外し済み（hostSpoolMap に無い）スプールは触らない（mountHistory 追加なし・残量不変）", () => {
    const removed = addSpool({ id: "614bdd", totalLengthMm: 336000, remainingLengthMm: 0 });
    addSpool({ id: "m1", totalLengthMm: 330000, remainingLengthMm: 175000 });
    setHistory("h", [job(100, 5000)]);
    mockMonitorData.hostSpoolMap = { h: "m1" }; // 614bdd は載っていない

    initLedgerAnchors({ nowMs: 7 });
    // 取り外し済み 614bdd には mount を種付けしない / 残量を total へリセットしない
    expect(mockMonitorData.mountHistory.find(e => e.spoolId === "614bdd")).toBeUndefined();
    expect(removed.remainingLengthMm).toBe(0);
  });

  it("既に mount イベントがあるスプールは再種付けしない（冪等）", () => {
    addSpool({ id: "m1", totalLengthMm: 330000, remainingLengthMm: 175000 });
    setHistory("h", [job(100, 5000)]);
    mockMonitorData.hostSpoolMap = { h: "m1" };
    appendMountEvent({ host: "h", spoolId: "m1", anchorRemainingMm: 200000, sinceJobId: 50, ts: 1 });

    const { seeded } = initLedgerAnchors({ nowMs: 2 });
    expect(seeded).toBe(0);
    expect(mockMonitorData.mountHistory.filter(e => e.type === "mount" && e.spoolId === "m1")).toHaveLength(1);
  });
});

// =====================================================================
// 12. 実データ回帰：破損 printIdRanges に引きずられず anchor を基点に冪等減算
// =====================================================================
describe("実データ回帰（破損 printIdRanges + アンカー mount）", () => {
  beforeEach(reset);

  it("(a) derive は total−Σ ではなく anchor を返す（printIdRanges に引きずられない）", () => {
    // 現用スプール a6ae00：壊れた printIdRanges（前スプール区間と重複・過大）を持つが、
    // anchor=現在値(213161) since=最新完了 の mount を種付け済み。
    const sp = addSpool({
      id: "a6ae00", totalLengthMm: 330000, remainingLengthMm: 213161,
      // 破損: 前スプール 684807 と重複する過大な区間群（fallback が拾えば 61751 へ激減していた）
      printIdRanges: [
        { startPrintID: "1700000000", endPrintID: "1740000000" },
        { startPrintID: "1700000000", endPrintID: "1750000000" }, // 重複
        { startPrintID: "1710000000", endPrintID: null }
      ],
      startPrintID: "1700000000", startLength: 330000
    });
    // ホスト履歴には since より前の大量消費ジョブも混在（fallback なら誤計上していた）
    setHistory("h", [
      job(1700000001, 120000), // since 以前（別スプール時代）→ 計上しない
      job(1720000000, 80000)   // since 以前 → 計上しない
    ]);
    // 純アンカー mount: anchor=現在値, sinceJobId=履歴最大完了
    appendMountEvent({ host: "h", spoolId: "a6ae00", anchorRemainingMm: 213161, sinceJobId: 1720000000, ts: 100 });

    const r = deriveSpoolRemaining("a6ae00");
    expect(r.mode).toBe("anchor");
    // sinceJobId(1720000000) 以後の完了ジョブは無い → derive = anchor(213161) - 0 = 213161
    expect(r.remainingMm).toBe(213161);
    // total−Σ（330000 - 200000 = 130000）にも、fallback 激減値(61751)にもならない
    expect(r.remainingMm).not.toBe(130000);
    expect(sp).toBeTruthy();
  });

  it("(b) since より後に完了ジョブ M を1件足すと anchor − M（単一減算・10回冪等）", () => {
    addSpool({ id: "a6ae00", totalLengthMm: 330000, remainingLengthMm: 213161 });
    setHistory("h", [job(1720000000, 80000)]); // since 以前
    appendMountEvent({ host: "h", spoolId: "a6ae00", anchorRemainingMm: 213161, sinceJobId: 1720000000, ts: 100 });

    // since より後に新規完了ジョブ M=12345 を1件追加
    const M = 12345;
    mockMonitorData.machines.h.printStore.history.push(job(1730000000, M));

    const expected = 213161 - M;
    for (let i = 0; i < 10; i++) {
      const r = deriveSpoolRemaining("a6ae00");
      expect(r.remainingMm).toBe(expected); // 何回呼んでも anchor − M（多重減算しない）
      expect(r.usedMm).toBe(M);
    }
  });
});

// =====================================================================
// 13. appendMountEvent / appendUnmountEvent の追記
// =====================================================================
describe("appendMountEvent / appendUnmountEvent", () => {
  beforeEach(reset);

  it("mount/unmount イベントが mountHistory に追記される", () => {
    appendMountEvent({ host: "h", spoolId: "sp1", anchorRemainingMm: 100000, sinceJobId: 0, ts: 1000 });
    appendUnmountEvent({ host: "h", spoolId: "sp1", untilJobId: 50, ts: 2000 });
    expect(mockMonitorData.mountHistory).toHaveLength(2);
    // evId は内容ベースの一意キー（type_spoolId_ts）
    expect(mockMonitorData.mountHistory[0]).toMatchObject({ type: "mount", spoolId: "sp1", evId: "mount_sp1_1000" });
    expect(mockMonitorData.mountHistory[1]).toMatchObject({ type: "unmount", untilJobId: 50, evId: "unmount_sp1_2000" });
  });

  it("同一 ts・異なるスプールでも evId が衝突しない（復元/import dedup での消失を防止）", () => {
    // initLedgerAnchors が複数ホストを同じ nowMs で種付けする状況を再現
    appendMountEvent({ host: "h1", spoolId: "spA", anchorRemainingMm: 100, sinceJobId: 0, ts: 5000 });
    appendMountEvent({ host: "h2", spoolId: "spB", anchorRemainingMm: 200, sinceJobId: 0, ts: 5000 });
    const ids = mockMonitorData.mountHistory.map(e => e.evId);
    expect(ids).toEqual(["mount_spA_5000", "mount_spB_5000"]);
    expect(new Set(ids).size).toBe(2); // 衝突なし → dedup で片方が消えない
  });
});

// =====================================================================
// 14. ADR-0005 evId 重複ガード（同秒二重追記を畳む）
// =====================================================================
describe("ADR-0005 evId 重複ガード", () => {
  beforeEach(reset);

  it("同一 spoolId/ts の mount を2回追記しても1件（二重区間を防ぐ）", () => {
    appendMountEvent({ host: "h", spoolId: "sp1", anchorRemainingMm: 100, sinceJobId: 0, ts: 1000 });
    appendMountEvent({ host: "h", spoolId: "sp1", anchorRemainingMm: 999, sinceJobId: 9, ts: 1000 });
    const mounts = mockMonitorData.mountHistory.filter(e => e.type === "mount" && e.spoolId === "sp1");
    expect(mounts).toHaveLength(1);
    expect(mounts[0].anchorRemainingMm).toBe(100); // 先勝ち（後続は無視）
  });

  it("unmount も同様に重複追記を畳む", () => {
    appendUnmountEvent({ host: "h", spoolId: "sp1", untilJobId: 50, ts: 2000 });
    appendUnmountEvent({ host: "h", spoolId: "sp1", untilJobId: 77, ts: 2000 });
    const unmounts = mockMonitorData.mountHistory.filter(e => e.type === "unmount" && e.spoolId === "sp1");
    expect(unmounts).toHaveLength(1);
  });
});

// =====================================================================
// 15. ADR-0005 イベント文脈（record / get / resolve / 冪等 / upsert）
// =====================================================================
describe("ADR-0005 イベント文脈", () => {
  beforeEach(reset);

  it("record → get で取得、resolve で未解決から外れる", () => {
    recordFilamentEvent({ host: "h", ts: 100, stateAtEvent: 5, oldSpoolId: "OLD", runout: true });
    const ev = getOpenFilamentEvent("h");
    expect(ev).toBeTruthy();
    expect(ev.stateAtEvent).toBe(5);
    expect(ev.runout).toBe(true);
    expect(ev.evId).toBe("fctx_h_100");

    resolveFilamentEvent("h", "split", { ts: 200 });
    expect(getOpenFilamentEvent("h")).toBeNull();
    expect(mockMonitorData.filamentEventContext.h.resolution).toBe("split");
    expect(mockMonitorData.filamentEventContext.h.resolvedAt).toBe(200);
  });

  it("同一ホストで再 record は origin(evId/ts) を保持して更新（切れ→一時停止の昇格）", () => {
    // 切れ(0→1, printing) を記録 → その後 paused へ
    recordFilamentEvent({ host: "h", ts: 100, stateAtEvent: 1, oldSpoolId: "OLD", runout: true });
    recordFilamentEvent({ host: "h", ts: 250, stateAtEvent: 5 /* paused */ });
    const ctxs = Object.values(mockMonitorData.filamentEventContext);
    expect(ctxs).toHaveLength(1);            // 文脈は1件（重複生成しない）
    const ev = getOpenFilamentEvent("h");
    expect(ev.evId).toBe("fctx_h_100");      // origin ts/evId 保持（R4）
    expect(ev.ts).toBe(100);
    expect(ev.stateAtEvent).toBe(5);         // 交換に近い状態（paused）へ更新
    expect(ev.runout).toBe(true);            // runout は維持
  });

  it("解決後に再 record すると新しい文脈で置き換わる", () => {
    recordFilamentEvent({ host: "h", ts: 100, stateAtEvent: 5 });
    resolveFilamentEvent("h", "split", { ts: 150 });
    recordFilamentEvent({ host: "h", ts: 300, stateAtEvent: 1 });
    const ev = getOpenFilamentEvent("h");
    expect(ev.evId).toBe("fctx_h_300");
    expect(ev.resolved).toBe(false);
  });

  it("文脈は monitorData に残る＝（再接続で in-memory が消えても）遡及判定を維持", () => {
    recordFilamentEvent({ host: "h", ts: 100, stateAtEvent: 5, oldSpoolId: "OLD" });
    // 再接続シミュレーション: monitorData 自体は保持される（aggregator の _hostStates のみ消える想定）
    expect(getOpenFilamentEvent("h").stateAtEvent).toBe(5);
  });
});

// =====================================================================
// 16. ADR-0005 稼働中=全体 / 一時停止=分割 の derive 境界（純関数）
// =====================================================================
describe("ADR-0005 稼働中=全体 derive", () => {
  beforeEach(reset);

  it("旧は J を除外（until=Lc）、新は J 全体を計上（anchor=remaining+usedAtSwap）", () => {
    // 完了 100,200。進行中 J=300。Lc=200。usedAtSwap=8000。
    addSpool({ id: "OLD", totalLengthMm: 330000, remainingLengthMm: 290000 });
    addSpool({ id: "NEW", totalLengthMm: 330000, remainingLengthMm: 330000 });
    setHistory("h", [job(100, 5000), job(200, 6000), job(300, 40000)]);
    // OLD: 装着(since=200, anchor=300000) → 取外し(until=200, J除外)
    appendMountEvent({ host: "h", spoolId: "OLD", anchorRemainingMm: 300000, sinceJobId: 200, ts: 10 });
    appendUnmountEvent({ host: "h", spoolId: "OLD", untilJobId: 200, ts: 20 });
    // NEW: 装着(since=200, anchor=330000+8000=338000, open)
    appendMountEvent({ host: "h", spoolId: "NEW", anchorRemainingMm: 338000, sinceJobId: 200, ts: 21 });

    const rOld = deriveSpoolRemaining("OLD");
    expect(rOld.usedMm).toBe(0);          // J=300 は until=200 で除外
    expect(rOld.remainingMm).toBe(300000); // J前の値へ復元（live 290000 ではない）

    const rNew = deriveSpoolRemaining("NEW");
    expect(rNew.usedMm).toBe(40000);       // J 全体
    expect(rNew.remainingMm).toBe(298000); // 338000 - 40000（live==authority）
  });
});

describe("ADR-0005 一時停止=分割 derive", () => {
  beforeEach(reset);

  it("両区間が J を跨ぐ。filamentInfo で per-reel 帰属（旧→0/切れ, 新→再開後）", () => {
    addSpool({ id: "OLD", totalLengthMm: 330000, remainingLengthMm: 0 });
    addSpool({ id: "NEW", totalLengthMm: 330000, remainingLengthMm: 330000 });
    // J=300 は分割: OLD 300000（切れで全部）, NEW 25000
    setHistory("h", [
      job(100, 5000), job(200, 6000),
      job(300, 325000, { filamentInfo: [
        { spoolId: "OLD", usedMm: 300000 },
        { spoolId: "NEW", usedMm: 25000 }
      ] })
    ]);
    // OLD: since=200, anchor=300000 → until=300（J を含める）
    appendMountEvent({ host: "h", spoolId: "OLD", anchorRemainingMm: 300000, sinceJobId: 200, ts: 10 });
    appendUnmountEvent({ host: "h", spoolId: "OLD", untilJobId: 300, ts: 20 });
    // NEW: since=200, anchor=330000, open
    appendMountEvent({ host: "h", spoolId: "NEW", anchorRemainingMm: 330000, sinceJobId: 200, ts: 21 });

    const rOld = deriveSpoolRemaining("OLD");
    expect(rOld.usedMm).toBe(300000);     // J の OLD 持ち分
    expect(rOld.remainingMm).toBe(0);     // 切れ → 0

    const rNew = deriveSpoolRemaining("NEW");
    expect(rNew.usedMm).toBe(25000);      // J の NEW 持ち分
    expect(rNew.remainingMm).toBe(305000); // 330000 - 25000
  });

  it("reconcile(OLD) を10回呼んでも 0 を維持（多重復元なし）", () => {
    const old = addSpool({ id: "OLD", totalLengthMm: 330000, remainingLengthMm: 0 });
    setHistory("h", [
      job(200, 6000),
      job(300, 300000, { filamentInfo: [{ spoolId: "OLD", usedMm: 300000 }] })
    ]);
    appendMountEvent({ host: "h", spoolId: "OLD", anchorRemainingMm: 300000, sinceJobId: 200, ts: 10 });
    appendUnmountEvent({ host: "h", spoolId: "OLD", untilJobId: 300, ts: 20 });
    for (let i = 0; i < 10; i++) reconcileSpool("OLD", { ts: 100 + i });
    expect(old.remainingLengthMm).toBe(0);
  });
});

// =====================================================================
// 17. ADR-0005 境界トラップ：sinceJobId=J はそのジョブを取りこぼす（規則の文書化）
// =====================================================================
describe("ADR-0005 境界トラップ（since=J でジョブ消失）", () => {
  beforeEach(reset);

  it("新 mount since=J（進行中ID）にすると J が厳密 > 境界で除外され usedMm=0", () => {
    addSpool({ id: "NEW", totalLengthMm: 330000, remainingLengthMm: 330000 });
    setHistory("h", [job(300, 40000)]);
    // 誤: since=300（=J）。derive は pid>300 を要求 → J(300) は計上されない。
    appendMountEvent({ host: "h", spoolId: "NEW", anchorRemainingMm: 330000, sinceJobId: 300, ts: 10 });
    const r = deriveSpoolRemaining("NEW");
    expect(r.usedMm).toBe(0); // ← 実装は Lc(=最新完了) を since にすることでこれを回避
  });
});

// =====================================================================
// 19. recomputeSpoolFromManualEdit（Option1: 手動編集=権威・総量基準再計算＋再アンカー）
// =====================================================================
describe("recomputeSpoolFromManualEdit（手動編集=権威）", () => {
  beforeEach(reset);

  it("総量 − 明示帰属する全完了ジョブの消費 で再計算（インポート済み履歴=pre-anchor でも反映）", () => {
    // 装着アンカー since=最新完了 のため、アンカー方式なら過去ジョブは一切引かれない。
    // 手動編集権威は履歴全体（pre-anchor 含む）を合算する。
    const sp = addSpool({ id: "sp1", totalLengthMm: 330000, remainingLengthMm: 330000 });
    setHistory("h", [
      job(100, 20000, { filamentInfo: [{ spoolId: "sp1", usedMm: 20000 }] }),
      job(200, 30000, { filamentId: "sp1" })
    ]);
    mockMonitorData.hostSpoolMap = { h: "sp1" };
    // 装着中: since=200（最新完了）で種付け → アンカー方式では derive=anchor（過去引かない）
    appendMountEvent({ host: "h", spoolId: "sp1", anchorRemainingMm: 330000, sinceJobId: 200, ts: 10 });

    const res = recomputeSpoolFromManualEdit("sp1", { ts: 999 });
    expect(res.mode).toBe("total");
    expect(res.used).toBe(50000);          // 20000 + 30000（pre-anchor も合算）
    expect(res.after).toBe(280000);        // 330000 - 50000
    expect(sp.remainingLengthMm).toBe(280000);
    expect(sp._remainingVerified).toBe(true);
    expect(sp.updatedAt).toBe(999);
  });

  it("明示帰属していないジョブ（filamentInfo/filamentId なし）は合算しない", () => {
    const sp = addSpool({ id: "sp1", totalLengthMm: 100000, remainingLengthMm: 100000 });
    setHistory("h", [
      job(100, 20000),                                                  // 帰属なし → 除外
      job(200, 5000, { filamentInfo: [{ spoolId: "sp1", usedMm: 5000 }] }) // 帰属あり
    ]);
    mockMonitorData.hostSpoolMap = { h: "sp1" };
    appendMountEvent({ host: "h", spoolId: "sp1", anchorRemainingMm: 100000, sinceJobId: 200, ts: 10 });

    const res = recomputeSpoolFromManualEdit("sp1", { ts: 1 });
    expect(res.used).toBe(5000);
    expect(res.after).toBe(95000);
  });

  it("他スプールに帰属するジョブは合算しない（multi-spool の per-reel 厳密帰属）", () => {
    const sp = addSpool({ id: "sp1", totalLengthMm: 100000, remainingLengthMm: 100000 });
    setHistory("h", [
      job(100, 9000, { filamentInfo: [
        { spoolId: "sp1", usedMm: 4000 },
        { spoolId: "sp2", usedMm: 5000 }
      ] })
    ]);
    mockMonitorData.hostSpoolMap = { h: "sp1" };
    appendMountEvent({ host: "h", spoolId: "sp1", anchorRemainingMm: 100000, sinceJobId: 100, ts: 10 });
    const res = recomputeSpoolFromManualEdit("sp1", { ts: 1 });
    expect(res.used).toBe(4000);           // sp1 持ち分のみ
    expect(res.after).toBe(96000);
  });

  it("再アンカー: 再計算後に deriveSpoolRemaining が同値（自動 reconcile が権威値を壊さない）", () => {
    const sp = addSpool({ id: "sp1", totalLengthMm: 330000, remainingLengthMm: 330000 });
    setHistory("h", [
      job(100, 20000, { filamentId: "sp1" }),
      job(200, 30000, { filamentId: "sp1" })
    ]);
    mockMonitorData.hostSpoolMap = { h: "sp1" };
    appendMountEvent({ host: "h", spoolId: "sp1", anchorRemainingMm: 330000, sinceJobId: 200, ts: 10 });

    const res = recomputeSpoolFromManualEdit("sp1", { ts: 999 });
    expect(res.after).toBe(280000);
    // 開区間 mount が貼り直され anchor=280000, since=最新完了(200) になっている
    const open = getSpoolIntervals("sp1").find(iv => iv.untilJobId == null);
    expect(open.anchorRemainingMm).toBe(280000);
    expect(open.sinceJobId).toBe(200);
    // 以後の reconcile は anchor 基点（過去を再計上しない）→ 権威値を維持
    const d = deriveSpoolRemaining("sp1");
    expect(d.remainingMm).toBe(280000);
    const r = reconcileSpool("sp1", { ts: 1000 });
    expect(r.after).toBe(280000);
    expect(sp.remainingLengthMm).toBe(280000);
  });

  it("再アンカー後に新規完了ジョブ → reconcile はその分だけ減算（過去は二重計上しない）", () => {
    const sp = addSpool({ id: "sp1", totalLengthMm: 330000, remainingLengthMm: 330000 });
    setHistory("h", [job(200, 30000, { filamentId: "sp1" })]);
    mockMonitorData.hostSpoolMap = { h: "sp1" };
    appendMountEvent({ host: "h", spoolId: "sp1", anchorRemainingMm: 330000, sinceJobId: 200, ts: 10 });

    recomputeSpoolFromManualEdit("sp1", { ts: 999 });
    expect(sp.remainingLengthMm).toBe(300000); // 330000 - 30000

    // 以後に新規完了ジョブ M（since=200 より後）を追加して reconcile
    mockMonitorData.machines.h.printStore.history.push(job(300, 12000, { filamentId: "sp1" }));
    const r = reconcileSpool("sp1", { ts: 1000 });
    expect(r.after).toBe(288000);  // 300000(=anchor) - 12000（過去30000 は再計上しない）
  });

  it("冪等: 同編集を10回再計算しても同値", () => {
    const sp = addSpool({ id: "sp1", totalLengthMm: 100000, remainingLengthMm: 100000 });
    setHistory("h", [job(100, 25000, { filamentId: "sp1" })]);
    mockMonitorData.hostSpoolMap = { h: "sp1" };
    appendMountEvent({ host: "h", spoolId: "sp1", anchorRemainingMm: 100000, sinceJobId: 100, ts: 10 });
    for (let i = 0; i < 10; i++) {
      const r = recomputeSpoolFromManualEdit("sp1", { ts: 50 + i });
      expect(r.after).toBe(75000);
    }
    expect(sp.remainingLengthMm).toBe(75000);
    // 開区間は1つに保たれる（イベント増殖なし）
    expect(getSpoolIntervals("sp1").filter(iv => iv.untilJobId == null)).toHaveLength(1);
  });

  it("消費が総量を超える → 0 にクランプ", () => {
    const sp = addSpool({ id: "sp1", totalLengthMm: 50000, remainingLengthMm: 50000 });
    setHistory("h", [job(100, 80000, { filamentId: "sp1" })]);
    mockMonitorData.hostSpoolMap = { h: "sp1" };
    appendMountEvent({ host: "h", spoolId: "sp1", anchorRemainingMm: 50000, sinceJobId: 100, ts: 10 });
    const r = recomputeSpoolFromManualEdit("sp1", { ts: 1 });
    expect(r.after).toBe(0);
    expect(sp.remainingLengthMm).toBe(0);
  });

  it("印刷中スプールは触らない（skip）", () => {
    const sp = addSpool({
      id: "sp1", totalLengthMm: 100000, remainingLengthMm: 41234, currentPrintID: "777"
    });
    setHistory("h", [job(100, 5000, { filamentId: "sp1" })]);
    const r = recomputeSpoolFromManualEdit("sp1", { ts: 1 });
    expect(r.skipped).toBe(true);
    expect(r.mode).toBe("skip");
    expect(sp.remainingLengthMm).toBe(41234); // 不変
  });

  it("総量不明(0) → アンカー方式 reconcile へフォールバック", () => {
    const sp = addSpool({ id: "sp1", totalLengthMm: 0, remainingLengthMm: 90000 });
    setHistory("h", [job(100, 5000, { filamentId: "sp1" })]);
    appendMountEvent({ host: "h", spoolId: "sp1", anchorRemainingMm: 90000, sinceJobId: 0, ts: 10 });
    const r = recomputeSpoolFromManualEdit("sp1", { ts: 1 });
    // reconcileSpool（アンカー方式）の戻り（mode:"anchor"）= 90000 - 5000
    expect(r.mode).toBe("anchor");
    expect(sp.remainingLengthMm).toBe(85000);
  });

  it("非装着スプール → 残量は再計算するが mount は増やさない（自動 reconcile 対象外）", () => {
    const sp = addSpool({ id: "sp1", totalLengthMm: 100000, remainingLengthMm: 100000 });
    setHistory("h", [job(100, 15000, { filamentId: "sp1" })]);
    // hostSpoolMap に sp1 は無い（取り外し済み）
    mockMonitorData.hostSpoolMap = {};
    const r = recomputeSpoolFromManualEdit("sp1", { ts: 1 });
    expect(r.after).toBe(85000);
    expect(sp.remainingLengthMm).toBe(85000);
    expect(mockMonitorData.mountHistory.filter(e => e.spoolId === "sp1")).toHaveLength(0);
  });

  it("スプール未発見 → null", () => {
    expect(recomputeSpoolFromManualEdit("nope", { ts: 1 })).toBeNull();
  });
});

// =====================================================================
// 18. ADR-0005 P6 runoutGateHeld（2信号ゲート: センサーON ＋ 推定残<10%）
// =====================================================================
describe("ADR-0005 P6 runoutGateHeld（2信号ゲート）", () => {
  it("runout かつ 残<10% → true（高確度: 使い切り→新リール）", () => {
    expect(runoutGateHeld({ runout: true, oldRemainingPct: 5 })).toBe(true);
    expect(runoutGateHeld({ runout: true, oldRemainingPct: 9.99 })).toBe(true);
    expect(runoutGateHeld({ runout: true, oldRemainingPct: 0 })).toBe(true);
  });

  it("runout だが 残≥10% → false（不一致＝詰まり/誤動作。同一再セット）", () => {
    expect(runoutGateHeld({ runout: true, oldRemainingPct: 10 })).toBe(false);
    expect(runoutGateHeld({ runout: true, oldRemainingPct: 35 })).toBe(false);
  });

  it("runout でない（センサー未ON）→ false", () => {
    expect(runoutGateHeld({ runout: false, oldRemainingPct: 5 })).toBe(false);
  });

  it("oldRemainingPct 不明/欠落/null → false（推定信号なし）", () => {
    expect(runoutGateHeld({ runout: true, oldRemainingPct: null })).toBe(false);
    expect(runoutGateHeld({ runout: true, oldRemainingPct: NaN })).toBe(false);
    expect(runoutGateHeld({ runout: true })).toBe(false);
    expect(runoutGateHeld(null)).toBe(false);
    expect(runoutGateHeld(undefined)).toBe(false);
  });
});
