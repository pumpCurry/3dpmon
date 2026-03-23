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
 * - マルチプリンタ対応: パネル単位の状態管理（モジュールシングルトン排除）
 *
 * 【公開関数一覧】
 * - {@link initializeCommandPalette}：主要ボタン設定
 * - {@link initializeRateControls}：レート変更UI初期化
 * - {@link initSendRawJson}：任意JSON送信用UI
 * - {@link initSendGcode}：G-code送信用UI
 * - {@link initTestRawJson}：テストデータ送信用UI
 *
 * @version 1.390.788 (PR #366)
 * @since   1.390.193 (PR #86)
 * @lastModified 2026-03-11 02:00:00
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
import { getDisplayValue, monitorData } from "./dashboard_data.js";
import { showInputDialog, showConfirmDialog } from "./dashboard_ui_confirm.js";
import { showAlert } from "./dashboard_notification_manager.js";
import { pushLog } from "./dashboard_log_util.js";

/**
 * パネルルート内の要素を検索するヘルパーを生成する。
 * @private
 * @param {HTMLElement|null} root - パネル本体要素
 * @returns {(id: string) => HTMLElement|null}
 */
function _makeFinder(root) {
  return (id) => {
    if (!root) return null;
    return root.querySelector(`[id$="__${id}"]`) || root.querySelector(`#${id}`);
  };
}

/**
 * コマンドパレットの全ボタンにイベントをバインドする。
 * パネル単位で呼び出され、root と hostname はクロージャで保持される。
 *
 * @param {HTMLElement} root - パネル本体要素
 * @param {string} hostname  - 送信先ホスト名
 */
export function initializeCommandPalette(root, hostname) {
  const findById = _makeFinder(root);
  const host = hostname || null;

  /**
   * 各コマンドボタンの設定マッピング
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
        const el = findById("cmd-print-filepath");
        const path = el?.value.trim();
        return path ? { file: path } : null;
      }
    },
    {
      buttonId: "btn-stop-print",
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
      buttonId: "btn-pause-print",
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
      buttonId: "btn-resume-print",
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
      buttonId: "btn-history-list",
      method:   "get",
      getParams: () => ({ reqHistory: 1 })
    },
    {
      buttonId: "btn-file-list",
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
        const el = findById("cmd-gcode-cmd");
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
        const el = findById("cmd-delete-path");
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
        const pathEl = findById("cmd-upload-path");
        const dataEl = findById("cmd-upload-data");
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
        const el = findById("cmd-led-state");
        return el ? { lightSw: el.value === "true" ? 1 : 0 } : null;
      }
    },
    {
      buttonId: "btn-set-nozzle-temp",
      method:   "set",
      inputIds: ["cmd-nozzle-temp"],
      getParams: () => {
        const el = findById("cmd-nozzle-temp");
        const v = parseFloat(el?.value);
        return !isNaN(v) ? { targetNozzleTemp: v } : null;
      }
    },
    {
      buttonId: "btn-set-bed-temp",
      method:   "set",
      inputIds: ["cmd-bed-temp"],
      getParams: () => {
        const el = findById("cmd-bed-temp");
        const v = parseFloat(el?.value);
        return !isNaN(v) ? { targetBedTemp0: v } : null;
      }
    },
    {
      buttonId: "btn-set-model-fan",
      method:   "set",
      inputIds: ["cmd-fan-model-state"],
      getParams: () => {
        const el = findById("cmd-fan-model-state");
        return el ? { fan: el.value === "true" ? 1 : 0 } : null;
      }
    },
    {
      buttonId: "btn-set-aux-fan",
      method:   "set",
      inputIds: ["cmd-fan-aux-state"],
      getParams: () => {
        const el = findById("cmd-fan-aux-state");
        return el ? { fanAuxiliary: el.value === "true" ? 1 : 0 } : null;
      }
    }
  ];

  COMMAND_MAPPINGS.forEach(({ buttonId, method, getParams, inputIds, confirm }) => {
    const btn = findById(buttonId);
    if (!btn) return;

    const validate = () => { btn.disabled = getParams() === null; };
    validate();
    (inputIds || []).forEach(id => {
      const el = findById(id);
      if (el) el.addEventListener("input", validate);
    });

    btn.addEventListener("click", async () => {
      const params = getParams();
      if (!params) {
        showAlert(`パラメータ未入力または不正です [${buttonId}]`, "error");
        return;
      }
      if (confirm) {
        const opts = typeof confirm === "function" ? confirm(params) : confirm;
        const ok = await showConfirmDialog(opts);
        if (!ok) return;
      }
      console.debug("▶ sendCommand", method, params);
      sendCommand(method, params, host);
    });
  });

  _initializeFanControls(root, host);
  _initializeTempControls(root, host);
  _initializeRateControls(root, host);
}

/**
 * ファン／LED トグル & スライダー制御を初期化する。
 * パネルルート内の要素を検索する。
 *
 * @private
 * @param {HTMLElement} root - パネル本体要素
 * @param {string|null} host - ホスト名
 */
function _initializeFanControls(root, host) {
  const find = (id) => root ? (root.querySelector(`[id$="__${id}"]`) || root.querySelector(`#${id}`)) : null;

  const toggles = [
    { id: "modelFanToggle2",    param: "fan" },
    { id: "backFanToggle2",     param: "fanCase" },
    { id: "sideFanToggle2",     param: "fanAuxiliary" },
    { id: "ledToggle2",         param: "lightSw" },
    { id: "aiSwToggle",         param: "aiSw" },
    { id: "aiDetectionToggle",  param: "aiDetection" },
    { id: "aiFirstFloorToggle", param: "aiFirstFloor" },
    { id: "aiPausePrintToggle", param: "aiPausePrint" }
  ];
  toggles.forEach(({ id, param }) => {
    const el = find(id);
    if (!el) return;
    el.addEventListener("change", () => {
      const v = el.checked ? 1 : 0;
      sendCommand("set", { [param]: v }, host);
    });
  });

  const sliders = [
    { id: "modelFanSlider",      p: 0, displayId: "modelFanSliderValue" },
    { id: "caseFanSlider",       p: 1, displayId: "caseFanSliderValue" },
    { id: "auxiliaryFanSlider",  p: 2, displayId: "auxiliaryFanSliderValue" }
  ];
  sliders.forEach(({ id, p, displayId }) => {
    const slider = find(id);
    const display = find(displayId);
    if (!slider || !display) return;
    slider.addEventListener("input", () => {
      const v = slider.value;
      const span = display.querySelector(".value");
      if (span) span.textContent = v;
    });
    slider.addEventListener("change", () => {
      const pct = Number(slider.value);
      const s = Math.round(pct * 255 / 100);
      const cmd = `M106 P${p} S${s}`;
      sendCommand("set", { gcodeCmd: cmd }, host);
    });
  });
}

/**
 * ノズル／ベッド温度コントロールの初期化。
 * パネルルート内の要素を検索する。
 *
 * @private
 * @param {HTMLElement} root - パネル本体要素
 * @param {string|null} host - ホスト名
 */
function _initializeTempControls(root, host) {
  const find = (id) => root ? (root.querySelector(`[id$="__${id}"]`) || root.querySelector(`#${id}`)) : null;

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
    const slider  = find(sliderId);
    const input   = find(inputId);
    const sendBtn = find(sendBtnId);
    if (!slider || !input || !sendBtn) return;

    let fromSlider = false;
    let fromInput  = false;
    let lastSend = 0;

    const sendValue = (forceVal) => {
      let v = forceVal != null ? forceVal : parseInt(input.value, 10);
      if (isNaN(v)) v = Number(slider.min);
      v = Math.min(Math.max(v, Number(slider.min)), Number(slider.max));
      slider.value = v;
      input.value  = v;
      sendCommand("set", makePayload(v), host);
      lastSend = Date.now();
    };

    const maxEl = root ? root.querySelector(maxField) : null;
    const maxText = maxEl?.textContent;
    const maxVal  = parseFloat(maxText);
    if (!isNaN(maxVal)) {
      slider.max = maxVal;
      input.max  = maxVal;
    }

    slider.addEventListener("input", () => {
      fromSlider = true;
      input.value = slider.value;
      fromSlider = false;
    });
    slider.addEventListener("change", () => {
      sendValue(Math.round(+slider.value));
    });
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") input.blur();
    });
    input.addEventListener("blur", () => sendValue());
    input.addEventListener("focus", () => { lastSend = 0; });
    sendBtn.addEventListener("click", () => {
      if (Date.now() - lastSend >= 3000) sendValue();
    });
  });
}

