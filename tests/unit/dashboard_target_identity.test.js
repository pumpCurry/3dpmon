/**
 * @fileoverview dashboard_target_identity.js 純関数テスト（監査 P0: dest 正規化）
 *
 * 固定する不変条件:
 *  - IPv4/IPv6(bracket・bare)/hostname:port を素朴 split(":") で壊さない
 *  - 既定ポート補完（normalizeDest）が IPv6 を角括弧で包む
 *  - isIpLiteral が v4/v6 を検出し hostname を除外
 */
import { describe, it, expect } from "vitest";
import {
  parseDest, normalizeDest, isIPv4, isIpLiteral, extractHost
} from "../../3dp_lib/dashboard_target_identity.js";

describe("isIPv4", () => {
  it("正しい IPv4", () => {
    expect(isIPv4("192.168.1.50")).toBe(true);
    expect(isIPv4("0.0.0.0")).toBe(true);
    expect(isIPv4("255.255.255.255")).toBe(true);
  });
  it("不正な IPv4 は false", () => {
    expect(isIPv4("256.1.1.1")).toBe(false);
    expect(isIPv4("192.168.1")).toBe(false);
    expect(isIPv4("fe80::1")).toBe(false);
    expect(isIPv4("host.local")).toBe(false);
    expect(isIPv4("")).toBe(false);
  });
});

describe("parseDest", () => {
  it("bare IPv4", () => {
    const p = parseDest("192.168.1.50");
    expect(p).toMatchObject({ ok: true, host: "192.168.1.50", port: null, hasPort: false, isIPv4: true, isIPv6: false, isHostname: false });
  });
  it("IPv4:port", () => {
    const p = parseDest("192.168.1.50:9999");
    expect(p).toMatchObject({ ok: true, host: "192.168.1.50", port: 9999, hasPort: true, isIPv4: true });
  });
  it("hostname:port", () => {
    const p = parseDest("k1max.local:80");
    expect(p).toMatchObject({ ok: true, host: "k1max.local", port: 80, hasPort: true, isHostname: true, isIPv4: false });
  });
  it("bare hostname", () => {
    const p = parseDest("k1max.local");
    expect(p).toMatchObject({ ok: true, host: "k1max.local", hasPort: false, isHostname: true });
  });
  it("[IPv6]:port", () => {
    const p = parseDest("[fe80::1]:9999");
    expect(p).toMatchObject({ ok: true, host: "fe80::1", port: 9999, hasPort: true, isIPv6: true });
  });
  it("[IPv6] のみ（ポートなし）", () => {
    const p = parseDest("[fe80::1]");
    expect(p).toMatchObject({ ok: true, host: "fe80::1", port: null, hasPort: false, isIPv6: true });
  });
  it("bare IPv6", () => {
    const p = parseDest("fe80::1");
    expect(p).toMatchObject({ ok: true, host: "fe80::1", port: null, hasPort: false, isIPv6: true });
  });
  it("空入力は ok=false", () => {
    expect(parseDest("").ok).toBe(false);
    expect(parseDest(null).ok).toBe(false);
  });
  it("不正ポートは ok=false", () => {
    expect(parseDest("192.168.1.50:99999").ok).toBe(false);
    expect(parseDest("192.168.1.50:0").ok).toBe(false);
    expect(parseDest("host:abc").ok).toBe(false);
  });
});

describe("normalizeDest", () => {
  it("T-ID-02: IPv6 raw に既定ポート補完し角括弧化", () => {
    expect(normalizeDest("fe80::1", { defaultPort: 9999 }).normalizedDest).toBe("[fe80::1]:9999");
  });
  it("T-ID-02: [IPv6]:port はそのまま角括弧維持", () => {
    expect(normalizeDest("[fe80::1]:9999", { defaultPort: 9999 }).normalizedDest).toBe("[fe80::1]:9999");
  });
  it("IPv4 に既定ポート補完", () => {
    expect(normalizeDest("192.168.1.50", { defaultPort: 9999 }).normalizedDest).toBe("192.168.1.50:9999");
  });
  it("IPv4:port は明示ポート優先", () => {
    expect(normalizeDest("192.168.1.50:80", { defaultPort: 9999 }).normalizedDest).toBe("192.168.1.50:80");
  });
  it("hostname に既定ポート補完", () => {
    expect(normalizeDest("k1max.local", { defaultPort: 80 }).normalizedDest).toBe("k1max.local:80");
  });
  it("ポート欠落かつ既定なし → ok=false", () => {
    const r = normalizeDest("192.168.1.50");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("missing-port");
  });
  it("同一IP・別ポートは別 normalizedDest（dedupe が別物と扱える）", () => {
    const a = normalizeDest("192.168.1.50:9999", { defaultPort: 9999 }).normalizedDest;
    const b = normalizeDest("192.168.1.50:80", { defaultPort: 80 }).normalizedDest;
    expect(a).not.toBe(b);
  });
});

describe("isIpLiteral", () => {
  it("IPv4/IPv6 は true", () => {
    expect(isIpLiteral("192.168.1.50")).toBe(true);
    expect(isIpLiteral("192.168.1.50:9999")).toBe(true);
    expect(isIpLiteral("fe80::1")).toBe(true);
    expect(isIpLiteral("[fe80::1]:80")).toBe(true);
  });
  it("hostname は false（IP→hostname 移行対象外）", () => {
    expect(isIpLiteral("k1max.local")).toBe(false);
    expect(isIpLiteral("k1max.local:80")).toBe(false);
    expect(isIpLiteral("")).toBe(false);
  });
});

describe("extractHost", () => {
  it("各形式からホスト部を抽出", () => {
    expect(extractHost("192.168.1.50:9999")).toBe("192.168.1.50");
    expect(extractHost("[fe80::1]:80")).toBe("fe80::1");
    expect(extractHost("fe80::1")).toBe("fe80::1");
    expect(extractHost("k1max.local")).toBe("k1max.local");
    expect(extractHost("")).toBe("");
  });
});
