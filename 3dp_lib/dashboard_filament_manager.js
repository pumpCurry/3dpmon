/**
 * @fileoverview
 * 3Dプリンタ監視ツール 3dpmon 用 フィラメント管理モーダル モジュール
 * dashboard_filament_manager.js
 * (c) pumpCurry 2025
 * -----------------------------------------------------------
 * @module dashboard_filament_manager
 *
 * 【機能内容サマリ】
 * - フィラメント管理ダイアログの表示
 * - 使用記録/在庫/プリセットの一覧表示
 *
 * 【公開関数一覧】
 * - {@link showFilamentManager}：管理モーダルを開く
 *
* @version 1.390.247 (PR #111)
* @since   1.390.228 (PR #102)
*/
"use strict";

import { monitorData } from "./dashboard_data.js";
import { getCurrentSpool, getSpools } from "./dashboard_spool.js";
import {
  getInventory,
  setInventoryQuantity,
  adjustInventory
} from "./dashboard_filament_inventory.js";
import { FILAMENT_PRESETS } from "./dashboard_filament_presets.js";
import { saveUnifiedStorage } from "./dashboard_storage.js";

let styleInjected = false;

/**
 * 必要な CSS を一度だけ注入する。
 *
 * @private
 * @returns {void}
 */
function injectStyles() {
  if (styleInjected) return;
  styleInjected = true;
  const css = `
    .filament-manager-overlay{position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:3000;}
    .filament-manager-modal{background:#fff;border-radius:8px;width:90%;max-width:640px;box-shadow:0 2px 12px rgba(0,0,0,0.4);display:flex;flex-direction:column;}
    .filament-manager-header{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid #ddd;}
    .filament-manager-tabs{display:flex;border-bottom:1px solid #ddd;}
    .filament-manager-tabs button{flex:1;padding:6px;border:none;background:#f4f4f5;cursor:pointer;}
    .filament-manager-tabs button.active{background:#fff;border-bottom:2px solid #38bdf8;}
    .filament-manager-content{padding:8px;overflow-y:auto;max-height:60vh;}
    .filament-manager-content table{width:100%;border-collapse:collapse;}
    .filament-manager-content th,.filament-manager-content td{border:1px solid #ddd;padding:4px;font-size:12px;}
    .filament-manager-content .inv-qty-input{width:60px;text-align:right;}
    .filament-manager-content .inv-adjust{margin:0 2px;padding:0 4px;}
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * 使用履歴タブの内容を生成する。
 *
 * @private
 * @returns {HTMLElement} 生成された要素
 */
function createHistoryContent() {
  const div = document.createElement("div");
  div.className = "filament-manager-content";
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>ID</th><th>Spool</th><th>Used(mm)</th><th>Time</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  monitorData.usageHistory.forEach(u => {
    const tr = document.createElement("tr");
    const t = new Date(Number(u.startedAt || u.timestamp || 0));
    tr.innerHTML = `<td>${u.usageId || ""}</td><td>${u.spoolId}</td><td>${u.usedLength || 0}</td><td>${t.toLocaleString()}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  div.appendChild(table);
  return div;
}

/**
 * 現在スプール表示タブを生成する。
 *
 * @private
 * @returns {HTMLElement} DOM 要素
 */
function createCurrentSpoolContent() {
  const div = document.createElement("div");
  div.className = "filament-manager-content";
  const sp = getCurrentSpool();
  if (!sp) {
    div.textContent = "現在選択中のスプールがありません";
    return div;
  }
  const ul = document.createElement("ul");
  ul.style.fontSize = "12px";
  ul.innerHTML = `
    <li>名前: ${sp.name}</li>
    <li>材質: ${sp.material}</li>
    <li>残量: ${sp.remainingLengthMm} / ${sp.totalLengthMm} mm</li>
  `;
  div.appendChild(ul);
  return div;
}

/**
 * 在庫一覧タブを生成する。
 * 在庫数を増減するボタンと入力欄を備え、直接数量変更が可能。
 *
 * @private
 * @returns {HTMLElement} DOM 要素
 */
