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
import { monitorData, currentHostname } from "./dashboard_data.js"; // filament残量取得用
import {
  getCurrentSpool,
  getCurrentSpoolId,
  useFilament,
  getSpoolById,
  updateSpool
} from "./dashboard_spool.js";
import { sendCommand, fetchStoredData, getDeviceIp } from "./dashboard_connection.js";
import { showVideoOverlay } from "./dashboard_video_player.js";
import { showSpoolDialog, showSpoolSelectDialog } from "./dashboard_spool_ui.js";
import { PRINT_STATE_CODE } from "./dashboard_ui_mapping.js";

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

// 最後に保存した JSON 文字列のキャッシュ（差分チェック用）
let _lastSavedJson = "";

// 最新のファイル一覧データ（renderFileList 実行時に更新）
let _fileList = [];

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
export function parseRawHistoryEntry(raw, baseUrl, host = currentHostname) {
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
  // 材料使用量は小数第2位で切り上げ
  const materialUsedMm = Math.ceil((raw.usagematerial || 0) * 100) / 100;

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
export function parseRawHistoryList(rawArray, baseUrl, host = currentHostname) {
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
 * @returns {Object|null}
 */
export function loadCurrent() {
  return loadPrintCurrent();
}

/**
 * 現在印刷中ジョブを保存
 * @param {Object|null} job
 */
export function saveCurrent(job) {
  savePrintCurrent(job);
}

/**
 * 履歴一覧をロード
 * @returns {Array<Object>}
 */
export function loadHistory() {
  return loadPrintHistory();
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
export function saveHistory(jobs) {
  const json = JSON.stringify(jobs);
  if (json === _lastSavedJson) {
    // 変更なしならスキップ
    return;
  }
  _lastSavedJson = json;
  savePrintHistory(jobs);
  pushLog("[saveHistory] 印刷履歴を保存しました", "info");
}

/**
 * 保存済みの動画マップを取得する。
 * @returns {Record<string, string>}
 */
export function loadVideos() {
  return loadPrintVideos();
}

/**
 * 動画マップを保存する。
 * @param {Record<string, string>} map
 */
export function saveVideos(map) {
  savePrintVideos(map);
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
    // 大サムネイル URL
    const currentUrl = `${baseUrl}/downloads/original/current_print_image.png?${ts}`;
    // フォールバック画像
    const fallback   = `${baseUrl}/downloads/defData/file_print_photo.png`;
    return `
      <div class="current-print">
        <img
          class="print-job-thumb--large"
          src="${currentUrl}"
          onerror="this.onerror=null;this.src='${fallback}'"
          alt="現在印刷中"
        />
        <div class="print-job-info">
          <div class="filename"><strong>現在:</strong> ${name}</div>
          <div class="times">開始: ${fmt(job.startTime)}</div>
          <div class="material-used">使用: ${job.materialUsedMm != null ? job.materialUsedMm.toLocaleString() : "—"} mm</div>
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
            使用: ${job.materialUsedMm != null ? job.materialUsedMm.toLocaleString() : "—"} mm
          </div>
      </div>
    `;
  }
}; // ← renderTemplates 終了




// ---------------------- DOM 描画 ----------------------

/**
 * 現在印刷中ジョブを指定コンテナに描画
 * @param {HTMLElement|null} containerEl - 描画先要素。null の場合は処理しません
 */
export function renderPrintCurrent(containerEl) {
  if (!containerEl) return;
  containerEl.innerHTML = "";
  const job = loadCurrent();
  const ip = getDeviceIp();
  const baseUrl = `http://${ip}`;


  if (!job) {
    containerEl.innerHTML = "<p>現在印刷中のジョブはありません。</p>";
    return;
  } else {
    containerEl.innerHTML = renderTemplates.current(job, baseUrl);
  }
}


/**
 * 印刷履歴リストを指定コンテナ（ul または div）に描画
 * @param {HTMLElement|null} containerEl - 描画先要素。null なら何もしません
 */
export function renderPrintHistory(containerEl) {
  if (!containerEl) return;
  const jobs = loadHistory();
  const ip = getDeviceIp();
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
  host = currentHostname
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
  const oldJobs = loadHistory();
  const mergedMap = new Map();
  newJobs.forEach(j => mergedMap.set(String(j.id), j));
  oldJobs.forEach(j => {
    if (!mergedMap.has(String(j.id))) mergedMap.set(String(j.id), j);
  });
  const jobs = Array.from(mergedMap.values())
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, MAX_PRINT_HISTORY);


  const state = Number(machine?.runtimeData?.state ?? 0);
  const printing = [PRINT_STATE_CODE.printStarted, PRINT_STATE_CODE.printPaused].includes(state);
  const curSpoolId = getCurrentSpoolId();
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

  const videoMap = loadVideos();
  jobs.forEach(j => {
    const info = videoMap[j.id];
    if (info && info.videoUrl) j.videoUrl = info.videoUrl;
  });
  saveHistory(jobs);

  // 現在印刷中ジョブの更新があれば再描画
  const prev = loadCurrent();
  if (jobs[0]?.id !== prev?.id) {
    saveCurrent(jobs[0]);
    renderPrintCurrent(document.getElementById(currentContainerId));
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
  renderHistoryTable(mergedRaw, baseUrl);
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
 * @returns {void}
 */
export function updateHistoryList(
  rawArray,
  baseUrl,
  currentContainerId = "print-current-container",
  host = currentHostname
) {
  if (!Array.isArray(rawArray)) return;
  pushLog("[updateHistoryList] マージ処理を開始", "info");
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

  let merged = false;
  const oldJobs = loadHistory();
  const mergedMap = new Map();
  newJobs.forEach(j => mergedMap.set(String(j.id), j));
  oldJobs.forEach(j => {
    const cur = mergedMap.get(String(j.id));
    if (cur) {
      Object.entries(j).forEach(([k, v]) => {
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

  const videoMap = loadVideos();
  jobs.forEach(j => {
    const info = videoMap[j.id];
    if (info && info.videoUrl) j.videoUrl = info.videoUrl;
  });
  saveHistory(jobs);
  pushLog(
    `[updateHistoryList] 保存データとマージ ${merged ? "完了" : "変更なし"}`,
    "info"
  );

  const prev = loadCurrent();
  if (jobs[0]?.id !== prev?.id) {
    saveCurrent(jobs[0]);
    renderPrintCurrent(document.getElementById(currentContainerId));
  }

  // ここから UI 更新処理。保存済みジョブ配列を簡易 raw 形式に変換し、
  // 統合された履歴としてテーブルへ描画する
  const raw = jobsToRaw(jobs);
  renderHistoryTable(raw, baseUrl);
  pushLog("[updateHistoryList] UI へ反映しました", "info");
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
export function updateVideoList(videoArray, baseUrl, host = currentHostname) {
  if (!Array.isArray(videoArray) || !videoArray.length) return;
  pushLog("[updateVideoList] マージ処理を開始", "info");
  const map = { ...loadVideos() };
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
    pushLog("[updateVideoList] saveVideos() を呼び出します", "info");
    saveVideos(map);
  }

  const jobs = loadHistory();
  let changed = false;
  jobs.forEach(job => {
    const info = map[job.id];
    if (info && info.videoUrl && job.videoUrl !== info.videoUrl) {
      job.videoUrl = info.videoUrl;
      changed = true;
    }
  });
  if (changed) {
    saveHistory(jobs);
    // 動画マップが更新されていない場合でも
    // 履歴に動画URLが追加されたタイミングで保存を保証する
    if (!updated) saveVideos(map);
  }
  if (updated || changed) {
    const raw = jobsToRaw(jobs);
    renderHistoryTable(raw, baseUrl);
  }
  pushLog(
    `[updateVideoList] 保存データとマージ ${updated || changed ? "完了" : "変更なし"}`,
    "info"
  );
  if (updated || changed) {
    pushLog("[updateVideoList] UI へ反映しました", "info");
  }
}

/**
 * rawArray の各エントリを HTML テーブルに描画し、
 * 操作ボタンにイベントをバインドします。
 *
 * @param {Array<Object>} rawArray - プリンタから受信した生履歴データ配列
 * @param {string} baseUrl         - サムネイル取得用のサーバーベース URL
 */
export function renderHistoryTable(rawArray, baseUrl) {
  const tbody = document.querySelector("#print-history-table tbody");
  const fmt = iso => iso ? formatEpochToDateTime(iso) : "—";
  const startwayMap = {
    1:  "機器操作経由",
    11: "外部操作経由",
    9:  "クラウド経由"
  };
  
  if (!tbody) return;

  tbody.innerHTML = "";

  rawArray.forEach((raw, index) => {
    const name     = raw.filename.split("/").pop();
    const thumbUrl = makeThumbUrl(baseUrl, raw.filename);
    const fallback = `${baseUrl}/downloads/defData/file_icon.png`;

    // テーブル行を作成
    const startwayLabel =
      raw.startway !== undefined
        ? (startwayMap[raw.startway] || raw.startway)
        : "—";
    const size      = raw.size != null ? raw.size.toLocaleString() : "—";
    const ctime     = raw.ctime ? fmt(raw.ctime) : "—";
    const stime     = raw.starttime ? fmt(raw.starttime) : "—";
    const astime    = raw.actualStartTime ? fmt(raw.actualStartTime) : "—";
    const etime     = raw.endtime ? fmt(raw.endtime) : "—";
    const utimeSec  = raw.usagetime != null ? Number(raw.usagetime) : null;
    const utime     = utimeSec != null ? formatDuration(utimeSec) : "—";
    const prepSec   = raw.preparationTime != null ? Number(raw.preparationTime) : null;
    const preptime  = prepSec != null ? formatDuration(prepSec) : "—";
    const checkSec  = raw.firstLayerCheckTime != null ? Number(raw.firstLayerCheckTime) : null;
    const checktime = checkSec != null ? formatDuration(checkSec) : "—";
    const pauseSec  = raw.pauseTime != null ? Number(raw.pauseTime) : null;
    const pausetime = pauseSec != null ? formatDuration(pauseSec) : "—";
    const umaterial =
      raw.usagematerial != null
        ? `${(Math.ceil(raw.usagematerial * 100) / 100).toLocaleString()} mm`
        : "—";
    const finish    = raw.printfinish ? "✔︎" : "";
    const md5       = raw.filemd5 || "—";
    const videoLink = raw.videoUrl
      ? `<button class="video-link" data-url="${raw.videoUrl}">📹</button>`
      : "";
    const spoolInfos = Array.isArray(raw.filamentInfo)
      ? raw.filamentInfo
      : (raw.filamentId ? [{ spoolId: raw.filamentId }] : []);
    const matColors = {
      PLA: '#FFEDD5',
      'PLA+': '#FED7AA',
      PETG: '#DBEAFE',
      ABS: '#FECACA',
      TPU: '#E9D5FF'
    };
    const spoolTexts = [];
    const countTexts = [];
    const remainTexts = [];
    const changeTexts = [];
    if (spoolInfos.length === 0) {
      spoolTexts.push(
        `<button class="spool-assign" data-id="${raw.id}">スプール指定</button>`
      );
    }
    spoolInfos.forEach((info, idx) => {
      const sp = getSpoolById(info.spoolId) || null;
      const mat = info.material || sp?.material || '';
      const matColor = mat ? (matColors[mat] || '#EEE') : '#EEE';
      const color = info.filamentColor || sp?.filamentColor || '#000';
      const colorBox = `<span class="filament-color-box" style="color:${color};">■</span>`;
      const matTag   = mat ? `<span class="material-tag" style="background:${matColor};">${mat}</span>` : '';
      const name = info.spoolName || sp?.name || '';
      const colName = info.colorName || sp?.colorName || '';
      let text = name || colName ? `${colorBox} ${matTag} ${name}/${colName}` : '(不明)';
      if (idx === 0) {
        const editId = info.spoolId || raw.filamentId;
        if (editId) text += ` <button class="spool-edit" data-id="${editId}">修正</button>`;
      }
      spoolTexts.push(text);
      countTexts.push(info.spoolCount ?? sp?.printCount ?? 0);
      remainTexts.push(info.expectedRemain ?? sp?.remainingLengthMm ?? 0);
      const serial = info.serialNo ?? sp?.serialNo ?? '';
      changeTexts.push(`🔄️ ${serial}`);
    });
    const spoolText = spoolTexts.join('<br>');
    const printCnt  = countTexts.join('<br>');
    const remainLen = remainTexts.join('<br>');
    const changeText = changeTexts.join('<br>');
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <button class="cmd-print">印刷</button>
        <button class="cmd-rename">名前変更</button>
        <button class="cmd-delete">削除</button>
      </td>
      <td data-key="number">${index + 1}</td>
      <td data-key="id">${raw.id}</td>
      <td>
        <img
          src="${thumbUrl}"
          alt="${name}"
          style="width:50px"
          onerror="this.onerror=null;this.src='${fallback}'"
        />
      </td>
      <td>${name}</td>
      <td data-key="startway">${startwayLabel}</td>
      <td data-key="size">${size}</td>
      <td data-key="ctime">${ctime}</td>
      <td data-key="starttime">${stime}</td>
      <td data-key="actualstart">${astime}</td>
      <td data-key="endtime">${etime}</td>
      <td data-key="preptime" data-sec="${prepSec ?? ''}">${preptime}</td>
      <td data-key="checktime" data-sec="${checkSec ?? ''}">${checktime}</td>
      <td data-key="pausetime" data-sec="${pauseSec ?? ''}">${pausetime}</td>
      <td data-key="usagetime" data-sec="${utimeSec ?? ''}">${utime}</td>
      <td data-key="usagematerial">${umaterial}</td>
      <td>${finish}</td>
      <td>${md5}</td>
      <td>${videoLink}</td>
      <td>${spoolText}</td>
      <td data-key="spoolchange">${changeText}</td>
      <td data-key="spoolcount">${printCnt}</td>
      <td data-key="remain">${remainLen}</td>
    `;
    tbody.appendChild(tr);

    // ボタンごとにクリックハンドラを登録
    tr.querySelector(".cmd-print")?.addEventListener("click", () => {
      handlePrintClick(raw, thumbUrl);
    });
    tr.querySelector(".cmd-rename")?.addEventListener("click", () => {
      handleRenameClick(raw);
    });
    tr.querySelector(".cmd-delete")?.addEventListener("click", () => {
      handleDeleteClick(raw);
    });
    tr.querySelector(".video-link")?.addEventListener("click", () => {
      showVideoOverlay(raw.videoUrl);
    });
    tr.querySelector(".spool-edit")?.addEventListener("click", async ev => {
      const sid = ev.currentTarget?.dataset.id;
      const sp = sid ? getSpoolById(sid) : null;
      if (!sp) {
        alert("スプール情報が見つかりません");
        return;
      }
      const res = await showSpoolDialog({ title: "スプール編集", spool: sp });
      if (res) {
        updateSpool(sp.id, res);
      }
    });
    tr.querySelector(".spool-assign")?.addEventListener("click", async () => {
      const sp = await showSpoolSelectDialog({ title: "スプール指定" });
      if (!sp) return;
      raw.filamentInfo = [
        {
          spoolId: sp.id,
          serialNo: sp.serialNo,
          spoolName: sp.name,
          colorName: sp.colorName,
          filamentColor: sp.filamentColor,
          material: sp.material,
          spoolCount: sp.printCount,
          expectedRemain: sp.remainingLengthMm
        }
      ];
      updateHistoryList([raw], baseUrl);
    });
  });

  // ソート用リスナ追加
  document.querySelectorAll("#print-history-table th").forEach(th => {
    th.onclick = () => sortTable("#print-history-table", th.dataset.key);
  });

}

/**
 * 印刷実行ボタン押下時の処理。
 * 残フィラメント量を計算し、確認ダイアログを表示後、送信します。
 *
 * @param {Object} raw     - 行データ
 * @param {string} thumbUrl - サムネイル画像の URL
 */
async function handlePrintClick(raw, thumbUrl) {
  const usedSec        = raw.usagetime;
  const expectedFinish = new Date(Date.now() + usedSec * 1000).toLocaleString();
  const materialNeeded = Math.ceil(raw.usagematerial * 100) / 100;
  const spool          = getCurrentSpool();
  const remaining      = spool?.remainingLengthMm ?? 0;
  const afterRemaining = Math.max(0, remaining - materialNeeded).toLocaleString();

  const html = `
    <img src="${thumbUrl}" style="width:80px; float:left; margin:0 12px 12px 0">
    <div><strong>${raw.filename.split("/").pop()}</strong></div>
    <div>所要時間: ${usedSec}s → 完了見込: ${expectedFinish}</div>
    <div>フィラメント: ${remaining} − ${materialNeeded} ＝ ${afterRemaining} mm</div>
  `;

  const ok = await showConfirmDialog({
    level:       "info",
    title:       "印刷実行の確認",
    // messageは 空,
    html:        html,
    confirmText: "印刷する",
    cancelText:  "キャンセル"
  });
  if (!ok) return;

  if (spool) {
    useFilament(materialNeeded);
  }

  // 実際にプリントコマンドを送信
  const target = raw.rawFilename ?? raw.filename;
  sendCommand(
    "set",
    { opGcodeFile: `printprt:${target}` },
    currentHostname
  );
}

/**
 * 削除ボタン押下時の処理。
 * 確認ダイアログ後に削除コマンドを送信します。
 *
 * @param {Object} raw - 行データ
 */
async function handleDeleteClick(raw) {
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
    currentHostname
  );
}

/**
 * 名前変更ボタン押下時の処理。
 * prompt で新名称を入力後、確認ダイアログ、送信を行います。
 *
 * @param {Object} raw - 行データ
 */
async function handleRenameClick(raw) {
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
    currentHostname
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

/** アップロード UI の初期化 */
export function setupUploadUI() {
  const btn        = document.getElementById("gcode-upload-btn");
  const input      = document.getElementById("gcode-upload-input");
  const progress   = document.getElementById("gcode-upload-progress");
  const percentEl  = document.getElementById("gcode-upload-percent");
  const dropLayer  = document.getElementById("drop-overlay");
  const dropClose  = document.getElementById("drop-overlay-close");
  if (!btn || !input || !progress || !percentEl || !dropLayer || !dropClose) return;

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
  function showDropLayer() { dropLayer.classList.remove("hidden"); }
  /** ドロップオーバーレイを隠す */
  function hideDropLayer() { dropLayer.classList.add("hidden"); }

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
    return _fileList.some(entry => entry.basename === fname);
  }

  /**
   * 選択されたファイルを読み込み、アップロード確認ダイアログを表示する。
   *
   * 読み込み中は進捗バーを表示し、サムネイル抽出も行う。
   *
   * @param {File} file - ユーザーが選択した G-code ファイル
   * @returns {Promise<void>} 処理完了時に解決
   */
  async function prepareAndConfirm(file) {
    currentFile = file;
    btn.disabled = true;
    showProgress();
    try {
      const text = await readFile(file);
      updateProgress(file.size, file.size);
      let thumb = extractThumb(text);
      if (!thumb) {
        const ip = getDeviceIp();
        thumb = `http://${ip}/downloads/defData/file_icon.png`;
      }
      hideProgress();
      btn.disabled = false;
      const exists = hasSameFile(file.name);
      const html = `
        <img src="${thumb}" style="width:100px; display:block; margin-bottom:8px">
        <div>${exists
          ? `同名のファイルがあります！上書きしてよろしいですか?<br><strong>${file.name}</strong>`
          : `<strong>${file.name}</strong> をアップロードしますか？`}</div>`;
      const ok = await showConfirmDialog({
        level: exists ? "warn" : "info",
        title: "ファイルアップロードの確認",
        html,
        confirmText: "アップロード",
        cancelText: "キャンセル"
      });
      if (ok) uploadFile(file);
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
    }
  }

  /**
   * ファイル一覧を取得してアップロード成否を確認する
   * @param {string} fname - アップロードしたファイル名
   * @returns {Promise<boolean>} 最新ファイル名が一致すれば true
   */
  async function verifyUploadSuccess(fname) {
    try {
      await sendCommand("get", { reqGcodeFile: 1 }, currentHostname);
    } catch (e) {
      console.warn("verifyUploadSuccess: sendCommand failed", e);
    }
    const first = document.querySelector('#file-list-table tbody tr:first-child td[data-key="filename"]');
    return first?.textContent.trim() === fname;
  }

  /**
   * 指定ファイルをプリンタへアップロードする。
   *
   * XHR を用いて POST 送信し、結果に応じてダイアログ表示を行う。
   *
   * @param {File} file - アップロードするファイル
   * @returns {void}
   */
  function uploadFile(file) {
    btn.disabled = true;
    showProgress();
    updateProgress(0, file.size);

    const ip  = getDeviceIp();
    const url = `http://${ip}/upload/${encodeURIComponent(file.name)}`;
    const form = new FormData();
    form.append("file", file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) updateProgress(e.loaded, e.total);
    };
    xhr.onload = async () => {
      hideProgress();
      btn.disabled = false;
      if (xhr.status === 200) {
        await showConfirmDialog({
          level: "success",
          title: "アップロード完了",
          message: `${file.name} を正常にアップロードしました。`,
          confirmText: "OK"
        });
        currentFile = null;
        input.value = "";
      } else {
        await showConfirmDialog({
          level: "error",
          title: "アップロード失敗",
          message: `エラー: ${xhr.status} ${xhr.statusText}`,
          confirmText: "OK"
        });
      }
    };
    const handleError = async () => {
      hideProgress();
      btn.disabled = false;
      const detail = `status=${xhr.status} readyState=${xhr.readyState}`;
      // -- ファイル一覧を再取得し、最新がアップロードしたファイルなら成功扱い --
      const uploaded = await verifyUploadSuccess(file.name);
      if (uploaded) {
        await showConfirmDialog({
          level: "success",
          title: "アップロード完了",
          message: `${file.name} をアップロードしました (応答なし)`,
          confirmText: "OK"
        });
        currentFile = null;
        input.value = "";
        return;
      }
      await showConfirmDialog({
        level: "error",
        title: "アップロード失敗",
        message: `ネットワークエラー (${detail})`,
        confirmText: "OK"
      });
    };
    xhr.onerror = handleError;
    xhr.onabort = handleError;
    xhr.ontimeout = handleError;
    xhr.send(form);
  }

  input.addEventListener("change", () => {
    if (input.files?.length) prepareAndConfirm(input.files[0]);
  });

  btn.addEventListener("click", () => {
    if (currentFile) {
      uploadFile(currentFile);
    } else if (input.files?.length) {
      prepareAndConfirm(input.files[0]);
    } else {
      alert("まず .gcode ファイルを選択してください");
    }
  });

  document.addEventListener("dragover", e => {
    e.preventDefault();
    showDropLayer();
  });
  document.addEventListener("dragleave", e => {
    if (e.target === document || e.target === dropLayer) {
      hideDropLayer();
    }
  });
  document.addEventListener("drop", e => {
    e.preventDefault();
    hideDropLayer();
    if (e.dataTransfer?.files?.length) {
      prepareAndConfirm(e.dataTransfer.files[0]);
    }
  });

  dropClose.addEventListener("click", hideDropLayer);
}

/** --- 1) タブ切り替えの初期設定 --- */
export function initHistoryTabs(paneIndex = 1) {
  const prefix = `p${paneIndex}-`;
  const btnH = document.getElementById(`${prefix}tab-print-history`);
  const btnF = document.getElementById(`${prefix}tab-file-list`);
  const pH = document.getElementById(`${prefix}panel-print-history-tab`);
  const pF = document.getElementById(`${prefix}panel-file-list`);
  if (!btnH || !btnF) return;
  btnH.addEventListener("click", () => {
    btnH.classList.add("active"); btnF.classList.remove("active");
    pH?.classList.remove("hidden"); pF?.classList.add("hidden");
  });
  btnF.addEventListener("click", () => {
    btnF.classList.add("active"); btnH.classList.remove("active");
    pF?.classList.remove("hidden"); pH?.classList.add("hidden");
  });
}

/**
 * 印刷履歴からファイル単位の統計情報を生成する。
 * 完了済みの履歴のみを対象とし、印刷回数と総使用時間を集計する。
 *
 * @returns {Map<string, {md5: string, count: number, totalSec: number}>}
 *          キー: rawFilename または basename
 */
function buildHistoryStats() {
  const map = new Map();
  const history = loadHistory();
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
export function renderFileList(info, baseUrl) {
  // parseFileInfo で揃えたキー群をもつオブジェクト配列を得る
  pushLog("[renderFileList] マージ処理開始 (保存データなし)", "info");
  const arr = parseFileInfo(info.fileInfo, baseUrl);

  // 最新の一覧をアップロード検証用に保持
  _fileList = arr.slice();

  // 履歴から印刷回数と実使用時間を取得
  const stats = buildHistoryStats();
  arr.forEach(item => {
    const st = stats.get(item.filename);
    if (st) {
      item.filemd5 = st.md5;
      item.printCount = st.count;
      if (st.count > 0) item.usagetime = Math.round(st.totalSec / st.count);
    }
  });

  // 総数表示
  document.getElementById("file-list-total").textContent = info.totalNum;

  const tbody = document.querySelector("#file-list-table tbody");
  tbody.innerHTML = "";

  arr.forEach(item => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <button class="cmd-print">印刷</button>
        <button class="cmd-rename">名前変更</button>
        <button class="cmd-delete">削除</button>
      </td>
      <td data-key="number">${item.number}</td>
      <td data-key="thumb">
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
      <td data-key="mtime">${item.mtime.toLocaleString()}</td>
      <td data-key="expect">${item.expect.toLocaleString()}</td>
      <td data-key="prints">${item.printCount}</td>
      <td data-key="md5">${item.filemd5}</td>
    `;
    tbody.appendChild(tr);

    // 印刷ボタン：raw オブジェクトと thumbUrl を渡す
    tr.querySelector(".cmd-print")?.addEventListener("click", () => {
      handlePrintClick(item, item.thumbUrl);
    });
    // 名前変更／削除：raw.filename（フルパス）や usagetime/usagematerial が item に含まれる
    tr.querySelector(".cmd-rename")?.addEventListener("click", () => {
      handleRenameClick(item);
    });
    tr.querySelector(".cmd-delete")?.addEventListener("click", () => {
      handleDeleteClick(item);
    });
  });

  // --- ソート機能登録 ---
  document.querySelectorAll("#file-list-table th").forEach(th => {
    th.addEventListener("click", () => {
      sortTable("#file-list-table", th.dataset.key);
    });
  });
  pushLog("[renderFileList] UI へ反映しました", "info");
}

/** --- 4) 汎用ソート関数 --- */
function sortTable(selector, key) {
  const table = document.querySelector(selector);
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
}
