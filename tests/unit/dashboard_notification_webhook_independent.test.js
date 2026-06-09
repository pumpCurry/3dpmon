/**
 * @fileoverview notify() の汎用Webhook 独立化ゲートの回帰テスト
 *
 * v2.2.1021: 「webhookIndependent=true なら通知マスター(enabled)が OFF でも Webhook を送る」
 * という外部連携の独立 push を追加した。既定(false)では従来挙動と完全互換であることを担保する。
 *
 * notification_manager.js はモジュール読込時に document へ触れるため jsdom 環境で実行する。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mockMonitorData = { machines: {}, appSettings: {} };
let suppressed = false;

vi.doMock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: mockMonitorData,
  isNotificationSuppressed: () => suppressed,
  PLACEHOLDER_HOSTNAME: "_$_NO_MACHINE_$_"
}));
vi.doMock("../../3dp_lib/dashboard_storage.js", () => ({ saveUnifiedStorage: vi.fn() }));
vi.doMock("../../3dp_lib/dashboard_audio_manager.js", () => ({
  audioManager: { isVoiceAllowed: () => true, isMusicAllowed: () => false, play: vi.fn() }
}));
// showAlert は dashboard_log_util を動的 import して window.dispatchEvent するため、
// テスト環境破棄後の未処理例外（window is not defined）を避けるためモックする。
vi.doMock("../../3dp_lib/dashboard_log_util.js", () => ({
  pushNotificationLog: vi.fn(),
  pushLog: vi.fn()
}));

const { NotificationManager } = await import("../../3dp_lib/dashboard_notification_manager.js");

/** テスト用イベントマップを持つインスタンスを生成 */
function makeMgr() {
  const m = new NotificationManager();
  m.map = { ev: { enabled: true, talk: "hi {hostname}", label: "hi", level: "info" } };
  m.webhookUrls = ["http://example.test/hook"];
  return m;
}

/** notify() を呼び、UI(_speakText)/Webhook(_sendWebHook) の発火を観測する */
function run(m) {
  const wh = vi.spyOn(m, "_sendWebHook").mockImplementation(() => {});
  const tts = vi.spyOn(m, "_speakText").mockImplementation(() => {});
  m.notify("ev", { hostname: "h" });
  return { wh, tts };
}

beforeEach(() => {
  suppressed = false;
  mockMonitorData.machines = {};
});

describe("notify() 汎用Webhook 独立化ゲート", () => {
  it("enabled=true & independent=false: UI と Webhook 両方（後方互換）", () => {
    const m = makeMgr();
    m.enabled = true; m.webhookIndependent = false;
    const { wh, tts } = run(m);
    expect(tts).toHaveBeenCalledTimes(1);
    expect(wh).toHaveBeenCalledTimes(1);
  });

  it("enabled=false & independent=false: 無送信（後方互換）", () => {
    const m = makeMgr();
    m.enabled = false; m.webhookIndependent = false;
    const { wh, tts } = run(m);
    expect(tts).not.toHaveBeenCalled();
    expect(wh).not.toHaveBeenCalled();
  });

  it("enabled=false & independent=true: Webhook のみ（UI 無発火）", () => {
    const m = makeMgr();
    m.enabled = false; m.webhookIndependent = true;
    const { wh, tts } = run(m);
    expect(tts).not.toHaveBeenCalled();
    expect(wh).toHaveBeenCalledTimes(1);
  });

  it("def.enabled=false のイベントは独立でも無送信（イベントフィルタ維持）", () => {
    const m = makeMgr();
    m.enabled = false; m.webhookIndependent = true;
    m.map.ev.enabled = false;
    const { wh } = run(m);
    expect(wh).not.toHaveBeenCalled();
  });

  it("ホスト抑制中は独立でも無送信", () => {
    suppressed = true;
    const m = makeMgr();
    m.enabled = false; m.webhookIndependent = true;
    const { wh } = run(m);
    expect(wh).not.toHaveBeenCalled();
  });

  it("webhookUrls が空なら独立でも Webhook 無送信", () => {
    const m = makeMgr();
    m.enabled = false; m.webhookIndependent = true; m.webhookUrls = [];
    const { wh } = run(m);
    expect(wh).not.toHaveBeenCalled();
  });
});
