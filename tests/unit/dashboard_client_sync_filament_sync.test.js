/**
 * @fileoverview リレー子のフィラメント共有状態同期（親権威・全置換）回帰テスト
 *
 * バグ: 旧実装の _applySnapshot/_applyDelta は filamentSpools を「IDベースマージ +
 * sticky フラグ保護（existing.isActive = prevActive || ...）」で適用していたため、
 *   (a) 親で取り外し/交換しても子の isActive/isInUse/hostname が永遠に解除されない
 *   (b) 親で削除したスプールが子に残り続ける
 * という親子表示乖離（「本体で変更した内容が反映されない」）の根本原因だった。
 *
 * 修正: 親が唯一の権威として全置換（in-place）。mountHistory（ADR-0004 台帳）も
 * スナップショット/デルタで同期する。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

/* ── window シム（dashboard_data.js が module top-level で window を参照するため） ── */
vi.hoisted(() => {
  globalThis.window = globalThis.window || {};
});

import { _applySharedFilamentState } from "../../3dp_lib/dashboard_client_sync.js";
import { monitorData } from "../../3dp_lib/dashboard_data.js";

/**
 * テスト用スプールを生成する。
 * @param {string} id - スプールID
 * @param {object} over - 上書きフィールド
 * @returns {object} スプールオブジェクト
 */
function spool(id, over = {}) {
  return {
    id, name: `SP-${id}`, remainingLengthMm: 100000, totalLengthMm: 330000,
    isActive: false, isInUse: false, hostname: null, deleted: false,
    ...over,
  };
}

describe("_applySharedFilamentState — 親権威の全置換", () => {
  beforeEach(() => {
    monitorData.filamentSpools.splice(0, monitorData.filamentSpools.length);
    for (const k of Object.keys(monitorData.hostSpoolMap)) delete monitorData.hostSpoolMap[k];
    monitorData.mountHistory = [];
  });

  it("親での取り外し（isActive=false/hostname=null）が子へ伝搬する（旧 sticky マージのバグ）", () => {
    // 子の現状: A が h1 に装着中
    monitorData.filamentSpools.push(spool("A", { isActive: true, isInUse: true, hostname: "h1" }));
    monitorData.hostSpoolMap.h1 = "A";

    // 親が A を取り外した状態を受信
    _applySharedFilamentState({
      filamentSpools: [spool("A", { isActive: false, isInUse: false, hostname: null, removedAt: 123 })],
      hostSpoolMap: { h1: null },
    });

    const a = monitorData.filamentSpools.find(s => s.id === "A");
    expect(a.isActive, "旧実装は prevActive || ... で true のまま残った").toBe(false);
    expect(a.isInUse).toBe(false);
    expect(a.hostname).toBeNull();
    expect(monitorData.hostSpoolMap.h1).toBeNull();
  });

  it("親でのスプール交換（A→B）が子へ伝搬する", () => {
    monitorData.filamentSpools.push(
      spool("A", { isActive: true, isInUse: true, hostname: "h1", remainingLengthMm: 5000 }),
      spool("B")
    );
    monitorData.hostSpoolMap.h1 = "A";

    _applySharedFilamentState({
      filamentSpools: [
        spool("A", { isActive: false, hostname: null, remainingLengthMm: 5000 }),
        spool("B", { isActive: true, isInUse: true, hostname: "h1", remainingLengthMm: 330000 }),
      ],
      hostSpoolMap: { h1: "B" },
    });

    expect(monitorData.hostSpoolMap.h1).toBe("B");
    expect(monitorData.filamentSpools.find(s => s.id === "A").isActive).toBe(false);
    expect(monitorData.filamentSpools.find(s => s.id === "B").isActive).toBe(true);
  });

  it("親で削除されたスプールが子からも消える（全置換）", () => {
    monitorData.filamentSpools.push(spool("A"), spool("B"));

    _applySharedFilamentState({ filamentSpools: [spool("B")] });

    expect(monitorData.filamentSpools.map(s => s.id)).toEqual(["B"]);
  });

  it("親の残量編集が子の表示値を上書きする", () => {
    monitorData.filamentSpools.push(spool("A", { remainingLengthMm: 99999 }));

    _applySharedFilamentState({
      filamentSpools: [spool("A", { remainingLengthMm: 250000 })],
    });

    expect(monitorData.filamentSpools.find(s => s.id === "A").remainingLengthMm).toBe(250000);
  });

  it("配列参照は維持される（ビューが保持する参照を壊さない）", () => {
    const refSpools = monitorData.filamentSpools;
    const refMap = monitorData.hostSpoolMap;

    _applySharedFilamentState({
      filamentSpools: [spool("X")],
      hostSpoolMap: { h9: "X" },
    });

    expect(monitorData.filamentSpools).toBe(refSpools);
    expect(monitorData.hostSpoolMap).toBe(refMap);
    expect(refSpools.map(s => s.id)).toEqual(["X"]);
    expect(refMap.h9).toBe("X");
  });

  it("mountHistory（ADR-0004 台帳）が同期される", () => {
    const events = [
      { evId: "e1", type: "mount", spoolId: "A", host: "h1", ts: 1 },
      { evId: "e2", type: "unmount", spoolId: "A", host: "h1", ts: 2 },
    ];
    _applySharedFilamentState({ mountHistory: events });
    expect(monitorData.mountHistory).toEqual(events);
    // 受信配列のコピーであること（親メッセージの再利用で壊れない）
    expect(monitorData.mountHistory).not.toBe(events);
  });

  it("フィールド欠落（undefined）は変更しない（部分デルタの安全策）", () => {
    monitorData.filamentSpools.push(spool("A"));
    monitorData.hostSpoolMap.h1 = "A";
    monitorData.mountHistory = [{ evId: "e1" }];

    _applySharedFilamentState({}); // shared はあるが中身なし

    expect(monitorData.filamentSpools.map(s => s.id)).toEqual(["A"]);
    expect(monitorData.hostSpoolMap.h1).toBe("A");
    expect(monitorData.mountHistory).toEqual([{ evId: "e1" }]);
  });

  it("空配列は正当（親が全削除した状態を伝搬する）", () => {
    monitorData.filamentSpools.push(spool("A"));
    _applySharedFilamentState({ filamentSpools: [] });
    expect(monitorData.filamentSpools.length).toBe(0);
  });
});
