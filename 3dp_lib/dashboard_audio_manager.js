/**
 * @fileoverview
 * 3Dプリンタ監視ツール 3dpmon 用 Audio 管理モジュール
 * dashboard_audio_manager.js
 * (c) pumpCurry 2025
 * -----------------------------------------------------------
 * @module dashboard_audio_manager
 *
 * 【機能内容サマリ】
 * - 初回操作検知後に無音テストを実行
 * - 音声再生・音声合成の許可状態を管理
 * - UI ボタンから再生制御と状態表示
 * - 任意音声ファイルの再生サポート
 *
 * 【公開関数一覧】
 * - {@link AudioManager}：音声管理クラス
 * - {@link audioManager}：共有インスタンス
 *
 * @version 1.390.0
 * @since   v1.390.0
 */

"use strict";

/**
 * AudioManager クラス：
 * 音声の再生、音声合成の確認テスト、音声の許可状態を管理
 */
export class AudioManager {
  constructor() {
    /** @type {boolean} 初回操作を検知したか */
    this.c = false;
    /** @type {boolean} 無音MP3再生テスト成功フラグ */
    this.Tm = false;
    /** @type {boolean} 無声Utteranceテスト成功フラグ */
    this.Tv = false;
    /** @type {boolean} 音楽再生許可 */
    this.Am = true;
    /** @type {boolean} 音声発声許可 */
    this.Av = true;

    /** @type {HTMLElement|null} オーバーレイDOM */
    this.overlay = null;
    /** @type {HTMLElement|null} カウント表示DOM */
    this.countEl = null;
    /** @type {number} カウント秒 */
    this.countdown = 8;
    /** @type {number|null} タイマーID */
    this.countTimer = null;

    /** @type {HTMLButtonElement|null} 音楽トグルボタン */
    this.btnMusic = null;
    /** @type {HTMLButtonElement|null} 音声トグルボタン */
    this.btnVoice = null;

    this._setupOverlay();
    this._setupButtons();
    this._startWaiting();
  }

  /**
   * UIテンプレートからオーバーレイを設置
   * @private
   */
  _setupOverlay() {
    const tmpl = document.getElementById("audio-unlock-template");
    if (!tmpl) return;
    this.overlay = tmpl.content.firstElementChild.cloneNode(true);
    this.overlay.querySelector("p").innerHTML = `どこでもタップして<br>オーディオテストを開始`;
    this.countEl = this.overlay.querySelector("#unlock-count");
    document.body.append(this.overlay);
  }

  /**
   * トグルボタンUIを生成し画面に挿入
   * @private
   */
  _setupButtons() {
    const container = document.createElement("div");
    container.id = "audio-test-controls";
    container.style.cssText = `
      position:fixed; bottom:10px; right:10px;
      display:flex; gap:8px; z-index:1001;
    `;

    this.btnMusic = document.createElement("button");
    this.btnMusic.textContent = "🎶";
    this.btnMusic.addEventListener("click", () => this._onMusicClick());

    this.btnVoice = document.createElement("button");
    this.btnVoice.textContent = "🗣";
    this.btnVoice.addEventListener("click", () => this._onVoiceClick());

    container.append(this.btnMusic, this.btnVoice);

    const titleRight = document.querySelector(".title-bar .right");
    (titleRight || document.body).append(container);

    this._updateButtons();
  }

  /**
   * 初回ユーザー操作またはタイムアウト後にテストを起動
   * @private
   */
  _startWaiting() {
    const onFirst = () => {
      this.c = true;
      this._cleanupWaiting();
      this._runTests();
    };
    document.body.addEventListener("pointerdown", onFirst, { once: true });

    this.countTimer = setInterval(() => {
      this.countdown--;
      if (this.countEl) this.countEl.textContent = this.countdown;
      if (this.countdown <= 0) {
        this._cleanupWaiting();
        if (!this.c) this._runTests();
      }
    }, 1000);
  }

  /**
   * テストオーバーレイとタイマーを除去
   * @private
   */
  _cleanupWaiting() {
    if (this.overlay) this.overlay.remove();
    clearInterval(this.countTimer);
  }

