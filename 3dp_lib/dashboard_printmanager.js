/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 印刷履歴管理モジュール
 * @file dashboard_printmanager.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_printManager
 *
 * 【機能内容サマリ】
 * - 印刷履歴および現在ジョブの保存・描画
 * - Template 処理を分離した柔軟なUI生成
 *
 * 【公開関数一覧】
 * - {@link parseRawHistoryEntry}：履歴エントリ解析
 * - {@link parseRawHistoryList}：履歴リスト解析
 * - {@link loadCurrent}：現在ジョブ読み込み
 * - {@link saveCurrent}：現在ジョブ保存
 * - {@link loadHistory}：履歴読み込み
 * - {@link saveHistory}：履歴保存
 * - {@link loadVideos}：動画一覧読み込み
 * - {@link saveVideos}：動画一覧保存
 * - {@link jobsToRaw}：内部モデル→生データ変換
 *
* @version 1.390.767 (PR #353)
* @since   1.390.197 (PR #88)
* @lastModified 2025-08-07 22:24:00
 * -----------------------------------------------------------
 * @todo
 * - none
*/
"use strict";

import {
  loadPrintCurrent,
  savePrintCurrent,
  loadPrintHistory,
  savePrintHistory,
  loadPrintVideos,
  savePrintVideos,
  MAX_PRINT_HISTORY
} from "./dashboard_storage.js";

import { formatEpochToDateTime, formatDuration } from "./dashboard_utils.js";
import { pushLog } from "./dashboard_log_util.js";
import { showConfirmDialog, showInputDialog } from "./dashboard_ui_confirm.js";
import { monitorData, scopedById, setStoredDataForHost } from "./dashboard_data.js";
import {
  getCurrentSpool,
  getCurrentSpoolId,
  setCurrentSpoolId,
  useFilament,
  getSpoolById,
  updateSpool,
  formatFilamentAmount,
  formatSpoolDisplayId,
  buildFilamentRecommendations
} from "./dashboard_spool.js";
import { sendCommand, fetchStoredData, getDeviceIp, getConnectionState } from "./dashboard_connection.js";
import { showVideoOverlay } from "./dashboard_video_player.js";
import { showSpoolDialog, showSpoolSelectDialog } from "./dashboard_spool_ui.js";
import { showHistoryFilamentDialog, updatePreview as updateFilamentPreview } from "./dashboard_filament_change.js";
import { PRINT_STATE_CODE } from "./dashboard_ui_mapping.js";
import { getCurrentPrintID } from "./dashboard_aggregator.js";

/**
 * 履歴エントリのスプール変更が現在印刷中ジョブに対するものか判定し、
 * 該当する場合は機器装着スプールとフィラメントプレビューも連動更新する。
 *
 * @private
 * @param {Object} raw - 変更対象の履歴 raw オブジェクト
 * @param {Object} updatedSp - 新しいスプールオブジェクト
 * @param {string} hostname - ホスト名
 */
function _linkCurrentPrintSpool(raw, updatedSp, hostname) {
  const machine = monitorData.machines[hostname];
  if (!machine) return;
  const st = Number(machine.runtimeData?.state ?? 0);
  const isPrinting =
    st === PRINT_STATE_CODE.printStarted ||
    st === PRINT_STATE_CODE.printPaused;
  if (!isPrinting) return;

  // 現在印刷中のジョブIDと一致するか確認
  const curJob = loadCurrent(hostname);
  if (!curJob || String(curJob.id) !== String(raw.id)) return;

  // 既に同じスプールが装着済みなら何もしない
  if (getCurrentSpoolId(hostname) === updatedSp.id) return;

  // 装着スプールを変更（setCurrentSpoolId は旧スプールの精算も行うが、
  // 呼び出し元で既に残量調整済みのため、per-host ポインタの切替のみ必要）
  const oldId = getCurrentSpoolId(hostname);
  // per-host マップを更新（グローバル値はレガシー互換で維持）
  monitorData.hostSpoolMap[hostname] = updatedSp.id;
  monitorData.currentSpoolId = updatedSp.id;
  // 該当ホストのスプールのみ isActive を切り替え（他ホスト装着分には触れない）
  const oldSpool = getSpoolById(oldId);
  if (oldSpool && oldSpool.hostname === hostname) {
    oldSpool.isActive = false;
    oldSpool.isInUse = false;
  }
  updatedSp.isActive = true;
  updatedSp.isInUse = true;
  updatedSp.hostname = hostname;
  // aggregator の追跡を新スプールに切り替え
  if (updatedSp.currentJobStartLength == null) {
    updatedSp.currentJobStartLength = updatedSp.remainingLengthMm;
  }
  updatedSp.currentPrintID = String(curJob.id);
  // storedData を更新してフィラメントプレビューを連動
  setStoredDataForHost(hostname, "filamentRemainingMm", updatedSp.remainingLengthMm, true);
  pushLog(
    `[renderHistoryTable] 現在印刷ジョブのスプール変更を検出: ${oldId} → ${updatedSp.id}`,
    "info", false, hostname
  );
}

/**
 * パース済み履歴 raw オブジェクトにフィラメント情報を書き込む。
 * updateHistoryList の再パースを回避し、filename/printfinish の破壊を防ぐ。
 *
 * @private
 * @param {Object} raw - パース済み履歴エントリ
 * @param {Object} sp - スプールオブジェクト
 * @returns {void}
 */
function _applyFilamentToRaw(raw, sp) {
  raw.filamentInfo = [{
    spoolId: sp.id, serialNo: sp.serialNo,
    spoolName: sp.name, colorName: sp.colorName,
    filamentColor: sp.filamentColor, material: sp.material,
    spoolCount: sp.printCount,
    expectedRemain: sp.remainingLengthMm
  }];
  raw.filamentId = sp.id;
  raw.filamentColor = sp.filamentColor;
  raw.filamentType = sp.material;
}

/**
 * 保存済み履歴にフィラメント情報をパッチし永続化する。
 * updateHistoryList を通さないことで、再パースによるデータ破壊を防ぐ。
 *
 * @private
 * @param {Object} raw - パース済み履歴エントリ（filamentInfo 等がセット済み）
 * @param {string} hostname - ホスト名
 * @returns {void}
 */
function _patchHistoryFilament(raw, hostname) {
  const jobs = loadHistory(hostname);
  const job = jobs.find(j => String(j.id) === String(raw.id));
  if (job) {
    job.filamentInfo = raw.filamentInfo;
    job.filamentId = raw.filamentId;
    job.filamentColor = raw.filamentColor;
    job.filamentType = raw.filamentType;
    saveHistory(jobs, hostname);
  }
  // current にも反映
  const cur = loadCurrent(hostname);
  if (cur && String(cur.id) === String(raw.id)) {
    cur.filamentInfo = raw.filamentInfo;
    cur.filamentId = raw.filamentId;
    cur.filamentColor = raw.filamentColor;
    cur.filamentType = raw.filamentType;
    saveCurrent(cur, hostname);
    renderPrintCurrent(scopedById("print-current-container", hostname), hostname);
  }
}

/**
 * 履歴マージ時にゼロ値を無視したいフィールド一覧
 *
 * これらのタイマー値は機器から送信されないため、
 * サーバー取得データが 0 を示していても未計測とみなし、
 * 本モジュールが保持している値を優先する。
 *
 * @constant {Set<string>}
 */
const MERGE_IGNORE_ZERO_FIELDS = new Set([
  "preparationTime",
  "firstLayerCheckTime",
  "pauseTime",
  // 使用フィラメント量は印刷途中では 0 になるため保持値を優先
  "materialUsedMm"
]);

// 最後に保存した JSON 文字列のキャッシュ（差分チェック用、per-host）
const _lastSavedJsonMap = new Map();

/** ドキュメント全体のドロップハンドラが登録済みか */
let _dropHandlerInstalled = false;
/** アップロード確認ダイアログでの選択済みホスト（confirmボタン押下時にキャプチャ） */
let _lastSelectedUploadHosts = [];


// 最新のファイル一覧データ（renderFileList 実行時に更新、per-host）
const _fileListMap = new Map();

/**
 * 指定ホストのファイル一覧を返す。
 * renderFileList で更新された最新データのスナップショット。
 *
 * @param {string} hostname - ホスト名
 * @returns {Array<Object>} ファイルエントリ配列（空なら空配列）
 */
export function getFileList(hostname) {
  return _fileListMap.get(hostname) || [];
}

/**
 * GCode メタデータキャッシュ。
 * アップロード時に抽出したメタデータをファイル名（basename）をキーに保持し、
 * 印刷開始確認やファイル一覧の所要時間表示に使用する。
 * localStorage に永続化し、リロード後もキャッシュを利用可能にする。
 * @type {Map<string, {timeSec?:number, time?:string, filament?:string, filamentMm?:number, layers?:string, layerHeight?:string, material?:string, nozzleTemp?:string, bedTemp?:string}>}
 */
const _GCODE_META_STORAGE_KEY = "3dpmon_gcode_meta_cache";
const _gcodeMetaCache = new Map();
try {
  const saved = localStorage.getItem(_GCODE_META_STORAGE_KEY);
  if (saved) {
    const obj = JSON.parse(saved);
    for (const [k, v] of Object.entries(obj)) _gcodeMetaCache.set(k, v);
  }
} catch { /* 無視 */ }

/** キャッシュを localStorage に保存する */
function _saveGcodeMetaCache() {
  try {
    const obj = Object.fromEntries(_gcodeMetaCache);
    localStorage.setItem(_GCODE_META_STORAGE_KEY, JSON.stringify(obj));
  } catch { /* 無視 */ }
}

/*
 * サムネイル URL を生成（メーカー仕様: downloads/humbnail/{basename}.png）
 * @param {string} baseUrl    サーバーのベース URL (例: "http://192.168.1.5")
 * @param {number} id         履歴エントリの ID
 * @param {string} filemd5    ファイルの MD5 ハッシュ
 * @param {string} rawFilename   履歴エントリの filename フルパス。
 *   未定義時は空文字列を返す
 * @returns {string}
 */
function makeThumbUrl(baseUrl, rawFilename) {
  if (!rawFilename) return "";
  // パスからファイル名部分だけ取り出し (例: ".../foo.gcode" → "foo.gcode")
  const fname = rawFilename.split("/").pop() || "";
  // 拡張子を取り除く (例: "foo.gcode" → "foo")
  const base  = fname.replace(/\.[^/.]+$/, "");
  // メーカー仕様フォルダ名は "humbnail"
  return `${baseUrl}/downloads/humbnail/${base}.png`;
}


/**
 * 生の履歴エントリをモデル化
 * @param {Object} raw           - 元データ
 * @param {string} baseUrl       - サムネイル取得用ベース URL
 * @returns {{
 *   id:number,
 *   rawFilename:string,
 *   filename:string,
 *   startTime:string,
 *   finishTime?:string|null,
 *   materialUsedMm:number,
 *   thumbUrl:string,
 *   startway?:number,
 *   size?:number,
 *   filemd5?:string,
 *   printfinish?:number,        // 成功フラグ(1/0)
 *   preparationTime?:number,
 *   firstLayerCheckTime?:number,
 *   pauseTime?:number,
 *   filamentId?:string,
 *   filamentColor?:string,
 *   filamentType?:string
 * }}
 * @description
 * 受信した生データ `raw` をHTML描画用オブジェクトに整形します。
 * サムネイルURL生成や開始方式などの追加情報もここで抽出します。
 */
export function parseRawHistoryEntry(raw, baseUrl, host) {
  const id             = raw.id;
  const filename       = raw.filename?.split("/").pop() || "(不明)";
  // フルパスも保持しておくことでコマンド送信時に利用できるようにする
  const rawFilename    = raw.filename;
  const startSec       = raw.starttime || 0;
  const actualStartSec = raw.actualStartTime != null ? Number(raw.actualStartTime) : null;
  const useTimeSec     = raw.usagetime || 0;
  const startTime      = new Date(startSec * 1000).toISOString();
  const actualStartTime = actualStartSec != null ? new Date(actualStartSec * 1000).toISOString() : null;
  const finishTime     = useTimeSec > 0
    ? new Date((startSec + useTimeSec) * 1000).toISOString()
    : null;
  // raw.usagetime が 0 でも 1 を返す場合があるため、機器の報告値を優先
  const printfinish    = raw.printfinish != null
    ? Number(raw.printfinish)
    // 値が存在しない場合のみ使用時間から推測
    : (useTimeSec > 0 ? 1 : 0);
  // 材料使用量: 機器報告値をそのまま保持（丸めない）
  const materialUsedMm = Number(raw.usagematerial || 0);

  // raw.filename に基づくサムネイル生成
  const thumbUrl       = makeThumbUrl(baseUrl, raw.filename);

  const startway       = raw.startway;
  const size           = raw.size;
  const filemd5        = raw.filemd5;

  const preparationTime     = raw.preparationTime;
  const firstLayerCheckTime = raw.firstLayerCheckTime;
  const pauseTime           = raw.pauseTime;
  const filamentId          = raw.filamentId;
  const filamentColor       = raw.filamentColor;
  const filamentType        = raw.filamentType;
  const filamentInfo        = raw.filamentInfo;

  const hostname            = host || "";
  const ip                  = getDeviceIp(host);
  const updatedEpoch        = Math.floor(Date.now() / 1000);

  return {
    id,
    rawFilename,
    filename,
    startTime,
    actualStartTime,
    finishTime,
    printfinish,
    materialUsedMm,
    thumbUrl,
    startway,
    size,
    filemd5,
    preparationTime,
    firstLayerCheckTime,
    pauseTime,
    filamentId,
    filamentColor,
    filamentType,
    filamentInfo,
    hostname,
    ip,
    updatedEpoch
  };
}

/**
 * 生配列からフィルタ・ソート・制限をかけた履歴リストを返す
 * @param {Array<Object>} rawArray - 元データ配列
 * @param {string} baseUrl         - サムネイル取得用ベース URL
 * @returns {Array<ReturnType<typeof parseRawHistoryEntry>>}
 * @description
 *  `filename` を持たない履歴エントリでも `filamentInfo` が存在する場合は
 *  フィルタを通過させ、スプール情報のみの更新を反映できるようにする。
 */
export function parseRawHistoryList(rawArray, baseUrl, host) {
  return rawArray
    .filter(r =>
      (typeof r.filename === "string" && r.filename.length > 0) ||
      (Array.isArray(r.filamentInfo) && r.filamentInfo.length > 0)
    )
    .map(r => parseRawHistoryEntry(r, baseUrl, host))
    .sort((a, b) => b.id - a.id)
    .slice(0, MAX_PRINT_HISTORY);
}

// ---------------------- ストレージ操作 ----------------------

/**
 * 現在印刷中ジョブをロード
 * @param {string} hostname - ホスト名
 * @returns {Object|null}
 */
export function loadCurrent(hostname) {
  return loadPrintCurrent(hostname);
}

/**
 * 現在印刷中ジョブを保存
 * @param {Object|null} job
 * @param {string} hostname - ホスト名
 */
export function saveCurrent(job, hostname) {
  savePrintCurrent(job, hostname);
}

/**
 * 履歴一覧をロード
 * @param {string} hostname - ホスト名
 * @returns {Array<Object>}
 */
export function loadHistory(hostname) {
  return loadPrintHistory(hostname);
}

/**
 * 印刷履歴データを保存する。
 *
 * - `parseRawHistoryList()` などから生成された履歴配列を受け取り、
 *   前回と同一でなければ localStorage に保存を行う。
 * - 差分がなければ保存をスキップして無駄な write を抑制する。
 * - 保存時には info ログを出力する。
 *
 * @param {Array<Object>} jobs - parseRawHistoryList により構成された履歴モデル配列
 * @returns {void}
 */
export function saveHistory(jobs, hostname) {
  const host = hostname;
  if (!host) return;
  const json = JSON.stringify(jobs);
  if (json === _lastSavedJsonMap.get(host)) {
    // 変更なしならスキップ
    return;
  }
  _lastSavedJsonMap.set(host, json);
  savePrintHistory(jobs, host);
  pushLog("[saveHistory] 印刷履歴を保存しました", "info", false, hostname);
}

/**
 * 保存済みの動画マップを取得する。
 * @returns {Record<string, string>}
 */
export function loadVideos(hostname) {
  return loadPrintVideos(hostname);
}

/**
 * 動画マップを保存する。
 * @param {Record<string, string>} map
 */
export function saveVideos(map, hostname) {
  savePrintVideos(map, hostname);
}

/**
 * 保存済みジョブ配列を履歴テーブル用の簡易 raw 形式に変換します。
 *
 * @param {Array<Object>} jobs - loadHistory() で取得した履歴配列
 * @returns {Array<Object>} テーブル描画用のオブジェクト配列
 * @description
 * `jobs` 配列に含まれる各要素を表示用に整形し、
 * `renderHistoryTable()` が要求するフィールドを備えた
 * オブジェクト配列へ変換します。具体的には以下のプロパティを持ちます:
 * - `id`               : 履歴エントリ ID
 * - `filename`         : ファイル名
 * - `startway`         : 開始方式 (数値)
 * - `size`             : ファイルサイズ
 * - `ctime`            : 作成時刻(UNIX秒)
 * - `starttime`        : 開始時刻(UNIX秒)
 * - `usagetime`        : 使用時間(秒)
 * - `usagematerial`    : 使用フィラメント量(mm)
 * - `printfinish`      : 成功フラグ(1/0)
 * - `filemd5`          : ファイルMD5ハッシュ
 * - `rawFilename`      : フルパス(存在すれば)
 * - その他 `videoUrl` など追加情報
 */
export function jobsToRaw(jobs) {
    return jobs.map(job => {
      const startEpoch = job.startTime ? Date.parse(job.startTime) / 1000 : 0;
      const finishEpoch = job.finishTime ? Date.parse(job.finishTime) / 1000 : 0;
      return {
        id:            job.id,
        filename:      job.filename,
        ...(job.rawFilename !== undefined && { rawFilename: job.rawFilename }),
        startway:      job.startway ?? null,
        size:          job.size ?? 0,
        ctime:         startEpoch,
        starttime:     startEpoch,
        ...(job.actualStartTime !== undefined && { actualStartTime: Date.parse(job.actualStartTime) / 1000 }),
        ...(finishEpoch && { endtime: finishEpoch }),
        usagetime:     finishEpoch ? finishEpoch - startEpoch : 0,
        usagematerial: job.materialUsedMm,
        printfinish:   job.printfinish ?? (finishEpoch ? 1 : 0),
        filemd5:       job.filemd5 ?? "",
      ...(job.videoUrl !== undefined && { videoUrl: job.videoUrl }),
      ...(job.preparationTime      !== undefined && { preparationTime:      job.preparationTime }),
      ...(job.firstLayerCheckTime   !== undefined && { firstLayerCheckTime:   job.firstLayerCheckTime }),
      ...(job.pauseTime             !== undefined && { pauseTime:             job.pauseTime }),
      ...(job.filamentId            !== undefined && { filamentId:            job.filamentId }),
      ...(job.filamentColor         !== undefined && { filamentColor:         job.filamentColor }),
      ...(job.filamentType          !== undefined && { filamentType:          job.filamentType })
      ,...(job.filamentInfo         !== undefined && { filamentInfo:         job.filamentInfo })
    };
  });
}

// ---------------------- 描画テンプレート ----------------------

/**
 * ISO8601 文字列を「YYYY-MM-DD hh:mm:ss」に整形
 * @param {string|null} iso
 * @returns {string}
 */
function fmtISO(iso) {
  return iso
    ? iso.replace("T", " ").replace(/\.\d+Z$/, "")
    : "—";
}

export const renderTemplates = {
 /**
  * 現在印刷中ジョブの大サムネイル表示テンプレート
  *
  * @param job - 表示対象ジョブ
  * @param {string} baseUrl 例: "http://192.168.54.151"
  */
  current(job, baseUrl) {
    const fmt = iso => iso ? formatEpochToDateTime(iso) : "—";
    const name = job.filename || '(名称不明)';
    const ts = Date.now();
    const currentUrl = `${baseUrl}/downloads/original/current_print_image.png?${ts}`;
    const fallback   = `${baseUrl}/downloads/defData/file_print_photo.png`;
    const finishHtml = job.finishTime
      ? `<div class="cp-row"><span class="cp-label">終了:</span> ${fmt(job.finishTime)}</div>` : "";

    // フィラメント情報: スプール名・色・素材 + 消費量/残量
    const spool = job.filamentId ? getSpoolById(job.filamentId) : null;
    const materialFmt = job.materialUsedMm != null
      ? formatFilamentAmount(job.materialUsedMm, spool) : null;
    const materialVal = materialFmt ? materialFmt.display : "—";

    // スプール情報行
    let spoolHtml = "";
    if (spool) {
      const spLabel = formatSpoolDisplayId(spool);
      const spName = spool.name || spool.colorName || "";
      const mat = spool.materialName || spool.material || "";
      const color = spool.filamentColor || "#000";
      const remainFmt = formatFilamentAmount(spool.remainingLengthMm, spool);
      const remainPct = spool.totalLengthMm > 0
        ? ((spool.remainingLengthMm / spool.totalLengthMm) * 100).toFixed(0) : "?";
      spoolHtml = `
        <div class="cp-row" style="margin-top:4px">
          <span class="cp-label">スプール:</span>
          <span class="filament-color-box" style="color:${color};">■</span>
          ${spLabel} ${spName} ${mat}
        </div>
        <div class="cp-row"><span class="cp-label">残量:</span> ${remainFmt.display} (${remainPct}%)</div>
      `;
    }

    // 時間内訳行
    let timingHtml = "";
    const prepSec = Number(job.preparationTime || 0);
    const pauseSec = Number(job.pauseTime || 0);
    if (prepSec > 0 || pauseSec > 0) {
      const parts = [];
      if (prepSec > 0) parts.push(`準備 ${formatDuration(prepSec)}`);
      if (pauseSec > 0) parts.push(`停止 ${formatDuration(pauseSec)}`);
      timingHtml = `<div class="cp-row" style="font-size:0.9em;color:#666"><span class="cp-label"></span>${parts.join(" / ")}</div>`;
    }

    return `
      <div class="current-print">
        <div class="cp-thumb-wrap">
          <img
            class="cp-thumb"
            src="${currentUrl}"
            onerror="this.onerror=null;this.src='${fallback}'"
            alt="現在印刷中"
          />
        </div>
        <div class="cp-info">
          <div class="cp-filename">${name}</div>
          <div class="cp-row"><span class="cp-label">開始:</span> ${fmt(job.startTime)}</div>
          ${finishHtml}
          <div class="cp-row"><span class="cp-label">消費:</span> ${materialVal}</div>
          ${spoolHtml}
          ${timingHtml}
        </div>
      </div>
    `;
  },

  /**
   * 履歴リスト用 小サムネイル表示テンプレート
   * @param job
   * @param {string} baseUrl
   */
  historyItem(job, baseUrl) {
    const thumbUrl = makeThumbUrl(baseUrl, job.rawFilename || job.filename);
    const fallback = `${baseUrl}/downloads/defData/file_icon.png`;
    const fmt = iso => iso ? formatEpochToDateTime(iso) : "—";
    return `
      <img
        class="print-job-thumb"
        src="${thumbUrl}"
        onerror="this.onerror=null;this.src='${fallback}'"
        alt="${job.filename}"
      />
      <div class="print-job-info">
        <div class="filename">${job.filename}</div>
        <div class="times">
          開始: ${fmt(job.startTime)}
          ${job.finishTime ? `<br>完了: ${fmt(job.finishTime)}` : ""}
        </div>
          <div class="material-used">
            消費: ${job.materialUsedMm != null ? formatFilamentAmount(job.materialUsedMm, job.filamentId ? getSpoolById(job.filamentId) : null).display : "—"}
          </div>
      </div>
    `;
  }
}; // ← renderTemplates 終了




// ---------------------- DOM 描画 ----------------------

/**
 * 現在印刷中ジョブを指定コンテナに描画
 * @param {HTMLElement|null} containerEl - 描画先要素。null の場合は処理しません
 * @param {string} hostname - ホスト名
 */
export function renderPrintCurrent(containerEl, hostname) {
  if (!containerEl) return;
  containerEl.innerHTML = "";
  const job = loadCurrent(hostname);
  const ip = getDeviceIp(hostname);
  const baseUrl = `http://${ip}`;

  if (!job) {
    containerEl.innerHTML = "<p>現在印刷中のジョブはありません。</p>";
    return;
  }

  /* 印刷中であれば storedData からリアルタイム使用量を取得 */
  const machine = monitorData.machines[hostname];
  const printState = Number(machine?.runtimeData?.state ?? -1);
  if (
    (printState === PRINT_STATE_CODE.printStarted ||
     printState === PRINT_STATE_CODE.printPaused) &&
    machine?.storedData
  ) {
    const sd = machine.storedData;
    const liveLen = sd.usedMaterialLength?.rawValue
      ?? sd.usagematerial?.rawValue
      ?? sd.materialLength?.rawValue;
    if (liveLen != null) {
      job.materialUsedMm = Number(liveLen);
    }
  }

  containerEl.innerHTML = renderTemplates.current(job, baseUrl);
}


/**
 * 印刷履歴リストを指定コンテナ（ul または div）に描画
 * @param {HTMLElement|null} containerEl - 描画先要素。null なら何もしません
 */
export function renderPrintHistory(containerEl, hostname) {
  if (!containerEl) return;
  const jobs = loadHistory(hostname);
  const ip = getDeviceIp(hostname);
  const baseUrl = `http://${ip}`;

  containerEl.innerHTML = "";
  if (!jobs.length) {
    containerEl.innerHTML = "<li>履歴がありません。</li>";
    return;
  }
  for (const job of jobs) {
    const li = document.createElement("li");
    li.className = "print-job-item";
    // rawFilename を渡せるように、履歴保存時に保持しておくと良いです
    li.innerHTML = renderTemplates.historyItem(job, baseUrl);
    containerEl.appendChild(li);
  }
}


/**
 * WebSocket から取得したデータを元に履歴を更新し再描画
 * @param {() => Promise<Object>} fetchStoredData - サーバーデータ取得関数
 * @param {string} baseUrl - サムネイル URL のベース
 * @param {string} [currentContainerId="print-current-container"]
 * @param {string} [historyContainerId="print-history-list"]
 */
export async function refreshHistory(
  fetchStoredData,
  baseUrl,
  currentContainerId = "print-current-container",
  historyContainerId = "print-history-list",
  host
) {
  // 生データ取得
  const sd  = await fetchStoredData(host);
  const raw = Array.isArray(sd.historyList) ? sd.historyList : [];

  // パース → 永続化（既存データとマージ）
  const newJobs = parseRawHistoryList(raw, baseUrl, host);
  // --- monitorData の一時履歴データを取り込み ---
  const machine = monitorData.machines[host];
  const buf = machine ? machine.historyData : [];
  const appliedIdx = new Set();
  if (buf && buf.length) {
    const bufMap = new Map(buf.map((b, i) => [String(b.id), { data: b, idx: i }]));
    newJobs.forEach(job => {
      const found = bufMap.get(String(job.id));
      if (!found) return;
      Object.entries(found.data).forEach(([k, v]) => {
        if (k === "id") return;
        const isZero = MERGE_IGNORE_ZERO_FIELDS.has(k) && Number(job[k]) === 0;
        if (v != null && (job[k] == null || isZero)) {
          job[k] = v;
        }
      });
      appliedIdx.add(found.idx);
    });
    if (machine) {
      machine.historyData = buf.filter((_, i) => !appliedIdx.has(i));
    }
  }
  const FILAMENT_KEYS_R = new Set([
    "filamentId", "filamentColor", "filamentType", "filamentInfo"
  ]);
  const oldJobs = loadHistory(host);
  const mergedMap = new Map();
  newJobs.forEach(j => mergedMap.set(String(j.id), j));
  oldJobs.forEach(j => {
    const cur = mergedMap.get(String(j.id));
    if (cur) {
      // フィラメント関連: newJobs（bufバッファ経由）に値がある場合は
      // ユーザー操作結果なのでそちらを優先。ない場合のみ旧データで補完。
      Object.entries(j).forEach(([k, v]) => {
        if (FILAMENT_KEYS_R.has(k)) {
          if (cur[k] == null && v != null) cur[k] = v;
          return;
        }
        const isZero = MERGE_IGNORE_ZERO_FIELDS.has(k) && Number(cur[k]) === 0;
        if (v != null && (cur[k] == null || isZero)) cur[k] = v;
      });
    } else {
      mergedMap.set(String(j.id), j);
    }
  });
  const jobs = Array.from(mergedMap.values())
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, MAX_PRINT_HISTORY);

  let merged = false;
  const state = Number(machine?.runtimeData?.state ?? 0);
  const printing = [PRINT_STATE_CODE.printStarted, PRINT_STATE_CODE.printPaused].includes(state);
  const curSpoolId = getCurrentSpoolId(host);
  if (printing && curSpoolId && jobs[0]) {
    const sp = getSpoolById(curSpoolId);
    if (sp) {
      if (!jobs[0].filamentId) jobs[0].filamentId = curSpoolId;
      if (!jobs[0].filamentColor && (sp.filamentColor || sp.color)) {
        jobs[0].filamentColor = sp.filamentColor || sp.color;
      }
      if (!jobs[0].filamentType && (sp.material || sp.materialName)) {
        jobs[0].filamentType = sp.material || sp.materialName;
      }
      // 履歴にスプール情報が存在しない場合は現在スプールを即時反映
      jobs[0].filamentInfo ??= [];
      if (!jobs[0].filamentInfo.some(info => info.spoolId === sp.id)) {
        jobs[0].filamentInfo.push({
          spoolId: sp.id,
          serialNo: sp.serialNo,
          spoolName: sp.name,
          colorName: sp.colorName,
          filamentColor: sp.filamentColor,
          material: sp.material,
          spoolCount: sp.printCount,
          expectedRemain: sp.remainingLengthMm
        });
      }

      if (!sp.currentPrintID) sp.currentPrintID = jobs[0].id;
    }
    merged = true;
  }

  const videoMap = loadVideos(host);
  jobs.forEach(j => {
    const info = videoMap[j.id];
    if (info && info.videoUrl) j.videoUrl = info.videoUrl;
  });
  saveHistory(jobs, host);

  // 現在印刷中ジョブの更新: 新IDなら置換、同一IDでもマージして最新データを反映
  const prev = loadCurrent(host);
  if (jobs[0]) {
    if (jobs[0].id !== prev?.id) {
      saveCurrent(jobs[0], host);
    } else {
      const merged = { ...jobs[0] };
      if (prev) {
        Object.entries(prev).forEach(([k, v]) => {
          if (v != null && merged[k] == null) merged[k] = v;
        });
      }
      saveCurrent(merged, host);
    }
    renderPrintCurrent(scopedById(currentContainerId, host), host);
  }

  // --- テーブル描画 ---
  const rawMap = new Map(raw.map(r => [r.id, r]));
  jobs.forEach(j => {
    if (!rawMap.has(j.id)) {
      rawMap.set(j.id, jobsToRaw([j])[0]);
    }
  });
  const mergedRaw = Array.from(rawMap.values())
    .sort((a, b) => b.id - a.id)
    .slice(0, MAX_PRINT_HISTORY);
  renderHistoryTable(mergedRaw, baseUrl, host);
}

/**
 * 履歴リストをマージして保存し、UI を更新する。
 *
 * 受信した `rawArray` を内部モデルに変換し、既に保存されている履歴と
 * 一時バッファの内容を統合した上で `saveHistory()` を実行する。保存後は
 * `jobsToRaw()` で簡易形式へ変換し、`renderHistoryTable()` によって
 * ダッシュボードの表へ反映する。これにより表示内容は常にマージ済みの
 * 最新状態となる。
 *
 * @param {Array<Object>} rawArray - プリンタから受信した生履歴データ配列
 * @param {string} baseUrl         - サムネイル取得用のサーバーベース URL
 * @param {string} [currentContainerId="print-current-container"]
 *          現在ジョブ表示用コンテナの要素 ID
 * @param {string} [host] - ホスト名
 * @param {Object} [opts] - オプション
 * @param {boolean} [opts.forceFilament=false] - true の場合、新しいフィラメント値で
 *   保存済みの値を上書きする（ユーザー操作による指定・修正時に使用）
 * @returns {void}
 */
export function updateHistoryList(
  rawArray,
  baseUrl,
  currentContainerId = "print-current-container",
  host,
  opts = {}
) {
  if (!Array.isArray(rawArray)) return;
  pushLog("[updateHistoryList] マージ処理を開始", "info", false, host);
  const newJobs = parseRawHistoryList(rawArray, baseUrl, host);

  const machine = monitorData.machines[host];
  const buf = machine ? machine.historyData : [];
  const appliedIdx = new Set();
  if (buf && buf.length) {
    const bufMap = new Map(buf.map((b, i) => [String(b.id), { data: b, idx: i }]));
    newJobs.forEach(job => {
      const found = bufMap.get(String(job.id));
      if (!found) return;
      Object.entries(found.data).forEach(([k, v]) => {
        if (k === "id") return;
        const isZero = MERGE_IGNORE_ZERO_FIELDS.has(k) && Number(job[k]) === 0;
        if (v != null && (job[k] == null || isZero)) job[k] = v;
      });
      appliedIdx.add(found.idx);
    });
    if (machine) {
      machine.historyData = buf.filter((_, i) => !appliedIdx.has(i));
    }
  }

  /** フィラメント関連キー */
  const FILAMENT_KEYS = new Set([
    "filamentId", "filamentColor", "filamentType", "filamentInfo"
  ]);

  let merged = false;
  const oldJobs = loadHistory(host);
  const mergedMap = new Map();
  newJobs.forEach(j => mergedMap.set(String(j.id), j));
  oldJobs.forEach(j => {
    const cur = mergedMap.get(String(j.id));
    if (cur) {
      Object.entries(j).forEach(([k, v]) => {
        // フィラメント関連:
        //   newJobs（historyData バッファ経由）に値がある場合はユーザー操作結果
        //   なのでそちらを優先する。newJobs に値がない場合のみ旧データで補完。
        if (FILAMENT_KEYS.has(k)) {
          if (cur[k] == null && v != null) {
            cur[k] = v;
            merged = true;
          }
          return;
        }
        const isZeroInCur = MERGE_IGNORE_ZERO_FIELDS.has(k) && Number(cur[k]) === 0;
        const isOldJobFinishedAndValid =
          MERGE_IGNORE_ZERO_FIELDS.has(k) && j.printfinish === 1 && v != null && v !== 0;

        if (
          v != null &&
          (cur[k] == null ||
            isZeroInCur ||
            (cur.printfinish !== 1 && isOldJobFinishedAndValid))
        ) {
          cur[k] = v;
          merged = true;
        }
      });
    } else {
      mergedMap.set(String(j.id), j);
      merged = true;
    }
  });
  const jobs = Array.from(mergedMap.values())
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, MAX_PRINT_HISTORY);

  const videoMap = loadVideos(host);
  jobs.forEach(j => {
    const info = videoMap[j.id];
    if (info && info.videoUrl) j.videoUrl = info.videoUrl;
  });
  saveHistory(jobs, host);
  pushLog(
    `[updateHistoryList] 保存データとマージ ${merged ? "完了" : "変更なし"}`,
    "info", false, host
  );

  // historyList の先頭行は現在の印刷ジョブ。printStartTime/printFileName が
  // 先に到着して saveCurrent 済みでも、historyList には usagematerial / usagetime /
  // thumbnail 等のより完全な情報が含まれるため、同一IDでもマージして更新する。
  const prev = loadCurrent(host);
  if (jobs[0]) {
    if (jobs[0].id !== prev?.id) {
      saveCurrent(jobs[0], host);
    } else {
      // 同一ID: historyList の完全データと既存データをマージ
      const mergedCur = { ...jobs[0] };
      if (prev) {
        Object.entries(prev).forEach(([k, v]) => {
          if (v != null && mergedCur[k] == null) mergedCur[k] = v;
        });
      }
      saveCurrent(mergedCur, host);
    }
    renderPrintCurrent(scopedById(currentContainerId, host), host);
  }

  // ここから UI 更新処理。保存済みジョブ配列を簡易 raw 形式に変換し、
  // 統合された履歴としてテーブルへ描画する
  const raw = jobsToRaw(jobs);
  renderHistoryTable(raw, baseUrl, host);
  pushLog("[updateHistoryList] UI へ反映しました", "info", false, host);
}

