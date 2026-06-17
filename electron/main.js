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
 * @version 1.390.790 (v2.2.1020)
 * @since   1.390.783 (PR #366)
 * @lastModified 2026-06-08
 * -----------------------------------------------------------
 * 【v2.2.1020 変更点】
 * - 効率モード/最小化/非フォア時の通知遅延・画面更新停止を解消:
 *   webPreferences.backgroundThrottling=false + 背景スロットリング抑止スイッチ3種
 *   + powerSaveBlocker("prevent-app-suspension") を導入。
 * @todo
 * - IPC 経由のファイル保存機能
 * - ネイティブメニュー統合
 */

"use strict";

const { app, BrowserWindow, Menu, ipcMain, dialog, shell, powerSaveBlocker } = require("electron");
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

/* ─── カメラパススルー (リレー子向け snapshot プロキシ) ─── */

/**
 * ホスト名 → カメラ／画像エンドポイント のマップ。
 * 親レンダラーが connectionTargets から構築し、set-camera-endpoints IPC で渡す。
 * SSRF 対策: このマップに載っているホストのみ転送を許可する（任意IP転送禁止）。
 *
 * - port    : カメラ snapshot/stream 用ポート（既定 8080）
 * - httpPort : プリンタ HTTP 静的アセット用ポート（既定 80、画像パススルーで使用）
 *
 * @type {Object<string, {ip: string, port: number, httpPort?: number}>}
 */
let _cameraEndpoints = {};

/**
 * ホスト別の最新スナップショットキャッシュ。
 * 短時間(_CAM_CACHE_TTL_MS)に集中する複数子からの要求を1枚のフェッチでまかなう。
 *
 * @type {Map<string, {buf: Buffer, ts: number}>}
 */
const _camSnapCache = new Map();

/**
 * ホスト別の取得中 Promise（stampede 防止）。
 * 同一ホストへの同時フェッチを1本に集約する。
 *
 * @type {Map<string, Promise<Buffer>>}
 */
const _camInflight = new Map();

/** スナップショットキャッシュの有効期間 (ms) */
const _CAM_CACHE_TTL_MS = 1200;
/** プリンタへの snapshot 取得タイムアウト (ms) */
const _CAM_FETCH_TIMEOUT_MS = 4000;
/** スナップショット受理上限サイズ (bytes) — 暴走/誤転送防止 */
const _CAM_MAX_BYTES = 3 * 1024 * 1024;

/* ─── 画像パススルー (リレー子向け 静的画像プロキシ) ─── */

/** プリンタ画像取得タイムアウト (ms) */
const _IMG_FETCH_TIMEOUT_MS = 5000;
/** 画像受理上限サイズ (bytes) — サムネ/アイコン用途。暴走/誤転送防止 */
const _IMG_MAX_BYTES = 10 * 1024 * 1024;

/**
 * プリンタカメラから単一スナップショット(JPEG)を1枚取得する。
 * 既に取得中なら同じ Promise を共有する（stampede 防止）。
 *
 * @private
 * @param {string} host - ホスト名（_cameraEndpoints のキー）
 * @param {{ip: string, port: number}} ep - 解決済みエンドポイント
 * @returns {Promise<Buffer>} JPEG バイト列（FFD8 で始まる）
 */
function _fetchCameraSnapshot(host, ep) {
  const existing = _camInflight.get(host);
  if (existing) return existing;

  const p = new Promise((resolve, reject) => {
    const port = ep.port || 8080;
    const req = http.get(
      { host: ep.ip, port, path: "/?action=snapshot", timeout: _CAM_FETCH_TIMEOUT_MS },
      (resp) => {
        if (resp.statusCode !== 200) {
          resp.resume(); // ソケット解放
          reject(new Error(`upstream status ${resp.statusCode}`));
          return;
        }
        const chunks = [];
        let total = 0;
        resp.on("data", (chunk) => {
          total += chunk.length;
          if (total > _CAM_MAX_BYTES) {
            req.destroy();
            reject(new Error("snapshot too large"));
            return;
          }
          chunks.push(chunk);
        });
        resp.on("end", () => {
          const buf = Buffer.concat(chunks);
          // JPEG マジックナンバー(FFD8) チェック — MJPEG ストリーム等の誤受理を防ぐ
          if (buf.length < 2 || buf[0] !== 0xFF || buf[1] !== 0xD8) {
            reject(new Error("not a JPEG"));
            return;
          }
          resolve(buf);
        });
        resp.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error("snapshot timeout")));
    req.on("error", reject);
  });

  _camInflight.set(host, p);
  // 成否に関わらず in-flight を解除
  p.then(
    () => _camInflight.delete(host),
    () => _camInflight.delete(host)
  );
  return p;
}

/**
 * メインウィンドウの参照を保持する。
 * GC によるウィンドウ破棄を防ぐためグローバルスコープに置く。
 *
 * @type {BrowserWindow|null}
 */
let mainWindow = null;

/**
 * powerSaveBlocker のハンドル ID。
 * アプリ稼働中はシステム/アプリのサスペンドを抑止し続ける（24/7 監視のため）。
 *
 * @type {number|null}
 */
let _powerSaveBlockerId = null;

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

      // ─── リレー子向けカメラ snapshot プロキシ ───
      // /relay-camera/{host}/snapshot.jpg → プリンタの /?action=snapshot を中継し
      // 単一 JPEG を返す。子はプリンタに直接到達できないため親が代理取得する。
      const camMatch = req.url.match(/^\/relay-camera\/(.+?)\/snapshot\.jpg/);
      if (camMatch) {
        const host = decodeURIComponent(camMatch[1]);
        const ep = _cameraEndpoints[host];
        if (!ep || !ep.ip) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Unknown camera host");
          return;
        }

        const sendJpeg = (buf) => {
          res.writeHead(200, {
            "Content-Type": "image/jpeg",
            "Content-Length": buf.length,
            "Cache-Control": "no-store"
          });
          res.end(buf);
        };

        // キャッシュが新鮮ならそのまま返す（複数子の同時要求を吸収）
        const cached = _camSnapCache.get(host);
        if (cached && Date.now() - cached.ts < _CAM_CACHE_TTL_MS) {
          sendJpeg(cached.buf);
          return;
        }

        // プリンタから1枚取得（in-flight 集約）。失敗は 502。
        _fetchCameraSnapshot(host, ep).then(
          (buf) => {
            _camSnapCache.set(host, { buf, ts: Date.now() });
            sendJpeg(buf);
          },
          (err) => {
            // 失敗時、わずかに古いキャッシュがあれば代替提示（連続コマ落ち緩和）
            const stale = _camSnapCache.get(host);
            if (stale) {
              sendJpeg(stale.buf);
              return;
            }
            res.writeHead(502, { "Content-Type": "text/plain" });
            res.end("Camera fetch failed: " + (err && err.message ? err.message : "error"));
          }
        );
        return;
      }

      // ─── リレー子向け 画像パススルー プロキシ ───
      // /relay-image/{host}/{path...} → プリンタの HTTP(:80) 静的アセットを中継。
      // サムネ/アイコン等。子はプリンタに直接到達できないため親が代理取得する。
      // SSRF/トラバーサル対策: host は _cameraEndpoints 限定、path は downloads/ 配下のみ許可。
      const imgMatch = req.url.match(/^\/relay-image\/([^/]+)\/(.+)$/);
      if (imgMatch) {
        // クエリ文字列を分離（後で上流へ転送）。g2 はパス部分のみ。
        const qIdx = imgMatch[2].indexOf("?");
        const query = qIdx >= 0 ? imgMatch[2].slice(qIdx) : "";
        const rawPath = qIdx >= 0 ? imgMatch[2].slice(0, qIdx) : imgMatch[2];
        // 不正な %エンコードは 400（uncaught 例外でハンドラを落とさない）
        let host, decodedPath;
        try {
          host = decodeURIComponent(imgMatch[1]);
          decodedPath = decodeURIComponent(rawPath);
        } catch {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Bad request");
          return;
        }

        const ep = _cameraEndpoints[host];
        if (!ep || !ep.ip) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Unknown image host");
          return;
        }

        // トラバーサル対策: ".." を含むパスは拒否
        if (decodedPath.includes("..")) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden path");
          return;
        }
        // プリンタ静的アセット限定: downloads/ 配下のみ許可
        if (!decodedPath.startsWith("downloads/")) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden path");
          return;
        }

        const imgPort = ep.httpPort || 80;
        // クエリは生のまま転送（rawPath はデコード済みだが downloads/ 配下に限定済み）
        const upstreamPath = "/" + rawPath + query;
        const ireq = http.get(
          { host: ep.ip, port: imgPort, path: upstreamPath, timeout: _IMG_FETCH_TIMEOUT_MS },
          (iresp) => {
            const status = iresp.statusCode || 502;
            if (status !== 200) {
              iresp.resume(); // ソケット解放
              res.writeHead(status, { "Content-Type": "text/plain" });
              res.end("Upstream status " + status);
              return;
            }
            const headers = {
              // サムネ/アイコンは実質不変なのでブラウザにキャッシュさせる
              "Cache-Control": "public, max-age=3600"
            };
            if (iresp.headers["content-type"]) {
              headers["Content-Type"] = iresp.headers["content-type"];
            }
            res.writeHead(200, headers);
            // サイズ上限を監視しつつストリーム返却
            let total = 0;
            iresp.on("data", (chunk) => {
              total += chunk.length;
              if (total > _IMG_MAX_BYTES) {
                ireq.destroy();
                res.destroy();
              }
            });
            iresp.pipe(res);
          }
        );
        ireq.on("timeout", () => ireq.destroy(new Error("image timeout")));
        ireq.on("error", (err) => {
          if (res.headersSent) {
            res.destroy();
            return;
          }
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end("Image fetch failed: " + (err && err.message ? err.message : "error"));
        });
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
      /* ★ v2.2.1020: バックグラウンド/最小化/非フォア時もタイマー(setInterval/
         setTimeout)・requestAnimationFrame を全速で維持する。
         既定(true)のままだと Chromium が背景窓のタイマーを 1Hz→(5分後)1/分 に絞り、
         aggregator(500ms)による画面更新の停止、通知の大幅遅延、heartbeat(30s)切れに
         よる WS 切断を招く。監視ツールとして常時リアルタイム動作が必須のため無効化する。
         （真に最小化された窓の「描画」は OS が止めるため復帰時に即時反映となるが、
           JS/タイマー/通知/WS は本設定で背景でも生き続ける。） */
      backgroundThrottling: false,
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

