/**
 * @fileoverview dashboard_device_identity.js の単体テスト
 */
import { describe, it, expect } from "vitest";
import {
  createDeviceIdentityCandidate,
  mergeDeviceIdentityCandidate,
  normalizeIdentityEvidence,
  normalizeMacAddress,
  shouldMergeDeviceIdentity,
} from "../../3dp_lib/printer_core/dashboard_device_identity.js";

describe("dashboard_device_identity", () => {
  it("区切りなし/コロン/ハイフンのMACを同じ表記へ正規化する", () => {
    expect(normalizeMacAddress("AA1122334455")).toBe("aa:11:22:33:44:55");
    expect(normalizeMacAddress("AA:11:22:33:44:55")).toBe("aa:11:22:33:44:55");
    expect(normalizeMacAddress("aa-11-22-33-44-55")).toBe("aa:11:22:33:44:55");
    expect(normalizeMacAddress("not-a-mac")).toBeNull();
  });

  it("serialをdeviceId seedに使い、MACはendpoint aliasとして保持する", () => {
    const candidate = createDeviceIdentityCandidate({
      serialNumber: "K2PRO-SERIAL-001",
      reportedModel: "F012",
      reportedHostname: "K2Pro-Test",
      endpointAddress: "printer-wired.local",
      macAddress: "AA1122334455",
      macAliases: ["66:77:88:99:AA:BB"],
    });

    expect(candidate.deviceIdSeed).toBe("serial:k2pro-serial-001");
    expect(candidate.identityStrength).toBe("serial");
    expect(candidate.endpointAliases.addresses).toEqual(["printer-wired.local"]);
    expect(candidate.endpointAliases.macs).toEqual([
      "66:77:88:99:aa:bb",
      "aa:11:22:33:44:55",
    ]);
    expect(candidate.evidenceReasons).toContain("mac-as-endpoint-alias");
  });

  it("有線MACと無線MACが違ってもserial一致なら同一物理機として統合する", () => {
    const wired = createDeviceIdentityCandidate({
      serialNumber: "K2PRO-SERIAL-001",
      reportedModel: "F012",
      endpointAddress: "printer-wired.local",
      macAddress: "AA1122334455",
    });
    const wireless = createDeviceIdentityCandidate({
      serialNumber: "K2PRO-SERIAL-001",
      reportedModel: "F012",
      endpointAddress: "printer-wifi.local",
      macAddress: "66:77:88:99:AA:BB",
    });

    expect(shouldMergeDeviceIdentity(wired, wireless)).toEqual({
      merge: true,
      confidence: "strong",
      reason: "serial-match",
    });

    const merged = mergeDeviceIdentityCandidate(wired, wireless);
    expect(merged.deviceIdSeed).toBe("serial:k2pro-serial-001");
    expect(merged.endpointAliases.addresses).toEqual(["printer-wifi.local", "printer-wired.local"]);
    expect(merged.endpointAliases.macs).toEqual([
      "66:77:88:99:aa:bb",
      "aa:11:22:33:44:55",
    ]);
  });

  it("serialが矛盾する場合はMACが同じでも統合しない", () => {
    const left = createDeviceIdentityCandidate({
      serialNumber: "SERIAL-A",
      macAddress: "AA1122334455",
    });
    const right = createDeviceIdentityCandidate({
      serialNumber: "SERIAL-B",
      macAddress: "AA1122334455",
    });

    expect(shouldMergeDeviceIdentity(left, right)).toEqual({
      merge: false,
      confidence: "conflict",
      reason: "serial-conflict",
    });
  });

  it("強い識別材料がない場合はprovisional seedを作る", () => {
    const evidence = normalizeIdentityEvidence({
      reportedModel: "K1 Max",
      reportedHostname: "K1Max-4A1B",
      macAddress: "AA-BB-CC-DD-EE-FF",
    });
    const candidate = createDeviceIdentityCandidate(evidence);

    expect(candidate.identityStrength).toBe("provisional");
    expect(candidate.deviceIdSeed).toBe("provisional:k1-max:k1max-4a1b");
    expect(candidate.endpointAliases.macs).toEqual(["aa:bb:cc:dd:ee:ff"]);
  });
});