/**
 * 動画リストをマージし履歴に適用する。
 *
 * - 動画マップまたは履歴が更新された場合、`renderHistoryTable()` を呼び出し
 *   UI を即時更新する。
 * - 動画マップに変更があった場合はログに "完了" が表示される。
 *
 * @param {Array<Object>} videoArray - 新規取得した動画情報の配列
 * @param {string} baseUrl           - サーバーのベース URL
 * @returns {void}
 */
export function updateVideoList(videoArray, baseUrl, host) {
  if (!Array.isArray(videoArray) || !videoArray.length) return;
  pushLog("[updateVideoList] マージ処理を開始", "info", false, host);
  const map = { ...loadVideos(host) };
  let updated = false;
  videoArray.forEach(v => {
    if (!v.id) return;
    const url = `${baseUrl}/downloads/video/${v.id}.mp4`;
    const entry = { ...v, videoUrl: url };
    const cur = map[v.id];
    if (!cur || JSON.stringify(cur) !== JSON.stringify(entry)) {
      map[v.id] = entry;
      updated = true;
    }
  });
  if (updated) {
    // 新しい動画情報が存在するため保存処理を実行
    pushLog("[updateVideoList] saveVideos() を呼び出します", "info", false, host);
    saveVideos(map, host);
  }

  const jobs = loadHistory(host);
  let changed = false;
  jobs.forEach(job => {
    const info = map[job.id];
    if (info && info.videoUrl && job.videoUrl !== info.videoUrl) {
      job.videoUrl = info.videoUrl;
      changed = true;
    }
  });
  if (changed) {
    saveHistory(jobs, host);
    // 動画マップが更新されていない場合でも
    // 履歴に動画URLが追加されたタイミングで保存を保証する
    if (!updated) saveVideos(map, host);
  }
  if (updated || changed) {
    const raw = jobsToRaw(jobs);
    renderHistoryTable(raw, baseUrl, host);
  }
  pushLog(
    `[updateVideoList] 保存データとマージ ${updated || changed ? "完了" : "変更なし"}`,
    "info", false, host
  );
  if (updated || changed) {
    pushLog("[updateVideoList] UI へ反映しました", "info", false, host);
  }
}

