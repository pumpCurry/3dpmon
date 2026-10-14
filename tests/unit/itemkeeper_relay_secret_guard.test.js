import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { itemKeeperRelayPublicSettings, RELAY_VISIBLE_ITEMKEEPER_KEYS } from
  "../../3dp_lib/dashboard_itemkeeper_relay_public.js";

const root = fileURLToPath(new URL("../../3dp_lib/", import.meta.url));
const read = (name) => readFileSync(new URL(name, `file://${root}/`), "utf8");

describe("R19-a: secret-free readonly / satellite ItemKeeper settings", () => {
  it("only sends allowlisted public display preferences", () => {
    const secret = "a-sentinel-private-key-never-send";
    const src = {
      enabled:true, endpoint:"http://localhost:8313", historyScope:"all",
      onStart:true, attachState:false, clientId:"ikc_live_sentinel",
      secret, credentials:{nested:secret}, futureApiKey:secret
    };
    const result = itemKeeperRelayPublicSettings(src);
    expect(result.enabled).toBe(true);
    expect(result.endpoint).toBe(src.endpoint);
    expect(result.historyScope).toBe("all");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).not.toHaveProperty("clientId");
    expect(result).not.toHaveProperty("secret");
    expect(result).not.toHaveProperty("credentials");
    expect(result).not.toHaveProperty("futureApiKey");
  });

  it("unknown/future keys do not leak; input unchanged", () => {
    const x = {enabled:true, secret:"hidden", bearer:"sensitive", prototypeSecret:"test"};
    const before = JSON.stringify(x);
    const result = itemKeeperRelayPublicSettings(x);
    expect(Object.keys(result)).toEqual(["enabled"]);
    expect(JSON.stringify(x)).toBe(before);
    expect(itemKeeperRelayPublicSettings(null)).toEqual({});
  });

  it("visible key set never contains sender credentials", () => {
    expect(RELAY_VISIBLE_ITEMKEEPER_KEYS).not.toContain("secret");
    expect(RELAY_VISIBLE_ITEMKEEPER_KEYS).not.toContain("clientId");
  });

  it("parent bridge uses sanitizer for both delta and snapshot", () => {
    const source = read("dashboard_relay_bridge.js");
    expect(source).toContain("sharedDelta.appSettingsItemkeeper = itemKeeperRelayPublicSettings(");
    expect(source).toContain("itemkeeper: itemKeeperRelayPublicSettings(");
  });

  it("satellite/readonly also sanitizes inbound parent or legacy relay packets", () => {
    expect(read("dashboard_client_sync.js"))
      .toContain("monitorData.appSettings.itemkeeper = itemKeeperRelayPublicSettings(ik)");
  });

  it("parent preserves sender credential pair on child settings RPC", () => {
    const source = read("dashboard_integration_itemkeeper.js");
    expect(source).toContain("clientId: current.clientId");
    expect(source).toContain("secret: current.secret");
  });
});
