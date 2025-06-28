/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 コマンド送信UIモジュール
 * @file dashboard_send_command.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_send_command
 *
 * 【機能内容サマリ】
 * - WebSocket メソッドをボタンに紐付け
 * - 入力検証や確認ダイアログを介した安全な送信
 *
 * 【公開関数一覧】
 * - {@link initializeCommandPalette}：主要ボタン設定
 * - {@link initializeRateControls}：レート変更UI初期化
 * - {@link initSendRawJson}：任意JSON送信用UI
 * - {@link initSendGcode}：G-code送信用UI
 * - {@link initTestRawJson}：テストデータ送信用UI
 *
* @version 1.390.517 (PR #237)
* @since   1.390.193 (PR #86)
* @lastModified 2025-06-28 15:00:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

import {
  getDeviceIp,
  sendCommand,
  sendGcodeCommand,
  simulateReceivedJson
} from "./dashboard_connection.js";
import { currentHostname, getDisplayValue } from "./dashboard_data.js";
import { showInputDialog, showConfirmDialog } from "./dashboard_ui_confirm.js";
import { showAlert } from "./dashboard_notification_manager.js";
import { pushLog } from "./dashboard_log_util.js";


/**
 * 各コマンドボタンの設定マッピング
 * @type {Array<{
 *   buttonId: string,
 *   method: string,
 *   getParams: () => object|null,
 *   inputIds?: string[],
 *   confirm?: import("./dashboard_ui_confirm.js").ConfirmOptions|((params: any)=>import("./dashboard_ui_confirm.js").ConfirmOptions)
 * }>}
 */
const COMMAND_MAPPINGS = [
  {
    buttonId: "btn-get-status",
    method:   "get",
    getParams: () => ["nozzleTemp", "bedTemp0"]
  },
  {
    buttonId: "btn-print-file",
    method:   "print",
    inputIds: ["cmd-print-filepath"],
    getParams: () => {
      const el = document.getElementById("cmd-print-filepath");
      const path = el?.value.trim();
      return path ? { file: path } : null;
    }
  },
  {
    buttonId: "btn-stop-print", //☆OK
    method:   "set",
    getParams: () => ({ stop: 1 }),
    confirm: {
      level: "warn",
      title: "印刷停止(stop)の確認",
      message: "途中再開できません。本当に停止しますか？",
      confirmText: "停止(stop)",
      cancelText:  "キャンセル"
    }
  },
  {
    buttonId: "btn-pause-print", //☆OK
    method:   "set",
    getParams: () => ({ pause: 1 }),
    confirm: {
      level: "warn",
      title: "印刷一時停止(pause)の確認",
      message: "一時停止後は再開指示が必要です。本当に一時停止しますか？",
      confirmText: "一時停止(pause)",
      cancelText:  "キャンセル"
    }
  },
  {
    buttonId: "btn-resume-print", //☆OK
    method:   "set",
    getParams: () => ({ pause: 0 }),
    confirm: {
      level: "warn",
      title: "印刷再開(resume)の確認",
      message: "印刷中・停止中には実施不可です。本当に再開しますか？",
      confirmText: "再開(resume)",
      cancelText:  "キャンセル"
    }
  },
  {
    buttonId: "btn-history-list", // ☆OK
    method:   "get",
    getParams: () => ({ reqHistory: 1 })
  },
  {
    buttonId: "btn-file-list", // ☆OK
    method:   "get",
    getParams: () => ({ reqGcodeFile: 1 })
  },
  {
    buttonId: "btn-autohome",
    method:   "autoHome",
    getParams: () => ({}),
    confirm: {
      level: "warn",
      title: "ホーム復帰(autoHome)の確認",
      message: "印刷中には実施できません。本当に実行しますか？",
      confirmText: "ホーム復帰(autoHome)",
      cancelText:  "キャンセル"
    }
  },
  {
    buttonId: "btn-ack-error",
    method:   "set",
    getParams: () => ({ cleanErr: 1 })
  },
  {
    buttonId: "btn-autolevel",
    method:   "autoLevel",
    getParams: () => ({}),
    confirm: {
      level: "warn",
      title: "ベッドレベリング(autoLevel)の確認",
      message: "印刷中には実施できません。本当に実行しますか？",
      confirmText: "ベッドレベリング(autoLevel)",
      cancelText:  "キャンセル"
    }
  },
  {
    buttonId: "btn-run-gcode",
    method:   "runGcode",
    inputIds: ["cmd-gcode-cmd"],
    getParams: () => {
      const el = document.getElementById("cmd-gcode-cmd");
      const cmd = el?.value.trim();
      return cmd ? { cmd } : null;
    },
    confirm: params => ({
      level: "warn",
      title: "Gコード実行(runGcode)の確認",
      message: `G-code を実行します: "${params.cmd}"。よろしいですか？`,
      confirmText: "実行",
      cancelText:  "キャンセル"
    })
  },
  {
    buttonId: "btn-delete-file",
    method:   "deleteFile",
    inputIds: ["cmd-delete-path"],
    getParams: () => {
      const el = document.getElementById("cmd-delete-path");
      const path = el?.value.trim();
      return path ? { path } : null;
    },
    confirm: {
      level: "error",
      title: "ファイル削除の警告",
      message: "削除すると復元できません。本当に削除しますか？",
      confirmText: "削除",
      cancelText:  "キャンセル"
    }
  },
  {
    buttonId: "btn-upload-file",
    method:   "uploadFile",
    inputIds: ["cmd-upload-path","cmd-upload-data"],
    getParams: () => {
      const pathEl = document.getElementById("cmd-upload-path");
      const dataEl = document.getElementById("cmd-upload-data");
      const path = pathEl?.value.trim();
      const data = dataEl?.value;
      return path && data ? { path, data } : null;
    }
  },
  {
    buttonId: "btn-elapse-video-list",
    method:   "elapseVideoList",
    getParams: () => ({})
  },
  {
    buttonId: "btn-upgrade-firmware",
    method:   "upgradeFirmware",
    getParams: () => ({})
  },
  {
    buttonId: "btn-factory-reset",
    method:   "factoryReset",
    getParams: () => ({}),
    confirm: {
      level: "error",
      title: "工場リセットの警告",
      message: "全設定が初期化されます。本当に実行しますか？",
      confirmText: "リセット",
      cancelText:  "キャンセル"
    }
  },
  {
    buttonId: "btn-set-led",
    method:   "set",
    inputIds: ["cmd-led-state"],
    getParams: () => {
      const el = document.getElementById("cmd-led-state");
      return el ? { lightSw: el.value === "true" ? 1 : 0 } : null;
    }
  },
  {
    buttonId: "btn-set-nozzle-temp",
    method:   "set",
    inputIds: ["cmd-nozzle-temp"],
    getParams: () => {
      const el = document.getElementById("cmd-nozzle-temp");
      const v = parseFloat(el?.value);
      return !isNaN(v) ? { targetNozzleTemp: v } : null;
    }
  },
  {
    buttonId: "btn-set-bed-temp",
    method:   "set",
    inputIds: ["cmd-bed-temp"],
    getParams: () => {
      const el = document.getElementById("cmd-bed-temp");
      const v = parseFloat(el?.value);
      return !isNaN(v) ? { targetBedTemp0: v } : null;
    }
  },
  {
    buttonId: "btn-set-model-fan",
    method:   "set",
    inputIds: ["cmd-fan-model-state"],
    getParams: () => {
      const el = document.getElementById("cmd-fan-model-state");
      return el ? { fan: el.value === "true" ? 1 : 0 } : null;
    }
  },
  {
    buttonId: "btn-set-aux-fan",
    method:   "set",
    inputIds: ["cmd-fan-aux-state"],
    getParams: () => {
      const el = document.getElementById("cmd-fan-aux-state");
      return el ? { fanAuxiliary: el.value === "true" ? 1 : 0 } : null;
    }
  }
];

/**
 * コマンドパレットの全ボタンにイベントをバインドします。
 * - getParams() の戻り値が null のときはボタンを disabled
 * - 確認が必要な場合は showConfirmDialog を介して実行
 */
export function initializeCommandPalette() {
  COMMAND_MAPPINGS.forEach(({ buttonId, method, getParams, inputIds, confirm }) => {
    const btn = document.getElementById(buttonId);
    if (!btn) {
      console.warn(`initializeCommandPalette: ボタン要素 '${buttonId}' が見つかりません`);
      return;
    }
    // バリデーション関数
    const validate = () => { btn.disabled = getParams() === null; };
    validate();
    (inputIds || []).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("input", validate);
    });

    btn.addEventListener("click", async () => {
      const params = getParams();
      if (!params) {
        showAlert(`パラメータ未入力または不正です [${buttonId}]`, "error");
        return;
      }
      // 確認ダイアログ
      if (confirm) {
        const opts = typeof confirm === "function" ? confirm(params) : confirm;
        const ok = await showConfirmDialog(opts);
        if (!ok) return;
      }
      console.debug("▶ sendCommand", method, params);
      sendCommand(method, params, currentHostname);
    });
  });
  
  initializeFanControls();
  initializeTempControls();
  initializeRateControls();
}