  /**
   * 音楽と音声の再生テストを順次実行
   * @private
   */
  async _runTests() {
    console.log("[_runTest] テスト実施中");
    await this._testMusic();
    await this._testVoice();
    this._updateButtons();
  }

  /**
   * サイレント WAV を再生して音楽再生機能の可否をテストします。
   *
   * @private
   * @returns {Promise<boolean>} 再生成功で true、失敗で false
   */
  _testMusic() {
  return new Promise((resolve) => {
    // 44 バイトだけの超短 WAV（サイレント）
    const silentWav =
      "data:audio/wav;base64," +
      "UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA=";
    const audio = new Audio(silentWav);
    console.debug("[_testMusic] WAV canPlayType:", audio.canPlayType('audio/wav; codecs="1"'));

    audio.volume = 0.01;

    audio.onended = () => {
      this.Tm = true;
      console.log("[_testMusic] 再生成功（onended）");
      resolve(true);
    };
    audio.onerror = (e) => {
      this.Tm = false;
      console.error("[_testMusic] 再生エラー（onerror）:", e);
      resolve(false);
    };

    audio.play()
      .then(() => console.debug("[_testMusic] play() 開始成功"))
      .catch((err) => {
        this.Tm = false;
        console.error("[_testMusic] play() 失敗:", err);
        resolve(false);
      });
  });
}




  /**
   * 無音MP3を使って音楽再生の可否をテストします。
   * - 成功時: Tm=true, resolve(true)
   * - 失敗時: Tm=false, resolve(false)
   * - 再生開始、成功、失敗は console にログ出力されます。
   *
   * @private
   * @returns {Promise<boolean>} 再生成功で true、失敗で false
   */
  _testMusic_old() {
    return new Promise((resolve) => {
      const silentMp3_05 = "data:audio/mp3;base64,//uQZAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAACAAACcQCA" +
                        "AMEZAAAACAAADSAAAAEsAAABhAAABEVNTRwAAAA8AAAAQAAACAAACcQCA" +
                        "AMEZAAAACAAADSAAAAEsAAABhAAAAD3cAADhAAAABAAADSAAAAEsAAABh" +
                        "AAAAD2wAADhAAAABAAADSAAAAEsAAABhAAAAD28AADhAAAABAAADSAAAA" +
                        "EsAAABhAAAAD3wAADhAAAABAAADSAAAAEsAAABhAAAAD6QAADhAAAABAA" +
                        "ADSAAAAEsAAABhAAAAD6wAADhAAAABAAAD/4QxAAD/8QwA";

      const silentMp3 = "data:audio/mp3;base64,//uQZAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAACAAACcQCA"
                        "AMEZAAAACAAADSAAAAEsAAABhAAABEVNTRwAAAA8AAAAQAAACAAACcQCA"
                        "AMEZAAAACAAADSAAAAEsAAABhAAAADwAAADhAAAABAAADSAAAAEsAAABh"
                        "AAAADwAAADhAAAABAAADSAAAAEsAAABhAAAADwAAADhAAAABAAADSAAAA"
                        "EsAAABhAAAADwAAADhAAAABAAADSAAAAEsAAABhAAAADwAAADhAAAABAA"
                        "ADSAAAAEsAAABhAAAADwAAADhAAAABAAADSAAAAEsAAABhAAAADwAAADh"
                        "AAAABAAADSAAAAEsAAABhAAAADwAAADhAAAABAAADSAAAAEsAAABhAAAB"
                        "D4AAADhAAAABAAADSAAAAEsAAABhAAABD4AAADhAAAABAAADSAAAAEsAA"
                        "ABhAAABD4AAADhAAAABAAADSAAAAEsAAABhAAABD4AAADhAAAABAAADSAA"
                        "AAEsAAABhAAABD4AAADhAAAABAAADSAAAAEsAAABhAAABD4AAADhAAAABA"
                        "AAD/4QxAAD/8QwA";
  
      const audio = new Audio(silentMp3);
      audio.volume = 0.01;
  
      audio.onended = () => {
        this.Tm = true;
        console.log("[_testMusic] 再生成功（onended）");
        resolve(true);
      };
  
      audio.onerror = (e) => {
        this.Tm = false;
        console.error("[_testMusic] 再生エラー（onerror）:", e);
        resolve(false);
      };
  
      audio.play()
        .then(() => {
          console.debug("[_testMusic] play() 開始成功");
        })
        .catch((err) => {
          this.Tm = false;
          console.error("[_testMusic] play() 失敗:", err);
          resolve(false);
        });
    });
  }
  
