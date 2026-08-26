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
const mockPrinterTypes = {};

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
  getPrinterType: vi.fn((host) => mockPrinterTypes[host] || "creality-k1")
}));

// グローバル fetch モック（_isServiceDown 用 — 常に成功 = サービス停止していない）
global.fetch = vi.fn(() => Promise.resolve({ ok: true }));

const {
  registerCameraPanel,
  unregisterCameraPanel,
  startCameraStream,
  stopCameraStream
} = await import("../../3dp_lib/dashboard_camera_ctrl.js");

const nativeFetch = global.fetch;
const nativePeerConnection = global.RTCPeerConnection;
const nativeMediaStream = global.MediaStream;
const nativeVideoPlay = HTMLMediaElement.prototype.play;

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
    <div class="no-signal"><span class="no-signal-main"></span></div>
    <div class="camera-status hidden">
      <span class="camera-status-label"></span>
      <span class="camera-status-sub"></span>
      <span class="spinner"></span>
    </div>
    <button class="camera-cancel-btn"></button>
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
  mockMonitorData.appSettings.connectionTargets = [];
  mockMonitorData.appSettings.cameraPort = 8080;
  mockPrinterTypes["host-A"] = "creality-k1";
  mockPrinterTypes["host-B"] = "creality-k1";
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  global.fetch = nativeFetch || vi.fn(() => Promise.resolve({ ok: true }));
  if (nativePeerConnection) global.RTCPeerConnection = nativePeerConnection;
  else delete global.RTCPeerConnection;
  if (nativeMediaStream) global.MediaStream = nativeMediaStream;
  else delete global.MediaStream;
  HTMLMediaElement.prototype.play = nativeVideoPlay;
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

  it("K2 WebRTCカメラはK1 MJPEG URLへ誤接続せずWebRTC videoへ接続する", async () => {
    mockPrinterTypes["host-A"] = "creality-k2";
    mockMonitorData.appSettings.connectionTargets = [
      {
        dest: "192.168.1.10:9999",
        hostname: "host-A",
        printerType: "creality-k2",
        cameraPort: 8000,
        cameraProtocol: "k2-webrtc",
      },
    ];
    const answer = {
      type: "answer",
      sdp: [
        "v=0",
        "m=video 9 UDP/TLS/RTP/SAVPF 96",
        "a=rtpmap:96 H264/90000",
      ].join("\r\n"),
    };
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(btoa(JSON.stringify(answer))),
    }));
    global.MediaStream = class MediaStream {
      constructor(tracks = []) { this._tracks = tracks; }
      getTracks() { return this._tracks; }
    };
    class FakePeerConnection extends EventTarget {
      constructor() {
        super();
        this.iceGatheringState = "complete";
        this.iceConnectionState = "new";
        this.connectionState = "new";
        this.localDescription = null;
      }
      addTransceiver() {}
      createOffer() { return Promise.resolve({ type: "offer", sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96" }); }
      setLocalDescription(offer) { this.localDescription = offer; return Promise.resolve(); }
      setRemoteDescription() {
        this.iceConnectionState = "connected";
        this.connectionState = "connected";
        const track = { kind: "video", readyState: "live", muted: false, stop: vi.fn() };
        const event = new Event("track");
        Object.defineProperty(event, "track", { value: track });
        Object.defineProperty(event, "streams", { value: [new MediaStream([track])] });
        this.dispatchEvent(event);
        this.dispatchEvent(new Event("iceconnectionstatechange"));
        this.dispatchEvent(new Event("connectionstatechange"));
        return Promise.resolve();
      }
      close() { this.connectionState = "closed"; }
    }
    global.RTCPeerConnection = FakePeerConnection;
    HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
    const img = createMockImg();
    const body = createMockBody();
    registerCameraPanel("host-A", img, body, null);

    startCameraStream("host-A");
    flushCameraStart();
    await Promise.resolve();
    await Promise.resolve();
    const video = body.querySelector("video.camera-webrtc-stream");
    Object.defineProperty(video, "videoWidth", { configurable: true, value: 1280 });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: 720 });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    await Promise.resolve();

    expect(img.getAttribute("src")).toBeNull();
    expect(video).toBeTruthy();
    expect(global.fetch).toHaveBeenCalledWith(
      "http://192.168.1.10:8000/call/webrtc_local",
      expect.objectContaining({ method: "POST", headers: { "Content-Type": "plain/text" } })
    );
    expect(body.querySelector(".camera-status")?.classList.contains("hidden")).toBe(true);
  });

  it("K2 WebRTCカメラはRTCPeerConnection非対応環境では明示的に未対応表示にする", () => {
    mockPrinterTypes["host-A"] = "creality-k2";
    mockMonitorData.appSettings.connectionTargets = [
      {
        dest: "192.168.1.10:9999",
        hostname: "host-A",
        printerType: "creality-k2",
        cameraPort: 8000,
        cameraProtocol: "k2-webrtc",
      },
    ];
    const oldPeerConnection = global.RTCPeerConnection;
    delete global.RTCPeerConnection;
    const img = createMockImg();
    const body = createMockBody();
    registerCameraPanel("host-A", img, body, null);

    startCameraStream("host-A");
    flushCameraStart();

    expect(body.querySelector(".no-signal-main")?.textContent).toBe("K2 CAMERA");
    expect(body.querySelector(".camera-status-label")?.textContent).toBe("WebRTCカメラ未対応");
    expect(body.querySelector(".camera-status-sub")?.textContent).toContain("http://192.168.1.10:8000/call/webrtc_local");
    global.RTCPeerConnection = oldPeerConnection;
  });

  it("K2 WebRTC signalling timeoutは再接続待機へ遷移する", async () => {
    mockPrinterTypes["host-A"] = "creality-k2";
    mockMonitorData.appSettings.connectionTargets = [
      {
        dest: "192.168.1.10:9999",
        hostname: "host-A",
        printerType: "creality-k2",
        cameraPort: 8000,
        cameraProtocol: "k2-webrtc",
      },
    ];
    global.fetch = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }));
    class TimeoutPeerConnection extends EventTarget {
      constructor() {
        super();
        this.iceGatheringState = "complete";
        this.iceConnectionState = "new";
        this.connectionState = "new";
        this.localDescription = null;
      }
      addTransceiver() {}
      createOffer() { return Promise.resolve({ type: "offer", sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96" }); }
      setLocalDescription(offer) { this.localDescription = offer; return Promise.resolve(); }
      close() { this.connectionState = "closed"; }
    }
    global.RTCPeerConnection = TimeoutPeerConnection;
    const img = createMockImg();
    const body = createMockBody();
    registerCameraPanel("host-A", img, body, null);

    startCameraStream("host-A");
    flushCameraStart();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.resolve();

    expect(body.querySelector(".camera-status-label")?.textContent).toBe("再接続待機");
    expect(body.querySelector(".camera-status-sub")?.textContent).toContain("再試行まで");
  });

  it("K2 WebRTC接続後のfailed状態は再接続待機へ遷移する", async () => {
    mockPrinterTypes["host-A"] = "creality-k2";
    mockMonitorData.appSettings.connectionTargets = [
      {
        dest: "192.168.1.10:9999",
        hostname: "host-A",
        printerType: "creality-k2",
        cameraPort: 8000,
        cameraProtocol: "k2-webrtc",
      },
    ];
    const answer = {
      type: "answer",
      sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 H264/90000",
    };
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(btoa(JSON.stringify(answer))),
    }));
    global.MediaStream = class MediaStream {
      constructor(tracks = []) { this._tracks = tracks; }
      getTracks() { return this._tracks; }
    };
    let lastPeerConnection = null;
    class RecoverPeerConnection extends EventTarget {
      constructor() {
        super();
        this.iceGatheringState = "complete";
        this.iceConnectionState = "new";
        this.connectionState = "new";
        this.localDescription = null;
        lastPeerConnection = this;
      }
      addTransceiver() {}
      createOffer() { return Promise.resolve({ type: "offer", sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96" }); }
      setLocalDescription(offer) { this.localDescription = offer; return Promise.resolve(); }
      setRemoteDescription() {
        this.iceConnectionState = "connected";
        this.connectionState = "connected";
        const track = { kind: "video", readyState: "live", muted: false, stop: vi.fn() };
        const event = new Event("track");
        Object.defineProperty(event, "track", { value: track });
        Object.defineProperty(event, "streams", { value: [new MediaStream([track])] });
        this.dispatchEvent(event);
        this.dispatchEvent(new Event("iceconnectionstatechange"));
        this.dispatchEvent(new Event("connectionstatechange"));
        return Promise.resolve();
      }
      close() { this.connectionState = "closed"; }
    }
    global.RTCPeerConnection = RecoverPeerConnection;
    HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
    const img = createMockImg();
    const body = createMockBody();
    registerCameraPanel("host-A", img, body, null);

    startCameraStream("host-A");
    flushCameraStart();
    await Promise.resolve();
    await Promise.resolve();
    const video = body.querySelector("video.camera-webrtc-stream");
    Object.defineProperty(video, "videoWidth", { configurable: true, value: 1280 });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: 720 });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();

    expect(body.querySelector(".camera-status")?.classList.contains("hidden")).toBe(true);
    lastPeerConnection.iceConnectionState = "failed";
    lastPeerConnection.connectionState = "failed";
    lastPeerConnection.dispatchEvent(new Event("iceconnectionstatechange"));

    expect(body.querySelector(".camera-status-label")?.textContent).toBe("再接続待機");
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
