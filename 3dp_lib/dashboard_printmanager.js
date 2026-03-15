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
  formatSpoolDisplayId
} from "./dashboard_spool.js";
import { sendCommand, fetchStoredData, getDeviceIp } from "./dashboard_connection.js";
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

// 最新のファイル一覧データ（renderFileList 実行時に更新、per-host）
const _fileListMap = new Map();

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
    // 大サムネイル URL
    const currentUrl = `${baseUrl}/downloads/original/current_print_image.png?${ts}`;
    // フォールバック画像
    const fallback   = `${baseUrl}/downloads/defData/file_print_photo.png`;
    const finishHtml = job.finishTime
      ? `<div class="cp-row"><span class="cp-label">終了:</span> ${fmt(job.finishTime)}</div>` : "";
    const materialVal = job.materialUsedMm != null
      ? job.materialUsedMm.toLocaleString() + " mm" : "—";
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
          <div class="cp-row"><span class="cp-label">使用:</span> ${materialVal}</div>
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
    const umaterial =
      raw.usagematerial != null
        ? (Math.ceil(raw.usagematerial * 100) / 100).toLocaleString()
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

    // フィラメント情報
    const spoolInfos = Array.isArray(raw.filamentInfo)
      ? raw.filamentInfo
      : (raw.filamentId ? [{ spoolId: raw.filamentId }] : []);
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
        const rem = info.expectedRemain ?? sp?.remainingLengthMm ?? 0;
        parts.push(`<div class="spool-line">${text}</div>`);
        parts.push(`<div class="spool-meta">残:${rem} 回:${cnt}</div>`);
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

  // 所要時間（実績があれば実績ベース、なければ機器報告値）
  const estSec = insight?.avgDurationSec > 0 ? insight.avgDurationSec : usedSec;
  const expectedFinish = new Date(Date.now() + estSec * 1000).toLocaleString();

  // --- ダイアログ HTML 構築 ---
  let html = `<div style="display:flex;gap:12px;margin-bottom:8px">`;
  html += `<img src="${thumbUrl}" style="width:80px;height:80px;object-fit:cover;border-radius:4px">`;
  html += `<div><strong style="font-size:1.1em">${filename}</strong></div></div>`;

  // 過去実績セクション
  if (insight && insight.printCount > 0) {
    const avgDur = formatDuration(insight.avgDurationSec);
    const rate = (insight.successRate * 100).toFixed(0);
    const avgFmt = formatFilamentAmount(insight.avgMaterialMm, spool);
    html += `<div style="margin:8px 0;padding:8px;background:#f0f9ff;border-radius:4px">`;
    html += `<div style="font-weight:bold;margin-bottom:4px">過去の実績 (${insight.printCount}回 / 成功率 ${rate}%)</div>`;
    html += `<div>平均所要: ${avgDur}</div>`;
    html += `<div>平均消費: ${avgFmt.display}</div>`;
    if (insight.lastPrintDate) {
      const lastD = formatEpochToDateTime(insight.lastPrintDate);
      const lastR = insight.lastResult === 1 ? "✔ 成功" : "✗ 失敗";
      html += `<div>最終: ${lastD} ${lastR}</div>`;
    }
    html += `</div>`;
  }

  // スプール情報セクション
  if (spool) {
    const spoolLabel = `${formatSpoolDisplayId(spool)} ${spool.name || ""} ${spool.materialName || spool.material || ""}`;
    const remainPct = spool.totalLengthMm > 0
      ? ((remaining / spool.totalLengthMm) * 100).toFixed(0) : "?";
    const afterPct = spool.totalLengthMm > 0
      ? ((afterRemaining / spool.totalLengthMm) * 100).toFixed(0) : "?";

    const bgColor = isShort ? "#fef2f2" : "#f0fdf4";
    html += `<div style="margin:8px 0;padding:8px;background:${bgColor};border-radius:4px">`;
    html += `<div style="font-weight:bold;margin-bottom:4px">スプール: ${spoolLabel}</div>`;
    html += `<div>残量: ${fmtRemain.display} (${remainPct}%)</div>`;
    html += `<div>印刷後予想: ${fmtAfter.display} (${afterPct}%)</div>`;
    if (isShort) {
      html += `<div style="color:#dc2626;font-weight:bold;margin-top:4px">⚠ フィラメントが不足する可能性があります</div>`;
    } else {
      html += `<div style="color:#16a34a;margin-top:4px">✓ 十分な残量があります</div>`;
    }
    html += `</div>`;
  }

  // 予想完了セクション
  const durLabel = insight?.avgDurationSec > 0 ? "実績ベース" : "機器見積";
  html += `<div style="margin:8px 0">`;
  html += `<div>必要量: ${fmtNeed.display}</div>`;
  html += `<div>予想所要: ${formatDuration(estSec)} (${durLabel})</div>`;
  html += `<div>予想完了: ${expectedFinish}</div>`;
  html += `</div>`;

  const ok = await showConfirmDialog({
    level:       isShort ? "warnRed" : "info",
    title:       "印刷実行の確認",
    html,
    confirmText: isShort ? "不足の可能性あり — それでも印刷する" : "印刷する",
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
 * アップロード UI の初期化
 * @param {HTMLElement} [root] - パネル本体要素（省略時は document 全体）
 * @param {string} hostname - ホスト名
 */
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
  async function prepareAndConfirm(file) {
    currentFile = file;
    btn.disabled = true;
    showProgress();
    try {
      const text = await readFile(file);
      updateProgress(file.size, file.size);
      let thumb = extractThumb(text);
      if (!thumb) {
        const ip = getDeviceIp(hostname);
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
      await sendCommand("get", { reqGcodeFile: 1 }, hostname);
    } catch (e) {
      console.warn("verifyUploadSuccess: sendCommand failed", e);
    }
    const ftbl = scopedById("file-list-table", hostname);
    const first = ftbl?.querySelector('tbody tr:first-child td[data-key="filename"]');
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

    const ip  = getDeviceIp(hostname);
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
function buildFileInsight(filename, hostname) {
  const history = loadHistory(hostname);
  const basename = filename.split("/").pop();

  const matching = history.filter(j => {
    const jName = (j.rawFilename || j.filename || "").split("/").pop();
    return jName === basename;
  });
  if (matching.length === 0) return null;

  let totalSec = 0, totalMaterial = 0;
  let successCount = 0, failCount = 0;
  let lastDate = null, lastResult = null;

  for (const j of matching) {
    const start = j.startTime ? Date.parse(j.startTime) : 0;
    const finish = j.finishTime ? Date.parse(j.finishTime) : 0;
    if (finish && start) totalSec += (finish - start) / 1000;
    if (j.materialUsedMm > 0) totalMaterial += j.materialUsedMm;
    if (j.printfinish === 1) successCount++;
    else failCount++;

    const ts = j.finishTime || j.startTime;
    if (ts && (!lastDate || ts > lastDate)) {
      lastDate = ts;
      lastResult = j.printfinish;
    }
  }

  const printCount = matching.length;
  const avgDurationSec = printCount > 0 ? totalSec / printCount : 0;
  const avgMaterialMm = printCount > 0 ? totalMaterial / printCount : 0;

  return {
    printCount,
    successCount,
    failCount,
    successRate: printCount > 0 ? successCount / printCount : 0,
    avgDurationSec,
    avgMaterialMm,
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
      <td data-key="expect">${item.expect.toLocaleString()}</td>
      <td data-key="prints">${item.printCount}</td>
      <td data-key="md5" class="col-md5" title="${item.filemd5 || ''}">${md5short}</td>
    `;
    tbody.appendChild(tr);

    // イベントハンドラ
    tr.querySelector(".cmd-print")?.addEventListener("click", () => {
      handlePrintClick(item, item.thumbUrl);
    });
    tr.querySelector(".cmd-rename")?.addEventListener("click", () => {
      handleRenameClick(item);
    });
    tr.querySelector(".cmd-delete")?.addEventListener("click", () => {
      handleDeleteClick(item);
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
