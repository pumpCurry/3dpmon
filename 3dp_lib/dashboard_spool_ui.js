"use strict";

import {
  getSpools,
  getCurrentSpoolId,
  setCurrentSpoolId,
  addSpool,
  updateSpool,
  deleteSpool
} from "./dashboard_spool.js";
import { showInputDialog } from "./dashboard_ui_confirm.js";
import { MATERIAL_SPECS } from "./material_specs.js";

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

  addBtn.addEventListener("click", async () => {
    const name = await showInputDialog({ title: "スプール名" });
    if (!name) return;
    const material = await showInputDialog({ title: "素材", defaultValue: "PLA" });
    if (material == null) return;
    const spec = MATERIAL_SPECS[material.toUpperCase()];
    const pMin = await showInputDialog({ title: "ノズル温度min", defaultValue: spec?.printTemp[0] ?? "" });
    if (pMin == null) return;
    const pMax = await showInputDialog({ title: "ノズル温度max", defaultValue: spec?.printTemp[1] ?? "" });
    if (pMax == null) return;
    const bMin = await showInputDialog({ title: "ベッド温度min", defaultValue: spec?.bedTemp[0] ?? "" });
    if (bMin == null) return;
    const bMax = await showInputDialog({ title: "ベッド温度max", defaultValue: spec?.bedTemp[1] ?? "" });
    if (bMax == null) return;
    const dens = await showInputDialog({ title: "密度(g/cm³)", defaultValue: spec?.density ?? "" });
    if (dens == null) return;
    const total = parseFloat(await showInputDialog({ title: "総長(mm)", defaultValue: "10000" })) || 0;
    const remain = parseFloat(await showInputDialog({ title: "残り長(mm)", defaultValue: String(total) })) || 0;
    addSpool({
      name,
      material,
      printTempMin: parseFloat(pMin) || null,
      printTempMax: parseFloat(pMax) || null,
      bedTempMin:   parseFloat(bMin) || null,
      bedTempMax:   parseFloat(bMax) || null,
      density:      parseFloat(dens) || null,
      totalLengthMm: total,
      remainingLengthMm: remain
    });
    render();
  });

  render();
}
