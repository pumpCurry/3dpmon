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

const { app, BrowserWindow, Menu, ipcMain } = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");

/** リレーサーバポート（Go+3+D = 5313） */
const RELAY_PORT = parseInt(process.env.RELAY_PORT || "5313", 10);

/** HTTPサーバインスタンス */
let httpServer = null;
/** リレーサーバモジュール */
let relayServer = null;

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

/* ─── MIME タイプマップ ─── */
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico":  "image/x-icon",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".gif":  "image/gif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf":  "font/ttf",
  ".map":  "application/json"
};

/**
 * HTTP 静的ファイルサーバを起動する。
 * プロジェクトルートをドキュメントルートとして配信。
 * WS リレーサーバの土台にもなる。
 *
 * @param {number} port - リスンポート
 * @returns {Promise<http.Server>}
 */
function startHttpServer(port) {
  const root = path.join(__dirname, "..");

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // API エンドポイント
      if (req.url === "/api/relay-mode") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ mode: "parent", port, version: app.getVersion() }));
        return;
      }

      // 静的ファイル配信
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      let filePath = path.join(root, urlPath);

      // インデックスファイル: ルートまたはディレクトリアクセス時
      if (urlPath === "/" || filePath === root || filePath === root + path.sep) {
        filePath = path.join(root, "3dp_monitor.html");
      }

      // ディレクトリトラバーサル防止（正規化後に再チェック）
      filePath = path.resolve(filePath);
      if (!filePath.startsWith(path.resolve(root))) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";

      fs.readFile(filePath, (err, data) => {
        if (err) {
          if (err.code === "ENOENT" || err.code === "EISDIR") {
            res.writeHead(404);
            res.end("Not Found: " + urlPath);
          } else {
            console.error(`[HTTP] 500 for ${urlPath}:`, err.code, err.message);
            res.writeHead(500);
            res.end("Internal Server Error");
          }
          return;
        }
        res.writeHead(200, {
          "Content-Type": contentType,
          "Cache-Control": "no-cache"
        });
        res.end(data);
      });
    });

    server.listen(port, "0.0.0.0", () => {
      console.log(`[3dpmon] HTTP + WSリレーサーバ起動: http://0.0.0.0:${port}/`);
      resolve(server);
    });

    server.on("error", (err) => {
      console.error(`[3dpmon] サーバ起動失敗 (port ${port}):`, err.message);
      reject(err);
    });
  });
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
/**
 * 旧オリジン(file://)のストレージデータを新パーティション(persist:3dpmon)にコピーする。
 * Electron の localStorage/IndexedDB はユーザーデータディレクトリ配下に保存されるため、
 * ファイルシステムレベルでコピーする。
 *
 * 旧: userData/Default/Local Storage/  → 新: userData/Partitions/3dpmon/Local Storage/
 * 旧: userData/Default/IndexedDB/      → 新: userData/Partitions/3dpmon/IndexedDB/
 *
 * @private
 */
