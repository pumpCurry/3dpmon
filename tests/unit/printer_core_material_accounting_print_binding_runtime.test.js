/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 MaterialAccounting PrintBinding runtime 単体テスト
 * @file printer_core_material_accounting_print_binding_runtime.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_material_accounting_print_binding_runtime_test
 *
 * 【機能内容サマリ】
 * - Gate 18.9I-1 のprint-start binding runtimeを検証
 * - 実印刷ジョブID観測後にMaterialSource/SpoolMount snapshotを保存する境界を検証
 * - current mount変更ではなくprint-start時点のsource別mountで後続帰属できることを固定
 * - PrintBinding専用CAS成功後だけruntime storeを進める境界を検証
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1589 (PR #440)
 * @since   1.390.1587 (PR #440)
 * @lastModified 2026-09-01 18:15:11
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  MATERIAL_IDENTITY_STRENGTH,
  MATERIAL_SOURCE_KIND,
  SPOOL_MOUNT_STATUS,
  SPOOL_MOUNT_VERIFICATION,
  createSpoolMountRecord,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_contract.js";
import { createEmptyMaterialAccountingSpoolMountStore } from "../../3dp_lib/printer_core/dashboard_material_accounting_mount_store.js";
import {
  normalizeStoredMaterialAccountingPrintBindingStore,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_print_binding.js";
import { createMulticolorCfsPrintPlan } from "../../3dp_lib/printer_core/dashboard_print_plan.js";

const mockMonitorData = {};

vi.mock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: mockMonitorData,
}));

vi.mock("../../3dp_lib/dashboard_storage.js", () => ({
  commitMaterialAccountingPrintBindingStoreDurably: vi.fn(),
  saveUnifiedStorage: vi.fn(),
}));

const storageMock = await import("../../3dp_lib/dashboard_storage.js");

const {
  resolveObservedMaterialSourceRecord,
} = await import("../../3dp_lib/printer_core/dashboard_material_accounting_mount_runtime.js");
const {
  createMaterialAccountingPrintBindingRuntime,
} = await import("../../3dp_lib/printer_core/dashboard_material_accounting_print_binding_runtime.js");

/**
 * テスト用G-code assetを生成する。
 *
 * 【詳細説明】
 * - PrintPlan contractはasset.contentからanalysisを生成するため、logical tool数に対応した
 *   最小G-code本文を作る。
 *
 * @function createAsset
 * @param {string} fileName - G-codeファイル名。
 * @param {number[]} logicalTools - logical tool番号一覧。
 * @returns {Object} PrintPlan用asset。
 */
function createAsset(fileName, logicalTools) {
  const content = logicalTools.map((toolId) => `T${toolId}\nG1 X${toolId}`).join("\n");
  const fileHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  return {
    path: `/mnt/UDISK/printer_data/gcodes/${fileName}`,
    fileName,
    content,
    analyzerVersion: "unit-gcode-analyzer",
    uploadReceipt: {
      receiptId: `upload:${fileName}`,
      deviceId: "serial:k2",
      remotePath: `/mnt/UDISK/printer_data/gcodes/${fileName}`,
      fileHash,
    },
  };
}

/**
 * read-only MaterialSource観測storeを生成する。
 *
 * @function createMaterialSourceObservationStore
 * @param {string} deviceId - Device ID。
 * @returns {Object} materialSourceObservations互換store。
 */
function createMaterialSourceObservationStore(deviceId = "serial:k2") {
  return {
    schemaVersion: 1,
    authority: "observation-only",
    byDeviceId: {
      [deviceId]: {
        deviceId,
        identityStrength: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
        lastObservedAt: "2026-09-01T08:00:00.000Z",
        providerDisconnectedAt: null,
        restoredFromStorage: false,
        latestBySourceId: {
          "source:k2:cfs:1a": {
            sourceId: "source:k2:cfs:1a",
            kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
            unitId: `unit:${deviceId}:cfs:1`,
            unitIndex: 1,
            boxId: 1,
            slotId: 0,
            protocolSlotId: "1A",
            displayLabel: "1A",
            materialSourceIdentityStrength: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
          },
          "source:k2:cfs:1b": {
            sourceId: "source:k2:cfs:1b",
            kind: MATERIAL_SOURCE_KIND.CFS_SLOT,
            unitId: `unit:${deviceId}:cfs:1`,
            unitIndex: 1,
            boxId: 1,
            slotId: 1,
            protocolSlotId: "1B",
            displayLabel: "1B",
            materialSourceIdentityStrength: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
          },
        },
      },
    },
  };
}

