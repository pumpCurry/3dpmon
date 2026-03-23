/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 スプールUIモジュール
 * @file dashboard_spool_ui.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_spool_ui
 *
 * 【機能内容サマリ】
 * - スプール編集・選択ダイアログの表示
 *
 * 【公開関数一覧】
 * - {@link showSpoolDialog}：スプール編集ダイアログ
 * - {@link showSpoolSelectDialog}：スプール選択ダイアログ
 *
 * @version 1.390.759 (PR #366)
 * @since   1.390.193 (PR #86)
 * @lastModified 2026-03-12 00:00:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */
"use strict";

import { getSpools } from "./dashboard_spool.js";
import { showConfirmDialog } from "./dashboard_ui_confirm.js";

let styleInjected = false;
function injectStyles() {
  // CSS は 3dp_panel.css に移行済み（Phase 1-C）
  // この関数は後方互換性のために残す
}

function showSpoolDialog({ title = "", spool = {} }) {
  injectStyles();
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "spool-dialog-overlay";
    const dlg = document.createElement("div");
    dlg.className = "spool-dialog";
    overlay.appendChild(dlg);

    const h3 = document.createElement("h3");
    h3.textContent = title;
    dlg.appendChild(h3);

    const nameLabel = document.createElement("label");
    nameLabel.textContent = "スプール名";
    const nameInput = document.createElement("input");
    nameInput.value = spool.name || "";
    nameLabel.appendChild(nameInput);
    dlg.appendChild(nameLabel);

    const totalLabel = document.createElement("label");
    totalLabel.textContent = "総長(mm)";
    const totalInput = document.createElement("input");
    totalInput.type = "number";
    totalInput.value = spool.totalLengthMm ?? "";
    totalLabel.appendChild(totalInput);
    dlg.appendChild(totalLabel);

    const remainLabel = document.createElement("label");
    remainLabel.textContent = "残り長(mm)";
    const remainInput = document.createElement("input");
    remainInput.type = "number";
    remainInput.value = spool.remainingLengthMm ?? "";
    remainLabel.appendChild(remainInput);
    dlg.appendChild(remainLabel);

    const noteLabel = document.createElement("label");
    noteLabel.textContent = "メモ";
    const noteInput = document.createElement("input");
    noteInput.value = spool.note || "";
    noteLabel.appendChild(noteInput);
    dlg.appendChild(noteLabel);

    const favLabel = document.createElement("label");
    const favInput = document.createElement("input");
    favInput.type = "checkbox";
    favInput.checked = !!spool.isFavorite;
    favLabel.appendChild(favInput);
    favLabel.append(" お気に入り");
    dlg.appendChild(favLabel);

    const btns = document.createElement("div");
    btns.className = "spool-dialog-buttons";
    const btnOk = document.createElement("button");
    btnOk.textContent = "OK";
    const btnCancel = document.createElement("button");
    btnCancel.textContent = "キャンセル";
    btns.append(btnOk, btnCancel);
    dlg.appendChild(btns);

    document.body.appendChild(overlay);

    btnOk.addEventListener("click", () => {
      cleanup();
      resolve({
        name: nameInput.value.trim(),
        totalLengthMm: parseFloat(totalInput.value) || 0,
        remainingLengthMm: parseFloat(remainInput.value) || 0,
        isFavorite: favInput.checked,
        note: noteInput.value.trim()
      });
    });

    btnCancel.addEventListener("click", async () => {
      const ok = await showConfirmDialog({
        level: "warn",
        title: "確認",
        message: "編集中ですがキャンセルしてもよろしいですか?",
        confirmText: "はい",
        cancelText: "いいえ"
      });
      if (ok) { cleanup(); resolve(null); }
    });

    function cleanup() { overlay.remove(); }
  });
}

/**
 * スプール選択ダイアログを表示する。
 *
 * @function showSpoolSelectDialog
 * @param {Object} [opts]
 * @param {string} [opts.title=""] - ダイアログタイトル
 * @param {Array<Object>} [opts.spools=getSpools()] - 選択候補のスプール一覧
 * @returns {Promise<Object|null>} 選択されたスプール、キャンセル時は null
 */
function showSpoolSelectDialog({ title = "", spools = getSpools() } = {}) {
  injectStyles();
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "spool-dialog-overlay";
    const dlg = document.createElement("div");
    dlg.className = "spool-dialog";
    overlay.appendChild(dlg);

    const h3 = document.createElement("h3");
    h3.textContent = title;
    dlg.appendChild(h3);

    const select = document.createElement("select");
    spools.forEach(sp => {
      const opt = document.createElement("option");
      opt.value = sp.id;
      opt.textContent = `${sp.name} (${sp.remainingLengthMm}/${sp.totalLengthMm} mm)`;
      select.appendChild(opt);
    });
    dlg.appendChild(select);

    const btns = document.createElement("div");
    btns.className = "spool-dialog-buttons";
    const btnOk = document.createElement("button");
    btnOk.textContent = "OK";
    const btnCancel = document.createElement("button");
    btnCancel.textContent = "キャンセル";
    btns.append(btnOk, btnCancel);
    dlg.appendChild(btns);

    document.body.appendChild(overlay);

    btnOk.addEventListener("click", () => {
      const id = select.value;
      const sp = spools.find(s => String(s.id) === String(id)) || null;
      overlay.remove();
      resolve(sp);
    });
    btnCancel.addEventListener("click", () => {
      overlay.remove();
      resolve(null);
    });
  });
}

export { showSpoolDialog, showSpoolSelectDialog };