/**
 * rawArray の各エントリを HTML テーブルに描画し、
 * 操作ボタンにイベントをバインドします。
 * グループ化された多段行レイアウトで表示する。
 *
 * @param {Array<Object>} rawArray - プリンタから受信した生履歴データ配列
 * @param {string} baseUrl         - サムネイル取得用のサーバーベース URL
 * @param {string} hostname        - ホスト名
 */
export function renderHistoryTable(rawArray, baseUrl, hostname) {
  const table = scopedById("print-history-table", hostname);
  const tbody = table?.querySelector("tbody");
  /** @param {string} iso - 日時文字列 @returns {string} YYYY/MM/DD HH:MM:SS */
  const fmt = iso => iso ? formatEpochToDateTime(iso) : "—";
  const startwayMap = {
    1:  "機器操作経由",
    11: "外部操作経由",
    9:  "クラウド経由"
  };

  if (!tbody) return;

  /* 現在印刷中のジョブ判定用 */
  const curPrintId = getCurrentPrintID(hostname);
  const machine    = monitorData.machines[hostname];
  const printState = Number(machine?.runtimeData?.state ?? -1);
  const isActive   = (st) =>
    st === PRINT_STATE_CODE.printStarted || st === PRINT_STATE_CODE.printPaused;

  tbody.innerHTML = "";

  rawArray.forEach((raw, index) => {
    const name     = raw.filename.split("/").pop();
    const thumbUrl = makeThumbUrl(baseUrl, raw.filename);
    const fallback = `${baseUrl}/downloads/defData/file_icon.png`;

    // データ整形
    const startwayLabel =
      raw.startway !== undefined
        ? (startwayMap[raw.startway] || raw.startway)
        : "—";
    const size      = raw.size != null ? raw.size.toLocaleString() : "—";
    const stime     = fmt(raw.starttime);
    const etime     = fmt(raw.endtime);
    const utimeSec  = raw.usagetime != null ? Number(raw.usagetime) : null;
    const utime     = utimeSec != null ? formatDuration(utimeSec) : "—";
    const prepSec   = raw.preparationTime != null ? Number(raw.preparationTime) : null;
    const preptime  = prepSec != null ? formatDuration(prepSec) : "";
    const checkSec  = raw.firstLayerCheckTime != null ? Number(raw.firstLayerCheckTime) : null;
    const checktime = checkSec != null ? formatDuration(checkSec) : "";
    const pauseSec  = raw.pauseTime != null ? Number(raw.pauseTime) : null;
    const pausetime = pauseSec != null ? formatDuration(pauseSec) : "";
    // フィラメント情報（umaterial 算出前に必要）
    const spoolInfos = Array.isArray(raw.filamentInfo)
      ? raw.filamentInfo
      : (raw.filamentId ? [{ spoolId: raw.filamentId }] : []);
    // フィラメント消費量: スプール情報があれば g/¥ 換算も表示
    const spoolForFmt = spoolInfos.length > 0
      ? (getSpoolById(spoolInfos[0].spoolId) || null) : null;
    const umaterial =
      raw.usagematerial != null
        ? formatFilamentAmount(raw.usagematerial, spoolForFmt).display
        : "—";
    /* 成否表示: 印刷中/一時停止中のジョブは ▶/⏸ で表示 */
    const isCurrentJob = curPrintId && String(raw.id) === String(curPrintId) && isActive(printState);
    let finish, finishCls;
    if (isCurrentJob) {
      finish    = printState === PRINT_STATE_CODE.printPaused ? "⏸" : "▶";
      finishCls = "result-active";
    } else if (raw.printfinish) {
      finish    = "✔";
      finishCls = "result-ok";
    } else {
      finish    = "✗";
      finishCls = "result-ng";
    }
    const md5short  = raw.filemd5 ? raw.filemd5.substring(0, 8) : "";
    const videoLink = raw.videoUrl
      ? `<button class="video-link icon-btn" data-url="${raw.videoUrl}" title="動画">📹</button>`
      : "";

    // 時間詳細行（準備・確認・停止があれば表示）
    const timeDetails = [];
    if (preptime) timeDetails.push(`準備${preptime}`);
    if (checktime) timeDetails.push(`確認${checktime}`);
    if (pausetime) timeDetails.push(`停止${pausetime}`);
    const timeDetailHtml = timeDetails.length
      ? `<div class="time-detail">${timeDetails.join(" ")}</div>`
      : "";

    const matColors = {
      PLA: '#FFEDD5', 'PLA+': '#FED7AA', PETG: '#DBEAFE',
      ABS: '#FECACA', TPU: '#E9D5FF'
    };
    let spoolHtml = "";
    if (spoolInfos.length === 0) {
      spoolHtml = `<button class="spool-assign btn-xs" data-id="${raw.id}">指定</button>`;
    } else {
      const parts = [];
      spoolInfos.forEach((info, idx) => {
        const sp = getSpoolById(info.spoolId) || null;
        const mat = info.material || sp?.material || '';
        const matColor = mat ? (matColors[mat] || '#EEE') : '#EEE';
        const color = info.filamentColor || sp?.filamentColor || '#000';
        const colorBox = `<span class="filament-color-box" style="color:${color};">■</span>`;
        const matTag   = mat ? `<span class="material-tag" style="background:${matColor};">${mat}</span>` : '';
        const spName = info.spoolName || sp?.name || '';
        const colName = info.colorName || sp?.colorName || '';
        let text = spName || colName ? `${colorBox}${matTag} ${spName}/${colName}` : '(不明)';
        if (idx === 0) {
          const editId = info.spoolId || raw.filamentId;
          if (editId) text += ` <button class="spool-edit icon-btn" data-id="${editId}" title="修正">✏</button>`;
        }
        const cnt = info.spoolCount ?? sp?.printCount ?? 0;
        const remMm = info.expectedRemain ?? sp?.remainingLengthMm ?? 0;
        const remFmt = formatFilamentAmount(remMm, sp);
        parts.push(`<div class="spool-line">${text}</div>`);
        parts.push(`<div class="spool-meta">残:${remFmt.display} 回:${cnt}</div>`);
      });
      spoolHtml = parts.join("");
    }

    const tr = document.createElement("tr");
    tr.className = "history-row";
    tr.innerHTML = `
      <td class="col-cmd">
        <button class="cmd-print icon-btn" title="印刷">▶</button>
        <button class="cmd-rename icon-btn" title="名前変更">✏</button>
        <button class="cmd-delete icon-btn" title="削除">🗑</button>
      </td>
      <td data-key="number" class="col-num">${index + 1}<div class="sub-id">${raw.id}</div></td>
      <td class="col-thumb">
        <img src="${thumbUrl}" alt="${name}" style="width:40px"
          onerror="this.onerror=null;this.src='${fallback}'" />
      </td>
      <td data-key="filename" class="col-file">
        <div class="file-name" title="${name}">${name}</div>
      </td>
      <td data-key="startway">${startwayLabel}</td>
      <td data-key="size">${size}</td>
      <td data-key="starttime" class="col-time" data-sec="${utimeSec ?? ''}">
        <div class="time-range">${stime} → ${etime}</div>
        <div class="time-duration">⏱ ${utime}</div>
        ${timeDetailHtml}
      </td>
      <td data-key="printfinish" class="col-finish"><span class="${finishCls}">${finish}</span></td>
      <td data-key="usagematerial">${umaterial}</td>
      <td data-key="spool" class="col-spool">${spoolHtml}</td>
      <td data-key="filemd5" class="col-extra">
        ${videoLink}
        <span class="md5-short" title="${raw.filemd5 || ''}">${md5short}</span>
      </td>
    `;
    tbody.appendChild(tr);

    // イベントハンドラ登録
    tr.querySelector(".cmd-print")?.addEventListener("click", () => {
      handlePrintClick(raw, thumbUrl, hostname);
    });
    tr.querySelector(".cmd-rename")?.addEventListener("click", () => {
      handleRenameClick(raw, hostname);
    });
    tr.querySelector(".cmd-delete")?.addEventListener("click", () => {
      handleDeleteClick(raw, hostname);
    });
    tr.querySelector(".video-link")?.addEventListener("click", () => {
      showVideoOverlay(raw.videoUrl);
    });
    tr.querySelector(".spool-edit")?.addEventListener("click", async ev => {
      const sid = ev.currentTarget?.dataset.id;
      const materialUsedMm = raw.usagematerial || 0;
      const result = await showHistoryFilamentDialog({
        hostname, materialUsedMm, currentSpoolId: sid, jobId: String(raw.id)
      });
      if (!result) return;
      const { spool: newSp } = result;
      // 同一スプール選択時はスキップ
      if (sid && newSp.id === sid) return;
      // 旧スプールに使用量を復元
      if (sid && materialUsedMm > 0) {
        const oldSp = getSpoolById(sid);
        if (oldSp) {
          updateSpool(oldSp.id, {
            remainingLengthMm: oldSp.remainingLengthMm + materialUsedMm
          });
        }
      }
      // 新スプールから使用量を差し引く
      if (materialUsedMm > 0) {
        const freshSp = getSpoolById(newSp.id);
        const remain = freshSp ? freshSp.remainingLengthMm : newSp.remainingLengthMm;
        updateSpool(newSp.id, {
          remainingLengthMm: Math.max(0, remain - materialUsedMm)
        });
      }
      const updatedSp = getSpoolById(newSp.id) || newSp;
      // パース済み raw にフィラメント情報を直接セット（再パースを避ける）
      _applyFilamentToRaw(raw, updatedSp);
      // 保存済み履歴を直接更新（updateHistoryList の再パースでデータ破壊を防ぐ）
      _patchHistoryFilament(raw, hostname);
      // 現在印刷中ジョブなら機器装着スプール・プレビューも連動
      _linkCurrentPrintSpool(raw, updatedSp, hostname);
      // パネルのフィラメントプレビューを更新
      const hostPreview = window._filamentPreviews?.get(hostname);
      if (hostPreview) updateFilamentPreview(updatedSp, hostPreview);
      // UI 再描画
      const allJobs = loadHistory(hostname);
      renderHistoryTable(jobsToRaw(allJobs), baseUrl, hostname);
    });
    tr.querySelector(".spool-assign")?.addEventListener("click", async () => {
      const materialUsedMm = raw.usagematerial || 0;
      const result = await showHistoryFilamentDialog({
        hostname, materialUsedMm, currentSpoolId: null, jobId: String(raw.id)
      });
      if (!result) return;
      const { spool: newSp } = result;
      // 新スプールから使用量を差し引く
      if (materialUsedMm > 0) {
        const freshSp = getSpoolById(newSp.id);
        const remain = freshSp ? freshSp.remainingLengthMm : newSp.remainingLengthMm;
        updateSpool(newSp.id, {
          remainingLengthMm: Math.max(0, remain - materialUsedMm)
        });
      }
      const updatedSp = getSpoolById(newSp.id) || newSp;
      // パース済み raw にフィラメント情報を直接セット
      _applyFilamentToRaw(raw, updatedSp);
      // 保存済み履歴を直接更新
      _patchHistoryFilament(raw, hostname);
      // 現在印刷中ジョブなら機器装着スプール・プレビューも連動
      _linkCurrentPrintSpool(raw, updatedSp, hostname);
      // パネルのフィラメントプレビューを更新
      const hostPreview = window._filamentPreviews?.get(hostname);
      if (hostPreview) updateFilamentPreview(updatedSp, hostPreview);
      // UI 再描画
      const allJobs = loadHistory(hostname);
      renderHistoryTable(jobsToRaw(allJobs), baseUrl, hostname);
    });
  });

  // ソート用リスナ追加 + ソートインジケータ
  if (table) {
    _bindSortHeaders(table, "print-history-table", hostname);
  }

  // ── ジョブ詳細ドリルダウン (5-1 + 4-3) ──
  const tableParent = table?.parentElement;
  if (tableParent) {
    // 既存のドリルダウンがあれば再利用
    let drilldown = tableParent.querySelector(".job-drilldown");
    if (!drilldown) {
      drilldown = document.createElement("div");
      drilldown.className = "job-drilldown";
      drilldown.classList.add("pm-drilldown");
      tableParent.appendChild(drilldown);
    }

    // 各行にクリックハンドラ追加
    tbody?.querySelectorAll("tr.history-row").forEach((tr, idx) => {
      tr.style.cursor = "pointer";
      tr.addEventListener("click", (ev) => {
        // ボタン操作時はドリルダウンしない
        if (ev.target.closest("button, select, input")) return;
        const raw = rawArray[idx];
        if (!raw) return;
        _renderJobDrilldown(drilldown, raw, baseUrl, hostname);
      });
    });
  }

}

