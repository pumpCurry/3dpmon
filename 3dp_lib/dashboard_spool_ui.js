"use strict";

import {
  getSpools,
  getCurrentSpoolId,
  getSpoolById,
  setCurrentSpoolId,
  addSpool,
  updateSpool,
  deleteSpool
} from "./dashboard_spool.js";

document.addEventListener("DOMContentLoaded", initSpoolUI);

function initSpoolUI() {
  const listEl = document.getElementById("spool-list");
  const addBtn = document.getElementById("spool-add-btn");
  if (!listEl || !addBtn) return;

  /**
   * 現在選択中のスプール情報をプレビューに反映
   * @param {Object} sp スプールデータ
   */
  function updatePreview(sp) {
    const fp = window.filamentPreview;
    if (!fp || !sp) return;

    if (sp.color) fp.setOption("filamentColor", sp.color);
    if (typeof sp.totalLengthMm === "number")
      fp.setOption("filamentTotalLength", sp.totalLengthMm);
    if (typeof sp.diameterMm === "number")
      fp.setOption("filamentDiameter", sp.diameterMm);
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
      li.textContent = `${sp.name} (${sp.remainingLengthMm}/${sp.totalLengthMm} mm)`;
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
      edit.addEventListener("click", () => {
        const name = prompt("スプール名", sp.name);
        if (name == null) return;
        const remain = prompt("残り長(mm)", String(sp.remainingLengthMm));
        if (remain == null) return;
        updateSpool(sp.id, { name, remainingLengthMm: Number(remain) });
        const updated = getSpoolById(sp.id);
        if (sp.id === getCurrentSpoolId()) updatePreview(updated);
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

  addBtn.addEventListener("click", () => {
    const name = prompt("スプール名");
    if (!name) return;
    const total = parseFloat(prompt("総長(mm)", "10000")) || 0;
    const remain = parseFloat(prompt("残り長(mm)", String(total))) || 0;
    addSpool({ name, totalLengthMm: total, remainingLengthMm: remain });
    render();
  });

  render();
}