/* ─── Chromium フラグ: バックグラウンド スロットリング / 効率モード(EcoQoS) 抑止 ─── */
// ★ v2.2.1020: 最小化・非フォア・他窓オクルージョン時に Chromium がレンダラを
//   背景降格し、Windows 11 が効率モード(EcoQoS = PROCESS_POWER_THROTTLING_EXECUTION_SPEED)
//   を適用すると、タイマー駆動の画面更新/通知/heartbeat が停止または大幅遅延する。
//   webPreferences.backgroundThrottling=false と併せ、プロセスレベルでも背景降格を止める。
//   - disable-background-timer-throttling   : 背景窓の setTimeout/setInterval 抑制を停止
//   - disable-renderer-backgrounding        : レンダラのプロセス優先度降格(EcoQoS)を停止（効率モードの核）
//   - disable-backgrounding-occluded-windows: 他窓に隠れた窓の描画/処理停止を防止（非フォア対策）
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

/* ─── アプリケーションライフサイクル ─── */

app.whenReady().then(async () => {
  // ★ v2.2.1020: システム/アプリのサスペンドを抑止する（24/7 監視のため）。
  //   省電力スリープやアプリサスペンドでレンダラが停止し通知を取りこぼすのを防ぐ。
  //   "prevent-app-suspension" はディスプレイ消灯は許容しつつアプリの実行を維持する。
  try {
    if (_powerSaveBlockerId === null || !powerSaveBlocker.isStarted(_powerSaveBlockerId)) {
      _powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension");
      console.log(`[3dpmon] powerSaveBlocker 起動 (id=${_powerSaveBlockerId})`);
    }
  } catch (e) {
    console.warn("[3dpmon] powerSaveBlocker 起動失敗:", e.message);
  }

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

  // レンダラー(親) → リレー: 昇格PIN検証結果を反映
  ipcMain.on("relay-promote-response", (_, { clientId, granted, reason }) => {
    if (relayServer) relayServer.resolvePromote(clientId, granted, reason);
  });

  // リレーサーバ情報の問い合わせ
  ipcMain.handle("relay-get-config", () => ({
    enabled: !!relayServer,
    port: RELAY_PORT,
    clients: relayServer?.getClients() || []
  }));

  // レンダラー(親) → カメラパススルー: ホスト→エンドポイント のマップを受け取る
  // 子向け /relay-camera/{host}/snapshot.jpg の転送許可先（SSRF allowlist）になる
  ipcMain.on("set-camera-endpoints", (_e, map) => {
    if (map && typeof map === "object") {
      _cameraEndpoints = map;
    }
  });

  // レンダラー(親) → カメラ snapshot を Base64(JPEG) で取得（ItemKeeper 連携の画像添付用）
  // 親レンダラーは file:// オリジンのため CORS でプリンタ画像を直接読めない。
  // メインプロセスが _cameraEndpoints allowlist 経由で1枚取得し Base64 で返す。
  // /relay-camera プロキシと同じ取得関数・短期キャッシュを共有し、プリンタ負荷を抑える。
  ipcMain.handle("get-camera-snapshot", async (_e, host) => {
    const ep = _cameraEndpoints[host];
    if (!ep || !ep.ip) return null;
    const toResult = (buf) => ({ mime: "image/jpeg", dataBase64: buf.toString("base64"), bytes: buf.length });
    // 新鮮なキャッシュがあれば再取得しない（カメラパネル表示と取得を集約）
    const cached = _camSnapCache.get(host);
    if (cached && Date.now() - cached.ts < _CAM_CACHE_TTL_MS) return toResult(cached.buf);
    try {
      const buf = await _fetchCameraSnapshot(host, ep);
      _camSnapCache.set(host, { buf, ts: Date.now() });
      return toResult(buf);
    } catch {
      const stale = _camSnapCache.get(host);
      return stale ? toResult(stale.buf) : null;
    }
  });

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

/* 終了時: powerSaveBlocker を解放する */
app.on("will-quit", () => {
  try {
    if (_powerSaveBlockerId !== null && powerSaveBlocker.isStarted(_powerSaveBlockerId)) {
      powerSaveBlocker.stop(_powerSaveBlockerId);
    }
  } catch { /* 解放失敗は無視（プロセス終了に伴い回収される） */ }
  _powerSaveBlockerId = null;
});
