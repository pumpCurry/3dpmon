/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 プロトコル記録モジュール
 * @file dashboard_protocol_recorder.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_protocol_recorder
 *
 * 【機能内容サマリ】
 * - 実機通信の inbound / outbound / transport / marker イベントを順序付きで記録
 * - IP、MAC、serial、認証情報などを決定的トークンへ置換
 * - Fixture 化しやすい JSON / NDJSON 形式でエクスポート
 *
 * 【公開関数一覧】
 * - {@link ProtocolRecorder}：通信キャプチャセッションを管理
 * - {@link createProtocolRecorder}：既定設定で ProtocolRecorder を作成
 * - {@link redactProtocolValue}：任意値を recorder と同じ規則で秘匿化
 * - {@link toFixtureNdjson}：fixture イベント配列を NDJSON 文字列へ変換
 *
 * @version 1.390.1293 (PR #432)
 * @since   1.390.1290 (PR #432)
 * @lastModified 2026-08-07 02:48:00
 * -----------------------------------------------------------
 * @todo
 * - Gate 0 実機キャプチャ UI との接続
 */

"use strict";

/**
 * Protocol Recorder が出力する fixture バージョン。
 *
 * 【詳細説明】
 * - Gate 0 の初期 fixture schema として固定する。
 * - 破壊的な形式変更を行う場合は、この値を増やして旧 fixture replay を維持する。
 *
 * @constant {number}
 */
export const PROTOCOL_FIXTURE_VERSION = 1;

/**
 * Recorder の既定 redaction 設定。
 *
 * 【詳細説明】
 * - 実機キャプチャをそのまま CI fixture にできるよう、個人環境へ紐付く情報を標準で秘匿する。
 *
 * @constant {Object}
 */
export const DEFAULT_REDACTION_OPTIONS = Object.freeze({
  ip: true,
  mac: true,
  serial: true,
  credential: true,
  ssid: true,
  hostname: true,
  id: true,
  fileName: true,
  rfid: true,
});

/**
 * IPv4 アドレスの検出正規表現。
 *
 * 【詳細説明】
 * - JSON 文字列内や URL 文字列内の IPv4 を置換するために利用する。
 *
 * @constant {RegExp}
 */
const IPV4_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

/**
 * IPv6 アドレスの検出正規表現。
 *
 * 【詳細説明】
 * - 完全表記と省略表記の代表的な形を fixture から除去する。
 * - ポート番号や時刻表記との誤検出を避けるため、2個以上のコロンを含む token だけを対象にする。
 *
 * @constant {RegExp}
 */
const IPV6_PATTERN = /\b(?=(?:[0-9a-f]{0,4}:){2,}[0-9a-f]{0,4}\b)(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/gi;

/**
 * MAC アドレスの検出正規表現。
 *
 * 【詳細説明】
 * - コロン区切り、ハイフン区切り、区切りなし 12 桁 HEX を秘匿対象にする。
 *
 * @constant {RegExp}
 */
const MAC_PATTERN = /\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b|\b[0-9a-f]{2}(?:-[0-9a-f]{2}){5}\b|\b[0-9a-f]{12}\b/gi;

/**
 * MAC 系キーを判定する正規表現。
 *
 * 【詳細説明】
 * - Creality の /info では区切りなし 12 桁 HEX が `mac` として返ることがある。
 *
 * @constant {RegExp}
 */
const MAC_KEY_PATTERN = /(?:^mac$|macAddress|wifiMac|ethernetMac)/i;

/**
 * secret 系キーを判定する正規表現。
 *
 * 【詳細説明】
 * - 値の形に関係なく、キー名だけで秘匿する必要がある項目をまとめる。
 *
 * @constant {RegExp}
 */
const CREDENTIAL_KEY_PATTERN = /(?:password|passwd|passphrase|token|secret|api[_-]?key|authorization|cookie|credential)/i;

/**
 * SSID 系キーを判定する正規表現。
 *
 * 【詳細説明】
 * - Wi-Fi 環境名は個人環境情報なので、明示キーでは値全体を秘匿する。
 *
 * @constant {RegExp}
 */
const SSID_KEY_PATTERN = /(?:ssid|wifiName|wiFiName|wirelessName)/i;

/**
 * serial 系キーを判定する正規表現。
 *
 * 【詳細説明】
 * - 実機個体番号は公開 fixture に含めない。
 *
 * @constant {RegExp}
 */
const SERIAL_KEY_PATTERN = /(?:serial|serialNumber|sn|machineId|deviceSerial)/i;

/**
 * IP 系キーを判定する正規表現。
 *
 * 【詳細説明】
 * - address や host は文字列中の IP のみを置換する。
 *
 * @constant {RegExp}
 */
const IP_KEY_PATTERN = /(?:ip|address|addr|host|hostname|url|endpoint)/i;

/**
 * hostname 系キーを判定する正規表現。
 *
 * 【詳細説明】
 * - WebSocket hostname や `/info` の device name は個人環境の命名規則を含むため値全体を秘匿する。
 *
 * @constant {RegExp}
 */
const HOSTNAME_KEY_PATTERN = /(?:^hostname$|reportedHostname|deviceName|printerName)/i;

/**
 * 印刷ジョブや機体固有 ID 系キーを判定する正規表現。
 *
 * 【詳細説明】
 * - 数値だけの printId / jobId / token も string に変換して秘匿する。
 *
 * @constant {RegExp}
 */
const UNIQUE_ID_KEY_PATTERN = /(?:^printId$|^jobId$|^taskId$|^deviceId$|^machineId$|^uid$|^uuid$)/i;

/**
 * RFID 系キーを判定する正規表現。
 *
 * 【詳細説明】
 * - CFS spool や材料タグの固有値を fixture へ残さないために利用する。
 *
 * @constant {RegExp}
 */
const RFID_KEY_PATTERN = /(?:rfid|rfidUid|rfidTag|tagUid)/i;

/**
 * 文字列内の G-code ファイル名を検出する正規表現。
 *
 * 【詳細説明】
 * - URL や path 文字列内に埋め込まれたファイル名だけを token 化する。
 *
 * @constant {RegExp}
 */
const GCODE_FILE_PATTERN = /[^/\\:"<>|?*\r\n]+\.g(?:code|co|code3mf)\b/gi;

/**
 * redaction token の種別別カウンタを初期化する。
 *
 * 【詳細説明】
 * - 同一キャプチャ内で同じ値を同じ token にするため、値ごとの Map と連番を保持する。
 *
 * @private
 * @returns {{maps: Object<string, Map<string, string>>, counts: Object<string, number>}} - redaction 状態
 */
function createRedactionState() {
  return {
    maps: {
      ip: new Map(),
      mac: new Map(),
      serial: new Map(),
      credential: new Map(),
      ssid: new Map(),
      hostname: new Map(),
      id: new Map(),
      file: new Map(),
      rfid: new Map(),
    },
    counts: {
      ip: 0,
      mac: 0,
      serial: 0,
      credential: 0,
      ssid: 0,
      hostname: 0,
      id: 0,
      file: 0,
      rfid: 0,
    },
  };
}

/**
 * 値を決定的な redaction token へ変換する。
 *
 * 【詳細説明】
 * - 同じ実値は同じ token へ変換し、fixture 内の対応関係だけは追えるようにする。
 *
 * @private
 * @param {Object} state - redaction 状態
 * @param {string} kind - token 種別
 * @param {string} rawValue - 秘匿する元値
 * @returns {string} redaction token
 */
function tokenFor(state, kind, rawValue) {
  const value = String(rawValue);
  const map = state.maps[kind];
  if (map.has(value)) {
    return map.get(value);
  }
  state.counts[kind] += 1;
  const token = `<${kind.toUpperCase()}_${String(state.counts[kind]).padStart(3, "0")}>`;
  map.set(value, token);
  return token;
}

/**
 * key 名に応じて非文字列の固有値も token 化する。
 *
 * 【詳細説明】
 * - printId や RFID は数値で届くことがあるため、文字列処理に入る前に秘匿対象を判定する。
 * - JSON 構造そのものは保ち、値だけを決定的 token へ置換する。
 *
 * @private
 * @param {*} value - 入力値
 * @param {Object} options - redaction オプション
 * @param {Object} state - redaction 状態
 * @param {string} keyName - 親オブジェクトのキー名
 * @returns {*} token 化した値、または元値
 */
function redactScalarByKey(value, options, state, keyName) {
  if (options.credential && CREDENTIAL_KEY_PATTERN.test(keyName)) {
    return tokenFor(state, "credential", value);
  }
  if (options.ssid && SSID_KEY_PATTERN.test(keyName)) {
    return tokenFor(state, "ssid", value);
  }
  if (options.serial && SERIAL_KEY_PATTERN.test(keyName)) {
    return tokenFor(state, "serial", value);
  }
  if (options.mac && MAC_KEY_PATTERN.test(keyName)) {
    return tokenFor(state, "mac", String(value).toLowerCase());
  }
  if (options.hostname && HOSTNAME_KEY_PATTERN.test(keyName)) {
    return tokenFor(state, "hostname", value);
  }
  if (options.rfid && RFID_KEY_PATTERN.test(keyName)) {
    return tokenFor(state, "rfid", value);
  }
  if (options.id && UNIQUE_ID_KEY_PATTERN.test(keyName)) {
    return tokenFor(state, "id", value);
  }
  return value;
}

/**
 * ファイル名またはパス内の G-code 名を token 化する。
 *
 * 【詳細説明】
 * - directory や URL の構造は fixture replay の助けになるため残す。
 * - 拡張子は互換性確認に必要な情報なので token の後ろに保持する。
 *
 * @private
 * @param {string} value - 入力文字列
 * @param {Object} state - redaction 状態
 * @returns {string} ファイル名を秘匿した文字列
 */
function redactGcodeFileNames(value, state) {
  return String(value).replace(GCODE_FILE_PATTERN, (match) => {
    const extensionMatch = match.match(/(\.g(?:code|co|code3mf))$/i);
    const extension = extensionMatch ? extensionMatch[1].toLowerCase() : "";
    return `${tokenFor(state, "file", match)}${extension}`;
  });
}

/**
 * JSON 互換値を深く複製する。
 *
 * 【詳細説明】
 * - structuredClone がないブラウザやテスト環境でも動くよう、JSON 経由にフォールバックする。
 * - プロトコル payload は fixture 化可能な JSON 値である前提とする。
 *
 * @private
 * @param {*} value - 複製対象
 * @returns {*} 複製値
 */
function cloneJsonValue(value) {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * 指定値を Protocol Recorder の規則で秘匿化する。
 *
 * 【詳細説明】
 * - オブジェクトと配列は再帰的に走査する。
 * - キー名が secret / serial / ssid / hostname / RFID / ID を示す場合は値全体を秘匿する。
 * - 文字列中の IPv4 / IPv6 / MAC / G-code ファイル名は、キー名に依存せず検出して置換する。
 *
 * @function redactProtocolValue
 * @param {*} value - 秘匿化対象の JSON 互換値
 * @param {Object=} options - redaction の有効・無効設定
 * @param {Object=} state - 同一 fixture 内で token を安定させる redaction 状態
 * @param {string=} keyName - 親オブジェクトのキー名
 * @returns {*} 秘匿化済みの値
 * @example
 * const redacted = redactProtocolValue({ ip: "192.168.54.151" });
 */
export function redactProtocolValue(value, options = DEFAULT_REDACTION_OPTIONS, state = createRedactionState(), keyName = "") {
  if (Array.isArray(value)) {
    return value.map((entry) => redactProtocolValue(entry, options, state, keyName));
  }

  if (value && typeof value === "object") {
    const redacted = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      redacted[childKey] = redactProtocolValue(childValue, options, state, childKey);
    }
    return redacted;
  }

  const keyedScalar = redactScalarByKey(value, options, state, keyName);
  if (keyedScalar !== value) {
    return keyedScalar;
  }

  if (typeof value !== "string") {
    return value;
  }

  let result = value;
  if (options.mac) {
    result = result.replace(MAC_PATTERN, (match) => tokenFor(state, "mac", match.toLowerCase()));
  }
  if (options.ip || IP_KEY_PATTERN.test(keyName)) {
    result = result.replace(IPV4_PATTERN, (match) => tokenFor(state, "ip", match));
    result = result.replace(IPV6_PATTERN, (match) => tokenFor(state, "ip", match));
  }
  if (options.fileName) {
    result = redactGcodeFileNames(result, state);
  }
  return result;
}

/**
 * fixture event 配列を NDJSON 文字列に変換する。
 *
 * 【詳細説明】
 * - 1行1イベントにすることで、通信順序の diff と replay を容易にする。
 * - 末尾改行を付け、Git 上で通常のテキストファイルとして扱いやすくする。
 *
 * @function toFixtureNdjson
 * @param {Array<Object>} events - fixture event 配列
 * @returns {string} NDJSON 文字列
 * @example
 * const ndjson = toFixtureNdjson(fixture.events);
 */
export function toFixtureNdjson(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return "";
  }
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

/**
 * Capture ID を生成する。
 *
 * 【詳細説明】
 * - crypto.randomUUID が使える環境では UUID を使い、ない環境では時刻と乱数で衝突を避ける。
 *
 * @private
 * @returns {string} Capture ID
 */
function defaultIdFactory() {
  try {
    if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function") {
      return `capture_${globalThis.crypto.randomUUID()}`;
    }
  } catch {
    // crypto が存在してもアクセスできない環境では下のフォールバックへ進む。
  }
  return `capture_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * metadata の既定値を補完する。
 *
 * 【詳細説明】
 * - 実機名やファームウェアが未確定でも fixture として最低限の形を保つ。
 *
 * @private
 * @param {Object} metadata - ユーザー指定 metadata
 * @param {number} startedAt - キャプチャ開始時刻
 * @returns {Object} 正規化 metadata
 */
function normalizeMetadata(metadata, startedAt) {
  const source = metadata && typeof metadata === "object" ? metadata : {};
  return {
    fixtureVersion: PROTOCOL_FIXTURE_VERSION,
    device: {
      model: source.device?.model || "unknown",
      reportedModel: source.device?.reportedModel || null,
      reportedHostname: source.device?.reportedHostname || null,
      firmwareVersion: source.device?.firmwareVersion || "unknown",
      cfsFirmwareVersion: source.device?.cfsFirmwareVersion || null,
      attachment: source.device?.attachment || "unknown",
    },
    capture: {
      capturedAt: source.capture?.capturedAt || new Date(startedAt).toISOString(),
      scenario: source.capture?.scenario || "unspecified",
      operatorNotes: source.capture?.operatorNotes || "",
    },
    endpoints: Array.isArray(source.endpoints) ? source.endpoints : [],
    redaction: {
      ip: true,
      mac: true,
      serial: true,
      credential: true,
      ssid: true,
      hostname: true,
      id: true,
      fileName: true,
      rfid: true,
      ...(source.redaction || {}),
    },
  };
}

/**
 * plain object を再帰的に merge する。
 *
 * 【詳細説明】
 * - Protocol Recorder metadata の追記だけに使うため、配列は置換する。
 *
 * @private
 * @param {object} target - merge 先
 * @param {object} patch - merge 元
 * @returns {object} merge 後の target
 */
function mergePlainObject(target, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) {
        target[key] = {};
      }
      mergePlainObject(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

/**
 * Printer Core v3 のプロトコル記録クラス。
 *
 * 【詳細説明】
 * - inbound / outbound / transport / marker を同じ時系列に積む。
 * - payload の意味解釈は Adapter / Codec の責務なので、本クラスは raw payload を保持する。
 * - export 時に redaction を行うため、テストでは未秘匿内部値と秘匿済み fixture の両方を検証できる。
 *
 * @class ProtocolRecorder
 */
export class ProtocolRecorder {
  /**
   * ProtocolRecorder を初期化する。
   *
   * 【詳細説明】
   * - clock を注入できるため、fixture export と単体テストを決定的にできる。
   *
   * @param {Object=} options - Recorder オプション
   * @param {Function=} options.clock - epoch ms を返す時計関数
   * @param {Function=} options.idFactory - captureId を返す関数
   * @param {Object=} options.redactionOptions - redaction 設定
   */
  constructor(options = {}) {
    this.clock = typeof options.clock === "function" ? options.clock : Date.now;
    this.idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;
    this.redactionOptions = {
      ...DEFAULT_REDACTION_OPTIONS,
      ...(options.redactionOptions || {}),
    };
    this.session = null;
  }

  /**
   * キャプチャセッションを開始する。
   *
   * 【詳細説明】
   * - 既に開始済みの場合は二重開始を防ぐため例外にする。
   *
   * @function startSession
   * @param {Object=} metadata - fixture metadata
   * @returns {Object} 開始したセッション概要
   * @throws {Error} 既に開始済みの場合
   * @example
   * recorder.startSession({ device: { model: "K2 Pro Combo" } });
   */
  startSession(metadata = {}) {
    if (this.session) {
      throw new Error("ProtocolRecorder session is already active");
    }

    const startedAt = this.clock();
    this.session = {
      captureId: this.idFactory(),
      startedAt,
      stoppedAt: null,
      sequence: 0,
      metadata: normalizeMetadata(metadata, startedAt),
      events: [],
    };
    return {
      captureId: this.session.captureId,
      startedAt: this.session.startedAt,
      metadata: cloneJsonValue(this.session.metadata),
    };
  }

  /**
   * outbound frame を記録する。
   *
   * 【詳細説明】
   * - UI や command dispatcher から送信した request frame の記録に使う。
   *
   * @function recordOutbound
   * @param {string} channel - 通信チャネル名
   * @param {*} payload - 送信 payload
   * @param {Object=} details - 補助情報
   * @returns {Object} 記録した event
   * @throws {Error} セッション未開始の場合
   * @example
   * recorder.recordOutbound("ws9999", { method: "get" });
   */
  recordOutbound(channel, payload, details = {}) {
    return this.recordFrame("out", channel, payload, details);
  }

  /**
   * inbound frame を記録する。
   *
   * 【詳細説明】
   * - プリンタから受信した raw frame の記録に使う。
   *
   * @function recordInbound
   * @param {string} channel - 通信チャネル名
   * @param {*} payload - 受信 payload
   * @param {Object=} details - 補助情報
   * @returns {Object} 記録した event
   * @throws {Error} セッション未開始の場合
   * @example
   * recorder.recordInbound("ws9999", { nozzleTemp: 220 });
   */
  recordInbound(channel, payload, details = {}) {
    return this.recordFrame("in", channel, payload, details);
  }

  /**
   * セッション metadata を追記する。
   *
   * 【詳細説明】
   * - /info 応答など、キャプチャ開始後に判明した reportedModel や firmwareVersion を metadata に反映する。
   *
   * @function mergeMetadata
   * @param {object} patch - metadata へ反映する差分
   * @returns {object} merge 後の metadata
   * @throws {Error} セッション未開始の場合
   * @example
   * recorder.mergeMetadata({ device: { firmwareVersion: "1.0.0" } });
   */
  mergeMetadata(patch) {
    this.ensureSession();
    mergePlainObject(this.session.metadata, patch);
    return cloneJsonValue(this.session.metadata);
  }

  /**
   * transport 層の接続・切断・エラーイベントを記録する。
   *
   * 【詳細説明】
   * - handshake や reconnect の状態を raw payload と別に残す。
   *
   * @function recordTransportEvent
   * @param {Object} event - transport event
   * @param {string} event.channel - 通信チャネル名
   * @param {string} event.type - イベント種別
   * @param {Object=} event.details - 補助情報
   * @returns {Object} 記録した event
   * @throws {Error} セッション未開始の場合
   * @example
   * recorder.recordTransportEvent({ channel: "ws9999", type: "open" });
   */
  recordTransportEvent(event) {
    const source = event && typeof event === "object" ? event : {};
    return this.appendEvent({
      direction: "event",
      channel: source.channel || "unknown",
      kind: "transport",
      type: source.type || "unknown",
      details: cloneJsonValue(source.details || {}),
    });
  }

  /**
   * オペレータ操作や実機状態の目印を記録する。
   *
   * 【詳細説明】
   * - CFS slot 変更や印刷状態など、通信ログだけでは分かりにくい境界に marker を残す。
   *
   * @function addMarker
   * @param {string} name - marker 名
   * @param {Object=} details - 補助情報
   * @returns {Object} 記録した marker event
   * @throws {Error} セッション未開始の場合
   * @example
   * recorder.addMarker("cfs-slot-loaded", { slot: 2 });
   */
  addMarker(name, details = {}) {
    return this.appendEvent({
      direction: "marker",
      channel: "operator",
      kind: "marker",
      name: String(name || "unnamed"),
      details: cloneJsonValue(details),
    });
  }

  /**
   * キャプチャセッションを終了する。
   *
   * 【詳細説明】
   * - 終了後も export は可能にする。
   *
   * @function stopSession
   * @returns {Object} 終了したセッション概要
   * @throws {Error} セッション未開始の場合
   * @example
   * recorder.stopSession();
   */
  stopSession() {
    this.ensureSession();
    const stoppedAt = this.clock();
    this.session.stoppedAt = stoppedAt;
    return {
      captureId: this.session.captureId,
      startedAt: this.session.startedAt,
      stoppedAt,
      durationMs: stoppedAt - this.session.startedAt,
      eventCount: this.session.events.length,
    };
  }

  /**
   * 現在のキャプチャを fixture JSON としてエクスポートする。
   *
   * 【詳細説明】
   * - redaction 有効時は metadata と event payload の両方を秘匿化する。
   * - events は sequence 順を維持する。
   *
   * @function exportFixture
   * @param {Object=} options - export オプション
   * @param {boolean=} options.redact - redaction を適用するか
   * @returns {Object} fixture JSON
   * @throws {Error} セッション未開始の場合
   * @example
   * const fixture = recorder.exportFixture({ redact: true });
   */
  exportFixture(options = {}) {
    this.ensureSession();
    const redact = options.redact !== false;
    const redactionState = createRedactionState();
    const metadata = cloneJsonValue(this.session.metadata);
    const events = cloneJsonValue(this.session.events);
    const fixture = {
      fixtureVersion: PROTOCOL_FIXTURE_VERSION,
      captureId: this.session.captureId,
      startedAt: this.session.startedAt,
      stoppedAt: this.session.stoppedAt,
      durationMs: (this.session.stoppedAt || this.clock()) - this.session.startedAt,
      metadata,
      events,
    };

    if (!redact) {
      return fixture;
    }

    return redactProtocolValue(fixture, this.redactionOptions, redactionState);
  }

  /**
   * 現在のキャプチャを NDJSON としてエクスポートする。
   *
   * 【詳細説明】
   * - metadata は含めず、event replay 用のイベント行だけを出力する。
   *
   * @function exportNdjson
   * @param {Object=} options - export オプション
   * @param {boolean=} options.redact - redaction を適用するか
   * @returns {string} NDJSON 文字列
   * @throws {Error} セッション未開始の場合
   * @example
   * const ndjson = recorder.exportNdjson();
   */
  exportNdjson(options = {}) {
    const fixture = this.exportFixture(options);
    return toFixtureNdjson(fixture.events);
  }

  /**
   * frame event を記録する内部処理。
   *
   * 【詳細説明】
   * - outbound/inbound で共通の event envelope を組み立てる。
   *
   * @private
   * @param {string} direction - in または out
   * @param {string} channel - 通信チャネル名
   * @param {*} payload - raw payload
   * @param {Object=} details - 補助情報
   * @returns {Object} 記録した event
   */
  recordFrame(direction, channel, payload, details = {}) {
    return this.appendEvent({
      direction,
      channel: String(channel || "unknown"),
      kind: "frame",
      payload: cloneJsonValue(payload),
      details: cloneJsonValue(details),
    });
  }

  /**
   * event envelope を付けて記録する。
   *
   * 【詳細説明】
   * - sequence は Recorder 内の単調増加番号であり、時刻補正に依存しない。
   *
   * @private
   * @param {Object} event - 記録する event 本体
   * @returns {Object} 記録した event
   */
  appendEvent(event) {
    this.ensureSession();
    this.session.sequence += 1;
    const recorded = {
      sequence: this.session.sequence,
      atMs: this.clock() - this.session.startedAt,
      ...event,
    };
    this.session.events.push(recorded);
    return cloneJsonValue(recorded);
  }

  /**
   * セッション開始済みであることを検証する。
   *
   * 【詳細説明】
   * - public API から未開始状態で呼ばれた場合に、分かりやすいエラーを返す。
   *
   * @private
   * @returns {void}
   * @throws {Error} セッション未開始の場合
   */
  ensureSession() {
    if (!this.session) {
      throw new Error("ProtocolRecorder session has not started");
    }
  }
}

/**
 * 既定設定で ProtocolRecorder を作成する。
 *
 * 【詳細説明】
 * - UI やテストから class 名に依存せず recorder を生成するための小さな factory。
 *
 * @function createProtocolRecorder
 * @param {Object=} options - Recorder オプション
 * @returns {ProtocolRecorder} ProtocolRecorder インスタンス
 * @example
 * const recorder = createProtocolRecorder();
 */
export function createProtocolRecorder(options = {}) {
  return new ProtocolRecorder(options);
}