/**
 * ファン／LED トグル & スライダー制御を初期化します
 *
 * • トグル（change）→ {"method":"set","params":{param:0|1}}
 * • スライダー（mouseup）→ {"method":"set","params":{"gcodeCmd":"M106 P<p> S<s>"}} 
 */
function initializeFanControls() {
  // ── トグルのみ 0/1 を送る
  const toggles = [
    { id: "modelFanToggle2",    param: "fan" },            // モデルファン
    { id: "backFanToggle2",     param: "fanCase" },        // ケースファン
    { id: "sideFanToggle2",     param: "fanAuxiliary" },   // 側面ファン
    { id: "ledToggle2",         param: "lightSw" },        // LED照明
    { id: "aiSwToggle",         param: "aiSw" },           // 印刷前自動調整
    { id: "aiDetectionToggle",  param: "aiDetection" },    // 異常出力検知
    { id: "aiFirstFloorToggle", param: "aiFirstFloor" },   // 初層出力確認
    { id: "aiPausePrintToggle", param: "aiPausePrint" }    // 異常時一時停止
  ];
  toggles.forEach(({ id, param }) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", () => {
      const v = el.checked ? 1 : 0;
      sendCommand("set", { [param]: v }, currentHostname);
    });
  });

  // ── スライダーで 0–100% 指定 → G-code M106 P<p> S<s> 送信
  //    P: ファン番号 (0=モデル,1=ケース,2=側面)
  const sliders = [
    { id: "modelFanSlider",      p: 0, displayId: "modelFanSliderValue" },
    { id: "caseFanSlider",       p: 1, displayId: "caseFanSliderValue" },
    { id: "auxiliaryFanSlider",  p: 2, displayId: "auxiliaryFanSliderValue" }
  ];
  sliders.forEach(({ id, p, displayId }) => {
    const slider = document.getElementById(id);
    const display = document.getElementById(displayId);
    if (!slider || !display) return;
    // input 中は％表示だけ更新
    slider.addEventListener("input", () => {
      const v = slider.value;
      const span = display.querySelector(".value");
      if (span) span.textContent = v;
    });
    // マウスアップ（＝ドラッグ終了）で実際に送信
    slider.addEventListener("mouseup", () => {
      const pct = Number(slider.value);
      // 0–255 に丸め
      const s = Math.round(pct * 255 / 100);
      const cmd = `M106 P${p} S${s}`;
      sendCommand("set", { gcodeCmd: cmd }, currentHostname);
    });
  });
}

