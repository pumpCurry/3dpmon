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

const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");

/**
 * アプリケーションバージョンを package.json から確実に取得する。
 * app.getVersion() は開発起動時 (electron .) に Electron 自身のバージョンを返すため、
 * 常に package.json を直接参照する。
 *
 * @returns {string} package.json の version
 */
function getAppVersion() {
  try {
    return require("../package.json").version;
  } catch {
    return app.getVersion();  // フォールバック
  }
}
const APP_VERSION = getAppVersion();

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
        res.end(JSON.stringify({ mode: "parent", port, version: APP_VERSION }));
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

    server.listen(port, "::", () => {  // ★ "::" = IPv4 + IPv6 デュアルスタック
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
 * パーティション孤立データの救済。
 * v2.1.008 で persist:3dpmon パーティションに保存されたデータを
 * デフォルトパーティション（file:// オリジン）に復元する。
 *
 * @private
 */
function _migrateStoragePartition() {
  const userData = app.getPath("userData");

  // センチネルファイルでマイグレーション済みかチェック
  const sentinelPath = path.join(userData, ".storage-migrated-v2");
  if (fs.existsSync(sentinelPath)) {
    return;
  }

  // 旧ストレージのコピー元を探索（優先順）
  // ★ v2.1.008 で Partitions/3dpmon/ に孤立したデータを元に戻す
  const partitionDir = path.join(userData, "Partitions", "3dpmon");
  const defaultDir = userData; // file:// オリジンのデフォルト保存先

  if (!fs.existsSync(partitionDir)) {
    // パーティションデータなし → マイグレーション不要
    try { fs.writeFileSync(sentinelPath, JSON.stringify({ migratedAt: new Date().toISOString(), reason: "no partition data" })); } catch {}
    return;
  }

  console.log(`[migration] パーティション孤立データ救済: ${partitionDir} → ${defaultDir}`);

  // コピー対象ディレクトリ
  const targets = ["Local Storage", "IndexedDB", "Session Storage"];
  let copied = 0;

  for (const subDir of targets) {
    const src = path.join(partitionDir, subDir);
    const dst = path.join(defaultDir, subDir);
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
      source: partitionDir,
      destination: defaultDir
    }));
  } catch { /* センチネル書き込み失敗は致命的ではない */ }

  if (copied > 0) {
    console.log(`[migration] ストレージマイグレーション完了 (${copied}ディレクトリ)`);
  }
}

/**
 * v2.2.1005: portable版 → NSIS版インストールユーザーデータ移行
 * NSIS インストール版の初回起動時に、portable 版（3dpmon-data フォルダ）の
 * データを取り込むかユーザーに確認するダイアログを表示する。
 *
 * @private
 * @returns {Promise<void>}
 */
async function _migrateFromPortable() {
  // portable 版で起動している場合はスキップ
  if (process.env.PORTABLE_EXECUTABLE_DIR || process.argv.includes("--portable")) {
    return;
  }
  const userData = app.getPath("userData");
  const sentinelPath = path.join(userData, ".portable-migration-checked");
  if (fs.existsSync(sentinelPath)) {
    return;  // 既にチェック済み
  }

  // 既存のデータが %APPDATA%\3dpmon にある場合はスキップ（既に NSIS 版で使用中）
  const localStorageDir = path.join(userData, "Local Storage");
  if (fs.existsSync(localStorageDir)) {
    try { fs.writeFileSync(sentinelPath, JSON.stringify({ checkedAt: new Date().toISOString(), result: "skipped (data exists)" })); } catch {}
    return;
  }

  // ユーザーに portable データのインポートを尋ねる
  const choice = await dialog.showMessageBox({
    type: "question",
    title: "3dpmon - 既存データの取り込み",
    message: "以前ポータブル版（portable.exe）を使用していましたか？",
    detail: "ポータブル版のフォルダ内にある「3dpmon-data」フォルダを選択すると、設定・印刷履歴・フィラメント情報を引き継げます。\n\n初回インストール（新規）の場合は「新規開始」を選択してください。",
    buttons: ["既存データを選択して取り込む", "新規開始（取り込まない）"],
    defaultId: 1,
    cancelId: 1
  });

  if (choice.response === 0) {
    const result = await dialog.showOpenDialog({
      title: "ポータブル版データフォルダを選択（3dpmon-data フォルダ）",
      properties: ["openDirectory"],
      buttonLabel: "このフォルダを取り込む"
    });
    if (!result.canceled && result.filePaths.length > 0) {
      const srcDir = result.filePaths[0];
      // 妥当性チェック: Local Storage or IndexedDB が存在するか
      const looksValid = fs.existsSync(path.join(srcDir, "Local Storage")) ||
                         fs.existsSync(path.join(srcDir, "IndexedDB"));
      if (!looksValid) {
        await dialog.showMessageBox({
          type: "warning",
          title: "取り込み失敗",
          message: "選択されたフォルダに 3dpmon のデータが見つかりませんでした。",
          detail: `フォルダ内に「Local Storage」または「IndexedDB」サブフォルダが必要です。\n\n選択: ${srcDir}`
        });
      } else {
        try {
          fs.cpSync(srcDir, userData, { recursive: true, force: false, errorOnExist: false });
          await dialog.showMessageBox({
            type: "info",
            title: "取り込み完了",
            message: "ポータブル版のデータを取り込みました。",
            detail: `保存先: ${userData}`
          });
        } catch (e) {
          await dialog.showMessageBox({
            type: "error",
            title: "取り込み失敗",
            message: "データのコピー中にエラーが発生しました。",
            detail: e.message
          });
        }
      }
    }
  }

  // センチネル: 結果に関わらず一度だけ尋ねる
  try { fs.writeFileSync(sentinelPath, JSON.stringify({ checkedAt: new Date().toISOString(), choice: choice.response })); } catch {}
}

