/**
 * @fileoverview dashboard_device_identity_repository.js の単体テスト
 */
import { describe, it, expect } from "vitest";
import {
  PRINTER_CORE_V3_IDENTITY_SCHEMA_VERSION,
  mergePrinterCoreV3IdentityRecords,
  recordPrinterCoreV3Identity,
  toComparablePrinterCoreV3Identity,
  transferPrinterCoreV3IdentityRecords,
} from "../../3dp_lib/printer_core/dashboard_device_identity_repository.js";

describe("dashboard_device_identity_repository", () => {
  it("観測evidenceをconnectionTarget上のdry-run identityとして保存する", () => {
    const target = { dest: "203.0.113.20:9999", hostname: "" };
    const result = recordPrinterCoreV3Identity(target, {
      hostname: "K2Pro-Test",
      model: "F012",
      sn: "K2PRO-SERIAL-001",
      mac: "AA1122334455",
    }, {
      hostOrDest: "203.0.113.20",
      endpointAddress: "203.0.113.20",
    });

    expect(result.changed).toBe(true);
    expect(target.printerCoreV3Identity).toMatchObject({
      schemaVersion: PRINTER_CORE_V3_IDENTITY_SCHEMA_VERSION,
      dryRun: true,
      deviceIdSeed: "serial:k2pro-serial-001",
      identityStrength: "serial",
      reportedModel: "F012",
      reportedHostname: "K2Pro-Test",
      lastEvidenceReason: "first-observation",
    });
    expect(target.printerCoreV3Identity.endpointAliases.macs).toEqual(["aa:11:22:33:44:55"]);
  });

  it("同じ内容の再観測では時刻だけを理由にchangedへしない", () => {
    const target = { dest: "203.0.113.20:9999", hostname: "K2Pro-Test" };
    recordPrinterCoreV3Identity(target, {
      hostname: "K2Pro-Test",
      model: "F012",
      sn: "K2PRO-SERIAL-001",
      mac: "AA1122334455",
    }, {
      hostOrDest: "K2Pro-Test",
      endpointAddress: "203.0.113.20",
    });

    const second = recordPrinterCoreV3Identity(target, {
      hostname: "K2Pro-Test",
      model: "F012",
      sn: "K2PRO-SERIAL-001",
      mac: "AA1122334455",
    }, {
      hostOrDest: "K2Pro-Test",
      endpointAddress: "203.0.113.20",
    });

    expect(second.changed).toBe(false);
    expect(toComparablePrinterCoreV3Identity(target.printerCoreV3Identity)).not.toHaveProperty("lastObservedAt");
  });

  it("serial矛盾はconflictへ隔離し、既存identityを上書きしない", () => {
    const target = { dest: "203.0.113.20:9999", hostname: "K2Pro-Test" };
    recordPrinterCoreV3Identity(target, {
      hostname: "K2Pro-Test",
      sn: "K2PRO-SERIAL-001",
      mac: "AA1122334455",
    }, {
      endpointAddress: "203.0.113.20",
    });

    const conflict = recordPrinterCoreV3Identity(target, {
      hostname: "K2Pro-Test",
      sn: "K2PRO-SERIAL-OTHER",
      mac: "AA1122334455",
    }, {
      endpointAddress: "203.0.113.20",
    });

    expect(conflict.changed).toBe(true);
    expect(target.printerCoreV3Identity.deviceIdSeed).toBe("serial:k2pro-serial-001");
    expect(target.printerCoreV3IdentityConflict.decision).toEqual({
      merge: false,
      confidence: "conflict",
      reason: "serial-conflict",
    });
  });

  it("旧targetから新targetへidentityとconflictを移送できる", () => {
    const current = { dest: "203.0.113.21:9999", hostname: "K2Pro-Test" };
    const stale = { dest: "203.0.113.20:9999", hostname: "K2Pro-Test" };
    recordPrinterCoreV3Identity(stale, {
      hostname: "K2Pro-Test",
      sn: "K2PRO-SERIAL-001",
      mac: "AA1122334455",
    }, {
      endpointAddress: "203.0.113.20",
    });
    recordPrinterCoreV3Identity(current, {
      hostname: "K2Pro-Test",
      sn: "K2PRO-SERIAL-001",
      mac: "66778899AABB",
    }, {
      endpointAddress: "203.0.113.21",
    });

    const transfer = transferPrinterCoreV3IdentityRecords(current, stale);

    expect(transfer.changed).toBe(true);
    expect(current.printerCoreV3Identity.endpointAliases.addresses).toEqual([
      "203.0.113.20",
      "203.0.113.21",
    ]);
    expect(current.printerCoreV3Identity.endpointAliases.macs).toEqual([
      "66:77:88:99:aa:bb",
      "aa:11:22:33:44:55",
    ]);
  });

  it("Moonraker targetはCreality identity dry-runの対象外にする", () => {
    const target = { dest: "203.0.113.30:80", hostname: "Fluidd-Test", printerType: "moonraker" };
    const result = recordPrinterCoreV3Identity(target, {
      hostname: "Fluidd-Test",
      sn: "MOONRAKER-SERIAL-001",
    }, {
      endpointAddress: "203.0.113.30",
    });

    expect(result.changed).toBe(false);
    expect(target.printerCoreV3Identity).toBeUndefined();
  });

  it("mergePrinterCoreV3IdentityRecordsは同一serialのendpoint aliasを統合する", () => {
    const leftTarget = { dest: "203.0.113.20:9999" };
    const rightTarget = { dest: "203.0.113.21:9999" };
    recordPrinterCoreV3Identity(leftTarget, {
      sn: "K2PRO-SERIAL-001",
      mac: "AA1122334455",
    }, {
      endpointAddress: "203.0.113.20",
    });
    recordPrinterCoreV3Identity(rightTarget, {
      sn: "K2PRO-SERIAL-001",
      mac: "66778899AABB",
    }, {
      endpointAddress: "203.0.113.21",
    });

    const merged = mergePrinterCoreV3IdentityRecords(
      leftTarget.printerCoreV3Identity,
      rightTarget.printerCoreV3Identity
    );

    expect(merged.deviceIdSeed).toBe("serial:k2pro-serial-001");
    expect(merged.lastMergeDecision.reason).toBe("serial-match");
    expect(merged.endpointAliases.addresses).toEqual(["203.0.113.20", "203.0.113.21"]);
  });
});
