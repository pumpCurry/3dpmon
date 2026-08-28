/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 material provider 単体テスト
 * @file printer_core_material_provider.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_material_provider_test
 *
 * 【機能内容サマリ】
 * - K2/CFS と K1C/CFS-C の read-only material provider 境界を検証
 * - Moonraker/CFS-C material entry の presence 注釈が空placeholderをloaded扱いしないことを検証
 *
 * 【公開関数一覧】
 * - なし：Vitest による単体テストのみを提供
 *
 * @version 1.390.1462 (PR #435)
 * @since   1.390.1459 (PR #435)
 * @lastModified 2026-08-28 17:28:29
 * -----------------------------------------------------------
 * @todo
 * - Gate12 live fixture取得後、CFS-C attach/detach時のprovider payload差分を追加する
 */

import { describe, expect, it } from "vitest";

import {
  createCfsMoonrakerBoxMaterialProvider,
} from "../../3dp_lib/printer_core/dashboard_material_provider.js";
import {
  createEmptyMaterialSourceObservations,
  recordMaterialTopologyObservation,
} from "../../3dp_lib/printer_core/dashboard_material_source_observation.js";

describe("Printer Core v3 material provider", () => {
  it("CFS-C providerは実材料観測があるentryだけpresence loadedを明示する", () => {
    const provider = createCfsMoonrakerBoxMaterialProvider();

    const topology = provider.createTopology({
      materialBoxs: [
        {
          id: 1,
          state: 1,
          type: 0,
          materials: [
            { id: 0 },
            { id: 1, name: "White PLA", type: "PLA", color: "#0ffffff" },
            { id: 2, percent: 54 },
          ],
        },
      ],
    }, { connected: true });

    const bySourceId = new Map(topology.sources.map((source) => [source.sourceId, source]));
    expect(bySourceId.get("cfs:1:slot:0")?.presence).toBeUndefined();
    expect(bySourceId.get("cfs:1:slot:1")).toMatchObject({
      presence: "loaded",
      presenceEvidence: {
        sourceProtocol: "creality-moonraker-boxsInfo",
        reason: "observed-material-entry-without-state-code",
      },
    });
    expect(bySourceId.get("cfs:1:slot:2")?.presence).toBe("loaded");
  });

  it("CFS-C providerのloaded注釈はpresence observed maskとして観測ストアへ伝わる", () => {
    const provider = createCfsMoonrakerBoxMaterialProvider();
    const store = createEmptyMaterialSourceObservations();
    const completeTopology = provider.createTopology({
      materialBoxs: [
        {
          id: 1,
          state: 1,
          type: 0,
          materials: [
            { id: 2, name: "Silver PLA", type: "PLA", color: "#0c0c0c0" },
          ],
        },
      ],
    }, { connected: true });
    const complete = recordMaterialTopologyObservation(store, {
      host: "K1C-CFSC",
      deviceId: "material-provider:K1C-CFSC",
      identityStrength: "provisional",
      sessionId: "session-cfsc-provider",
      providerId: provider.providerId,
      providerGeneration: "moonraker-provider-1",
      sequence: 1,
      observedAt: "2026-08-27T12:00:00.000Z",
      topology: completeTopology,
      snapshotCompleteness: "complete",
    });
    const partialTopology = provider.createTopology({
      materialBoxs: [
        {
          id: 1,
          state: 1,
          type: 0,
          materials: [
            { id: 2, name: "Silver PLA Updated" },
          ],
        },
      ],
    }, { connected: true });
    const annotatedPartialSource = partialTopology.sources.find((source) => source.sourceId === "cfs:1:slot:2");

    expect(annotatedPartialSource).toMatchObject({
      presence: "loaded",
      observedFields: {
        status: { presence: true },
      },
      presenceEvidence: {
        sourceProtocol: "creality-moonraker-boxsInfo",
        reason: "observed-material-entry-without-state-code",
      },
    });

    const partial = recordMaterialTopologyObservation(complete.store, {
      host: "K1C-CFSC",
      deviceId: "material-provider:K1C-CFSC",
      identityStrength: "provisional",
      sessionId: "session-cfsc-provider",
      providerId: provider.providerId,
      providerGeneration: "moonraker-provider-1",
      sequence: 2,
      observedAt: "2026-08-27T12:00:10.000Z",
      topology: partialTopology,
      snapshotCompleteness: "partial",
    });

    expect(partial.record.latestBySourceId["cfs:1:slot:2"]).toMatchObject({
      presence: "loaded",
      presenceEvidence: {
        sourceProtocol: "creality-moonraker-boxsInfo",
        reason: "observed-material-entry-without-state-code",
      },
      material: {
        name: "Silver PLA Updated",
        type: "PLA",
        color: {
          displayHex: "c0c0c0",
        },
      },
    });
    expect(partial.changes).toHaveLength(1);
    expect(partial.record.events.filter((event) => event.sourceId === "cfs:1:slot:2")).toHaveLength(2);
  });
});