/**
 * ジョブ詳細ドリルダウンを描画する。(Stage 5-1 + 4-3)
 *
 * 時間内訳・素材消費・スプール変動・同一ファイル実績・
 * プリンタ間比較を統合表示する。
 *
 * @private
 * @param {HTMLElement} container - 描画先
 * @param {Object} raw - 履歴行データ
 * @param {string} baseUrl - サムネイルベースURL
 * @param {string} hostname - ホスト名
 */
function _renderJobDrilldown(container, raw, baseUrl, hostname) {
  container.style.display = "";
  container.innerHTML = "";

  const filename = (raw.rawFilename || raw.filename || "").split("/").pop();
  const spool = raw.filamentId ? getSpoolById(raw.filamentId) : null;
  const materialFmt = raw.usagematerial > 0 ? formatFilamentAmount(raw.usagematerial, spool) : null;

  // ヘッダー
  const hdr = document.createElement("div");
  hdr.className = "pm-drilldown-header";
  const thumbUrl = makeThumbUrl(baseUrl, raw.rawFilename || raw.filename);
  hdr.innerHTML = `<div class="flex-row"><img src="${thumbUrl}" class="pm-thumb" onerror="this.style.display='none'"><div><strong>${filename}</strong><br><span class="text-secondary-xs">${raw.printfinish === 1 ? "✔ 成功" : raw.printfinish === 0 ? "✗ 失敗" : "— 不明"}</span></div></div>`;
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "×";
  closeBtn.className = "drilldown-close";
  closeBtn.addEventListener("click", () => { container.style.display = "none"; });
  hdr.appendChild(closeBtn);
  container.appendChild(hdr);

  // カード群
  const cards = document.createElement("div");
  cards.className = "stat-cards";

  // 時間内訳
  const startSec = raw.starttime ? Number(raw.starttime) : 0;
  const usageSec = Number(raw.usagetime || 0);
  const prepSec = Number(raw.preparationTime || 0);
  const checkSec = Number(raw.firstLayerCheckTime || 0);
  const pauseSec = Number(raw.pauseTime || 0);
  const actualPrintSec = Math.max(0, usageSec - prepSec - checkSec - pauseSec);

  const addCard = (label, value, sub) => {
    const card = document.createElement("div");
    card.className = "stat-card";
    card.innerHTML = `<div class="stat-card-label">${label}</div><div class="stat-card-value">${value}</div>${sub ? `<div class="stat-card-sub">${sub}</div>` : ""}`;
    cards.appendChild(card);
  };

  if (usageSec > 0) addCard("合計時間", formatDuration(usageSec), "");
  if (actualPrintSec > 0) addCard("実印刷", formatDuration(actualPrintSec), "");
  if (prepSec > 0) addCard("準備", formatDuration(prepSec), "");
  if (pauseSec > 0) addCard("停止", formatDuration(pauseSec), "");
  if (materialFmt) addCard("消費量", materialFmt.display, "");

  // スプール変動
  if (spool && Array.isArray(raw.filamentInfo) && raw.filamentInfo.length >= 2) {
    const before = raw.filamentInfo[0]?.expectedRemain;
    const after = raw.filamentInfo[raw.filamentInfo.length - 1]?.expectedRemain;
    if (before != null && after != null) {
      const bFmt = formatFilamentAmount(before, spool);
      const aFmt = formatFilamentAmount(after, spool);
      addCard("スプール変動", `${bFmt.m}m → ${aFmt.m}m`, `${formatSpoolDisplayId(spool)}`);
    }
  } else if (spool) {
    addCard("スプール", formatSpoolDisplayId(spool), spool.name || "");
  }

  container.appendChild(cards);

  // 同一ファイル実績 + プリンタ間比較 (4-3)
  const insight = buildFileInsight(raw.rawFilename || raw.filename, hostname);
  if (insight && insight.printCount > 1) {
    const compFs = document.createElement("fieldset");
    compFs.className = "pm-compare-fieldset";
    const rate = (insight.successRate * 100).toFixed(0);
    const avgFmt = formatFilamentAmount(insight.avgMaterialMm, spool);
    compFs.innerHTML = `<legend style="font-weight:bold;font-size:0.9em">このファイルの実績 (${hostname})</legend>` +
      `<div>印刷${insight.printCount}回 / 成功率 ${rate}% / 平均時間 ${formatDuration(insight.avgDurationSec)} / 平均消費 ${avgFmt.display}</div>`;

    // 他ホストでの実績があれば比較表示 (4-3)
    const otherHosts = Object.keys(monitorData.machines).filter(
      h => h !== hostname && h !== "_$_NO_MACHINE_$_"
    );
    for (const otherHost of otherHosts) {
      const otherInsight = buildFileInsight(raw.rawFilename || raw.filename, otherHost);
      if (otherInsight && otherInsight.printCount > 0) {
        const oRate = (otherInsight.successRate * 100).toFixed(0);
        const oFmt = formatFilamentAmount(otherInsight.avgMaterialMm, spool);
        const timeDiff = insight.avgDurationSec > 0
          ? (((otherInsight.avgDurationSec - insight.avgDurationSec) / insight.avgDurationSec) * 100).toFixed(0) : "?";
        const matDiff = insight.avgMaterialMm > 0
          ? (((otherInsight.avgMaterialMm - insight.avgMaterialMm) / insight.avgMaterialMm) * 100).toFixed(0) : "?";
        const displayName = monitorData.machines[otherHost]?.storedData?.hostname?.rawValue || otherHost;
        compFs.innerHTML += `<div style="margin-top:4px;padding-top:4px;border-top:1px solid #f0f0f0">` +
          `<strong>${displayName}:</strong> ${otherInsight.printCount}回 / 成功率 ${oRate}% / ` +
          `平均時間 ${formatDuration(otherInsight.avgDurationSec)} (${timeDiff > 0 ? "+" : ""}${timeDiff}%) / ` +
          `平均消費 ${oFmt.display} (${matDiff > 0 ? "+" : ""}${matDiff}%)</div>`;
      }
    }
    container.appendChild(compFs);
  }
}

