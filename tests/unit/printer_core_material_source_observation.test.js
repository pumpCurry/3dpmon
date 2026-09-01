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
 * @version 1.390.1601 (PR #440)
 * @since   1.390.1422 (PR #435)
 * @lastModified 2026-09-01 21:03:29
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { describe, expect, it } from "vitest";

import {
  createEmptyMaterialSourceObservations,
  deriveMaterialSourceObservationFreshness,
  normalizeStoredMaterialSourceObservations,
  recordMaterialTopologyObservation,
  rekeyMaterialSourceObservationDevice,
} from "../../3dp_lib/printer_core/dashboard_material_source_observation.js";
import {
  normalizeK2BoxsInfo,
} from "../../3dp_lib/printer_core/dashboard_normalized_state.js";

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

  it("provider断と復帰をsource semantic差分とは別のdevice-level eventとして保持する", () => {
    const store = createEmptyMaterialSourceObservations();
    recordMaterialTopologyObservation(store, {
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
    });

    const disconnected = recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "k2-session-1",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-1",
      sequence: 11,
      observedAt: "2026-08-27T12:00:10.000Z",
      topology: createTopology({
        cfs: { connected: false, topologyState: "stale" },
        provider: { providerId: "k2-ws9999-boxsInfo", disconnectedAt: "2026-08-27T12:00:09.000Z" },
      }),
      snapshotCompleteness: "partial",
    });
    const reconnected = recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "k2-session-2",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-2",
      sequence: 12,
      observedAt: "2026-08-27T12:00:20.000Z",
      topology: createTopology(),
      snapshotCompleteness: "complete",
    });

    expect(disconnected.changes.some((change) => change.changeKind === "provider-disconnected")).toBe(true);
    expect(reconnected.changes.map((change) => change.changeKind)).toEqual([
      "provider-generation-changed",
      "provider-reconnected",
    ]);
    expect(reconnected.record.providerDisconnectedAt).toBeNull();
    expect(reconnected.record.events.map((event) => event.changeKind)).toContain("provider-disconnected");
    expect(reconnected.record.events.map((event) => event.changeKind)).toContain("provider-reconnected");
  });

  it("event logをtrimした場合はcoverage開始時刻を保持範囲の先頭へ前進させる", () => {
    const store = createEmptyMaterialSourceObservations();
    recordMaterialTopologyObservation(store, {
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
      limits: { maxEventsPerSource: 4, maxEventsPerDevice: 4 },
    });
    const changed = recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "k2-session-1",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-1",
      sequence: 11,
      observedAt: "2026-08-27T12:00:10.000Z",
      topology: createTopology({
        sources: createTopology().sources.map((source) => source.sourceId === "cfs:1:slot:2"
          ? { ...source, status: { ...source.status, selected: false } }
          : source),
        assignments: [],
      }),
      snapshotCompleteness: "complete",
      limits: { maxEventsPerSource: 4, maxEventsPerDevice: 1 },
    });

    expect(changed.record.events).toHaveLength(1);
    expect(changed.record.events[0].changeKind).toBe("source-changed");
    expect(changed.record.eventCoverageStartedAt).toBe("2026-08-27T12:00:10.000Z");
    expect(changed.record.eventCoverageTrimmedAt).toBe("2026-08-27T12:00:10.000Z");
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

  it("明示merge rekeyは既存stable recordへprovisional source履歴を統合する", () => {
    const store = createEmptyMaterialSourceObservations();
    const baseTopology = createTopology();
    recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-stable",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-stable",
      sequence: 1,
      observedAt: "2026-08-27T12:00:00.000Z",
      topology: createTopology({ sources: [baseTopology.sources[0]] }),
      snapshotCompleteness: "complete",
    });
    recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "provisional-shadow:endpoint:192.168.54.153%3A9999",
      identityStrength: "provisional",
      sessionId: "session-provisional",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-provisional",
      sequence: 1,
      observedAt: "2026-08-27T12:01:00.000Z",
      topology: createTopology({ sources: [baseTopology.sources[2]] }),
      snapshotCompleteness: "complete",
    });

    const merged = rekeyMaterialSourceObservationDevice(store, {
      fromDeviceId: "provisional-shadow:endpoint:192.168.54.153%3A9999",
      toDeviceId: "serial:905251280E69E7",
      observedAt: "2026-08-27T12:02:00.000Z",
      mergeIfTargetExists: true,
      identityConflict: false,
    });

    expect(merged).toMatchObject({ accepted: true, reason: "merged" });
    expect(store.byDeviceId["provisional-shadow:endpoint:192.168.54.153%3A9999"]).toBeUndefined();
    expect(store.byDeviceId["serial:905251280E69E7"].latestBySourceId).toMatchObject({
      "external:0": { kind: "external-spool" },
      "cfs:1:slot:2": { kind: "cfs-slot", deviceId: "serial:905251280E69E7" },
    });
    expect(store.byDeviceId["serial:905251280E69E7"].providerStates["k2-ws9999-boxsInfo"]).toMatchObject({
      activeGeneration: "ws-provisional",
      lastSequence: 1,
      retiredGenerations: ["ws-stable"],
    });
    expect(store.byDeviceId["serial:905251280E69E7"].events.some((event) => event.changeKind === "device-merged")).toBe(true);
  });

  it("明示merge rekeyは同一sourceIdではlastObservedAtが新しいsnapshotを採用する", () => {
    const store = createEmptyMaterialSourceObservations();
    const baseTopology = createTopology();
    const oldSource = {
      ...baseTopology.sources[2],
      material: { ...baseTopology.sources[2].material, name: "Old PLA" },
      status: { ...baseTopology.sources[2].status, selected: false },
    };
    const newSource = {
      ...baseTopology.sources[2],
      material: { ...baseTopology.sources[2].material, name: "New PLA" },
      status: { ...baseTopology.sources[2].status, selected: true },
    };
    recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-stable",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-stable",
      sequence: 1,
      observedAt: "2026-08-27T12:00:00.000Z",
      topology: createTopology({ sources: [oldSource] }),
      snapshotCompleteness: "complete",
    });
    recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "provisional-shadow:endpoint:192.168.54.153%3A9999",
      identityStrength: "provisional",
      sessionId: "session-provisional",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-provisional",
      sequence: 1,
      observedAt: "2026-08-27T12:01:00.000Z",
      topology: createTopology({ sources: [newSource] }),
      snapshotCompleteness: "complete",
    });

    const merged = rekeyMaterialSourceObservationDevice(store, {
      fromDeviceId: "provisional-shadow:endpoint:192.168.54.153%3A9999",
      toDeviceId: "serial:905251280E69E7",
      observedAt: "2026-08-27T12:02:00.000Z",
      mergeIfTargetExists: true,
      identityConflict: false,
    });

    expect(merged).toMatchObject({
      accepted: true,
      reason: "merged",
      mergedSourceIds: ["cfs:1:slot:2"],
      skippedSourceIds: [],
    });
    expect(store.byDeviceId["serial:905251280E69E7"].latestBySourceId["cfs:1:slot:2"]).toMatchObject({
      material: { name: "New PLA" },
      selected: true,
      lastObservedAt: "2026-08-27T12:01:00.000Z",
    });
  });

  it("明示merge rekeyは同一sourceId同一時刻の意味不一致をmerge conflict eventとして残す", () => {
    const store = createEmptyMaterialSourceObservations();
    const baseTopology = createTopology();
    const stableSource = {
      ...baseTopology.sources[2],
      material: { ...baseTopology.sources[2].material, name: "Stable PLA" },
    };
    const provisionalSource = {
      ...baseTopology.sources[2],
      material: { ...baseTopology.sources[2].material, name: "Provisional PLA" },
    };
    recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-stable",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-stable",
      sequence: 1,
      observedAt: "2026-08-27T12:00:00.000Z",
      topology: createTopology({ sources: [stableSource] }),
      snapshotCompleteness: "complete",
    });
    recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "provisional-shadow:endpoint:192.168.54.153%3A9999",
      identityStrength: "provisional",
      sessionId: "session-provisional",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-provisional",
      sequence: 1,
      observedAt: "2026-08-27T12:00:00.000Z",
      topology: createTopology({ sources: [provisionalSource] }),
      snapshotCompleteness: "complete",
    });

    const merged = rekeyMaterialSourceObservationDevice(store, {
      fromDeviceId: "provisional-shadow:endpoint:192.168.54.153%3A9999",
      toDeviceId: "serial:905251280E69E7",
      observedAt: "2026-08-27T12:02:00.000Z",
      mergeIfTargetExists: true,
      identityConflict: false,
    });

    expect(merged).toMatchObject({
      accepted: true,
      reason: "merged",
      mergedSourceIds: [],
      skippedSourceIds: ["cfs:1:slot:2"],
      conflictSourceIds: ["cfs:1:slot:2"],
    });
    expect(store.byDeviceId["serial:905251280E69E7"].latestBySourceId["cfs:1:slot:2"]).toMatchObject({
      material: { name: "Stable PLA" },
    });
    expect(store.byDeviceId["serial:905251280E69E7"].events.some((event) => {
      return event.changeKind === "source-merge-conflict" &&
        event.sourceId === "cfs:1:slot:2";
    })).toBe(true);
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

  it("partial snapshot内の疎なsource更新は未観測fieldを前回snapshotから保持する", () => {
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
      topology: createTopology({
        sources: [
          {
            sourceId: "cfs:1:slot:2",
            kind: "cfs-slot",
            unitId: "cfs:1",
            boxId: 1,
            slotId: 2,
            status: { selected: false },
          },
        ],
      }),
      snapshotCompleteness: "partial",
    });

    expect(partial.record.latestBySourceId["cfs:1:slot:2"]).toMatchObject({
      presence: "loaded",
      selected: false,
      material: {
        name: "Generic PLA-Silk",
        color: { displayHex: "c0c0c0" },
      },
      remaining: {
        rawPercent: "-5",
        normalizedPercent: 0,
        valid: false,
      },
      status: { stateCode: 1 },
      assignments: [{ assignmentId: "T1A" }],
      lastObservedAt: "2026-08-27T12:00:10.000Z",
    });
  });

  it("raw partial boxsInfoはNormalizerのmask経由で未観測material/remaining/assignmentを保持する", () => {
    const store = createEmptyMaterialSourceObservations();
    const completeRaw = {
      enable: 1,
      materialBoxs: [
        {
          id: 1,
          type: 0,
          state: 1,
          materials: [
            {
              id: 2,
              state: 1,
              selected: 1,
              vendor: "Generic",
              type: "PLA",
              name: "Generic PLA-Silk",
              color: "#09ea7ae",
              percent: 54,
            },
          ],
        },
      ],
      colorMatch: [
        { id: "T1C", boxId: 1, materialId: 2 },
      ],
    };
    recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-a",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-1",
      sequence: 1,
      observedAt: "2026-08-27T12:00:00.000Z",
      topology: normalizeK2BoxsInfo(completeRaw, { connected: true }),
      snapshotCompleteness: "complete",
    });

    const partialRaw = {
      enable: 1,
      materialBoxs: [
        {
          id: 1,
          type: 0,
          state: 1,
          materials: [
            {
              id: 2,
              selected: 0,
            },
          ],
        },
      ],
    };
    const partialTopology = normalizeK2BoxsInfo(partialRaw, { connected: true });

    expect(partialTopology.observationMask.sections.assignments).toBe(false);
    expect(partialTopology.sources[0].observedFields).toMatchObject({
      material: {
        type: false,
        color: false,
      },
      status: {
        selected: true,
        remaining: false,
        stateCode: false,
      },
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
      topology: partialTopology,
      snapshotCompleteness: "partial",
    });

    expect(partial.accepted).toBe(true);
    expect(partial.record.latestBySourceId["cfs:1:slot:2"]).toMatchObject({
      selected: false,
      presence: "loaded",
      material: {
        type: "PLA",
        name: "Generic PLA-Silk",
        color: {
          raw: "#09ea7ae",
          displayHex: "9ea7ae",
        },
      },
      remaining: {
        normalizedPercent: 54,
        valid: true,
      },
      assignments: [
        { assignmentId: "T1C" },
      ],
    });
  });

  it("presenceだけを明示観測したpartial deltaは前回presenceで上書きしない", () => {
    const store = createEmptyMaterialSourceObservations();
    const first = recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-presence-only",
      providerId: "test-presence-provider",
      providerGeneration: "ws-presence",
      sequence: 1,
      observedAt: "2026-08-27T12:00:00.000Z",
      topology: createTopology({
        sources: [
          {
            sourceId: "cfs:1:slot:0",
            kind: "cfs-slot",
            unitId: "cfs:1",
            boxId: 1,
            slotId: 0,
            presence: "loaded",
            presenceEvidence: {
              sourceProtocol: "test",
              reason: "initial-presence",
            },
            material: { type: "PLA", name: "White PLA" },
            status: { stateCode: null, selected: false },
          },
        ],
      }),
      snapshotCompleteness: "complete",
    });
    const second = recordMaterialTopologyObservation(first.store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-presence-only",
      providerId: "test-presence-provider",
      providerGeneration: "ws-presence",
      sequence: 2,
      observedAt: "2026-08-27T12:00:10.000Z",
      topology: createTopology({
        sources: [
          {
            sourceId: "cfs:1:slot:0",
            kind: "cfs-slot",
            unitId: "cfs:1",
            boxId: 1,
            slotId: 0,
            presence: "empty",
            presenceEvidence: {
              sourceProtocol: "test",
              reason: "presence-only-update",
            },
            observedFields: {
              status: { presence: true },
            },
          },
        ],
      }),
      snapshotCompleteness: "partial",
    });

    expect(second.record.latestBySourceId["cfs:1:slot:0"]).toMatchObject({
      presence: "empty",
      presenceEvidence: {
        sourceProtocol: "test",
        reason: "presence-only-update",
      },
      material: { name: "White PLA" },
    });
  });

  it("providerが明示したpresenceEvidenceをmaterial source snapshotへ保持する", () => {
    const store = createEmptyMaterialSourceObservations();
    const result = recordMaterialTopologyObservation(store, {
      host: "K1C-CFSC",
      deviceId: "material-provider:K1C-CFSC",
      identityStrength: "provisional",
      sessionId: "session-presence-evidence",
      providerId: "creality-cfs-moonraker-box",
      providerGeneration: "moonraker-presence",
      sequence: 1,
      observedAt: "2026-08-27T12:00:00.000Z",
      topology: createTopology({
        sources: [
          {
            sourceId: "cfs:1:slot:2",
            kind: "cfs-slot",
            unitId: "cfs:1",
            boxId: 1,
            slotId: 2,
            presence: "loaded",
            presenceEvidence: {
              sourceProtocol: "creality-moonraker-boxsInfo",
              reason: "observed-material-entry-without-state-code",
            },
            material: { type: "PLA", name: "Silver PLA" },
            status: { stateCode: null, selected: true },
          },
        ],
      }),
      snapshotCompleteness: "complete",
    });

    expect(result.record.latestBySourceId["cfs:1:slot:2"]).toMatchObject({
      presence: "loaded",
      presenceEvidence: {
        sourceProtocol: "creality-moonraker-boxsInfo",
        reason: "observed-material-entry-without-state-code",
      },
    });
  });

  it("raw partial boxsInfoでもcolorMatch空配列が明示観測された場合はassignmentをclearする", () => {
    const store = createEmptyMaterialSourceObservations();
    const completeRaw = {
      enable: 1,
      materialBoxs: [
        {
          id: 1,
          type: 0,
          state: 1,
          materials: [
            { id: 2, state: 1, selected: 1, type: "PLA", name: "PLA", percent: 80 },
          ],
        },
      ],
      colorMatch: [
        { id: "T1C", boxId: 1, materialId: 2 },
      ],
    };
    recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-a",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-1",
      sequence: 1,
      observedAt: "2026-08-27T12:00:00.000Z",
      topology: normalizeK2BoxsInfo(completeRaw, { connected: true }),
      snapshotCompleteness: "complete",
    });

    const clearAssignmentTopology = normalizeK2BoxsInfo({
      enable: 1,
      materialBoxs: [
        {
          id: 1,
          type: 0,
          state: 1,
          materials: [
            { id: 2, selected: 1 },
          ],
        },
      ],
      colorMatch: [],
    }, { connected: true });

    expect(clearAssignmentTopology.observationMask.sections.assignments).toBe(true);

    const result = recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-a",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-1",
      sequence: 2,
      observedAt: "2026-08-27T12:00:10.000Z",
      topology: clearAssignmentTopology,
      snapshotCompleteness: "partial",
    });

    expect(result.accepted).toBe(true);
    expect(result.record.latestBySourceId["cfs:1:slot:2"].assignments).toEqual([]);
    expect(result.record.latestBySourceId["cfs:1:slot:2"].material).toMatchObject({
      type: "PLA",
      name: "PLA",
    });
  });

  it("raw partial colorMatchのみの観測でも既存sourceのassignmentを更新またはclearする", () => {
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
      topology: normalizeK2BoxsInfo({
        enable: 1,
        materialBoxs: [
          {
            id: 1,
            type: 0,
            state: 1,
            materials: [
              { id: 2, state: 1, selected: 1, type: "PLA", name: "PLA", percent: 80 },
            ],
          },
        ],
        colorMatch: [
          { id: "T1C", boxId: 1, materialId: 2 },
        ],
      }, { connected: true }),
      snapshotCompleteness: "complete",
    });

    const updateResult = recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-a",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-1",
      sequence: 2,
      observedAt: "2026-08-27T12:00:10.000Z",
      topology: normalizeK2BoxsInfo({
        enable: 1,
        colorMatch: [
          { id: "T1A", boxId: 1, materialId: 2 },
        ],
      }, { connected: true }),
      snapshotCompleteness: "partial",
    });

    expect(updateResult.accepted).toBe(true);
    expect(updateResult.record.latestBySourceId["cfs:1:slot:2"]).toMatchObject({
      material: {
        type: "PLA",
        name: "PLA",
      },
      remaining: {
        normalizedPercent: 80,
      },
      assignments: [
        { assignmentId: "T1A" },
      ],
    });

    const clearResult = recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-a",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-1",
      sequence: 3,
      observedAt: "2026-08-27T12:00:20.000Z",
      topology: normalizeK2BoxsInfo({
        enable: 1,
        colorMatch: [],
      }, { connected: true }),
      snapshotCompleteness: "partial",
    });

    expect(clearResult.accepted).toBe(true);
    expect(clearResult.record.latestBySourceId["cfs:1:slot:2"].assignments).toEqual([]);
    expect(clearResult.record.latestBySourceId["cfs:1:slot:2"].remaining.normalizedPercent).toBe(80);
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

  it("nullや空文字を0へ変換せず、source ID欠落はdiagnosticへ逃がす", () => {
    const store = createEmptyMaterialSourceObservations();
    const result = recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-null",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-null",
      sequence: 1,
      observedAt: "2026-08-27T12:00:00.000Z",
      topology: createTopology({
        sources: [
          {
            sourceId: "cfs:1:slot:null-state",
            kind: "cfs-slot",
            unitId: "cfs:1",
            boxId: 1,
            slotId: "null-state",
            material: { vendor: "", type: "", name: "", color: null, rfid: null },
            status: { stateCode: null, selected: null, remaining: { rawPercent: null, normalizedPercent: null, valid: null } },
          },
          {
            kind: "cfs-slot",
            unitId: "cfs:1",
            boxId: 1,
            slotId: null,
            material: { vendor: "Generic", type: "PLA" },
            status: { stateCode: 1 },
          },
          {
            kind: "external-spool",
            slotId: "",
            material: { vendor: "Generic", type: "PLA" },
            status: { stateCode: 1 },
          },
        ],
      }),
      snapshotCompleteness: "complete",
    });

    expect(result.accepted).toBe(true);
    expect(result.record.latestBySourceId["cfs:1:slot:null-state"]).toMatchObject({
      presence: "unknown",
      status: {
        stateCode: null,
      },
    });
    expect(result.record.latestBySourceId["cfs:1:slot:0"]).toBeUndefined();
    expect(result.record.latestBySourceId["external:0"]).toBeUndefined();
    expect(result.record.diagnostics.map((entry) => entry.reason)).toEqual([
      "source-id-missing",
      "source-id-missing",
    ]);
  });

  it("残留metadataだけではmaterial source snapshotをloaded扱いしない", () => {
    const store = createEmptyMaterialSourceObservations();
    const result = recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-residual-metadata",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-residual",
      sequence: 1,
      observedAt: "2026-08-27T12:00:00.000Z",
      topology: createTopology({
        sources: [
          {
            sourceId: "cfs:1:slot:0",
            kind: "cfs-slot",
            unitId: "cfs:1",
            boxId: 1,
            slotId: 0,
            material: {
              vendor: "Generic",
              type: "PLA",
              name: "Removed PLA",
              color: { raw: "#0ffffff", normalized: "0ffffff", displayHex: "ffffff", cssColor: "#ffffff" },
              rfid: "old-rfid",
            },
            status: {
              stateCode: 0,
              selected: false,
              remaining: { rawPercent: 100, normalizedPercent: 100, valid: true },
            },
          },
          {
            sourceId: "cfs:1:slot:1",
            kind: "cfs-slot",
            unitId: "cfs:1",
            boxId: 1,
            slotId: 1,
            material: {
              vendor: "Generic",
              type: "PLA",
              name: "Metadata Only PLA",
              color: { raw: "#072a530", normalized: "072a530", displayHex: "72a530", cssColor: "#72a530" },
              rfid: "",
            },
            status: {
              stateCode: null,
              selected: null,
              remaining: { rawPercent: null, normalizedPercent: null, valid: null },
            },
          },
        ],
      }),
      snapshotCompleteness: "complete",
    });

    expect(result.accepted).toBe(true);
    expect(result.record.latestBySourceId["cfs:1:slot:0"]).toMatchObject({
      presence: "empty",
      material: { name: "Removed PLA" },
      status: { stateCode: 0 },
    });
    expect(result.record.latestBySourceId["cfs:1:slot:1"]).toMatchObject({
      presence: "unknown",
      material: { name: "Metadata Only PLA" },
      status: { stateCode: null },
    });
  });

  it("明示observedAtが不正な観測は現在時刻へ化けさせず拒否する", () => {
    const store = createEmptyMaterialSourceObservations();
    const result = recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-invalid-time",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-invalid-time",
      sequence: 1,
      observedAt: "not-a-date",
      topology: createTopology(),
      snapshotCompleteness: "complete",
    });

    expect(result).toMatchObject({ accepted: false, reason: "invalid-observed-at" });
    expect(store.byDeviceId["serial:905251280E69E7"]).toBeUndefined();
  });

  it("新しいprovider generationを受理した後は退役generationの遅延frameを時刻に関係なく拒否する", () => {
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
    });
    const advanced = recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-b",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-2",
      sequence: 1,
      observedAt: "2026-08-27T12:00:10.000Z",
      topology: createTopology(),
    });
    const staleLater = recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-a",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-1",
      sequence: 2,
      observedAt: "2026-08-27T12:00:20.000Z",
      topology: createTopology({ sources: [] }),
      snapshotCompleteness: "complete",
    });

    expect(advanced.accepted).toBe(true);
    expect(advanced.record.providerGeneration).toBe("ws-2");
    expect(advanced.record.retiredProviderGenerations).toEqual(["ws-1"]);
    expect(staleLater).toMatchObject({ accepted: false, reason: "stale-provider-generation" });
    expect(store.byDeviceId["serial:905251280E69E7"].providerGeneration).toBe("ws-2");
    expect(store.byDeviceId["serial:905251280E69E7"].latestBySourceId["cfs:1:slot:2"]).toMatchObject({
      presence: "loaded",
    });
  });

  it("provider generationはproviderId単位で管理し、別providerの切替で互いを退役扱いにしない", () => {
    const store = createEmptyMaterialSourceObservations();
    recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-provider-a",
      providerId: "provider-a",
      providerGeneration: "provider-a:transport:1",
      sequence: 1,
      observedAt: "2026-08-27T12:00:00.000Z",
      topology: createTopology({ provider: { providerId: "provider-a" } }),
      snapshotCompleteness: "complete",
    });
    recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-provider-b",
      providerId: "provider-b",
      providerGeneration: "provider-b:transport:1",
      sequence: 1,
      observedAt: "2026-08-27T12:00:10.000Z",
      topology: createTopology({ provider: { providerId: "provider-b" } }),
      snapshotCompleteness: "partial",
    });
    const providerAHeartbeat = recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-provider-a",
      providerId: "provider-a",
      providerGeneration: "provider-a:transport:1",
      sequence: 2,
      observedAt: "2026-08-27T12:00:20.000Z",
      topology: createTopology({ provider: { providerId: "provider-a" } }),
      snapshotCompleteness: "partial",
    });

    expect(providerAHeartbeat.accepted).toBe(true);
    expect(providerAHeartbeat.record.providerStates).toMatchObject({
      "provider-a": { activeGeneration: "provider-a:transport:1" },
      "provider-b": { activeGeneration: "provider-b:transport:1" },
    });
  });

  it("sequenceの巻き戻し判定はproviderId単位のlastSequenceを優先する", () => {
    const store = createEmptyMaterialSourceObservations();
    recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-provider-a",
      providerId: "provider-a",
      providerGeneration: "provider-a:transport:1",
      sequence: 100,
      observedAt: "2026-08-27T12:00:00.000Z",
      topology: createTopology({ provider: { providerId: "provider-a" } }),
      snapshotCompleteness: "complete",
    });
    const providerBInitial = recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-provider-b",
      providerId: "provider-b",
      providerGeneration: "provider-b:transport:1",
      sequence: 1,
      observedAt: "2026-08-27T12:00:10.000Z",
      topology: createTopology({ provider: { providerId: "provider-b" } }),
      snapshotCompleteness: "partial",
    });
    const providerBAdvanced = recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-provider-b",
      providerId: "provider-b",
      providerGeneration: "provider-b:transport:1",
      sequence: 3,
      observedAt: "2026-08-27T12:00:20.000Z",
      topology: createTopology({ provider: { providerId: "provider-b" } }),
      snapshotCompleteness: "partial",
    });
    const providerBStale = recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-provider-b",
      providerId: "provider-b",
      providerGeneration: "provider-b:transport:1",
      sequence: 2,
      observedAt: "2026-08-27T12:00:30.000Z",
      topology: createTopology({ provider: { providerId: "provider-b" } }),
      snapshotCompleteness: "partial",
    });

    expect(providerBInitial.accepted).toBe(true);
    expect(providerBAdvanced.accepted).toBe(true);
    expect(providerBStale).toMatchObject({ accepted: false, reason: "stale-sequence" });
    expect(store.byDeviceId["serial:905251280E69E7"].providerStates).toMatchObject({
      "provider-a": { lastSequence: 100 },
      "provider-b": { lastSequence: 3 },
    });
  });

  it("provider別の時刻巻き戻し判定はdevice global lastObservedAtを使わない", () => {
    const store = createEmptyMaterialSourceObservations();
    recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-provider-a",
      providerId: "provider-a",
      providerGeneration: "provider-a:transport:1",
      sequence: 1,
      observedAt: "2026-08-27T12:10:00.000Z",
      topology: createTopology({ provider: { providerId: "provider-a" } }),
      snapshotCompleteness: "partial",
    });
    const providerBInitial = recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-provider-b",
      providerId: "provider-b",
      providerGeneration: "provider-b:transport:1",
      sequence: 1,
      observedAt: "2026-08-27T12:00:00.000Z",
      topology: createTopology({ provider: { providerId: "provider-b" } }),
      snapshotCompleteness: "partial",
    });

    expect(providerBInitial.accepted).toBe(true);
    expect(providerBInitial.record.providerStates).toMatchObject({
      "provider-a": { lastObservedAt: "2026-08-27T12:10:00.000Z" },
      "provider-b": { lastObservedAt: "2026-08-27T12:00:00.000Z" },
    });
  });

  it("復元済みrecordはTTL内でもlast-known staleとして扱い、新しいlive観測でfreshへ戻る", () => {
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
    result.record.restoredFromStorage = true;
    result.record.restoredAt = "2026-08-27T12:00:10.000Z";

    expect(deriveMaterialSourceObservationFreshness(result.record, {
      now: "2026-08-27T12:00:20.000Z",
      freshTtlMs: 60_000,
    })).toMatchObject({ state: "stale", reason: "restored-last-known" });

    recordMaterialTopologyObservation(store, {
      host: "K2Pro-69E7",
      deviceId: "serial:905251280E69E7",
      identityStrength: "stable",
      sessionId: "session-a",
      providerId: "k2-ws9999-boxsInfo",
      providerGeneration: "ws-1",
      sequence: 2,
      observedAt: "2026-08-27T12:00:30.000Z",
      topology: createTopology(),
    });

    expect(result.record.restoredFromStorage).toBe(false);
    expect(deriveMaterialSourceObservationFreshness(result.record, {
      now: "2026-08-27T12:00:40.000Z",
      freshTtlMs: 60_000,
    })).toMatchObject({ state: "fresh", reason: "within-ttl" });
  });

  it("stored observation storeはschema-awareに正規化しfuture versionをfail-closedで保持する", () => {
    const legacy = normalizeStoredMaterialSourceObservations({
      byDeviceId: {
        "serial:legacy": {
          deviceId: "serial:legacy",
          latestBySourceId: {},
          events: [],
        },
      },
    }, { restoredAt: "2026-08-27T12:10:00.000Z" });

    expect(legacy).toMatchObject({
      schemaVersion: 1,
      migrationStatus: "current",
      byDeviceId: {
        "serial:legacy": {
          restoredFromStorage: true,
          authority: "observation-only",
        },
      },
    });

    const future = normalizeStoredMaterialSourceObservations({
      schemaVersion: 99,
      byDeviceId: {
        "serial:future": {
          deviceId: "serial:future",
          latestBySourceId: {},
          events: [],
        },
      },
    }, { restoredAt: "2026-08-27T12:10:00.000Z" });

    expect(future).toMatchObject({
      schemaVersion: 99,
      migrationStatus: "future-version-unsupported",
      byDeviceId: {},
      retainedUnsupportedStore: expect.objectContaining({ schemaVersion: 99 }),
    });
  });
});
