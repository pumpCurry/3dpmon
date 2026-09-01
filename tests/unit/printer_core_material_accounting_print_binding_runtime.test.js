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
 * - Gate 18.9I-2 のcompletion usage runtimeを検証
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1601 (PR #440)
 * @since   1.390.1587 (PR #440)
 * @lastModified 2026-09-01 21:03:29
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MATERIAL_IDENTITY_STRENGTH,
  MATERIAL_ACCOUNTING_PRINT_BINDING_STATUS,
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
        eventCoverageStartedAt: "2026-09-01T08:00:00.000Z",
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
 * MaterialSource観測storeの最終観測時刻を更新する。
 *
 * 【詳細説明】
 * - source continuityはTTL付きfreshnessで判定するため、debit可を期待するテストでは
 *   完了直前の観測へ更新し、stale検査では古い観測をあえて残す。
 *
 * @function markMaterialSourcesObservedAt
 * @param {Object} data - runtime data。
 * @param {string} observedAt - 最終観測時刻。
 * @returns {void}
 */
function markMaterialSourcesObservedAt(data, observedAt) {
  const record = data.materialSourceObservations.byDeviceId["serial:k2"];
  record.lastObservedAt = observedAt;
  for (const source of Object.values(record.latestBySourceId)) {
    source.lastObservedAt = observedAt;
  }
}

/**
 * runtime用monitorDataへ実機観測済み印刷ジョブを設定する。
 *
 * @function attachObservedPrintJob
 * @param {Object} data - runtime data。
 * @param {Object=} options - 観測値オプション。
 * @param {string=} options.hostname - 対象ホスト名。
 * @param {string=} options.deviceId - Printer Core v3 device ID。
 * @param {string=} options.sessionId - Printer Core v3 live shadow session ID。
 * @param {number=} options.connectionGeneration - WebSocket接続世代。
 * @param {string=} options.printJobId - 実機で観測したPrintJob ID。
 * @param {string|null=} options.firstObservedAt - 実機で観測した印刷開始時刻。
 * @param {string|null=} options.observedReceivedAt - 3DPmonが開始観測を受け取った時刻。
 * @returns {string} 設定したホスト名。
 */
function attachObservedPrintJob(data, options = {}) {
  const hostname = options.hostname || "K2Pro-69E7";
  const deviceId = options.deviceId || "serial:k2";
  const sessionId = options.sessionId || "session:k2-live";
  const connectionGeneration = options.connectionGeneration === null
    ? null
    : (options.connectionGeneration || 7);
  const printJobId = options.printJobId || "job:actual-1001";
  const firstObservedAt = options.firstObservedAt === null
    ? null
    : (options.firstObservedAt || "2026-09-01T08:01:00.000Z");
  const observedReceivedAt = options.observedReceivedAt === null
    ? null
    : (options.observedReceivedAt || "2026-09-01T08:01:05.000Z");
  data.machines = {
    ...(data.machines || {}),
    [hostname]: {
      storedData: {
        printId: { rawValue: printJobId },
        state: { rawValue: 2 },
      },
      printStore: {
        current: firstObservedAt
          ? { id: printJobId, startTime: firstObservedAt, firstObservedAt, observedReceivedAt }
          : { id: printJobId, observedReceivedAt },
        history: [],
      },
      runtimeData: {
        printerCoreV3Shadow: {
          deviceId,
          sessionId,
          ...(connectionGeneration === null ? {} : { connectionGeneration }),
          family: "k2",
        },
      },
    },
  };
  return hostname;
}

/**
 * runtime用monitorDataへ実機観測済み完了ジョブを設定する。
 *
 * 【詳細説明】
 * - 完了時runtimeはcaller suppliedな完了時刻やjob IDをauthorityにしないため、
 *   `printStore.history`に保存された機器観測済み履歴をfixture化する。
 *
 * @function attachObservedCompletedPrintJob
 * @param {Object} data - runtime data。
 * @param {Object=} options - 観測値オプション。
 * @param {string=} options.hostname - 対象ホスト名。
 * @param {string=} options.deviceId - Printer Core v3 device ID。
 * @param {string=} options.sessionId - Printer Core v3 live shadow session ID。
 * @param {number|null=} options.connectionGeneration - WebSocket接続世代。
 * @param {string=} options.printJobId - 完了したPrintJob ID。
 * @param {string|null=} options.completedAt - 機器で観測した完了時刻。
 * @param {string|null=} options.observedReceivedAt - 3DPmonが完了履歴を受け取った時刻。
 * @param {number=} options.totalUsedLengthMm - 機器で観測した総使用量。
 * @returns {string} 設定したホスト名。
 */
function attachObservedCompletedPrintJob(data, options = {}) {
  const hostname = options.hostname || "K2Pro-69E7";
  const deviceId = options.deviceId || "serial:k2";
  const sessionId = options.sessionId || "session:k2-live";
  const connectionGeneration = options.connectionGeneration === null
    ? null
    : (options.connectionGeneration || 7);
  const printJobId = options.printJobId || "job:actual-1001";
  const completedAt = options.completedAt === null
    ? null
    : (options.completedAt || "2026-09-01T08:31:00.000Z");
  const observedReceivedAt = options.observedReceivedAt === null
    ? null
    : (options.observedReceivedAt || "2026-09-01T08:31:05.000Z");
  data.machines = {
    ...(data.machines || {}),
    [hostname]: {
      ...(data.machines?.[hostname] || {}),
      storedData: {
        ...(data.machines?.[hostname]?.storedData || {}),
        printId: { rawValue: printJobId },
      },
      printStore: {
        ...(data.machines?.[hostname]?.printStore || {}),
        history: [
          ...(data.machines?.[hostname]?.printStore?.history || []),
          {
            id: printJobId,
            finishTime: completedAt,
            observedReceivedAt,
            printfinish: 1,
            materialUsedMm: options.totalUsedLengthMm ?? 9753,
          },
        ],
      },
      runtimeData: {
        ...(data.machines?.[hostname]?.runtimeData || {}),
        printerCoreV3Shadow: {
          deviceId,
          sessionId,
          ...(connectionGeneration === null ? {} : { connectionGeneration }),
          family: "k2",
        },
      },
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
  beforeEach(() => {
    storageMock.commitMaterialAccountingPrintBindingStoreDurably.mockReset();
    storageMock.saveUnifiedStorage.mockReset();
    for (const key of Object.keys(mockMonitorData)) {
      delete mockMonitorData[key];
    }
  });

  it("観測済みprintJobIdで現在OPENのsource別SpoolMountをprint-start snapshotへ保存する", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const plan = createPlan(data);
    const hostname = attachObservedPrintJob(data);
    const persist = vi.fn(async ({ nextStore }) => {
      data.materialAccountingPrintBindingStore = nextStore;
      return { ok: true, casApplied: true, persisted: true, backend: "test" };
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
      snapshot.trusted,
      snapshot.authority?.canBindUsage,
    ])).toEqual([
      ["T1A", "spool:a", "job:actual-1001", true, true],
      ["T1B", "spool:b", "job:actual-1001", true, true],
    ]);
    expect(data.materialAccountingPrintBindingStore.printStartSnapshots.map((snapshot) => snapshot.issuanceEvidence)).toEqual([
      {
        source: "printer-core-print-binding-runtime",
        deviceId: "serial:k2",
        sessionId: "session:k2-live",
        connectionGeneration: 7,
        printJobId: "job:actual-1001",
        devicePrintStartTime: "2026-09-01T08:01:00.000Z",
        printStartObservedReceivedAt: "2026-09-01T08:01:05.000Z",
        firstObservedAt: "2026-09-01T08:01:00.000Z",
      },
      {
        source: "printer-core-print-binding-runtime",
        deviceId: "serial:k2",
        sessionId: "session:k2-live",
        connectionGeneration: 7,
        printJobId: "job:actual-1001",
        devicePrintStartTime: "2026-09-01T08:01:00.000Z",
        printStartObservedReceivedAt: "2026-09-01T08:01:05.000Z",
        firstObservedAt: "2026-09-01T08:01:00.000Z",
      },
    ]);
  });

  it("同じ実機print-start観測を再評価してもstable identityで冪等になりsnapshotを増やさない", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const plan = createPlan(data);
    const hostname = attachObservedPrintJob(data, {
      printJobId: "job:retry-stable",
      firstObservedAt: "2026-09-01T08:01:00.000Z",
    });
    const persist = vi.fn(async ({ nextStore }) => {
      data.materialAccountingPrintBindingStore = nextStore;
      return { ok: true, casApplied: true, persisted: true, backend: "test" };
    });
    const runtime = createMaterialAccountingPrintBindingRuntime({ data, persist });

    const first = await runtime.recordObservedPrintStart({
      printPlan: plan,
      hostname,
      printJobId: "job:retry-stable",
    });
    data.machines[hostname].printStore.current.startTime = "2026-09-01T08:01:05.000Z";
    data.machines[hostname].printStore.current.firstObservedAt = "2026-09-01T08:01:05.000Z";
    const second = await runtime.recordObservedPrintStart({
      printPlan: plan,
      hostname,
      printJobId: "job:retry-stable",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.status).toBe(MATERIAL_ACCOUNTING_PRINT_BINDING_STATUS.IDEMPOTENT);
    expect(data.materialAccountingPrintBindingStore.printStartSnapshots).toHaveLength(2);
    expect(data.materialAccountingPrintBindingStore.printStartSnapshots.map((snapshot) => snapshot.capturedAt))
      .toEqual(["2026-09-01T08:01:00.000Z", "2026-09-01T08:01:00.000Z"]);
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

  it("custom persistがcasAppliedを返さない場合はruntime storeを更新しない", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const hostname = attachObservedPrintJob(data, { printJobId: "job:loose-persist" });
    const before = data.materialAccountingPrintBindingStore;
    const runtime = createMaterialAccountingPrintBindingRuntime({
      data,
      persist: vi.fn(async () => ({ ok: true, persisted: true, backend: "test" })),
    });

    const result = await runtime.recordObservedPrintStart({
      printPlan: createPlan(data),
      hostname,
      printJobId: "job:loose-persist",
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("print-binding-persist-failed");
    expect(data.materialAccountingPrintBindingStore).toBe(before);
  });

  it("別deviceの現在ジョブ観測だけではPrintPlanのsnapshotを保存しない", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const hostname = attachObservedPrintJob(data, {
      printJobId: "job:wrong-device",
      deviceId: "serial:k2-other",
      sessionId: "session:k2-other",
    });
    const runtime = createMaterialAccountingPrintBindingRuntime({
      data,
      persist: vi.fn(),
    });

    const result = await runtime.recordObservedPrintStart({
      printPlan: createPlan(data),
      hostname,
      printJobId: "job:wrong-device",
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("observed-print-device-mismatch");
    expect(data.materialAccountingPrintBindingStore.printStartSnapshots).toEqual([]);
  });

  it("現在sessionが観測できないPrintJobはtrusted snapshotへ昇格しない", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const hostname = attachObservedPrintJob(data, { printJobId: "job:missing-session" });
    delete data.machines[hostname].runtimeData.printerCoreV3Shadow.sessionId;
    const runtime = createMaterialAccountingPrintBindingRuntime({
      data,
      persist: vi.fn(),
    });

    const result = await runtime.recordObservedPrintStart({
      printPlan: createPlan(data),
      hostname,
      printJobId: "job:missing-session",
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("observed-print-session-required");
    expect(data.materialAccountingPrintBindingStore.printStartSnapshots).toEqual([]);
  });

  it("要求時のconnectionGenerationを観測側で確認できないPrintJobは保存しない", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const hostname = attachObservedPrintJob(data, {
      printJobId: "job:missing-generation",
      connectionGeneration: null,
    });
    const runtime = createMaterialAccountingPrintBindingRuntime({
      data,
      persist: vi.fn(),
    });

    const result = await runtime.recordObservedPrintStart({
      printPlan: createPlan(data),
      hostname,
      printJobId: "job:missing-generation",
      connectionGeneration: 7,
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("observed-print-connection-generation-required");
    expect(data.materialAccountingPrintBindingStore.printStartSnapshots).toEqual([]);
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

  it("実機観測済みjobに開始時刻が無い場合はcaller supplied capturedAtだけではsnapshotを保存しない", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const hostname = attachObservedPrintJob(data, {
      printJobId: "job:missing-observed-time",
      firstObservedAt: null,
    });
    const runtime = createMaterialAccountingPrintBindingRuntime({
      data,
      persist: vi.fn(),
    });

    const result = await runtime.recordObservedPrintStart({
      printPlan: createPlan(data),
      hostname,
      printJobId: "job:missing-observed-time",
      capturedAt: "2026-09-01T08:01:00.000Z",
      bindingOperationId: "binding:missing-observed-time",
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("observed-print-start-time-required");
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

  it("完了時のsource-specific usageをtrusted print-start snapshotへ帰属しCAS成功後だけshadow ledgerへ保存する", async () => {
    const data = createRuntimeData();
    data.usageHistory = [];
    data.filamentSpools = [
      { id: "spool:a", remainingLengthMm: 330000 },
      { id: "spool:b", remainingLengthMm: 330000 },
    ];
    attachOpenMounts(data);
    const plan = createPlan(data);
    const hostname = attachObservedPrintJob(data, {
      printJobId: "job:completion-source-specific",
      firstObservedAt: "2026-09-01T08:01:00.000Z",
    });
    const persist = vi.fn(async ({ nextStore }) => {
      data.materialAccountingPrintBindingStore = nextStore;
      return { ok: true, casApplied: true, backend: "test" };
    });
    const runtime = createMaterialAccountingPrintBindingRuntime({ data, persist });
    await runtime.recordObservedPrintStart({
      printPlan: plan,
      hostname,
      printJobId: "job:completion-source-specific",
    });
    attachObservedCompletedPrintJob(data, {
      hostname,
      printJobId: "job:completion-source-specific",
      completedAt: "2026-09-01T08:31:00.000Z",
      totalUsedLengthMm: 9753,
    });
    markMaterialSourcesObservedAt(data, "2026-09-01T08:30:45.000Z");
    data.machines[hostname].printStore.history.at(-1).materialUsed = "3210,6543";

    const result = await runtime.recordObservedPrintCompletion({
      printPlan: plan,
      hostname,
      printJobId: "job:completion-source-specific",
      resultSetCompleteness: "complete",
    });

    expect(result.ok).toBe(true);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(result.segments.map((segment) => [
      segment.protocolToolAlias,
      segment.spoolId,
      segment.usedLengthMm,
      segment.debit.canDebit,
    ])).toEqual([
      ["T1A", "spool:a", 3210, true],
      ["T1B", "spool:b", 6543, true],
    ]);
    expect(result.usageEvidence.every((evidence) => evidence.trusted === true)).toBe(true);
    expect(data.materialAccountingPrintBindingStore.ledgerEvents).toHaveLength(2);
    expect(data.materialAccountingPrintBindingStore.ledgerEvents.every((event) => event.authority.canDebitRemaining === true)).toBe(true);
    expect(data.usageHistory).toEqual([]);
    expect(data.filamentSpools.map((spool) => spool.remainingLengthMm)).toEqual([330000, 330000]);
  });

  it("K2履歴のmaterialUsed文字列をPrintPlan順のsource-specific usageへ展開する", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const plan = createPlan(data);
    const hostname = attachObservedPrintJob(data, { printJobId: "job:k2-history-material-used" });
    const persist = vi.fn(async ({ nextStore }) => {
      data.materialAccountingPrintBindingStore = nextStore;
      return { ok: true, casApplied: true, backend: "test" };
    });
    const runtime = createMaterialAccountingPrintBindingRuntime({ data, persist });
    await runtime.recordObservedPrintStart({ printPlan: plan, hostname, printJobId: "job:k2-history-material-used" });
    attachObservedCompletedPrintJob(data, {
      hostname,
      printJobId: "job:k2-history-material-used",
      completedAt: "2026-09-01T08:31:00.000Z",
    });
    markMaterialSourcesObservedAt(data, "2026-09-01T08:30:45.000Z");
    data.machines[hostname].printStore.history.at(-1).materialUsed = "3210,6543";

    const result = await runtime.recordObservedPrintCompletion({
      printPlan: plan,
      hostname,
      printJobId: "job:k2-history-material-used",
      resultSetCompleteness: "complete",
      continuityBySourceId: Object.fromEntries(plan.toolAssignments.map((assignment) => [
        assignment.materialSourceId,
        { sourceContinuity: true, freshTopology: true },
      ])),
    });

    expect(result.ok).toBe(true);
    expect(result.segments.map((segment) => [
      segment.protocolToolAlias,
      segment.usedLengthMm,
      segment.debit.canDebit,
    ])).toEqual([
      ["T1A", 3210, true],
      ["T1B", 6543, true],
    ]);
  });

  it("K2履歴のmaterialUsedSourceCsv保存形式からsource-specific usageへ展開する", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const plan = createPlan(data);
    const hostname = attachObservedPrintJob(data, { printJobId: "job:k2-history-source-csv" });
    const persist = vi.fn(async ({ nextStore }) => {
      data.materialAccountingPrintBindingStore = nextStore;
      return { ok: true, casApplied: true, backend: "test" };
    });
    const runtime = createMaterialAccountingPrintBindingRuntime({ data, persist });
    await runtime.recordObservedPrintStart({ printPlan: plan, hostname, printJobId: "job:k2-history-source-csv" });
    attachObservedCompletedPrintJob(data, {
      hostname,
      printJobId: "job:k2-history-source-csv",
      completedAt: "2026-09-01T08:31:00.000Z",
    });
    markMaterialSourcesObservedAt(data, "2026-09-01T08:30:45.000Z");
    data.machines[hostname].printStore.history.at(-1).materialUsedMm = 9753;
    data.machines[hostname].printStore.history.at(-1).materialUsedTotalObserved = true;
    data.machines[hostname].printStore.history.at(-1).materialUsedSourceCsv = "3210,6543";

    const result = await runtime.recordObservedPrintCompletion({
      printPlan: plan,
      hostname,
      printJobId: "job:k2-history-source-csv",
      resultSetCompleteness: "complete",
    });

    expect(result.ok).toBe(true);
    expect(result.segments.map((segment) => [
      segment.protocolToolAlias,
      segment.usedLengthMm,
      segment.debit.canDebit,
    ])).toEqual([
      ["T1A", 3210, true],
      ["T1B", 6543, true],
    ]);
  });

  it("TTL切れのMaterialSource観測ではsource-specific usageをdebit候補へ昇格しない", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const plan = createPlan(data);
    const hostname = attachObservedPrintJob(data, { printJobId: "job:k2-stale-continuity" });
    const persist = vi.fn(async ({ nextStore }) => {
      data.materialAccountingPrintBindingStore = nextStore;
      return { ok: true, casApplied: true, backend: "test" };
    });
    const runtime = createMaterialAccountingPrintBindingRuntime({ data, persist });
    await runtime.recordObservedPrintStart({ printPlan: plan, hostname, printJobId: "job:k2-stale-continuity" });
    attachObservedCompletedPrintJob(data, {
      hostname,
      printJobId: "job:k2-stale-continuity",
      completedAt: "2026-09-01T08:31:00.000Z",
    });
    data.machines[hostname].printStore.history.at(-1).materialUsed = "3210,6543";

    const result = await runtime.recordObservedPrintCompletion({
      printPlan: plan,
      hostname,
      printJobId: "job:k2-stale-continuity",
      resultSetCompleteness: "complete",
    });

    expect(result.ok).toBe(true);
    expect(result.segments.every((segment) => segment.debit.canDebit === false)).toBe(true);
    expect(result.segments.every((segment) => segment.debit.reasons.includes("source-continuity-required"))).toBe(true);
    expect(result.segments.every((segment) => segment.debit.reasons.includes("fresh-topology-required"))).toBe(true);
    expect(result.ledgerEvents.every((event) => event.authority.canDebitRemaining === false)).toBe(true);
  });

  it("print-start後に同一sourceの変更イベントがある場合は完了時freshでもdebit候補へ昇格しない", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const plan = createPlan(data);
    const hostname = attachObservedPrintJob(data, { printJobId: "job:k2-source-changed-during-print" });
    const persist = vi.fn(async ({ nextStore }) => {
      data.materialAccountingPrintBindingStore = nextStore;
      return { ok: true, casApplied: true, backend: "test" };
    });
    const runtime = createMaterialAccountingPrintBindingRuntime({ data, persist });
    await runtime.recordObservedPrintStart({ printPlan: plan, hostname, printJobId: "job:k2-source-changed-during-print" });
    attachObservedCompletedPrintJob(data, {
      hostname,
      printJobId: "job:k2-source-changed-during-print",
      completedAt: "2026-09-01T08:31:00.000Z",
    });
    markMaterialSourcesObservedAt(data, "2026-09-01T08:30:45.000Z");
    const deviceRecord = data.materialSourceObservations.byDeviceId["serial:k2"];
    deviceRecord.events = Array.isArray(deviceRecord.events) ? deviceRecord.events : [];
    deviceRecord.events.push({
      observationId: "mso:serial-k2:source-k2-cfs-1a:changed-during-print",
      deviceId: "serial:k2",
      sourceId: "source:k2:cfs:1a",
      observedAt: "2026-09-01T08:10:00.000Z",
      changeKind: "source-changed",
      before: null,
      after: null,
      authority: "observation-only",
    });
    data.machines[hostname].printStore.history.at(-1).materialUsed = "3210,6543";

    const result = await runtime.recordObservedPrintCompletion({
      printPlan: plan,
      hostname,
      printJobId: "job:k2-source-changed-during-print",
      resultSetCompleteness: "complete",
    });

    const changedSegment = result.segments.find((segment) => segment.protocolToolAlias === "T1A");
    const unchangedSegment = result.segments.find((segment) => segment.protocolToolAlias === "T1B");
    expect(result.ok).toBe(true);
    expect(changedSegment.debit.canDebit).toBe(false);
    expect(changedSegment.debit.reasons).toContain("physical-discontinuity");
    expect(changedSegment.debit.reasons).toContain("source-continuity-required");
    expect(unchangedSegment.debit.canDebit).toBe(true);
  });

  it("print-start後のprovider断は同じsource状態へ復帰してもdebit候補へ昇格しない", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const plan = createPlan(data);
    const hostname = attachObservedPrintJob(data, { printJobId: "job:k2-provider-gap-during-print" });
    const persist = vi.fn(async ({ nextStore }) => {
      data.materialAccountingPrintBindingStore = nextStore;
      return { ok: true, casApplied: true, backend: "test" };
    });
    const runtime = createMaterialAccountingPrintBindingRuntime({ data, persist });
    await runtime.recordObservedPrintStart({ printPlan: plan, hostname, printJobId: "job:k2-provider-gap-during-print" });
    attachObservedCompletedPrintJob(data, {
      hostname,
      printJobId: "job:k2-provider-gap-during-print",
      completedAt: "2026-09-01T08:31:00.000Z",
    });
    markMaterialSourcesObservedAt(data, "2026-09-01T08:30:45.000Z");
    const deviceRecord = data.materialSourceObservations.byDeviceId["serial:k2"];
    deviceRecord.events = Array.isArray(deviceRecord.events) ? deviceRecord.events : [];
    deviceRecord.events.push({
      observationId: "mso:serial-k2:device:provider-disconnected-during-print",
      deviceId: "serial:k2",
      sourceId: null,
      observedAt: "2026-09-01T08:12:00.000Z",
      changeKind: "provider-disconnected",
      before: { providerDisconnectedAt: null },
      after: { providerDisconnectedAt: "2026-09-01T08:12:00.000Z" },
      authority: "observation-only",
    });
    data.machines[hostname].printStore.history.at(-1).materialUsed = "3210,6543";

    const result = await runtime.recordObservedPrintCompletion({
      printPlan: plan,
      hostname,
      printJobId: "job:k2-provider-gap-during-print",
      resultSetCompleteness: "complete",
    });

    expect(result.ok).toBe(true);
    expect(result.segments.every((segment) => segment.debit.canDebit === false)).toBe(true);
    expect(result.segments.every((segment) => segment.debit.reasons.includes("physical-discontinuity"))).toBe(true);
    expect(result.segments.every((segment) => segment.debit.reasons.includes("source-continuity-required"))).toBe(true);
  });

  it("device全体がfreshでもsource固有観測がTTL切れなら該当sourceだけdebit候補へ昇格しない", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const plan = createPlan(data);
    const hostname = attachObservedPrintJob(data, { printJobId: "job:k2-source-specific-ttl" });
    const persist = vi.fn(async ({ nextStore }) => {
      data.materialAccountingPrintBindingStore = nextStore;
      return { ok: true, casApplied: true, backend: "test" };
    });
    const runtime = createMaterialAccountingPrintBindingRuntime({ data, persist });
    await runtime.recordObservedPrintStart({ printPlan: plan, hostname, printJobId: "job:k2-source-specific-ttl" });
    attachObservedCompletedPrintJob(data, {
      hostname,
      printJobId: "job:k2-source-specific-ttl",
      completedAt: "2026-09-01T08:31:00.000Z",
      observedReceivedAt: "2026-09-01T08:31:05.000Z",
    });
    const deviceRecord = data.materialSourceObservations.byDeviceId["serial:k2"];
    deviceRecord.lastObservedAt = "2026-09-01T08:30:45.000Z";
    deviceRecord.latestBySourceId["source:k2:cfs:1a"].lastObservedAt = "2026-09-01T08:02:00.000Z";
    deviceRecord.latestBySourceId["source:k2:cfs:1b"].lastObservedAt = "2026-09-01T08:30:45.000Z";
    data.machines[hostname].printStore.history.at(-1).materialUsed = "3210,6543";

    const result = await runtime.recordObservedPrintCompletion({
      printPlan: plan,
      hostname,
      printJobId: "job:k2-source-specific-ttl",
      resultSetCompleteness: "complete",
    });

    const sourceA = result.segments.find((segment) => segment.protocolToolAlias === "T1A");
    const sourceB = result.segments.find((segment) => segment.protocolToolAlias === "T1B");
    expect(result.ok).toBe(true);
    expect(sourceA.debit.canDebit).toBe(false);
    expect(sourceA.debit.reasons).toContain("source-continuity-required");
    expect(sourceA.debit.reasons).toContain("fresh-topology-required");
    expect(sourceB.debit.canDebit).toBe(true);
  });

  it("printer時計がlocal受信時計とずれていてもlocal観測区間内ならdebit候補へ昇格する", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const plan = createPlan(data);
    const hostname = attachObservedPrintJob(data, {
      printJobId: "job:k2-local-clock-continuity",
      firstObservedAt: "2026-09-01T08:01:00.000Z",
      observedReceivedAt: "2026-09-01T08:01:05.000Z",
    });
    const persist = vi.fn(async ({ nextStore }) => {
      data.materialAccountingPrintBindingStore = nextStore;
      return { ok: true, casApplied: true, backend: "test" };
    });
    const runtime = createMaterialAccountingPrintBindingRuntime({ data, persist });
    await runtime.recordObservedPrintStart({ printPlan: plan, hostname, printJobId: "job:k2-local-clock-continuity" });
    attachObservedCompletedPrintJob(data, {
      hostname,
      printJobId: "job:k2-local-clock-continuity",
      completedAt: "2026-09-01T08:30:30.000Z",
      observedReceivedAt: "2026-09-01T08:31:05.000Z",
    });
    markMaterialSourcesObservedAt(data, "2026-09-01T08:30:45.000Z");
    data.machines[hostname].printStore.history.at(-1).materialUsed = "3210,6543";

    const result = await runtime.recordObservedPrintCompletion({
      printPlan: plan,
      hostname,
      printJobId: "job:k2-local-clock-continuity",
      resultSetCompleteness: "complete",
    });

    expect(result.ok).toBe(true);
    expect(result.segments.map((segment) => segment.debit.canDebit)).toEqual([true, true]);
  });

  it("print-start以後のevent coverageが証明できない場合はdebit候補へ昇格しない", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const plan = createPlan(data);
    const hostname = attachObservedPrintJob(data, { printJobId: "job:k2-event-coverage-missing" });
    const persist = vi.fn(async ({ nextStore }) => {
      data.materialAccountingPrintBindingStore = nextStore;
      return { ok: true, casApplied: true, backend: "test" };
    });
    const runtime = createMaterialAccountingPrintBindingRuntime({ data, persist });
    await runtime.recordObservedPrintStart({ printPlan: plan, hostname, printJobId: "job:k2-event-coverage-missing" });
    attachObservedCompletedPrintJob(data, {
      hostname,
      printJobId: "job:k2-event-coverage-missing",
      completedAt: "2026-09-01T08:31:00.000Z",
    });
    markMaterialSourcesObservedAt(data, "2026-09-01T08:30:45.000Z");
    delete data.materialSourceObservations.byDeviceId["serial:k2"].eventCoverageStartedAt;
    data.machines[hostname].printStore.history.at(-1).materialUsed = "3210,6543";

    const result = await runtime.recordObservedPrintCompletion({
      printPlan: plan,
      hostname,
      printJobId: "job:k2-event-coverage-missing",
      resultSetCompleteness: "complete",
    });

    expect(result.ok).toBe(true);
    expect(result.segments.every((segment) => segment.debit.canDebit === false)).toBe(true);
    expect(result.segments.every((segment) => segment.debit.reasons.includes("source-continuity-required"))).toBe(true);
    expect(result.segments.every((segment) => segment.debit.reasons.includes("fresh-topology-required"))).toBe(true);
  });

  it("完了後に観測されたfreshなMaterialSourceを完了時点のcontinuity証拠へ遡及利用しない", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const plan = createPlan(data);
    const hostname = attachObservedPrintJob(data, {
      printJobId: "job:k2-post-completion-source-observation",
      firstObservedAt: "2026-09-01T08:01:00.000Z",
    });
    const persist = vi.fn(async ({ nextStore }) => {
      data.materialAccountingPrintBindingStore = nextStore;
      return { ok: true, casApplied: true, backend: "test" };
    });
    const runtime = createMaterialAccountingPrintBindingRuntime({ data, persist });
    await runtime.recordObservedPrintStart({
      printPlan: plan,
      hostname,
      printJobId: "job:k2-post-completion-source-observation",
    });
    attachObservedCompletedPrintJob(data, {
      hostname,
      printJobId: "job:k2-post-completion-source-observation",
      completedAt: "2026-09-01T08:31:00.000Z",
    });
    markMaterialSourcesObservedAt(data, "2026-09-01T08:31:30.000Z");
    data.machines[hostname].printStore.history.at(-1).materialUsed = "3210,6543";

    const result = await runtime.recordObservedPrintCompletion({
      printPlan: plan,
      hostname,
      printJobId: "job:k2-post-completion-source-observation",
      resultSetCompleteness: "complete",
    });

    expect(result.ok).toBe(true);
    expect(result.segments.every((segment) => segment.debit.canDebit === false)).toBe(true);
    expect(result.segments.every((segment) => segment.debit.reasons.includes("source-continuity-required"))).toBe(true);
    expect(result.segments.every((segment) => segment.debit.reasons.includes("fresh-topology-required"))).toBe(true);
  });

  it("完了時のcaller PrintPlan assignment変更ではなく保存済みprint-start snapshot順へusageを帰属する", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const plan = createPlan(data);
    const hostname = attachObservedPrintJob(data, { printJobId: "job:k2-history-snapshot-order" });
    const persist = vi.fn(async ({ nextStore }) => {
      data.materialAccountingPrintBindingStore = nextStore;
      return { ok: true, casApplied: true, backend: "test" };
    });
    const runtime = createMaterialAccountingPrintBindingRuntime({ data, persist });
    await runtime.recordObservedPrintStart({ printPlan: plan, hostname, printJobId: "job:k2-history-snapshot-order" });
    attachObservedCompletedPrintJob(data, {
      hostname,
      printJobId: "job:k2-history-snapshot-order",
      completedAt: "2026-09-01T08:31:00.000Z",
    });
    data.machines[hostname].printStore.history.at(-1).materialUsed = "3210,6543";
    const swappedCompletionPlan = {
      ...plan,
      toolAssignments: [...plan.toolAssignments].reverse(),
    };

    const result = await runtime.recordObservedPrintCompletion({
      printPlan: swappedCompletionPlan,
      hostname,
      printJobId: "job:k2-history-snapshot-order",
      resultSetCompleteness: "complete",
    });

    expect(result.ok).toBe(true);
    expect(result.segments.map((segment) => [
      segment.protocolToolAlias,
      segment.spoolId,
      segment.usedLengthMm,
    ])).toEqual([
      ["T1A", "spool:a", 3210],
      ["T1B", "spool:b", 6543],
    ]);
  });

  it("K2履歴のmaterialUsed数がprint-start snapshot数と一致しない場合はsource別帰属をBLOCKする", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const plan = createPlan(data);
    const hostname = attachObservedPrintJob(data, { printJobId: "job:k2-history-extra-usage" });
    const persist = vi.fn(async ({ nextStore }) => {
      data.materialAccountingPrintBindingStore = nextStore;
      return { ok: true, casApplied: true, backend: "test" };
    });
    const runtime = createMaterialAccountingPrintBindingRuntime({ data, persist });
    await runtime.recordObservedPrintStart({ printPlan: plan, hostname, printJobId: "job:k2-history-extra-usage" });
    attachObservedCompletedPrintJob(data, {
      hostname,
      printJobId: "job:k2-history-extra-usage",
      completedAt: "2026-09-01T08:31:00.000Z",
    });
    data.machines[hostname].printStore.history.at(-1).materialUsed = "3210,6543,999";

    const result = await runtime.recordObservedPrintCompletion({
      printPlan: plan,
      hostname,
      printJobId: "job:k2-history-extra-usage",
      resultSetCompleteness: "complete",
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("material-used-source-count-mismatch");
    expect(data.materialAccountingPrintBindingStore.jobMaterialSegments).toEqual([]);
  });

  it("caller supplied materialUsagesだけではtrusted source別usageへ昇格しない", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const plan = createPlan(data);
    const hostname = attachObservedPrintJob(data, { printJobId: "job:caller-usage-untrusted" });
    const persist = vi.fn(async ({ nextStore }) => {
      data.materialAccountingPrintBindingStore = nextStore;
      return { ok: true, casApplied: true, backend: "test" };
    });
    const runtime = createMaterialAccountingPrintBindingRuntime({ data, persist });
    await runtime.recordObservedPrintStart({ printPlan: plan, hostname, printJobId: "job:caller-usage-untrusted" });
    attachObservedCompletedPrintJob(data, {
      hostname,
      printJobId: "job:caller-usage-untrusted",
      completedAt: "2026-09-01T08:31:00.000Z",
    });

    const result = await runtime.recordObservedPrintCompletion({
      printPlan: plan,
      hostname,
      printJobId: "job:caller-usage-untrusted",
      resultSetCompleteness: "complete",
      materialUsages: [
        { protocolToolAlias: "T1A", usedLengthMm: 3210 },
        { protocolToolAlias: "T1B", usedLengthMm: 6543 },
      ],
      continuityBySourceId: Object.fromEntries(plan.toolAssignments.map((assignment) => [
        assignment.materialSourceId,
        { sourceContinuity: true, freshTopology: true },
      ])),
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("observed-material-used-required");
    expect(data.materialAccountingPrintBindingStore.jobMaterialSegments).toEqual([]);
  });

  it("完了時のCAS未適用ではsource-specific usageをruntime storeへ反映しない", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const plan = createPlan(data);
    const hostname = attachObservedPrintJob(data, { printJobId: "job:completion-cas-fail" });
    const persist = vi.fn(async ({ nextStore }) => {
      if (nextStore.printStartSnapshots.length > 0 && nextStore.jobMaterialSegments.length === 0) {
        data.materialAccountingPrintBindingStore = nextStore;
        return { ok: true, casApplied: true, backend: "test" };
      }
      return { ok: false, casApplied: false, reason: "cas-mismatch" };
    });
    const runtime = createMaterialAccountingPrintBindingRuntime({ data, persist });
    await runtime.recordObservedPrintStart({ printPlan: plan, hostname, printJobId: "job:completion-cas-fail" });
    attachObservedCompletedPrintJob(data, { hostname, printJobId: "job:completion-cas-fail" });
    data.machines[hostname].printStore.history.at(-1).materialUsed = "3210,6543";
    const before = data.materialAccountingPrintBindingStore;

    const result = await runtime.recordObservedPrintCompletion({
      printPlan: plan,
      hostname,
      printJobId: "job:completion-cas-fail",
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("print-binding-persist-failed");
    expect(data.materialAccountingPrintBindingStore).toBe(before);
  });

  it("完了履歴が観測できない場合はcaller supplied completedAtだけではusageを保存しない", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const plan = createPlan(data);
    const hostname = attachObservedPrintJob(data, { printJobId: "job:missing-completion" });
    const persist = vi.fn(async ({ nextStore }) => {
      data.materialAccountingPrintBindingStore = nextStore;
      return { ok: true, casApplied: true, backend: "test" };
    });
    const runtime = createMaterialAccountingPrintBindingRuntime({ data, persist });
    await runtime.recordObservedPrintStart({ printPlan: plan, hostname, printJobId: "job:missing-completion" });

    const result = await runtime.recordObservedPrintCompletion({
      printPlan: plan,
      hostname,
      printJobId: "job:missing-completion",
      completedAt: "2026-09-01T08:31:00.000Z",
      materialUsages: [{ protocolToolAlias: "T1A", usedLengthMm: 3210 }],
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("observed-print-completion-required");
    expect(data.materialAccountingPrintBindingStore.jobMaterialSegments).toEqual([]);
  });
});
