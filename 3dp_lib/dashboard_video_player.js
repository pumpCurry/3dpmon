/**
 * @fileoverview
 *  @description 3Dプリンタ監視ツール 3dpmon 用 動画オーバーレイプレーヤー モジュール
 * @file dashboard_video_player.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_video_player
 * 【機能内容サマリ】
 * - 動画ダウンロードとオーバーレイ再生UI
 *
 * 【公開関数一覧】
 * - {@link showVideoOverlay}：動画を取得して再生
 *
 * @version 1.390.315 (PR #143)
 * @since   1.390.193 (PR #86)
 * @lastModified 2025-06-19 22:01:15
 * -----------------------------------------------------------
 * @todo
 * - なし
 */

"use strict";

import { showConfirmDialog } from "./dashboard_ui_confirm.js";

/**
 * 動画をダウンロードして再生するオーバーレイを表示します。
 * 取得中はスピナーと進捗バーを表示し、完了後に保存ボタンと
 * 戻るボタン付きの動画プレーヤーを表示します。
 *
 * @param {string} url - ダウンロード元の動画URL
 * @returns {Promise<void>} ダウンロード完了後に解決する Promise
 */
export async function showVideoOverlay(url) {
  if (!url) return;

  // オーバーレイ要素を生成して DOM に追加
  const overlay = document.createElement("div");
  overlay.className = "video-overlay";
  overlay.innerHTML = `
    <div class="video-box">
      <div class="spinner video-spinner"></div>
      <progress class="video-progress" value="0" max="100"></progress>
      <div class="video-actions hidden">
        <video class="video-player" controls></video>
        <div class="video-buttons">
          <button class="video-save">保存</button>
          <button class="video-back">戻る</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const progressEl = overlay.querySelector(".video-progress");
  const spinner    = overlay.querySelector(".video-spinner");
  const actions    = overlay.querySelector(".video-actions");
  const videoEl    = overlay.querySelector(".video-player");
  const btnSave    = overlay.querySelector(".video-save");
  const btnBack    = overlay.querySelector(".video-back");

  /** 進捗バー更新 */
  const updateProgress = (loaded, total) => {
    if (!total) return;
    const pct = Math.floor((loaded / total) * 100);
    progressEl.value = pct;
  };

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.statusText);
    const total = Number(res.headers.get("Content-Length")) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      updateProgress(received, total);
    }
    const blob = new Blob(chunks, { type: res.headers.get("Content-Type") || "video/mp4" });
    const blobUrl = URL.createObjectURL(blob);

    // プレーヤー表示に切り替え
    spinner.classList.add("hidden");
    progressEl.classList.add("hidden");
    actions.classList.remove("hidden");
    videoEl.src = blobUrl;

    // 保存処理
    btnSave.onclick = () => {
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = url.split("/").pop() || "video.mp4";
      a.click();
    };

    // 戻る処理
    btnBack.onclick = () => {
      URL.revokeObjectURL(blobUrl);
      overlay.remove();
    };
  } catch (e) {
    spinner.classList.add("hidden");
    progressEl.classList.add("hidden");
    await showConfirmDialog({
      level: "error",
      title: "動画取得失敗",
      message: e.message,
      confirmText: "OK"
    });
    overlay.remove();
  }
}
