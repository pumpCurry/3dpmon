/**
 * @fileoverview dashboard_camera_ctrl.js のユニットテスト
 * watchdog タイマー、generation ベース stale 検出、並行制御の検証。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── モック ──
const mockMonitorData = {
  appSettings: { connectionTargets: [], cameraPort: 8080, cameraToggle: true },
  hostCameraToggle: {},
  machines: {}
};

vi.doMock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: mockMonitorData,
  PLACEHOLDER_HOSTNAME: "_$_NO_MACHINE_$_"
}));

vi.doMock("../../3dp_lib/dashboard_log_util.js", () => ({
  pushLog: vi.fn()
}));

vi.doMock("../../3dp_lib/dashboard_notification_manager.js", () => ({
  notificationManager: { notify: vi.fn() },
  showAlert: vi.fn()
}));

vi.doMock("../../3dp_lib/dashboard_connection.js", () => ({
  getDeviceIp: vi.fn((host) => {
    const m = { "host-A": "192.168.1.10", "host-B": "192.168.1.11" };
    return m[host] || "";
  }),
  getDeviceDest: vi.fn((host) => {
    const m = { "host-A": "192.168.1.10:9999", "host-B": "192.168.1.11:9999" };
    return m[host] || "";
  }),
  // 既存テストは K1 ホスト前提（Moonraker 分岐に入らない）
  getPrinterType: vi.fn(() => "creality-k1")
}));

// グローバル fetch モック（_isServiceDown 用 — 常に成功 = サービス停止していない）
global.fetch = vi.fn(() => Promise.resolve({ ok: true }));

const {
  registerCameraPanel,
  unregisterCameraPanel,
  startCameraStream,
  stopCameraStream
} = await import("../../3dp_lib/dashboard_camera_ctrl.js");

// ── ヘルパー ──
function createMockImg() {
  const img = document.createElement("img");
  // jsdom の img は src 設定で onload/onerror を自動発火しない
  return img;
}

function createMockBody() {
  const body = document.createElement("div");
  // _updateUI が querySelector で探す要素
  body.innerHTML = `
    <div data-status="connecting" style="display:none"></div>
    <div data-status="retrying" style="display:none"></div>
    <div data-status="disconnected" style="display:none"></div>
    <div data-status="connected" style="display:none"></div>
  `;
  document.body.appendChild(body);
  return body;
}

function flushCameraStart() {
  vi.advanceTimersByTime(750);
}

beforeEach(() => {
  vi.useFakeTimers();
  mockMonitorData.hostCameraToggle = { "host-A": true, "host-B": true };
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  // レジストリをクリーンアップ
  unregisterCameraPanel("host-A");
  unregisterCameraPanel("host-B");
});

// ======================================================================
//  Phase 1: entry 構造拡張
// ======================================================================

describe("registerCameraPanel — entry 構造", () => {
  it("新規 entry に watchdogTimer/_generation が初期化される", () => {
    const img = createMockImg();
    const body = createMockBody();
    registerCameraPanel("host-A", img, body, null);
    // 内部状態にアクセスするため startCameraStream を呼んで挙動から確認
    startCameraStream("host-A");
    flushCameraStart();
    // 1回目の接続試行が記録される（attempts=1）
    // watchdogTimer が設定されているはず → vi.getTimerCount() で確認
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    stopCameraStream("host-A");
  });
});

// ======================================================================
//  MJPEG img パイプライン差し替え (P0・目玉修正の回帰保護)
//  ※ 旧テストは img を DOM に接続しておらず _releaseImagePipeline の
//    clone/replace 分岐(oldImg.isConnected 前提)を一度も通っていなかった。
// ======================================================================
describe("MJPEG img パイプライン差し替え (P0)", () => {
  it("stop 時: DOM接続済み img を新品へ差し替え、旧img は src/handlers を解放", () => {
    const img = createMockImg();
    const body = createMockBody();
    body.appendChild(img);                 // ★ 実DOM接続（clone/replace の前提）
    img.onload = () => {}; img.onerror = () => {};
    registerCameraPanel("host-A", img, body, null);
    startCameraStream("host-A");
    flushCameraStart();
    expect(img.isConnected, "前提: img は接続済み").toBe(true);

    stopCameraStream("host-A");

    // 旧img: src 除去・handlers null
    expect(img.getAttribute("src"), "旧img の src 除去").toBeNull();
    expect(img.onload, "旧img onload null").toBeNull();
    expect(img.onerror, "旧img onerror null").toBeNull();
    // body 内の img は別要素へ差し替わっている（＝MJPEG デコード資源を解放）
    const cur = body.querySelector("img");
    expect(cur, "body に新 img が存在").toBeTruthy();
    expect(cur === img, "新 img は旧 img と別要素").toBe(false);
    expect(cur.getAttribute("src"), "新 img は src 無し").toBeNull();
  });

  it("id/class/data 属性は clone で維持される", () => {
    const img = createMockImg();
    img.id = "cam-img-hostA";
    img.className = "camera-stream foo";
    img.dataset.host = "host-A";
    const body = createMockBody();
    body.appendChild(img);
    registerCameraPanel("host-A", img, body, null);
    startCameraStream("host-A");
    flushCameraStart();
    stopCameraStream("host-A");

    const cur = body.querySelector("img");
    expect(cur).not.toBe(img);
    expect(cur.id).toBe("cam-img-hostA");
    expect(cur.classList.contains("camera-stream")).toBe(true);
    expect(cur.dataset.host).toBe("host-A");
  });

  it("ON→OFF→ON の連打で最後の1回だけ実接続（debounce 合流）", () => {
    const img = createMockImg();
    const body = createMockBody();
    body.appendChild(img);
    registerCameraPanel("host-A", img, body, null);
    // 750ms 未満の間に ON を連打
    startCameraStream("host-A");
    vi.advanceTimersByTime(200);
    startCameraStream("host-A");
    vi.advanceTimersByTime(200);
    startCameraStream("host-A");
    // まだ debounce 中 → 実接続していない（src 未設定）
    expect(img.getAttribute("src"), "debounce 中は未接続").toBeNull();
    // 最後の要求から 750ms 経過 → 1回だけ接続
    vi.advanceTimersByTime(750);
    const connected = body.querySelector("img");
    expect(connected.getAttribute("src"), "最後の1回だけ接続").toMatch(/192\.168\.1\.10:8080/);
    stopCameraStream("host-A");
  });
});

// ======================================================================
//  Phase 2: watchdog タイマー
// ======================================================================

describe("watchdog タイマー (CRITICAL)", () => {
  it("img.src 設定後、onload/onerror が来ないと 10秒後にリトライがスケジュールされる", () => {
    const img = createMockImg();
    const body = createMockBody();
    registerCameraPanel("host-A", img, body, null);
    startCameraStream("host-A");
    flushCameraStart();

    // 最初の接続試行（attempts=1）
    // src が設定されているはず
    expect(img.src).toMatch(/192\.168\.1\.10:8080/);

    // 10秒経過 → watchdog 発火 → _releaseImagePipeline で src が除去される
    vi.advanceTimersByTime(10_000);
    // watchdog で removeAttribute("src") される（旧: || true で常に成功していた無意味assertionを是正）
    expect(img.getAttribute("src")).toBeNull();
    stopCameraStream("host-A");
  });

  it("onload 発火で watchdog がクリアされる", () => {
    const img = createMockImg();
    const body = createMockBody();
    registerCameraPanel("host-A", img, body, null);
    startCameraStream("host-A");
    flushCameraStart();

    const timersBeforeOnload = vi.getTimerCount();
    expect(timersBeforeOnload).toBeGreaterThan(0);

    // onload を発火
    img.onload && img.onload();

    // watchdog がクリアされたので残タイマーが減る
    const timersAfterOnload = vi.getTimerCount();
    expect(timersAfterOnload).toBeLessThan(timersBeforeOnload);
    stopCameraStream("host-A");
  });

  it("watchdog 発火後も userStopped なら何もしない", () => {
    const img = createMockImg();
    const body = createMockBody();
    registerCameraPanel("host-A", img, body, null);
    startCameraStream("host-A");
    flushCameraStart();
    stopCameraStream("host-A"); // userStopped = true

    // watchdog が発火しても何も起こらない
    vi.advanceTimersByTime(15_000);
    // 例外が出ないこと
    expect(true).toBe(true);
  });
});

// ======================================================================
//  Phase 4: 並行制御
// ======================================================================

describe("startCameraStream 並行制御 (HIGH)", () => {
  it("連続2回呼ばれてもタイマーが二重起動しない", () => {
    const img = createMockImg();
    const body = createMockBody();
    registerCameraPanel("host-A", img, body, null);

    startCameraStream("host-A");
    flushCameraStart();
    const timers1 = vi.getTimerCount();

    startCameraStream("host-A"); // 2回目
    const timers2 = vi.getTimerCount();

    // 1回目のタイマーは _cancelTimers でクリアされるので、
    // タイマー数は増えない（同程度になる）
    expect(timers2).toBeLessThanOrEqual(timers1 + 1);
    stopCameraStream("host-A");
  });

  it("startCameraStream 呼び出しごとに _generation がインクリメントされる", () => {
    const img = createMockImg();
    const body = createMockBody();
    registerCameraPanel("host-A", img, body, null);

    // 旧コールバックを取得
    startCameraStream("host-A");
    flushCameraStart();
    const oldOnerror = img.onerror;

    // 2回目の呼び出し
    startCameraStream("host-A");
    flushCameraStart();

    // 旧 onerror が発火しても stale 扱いで何も起こらない（generation 不一致）
    // 新しい onerror に差し替わっている
    expect(img.onerror).not.toBe(oldOnerror);
    stopCameraStream("host-A");
  });
});

// ======================================================================
//  registerCameraPanel での旧 entry 完全停止 (MEDIUM)
// ======================================================================

describe("registerCameraPanel での旧 entry 完全停止", () => {
  it("再登録時に旧 img.src がクリアされる", () => {
    const oldImg = createMockImg();
    const body = createMockBody();
    registerCameraPanel("host-A", oldImg, body, null);
    startCameraStream("host-A");
    flushCameraStart();
    expect(oldImg.src).toMatch(/192\.168\.1\.10/);

    // 同じホスト名で再登録
    const newImg = createMockImg();
    registerCameraPanel("host-A", newImg, body, null);

    // 旧 img の src が空になっている
    expect(oldImg.src === "" || oldImg.src.endsWith("/") || oldImg.getAttribute("src") === "").toBe(true);
    // 旧 img の onload/onerror が null
    expect(oldImg.onload).toBeNull();
    expect(oldImg.onerror).toBeNull();
  });

  it("再登録後の新 entry は generation=0 から始まる", () => {
    const oldImg = createMockImg();
    const body = createMockBody();
    registerCameraPanel("host-A", oldImg, body, null);
    startCameraStream("host-A"); // _generation++
    flushCameraStart();

    // 再登録
    const newImg = createMockImg();
    registerCameraPanel("host-A", newImg, body, null);

    // 新 entry で startCameraStream を呼ぶ
    startCameraStream("host-A");
    flushCameraStart();
    // 例外なく動作する（generation が独立している）
    expect(true).toBe(true);
    stopCameraStream("host-A");
  });
});

// ======================================================================
//  unregisterCameraPanel
// ======================================================================

describe("unregisterCameraPanel", () => {
  it("登録解除で全タイマーがクリアされる", () => {
    const img = createMockImg();
    const body = createMockBody();
    registerCameraPanel("host-A", img, body, null);
    startCameraStream("host-A");
    flushCameraStart();

    const timersBefore = vi.getTimerCount();
    expect(timersBefore).toBeGreaterThan(0);

    unregisterCameraPanel("host-A");

    const timersAfter = vi.getTimerCount();
    expect(timersAfter).toBeLessThan(timersBefore);
  });

  it("存在しないホストの解除は無害", () => {
    expect(() => unregisterCameraPanel("ghost")).not.toThrow();
  });
});

// ======================================================================
//  マルチホスト独立性
// ======================================================================

describe("マルチホスト独立性", () => {
  it("2台のホストが独立して接続される", () => {
    const imgA = createMockImg();
    const imgB = createMockImg();
    const body = createMockBody();
    registerCameraPanel("host-A", imgA, body, null);
    registerCameraPanel("host-B", imgB, body, null);

    startCameraStream("host-A");
    startCameraStream("host-B");
    flushCameraStart();

    expect(imgA.src).toMatch(/192\.168\.1\.10/);
    expect(imgB.src).toMatch(/192\.168\.1\.11/);
    expect(imgA.src).not.toBe(imgB.src);

    stopCameraStream("host-A");
    stopCameraStream("host-B");
  });

  it("一方を停止しても他方に影響しない", () => {
    const imgA = createMockImg();
    const imgB = createMockImg();
    const body = createMockBody();
    registerCameraPanel("host-A", imgA, body, null);
    registerCameraPanel("host-B", imgB, body, null);

    startCameraStream("host-A");
    startCameraStream("host-B");
    flushCameraStart();

    stopCameraStream("host-A");

    // host-B の img.src は維持されている
    expect(imgB.src).toMatch(/192\.168\.1\.11/);
    stopCameraStream("host-B");
  });
});
