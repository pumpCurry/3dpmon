/**
 * @fileoverview
 * dashboard_notification_manager.js (ver.1.328)
 *
 * 通知マネージャ：設定の永続化／UI生成／通知発火を担当。
 * 画面上部固定アラート機能を統合。
 */
"use strict";

import { currentHostname, monitorData } from "./dashboard_data.js";
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
  zIndex:        "1050",
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
    this.ttsVoice   = "female"; // "female" or "male"
    this.ttsRate    = 1.8;      // 0.5～3.0

    // 永続化済み設定を復元
    const saved = monitorData.appSettings[SETTINGS_KEY];
    if (saved) {
      this.enabled    = saved.enabled    ?? this.enabled;
      this.volume     = saved.volume     ?? this.volume;
      this.muted      = saved.muted      ?? this.muted;
      this.useWebPush = saved.useWebPush ?? this.useWebPush;
      if (saved.map)      this.map      = JSON.parse(JSON.stringify(saved.map));
      if (saved.ttsVoice) this.ttsVoice = saved.ttsVoice;
      if (saved.ttsRate)  this.ttsRate  = saved.ttsRate;
    }

    // level プロパティがない場合は "info" を補填
    Object.values(this.map).forEach(cfg => {
      if (!cfg.level) cfg.level = "info";
    });
  }

  /** @private 永続化ヘルパー */
  _persistSettings() {
    monitorData.appSettings[SETTINGS_KEY] = {
      enabled:    this.enabled,
      volume:     this.volume,
      muted:      this.muted,
      useWebPush: this.useWebPush,
      map:        this.map,
      ttsVoice:   this.ttsVoice,
      ttsRate:    this.ttsRate
    };
    saveUnifiedStorage();
  }

  enable(flag)        { this.enabled    = !!flag; this._persistSettings(); }
  mute(flag)          { this.muted      = !!flag; this._persistSettings(); }
  setVolume(v)        { this.volume     = Math.max(0, Math.min(1, v)); this._persistSettings(); }
  enableWebPush(flag) { this.useWebPush = !!flag; this._persistSettings(); }

  getNotificationMap() { return JSON.parse(JSON.stringify(this.map)); }
  getTypes()           { return Object.keys(this.map); }

  updateNotification(type, patch) {
    if (!this.map[type]) return;
    Object.assign(this.map[type], patch);
    this._persistSettings();
  }

  // 新規メソッド：TTS 設定の変更
  setTtsVoice(voice) { 
    this.ttsVoice = voice; 
    this._persistSettings(); 
  }
  setTtsRate(rate) { 
    this.ttsRate = rate; 
    this._persistSettings(); 
  }


  /**
   * 通知を発火します。
   * - ログ出力／固定アラート／TTS／効果音／WebPush
   * @param {string} type
   * @param {object} [payload]
   */
  notify(type, payload = {}) {
    if (!this.enabled) return;
    const def = this.map[type];
    if (!def?.enabled) return;

    // マクロ展開
    const now = new Date().toLocaleString();
    const ctx = { hostname: currentHostname || "unknown", now, ...payload };
    const text = (def.talk || def.label || "")
      .replace(/\{([^}]+)\}/g, (_, k) => ctx[k] != null ? String(ctx[k]) : "");

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
      const voices = speechSynthesis.getVoices();
      // 名前に female/male が含まれるものを優先
      const found = voices.find(v =>
        this.ttsVoice === "female" ? /female/i.test(v.name) : /male/i.test(v.name)
      ) || voices[0];
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

  }

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

  _genTitle() {
    const host = currentHostname || "unknown";
    const long = `3Dプリンタ監視ツール:${host}`;
    return long.length <= 30 ? long : `3Dプリンタ:${host}`;
  }

  testNotification(type) {
    this.notify(type, {});
  }

  testAllNotifications(interval = 500) {
    this.getTypes().forEach((type, idx) =>
      setTimeout(() => this.notify(type), idx * interval)
    );
  }

  /**
   * 通知設定編集UIを生成・バインドします。
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
    const saveBtn = document.createElement("button");
    saveBtn.textContent = "保存";
    saveBtn.addEventListener("click", () => {
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
    container.appendChild(saveBtn);

    // (E) 読み上げ設定フィールド
    const ttsFs = document.createElement("fieldset");
    ttsFs.className = "tts-settings";
    ttsFs.style.cssText = "margin-top:1em;padding:0.5em;border:1px solid #ccc;border-radius:4px;";
    ttsFs.innerHTML = `
      <legend>読み上げ設定</legend>
      <label><input type="radio" name="tts-voice" value="female"> 女声</label>
      <label style="margin-left:1em;"><input type="radio" name="tts-voice" value="male"> 男声</label>
      <div style="margin:0.5em 0;">
        <label for="tts-rate">速度：</label>
        <input type="range" id="tts-rate" min="0.5" max="3" step="0.1">
        <span id="tts-rate-value"></span>
      </div>
      <button id="tts-save-btn">読み上げ設定を保存</button>
    `;
    container.appendChild(ttsFs);
    
    // UI に現在値を反映
    ttsFs.querySelector(`input[name="tts-voice"][value="${this.ttsVoice}"]`).checked = true;
    const rateInput = ttsFs.querySelector("#tts-rate");
    const rateValue = ttsFs.querySelector("#tts-rate-value");
    rateInput.value = this.ttsRate;
    rateValue.textContent = this.ttsRate.toFixed(1);
    
    // イベントバインド
    rateInput.addEventListener("input", e => {
      rateValue.textContent = parseFloat(e.target.value).toFixed(1);
    });
    ttsFs.querySelector("#tts-save-btn")
      .addEventListener("click", () => {
        const voice = ttsFs.querySelector(`input[name="tts-voice"]:checked`).value;
        const rate  = parseFloat(rateInput.value);
        this.setTtsVoice(voice);
        this.setTtsRate(rate);
        showAlert("読み上げ設定を保存しました", "success");
      });


  }
}



/* ------------------------------------------------------------------
 * シングルトンとしてエクスポート
 * ------------------------------------------------------------------ */
export const notificationManager = new NotificationManager();
