/**
 * @fileoverview getHostDisplayName（呼び出し名称の解決）単体テスト
 *
 * 優先順 label > 機器申告hostname > model > ホストキー を検証する。
 * 特に Moonraker のようにホストキーが IP のまま（hostname へ未移行）でも、
 * 接続先設定(dest)から label を逆引きできること（通知/読み上げ/一覧が IP のまま
 * 出ていた問題の解消）を確認する。
 *
 * getHostDisplayName はモジュール内部の monitorData を参照するため、実物の
 * monitorData を import して書き換える（mock 差し替えでは内部 closure に効かない）。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getHostDisplayName, monitorData } from "../../3dp_lib/dashboard_data.js";

beforeEach(() => {
  monitorData.appSettings = { connectionTargets: [] };
  monitorData.machines = {};
});

describe("getHostDisplayName", () => {
  it("label を最優先（hostname キーで逆引き）", () => {
    monitorData.appSettings.connectionTargets = [
      { dest: "192.168.54.15:80", hostname: "Ideaformer", label: "IR3V2" }
    ];
    monitorData.machines = { Ideaformer: { storedData: { hostname: { rawValue: "Ideaformer" } } } };
    expect(getHostDisplayName("Ideaformer")).toBe("IR3V2");
  });

  it("ホストキーが IP のままでも dest から label 解決（Moonraker未移行ケース）", () => {
    monitorData.appSettings.connectionTargets = [
      { dest: "192.168.54.15:80", hostname: "Ideaformer", label: "IR3V2" }
    ];
    monitorData.machines = { "192.168.54.15": { storedData: { hostname: { rawValue: "" } } } };
    // 従来は "192.168.54.15" がそのまま出ていた → label "IR3V2" を返す
    expect(getHostDisplayName("192.168.54.15")).toBe("IR3V2");
  });

  it("label 未設定 → 機器申告 hostname にフォールバック", () => {
    monitorData.appSettings.connectionTargets = [{ dest: "192.168.1.5:9999", hostname: "K1Max-03FA" }];
    monitorData.machines = { "K1Max-03FA": { storedData: { hostname: { rawValue: "K1Max-03FA" } } } };
    expect(getHostDisplayName("K1Max-03FA")).toBe("K1Max-03FA");
  });

  it("label/hostname 無し → model にフォールバック", () => {
    monitorData.machines = { h1: { storedData: { model: { rawValue: "Klipper (belt)" } } } };
    expect(getHostDisplayName("h1")).toBe("Klipper (belt)");
  });

  it("接続先設定も storedData も無い → ホストキーをそのまま返す", () => {
    expect(getHostDisplayName("192.168.0.99")).toBe("192.168.0.99");
  });

  it("空 label（空白のみ）は採用せずフォールバック", () => {
    monitorData.appSettings.connectionTargets = [{ dest: "192.168.1.5:9999", hostname: "h", label: "   " }];
    monitorData.machines = { h: { storedData: { hostname: { rawValue: "real-host" } } } };
    expect(getHostDisplayName("h")).toBe("real-host");
  });

  it("falsy host はそのまま返す", () => {
    expect(getHostDisplayName("")).toBe("");
  });
});
