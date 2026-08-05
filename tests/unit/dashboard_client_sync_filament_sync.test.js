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

describe("_applySharedFilamentState — フィラメント補助ドメイン（監査 P0 第2報）", () => {
  beforeEach(() => {
    monitorData.filamentInventory.splice(0, monitorData.filamentInventory.length);
    monitorData.userPresets.splice(0, monitorData.userPresets.length);
    monitorData.hiddenPresets.splice(0, monitorData.hiddenPresets.length);
    monitorData.favoritePresets.splice(0, monitorData.favoritePresets.length);
    monitorData.usageHistory.splice(0, monitorData.usageHistory.length);
    if (!Array.isArray(monitorData.pendingUnattributedUsage)) monitorData.pendingUnattributedUsage = [];
    monitorData.pendingUnattributedUsage.splice(0, monitorData.pendingUnattributedUsage.length);
    for (const k of Object.keys(monitorData.filamentEventContext)) delete monitorData.filamentEventContext[k];
    monitorData.spoolSerialCounter = 0;
    if (!monitorData.inferredCandidateStore || typeof monitorData.inferredCandidateStore !== "object") {
      monitorData.inferredCandidateStore = {};
    }
    for (const k of Object.keys(monitorData.inferredCandidateStore)) delete monitorData.inferredCandidateStore[k];
    monitorData.inferredDecisionRecoveryRequired = null;
    monitorData.inferredRecoveryOperationRecoveryRequired = null;
    if (!Array.isArray(monitorData.inferredRecoveryEvents)) monitorData.inferredRecoveryEvents = [];
    monitorData.inferredRecoveryEvents.splice(0, monitorData.inferredRecoveryEvents.length);
    if (!monitorData.ledgerRepairRequired || typeof monitorData.ledgerRepairRequired !== "object") {
      monitorData.ledgerRepairRequired = {};
    }
    for (const k of Object.keys(monitorData.ledgerRepairRequired)) delete monitorData.ledgerRepairRequired[k];
    if (!Array.isArray(monitorData.mountHistoryRejectedEvents)) monitorData.mountHistoryRejectedEvents = [];
    monitorData.mountHistoryRejectedEvents.splice(0, monitorData.mountHistoryRejectedEvents.length);
  });

  it("Phase4: pendingUnattributedUsage を親からミラー（in-place 全置換・参照維持）", () => {
    const ref = monitorData.pendingUnattributedUsage;
    monitorData.pendingUnattributedUsage.push({ host: "old", usedMm: 1 });
    _applySharedFilamentState({
      pendingUnattributedUsage: [{ host: "k1", spoolId: "s1", usedMm: 5000, reason: "invalid-job-id" }],
    });
    expect(monitorData.pendingUnattributedUsage).toBe(ref); // ビュー参照維持
    expect(monitorData.pendingUnattributedUsage).toEqual([
      { host: "k1", spoolId: "s1", usedMm: 5000, reason: "invalid-job-id" },
    ]);
  });

  it("Phase4: pendingUnattributedUsage 欠落は変更しない（部分デルタ安全策）", () => {
    monitorData.pendingUnattributedUsage.push({ host: "keep", usedMm: 3 });
    _applySharedFilamentState({ filamentSpools: [] });
    expect(monitorData.pendingUnattributedUsage).toEqual([{ host: "keep", usedMm: 3 }]);
  });

  it("P0-1: pendingUnattributedUsageArchive（隔離集約）を親から全置換ミラー", () => {
    if (!monitorData.pendingUnattributedUsageArchive) monitorData.pendingUnattributedUsageArchive = {};
    monitorData.pendingUnattributedUsageArchive.stale = { count: 9 };
    _applySharedFilamentState({
      pendingUnattributedUsageArchive: { k1: { count: 3, totalUsedMm: 300 } },
    });
    expect(monitorData.pendingUnattributedUsageArchive.stale).toBeUndefined();
    expect(monitorData.pendingUnattributedUsageArchive.k1).toEqual({ count: 3, totalUsedMm: 300 });
  });

  it("#412-O4: inferredCandidateStore を親から全置換ミラー", () => {
    monitorData.inferredCandidateStore.stale = { candidateHash: "stale", status: "pending" };
    _applySharedFilamentState({
      inferredCandidateStore: {
        "ic-a": { candidateHash: "ic-a", host: "k1", status: "pending", usedMm: 1200 },
      },
    });
    expect(monitorData.inferredCandidateStore.stale).toBeUndefined();
    expect(monitorData.inferredCandidateStore["ic-a"]).toEqual({
      candidateHash: "ic-a", host: "k1", status: "pending", usedMm: 1200
    });
  });

  it("#418: recovery / repair 診断を親から全置換ミラーする", () => {
    monitorData.inferredDecisionRecoveryRequired = { candidateHash: "stale", reason: "old" };
    monitorData.inferredRecoveryOperationRecoveryRequired = { operation: "stale", reason: "old" };
    monitorData.inferredRecoveryEvents.push({ eventId: "ir-old", type: "old" });
    monitorData.ledgerRepairRequired.stale = { status: "old" };
    monitorData.mountHistoryRejectedEvents.push({ reason: "old", event: { evId: "old" } });

    _applySharedFilamentState({
      inferredDecisionRecoveryRequired: { candidateHash: "ic-a", action: "confirm", reason: "rollback_durable_save_failed" },
      inferredRecoveryOperationRecoveryRequired: { operation: "clearLedgerRepairRequired", reason: "rollback_durable_save_failed" },
      inferredRecoveryEvents: [{ eventId: "ir-a", type: "recovery-durable-save-retried", createdAt: 123 }],
      ledgerRepairRequired: { k1: { spoolId: "S1", status: "ambiguous", detectedAtEpochMs: 123 } },
      mountHistoryRejectedEvents: [{ reason: "reanchor-invalid-reference", event: { evId: "ev-a", host: "k1" } }],
    });

    expect(monitorData.inferredDecisionRecoveryRequired).toEqual({
      candidateHash: "ic-a",
      action: "confirm",
      reason: "rollback_durable_save_failed",
    });
    expect(monitorData.inferredRecoveryOperationRecoveryRequired).toEqual({
      operation: "clearLedgerRepairRequired",
      reason: "rollback_durable_save_failed",
    });
    expect(monitorData.inferredRecoveryEvents).toEqual([
      { eventId: "ir-a", type: "recovery-durable-save-retried", createdAt: 123 },
    ]);
    expect(monitorData.ledgerRepairRequired.stale).toBeUndefined();
    expect(monitorData.ledgerRepairRequired.k1).toEqual({ spoolId: "S1", status: "ambiguous", detectedAtEpochMs: 123 });
    expect(monitorData.mountHistoryRejectedEvents).toEqual([
      { reason: "reanchor-invalid-reference", event: { evId: "ev-a", host: "k1" } },
    ]);
  });

  it("#418: 親で解消済みの recovery / repair 診断を Satellite 側から消す", () => {
    monitorData.inferredDecisionRecoveryRequired = { candidateHash: "ic-a", reason: "old" };
    monitorData.inferredRecoveryOperationRecoveryRequired = { operation: "old", reason: "old" };
    monitorData.inferredRecoveryEvents.push({ eventId: "ir-a", type: "old" });
    monitorData.ledgerRepairRequired.k1 = { status: "ambiguous" };
    monitorData.mountHistoryRejectedEvents.push({ reason: "old" });

    _applySharedFilamentState({
      inferredDecisionRecoveryRequired: null,
      inferredRecoveryOperationRecoveryRequired: null,
      inferredRecoveryEvents: [],
      ledgerRepairRequired: {},
      mountHistoryRejectedEvents: [],
    });

    expect(monitorData.inferredDecisionRecoveryRequired).toBeNull();
    expect(monitorData.inferredRecoveryOperationRecoveryRequired).toBeNull();
    expect(monitorData.inferredRecoveryEvents).toEqual([]);
    expect(monitorData.ledgerRepairRequired).toEqual({});
    expect(monitorData.mountHistoryRejectedEvents).toEqual([]);
  });

  it("#418: recovery 診断だけが変化した場合も開いている管理画面を再描画する", () => {
    globalThis.window._refreshFilamentManagerIfOpen = vi.fn();
    _applySharedFilamentState({
      inferredDecisionRecoveryRequired: { candidateHash: "ic-a", reason: "rollback_failed" },
      inferredRecoveryOperationRecoveryRequired: null,
      inferredRecoveryEvents: [{ eventId: "ir-a", type: "retry" }],
    });
    const firstCount = globalThis.window._refreshFilamentManagerIfOpen.mock.calls.length;

    _applySharedFilamentState({
      inferredDecisionRecoveryRequired: { candidateHash: "ic-b", reason: "rollback_failed" },
      inferredRecoveryOperationRecoveryRequired: { operation: "clearLedgerRepairRequired", reason: "rollback_failed" },
      inferredRecoveryEvents: [{ eventId: "ir-b", type: "retry" }],
    });

    expect(globalThis.window._refreshFilamentManagerIfOpen.mock.calls.length).toBeGreaterThan(firstCount);
    delete globalThis.window._refreshFilamentManagerIfOpen;
  });

  it("在庫・プリセット・使用履歴を親からミラー（in-place 全置換・参照維持）", () => {
    const refInv = monitorData.filamentInventory;
    monitorData.filamentInventory.push({ modelId: "old", quantity: 9 });
    _applySharedFilamentState({
      filamentInventory: [{ modelId: "m1", quantity: 3 }],
      userPresets: [{ presetId: "user-1" }],
      hiddenPresets: ["h1"],
      favoritePresets: ["f1"],
      usageHistory: [{ id: "u1" }],
    });
    expect(monitorData.filamentInventory).toBe(refInv); // ビュー参照維持
    expect(monitorData.filamentInventory).toEqual([{ modelId: "m1", quantity: 3 }]);
    expect(monitorData.userPresets).toEqual([{ presetId: "user-1" }]);
    expect(monitorData.hiddenPresets).toEqual(["h1"]);
    expect(monitorData.favoritePresets).toEqual(["f1"]);
    expect(monitorData.usageHistory).toEqual([{ id: "u1" }]);
  });

  it("切れイベント文脈（filamentEventContext）を全置換ミラー", () => {
    monitorData.filamentEventContext.stale = { resolved: false };
    _applySharedFilamentState({
      filamentEventContext: { h1: { resolved: true, resolution: "reseat" } },
    });
    expect(monitorData.filamentEventContext.stale).toBeUndefined();
    expect(monitorData.filamentEventContext.h1).toEqual({ resolved: true, resolution: "reseat" });
  });

  it("spoolSerialCounter を親値でミラー（子採番の分岐防止）", () => {
    monitorData.spoolSerialCounter = 2;
    _applySharedFilamentState({ spoolSerialCounter: 57 });
    expect(monitorData.spoolSerialCounter).toBe(57);
  });

  it("補助ドメインのフィールド欠落は変更しない（部分デルタ安全策）", () => {
    monitorData.filamentInventory.push({ modelId: "keep", quantity: 1 });
    monitorData.spoolSerialCounter = 5;
    _applySharedFilamentState({ filamentSpools: [] });
    expect(monitorData.filamentInventory).toEqual([{ modelId: "keep", quantity: 1 }]);
    expect(monitorData.spoolSerialCounter).toBe(5);
  });
});
