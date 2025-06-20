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
 * @version 1.390.317 (PR #143)
 * @since   1.390.193 (PR #86)
 * @lastModified 2025-06-19 22:38:18
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { currentHostname } from "./dashboard_data.js";

const containerId = 'filemanager-history';
const STORAGE_KEY_PREFIX = '3dp-filemanager-history-';
const MAX_HISTORY = 150;

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
 * 履歴データを localStorage に保存する（内部用）。
 *
 * @private
 * @param {HistoryEntry[]} historyList - 整形済み履歴エントリ配列
 * @param {VideoEntry[]}   videoList   - 関連動画エントリ配列
 */
function _storageKey() {
  return `${STORAGE_KEY_PREFIX}${currentHostname || 'default'}`;
}

function _saveHistoryData(historyList, videoList) {
  const data = { historyList, elapseVideoList: videoList };
  try {
    localStorage.setItem(_storageKey(), JSON.stringify(data));
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
function _loadHistoryData() {
  const raw = localStorage.getItem(_storageKey());
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
  saveFromPrinterData({ historyList, elapseVideoList }) {
    const history = historyList?.rawValue || [];
    const videos  = elapseVideoList?.rawValue || [];
    const stored = _loadHistoryData();

    const histMap = new Map(stored.historyList.map(h => [h.id, h]));
    history.forEach(h => {
      if (h && h.id != null) histMap.set(h.id, h);
    });
    const mergedHistory = Array.from(histMap.values())
      .sort((a, b) => b.id - a.id)
      .slice(0, MAX_HISTORY);

    const videoMap = new Map(stored.elapseVideoList.map(v => [v.id, v]));
    videos.forEach(v => {
      if (v && v.id != null) videoMap.set(v.id, v);
    });
    const mergedVideos = Array.from(videoMap.values());

    _saveHistoryData(mergedHistory, mergedVideos);
    this.render();
  },

  /**
   * 保存された履歴データを読み込み、HTML要素として描画する。
   *
   * @returns {void}
   */
  render() {
    const { historyList, elapseVideoList } = _loadHistoryData();
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
