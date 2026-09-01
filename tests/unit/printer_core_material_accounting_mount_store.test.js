/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 MaterialAccounting SpoolMount store 単体テスト
 * @file printer_core_material_accounting_mount_store.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_material_accounting_mount_store_test
 *
 * 【機能内容サマリ】
 * - Gate 18.9H-1a のproduction SpoolMount store正規化contractを検証
 * - durable authorityにoperationsByIdを保存しない境界を固定
 * - conflict / corrupt recordをactive authorityから隔離する
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1581 (PR #440)
 * @since   1.390.1575 (PR #440)
 * @lastModified 2026-09-01 14:58:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { describe, expect, it } from "vitest";

import {
  MATERIAL_IDENTITY_STRENGTH,
  SPOOL_MOUNT_STATUS,
  SPOOL_MOUNT_VERIFICATION,
  createSpoolMountRecord,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_contract.js";
import {
  MATERIAL_ACCOUNTING_SPOOL_MOUNT_STORE_AUTHORITY,
  MATERIAL_ACCOUNTING_SPOOL_MOUNT_STORE_SCHEMA_VERSION,
  createMaterialAccountingSpoolMountStoreDigest,
  createMaterialAccountingSpoolMountOperationPayloadDigest,
  normalizeStoredMaterialAccountingSpoolMountStore,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_mount_store.js";

/**
 * テスト用SpoolMount recordを生成する。
 *
 * @function createMount
 * @param {Object} overrides - 上書き値。
 * @returns {Object} SpoolMount record。
 */
function createMount(overrides = {}) {
  return createSpoolMountRecord({
    materialSourceId: "material-source:k2:1a",
    spoolId: "spool:silver-pla",
    mountOperationId: "mount-op:001",
    openedAt: "2026-09-01T00:00:00.000Z",
    openedBy: "operator",
    verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
    sourceIdentityStrengthAtOpen: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
    ...overrides,
  });
}

/**
 * テスト用operation eventを生成する。
 *
 * @function createEvent
 * @param {Object} overrides - 上書き値。
 * @returns {Object} operation event。
 */
function createEvent(overrides = {}) {
  const operationId = overrides.operationId || "mount-op:001";
  const payload = overrides.payload || {
    kind: "operator-mount",
    operatorActionId: "action:mount:1",
    operationId,
    materialSourceId: "material-source:k2:1a",
    spoolId: "spool:silver-pla",
  };
  return {
    eventId: overrides.eventId || "event:mount:1",
    kind: overrides.kind || "operator-mount",
    operatorActionId: overrides.operatorActionId || "action:mount:1",
    operationId,
    payloadDigest: overrides.payloadDigest || createMaterialAccountingSpoolMountOperationPayloadDigest(payload),
    payload,
    recordRefs: Object.prototype.hasOwnProperty.call(overrides, "recordRefs")
      ? overrides.recordRefs
      : ["mount-op:001"],
    createdAt: overrides.createdAt || "2026-09-01T00:00:00.000Z",
    actor: overrides.actor || "operator",
  };
}

describe("MaterialAccountingSpoolMountStore", () => {
  it("空storeをproduction mount authority shapeへ正規化する", () => {
    const store = normalizeStoredMaterialAccountingSpoolMountStore(null);

    expect(store).toMatchObject({
      schemaVersion: MATERIAL_ACCOUNTING_SPOOL_MOUNT_STORE_SCHEMA_VERSION,
      authority: MATERIAL_ACCOUNTING_SPOOL_MOUNT_STORE_AUTHORITY,
      storeRevision: 0,
      spoolMounts: [],
      events: [],
      conflicts: [],
      retainedUnsupportedEntries: [],
      invariants: {
        operatorManaged: true,
        deviceObservationWrites: false,
        physicalCommandWrites: false,
        legacyHostSpoolMapWrites: false,
        legacyUsageHistoryWrites: false,
        legacySpoolRemainingWrites: false,
        filamentLedgerWrites: false,
        printBindingWrites: false,
      },
    });
    expect(store.storeDigest).toMatch(/^fnv1a128:/);
    expect(store.operationsById).toBeUndefined();
  });

  it("valid mount recordとeventを保持しstoreDigestを再計算する", () => {
    const mount = createMount();
    const stored = {
      schemaVersion: 1,
      authority: "material-accounting-spool-mount-store",
      storeRevision: 12,
      storeDigest: "tampered",
      spoolMounts: [mount],
      events: [createEvent({ operationId: mount.mountOperationId, recordRefs: [mount.mountOperationId] })],
    };

    const store = normalizeStoredMaterialAccountingSpoolMountStore(stored);

    expect(store.storeRevision).toBe(12);
    expect(store.spoolMounts).toEqual([mount]);
    expect(store.events).toEqual(stored.events);
    expect(store.storeDigest).toBe(createMaterialAccountingSpoolMountStoreDigest(store));
    expect(store.storeDigest).not.toBe("tampered");
  });

  it("invalid eventはoperation index authorityに残さずretainedUnsupportedEntriesへ隔離する", () => {
    const mount = createMount();
    const store = normalizeStoredMaterialAccountingSpoolMountStore({
      spoolMounts: [mount],
      events: [
        createEvent({ operationId: mount.mountOperationId, recordRefs: [mount.mountOperationId] }),
        { eventId: "event:bad", kind: "operator-mount", payloadDigest: "tampered" },
      ],
    });

    expect(store.events).toHaveLength(1);
    expect(store.retainedUnsupportedEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "event", reason: expect.stringContaining("invalid") }),
    ]));
  });

  it("orphan event recordRefはactive eventから隔離する", () => {
    const mount = createMount();
    const store = normalizeStoredMaterialAccountingSpoolMountStore({
      spoolMounts: [mount],
      events: [
        createEvent({
          eventId: "event:orphan",
          operationId: "mount-op:orphan",
          recordRefs: ["mount-op:orphan"],
        }),
      ],
    });

    expect(store.events).toEqual([]);
    expect(store.retainedUnsupportedEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "event", reason: "orphan-event-record-ref" }),
    ]));
  });

  it("operator eventのrecordRefsが空ならphantom receiptとして隔離する", () => {
    const mount = createMount();
    const store = normalizeStoredMaterialAccountingSpoolMountStore({
      spoolMounts: [mount],
      events: [
        createEvent({
          eventId: "event:phantom",
          operationId: mount.mountOperationId,
          recordRefs: [],
        }),
      ],
    });

    expect(store.events).toEqual([]);
    expect(store.retainedUnsupportedEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "event", reason: expect.stringContaining("missing-event-record-refs") }),
    ]));
  });

  it("event外側とpayloadのkind/action/operationIdが不一致なら隔離する", () => {
    const mount = createMount();
    const mismatched = createEvent({
      eventId: "event:mismatched",
      operationId: mount.mountOperationId,
      recordRefs: [mount.mountOperationId],
      payload: {
        kind: "operator-mount",
        operatorActionId: "action:other",
        operationId: mount.mountOperationId,
        materialSourceId: "material-source:k2:1a",
        spoolId: "spool:silver-pla",
      },
    });
    const store = normalizeStoredMaterialAccountingSpoolMountStore({
      spoolMounts: [mount],
      events: [mismatched],
    });

    expect(store.events).toEqual([]);
    expect(store.retainedUnsupportedEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "event", reason: expect.stringContaining("payload-operatorActionId-mismatch") }),
    ]));
  });

  it("同じeventIdでpayload差異がある場合はfirst-winせず双方を隔離する", () => {
    const mount = createMount();
    const first = createEvent({
      eventId: "event:duplicate",
      operationId: mount.mountOperationId,
      recordRefs: [mount.mountOperationId],
    });
    const second = createEvent({
      eventId: "event:duplicate",
      operationId: mount.mountOperationId,
      recordRefs: [mount.mountOperationId],
      payload: {
        kind: "operator-mount",
        operatorActionId: "action:mount:1",
        operationId: mount.mountOperationId,
        materialSourceId: "material-source:k2:1a",
        spoolId: "spool:changed",
      },
    });

    const store = normalizeStoredMaterialAccountingSpoolMountStore({
      spoolMounts: [mount],
      events: [first, second],
    });

    expect(store.events).toEqual([]);
    expect(store.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "event-id-payload-conflict",
        reason: "same-event-id-different-payload",
      }),
    ]));
    expect(store.retainedUnsupportedEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "event", record: first }),
      expect.objectContaining({ kind: "event", record: second }),
    ]));
  });

  it("同じoperation semantic keyでpayload差異がある場合はfirst-winせず双方を隔離する", () => {
    const mount = createMount();
    const first = createEvent({
      eventId: "event:semantic:first",
      operationId: mount.mountOperationId,
      recordRefs: [mount.mountOperationId],
    });
    const second = createEvent({
      eventId: "event:semantic:second",
      operationId: mount.mountOperationId,
      recordRefs: [mount.mountOperationId],
      payload: {
        kind: "operator-mount",
        operatorActionId: "action:mount:1",
        operationId: mount.mountOperationId,
        materialSourceId: "material-source:k2:1a",
        spoolId: "spool:changed",
      },
    });

    const store = normalizeStoredMaterialAccountingSpoolMountStore({
      spoolMounts: [mount],
      events: [second, first],
    });

    expect(store.events).toEqual([]);
    expect(store.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "operation-semantic-payload-conflict",
        reason: "same-operation-semantic-key-different-payload",
      }),
    ]));
    expect(store.retainedUnsupportedEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "event", record: first }),
      expect.objectContaining({ kind: "event", record: second }),
    ]));
  });

  it("invalid mount recordはactive authorityから外しretainedUnsupportedEntriesへ隔離する", () => {
    const store = normalizeStoredMaterialAccountingSpoolMountStore({
      spoolMounts: [{ mountId: "", materialSourceId: "material-source:k2:1a" }],
    });

    expect(store.spoolMounts).toEqual([]);
    expect(store.retainedUnsupportedEntries).toEqual([
      expect.objectContaining({
        kind: "spoolMount",
        reason: expect.stringContaining("invalid"),
      }),
    ]);
  });

  it("同時open conflictはfirst-winせず衝突集合をactive authorityから外す", () => {
    const first = createMount({ mountOperationId: "mount-op:source-a", spoolId: "spool:a" });
    const second = createMount({ mountOperationId: "mount-op:source-b", spoolId: "spool:b" });

    const store = normalizeStoredMaterialAccountingSpoolMountStore({
      spoolMounts: [first, second],
    });

    expect(store.spoolMounts).toEqual([]);
    expect(store.conflicts).toEqual([
      expect.objectContaining({
        type: "source-open-mount-conflict",
        reason: "material-source-already-has-open-mount",
      }),
    ]);
    expect(store.retainedUnsupportedEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "spoolMount", record: first }),
      expect.objectContaining({ kind: "spoolMount", record: second }),
    ]));
  });

  it("closed adjacent intervalは復元し、overlapした衝突集合はactive authorityから外す", () => {
    const closed = createMount({
      status: SPOOL_MOUNT_STATUS.CLOSED,
      closedAt: "2026-09-01T01:00:00.000Z",
      closedBy: "operator",
      closeOperationId: "close-op:001",
      closeReason: "operator-replace",
    });
    const adjacent = createMount({
      mountOperationId: "mount-op:adjacent",
      spoolId: "spool:black-pla",
      openedAt: "2026-09-01T01:00:00.000Z",
    });
    const overlap = createMount({
      mountOperationId: "mount-op:overlap",
      spoolId: "spool:white-pla",
      openedAt: "2026-09-01T00:30:00.000Z",
      status: SPOOL_MOUNT_STATUS.CLOSED,
      closedAt: "2026-09-01T02:00:00.000Z",
    });

    const store = normalizeStoredMaterialAccountingSpoolMountStore({
      spoolMounts: [closed, adjacent, overlap],
    });

    expect(store.spoolMounts).toEqual([]);
    expect(store.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "source-interval-overlap-conflict",
        reason: "material-source-mount-interval-overlap",
      }),
    ]));
    expect(store.conflicts).toHaveLength(2);
    expect(store.retainedUnsupportedEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "spoolMount", record: closed }),
      expect.objectContaining({ kind: "spoolMount", record: adjacent }),
      expect.objectContaining({ kind: "spoolMount", record: overlap }),
    ]));
    expect(store.retainedUnsupportedEntries.length).toBeGreaterThanOrEqual(3);
  });
});
