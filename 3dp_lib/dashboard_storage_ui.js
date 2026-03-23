/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 ストレージUIコントローラ
 * @file dashboard_storage_ui.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_storage_ui
 *
 * 【機能内容サマリ】
 * - ストレージ使用率表示と同期処理を管理
 * - クォータテストやエクスポート/インポート機能
 * - カスタムイベントでUIを更新
 *
 * 【公開関数一覧】
 * - なし（DOMイベント経由で動作）
 *
 * @version 1.390.317 (PR #143)
 * @since   1.390.198 (PR #89)
 * @lastModified 2025-06-19 22:38:18
 * -----------------------------------------------------------
 * @todo
 * - none
*/

"use strict";

import {
  estimateStorageQuota,
  estimateLocalStorageUsageBytes,
  syncStorageNow,
  testMaxLocalStorageQuota,
  exportAllData,
  importAllData,
  importHistoryOnly,
  saveUnifiedStorage
} from "./dashboard_storage.js";

let liveTimer = null;

/* ------------------------------------------------------------------ */
/*  パネル内メッセージユーティリティ                                  */
/* ------------------------------------------------------------------ */
function panelToast(msg, isErr = false) {
  const panelBody = document.querySelector("#storage-panel div");
  if (!panelBody) return;
  const note = document.createElement("div");
  note.style.cssText =
    `margin-top:4px;font-size:12px;color:${isErr ? "#c00" : "#064"};`;
  note.textContent = msg;
  panelBody.appendChild(note);
  setTimeout(() => note.remove(), 3000);
}

/* ------------------------------------------------------------------ */
/*  初期化                                                             */
/* ------------------------------------------------------------------ */
/**
 * initStorageUI:
 *   ストレージ関連 UI を初期化し、各ボタンのイベントを設定する。
 *   Export/Import ボタン群は `#storage-panel` 要素の末尾へ追加する。
 *
 * @function initStorageUI
 * @returns {void}
 */
export function initStorageUI() {
  /* 注: この関数は DOMContentLoaded 時に呼ばれるが、
     パネルシステム起動後は要素がテンプレートに移動するため、
     パネル再生成時は initStorageUIInPanel() を使用する。 */
  // DOM キャッシュ
  const elPanel = document.getElementById("storage-panel");
  const elUsage = document.getElementById("storage-usage");
  const elSync  = document.getElementById("storage-last-sync");
  const elErr   = document.getElementById("storage-error");
  const btnSave = document.getElementById("storage-save-btn");
  const btnTest = document.getElementById("storage-quota-test-btn");

  /* ----- Export / Import ボタンを動的に挿入 ----- */
  const expBtn = document.createElement("button");
  expBtn.id = "storage-export-btn";
  expBtn.textContent = "全データ Export (v2.00)";
  expBtn.style.cssText = "font-size:12px;margin-left:5px;";

  const impBtn = document.createElement("button");
  impBtn.id = "storage-import-btn";
  impBtn.textContent = "全データ Import (マージ)";
  impBtn.style.cssText = "font-size:12px;margin-left:5px;";

  const impHistBtn = document.createElement("button");
  impHistBtn.id = "storage-import-history-btn";
  impHistBtn.textContent = "📋 印刷履歴のみ Import (名寄せ)";
  impHistBtn.style.cssText = "font-size:12px;margin-left:5px;";

  // 既存パネル要素の末尾にボタン群用 div を追加
  const btnGroup = document.createElement("div");
  btnGroup.style.cssText = "padding:8px;font-size:0.9em;display:flex;flex-wrap:wrap;gap:4px;";
  btnGroup.append(expBtn, impBtn, impHistBtn);
  elPanel?.appendChild(btnGroup);

  /* ---------------- ボタン動作 ---------------- */

  // 保存
  btnSave?.addEventListener("click", () => {
    syncStorageNow();
    panelToast("保存しました");
  });

  // クォータテスト
  btnTest?.addEventListener("click", handleQuotaTest);

  // Export
  expBtn.addEventListener("click", () => doExport(panelToast));

  // Import (全データマージ)
  impBtn.addEventListener("click", () => doImport(panelToast));

  // Import (印刷履歴のみ名寄せ)
  impHistBtn.addEventListener("click", () => doImportHistoryOnly(panelToast));

  /* ---------------- パネル開閉 / カスタムイベント ---------------- */

  // サブモーダル開閉時に使用量を更新
  // (旧 <details> の toggle イベントから MutationObserver に変更)
  const storageOverlay = document.getElementById("storage-modal-overlay");
  if (storageOverlay) {
    const obs = new MutationObserver(() => {
      if (storageOverlay.classList.contains("open")) { startLiveUsage(); updateUsage(); }
      else stopLiveUsage();
    });
    obs.observe(storageOverlay, { attributes: true, attributeFilter: ["class"] });
  }

  window.addEventListener("storage:sync", (ev) => {
    updateSyncTime(ev.detail.when);
    updateUsage();
  });

  window.addEventListener("storage:legacyCleaned", (ev) => {
    panelToast(`旧キー ${ev.detail.removed} 件を削除しました`);
  });

  /* ---------------- 初期表示 ---------------- */
  updateUsage();
}

/* ------------------------------------------------------------------ */
/*  内部ヘルパ                                                         */
/* ------------------------------------------------------------------ */

/**
 * ストレージ使用量とクォータを取得し、UI に表示
 */
async function updateUsage() {
  try {
    const { usage, quota } = await estimateStorageQuota();
    const pct  = ((usage / quota) * 100).toFixed(1);
    const elUsage = document.getElementById("storage-usage");
    if (elUsage) {
      elUsage.textContent =
        `${formatBytes(usage)} / ${formatBytes(quota)}  (${pct}%)`;
      elUsage.title = `クォータ: ${quota} bytes`;
    }
    const elErrOk = document.getElementById("storage-error");
    if (elErrOk) elErrOk.hidden = true;
  } catch {
    const elErr = document.getElementById("storage-error");
    if (elErr) {
      elErr.hidden = false;
      elErr.textContent = "⚠︎ 容量取得エラー";
    }
  }
}

/** 最終同期時刻を更新 */
function updateSyncTime(ts) {
  const elSync = document.getElementById("storage-last-sync");
  if (!elSync) return;
  elSync.textContent = new Date(ts).toLocaleString();
}

/** 使用量ライブ更新開始（2 秒ごと） */
function startLiveUsage() {
  if (liveTimer) return;
  liveTimer = setInterval(updateUsage, 2000);
}

/** 使用量ライブ更新停止 */
function stopLiveUsage() {
  clearInterval(liveTimer);
  liveTimer = null;
}

/** クォータテスト */
async function handleQuotaTest() {
  const btnTest = document.getElementById("storage-quota-test-btn");
  if (!btnTest) return;

  btnTest.disabled = true;
  try {
    const writable = await testMaxLocalStorageQuota();
    panelToast(
      `残容量テスト結果: 追加で ${formatBytes(writable)} 書込可能でした`
    );
    updateUsage();
  } catch (e) {
    console.error("[quota‑test]", e);
    panelToast("クォータテスト中にエラーが発生しました", true);
    try { updateUsage(); } catch {}
  } finally {
    btnTest.disabled = false;
  }
}

/** タイムスタンプ文字列を生成する内部ヘルパー */
function _makeTimestamp() {
  const now = new Date();
  const pad = (n) => n.toString().padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/**
 * v2.00 形式で全データをエクスポートする。
 * ファイル名は `3dpmon_export_YYYYMMDD-hhmmss.json` 形式。
 *
 * @param {Function} toast - トースト表示関数
 * @returns {Promise<void>}
 */
async function doExport(toast) {
  try {
    const data = await exportAllData();
    data._exportVersion = "2.00";
    data._exportDate = new Date().toISOString();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `3dpmon_export_${_makeTimestamp()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("v2.00 形式でエクスポートしました");
  } catch (e) {
    console.error("[doExport]", e);
    toast("エクスポートに失敗しました", true);
  }
}

/**
 * v1.40 形式のデータを v2.00 形式に変換する。
 * v1.40: フラットな monitorData（storedData, printStore 等がトップレベル）
 * v2.00: shared キー群 + machines: { hostname: {...} }
 *
 * @param {Object} data - v1.40 形式データ
 * @returns {Object} v2.00 形式データ
 */
function _convertV140toV200(data) {
  const SHARED_KEYS = [
    "appSettings", "filamentSpools", "usageHistory",
    "filamentPresets", "filamentInventory",
    "currentSpoolId", "spoolSerialCounter"
  ];
  const result = {};
  for (const key of SHARED_KEYS) {
    if (key in data) result[key] = data[key];
  }
  if (data.machines && typeof data.machines === "object") {
    /* v1.40 でも machines が存在する場合（混在形式） */
    result.machines = data.machines;
  } else {
    /* v1.40 フラット形式: storedData/printStore 等をデフォルトホストに格納 */
    const hostData = {};
    const HOST_KEYS = ["storedData", "printStore", "fileList"];
    for (const key of HOST_KEYS) {
      if (key in data) hostData[key] = data[key];
    }
    /* storedData から hostname を取得し、ホスト名として使用 */
    let hostname = "imported";
    if (hostData.storedData?.hostname?.rawValue) {
      hostname = hostData.storedData.hostname.rawValue;
    }
    if (Object.keys(hostData).length > 0) {
      result.machines = { [hostname]: hostData };
    }
  }
  result._exportVersion = "2.00";
  result._convertedFrom = "1.40";
  return result;
}

/**
 * エクスポートデータのバージョンを判定する。
 *
 * @param {Object} data - パース済み JSON データ
 * @returns {"2.00"|"1.40"} バージョン文字列
 */
function _detectExportVersion(data) {
  if (data._exportVersion === "2.00") return "2.00";
  if (data.machines && typeof data.machines === "object") {
    /* machines キーがあり、各値がオブジェクトなら v2.00 相当 */
    const vals = Object.values(data.machines);
    if (vals.length > 0 && typeof vals[0] === "object") return "2.00";
  }
  return "1.40";
}

/**
 * 全データをインポートする。v1.40 / v2.00 自動判定。
 * - `.json` および `.txt` ファイルを受け付ける
 * - v1.40 データは自動で v2.00 に変換してからインポート
 *
 * @param {Function} toast - トースト表示関数
 * @returns {void}
 */
function doImport(toast) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,.txt";
  input.addEventListener("change", (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(reader.result);
        const version = _detectExportVersion(parsed);
        let importData = parsed;
        if (version === "1.40") {
          importData = _convertV140toV200(parsed);
          console.info("[doImport] v1.40 → v2.00 変換を実施しました");
        }
        /* メタデータキーを除去してからインポート */
        delete importData._exportVersion;
        delete importData._exportDate;
        delete importData._convertedFrom;
        const stats = await importAllData(importData);
        const parts = [];
        if (stats.spools > 0) parts.push(`スプール ${stats.spools}件`);
        if (stats.history > 0) parts.push(`使用履歴 ${stats.history}件`);
        if (stats.presets > 0) parts.push(`プリセット ${stats.presets}件`);
        if (stats.inventory > 0) parts.push(`在庫 ${stats.inventory}件`);
        if (stats.machines > 0) parts.push(`印刷履歴 ${stats.machines}件`);
        const summary = parts.length > 0 ? parts.join(", ") : "新規データなし";
        toast(`マージインポート完了 (${version} 形式): ${summary}。ページを再読み込みします。`);
        setTimeout(() => location.reload(), 1500);
      } catch (e) {
        console.error("[doImport]", e);
        toast("インポート失敗: 不正な JSON", true);
      }
    };
    reader.readAsText(file);
  });
  input.click();
}


/**
 * 印刷履歴のみをインポートする（名寄せモード）。
 * @param {Function} toast
 */
function doImportHistoryOnly(toast) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,.txt";
  input.addEventListener("change", (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(reader.result);
        const version = _detectExportVersion(parsed);
        let importData = parsed;
        if (version === "1.40") {
          importData = _convertV140toV200(parsed);
        }
        delete importData._exportVersion;
        delete importData._exportDate;
        delete importData._convertedFrom;

        const stats = importHistoryOnly(importData);
        saveUnifiedStorage(true);

        const parts = [];
        if (stats.added > 0) parts.push(`新規 ${stats.added}件`);
        if (stats.enriched > 0) parts.push(`名寄せ補完 ${stats.enriched}件`);
        if (stats.usageAdded > 0) parts.push(`使用実績 ${stats.usageAdded}件`);
        if (stats.skippedHosts.length > 0) parts.push(`スキップ: ${stats.skippedHosts.join(", ")}`);
        const summary = parts.length > 0 ? parts.join(", ") : "新規データなし";
        toast(`履歴インポート完了 (${version}): ${summary}。ページを再読み込みします。`);
        setTimeout(() => location.reload(), 1500);
      } catch (e) {
        console.error("[doImportHistoryOnly]", e);
        toast("インポート失敗: " + e.message, true);
      }
    };
    reader.readAsText(file);
  });
  input.click();
}

/** バイト数を “X.XX MiB” に変換 */
function formatBytes(b) {
  return (b / 1024 / 1024).toFixed(2) + " MiB";
}

/**
 * initStorageUIInPanel:
 *   パネルシステムから呼ばれるスコープ付きストレージUI初期化。
 *   テンプレートからクローンされたパネル本体内の要素にバインドする。
 *
 * @function initStorageUIInPanel
 * @param {HTMLElement} body - パネル本体要素（.panel-body）
 * @returns {void}
 */
export function initStorageUIInPanel(body) {
  if (!body) return;

  /** パネル内要素を検索するヘルパー（スコープ付きID対応） */
  const find = (id) =>
    body.querySelector(`[id$="__${id}"]`) || body.querySelector(`#${id}`);

  const elPanel = find("storage-panel");
  const elUsage = find("storage-usage");
  const elErr   = find("storage-error");
  const btnSave = find("storage-save-btn");
  const btnTest = find("storage-quota-test-btn");
  const btnClear = find("clear-storage-button");

  /** パネル内トースト */
  const toast = (msg, isErr = false) => {
    const note = document.createElement("div");
    note.style.cssText =
      `margin-top:4px;font-size:12px;color:${isErr ? "#c00" : "#064"};`;
    note.textContent = msg;
    (elPanel || body).appendChild(note);
    setTimeout(() => note.remove(), 3000);
  };

  /** 使用量更新 */
  const refreshUsage = async () => {
    try {
      const { usage, quota } = await estimateStorageQuota();
      const pct = ((usage / quota) * 100).toFixed(1);
      if (elUsage) {
        elUsage.textContent =
          `${formatBytes(usage)} / ${formatBytes(quota)}  (${pct}%)`;
      }
      if (elErr) elErr.hidden = true;
    } catch {
      if (elErr) { elErr.hidden = false; elErr.textContent = "容量取得エラー"; }
    }
  };

  /* Export / Import ボタンを動的に挿入（v2.00 統一） */
  const expBtn = document.createElement("button");
  expBtn.textContent = "全データ Export (v2.00)";
  expBtn.style.cssText = "font-size:12px;margin-left:5px;";

  const impBtn = document.createElement("button");
  impBtn.textContent = "全データ Import (v1.40/v2.00)";
  impBtn.style.cssText = "font-size:12px;margin-left:5px;";

  const btnGroup = document.createElement("div");
  btnGroup.style.cssText = "padding:8px;font-size:0.9em;";
  btnGroup.append(expBtn, impBtn);
  if (elPanel) elPanel.appendChild(btnGroup);

  /* ボタンイベント */
  if (btnSave) {
    btnSave.addEventListener("click", () => {
      syncStorageNow();
      toast("保存しました");
    });
  }

  if (btnTest) {
    btnTest.addEventListener("click", async () => {
      btnTest.disabled = true;
      try {
        const writable = await testMaxLocalStorageQuota();
        toast(`残容量テスト結果: 追加で ${formatBytes(writable)} 書込可能でした`);
        refreshUsage();
      } catch (e) {
        console.error("[quota-test]", e);
        toast("クォータテスト中にエラーが発生しました", true);
      } finally {
        btnTest.disabled = false;
      }
    });
  }

  expBtn.addEventListener("click", () => doExport(toast));
  impBtn.addEventListener("click", () => doImport(toast));

  /* 全ストレージ削除ボタン */
  if (btnClear) {
    const confirmModal = find("confirm-delete-modal");
    const confirmOk = find("confirm-delete-ok");
    const confirmCancel = find("confirm-delete-cancel");

    btnClear.addEventListener("click", () => {
      if (confirmModal) confirmModal.style.display = "";
    });
    if (confirmCancel) {
      confirmCancel.addEventListener("click", () => {
        if (confirmModal) confirmModal.style.display = "none";
      });
    }
    if (confirmOk) {
      confirmOk.addEventListener("click", () => {
        localStorage.clear();
        if (confirmModal) confirmModal.style.display = "none";
        toast("全ストレージを削除しました。ページを再読み込みします。");
        setTimeout(() => location.reload(), 800);
      });
    }
  }

  /* パネル開閉で使用量ライブ更新 */
  let panelLiveTimer = null;
  if (elPanel) {
    elPanel.addEventListener("toggle", () => {
      if (elPanel.open) {
        if (!panelLiveTimer) panelLiveTimer = setInterval(refreshUsage, 2000);
      } else {
        clearInterval(panelLiveTimer);
        panelLiveTimer = null;
      }
    });
  }

  /* 初期表示 */
  refreshUsage();
}
