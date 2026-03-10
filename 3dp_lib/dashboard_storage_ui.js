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
  importAllData
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
  expBtn.textContent = "全データ Export";
  expBtn.style.cssText = "font-size:12px;margin-left:5px;";

  const impBtn = document.createElement("button");
  impBtn.id = "storage-import-btn";
  impBtn.textContent = "全データ Import";
  impBtn.style.cssText = "font-size:12px;margin-left:5px;";

  const allExpBtn = document.createElement("button");
  allExpBtn.id = "storage-export-all-btn";
  allExpBtn.textContent = "すべてのデータのエクスポート";
  allExpBtn.style.cssText = "font-size:12px;margin-left:5px;";

  // 既存パネル要素の末尾にボタン群用 div を追加
  // この位置で追加することで HTML 側の末尾に配置される
  const btnGroup = document.createElement("div");
  btnGroup.style.cssText = "padding:8px;font-size:0.9em;";
  btnGroup.append(expBtn, impBtn, allExpBtn);
  elPanel?.appendChild(btnGroup);

  /* ---------------- ボタン動作 ---------------- */

  // 保存
  btnSave?.addEventListener("click", () => {
    syncStorageNow();
    panelToast("保存しました");
  });

  // クォータテスト
  btnTest?.addEventListener("click", handleQuotaTest);

  // Export（IndexedDB 優先、フォールバック localStorage）
  expBtn.addEventListener("click", async () => {
    try {
      const data = await exportAllData();
      const json = JSON.stringify(data);
      const blob = new Blob([json], { type: "application/json" });
      const url  = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "3dp-monitor_backup.json";
      a.click();
      URL.revokeObjectURL(url);
      panelToast("エクスポート用 JSON を生成しました");
    } catch (e) {
      console.error("[storage‑export]", e);
      panelToast("エクスポートに失敗しました", true);
    }
  });

  // Import（IndexedDB 優先、フォールバック localStorage）
  impBtn.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.addEventListener("change", (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const parsed = JSON.parse(reader.result);         // 妥当性チェック
          await importAllData(parsed);
          panelToast("インポート完了。ページを再読み込みします。");
          setTimeout(() => location.reload(), 800);
        } catch (e) {
          console.error("[storage‑import]", e);
          panelToast("インポート失敗: 不正な JSON", true);
        }
      };
      reader.readAsText(file);
    });
    input.click();
  });

  // すべてのデータをエクスポート
  allExpBtn.addEventListener("click", exportAllStorageData);

  /* ---------------- パネル開閉 / カスタムイベント ---------------- */

  elPanel?.addEventListener("toggle", () => {
    if (elPanel.open) startLiveUsage();
    else               stopLiveUsage();
  });

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

/**
 * 現在の統合ストレージ内容をテキストファイルに保存する。
 * - ファイル名は `3dpmon_export_YYYYMMDD-hhmmss.txt` 形式
 * - IndexedDB 優先、フォールバック localStorage
 *
 * @function exportAllStorageData
 * @returns {Promise<void>}
 */
async function exportAllStorageData() {
  try {
    const data = await exportAllData();
    const json = JSON.stringify(data);
    const now  = new Date();
    const pad = (n) => n.toString().padStart(2, "0");
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const filename = `3dpmon_export_${stamp}.txt`;
    const blob = new Blob([json], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    panelToast("データをエクスポートしました");
  } catch (e) {
    console.error("[exportAllStorageData]", e);
    panelToast("エクスポートに失敗しました", true);
  }
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

  /* Export / Import ボタンを動的に挿入 */
  const expBtn = document.createElement("button");
  expBtn.textContent = "全データ Export";
  expBtn.style.cssText = "font-size:12px;margin-left:5px;";

  const impBtn = document.createElement("button");
  impBtn.textContent = "全データ Import";
  impBtn.style.cssText = "font-size:12px;margin-left:5px;";

  const allExpBtn = document.createElement("button");
  allExpBtn.textContent = "すべてのデータのエクスポート";
  allExpBtn.style.cssText = "font-size:12px;margin-left:5px;";

  const btnGroup = document.createElement("div");
  btnGroup.style.cssText = "padding:8px;font-size:0.9em;";
  btnGroup.append(expBtn, impBtn, allExpBtn);
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

  expBtn.addEventListener("click", async () => {
    try {
      const data = await exportAllData();
      const json = JSON.stringify(data);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "3dp-monitor_backup.json";
      a.click();
      URL.revokeObjectURL(url);
      toast("エクスポート用 JSON を生成しました");
    } catch (e) {
      console.error("[storage-export]", e);
      toast("エクスポートに失敗しました", true);
    }
  });

  impBtn.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.addEventListener("change", (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const parsed = JSON.parse(reader.result);
          await importAllData(parsed);
          toast("インポート完了。ページを再読み込みします。");
          setTimeout(() => location.reload(), 800);
        } catch (e) {
          console.error("[storage-import]", e);
          toast("インポート失敗: 不正な JSON", true);
        }
      };
      reader.readAsText(file);
    });
    input.click();
  });

  allExpBtn.addEventListener("click", async () => {
    try {
      const data = await exportAllData();
      const json = JSON.stringify(data);
      const now = new Date();
      const pad = (n) => n.toString().padStart(2, "0");
      const stamp =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const blob = new Blob([json], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `3dpmon_export_${stamp}.txt`;
      a.click();
      URL.revokeObjectURL(url);
      toast("データをエクスポートしました");
    } catch (e) {
      console.error("[exportAllStorageData]", e);
      toast("エクスポートに失敗しました", true);
    }
  });

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