function _migrateStoragePartition() {
  const userData = app.getPath("userData");
  // ★ Electron の persist: パーティション名は "Partitions/persist_<name>" にマッピングされる
  const newPartDir = path.join(userData, "Partitions", "persist_3dpmon");

  // センチネルファイルでマイグレーション済みかチェック
  const sentinelPath = path.join(userData, ".storage-migrated");
  if (fs.existsSync(sentinelPath)) {
    return; // マイグレーション済み
  }

  // 旧ストレージのコピー元を探索（優先順）
  const candidates = [
    path.join(userData, "Default"),                    // Electron標準
    path.join(userData, "Local Storage"),              // 直下にある場合
    path.join(userData)                                // userDataそのもの
  ];

  let sourceDir = null;
  for (const dir of candidates) {
    const lsPath = path.join(dir, "Local Storage");
    const idbPath = path.join(dir, "IndexedDB");
    if (fs.existsSync(lsPath) || fs.existsSync(idbPath)) {
      sourceDir = dir;
      break;
    }
  }

  if (!sourceDir) {
    console.log("[migration] 旧ストレージが見つかりません（初回起動）");
    return;
  }

  console.log(`[migration] 旧ストレージ発見: ${sourceDir} → ${newPartDir}`);

  // コピー対象ディレクトリ
  const targets = ["Local Storage", "IndexedDB", "Session Storage"];
  let copied = 0;

  for (const subDir of targets) {
    const src = path.join(sourceDir, subDir);
    const dst = path.join(newPartDir, subDir);
    if (!fs.existsSync(src)) continue;
    try {
      fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false });
      copied++;
      console.log(`[migration] コピー完了: ${subDir}`);
    } catch (e) {
      console.warn(`[migration] コピー失敗 (${subDir}):`, e.message);
    }
  }

  // センチネルファイルを書き込み（次回以降スキップ）
  try {
    fs.writeFileSync(sentinelPath, JSON.stringify({
      migratedAt: new Date().toISOString(),
      copiedDirs: copied,
      source: sourceDir,
      destination: newPartDir
    }));
  } catch { /* センチネル書き込み失敗は致命的ではない */ }

  if (copied > 0) {
    console.log(`[migration] ストレージマイグレーション完了 (${copied}ディレクトリ)`);
  }
}

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
      nodeIntegration: false,
      /* Electron版: ユーザークリックなしで音声再生（TTS/効果音）を許可 */
      autoplayPolicy: "no-user-gesture-required",
      /* ★ ストレージパーティションを固定 — file:// と http://localhost の
         オリジン変更でデータが消失しないよう、persist:3dpmon パーティションを使用。
         これにより localStorage / IndexedDB が常に同じ場所に保存される。 */
      partition: "persist:3dpmon"
    }
  });

  /* HTTP サーバ経由で読み込む（子クライアントと同一オリジンを共有）
     サーバ未起動時は file:// にフォールバック */
  if (httpServer) {
    mainWindow.loadURL(`http://localhost:${RELAY_PORT}/3dp_monitor.html`);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "3dp_monitor.html"));
  }

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

/* ─── Chromium フラグ: 音声自動再生を許可 ─── */
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

/* ─── アプリケーションライフサイクル ─── */

app.whenReady().then(async () => {
  // 壊れた GPU / コードキャッシュを起動時にクリーンアップ
  // (多重起動やクラッシュで破損した場合のリカバリ)
  const cacheDirs = ["GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "Code Cache"];
  for (const dir of cacheDirs) {
    const fullPath = path.join(app.getPath("userData"), dir);
    try {
      if (fs.existsSync(fullPath)) {
        fs.rmSync(fullPath, { recursive: true, force: true });
      }
    } catch { /* キャッシュ削除失敗は無視 */ }
  }

  // ★ ストレージマイグレーション: 旧オリジン(file://) → 新パーティション(persist:3dpmon)
  _migrateStoragePartition();

  // HTTP + WSリレーサーバを起動（子クライアントが接続可能に）
  try {
    httpServer = await startHttpServer(RELAY_PORT);
    // WSリレーサーバ起動（子クライアント接続を受け付ける）
    const { startRelayServer } = require("./relay_server.js");
    relayServer = startRelayServer(httpServer, {
      sendToRenderer: (channel, data) => {
        if (mainWindow?.webContents) {
          mainWindow.webContents.send(channel, data);
        }
      }
    });
  } catch (e) {
    console.warn("[3dpmon] HTTPサーバ起動失敗、file://モードで動作:", e.message);
    httpServer = null;
  }

  createWindow();

  /* ─── IPC ブリッジ: レンダラー ↔ リレーサーバ ─── */

  // レンダラー → リレー: state delta 配信
  ipcMain.on("relay-broadcast", (_, delta) => {
    if (relayServer) relayServer.broadcastDelta(delta);
  });

  // レンダラー → リレー: 特定クライアントへのスナップショット送信
  ipcMain.on("relay-send-snapshot", (_, { clientId, state }) => {
    if (relayServer) relayServer.sendToClient(clientId, { type: "relay-snapshot", state });
  });

  // リレーサーバ情報の問い合わせ
  ipcMain.handle("relay-get-config", () => ({
    enabled: !!relayServer,
    port: RELAY_PORT,
    clients: relayServer?.getClients() || []
  }));

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