  /**
   * 無声Utteranceを使って音声合成の可否をテストします。
   * - 成功時: Tv=true, resolve(true)
   * - 失敗時: Tv=false, resolve(false)
   * - speak() が例外を投げた場合も失敗として処理されます。
   *
   * @private
   * @returns {Promise<boolean>} 発声成功で true、失敗で false
   */
  _testVoice() {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) {
        this.Tv = false;
        console.warn("[_testVoice] speechSynthesis API 未対応");
        return resolve(false);
      }
  
      const utter = new SpeechSynthesisUtterance("ー");
      utter.volume = 0.01;
  
      utter.onend = () => {
        this.Tv = true;
        console.log("[_testVoice] 発声成功（onend）");
        resolve(true);
      };
  
      utter.onerror = (e) => {
        this.Tv = false;
        console.error("[_testVoice] 発声エラー（onerror）:", e);
        resolve(false);
      };
  
      try {
        speechSynthesis.speak(utter);
        console.debug("[_testVoice] speak() 呼び出し成功");
      } catch (err) {
        this.Tv = false;
        console.error("[_testVoice] speak() 例外:", err);
        resolve(false);
      }
    });
  }

  /**
   * @fileoverview
   * AudioManager クラスのトグル・テスト・許可状態関連メソッド定義
   * - ボタン押下時の再テスト or トグル切替
   * - 状態に応じた CSS クラスと data-status の更新
   * - 音楽・音声それぞれに isXXXAllowed() チェックAPIを提供
   * 
   * @version 1.0
   * @module dashboard_audio_manager
   */
  
  /**
   * トグルボタンの状態を更新（ステータス属性とCSSクラス）
   * - テスト未実行：青（"blue"）
   * - テスト失敗：赤（"red"）
   * - テスト成功＋許可あり：緑（"green"）
   * - テスト成功＋許可なし：中立（"neutral"）
   * @private
   */
  _updateButtons() {
    console.log("[_updateButtons] ）");
    this.btnMusic.dataset.status = this.Tm
      ? (this.Am ? "green" : "neutral")
      : (this.Tm === false && this.c ? "red" : "blue");
  
    this.btnVoice.dataset.status = this.Tv
      ? (this.Av ? "green" : "neutral")
      : (this.Tv === false && this.c ? "red" : "blue");
  
    this._applyOverlay(this.btnMusic);
    this._applyOverlay(this.btnVoice);
  }
  
  /**
   * ステータス属性に応じてボタンに状態CSSクラス（青/赤/緑）を適用
   * @private
   * @param {HTMLButtonElement} btn - 対象ボタン要素
   */
  _applyOverlay(btn) {
    const s = btn.dataset.status;
    btn.classList.toggle("status-blue",  s === "blue");
    btn.classList.toggle("status-red",   s === "red");
    btn.classList.toggle("status-green", s === "green");
  }
  
  /**
   * 音楽ボタン押下時の処理
   * - テスト未通過の場合：再テストを実行し、結果に応じてUIを更新
   * - テスト通過済みの場合：許可フラグをトグルし、UIを更新
   * @private
   */
  _onMusicClick() {
    if (!this.Tm) {
      this._testMusic().then(() => this._updateButtons());
    } else {
      this.Am = !this.Am;
      this._updateButtons();
    }
  }
  
  /**
   * 音声ボタン押下時の処理
   * - テスト未通過の場合：再テストを実行し、結果に応じてUIを更新
   * - テスト通過済みの場合：許可フラグをトグルし、UIを更新
   * @private
   */
  _onVoiceClick() {
    if (!this.Tv) {
      this._testVoice().then(() => this._updateButtons());
    } else {
      this.Av = !this.Av;
      this._updateButtons();
    }
  }
  
  /**
   * 音楽の再生が許可されているかを返す
   * @returns {boolean} Am=true かつ Tm=true の場合に true
   */
  isMusicAllowed() {
    return this.Am && this.Tm;
  }
  
  /**
   * 音声合成が許可されているかを返す
   * @returns {boolean} Av=true かつ Tv=true の場合に true
   */
  isVoiceAllowed() {
    return this.Av && this.Tv;
  }


  /**
   * 任意の音声ソースを再生する。
   * - 音量は1.0で固定（必要なら将来的に this.volume 追加可）
   * - 成功・失敗・完了時にデバッグログを出力
   *
   * @param {string} src - 再生する音源（ローカルファイル、URL、dataURIなど）
   * @returns {Promise<void>|undefined}
   */
  play(src) {
    console.debug(`[audioManager] play requested → ${src}`);
    const audio = new Audio(src);
    audio.volume = 1.0;

    const p = audio.play();
    if (p && p.then) {
      p.then(() => console.debug(`[audioManager] playback started → ${src}`))
       .catch(err => console.debug(`[audioManager] playback failed → ${src}`, err));
    }

    audio.onended = () => {
      console.debug(`[audioManager] playback ended → ${src}`);
    };
    audio.onerror = (e) => {
      console.debug(`[audioManager] playback error → ${src}`, e);
    };

    return p;
  }

  /**
   * 任意のテキストを音声合成で読み上げます。
   *
   * - Web Speech API (`speechSynthesis`) を使用して読み上げを行います。
   * - 読み上げ中に別の呼び出しが来た場合、既存の発話を中断可能（オプション制御）。
   * - 各種オプション（音量、話速、ピッチ、言語）を指定可能。
   * - 実行結果は Promise で通知され、成功時に resolve、失敗時に reject。
   *
   * @param {string} text - 読み上げる内容（プレーンテキスト）
   * @param {Object} [options={}] - 読み上げオプション
   * @param {number} [options.volume=1.0] - 音量（0.0〜1.0）
   * @param {number} [options.rate=1.0] - 話速（0.1〜10.0）
   * @param {number} [options.pitch=1.0] - 音の高さ（0.0〜2.0）
   * @param {string} [options.lang="ja-JP"] - 言語コード（例: "ja-JP", "en-US"）
   * @param {boolean} [options.cancelPrevious=true] - 前回の読み上げを中断するか（将来、機器ごと切替予定）
   * @returns {Promise<void>} 読み上げ完了まで待機できる Promise（失敗時は reject）
   */
  speak(text, options = {}) {
    console.debug(`[audioManager] speak requested → "${text}"`, options);

    if (!("speechSynthesis" in window)) {
      const err = new Error("speechSynthesis is not supported by this browser.");
      console.warn("[audioManager] speechSynthesis 非対応");
      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      const {
        volume = 1.0,
        rate = 1.0,
        pitch = 1.0,
        lang = "ja-JP",
        cancelPrevious = true
      } = options;

      // 将来的に機器ごとの制御を追加予定: if (this.allowSpeakInterrupt) ...
      if (cancelPrevious && speechSynthesis.speaking) {
        console.debug("[audioManager] 既存の読み上げをキャンセル中");
        speechSynthesis.cancel();
      }

      const utter = new SpeechSynthesisUtterance(text);
      utter.volume = volume;
      utter.rate   = rate;
      utter.pitch  = pitch;
      utter.lang   = lang;

      utter.onend = () => {
        console.debug(`[audioManager] speak ended → "${text}"`);
        resolve();
      };

      utter.onerror = (e) => {
        console.error(`[audioManager] speak error → "${text}"`, e);
        reject(e);
      };

      try {
        speechSynthesis.speak(utter);
        console.debug("[audioManager] speak() 呼び出し成功");
      } catch (e) {
        console.error("[audioManager] speak() 例外:", e);
        reject(e);
      }
    });
  }



}

/**
 * AudioManager のシングルトンインスタンス。
 * アプリケーション全体で再利用可。
 * @type {AudioManager}
 */
export const audioManager = new AudioManager();

