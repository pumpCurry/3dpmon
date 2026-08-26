/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 カメラ制御モジュール
 * @file dashboard_camera_ctrl.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_camera_ctrl
 *
 * 【機能内容サマリ】
 * - ホスト別のカメラ映像ストリーム管理
 * - パネル内 <img> タグへの直接操作（IDスコーピング対応）
 * - 接続状態に応じた NO SIGNAL / CONNECTING / RETRYING UI
 * - Exponential Backoff による再接続（最大5回）
 * - 配信サービス停止時は一度だけエラー通知
 * - K2系WebRTCカメラの直接表示
 *
 * 【公開関数一覧】
 * - {@link registerCameraPanel}：カメラパネルを登録
 * - {@link unregisterCameraPanel}：カメラパネルを登録解除
 * - {@link startCameraStream}：カメラストリーム開始
 * - {@link stopCameraStream}：カメラストリーム停止
 * - {@link stopAllCameraStreams}：全ホストのカメラを停止
 * - {@link handleCameraError}：接続エラー処理（互換用）
 *
 * @version 1.390.1391 (PR #432)
 * @since   1.390.193 (PR #86)
 * @lastModified 2026-08-26 10:08:30
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

import { monitorData } from "./dashboard_data.js";
import { getDeviceIp, getDeviceDest, getPrinterType } from "./dashboard_connection.js";
import { pushLog }                  from "./dashboard_log_util.js";
import { notificationManager }      from "./dashboard_notification_manager.js";
import { extractHost }              from "./dashboard_target_identity.js";

// ─── 定数 ────────────────────────────────────────────────────
/** @constant {number} 最大再接続試行回数 */
const CAMERA_MAX_RETRY      = 5;
/** @constant {number} 基本リトライ間隔 (ms) */
const DEFAULT_RETRY_DELAY   = 2000;
/** @constant {number} デフォルトのストリーム提供ポート */
const DEFAULT_STREAM_PORT   = 8080;
/** @constant {number} K2系WebRTC camera serviceの既定ポート */
const DEFAULT_K2_WEBRTC_PORT = 8000;
/** @constant {number} watchdog タイムアウト (ms) — onload/onerror が来なければ強制的に失敗扱い */
const CAMERA_WATCHDOG_MS    = 10_000;
/** @constant {number} リレー子モードでの snapshot ポーリング間隔 既定 (ms) ≈ 0.4FPS */
const RELAY_CAMERA_INTERVAL_MS = 2500;
/** @constant {number} リレー子モードのポーリング間隔 下限 (ms) */
const RELAY_CAMERA_MIN_INTERVAL_MS = 1000;
/** @constant {number} ユーザー操作でONへ戻す際に実接続を合流する待機時間 (ms) */
const CAMERA_USER_RESTART_DEBOUNCE_MS = 750;
/** @constant {number} カメラサービス疎通確認 fetch の明示タイムアウト (ms) */
const CAMERA_SERVICE_PROBE_TIMEOUT_MS = 3000;
/** @constant {number} K2 WebRTC 接続確立待ちタイムアウト (ms) */
const K2_WEBRTC_CONNECTION_TIMEOUT_MS = 15000;
/** @constant {number} K2 WebRTC 初回フレーム待ちタイムアウト (ms) */
const K2_WEBRTC_FRAME_TIMEOUT_MS = 20000;

/**
 * 現在のレンダラーがリレー子（readonly/satellite）かどうかを返す。
 * 子はプリンタへ直接到達できないため、親(5313)の snapshot プロキシ経由で取得する。
 *
 * @private
 * @returns {boolean}
 */
function _isRelayChild() {
  return typeof window !== "undefined" && window._3dpmonRelayChild === true;
}

/**
 * リレー子モードでの snapshot ポーリング間隔を解決する。
 * monitorData.appSettings.relayCameraIntervalMs で上書き可（下限あり）。
 *
 * @private
 * @returns {number} ポーリング間隔 (ms)
 */
function _relayCameraIntervalMs() {
  const v = Number(monitorData.appSettings?.relayCameraIntervalMs);
  const ms = Number.isFinite(v) && v > 0 ? v : RELAY_CAMERA_INTERVAL_MS;
  return Math.max(RELAY_CAMERA_MIN_INTERVAL_MS, ms);
}

/**
 * カメラ制御用に保存済みconnectionTargetを取得する。
 *
 * 【詳細説明】
 * - dashboard_connection.js との循環参照を増やさないため、このmoduleでは monitorData から直接引く。
 * - host名確定前後の両方に対応するため、dest一致、hostname一致、destのhost部一致の順に探す。
 *
 * @private
 * @param {string} host - hostname または接続キー
 * @returns {object|null} connectionTarget、見つからない場合 null
 */
function _findCameraConnectionTarget(host) {
  const dest = getDeviceDest(host);
  const hostText = String(host || "").trim();
  const targets = monitorData.appSettings?.connectionTargets || [];
  return targets.find((target) => target?.dest === dest) ||
    targets.find((target) => target?.hostname === hostText) ||
    targets.find((target) => extractHost(target?.dest || "") === hostText) ||
    null;
}

/**
 * K2系カメラ表示用portを解決する。
 *
 * 【詳細説明】
 * - 明示的なper-host cameraPortを最優先し、未設定ならK2 WebRTC camera serviceとして観測される8000を返す。
 * - `/info.videoPort` は443を返す個体があるが、従来MJPEG endpointではないためここでは既定portに使わない。
 *
 * @private
 * @param {string} host - hostname または接続キー
 * @returns {number} K2 camera service port
 */
function _resolveK2CameraPort(host) {
  const target = _findCameraConnectionTarget(host);
  const port = Number(target?.cameraPort);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_K2_WEBRTC_PORT;
}

// ─── ホスト別カメラ状態レジストリ ─────────────────────────────
/**
 * ホスト名をキーとするカメラパネル登録情報。
 * パネル初期化時に registerCameraPanel で登録し、
 * パネル破棄時に unregisterCameraPanel で解除する。
 *
 * @typedef {Object} CameraPanelEntry
 * @property {HTMLImageElement} img       - パネル内の <img> 要素
 * @property {HTMLElement}      body      - パネル本体要素（.panel-body）
 * @property {HTMLInputElement|null} toggle - ヘッダー内のトグルスイッチ
 * @property {string}   hostname          - ホスト名（ログ・通知用）
 * @property {number}   attempts          - リトライ試行回数
 * @property {number|null} retryTimeout   - setTimeout ID
 * @property {number|null} countdownTimer - setInterval ID
 * @property {number|null} watchdogTimer  - setTimeout ID (img.src 後の応答監視)
 * @property {number|null} pollTimeout    - setTimeout ID (リレー子 snapshot ポーリング)
 * @property {number|null} userRestartTimer - ユーザーON要求を合流する debounce タイマー
 * @property {AbortController|null} serviceProbeAbortController - サービス疎通確認 fetch の中断制御
 * @property {RTCPeerConnection|null} webrtcPeerConnection - K2 WebRTC camera のPeerConnection
 * @property {HTMLVideoElement|null} webrtcVideo - K2 WebRTC camera 表示用video要素
 * @property {boolean} desiredEnabled     - UI/設定上のカメラ有効希望状態
 * @property {number}   _generation       - stale 検出用 epoch カウンタ
 *                                          各非同期コールバックはクロージャでこの値をキャプチャし
 *                                          発火時に entry._generation と比較して stale なら return する
 * @property {boolean}  firstConnected    - 初回接続完了フラグ
 * @property {boolean}  userStopped       - ユーザによる明示停止フラグ
 * @property {boolean}  serviceNotified   - サービス停止通知済みフラグ
 */

/**
 * ホスト名 → CameraPanelEntry のマップ
 * @type {Map<string, CameraPanelEntry>}
 */
const cameraRegistry = new Map();

/* ─── パネル登録 API ─── */

/**
 * カメラパネルをレジストリに登録する。
 * パネル初期化（initCameraPanel）から呼び出す。
 *
 * @function registerCameraPanel
 * @param {string} hostname          - ホスト名
 * @param {HTMLImageElement} img     - パネル内の <img> 要素
 * @param {HTMLElement} body         - パネル本体要素
 * @param {HTMLInputElement|null} toggle - ヘッダーのトグルスイッチ
 * @returns {void}
 */
export function registerCameraPanel(hostname, img, body, toggle) {
  /* 既存エントリの完全停止（順序重要） */
  const prev = cameraRegistry.get(hostname);
  if (prev) {
    // 1. ハンドラ・タイマーを全クリア（停止時の spurious onerror を防ぐ）
    _cancelTimers(prev);
    // 2. generation インクリメントで suspend 中の async onerror を stale 化
    prev._generation = (prev._generation || 0) + 1;
    // 3. 旧 img の MJPEG デコードパイプラインを完全解放
    _stopK2WebRtcPipeline(prev);
    _releaseImagePipeline(prev, { replace: false });
    // 4. リトライ抑制フラグ
    prev.userStopped = true;
  }

  cameraRegistry.set(hostname, {
    hostname,
    img,
    body,
    toggle,
    attempts: 0,
    retryTimeout: null,
    countdownTimer: null,
    watchdogTimer: null,
    pollTimeout: null,
    userRestartTimer: null,
    serviceProbeAbortController: null,
    webrtcPeerConnection: null,
    webrtcVideo: null,
    streamTarget: null,
    desiredEnabled: false,
    _generation: 0,
    firstConnected: false,
    userStopped: false,
    serviceNotified: false
  });
}

/**
 * カメラパネルをレジストリから解除する。
 * パネル破棄時に呼び出す。ストリームも停止する。
 *
 * @function unregisterCameraPanel
 * @param {string} hostname - ホスト名
 * @returns {void}
 */
export function unregisterCameraPanel(hostname) {
  const entry = cameraRegistry.get(hostname);
  if (!entry) return;
  // suspend 中の async onerror を stale 化（orphan タイマー防止）
  entry._generation = (entry._generation || 0) + 1;
  entry.userStopped = true;
  entry.desiredEnabled = false;
  _cancelTimers(entry);
  _stopK2WebRtcPipeline(entry);
  entry.attempts = 0;
  entry.streamTarget = null;
  entry._activeStreamUrl = null;
  _releaseImagePipeline(entry, { replace: false });
  cameraRegistry.delete(hostname);
}

/* ─── ストリーム制御 API ─── */

/**
 * 指定ホストのカメラストリームを開始する。
 * レジストリに登録済みのパネルが無い場合は何もしない。
 *
 * @function startCameraStream
 * @param {string} hostname - ホスト名
 * @returns {void}
 */
export function startCameraStream(hostname) {
  const host = hostname;
  if (!host) return;

  const entry = cameraRegistry.get(host);
  if (!entry) {
    /* レジストリ未登録（パネルが閉じている等）→ 何もしない */
    return;
  }

  entry.desiredEnabled = true;
  entry.userStopped = false;
  _cancelUserRestartTimer(entry);

  /* ユーザーが短時間にON/OFFを連打した場合、途中のON要求を実接続へ進めない。
     generationを捕捉し、停止・再登録・別ON要求で古くなったcallbackは接続開始前に捨てる。 */
  entry._generation = (entry._generation || 0) + 1;
  const gen = entry._generation;
  entry.userRestartTimer = setTimeout(() => {
    entry.userRestartTimer = null;
    if (!_canUseEntry(entry, gen)) return;
    _startCameraStreamNow(host, entry, gen);
  }, CAMERA_USER_RESTART_DEBOUNCE_MS);
}

/**
 * debounce 後に実際のカメラストリーム接続を開始する。
 *
 * 【詳細説明】
 * - 公開APIの startCameraStream() はユーザー操作を合流するだけにし、実接続は本関数へ集約する。
 * - generation と desiredEnabled を入口で検査し、停止後に残った古いタイマーが img.src を設定しないようにする。
 *
 * @private
 * @param {string} host - ホスト名
 * @param {CameraPanelEntry} entry - レジストリ上のカメラ状態
 * @param {number} gen - start要求時点の世代番号
 * @returns {void}
 */
function _startCameraStreamNow(host, entry, gen) {
  if (!_canUseEntry(entry, gen)) return;

  /* ★ 冪等化（起動時「カメラ接続成功」二重ログ/二重接続の修正）:
     onAux(server.webcams.list 到着) と panel_init/接続確立 が両方 startCameraStream を
     呼ぶため、Moonraker では一度接続→URL解決後に再接続して "接続成功" が二重化していた。
     既に接続済み(firstConnected)で配信先URLが変わらないなら、再接続せず即 return する。
     ※ K1/relay 子は配信URLが固定のため「接続済みなら同一」とみなす。Moonraker は
       machine._cameraStreamUrl の変化時のみ再接続する。停止中(userStopped)は対象外。 */
  if (entry.firstConnected && !entry.userStopped && entry._activeStreamUrl) {
    const toggleOn = (monitorData.hostCameraToggle[host] ?? monitorData.appSettings.cameraToggle);
    if (toggleOn) {
      let nextUrl = entry._activeStreamUrl;
      if (!_isRelayChild() && getPrinterType(host) === "moonraker") {
        nextUrl = monitorData.machines[host]?._cameraStreamUrl || entry._activeStreamUrl;
      }
      if (nextUrl === entry._activeStreamUrl) return;  // 同一URLで配信中 → 何もしない
    }
  }

  /* ★ 並行制御: 既存接続を完全停止してから新規開始
     handleSocketOpen + initCameraPanel からの同時呼び出しを安全にする */
  _cancelTimers(entry);
  entry._generation = gen;  // debounce要求の世代を、この実接続の有効世代として維持する

  entry.userStopped = false;
  entry.desiredEnabled = true;
  entry.serviceNotified = false;
  entry.firstConnected = false;

  /* per-host カメラトグルが OFF ならストリームを開始せず切断表示にする */
  if (!(monitorData.hostCameraToggle[host] ?? monitorData.appSettings.cameraToggle)) {
    _updateUI(entry, "disconnected");
    return;
  }

  /* ★ リレー子（readonly/satellite）はプリンタへ直接到達できない。
     IP 解決をスキップし、親(5313)の snapshot プロキシを低FPSポーリングする。
     URL は相対パス（= 親 origin）なので子→親へ届く。 */
  if (_isRelayChild()) {
    entry.attempts = 0;
    _cancelTimers(entry);
    _connectStreamRelay(entry, host, gen);
    return;
  }

  /* デバイスIP解決 */
  const deviceIp = getDeviceIp(host);
  const ip = deviceIp || "";
  if (!ip) {
    _updateUI(entry, "disconnected");
    return;
  }

  /* ★ Moonraker(Fluidd): カメラURLは機器・構成依存で可変（相対 /webcam/... を nginx が
     proxy 等）。K1 固定の "ip:8080/?action=stream" は使わず、server.webcams.list 由来の
     解決済み絶対URL(machine._cameraStreamUrl)を使う。未取得時は K1 URL を叩かず待機し、
     onAux でカメラ一覧到着時に startCameraStream が再実行される。 */
  if (getPrinterType(host) === "moonraker") {
    const machine = monitorData.machines[host];
    const camUrl = machine?._cameraStreamUrl;
    if (!camUrl) {
      _updateUI(entry, "disconnected");
      return;
    }
    let camPort = 80;
    try { camPort = Number(new URL(camUrl).port) || (camUrl.startsWith("https") ? 443 : 80); } catch { /* noop */ }
    entry.streamUrl = camUrl;
    entry.attempts = 0;
    entry.cameraPort = camPort;
    _cancelTimers(entry);
    _connectStream(entry, extractHost(ip), gen);
    return;
  }

  /* ★ K2系: 現時点の実機はWebRTC/HTML camera serviceで、K1のMJPEG <img> endpointではない。
     `http://ip:8000/call/webrtc_local` へSDP offerをPOSTし、ChromiumのRTCPeerConnectionで受信する。
     K1のMJPEG <img> へフォールバックすると誤ったリトライになるため、K2は専用経路だけを使う。 */
  if (getPrinterType(host) === "creality-k2") {
    const port = _resolveK2CameraPort(host);
    entry.streamUrl = `http://${extractHost(ip)}:${port}/call/webrtc_local`;
    entry.attempts = 0;
    entry.cameraPort = port;
    entry.streamTarget = `${extractHost(ip)}:${port}`;
    _cancelTimers(entry);
    _connectK2WebRtcStream(entry, extractHost(ip), gen);
    return;
  }

  /* カメラポート解決: per-host（connectionTarget.cameraPort）→ グローバル設定 → デフォルト
     connectionTarget の検索は getDeviceDest 経由で dest を取得して行う */
  const dest = getDeviceDest(host);
  const tgt = _findCameraConnectionTarget(host) || { dest };
  const port = tgt?.cameraPort || monitorData.appSettings.cameraPort || DEFAULT_STREAM_PORT;

  entry.streamUrl = null;  // K1 はポート方式（override 不使用）
  entry.attempts = 0;
  entry.cameraPort = port;
  _cancelTimers(entry);
  _connectStream(entry, extractHost(ip), gen);
}

/**
 * 指定ホストのカメラストリームを停止する。
 * ユーザ操作による停止であることをフラグで記録し、自動リトライを防止する。
 *
 * @function stopCameraStream
 * @param {string} hostname - ホスト名
 * @returns {void}
 */
export function stopCameraStream(hostname) {
  const host = hostname;
  if (!host) return;

  const entry = cameraRegistry.get(host);
  if (!entry) return;

  entry.userStopped = true;
  entry.desiredEnabled = false;
  entry._generation = (entry._generation || 0) + 1;
  _stopEntry(entry);
  _updateUI(entry, "disconnected");
  pushLog(`カメラストリーム停止 (${host})`, "info", false, host);
  notificationManager.notify("cameraConnectionStopped", { hostname: host });
}

/**
 * 全ホストのカメラストリームを停止する。
 *
 * @function stopAllCameraStreams
 * @returns {void}
 */
export function stopAllCameraStreams() {
  for (const [, entry] of cameraRegistry) {
    entry.userStopped = true;
    entry.desiredEnabled = false;
    entry._generation = (entry._generation || 0) + 1;
    _stopEntry(entry);
    _updateUI(entry, "disconnected");
  }
}

/**
 * 旧API互換エントリポイント。
 *
 * @function handleCameraError
 * @returns {void}
 */
export function handleCameraError(hostname) {
  if (!hostname) return;
  const entry = cameraRegistry.get(hostname);
  if (entry) _updateUI(entry, "disconnected");
  pushLog("カメラ映像の読み込みエラー", "error", false, hostname);
}

/* ─── 内部ヘルパー ─── */

/**
 * タイマーとイベントハンドラをクリアする。
 *
 * @private
 * @param {CameraPanelEntry} entry
 * @returns {void}
 */
function _cancelTimers(entry) {
  if (entry.img) {
    entry.img.onload = null;
    entry.img.onerror = null;
  }
  if (entry.retryTimeout != null) {
    clearTimeout(entry.retryTimeout);
    entry.retryTimeout = null;
  }
  if (entry.countdownTimer != null) {
    clearInterval(entry.countdownTimer);
    entry.countdownTimer = null;
  }
  if (entry.watchdogTimer != null) {
    clearTimeout(entry.watchdogTimer);
    entry.watchdogTimer = null;
  }
  if (entry.pollTimeout != null) {
    clearTimeout(entry.pollTimeout);
    entry.pollTimeout = null;
  }
  _cancelUserRestartTimer(entry);
  _abortServiceProbe(entry);
}

/**
 * watchdog タイマーのみクリア（onload/onerror 発火時の即時クリア用）。
 * @private
 * @param {CameraPanelEntry} entry
 */
function _clearWatchdog(entry) {
  if (entry.watchdogTimer != null) {
    clearTimeout(entry.watchdogTimer);
    entry.watchdogTimer = null;
  }
}

/**
 * ストリームを停止しタイマーをクリアする（UI更新はしない）。
 *
 * @private
 * @param {CameraPanelEntry} entry
 * @returns {void}
 */
function _stopEntry(entry) {
  _cancelTimers(entry);
  _stopK2WebRtcPipeline(entry);
  entry.attempts = 0;
  entry.streamTarget = null;
  entry._activeStreamUrl = null;   // ★ 冪等化用の配信URL記録もクリア（再開時に再接続させる）
  _releaseImagePipeline(entry, { replace: true });
}

/**
 * 同一の物理カメラ (ip:port) へ既にストリーム中の「別ホスト」エントリを停止する。
 * IP 再利用やホスト名変更で connectionMap キーが二重化した際、同一機器へ
 * MJPEG が重複接続するのを防ぐ（最後に開始したストリームを優先＝newest wins）。
 * 別 IP（別機器）の正規ストリームには影響しない。
 *
 * @private
 * @param {CameraPanelEntry} keepEntry - 維持するエントリ（停止対象から除外）
 * @param {string} target - "ip:port"
 * @returns {void}
 */
function _stopDuplicateTargetStreams(keepEntry, target) {
  for (const [, other] of cameraRegistry) {
    if (other === keepEntry) continue;
    if (other.userStopped) continue;
    if (other.streamTarget !== target) continue;
    _cancelTimers(other);
    _stopK2WebRtcPipeline(other);
    other._generation = (other._generation || 0) + 1; // 旧 async コールバックを stale 化
    other.userStopped = true;
    other.desiredEnabled = false;
    other.streamTarget = null;
    _releaseImagePipeline(other, { replace: true });
    _updateUI(other, "disconnected");
    pushLog(
      `同一カメラ(${target})への重複接続を検出 → 旧ホスト「${other.hostname}」のストリームを停止しました`,
      "warn", false, other.hostname
    );
  }
}

/**
 * K2 WebRTC signalling用のofferをbase64文字列へ変換する。
 *
 * 【詳細説明】
 * - K2 camera serviceは `plain/text` bodyとしてbase64化したJSON offerを期待する。
 * - ブラウザ実装では `btoa` を使い、非ブラウザテスト環境では `Buffer` へフォールバックする。
 *
 * @private
 * @param {RTCSessionDescriptionInit} description - local offer description
 * @returns {string} base64 encoded offer JSON
 */
function _encodeK2WebRtcOffer(description) {
  const payload = JSON.stringify({ type: description.type, sdp: description.sdp });
  if (typeof btoa === "function") return btoa(payload);
  return globalThis.Buffer.from(payload, "utf8").toString("base64");
}

/**
 * K2 WebRTC signalling応答をanswerへ変換する。
 *
 * 【詳細説明】
 * - 実機はbase64化したJSON answerを `text/plain` で返す。
 * - 不正応答は例外として上位の接続失敗処理へ渡す。
 *
 * @private
 * @param {string} text - signalling response body
 * @returns {RTCSessionDescriptionInit} remote answer description
 */
function _decodeK2WebRtcAnswer(text) {
  const trimmed = String(text || "").trim();
  const decoded = typeof atob === "function"
    ? atob(trimmed)
    : globalThis.Buffer.from(trimmed, "base64").toString("utf8");
  return JSON.parse(decoded);
}

/**
 * RTCPeerConnectionのICE gathering完了を待つ。
 *
 * @private
 * @param {RTCPeerConnection} pc - 接続対象PeerConnection
 * @returns {Promise<void>} ICE gathering完了で解決
 */
function _waitForK2IceGatheringComplete(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolvePromise) => {
    const onState = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", onState);
        resolvePromise();
      }
    };
    pc.addEventListener("icegatheringstatechange", onState);
  });
}