/**
 * 印刷実行ボタン押下時の処理。
 *
 * 過去の実績・スプール残量・コスト推定を含む確認ダイアログを表示し、
 * フィラメント不足時には警告レベルで表示する。
 *
 * @param {Object} raw      - 行データ
 * @param {string} thumbUrl - サムネイル画像の URL
 * @param {string} hostname - ホスト名
 */
async function handlePrintClick(raw, thumbUrl, hostname) {
  const usedSec        = Number(raw.usagetime || 0);
  const materialNeeded = Number(raw.usagematerial || 0);
  const spool          = getCurrentSpool(hostname);
  const remaining      = spool?.remainingLengthMm ?? 0;
  const afterRemaining = Math.max(0, remaining - materialNeeded);
  const isShort        = remaining > 0 && materialNeeded > remaining;

  // フィラメント量を人間可読にフォーマット
  const fmtNeed  = formatFilamentAmount(materialNeeded, spool);
  const fmtRemain = formatFilamentAmount(remaining, spool);
  const fmtAfter = formatFilamentAmount(afterRemaining, spool);

  // ファイル別の過去実績
  const insight = buildFileInsight(raw.filename || raw.rawFilename || "", hostname);
  const filename = (raw.filename || "").split("/").pop();

  // GCode メタデータ (アップロード時に抽出済み)
  const gcMeta = raw._gcodeMeta || _gcodeMetaCache.get(filename) || {};

  // 所要時間（実績 > GCode見積 > 機器報告値）
  let estSec, durLabel;
  if (insight?.avgDurationSec > 0) {
    estSec = insight.avgDurationSec;
    durLabel = "実績ベース";
  } else if (gcMeta.timeSec > 0) {
    estSec = gcMeta.timeSec;
    durLabel = "GCode見積";
  } else {
    estSec = usedSec;
    durLabel = "機器報告";
  }
  const expectedFinish = estSec > 0
    ? new Date(Date.now() + estSec * 1000).toLocaleString()
    : "—";

  // --- 素材ミスマッチ検出 ---
  const spoolMaterial = spool?.materialName || spool?.material || "";
  const gcodeMaterial = gcMeta.material || "";
  const materialMismatch = !!(spool && gcodeMaterial &&
    spoolMaterial.trim().toUpperCase() !== gcodeMaterial.trim().toUpperCase());

  // --- ダイアログ HTML 構築 ---
  let html = `<div class="pm-print-header">`;
  html += `<img src="${thumbUrl}" class="pm-print-thumb">`;
  html += `<div><strong class="pm-print-filename">${filename}</strong></div></div>`;

  // スプール未装着警告
  if (!spool) {
    html += `<div class="pm-print-section pm-print-warn-section">`;
    html += `<div class="pm-print-section-title">⚠ スプール未装着</div>`;
    html += `<div>フィラメント管理でスプールを装着してから印刷することを推奨します。</div>`;
    html += `<div>消費量の追跡・残量計算ができません。</div>`;
    html += `</div>`;
  }

  // 素材ミスマッチ警告
  if (materialMismatch) {
    html += `<div class="pm-print-section pm-print-danger-section">`;
    html += `<div class="pm-print-section-title">🚨 素材不一致</div>`;
    html += `<div>GCode 指定: <strong>${gcodeMaterial}</strong></div>`;
    html += `<div>装着スプール: <strong>${spoolMaterial}</strong></div>`;
    html += `<div>素材が異なると印刷品質に重大な影響があります。</div>`;
    html += `</div>`;
  }

  // 過去実績セクション
  if (insight && insight.printCount > 0) {
    const avgDur = formatDuration(insight.avgDurationSec);
    const rate = (insight.successRate * 100).toFixed(0);
    const avgFmt = formatFilamentAmount(insight.avgMaterialMm, spool);
    html += `<div class="pm-print-section pm-print-info-section">`;
    html += `<div class="pm-print-section-title">過去の実績 (${insight.printCount}回 / 成功率 ${rate}%)</div>`;
    html += `<div>平均所要: ${avgDur}</div>`;
    html += `<div>平均消費: ${avgFmt.display}</div>`;
    if (insight.lastPrintDate) {
      const lastD = formatEpochToDateTime(insight.lastPrintDate);
      const lastR = insight.lastResult === 1 ? "✔ 成功" : "✗ 失敗";
      html += `<div>最終: ${lastD} ${lastR}</div>`;
    }
    html += `</div>`;
  } else if (Object.keys(gcMeta).length > 0) {
    // 履歴なし — GCode メタデータから情報表示
    html += `<div class="pm-print-section pm-print-neutral-section">`;
    html += `<div class="pm-print-section-title">GCode 情報 (初回印刷)</div>`;
    const items = [];
    if (gcMeta.material)    items.push(`素材: ${gcMeta.material}`);
    if (gcMeta.layers)      items.push(`${gcMeta.layers}層`);
    if (gcMeta.layerHeight) items.push(`高さ ${gcMeta.layerHeight}mm`);
    if (gcMeta.nozzleTemp)  items.push(`ノズル ${gcMeta.nozzleTemp}℃`);
    if (gcMeta.bedTemp)     items.push(`ベッド ${gcMeta.bedTemp}℃`);
    if (items.length > 0) html += `<div>${items.join("　")}</div>`;
    html += `</div>`;
  }

  // スプール情報セクション（残量バー付き）
  if (spool) {
    const spoolLabel = `${formatSpoolDisplayId(spool)} ${spool.name || ""} ${spoolMaterial}`;
    const remainPct = spool.totalLengthMm > 0
      ? ((remaining / spool.totalLengthMm) * 100).toFixed(0) : "?";
    const afterPct = spool.totalLengthMm > 0
      ? ((afterRemaining / spool.totalLengthMm) * 100).toFixed(0) : "?";
    const remainPctNum = parseFloat(remainPct) || 0;
    const afterPctNum = parseFloat(afterPct) || 0;

    const sectionClass = isShort ? "pm-print-danger-section" : "pm-print-success-section";
    html += `<div class="pm-print-section ${sectionClass}">`;
    html += `<div class="pm-print-section-title">スプール: ${spoolLabel}</div>`;

    // 残量バー
    html += `<div class="pm-print-remain-bar-wrap">`;
    html += `<div class="pm-print-remain-bar">`;
    html += `<div class="pm-print-remain-bar-fill" style="width:${remainPctNum}%;background:${spool.filamentColor || spool.color || "var(--color-accent)"}"></div>`;
    if (!isShort) {
      html += `<div class="pm-print-remain-bar-consume" style="width:${remainPctNum - afterPctNum}%;left:${afterPctNum}%"></div>`;
    }
    html += `</div>`;
    html += `<span class="pm-print-remain-label">${remainPct}% → ${afterPct}%</span>`;
    html += `</div>`;

    html += `<div>残量: ${fmtRemain.display} (${remainPct}%)</div>`;
    html += `<div>印刷後予想: ${fmtAfter.display} (${afterPct}%)</div>`;
    if (isShort) {
      html += `<div class="pm-print-alert-danger">⚠ フィラメントが不足する可能性があります</div>`;
    } else {
      html += `<div class="pm-print-alert-success">✓ 十分な残量があります</div>`;
    }
    html += `</div>`;
  }

  // 残量不足時: このスプールの残量で印刷できるファイルの提案
  if (isShort && spool) {
    const recs = buildFilamentRecommendations(
      remaining, spoolMaterial, hostname, { maxResults: 3 }
    );
    if (recs.length > 0) {
      html += `<div class="pm-print-section pm-print-info-section">`;
      html += `<div class="pm-print-section-title">💡 この残量で印刷できるファイル</div>`;
      html += `<div class="rec-list">`;
      for (const rec of recs) {
        const fmtNeedRec = formatFilamentAmount(rec.materialNeeded, spool);
        html += `<div class="rec-item">`;
        html += `<span class="rec-filename">${rec.basename}</span>`;
        html += `<span class="rec-detail">必要: ${fmtNeedRec.display}</span>`;
        html += `<span class="rec-reason">${rec.reason}</span>`;
        html += `</div>`;
      }
      html += `</div></div>`;
    }
  }

  // 予想完了セクション
  html += `<div class="pm-print-section pm-print-neutral-section">`;
  html += `<div>必要量: ${fmtNeed.display}</div>`;
  if (estSec > 0) {
    html += `<div>予想所要: ${formatDuration(estSec)} (${durLabel})</div>`;
    html += `<div>予想完了: ${expectedFinish}</div>`;
  }
  html += `</div>`;

  // ダイアログレベルと確認ボタンを危険度に応じて変更
  let dialogLevel = "info";
  let confirmLabel = "印刷する";
  if (materialMismatch) {
    dialogLevel = "warnRed";
    confirmLabel = "🚨 素材不一致 — それでも印刷する";
  } else if (isShort) {
    dialogLevel = "warnRed";
    confirmLabel = "⚠ 不足の可能性あり — それでも印刷する";
  } else if (!spool) {
    dialogLevel = "warn";
    confirmLabel = "スプール未装着のまま印刷する";
  }

  const ok = await showConfirmDialog({
    level:       dialogLevel,
    title:       "印刷実行の確認",
    html,
    confirmText: confirmLabel,
    cancelText:  "キャンセル"
  });
  if (!ok) return;

  if (spool) {
    useFilament(materialNeeded, "", hostname);
  }

  // 実際にプリントコマンドを送信
  const target = raw.rawFilename ?? raw.filename;
  sendCommand(
    "set",
    { opGcodeFile: `printprt:${target}` },
    hostname
  );
}

