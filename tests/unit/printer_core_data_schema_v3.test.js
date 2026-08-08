/**
 * @fileoverview Printer Core v3 Data Schema dry-run contract の単体テスト
 * @description
 * - Gate 13 で IndexedDB を変更する前に、store 定義と migration dry-run plan を純粋関数で検証する。
 *
 * @version 1.390.1341 (PR #432)
 * @since 1.390.1341 (PR #432)
 * @lastModified 2026-08-09 01:31:56
 */

import { describe, expect, it } from "vitest";
import {
  createPrinterCoreV3DeterministicId,
  createPrinterCoreV3MigrationPlan,
  getPrinterCoreV3StoreDefinitions,
  getPrinterCoreV3StoreNames,
  stableStringifyPrinterCoreV3Value,
  validatePrinterCoreV3MigrationPlan,
} from "../../3dp_lib/printer_core/dashboard_data_schema_v3.js";

/**
 * migration dry-run 用の最小 legacy monitorData を生成する。
 *
 * 【詳細説明】
 * - v2 既存データの代表として connectionTargets、machines、spools、mountHistory、usageHistory を含める。
 *
 * @function createLegacyMonitorData
 * @returns {object} テスト用 legacy monitorData
 */
function createLegacyMonitorData() {
  return {
    appSettings: {
      connectionTargets: [
        {
          dest: "192.168.54.151:9999",
          hostname: "K1Max-A",
          printerType: "k1",
        },
        {
          dest: "192.168.54.21:9999",
          hostname: "K2Pro-69E7",
          printerType: "k2",
          printerCoreV3Identity: {
            deviceIdSeed: "serial:905251280E69E7",
          },
        },
      ],
    },
    machines: {
      "K1Max-A": {
        printStore: {
          history: [
            {
              id: "1001",
              fileName: "benchy.gcode",
            },
          ],
        },
      },
      "K2Pro-69E7": {
        printStore: {
          history: [
            {
              id: "2001",
              fileName: "4color-benchy.gcode",
            },
            {
              id: "2002",
              fileName: "deguchi-test.gcode",
            },
          ],
        },
      },
    },
    filamentSpools: [
      {
        id: "spool-1",
        name: "PLA Silver",
      },
    ],
    mountHistory: [
      {
        evId: "mount-1",
        spoolId: "spool-1",
      },
    ],
    usageHistory: [
      {
        usageId: "usage-1",
        spoolId: "spool-1",
      },
    ],
  };
}

describe("Printer Core v3 Data Schema contract", () => {
  it("ADR-0007のstore定義を安定した順序で返す", () => {
    const storeNames = getPrinterCoreV3StoreNames();

    expect(storeNames).toEqual([
      "meta",
      "devices",
      "deviceEndpoints",
      "capabilitySnapshots",
      "printJobs",
      "gcodeAssets",
      "printPlans",
      "filamentUnits",
      "materialSources",
      "spools",
      "spoolMounts",
      "jobMaterialSegments",
      "filamentLedger",
      "settings",
      "migrationJournal",
      "protocolCaptures",
    ]);

    const definitions = getPrinterCoreV3StoreDefinitions();
    expect(definitions.find((store) => store.name === "devices")).toMatchObject({
      keyPath: "deviceId",
      indexes: ["reportedModel", "serialNumber"],
    });
    expect(definitions.find((store) => store.name === "materialSources")).toMatchObject({
      keyPath: "materialSourceId",
      indexes: ["unitId", "kind"],
    });
  });

  it("store定義は呼び出し側mutationで壊れない", () => {
    const definitions = getPrinterCoreV3StoreDefinitions();
    definitions[0].name = "mutated";
    definitions[1].indexes.push("mutatedIndex");

    expect(getPrinterCoreV3StoreNames()[0]).toBe("meta");
    expect(getPrinterCoreV3StoreDefinitions()[1].indexes).not.toContain("mutatedIndex");
  });

  it("canonical stringifyとdeterministic IDはobject key順に依存しない", () => {
    const left = { b: 2, a: { d: 4, c: 3 } };
    const right = { a: { c: 3, d: 4 }, b: 2 };

    expect(stableStringifyPrinterCoreV3Value(left)).toBe(stableStringifyPrinterCoreV3Value(right));
    expect(createPrinterCoreV3DeterministicId("device", ["serial", "SN-001"]))
      .toBe(createPrinterCoreV3DeterministicId("DEVICE", [" serial ", "sn-001"]));
  });

  it("legacy monitorDataからv3 migration dry-run planを生成する", () => {
    const plan = createPrinterCoreV3MigrationPlan(createLegacyMonitorData(), {
      createdAt: "2026-08-09T01:31:56.000+09:00",
    });

    expect(plan).toMatchObject({
      status: "dry-run",
      dataSchemaVersion: 3,
      createdAt: "2026-08-09T01:31:56.000+09:00",
      legacyCounts: {
        connectionTargets: 2,
        deviceEndpoints: 2,
        machines: 2,
        printHistoryJobs: 3,
        filamentSpools: 1,
        mountHistory: 1,
        usageHistory: 1,
      },
      plannedWrites: {
        meta: 1,
        devices: 2,
        deviceEndpoints: 2,
        printJobs: 3,
        spools: 1,
        spoolMounts: 1,
        filamentLedger: 1,
        settings: 1,
        migrationJournal: 1,
      },
      invariants: {
        dualWriteAllowed: true,
        activateV3Writes: false,
        preserveLegacyData: true,
        migrationIsDeterministic: true,
      },
      warnings: [],
    });
    expect(plan.source.checksum).toMatch(/^fnv1a32:[0-9a-f]{8}$/u);
    expect(validatePrinterCoreV3MigrationPlan(plan)).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("empty legacy dataは警告を出すがv3 write activationはしない", () => {
    const plan = createPrinterCoreV3MigrationPlan({});

    expect(plan.warnings).toEqual([
      "legacy-app-settings-missing",
      "legacy-machines-empty",
      "legacy-device-endpoints-empty",
    ]);
    expect(plan.invariants.activateV3Writes).toBe(false);
    expect(validatePrinterCoreV3MigrationPlan(plan).ok).toBe(true);
  });

  it("dry-run以外や未知storeをvalidationで拒否する", () => {
    const plan = createPrinterCoreV3MigrationPlan(createLegacyMonitorData());
    const invalid = {
      ...plan,
      status: "activated",
      plannedWrites: {
        ...plan.plannedWrites,
        unknownStore: 1,
      },
      invariants: {
        ...plan.invariants,
        activateV3Writes: true,
      },
    };

    expect(validatePrinterCoreV3MigrationPlan(invalid)).toEqual({
      ok: false,
      errors: [
        "plan-status-not-dry-run",
        "plan-activates-v3-writes",
        "planned-write-unknown:unknownStore",
      ],
    });
  });
});