/**
 * RTCPeerConnectionの接続確立を待つ。
 *
 * @private
 * @param {RTCPeerConnection} pc - 接続対象PeerConnection
 * @param {number} timeoutMs - timeout milliseconds
 * @returns {Promise<void>} connected/completedで解決
 */
function _waitForK2WebRtcConnection(pc, timeoutMs) {
  if (["connected", "completed"].includes(pc.iceConnectionState) || pc.connectionState === "connected") {
    return Promise.resolve();
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error("K2 WebRTC connection timeout"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      pc.removeEventListener("iceconnectionstatechange", onState);
      pc.removeEventListener("connectionstatechange", onState);
    };
    const onState = () => {
      if (["connected", "completed"].includes(pc.iceConnectionState) || pc.connectionState === "connected") {
        cleanup();
        resolvePromise();
      } else if (["failed", "closed"].includes(pc.iceConnectionState) || ["failed", "closed"].includes(pc.connectionState)) {
        cleanup();
        rejectPromise(new Error(`K2 WebRTC failed: ice=${pc.iceConnectionState} pc=${pc.connectionState}`));
      }
    };
    pc.addEventListener("iceconnectionstatechange", onState);
    pc.addEventListener("connectionstatechange", onState);
  });
}

/**
 * K2 WebRTC videoの初回フレームを待つ。
 *
 * @private
 * @param {HTMLVideoElement} video - 表示用video要素
 * @param {number} timeoutMs - timeout milliseconds
 * @returns {Promise<void>} video dimension観測で解決
 */
