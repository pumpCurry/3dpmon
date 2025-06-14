"use strict";

import {
  getSpools,
  getCurrentSpoolId,
  setCurrentSpoolId,
  addSpool,
  updateSpool,
  deleteSpool,
  getMaterialDensity,
  lengthFromWeight,
  weightFromLength
} from "./dashboard_spool.js";

document.addEventListener("DOMContentLoaded", initSpoolUI);

function initSpoolUI() {
  const listEl = document.getElementById("spool-list");
  const addBtn = document.getElementById("spool-add-btn");
  if (!listEl || !addBtn) return;

  function injectStyles() {
    if (document.getElementById("spool-dialog-style")) return;
    const css = `
    .spool-dialog-overlay{position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:2000;}
    .spool-dialog{background:#fff;border-radius:8px;width:90%;max-width:320px;box-shadow:0 2px 12px rgba(0,0,0,0.4);padding:16px;}
    .spool-dialog-header{font-size:18px;font-weight:bold;margin-bottom:8px;}
    .spool-dialog-body label{display:block;margin:8px 0;font-size:14px;}
    .spool-dialog-body input,.spool-dialog-body select{width:100%;box-sizing:border-box;padding:4px;margin-top:4px;}
    .spool-dialog-buttons{display:flex;justify-content:flex-end;margin-top:12px;}
    .spool-dialog-buttons button{margin-left:8px;}
    `;
    const style = document.createElement("style");
    style.id = "spool-dialog-style";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function showSpoolDialog(sp = {}) {
    injectStyles();
    return new Promise(res => {
      const overlay = document.createElement("div");
      overlay.className = "spool-dialog-overlay";
      const dialog = document.createElement("div");
      dialog.className = "spool-dialog";
      overlay.appendChild(dialog);
      dialog.innerHTML = `
        <div class="spool-dialog-header">スプール設定</div>
        <div class="spool-dialog-body">
          <label>名前<input id="sd-name"></label>
          <label>素材<select id="sd-material">
            <option value="PLA">PLA</option>
            <option value="PETG">PETG</option>
            <option value="ABS">ABS</option>
            <option value="TPU">TPU</option>
          </select></label>
          <label>総長(mm)<input id="sd-total" type="number"></label>
          <label>総重量(g)<input id="sd-weight" type="number"></label>
          <label>残り長(mm)<input id="sd-remain" type="number"></label>
        </div>
        <div class="spool-dialog-buttons">
          <button id="sd-ok">OK</button>
          <button id="sd-cancel">キャンセル</button>
        </div>`;
      document.body.appendChild(overlay);

      const nameInput = dialog.querySelector("#sd-name");
      const matSel    = dialog.querySelector("#sd-material");
      const totalIn   = dialog.querySelector("#sd-total");
      const weightIn  = dialog.querySelector("#sd-weight");
      const remainIn  = dialog.querySelector("#sd-remain");

      nameInput.value  = sp.name || "";
      matSel.value     = sp.material || "PLA";
      totalIn.value    = sp.totalLengthMm ?? "";
      weightIn.value   = sp.weightGram ?? "";
      remainIn.value   = sp.remainingLengthMm ?? sp.totalLengthMm ?? "";

      function dens(){ return getMaterialDensity(matSel.value); }

      function updateWeight(){
        const len = parseFloat(totalIn.value) || 0;
        const w = Math.round(weightFromLength(len, dens(), 1.75));
        weightIn.value = String(w);
      }

      function updateLength(){
        const w = parseFloat(weightIn.value) || 0;
        const len = Math.round(lengthFromWeight(w, dens(), 1.75));
        totalIn.value = String(len);
      }

      totalIn.addEventListener("input", updateWeight);
      weightIn.addEventListener("input", updateLength);
      matSel.addEventListener("change", () => {
        if (document.activeElement === weightIn) updateLength();
        else updateWeight();
      });

      dialog.querySelector("#sd-ok").addEventListener("click", () => {
        const result = {
          name: nameInput.value,
          material: matSel.value,
          totalLengthMm: Number(totalIn.value) || 0,
          weightGram: Number(weightIn.value) || 0,
          remainingLengthMm: Number(remainIn.value) || 0
        };
        overlay.remove();
        res(result);
      });

      dialog.querySelector("#sd-cancel").addEventListener("click", () => {
        overlay.remove();
        res(null);
      });
    });
  }

  function render() {
    const spools = getSpools();
    listEl.innerHTML = "";
    spools.forEach(sp => {
      const li = document.createElement("li");
      let txt = `${sp.name} (${sp.remainingLengthMm}/${sp.totalLengthMm} mm`;
      if (sp.weightGram) txt += `, ${sp.weightGram}g`;
      li.textContent = txt + ")";
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
        const res = await showSpoolDialog(sp);
        if (res) { updateSpool(sp.id, res); render(); }
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
      const res = await showSpoolDialog();
      if (res) { addSpool(res); render(); }
    });

  render();
}