/**
 * ノズル／ベッド温度コントロールの初期化
 *
 * - スライダーは 0–max（max は DOM の data-field="maxXXX" から取得）
 * - テキストボックスは同じ範囲、Enter or blur で送信
 * - 双方向同期で無限ループを防止
 */
function initializeTempControls() {
  const configs = [
    {
      sliderId:  "nozzleTempSlider",
      inputId:   "nozzleTempInput",
      sendBtnId: "nozzleTempSendBtn",
      maxField:  "[data-field=\"maxNozzleTemp\"] .value",
      makePayload: v => ({ nozzleTempControl: v })
    },
    {
      sliderId:  "bedTempSlider",
      inputId:   "bedTempInput",
      sendBtnId: "bedTempSendBtn",
      maxField:  "[data-field=\"maxBedTemp\"] .value",
      makePayload: v => ({ bedTempControl: { num: 0, val: v } })
    }
  ];

  configs.forEach(({ sliderId, inputId, sendBtnId, maxField, makePayload }) => {
    const slider  = document.getElementById(sliderId);
    const input   = document.getElementById(inputId);
    const sendBtn = document.getElementById(sendBtnId);
    if (!slider || !input || !sendBtn) return;

    // 無限ループ防止用フラグ
    let fromSlider = false;
    let fromInput  = false;
    // 直近送信タイムスタンプ
    let lastSend = 0;

    /**
     * 入力値を検証して送信するヘルパー
     *
     * @private
     * @param {number} [forceVal] - 強制的に送信する値（省略時は input の値）
     */
    const sendValue = (forceVal) => {
      let v = forceVal != null ? forceVal : parseInt(input.value, 10);
      if (isNaN(v)) {
        v = Number(slider.min);
      }
      v = Math.min(Math.max(v, Number(slider.min)), Number(slider.max));
      slider.value = v;
      input.value  = v;
      sendCommand("set", makePayload(v), currentHostname);
      lastSend = Date.now();
    };

    // ① max を設定
    const maxText = document.querySelector(maxField)?.textContent;
    const maxVal  = parseFloat(maxText);
    if (!isNaN(maxVal)) {
      slider.max = maxVal;
      input.max  = maxVal;
    }

    // ② スライダー操作 → テキストに反映
    slider.addEventListener("input", () => {
      fromSlider = true;
      input.value = slider.value;
      fromSlider = false;
    });

    // ③ スライダーを離した(change) → send
    slider.addEventListener("change", () => {
      const v = Math.round(+slider.value);
      sendValue(v);
    });

    // ④ テキストで Enter → blur に飛ばす
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        input.blur();
      }
    });

    // ⑤ テキスト blur → validate → スライダー反映＆send
    input.addEventListener("blur", () => {
      sendValue();
    });

    // フォーカス復帰でクールダウン解除
    input.addEventListener("focus", () => {
      lastSend = 0;
    });

    // ⏎ ボタンクリックで送信（3秒クールダウン）
    sendBtn.addEventListener("click", () => {
      if (Date.now() - lastSend >= 3000) {
        sendValue();
      }
    });

    // ⑥ （オプション）外部 updateStoredDataToDOM で温度変化が来たら
    //     双方向同期をキープするため、ここでテキスト＋スライダーを更新しても OK
    //     （fromSlider/fromInput で send を防いでいるので無限ループしません）
  });
}