function _waitForK2VideoFrame(video, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        clearInterval(timer);
        resolvePromise();
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        rejectPromise(new Error("K2 WebRTC video frame timeout"));
      }
    }, 100);
  });
}

/**
 * K2 WebRTC表示用video要素を取得または作成する。
 *
 * @private
 * @param {CameraPanelEntry} entry - カメラ状態
 * @returns {HTMLVideoElement} 表示用video要素
 */
function _ensureK2WebRtcVideo(entry) {
  if (entry.webrtcVideo?.isConnected) return entry.webrtcVideo;
  const video = document.createElement("video");
  video.className = "camera-webrtc-stream";
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  const anchor = entry.img;
  if (anchor?.parentNode) {
    anchor.parentNode.insertBefore(video, anchor.nextSibling);
  } else {
    entry.body?.appendChild(video);
  }
  entry.webrtcVideo = video;
  return video;
}

/**
 * K2 WebRTC pipelineを停止してDOM/PeerConnectionを解放する。
 *
 * @private
 * @param {CameraPanelEntry} entry - カメラ状態
 * @returns {void}
 */
function _stopK2WebRtcPipeline(entry) {
  const pc = entry?.webrtcPeerConnection;
  if (pc) {
    try { pc.close(); } catch { /* noop */ }
  }
  entry.webrtcPeerConnection = null;
  const video = entry?.webrtcVideo;
  if (video) {
    const stream = video.srcObject;
    if (stream && typeof stream.getTracks === "function") {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { /* noop */ }
      }
    }
    video.srcObject = null;
    video.remove();
  }
  entry.webrtcVideo = null;
}

