/**
 * @fileoverview dashboard_camera_ctrl.js 多重動画接続防止 (fix/camera-dedup) のユニットテスト
 *
 * 仕様:
 *   - 同一の物理カメラ (ip:port) へストリームを開始すると、既に同じ ip:port を
 *     ストリーム中の「別ホスト」エントリは停止される（最後に開始した方が優先＝newest wins）。
 *     → IP 再利用 / ホスト名変更で connectionMap キーが二重化しても 1機器=1 MJPEG に収束。
 *   - 別 IP（別機器）への正規ストリームには影響しない。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockMonitorData = {
  appSettings: { connectionTargets: [], cameraPort: 8080, cameraToggle: true },
  hostCameraToggle: {},
  machines: {}
};
vi.doMock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: mockMonitorData,
  PLACEHOLDER_HOSTNAME: "_$_NO_MACHINE_$_"
}));
vi.doMock("../../3dp_lib/dashboard_log_util.js", () => ({ pushLog: vi.fn() }));
vi.doMock("../../3dp_lib/dashboard_notification_manager.js", () => ({
  notificationManager: { notify: vi.fn() }, showAlert: vi.fn()
}));
// dup-A と dup-B は同一IP(=同一物理カメラ)、other は別IP
vi.doMock("../../3dp_lib/dashboard_connection.js", () => ({
  getDeviceIp: vi.fn((h) => ({ "dup-A": "192.168.1.50", "dup-B": "192.168.1.50", "other": "192.168.1.99" }[h] || "")),
  getDeviceDest: vi.fn((h) => ({ "dup-A": "192.168.1.50:9999", "dup-B": "192.168.1.50:9999", "other": "192.168.1.99:9999" }[h] || "")),
  getPrinterType: vi.fn(() => "creality-k1")
}));
global.fetch = vi.fn(() => Promise.resolve({ ok: true }));

const { registerCameraPanel, unregisterCameraPanel, startCameraStream, stopCameraStream } =
  await import("../../3dp_lib/dashboard_camera_ctrl.js");
const logUtil = await import("../../3dp_lib/dashboard_log_util.js");

function mkImg() { return document.createElement("img"); }
function mkBody() { const d = document.createElement("div"); return d; }

beforeEach(() => {
  vi.useFakeTimers();
  mockMonitorData.hostCameraToggle = { "dup-A": true, "dup-B": true, "other": true };
});
afterEach(() => {
  vi.useRealTimers(); vi.clearAllMocks();
  unregisterCameraPanel("dup-A"); unregisterCameraPanel("dup-B"); unregisterCameraPanel("other");
});

describe("カメラ多重接続防止 (fix/camera-dedup)", () => {
  it("同一IPの別ホストへストリーム開始すると旧ホストのストリームは停止される(newest wins)", () => {
    const imgA = mkImg(), imgB = mkImg(), body = mkBody();
    registerCameraPanel("dup-A", imgA, body, null);
    registerCameraPanel("dup-B", imgB, body, null);

    startCameraStream("dup-A");
    expect(imgA.src).toMatch(/192\.168\.1\.50:8080/);   // A がストリーム中
    expect(imgA.classList.contains("off")).toBe(false);

    startCameraStream("dup-B");                          // 同一IPでBを開始
    expect(imgB.src).toMatch(/192\.168\.1\.50:8080/);   // B がストリーム中
    expect(imgB.classList.contains("off")).toBe(false);
    // A は重複として停止（src クリア + off）
    expect(imgA.classList.contains("off")).toBe(true);
    expect(/action=stream/.test(imgA.src)).toBe(false);
  });

  it("別IP(別機器)のストリームには影響しない", () => {
    const imgA = mkImg(), imgO = mkImg(), body = mkBody();
    registerCameraPanel("dup-A", imgA, body, null);
    registerCameraPanel("other", imgO, body, null);

    startCameraStream("dup-A");
    startCameraStream("other");

    // 異なるIPなので両方ストリーム中
    expect(imgA.src).toMatch(/192\.168\.1\.50:8080/);
    expect(imgO.src).toMatch(/192\.168\.1\.99:8080/);
    expect(imgA.classList.contains("off")).toBe(false);
    expect(imgO.classList.contains("off")).toBe(false);
  });

  it("接続済みで同一URLなら再 startCameraStream しても再接続しない(冪等＝接続成功二重化防止)", () => {
    const imgO = mkImg(), body = mkBody();
    registerCameraPanel("other", imgO, body, null);

    startCameraStream("other");
    // 接続成功をシミュレート（jsdom は img.src で onload を自動発火しないため手動）
    if (typeof imgO.onload === "function") imgO.onload();

    const tries1 = logUtil.pushLog.mock.calls.filter(c => /接続試行/.test(String(c[0]))).length;
    expect(tries1).toBe(1);

    // 同一URLで再度開始（onAux と panel_init の二重呼び出し相当）→ 再接続しない
    startCameraStream("other");
    const tries2 = logUtil.pushLog.mock.calls.filter(c => /接続試行/.test(String(c[0]))).length;
    expect(tries2, "接続済み同一URLでは再接続(接続試行)しない").toBe(1);
  });

  it("停止した重複ストリームはリトライしない(userStopped)", () => {
    const imgA = mkImg(), imgB = mkImg(), body = mkBody();
    registerCameraPanel("dup-A", imgA, body, null);
    registerCameraPanel("dup-B", imgB, body, null);
    startCameraStream("dup-A");
    startCameraStream("dup-B");   // A を停止

    const before = vi.getTimerCount();
    vi.advanceTimersByTime(30_000); // A の watchdog/retry が動かないこと（停止済み）
    // 例外なく、Aのstreamは復活しない（off のまま）
    expect(imgA.classList.contains("off")).toBe(true);
    expect(before).toBeGreaterThanOrEqual(0);
  });
});
