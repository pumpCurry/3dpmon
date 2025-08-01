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
  currentHostname,
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
    this.ttsVoice   = ""; // Web Speech API voice name
    this.ttsRate    = 1.8;      // 0.5～3.0
    this.webhookUrls = [];
    this.filamentLowThreshold = 0.1; // 残量10%を下回ったら通知

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
    if (Array.isArray(saved.webhookUrls)) this.webhookUrls = saved.webhookUrls;
    if (typeof saved.filamentLowThreshold === "number") {
      this.filamentLowThreshold = saved.filamentLowThreshold;
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

    monitorData.appSettings[SETTINGS_KEY] = {
      enabled:    this.enabled,
      volume:     this.volume,
      muted:      this.muted,
      useWebPush: this.useWebPush,
      map:        sanitized,
      ttsVoice:   this.ttsVoice,
      ttsRate:    this.ttsRate,
      webhookUrls: this.webhookUrls,
      filamentLowThreshold: this.filamentLowThreshold
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
   * 読み上げに使用する Voice 名を設定する。
   * 設定後は永続ストレージにも保存される。
   *
   * @param {string} voice - 利用する音声エンジン名
   * @returns {void}
   */
  setTtsVoice(voice) {
    this.ttsVoice = voice;
    this._persistSettings();
  }

  /**
   * 読み上げ速度を設定する。
   * 設定値は 0.1〜10 の範囲で利用される。
   *
   * @param {number} rate - TTS の再生速度
   * @returns {void}
   */
  setTtsRate(rate) {
    this.ttsRate = rate;
    this._persistSettings();
  }


  /**
   * 通知を発火します。
   * - ログ出力／固定アラート／TTS／効果音／WebPush
   *
   * @function notify
   * @param {string} type
   * @param {object} [payload]
  */
  notify(type, payload = {}) {
    if (!this.enabled || notificationSuppressed) return;
    const def = this.map[type];
    if (!def?.enabled) return;

    // マクロ展開
    const now = new Date().toLocaleString();
    const ctx = { hostname: currentHostname || "unknown", now, ...payload };
    const text = (def.talk || def.label || "")
      .replace(/\{([^}]+)\}/g, (_, k) => ctx[k] != null ? String(ctx[k]) : "")
      .replace(/[\r\n]+/g, " ");

    // 1) ログ出力
    import("./dashboard_log_util.js")
      .then(({ pushNotificationLog }) => pushNotificationLog(text, def.level));

    // 2) 固定アラート
    showAlert(text, def.level, def.level === "error");

    // 3) TTS
    if (!this.muted && audioManager.isVoiceAllowed() && def.talk) {
      const utt = new SpeechSynthesisUtterance(text);
    
      // rate
      utt.rate = this.ttsRate;
    
      // voice
      const voices = speechSynthesis
        .getVoices()
        .filter(v => v.lang === "ja-JP" && v.localService);

      let found;
      if (this.ttsVoice === "female" || this.ttsVoice === "male") {
        // 旧設定との互換のため female/male も受け付ける
        found = voices.find(v =>
          this.ttsVoice === "female" ? /female/i.test(v.name) : /male/i.test(v.name)
        );
      } else if (this.ttsVoice) {
        found = voices.find(v => v.name === this.ttsVoice);
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
      this._sendWebHook(text);
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
   * @private
   * @param {string} body - 通知本文
   * @returns {void}
   */
  _sendWebHook(body) {
    this.webhookUrls.forEach(url => {
      try {
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: body })
        });
      } catch (e) {
        console.error("[webhook]", e);
      }
    });
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
    const host = currentHostname || "unknown";
    const long = `3Dプリンタ監視ツール:${host}`;
    return long.length <= 30 ? long : `3Dプリンタ:${host}`;
  }

  /**
   * 指定タイプの通知を即座にテスト送信する。
   *
   * @param {string} type - テストする通知タイプ
   * @returns {void}
   */
  testNotification(type) {
    this.notify(type, {});
  }

  /**
   * すべての通知タイプを順番にテスト送信する。
   *
   * @param {number} [interval=500] - 各通知の送信間隔(ms)
   * @returns {void}
   */
  testAllNotifications(interval = 500) {
    this.getTypes().forEach((type, idx) =>
      setTimeout(() => this.notify(type), idx * interval)
    );
  }

  /**
   * 通知設定編集UIを生成・バインドします。
   *
   * @function initSettingsUI
   * @param {HTMLElement} container - #notification-panel-body
   */
  initSettingsUI(container) {
    container.innerHTML = "";

    // (A) 通知全体 ON/OFF
    const master = document.createElement("label");
    master.innerHTML = `<input type="checkbox" ${this.enabled ? "checked" : ""}> 通知全体を有効`;
    master.querySelector("input")
          .addEventListener("change", e => this.enable(e.target.checked));
    container.append(master, document.createElement("hr"));

    // (B) 全通知テスト
    const btnAll = document.createElement("button");
    btnAll.textContent = "全通知テスト";
    btnAll.addEventListener("click", () => this.testAllNotifications());
    container.appendChild(btnAll);

    // (C) 各タイプ設定UI
    const types  = this.getTypes();
    const levels = LEVELS;
    types.forEach(type => {
      const cfg = this.map[type] || {};
      const item = document.createElement("div");
      item.className = "notif-item";

      // Enable checkbox
      const chk = document.createElement("input");
      chk.type    = "checkbox";
      chk.checked = !!cfg.enabled;
      item.appendChild(chk);

      // Label
      const lbl = document.createElement("label");
      lbl.textContent = ` ${type}`;
      item.appendChild(lbl);

      // Test button
      const test = document.createElement("button");
      test.textContent = "テスト";
      test.addEventListener("click", () => this.testNotification(type));
      item.appendChild(test);

      // Talk text input
      const talk = document.createElement("input");
      talk.type        = "text";
      talk.value       = cfg.talk || "";
      talk.placeholder = "読み上げテキスト";
      item.appendChild(talk);

      // Sound filename input
      const snd = document.createElement("input");
      snd.type        = "text";
      snd.value       = cfg.sound || "";
      snd.placeholder = "音ファイル名";
      item.appendChild(snd);

      // Level select
      const sel = document.createElement("select");
      levels.forEach(lv => {
        const o = document.createElement("option");
        o.value       = lv;
        o.textContent = lv;
        if (cfg.level === lv) o.selected = true;
        sel.appendChild(o);
      });
      item.appendChild(sel);

      container.appendChild(item);
    });

    // (D) 保存ボタン
    const notifSaveBtn = document.createElement("button");
    notifSaveBtn.textContent = "保存";
    notifSaveBtn.addEventListener("click", () => {
      container.querySelectorAll(".notif-item").forEach((item, i) => {
        // input と select を順に取得し [checkbox, talk, sound, level] と4要素で分解
        const [chk, talk, snd, sel] = item.querySelectorAll("input,select");
        this.updateNotification(types[i], {
          enabled: chk.checked,
          talk:    talk.value,
          sound:   snd.value,
          level:   sel.value
        });
      });

      // ログ出力
      import("./dashboard_log_util.js")
        .then(({ pushNotificationLog }) => {
          pushNotificationLog("通知設定を保存しました", "info");
          // 成功アラートを表示
          showAlert("通知設定を保存しました", "success");
        })
        .catch(() => {
          // 万一の失敗時はエラーアラートを表示
          showAlert("通知設定の保存に失敗しました", "error", true);
        });
    });
    container.appendChild(notifSaveBtn);

    // (E) 閾値・Webhook 設定フィールド
    const extraFs = document.createElement("fieldset");
    extraFs.className = "extra-settings";
    extraFs.style.cssText = "margin-top:1em;padding:0.5em;border:1px solid #ccc;border-radius:4px;";
    extraFs.innerHTML = `
      <legend>追加設定</legend>
      <label>フィラメント残量警告閾値(%)<input type="number" id="filament-threshold" min="1" max="50" step="1" value="${Math.round(this.filamentLowThreshold*100)}"></label>
      <label style="display:block;margin-top:0.5em;">Webhook URLs (comma separated)
        <textarea id="webhook-urls" rows="2" style="width:100%">${this.webhookUrls.join(",")}</textarea>
      </label>
      <button id="extra-save-btn">保存</button>
    `;
    container.appendChild(extraFs);
    extraFs.querySelector("#extra-save-btn").addEventListener("click", () => {
      const thr = parseFloat(extraFs.querySelector("#filament-threshold").value) / 100;
      const urls = extraFs.querySelector("#webhook-urls").value.split(",").map(s => s.trim()).filter(s => s);
      this.setFilamentLowThreshold(thr);
      this.setWebhookUrls(urls);
      showAlert("追加通知設定を保存しました", "success");
    });

    // (F) 読み上げ設定フィールド
    const ttsFs = document.createElement("fieldset");
    ttsFs.className = "tts-settings";
    ttsFs.style.cssText = "margin-top:1em;padding:0.5em;border:1px solid #ccc;border-radius:4px;";
    ttsFs.innerHTML = `
      <legend>読み上げ設定</legend>
      <label for="tts-voice-select">音声を選択：</label>
      <select id="tts-voice-select"></select>
      <div style="margin:0.5em 0;">
        <input type="text" id="tts-test-text" value="この速度と音声でお知らせします">
        <button id="tts-test-btn">発声テスト</button>
      </div>
      <div style="margin:0.5em 0;">
        <label for="tts-rate">速度：</label>
        <input type="range" id="tts-rate" min="0.5" max="3" step="0.1">
        <span id="tts-rate-value"></span>
      </div>
      <button id="tts-save-btn">読み上げ設定を保存</button>
    `;
    container.appendChild(ttsFs);

    const voiceSelect = ttsFs.querySelector("#tts-voice-select");
    const rateInput   = ttsFs.querySelector("#tts-rate");
    const rateValue   = ttsFs.querySelector("#tts-rate-value");
    const ttsSaveBtn  = ttsFs.querySelector("#tts-save-btn");
    const testInput   = ttsFs.querySelector("#tts-test-text");
    const testBtn     = ttsFs.querySelector("#tts-test-btn");

    /**
     * 利用可能な音声リストを `<select>` に反映します。
     * - ja-JP かつ localService=true の音声のみを対象とします。
     *
     * @function populateVoiceList
     * @private
     */
    const populateVoiceList = () => {
      const voices = speechSynthesis
        .getVoices()
        .filter(v => v.lang === "ja-JP" && v.localService);

      voiceSelect.innerHTML = "";
      voices.forEach(v => {
        const opt = document.createElement("option");
        opt.value = v.name;
        opt.textContent = `${v.name} (${v.lang})`;
        voiceSelect.appendChild(opt);
      });

      if (voices.some(v => v.name === this.ttsVoice)) {
        voiceSelect.value = this.ttsVoice;
      }
    };

    populateVoiceList();
    if (speechSynthesis.onvoiceschanged !== undefined) {
      speechSynthesis.onvoiceschanged = populateVoiceList;
    }

    rateInput.value = this.ttsRate;
    rateValue.textContent = this.ttsRate.toFixed(1);

    rateInput.addEventListener("input", e => {
      rateValue.textContent = parseFloat(e.target.value).toFixed(1);
    });

    ttsSaveBtn.addEventListener("click", () => {
      this.setTtsVoice(voiceSelect.value);
      this.setTtsRate(parseFloat(rateInput.value));
      showAlert("読み上げ設定を保存しました", "success");
    });

    testBtn.addEventListener("click", () => {
      const utter = new SpeechSynthesisUtterance(testInput.value);
      utter.rate = parseFloat(rateInput.value);
      const voices = speechSynthesis
        .getVoices()
        .filter(v => v.lang === "ja-JP" && v.localService);
      const voice = voices.find(v => v.name === voiceSelect.value) || voices[0];
      if (voice) utter.voice = voice;
      window.speechSynthesis.speak(utter);
    });


  }
}



/* ------------------------------------------------------------------
 * シングルトンとしてエクスポート
 * ------------------------------------------------------------------ */
export const notificationManager = new NotificationManager();