/**
 * K2 WebRTC camera streamへ接続する。
 *
 * 【詳細説明】
 * - 実機probeで確認した `RTCPeerConnection → offer → HTTP POST → answer → ontrack → video frame` の順序を本体へ移植する。
 * - 失敗時はK1/MJPEGへフォールバックせず、WebRTC専用の失敗としてUIへ表示し、誤ったリトライ地獄を避ける。
 *
 * @private
 * @param {CameraPanelEntry} entry - カメラ状態
 * @param {string} host - IPアドレス（ポートなし）
 * @param {number} gen - start要求時点の世代番号
 * @returns {void}
 */
function _connectK2WebRtcStream(entry, host, gen = entry._generation) {
  if (!_canUseEntry(entry, gen)) return;
  if (typeof globalThis.RTCPeerConnection !== "function") {
    _updateUI(entry, "unsupported", { reason: "RTCPeerConnection unavailable", url: entry.streamUrl });
    pushLog("K2 WebRTCカメラを表示できません: RTCPeerConnectionが利用できません", "warn", false, entry.hostname);
    return;
  }

  entry.attempts++;
  _updateUI(entry, "connecting", { attempt: entry.attempts, max: CAMERA_MAX_RETRY });
  pushLog(`K2 WebRTCカメラ接続試行 (${entry.attempts}/${CAMERA_MAX_RETRY})`, "info", false, entry.hostname);
  _stopK2WebRtcPipeline(entry);

  const pc = new globalThis.RTCPeerConnection({ iceServers: [] });
  const video = _ensureK2WebRtcVideo(entry);
  entry.webrtcPeerConnection = pc;
  entry.streamTarget = `${host}:${entry.cameraPort || DEFAULT_K2_WEBRTC_PORT}:webrtc`;
  _stopDuplicateTargetStreams(entry, entry.streamTarget);
  entry.img?.classList.add("off");

  pc.addEventListener("track", (event) => {
    if (!_canUseEntry(entry, gen)) return;
    const stream = event.streams && event.streams[0] ? event.streams[0] : new globalThis.MediaStream([event.track]);
    video.srcObject = stream;
  });

  (async () => {
    try {
      pc.addTransceiver("video", { direction: "sendrecv" });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await _waitForK2IceGatheringComplete(pc);
      if (!_canUseEntry(entry, gen)) return;

      const response = await fetch(entry.streamUrl, {
        method: "POST",
        headers: { "Content-Type": "plain/text" },
        body: _encodeK2WebRtcOffer(pc.localDescription || offer),
      });
      const responseText = await response.text();
      if (!response.ok) throw new Error(`K2 WebRTC signalling HTTP ${response.status}`);
      const answer = _decodeK2WebRtcAnswer(responseText);
      await pc.setRemoteDescription(answer);
      await _waitForK2WebRtcConnection(pc, K2_WEBRTC_CONNECTION_TIMEOUT_MS);
      await video.play().catch(() => {});
      await _waitForK2VideoFrame(video, K2_WEBRTC_FRAME_TIMEOUT_MS);
      if (!_canUseEntry(entry, gen)) return;

      entry.firstConnected = true;
      entry.attempts = 0;
      entry._activeStreamUrl = entry.streamUrl;
      _updateUI(entry, "connected");
      pushLog("K2 WebRTCカメラ接続成功", "success", false, entry.hostname);
      notificationManager.notify("cameraConnected", { hostname: entry.hostname });
    } catch (error) {
      if (!_canUseEntry(entry, gen)) return;
      _stopK2WebRtcPipeline(entry);
      _updateUI(entry, "unsupported", { reason: error.message, url: entry.streamUrl });
      pushLog(`K2 WebRTCカメラ接続失敗: ${error.message}`, "error", false, entry.hostname);
      notificationManager.notify("cameraConnectionFailed", { hostname: entry.hostname });
    }
  })();
}