/**
 * アプリケーションメニューを構築する。
 * トップバーに「ファイル / ヘルプ」メニューを表示する。
 *
 * @private
 * @returns {void}
 */
function _buildAppMenu() {
  const template = [
    {
      label: "ファイル",
      submenu: [
        { label: "リロード", accelerator: "CmdOrCtrl+R", role: "reload" },
        { label: "強制リロード", accelerator: "CmdOrCtrl+Shift+R", role: "forceReload" },
        { type: "separator" },
        { label: "終了", accelerator: "Alt+F4", role: "quit" }
      ]
    },
    {
      label: "表示",
      submenu: [
        { label: "拡大", accelerator: "CmdOrCtrl+Plus", role: "zoomIn" },
        { label: "縮小", accelerator: "CmdOrCtrl+-", role: "zoomOut" },
        { label: "等倍", accelerator: "CmdOrCtrl+0", role: "resetZoom" },
        { type: "separator" },
        { label: "全画面切り替え", accelerator: "F11", role: "togglefullscreen" },
        { type: "separator" },
        { label: "開発者ツール", accelerator: "F12", role: "toggleDevTools" }
      ]
    },
    {
      label: "ヘルプ",
      submenu: [
        {
          label: "GitHub リポジトリを開く",
          click: () => shell.openExternal("https://github.com/pumpCurry/3dpmon")
        },
        {
          label: "最新リリースを確認",
          click: () => shell.openExternal("https://github.com/pumpCurry/3dpmon/releases")
        },
        { type: "separator" },
        {
          label: "3dpmon について...",
          click: () => {
            if (mainWindow?.webContents) {
              mainWindow.webContents.send("show-about-dialog");
            }
          }
        }
      ]
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 800,
    minHeight: 600,
    title: `3dpmon - 3Dプリンタ監視ダッシュボード v${APP_VERSION}`,
    icon: (() => {
      const buildIcon = path.join(__dirname, "..", "build", "icon.ico");
      const favicon = path.join(__dirname, "..", "favicon.ico");
      return fs.existsSync(buildIcon) ? buildIcon : favicon;
    })(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      /* 既存コードとの互換性のため contextIsolation は有効のまま維持 */
      contextIsolation: true,
      nodeIntegration: false,
      /* Electron版: ユーザークリックなしで音声再生（TTS/効果音）を許可 */
      autoplayPolicy: "no-user-gesture-required",
      /* ★ partition は指定しない — file:// オリジンのデフォルトパーティションを使用。
         persist:3dpmon パーティションはオリジン不一致でデータ消失を引き起こすため廃止。 */
    }
  });

  /* ★ 親ウィンドウは常に file:// で読み込む。
     http://localhost: だとオリジンが変わり、localStorage/IndexedDB が
     別パーティションになってデータが消失する。
     子クライアント用の HTTP サーバは別途 port 5313 で起動済み。 */
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

  // ★ v2.2.1005: NSIS 初回起動時に portable 版データの取り込みを尋ねる
  await _migrateFromPortable();

  // ★ アプリケーションメニュー（ヘルプ → 3dpmon について）
  _buildAppMenu();

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

  /* ─── IPC: バージョン取得 ─── */
  ipcMain.on("get-app-version", (event) => {
    event.returnValue = APP_VERSION;
  });

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

  /* ─── ARP 解決 IPC ─── */
  const { resolveArp, scanArpTable, isCrealityDevice } = require("./arp_resolver.js");

  // 単一 IP の MAC を解決
  ipcMain.handle("arp-resolve", (_, ip) => resolveArp(ip));

  // ARP テーブル全スキャン（Creality 機器の自動検出用）
  ipcMain.handle("arp-scan", () => {
    const all = scanArpTable();
    return all.map(e => ({ ...e, isCreality: isCrealityDevice(e.mac) }));
  });

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