/**
 * @function initializeRateControls
 * @description
 *   印刷速度（フィードレート）とフィラメントフロー率のスライダーおよび数値入力を初期化し、
 *   ユーザー操作に応じてサーバーへ設定を送信します。
 *
 *   - スライダー操作中（input イベント）に隣接する数値入力欄をリアルタイム更新
 *   - スライダー操作完了（change イベント）でサーバーへ送信
 *   - 数値入力欄で Enter キー押下 → blur で確定
 *   - blur 時に範囲チェック ＆ スライダー同期 → サーバーへ送信
 */
export function initializeRateControls() {
  // 各制御に対応する要素IDと送信パラメータの設定
  const configs = [
    {
      sliderId:     "feedrateSlider",
      inputId:      "feedrateInput",
      sendBtnId:    "feedrateSendBtn",
      presetClass:  "feedrate-preset",
      param:        "setFeedratePct"
    },
    {
      sliderId:     "flowrateSlider",
      inputId:      "flowrateInput",
      sendBtnId:    "flowrateSendBtn",
      presetClass:  "flowrate-preset",
      param:        "curFlowratePct"
    }
  ];

  configs.forEach(({ sliderId, inputId, sendBtnId, presetClass, param }) => {
    const slider = document.getElementById(sliderId);
    const input  = document.getElementById(inputId);
    const sendBtn = document.getElementById(sendBtnId);
    const presets = document.querySelectorAll(`.${presetClass}`);
    if (!slider || !input || !sendBtn) return; // 要素が見つからなければ無視

    let lastSend = 0; // 直近送信タイムスタンプ

    /**
     * 入力値を検証して送信するヘルパー
     *
     * @private
     * @param {number} [forceVal] - 強制的に送信する値（省略時は input の値）
     */
    const sendValue = (forceVal) => {
      let v = forceVal != null ? forceVal : parseInt(input.value, 10);
      if (isNaN(v)) {
        v = Number(slider.min);
      }
      v = Math.min(Math.max(v, Number(slider.min)), Number(slider.max));
      slider.value = v;
      input.value  = v;
      sendCommand("set", { [param]: v }, currentHostname);
      lastSend = Date.now();
    };

    // スライダーを動かしている間、数値入力欄にも反映
    slider.addEventListener("input", () => {
      input.value = slider.value;
    });

    // スライダーの操作完了後（change）にサーバに送信
    slider.addEventListener("change", () => {
      const v = Math.round(Number(slider.value));
      sendValue(v);
    });

    // 数値入力欄で Enter を押すと blur で確定
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        input.blur();
      }
    });

    // blur 時に値を適正範囲内に丸め、スライダーと同期、そしてサーバへ送信
    input.addEventListener("blur", () => {
      sendValue();
    });

    // フォーカス復帰でクールダウン解除
    input.addEventListener("focus", () => {
      lastSend = 0;
    });

    // ⏎ ボタンクリックで送信（3秒クールダウン）
    sendBtn.addEventListener("click", () => {
      if (Date.now() - lastSend >= 3000) {
        sendValue();
      }
    });

    // プリセットボタン
    presets.forEach(btn => {
      const val = parseInt(btn.dataset.value, 10);
      if (isNaN(val)) return;
      btn.addEventListener("click", () => {
        input.value  = String(val);
        slider.value = String(val);
        sendValue(val);
      });
    });
  });
}

