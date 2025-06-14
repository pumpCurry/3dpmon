"use strict";

import {
  getSpools,
  getCurrentSpoolId,
  setCurrentSpoolId,
  addSpool,
  updateSpool,
  deleteSpool
} from "./dashboard_spool.js";
import { showConfirmDialog } from "./dashboard_ui_confirm.js";

let styleInjected = false;
function injectStyles() {
  if (styleInjected) return;
  styleInjected = true;
  const css = `
.spool-dialog-overlay {
  position: fixed; top:0; left:0; width:100vw; height:100vh;
  background: rgba(0,0,0,0.5); display:flex;
  align-items:center; justify-content:center; z-index:2000;
}
.spool-dialog {
  background:#fff; border-radius:8px; width:90%; max-width:400px;
  box-shadow:0 2px 12px rgba(0,0,0,0.4); padding:16px;
  display:flex; flex-direction:column; gap:8px;
}
.spool-dialog h3 { margin:0; font-size:1.2em; }
.spool-dialog label { font-size:14px; display:flex; flex-direction:column; }
.spool-dialog input { padding:6px; font-size:14px; }
.spool-dialog-buttons { display:flex; justify-content:flex-end; gap:8px; }
.spool-dialog-buttons button { padding:6px 12px; font-size:14px; }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
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
        remainingLengthMm: parseFloat(remainInput.value) || 0
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

document.addEventListener("DOMContentLoaded", initSpoolUI);

function initSpoolUI() {
  const listEl = document.getElementById("spool-list");
  const addBtn = document.getElementById("spool-add-btn");
  if (!listEl || !addBtn) return;

  function render() {
    const spools = getSpools();
    listEl.innerHTML = "";
    spools.forEach(sp => {
      const li = document.createElement("li");
      li.textContent = `${sp.name} (${sp.remainingLengthMm}/${sp.totalLengthMm} mm)`;
      if (sp.id === getCurrentSpoolId()) {
        li.style.fontWeight = "bold";
      }
      const sel = document.createElement("button");
      sel.textContent = "選択";
      sel.addEventListener("click", () => {
        setCurrentSpoolId(sp.id);
        render();
      });
      const edit = document.createElement("button");
      edit.textContent = "編集";
      edit.addEventListener("click", async () => {
        const result = await showSpoolDialog({ title: "スプール編集", spool: sp });
        if (!result) return;
        updateSpool(sp.id, result);
        render();
      });
      const del = document.createElement("button");
      del.textContent = "削除";
      del.addEventListener("click", () => {
        if (confirm("削除しますか?")) {
          deleteSpool(sp.id);
          render();
        }
      });
      li.append(" ", sel, edit, del);
      listEl.appendChild(li);
    });
  }

  addBtn.addEventListener("click", async () => {
    const result = await showSpoolDialog({ title: "スプール追加" });
    if (!result || !result.name) return;
    addSpool(result);
    render();
  });

  render();
}
