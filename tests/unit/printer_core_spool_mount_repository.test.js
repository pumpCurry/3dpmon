/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Universal SpoolMount repository 単体テスト
 * @file printer_core_spool_mount_repository.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_spool_mount_repository_test
 *
 * 【機能内容サマリ】
 * - Gate 18.9A のpure SpoolMountRepository不変条件を検証
 * - MaterialSource/Spoolごとのopen mount最大1制約を固定
 * - mountOperationIdの冪等性とpayload差異conflictを固定
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1498 (PR #438)
 * @since   1.390.1496 (PR #438)
 * @lastModified 2026-08-31 11:35:00
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
  createSpoolMountRepository,
} from "../../3dp_lib/printer_core/dashboard_spool_mount_repository.js";

/**
 * SpoolMount recordを生成する。
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
    openedAt: "2026-08-31T01:00:00.000Z",
    openedBy: "operator",
    verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
    sourceIdentityStrengthAtOpen: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
    ...overrides,
  });
}

describe("SpoolMountRepository", () => {
  it("valid SpoolMountを記録しsource/spoolのopen mountとして解決できる", () => {
    const repository = createSpoolMountRepository();
    const mount = createMount();

    const result = repository.recordMount(mount);

    expect(result).toMatchObject({ ok: true, action: "insert" });
    expect(repository.getMount(mount.mountId)).toMatchObject({ mountId: mount.mountId });
    expect(repository.getOpenMountForSource("material-source:k2:1a")).toMatchObject({ mountId: mount.mountId });
    expect(repository.getOpenMountForSpool("spool:silver-pla")).toMatchObject({ mountId: mount.mountId });
  });

  it("同じmountOperationIdかつ同じpayloadの再送は冪等成功にする", () => {
    const repository = createSpoolMountRepository();
    const mount = createMount();

    expect(repository.recordMount(mount)).toMatchObject({ ok: true, action: "insert" });
    const retry = repository.recordMount(createMount());

    expect(retry).toMatchObject({ ok: true, action: "idempotent" });
    expect(repository.toJSON().mounts).toHaveLength(1);
    expect(repository.getConflicts()).toEqual([]);
  });

  it("同じmountOperationIdでpayloadが異なる場合は上書きせずconflictにする", () => {
    const repository = createSpoolMountRepository();
    const mount = createMount();
    const changed = createMount({
      spoolId: "spool:changed",
    });

    expect(repository.recordMount(mount)).toMatchObject({ ok: true, action: "insert" });
    const result = repository.recordMount(changed);

    expect(result).toMatchObject({ ok: false, action: "conflict" });
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        type: "operation-payload-conflict",
        reason: "same-mount-operation-different-payload",
        existingMountId: mount.mountId,
        candidateMountId: changed.mountId,
      }),
    ]);
    expect(repository.getMount(mount.mountId).spoolId).toBe("spool:silver-pla");
  });

  it("1つのMaterialSourceへ別operationのopen mountを2件作らない", () => {
    const repository = createSpoolMountRepository();
    const mount = createMount();
    const second = createMount({
      spoolId: "spool:black-pla",
      mountOperationId: "mount-op:002",
    });

    expect(repository.recordMount(mount)).toMatchObject({ ok: true, action: "insert" });
    const result = repository.recordMount(second);

    expect(result).toMatchObject({ ok: false, action: "conflict" });
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        type: "source-open-mount-conflict",
        reason: "material-source-already-has-open-mount",
      }),
    ]);
    expect(repository.listMountsForSource("material-source:k2:1a")).toHaveLength(1);
  });

  it("1つのSpoolを別Device/別MaterialSourceへ同時openしない", () => {
    const repository = createSpoolMountRepository();
    const mount = createMount();
    const second = createMount({
      materialSourceId: "material-source:k1:direct",
      mountOperationId: "mount-op:003",
    });

    expect(repository.recordMount(mount)).toMatchObject({ ok: true, action: "insert" });
    const result = repository.recordMount(second);

    expect(result).toMatchObject({ ok: false, action: "conflict" });
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        type: "spool-open-mount-conflict",
        reason: "spool-already-mounted-on-another-source",
      }),
    ]);
    expect(repository.listMountsForSpool("spool:silver-pla")).toHaveLength(1);
  });

  it("closed mountはopen indexを占有しない", () => {
    const repository = createSpoolMountRepository();
    const closed = createMount({
      status: SPOOL_MOUNT_STATUS.CLOSED,
      closedAt: "2026-08-31T02:00:00.000Z",
      closedBy: "operator",
    });
    const open = createMount({
      mountOperationId: "mount-op:004",
      openedAt: "2026-08-31T02:00:00.000Z",
    });

    expect(repository.recordMount(closed)).toMatchObject({ ok: true, action: "insert" });
    expect(repository.recordMount(open)).toMatchObject({ ok: true, action: "insert" });
    expect(repository.listMountsForSource("material-source:k2:1a")).toHaveLength(2);
    expect(repository.getOpenMountForSource("material-source:k2:1a")).toMatchObject({ mountId: open.mountId });
  });

  it("OPEN mountを専用APIでCLOSEDへ遷移し、次のopen mountを許可する", () => {
    const repository = createSpoolMountRepository();
    const mount = createMount();
    const next = createMount({
      spoolId: "spool:black-pla",
      mountOperationId: "mount-op:004",
      openedAt: "2026-08-31T02:00:00.000Z",
    });

    expect(repository.recordMount(mount)).toMatchObject({ ok: true, action: "insert" });
    expect(repository.closeMount({
      mountId: mount.mountId,
      closedAt: "2026-08-31T02:00:00.000Z",
      closedBy: "operator",
    })).toMatchObject({ ok: true, action: "close" });
    expect(repository.getOpenMountForSource("material-source:k2:1a")).toBeNull();
    expect(repository.recordMount(next)).toMatchObject({ ok: true, action: "insert" });
    expect(repository.getOpenMountForSource("material-source:k2:1a")).toMatchObject({ mountId: next.mountId });
  });

  it("OPEN mountをcloseした後も元の作成operation再送は冪等成功にする", () => {
    const repository = createSpoolMountRepository();
    const mount = createMount();

    expect(repository.recordMount(mount)).toMatchObject({ ok: true, action: "insert" });
    expect(repository.closeMount({
      mountId: mount.mountId,
      closeOperationId: "close-op:001",
      closedAt: "2026-08-31T02:00:00.000Z",
      closedBy: "operator",
    })).toMatchObject({ ok: true, action: "close" });

    const retry = repository.recordMount(createMount());

    expect(retry).toMatchObject({ ok: true, action: "idempotent" });
    expect(retry.record).toMatchObject({
      mountId: mount.mountId,
      status: SPOOL_MOUNT_STATUS.CLOSED,
      closedAt: "2026-08-31T02:00:00.000Z",
    });
    expect(repository.getConflicts()).toEqual([]);
  });

  it("closeMountの再送は同一payloadなら冪等、差異があればconflictにする", () => {
    const repository = createSpoolMountRepository();
    const mount = createMount();

    expect(repository.recordMount(mount)).toMatchObject({ ok: true, action: "insert" });
    expect(repository.closeMount({
      mountId: mount.mountId,
      closedAt: "2026-08-31T02:00:00.000Z",
      closedBy: "operator",
    })).toMatchObject({ ok: true, action: "close" });
    expect(repository.closeMount({
      mountId: mount.mountId,
      closedAt: "2026-08-31T02:00:00.000Z",
      closedBy: "operator",
    })).toMatchObject({ ok: true, action: "idempotent" });

    const conflict = repository.closeMount({
      mountId: mount.mountId,
      closedAt: "2026-08-31T02:30:00.000Z",
      closedBy: "operator",
    });

    expect(conflict).toMatchObject({ ok: false, action: "conflict" });
    expect(conflict.conflicts).toEqual([
      expect.objectContaining({
        type: "close-payload-conflict",
        reason: "same-mount-close-different-payload",
      }),
    ]);
  });

  it("closeMountはcloseOperationId単位で冪等性を判定し差異をconflictにする", () => {
    const repository = createSpoolMountRepository();
    const mount = createMount();

    expect(repository.recordMount(mount)).toMatchObject({ ok: true, action: "insert" });
    expect(repository.closeMount({
      mountId: mount.mountId,
      closeOperationId: "close-op:001",
      closedAt: "2026-08-31T02:00:00.000Z",
      closedBy: "operator",
    })).toMatchObject({ ok: true, action: "close" });
    expect(repository.closeMount({
      mountId: mount.mountId,
      closeOperationId: "close-op:001",
      closedAt: "2026-08-31T02:00:00.000Z",
      closedBy: "operator",
    })).toMatchObject({ ok: true, action: "idempotent" });

    const conflict = repository.closeMount({
      mountId: mount.mountId,
      closeOperationId: "close-op:001",
      closedAt: "2026-08-31T02:30:00.000Z",
      closedBy: "operator",
    });

    expect(conflict).toMatchObject({ ok: false, action: "conflict" });
    expect(conflict.conflicts).toEqual([
      expect.objectContaining({
        type: "close-operation-payload-conflict",
        reason: "same-close-operation-different-payload",
      }),
    ]);
  });

  it("BLOCKED mountはcloseMountでCLOSEDへ遷移させない", () => {
    const repository = createSpoolMountRepository();
    const blocked = createMount({
      status: SPOOL_MOUNT_STATUS.BLOCKED,
      mountOperationId: "mount-op:blocked",
    });

    expect(repository.recordMount(blocked)).toMatchObject({ ok: true, action: "insert" });
    const result = repository.closeMount({
      mountId: blocked.mountId,
      closeOperationId: "close-op:blocked",
      closedAt: "2026-08-31T02:00:00.000Z",
      closedBy: "operator",
    });

    expect(result).toMatchObject({
      ok: false,
      action: "invalid",
      errors: ["mount-not-open"],
    });
    expect(repository.getMount(blocked.mountId)).toMatchObject({
      status: SPOOL_MOUNT_STATUS.BLOCKED,
    });
  });

  it("同一sourceまたは同一spoolの履歴interval重複を拒否する", () => {
    const repository = createSpoolMountRepository();
    const closed = createMount({
      status: SPOOL_MOUNT_STATUS.CLOSED,
      closedAt: "2026-08-31T02:00:00.000Z",
      closedBy: "operator",
    });
    const overlappingSource = createMount({
      spoolId: "spool:black-pla",
      mountOperationId: "mount-op:005",
      openedAt: "2026-08-31T01:30:00.000Z",
      status: SPOOL_MOUNT_STATUS.CLOSED,
      closedAt: "2026-08-31T03:00:00.000Z",
    });
    const overlappingSpool = createMount({
      materialSourceId: "material-source:k2:1b",
      mountOperationId: "mount-op:006",
      openedAt: "2026-08-31T01:30:00.000Z",
      status: SPOOL_MOUNT_STATUS.CLOSED,
      closedAt: "2026-08-31T03:00:00.000Z",
    });
    const adjacent = createMount({
      mountOperationId: "mount-op:007",
      openedAt: "2026-08-31T02:00:00.000Z",
      status: SPOOL_MOUNT_STATUS.CLOSED,
      closedAt: "2026-08-31T03:00:00.000Z",
    });

    expect(repository.recordMount(closed)).toMatchObject({ ok: true, action: "insert" });
    expect(repository.recordMount(overlappingSource)).toMatchObject({
      ok: false,
      action: "conflict",
      conflicts: [
        expect.objectContaining({
          type: "source-interval-overlap-conflict",
          reason: "material-source-mount-interval-overlap",
        }),
      ],
    });
    expect(repository.recordMount(overlappingSpool)).toMatchObject({
      ok: false,
      action: "conflict",
      conflicts: [
        expect.objectContaining({
          type: "spool-interval-overlap-conflict",
          reason: "spool-mount-interval-overlap",
        }),
      ],
    });
    expect(repository.recordMount(adjacent)).toMatchObject({ ok: true, action: "insert" });
  });

  it("invalid SpoolMountは保存しない", () => {
    const repository = createSpoolMountRepository();
    const mount = {
      ...createMount(),
      status: "clsoed",
    };

    const result = repository.recordMount(mount);

    expect(result).toMatchObject({ ok: false, action: "invalid" });
    expect(result.errors).toContain("invalid-status");
    expect(repository.toJSON().mounts).toEqual([]);
  });
});