/**
 * 「JSON送信」ボタンの設定とハンドラ登録
 */
export function initSendRawJson() {
  const btn = document.getElementById("btn-send-raw-json");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    // 1) 接続先チェック
    const ip = getDeviceIp();
    if (!ip) {
      showAlert("接続先が未設定です。先に接続してください。", "error");
      return;
    }

    // 2) JSON入力ダイアログ（Ctrl+Enterで確定）
    let jsonStr = await showInputDialog({
      level:             "info",
      title:             "Raw JSON コマンド入力",
      message:           "送信したい JSON を入力してください。\n（Ctrl+Enter で送信）",
      multiline:         true,
      placeholder:       `{"method":"set","params":{}}`,
      defaultValue:      "",
      submitOnCtrlEnter: true,
      confirmText:       "OK",
      cancelText:        "キャンセル"
    });
    if (jsonStr == null) return;  // キャンセル

    // 3) 構文チェック→エラーなら再入力
    while (true) {
      let cmd;
      try {
        cmd = JSON.parse(jsonStr);
      } catch (e) {
        await showAlert("JSON 構文エラー: " + e.message, "error");
        const again = await showInputDialog({
          level:             "warn",
          title:             "JSON 再入力",
          message:           "正しい JSON を入力してください。\n（Ctrl+Enter で送信）",
          multiline:         true,
          placeholder:       `{"method":"set","params":{}}`,
          defaultValue:      jsonStr,
          submitOnCtrlEnter: true,
          confirmText:       "OK",
          cancelText:        "キャンセル"
        });
        if (again == null) return;
        jsonStr = again;
        continue;
      }

      // 4) 確認ダイアログ
      const ok = await showConfirmDialog({
        level:       "info",
        title:       "送信確認",
        html:        `<pre style="white-space:pre-wrap;">${jsonStr}</pre>`,
        confirmText: "送信",
        cancelText:  "編集に戻る"
      });
      if (!ok) {
        const again = await showInputDialog({
          level:             "info",
          title:             "Raw JSON 編集",
          message:           "送信する JSON を編集してください。\n（Ctrl+Enter で送信）",
          multiline:         true,
          placeholder:       `{"method":"set","params":{}}`,
          defaultValue:      jsonStr,
          submitOnCtrlEnter: true,
          confirmText:       "OK",
          cancelText:        "キャンセル"
        });
        if (again == null) return;
        jsonStr = again;
        continue;
      }

      // 5) 送信＆ログ出力
      pushLog(`送信(Raw JSON): ${jsonStr}`, "send");
      if (cmd.method) {
        try {
          await sendCommand(cmd.method, cmd.params ?? {}, currentHostname);
        } catch {
          // sendCommand 内でエラー表示済み
        }
      } else {
        showAlert("`method` プロパティが必要です。", "error");
      }
      break;
    }
  });
}

/**
 * "G-code送信" ボタンの設定とハンドラ登録
 */