/**
 * ストリーム配信サービスが停止しているか判定する。
 *
 * @private
 * @param {string} host - IPアドレス
 * @returns {Promise<boolean>}
 */
async function _isServiceDown(entry, host, port) {
  port = port || monitorData.appSettings.cameraPort || DEFAULT_STREAM_PORT;
  _abortServiceProbe(entry);
  const controller = new AbortController();
  entry.serviceProbeAbortController = controller;
  const timeoutId = setTimeout(() => controller.abort(), CAMERA_SERVICE_PROBE_TIMEOUT_MS);
  try {
    await fetch(`http://${host}:${port}/`, {
      method: "GET",
      mode: "no-cors",
      signal: controller.signal
    });
    return false;
  } catch {
    return true;
  } finally {
    clearTimeout(timeoutId);
    if (entry.serviceProbeAbortController === controller) {
      entry.serviceProbeAbortController = null;
    }
  }
}

/**
 * <img> の src を設定してストリームを開始する。
 * onload/onerror でリトライを制御する。
 *
 * @private
 * @param {CameraPanelEntry} entry
 * @param {string} host - IPアドレス（ポートなし）
 * @returns {void}
 */
function _connectStream(entry, host, gen = entry._generation) {
  if (!_canUseEntry(entry, gen)) return;

  /* リトライ上限チェック */
  if (entry.attempts >= CAMERA_MAX_RETRY) {
    entry.userStopped = true;
    _cancelTimers(entry);
    _updateUI(entry, "disconnected");
    pushLog(`カメラ自動リトライ上限(${CAMERA_MAX_RETRY})に達しました`, "error", false, entry.hostname);
    notificationManager.notify("cameraConnectionFailed", { hostname: entry.hostname });
    return;
  }

  entry.attempts++;
  _updateUI(entry, "connecting", {
    attempt: entry.attempts,
    max: CAMERA_MAX_RETRY
  });
  pushLog(`カメラストリーム接続試行 (${entry.attempts}/${CAMERA_MAX_RETRY})`, "info", false, entry.hostname);

  const delayMs = DEFAULT_RETRY_DELAY * Math.pow(2, entry.attempts - 1);
  const waitSec = Math.ceil(delayMs / 1000);
  const port = entry.cameraPort || monitorData.appSettings.cameraPort || DEFAULT_STREAM_PORT;
  // Moonraker は解決済み絶対URL(entry.streamUrl)を優先。K1 はポート方式の固定URL。
  const url = entry.streamUrl || `http://${host}:${port}/?action=stream`;

  _cancelTimers(entry);

  /* ★ このコールバックが有効な世代を記憶（stale 検出用） */
  const img = entry.img;
  if (!img) return;

  /* 読み込み成功 */
  img.onload = () => {
    _clearWatchdog(entry);
    if (!_canUseEntry(entry, gen, img)) return;  // stale (re-register/start中)

    _cancelTimers(entry);

    if (!entry.firstConnected) {
      entry.attempts = 0;
      entry.firstConnected = true;
      entry._activeStreamUrl = url;   // ★ 冪等化用: 現在配信中のURLを記録
      _updateUI(entry, "connected");
      pushLog("カメラ接続成功", "success", false, entry.hostname);
      notificationManager.notify("cameraConnected", { hostname: entry.hostname });
    } else if (entry.attempts > 0) {
      entry.attempts = 0;
      _updateUI(entry, "connected");
      pushLog("カメラ再接続成功", "info", false, entry.hostname);
    }
  };

  /* 読み込みエラー */
  img.onerror = async () => {
    _clearWatchdog(entry);
    if (!_canUseEntry(entry, gen, img)) return;  // stale (再入 or unregister 済み)

    /* ★ 再入ガード: 自分の generation をインクリメントして
        suspend 中に発火する2回目以降の onerror を stale 化 */
    entry._generation++;
    const myGen = entry._generation;

    /* サービス停止チェック */
    if (!entry.serviceNotified && await _isServiceDown(entry, host, port)) {
      if (!_canUseEntry(entry, myGen, img)) return;  // await 中に外部変更 → stale
      entry.serviceNotified = true;
      _cancelTimers(entry);
      _updateUI(entry, "disconnected");
      pushLog("機器側の動画配信サービスが異常停止しています", "error", false, entry.hostname);
      notificationManager.notify("cameraServiceStopped", { hostname: entry.hostname });
      return;
    }

    if (!_canUseEntry(entry, myGen, img)) return;  // await 後の stale チェック

    /* リトライをスケジュール */
    _scheduleRetry(entry, host, delayMs, waitSec, myGen);
  };

  /* ★ 多重動画接続防止 (fix/camera-dedup):
     同一物理カメラ(ip:port)へ既にストリーム中の別ホストを停止し、1機器=1 MJPEG に収束させる。
     IP再利用/ホスト名変更で connectionMap キーが二重化しても重複接続を防ぐ。 */
  entry.streamTarget = `${host}:${port}`;
  _stopDuplicateTargetStreams(entry, entry.streamTarget);

  /* ストリーム開始 */
  img.setAttribute("src", url);
  img.classList.remove("off");

  /* ★ watchdog: onload/onerror が CAMERA_WATCHDOG_MS 以内に来なければ強制的に失敗扱い
      MJPEG ストリームでサーバが TCP 接続を受け入れたが正常にデータを返さない場合、
      onload/onerror がどちらも発火せず、ブラウザが CPU 100% で固まる問題への対策 */
  entry.watchdogTimer = setTimeout(() => {
    entry.watchdogTimer = null;
    if (!_canUseEntry(entry, gen, img)) return;  // stale

    // ハンドラを null にしてから src 属性を除去し、img自体を差し替えて接続を強制終了する。
    // 停止時の spurious onerror が onerror ロジックを再実行しないようにする。
    _releaseImagePipeline(entry, { replace: true });
    pushLog(
      `カメラ watchdog タイムアウト (${CAMERA_WATCHDOG_MS}ms) — サーバ応答なし`,
      "warn", false, entry.hostname
    );
    // 旧 generation のハンドラを stale 化してからリトライ
    entry._generation++;
    _scheduleRetry(entry, host, delayMs, waitSec, entry._generation);
  }, CAMERA_WATCHDOG_MS);
}

