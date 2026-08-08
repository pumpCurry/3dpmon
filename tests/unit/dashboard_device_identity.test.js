/**
 * @fileoverview dashboard_device_identity.js の単体テスト
 */
import { describe, it, expect } from "vitest";
import {
  createDeviceIdentityCandidate,
  createDeviceFingerprint,
  DEVICE_FINGERPRINT_SCHEMA_VERSION,
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
    expect(candidate.deviceFingerprint).toMatchObject({
      schemaVersion: DEVICE_FINGERPRINT_SCHEMA_VERSION,
      strong: { serialNumber: "k2pro-serial-001" },
      endpointAliases: {
        macs: [
          "66:77:88:99:aa:bb",
          "aa:11:22:33:44:55",
        ],
      },
    });
    expect(candidate.evidenceReasons).toContain("mac-as-endpoint-alias");
  });

  it("/info由来の証拠をDeviceFingerprintとして保持する", () => {
    const fingerprint = createDeviceFingerprint({
      source: "http-info",
      model: "F012",
      sn: "K2PRO-SERIAL-001",
      mac: "AA1122334455",
      version: "1.0.0",
      wssPort: "443",
      videoPort: 443,
      endpointAddress: "192.0.2.21",
    });

    expect(fingerprint).toEqual({
      schemaVersion: DEVICE_FINGERPRINT_SCHEMA_VERSION,
      sources: ["http-info"],
      strong: {
        serialNumber: "k2pro-serial-001",
        stableMachineId: null,
      },
      reported: {
        model: "F012",
        hostname: null,
        firmwareVersion: "1.0.0",
      },
      endpointAliases: {
        addresses: ["192.0.2.21"],
        macs: ["aa:11:22:33:44:55"],
      },
      transports: {
        httpInfoObserved: true,
        ws9999Observed: false,
        wssPort: 443,
        videoPort: 443,
      },
    });
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
    expect(merged.deviceFingerprint.endpointAliases.addresses).toEqual([
      "printer-wifi.local",
      "printer-wired.local",
    ]);
    expect(merged.deviceFingerprint.endpointAliases.macs).toEqual([
      "66:77:88:99:aa:bb",
      "aa:11:22:33:44:55",
    ]);
  });

  it("HTTP /info と WS9999 fingerprint source を統合して保持する", () => {
    const info = createDeviceIdentityCandidate({
      source: "http-info",
      model: "F012",
      sn: "K2PRO-SERIAL-001",
      version: "1.0.0",
      wssPort: 443,
      videoPort: 443,
      endpointAddress: "192.0.2.21",
      mac: "AA1122334455",
    });
    const ws = createDeviceIdentityCandidate({
      source: "ws9999",
      hostname: "K2Pro-Test",
      model: "F012",
      sn: "K2PRO-SERIAL-001",
      endpointAddress: "k2pro.local",
      mac: "66778899AABB",
    });

    const merged = mergeDeviceIdentityCandidate(info, ws);

    expect(merged.deviceFingerprint.sources).toEqual(["http-info", "ws9999"]);
    expect(merged.deviceFingerprint.reported).toMatchObject({
      model: "F012",
      hostname: "K2Pro-Test",
      firmwareVersion: "1.0.0",
    });
    expect(merged.deviceFingerprint.transports).toMatchObject({
      httpInfoObserved: true,
      ws9999Observed: true,
      wssPort: 443,
      videoPort: 443,
    });
    expect(merged.deviceFingerprint.endpointAliases.addresses).toEqual([
      "192.0.2.21",
      "k2pro.local",
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
    expect(candidate.deviceIdSeed).toBe("provisional:k1%20max:k1max-4a1b");
    expect(candidate.endpointAliases.macs).toEqual(["aa:bb:cc:dd:ee:ff"]);
  });

  it("記号違いのserialを同じdeviceId seedへ潰さない", () => {
    const slash = createDeviceIdentityCandidate({ serialNumber: "ABC/123" });
    const colon = createDeviceIdentityCandidate({ serialNumber: "ABC:123" });
    const hyphen = createDeviceIdentityCandidate({ serialNumber: "ABC-123" });

    expect(slash.deviceIdSeed).toBe("serial:abc%2F123");
    expect(colon.deviceIdSeed).toBe("serial:abc%3A123");
    expect(hyphen.deviceIdSeed).toBe("serial:abc-123");
    expect(new Set([slash.deviceIdSeed, colon.deviceIdSeed, hyphen.deviceIdSeed]).size).toBe(3);
  });

  it("stableMachineId由来の候補は後続serial観測で昇格する", () => {
    const stable = createDeviceIdentityCandidate({
      stableMachineId: "K2PRO-STABLE-001",
      endpointAddress: "192.0.2.10",
    });
    const serial = createDeviceIdentityCandidate({
      serialNumber: "K2PRO-SERIAL-001",
      stableMachineId: "K2PRO-STABLE-001",
      endpointAddress: "192.0.2.11",
    });

    const decision = shouldMergeDeviceIdentity(stable, serial);
    const merged = mergeDeviceIdentityCandidate(stable, serial);

    expect(decision).toEqual({
      merge: true,
      confidence: "strong",
      reason: "stable-machine-id-match",
    });
    expect(merged.identityStrength).toBe("serial");
    expect(merged.deviceIdSeed).toBe("serial:k2pro-serial-001");
    expect(merged.endpointAliases.addresses).toEqual(["192.0.2.10", "192.0.2.11"]);
  });

  it("serialが一致してもstableMachineIdが矛盾する場合はconflictを優先する", () => {
    const left = createDeviceIdentityCandidate({
      serialNumber: "K2PRO-SERIAL-001",
      stableMachineId: "STABLE-A",
    });
    const right = createDeviceIdentityCandidate({
      serialNumber: "K2PRO-SERIAL-001",
      stableMachineId: "STABLE-B",
    });

    expect(shouldMergeDeviceIdentity(left, right)).toEqual({
      merge: false,
      confidence: "conflict",
      reason: "stable-machine-id-conflict",
    });
  });
});