function createInventoryContent() {
  const div = document.createElement("div");
  div.className = "filament-manager-content";
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>ID</th><th>数量</th><th>合計使用数</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  getInventory().forEach(inv => {
    const tr = document.createElement("tr");

    const idTd = document.createElement("td");
    idTd.textContent = inv.modelId;

    const qtyTd = document.createElement("td");
    const minus = document.createElement("button");
    minus.textContent = "-";
    minus.className = "inv-adjust";
    minus.addEventListener("click", () => {
      qtyInput.value = adjustInventory(inv.modelId, -1).toString();
    });

    const qtyInput = document.createElement("input");
    qtyInput.type = "number";
    qtyInput.className = "inv-qty-input";
    qtyInput.value = inv.quantity;
    qtyInput.addEventListener("change", () => {
      qtyInput.value = setInventoryQuantity(inv.modelId, qtyInput.value).toString();
    });

    const plus = document.createElement("button");
    plus.textContent = "+";
    plus.className = "inv-adjust";
    plus.addEventListener("click", () => {
      qtyInput.value = adjustInventory(inv.modelId, 1).toString();
    });

    qtyTd.append(minus, qtyInput, plus);

    const usedTd = document.createElement("td");
    usedTd.textContent = inv.totalUsedNum;

    tr.append(idTd, qtyTd, usedTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  div.appendChild(table);
  return div;
}

/**
 * プリセット一覧タブを生成する。
 *
 * @private
 * @returns {HTMLElement} DOM 要素
 */
function createPresetContent() {
  const div = document.createElement("div");
  div.className = "filament-manager-content";

  const form = document.createElement("form");
  form.style.cssText = "font-size:12px;margin-bottom:8px;";

  const brandInput = document.createElement("input");
  brandInput.placeholder = "ブランド";
  brandInput.style.marginRight = "4px";

  const matInput = document.createElement("input");
  matInput.placeholder = "材質";
  matInput.style.marginRight = "4px";

  const colorNameInput = document.createElement("input");
  colorNameInput.placeholder = "色名";
  colorNameInput.style.marginRight = "4px";

  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.style.marginRight = "4px";

  const submitBtn = document.createElement("button");
  submitBtn.textContent = "追加";

  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "キャンセル";
  cancelBtn.type = "button";
  cancelBtn.style.marginLeft = "4px";

  form.append(brandInput, matInput, colorNameInput, colorInput, submitBtn, cancelBtn);
  div.appendChild(form);

  const ul = document.createElement("ul");
  ul.style.fontSize = "12px";
  div.appendChild(ul);

  let editIndex = -1;

  function resetForm() {
    brandInput.value = "";
    matInput.value = "";
    colorNameInput.value = "";
    colorInput.value = "#000000";
    submitBtn.textContent = "追加";
    editIndex = -1;
  }

  function render() {
    ul.innerHTML = "";
    const list = monitorData.filamentPresets || FILAMENT_PRESETS;
    list.forEach((p, idx) => {
      const li = document.createElement("li");
      li.textContent = `${p.brand} ${p.colorName} (${p.material})`;
      const edit = document.createElement("button");
      edit.textContent = "編集";
      edit.style.marginLeft = "4px";
      edit.addEventListener("click", () => {
        brandInput.value = p.brand || "";
        matInput.value = p.material || "";
        colorNameInput.value = p.colorName || "";
        colorInput.value = p.color || "#000000";
        submitBtn.textContent = "保存";
        editIndex = idx;
      });
      const del = document.createElement("button");
      del.textContent = "削除";
      del.style.marginLeft = "4px";
      del.addEventListener("click", () => {
        if (!confirm("削除しますか?")) return;
        monitorData.filamentPresets.splice(idx, 1);
        saveUnifiedStorage();
        render();
        resetForm();
      });
      li.append(edit, del);
      ul.appendChild(li);
    });
  }

  form.addEventListener("submit", ev => {
    ev.preventDefault();
    const p = {
      presetId: editIndex >= 0 ? monitorData.filamentPresets[editIndex].presetId : `preset-${Date.now()}`,
      brand: brandInput.value.trim(),
      material: matInput.value.trim(),
      color: colorInput.value,
      colorName: colorNameInput.value.trim()
    };
    if (editIndex >= 0) {
      monitorData.filamentPresets.splice(editIndex, 1, p);
    } else {
      monitorData.filamentPresets.push(p);
    }
    saveUnifiedStorage();
    render();
    resetForm();
  });

  cancelBtn.addEventListener("click", resetForm);

  if (!monitorData.filamentPresets || !monitorData.filamentPresets.length) {
    monitorData.filamentPresets = [...FILAMENT_PRESETS];
  }
  render();
  resetForm();
  return div;
}

function createReportContent() {
  const div = document.createElement("div");
  div.className = "filament-manager-content";
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>日付</th><th>スプール数</th><th>消費量(mm)</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  const map = {};
  (monitorData.usageHistory || []).forEach(u => {
    const d = new Date(Number(u.startedAt || 0)).toISOString().slice(0, 10);
    if (!map[d]) map[d] = { ids: new Set(), len: 0 };
    map[d].ids.add(u.spoolId);
    map[d].len += Number(u.usedLength || 0);
  });
  Object.entries(map)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .forEach(([d, info]) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${d}</td><td>${info.ids.size}</td><td>${info.len.toLocaleString()}</td>`;
      tbody.appendChild(tr);
    });
  table.appendChild(tbody);
  div.appendChild(table);
  return div;
}

/**
 * フィラメント管理モーダルを表示する。
 *
 * @function showFilamentManager
 * @returns {void}
 */
export function showFilamentManager() {
  injectStyles();
  const overlay = document.createElement("div");
  overlay.className = "filament-manager-overlay";
  const modal = document.createElement("div");
  modal.className = "filament-manager-modal";
  overlay.appendChild(modal);

  const header = document.createElement("div");
  header.className = "filament-manager-header";
  header.innerHTML = '<span>フィラメント管理</span>';
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => overlay.remove());
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const tabBar = document.createElement("div");
  tabBar.className = "filament-manager-tabs";
  const tabs = ["使用記録簿", "現在のスプール", "在庫", "プリセット", "集計レポート"];
  const contents = [
    createHistoryContent(),
    createCurrentSpoolContent(),
    createInventoryContent(),
    createPresetContent(),
    createReportContent()
  ];
  const contentWrap = document.createElement("div");
  modal.appendChild(tabBar);
  modal.appendChild(contentWrap);

  function switchTab(idx) {
    tabBar.querySelectorAll("button").forEach((b, i) => {
      b.classList.toggle("active", i === idx);
      contents[i].style.display = i === idx ? "block" : "none";
    });
  }

  tabs.forEach((name, i) => {
    const btn = document.createElement("button");
    btn.textContent = name;
    if (i === 0) btn.classList.add("active");
    btn.addEventListener("click", () => switchTab(i));
    tabBar.appendChild(btn);
  });

  contents.forEach((c, i) => {
    if (i !== 0) c.style.display = "none";
    contentWrap.appendChild(c);
  });

  document.body.appendChild(overlay);
}

// DOM 読み込み後にボタンをバインド
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("filament-list-btn")?.addEventListener("click", () => {
    showFilamentManager();
  });
});