/**
 * リレー子モードの snapshot ポーリング接続。
 * 親(5313)の `/relay-camera/{host}/snapshot.jpg` を1枚ずつ取得し、
 * onload 後に RELAY_CAMERA_INTERVAL_MS 間隔で次フレームへ差し替える（≈0.4FPS）。
 * 連続 MJPEG ではないため CPU/帯域負荷を抑えられる。
 *
 * generation / userStopped / リトライ(CAMERA_MAX_RETRY) / watchdog は
 * 直結版（_connectStream）と同じ枠組みを踏襲する。
 *
 * @private
 * @param {CameraPanelEntry} entry
 * @param {string} host - プリンタホスト名（親 _cameraEndpoints のキーと一致）
 * @returns {void}
 */
function _connectStreamRelay(entry, host, gen = entry._generation) {
  if (!_canUseEntry(entry, gen)) return;

  /* リトライ上限チェック（直結版と同一仕様） */
  if (entry.attempts >= CAMERA_MAX_RETRY) {
    entry.userStopped = true;
    _cancelTimers(entry);
    _updateUI(entry, "disconnected");
    pushLog(`カメラ自動リトライ上限(${CAMERA_MAX_RETRY})に達しました`, "error", false, entry.hostname);
    notificationManager.notify("cameraConnectionFailed", { hostname: entry.hostname });
    return;
  }

  entry.attempts++;
  if (!entry.firstConnected) {
    _updateUI(entry, "connecting", { attempt: entry.attempts, max: CAMERA_MAX_RETRY });
    pushLog(`カメラ(リレー)接続試行 (${entry.attempts}/${CAMERA_MAX_RETRY})`, "info", false, entry.hostname);
  }

  const delayMs = DEFAULT_RETRY_DELAY * Math.pow(2, entry.attempts - 1);
  const waitSec = Math.ceil(delayMs / 1000);
  const url = `/relay-camera/${encodeURIComponent(host)}/snapshot.jpg`;

  _cancelTimers(entry);

  /* このコールバック群が有効な世代を記憶（stale 検出用） */
  /** 1フレーム分の取得を開始する（watchdog を都度張り直す） */
  const loadOne = () => {
    const img = entry.img;
    if (!_canUseEntry(entry, gen, img)) return;

    img.onload = () => {
      _clearWatchdog(entry);
      if (!_canUseEntry(entry, gen, img)) return;

      /* 接続成功（初回 / 再接続）を一度だけ通知し attempts をリセット */
      if (!entry.firstConnected) {
        entry.firstConnected = true;
        entry.attempts = 0;
        _updateUI(entry, "connected");
        pushLog("カメラ接続成功(リレー)", "success", false, entry.hostname);
        notificationManager.notify("cameraConnected", { hostname: entry.hostname });
      } else if (entry.attempts > 0) {
        entry.attempts = 0;
        _updateUI(entry, "connected");
        pushLog("カメラ再接続成功(リレー)", "info", false, entry.hostname);
      }

      /* 次フレームを間隔をあけてスケジュール（連続MJPEGではなく1枚ずつ更新） */
      entry.pollTimeout = setTimeout(() => {
        entry.pollTimeout = null;
        loadOne();
      }, _relayCameraIntervalMs());
    };

    img.onerror = () => {
      _clearWatchdog(entry);
      if (!_canUseEntry(entry, gen, img)) return;
      /* 旧ハンドラを stale 化してからリトライ（再入ガード） */
      entry._generation++;
      _scheduleRelayRetry(entry, host, delayMs, waitSec, entry._generation);
    };

    /* キャッシュ回避のためクエリにタイムスタンプを付与（親側は no-store） */
    img.setAttribute("src", url + "?t=" + Date.now());
    img.classList.remove("off");

    /* watchdog: onload/onerror がどちらも来ない場合の保険 */
    entry.watchdogTimer = setTimeout(() => {
      entry.watchdogTimer = null;
      if (!_canUseEntry(entry, gen, img)) return;
      _releaseImagePipeline(entry, { replace: true });
      pushLog(
        `カメラ(リレー) watchdog タイムアウト (${CAMERA_WATCHDOG_MS}ms) — 応答なし`,
        "warn", false, entry.hostname
      );
      entry._generation++;
      _scheduleRelayRetry(entry, host, delayMs, waitSec, entry._generation);
    }, CAMERA_WATCHDOG_MS);
  };

  loadOne();
}

