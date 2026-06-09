/**
 * @fileoverview 外部連携モーダル UI（initModalUI / _commitModal）の単体テスト
 *
 * モーダルの動的生成（汎用Webhook節 / ItemKeeper節 / 対象機器テーブル / 保存・キャンセル）と、
 * トランザクション編集（「保存して戻る」で draft を確定し永続化）を検証する。
 * DOM を使うため jsdom 環境で実行する。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mockMonitorData = {
  machines: {},
  appSettings: {
    connectionTargets: [
      { dest: "192.168.1.5:9999", hostname: "k1", label: "1号機", ikDeviceAlias: "", ikEnabled: true },
      { dest: "192.168.1.6:9999", hostname: "k2", label: "2号機", ikEnabled: false }
    ],
    itemkeeper: {}
  }
};
const nmMock = {
  getWebhookUrls: () => ["http://a.test/hook"],
  getWebhookIndependent: () => true,
  statusSnapshotEnabled: false,
  statusSnapshotIntervalSec: 30,
  setWebhookUrls: vi.fn(),
  setWebhookIndependent: vi.fn(),
  setStatusSnapshot: vi.fn()
};

vi.doMock("../../3dp_lib/dashboard_data.js", () => ({ monitorData: mockMonitorData, PLACEHOLDER_HOSTNAME: "_$_NO_MACHINE_$_" }));
vi.doMock("../../3dp_lib/dashboard_storage.js", () => ({ saveUnifiedStorage: vi.fn() }));
vi.doMock("../../3dp_lib/dashboard_spool.js", () => ({
  getSpoolById: () => null, getMaterialDensity: () => 1.24, weightFromLength: () => 0
}));
vi.doMock("../../3dp_lib/dashboard_filament_ledger.js", () => ({
  attributedUsed: () => 0, deriveSpoolRemaining: () => ({ remainingMm: 0 })
}));
vi.doMock("../../3dp_lib/dashboard_notification_manager.js", () => ({ notificationManager: nmMock }));

const { ItemKeeperIntegration } = await import("../../3dp_lib/dashboard_integration_itemkeeper.js");

/** モーダル本体 + overlay を用意して initModalUI を呼ぶ */
function openModal(ik) {
  document.body.innerHTML = '<div id="external-modal-overlay" class="open"></div>';
  const container = document.createElement("div");
  document.body.appendChild(container);
  ik.initModalUI(container);
  return container;
}

beforeEach(() => {
  mockMonitorData.appSettings.connectionTargets = [
    { dest: "192.168.1.5:9999", hostname: "k1", label: "1号機", ikDeviceAlias: "", ikEnabled: true },
    { dest: "192.168.1.6:9999", hostname: "k2", label: "2号機", ikEnabled: false }
  ];
  vi.clearAllMocks();
});

describe("initModalUI（描画）", () => {
  it("汎用Webhook節・ItemKeeper節・保存/キャンセルを描画", () => {
    const ik = new ItemKeeperIntegration();
    const c = openModal(ik);
    expect(c.querySelector('[data-role="wh-urls"]')).toBeTruthy();
    expect(c.querySelector('[data-role="wh-independent"]')).toBeTruthy();
    expect(c.querySelector('[data-role="ik-enabled"]')).toBeTruthy();
    expect(c.querySelector('[data-role="ik-endpoint"]')).toBeTruthy();
    expect(c.querySelector('[data-role="ik-secret"]')?.getAttribute("type")).toBe("password");
    expect(c.querySelector('[data-role="ext-save"]')).toBeTruthy();
    expect(c.querySelector('[data-role="ext-cancel"]')).toBeTruthy();
  });

  it("現在の保存値をフォームへ反映（webhook独立フラグ等）", () => {
    const ik = new ItemKeeperIntegration();
    ik.settings.enabled = true;
    ik.settings.endpoint = "itemkeeper.com";
    const c = openModal(ik);
    expect(c.querySelector('[data-role="ik-enabled"]').checked).toBe(true);
    expect(c.querySelector('[data-role="ik-endpoint"]').value).toBe("itemkeeper.com");
    expect(c.querySelector('[data-role="wh-independent"]').checked).toBe(true); // nmMock=true
    expect(c.querySelector('[data-role="wh-urls"]').value).toContain("a.test");
  });

  it("対象機器テーブルを connectionTargets から生成（alias入力・連携チェック）", () => {
    const ik = new ItemKeeperIntegration();
    const c = openModal(ik);
    expect(c.querySelectorAll("[data-ik-alias]")).toHaveLength(2);
    const k2chk = c.querySelector('[data-ik-enabled="192.168.1.6:9999"]');
    expect(k2chk.checked).toBe(false); // ikEnabled:false
  });
});

describe("_commitModal（保存して戻る）", () => {
  it("ItemKeeper設定 / webhook / 対象機器エイリアスを確定し永続化", () => {
    const ik = new ItemKeeperIntegration();
    const c = openModal(ik);

    c.querySelector('[data-role="ik-enabled"]').checked = true;
    c.querySelector('[data-role="ik-endpoint"]').value = "itemkeeper.com";
    c.querySelector('[data-role="ik-clientid"]').value = "cid";
    c.querySelector('[data-role="ik-secret"]').value = "sec";
    c.querySelector('[data-role="ik-scope"]').value = "recent:200";
    c.querySelector('[data-role="wh-urls"]').value = "http://x.test/1, http://x.test/2";
    c.querySelector('[data-ik-alias="192.168.1.5:9999"]').value = "1号機";

    // 「保存して戻る」をクリック
    c.querySelector('[data-role="ext-save"]').click();

    expect(ik.settings.enabled).toBe(true);
    expect(ik.settings.endpoint).toBe("itemkeeper.com");
    expect(ik.settings.clientId).toBe("cid");
    expect(ik.settings.secret).toBe("sec");
    expect(ik.settings.historyScope).toBe("recent:200");
    // appSettings へ永続化されている
    expect(mockMonitorData.appSettings.itemkeeper.clientId).toBe("cid");
    // webhook は notificationManager 経由
    expect(nmMock.setWebhookUrls).toHaveBeenCalledWith(["http://x.test/1", "http://x.test/2"]);
    expect(nmMock.setWebhookIndependent).toHaveBeenCalled();
    // 機器エイリアスが connectionTargets に反映
    const t = mockMonitorData.appSettings.connectionTargets.find(x => x.dest === "192.168.1.5:9999");
    expect(t.ikDeviceAlias).toBe("1号機");
    // overlay が閉じている
    expect(document.getElementById("external-modal-overlay").classList.contains("open")).toBe(false);
  });

  it("キャンセルは設定を変更しない", () => {
    const ik = new ItemKeeperIntegration();
    const c = openModal(ik);
    c.querySelector('[data-role="ik-endpoint"]').value = "changed.example";
    c.querySelector('[data-role="ext-cancel"]').click();
    expect(ik.settings.endpoint).toBe(""); // 既定のまま
    expect(document.getElementById("external-modal-overlay").classList.contains("open")).toBe(false);
  });
});
