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

  it("カメラ画像添付トグル（既定OFF）と機器別カメラ列（既定ON）を描画", () => {
    const ik = new ItemKeeperIntegration();
    const c = openModal(ik);
    const attach = c.querySelector('[data-role="ik-attach-camera"]');
    expect(attach).toBeTruthy();
    expect(attach.checked).toBe(false); // attachCamera 既定 OFF
    // 機器別カメラ列は connectionTargets の各機に対して生成され、既定 ON
    expect(c.querySelectorAll("[data-ik-camera]")).toHaveLength(2);
    expect(c.querySelector('[data-ik-camera="192.168.1.5:9999"]').checked).toBe(true);
  });

  it("状態/ファイル/サムネ添付トグル（既定OFF）を描画", () => {
    const ik = new ItemKeeperIntegration();
    const c = openModal(ik);
    expect(c.querySelector('[data-role="ik-attach-state"]')?.checked).toBe(false);
    expect(c.querySelector('[data-role="ik-attach-files"]')?.checked).toBe(false);
    expect(c.querySelector('[data-role="ik-attach-thumbs"]')?.checked).toBe(false);
  });

  it("ikCamera=false の機器はカメラ列が未チェック", () => {
    mockMonitorData.appSettings.connectionTargets = [
      { dest: "192.168.1.5:9999", hostname: "k1", label: "1号機", ikEnabled: true, ikCamera: false }
    ];
    const ik = new ItemKeeperIntegration();
    const c = openModal(ik);
    expect(c.querySelector('[data-ik-camera="192.168.1.5:9999"]').checked).toBe(false);
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

  it("カメラ添付トグルと機器別カメラ列を確定し永続化", () => {
    const ik = new ItemKeeperIntegration();
    const c = openModal(ik);
    c.querySelector('[data-role="ik-attach-camera"]').checked = true;
    // k1 のカメラ列を OFF にする
    c.querySelector('[data-ik-camera="192.168.1.5:9999"]').checked = false;
    c.querySelector('[data-role="ext-save"]').click();
    expect(ik.settings.attachCamera).toBe(true);
    expect(mockMonitorData.appSettings.itemkeeper.attachCamera).toBe(true);
    const t = mockMonitorData.appSettings.connectionTargets.find(x => x.dest === "192.168.1.5:9999");
    expect(t.ikCamera).toBe(false);
  });

  it("状態/ファイル/サムネ添付トグルを確定し永続化", () => {
    const ik = new ItemKeeperIntegration();
    const c = openModal(ik);
    c.querySelector('[data-role="ik-attach-state"]').checked = true;
    c.querySelector('[data-role="ik-attach-files"]').checked = true;
    c.querySelector('[data-role="ik-attach-thumbs"]').checked = true;
    c.querySelector('[data-role="ext-save"]').click();
    expect(ik.settings.attachState).toBe(true);
    expect(ik.settings.attachFiles).toBe(true);
    expect(ik.settings.attachFileThumbs).toBe(true);
    expect(mockMonitorData.appSettings.itemkeeper.attachFiles).toBe(true);
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

describe("折りたたみ / 連携タイミング / 仕様非表示", () => {
  it("OFF時は ItemKeeper 本体(ik-body)を折りたたむ（▸）", () => {
    const ik = new ItemKeeperIntegration(); // enabled:false 既定
    const c = openModal(ik);
    expect(c.querySelector('[data-role="ik-body"]').style.display).toBe("none");
    expect(c.querySelector('[data-role="ik-chevron"]').textContent).toBe("▸");
  });
  it("ON時は展開（▾）", () => {
    const ik = new ItemKeeperIntegration();
    ik.settings.enabled = true;
    const c = openModal(ik);
    expect(c.querySelector('[data-role="ik-body"]').style.display).not.toBe("none");
    expect(c.querySelector('[data-role="ik-chevron"]').textContent).toBe("▾");
  });
  it("ヘッダクリックで展開トグル", () => {
    const ik = new ItemKeeperIntegration();
    const c = openModal(ik);
    const body = c.querySelector('[data-role="ik-body"]');
    expect(body.style.display).toBe("none");
    c.querySelector('[data-role="ik-header"]').click();
    expect(body.style.display).not.toBe("none");
  });
  it("連携タイミング欄(開始/終了/一時停止/指定/分=既定5)を描画", () => {
    const ik = new ItemKeeperIntegration();
    const c = openModal(ik);
    expect(c.querySelector('[data-role="ik-onstart"]')).toBeTruthy();
    expect(c.querySelector('[data-role="ik-onfinish"]')).toBeTruthy();
    expect(c.querySelector('[data-role="ik-onpause"]')).toBeTruthy();
    expect(c.querySelector('[data-role="ik-oninterval"]')).toBeTruthy();
    expect(c.querySelector('[data-role="ik-intervalmin"]').value).toBe("5");
  });
  it("仕様ファイルパスを表示しない（情報漏えい防止）", () => {
    const ik = new ItemKeeperIntegration();
    const c = openModal(ik);
    expect(c.innerHTML).not.toContain("docs/develop");
    expect(c.innerHTML).not.toContain("specification.md");
  });
  it("タイミングを保存できる（onPause/onInterval/intervalMin）", () => {
    const ik = new ItemKeeperIntegration();
    ik.settings.enabled = true;
    const c = openModal(ik);
    c.querySelector('[data-role="ik-onpause"]').checked = false;
    c.querySelector('[data-role="ik-oninterval"]').checked = true;
    c.querySelector('[data-role="ik-intervalmin"]').value = "10";
    c.querySelector('[data-role="ext-save"]').click();
    expect(ik.settings.onPause).toBe(false);
    expect(ik.settings.onInterval).toBe(true);
    expect(ik.settings.intervalMin).toBe(10);
    if (ik._intervalTimer) clearInterval(ik._intervalTimer); // タイマーリーク防止
  });
});

describe("破棄確認 (requestCloseExternal・共通confirm)", () => {
  it("未変更なら確認なしで閉じる", async () => {
    const ik = new ItemKeeperIntegration();
    openModal(ik);
    await ik.requestCloseExternal();
    expect(document.getElementById("external-modal-overlay").classList.contains("open")).toBe(false);
  });
  it("入力すると dirty になる", () => {
    const ik = new ItemKeeperIntegration();
    ik.settings.enabled = true;
    const c = openModal(ik);
    expect(ik._dirty).toBe(false);
    const ep = c.querySelector('[data-role="ik-endpoint"]');
    ep.value = "x.com";
    ep.dispatchEvent(new Event("input", { bubbles: true }));
    expect(ik._dirty).toBe(true);
  });
  it("dirty時は確認ダイアログを出し、破棄して閉じるでクローズ", async () => {
    const ik = new ItemKeeperIntegration();
    ik.settings.enabled = true;
    const c = openModal(ik);
    const ep = c.querySelector('[data-role="ik-endpoint"]');
    ep.value = "x.com";
    ep.dispatchEvent(new Event("input", { bubbles: true }));
    const p = ik.requestCloseExternal(); // 共通confirmが同期的にDOMへ出る
    const discardBtn = [...document.querySelectorAll(".confirm-button")].find(b => b.textContent === "破棄して閉じる");
    expect(discardBtn).toBeTruthy();
    discardBtn.click();
    await p;
    expect(document.getElementById("external-modal-overlay").classList.contains("open")).toBe(false);
  });
  it("dirty時に「編集に戻る」を押すと閉じない", async () => {
    const ik = new ItemKeeperIntegration();
    ik.settings.enabled = true;
    const c = openModal(ik);
    const ep = c.querySelector('[data-role="ik-endpoint"]');
    ep.value = "x.com";
    ep.dispatchEvent(new Event("input", { bubbles: true }));
    const p = ik.requestCloseExternal();
    const keepBtn = [...document.querySelectorAll(".confirm-button")].find(b => b.textContent === "編集に戻る");
    keepBtn.click();
    await p;
    expect(document.getElementById("external-modal-overlay").classList.contains("open")).toBe(true);
  });
});