/**
 * リレー子モードのリトライをスケジュールする（カウントダウン UI + setTimeout）。
 * リトライ実行時は直結版ではなく _connectStreamRelay へ再入する。
 *
 * @private
 * @param {CameraPanelEntry} entry
 * @param {string} host
 * @param {number} delayMs
 * @param {number} waitSec
 */
function _scheduleRelayRetry(entry, host, delayMs, waitSec, gen = entry._generation) {
  if (!_canUseEntry(entry, gen)) return;

  _updateUI(entry, "retrying", {
    attempt: entry.attempts + 1,
    max: CAMERA_MAX_RETRY,
    wait: waitSec
  });
  pushLog(`カメラ(リレー)切断検知 (${entry.attempts}/${CAMERA_MAX_RETRY})`, "warn", false, entry.hostname);

  /* カウントダウン表示（直結版と同一） */
  let remaining = waitSec;
  entry.countdownTimer = setInterval(() => {
    remaining--;
    if (remaining > 0) {
      _updateUI(entry, "retrying", {
        attempt: entry.attempts + 1,
        max: CAMERA_MAX_RETRY,
        wait: remaining
      });
    } else {
      clearInterval(entry.countdownTimer);
      entry.countdownTimer = null;
    }
  }, 1000);

  /* リトライ実行 → リレー版に再入 */
  entry.retryTimeout = setTimeout(() => {
    entry.retryTimeout = null;
    if (!_canUseEntry(entry, gen)) return;
    _releaseImagePipeline(entry, { replace: true });
    _connectStreamRelay(entry, host, gen);
  }, delayMs);
}

/**
 * リトライをスケジュールする（カウントダウン UI + setTimeout）。
 * onerror と watchdog の両経路から共通利用。
 *
 * @private
 * @param {CameraPanelEntry} entry
 * @param {string} host
 * @param {number} delayMs
 * @param {number} waitSec
 */
function _scheduleRetry(entry, host, delayMs, waitSec, gen = entry._generation) {
  if (!_canUseEntry(entry, gen)) return;

  _updateUI(entry, "retrying", {
    attempt: entry.attempts + 1,
    max: CAMERA_MAX_RETRY,
    wait: waitSec
  });
  pushLog(`カメラ切断検知 (${entry.attempts}/${CAMERA_MAX_RETRY})`, "warn", false, entry.hostname);

  /* カウントダウン表示 */
  let remaining = waitSec;
  entry.countdownTimer = setInterval(() => {
    remaining--;
    if (remaining > 0) {
      _updateUI(entry, "retrying", {
        attempt: entry.attempts + 1,
        max: CAMERA_MAX_RETRY,
        wait: remaining
      });
    } else {
      clearInterval(entry.countdownTimer);
      entry.countdownTimer = null;
    }
  }, 1000);

  /* リトライ実行 */
  entry.retryTimeout = setTimeout(() => {
    entry.retryTimeout = null;
    if (!_canUseEntry(entry, gen)) return;
    _releaseImagePipeline(entry, { replace: true });
    _connectStream(entry, host, gen);
  }, delayMs);
}

/**
 * ユーザーON要求を合流する debounce タイマーだけを解除する。
 *
 * @private
 * @param {CameraPanelEntry} entry - カメラ状態
 * @returns {void}
 */
function _cancelUserRestartTimer(entry) {
  if (entry?.userRestartTimer != null) {
    clearTimeout(entry.userRestartTimer);
    entry.userRestartTimer = null;
  }
}

