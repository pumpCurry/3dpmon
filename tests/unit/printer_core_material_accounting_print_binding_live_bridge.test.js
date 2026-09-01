/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 MaterialAccounting PrintBinding live bridge 単体テスト
 * @file printer_core_material_accounting_print_binding_live_bridge.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_material_accounting_print_binding_live_bridge_test
 *
 * 【機能内容サマリ】
 * - Gate 18.9I のK2/CFS印刷開始UIとPrintBinding runtimeの接続境界を検証
 * - 送信済みMaterialBindingPlanを実機観測job IDへbindするpending bridgeを検証
 * - 完了履歴観測後にsource-specific usage runtimeへ同じPrintPlanを渡す境界を検証
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1599 (PR #440)
 * @since   1.390.1595 (PR #440)
 * @lastModified 2026-09-01 21:16:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeFixtures = vi.hoisted(() => ({
  mockMonitorData: {},
}));

vi.mock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: runtimeFixtures.mockMonitorData,
}));

vi.mock("../../3dp_lib/dashboard_storage.js", () => ({
  commitMaterialAccountingPrintBindingStoreDurably: vi.fn(),
  saveUnifiedStorage: vi.fn(),
}));

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
import { createMaterialAccountingPrintBindingRuntime } from "../../3dp_lib/printer_core/dashboard_material_accounting_print_binding_runtime.js";
import {
  createMaterialBindingCommandBinding,
  createMaterialBindingPlan,
  validateMaterialBindingPlanCommandBinding,
  validateMaterialBindingPlan,
} from "../../3dp_lib/printer_core/dashboard_material_binding_plan.js";
import {
  clearMaterialAccountingPrintBindingLiveBridge,
  forgetMaterialAccountingPrintStartRequest,
  getMaterialAccountingPrintBindingLiveBridgeSnapshot,
  markMaterialAccountingPrintStartRequestSubmitted,
  recordObservedMaterialAccountingPrintCompletion,
  recordObservedMaterialAccountingPrintStart,
  rememberMaterialAccountingPrintStartRequest,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_print_binding_live_bridge.js";

/**
 * K2/CFS印刷開始command request fixtureを生成する。
 *
 * 【詳細説明】
 * - 本fixtureは実transportへ送らず、printmanagerが作るcommand request shapeのうち
 *   live bridgeが必要とするdevice/session/PrintPlan payloadだけを保持する。
 *
 * @function createCommandRequest
 * @returns {Object} Printer Core command request互換fixture。
 */
function createCommandRequest() {
  return {
    commandId: "cmd:k2:print-start:001",
    deviceId: "serial:k2",
    sessionId: "session:k2-live",
    commandKind: "print-start",
    transportKind: "ws9999",
    payload: {
      printPlanId: "ui-k2-cfs:K2Pro-69E7:/mnt/UDISK/printer_data/gcodes/two-color.gcode:hash",
      planKind: "multicolor-cfs",
      asset: {
        path: "/mnt/UDISK/printer_data/gcodes/two-color.gcode",
        fileHash: "sha256:test",
      },
      toolAssignments: [
        {
          toolId: 0,
          protocolToolAlias: "T1A",
          materialSourceId: "source:k2:cfs:1a",
          spoolId: "spool:a",
        },
        {
          toolId: 1,
          protocolToolAlias: "T1B",
          materialSourceId: "source:k2:cfs:1b",
          spoolId: "spool:b",
        },
      ],
      materialSourceIds: [
        "source:k2:cfs:1a",
        "source:k2:cfs:1b",
      ],
      startContext: {
        sessionId: "session:k2-live",
        connectionGeneration: 7,
        uploadGeneration: "upload:two-color:1",
      },
    },
  };
}

/**
 * live bridge実runtime composition用のMaterialSource観測storeを生成する。
 *
 * 【詳細説明】
 * - repositoryはprint-start時点のMaterialSourceとSpoolMountを実storeから再解決するため、
 *   bridge単体mockではなく実runtime/repositoryを通すfixtureとして利用する。
 *
 * @function createMaterialSourceObservationStore
 * @param {string=} deviceId - Device ID。
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
        lastObservedAt: "2026-09-01T08:01:04.000Z",
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
 * 実runtime用monitorData互換fixtureを生成する。
 *
 * @function createRuntimeData
 * @returns {Object} monitorData互換fixture。
 */
function createRuntimeData() {
  return {
    machines: {
      "K2Pro-69E7": {
        storedData: {
          printId: { rawValue: "job:new-1001" },
          state: { rawValue: 2 },
        },
        printStore: {
          current: {
            id: "job:new-1001",
            startTime: "2026-09-01T08:01:05.000Z",
            firstObservedAt: "2026-09-01T08:01:05.000Z",
          },
          history: [],
        },
        runtimeData: {
          printerCoreV3Shadow: {
            deviceId: "serial:k2",
            sessionId: "session:k2-live",
            connectionGeneration: 7,
          },
        },
      },
    },
    materialSourceObservations: createMaterialSourceObservationStore(),
    materialAccountingSpoolMountStore: createEmptyMaterialAccountingSpoolMountStore(),
    materialAccountingPrintBindingStore: normalizeStoredMaterialAccountingPrintBindingStore(null),
  };
}

/**
 * 実runtime用fixtureへCFS 1A/1BのOPEN mountを設定する。
 *
 * @function attachOpenMounts
 * @param {Object} data - monitorData互換fixture。
 * @returns {void}
 */
function attachOpenMounts(data) {
  data.materialAccountingSpoolMountStore = {
    ...data.materialAccountingSpoolMountStore,
    spoolMounts: [
      createSpoolMountRecord({
        materialSourceId: "source:k2:cfs:1a",
        spoolId: "spool:a",
        mountOperationId: "mount:a",
        openedAt: "2026-09-01T07:30:00.000Z",
        openedBy: "operator",
        status: SPOOL_MOUNT_STATUS.OPEN,
        verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
        sourceIdentityStrengthAtOpen: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
      }),
      createSpoolMountRecord({
        materialSourceId: "source:k2:cfs:1b",
        spoolId: "spool:b",
        mountOperationId: "mount:b",
        openedAt: "2026-09-01T07:30:00.000Z",
        openedBy: "operator",
        status: SPOOL_MOUNT_STATUS.OPEN,
        verification: SPOOL_MOUNT_VERIFICATION.OPERATOR_CONFIRMED,
        sourceIdentityStrengthAtOpen: MATERIAL_IDENTITY_STRENGTH.PROVISIONAL,
      }),
    ],
  };
}

/**
 * K2/CFS UI用の正式MaterialBindingPlan fixtureを生成する。
 *
 * @function createBindingPlan
 * @returns {Object} MaterialBindingPlan fixture。
 */
function createBindingPlan(commandRequest = createCommandRequest()) {
  const payload = commandRequest.payload || {};
  return createMaterialBindingPlan({
    deviceId: commandRequest.deviceId,
    bindingPlanId: payload.printPlanId || "binding-plan:k2:two-color",
    planKind: "material-binding-plan",
    asset: {
      path: payload.asset?.path || "/mnt/UDISK/printer_data/gcodes/two-color.gcode",
      fileHash: payload.asset?.fileHash || "sha256:test",
      uploadGeneration: payload.startContext?.uploadGeneration || "upload:two-color:1",
    },
    toolAssignments: payload.toolAssignments || [],
    startContext: {
      sessionId: commandRequest.sessionId,
      connectionGeneration: payload.startContext?.connectionGeneration || commandRequest.connectionGeneration || null,
      uploadGeneration: payload.startContext?.uploadGeneration || "upload:two-color:1",
    },
    commandBinding: createMaterialBindingCommandBinding(commandRequest),
  });
}

describe("MaterialAccountingPrintBindingLiveBridge", () => {
  beforeEach(() => {
    clearMaterialAccountingPrintBindingLiveBridge();
  });

  it("K2/CFS印刷開始requestをpending MaterialBindingPlanとして保持し送信だけではruntimeへ保存しない", () => {
    const runtime = {
      recordObservedPrintStart: vi.fn(),
    };

    const pending = rememberMaterialAccountingPrintStartRequest({
      hostname: "K2Pro-69E7",
      commandRequest: createCommandRequest(),
      materialBindingPlan: createBindingPlan(),
      preparedAt: "2026-09-01T10:00:00.000Z",
    });

    expect(runtime.recordObservedPrintStart).not.toHaveBeenCalled();
    expect(pending.printPlan.deviceId).toBe("serial:k2");
    expect(pending.sessionId).toBe("session:k2-live");
    expect(pending.printPlan.toolAssignments.map((assignment) => assignment.protocolToolAlias)).toEqual(["T1A", "T1B"]);
    expect(getMaterialAccountingPrintBindingLiveBridgeSnapshot().pendingByHost["K2Pro-69E7"].printPlan.printPlanId)
      .toBe("ui-k2-cfs:K2Pro-69E7:/mnt/UDISK/printer_data/gcodes/two-color.gcode:hash");
  });

  it("実機観測printJobIdが来たときだけpending MaterialBindingPlanをprint-start runtimeへ一度だけ渡す", async () => {
    const runtime = {
      recordObservedPrintStart: vi.fn(async () => ({ ok: true, status: "recorded" })),
    };
    rememberMaterialAccountingPrintStartRequest({
      hostname: "K2Pro-69E7",
      commandRequest: createCommandRequest(),
      materialBindingPlan: createBindingPlan(),
      preparedAt: "2026-09-01T10:00:00.000Z",
    });
    markMaterialAccountingPrintStartRequestSubmitted({
      hostname: "K2Pro-69E7",
      commandId: "cmd:k2:print-start:001",
      submittedAt: "2026-09-01T10:00:00.000Z",
    });

    const first = await recordObservedMaterialAccountingPrintStart({
      hostname: "K2Pro-69E7",
      printJobId: "1785991119",
      firstObservedAt: "2026-09-01T10:00:05.000Z",
      observedReceivedAt: "2026-09-01T10:00:05.000Z",
      runtime,
    });
    const second = await recordObservedMaterialAccountingPrintStart({
      hostname: "K2Pro-69E7",
      printJobId: "1785991119",
      firstObservedAt: "2026-09-01T10:00:05.000Z",
      observedReceivedAt: "2026-09-01T10:00:05.000Z",
      runtime,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.status).toBe("already-recorded");
    expect(runtime.recordObservedPrintStart).toHaveBeenCalledTimes(1);
    expect(runtime.recordObservedPrintStart).toHaveBeenCalledWith(expect.objectContaining({
      hostname: "K2Pro-69E7",
      printJobId: "1785991119",
      sessionId: "session:k2-live",
      connectionGeneration: 7,
      printPlan: expect.objectContaining({
        deviceId: "serial:k2",
        printPlanId: "ui-k2-cfs:K2Pro-69E7:/mnt/UDISK/printer_data/gcodes/two-color.gcode:hash",
      }),
    }));
  });

  it("print-start記録済みpendingだけを完了runtimeへ渡しsource集合completeとして要求する", async () => {
    const runtime = {
      recordObservedPrintStart: vi.fn(async () => ({ ok: true, status: "recorded" })),
      recordObservedPrintCompletion: vi.fn(async () => ({ ok: true, status: "recorded" })),
    };
    rememberMaterialAccountingPrintStartRequest({
      hostname: "K2Pro-69E7",
      commandRequest: createCommandRequest(),
      materialBindingPlan: createBindingPlan(),
      preparedAt: "2026-09-01T10:00:00.000Z",
    });
    markMaterialAccountingPrintStartRequestSubmitted({
      hostname: "K2Pro-69E7",
      commandId: "cmd:k2:print-start:001",
      submittedAt: "2026-09-01T10:00:00.000Z",
    });
    await recordObservedMaterialAccountingPrintStart({
      hostname: "K2Pro-69E7",
      printJobId: "1785991119",
      firstObservedAt: "2026-09-01T10:00:05.000Z",
      observedReceivedAt: "2026-09-01T10:00:05.000Z",
      runtime,
    });

    const first = await recordObservedMaterialAccountingPrintCompletion({
      hostname: "K2Pro-69E7",
      printJobId: "1785991119",
      runtime,
    });
    const second = await recordObservedMaterialAccountingPrintCompletion({
      hostname: "K2Pro-69E7",
      printJobId: "1785991119",
      runtime,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.status).toBe("blocked");
    expect(second.reasons).toContain("recorded-print-start-required");
    expect(runtime.recordObservedPrintCompletion).toHaveBeenCalledTimes(1);
    expect(runtime.recordObservedPrintCompletion).toHaveBeenCalledWith(expect.objectContaining({
      hostname: "K2Pro-69E7",
      printJobId: "1785991119",
      sessionId: "session:k2-live",
      connectionGeneration: 7,
      resultSetCompleteness: "complete",
      printPlan: expect.objectContaining({
        materialSourceIds: ["source:k2:cfs:1a", "source:k2:cfs:1b"],
      }),
    }));
  });

  it("送信失敗時はhostname単位でpending MaterialBindingPlanを破棄できる", () => {
    rememberMaterialAccountingPrintStartRequest({
      hostname: "K2Pro-69E7",
      commandRequest: createCommandRequest(),
      materialBindingPlan: createBindingPlan(),
      preparedAt: "2026-09-01T10:00:00.000Z",
    });

    const removed = forgetMaterialAccountingPrintStartRequest({
      hostname: "K2Pro-69E7",
    });

    expect(removed).toBe(true);
    expect(getMaterialAccountingPrintBindingLiveBridgeSnapshot().pendingByHost).toEqual({});
  });

  it("正式MaterialBindingPlanをpendingへ保持し実runtime/repositoryで2 source snapshotを保存する", async () => {
    const data = createRuntimeData();
    attachOpenMounts(data);
    const runtime = createMaterialAccountingPrintBindingRuntime({
      data,
      persist: async ({ nextStore }) => ({ ok: true, casApplied: true, nextStore }),
    });
    const commandRequest = createCommandRequest();

    rememberMaterialAccountingPrintStartRequest({
      hostname: "K2Pro-69E7",
      commandRequest,
      materialBindingPlan: createBindingPlan(),
      submittedAt: "2026-09-01T08:01:00.000Z",
    });
    markMaterialAccountingPrintStartRequestSubmitted({
      hostname: "K2Pro-69E7",
      commandId: commandRequest.commandId,
      submittedAt: "2026-09-01T08:01:03.000Z",
    });

    const result = await recordObservedMaterialAccountingPrintStart({
      hostname: "K2Pro-69E7",
      printJobId: "job:new-1001",
      firstObservedAt: "2026-09-01T08:01:05.000Z",
      observedReceivedAt: "2026-09-01T08:01:05.000Z",
      runtime,
    });

    expect(result.ok).toBe(true);
    expect(data.materialAccountingPrintBindingStore.printStartSnapshots).toHaveLength(2);
    expect(data.materialAccountingPrintBindingStore.printStartSnapshots.map((snapshot) => [
      snapshot.protocolToolAlias,
      snapshot.materialSource.aliases.includes(`source:k2:cfs:1${snapshot.protocolToolAlias.slice(-1).toLowerCase()}`),
      snapshot.spoolId,
    ])).toEqual([
      ["T1A", true, "spool:a"],
      ["T1B", true, "spool:b"],
    ]);
  });

  it("MaterialBindingPlanはmodule attestationが壊れたplain objectを拒否する", () => {
    const plan = createBindingPlan();
    const cloned = structuredClone(plan);
    cloned.toolAssignments[0].materialSourceId = "source:k2:cfs:1d";

    const validation = validateMaterialBindingPlan(cloned);

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain("untrusted-material-binding-plan");
  });

  it("MaterialBindingPlanは実transport command requestと一致するcommandBindingだけを信頼する", () => {
    const commandRequest = createCommandRequest();
    const plan = createBindingPlan(commandRequest);
    const mismatchedRequest = createCommandRequest();
    mismatchedRequest.payload.asset.path = "/mnt/UDISK/printer_data/gcodes/other.gcode";

    const matching = validateMaterialBindingPlanCommandBinding(plan, commandRequest);
    const mismatched = validateMaterialBindingPlanCommandBinding(plan, mismatchedRequest);

    expect(matching).toEqual({
      ok: true,
      errors: [],
      commandBinding: expect.objectContaining({
        commandId: "cmd:k2:print-start:001",
        remotePath: "/mnt/UDISK/printer_data/gcodes/two-color.gcode",
      }),
    });
    expect(mismatched.ok).toBe(false);
    expect(mismatched.errors).toContain("material-binding-command-binding-digest-mismatch");
  });

  it("MaterialBindingPlanとtransport command requestが一致しない場合はpending登録を拒否する", () => {
    const commandRequest = createCommandRequest();
    const mismatchedRequest = createCommandRequest();
    mismatchedRequest.payload.toolAssignments = [
      {
        toolId: 0,
        protocolToolAlias: "T1A",
        materialSourceId: "source:k2:cfs:1d",
        spoolId: "spool:d",
      },
    ];

    expect(() => rememberMaterialAccountingPrintStartRequest({
      hostname: "K2Pro-69E7",
      commandRequest: mismatchedRequest,
      materialBindingPlan: createBindingPlan(commandRequest),
      preparedAt: "2026-09-01T10:00:00.000Z",
    })).toThrow(/material-binding-command-binding-digest-mismatch/);
  });

  it("MaterialBindingPlanはspool未割当sourceでもtransport binding候補として保持できる", () => {
    const plan = createMaterialBindingPlan({
      deviceId: "serial:k2",
      bindingPlanId: "binding-plan:k2:unmounted-source",
      asset: {
        path: "/mnt/UDISK/printer_data/gcodes/single.gcode",
        fileHash: "sha256:remote-list-hash",
      },
      toolAssignments: [{
        toolId: 0,
        protocolToolAlias: "T1A",
        materialSourceId: "source:k2:cfs:1a",
      }],
      startContext: {
        sessionId: "session:k2:1",
        connectionGeneration: 3,
      },
    });

    expect(plan.toolAssignments[0].spoolId).toBeNull();
    expect(validateMaterialBindingPlan(plan)).toEqual({ ok: true, errors: [] });
  });

  it("送信成功前のstart観測は保留しsubmitted後に同じ観測を再評価する", async () => {
    const runtime = {
      recordObservedPrintStart: vi.fn(async () => ({ ok: true, status: "recorded" })),
    };
    const commandRequest = createCommandRequest();
    rememberMaterialAccountingPrintStartRequest({
      hostname: "K2Pro-69E7",
      commandRequest,
      materialBindingPlan: createBindingPlan(),
      submittedAt: "2026-09-01T08:01:00.000Z",
    });

    const prepared = await recordObservedMaterialAccountingPrintStart({
      hostname: "K2Pro-69E7",
      printJobId: "job:new-1001",
      firstObservedAt: "2026-09-01T08:01:05.000Z",
      observedReceivedAt: "2026-09-01T08:01:05.000Z",
      runtime,
    });
    const submitted = await markMaterialAccountingPrintStartRequestSubmitted({
      hostname: "K2Pro-69E7",
      commandId: commandRequest.commandId,
      submittedAt: "2026-09-01T08:01:03.000Z",
      runtime,
    });

    expect(prepared.ok).toBe(false);
    expect(prepared.reasons).toContain("command-submit-not-confirmed");
    expect(submitted.ok).toBe(true);
    expect(runtime.recordObservedPrintStart).toHaveBeenCalledTimes(1);
    expect(runtime.recordObservedPrintStart).toHaveBeenCalledWith(expect.objectContaining({
      printJobId: "job:new-1001",
    }));
  });

  it("本番同様にsubmitted通知側がruntimeを持たない場合も先着start観測を再評価する", async () => {
    const runtime = {
      recordObservedPrintStart: vi.fn(async () => ({ ok: true, status: "recorded" })),
    };
    const commandRequest = createCommandRequest();
    rememberMaterialAccountingPrintStartRequest({
      hostname: "K2Pro-69E7",
      commandRequest,
      materialBindingPlan: createBindingPlan(),
      submittedAt: "2026-09-01T08:01:00.000Z",
    });

    const prepared = await recordObservedMaterialAccountingPrintStart({
      hostname: "K2Pro-69E7",
      printJobId: "job:new-1001",
      firstObservedAt: "2026-09-01T08:01:05.000Z",
      observedReceivedAt: "2026-09-01T08:01:05.000Z",
      runtime,
    });
    const submitted = await markMaterialAccountingPrintStartRequestSubmitted({
      hostname: "K2Pro-69E7",
      commandId: commandRequest.commandId,
      submittedAt: "2026-09-01T08:01:03.000Z",
    });

    expect(prepared.ok).toBe(false);
    expect(prepared.reasons).toContain("command-submit-not-confirmed");
    expect(submitted.ok).toBe(true);
    expect(runtime.recordObservedPrintStart).toHaveBeenCalledTimes(1);
    expect(runtime.recordObservedPrintStart).toHaveBeenCalledWith(expect.objectContaining({
      printJobId: "job:new-1001",
    }));
  });

  it("装置printStartTimeがsubmittedより古くても3DPmon受信時刻が送信後なら新jobとしてbindする", async () => {
    const runtime = {
      recordObservedPrintStart: vi.fn(async () => ({ ok: true, status: "recorded" })),
    };
    const commandRequest = createCommandRequest();
    rememberMaterialAccountingPrintStartRequest({
      hostname: "K2Pro-69E7",
      commandRequest,
      materialBindingPlan: createBindingPlan(commandRequest),
      submittedAt: "2026-09-01T10:00:00.000Z",
    });
    markMaterialAccountingPrintStartRequestSubmitted({
      hostname: "K2Pro-69E7",
      commandId: commandRequest.commandId,
      submittedAt: "2026-09-01T10:00:00.000Z",
    });

    const result = await recordObservedMaterialAccountingPrintStart({
      hostname: "K2Pro-69E7",
      printJobId: "job:new-1001",
      devicePrintStartTime: "2026-09-01T09:59:50.000Z",
      observedReceivedAt: "2026-09-01T10:00:05.000Z",
      runtime,
    });

    expect(result.ok).toBe(true);
    expect(runtime.recordObservedPrintStart).toHaveBeenCalledWith(expect.objectContaining({
      printJobId: "job:new-1001",
      capturedAt: "2026-09-01T09:59:50.000Z",
    }));
  });

  it("3DPmon受信時刻がsubmittedより古いstart観測は装置printStartTimeが新しくても拒否する", async () => {
    const runtime = {
      recordObservedPrintStart: vi.fn(async () => ({ ok: true, status: "recorded" })),
    };
    const commandRequest = createCommandRequest();
    rememberMaterialAccountingPrintStartRequest({
      hostname: "K2Pro-69E7",
      commandRequest,
      materialBindingPlan: createBindingPlan(commandRequest),
      submittedAt: "2026-09-01T10:00:00.000Z",
    });
    markMaterialAccountingPrintStartRequestSubmitted({
      hostname: "K2Pro-69E7",
      commandId: commandRequest.commandId,
      submittedAt: "2026-09-01T10:00:00.000Z",
    });

    const result = await recordObservedMaterialAccountingPrintStart({
      hostname: "K2Pro-69E7",
      printJobId: "job:new-1001",
      devicePrintStartTime: "2026-09-01T10:00:05.000Z",
      observedReceivedAt: "2026-09-01T09:59:59.000Z",
      runtime,
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("observed-received-before-command-submitted");
    expect(runtime.recordObservedPrintStart).not.toHaveBeenCalled();
  });

  it("baselineと同じ旧job観測は今回commandの新jobとしてbindしない", async () => {
    const runtime = {
      recordObservedPrintStart: vi.fn(async () => ({ ok: true, status: "recorded" })),
    };
    const commandRequest = createCommandRequest();
    commandRequest.payload.startContext.baselinePrintJobId = "job:old-9999";
    rememberMaterialAccountingPrintStartRequest({
      hostname: "K2Pro-69E7",
      commandRequest,
      materialBindingPlan: createBindingPlan(),
      submittedAt: "2026-09-01T08:01:00.000Z",
    });
    markMaterialAccountingPrintStartRequestSubmitted({
      hostname: "K2Pro-69E7",
      commandId: commandRequest.commandId,
      submittedAt: "2026-09-01T08:01:03.000Z",
    });

    const result = await recordObservedMaterialAccountingPrintStart({
      hostname: "K2Pro-69E7",
      printJobId: "job:old-9999",
      firstObservedAt: "2026-09-01T08:01:05.000Z",
      observedReceivedAt: "2026-09-01T08:01:05.000Z",
      runtime,
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("observed-job-matches-baseline");
    expect(runtime.recordObservedPrintStart).not.toHaveBeenCalled();
  });

  it("完了記録成功後はpendingを削除し後続の別jobへ旧planを再bindしない", async () => {
    const runtime = {
      recordObservedPrintStart: vi.fn(async () => ({ ok: true, status: "recorded" })),
      recordObservedPrintCompletion: vi.fn(async () => ({ ok: true, status: "recorded" })),
    };
    const commandRequest = createCommandRequest();
    rememberMaterialAccountingPrintStartRequest({
      hostname: "K2Pro-69E7",
      commandRequest,
      materialBindingPlan: createBindingPlan(),
      submittedAt: "2026-09-01T08:01:00.000Z",
    });
    markMaterialAccountingPrintStartRequestSubmitted({
      hostname: "K2Pro-69E7",
      commandId: commandRequest.commandId,
      submittedAt: "2026-09-01T08:01:03.000Z",
    });
    await recordObservedMaterialAccountingPrintStart({
      hostname: "K2Pro-69E7",
      printJobId: "job:new-1001",
      firstObservedAt: "2026-09-01T08:01:05.000Z",
      observedReceivedAt: "2026-09-01T08:01:05.000Z",
      runtime,
    });

    const completed = await recordObservedMaterialAccountingPrintCompletion({
      hostname: "K2Pro-69E7",
      printJobId: "job:new-1001",
      runtime,
    });
    const later = await recordObservedMaterialAccountingPrintStart({
      hostname: "K2Pro-69E7",
      printJobId: "job:manual-later",
      firstObservedAt: "2026-09-01T08:40:00.000Z",
      observedReceivedAt: "2026-09-01T08:40:00.000Z",
      runtime,
    });

    expect(completed.ok).toBe(true);
    expect(later.ok).toBe(false);
    expect(later.reasons).toContain("pending-print-plan-required");
    expect(getMaterialAccountingPrintBindingLiveBridgeSnapshot().pendingByHost).toEqual({});
  });
});
