/**
 * @fileoverview filamentLow 読み上げの小数まるめ＋単位整形（修正漏れ対応）の回帰テスト
 *
 * - 既定 talk が {remainingText}（表示単位・小数1桁の整形済み文字列）を使う。
 * - 旧既定 talk（残り{remaining}mm＝丸めなし・mm固定）は loadSettings で新既定へ移行する。
 *   ユーザがカスタムした文面は尊重する。
 * - notify() が {remainingText} を読み上げ文へ展開する。
 *
 * notification_manager.js はモジュール読込時に document へ触れるため jsdom 環境で実行する。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mockMonitorData = { machines: {}, appSettings: {} };

vi.doMock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: mockMonitorData,
  isNotificationSuppressed: () => false,
  PLACEHOLDER_HOSTNAME: "_$_NO_MACHINE_$_",
  // ★ 合流: notification_manager は {hostname} 置換に getHostDisplayName を使う
  getHostDisplayName: (h) => h
}));
vi.doMock("../../3dp_lib/dashboard_storage.js", () => ({ saveUnifiedStorage: vi.fn() }));
vi.doMock("../../3dp_lib/dashboard_audio_manager.js", () => ({
  audioManager: { isVoiceAllowed: () => true, isMusicAllowed: () => false, play: vi.fn() }
}));
vi.doMock("../../3dp_lib/dashboard_log_util.js", () => ({
  pushNotificationLog: vi.fn(),
  pushLog: vi.fn()
}));

const { NotificationManager } = await import("../../3dp_lib/dashboard_notification_manager.js");
const { defaultNotificationMap } = await import("../../3dp_lib/dashboard_notification_defaults.js");

const OLD_TALK = "{hostname} フィラメント残量が少なくなっています 残り{remaining}mm ({now})";

beforeEach(() => {
  mockMonitorData.machines = {};
  mockMonitorData.appSettings = {};
});

describe("filamentLow 読み上げ（単位・小数1桁）", () => {
  it("既定 talk は {remainingText} を使い、生の {remaining}mm を含まない", () => {
    const talk = defaultNotificationMap.filamentLow.talk;
    expect(talk).toContain("{remainingText}");
    expect(talk).not.toContain("{remaining}mm");
  });

  it("notify() が {remainingText} を読み上げ文へ展開する", () => {
    const m = new NotificationManager();
    m.enabled = true;
    const tts = vi.spyOn(m, "_speakText").mockImplementation(() => {});
    m.notify("filamentLow", { hostname: "k1", remaining: 187399.8333, remainingText: "187.4m" });
    expect(tts).toHaveBeenCalledTimes(1);
    const spoken = tts.mock.calls[0][0];
    expect(spoken).toContain("残り187.4m");
    expect(spoken).not.toContain("187399"); // 生の全桁が読まれない
  });

  it("loadSettings: 旧既定 talk を新既定へ移行する", () => {
    mockMonitorData.appSettings.notificationSettings = {
      map: { filamentLow: { talk: OLD_TALK, enabled: true, level: "warn" } }
    };
    const m = new NotificationManager();
    m.loadSettings();
    expect(m.map.filamentLow.talk).toBe(defaultNotificationMap.filamentLow.talk);
    expect(m.map.filamentLow.talk).toContain("{remainingText}");
  });

  it("loadSettings: ユーザがカスタムした talk は移行せず尊重する", () => {
    const custom = "{hostname} のこり {remaining}mm だよ";
    mockMonitorData.appSettings.notificationSettings = {
      map: { filamentLow: { talk: custom, enabled: true, level: "warn" } }
    };
    const m = new NotificationManager();
    m.loadSettings();
    expect(m.map.filamentLow.talk).toBe(custom);
  });
});
