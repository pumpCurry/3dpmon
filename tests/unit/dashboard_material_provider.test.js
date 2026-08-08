/**
 * @fileoverview Printer Core v3 material provider の単体テスト
 * @description
 * - K2 boxsInfo provider と K1C/CFS-C Moonraker provider の read-only 契約を検証する。
 * - provider metadata、ledger authority 境界、Moonraker envelope 抽出を fixture なしで確認する。
 *
 * @version 1.390.1340 (PR #432)
 * @since 1.390.1340 (PR #432)
 * @lastModified 2026-08-09 01:26:08
 */

import { describe, expect, it } from "vitest";
import {
  createCfsBoxsInfoMaterialProvider,
  createCfsMoonrakerBoxMaterialProvider,
  createNoCfsMaterialProvider,
  extractMoonrakerBoxsInfoPayload,
} from "../../3dp_lib/printer_core/dashboard_material_provider.js";

/**
 * CFS slot を含む最小 `boxsInfo` payload を生成する。
 *
 * 【詳細説明】
 * - K2 と K1C/CFS-C provider が同じ topology contract を返すことを確認するため、
 *   provider 固有ではない protocol shape だけを入れる。
 *
 * @function createSampleBoxsInfo
 * @returns {object} テスト用 boxsInfo payload
 */
function createSampleBoxsInfo() {
  return {
    enable: 1,
    materialBoxs: [
      {
        id: 1,
        type: 0,
        state: 1,
        temp: 27,
        humidity: 39,
        materials: [
          {
            id: 0,
            vendor: "Creality",
            type: "PLA",
            name: "Hyper PLA",
            color: "#C0C0C0",
            selected: 1,
            percent: 78,
          },
        ],
      },
    ],
    colorMatch: [
      {
        id: "T1C",
        boxId: 1,
        materialId: 0,
      },
    ],
  };
}

describe("Printer Core v3 material provider", () => {
  it("NoCFS providerは常にread-onlyでledger authorityを持たない", () => {
    const provider = createNoCfsMaterialProvider();
    const topology = provider.createTopology();

    expect(provider).toMatchObject({
      providerId: "material:none",
      readOnly: true,
      supportsCfs: false,
      canDriveLedger: false,
      transportKind: "none",
    });
    expect(topology.authority).toMatchObject({
      mode: "read-only-observation",
      canDriveLedger: false,
      providerId: "material:none",
    });
    expect(topology.provider).toMatchObject({
      providerId: "material:none",
      transportKind: "none",
      sourceProtocol: "none",
      canDriveLedger: false,
    });
    expect(topology.cfs.topologyState).toBe("unobserved");
  });

  it("K2 boxsInfo providerはWS9999由来のread-only metadataを付ける", () => {
    const provider = createCfsBoxsInfoMaterialProvider();
    const topology = provider.createTopology(createSampleBoxsInfo(), { connected: true });

    expect(topology.provider).toMatchObject({
      providerId: "creality-cfs-boxs-info",
      transportKind: "ws9999",
      sourceProtocol: "creality-boxsInfo",
      supportsCfs: true,
      canDriveLedger: false,
    });
    expect(topology.cfs).toMatchObject({
      connected: true,
      unitCount: 1,
      topologyState: "fresh",
    });
    expect(topology.sources[0]).toMatchObject({
      sourceId: "cfs:1:slot:0",
      kind: "cfs-slot",
      status: {
        selected: true,
        percent: 78,
      },
    });
    expect(topology.assignments[0]).toMatchObject({
      assignmentId: "T1C",
      sourceId: "cfs:1:slot:0",
      resolution: "resolved",
    });
  });

  it("Moonraker providerはenvelopeを展開してK2と同じtopology contractを返す", () => {
    const provider = createCfsMoonrakerBoxMaterialProvider();
    const topology = provider.createTopology({
      result: {
        boxsInfo: createSampleBoxsInfo(),
      },
    }, { connected: true });

    expect(provider).toMatchObject({
      providerId: "creality-cfs-moonraker-box",
      readOnly: true,
      supportsCfs: true,
      canDriveLedger: false,
      transportKind: "moonraker",
    });
    expect(topology.provider).toMatchObject({
      providerId: "creality-cfs-moonraker-box",
      transportKind: "moonraker",
      sourceProtocol: "creality-moonraker-boxsInfo",
      canDriveLedger: false,
    });
    expect(topology.sources).toHaveLength(1);
    expect(topology.sources[0].sourceId).toBe("cfs:1:slot:0");
    expect(topology.authority).toMatchObject({
      mode: "read-only-observation",
      canDriveLedger: false,
    });
  });

  it("Moonraker envelope抽出はboxsInfoとboxs_infoの代表形を受け付ける", () => {
    const sample = createSampleBoxsInfo();

    expect(extractMoonrakerBoxsInfoPayload({ boxsInfo: sample })).toBe(sample);
    expect(extractMoonrakerBoxsInfoPayload({ boxs_info: sample })).toBe(sample);
    expect(extractMoonrakerBoxsInfoPayload({ result: { boxsInfo: sample } })).toBe(sample);
    expect(extractMoonrakerBoxsInfoPayload({ params: { boxs_info: sample } })).toBe(sample);
    expect(extractMoonrakerBoxsInfoPayload({ data: { boxsInfo: sample } })).toBe(sample);
  });
});