export function initSendGcode() {
  const btn = document.getElementById("btn-send-gcode");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    const ip = getDeviceIp();
    if (!ip) {
      await showConfirmDialog({
        level: "error",
        title: "接続エラー",
        message: "接続先が未設定です。先に接続してください。",
        confirmText: "OK",
        cancelText: ""
      });
      return;
    }

    let gcode = await showInputDialog({
      level: "info",
      title: "G-code 入力",
      message: "送信したい G-code を入力してください。",
      placeholder: "M104 S200",
      defaultValue: "",
      submitOnEnter: true,
      confirmText: "OK",
      cancelText: "キャンセル"
    });
    if (gcode == null) return;

    while (true) {
      if (gcode.includes('"')) {
        gcode = await showInputDialog({
          level: "error",
          title: "G-code 再入力",
          message: "G-code に \" は使用できません。再入力してください。",
          placeholder: "M104 S200",
          defaultValue: gcode,
          submitOnEnter: true,
          confirmText: "OK",
          cancelText: "キャンセル"
        });
        if (gcode == null) return;
        continue;
      }

      const payload = {
        id: `set_gcode_${Date.now()}`,
        method: "set",
        params: { gcodeCmd: gcode }
      };
      const ok = await showConfirmDialog({
        level: "info",
        title: "送信確認",
        html: `<pre style="white-space:pre-wrap;">${JSON.stringify(payload)}</pre>`,
        confirmText: "送信",
        cancelText: "編集に戻る"
      });
      if (!ok) {
        gcode = await showInputDialog({
          level: "info",
          title: "G-code 編集",
          message: "送信する G-code を編集してください。",
          placeholder: "M104 S200",
          defaultValue: gcode,
          submitOnEnter: true,
          confirmText: "OK",
          cancelText: "キャンセル"
        });
        if (gcode == null) return;
        continue;
      }

      pushLog(`送信(G-code): ${gcode}`, "send");
      try {
        await sendGcodeCommand(gcode, currentHostname);
      } catch {
        // sendGcodeCommand 内でエラー表示済み
      }
      break;
    }
  });
}

/**
 * "JSONコマンドテスト" ボタンの設定とハンドラ登録
 * 指定テキストボックスの内容を受信メッセージとして処理します。
 */
export function initTestRawJson() {
  const btn = document.getElementById("btn-test-raw-json");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    let jsonStr = await showInputDialog({
      level: "info",
      title: "JSONテスト入力",
      message: "受信JSONとして扱う文字列を入力してください。",
      multiline: true,
      placeholder: "{\"id\":\"xxx\"}",
      defaultValue: "",
      submitOnCtrlEnter: true,
      confirmText: "OK",
      cancelText: "キャンセル"
    });
    if (jsonStr == null) return;

    while (true) {
      try {
        JSON.parse(jsonStr);
      } catch (e) {
        jsonStr = await showInputDialog({
          level: "error",
          title: "JSON再入力",
          message: `JSON 構文エラー: ${e.message}`,
          multiline: true,
          placeholder: "{\"id\":\"xxx\"}",
          defaultValue: jsonStr,
          submitOnCtrlEnter: true,
          confirmText: "OK",
          cancelText: "キャンセル"
        });
        if (jsonStr == null) return;
        continue;
      }
      simulateReceivedJson(jsonStr);
      break;
    }
  });
}

/**
 * "一時停止時 原点復帰" ボタンの設定とハンドラ登録
 *
 * @function initPauseHome
 * @returns {void}
 */
export function initPauseHome() {
  const btn = document.getElementById("btn-pause-home");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    const model = getDisplayValue("model")?.value;
    if (model !== "K1 Max") {
      showAlert("K1 Max 以外では使用できません", "error");
      return;
    }

    const ok = await showConfirmDialog({
      level: "warn",
      title: "印刷一時停止時の原点復帰と座標修正の実行",
      message: "印刷一時停止時に原点を再検出し、印刷待機位置に戻すを実行します。\n印刷一時停止時以外に実行しないでください。実施してよろしいですか?",
      confirmText: "原点復帰の実行",
      cancelText: "キャンセル"
    });
    if (!ok) return;

    try {
      await sendGcodeCommand("G28 X Y", currentHostname);
      await sendGcodeCommand("G0 X296.50 Y153.00 F6000", currentHostname);
    } catch {
      // sendGcodeCommand 内でエラー表示済み
    }
  });
}