/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Electron メインプロセス モジュール
 * @file electron/main.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module electron_main
 *
 * 【機能内容サマリ】
 * - Electron アプリケーションのエントリポイント
 * - BrowserWindow の生成と管理
 * - ブラウザ版との互換性を維持しつつ Electron 機能を提供
 *
 * 【公開関数一覧】
 * - なし（Electron メインプロセスとして即時実行）
 *
 * @version 1.390.783 (PR #366)
 * @since   1.390.783 (PR #366)
 * @lastModified 2026-03-10 21:00:00
 * -----------------------------------------------------------
 * @todo
 * - IPC 経由のファイル保存機能
 * - ネイティブメニュー統合
 */

"use strict";

const { app, BrowserWindow, Menu } = require("electron");
const path = require("path");

/**
 * メインウィンドウの参照を保持する。
 * GC によるウィンドウ破棄を防ぐためグローバルスコープに置く。
 *
 * @type {BrowserWindow|null}
 */
let mainWindow = null;

/* ─── ポータブル版: ユーザーデータを exe と同じディレクトリに保存 ─── */
// portable 版（NSIS portable や --portable フラグ）の場合、
// %APPDATA% ではなく exe のあるディレクトリに userData を配置する。
// これにより正規インストール版とデータが競合しない。
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  const portableData = path.join(process.env.PORTABLE_EXECUTABLE_DIR, "3dpmon-data");
  app.setPath("userData", portableData);
} else if (process.argv.includes("--portable")) {
  const portableData = path.join(path.dirname(process.execPath), "3dpmon-data");
  app.setPath("userData", portableData);
}

/**
 * メインウィンドウを生成する。
 *
 * 【詳細説明】
 * - 既存の 3dp_monitor.html をそのまま読み込む
 * - preload スクリプトで Electron API を安全に公開
 * - WebSocket 通信はレンダラープロセス内で既存コードがそのまま動作
 *
 * @function createWindow
 * @returns {void}
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 800,
    minHeight: 600,
    title: "3dpmon - 3Dプリンタ監視ダッシュボード",
    icon: path.join(__dirname, "..", "favicon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      /* 既存コードとの互換性のため contextIsolation は有効のまま維持 */
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  /* 既存 HTML をそのまま読み込む */
  mainWindow.loadFile(path.join(__dirname, "..", "3dp_monitor.html"));

  /* 開発モード: DevTools 自動表示 */
  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/* ─── 多重起動防止 ─── */
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // 既に別インスタンスが起動中 → 自身を終了し、既存ウィンドウをフォーカス
  app.quit();
} else {
  app.on("second-instance", () => {
    // 2つ目のインスタンスが起動を試みた → 既存ウィンドウを前面に
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

/* ─── アプリケーションライフサイクル ─── */

app.whenReady().then(() => {
  // 壊れた GPU / コードキャッシュを起動時にクリーンアップ
  // (多重起動やクラッシュで破損した場合のリカバリ)
  const fs = require("fs");
  const cacheDirs = ["GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "Code Cache"];
  for (const dir of cacheDirs) {
    const fullPath = path.join(app.getPath("userData"), dir);
    try {
      if (fs.existsSync(fullPath)) {
        fs.rmSync(fullPath, { recursive: true, force: true });
      }
    } catch { /* キャッシュ削除失敗は無視 */ }
  }

  createWindow();

  /* macOS: Dock アイコンクリック時にウィンドウ再生成 */
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

/* 全ウィンドウ閉鎖時にアプリ終了（macOS 以外） */
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
