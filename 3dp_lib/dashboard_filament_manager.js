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
 * @version 1.390.260 (PR #118)
 * @since   1.390.228 (PR #102)
 */
"use strict";

import { monitorData } from "./dashboard_data.js";
import {
  getCurrentSpool,
  getSpools,
  addSpool,
  updateSpool
} from "./dashboard_spool.js";
import {
  getInventory,
  setInventoryQuantity,
  adjustInventory
} from "./dashboard_filament_inventory.js";
import { FILAMENT_PRESETS } from "./dashboard_filament_presets.js";
import { saveUnifiedStorage } from "./dashboard_storage.js";
import { showSpoolDialog } from "./dashboard_spool_ui.js";
import { createFilamentPreview } from "./dashboard_filament_view.js";

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
    .filament-manager-content .search-form{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px;}
    .filament-manager-content .search-form select,
    .filament-manager-content .search-form input{padding:2px;font-size:12px;}
    .registered-container{display:flex;gap:8px;}
    .registered-preview{flex:0 0 120px;}
    .registered-table th{cursor:pointer;}
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
 * 登録済みフィラメント一覧タブを生成する。
 * 検索フォームと一覧テーブルを備え、編集・追加操作が可能。
 *
 * @private
 * @returns {HTMLElement} DOM 要素
 */
function createRegisteredContent() {
  const div = document.createElement("div");
  div.className = "filament-manager-content";

  const addBtn = document.createElement("button");
  addBtn.textContent = "新規登録";
  addBtn.style.fontSize = "12px";
  addBtn.style.marginBottom = "4px";

  const form = document.createElement("form");
  form.className = "search-form";
  const brandSel = document.createElement("select");
  const matSel = document.createElement("select");
  const colorSel = document.createElement("select");
  const nameIn = document.createElement("input");
  nameIn.placeholder = "名称";
  const searchBtn = document.createElement("button");
  searchBtn.textContent = "検索";
  form.append(brandSel, matSel, colorSel, nameIn, searchBtn);

  const countSpan = document.createElement("div");
  countSpan.style.fontSize = "12px";
  countSpan.style.margin = "4px 0";

  const wrap = document.createElement("div");
  wrap.className = "registered-container";
  const prevBox = document.createElement("div");
  prevBox.className = "registered-preview";
  wrap.appendChild(prevBox);

  const table = document.createElement("table");
  table.className = "registered-table";
  const thead = document.createElement("thead");
  thead.innerHTML =
    "<tr><th data-sort='brand'>ブランド</th><th data-sort='material'>材質</th>" +
    "<th data-sort='colorName'>色名</th><th data-sort='name'>名称</th>" +
    "<th data-sort='reelSubName'>サブ名称</th>" +
    "<th data-sort='count'>使用数</th><th data-sort='last'>最終利用日時</th><th>コマンド</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);
  wrap.appendChild(table);

  div.append(addBtn, form, countSpan, wrap);

  const preview = createFilamentPreview(prevBox, {
    filamentDiameter: 1.75,
    filamentTotalLength: 336000,
    filamentCurrentLength: 336000,
    filamentColor: "#22C55E",
    widthPx: 120,
    heightPx: 120,
    showSlider: false,
    disableInteraction: true,
    showOverlayLength: true,
    showOverlayPercent: true
  });

  let sortKey = "";
  let sortAsc = true;

  function buildMaps() {
    const map = {};
    (monitorData.usageHistory || []).forEach(h => {
      const m = map[h.spoolId] || { count: 0, last: 0 };
      m.count += 1;
      const t = Number(h.startedAt || 0);
      if (t > m.last) m.last = t;
      map[h.spoolId] = m;
    });
    return map;
  }

  function fillOptions(spools) {
    const brands = new Set();
    const mats = new Set();
    const colors = new Set();
    spools.forEach(sp => {
      if (sp.manufacturerName) brands.add(sp.manufacturerName);
      else if (sp.brand) brands.add(sp.brand);
      if (sp.materialName) mats.add(sp.materialName);
      else if (sp.material) mats.add(sp.material);
      if (sp.colorName) colors.add(sp.colorName);
    });
    brandSel.innerHTML = "<option value=''>ブランド</option>";
    [...brands].forEach(b => {
      const o = document.createElement("option");
      o.value = b;
      o.textContent = b;
      brandSel.appendChild(o);
    });
    matSel.innerHTML = "<option value=''>材質</option>";
    [...mats].forEach(m => {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m;
      matSel.appendChild(o);
    });
    colorSel.innerHTML = "<option value=''>色名</option>";
    [...colors].forEach(c => {
      const o = document.createElement("option");
      o.value = c;
      o.textContent = c;
      colorSel.appendChild(o);
    });
  }

  function applyFilter(spools) {
    return spools.filter(sp => {
      if (brandSel.value) {
        const b = sp.manufacturerName || sp.brand || "";
        if (b !== brandSel.value) return false;
      }
      if (matSel.value) {
        const m = sp.materialName || sp.material || "";
        if (m !== matSel.value) return false;
      }
      if (colorSel.value) {
        if (sp.colorName !== colorSel.value) return false;
      }
      if (nameIn.value) {
        const n = `${sp.name || ""}${sp.reelName || ""}${sp.reelSubName || ""}`;
        if (!n.includes(nameIn.value)) return false;
      }
      return true;
    });
  }

  function sortList(list) {
    if (!sortKey) return list;
    return list.sort((a, b) => {
      let va = "";
      let vb = "";
      switch (sortKey) {
        case "brand":
          va = a.manufacturerName || a.brand || "";
          vb = b.manufacturerName || b.brand || "";
          break;
        case "material":
          va = a.materialName || a.material || "";
          vb = b.materialName || b.material || "";
          break;
        case "colorName":
          va = a.colorName || "";
          vb = b.colorName || "";
          break;
        case "name":
          va = a.name || a.reelName || "";
          vb = b.name || b.reelName || "";
          break;
        case "reelSubName":
          va = a.reelSubName || "";
          vb = b.reelSubName || "";
          break;
        case "count":
          va = usageMap[a.id]?.count || 0;
          vb = usageMap[b.id]?.count || 0;
          break;
        case "last":
          va = usageMap[a.id]?.last || 0;
          vb = usageMap[b.id]?.last || 0;
          break;
        default:
          break;
      }
      if (va === vb) return 0;
      const cmp = va > vb ? 1 : -1;
      return sortAsc ? cmp : -cmp;
    });
  }

  function render() {
    const spools = getSpools();
    usageMap = buildMaps();
    fillOptions(spools);
    const list = sortList(applyFilter(spools));
    tbody.innerHTML = "";
    list.forEach(sp => {
      const tr = document.createElement("tr");
      const brand = sp.manufacturerName || sp.brand || "";
      const mat = sp.materialName || sp.material || "";
      const colorCell = document.createElement("td");
      colorCell.innerHTML = `<span style='color:${sp.filamentColor || sp.color || "#000"}'>■</span>${sp.colorName || ""}`;
      const name = sp.name || sp.reelName || "";
      const sub = sp.reelSubName || "";
      const usage = usageMap[sp.id]?.count || 0;
      const last = usageMap[sp.id]?.last
        ? new Date(usageMap[sp.id].last).toLocaleString()
        : "";
      tr.innerHTML = `<td>${brand}</td><td>${mat}</td>`;
      tr.appendChild(colorCell);
      tr.innerHTML += `<td>${name}</td><td>${sub}</td><td>${usage}</td><td>${last}</td>`;
      const cmd = document.createElement("td");
      const edit = document.createElement("button");
      edit.textContent = "編集";
      edit.addEventListener("click", async () => {
        const res = await showSpoolDialog(sp);
        if (res) {
          updateSpool(sp.id, res);
          render();
        }
      });
      cmd.appendChild(edit);
      tr.appendChild(cmd);
      tr.addEventListener("click", () => {
        preview.setState({
          filamentDiameter: sp.filamentDiameter,
          filamentTotalLength: sp.totalLengthMm,
          filamentCurrentLength: sp.remainingLengthMm,
          filamentColor: sp.filamentColor || sp.color,
          reelOuterDiameter: sp.reelOuterDiameter,
          reelThickness: sp.reelThickness,
          reelWindingInnerDiameter: sp.reelWindingInnerDiameter,
          reelCenterHoleDiameter: sp.reelCenterHoleDiameter,
          reelBodyColor: sp.reelBodyColor,
          reelFlangeTransparency: sp.reelFlangeTransparency,
          reelWindingForegroundColor: sp.reelWindingForegroundColor,
          reelCenterHoleForegroundColor: sp.reelCenterHoleForegroundColor,
          reelName: sp.name || "",
          reelSubName: sp.reelSubName || "",
          materialName: sp.materialName || sp.material || "",
          materialColorName: sp.colorName || "",
          materialColorCode: sp.filamentColor || sp.color || "",
          manufacturerName: sp.manufacturerName || sp.brand || ""
        });
      });
      tbody.appendChild(tr);
    });
    countSpan.textContent = `一覧：(${list.length}/${spools.length}件)`;
  }

  let usageMap = buildMaps();

  thead.addEventListener("click", ev => {
    const th = ev.target.closest("th");
    if (!th || !th.dataset.sort) return;
    if (sortKey === th.dataset.sort) {
      sortAsc = !sortAsc;
    } else {
      sortKey = th.dataset.sort;
      sortAsc = true;
    }
    render();
  });

  form.addEventListener("submit", ev => {
    ev.preventDefault();
    render();
  });

  addBtn.addEventListener("click", async () => {
    const res = await showSpoolDialog();
    if (res) {
      addSpool(res);
      render();
    }
  });

  render();
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

/**
 * 日付から週番号キー (YYYY-WW) を生成する。
 *
 * @private
 * @param {Date} date - 変換対象の日付
 * @returns {string} 週キー
 */
function formatWeekKey(date) {
  const first = new Date(date.getFullYear(), 0, 1);
  const days = Math.floor((date - first) / 86400000);
  const week = Math.floor((days + first.getDay()) / 7) + 1;
  return `${date.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * 日付から月番号キー (YYYY-MM) を生成する。
 *
 * @private
 * @param {Date} date - 変換対象の日付
 * @returns {string} 月キー
 */
function formatMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * 集計レポートタブの内容を生成する。
 * 日別集計テーブルに加え、週次・月次のグラフを表示する。
 *
 * @private
 * @returns {HTMLElement} DOM 要素
 */
function createReportContent() {
  const div = document.createElement("div");
  div.className = "filament-manager-content";

  // ── 1) 日別集計テーブル ───────────────────────────────
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>日付</th><th>スプール数</th><th>消費量(mm)</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");

  const dailyMap = {};
  const weeklyMap = {};
  const monthlyMap = {};

  (monitorData.usageHistory || []).forEach(u => {
    const dateObj = new Date(Number(u.startedAt || 0));
    const dayKey = dateObj.toISOString().slice(0, 10);
    if (!dailyMap[dayKey]) dailyMap[dayKey] = { ids: new Set(), len: 0 };
    dailyMap[dayKey].ids.add(u.spoolId);
    const used = Number(u.usedLength || 0);
    dailyMap[dayKey].len += used;

    const wKey = formatWeekKey(dateObj);
    weeklyMap[wKey] = (weeklyMap[wKey] || 0) + used;

    const mKey = formatMonthKey(dateObj);
    monthlyMap[mKey] = (monthlyMap[mKey] || 0) + used;
  });

  Object.entries(dailyMap)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .forEach(([d, info]) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${d}</td><td>${info.ids.size}</td><td>${info.len.toLocaleString()}</td>`;
      tbody.appendChild(tr);
    });
  table.appendChild(tbody);
  div.appendChild(table);

  // ── 2) 週次・月次の消費量を Chart.js で表示 ─────────────────
  const weekCanvas = document.createElement("canvas");
  weekCanvas.style.maxHeight = "200px";
  div.appendChild(weekCanvas);

  const monthCanvas = document.createElement("canvas");
  monthCanvas.style.maxHeight = "200px";
  div.appendChild(monthCanvas);

  if (typeof Chart !== "undefined") {
    new Chart(weekCanvas.getContext("2d"), {
      type: "bar",
      data: {
        labels: Object.keys(weeklyMap),
        datasets: [
          { label: "週次消費量(mm)", data: Object.values(weeklyMap) }
        ]
      },
      options: { responsive: true, maintainAspectRatio: false }
    });

    new Chart(monthCanvas.getContext("2d"), {
      type: "pie",
      data: {
        labels: Object.keys(monthlyMap),
        datasets: [
          { label: "月次消費量(mm)", data: Object.values(monthlyMap) }
        ]
      },
      options: { responsive: true, maintainAspectRatio: false }
    });
  }

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
  const tabs = [
    "使用記録簿",
    "現在のスプール",
    "在庫",
    "登録済みフィラメント",
    "プリセット",
    "集計レポート"
  ];
  const contents = [
    createHistoryContent(),
    createCurrentSpoolContent(),
    createInventoryContent(),
    createRegisteredContent(),
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