/**
 * runtime用monitorData互換データを生成する。
 *
 * @function createRuntimeData
 * @returns {Object} monitorData互換データ。
 */
function createRuntimeData() {
  return {
    machines: {},
    materialSourceObservations: createMaterialSourceObservationStore(),
    materialAccountingSpoolMountStore: createEmptyMaterialAccountingSpoolMountStore(),
    materialAccountingPrintBindingStore: normalizeStoredMaterialAccountingPrintBindingStore(null),
  };
}

/**
 * runtime用monitorDataへ実機観測済み印刷ジョブを設定する。
 *
 * @function attachObservedPrintJob
 * @param {Object} data - runtime data。
 * @param {Object=} options - 観測値オプション。
 * @param {string=} options.hostname - 対象ホスト名。
 * @param {string=} options.printJobId - 実機で観測したPrintJob ID。
 * @returns {string} 設定したホスト名。
 */
function attachObservedPrintJob(data, options = {}) {
  const hostname = options.hostname || "K2Pro-69E7";
  const printJobId = options.printJobId || "job:actual-1001";
  data.machines = {
    ...(data.machines || {}),
    [hostname]: {
      storedData: {
        printId: { rawValue: printJobId },
        state: { rawValue: 2 },
      },
      printStore: {
        current: { id: printJobId },
        history: [],
      },
      runtimeData: {},
    },
  };
  return hostname;
}

/**
 * 観測sourceからcanonical MaterialSource IDを解決する。
 *
 * @function resolveSource
 * @param {Object} data - runtime data。
 * @param {string} sourceId - raw source alias。
 * @param {string} deviceId - Device ID。
 * @returns {Object} MaterialSource record。
 */
function resolveSource(data, sourceId, deviceId = "serial:k2") {
  return resolveObservedMaterialSourceRecord({
    materialSourceObservations: data.materialSourceObservations,
    deviceId,
    materialSourceId: sourceId,
  });
}

/**
 * 2色CFS print planを生成する。
 *
 * @function createPlan
 * @param {Object} data - runtime data。
 * @returns {Object} PrintPlan。
 */
function createPlan(data) {
  const sourceA = resolveSource(data, "source:k2:cfs:1a");
  const sourceB = resolveSource(data, "source:k2:cfs:1b");
  return createMulticolorCfsPrintPlan({
    deviceId: "serial:k2",
    asset: createAsset("two-color.gcode", [0, 1]),
    toolAssignments: [
      {
        toolId: 0,
        protocolToolAlias: "T1A",
        materialSourceId: sourceA.materialSourceId,
        spoolId: "spool:a",
      },
      {
        toolId: 1,
        protocolToolAlias: "T1B",
        materialSourceId: sourceB.materialSourceId,
        spoolId: "spool:b",
      },
    ],
  });
}

/**
 * SpoolMount storeへOPEN mountを設定する。
 *
 * @function attachOpenMounts
 * @param {Object} data - runtime data。
 * @param {Object=} options - 設定オプション。
 * @param {boolean=} options.omitSecond - 2本目を省略する場合true。
 * @returns {Object[]} 生成したmount配列。
 */
function attachOpenMounts(data, options = {}) {
  const sourceA = resolveSource(data, "source:k2:cfs:1a");
  const sourceB = resolveSource(data, "source:k2:cfs:1b");
  const mounts = [
    createSpoolMountRecord({
      materialSourceId: sourceA.materialSourceId,
      spoolId: "spool:a",
      mountOperationId: "mount:a",
      openedAt: "2026-09-01T07:30:00.000Z",
      openedBy: "operator",
      status: SPOOL_MOUNT_STATUS.OPEN,
      verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
      sourceIdentityStrengthAtOpen: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
    }),
  ];
  if (options.omitSecond !== true) {
    mounts.push(createSpoolMountRecord({
      materialSourceId: sourceB.materialSourceId,
      spoolId: "spool:b",
      mountOperationId: "mount:b",
      openedAt: "2026-09-01T07:31:00.000Z",
      openedBy: "operator",
      status: SPOOL_MOUNT_STATUS.OPEN,
      verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
      sourceIdentityStrengthAtOpen: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
    }));
  }
  data.materialAccountingSpoolMountStore = {
    ...createEmptyMaterialAccountingSpoolMountStore(),
    spoolMounts: mounts,
  };
  return mounts;
}

