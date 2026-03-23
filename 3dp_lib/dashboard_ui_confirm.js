/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 モーダルUIユーティリティ
 * @file dashboard_ui_confirm.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_ui_confirm
 *
 * 【機能内容サマリ】
 * - 確認ダイアログと入力ダイアログを提供
 * - アイコン付きレベル表示
 *
 * 【公開関数一覧】
 * - {@link showConfirmDialog}：確認モーダル
 * - {@link showInputDialog}：入力モーダル
 *
 * @version 1.390.317 (PR #143)
 * @since   1.390.193 (PR #86)
 * @lastModified 2025-06-19 22:38:18
 * -----------------------------------------------------------
 * @todo
 * - none
 */
"use strict";

/** @type {{icon:string,color:string}} レベルごとのアイコンとカラー定義 */
const LEVEL_CONFIG = {
  info:    { icon: "ℹ️",  color: "#2f86eb" },
  warn:    { icon: "⚠️", color: "#e6a23c" },
  warnRed: { icon: "⚠️", color: "#f56c6c" },
  error:   { icon: "❌", color: "#f56c6c" },
  success: { icon: "✅", color: "#67c23a" }
};

let styleInjected = false;

/**
 * モーダル/ダイアログ用の動的 z-index カウンター。
 * 新しいオーバーレイを生成するたびにインクリメントし、
 * 常に最新のダイアログが最前面に表示される。
 * ベース値 5000 から開始し、閉じたら戻す。
 * @type {number}
 */
let _zIndexCounter = 5000;
/** 最初の呼び出し時に必要な CSS を document.head に注入 */
function injectStyles() {
  // CSS は 3dp_panel.css に移行済み（Phase 1-C）
  // この関数は後方互換性のために残す
}


/** @typedef {object} ConfirmOptions
 *  @property {"info"|"warn"|"warnRed"|"error"|"success"} [level="warn"] - タイプ
 *  @property {string} title                                 - タイトル
 *  @property {string} [message]                             - プレーンテキスト
 *  @property {string} [html]                                - HTML を直接レンダリングする場合
 *  @property {string} [confirmText]   // 肯定側ボタン
 *  @property {string} [middleText]    // 第3ボタン（optional）
 *  @property {string} [cancelText]    // 否定側ボタン
 *  @returns {Promise<true|false|"middle">}
 */

/**
 * 確認ダイアログを表示します。
 * @param {ConfirmOptions} options
 */
export function showConfirmDialog({
  level       = "warn",
  title       = "",
  message     = "",
  html        = "",
  confirmText,
  middleText,
  cancelText
}) {
  injectStyles();

  // ボタン未指定なら OK-only
  if (!confirmText && !middleText && !cancelText) {
    confirmText = "OK";
  }

  return new Promise(resolve => {
    const { icon, color } = LEVEL_CONFIG[level] || LEVEL_CONFIG.warn;

    // オーバーレイ（動的 z-index で常に最前面）
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.style.zIndex = String(++_zIndexCounter);
    document.body.appendChild(overlay);

    // ダイアログ
    const dlg = document.createElement("div");
    dlg.className = "confirm-dialog";
    overlay.appendChild(dlg);

    // ヘッダー
    const header = document.createElement("div");
    header.className = "confirm-header";
    header.style.backgroundColor = color;
    header.style.color = "#fff";
    header.innerHTML = `<span class="confirm-icon">${icon}</span>
                        <span class="confirm-title">${title}</span>`;
    dlg.appendChild(header);

    // 本文
    const body = document.createElement("div");
    body.className = "confirm-body";
    if (message) {
      const p = document.createElement("p");
      p.textContent = message;
      body.appendChild(p);
    }
    if (html) {
      const container = document.createElement("div");
      container.innerHTML = html;
      body.appendChild(container);
    }
    dlg.appendChild(body);

    // ボタン
    const btns = document.createElement("div");
    btns.className = "confirm-buttons";
    dlg.appendChild(btns);

    // 左：confirmText
    if (confirmText) {
      const btnConfirm = document.createElement("button");
      btnConfirm.className = "confirm-button confirm-destructive";
      btnConfirm.textContent = confirmText;
      btnConfirm.style.color = color;
      btnConfirm.addEventListener("click", () => {
        cleanup(); resolve(true);
      });
      btns.appendChild(btnConfirm);
    }

    // 中央：middleText
    if (middleText) {
      const btnMiddle = document.createElement("button");
      btnMiddle.className = "confirm-button confirm-safe";
      btnMiddle.textContent = middleText;
      btnMiddle.addEventListener("click", () => {
        cleanup(); resolve("middle");
      });
      btns.appendChild(btnMiddle);
    }

    // 右：cancelText
    if (cancelText) {
      const btnCancel = document.createElement("button");
      btnCancel.className = "confirm-button confirm-safe";
      btnCancel.textContent = cancelText;
      btnCancel.addEventListener("click", () => {
        cleanup(); resolve(false);
      });
      btns.appendChild(btnCancel);
    }

    function cleanup() {
      document.body.removeChild(overlay);
      _zIndexCounter--;
    }
  });
}


/////////////////////////

/**
 * @typedef {Object} InputDialogOptions
 *  @property {"info"|"warn"|"warnRed"|"error"|"success"} [level="info"]
 *  @property {string} title
 *  @property {string} [message]
 *  @property {string} [html]
 *  @property {boolean} [multiline=false]      - 複数行入力なら true
 *  @property {string} [placeholder=""]
 *  @property {string} [defaultValue=""]
 *  @property {boolean} [submitOnEnter=false]      - Enter で確定するか
 *  @property {boolean} [submitOnCtrlEnter=false]  - Ctrl+Enter で確定するか
 *  @property {string} [confirmText="OK"]
 *  @property {string} [cancelText="キャンセル"]
 *  @returns {Promise<string|null>}
 */

/**
 * 入力付きダイアログを表示します。
 * @param {InputDialogOptions} options
 */
export function showInputDialog({
  level             = "info",
  title             = "",
  message           = "",
  html              = "",
  multiline         = false,
  placeholder       = "",
  defaultValue      = "",
  submitOnEnter     = false,
  submitOnCtrlEnter = false,
  confirmText       = "OK",
  cancelText        = "キャンセル"
}) {
  injectStyles();
  return new Promise(resolve => {
    const { icon, color } = LEVEL_CONFIG[level] || LEVEL_CONFIG.info;

    // オーバーレイ＋ダイアログ本体（動的 z-index で常に最前面）
    const overlay = document.createElement("div");
    overlay.className = "input-dialog-overlay";
    overlay.style.zIndex = String(++_zIndexCounter);
    document.body.appendChild(overlay);
    const dlg = document.createElement("div");
    dlg.className = "input-dialog";
    overlay.appendChild(dlg);

    // ヘッダー
    const header = document.createElement("div");
    header.className = "input-dialog-header";
    header.style.backgroundColor = color;
    header.innerHTML = `<span class="icon">${icon}</span><span class="title">${title}</span>`;
    dlg.appendChild(header);

    // 本文説明
    if (message || html) {
      const bodyDesc = document.createElement("div");
      bodyDesc.className = "input-dialog-body";
      if (html) bodyDesc.innerHTML = message;
      else      bodyDesc.textContent = message;
      dlg.appendChild(bodyDesc);
    }

    // 入力欄
    const body = document.createElement("div");
    body.className = "input-dialog-body";
    const inputEl = multiline
      ? document.createElement("textarea")
      : document.createElement("input");
    if (!multiline) inputEl.type = "text";
    inputEl.className = "input-dialog-input";
    inputEl.placeholder = placeholder;
    inputEl.value       = defaultValue;
    body.appendChild(inputEl);
    dlg.appendChild(body);

    // ボタン群
    const btns = document.createElement("div");
    btns.className = "input-dialog-buttons";
    dlg.appendChild(btns);

    if (confirmText) {
      const btnOK = document.createElement("button");
      btnOK.className = "btn btn-primary";
      btnOK.innerText = confirmText;
      btnOK.addEventListener("click",  () => finish(inputEl.value));
      btns.appendChild(btnOK);
    }
    if (cancelText) {
      const btnCancel = document.createElement("button");
      btnCancel.className = "btn btn-secondary";
      btnCancel.innerText = cancelText;
      btnCancel.addEventListener("click", () => finish(null));
      btns.appendChild(btnCancel);
    }

    // キーハンドラ：Enter/Ctrl+Enter で確定 or 改行
    inputEl.addEventListener("keydown", e => {
      // Ctrl+Enter → 確定
      if (submitOnCtrlEnter && e.key==="Enter" && e.ctrlKey) {
        e.preventDefault(); finish(inputEl.value); return;
      }
      // Enter 単独で確定
      if (submitOnEnter && e.key==="Enter" && !e.ctrlKey) {
        e.preventDefault(); finish(inputEl.value); return;
      }
      // 複数行かつ Ctrl+Enter で改行
      if (multiline && submitOnEnter && e.key==="Enter" && e.ctrlKey) {
        e.preventDefault();
        const pos = inputEl.selectionStart;
        const v = inputEl.value;
        inputEl.value = v.slice(0,pos)+"\n"+v.slice(pos);
        inputEl.selectionStart = inputEl.selectionEnd = pos+1;
      }
    });

    inputEl.focus();

    function finish(result) {
      document.removeEventListener("keydown", finish);
      overlay.remove();
      _zIndexCounter--;
      resolve(result);
    }
  });
}