/**
 * 削除ボタン押下時の処理。
 * 確認ダイアログ後に削除コマンドを送信します。
 *
 * @param {Object} raw - 行データ
 */
async function handleDeleteClick(raw, hostname) {
  const name = raw.filename.split("/").pop();

  const html = `削除すると元に戻せません。本当によろしいですか? <br>ファイル: ${name}`;

  const ok = await showConfirmDialog({
    level:       "error",
    title:       "ファイル削除の確認",
    // messageは 空,
    html:        html,
    confirmText: "削除",
    cancelText:  "キャンセル"
  });
  if (!ok) return;

  const target = raw.rawFilename ?? raw.filename;
  sendCommand(
    "set",
    { opGcodeFile: `deleteprt:${target}` },
    hostname
  );
}

/**
 * 名前変更ボタン押下時の処理。
 * prompt で新名称を入力後、確認ダイアログ、送信を行います。
 *
 * @param {Object} raw - 行データ
 */
async function handleRenameClick(raw, hostname) {
  const oldName = raw.filename.split("/").pop();

  const newName = await showInputDialog({
    level:        "warn",                         // 警告レベル
    title:        "ファイル名変更の確認",         // ダイアログタイトル
    message:      "新しいファイル名を入力してください", // プレーンテキスト本文
    // html:       "...",                        // 必要ならここに HTML を入れられます
    defaultValue: oldName,                       // 初期入力値
    confirmText:  "変更する",                     // OK ボタンのラベル
    cancelText:   "キャンセル"                    // キャンセルボタンのラベル
  });

  // newName が null → キャンセル、空文字 → 何も変更しない
  if (newName == null || newName === oldName) return;

  const ok = await showConfirmDialog({
    level:       "warn",
    title:       "ファイル名変更の確認",
    message:     "以下のように変更します。よろしいですか?",
    html:        `変更前: ${oldName}<br>変更後: ${newName}`,
    confirmText: "変更する",
    cancelText:  "キャンセル"
  });
  if (!ok) return;

  // 元ディレクトリを維持してフルパスを組み立て
  const target = raw.rawFilename ?? raw.filename;
  const dir = target.slice(0, target.lastIndexOf("/"));
  sendCommand(
    "set",
    { opGcodeFile: `renameprt:${target}:${dir}/${newName}` },
    hostname
  );
}

/**
 * GCode ファイルから埋め込み PNG サムネを抜き出す
 * @param {File} file
 * @returns {Promise<string|null>} data:image/png;base64,...  or null
 */
async function extractThumbnailFromFile(file) {
  const text = await file.text();
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => /^\s*;\s*png begin/.test(l));
  const end   = lines.findIndex(l => /^\s*;\s*png end/.test(l), start+1);
  if (start < 0 || end < 0) return null;
  const b64 = lines.slice(start+1, end)
                   .map(l => l.replace(/^\s*;\s*/, ""))
                   .join("");
  return `data:image/png;base64,${b64}`;
}

/**
 * GCode ファイルのコメント行からメタデータを抽出する。
 *
 * 対応フォーマット:
 * - `;TIME:{sec}` — 印刷予想時間
 * - `;Filament used:{m}m` — フィラメント使用量
 * - `;Layer height: {mm}` — 積層ピッチ
 * - `;LAYER_COUNT:{n}` — 総レイヤー数
 * - `;Material name:{name}` — 素材名
 * - `START_PRINT EXTRUDER_TEMP={n} BED_TEMP={n}` — 温度設定
 *
 * @private
 * @param {string} text - GCode テキスト全体
 * @returns {{ time?: string, filament?: string, layerHeight?: string, layers?: string, material?: string, nozzleTemp?: string, bedTemp?: string }}
 */
function _extractGcodeMeta(text) {
  const meta = {};
  // 先頭500行のみスキャン (メタデータはファイル先頭にある)
  const lines = text.split(/\r?\n/, 500);
  for (const line of lines) {
    const l = line.trim();
    // ;TIME:3600.00 or ;TIME:3600
    if (!meta.time && /^;TIME:\s*(\d+(?:\.\d+)?)/.test(l)) {
      const sec = parseFloat(RegExp.$1);
      if (sec > 0) {
        meta.timeSec = sec;
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        meta.time = h > 0 ? `${h}時間${m}分` : `${m}分`;
      }
    }
    // ;Filament used: 12.345m or ;Filament used:12345mm
    if (!meta.filament && /^;Filament used:\s*(.+)/i.test(l)) {
      const raw = RegExp.$1.trim();
      meta.filament = raw;
      // mm 単位に正規化して保持
      const mMatch = raw.match(/([\d.]+)\s*m(?:m)?/i);
      if (mMatch) {
        const val = parseFloat(mMatch[1]);
        meta.filamentMm = raw.toLowerCase().includes("mm") ? val : val * 1000;
      }
    }
    // ;Layer height: 0.2
    if (!meta.layerHeight && /^;Layer height:\s*([\d.]+)/i.test(l)) {
      meta.layerHeight = RegExp.$1;
    }
    // ;LAYER_COUNT:123
    if (!meta.layers && /^;LAYER_COUNT:\s*(\d+)/i.test(l)) {
      meta.layers = RegExp.$1;
    }
    // ;Material name:PLA
    if (!meta.material && /^;Material name:\s*(.+)/i.test(l)) {
      meta.material = RegExp.$1.trim();
    }
    // START_PRINT EXTRUDER_TEMP=215 BED_TEMP=60
    if (!meta.nozzleTemp && /EXTRUDER_TEMP\s*=\s*(\d+)/i.test(l)) {
      meta.nozzleTemp = RegExp.$1;
    }
    if (!meta.bedTemp && /BED_TEMP\s*=\s*(\d+)/i.test(l)) {
      meta.bedTemp = RegExp.$1;
    }
  }
  return meta;
}

/**
 * アップロード UI の初期化
 * @param {HTMLElement} [root] - パネル本体要素（省略時は document 全体）
 * @param {string} hostname - ホスト名
 */
/**
 * GCodeメタデータからHTMLメタ情報行を構築する。
 *
 * @private
 * @param {Object} gcMeta - _extractGcodeMeta() の戻り値
 * @returns {string} HTMLメタ情報（空の場合は空文字列）
 */
function _buildMetaHtml(gcMeta) {
  if (!gcMeta || typeof gcMeta !== "object") return "";
  const items = [];
  if (gcMeta.time) items.push(`⏱ ${gcMeta.time}`);
  if (gcMeta.filament) items.push(`🧵 ${gcMeta.filament}`);
  if (gcMeta.layers) items.push(`📐 ${gcMeta.layers}層`);
  if (gcMeta.layerHeight) items.push(`高さ ${gcMeta.layerHeight}mm`);
  if (gcMeta.material) items.push(`素材 ${gcMeta.material}`);
  if (gcMeta.nozzleTemp || gcMeta.bedTemp) {
    const temps = [];
    if (gcMeta.nozzleTemp) temps.push(`ノズル${gcMeta.nozzleTemp}℃`);
    if (gcMeta.bedTemp) temps.push(`ベッド${gcMeta.bedTemp}℃`);
    items.push(`🌡 ${temps.join(" / ")}`);
  }
  return items.length > 0 ? `<div class="pm-upload-meta">${items.join("　")}</div>` : "";
}

/**
 * アップロード確認ダイアログを表示する共通関数。
 * ボタンアップロード・D&Dアップロードの両方から呼ばれる。
 *
 * @private
 * @param {Object} opts - オプション
 * @param {string} opts.filename - ファイル名
 * @param {number} opts.fileSize - ファイルサイズ(bytes)
 * @param {string} opts.thumbUrl - サムネイルURL
 * @param {Object} opts.gcMeta - GCodeメタデータ
 * @param {boolean} opts.exists - 同名ファイルが存在するか
 * @param {string} [opts.hostSelectHtml=""] - ホスト選択HTML（マルチプリンタ時）
 * @param {Array<string>} [opts.existsHosts=[]] - 重複があるホスト名リスト
 * @returns {Promise<boolean>} ユーザーが確認したら true
 */
async function _showUploadConfirmDialog(opts) {
  const {
    filename, fileSize, thumbUrl, gcMeta,
    exists, hostSelectHtml = "", existsHosts = []
  } = opts;
  const sizeMB = (fileSize / 1024 / 1024).toFixed(1);

  // --- 印刷確認ダイアログと同じ .pm-print-* 構造を使用 ---

  // ヘッダー: サムネイル + ファイル名
  let html = `<div class="pm-print-header">`;
  html += `<img src="${thumbUrl}" class="pm-print-thumb" onerror="this.style.display='none'">`;
  html += `<div><strong class="pm-print-filename">${filename}</strong>`;
  html += `<div class="pm-print-remain-label">${sizeMB} MB</div></div></div>`;

  // GCode メタデータセクション
  const metaHtml = _buildMetaHtml(gcMeta);
  if (metaHtml) {
    html += `<div class="pm-print-section pm-print-neutral-section">`;
    html += `<div class="pm-print-section-title">📄 GCode 情報</div>`;
    html += metaHtml;
    html += `</div>`;
  }

  // 重複警告セクション
  if (exists) {
    html += `<div class="pm-print-section pm-print-warn-section">`;
    html += `<div class="pm-print-section-title">⚠ ファイル重複</div>`;
    if (existsHosts.length > 1) {
      const names = existsHosts.map(h => {
        const m = monitorData.machines[h];
        return m?.storedData?.hostname?.rawValue || h;
      }).join(", ");
      html += `<div>${existsHosts.length}台に同名ファイルが存在します</div>`;
      html += `<div class="pm-print-remain-label">${names}</div>`;
    } else {
      html += `<div>同名のファイルが存在します（上書きされます）</div>`;
    }
    html += `</div>`;
  }

  // 送信先セクション
  if (hostSelectHtml) {
    html += hostSelectHtml;
  }

  return showConfirmDialog({
    level: exists ? "warn" : "info",
    title: "ファイルアップロード",
    html,
    confirmText: exists ? "上書きアップロード" : "アップロード",
    cancelText: "キャンセル"
  });
}