describe("MaterialAccountingPrintBindingRuntime", () => {
  it("観測済みprintJobIdで現在OPENのsource別SpoolMountをprint-start snapshotへ保存する", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const plan = createPlan(data);
    const hostname = attachObservedPrintJob(data);
    const persist = vi.fn(async ({ nextStore }) => {
      data.materialAccountingPrintBindingStore = nextStore;
      return { ok: true, persisted: true, backend: "test" };
    });
    const runtime = createMaterialAccountingPrintBindingRuntime({ data, persist });

    const result = await runtime.recordObservedPrintStart({
      printPlan: plan,
      hostname,
      printJobId: "job:actual-1001",
      capturedAt: "2026-09-01T08:01:00.000Z",
      bindingOperationId: "binding:actual-1001",
    });

    expect(result.ok).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(data.materialAccountingPrintBindingStore.printStartSnapshots.map((snapshot) => [
      snapshot.protocolToolAlias,
      snapshot.spoolId,
      snapshot.printJobId,
    ])).toEqual([
      ["T1A", "spool:a", "job:actual-1001"],
      ["T1B", "spool:b", "job:actual-1001"],
    ]);
  });

  it("実機で観測したprintJobIdが無い場合はsnapshotを保存しない", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const runtime = createMaterialAccountingPrintBindingRuntime({
      data,
      persist: vi.fn(),
    });

    const result = await runtime.recordObservedPrintStart({
      printPlan: createPlan(data),
      capturedAt: "2026-09-01T08:01:00.000Z",
      bindingOperationId: "binding:missing-job",
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("observed-print-job-id-required");
    expect(data.materialAccountingPrintBindingStore.printStartSnapshots).toEqual([]);
  });

  it("現在OPENなSpoolMountが無いsourceを含むprint-startは保存しない", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data, { omitSecond: true });
    const hostname = attachObservedPrintJob(data, { printJobId: "job:missing-mount" });
    const runtime = createMaterialAccountingPrintBindingRuntime({
      data,
      persist: vi.fn(),
    });

    const result = await runtime.recordObservedPrintStart({
      printPlan: createPlan(data),
      hostname,
      printJobId: "job:missing-mount",
      capturedAt: "2026-09-01T08:01:00.000Z",
      bindingOperationId: "binding:missing-mount",
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("spool-mount-required");
    expect(data.materialAccountingPrintBindingStore.printStartSnapshots).toEqual([]);
  });

  it("同じraw source aliasが別deviceにあってもPrintPlanのdeviceだけを解決する", async () => {
    const data = createRuntimeData();
    const hostname = attachObservedPrintJob(data, { printJobId: "job:device-boundary" });
    data.materialSourceObservations.byDeviceId["serial:k2-other"] =
      createMaterialSourceObservationStore("serial:k2-other").byDeviceId["serial:k2-other"];
    const otherSource = resolveSource(data, "source:k2:cfs:1a", "serial:k2-other");
    data.materialAccountingSpoolMountStore = {
      ...createEmptyMaterialAccountingSpoolMountStore(),
      spoolMounts: [
        createSpoolMountRecord({
          materialSourceId: otherSource.materialSourceId,
          spoolId: "spool:other",
          mountOperationId: "mount:other",
          openedAt: "2026-09-01T07:30:00.000Z",
          openedBy: "operator",
          status: SPOOL_MOUNT_STATUS.OPEN,
          verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
          sourceIdentityStrengthAtOpen: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
        }),
      ],
    };
    const runtime = createMaterialAccountingPrintBindingRuntime({
      data,
      persist: vi.fn(),
    });

    const result = await runtime.recordObservedPrintStart({
      printPlan: createPlan(data),
      hostname,
      printJobId: "job:device-boundary",
      capturedAt: "2026-09-01T08:01:00.000Z",
      bindingOperationId: "binding:device-boundary",
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("spool-mount-required");
    expect(data.materialAccountingPrintBindingStore.printStartSnapshots).toEqual([]);
  });

  it("persist失敗時はruntime storeを更新しない", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const hostname = attachObservedPrintJob(data, { printJobId: "job:persist-failed" });
    const before = data.materialAccountingPrintBindingStore;
    const runtime = createMaterialAccountingPrintBindingRuntime({
      data,
      persist: vi.fn(async () => ({ ok: false, reason: "durable-write-failed" })),
    });

    const result = await runtime.recordObservedPrintStart({
      printPlan: createPlan(data),
      hostname,
      printJobId: "job:persist-failed",
      capturedAt: "2026-09-01T08:01:00.000Z",
      bindingOperationId: "binding:persist-failed",
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("print-binding-persist-failed");
    expect(data.materialAccountingPrintBindingStore).toBe(before);
  });

  it("caller自己申告だけのprintJobIdは実機観測済みjobと一致しなければsnapshotを保存しない", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const hostname = attachObservedPrintJob(data, { printJobId: "job:actual-1001" });
    const runtime = createMaterialAccountingPrintBindingRuntime({
      data,
      persist: vi.fn(),
    });

    const result = await runtime.recordObservedPrintStart({
      printPlan: createPlan(data),
      hostname,
      printJobId: "job:forged-9999",
      capturedAt: "2026-09-01T08:01:00.000Z",
      bindingOperationId: "binding:forged-9999",
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("observed-print-job-id-mismatch");
    expect(data.materialAccountingPrintBindingStore.printStartSnapshots).toEqual([]);
  });

  it("既定persistはPrintBinding専用CASが成功するまでruntime storeを進めない", async () => {
    const data = createRuntimeData();
    Object.assign(mockMonitorData, data);
    attachOpenMounts(mockMonitorData);
    const hostname = attachObservedPrintJob(mockMonitorData, { printJobId: "job:cas-default" });
    storageMock.commitMaterialAccountingPrintBindingStoreDurably.mockImplementationOnce(async ({ nextStore }) => {
      expect(mockMonitorData.materialAccountingPrintBindingStore.printStartSnapshots).toEqual([]);
      mockMonitorData.materialAccountingPrintBindingStore = nextStore;
      return { ok: true, casApplied: true, backend: "indexedDB", reason: "cas-applied" };
    });
    const runtime = createMaterialAccountingPrintBindingRuntime();

    const result = await runtime.recordObservedPrintStart({
      printPlan: createPlan(mockMonitorData),
      hostname,
      printJobId: "job:cas-default",
      capturedAt: "2026-09-01T08:01:00.000Z",
      bindingOperationId: "binding:cas-default",
    });

    expect(result.ok).toBe(true);
    expect(storageMock.commitMaterialAccountingPrintBindingStoreDurably).toHaveBeenCalledTimes(1);
    expect(mockMonitorData.materialAccountingPrintBindingStore.printStartSnapshots).toHaveLength(2);
  });

  it("既定persistはPrintBinding専用CAS未適用ならsnapshotを成功扱いしない", async () => {
    const data = createRuntimeData();
    Object.assign(mockMonitorData, data);
    attachOpenMounts(mockMonitorData);
    const hostname = attachObservedPrintJob(mockMonitorData, { printJobId: "job:cas-failed" });
    const before = mockMonitorData.materialAccountingPrintBindingStore;
    storageMock.commitMaterialAccountingPrintBindingStoreDurably.mockResolvedValueOnce({
      ok: false,
      casApplied: false,
      backend: "indexedDB",
      reason: "cas-mismatch",
    });
    const runtime = createMaterialAccountingPrintBindingRuntime();

    const result = await runtime.recordObservedPrintStart({
      printPlan: createPlan(mockMonitorData),
      hostname,
      printJobId: "job:cas-failed",
      capturedAt: "2026-09-01T08:01:00.000Z",
      bindingOperationId: "binding:cas-failed",
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("print-binding-persist-failed");
    expect(mockMonitorData.materialAccountingPrintBindingStore).toBe(before);
  });
});
