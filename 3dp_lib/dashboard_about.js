/**
 * @fileoverview 3dpmon について ダイアログ
 * バージョン情報・著作権・リンクを表示するモーダルダイアログ。
 * Electron 版では IPC 経由で表示要求を受け取り、ブラウザ版では
 * 別途トップバーメニューから呼び出される。
 *
 * @file dashboard_about.js
 * @copyright (c) pumpCurry 2025-2026 / 5r4ce2
 *
 * @version 1.390.1119 (PR #385)
 * @lastModified 2026-06-16 23:00:00
 */

"use strict";

/** バージョン情報の取得元（フォールバック順） */
function _getAppVersion() {
  // Electron 環境では IPC 経由で取得
  if (window.electronAPI?.getVersion) {
    try { return window.electronAPI.getVersion(); } catch { /* ignore */ }
  }
  // ブラウザ版: HTML の meta タグから取得（ビルド時にも更新される）
  const meta = document.querySelector('meta[name="app-version"]');
  if (meta?.content) return meta.content;
  return "unknown";
}

/** 環境名（Electron版 / ブラウザ版） */
function _getEnvLabel() {
  if (window.electronAPI?.isElectron?.()) {
    const isPortable = location.href.includes("portable") ||
                       (window.electronAPI?.getPlatform?.() && false); // detect portable later
    return "Electron版";
  }
  return "ブラウザ版";
}

