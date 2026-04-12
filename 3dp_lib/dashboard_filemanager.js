/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 ファイルマネージャ UI モジュール
 * @file dashboard_filemanager.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_filemanager
 *
 * 【機能内容サマリ】
 * - 印刷履歴データの保存と表示を管理
 *
 * 【公開関数一覧】
 * - {@link FileManager}：履歴ロード・保存のユーティリティ
 *
 * @version 1.390.767 (PR #353)
 * @since   1.390.193 (PR #86)
 * @lastModified 2025-08-07 22:24:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { MAX_PRINT_HISTORY } from "./dashboard_storage.js";

const containerId = 'filemanager-history';
const STORAGE_KEY_PREFIX = '3dp-filemanager-history-';
/**
 * @typedef {Object} HistoryEntry
 * @property {number} id             ジョブID
 * @property {string} filename       ファイル名（パスを含む場合あり）
 * @property {number} starttime      開始時刻の UNIX タイムスタンプ（秒）
 * @property {number} [usagematerial] 使用量（mm）
 * @property {string} [thumbnail]    サムネイル URL
 * @property {string} hostname       ホスト名
 * @property {string} ip             IP アドレス
 * @property {number} updatedEpoch   情報更新時刻(秒)
 */

/**
 * @typedef {Object} VideoEntry
 * @property {number} id    ジョブID に対応
 * @property {string} video 動画 URL
 */

/**
 * localStorage 保存用のキー文字列を生成する。
 *
 * ホストごとに個別のキーを返すことで、複数ホストの履歴が混ざる
 * ことを防ぐ。
 *
 * @private
 * @returns {string} 生成した保存用キー
 */
function _storageKey(hostname) {
  if (!hostname) {
    throw new Error("[IMPL_ERROR] _storageKey: hostname is required (was: " + hostname + ")");
  }
  return `${STORAGE_KEY_PREFIX}${hostname}`;
}

/**
 * 履歴データと関連動画リストを localStorage に保存する。
 *
 * 保存処理は try-catch で保護し、失敗時は警告のみを出力する。
 *
 * @private
 * @param {HistoryEntry[]} historyList - 整形済み履歴エントリ配列
 * @param {VideoEntry[]}   videoList   - 関連動画エントリ配列
 * @returns {void}
 */
function _saveHistoryData(historyList, videoList, hostname) {
  const data = { historyList, elapseVideoList: videoList };
  try {
    localStorage.setItem(_storageKey(hostname), JSON.stringify(data));
  } catch (e) {
    console.warn('[FileManager] saveHistoryData failed:', e);
  }
}

/**
 * localStorage から履歴データを読み込む（内部用）。
 *
 * @private
 * @returns {{
 *   historyList: HistoryEntry[],
 *   elapseVideoList: VideoEntry[]
 * }}
 */
function _loadHistoryData(hostname) {
  const raw = localStorage.getItem(_storageKey(hostname));
  if (!raw) return { historyList: [], elapseVideoList: [] };
  try {
    const data = JSON.parse(raw);
    return {
      historyList: Array.isArray(data.historyList) ? data.historyList : [],
      elapseVideoList: Array.isArray(data.elapseVideoList) ? data.elapseVideoList : []
    };
  } catch (e) {
    console.warn('[FileManager] loadHistoryData parse error:', e);
    return { historyList: [], elapseVideoList: [] };
  }
}

/**
 * ファイルマネージャ UI モジュール。
 */
export const FileManager = {
  /**
   * 初期化処理。履歴ビューの初回描画を行う。
   */
  init() {
    this.render();
  },

  /**
   * プリンタから受け取った生データを永続化し、UIを再描画する。
   *
   * @param {object}               printerData
   * @param {{ rawValue: HistoryEntry[] }} printerData.historyList
   *   - 生データの印刷履歴配列
   * @param {{ rawValue: VideoEntry[] }}   printerData.elapseVideoList
   *   - 生データの動画リスト配列
   * @returns {void}
   */
  saveFromPrinterData({ historyList, elapseVideoList }, hostname) {
    const history = historyList?.rawValue || [];
    const videos  = elapseVideoList?.rawValue || [];
    const stored = _loadHistoryData(hostname);

    const histMap = new Map(stored.historyList.map(h => [h.id, h]));
    history.forEach(h => {
      if (h && h.id != null) histMap.set(h.id, h);
    });
    const mergedHistory = Array.from(histMap.values())
      .sort((a, b) => b.id - a.id)
      .slice(0, MAX_PRINT_HISTORY);

    const videoMap = new Map(stored.elapseVideoList.map(v => [v.id, v]));
    videos.forEach(v => {
      if (v && v.id != null) videoMap.set(v.id, v);
    });
    const mergedVideos = Array.from(videoMap.values());

    _saveHistoryData(mergedHistory, mergedVideos, hostname);
    this.render(hostname);
  },

  /**
   * 保存された履歴データを読み込み、HTML要素として描画する。
   *
   * @returns {void}
   */
  render(hostname) {
    const { historyList, elapseVideoList } = _loadHistoryData(hostname);
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    historyList.forEach(entry => {
      const card = document.createElement('div');
      card.className = 'history-card';

      const fileName = entry.filename?.split('/').pop() || '（不明）';
      const dateStr  = new Date(entry.starttime * 1000).toLocaleString();
      const thumbHtml = entry.thumbnail
        ? `<img src="${entry.thumbnail}" width="100" alt="サムネイル">`
        : '';

      const video = elapseVideoList.find(v => v.id === entry.id);
      const videoLink = video
        ? `<a href="${video.video}" target="_blank" rel="noopener">📹 動画</a>`
        : '';

      card.innerHTML = `
        <div class="card-header"><strong>${fileName}</strong></div>
        <div>開始日時: ${dateStr}</div>
        <div>材料使用量: ${Math.round(entry.usagematerial || 0)} mm</div>
        ${thumbHtml}
        <div>${videoLink}</div>
      `;
      container.appendChild(card);
    });
  }
};
