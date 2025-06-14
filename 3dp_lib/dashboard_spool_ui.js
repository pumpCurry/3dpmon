"use strict";

import {
  getSpools,
  getCurrentSpoolId,
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
      edit.addEventListener("click", () => {
        const name = prompt("スプール名", sp.name);
        if (name == null) return;
        const remain = prompt("残り長(mm)", String(sp.remainingLengthMm));
        if (remain == null) return;
        updateSpool(sp.id, { name, remainingLengthMm: Number(remain) });
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
