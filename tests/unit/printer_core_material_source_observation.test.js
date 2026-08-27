/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 material source 観測ストア単体テスト
 * @file printer_core_material_source_observation.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_material_source_observation_test
 *
 * 【機能内容サマリ】
 * - CFS/CFS-C/外部スプールのread-only material source観測を検証
 * - stable/provisional rekey、atomic batch、freshness導出、semantic change logの契約を固定
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1422 (PR #435)
 * @since   1.390.1422 (PR #435)
 * @lastModified 2026-08-27 23:12:24
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { describe, expect, it } from "vitest";

import {
  createEmptyMaterialSourceObservations,
  deriveMaterialSourceObservationFreshness,
  recordMaterialTopologyObservation,
  rekeyMaterialSourceObservationDevice,
} from "../../3dp_lib/printer_core/dashboard_material_source_observation.js";

function createTopology(overrides = {}) {
  return {
    authority: {
      mode: "read-only-observation",
      canDriveLedger: false,
    },
    provider: {
      providerId: "k2-ws9999-boxsInfo",
      lastObservedAt: "2026-08-27T12:00:00.000Z",
    },
    cfs: {
      connected: true,
      topologyState: "fresh",
    },
    sources: [
      {
        sourceId: "external:0",
        kind: "external-spool",
        slotId: 0,
        material: { type: "", name: "", color: { raw: "", normalized: "", displayHex: "", cssColor: null }, rfid: "" },
        status: { stateCode: 0, selected: false, remaining: { rawPercent: null, normalizedPercent: null, valid: null, confidence: "unknown", authority: "observation-only" } },
      },
      {
        sourceId: "cfs:1:slot:0",
        kind: "cfs-slot",
        unitId: "cfs:1",
        boxId: 1,
        slotId: 0,
        material: { vendor: "Generic", type: "PLA", name: "Generic PLA", color: { raw: "#09ea7ae", normalized: "09ea7ae", displayHex: "9ea7ae", cssColor: "#9ea7ae" }, rfid: null },
        status: { stateCode: 1, selected: false, remaining: { rawPercent: "100", normalizedPercent: 100, valid: true, confidence: "reported", authority: "observation-only", provenance: { source: "boxsInfo" } } },
      },
      {
        sourceId: "cfs:1:slot:2",
        kind: "cfs-slot",
        unitId: "cfs:1",
        boxId: 1,
        slotId: 2,
        material: { vendor: "Generic", type: "PLA", name: "Generic PLA-Silk", color: { raw: "#0c0c0c0", normalized: "0c0c0c0", displayHex: "c0c0c0", cssColor: "#c0c0c0" }, rfid: "" },
        status: { stateCode: 1, selected: true, remaining: { rawPercent: "-5", normalizedPercent: 0, valid: false, confidence: "reported", authority: "observation-only", provenance: { source: "boxsInfo" } } },
      },
    ],
    assignments: [
      { assignmentId: "T1A", sourceId: "cfs:1:slot:2", namespace: "creality-tool", resolution: "observed" },
    ],
    diagnostics: [],
    ...overrides,
  };
}

describe("MaterialSourceObservationStore", () => {
  it("topologyをatomic batchでsnapshot化し、semantic changeだけをbounded logへ追加する", () => {
    const store = createEmptyMaterialSourceObservations();
    const first = recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "k2-session-1",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-1",
      sequence: 10,
      observedAt: "2026-08-27T12:00:00.000Z",
      topology: createTopology(),
      snapshotCompleteness: "complete",
      limits: { maxEventsPerSource: 3, maxEventsPerDevice: 8 },
    });

    expect(first.accepted).toBe(true);
    expect(first.record.observationRevision).toBe(1);
    expect(first.changes.map((change) => change.changeKind)).toEqual([
      "source-observed",
      "source-observed",
      "source-observed",
    ]);
    expect(Object.keys(first.record.latestBySourceId)).toEqual([
      "external:0",
      "cfs:1:slot:0",
      "cfs:1:slot:2",
    ]);
    expect(first.record.latestBySourceId["cfs:1:slot:2"]).toMatchObject({
      selected: true,
      assignments: [{ assignmentId: "T1A", namespace: "creality-tool", resolution: "observed" }],
      remaining: {
        rawPercent: "-5",
        normalizedPercent: 0,
        valid: false,
        authority: "observation-only",
      },
      material: {
        rfid: "",
        color: {
          raw: "#0c0c0c0",
          normalized: "0c0c0c0",
          displayHex: "c0c0c0",
          cssColor: "#c0c0c0",
        },
      },
    });

    const second = recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "k2-session-1",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-1",
      sequence: 11,
      observedAt: "2026-08-27T12:00:10.000Z",
      topology: createTopology(),
      snapshotCompleteness: "complete",
      limits: { maxEventsPerSource: 3, maxEventsPerDevice: 8 },
    });

    expect(second.accepted).toBe(true);
    expect(second.record.observationRevision).toBe(2);
    expect(second.changes).toEqual([]);
    expect(second.record.events).toHaveLength(3);
    expect(second.record.latestBySourceId["cfs:1:slot:2"]).toMatchObject({
      firstObservedAt: "2026-08-27T12:00:00.000Z",
      lastObservedAt: "2026-08-27T12:00:10.000Z",
      lastChangedAt: "2026-08-27T12:00:00.000Z",
    });

    const changedTopology = createTopology({
      sources: createTopology().sources.map((source) => source.sourceId === "cfs:1:slot:2"
        ? { ...source, status: { ...source.status, selected: false } }
        : source),
      assignments: [],
    });
    const third = recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "k2-session-1",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-1",
      sequence: 12,
      observedAt: "2026-08-27T12:00:20.000Z",
      topology: changedTopology,
      snapshotCompleteness: "complete",
      limits: { maxEventsPerSource: 3, maxEventsPerDevice: 8 },
    });

    expect(third.changes.map((change) => change.changeKind)).toEqual(["source-changed"]);
    expect(third.record.latestBySourceId["cfs:1:slot:2"]).toMatchObject({
      selected: false,
      assignments: [],
      lastChangedAt: "2026-08-27T12:00:20.000Z",
    });
  });

  it("provisional deviceの履歴はstable deviceへ安全にrekeyでき、conflict中はmergeしない", () => {
    const store = createEmptyMaterialSourceObservations();
    recordMaterialTopologyObservation(store, {
      host: "192.168.54.153",
      deviceId: "provisional:endpoint:192.168.54.153",
      identityStrength: "provisional",
      sessionId: "session-a",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-1",
      sequence: 1,
      observedAt: "2026-08-27T12:00:00.000Z",
      topology: createTopology(),
    });

    const blocked = rekeyMaterialSourceObservationDevice(store, {
      fromDeviceId: "provisional:endpoint:192.168.54.153",
      toDeviceId: "serial:905251280E69E7",
      observedAt: "2026-08-27T12:00:05.000Z",
      identityConflict: true,
    });
    expect(blocked).toMatchObject({ accepted: false, reason: "identity-conflict" });
    expect(store.byDeviceId["provisional:endpoint:192.168.54.153"]).toBeTruthy();
    expect(store.byDeviceId["serial:905251280E69E7"]).toBeUndefined();

    const moved = rekeyMaterialSourceObservationDevice(store, {
      fromDeviceId: "provisional:endpoint:192.168.54.153",
      toDeviceId: "serial:905251280E69E7",
      observedAt: "2026-08-27T12:00:10.000Z",
      identityConflict: false,
    });
    expect(moved).toMatchObject({ accepted: true, reason: "rekeyed" });
    expect(store.byDeviceId["provisional:endpoint:192.168.54.153"]).toBeUndefined();
    expect(store.byDeviceId["serial:905251280E69E7"]).toMatchObject({
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      aliases: ["provisional:endpoint:192.168.54.153"],
    });
    expect(store.byDeviceId["serial:905251280E69E7"].events.some((event) => event.changeKind === "device-rekeyed")).toBe(true);
  });

  it("stale freshnessは保存値ではなく時刻とprovider状態から導出する", () => {
    const store = createEmptyMaterialSourceObservations();
    const result = recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-a",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-1",
      sequence: 1,
      observedAt: "2026-08-27T12:00:00.000Z",
      topology: createTopology(),
    });

    expect(deriveMaterialSourceObservationFreshness(result.record, {
      now: "2026-08-27T12:00:30.000Z",
      freshTtlMs: 60_000,
    })).toMatchObject({ state: "fresh" });
    expect(deriveMaterialSourceObservationFreshness(result.record, {
      now: "2026-08-27T12:02:00.000Z",
      freshTtlMs: 60_000,
    })).toMatchObject({ state: "stale", reason: "ttl-expired" });
    result.record.providerDisconnectedAt = "2026-08-27T12:00:40.000Z";
    expect(deriveMaterialSourceObservationFreshness(result.record, {
      now: "2026-08-27T12:00:45.000Z",
      freshTtlMs: 60_000,
    })).toMatchObject({ state: "stale", reason: "provider-disconnected" });
  });

  it("partial snapshotは既存sourceを保持し、complete snapshotだけ消失sourceをtombstone化する", () => {
    const store = createEmptyMaterialSourceObservations();
    recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-a",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-1",
      sequence: 1,
      observedAt: "2026-08-27T12:00:00.000Z",
      topology: createTopology(),
      snapshotCompleteness: "complete",
    });

    const partial = recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-a",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-1",
      sequence: 2,
      observedAt: "2026-08-27T12:00:10.000Z",
      topology: createTopology({ sources: [] }),
      snapshotCompleteness: "partial",
    });

    expect(partial.record.latestBySourceId["cfs:1:slot:2"]).toMatchObject({
      presence: "loaded",
      lastObservedAt: "2026-08-27T12:00:00.000Z",
    });

    const complete = recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-a",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-1",
      sequence: 3,
      observedAt: "2026-08-27T12:00:20.000Z",
      topology: createTopology({ sources: [] }),
      snapshotCompleteness: "complete",
    });

    expect(complete.record.latestBySourceId["cfs:1:slot:2"]).toMatchObject({
      presence: "unobserved",
      selected: null,
      tombstoneAt: "2026-08-27T12:00:20.000Z",
    });
    expect(complete.changes.some((change) => change.changeKind === "source-disappeared")).toBe(true);
  });

  it("古いprovider generationやsequenceはsnapshotを巻き戻さない", () => {
    const store = createEmptyMaterialSourceObservations();
    recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-a",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-2",
      sequence: 20,
      observedAt: "2026-08-27T12:01:00.000Z",
      topology: createTopology(),
    });

    const rejected = recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-a",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-1",
      sequence: 19,
      observedAt: "2026-08-27T12:00:50.000Z",
      topology: createTopology({
        sources: [],
      }),
    });

    expect(rejected).toMatchObject({ accepted: false, reason: "stale-provider-generation" });
    expect(store.byDeviceId["serial:905251280E69E7"].latestBySourceId["cfs:1:slot:2"]).toBeTruthy();
  });
});