let _styleInjected = false;
function _injectStyles() {
  if (_styleInjected) return;
  _styleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .about-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.6);
      z-index: 99999;
      display: flex; align-items: center; justify-content: center;
      animation: about-fade 0.15s ease-out;
    }
    @keyframes about-fade {
      from { opacity: 0; } to { opacity: 1; }
    }
    .about-dialog {
      /* ★ 常時ダーク固定（ヘッダが濃色グラデのため）。アプリのテーマトークンに
         依存すると surface=明 / text=明 の不整合で値が白抜き(不可視)になるため
         明示色で自己完結させる。 */
      background: #1e293b;
      color: #f1f5f9;
      border: 1px solid #334155;
      border-radius: 8px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.5);
      width: 480px; max-width: calc(100vw - 40px);
      max-height: calc(100vh - 40px);
      overflow-y: auto;
      padding: 0;
    }
    .about-header {
      display: flex; align-items: center; gap: 16px;
      padding: 20px;
      background: linear-gradient(135deg, #0f172a, #1e3a8a);
      border-radius: 8px 8px 0 0;
    }
    .about-icon {
      width: 80px; height: 80px;
      border-radius: 16px;
      flex-shrink: 0;
      background: #0f172a;
      object-fit: contain;
    }
    .about-title-block { flex: 1; min-width: 0; }
    .about-title {
      font-size: 1.6em; font-weight: bold;
      margin: 0 0 4px;
      color: #f1f5f9;
    }
    .about-tagline {
      font-size: 0.9em; color: #cbd5e1;
      margin: 0;
    }
    .about-body { padding: 16px 20px; }
    .about-row {
      display: flex; padding: 6px 0;
      border-bottom: 1px solid #334155;
      font-size: 0.9em;
    }
    .about-row:last-child { border-bottom: none; }
    .about-label {
      width: 110px; flex-shrink: 0;
      color: #94a3b8;
    }
    .about-value { flex: 1; word-break: break-all; color: #f1f5f9; }
    .about-value a { color: #0ea5e9; text-decoration: none; }
    .about-value a:hover { text-decoration: underline; }
    .about-footer {
      padding: 12px 20px;
      background: rgba(0,0,0,0.2);
      border-top: 1px solid #334155;
      display: flex; gap: 8px; align-items: center; justify-content: flex-end;
      border-radius: 0 0 8px 8px;
    }
    /* 更新確認ステータス（最新リリースボタンの前） */
    .about-update-status {
      margin-right: auto;
      font-size: 0.82em;
      color: #94a3b8;
    }
    .about-update-status.up-to-date { color: #34d399; }
    .about-update-status.update-available { color: #fbbf24; font-weight: bold; }
    .about-update-status.unknown { color: #64748b; }
    .about-btn {
      padding: 6px 16px; border-radius: 4px;
      border: 1px solid #475569;
      background: #334155;
      color: #f1f5f9;
      cursor: pointer; font-size: 0.9em;
    }
    .about-btn:hover { background: #0ea5e9; border-color: #0ea5e9; }
    .about-btn-primary { background: #0ea5e9; border-color: #0ea5e9; }
    .about-license {
      font-size: 0.78em; color: #94a3b8;
      padding: 8px 20px 0;
      line-height: 1.5;
    }
  `;
  document.head.appendChild(style);
}

/**
 * About ダイアログを表示する。
 * 既に開いている場合は何もしない。
 *
 * @returns {void}
 */
export function showAboutDialog() {
  _injectStyles();
  // 既存ダイアログがあれば閉じる
  const existing = document.querySelector(".about-overlay");
  if (existing) { existing.remove(); }

  const version = _getAppVersion();
  const envLabel = _getEnvLabel();
  const ua = navigator.userAgent;
  const chromeMatch = ua.match(/Chrome\/([0-9.]+)/);
  const electronMatch = ua.match(/Electron\/([0-9.]+)/);
  const chromeVer = chromeMatch ? chromeMatch[1] : "—";
  const electronVer = electronMatch ? electronMatch[1] : "—";

  // アイコンパス: build/icon-source.png を優先、なければ favicon.ico
  const iconCandidates = ["build/icon-source.png", "favicon.ico"];
  let iconSrc = iconCandidates[0];

  const overlay = document.createElement("div");
  overlay.className = "about-overlay";
  overlay.innerHTML = `
    <div class="about-dialog" role="dialog" aria-labelledby="about-title">
      <div class="about-header">
        <img class="about-icon" src="${iconCandidates[0]}" alt="3dpmon"
             onerror="this.onerror=null;this.src='${iconCandidates[1]}';">
        <div class="about-title-block">
          <h2 class="about-title" id="about-title">3dpmon</h2>
          <p class="about-tagline">3Dプリンタ監視ダッシュボード</p>
        </div>
      </div>
      <div class="about-body">
        <div class="about-row">
          <span class="about-label">バージョン</span>
          <span class="about-value"><strong>v${version}</strong> (${envLabel})</span>
        </div>
        <div class="about-row">
          <span class="about-label">対応機種</span>
          <span class="about-value">CREALITY K1 / K1C / K1 Max ／ Klipper・Moonraker 機 (Fluidd) ※Ideaformer IR3 v2 等</span>
        </div>
        <div class="about-row">
          <span class="about-label">著作権</span>
          <span class="about-value">© 2025-2026 pumpCurry / 5r4ce2</span>
        </div>
        <div class="about-row">
          <span class="about-label">ライセンス</span>
          <span class="about-value">修正BSDライセンス (3条項)</span>
        </div>
        <div class="about-row">
          <span class="about-label">GitHub</span>
          <span class="about-value"><a href="https://github.com/pumpCurry/3dpmon" target="_blank" rel="noopener">github.com/pumpCurry/3dpmon</a></span>
        </div>
        <div class="about-row">
          <span class="about-label">ウェブ</span>
          <span class="about-value"><a href="https://542.jp/" target="_blank" rel="noopener">https://542.jp/</a></span>
        </div>
        <div class="about-row">
          <span class="about-label">エンジン</span>
          <span class="about-value">Electron ${electronVer} / Chromium ${chromeVer}</span>
        </div>
      </div>
      <div class="about-license">
        本ソフトウェアは「現状のまま」提供されており、いかなる保証もありません。
        詳細はライセンス全文を参照してください。
      </div>
      <div class="about-footer">
        <span class="about-update-status" data-role="update-status" aria-live="polite">確認中…</span>
        <button class="about-btn" data-action="release">最新リリース</button>
        <button class="about-btn about-btn-primary" data-action="close">閉じる</button>
      </div>
    </div>
  `;

  // ─── イベントハンドラ ───
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();  // 背景クリックで閉じる
  });
  overlay.querySelector('[data-action="close"]').addEventListener("click", () => overlay.remove());
  overlay.querySelector('[data-action="release"]').addEventListener("click", () => {
    const url = "https://github.com/pumpCurry/3dpmon/releases";
    if (window.electronAPI?.isElectron?.()) {
      // Electron では shell.openExternal を使うべきだが、IPC が無いので window.open
      window.open(url, "_blank");
    } else {
      window.open(url, "_blank");
    }
  });
  // ESC で閉じる
  function escHandler(e) {
    if (e.key === "Escape") {
      overlay.remove();
      document.removeEventListener("keydown", escHandler);
    }
  }
  document.addEventListener("keydown", escHandler);

  document.body.appendChild(overlay);

  // ─── 更新確認（開いたとき1回だけ・失敗時は即諦めて "----"） ───
  _checkLatestRelease(version, overlay.querySelector('[data-role="update-status"]'));
}

/**
 * セマンティックなバージョン文字列を比較する（"2.2.1026" 形式）。
 * 区切りは . - + を許容し、各セグメントを数値比較する。
 *
 * @private
 * @param {string} a - バージョンA
 * @param {string} b - バージョンB
 * @returns {number} a>b なら 1 / a<b なら -1 / 同等なら 0
 */
function _compareVersions(a, b) {
  const pa = String(a).split(/[.\-+]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.\-+]/).map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/**
 * GitHub の最新リリースを1回だけ確認し、ステータス表示を更新する。
 *
 * 【詳細説明】
 * - `確認中…` → `最新版をご利用中です` / `最新版 vX.Y.Z があります` を表示。
 * - オフライン/到達不可/レート制限/タイムアウト時は **即座に諦めて `----`**。
 *   AbortController で 5 秒タイムアウトし、再試行・ループ・スロットルは行わない。
 *
 * @private
 * @param {string} currentVersion - 現在のアプリバージョン
 * @param {HTMLElement|null} statusEl - 表示先要素
 * @returns {Promise<void>}
 */
async function _checkLatestRelease(currentVersion, statusEl) {
  if (!statusEl) return;
  statusEl.textContent = "確認中…";
  statusEl.className = "about-update-status checking";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(
      "https://api.github.com/repos/pumpCurry/3dpmon/releases/latest",
      { signal: controller.signal, headers: { Accept: "application/vnd.github+json" } }
    );
    clearTimeout(timer);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const latest = String(data?.tag_name || data?.name || "").trim().replace(/^v/i, "");
    if (!latest) throw new Error("no tag");

    const cur = String(currentVersion).replace(/^v/i, "");
    if (_compareVersions(latest, cur) > 0) {
      statusEl.textContent = `最新版 v${latest} があります`;
      statusEl.className = "about-update-status update-available";
    } else {
      statusEl.textContent = "最新版をご利用中です";
      statusEl.className = "about-update-status up-to-date";
    }
  } catch {
    clearTimeout(timer);
    // オフライン/到達不可/タイムアウト等 → 即諦めて "----"（再試行しない）
    statusEl.textContent = "----";
    statusEl.className = "about-update-status unknown";
  }
}

/**
 * Electron からの「3dpmon について」メニュー要求をリッスンする。
 * 起動時に1回だけ呼ぶ。
 *
 * @returns {void}
 */
export function initAboutDialogListener() {
  if (window.electronAPI?.onShowAboutDialog) {
    window.electronAPI.onShowAboutDialog(() => showAboutDialog());
  }
}