/**
 * レート制御の初期化。
 * パネルルート内の要素を検索する。
 *
 * @private
 * @param {HTMLElement} root - パネル本体要素
 * @param {string|null} host - ホスト名
 */
function _initializeRateControls(root, host) {
  const find = (id) => root ? (root.querySelector(`[id$="__${id}"]`) || root.querySelector(`#${id}`)) : null;
  const findAll = (cls) => root ? root.querySelectorAll(`.${cls}`) : [];

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
    const slider  = find(sliderId);
    const input   = find(inputId);
    const sendBtn = find(sendBtnId);
    const presets = findAll(presetClass);
    if (!slider || !input || !sendBtn) return;

    let lastSend = 0;

    const sendValue = (forceVal) => {
      let v = forceVal != null ? forceVal : parseInt(input.value, 10);
      if (isNaN(v)) v = Number(slider.min);
      v = Math.min(Math.max(v, Number(slider.min)), Number(slider.max));
      slider.value = v;
      input.value  = v;
      sendCommand("set", { [param]: v }, host);
      lastSend = Date.now();
    };

    slider.addEventListener("input", () => { input.value = slider.value; });
    slider.addEventListener("change", () => { sendValue(Math.round(Number(slider.value))); });
    input.addEventListener("keydown", e => { if (e.key === "Enter") input.blur(); });
    input.addEventListener("blur", () => sendValue());
    input.addEventListener("focus", () => { lastSend = 0; });
    sendBtn.addEventListener("click", () => {
      if (Date.now() - lastSend >= 3000) sendValue();
    });

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
 * 後方互換のエクスポート。
 * パネルシステムでは initializeCommandPalette 内で自動呼び出しされるため、
 * 外部から直接呼ぶ必要はない。
 *
 * @param {HTMLElement} [root] - パネル本体要素
 * @param {string} hostname - ホスト名
 */
export function initializeRateControls(root, hostname) {
  _initializeRateControls(root || null, hostname || null);
}

/**
 * 「JSON送信」ボタンの設定とハンドラ登録
 * @param {HTMLElement} [root] - パネル本体要素
 * @param {string} hostname - ホスト名
 */
export function initSendRawJson(root, hostname) {
  const btn = root
    ? (root.querySelector(`[id$="__btn-send-raw-json"]`) || root.querySelector("#btn-send-raw-json"))
    : document.getElementById("btn-send-raw-json");
  if (!btn) return;
  const host = hostname || null;

  btn.addEventListener("click", async () => {
    const ip = getDeviceIp(host);
    if (!ip) {
      showAlert("接続先が未設定です。先に接続してください。", "error");
      return;
    }

    const displayName = monitorData.machines[host]?.storedData?.hostname?.rawValue || host || ip;
    let jsonStr = await showInputDialog({
      level:             "info",
      title:             `Raw JSON コマンド入力 → ${displayName}`,
      message:           "送信したい JSON を入力してください。\n（Ctrl+Enter で送信）",
      multiline:         true,
      placeholder:       `{"method":"set","params":{}}`,
      defaultValue:      "",
      submitOnCtrlEnter: true,
      confirmText:       "OK",
      cancelText:        "キャンセル"
    });
    if (jsonStr == null) return;

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

      pushLog(`送信(Raw JSON): ${jsonStr}`, "send", false, host);
      if (cmd.method) {
        try {
          await sendCommand(cmd.method, cmd.params ?? {}, host);
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
 * @param {HTMLElement} [root] - パネル本体要素
 * @param {string} hostname - ホスト名
 */
export function initSendGcode(root, hostname) {
  const btn = root
    ? (root.querySelector(`[id$="__btn-send-gcode"]`) || root.querySelector("#btn-send-gcode"))
    : document.getElementById("btn-send-gcode");
  if (!btn) return;
  const host = hostname || null;

  btn.addEventListener("click", async () => {
    const ip = getDeviceIp(host);
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

    const gcDisplayName = monitorData.machines[host]?.storedData?.hostname?.rawValue || host || ip;
    let gcode = await showInputDialog({
      level: "info",
      title: `G-code 入力 → ${gcDisplayName}`,
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

      pushLog(`送信(G-code): ${gcode}`, "send", false, host);
      try {
        await sendGcodeCommand(gcode, host);
      } catch {
        // sendGcodeCommand 内でエラー表示済み
      }
      break;
    }
  });
}

/**
 * "JSONコマンドテスト" ボタンの設定とハンドラ登録
 * @param {HTMLElement} [root] - パネル本体要素
 * @param {string} hostname - ホスト名
 */
export function initTestRawJson(root, hostname) {
  const btn = root
    ? (root.querySelector(`[id$="__btn-test-raw-json"]`) || root.querySelector("#btn-test-raw-json"))
    : document.getElementById("btn-test-raw-json");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    const host = hostname || null;
    const testDisplayName = monitorData.machines[host]?.storedData?.hostname?.rawValue || host || "(テスト)";
    let jsonStr = await showInputDialog({
      level: "info",
      title: `JSONテスト入力 → ${testDisplayName}`,
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
 * @param {HTMLElement} [root] - パネル本体要素
 * @param {string} hostname - ホスト名
 */
export function initPauseHome(root, hostname) {
  const btn = root
    ? (root.querySelector(`[id$="__btn-pause-home"]`) || root.querySelector("#btn-pause-home"))
    : document.getElementById("btn-pause-home");
  if (!btn) return;
  const host = hostname || null;

  btn.addEventListener("click", async () => {
    const model = getDisplayValue("model", host)?.value;
    const validModels = ["K1 Max", "K1", "K1C", "K1A"];
    if (!validModels.includes(model)) {
      showAlert("K1/K1C/K1A/K1 Max 以外では使用できません", "error");
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
      if (model === "K1 Max") {
        await sendGcodeCommand(
          "G28 X Y\nG0 X296.50 Y153.00 F6000\n",
          host
        );
      } else if (["K1", "K1C", "K1A"].includes(model)) {
        await sendGcodeCommand(
          "G28 X Y\nG0 X219.00 Y113.50 F6000\n",
          host
        );
      }
    } catch {
      // sendGcodeCommand 内でエラー表示済み
    }
  });
}

/**
 * "XYロック解除" ボタンの設定とハンドラ登録
 * @param {HTMLElement} [root] - パネル本体要素
 * @param {string} hostname - ホスト名
 */
export function initXYUnlock(root, hostname) {
  const btn = root
    ? (root.querySelector(`[id$="__btn-xy-unlock"]`) || root.querySelector("#btn-xy-unlock"))
    : document.getElementById("btn-xy-unlock");
  if (!btn) return;
  const host = hostname || null;

  btn.addEventListener("click", async () => {
    const ok = await showConfirmDialog({
      level: "warn",
      title: "XY軸ステッピングモーターロックの解除",
      message:
        "ヘッドを手で動かせないとき、ステッピングモーターでのXY軸ロックを解除します。\n" +
        "印刷一時停止時以外に実行しないでください。\n" +
        "再びロックする必要がある際は、原点復帰ボタンを押すとロックできます。\n" +
        "実施してよろしいですか?",
      confirmText: "XY軸ロック解除の実行",
      cancelText: "キャンセル"
    });
    if (!ok) return;

    try {
      await sendGcodeCommand("M84", host);
    } catch {
      // sendGcodeCommand 内でエラー表示済み
    }
  });
}