export function setupUploadUI(root, hostname) {
  const ctx = root || document;
  const btn        = ctx.querySelector("#gcode-upload-btn") || document.getElementById("gcode-upload-btn");
  const input      = ctx.querySelector("#gcode-upload-input") || document.getElementById("gcode-upload-input");
  const progress   = ctx.querySelector("#gcode-upload-progress") || document.getElementById("gcode-upload-progress");
  const percentEl  = ctx.querySelector("#gcode-upload-percent") || document.getElementById("gcode-upload-percent");
  const dropLayer  = document.getElementById("drop-overlay");
  const dropClose  = document.getElementById("drop-overlay-close");
  if (!btn || !input || !progress || !percentEl) return;
  /* ドロップオーバーレイが無い場合でもボタンアップロードは動作可能 */

  let currentFile = null;

  /**
   * アップロード進捗バーを更新する。
   *
   * @param {number} loaded - 読み込み済みバイト数
   * @param {number} total  - 全体のバイト数
   * @returns {void}
   */
  function updateProgress(loaded, total) {
    if (!total) { percentEl.textContent = "0%"; return; }
    const pct = Math.floor((loaded / total) * 100);
    const remain = total - loaded;
    const remainMb = (remain / (1024 * 1024)).toFixed(1);
    percentEl.textContent = `${pct}% (残り ${remainMb}MB)`;
  }

  /** 進捗バーを表示する */
  function showProgress() { progress.classList.remove("hidden"); }
  /** 進捗バーを非表示にする */
  function hideProgress() { progress.classList.add("hidden"); updateProgress(0,0); }

  /** ドロップオーバーレイを表示する */
  function showDropLayer() { dropLayer?.classList.remove("hidden"); }
  /** ドロップオーバーレイを隠す */
  function hideDropLayer() { dropLayer?.classList.add("hidden"); }

  /**
   * ファイルを読み込んで文字列として返す。
   * 読み込み中は進捗イベントでバーを更新する。
   *
   * @param {File} file - 読み込むファイル
   * @returns {Promise<string>} 読み込んだテキスト
   */
  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onprogress = e => {
        if (e.lengthComputable) updateProgress(e.loaded, e.total);
      };
      reader.onerror = () => reject(new Error("read error"));
      reader.onload = () => resolve(reader.result);
      reader.readAsText(file);
    });
  }

  /**
   * G-code 文字列から埋め込みサムネイルを抽出する。
   *
   * @param {string} text - G-code 全文
   * @returns {string|null} 抽出した data URI。無ければ null
   */
  function extractThumb(text) {
    const lines = text.split(/\r?\n/);
    const s = lines.findIndex(l => /^\s*;\s*png begin/.test(l));
    const e = lines.findIndex(l => /^\s*;\s*png end/.test(l), s + 1);
    if (s < 0 || e < 0) return null;
    const b64 = lines.slice(s + 1, e).map(l => l.replace(/^\s*;\s*/, "")).join("");
    return `data:image/png;base64,${b64}`;
  }

  /**
   * ファイル一覧データから同名ファイルの有無を判定するヘルパー。
   *
   * 画面要素は参照せず、最新描画時に保持した内部配列 `_fileList`
   * を検索することで高速に重複を確認する。
   *
   * @param {string} fname - 確認するファイル名
   * @returns {boolean} 同名が存在すれば true
   */
  function hasSameFile(fname) {
    return (_fileListMap.get(hostname) || []).some(entry => entry.basename === fname);
  }

  /**
   * 選択されたファイルを読み込み、アップロード確認ダイアログを表示する。
   *
   * 読み込み中は進捗バーを表示し、サムネイル抽出も行う。
   *
   * @param {File} file - ユーザーが選択した G-code ファイル
   * @returns {Promise<void>} 処理完了時に解決
   */
  /**
   * ファイル読み込み→確認ダイアログ→アップロードの共通フロー。
   * ボタン・D&D の両方から呼ばれる。マルチプリンタ時はホスト選択UIも表示。
   *
   * @param {File} file - アップロード対象ファイル
   * @returns {Promise<void>}
   */
  async function prepareAndConfirm(file) {
    currentFile = file;
    btn.disabled = true;
    showProgress();
    let thumb;
    let gcMeta = {};
    try {
      const text = await readFile(file);
      updateProgress(file.size, file.size);
      thumb = extractThumb(text);
      gcMeta = _extractGcodeMeta(text);
      if (Object.keys(gcMeta).length > 0) {
        _gcodeMetaCache.set(file.name, gcMeta);
        _saveGcodeMetaCache();
      }
    } catch (e) {
      hideProgress();
      btn.disabled = false;
      console.error(e);
      showConfirmDialog({
        level: "error",
        title: "ファイル読み込み失敗",
        message: e.message,
        confirmText: "OK"
      });
      return;
    }
    hideProgress();
    btn.disabled = false;
    if (!thumb) {
      thumb = `http://${getDeviceIp(hostname)}/downloads/defData/file_icon.png`;
    }

    // 接続中プリンタ一覧（D&D版と同じロジック）
    const allHosts = Object.keys(monitorData.machines).filter(
      h => h !== "_$_NO_MACHINE_$_"
        && monitorData.machines[h]?.storedData
        && getConnectionState(h) === "connected"
    );

    // 各ホストでの重複チェック
    const existsHosts = allHosts.filter(h =>
      (_fileListMap.get(h) || []).some(entry => entry.basename === file.name)
    );
    const exists = existsHosts.length > 0;

    // 送信先セクション（1台でも表示、マルチ時はチェックボックス付き）
    let hostSelectHtml = "";
    if (allHosts.length === 1) {
      // シングルホスト: 変更不可で送信先を表示
      const m = monitorData.machines[allHosts[0]];
      const name = m?.storedData?.hostname?.rawValue || allHosts[0];
      const dup = existsHosts.includes(allHosts[0]) ? ' <span class="pm-upload-dup-tag">(上書き)</span>' : "";
      hostSelectHtml = `
        <div class="pm-upload-host-section">
          <div class="pm-upload-host-single">🖨 送信先: <strong>${name}</strong>${dup}</div>
        </div>`;
    } else if (allHosts.length > 1) {
      const checkboxes = allHosts.map(h => {
        const m = monitorData.machines[h];
        const name = m.storedData?.hostname?.rawValue || h;
        const dup = existsHosts.includes(h) ? ' <span class="pm-upload-dup-tag">(上書き)</span>' : "";
        return `<label class="pm-upload-host-label"><input type="checkbox" class="pm-upload-host-chk" value="${h}" checked> ${name}${dup}</label>`;
      }).join("");
      hostSelectHtml = `
        <div class="pm-upload-host-section">
          <div class="pm-upload-host-header"><label><input type="checkbox" id="pm-upload-host-all" checked> 全て選択/解除</label></div>
          <div class="pm-upload-host-list">${checkboxes}</div>
        </div>`;
    }

    // ホスト選択チェックボックスのイベント設定（ダイアログ表示直後に登録）
    setTimeout(() => {
      const allChk = document.getElementById("pm-upload-host-all");
      if (allChk) {
        allChk.addEventListener("change", () => {
          document.querySelectorAll(".pm-upload-host-chk").forEach(c => { c.checked = allChk.checked; });
        });
      }
      const confirmBtn = document.querySelector(".confirm-button.confirm-destructive");
      if (confirmBtn) {
        confirmBtn.addEventListener("click", () => {
          const checked = document.querySelectorAll(".pm-upload-host-chk:checked");
          _lastSelectedUploadHosts = checked.length > 0
            ? [...checked].map(el => el.value)
            : [hostname];
        }, true);
      }
    }, 0);

    const ok = await _showUploadConfirmDialog({
      filename: file.name,
      fileSize: file.size,
      thumbUrl: thumb,
      gcMeta,
      exists,
      hostSelectHtml,
      existsHosts
    });
    if (!ok) return;

    // アップロード実行（マルチ/シングル統一）
    const targets = (allHosts.length > 1)
      ? (_lastSelectedUploadHosts.length > 0 ? _lastSelectedUploadHosts : [hostname])
      : [hostname];

    btn.disabled = true;
    showProgress();
    updateProgress(0, file.size);

    // 全ホストへ並行アップロード + 結果サマリー
    const results = await Promise.all(
      targets.map(h => _uploadToHost(file, h))
    );
    hideProgress();
    btn.disabled = false;

    const okList = results.filter(r => r.ok);
    const failList = results.filter(r => !r.ok);
    if (results.length === 1) {
      // シングルホスト: シンプルな結果表示
      const r = results[0];
      await showConfirmDialog({
        level: r.ok ? "success" : "error",
        title: r.ok ? "アップロード完了" : "アップロード失敗",
        message: `${r.name} → ${r.host} ${r.detail}`,
        confirmText: "OK"
      });
    } else {
      // マルチホスト: 一括結果表示
      const lines = [];
      for (const r of okList)   lines.push(`✅ ${r.host} ${r.detail}`);
      for (const r of failList) lines.push(`❌ ${r.host}: ${r.detail}`);
      const allOk = failList.length === 0;
      await showConfirmDialog({
        level: allOk ? "success" : (okList.length > 0 ? "warn" : "error"),
        title: allOk ? "アップロード完了" : "アップロード結果",
        html: `<div class="pm-upload-filename">${file.name}</div>
               <div class="pm-upload-meta">${lines.join("<br>")}</div>`,
        confirmText: "OK"
      });
    }
    currentFile = null;
    input.value = "";
  }

  /**
   * ファイル一覧を取得してアップロード成否を確認する。
   * 指定ホストのファイル一覧を再取得し、アップロードしたファイルが存在するか検証する。
   *
   * @param {string} fname      - アップロードしたファイル名
   * @param {string} targetHost - 検証対象のホスト名
   * @returns {Promise<boolean>} ファイルが見つかれば true
   */
  async function verifyUploadSuccess(fname, targetHost) {
    try {
      await sendCommand("get", { reqGcodeFile: 1 }, targetHost);
      // ファイル一覧更新まで少し待つ
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      console.warn("verifyUploadSuccess: sendCommand failed", e);
    }
    // 内部配列から検索（DOM に依存しない）
    const list = _fileListMap.get(targetHost) || [];
    return list.some(entry => entry.basename === fname);
  }

  /**
   * 指定ファイルを指定ホストへアップロードする。
   *
   * XHR を用いて POST 送信し、結果を Promise で返す。
   * K1 系プリンタは大きなファイルのアップロード後に接続を切断し
   * status=0 を返すことがあるため、エラー時はファイル一覧で検証する。
   *
   * @param {File}   file       - アップロードするファイル
   * @param {string} targetHost - アップロード先のホスト名
   * @returns {Promise<{ok:boolean, host:string, name:string, detail:string}>}
   */
  function _uploadToHost(file, targetHost) {
    const ip  = getDeviceIp(targetHost);
    const url = `http://${ip}/upload/${encodeURIComponent(file.name)}`;
    const form = new FormData();
    form.append("file", file, file.name);
    const displayName = monitorData.machines[targetHost]?.storedData?.hostname?.rawValue || targetHost;

    return new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      // タイムアウト: ファイルサイズに応じて動的設定 (最低5分, 10ms/KB)
      xhr.timeout = Math.max(300000, Math.round(file.size / 1024 * 10));
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) updateProgress(e.loaded, e.total);
      };

      xhr.onload = async () => {
        if (xhr.status === 200) {
          resolve({ ok: true, host: displayName, name: file.name, detail: "" });
        } else {
          // status !== 200 でもファイル一覧で検証
          const verified = await verifyUploadSuccess(file.name, targetHost);
          if (verified) {
            resolve({ ok: true, host: displayName, name: file.name, detail: "(検証済み)" });
          } else {
            resolve({ ok: false, host: displayName, name: file.name,
              detail: `HTTP ${xhr.status} ${xhr.statusText}` });
          }
        }
      };

      const handleError = async () => {
        const detail = `status=${xhr.status} readyState=${xhr.readyState}`;
        // K1 はアップロード成功後に接続を切ることがある — ファイル一覧で検証
        const verified = await verifyUploadSuccess(file.name, targetHost);
        if (verified) {
          resolve({ ok: true, host: displayName, name: file.name, detail: "(検証済み)" });
        } else {
          resolve({ ok: false, host: displayName, name: file.name,
            detail: `ネットワークエラー (${detail})` });
        }
      };
      xhr.onerror = handleError;
      xhr.onabort = handleError;
      xhr.ontimeout = handleError;
      xhr.send(form);
    });
  }

  input.addEventListener("change", () => {
    if (input.files?.length) prepareAndConfirm(input.files[0]);
  });

  btn.addEventListener("click", () => {
    if (currentFile) {
      prepareAndConfirm(currentFile);
    } else if (input.files?.length) {
      prepareAndConfirm(input.files[0]);
    } else {
      alert("まず .gcode ファイルを選択してください");
    }
  });

  // ドキュメント全体のドラッグ&ドロップは1度だけ登録
  if (!_dropHandlerInstalled) {
    _dropHandlerInstalled = true;
    document.addEventListener("dragover", e => {
      e.preventDefault();
      showDropLayer();
    });
    document.addEventListener("dragleave", e => {
      if (e.target === document || e.target === dropLayer) {
        hideDropLayer();
      }
    });
    document.addEventListener("drop", async (e) => {
      e.preventDefault();
      hideDropLayer();
      if (!e.dataTransfer?.files?.length) return;
      const file = e.dataTransfer.files[0];

      // D&D も共通の prepareAndConfirm フローを使う
      prepareAndConfirm(file);
    });
  }

  if (dropClose) dropClose.addEventListener("click", hideDropLayer);
}

