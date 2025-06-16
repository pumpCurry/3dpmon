"use strict";

import {
  getSpools,
  getCurrentSpoolId,
  getSpoolById,
  setCurrentSpoolId,
  addSpool,
  updateSpool,
  deleteSpool,
  getMaterialDensity,
  lengthFromWeight,
  weightFromLength
} from "./dashboard_spool.js";
import { showInputDialog } from "./dashboard_ui_confirm.js";
import { showConfirmDialog } from "./dashboard_ui_confirm.js";
import { MATERIAL_SPECS } from "./material_specs.js";

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
          <label>直径(mm)<input id="sd-diameter" type="number" step="0.01" value="1.75"></label>
          <label>総長(mm)<input id="sd-total" type="number" step="0.1"></label>
          <label>総重量(g)<input id="sd-weight" type="number" step="0.1"></label>
          <label>残り長(mm)<input id="sd-remain" type="number" step="0.1"></label>
      const matSel     = dialog.querySelector("#sd-material");
      const diaIn      = dialog.querySelector("#sd-diameter");
      const totalIn    = dialog.querySelector("#sd-total");
      const weightIn   = dialog.querySelector("#sd-weight");
      const remainIn   = dialog.querySelector("#sd-remain");

      nameInput.value = sp.name || "";
      matSel.value    = sp.material || "PLA";
      diaIn.value     = sp.diameterMm ?? 1.75;
      totalIn.value   = sp.totalLengthMm ?? "";
      weightIn.value  = sp.weightGram ?? "";
      remainIn.value  = sp.remainingLengthMm ?? sp.totalLengthMm ?? "";
      function dia(){ return parseFloat(diaIn.value) || 1.75; }

      let prevTotal = totalIn.value;
        const w = Math.round(weightFromLength(len, dens(), dia()));
        if (remainIn.value === prevTotal || remainIn.value === "") {
          remainIn.value = totalIn.value;
        }
        prevTotal = totalIn.value;
        const len = Math.round(lengthFromWeight(w, dens(), dia()));
        if (remainIn.value === prevTotal || remainIn.value === "") {
          remainIn.value = totalIn.value;
        }
        prevTotal = totalIn.value;
      diaIn.addEventListener("input", () => {
        if (document.activeElement === weightIn) updateLength();
        else updateWeight();
      });
          diameterMm: Number(diaIn.value) || 1.75,
      if (sp.diameterMm && sp.diameterMm !== 1.75) txt += `, ø${sp.diameterMm}mm`;
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

  /**
   * 現在選択中のスプール情報をプレビューに反映する。
   *
   * @param {Object} sp - スプールデータ
   * @param {string} [sp.color] - プレビュー用のフィラメント色文字列
   * @param {number} [sp.totalLengthMm] - スプール全体の長さ [mm]
   * @param {number} [sp.filamentDiameter] - フィラメント径 [mm]
   * @param {string} [sp.name] - スプール名
   * @param {string} [sp.material] - 材質名
   * @param {number} [sp.remainingLengthMm] - 残り長さ [mm]
   * @returns {void}
   */
  function updatePreview(sp) {
    const fp = window.filamentPreview;
    if (!fp || !sp) return;

    if (sp.color) fp.setOption("filamentColor", sp.color);
    if (typeof sp.totalLengthMm === "number")
      fp.setOption("filamentTotalLength", sp.totalLengthMm);
    if (typeof sp.filamentDiameter === "number")
      fp.setOption("filamentDiameter", sp.filamentDiameter);
    if (sp.name) {
      fp.setOption("reelName", sp.name);
      fp.setOption("showReelName", true);
    }
    if (sp.material) {
      fp.setOption("materialName", sp.material);
      fp.setOption("showMaterialName", true);
    } else {
      fp.setOption("showMaterialName", false);
    }
    if (typeof sp.remainingLengthMm === "number")
      fp.setRemainingLength(sp.remainingLengthMm);
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
        updatePreview(sp);
        render();
      });
      const edit = document.createElement("button");
      edit.textContent = "編集";
      edit.addEventListener("click", async () => {
        const res = await showSpoolDialog(sp);
        if (res) { updateSpool(sp.id, res); render(); }
/*
        const result = await showSpoolDialog({ title: "スプール編集", spool: sp });
        if (!result) return;
        updateSpool(sp.id, result);
        render();
*/
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
/*
  addBtn.addEventListener("click", async () => {
    const result = await showSpoolDialog({ title: "スプール追加" });
    if (!result || !result.name) return;
    addSpool(result);
    render();
  });
*/

  render();
}
