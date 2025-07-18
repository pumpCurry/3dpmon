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
  testMaxLocalStorageQuota
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

  // Export
  expBtn.addEventListener("click", () => {
    try {
      const json = localStorage.getItem("3dp-monitor_1.400") ?? "{}";
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

  // Import
  impBtn.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.addEventListener("change", (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          JSON.parse(reader.result);                        // 妥当性チェック
          localStorage.setItem("3dp-monitor_1.400", reader.result);
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
    elUsage.textContent =
      `${formatBytes(usage)} / ${formatBytes(quota)}  (${pct}%)`;
    elUsage.title = `クォータ: ${quota} bytes`;
    document.getElementById("storage-error").hidden = true;
  } catch {
    const elErr = document.getElementById("storage-error");
    elErr.hidden = false;
    elErr.textContent = "⚠︎ 容量取得エラー";
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
 * - 取得元は localStorage キー `3dp-monitor_1.400`
 *
 * @function exportAllStorageData
 * @returns {void}
 */
function exportAllStorageData() {
  try {
    const json = localStorage.getItem("3dp-monitor_1.400") ?? "{}";
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