/** --- 1) タブ切り替えの初期設定 --- */
export function initHistoryTabs() {
  const btnH = document.getElementById("tab-print-history");
  const btnF = document.getElementById("tab-file-list");
  const pH = document.getElementById("panel-print-history-tab");
  const pF = document.getElementById("panel-file-list");
  if (!btnH || !btnF || !pH || !pF) return;
  btnH.addEventListener("click", () => {
    btnH.classList.add("active"); btnF.classList.remove("active");
    pH.classList.remove("hidden"); pF.classList.add("hidden");
  });
  btnF.addEventListener("click", () => {
    btnF.classList.add("active"); btnH.classList.remove("active");
    pF.classList.remove("hidden"); pH.classList.add("hidden");
  });
}

/**
 * 印刷履歴からファイル単位の統計情報を生成する。
 * 完了済みの履歴のみを対象とし、印刷回数と総使用時間を集計する。
 *
 * @returns {Map<string, {md5: string, count: number, totalSec: number}>}
 *          キー: rawFilename または basename
 */
function buildHistoryStats(hostname) {
  const map = new Map();
  const history = loadHistory(hostname);
  history.forEach(job => {
    if (!job.finishTime) return; // 未完了は除外
    const key = job.rawFilename || job.filename;
    const start = job.startTime ? Date.parse(job.startTime) : 0;
    const finish = job.finishTime ? Date.parse(job.finishTime) : 0;
    const sec = finish && start ? (finish - start) / 1000 : 0;
    const entry = map.get(key) || { md5: job.filemd5 || "", count: 0, totalSec: 0 };
    if (!entry.md5 && job.filemd5) entry.md5 = job.filemd5;
    entry.count++;
    entry.totalSec += sec;
    map.set(key, entry);
  });
  return map;
}

/**
 * ファイル別の印刷実績インサイトを生成する。
 *
 * 印刷回数・成功率・平均時間・平均消費量・コスト推定を返す。
 * 印刷前ダイアログやファイル一覧の情報強化に使用する。
 *
 * @param {string} filename - ファイルパスまたは basename
 * @param {string} hostname - ホスト名
 * @returns {Object|null} インサイト情報。該当なしの場合 null
 */
export function buildFileInsight(filename, hostname) {
  const history = loadHistory(hostname);
  const basename = filename.split("/").pop();

  const matching = history.filter(j => {
    const jName = (j.rawFilename || j.filename || "").split("/").pop();
    return jName === basename;
  });
  if (matching.length === 0) return null;

  let successTotalSec = 0, successTotalMaterial = 0;
  let failTotalSec = 0, failTotalMaterial = 0;
  let successCount = 0, failCount = 0;
  let lastDate = null, lastResult = null;

  for (const j of matching) {
    const start = j.startTime ? Date.parse(j.startTime) : 0;
    const finish = j.finishTime ? Date.parse(j.finishTime) : 0;
    const sec = (finish && start) ? (finish - start) / 1000 : 0;
    const mat = j.materialUsedMm > 0 ? j.materialUsedMm : 0;

    if (j.printfinish === 1) {
      // 成功印刷: 平均値算出の対象
      successCount++;
      successTotalSec += sec;
      successTotalMaterial += mat;
    } else {
      // 失敗/中断: 平均値には含めない（参考値として保持）
      failCount++;
      failTotalSec += sec;
      failTotalMaterial += mat;
    }

    const ts = j.finishTime || j.startTime;
    if (ts && (!lastDate || ts > lastDate)) {
      lastDate = ts;
      lastResult = j.printfinish;
    }
  }

  const printCount = matching.length;
  // ★ 平均値は成功印刷のみで計算（失敗の過少/過大な値を排除）
  const avgDurationSec = successCount > 0 ? successTotalSec / successCount : 0;
  const avgMaterialMm = successCount > 0 ? successTotalMaterial / successCount : 0;

  return {
    printCount,
    successCount,
    failCount,
    successRate: printCount > 0 ? successCount / printCount : 0,
    avgDurationSec,     // 成功印刷のみの平均
    avgMaterialMm,      // 成功印刷のみの平均
    failAvgDurationSec: failCount > 0 ? failTotalSec / failCount : 0,
    failAvgMaterialMm:  failCount > 0 ? failTotalMaterial / failCount : 0,
    lastPrintDate: lastDate,
    lastResult,
    md5: matching.find(j => j.filemd5)?.filemd5 || ""
  };
}

/** --- 2) fileInfo テキストをパースして配列に --- */
function parseFileInfo(text, baseUrl) {
  // 各ファイル情報は「;」区切り
  return text.split(";").filter(s=>s).map((entry, idx) => {
    const [path,filename, size, layer, mtime, expect, thumb] = entry.split(":");
    const fullPath  = `${path}/${filename}`;
    const thumbUrl  = makeThumbUrl(baseUrl, thumb);
    return {
      // --- テーブル描画に必要なフィールド ---
      number:       idx + 1,
      basename:     filename,                    // 表示用のファイル名
      size:         Number(size),
      layer:        Number(layer),
      mtime:        new Date(Number(mtime) * 1000),
      expect:       Number(expect),
      thumbUrl:     thumbUrl,

      // --- 履歴(raw) と同じインターフェース ---
      filename:     fullPath,                    // raw.filename
      usagetime:    0,                           // ファイル一覧では不明なので 0 or 適宜
      usagematerial: Number(expect) || 0,        // raw.usagematerial 相当
      filemd5:      "",
      printCount:   0
    };
  });
}

/** --- 3) ファイル一覧描画 --- */
export function renderFileList(info, baseUrl, hostname) {
  // parseFileInfo で揃えたキー群をもつオブジェクト配列を得る
  pushLog("[renderFileList] マージ処理開始 (保存データなし)", "info", false, hostname);
  const arr = parseFileInfo(info.fileInfo, baseUrl);

  // 最新の一覧をアップロード検証用に保持
  _fileListMap.set(hostname, arr.slice());

  // 履歴から印刷回数と実使用時間を取得
  const stats = buildHistoryStats(hostname);
  arr.forEach(item => {
    const st = stats.get(item.filename);
    if (st) {
      item.filemd5 = st.md5;
      item.printCount = st.count;
      if (st.count > 0) item.usagetime = Math.round(st.totalSec / st.count);
    }
    // 履歴が無い場合、アップロード時に抽出した GCode メタデータをフォールバック
    const cached = _gcodeMetaCache.get(item.basename);
    if (cached) {
      if (!item.usagetime && cached.timeSec)  item.usagetime = Math.round(cached.timeSec);
      if (!item.layer && cached.layers)       item.layer = Number(cached.layers);
      item._gcodeMeta = cached;  // handlePrintClick で参照可能にする
    }
  });

  // 総数表示
  const totalEl = scopedById("file-list-total", hostname);
  if (totalEl) totalEl.textContent = info.totalNum;

  const fileTable = scopedById("file-list-table", hostname);
  const tbody = fileTable?.querySelector("tbody");
  if (!tbody) return;

  // 前回の行をクリアしてから再描画
  tbody.innerHTML = "";

  arr.forEach(item => {
    const tr = document.createElement("tr");
    tr.className = "file-row";
    const md5short = item.filemd5 ? item.filemd5.substring(0, 8) : "";
    // 更新日時を YYYY/MM/DD HH:MM:SS 形式にフォーマット
    const d = item.mtime;
    const mtimeStr = d instanceof Date && !isNaN(d)
      ? `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`
      : "—";

    // ファイル別実績
    const insight = buildFileInsight(item.filename, hostname);
    const expectFmt = formatFilamentAmount(item.expect, null);

    // 実績列: "4/5" (成功/全体) or "0"
    let printsLabel;
    if (insight && insight.printCount > 0) {
      printsLabel = `${insight.successCount}/${insight.printCount}`;
    } else {
      printsLabel = String(item.printCount || 0);
    }

    // 平均時間列（実績 > GCodeメタ > "—"）
    let avgTimeLabel;
    if (insight?.avgDurationSec > 0) {
      avgTimeLabel = formatDuration(insight.avgDurationSec);
    } else if (item._gcodeMeta?.timeSec) {
      avgTimeLabel = `≈${formatDuration(item._gcodeMeta.timeSec)}`;
    } else {
      avgTimeLabel = "—";
    }

    tr.innerHTML = `
      <td class="col-cmd">
        <button class="cmd-print icon-btn" title="印刷">▶</button>
        <button class="cmd-rename icon-btn" title="名前変更">✏</button>
        <button class="cmd-delete icon-btn" title="削除">🗑</button>
      </td>
      <td data-key="number" class="col-num">${item.number}</td>
      <td class="col-thumb">
        <img
          src="${item.thumbUrl}"
          alt="${item.basename}"
          style="width:40px"
          onerror="this.onerror=null;this.src='${baseUrl}/downloads/defData/file_icon.png'"
        >
      </td>
      <td data-key="filename">${item.basename}</td>
      <td data-key="layer">${item.layer.toLocaleString()}</td>
      <td data-key="size">${item.size.toLocaleString()}</td>
      <td data-key="mtime">${mtimeStr}</td>
      <td data-key="expect">${expectFmt.display}</td>
      <td data-key="prints">${printsLabel}</td>
      <td data-key="avgtime">${avgTimeLabel}</td>
      <td data-key="md5" class="col-md5" title="${item.filemd5 || ''}">${md5short}</td>
    `;
    tbody.appendChild(tr);

    // イベントハンドラ
    tr.querySelector(".cmd-print")?.addEventListener("click", () => {
      handlePrintClick(item, item.thumbUrl, hostname);
    });
    tr.querySelector(".cmd-rename")?.addEventListener("click", () => {
      handleRenameClick(item, hostname);
    });
    tr.querySelector(".cmd-delete")?.addEventListener("click", () => {
      handleDeleteClick(item, hostname);
    });
  });

  // ソート用リスナ + インジケータ
  if (fileTable) {
    _bindSortHeaders(fileTable, "file-list-table", hostname);
  }
  pushLog("[renderFileList] UI へ反映しました", "info", false, hostname);
}

/**
 * テーブルヘッダーにソートイベントとインジケータをバインドする。
 * @param {HTMLElement} table - テーブル要素
 * @param {string} tableId - テーブルID（sortTable用）
 * @param {string} hostname - ホスト名
 */
function _bindSortHeaders(table, tableId, hostname) {
  table.querySelectorAll("th[data-key]").forEach(th => {
    /* 重複バインド防止: 既にバインド済みなら何もしない */
    if (th._sortBound) return;
    th._sortBound = true;
    th.classList.add("sortable");
    th.addEventListener("click", () => {
      sortTable(tableId, th.dataset.key, hostname);
    });
  });
}

/** --- 4) 汎用ソート関数（ソートインジケータ付き） --- */
function sortTable(tableId, key, hostname) {
  /* パネルシステムではIDがスコープされるため scopedById を優先使用 */
  const table = scopedById(tableId, hostname);
  if (!table || !key) return;
  const tbody = table.querySelector("tbody");
  const rows = Array.from(tbody.querySelectorAll("tr"));
  // 昇順<->降順トグル
  const asc = !table.dataset[ key + "_asc" ];
  table.dataset[ key + "_asc" ] = asc ? "1" : "";

  rows.sort((a, b) => {
    const ta = a.querySelector(`td[data-key="${key}"]`);
    const tb = b.querySelector(`td[data-key="${key}"]`);
    const va = ta?.dataset.sec ?? ta?.textContent ?? "";
    const vb = tb?.dataset.sec ?? tb?.textContent ?? "";
    const na = parseFloat(String(va).replace(/,/g, ""));
    const nb = parseFloat(String(vb).replace(/,/g, ""));
    if (!isNaN(na) && !isNaN(nb)) {
      return asc ? na - nb : nb - na;
    }
    return asc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
  });
  rows.forEach(r => tbody.appendChild(r));

  // ソートインジケータ更新
  table.querySelectorAll("th[data-key]").forEach(th => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.key === key) {
      th.classList.add(asc ? "sort-asc" : "sort-desc");
    }
  });
}