/**
 * カメラサービス疎通確認 fetch を中断する。
 *
 * @private
 * @param {CameraPanelEntry} entry - カメラ状態
 * @returns {void}
 */
function _abortServiceProbe(entry) {
  if (entry?.serviceProbeAbortController) {
    try { entry.serviceProbeAbortController.abort(); } catch { /* noop */ }
    entry.serviceProbeAbortController = null;
  }
}

/**
 * MJPEGを受けていたHTMLImageElementのパイプラインを解放し、必要なら新品imgへ差し替える。
 *
 * 【詳細説明】
 * - Chromium内部に残り得るMJPEG decode/Raster/Compositor資源を切るため、停止時は同じimgを再利用しない。
 * - cloneNode(false)によりid/class/alt/data属性を維持し、entry.imgは必ず新要素またはnullへ更新する。
 *
 * @private
 * @param {CameraPanelEntry} entry - カメラ状態
 * @param {{replace?: boolean}} [options={}] - DOM上のimgを新品へ置換するかどうか
 * @returns {HTMLImageElement|null} 置換後のimg、または完全解放時はnull
 */
function _releaseImagePipeline(entry, { replace = true } = {}) {
  const oldImg = entry?.img;
  if (!oldImg) return null;

  oldImg.onload = null;
  oldImg.onerror = null;
  oldImg.removeAttribute("src");
  oldImg.classList.add("off");

  if (replace && oldImg.isConnected && oldImg.parentNode) {
    const newImg = oldImg.cloneNode(false);
    newImg.onload = null;
    newImg.onerror = null;
    newImg.removeAttribute("src");
    newImg.classList.add("off");
    oldImg.replaceWith(newImg);
    entry.img = newImg;
    return newImg;
  }

  entry.img = null;
  return null;
}

/**
 * 非同期callbackが現在も有効なカメラentryへ属しているか検査する。
 *
 * @private
 * @param {CameraPanelEntry} entry - カメラ状態
 * @param {number} gen - callbackが捕捉した世代
 * @param {HTMLImageElement|null} [img=null] - callbackが捕捉したimg
 * @returns {boolean} 接続処理を継続できる場合はtrue
 */
function _canUseEntry(entry, gen, img = null) {
  if (!entry) return false;
  if (cameraRegistry.get(entry.hostname) !== entry) return false;
  if (entry._generation !== gen) return false;
  if (entry.desiredEnabled !== true) return false;
  if (entry.userStopped === true) return false;
  if (img && entry.img !== img) return false;
  if (entry.body && entry.body.isConnected === false) return false;
  return true;
}

/**
 * パネル内の UI 要素を状態に応じて更新する。
 * パネルの body 内を querySelector で検索するため、IDスコーピングに依存しない。
 *
 * @private
 * @param {CameraPanelEntry} entry
 * @param {"disconnected"|"connecting"|"retrying"|"connected"|"unsupported"} state
 * @param {{attempt?:number, max?:number, wait?:number, reason?:string, url?:string}} [opt={}]
 * @returns {void}
 */
function _updateUI(entry, state, opt = {}) {
  const { body, img } = entry;
  if (!body) return;

  /* パネル内の UI 要素を body 起点で検索（IDスコーピング非依存） */
  const noSignal     = body.querySelector(".no-signal");
  const noSignalMain = noSignal?.querySelector(".no-signal-main");
  const statusBox    = body.querySelector(".camera-status");
  const labelEl      = statusBox?.querySelector("[id$='camera-status-label']")
                    || statusBox?.querySelector(".camera-status-label");
  const subEl        = statusBox?.querySelector("[id$='camera-status-sub']")
                    || statusBox?.querySelector(".camera-status-sub");
  const spinner      = statusBox?.querySelector("[id$='camera-spinner']")
                    || statusBox?.querySelector(".spinner");
  const cancelBtn    = body.querySelector(".camera-cancel-btn")
                    || body.querySelector("[id$='camera-cancel-button']");

  const show = el => el?.classList.remove("hidden");
  const hide = el => el?.classList.add("hidden");

  switch (state) {
    case "disconnected":
      if (noSignalMain) noSignalMain.textContent = "- NO SIGNAL -";
      if (labelEl) labelEl.textContent = "";
      if (subEl) subEl.textContent = "";
      img?.classList.add("off");
      statusBox?.classList.add("hidden");
      show(noSignal);
      hide(spinner);
      show(cancelBtn);
      break;

    case "connecting":
      if (noSignalMain) noSignalMain.textContent = "... CONNECTING ...";
      if (labelEl) labelEl.textContent = "接続中...";
      if (subEl) subEl.textContent = `(${opt.attempt || 0}/${opt.max || CAMERA_MAX_RETRY})`;
      img?.classList.add("off");
      statusBox?.classList.remove("hidden");
      show(noSignal);
      show(spinner);
      show(cancelBtn);
      break;

    case "retrying":
      if (noSignalMain) noSignalMain.textContent = "- SIGNAL LOST -";
      if (labelEl) labelEl.textContent = "再接続待機";
      if (subEl) subEl.textContent = `再試行まで ${opt.wait || 0} 秒`;
      img?.classList.add("off");
      statusBox?.classList.remove("hidden");
      show(noSignal);
      show(spinner);
      show(cancelBtn);
      break;

    case "connected":
      if (noSignalMain) noSignalMain.textContent = "- NO SIGNAL -";
      if (labelEl) labelEl.textContent = "";
      if (subEl) subEl.textContent = "";
      img?.classList.remove("off");
      statusBox?.classList.add("hidden");
      hide(noSignal);
      hide(spinner);
      hide(cancelBtn);
      break;

    case "unsupported":
      if (noSignalMain) noSignalMain.textContent = "K2 CAMERA";
      if (labelEl) labelEl.textContent = "WebRTCカメラ未対応";
      if (subEl) subEl.textContent = opt.url
        ? `カメラサービス: ${opt.url}`
        : "現在のカメラパネルはMJPEG表示のみ対応です";
      img?.classList.add("off");
      statusBox?.classList.remove("hidden");
      show(noSignal);
      hide(spinner);
      show(cancelBtn);
      break;
  }

  /* トグルスイッチの状態をカメラ設定に同期 */
  if (entry.toggle) {
    entry.toggle.checked = !!(monitorData.hostCameraToggle[entry.hostname] ?? monitorData.appSettings.cameraToggle);
  }
}
