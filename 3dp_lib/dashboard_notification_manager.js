/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 通知管理モジュール
 * @file dashboard_notification_manager.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_notification_manager
 *
 * 【機能内容サマリ】
 * - 通知設定の永続化とUI生成
 * - 画面上部アラート表示機能
 * - 通知発火の統括管理
 *
 * 【公開関数一覧】
 * - {@link showAlert}：アラート表示
 * - {@link clearErrorAlerts}：エラーアラート一括消去
 * - {@link NotificationManager}：通知管理クラス
 * - {@link notificationManager}：共有インスタンス
 *
* @version 1.390.474 (PR #216)
* @since   1.390.193 (PR #86)
* @lastModified 2025-06-25 22:45:32
 * -----------------------------------------------------------
 * @todo
 * - none
*/
"use strict";

import {
  monitorData,
  notificationSuppressed
} from "./dashboard_data.js";
import { saveUnifiedStorage }           from "./dashboard_storage.js";
import { audioManager }                 from "./dashboard_audio_manager.js";
import { defaultNotificationMap }       from "./dashboard_notification_defaults.js";
import { LEVELS }                       from "./dashboard_constants.js";

/* ------------------------------------------------------------------
 * 固定アラートマネージャ（画面上部75%不透明）
 * ------------------------------------------------------------------ */
const _alertContainer = document.createElement("div");
_alertContainer.className = "notification-container";
Object.assign(_alertContainer.style, {
  position:      "fixed",
  top:           "0",
  left:          "0",
  width:         "100%",
  zIndex:        "4050",
  opacity:       "0.75",
  pointerEvents: "none"
});
document.body.appendChild(_alertContainer);

/**
 * レベル名の正規化
 * @param {string} level
 * @returns {"info"|"warn"|"error"|"success"}
 */
function _normalizeLevel(level) {
  switch (level) {
    case "warning": return "warn";
    case "danger":  return "error";
    default:        return level;
  }
}

/**
 * 通知アラートを消去（アニメーション付き）
 * @param {HTMLElement} el
 */
function _dismiss(el) {
  el.classList.replace("enter-active", "exit");
  requestAnimationFrame(() => {
    el.classList.replace("exit", "exit-active");
    el.addEventListener("transitionend", () => el.remove(), { once: true });
  });
}

/**
 * 通知アラートを表示します。
 * @param {string} message                              - 表示メッセージ
 * @param {"info"|"warn"|"error"|"success"} [level="info"] - レベル（色）
 * @param {boolean} [persistent=false]                   - true のとき自動消去しない
 */
export function showAlert(message, level = "info", persistent = false) {
  const lvl = _normalizeLevel(level);
  const container = document.querySelector(".notification-container");
  if (!container) {
    console.warn("showAlert: .notification-container が見つかりません");
    return;
  }

  import("./dashboard_log_util.js").then(({ pushNotificationLog }) =>
    pushNotificationLog(message, lvl)
  );

  // アラート本体
  const alertEl = document.createElement("div");
  alertEl.className = `notification-alert ${lvl} enter`;
  alertEl.textContent = message;

  // 閉じるボタン
  const btn = document.createElement("button");
  btn.className = "notification-close";
  btn.innerHTML = "&times;";
  btn.addEventListener("click", () => _dismiss(alertEl));
  alertEl.appendChild(btn);

  container.appendChild(alertEl);

  // フェードイン
  requestAnimationFrame(() => {
    alertEl.classList.replace("enter", "enter-active");
  });

  // 自動消去（persistent=false かつ level !== "error"）
  if (!persistent && lvl !== "error") {
    setTimeout(() => _dismiss(alertEl), 8000);
  }
}

/**
 * error レベルのアラートを一括消去します。
 */
export function clearErrorAlerts() {
  const container = document.querySelector(".notification-container");
  if (!container) return;
  container
    .querySelectorAll(".notification-alert.error")
    .forEach(el => _dismiss(el));
}

/* ------------------------------------------------------------------
 * NotificationManager クラス
 * ------------------------------------------------------------------ */
const SETTINGS_KEY = "notificationSettings";

export class NotificationManager {

  constructor() {
    this.enabled    = true;
    this.volume     = 1.0;
    this.muted      = false;
    this.useWebPush = true;
    this.map        = JSON.parse(JSON.stringify(defaultNotificationMap));
    this.ttsVoice   = ""; // デフォルト TTS 音声名（ホスト個別設定がない場合に使用）
    this.ttsRate    = 1.8;      // デフォルト TTS 速度 0.5～3.0
    /** @type {Map<string, {voice: string, rate: number}>} ホスト別 TTS 設定 */
    this._hostTts   = new Map();
    this.webhookUrls = [];
    this.filamentLowThreshold = 0.1; // 残量10%を下回ったら通知
    /** ステータススナップショット Webhook 送信を有効にするか */
    this.statusSnapshotEnabled = false;
    /** ステータススナップショット送信間隔 [秒] */
    this.statusSnapshotIntervalSec = 30;

    // 永続化済み設定の読み込みは initializeDashboard() から
    // 行うため、コンストラクタでは呼び出さない。

    // level プロパティがない場合は "info" を補填
    Object.values(this.map).forEach(cfg => {
      if (!cfg.level) cfg.level = "info";
    });
  }

  /**
   * 永続化済み通知設定を読み込み、現在のインスタンスへ反映します。
   *
   * @function loadSettings
   * @returns {void}
   */
  loadSettings() {
    const saved = monitorData.appSettings[SETTINGS_KEY];
    if (!saved) return;
    this.enabled    = saved.enabled    ?? this.enabled;
    this.volume     = saved.volume     ?? this.volume;
    this.muted      = saved.muted      ?? this.muted;
    this.useWebPush = saved.useWebPush ?? this.useWebPush;
    // デフォルトマップを基点に保存済み設定をマージすることで
    // 新規追加された通知タイプを欠落なく補完する
    const merged = JSON.parse(JSON.stringify(defaultNotificationMap));
    if (saved.map) {
      Object.entries(saved.map).forEach(([k, v]) => {
        merged[k] = { ...(merged[k] || {}), ...v };
      });
    }
    // 改行を除去して単一行に統一
    Object.values(merged).forEach(cfg => {
      if (typeof cfg.talk === "string") {
        cfg.talk = cfg.talk.replace(/[\r\n]+/g, " ");
      }
      if (typeof cfg.label === "string") {
        cfg.label = cfg.label.replace(/[\r\n]+/g, " ");
      }
    });
    this.map = merged;

    if (saved.ttsVoice) this.ttsVoice = saved.ttsVoice;
    if (saved.ttsRate)  this.ttsRate  = saved.ttsRate;
    // per-host TTS 設定の復元
    if (saved.hostTts && typeof saved.hostTts === "object") {
      this._hostTts.clear();
      for (const [host, cfg] of Object.entries(saved.hostTts)) {
        this._hostTts.set(host, { voice: cfg.voice || "", rate: cfg.rate ?? this.ttsRate });
      }
    }
    if (Array.isArray(saved.webhookUrls)) this.webhookUrls = saved.webhookUrls;
    if (typeof saved.filamentLowThreshold === "number") {
      this.filamentLowThreshold = saved.filamentLowThreshold;
    }
    if (typeof saved.statusSnapshotEnabled === "boolean") {
      this.statusSnapshotEnabled = saved.statusSnapshotEnabled;
    }
    if (typeof saved.statusSnapshotIntervalSec === "number" && saved.statusSnapshotIntervalSec >= 5) {
      this.statusSnapshotIntervalSec = saved.statusSnapshotIntervalSec;
    }

    // level プロパティが欠けている場合は info を補填
    Object.values(this.map).forEach(cfg => {
      if (!cfg.level) cfg.level = "info";
    });

    // 旧データが改行を含んでいた場合は保存し直す
    this._persistSettings();
  }

  /** @private 永続化ヘルパー */
  _persistSettings() {
    const sanitized = JSON.parse(JSON.stringify(this.map));
    Object.values(sanitized).forEach(cfg => {
      if (typeof cfg.talk === "string") {
        cfg.talk = cfg.talk.replace(/[\r\n]+/g, " ");
      }
      if (typeof cfg.label === "string") {
        cfg.label = cfg.label.replace(/[\r\n]+/g, " ");
      }
    });

    // per-host TTS を永続化用オブジェクトに変換
    const hostTtsObj = {};
    for (const [host, cfg] of this._hostTts) {
      hostTtsObj[host] = { voice: cfg.voice, rate: cfg.rate };
    }

    monitorData.appSettings[SETTINGS_KEY] = {
      enabled:    this.enabled,
      volume:     this.volume,
      muted:      this.muted,
      useWebPush: this.useWebPush,
      map:        sanitized,
      ttsVoice:   this.ttsVoice,
      ttsRate:    this.ttsRate,
      hostTts:    hostTtsObj,
      webhookUrls: this.webhookUrls,
      filamentLowThreshold: this.filamentLowThreshold,
      statusSnapshotEnabled: this.statusSnapshotEnabled,
      statusSnapshotIntervalSec: this.statusSnapshotIntervalSec
    };
    saveUnifiedStorage();
  }

  enable(flag)        { this.enabled    = !!flag; this._persistSettings(); }
  mute(flag)          { this.muted      = !!flag; this._persistSettings(); }
  setVolume(v)        { this.volume     = Math.max(0, Math.min(1, v)); this._persistSettings(); }
  enableWebPush(flag) { this.useWebPush = !!flag; this._persistSettings(); }
  /**
   * Webhook URL リストを設定する。
   * 入力値は空要素を除外して保存される。
   *
   * @param {string[]} list - URL の配列
   * @returns {void}
   */
  setWebhookUrls(list) {
    this.webhookUrls = Array.isArray(list) ? list.filter(u => u) : [];
    this._persistSettings();
  }
  /**
   * 現在登録されている Webhook URL を取得する。
   *
   * @returns {string[]} URL 配列
   */
  getWebhookUrls() { return [...this.webhookUrls]; }
  /**
   * フィラメント残量警告の閾値を設定する。
   * 値は 0〜1 の範囲に丸められる。
   *
   * @param {number} v - 閾値(0〜1)
   * @returns {void}
   */
  setFilamentLowThreshold(v) {
    const val = Math.min(Math.max(v, 0), 1);
    this.filamentLowThreshold = val;
    this._persistSettings();
  }
  /**
   * フィラメント残量警告の閾値を取得する。
   *
   * @returns {number} 閾値(0〜1)
   */
  getFilamentLowThreshold() { return this.filamentLowThreshold; }

  getNotificationMap() { return JSON.parse(JSON.stringify(this.map)); }
  getTypes()           { return Object.keys(this.map); }

  updateNotification(type, patch) {
    if (!this.map[type]) return;
    Object.assign(this.map[type], patch);
    this._persistSettings();
  }

  // 新規メソッド：TTS 設定の変更

  /**
   * デフォルトの読み上げ音声名を設定する。
   * ホスト個別設定がない場合に使用される。
   *
   * @param {string} voice - 利用する音声エンジン名
   * @returns {void}
   */
  setTtsVoice(voice) {
    this.ttsVoice = voice;
    this._persistSettings();
  }

  /**
   * デフォルトの読み上げ速度を設定する。
   * ホスト個別設定がない場合に使用される。
   *
   * @param {number} rate - TTS の再生速度
   * @returns {void}
   */
  setTtsRate(rate) {
    this.ttsRate = rate;
    this._persistSettings();
  }

  /**
   * ホスト別 TTS 設定を取得する。
   * 個別設定がなければデフォルト値を返す。
   *
   * @param {string} hostname - ホスト名
   * @returns {{voice: string, rate: number}} TTS 設定
   */
  getHostTts(hostname) {
    const h = this._hostTts.get(hostname);
    return {
      voice: h?.voice ?? this.ttsVoice,
      rate:  h?.rate  ?? this.ttsRate
    };
  }

  /**
   * ホスト別 TTS 設定を保存する。
   *
   * @param {string} hostname - ホスト名
   * @param {string} voice - 音声名
   * @param {number} rate - 速度
   */
  setHostTts(hostname, voice, rate) {
    this._hostTts.set(hostname, { voice, rate });
    this._persistSettings();
  }

  /**
   * 通知を発火します。
   * - ログ出力／固定アラート／TTS／効果音／WebPush
   * - TTS 設定はホスト別に適用される（機器ごとに音声を変更可能）
   *
   * @function notify
   * @param {string} type - 通知タイプ
   * @param {object} [payload] - マクロ展開用データ（hostname を含むこと）
  */
  notify(type, payload = {}) {
    if (!this.enabled || notificationSuppressed) return;
    const def = this.map[type];
    if (!def?.enabled) return;

    // マクロ展開
    const now = new Date().toLocaleString();
    const hostname = payload.hostname || "unknown";
    const machine = monitorData.machines[hostname];
    const displayName = machine?.storedData?.hostname?.rawValue
                     || machine?.storedData?.model?.rawValue
                     || hostname;
    const ctx = { hostname: displayName, now, _rawHostname: hostname, ...payload };
    const text = (def.talk || def.label || "")
      .replace(/\{([^}]+)\}/g, (_, k) => ctx[k] != null ? String(ctx[k]) : "")
      .replace(/[\r\n]+/g, " ");

    // 1) 固定アラート（showAlert 内でログ出力も行われる）
    showAlert(text, def.level, def.level === "error");

    // 3) TTS（ホスト別設定を適用）
    if (!this.muted && audioManager.isVoiceAllowed() && def.talk) {
      const hostTts = this.getHostTts(hostname);
      const utt = new SpeechSynthesisUtterance(text);

      // rate（ホスト別）
      utt.rate = hostTts.rate;

      // voice（ホスト別）
      const voices = speechSynthesis
        .getVoices()
        .filter(v => v.lang === "ja-JP" && v.localService);

      let found;
      const voiceName = hostTts.voice;
      if (voiceName === "female" || voiceName === "male") {
        // 旧設定との互換のため female/male も受け付ける
        found = voices.find(v =>
          voiceName === "female" ? /female/i.test(v.name) : /male/i.test(v.name)
        );
      } else if (voiceName) {
        found = voices.find(v => v.name === voiceName);
      }
      if (!found) found = voices[0];
      if (found) utt.voice = found;

      window.speechSynthesis.speak(utt);
    }


    // 4) 効果音
    if (!this.muted && audioManager.isMusicAllowed() && def.sound) {
      audioManager.play(def.sound);
    }

    // 5) Web Push
    // Notification の許可がある場合だけ Web Push 処理を呼ぶ
    if (this.useWebPush
        && "Notification" in window
        && Notification.permission === "granted") {
      this._sendWebPush(text);
    }

    if (this.webhookUrls.length > 0) {
      this._sendWebHook(text, type, ctx);
    }

  }

  /**
   * Web Push 通知を送出する。
   *
   * Notification API が利用可能かを確認し、
   * 権限が無い場合は許可取得を試みる。
   *
   * @private
   * @param {string} body - 通知本文
   * @returns {void}
   */
  _sendWebPush(body) {
    if (!("Notification" in window)) {
      showAlert(body, "error");
      return;
    }
    const show = () => new Notification(this._genTitle(), { body, icon: "" });
    if (Notification.permission === "granted") {
      show();
    } else if (Notification.permission === "default") {
      Notification.requestPermission().then(p => {
        if (p === "granted") show();
        else showAlert(body, "error");
      });
    } else {
      showAlert(body, "error");
    }
  }

  /**
   * Webhook 経由で通知を送信する。
   *
   * 構造化されたペイロードを HTTP POST で送信する。
   * Slack / Discord / LINE / IFTTT 等の外部サービスに転送可能。
   * fetch はファイア・アンド・フォーゲット方式（レスポンスを待たない）。
   *
   * @private
   * @param {string} body - 展開済みテキスト
   * @param {string} type - 通知イベントタイプ (例: "printCompleted")
   * @param {object} ctx - マクロ展開済みコンテキスト
   * @returns {void}
   */
  _sendWebHook(body, type, ctx) {
    // per-host webhook ON/OFF チェック
    const rawHostname = ctx._rawHostname || ctx.hostname || "unknown";
    if (!this._isWebhookEnabledForHost(rawHostname)) return;

    const now = new Date();
    const payload = {
      // Slack/Discord 互換テキスト
      text: body,
      // 構造化データ
      event: type,
      hostname: ctx.hostname || "unknown",
      // タイムスタンプ: UTC + epoch + ローカル + オフセット
      timestamp: now.toISOString(),
      timestamp_epoch: now.getTime(),
      timestamp_local: now.toLocaleString(),
      timezone_offset_min: now.getTimezoneOffset(),
      data: {}
    };

    // イベント種別に応じた構造化データを付与
    for (const key of Object.keys(ctx)) {
      if (key === "hostname" || key === "now" || key === "_rawHostname") continue;
      payload.data[key] = ctx[key];
    }

    const json = JSON.stringify(payload);
    this.webhookUrls.forEach(url => {
      try {
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: json
        }).catch(e => console.warn("[webhook] fetch failed:", url, e.message));
      } catch (e) {
        console.error("[webhook]", e);
      }
    });
  }

  /**
   * 指定ホストで Webhook が有効かどうかを判定する。
   *
   * connectionTargets に `webhookEnabled` フィールドがある場合はそれを参照。
   * 未設定の場合はデフォルト有効（後方互換）。
   *
   * @private
   * @param {string} hostname - 生のホスト名キー（IP:PORT または hostname）
   * @returns {boolean}
   */
  _isWebhookEnabledForHost(hostname) {
    const targets = monitorData.appSettings.connectionTargets || [];
    const entry = targets.find(t => t.hostname === hostname || t.dest === hostname);
    // 明示的に false が設定されている場合のみ無効。未設定はデフォルト有効
    if (entry && entry.webhookEnabled === false) return false;
    return true;
  }

  /**
   * Webhook テスト送信を実行する。
   *
   * テスト用の構造化ペイロードを全 URL に送信し、
   * 結果をコールバックで返す。
   *
   * @param {function} [onResult] - (url, ok, error) を受け取るコールバック
   * @returns {Promise<void>}
   */
  async testWebhook(onResult) {
    if (this.webhookUrls.length === 0) {
      onResult?.("", false, "URL が設定されていません");
      return;
    }
    const now = new Date();
    const testPayload = {
      text: "3dpmon Webhook テスト送信",
      event: "webhookTest",
      hostname: "3dpmon",
      timestamp: now.toISOString(),
      timestamp_epoch: now.getTime(),
      timestamp_local: now.toLocaleString(),
      timezone_offset_min: now.getTimezoneOffset(),
      data: { message: "この通知はテスト送信です" }
    };
    const json = JSON.stringify(testPayload);
    for (const url of this.webhookUrls) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: json
        });
        onResult?.(url, res.ok, res.ok ? null : `HTTP ${res.status}`);
      } catch (e) {
        onResult?.(url, false, e.message);
      }
    }
  }

  /**
   * Web Push 通知用タイトルを生成する。
   *
   * ホスト名を含めた文字列を返すが、長すぎる場合は短縮版を返す。
   *
   * @private
   * @returns {string} 生成したタイトル文字列
   */
  _genTitle() {
    return "3Dプリンタ監視ツール";
  }

  /**
   * 指定タイプの通知を即座にテスト送信する。
   *
   * @param {string} type - テストする通知タイプ
   * @returns {void}
   */
  testNotification(type) {
    const def = this.map[type];
    if (!def) return;
    /* テスト送信時はログレベルを info に抑制し、テスト表記を付与 */
    const origLevel = def.level;
    def.level = "info";
    this.notify(type, { _test: true });
    def.level = origLevel;
  }

  /**
   * すべての通知タイプを順番にテスト送信する。
   *
   * @param {number} [interval=500] - 各通知の送信間隔(ms)
   * @returns {void}
   */
  testAllNotifications(interval = 500) {
    this.getTypes().forEach((type, idx) =>
      setTimeout(() => this.testNotification(type), idx * interval)
    );
  }

  /**
   * カテゴリ別通知タイプ定義
   * @private
   * @type {Array<{label: string, types: string[]}>}
   */
  static _CATEGORIES = [
    {
      label: "印刷イベント",
      types: [
        "printStarted", "printCompleted", "printFailed", "printPaused",
        "errorOccurred", "errorResolved",
        "filamentOut", "filamentReplaced", "filamentLow",
        "timeLeft10", "timeLeft5", "timeLeft1"
      ]
    },
    {
      label: "カメラ",
      types: [
        "cameraConnected", "cameraConnectionStopped",
        "cameraConnectionFailed", "cameraServiceStopped"
      ]
    },
    {
      label: "温度アラート",
      types: [
        "tempNearNozzle80", "tempNearBed80",
        "tempNearNozzle90", "tempNearBed90",
        "tempNearNozzle95", "tempNearBed95",
        "tempNearNozzle98", "tempNearBed98",
        "tempNearNozzle100", "tempNearBed100"
      ]
    }
  ];

  /**
   * タイプ名の日本語表示マップ
   * @private
   * @type {Object<string,string>}
   */
  static _TYPE_LABELS = {
    printStarted:     "印刷開始",
    printCompleted:   "印刷完了",
    printFailed:      "印刷失敗",
    printPaused:      "一時停止",
    errorOccurred:    "エラー発生",
    errorResolved:    "エラー解消",
    filamentOut:      "フィラメント切れ",
    filamentReplaced: "フィラメント補充",
    filamentLow:      "フィラメント残量低",
    timeLeft10:       "残り10分",
    timeLeft5:        "残り5分",
    timeLeft1:        "残り1分",
    cameraConnected:          "カメラ接続",
    cameraConnectionStopped:  "カメラ停止",
    cameraConnectionFailed:   "カメラ失敗",
    cameraServiceStopped:     "配信サービス停止",
    tempNearNozzle80:  "ノズル80%",
    tempNearBed80:     "ベッド80%",
    tempNearNozzle90:  "ノズル90%",
    tempNearBed90:     "ベッド90%",
    tempNearNozzle95:  "ノズル95%",
    tempNearBed95:     "ベッド95%",
    tempNearNozzle98:  "ノズル98%",
    tempNearBed98:     "ベッド98%",
    tempNearNozzle100: "ノズル100%",
    tempNearBed100:    "ベッド100%"
  };

  /**
   * 通知設定モーダル用テーブルUIを生成・バインドします。
   * カテゴリ別折り畳みテーブル形式で表示します。
   *
   * @function initModalUI
   * @param {HTMLElement} container - #notif-modal-body
   */
  initModalUI(container) {
    container.innerHTML = "";

    /* ── (A) マスター行: 全体 ON/OFF + 全テスト ── */
    const masterRow = document.createElement("div");
    masterRow.className = "notif-master-row";
    const masterChk = document.createElement("input");
    masterChk.type = "checkbox";
    masterChk.checked = this.enabled;
    masterChk.id = "notif-master-enable";
    masterChk.addEventListener("change", e => this.enable(e.target.checked));
    const masterLbl = document.createElement("label");
    masterLbl.htmlFor = "notif-master-enable";
    masterLbl.textContent = " 通知全体を有効";
    const testAllBtn = document.createElement("button");
    testAllBtn.textContent = "全通知テスト";
    testAllBtn.addEventListener("click", () => this.testAllNotifications());
    masterRow.append(masterChk, masterLbl, testAllBtn);
    container.appendChild(masterRow);

    /* ── (B) カテゴリ別テーブル ── */
    const levels = LEVELS;
    const allTypes = this.getTypes();

    for (const cat of NotificationManager._CATEGORIES) {
      // カテゴリ見出し（クリックで折り畳み）
      const catHeader = document.createElement("div");
      catHeader.className = "notif-category";
      catHeader.textContent = cat.label;

      const tableWrap = document.createElement("div");

      catHeader.addEventListener("click", () => {
        catHeader.classList.toggle("collapsed");
        tableWrap.style.display = catHeader.classList.contains("collapsed") ? "none" : "";
      });

      // テーブル生成
      const table = document.createElement("table");
      table.className = "notif-table";

      // ヘッダー
      const thead = document.createElement("thead");
      thead.innerHTML = `<tr>
        <th class="col-on">ON</th>
        <th class="col-type">タイプ</th>
        <th class="col-level">レベル</th>
        <th class="col-talk">読み上げテキスト</th>
        <th class="col-sound">サウンド</th>
        <th class="col-test">テスト</th>
      </tr>`;
      table.appendChild(thead);

      // ボディ
      const tbody = document.createElement("tbody");
      for (const type of cat.types) {
        const cfg = this.map[type] || {};
        const tr = document.createElement("tr");
        tr.dataset.notifType = type;

        // ON/OFF
        const tdOn = document.createElement("td");
        tdOn.className = "col-on";
        const chk = document.createElement("input");
        chk.type = "checkbox";
        chk.checked = !!cfg.enabled;
        chk.dataset.role = "enabled";
        tdOn.appendChild(chk);
        tr.appendChild(tdOn);

        // タイプ名
        const tdType = document.createElement("td");
        tdType.className = "col-type";
        const typeLabel = NotificationManager._TYPE_LABELS[type] || type;
        tdType.textContent = typeLabel;
        tdType.title = type;
        tr.appendChild(tdType);

        // レベル
        const tdLevel = document.createElement("td");
        tdLevel.className = "col-level";
        const sel = document.createElement("select");
        sel.dataset.role = "level";
        for (const lv of levels) {
          const o = document.createElement("option");
          o.value = lv;
          o.textContent = lv;
          if (cfg.level === lv) o.selected = true;
          sel.appendChild(o);
        }
        tdLevel.appendChild(sel);
        tr.appendChild(tdLevel);

        // 読み上げテキスト
        const tdTalk = document.createElement("td");
        tdTalk.className = "col-talk";
        const talkInput = document.createElement("input");
        talkInput.type = "text";
        talkInput.value = cfg.talk || "";
        talkInput.placeholder = "読み上げテキスト";
        talkInput.dataset.role = "talk";
        tdTalk.appendChild(talkInput);
        tr.appendChild(tdTalk);

        // サウンド
        const tdSound = document.createElement("td");
        tdSound.className = "col-sound";
        const sndInput = document.createElement("input");
        sndInput.type = "text";
        sndInput.value = cfg.sound || "";
        sndInput.placeholder = "音ファイル名";
        sndInput.dataset.role = "sound";
        tdSound.appendChild(sndInput);
        tr.appendChild(tdSound);

        // テストボタン
        const tdTest = document.createElement("td");
        tdTest.className = "col-test";
        const testBtn = document.createElement("button");
        testBtn.textContent = "▶";
        testBtn.title = `${typeLabel} をテスト`;
        testBtn.addEventListener("click", () => this.testNotification(type));
        tdTest.appendChild(testBtn);
        tr.appendChild(tdTest);

        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      tableWrap.appendChild(table);

      container.appendChild(catHeader);
      container.appendChild(tableWrap);
    }

    /* ── (C) 追加設定: 閾値・Webhook ── */
    const extraFs = document.createElement("fieldset");
    extraFs.className = "notif-extra-fieldset";
    extraFs.innerHTML = `
      <legend>追加設定</legend>
      <label>フィラメント残量警告閾値(%)
        <input type="number" data-role="filament-threshold" min="1" max="50" step="1"
               value="${Math.round(this.filamentLowThreshold * 100)}" style="width:5em;">
      </label>
      <label>Webhook URLs (カンマ区切り)
        <textarea data-role="webhook-urls" rows="2" style="width:100%">${this.webhookUrls.join(",")}</textarea>
      </label>
      <div style="margin-top:6px">
        <button type="button" data-role="webhook-test" class="btn btn-sm">Webhook テスト送信</button>
        <span data-role="webhook-test-result" style="margin-left:8px;font-size:0.9em"></span>
      </div>
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid #ddd">
        <label style="display:inline-flex;align-items:center;gap:4px">
          <input type="checkbox" data-role="status-snapshot-enabled" ${this.statusSnapshotEnabled ? "checked" : ""}>
          ステータス定期送信 (全プリンタ状態を Webhook で定期プッシュ)
        </label>
        <label style="margin-left:12px">
          間隔(秒)
          <input type="number" data-role="status-snapshot-interval" min="5" max="300" step="5"
                 value="${this.statusSnapshotIntervalSec}" style="width:5em">
        </label>
      </div>
    `;
    // Webhook テストボタンのハンドラ
    const testBtn = extraFs.querySelector('[data-role="webhook-test"]');
    const testResult = extraFs.querySelector('[data-role="webhook-test-result"]');
    if (testBtn) {
      testBtn.addEventListener("click", async () => {
        // テスト前に入力欄から最新の URL を反映
        const urlsEl = extraFs.querySelector('[data-role="webhook-urls"]');
        if (urlsEl) {
          this.webhookUrls = urlsEl.value.split(",").map(s => s.trim()).filter(s => s);
        }
        testResult.textContent = "送信中…";
        testResult.className = "";
        await this.testWebhook((url, ok, err) => {
          const short = url.length > 40 ? url.slice(0, 37) + "…" : url;
          if (ok) {
            testResult.textContent = `✔ ${short} — 送信成功`;
            testResult.className = "text-success";
          } else {
            testResult.textContent = `✗ ${short} — ${err || "送信失敗"}`;
            testResult.className = "text-danger";
          }
        });
      });
    }

    container.appendChild(extraFs);

    /* ── (D) 読み上げ設定（機器別） ── */
    const ttsFs = document.createElement("fieldset");
    ttsFs.className = "notif-extra-fieldset";
    const ttsLegend = document.createElement("legend");
    ttsLegend.textContent = "読み上げ設定（機器別）";
    ttsFs.appendChild(ttsLegend);

    // 接続済みホスト一覧を取得（＋デフォルト行）
    const hostKeys = Object.keys(monitorData.machines || {}).filter(h => h !== "_$_NO_MACHINE_$_");
    const ttsEntries = [{ key: "__default__", label: "デフォルト（全機器共通）" }];
    for (const h of hostKeys) {
      const machine = monitorData.machines[h];
      const machineLabel = machine?.storedData?.hostname?.rawValue || machine?.storedData?.model?.rawValue || h;
      ttsEntries.push({ key: h, label: machineLabel });
    }

    // 各ホスト用 TTS 行を生成
    const ttsTable = document.createElement("table");
    ttsTable.className = "notif-table";
    ttsTable.style.marginTop = "6px";
    const ttsThead = document.createElement("thead");
    ttsThead.innerHTML = `<tr>
      <th style="width:160px;">機器</th>
      <th style="width:200px;">音声</th>
      <th>速度</th>
      <th style="width:50px;">テスト</th>
    </tr>`;
    ttsTable.appendChild(ttsThead);

    const ttsTbody = document.createElement("tbody");
    /** @type {Array<{key:string, voiceSelect:HTMLSelectElement, rateInput:HTMLInputElement}>} */
    const ttsRows = [];

    for (const entry of ttsEntries) {
      const isDefault = entry.key === "__default__";
      const hostTts = isDefault
        ? { voice: this.ttsVoice, rate: this.ttsRate }
        : this.getHostTts(entry.key);

      const tr = document.createElement("tr");
      tr.dataset.ttsHost = entry.key;

      // 機器名
      const tdHost = document.createElement("td");
      tdHost.textContent = entry.label;
      tdHost.style.fontSize = "12px";
      if (isDefault) tdHost.style.fontWeight = "bold";
      tr.appendChild(tdHost);

      // 音声セレクト
      const tdVoice = document.createElement("td");
      const voiceSel = document.createElement("select");
      voiceSel.dataset.role = "host-tts-voice";
      voiceSel.style.width = "100%";
      tdVoice.appendChild(voiceSel);
      tr.appendChild(tdVoice);

      // 速度
      const tdRate = document.createElement("td");
      tdRate.style.whiteSpace = "nowrap";
      const rateIn = document.createElement("input");
      rateIn.type = "range";
      rateIn.min = "0.5";
      rateIn.max = "3";
      rateIn.step = "0.1";
      rateIn.value = hostTts.rate;
      rateIn.dataset.role = "host-tts-rate";
      rateIn.style.width = "80px";
      const rateSpan = document.createElement("span");
      rateSpan.textContent = hostTts.rate.toFixed(1);
      rateSpan.style.fontSize = "11px";
      rateSpan.style.marginLeft = "4px";
      rateIn.addEventListener("input", () => {
        rateSpan.textContent = parseFloat(rateIn.value).toFixed(1);
      });
      tdRate.append(rateIn, rateSpan);
      tr.appendChild(tdRate);

      // テストボタン
      const tdTest = document.createElement("td");
      tdTest.style.textAlign = "center";
      const testBtn = document.createElement("button");
      testBtn.textContent = "▶";
      testBtn.title = `${entry.label} の音声テスト`;
      testBtn.addEventListener("click", () => {
        const utter = new SpeechSynthesisUtterance("この速度と音声でお知らせします");
        utter.rate = parseFloat(rateIn.value);
        const voices = speechSynthesis.getVoices().filter(v => v.lang === "ja-JP" && v.localService);
        const voice = voices.find(v => v.name === voiceSel.value) || voices[0];
        if (voice) utter.voice = voice;
        window.speechSynthesis.speak(utter);
      });
      tdTest.appendChild(testBtn);
      tr.appendChild(tdTest);

      ttsTbody.appendChild(tr);
      ttsRows.push({ key: entry.key, voiceSelect: voiceSel, rateInput: rateIn, hostTts });
    }
    ttsTable.appendChild(ttsTbody);
    ttsFs.appendChild(ttsTable);
    container.appendChild(ttsFs);

    // 音声リスト生成（全行共有）
    /** @private 音声リストを全セレクトに反映 */
    const populateAllVoiceLists = () => {
      const voices = speechSynthesis
        .getVoices()
        .filter(v => v.lang === "ja-JP" && v.localService);
      for (const row of ttsRows) {
        row.voiceSelect.innerHTML = "";
        voices.forEach(v => {
          const opt = document.createElement("option");
          opt.value = v.name;
          opt.textContent = v.name;
          row.voiceSelect.appendChild(opt);
        });
        if (voices.some(v => v.name === row.hostTts.voice)) {
          row.voiceSelect.value = row.hostTts.voice;
        }
      }
    };
    populateAllVoiceLists();
    if (speechSynthesis.onvoiceschanged !== undefined) {
      speechSynthesis.onvoiceschanged = populateAllVoiceLists;
    }

    /* ── (E) 保存ボタン行 ── */
    const saveRow = document.createElement("div");
    saveRow.className = "notif-save-row";
    const saveBtn = document.createElement("button");
    saveBtn.className = "btn-save";
    saveBtn.textContent = "すべて保存";
    saveBtn.addEventListener("click", () => this._saveModalSettings(container, ttsRows));
    saveRow.appendChild(saveBtn);
    container.appendChild(saveRow);
  }

  /**
   * モーダル内の全設定を保存します。
   *
   * @private
   * @param {HTMLElement} container - モーダルボディ要素
   * @param {Array<{key:string, voiceSelect:HTMLSelectElement, rateInput:HTMLInputElement}>} ttsRows - TTS行データ
   */
  _saveModalSettings(container, ttsRows) {
    // 各通知タイプの設定を保存
    const rows = container.querySelectorAll("tr[data-notif-type]");
    rows.forEach(tr => {
      const type = tr.dataset.notifType;
      this.updateNotification(type, {
        enabled: tr.querySelector('[data-role="enabled"]').checked,
        talk:    tr.querySelector('[data-role="talk"]').value,
        sound:   tr.querySelector('[data-role="sound"]').value,
        level:   tr.querySelector('[data-role="level"]').value
      });
    });

    // 閾値・Webhook
    const thrEl = container.querySelector('[data-role="filament-threshold"]');
    if (thrEl) {
      this.setFilamentLowThreshold(parseFloat(thrEl.value) / 100);
    }
    const urlsEl = container.querySelector('[data-role="webhook-urls"]');
    if (urlsEl) {
      this.setWebhookUrls(urlsEl.value.split(",").map(s => s.trim()).filter(s => s));
    }

    // ステータススナップショット設定を保存
    const snapEnabledEl = container.querySelector('[data-role="status-snapshot-enabled"]');
    if (snapEnabledEl) this.statusSnapshotEnabled = snapEnabledEl.checked;
    const snapIntervalEl = container.querySelector('[data-role="status-snapshot-interval"]');
    if (snapIntervalEl) {
      const v = parseInt(snapIntervalEl.value, 10);
      if (v >= 5) this.statusSnapshotIntervalSec = v;
    }

    // per-host TTS 設定を保存
    for (const row of ttsRows) {
      const voice = row.voiceSelect.value;
      const rate  = parseFloat(row.rateInput.value);
      if (row.key === "__default__") {
        this.ttsVoice = voice;
        this.ttsRate  = rate;
      } else {
        this._hostTts.set(row.key, { voice, rate });
      }
    }
    this._persistSettings();

    // ログ + アラート
    import("./dashboard_log_util.js")
      .then(({ pushNotificationLog }) => {
        pushNotificationLog("通知設定を保存しました", "info");
        showAlert("通知設定を保存しました", "success");
      })
      .catch(() => {
        showAlert("通知設定の保存に失敗しました", "error", true);
      });
  }

  /**
   * 通知設定編集UIを生成・バインドします。（旧パネル版 — 互換用）
   *
   * @function initSettingsUI
   * @param {HTMLElement} container - #notification-panel-body
   * @deprecated initModalUI を使用してください
   */
  initSettingsUI(container) {
    // 旧UIは接続モーダルに移行済み。互換のため initModalUI に委譲
    this.initModalUI(container);
  }
}



/* ------------------------------------------------------------------
 * 共有インスタンスとしてエクスポート。
 * 通知設定（読み上げテキスト、サウンド等）は per-host 化対象。
 * TTS 音声・速度は per-host で管理される（機器ごとに声を変更可能）。
 * ------------------------------------------------------------------ */
export const notificationManager = new NotificationManager();
