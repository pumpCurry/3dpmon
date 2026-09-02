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
 * @version 1.390.1641 (PR #441)
* @since   1.390.197 (PR #88)
* @lastModified 2026-09-02 13:38:32
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
  saveUnifiedStorage,
  applyPrintHistoryRetention
} from "./dashboard_storage.js";

import { formatEpochToDateTime, formatDuration, normalizeJobId } from "./dashboard_utils.js";
import { pushLog } from "./dashboard_log_util.js";
import { scheduleAttributionNotice } from "./dashboard_attribution_notify.js";
import { showConfirmDialog, showInputDialog } from "./dashboard_ui_confirm.js";
import { monitorData, scopedById, setStoredDataForHost } from "./dashboard_data.js";
import {
  getCurrentSpool,
  getCurrentSpoolId,
  setCurrentSpoolId,
  useFilament,
  getSpoolById,
  formatFilamentAmount,
  formatRemainingFilamentAmount,
  formatUsageHtml,
  usageHeaderLabel,
  formatSpoolDisplayId,
  buildFilamentRecommendations,
  getAttributionPresentation,
  countAttributionIssuesForHost,
  getAttributionIssueIdsForHost,
  countUnattributedArchiveForHost
} from "./dashboard_spool.js";
import { sendCommand, fetchStoredData, getDeviceIp, getDisplayBaseUrl, getConnectionState, getPrinterType, getConnectionTarget } from "./dashboard_connection.js";
import { recomputeSpoolFromManualEdit } from "./dashboard_filament_ledger.js";
import { showVideoOverlay } from "./dashboard_video_player.js";
import { showSpoolDialog, showSpoolSelectDialog } from "./dashboard_spool_ui.js";
import { showHistoryFilamentDialog, updatePreview as updateFilamentPreview } from "./dashboard_filament_change.js";
import { PRINT_STATE_CODE } from "./dashboard_ui_mapping.js";
import { getCurrentPrintID } from "./dashboard_aggregator.js";
import {
  MATERIAL_DISPLAY_MODE,
  resolveDisplayMaterialTopology,
  resolveMaterialDisplayMode,
  resolveMaterialTopologyViewOptions
} from "./printer_core/dashboard_material_system_settings.js";
import { createMaterialTopologyViewModel } from "./printer_core/dashboard_material_topology_view_model.js";
import { getMaterialCssColor, getMaterialProtocolColor } from "./printer_core/dashboard_material_color.js";
import {
  createK2CfsCommandTransportPlan,
  K2_CFS_PRINT_START_TRANSPORT_PROFILE,
  sendK2CfsCommandTransportPlan
} from "./printer_core/dashboard_k2_cfs_command_transport.js";
import {
  createBoundPrinterCommandDispatcher,
  createPrinterCommandRequest
} from "./printer_core/dashboard_command_authority.js";
import {
  mergeCapabilitySets,
  PRINTER_CAPABILITIES
} from "./printer_core/dashboard_capabilities.js";
import {
  forgetMaterialAccountingPrintStartRequest,
  markMaterialAccountingPrintStartRequestSubmitted,
  rememberMaterialAccountingPrintStartRequest,
} from "./printer_core/dashboard_material_accounting_print_binding_live_bridge.js";
import {
  createMaterialBindingCommandBinding,
  createMaterialBindingPlan,
} from "./printer_core/dashboard_material_binding_plan.js";

/**
 * 現在の使用量表示単位を返す。
 * @returns {"m"|"mm"}
 */
export function getFilamentUnit() {
  return monitorData.appSettings.filamentUnit === "mm" ? "mm" : "m";
}

/**
 * 使用量表示単位(m/mm)を設定し、即時保存して開いている全パネルの
 * ヘッダー・トグルボタン・使用量セルを再描画なしで更新する。
 *
 * @param {"m"|"mm"} unit - 設定する単位
 * @returns {void}
 */
export function setFilamentUnit(unit) {
  const u = unit === "mm" ? "mm" : "m";
  monitorData.appSettings.filamentUnit = u;
  saveUnifiedStorage(true);  // ★ 即時保存
  applyFilamentUnitToUI(u);
}

/**
 * 現在の単位設定を全 UI（ヘッダー・トグルボタン・使用量セル）へ反映する。
 * DOM を直接更新するため再フェッチ不要。
 *
 * @param {"m"|"mm"} [unit] - 適用する単位（省略時は設定値）
 * @returns {void}
 */
export function applyFilamentUnitToUI(unit) {
  const u = unit || getFilamentUnit();

  // 1) ヘッダーラベル（data-unit-base を持つ th）
  document.querySelectorAll("th[data-unit-base]").forEach(th => {
    th.textContent = usageHeaderLabel(th.getAttribute("data-unit-base"), u);
  });

  // 2) トグルボタンのラベル
  document.querySelectorAll(".unit-toggle-btn").forEach(btn => {
    btn.textContent = `単位: ${u}`;
  });

  // 3) 使用量セル（data-mm を持つ .usage-cell）を再計算
  document.querySelectorAll(".usage-cell[data-mm]").forEach(td => {
    const mmStr = td.getAttribute("data-mm");
    if (mmStr === "" || mmStr == null) return;  // "—" 等はそのまま
    const mm = Number(mmStr);
    if (!Number.isFinite(mm)) return;
    const spoolId = td.getAttribute("data-spool") || "";
    const spool = spoolId ? (getSpoolById(spoolId) || null) : null;
    td.innerHTML = formatUsageHtml(mm, spool, u);
  });
}

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

  // ★ setCurrentSpoolId を使い、旧スプール解除 + 新スプール装着を正規ルートで実行
  // （直接 hostSpoolMap を操作すると isActive/hostname/removedAt 等の状態が不整合になる）
  // 旧スプールIDは付け替え前に取得しておく（ログ用。setCurrentSpoolId 後は取得できない）。
  const oldId = getCurrentSpoolId(hostname);
  setCurrentSpoolId(updatedSp.id, hostname);
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
export function _applyFilamentToRaw(raw, sp) {
  // ★ 監査 P0-5: 従来は filamentInfo 配列全体を1件で全置換していたため、
  //   複数リール割当て（A:15m / B:25m 等）のジョブで片方を編集すると
  //   もう一方の割当てと usedMm が消失していた。置換対象（raw.filamentId 一致、
  //   無ければ先頭）のみ差し替え、他リールのエントリと usedMm は保持する。
  const prev = Array.isArray(raw.filamentInfo) ? raw.filamentInfo : [];
  let targetIdx = raw.filamentId != null
    ? prev.findIndex(fi => fi && fi.spoolId === raw.filamentId)
    : -1;
  if (targetIdx < 0 && prev.length > 0) targetIdx = 0;
  const prevUsedMm = targetIdx >= 0 ? prev[targetIdx]?.usedMm : undefined;

  const entry = {
    spoolId: sp.id, serialNo: sp.serialNo,
    spoolName: sp.name, colorName: sp.colorName,
    filamentColor: sp.filamentColor, material: sp.material,
    spoolCount: sp.printCount,
    expectedRemain: sp.remainingLengthMm
  };
  // 置換対象が持っていた実消費量(usedMm)は帰属計算の権威値なので引き継ぐ。
  if (prevUsedMm != null) entry.usedMm = prevUsedMm;

  const next = prev.slice();
  if (targetIdx >= 0) next[targetIdx] = entry; else next.push(entry);
  raw.filamentInfo = next;

  // ★ レビュー指摘(ChatGPT): 単数形 filamentId は「代表リール」を表す後方互換フィールド。
  //   複数リール（distinct spoolId が2つ以上）の履歴で1本を差し替えた際に、編集リールへ
  //   filamentId を無条件で切り替えると代表リールが狂う。distinct が1つのときだけそのIDを
  //   採用し、複数なら null（＝代表なし）にする。色/素材は表示ヒントとして編集リール値を残す。
  const distinct = [...new Set(next.map(fi => fi && fi.spoolId).filter(v => v != null))];
  raw.filamentId = distinct.length === 1 ? distinct[0] : null;
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
 * 手動の履歴フィラメント編集を権威として当該スプール残量を再計算し（総量基準＋再アンカー）、
 * 装着中ホストの残量表示(storedData)も更新する。
 *
 * ADR-0004 のアンカー方式（{@link reconcileSpool}）は装着以降のジョブしか見ないため、
 * インポート済み履歴の編集が残量へ反映されない。手動編集は高信頼データとみなし
 * {@link recomputeSpoolFromManualEdit} で履歴全体から再計算する（ユーザー選択 Option 1）。
 *
 * @private
 * @param {?string} spoolId - 再計算するスプールID（falsy なら何もしない）
 * @param {number} ts - 更新時刻 ms
 * @returns {void}
 */
function _recomputeAndRefreshSpool(spoolId, ts) {
  if (!spoolId) return;
  try {
    recomputeSpoolFromManualEdit(spoolId, { ts });
  } catch (e) {
    console.warn("[printmanager] recomputeSpoolFromManualEdit 失敗:", e?.message || e);
    return;
  }
  const sp = getSpoolById(spoolId);
  if (!sp) return;
  // 装着中ホストの残量表示を更新（dirty マーク → 次の描画サイクルで反映）
  const map = monitorData.hostSpoolMap || {};
  for (const [h, sid] of Object.entries(map)) {
    if (sid === spoolId) {
      setStoredDataForHost(h, "filamentRemainingMm", sp.remainingLengthMm, true);
    }
  }
}

/**
 * 印刷ライフサイクル計測値（観測フラグ＋区間時間）を、保存済み履歴エントリへ付与する。
 *
 * 完了確定時(processData の →printDone 遷移)に呼ばれ、進捗100%時に登録済みのエントリを
 * printId(=id) で引いて observed / postProcessingTime（／Moonraker は warmup→preparationTime,
 * paused→pauseTime）を書き込む。機器申告値(K1 の preparationTime/pauseTime)が既に
 * あれば実測値で上書きしない。device 再取得時のマージ(updateHistoryList)は incoming が
 * これらを持たない＝null のため backfill で保持される。
 *
 * @function applyLifecycleMetrics
 * @param {string} host - ホスト名
 * @param {number|string} jobId - printId（= start_time epoch）
 * @param {{observed?:string, postProcessingTime?:?number, warmupSec?:?number, pausedSec?:?number}} metrics
 * @returns {void}
 */
export function applyLifecycleMetrics(host, jobId, metrics) {
  if (!host || jobId == null || !metrics) return;
  const jobs = loadHistory(host);
  const job = jobs.find(j => String(j.id) === String(jobId));
  if (!job) return; // 進捗100%登録前のレア競合（K1-Max即完了等）。後処理≈0で実害小。
  let changed = false;
  if (metrics.observed != null && job.observed !== metrics.observed) {
    job.observed = metrics.observed; changed = true;
  }
  if (metrics.postProcessingTime != null && job.postProcessingTime == null) {
    job.postProcessingTime = metrics.postProcessingTime; changed = true;
  }
  if (metrics.warmupSec != null && (job.preparationTime == null || Number(job.preparationTime) === 0)) {
    job.preparationTime = metrics.warmupSec; changed = true;
  }
  if (metrics.pausedSec != null && (job.pauseTime == null || Number(job.pauseTime) === 0)) {
    job.pauseTime = metrics.pausedSec; changed = true;
  }
  if (!changed) return;
  saveHistory(jobs, host);
  try {
    const baseUrl = getDisplayBaseUrl(host);
    renderHistoryTable(jobsToRaw(loadHistory(host)), baseUrl, host);
  } catch { /* 描画失敗は無視（保存は済んでいる） */ }
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

/**
 * source別materialUsed CSV候補をlossless保存用に正規化する。
 *
 * 【詳細説明】
 * - K2/CFSはtotal使用量とは別に `materialUsed:"3210,6543"` のようなsource順CSVを返す。
 * - 空文字や未観測値はnullにし、runtimeが「未観測」と「0mm」を混同しないようにする。
 *
 * @private
 * @function normalizeMaterialUsedSourceCsv
 * @param {*} value - materialUsed CSV候補
 * @returns {string|null} 正規化済みCSV、またはnull
 */
function normalizeMaterialUsedSourceCsv(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  return text ? text : null;
}

// 最後に保存した JSON 文字列のキャッシュ（差分チェック用、per-host）
const _lastSavedJsonMap = new Map();

/** ドキュメント全体のドロップハンドラが登録済みか */
let _dropHandlerInstalled = false;
/** アップロード確認ダイアログでの選択済みホスト（confirmボタン押下時にキャプチャ） */
let _lastSelectedUploadHosts = [];

/**
 * D&D ドロップ時に呼ぶファイル処理関数（モジュールレベル参照）。
 * 各 setupUploadUI 呼び出しで最新の prepareAndConfirm に更新される。
 * ★ かつてはドキュメント drop ハンドラが「最初に初期化されたパネルの
 *   クロージャ」を永続キャプチャしており、2番目以降のパネルにドロップしても
 *   最初のホストの UI・hostname で処理されるコンタミネーション欠陥があった。
 *   この参照を介すことで「どのパネルから登録されても等価な host 非依存処理」を呼ぶ。
 * @type {((file: File) => void)|null}
 */
let _dropFileHandler = null;

/**
 * ホスト別アップロード UI レジストリ。
 * 各パネルの進捗バー/ボタン要素を hostname キーで保持し、
 * アップロード進捗を「対象ホスト自身のパネル」へ表示するために使う。
 * これにより全機器が自分のパネルに進捗を表示し、特定パネルへの固定を排除する。
 * @type {Map<string, {btn: HTMLElement|null, progress: HTMLElement|null, percentEl: HTMLElement|null}>}
 */
const _uploadPanelRegistry = new Map();

/** 指定ホストのアップロード UI 参照を取得（無ければ null） */
function _hostUploadUI(host) {
  return _uploadPanelRegistry.get(host) || null;
}

/** 指定ホストのパネル進捗バーを表示する */
function _showHostProgress(host) {
  const ui = _hostUploadUI(host);
  if (ui?.progress) ui.progress.classList.remove("hidden");
}

/** 指定ホストのパネル進捗を更新する */
function _updateHostProgress(host, loaded, total) {
  const ui = _hostUploadUI(host);
  if (!ui?.percentEl) return;
  if (!total) { ui.percentEl.textContent = "0%"; return; }
  const pct = Math.floor((loaded / total) * 100);
  const remainMb = ((total - loaded) / (1024 * 1024)).toFixed(1);
  ui.percentEl.textContent = `${pct}% (残り ${remainMb}MB)`;
}

/** 指定ホストのパネル進捗バーを隠す */
function _hideHostProgress(host) {
  const ui = _hostUploadUI(host);
  if (ui?.progress) { ui.progress.classList.add("hidden"); _updateHostProgress(host, 0, 0); }
}

/** 指定ホストのアップロードボタン有効/無効を設定する */
function _setHostBtnDisabled(host, disabled) {
  const ui = _hostUploadUI(host);
  if (ui?.btn) ui.btn.disabled = disabled;
}

/** 複数ホストへ一括で進捗表示/非表示/ボタン制御 */
function _showProgressForHosts(hosts)  { for (const h of hosts) _showHostProgress(h); }
function _hideProgressForHosts(hosts)  { for (const h of hosts) _hideHostProgress(h); }
function _setBtnDisabledForHosts(hosts, d) { for (const h of hosts) _setHostBtnDisabled(h, d); }

/**
 * ファイル一覧パネル破棄時に呼び、アップロード UI レジストリから解除する。
 * 破棄済みパネルの detached DOM 参照が残らないようにする。
 *
 * @param {string} hostname - 解除するホスト名
 * @returns {void}
 */
export function unregisterUploadPanel(hostname) {
  if (hostname) _uploadPanelRegistry.delete(hostname);
}

/**
 * 現在アップロード UI レジストリに登録済みのホスト名一覧を返す。
 * （主にテスト・診断用。per-host 登録の検証に使う）
 *
 * @returns {string[]} 登録済みホスト名の配列
 */
export function getRegisteredUploadHosts() {
  return Array.from(_uploadPanelRegistry.keys());
}


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

/**
 * gcode メタデータを「アップロード先の全ホスト」のキャッシュへ登録する純関数。
 *
 * マルチホストアップロード時、平均時間(印刷予定秒数)が1番目の機器にしか
 * 登録されないコンタミネーションバグを防ぐため、targets 全件へ
 * `${host}:${filename}` キーで書き込む。
 *
 * @param {Map<string, object>} cache    - 書き込み先キャッシュ Map
 * @param {string[]} targets             - アップロード先ホスト名の配列
 * @param {string} filename              - ファイル名(basename)
 * @param {object} meta                  - gcode メタデータ
 * @returns {number} 書き込んだホスト数
 */
export function registerGcodeMetaForHosts(cache, targets, filename, meta) {
  if (!cache || !Array.isArray(targets) || !filename) return 0;
  if (!meta || Object.keys(meta).length === 0) return 0;
  let count = 0;
  for (const h of targets) {
    if (!h) continue;
    cache.set(`${h}:${filename}`, meta);
    count++;
  }
  return count;
}

/**
 * 指定ホストの保存済み印刷履歴（printStore.history）からテーブルを再描画する。
 *
 * リレー子（satellite/readonly）が親から履歴 delta を受信した後の再描画に使う。
 * 通常モードの initHistoryPanel と同じ経路（loadHistory→jobsToRaw→renderHistoryTable）。
 * パネル未生成・対象DOM不在でも安全（try/catch で吸収）。
 *
 * @param {string} hostname - ホスト名
 * @returns {void}
 */
export function rerenderHistoryForHost(hostname) {
  try {
    const jobs = loadHistory(hostname);
    if (!jobs.length) return;
    const baseUrl = getDisplayBaseUrl(hostname);
    renderHistoryTable(jobsToRaw(jobs), baseUrl, hostname);
  } catch (e) {
    console.warn("[printmanager] rerenderHistoryForHost エラー:", e);
  }
}

/**
 * 指定ホストのキャッシュ済みファイル一覧（_cachedFileInfo）を再描画する。
 *
 * リレー子が親からファイル一覧 delta を受信した後の再描画に使う。
 * 通常モードの initFileListPanel と同じ経路（renderFileList）。
 *
 * @param {string} hostname - ホスト名
 * @returns {void}
 */
export function rerenderFileListForHost(hostname) {
  try {
    const machine = monitorData.machines[hostname];
    if (!machine?._cachedFileInfo) return;
    const baseUrl = getDisplayBaseUrl(hostname);
    renderFileList(machine._cachedFileInfo, baseUrl, hostname);
  } catch (e) {
    console.warn("[printmanager] rerenderFileListForHost エラー:", e);
  }
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
 * サムネイル不在時のローカル代替画像（data-URI の SVG）。
 * 機器側の固定パス(downloads/defData/...)は K1 にしか存在せず、Moonraker 機では
 * 404 になり、再描画のたびに同じ URL を取りに行って大量リトライ(スロットル)を招いていた。
 * ネットワークを使わない data-URI を最終フォールバックにすることで 404 嵐を根絶する。
 * @constant {string}
 */
const THUMB_PLACEHOLDER = "data:image/svg+xml;utf8," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">' +
  '<rect width="48" height="48" rx="4" fill="#e2e8f0"/>' +
  '<path d="M12 32l8-9 5 6 4-4 7 7z" fill="#94a3b8"/>' +
  '<circle cx="18" cy="17" r="3" fill="#94a3b8"/>' +
  '</svg>'
);

/**
 * 確認ダイアログ用のHTML文字列へ埋め込む値をエスケープする。
 *
 * 【詳細説明】
 * - 印刷履歴ファイル名、G-codeメタ、CFS material名はいずれもプリンタまたはG-code由来である。
 * - `showConfirmDialog()` の `html` へ連結する前に特殊文字を無害化し、意図しないタグ解釈を防ぐ。
 *
 * @private
 * @param {*} value - 表示候補値
 * @returns {string} HTML特殊文字をエスケープした文字列
 */
function escapePrintDialogHtml(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

/**
 * 文字列がブラウザでそのまま描画できるURLか判定する。
 *
 * 【詳細説明】
 * - K2の `retGcodeFileInfo2.thumbnail` は `/mnt/UDISK/...` のプリンタ内パスを返す。
 * - その値を `<img src>` へ直接渡すとローカルファイルパス扱いになり、ファイル一覧だけ
 *   プレースホルダになるため、HTTP/data/blob URLだけを「そのまま使える」値として扱う。
 *
 * @private
 * @param {*} value - URL候補
 * @returns {boolean} ブラウザでそのまま利用できるURLなら true
 */
function isRenderableThumbUrl(value) {
  return /^(https?:|data:|blob:)/iu.test(String(value || "").trim());
}

/**
 * プリンタ内サムネイルパスから画像ファイル名だけを取り出す。
 *
 * 【詳細説明】
 * - K2は `thumbnail:"/mnt/UDISK/creality/local_gcode/humbnail/foo.png"` のように
 *   printer-local absolute pathを返すが、実際に画像として取得できる既存UI互換のURLは
 *   `http://host/downloads/humbnail/foo.png` である。
 * - `preview/original` しか無い場合も最後のファイル名を使えるよう、パス種別に依存せず末尾名だけ返す。
 *
 * @private
 * @param {*} value - raw thumbnail/preview path
 * @returns {string} ファイル名、または空文字
 */
function extractThumbBasename(value) {
  return String(value || "").trim().split(/[\\/]/u).pop() || "";
}

/**
 * K2/K1のサムネイル候補を既存downloads/humbnail URLへ正規化する。
 *
 * 【詳細説明】
 * - K1互換の履歴サムネは従来どおり `downloads/humbnail/{gcodeBase}.png` を使う。
 * - K2のファイル一覧は `retGcodeFileInfo2.thumbnail` がプリンタ内絶対パスで届くため、
 *   そのbasenameを `downloads/humbnail/` に載せ替える。
 * - 既にHTTP/data/blob URLなら変換せず、Moonraker等の外部メタ由来URLを壊さない。
 *
 * @private
 * @param {string} baseUrl - 表示用ベースURL
 * @param {string} filename - G-codeファイル名またはフルパス
 * @param {string=} explicit - プリンタ/メタ由来のサムネイル候補
 * @returns {string} 表示に使うサムネイルURL
 */
function normalizeThumbUrl(baseUrl, filename, explicit = "") {
  const raw = String(explicit || "").trim();
  if (isRenderableThumbUrl(raw)) {
    return raw;
  }
  if (raw.startsWith("/downloads/")) {
    return `${baseUrl}${raw}`;
  }
  const rawBase = extractThumbBasename(raw);
  if (rawBase && /\.(png|jpe?g|webp|gif)$/iu.test(rawBase)) {
    return `${baseUrl}/downloads/humbnail/${rawBase}`;
  }
  return makeThumbUrl(baseUrl, filename) || THUMB_PLACEHOLDER;
}

/**
 * ホスト種別に応じてサムネイル URL を解決する。
 *
 * 【詳細説明】
 * - 明示 URL（Moonraker メタ由来など）があれば最優先。
 * - Moonraker 機: gcode のサムネはメタの相対パス由来で、ファイル名から K1 規則で
 *   組み立てられない。ファイル一覧キャッシュ(machine._cachedFileInfo)から同名ファイルの
 *   thumbUrl を引く。見つからなければローカル代替({@link THUMB_PLACEHOLDER})を返し、
 *   存在しない機器パスを叩き続けない（K1 規則の humbnail/defData は使わない）。
 * - K1 機: 従来どおり {@link makeThumbUrl}（downloads/humbnail/…）。
 *
 * @param {string} host - ホスト名
 * @param {string} filename - ファイル名（パス可）
 * @param {string} [explicit] - 既知のサムネ URL（あれば最優先）
 * @returns {string} 表示に使える URL（不明時は data-URI 代替）
 */
function resolveThumbUrl(host, filename, explicit) {
  const baseUrl = getDisplayBaseUrl(host);
  const printerType = getPrinterType(host);
  if (explicit && printerType === "moonraker") {
    return explicit;
  }
  if (explicit) return normalizeThumbUrl(baseUrl, filename, explicit);
  if (printerType === "moonraker") {
    const m = monitorData.machines[host];
    const bn = String(filename || "").split("/").pop();
    const entries = m?._cachedFileInfo?.entries || [];
    const hit = entries.find(e => String(e.filename || "").split("/").pop() === bn);
    return hit?.thumbUrl || THUMB_PLACEHOLDER;
  }
  return normalizeThumbUrl(baseUrl, filename);
}

/**
 * MaterialTopologyの表示行から人間向けの材料ラベルを作る。
 *
 * 【詳細説明】
 * - CFS/CFS-Cの印刷確認では、3DPmon台帳の単一スプールではなく、実機から観測したslotを表示する。
 * - material名が欠落するfirmwareでも、slot名だけは必ず残して「未装着」と誤表示しない。
 *
 * @private
 * @param {object|null|undefined} row - material topology view model のsource row
 * @returns {string} 例: "1C Silver PLA (PLA)"
 */
function formatMaterialSourceRowLabel(row) {
  if (!row) {
    return "";
  }
  const material = row.material || {};
  const parts = [row.displaySlot || ""];
  const name = String(material.name || "").trim();
  const type = String(material.type || "").trim();
  if (name) {
    parts.push(name);
  }
  if (type && type !== name) {
    parts.push(`(${type})`);
  }
  return parts.filter(Boolean).join(" ");
}

/**
 * 任意値を空でない文字列へ正規化する。
 *
 * 【詳細説明】
 * - K2/CFS print-start では path、tool alias、sourceId が空のまま送信されると
 *   `colorMatch` が意味を失うため、UI境界で空文字を null に寄せる。
 *
 * @private
 * @param {*} value - 文字列候補
 * @returns {string|null} 空でない文字列、または null
 */
function toPrintManagerNonEmptyString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

/**
 * プロトコル色値を `colorMatch` へ渡せる文字列へ正規化する。
 *
 * 【詳細説明】
 * - K2の `boxsInfo` は `#0ffffff` のような7桁HEXを返すことがある。
 * - Printer Core側の正規化済み `normalized/displayHex` があればそれを優先し、
 *   無ければ raw から `#` だけを除いて送信用証拠にする。
 *
 * @private
 * @param {*} color - material color 候補
 * @returns {string|null} `colorMatch.list[].color` に載せる色文字列
 */
function normalizeK2CfsProtocolColor(color) {
  return getMaterialProtocolColor(color);
}

/**
 * セミコロン/カンマ区切りのG-code材料メタ値を配列へ分解する。
 *
 * 【詳細説明】
 * - K2 `retGcodeFileInfo2` は `material` や `materialColors` を `;` 区切りで返す。
 * - 古いキャッシュや別firmwareに備え、`,` 区切りも読み取れるようにする。
 *
 * @private
 * @param {*} value - 区切り文字列
 * @returns {string[]} 空要素を除いた文字列配列
 */
function splitK2CfsMaterialList(value) {
  return String(value || "")
    .split(/[;,]/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * K2 file entry の `match` 文字列を tool alias 対応へ変換する。
 *
 * 【詳細説明】
 * - `T1A=T1B` は「G-code側T1Aを現在のCreality割当T1Bへ寄せる」観測値として扱う。
 * - 送信時は右辺aliasから直接slotを推測せず、同じaliasを持つ観測済みCFS sourceを既定選択に使う。
 *
 * @private
 * @param {*} matchText - K2 `retGcodeFileInfo2.match`
 * @returns {Map<string,string>} 左辺tool alias -> 右辺alias
 */
function parseK2CfsMatchMap(matchText) {
  const map = new Map();
  for (const part of String(matchText || "").split(/\s+/u)) {
    const [left, right] = part.split("=").map((value) => toPrintManagerNonEmptyString(value));
    if (left && right) {
      map.set(left, right);
    }
  }
  return map;
}

/**
 * K2 G-codeファイルから印刷に必要な logical tool alias 一覧を推定する。
 *
 * 【詳細説明】
 * - `match` の左辺が最も具体的なので優先する。
 * - `material` / `materialColors` からtool数だけが分かる場合は `T1A` から順に補完する。
 * - 何も分からない単色ファイルは `T1A` だけを要求する。
 *
 * @private
 * @param {object} raw - ファイル一覧または履歴の行データ
 * @returns {string[]} logical tool alias一覧
 */
function deriveK2CfsToolAliases(raw) {
  const matchMap = parseK2CfsMatchMap(raw?.match || raw?.raw?.match);
  const fromMatch = [...matchMap.keys()];
  if (fromMatch.length > 0) {
    return fromMatch;
  }
  const materialCount = Math.max(
    splitK2CfsMaterialList(raw?.material || raw?.raw?.material).length,
    splitK2CfsMaterialList(raw?.materialColors || raw?.raw?.materialColors).length,
    1
  );
  return Array.from({ length: materialCount }, (_, index) => `T1${String.fromCharCode(65 + index)}`);
}

/**
 * CFS slot row の表示色を取得する。
 *
 * 【詳細説明】
 * - UIのスウォッチ表示だけに使い、送信payloadは別途 `normalizeK2CfsProtocolColor()` で正規化する。
 *
 * @private
 * @param {object|null|undefined} row - CFS source row
 * @returns {string|null} CSS color 候補
 */
function getK2CfsRowCssColor(row) {
  return getMaterialCssColor(row?.material?.color);
}

/**
 * source row に紐付いた Creality assignment alias を取得する。
 *
 * 【詳細説明】
 * - `boxsInfo.colorMatch[]` から正規化された assignmentId は、現在そのslotへ割り当てられている
 *   `T1A` などのprotocol aliasとしてUI既定選択に使える。
 *
 * @private
 * @param {object|null|undefined} row - CFS source row
 * @returns {string[]} assignment alias一覧
 */
function getK2CfsRowAssignmentAliases(row) {
  return (Array.isArray(row?.assignments) ? row.assignments : [])
    .map((assignment) => toPrintManagerNonEmptyString(assignment?.assignmentId))
    .filter(Boolean);
}

/**
 * K2/CFS印刷確認で選択できるCFS slot候補を抽出する。
 *
 * 【詳細説明】
 * - 外部スプールはCFS印刷開始transportでは扱わないため、ここではCFS slotだけを返す。
 * - 未装填slotは選択候補から除外し、空走りにつながる割当をUI段階で防ぐ。
 *
 * @private
 * @param {object} materialContext - {@link createMaterialPrintContext} の戻り値
 * @returns {object[]} 装填済みCFS source row一覧
 */
function getLoadedK2CfsRows(materialContext) {
  return (Array.isArray(materialContext?.loadedRows) ? materialContext.loadedRows : [])
    .filter((row) => row?.kind === "cfs-slot" && row?.presence === "loaded" && row?.sourceId);
}

/**
 * K2/CFS tool alias に対する既定sourceIdを決定する。
 *
 * 【詳細説明】
 * - file entry の `match` 右辺が現在のCFS assignmentに一致する場合はそのslotを既定にする。
 * - 一致しない場合は実機でselectedのslot、それも無ければ最初の装填済みslotに倒す。
 * - 倒し先はUI表示の既定値であり、ユーザーは確認画面で変更できる。
 *
 * @private
 * @param {string} toolAlias - logical tool alias
 * @param {object[]} cfsRows - 装填済みCFS row一覧
 * @param {Map<string,string>} matchMap - raw.match 由来の割当map
 * @returns {string} 既定sourceId
 */
function resolveDefaultK2CfsSourceId(toolAlias, cfsRows, matchMap) {
  const matchedAlias = matchMap.get(toolAlias);
  if (matchedAlias) {
    const matchedRow = cfsRows.find((row) => getK2CfsRowAssignmentAliases(row).includes(matchedAlias));
    if (matchedRow?.sourceId) {
      return matchedRow.sourceId;
    }
  }
  const selectedRow = cfsRows.find((row) => row.selected === true);
  return selectedRow?.sourceId || cfsRows[0]?.sourceId || "";
}

/**
 * K2/CFS印刷確認ダイアログ用のslot選択UIを構築する。
 *
 * 【詳細説明】
 * - logical tool aliasごとにCFS sourceを選ぶselectを出す。
 * - CrealityPrint同様に「T1Aなどのファイル側材料」と「1Aなどの物理slot」を明確に分ける。
 *
 * @private
 * @param {object} raw - ファイル一覧または履歴の行データ
 * @param {object} materialContext - CFS材料文脈
 * @returns {{html:string, selectIds:string[], toolAliases:string[], rows:object[], defaults:Map<string,string>, disabledReason:string|null}} UI構築結果
 */
function createK2CfsPrintAssignmentDialogModel(raw, materialContext) {
  const rows = getLoadedK2CfsRows(materialContext);
  const toolAliases = deriveK2CfsToolAliases(raw);
  const matchMap = parseK2CfsMatchMap(raw?.match || raw?.raw?.match);
  if (materialContext?.stale) {
    return {
      html: `<div class="pm-print-section pm-print-danger-section"><div class="pm-print-section-title">CFS割当不可</div><div>CFS情報が最終観測値のため、印刷開始前に最新状態を取得してください。</div></div>`,
      selectIds: [],
      toolAliases,
      rows,
      defaults: new Map(),
      disabledReason: "cfs-topology-stale",
    };
  }
  if (rows.length === 0) {
    return {
      html: `<div class="pm-print-section pm-print-danger-section"><div class="pm-print-section-title">CFS割当不可</div><div>装填済みCFSスロットが観測できないため、CFS印刷を開始できません。</div></div>`,
      selectIds: [],
      toolAliases,
      rows,
      defaults: new Map(),
      disabledReason: "cfs-loaded-source-missing",
    };
  }
  const selectIds = [];
  const defaults = new Map();
  let html = `<div class="pm-print-section pm-print-info-section pm-cfs-print-assignment">`;
  html += `<div class="pm-print-section-title">CFSスロット割当</div>`;
  html += `<div class="pm-cfs-print-assignment-note">ファイル側の材料(T1Aなど)ごとに、使用するCFS物理スロットを指定します。</div>`;
  html += `<div class="pm-cfs-print-assignment-list">`;
  toolAliases.forEach((toolAlias, index) => {
    const selectId = `pm-cfs-print-source-${Date.now()}-${index}`;
    const materialTypes = splitK2CfsMaterialList(raw?.material || raw?.raw?.material);
    const materialColors = splitK2CfsMaterialList(raw?.materialColors || raw?.raw?.materialColors);
    const expectedType = materialTypes[index] || materialTypes[0] || "";
    const expectedColor = materialColors[index] || materialColors[0] || "";
    const defaultSourceId = resolveDefaultK2CfsSourceId(toolAlias, rows, matchMap);
    selectIds.push(selectId);
    defaults.set(toolAlias, defaultSourceId);
    html += `<label class="pm-cfs-print-assignment-row" for="${selectId}">`;
    html += `<span class="pm-cfs-print-tool">${escapePrintDialogHtml(toolAlias)}</span>`;
    html += `<span class="pm-cfs-print-material">${escapePrintDialogHtml([expectedType, expectedColor].filter(Boolean).join(" / ") || "材料")}</span>`;
    html += `<select id="${selectId}" class="pm-cfs-print-source-select" data-tool-alias="${escapePrintDialogHtml(toolAlias)}">`;
    for (const row of rows) {
      const label = formatMaterialSourceRowLabel(row);
      const selected = row.sourceId === defaultSourceId ? " selected" : "";
      html += `<option value="${escapePrintDialogHtml(row.sourceId)}"${selected}>${escapePrintDialogHtml(label)}</option>`;
    }
    html += `</select>`;
    html += `</label>`;
  });
  html += `</div>`;
  html += `<div class="pm-cfs-print-source-grid">`;
  for (const row of rows) {
    const color = getK2CfsRowCssColor(row);
    const swatch = color ? `<span class="pm-cfs-print-swatch" style="background:${color}"></span>` : `<span class="pm-cfs-print-swatch pm-cfs-print-swatch-empty"></span>`;
    html += `<div class="pm-cfs-print-source-chip">${swatch}<strong>${escapePrintDialogHtml(row.displaySlot || "")}</strong><span>${escapePrintDialogHtml(formatMaterialSourceRowLabel(row))}</span></div>`;
  }
  html += `</div>`;
  html += `<div class="pm-cfs-print-assignment-note">CFS印刷では旧opGcodeFile直投げを使わず、colorMatchを送ってからmultiColorPrintを開始します。</div>`;
  html += `</div>`;
  return {
    html,
    selectIds,
    toolAliases,
    rows,
    defaults,
    disabledReason: null,
  };
}

/**
 * ダイアログDOMからK2/CFS source選択を読み取る。
 *
 * 【詳細説明】
 * - `showConfirmDialog()` は resolve 後すぐにはDOMを破棄しないため、await直後にselect値を取得できる。
 * - selectが見つからない場合はdialog modelの既定値へ倒すが、sourceIdが候補に存在しない場合は拒否する。
 *
 * @private
 * @param {object} dialogModel - {@link createK2CfsPrintAssignmentDialogModel} の戻り値
 * @returns {Array<{toolAlias:string, sourceId:string}>} ユーザーが確定した割当
 */
function readK2CfsPrintAssignmentsFromDialog(dialogModel) {
  const rowIds = new Set(dialogModel.rows.map((row) => row.sourceId));
  return dialogModel.toolAliases.map((toolAlias, index) => {
    const selectId = dialogModel.selectIds[index];
    const selectedValue = toPrintManagerNonEmptyString(document.getElementById(selectId)?.value);
    const fallbackValue = dialogModel.defaults.get(toolAlias) || "";
    const sourceId = selectedValue || fallbackValue;
    if (!rowIds.has(sourceId)) {
      throw new Error(`invalid-cfs-print-source:${toolAlias}`);
    }
    return { toolAlias, sourceId };
  });
}

/**
 * sourceIdからCFS表示rowを検索する。
 *
 * 【詳細説明】
 * - 送信payloadには、選択されたsourceIdのtype/color/boxId/materialId証拠を同じUI snapshotから載せる。
 *
 * @private
 * @param {object[]} rows - CFS source row一覧
 * @param {string} sourceId - material source ID
 * @returns {object|null} 対応row
 */
function findK2CfsRowBySourceId(rows, sourceId) {
  return (Array.isArray(rows) ? rows : []).find((row) => row?.sourceId === sourceId) || null;
}

/**
 * K2/CFS print-start対象ファイルのprinter-local pathを正規化する。
 *
 * 【詳細説明】
 * - `printprt:` prefixはtransport直前で使う旧API表現なので、command authorityのfile identityでは
 *   プリンタ内pathそのものへ寄せる。
 * - 空pathはsend-time validation以前に危険な推測へ落ちないようnullにする。
 *
 * @private
 * @param {*} value - raw filename候補
 * @returns {string|null} 正規化済みpath
 */
function normalizeK2CfsPrintFilePath(value) {
  const path = toPrintManagerNonEmptyString(value);
  if (!path) {
    return null;
  }
  return path.startsWith("printprt:") ? path.slice("printprt:".length) : path;
}

/**
 * K2 file rowから送信時照合用のfile identity hashを作る。
 *
 * 【詳細説明】
 * - `filemd5` がある場合はプリンタ報告値として最優先する。
 * - K2 file listではMD5が欠落する場合があるため、size/createTime/sourceProtocolから作る
 *   一覧観測fingerprintを次善のfile identityとして使う。
 * - この値はsend-timeに現在キャッシュから再計算し、一致しなければdispatcherで拒否する。
 *
 * @private
 * @param {object|null|undefined} row - file list / history row
 * @returns {string|null} file identity hash相当値
 */
function deriveK2CfsFileIdentityHash(row) {
  const md5 = toPrintManagerNonEmptyString(row?.filemd5 || row?.raw?.filemd5);
  if (md5) {
    return md5;
  }
  const size = Number(row?.size ?? row?.file_size ?? row?.raw?.file_size ?? row?.raw?.size);
  const createTimeValue = row?.create_time ?? row?.ctime ?? row?.mtime ?? row?.raw?.create_time ?? row?.raw?.ctime ?? row?.raw?.mtime;
  const createTime = createTimeValue instanceof Date
    ? Math.floor(createTimeValue.getTime() / 1000)
    : Number(createTimeValue);
  const sourceProtocol = toPrintManagerNonEmptyString(row?.sourceProtocol || row?.raw?.sourceProtocol) || "unknown";
  if (Number.isFinite(size) && size > 0 && Number.isFinite(createTime) && createTime > 0) {
    return `k2-file-list:${sourceProtocol}:${Math.floor(size)}:${Math.floor(createTime)}`;
  }
  return null;
}

/**
 * K2/CFS print-start用のupload generation相当IDを作る。
 *
 * 【詳細説明】
 * - 既存remote file開始ではupload receiptが存在しないため、現在のfile identity snapshotにbindした
 *   generation IDを使う。
 * - dispatcherは送信直前に同じpath/hashを現在キャッシュから再計算して一致を要求する。
 *
 * @private
 * @param {string} path - printer-local gcode path
 * @param {string} fileHash - file identity hash
 * @returns {string} upload generation相当ID
 */
function createK2CfsExistingFileGeneration(path, fileHash) {
  return `k2-existing-file:${encodeURIComponent(path)}:${encodeURIComponent(fileHash)}`;
}

/**
 * 現在キャッシュされているK2 file rowをpathで検索する。
 *
 * 【詳細説明】
 * - UIのraw行だけを信用せず、send-time snapshotでは接続層が最後に受けたfile list cacheを見直す。
 * - basename一致だけでは別ディレクトリの同名fileと衝突するため、まずprinter-local path完全一致を要求する。
 *
 * @private
 * @param {string} hostname - 対象ホスト名
 * @param {string} path - printer-local gcode path
 * @returns {object|null} 現在キャッシュ上のfile row
 */
function findCurrentK2CfsFileRow(hostname, path) {
  const machine = monitorData.machines?.[hostname] || null;
  const targetPath = normalizeK2CfsPrintFilePath(path);
  if (!machine || !targetPath) {
    return null;
  }
  const entries = Array.isArray(machine._cachedFileInfo?.entries)
    ? machine._cachedFileInfo.entries
    : [];
  return entries.find((entry) => normalizeK2CfsPrintFilePath(entry?.rawFilename ?? entry?.filename ?? entry?.path) === targetPath) || null;
}

/**
 * K2/CFS print-start request用のfile identityを作る。
 *
 * 【詳細説明】
 * - request作成時とsend-time context作成時の両方で同じ関数を使い、path/hash/generationの意味を揃える。
 *
 * @private
 * @param {object|null|undefined} row - file list / history row
 * @returns {{path:string,fileHash:string,uploadGeneration:string}} file identity
 * @throws {Error} pathまたはidentity hashを作れない場合
 */
function createK2CfsPrintFileIdentity(row) {
  const path = normalizeK2CfsPrintFilePath(row?.rawFilename ?? row?.filename ?? row?.path ?? row?.raw?.path);
  const fileHash = deriveK2CfsFileIdentityHash(row);
  if (!path) {
    throw new Error("missing-k2-cfs-gcode-path");
  }
  if (!fileHash) {
    throw new Error("missing-k2-cfs-file-identity");
  }
  return {
    path,
    fileHash,
    uploadGeneration: createK2CfsExistingFileGeneration(path, fileHash),
  };
}

/**
 * K2/CFS print-startのsend-time material topologyを作る。
 *
 * 【詳細説明】
 * - runtime上のlastStateを直接信用せず、表示用と同じTTL freshness判定を通したtopologyを使う。
 * - MaterialSourceの `presence` はNormalizedState rawではなくview modelで導出済みの値を渡し、
 *   実機の `status.stateCode` 由来slotが送信直前に未装填扱いへ化けないようにする。
 *
 * @private
 * @param {string} hostname - 対象ホスト名
 * @param {object|null|undefined} shadowRecord - runtimeData.printerCoreV3Shadow record
 * @returns {{cfsConnected:boolean,topologyState:string,sourceCount:number|null,sources:Array<object>}} send-time material topology
 */
function createK2CfsPrintSendTimeMaterialTopology(hostname, shadowRecord) {
  const rawTopology = shadowRecord?.lastState?.materials || null;
  const displayTopology = resolveDisplayMaterialTopology({
    topology: rawTopology,
    shadowRecord,
  });
  if (!displayTopology) {
    return {
      cfsConnected: false,
      topologyState: "unobserved",
      sourceCount: null,
      sources: [],
    };
  }
  const target = getConnectionTarget(hostname);
  const printerType = getPrinterType(hostname);
  const viewOptions = resolveMaterialTopologyViewOptions({ target, printerType, topology: displayTopology });
  const viewModel = createMaterialTopologyViewModel(displayTopology, viewOptions);
  const cfsRows = viewModel.units.flatMap((unit) => unit.slots || []);
  const sources = cfsRows
    .filter((row) => row?.sourceId)
    .map((row) => ({
      sourceId: row.sourceId,
      kind: row.kind,
      boxId: row.boxId,
      slotId: row.protocolSlotId,
      presence: row.presence,
      material: {
        type: row.material?.type ?? null,
        name: row.material?.name ?? null,
        color: row.material?.color || null,
      },
    }));
  return {
    cfsConnected: displayTopology.cfs?.connected === true,
    topologyState: displayTopology.cfs?.topologyState || "unobserved",
    sourceCount: sources.length,
    sources,
  };
}

/**
 * K2/CFS print-start transport profile を現在の観測証拠から認定する。
 *
 * 【詳細説明】
 * - command capability はprinterTypeだけから固定発行せず、現在sessionのNormalizedStateと
 *   実機certified済みprofileの一致を確認してから付与する。
 * - 現公開候補では F012 のWS9999 `colorMatch` -> `multiColorPrint` profileだけを認める。
 *
 * @private
 * @param {object|null|undefined} shadowRecord - runtimeData.printerCoreV3Shadow record
 * @param {object} materialTopology - send-time material topology
 * @returns {boolean} 現在sessionでK2/CFS print-startを送信してよいprofileならtrue
 */
function isK2CfsPrintStartTransportProfileCertified(shadowRecord, materialTopology) {
  const state = shadowRecord?.lastState || null;
  const reportedModel = String(state?.identity?.reportedModel || "").trim().toUpperCase();
  return Boolean(
    reportedModel === "F012" &&
    shadowRecord?.state !== "closed" &&
    materialTopology?.cfsConnected === true &&
    materialTopology?.topologyState === "fresh" &&
    Array.isArray(materialTopology.sources) &&
    materialTopology.sources.some((source) => source.kind === "cfs-slot")
  );
}

/**
 * K2/CFS print-startのsend-time capability setを作る。
 *
 * 【詳細説明】
 * - Adapterが観測したcapabilityを基礎にし、certified transport profileが現在証拠に一致した場合だけ
 *   `command.print-start` を追加する。
 * - profile名はcontext内の監査証拠として残し、後続レビューで「どのtransport契約を許可したか」を確認できる。
 *
 * @private
 * @param {object|null|undefined} shadowRecord - runtimeData.printerCoreV3Shadow record
 * @param {object} materialTopology - send-time material topology
 * @returns {{capabilities:string[], transportProfiles:string[]}} capability と認定profile
 */
function createK2CfsPrintSendTimeCapabilities(shadowRecord, materialTopology) {
  const observedCapabilities = shadowRecord?.lastState?.capabilities || [];
  const transportProfiles = [];
  let capabilities = mergeCapabilitySets(observedCapabilities).values;
  if (isK2CfsPrintStartTransportProfileCertified(shadowRecord, materialTopology)) {
    transportProfiles.push(K2_CFS_PRINT_START_TRANSPORT_PROFILE);
    capabilities = mergeCapabilitySets(capabilities, [
      PRINTER_CAPABILITIES.COMMAND_PRINT_START,
      PRINTER_CAPABILITIES.MATERIAL_CFS,
      PRINTER_CAPABILITIES.MATERIAL_CFS_TOPOLOGY,
    ]).values;
  }
  return {
    capabilities,
    transportProfiles,
  };
}

/**
 * K2/CFS print-startの送信直前contextを作る。
 *
 * 【詳細説明】
 * - active session、command capability、現在file identity、現在CFS topologyをdispatcherへ渡す。
 * - callerが持っていた古いraw行ではなく、送信直前のruntime/cacheから再構築する。
 *
 * @private
 * @param {string} hostname - 対象ホスト名
 * @param {object} request - command request
 * @returns {object} command authority send-time snapshot
 */
function createK2CfsPrintSendTimeContext(hostname, request) {
  const machine = monitorData.machines?.[hostname] || null;
  const shadowRecord = machine?.runtimeData?.printerCoreV3Shadow || null;
  const requestedPath = normalizeK2CfsPrintFilePath(request?.payload?.asset?.path);
  const currentFile = findCurrentK2CfsFileRow(hostname, requestedPath);
  const fileIdentity = currentFile ? createK2CfsPrintFileIdentity(currentFile) : {
    path: requestedPath || "",
    fileHash: "",
    uploadGeneration: "",
  };
  const materialTopology = createK2CfsPrintSendTimeMaterialTopology(hostname, shadowRecord);
  const sendTimeCapabilities = createK2CfsPrintSendTimeCapabilities(shadowRecord, materialTopology);
  return {
    deviceId: shadowRecord?.deviceId || "",
    sessionId: shadowRecord?.sessionId || "",
    transportKind: "ws9999",
    active: getConnectionState(hostname) === "connected" && shadowRecord?.state !== "closed",
    capabilities: sendTimeCapabilities.capabilities,
    transportProfiles: sendTimeCapabilities.transportProfiles,
    materialTopology,
    uploadGeneration: fileIdentity.uploadGeneration,
    fileIdentity: {
      remotePath: fileIdentity.path,
      fileHash: fileIdentity.fileHash,
    },
    stateSequence: shadowRecord?.lastSequence ?? shadowRecord?.lastState?.source?.sequence ?? null,
    observedState: shadowRecord?.lastState || null,
    createdAt: new Date().toISOString(),
  };
}

/**
 * K2/CFS print-start後の観測snapshotを返す。
 *
 * 【詳細説明】
 * - 現段階ではprotocol correlation proofを偽造しない。
 * - 送信直後に既に新stateが観測されていなければ、command resultはcompleted:falseのままになる。
 *
 * @private
 * @param {string} hostname - 対象ホスト名
 * @returns {object} command authority observation
 */
function observeK2CfsPrintCommandState(hostname) {
  const shadowRecord = monitorData.machines?.[hostname]?.runtimeData?.printerCoreV3Shadow || null;
  return {
    observedState: shadowRecord?.lastState || null,
    observedSequence: shadowRecord?.lastSequence ?? shadowRecord?.lastState?.source?.sequence ?? null,
    observedSessionId: shadowRecord?.sessionId || "",
  };
}

/**
 * K2/CFS印刷開始requestをUI選択から構築する。
 *
 * 【詳細説明】
 * - ここではPrintPlan authority全体を解放せず、K2/CFS transport mapperが必要とする
 *   command request shapeだけを作る。
 * - 外部スプールや未装填slotはdialogModelの候補に入らないため、`opGcodeFile` fallbackへ落ちない。
 *
 * @private
 * @param {object} options - 構築オプション
 * @param {string} options.hostname - 対象ホスト名
 * @param {object} options.raw - ファイル一覧または履歴の行データ
 * @param {object} options.dialogModel - CFS割当UI model
 * @param {Array<{toolAlias:string, sourceId:string}>} options.assignments - 確定割当
 * @returns {object} Printer Core command request風object
 */
function createK2CfsPrintStartRequestFromUi(options) {
  const machine = monitorData.machines?.[options.hostname] || null;
  const shadowRecord = machine?.runtimeData?.printerCoreV3Shadow || null;
  const fileIdentity = createK2CfsPrintFileIdentity(options.raw);
  if (!shadowRecord?.deviceId || !shadowRecord?.sessionId) {
    throw new Error("missing-k2-cfs-shadow-session");
  }
  const fileMaterialTypes = splitK2CfsMaterialList(options.raw?.material || options.raw?.raw?.material);
  const toolAssignments = options.assignments.map((assignment, index) => {
    const row = findK2CfsRowBySourceId(options.dialogModel.rows, assignment.sourceId);
    const material = row?.material || {};
    const materialType = toPrintManagerNonEmptyString(material.type) || fileMaterialTypes[index] || fileMaterialTypes[0] || null;
    const color = normalizeK2CfsProtocolColor(material.color);
    if (!row || !materialType || !color) {
      throw new Error(`missing-k2-cfs-material-evidence:${assignment.toolAlias}`);
    }
    return {
      toolId: index,
      protocolToolAlias: assignment.toolAlias,
      materialSourceId: assignment.sourceId,
      protocol: {
        type: materialType,
        color,
      },
      material: {
        type: materialType,
        name: material.name || null,
        color: material.color || null,
      },
    };
  });
  return createPrinterCommandRequest({
    deviceId: shadowRecord.deviceId,
    sessionId: shadowRecord.sessionId,
    commandKind: "print-start",
    transportKind: "ws9999",
    payload: {
      printPlanId: `ui-k2-cfs:${options.hostname}:${fileIdentity.path}:${fileIdentity.fileHash}`,
      planKind: toolAssignments.length > 1 ? "multicolor-cfs" : "single-color",
      transportProfile: K2_CFS_PRINT_START_TRANSPORT_PROFILE,
      asset: {
        path: fileIdentity.path,
        fileHash: fileIdentity.fileHash,
      },
      toolAssignments,
      materialSourceIds: [...new Set(toolAssignments.map((assignment) => assignment.materialSourceId))],
      startOptions: {
        enableSelfTest: 0,
      },
      startContext: {
        sessionId: shadowRecord.sessionId,
        connectionGeneration: shadowRecord.connectionGeneration ?? shadowRecord.printerCoreV3ConnectionGeneration ?? null,
        uploadGeneration: fileIdentity.uploadGeneration,
        receiptId: null,
        baselinePrintJobId: String(machine?.printStore?.current?.id || getCurrentPrintID(options.hostname) || "").trim() || null,
        baselinePrintStartTime: machine?.printStore?.current?.startTime ||
          machine?.printStore?.current?.firstObservedAt ||
          machine?.storedData?.printStartTime?.rawValue ||
          null,
      },
    },
    expectedState: [{
      path: "print.stateLabel",
      operator: "oneOf",
      expected: ["checking", "heating", "printing"],
    }],
    timeoutMs: 60_000,
    idempotencyKey: `ui-k2-cfs:${options.hostname}:${fileIdentity.path}:${fileIdentity.fileHash}`,
    createdAt: new Date().toISOString(),
  });
}

/**
 * K2/CFS印刷開始の材料割当planをUI選択から構築する。
 *
 * 【詳細説明】
 * - transport requestは実機へ送るremote file identityを持ち、MaterialBindingPlanは3DPmon内の
 *   source/spool/tool対応をprint-start観測へbindするためだけに保持する。
 * - 既存remote G-codeではPrintPlan用のG-code content/upload receiptを持てないため、
 *   `validatePrintPlan()`を弱めず材料割当専用contractへ分離する。
 *
 * @private
 * @function createK2CfsMaterialBindingPlanFromPrintStartRequest
 * @param {object} request - K2/CFS print-start command request。
 * @returns {object} MaterialBindingPlan。
 */
function createK2CfsMaterialBindingPlanFromPrintStartRequest(request) {
  const payload = request?.payload || {};
  return createMaterialBindingPlan({
    deviceId: request.deviceId,
    bindingPlanId: payload.printPlanId,
    asset: {
      path: payload.asset?.path,
      fileHash: payload.asset?.fileHash,
      uploadGeneration: payload.startContext?.uploadGeneration || null,
    },
    toolAssignments: payload.toolAssignments || [],
    startContext: {
      sessionId: request.sessionId,
      connectionGeneration: payload.startContext?.connectionGeneration || request.connectionGeneration || null,
      uploadGeneration: payload.startContext?.uploadGeneration || null,
    },
    commandBinding: createMaterialBindingCommandBinding(request),
    createdAt: request.createdAt || null,
  });
}

/**
 * K2/CFS印刷開始transportを送信する。
 *
 * 【詳細説明】
 * - `createK2CfsCommandTransportPlan()` が拒否した場合はプリンタへ何も送らない。
 * - `sendCommand()` はK1/K2 WebSocketのfire-and-forget APIなので、transport hookでは
 *   ローカル投入完了を `submitted` として返す。
 *
 * @private
 * @param {string} hostname - 対象ホスト名
 * @param {object} request - Printer Core command request風object
 * @param {object=} options - 送信直前hook。
 * @param {Function=} options.onBeforeTransportDispatch - transport plan検証後、実送信前に呼ぶhook。
 * @returns {Promise<object>} transport送信結果
 */
async function sendK2CfsPrintStartRequest(hostname, request, options = {}) {
  const dispatcher = createBoundPrinterCommandDispatcher({
    getSendTimeContext: (currentRequest) => createK2CfsPrintSendTimeContext(hostname, currentRequest),
    sendTransport: async (currentRequest) => {
      const plan = createK2CfsCommandTransportPlan(currentRequest);
      if (!plan.ok) {
        throw new Error(`k2-cfs-print-plan-rejected:${plan.reason}`);
      }
      if (typeof options.onBeforeTransportDispatch === "function") {
        await options.onBeforeTransportDispatch({ request: currentRequest, transportPlan: plan });
      }
      const transportResponse = await sendK2CfsCommandTransportPlan(plan, async (frame, meta) => {
        await sendCommand(frame.method, frame.params, hostname);
        return {
          status: "submitted",
          frame,
          meta,
        };
      });
      return transportResponse;
    },
    observeState: () => observeK2CfsPrintCommandState(hostname),
  });
  const result = await dispatcher.dispatch(request);
  if (!result.transportAccepted) {
    const errors = Array.isArray(result.error?.errors) ? result.error.errors.join(",") : (result.error?.message || result.status);
    throw new Error(`k2-cfs-print-dispatch-rejected:${errors}`);
  }
  return result;
}

/**
 * CFS/CFS-C観測状態から印刷確認用の材料文脈を作る。
 *
 * 【詳細説明】
 * - 既存の印刷確認ダイアログは `getCurrentSpool()` の単一スプール装着だけを見ていた。
 *   K2/CFSでは3DPmon台帳スプールが未装着でも、実機CFS側には選択中/装填済みslotがある。
 * - ここではruntimeDataのPrinter Core v3 material topologyを表示専用に解決し、
 *   CFS slotが観測済みなら「スプール未装着」ではなく「CFS供給を観測」として扱う。
 * - この結果は印刷確認UIの誤表示防止だけに使い、ledger authorityや送信authorityにはしない。
 *
 * @private
 * @param {string} hostname - 対象ホスト名
 * @returns {{
 *   displayMode:string,
 *   topologyState:string,
 *   hasCfsSupply:boolean,
 *   selectedRow:object|null,
 *   loadedRows:Array<object>,
 *   viewModel:object|null,
 *   selectedLabel:string,
 *   stale:boolean
 * }} 印刷確認用のCFS材料文脈
 */
function createMaterialPrintContext(hostname) {
  const machine = monitorData.machines?.[hostname] || null;
  const shadowRecord = machine?.runtimeData?.printerCoreV3Shadow || null;
  const topology = resolveDisplayMaterialTopology({
    topology: shadowRecord?.lastState?.materials || null,
    shadowRecord,
  });
  const printerType = getPrinterType(hostname);
  const target = getConnectionTarget(hostname);
  const displayMode = resolveMaterialDisplayMode({ target, printerType, topology });
  if (displayMode !== MATERIAL_DISPLAY_MODE.MULTI_SLOT) {
    return {
      displayMode,
      topologyState: "legacy",
      hasCfsSupply: false,
      selectedRow: null,
      loadedRows: [],
      viewModel: null,
      selectedLabel: "",
      stale: false,
    };
  }
  const viewOptions = resolveMaterialTopologyViewOptions({ target, printerType, topology });
  const viewModel = createMaterialTopologyViewModel(topology, viewOptions);
  const cfsRows = viewModel.units.flatMap((unit) => unit.slots || []);
  const loadedRows = cfsRows.filter((row) => row?.presence === "loaded");
  const selectedRow = cfsRows.find((row) => row?.selected === true && row?.presence === "loaded") || null;
  return {
    displayMode,
    topologyState: viewModel.cfs.topologyState || "unobserved",
    hasCfsSupply: loadedRows.length > 0,
    selectedRow,
    loadedRows,
    viewModel,
    selectedLabel: formatMaterialSourceRowLabel(selectedRow),
    stale: viewModel.cfs.topologyState === "stale",
  };
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
 *   materialUsedSourceCsv?:string|null,
 *   materialUsedTotalObserved?:boolean,
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
  // printfinish: 完了シグナル(実印刷時間 usagetime>0 または 終了時刻 endtime>0)が有る
  //   ジョブのみ成否を確定する。どちらも無い＝印刷中/未完了は null（未確定）にし、
  //   機器の「早すぎる result」も無視する。★ K1 は履歴再取得で印刷中エントリに
  //   printfinish=0 を付けて寄越すため、明示値があっても完了シグナルが無ければ信頼しない
  //   （印刷中ジョブを再起動時に失敗(✗)/成功(✔)へ誤確定＝誤計上していた根本対策）。
  const _finished = (useTimeSec > 0) || (raw.endtime != null && Number(raw.endtime) > 0);
  const printfinish    = _finished
    ? (raw.printfinish != null ? Number(raw.printfinish) : (useTimeSec > 0 ? 1 : 0))
    : null;
  // 材料使用量: total報告とK2/CFS source別CSVは意味が違うため分離して保持する。
  const materialUsedTotalObserved = raw.usagematerial !== undefined &&
    raw.usagematerial !== null &&
    raw.usagematerial !== "";
  const materialUsedMm = materialUsedTotalObserved ? Number(raw.usagematerial) : 0;
  const materialUsedSourceCsv = normalizeMaterialUsedSourceCsv(
    raw.materialUsedSourceCsv ?? raw.materialUsed ?? raw.raw?.materialUsed
  );

  // サムネイルURL: ホスト種別に応じて解決（Moonrakerはメタ/ファイル一覧キャッシュ由来、
  // 不明時はローカル代替。K1は従来の humbnail パス）。
  const thumbUrl       = resolveThumbUrl(host, raw.filename, raw.thumbUrl);

  const startway       = raw.startway;
  const size           = raw.size;
  const filemd5        = raw.filemd5;

  const preparationTime     = raw.preparationTime;
  const firstLayerCheckTime = raw.firstLayerCheckTime;
  const pauseTime           = raw.pauseTime;
  // ★ A: Moonraker のネイティブ ID（job_id）を内部保持（printId=id は start_time のまま）
  const moonrakerJobId      = raw.moonrakerJobId;
  // ★ J: 観測フラグ（live/partial/history）＋印刷後処理時間（秒）。既定は未設定＝取れなかった。
  const observed            = raw.observed;
  const postProcessingTime  = raw.postProcessingTime;
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
    startTimeSec: startSec,  // ★ epoch秒（比較用に保持）
    actualStartTime,
    finishTime,
    printfinish,
    materialUsedMm,
    materialUsedSourceCsv,
    materialUsed: materialUsedSourceCsv,
    materialUsedTotalObserved,
    thumbUrl,
    startway,
    size,
    filemd5,
    preparationTime,
    firstLayerCheckTime,
    pauseTime,
    moonrakerJobId,
    observed,
    postProcessingTime,
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
  const parsed = rawArray
    // ★ ID:0/null 正規化: 無効ID（0/null/負数）のエントリは履歴として扱わない。
    //   電源投入直後の stale push 由来のゴースト（id=0 = epoch 1970）を
    //   パース境界で遮断する（過去バージョンで保存済みのゴーストも再パース時に消える）。
    .filter(r => normalizeJobId(r?.id) != null)
    .filter(r =>
      (typeof r.filename === "string" && r.filename.length > 0) ||
      (Array.isArray(r.filamentInfo) && r.filamentInfo.length > 0)
    )
    .map(r => parseRawHistoryEntry(r, baseUrl, host))
    .sort((a, b) => b.id - a.id);
  return applyPrintHistoryRetention(parsed);
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
  // ★ ID:0/null 正規化: 過去バージョンが保存した無効ID（0/null）のゴースト履歴を
  //   読み出し境界で除去する（一度の保存サイクルで永続データからも消える）。
  return loadPrintHistory(hostname).filter(j => normalizeJobId(j?.id) != null);
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
  // ★ ID:0/null 正規化: 無効IDのエントリは保存しない（書き込み境界の最終防衛線）
  jobs = Array.isArray(jobs) ? jobs.filter(j => normalizeJobId(j?.id) != null) : jobs;
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
        usagetime:     (finishEpoch && startEpoch > 0)
                         ? Math.max(0, finishEpoch - startEpoch)
                         : 0,  // ★ startEpoch=0 のとき finishEpoch がそのまま usagetime になるバグ防止
        usagematerial: job.materialUsedMm,
        ...(job.materialUsedSourceCsv !== undefined && { materialUsedSourceCsv: job.materialUsedSourceCsv }),
        ...(job.materialUsed !== undefined && { materialUsed: job.materialUsed }),
        ...(job.materialUsedTotalObserved !== undefined && { materialUsedTotalObserved: job.materialUsedTotalObserved }),
        // ★ printfinish: finishTime(=完了)が無ければ未確定(null)。あれば明示値(1/0)をそのまま。
        //   印刷中ジョブ(finishTime なし)は保存値が誤って 0/1 でも表示で未確定(…)に矯正する
        //   （K1 履歴再取得の早すぎる result / マージ復元によるストアの誤確定を描画側で吸収）。
        //   完了(finishTime 付与)後に初めて ✔/✗ を表示する。
        printfinish:   finishEpoch ? (job.printfinish ?? null) : null,
        // ★ 中止確定フラグ（非破壊）。printfinish は触らず表示のみ「⏹」へ切替える。
        ...(job.discontinued === true && { discontinued: true }),
        filemd5:       job.filemd5 ?? "",
      ...(job.videoUrl !== undefined && { videoUrl: job.videoUrl }),
      ...(job.preparationTime      !== undefined && { preparationTime:      job.preparationTime }),
      ...(job.firstLayerCheckTime   !== undefined && { firstLayerCheckTime:   job.firstLayerCheckTime }),
      ...(job.pauseTime             !== undefined && { pauseTime:             job.pauseTime }),
      ...(job.moonrakerJobId       !== undefined && { moonrakerJobId:       job.moonrakerJobId }),
      ...(job.observed             !== undefined && { observed:             job.observed }),
      ...(job.postProcessingTime   !== undefined && { postProcessingTime:   job.postProcessingTime }),
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
  current(job, baseUrl, host) {
    const fmt = iso => iso ? formatEpochToDateTime(iso) : "—";
    const name = job.filename || '(名称不明)';
    // K1 はライブ撮影画像(current_print_image.png, キャッシュバスター付き)を使う。
    // Moonraker にはこのパスが無く、毎描画(?ts)で 404 を取りに行きスロットルを招くため、
    // 当該機では gcode サムネ(静的・キャッシュ可)へ切り替え、404 嵐を避ける。
    const isMoonraker = getPrinterType(host) === "moonraker";
    const currentUrl = isMoonraker
      ? resolveThumbUrl(host, job.rawFilename || job.filename, job.thumbUrl)
      : `${baseUrl}/downloads/original/current_print_image.png?${Date.now()}`;
    const fallback   = isMoonraker
      ? THUMB_PLACEHOLDER
      : `${baseUrl}/downloads/defData/file_print_photo.png`;
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
      const remainFmt = formatRemainingFilamentAmount(spool.remainingLengthMm, spool);
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
  historyItem(job, baseUrl, host) {
    const thumbUrl = resolveThumbUrl(host, job.rawFilename || job.filename, job.thumbUrl);
    const fallback = THUMB_PLACEHOLDER;
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
  const baseUrl = getDisplayBaseUrl(hostname);

  if (!job) {
    containerEl.innerHTML = "<p>現在印刷中のジョブはありません。</p>";
    return;
  }

  /* 印刷中であれば storedData からリアルタイム使用量を取得 */
  const machine = monitorData.machines[hostname];
  // ★ 状態は storedData.state(機器報告の生値・再起動後も保持)を最優先。
  //   runtimeData.state は data.state 欠落メッセージで "NaN" に化け、印刷中でも
  //   ▶(進行中)にならない不具合があったため、信頼できる storedData.state を一次ソースにする。
  const printState = Number(
    machine?.storedData?.state?.rawValue
    ?? machine?.runtimeData?.state
    ?? -1
  );
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

  containerEl.innerHTML = renderTemplates.current(job, baseUrl, hostname);
}


/**
 * 印刷履歴リストを指定コンテナ（ul または div）に描画
 * @param {HTMLElement|null} containerEl - 描画先要素。null なら何もしません
 */
export function renderPrintHistory(containerEl, hostname) {
  if (!containerEl) return;
  const jobs = loadHistory(hostname);
  const baseUrl = getDisplayBaseUrl(hostname);

  containerEl.innerHTML = "";
  if (!jobs.length) {
    containerEl.innerHTML = "<li>履歴がありません。</li>";
    return;
  }
  for (const job of jobs) {
    const li = document.createElement("li");
    li.className = "print-job-item";
    // rawFilename を渡せるように、履歴保存時に保持しておくと良いです
    li.innerHTML = renderTemplates.historyItem(job, baseUrl, hostname);
    containerEl.appendChild(li);
  }
}


/**
 * ADR-0005: 履歴マージ用に filamentInfo を spoolId 単位で upsert する。
 *
 * 「配列まるごと null のときだけ補完」だと、分割（一時停止交換）で 1 ジョブに記録した
 * 複数リールの per-reel usedMm が reqHistory パース結果（プリンタ由来・色のみ等）に
 * 上書き／脱落してしまう。spoolId をキーに、未知リールは追加・欠落スカラーと usedMm は
 * 補完する形でマージし、各リールの消費量を保持する。
 *
 * @private
 * @param {Array<Object>|undefined} curArr - 取り込み先（newJobs 側）の filamentInfo
 * @param {Array<Object>|undefined} incoming - 取り込み元（oldJobs=印刷履歴の権威）の filamentInfo
 * @returns {Array<Object>|undefined} マージ後配列
 */
export function _mergeFilamentInfo(curArr, incoming) {
  if (!Array.isArray(incoming) || incoming.length === 0) return curArr;
  if (!Array.isArray(curArr) || curArr.length === 0) return incoming.slice();
  const out = curArr.slice();
  for (const inc of incoming) {
    if (!inc) continue;
    const sid = inc.spoolId;
    if (sid == null) {
      // spoolId 無し（色のみ等）: 既存に spoolId 無しエントリが無ければ追加（重複防止）。
      if (!out.some(e => e && e.spoolId == null)) out.push(inc);
      continue;
    }
    const existing = out.find(e => e && e.spoolId === sid);
    if (!existing) {
      out.push(inc);
    } else {
      // 欠落スカラーを補完。usedMm は新側が未設定/0 のときのみ旧（権威）で埋める。
      for (const [kk, vv] of Object.entries(inc)) {
        if (vv == null) continue;
        if (kk === "usedMm") {
          if (!(Number(existing.usedMm) > 0)) existing.usedMm = vv;
        } else if (existing[kk] == null) {
          existing[kk] = vv;
        }
      }
    }
  }
  return out;
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
        if (k === "filamentInfo") {
          // ★ ADR-0005: filamentInfo は spoolId 単位で upsert（分割の複数リールと per-reel
          //   usedMm が reqHistory 由来の色のみ filamentInfo に脱落しないよう保持）。
          cur.filamentInfo = _mergeFilamentInfo(cur.filamentInfo, v);
          return;
        }
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
  const jobs = applyPrintHistoryRetention(
    Array.from(mergedMap.values()).sort((a, b) => Number(b.id) - Number(a.id))
  );

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
  const mergedRaw = applyPrintHistoryRetention(
    Array.from(rawMap.values()).sort((a, b) => b.id - a.id)
  );
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
          // ★ P1-2: filamentInfo は配列（分割交換の per-reel spoolId/usedMm を保持）。
          //   薄い incoming（色のみ・spoolId なし）が spoolId/usedMm 付きの既存を丸ごと
          //   上書き消去しないよう、refreshHistory と同じ _mergeFilamentInfo で upsert する。
          if (k === "filamentInfo") {
            if (v != null) {
              const before = JSON.stringify(cur.filamentInfo || null);
              cur.filamentInfo = _mergeFilamentInfo(cur.filamentInfo, v);
              if (JSON.stringify(cur.filamentInfo || null) !== before) merged = true;
            }
            return;
          }
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
  const jobs = applyPrintHistoryRetention(
    Array.from(mergedMap.values()).sort((a, b) => Number(b.id) - Number(a.id))
  );

  // ★ 未完了ジョブ(終了時刻なし)は成否を確定しない＝printfinish=null（誤計上防止・タイミング非依存）。
  //   K1 は履歴再取得で印刷中エントリへ早すぎる printfinish=0 を付け(usagetime=0/finishTime=null)、
  //   さらにマージが旧値(0)を復元するため、保存直前に「finishTime が無いエントリは未確定(null)」へ
  //   正規化する。完了報告(finishTime 付与)後に初めて ✔/✗ が確定し、既存の誤確定エントリ
  //   (printfinish=0/finishTime=null)も次回マージで自己修復される。
  //   ※ getCurrentPrintID 依存だと起動時(現在ID未確立)に発火せず外していた。finishTime 基準は確実。
  jobs.forEach(j => {
    if (j.finishTime == null && j.printfinish != null) j.printfinish = null;
  });

  // ★ 中止検知（非破壊・自己修復）: 「未確定(printfinish==null/finishTime なし)」のまま
  //   放置された“非最新”ジョブ＝より大きい id（＝より新しい印刷）が後続で存在する以上、
  //   そのジョブはもう継続されていない（中断/電源断/再起動等で完了報告が来なかった）。
  //   printfinish を 0(失敗) へ書き換えると統計を汚染し復元不能になるため破壊的修正は行わず、
  //   別フラグ discontinued=true を立てて「継続されていない」ことだけを内部データへ明示する。
  //   成否は printfinish=null のまま＝stats 集計対象外を維持（依然「不明」）。
  //   完了報告が後から届けば finishTime/printfinish が入り isPending=false となり、
  //   次回マージで discontinued は自動解除される（自己修復）。
  //   ※ 最新(=id 最大)ジョブ自身と、currentPrintID 一致の稼働中ジョブは保護対象（中止にしない）。
  const curId    = getCurrentPrintID(host);
  const newestId = jobs.reduce((m, j) => Math.max(m, Number(j.id) || 0), 0);
  jobs.forEach(j => {
    const isPending = j.printfinish == null && j.finishTime == null;
    const hasNewer  = (Number(j.id) || 0) < newestId;
    const isCurrent = curId != null && String(j.id) === String(curId);
    if (isPending && hasNewer && !isCurrent) {
      if (j.discontinued !== true) { j.discontinued = true; merged = true; }
    } else if (j.discontinued) {
      // 条件を満たさなくなった（完了報告が来た / 最新になった等）→ 整合のため解除
      delete j.discontinued;
      merged = true;
    }
  });

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
 * 印刷履歴1行の成否アイコン/クラスを決定する純関数。
 *
 * ★ 重要不変条件: 「印刷中(▶/⏸)」は isCurrentJob（currentPrintID 一致 かつ
 *   aggregator 状態が printStarted/printPaused）が真のときのみ。
 *   currentPrintID と一致しないジョブは printfinish の値に関わらず決して
 *   「印刷中」と表示しない（再取得時の複数印刷中コンタミネーション防止）。
 *
 * @param {Object}  params
 * @param {boolean} params.isCurrentJob - 現在の印刷ジョブと一致し稼働中か
 * @param {boolean} params.isPaused     - 一時停止中か
 * @param {number|null|undefined} params.printfinish - 完了フラグ(1=成功)
 * @param {boolean} [params.discontinued] - 非最新のまま放置され中止と確定したか
 * @returns {{finish: string, finishCls: string}}
 */
export function resolveHistoryFinishStatus({ isCurrentJob, isPaused, printfinish, discontinued }) {
  if (isCurrentJob) {
    // 唯一の「印刷中」: 現在の印刷ジョブ
    return { finish: isPaused ? "⏸" : "▶", finishCls: "result-active" };
  }
  if (printfinish === 1) {
    return { finish: "✔", finishCls: "result-ok" };
  }
  // ★ printfinish == null/undefined = 印刷中/未確定（再起動直後など、機器が完了を
  //   まだ報告していない）。完了が確認できるまで成否を確定しない＝✗にしない（誤計上防止）。
  //   currentPrintID と一致すれば上の isCurrentJob 分岐で ▶ になる。一致しない過渡状態は
  //   中立の「…」で表示し、stats でも除外される（printfinish==null は集計対象外）。
  if (printfinish == null) {
    // ★ 中止確定（discontinued）: より新しいジョブが存在する＝その後に別の印刷が
    //   始まっている以上、この未確定ジョブはもう継続されていない（中断/電源断等で
    //   完了報告が来なかった）。無期限の「…」ではなく「⏹(中止)」で明示する。
    //   printfinish は依然 null＝成否は「不明」のまま（stats 集計対象外を維持）で、
    //   破壊的な ✗(失敗) 確定はしない。
    if (discontinued) {
      return { finish: "⏹", finishCls: "result-aborted" };
    }
    return { finish: "…", finishCls: "result-pending" };
  }
  // 明示値で成功(1)でない（0 / -1 等）＝失敗/中断 → ✗
  return { finish: "✗", finishCls: "result-ng" };
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
  // ★ 状態は storedData.state(機器報告の生値・再起動後も保持)を最優先。
  //   runtimeData.state は data.state 欠落メッセージで "NaN" に化け、印刷中でも
  //   ▶(進行中)にならない不具合があったため、信頼できる storedData.state を一次ソースにする。
  const printState = Number(
    machine?.storedData?.state?.rawValue
    ?? machine?.runtimeData?.state
    ?? -1
  );
  const isActive   = (st) =>
    st === PRINT_STATE_CODE.printStarted || st === PRINT_STATE_CODE.printPaused;

  tbody.innerHTML = "";

  rawArray.forEach((raw, index) => {
    const name     = raw.filename.split("/").pop();
    const thumbUrl = resolveThumbUrl(hostname, raw.filename, raw.thumbUrl);
    const fallback = THUMB_PLACEHOLDER;

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
    // ★ J: 印刷後処理時間（進捗100%→完了。立ち会えたときのみ実測値あり）
    const postSec   = raw.postProcessingTime != null ? Number(raw.postProcessingTime) : null;
    const posttime  = postSec != null ? formatDuration(postSec) : "";
    // フィラメント情報（umaterial 算出前に必要）
    const spoolInfos = Array.isArray(raw.filamentInfo)
      ? raw.filamentInfo
      : (raw.filamentId ? [{ spoolId: raw.filamentId }] : []);
    // フィラメント消費量: スプール情報があれば g/¥ 換算も表示
    const spoolForFmt = spoolInfos.length > 0
      ? (getSpoolById(spoolInfos[0].spoolId) || null) : null;
    // ★ 単位トグル(m/mm)に応じて距離を切替、距離と (g, ¥) を2段表示
    const _unit = monitorData.appSettings.filamentUnit === "mm" ? "mm" : "m";
    const umaterial =
      raw.usagematerial != null
        ? formatUsageHtml(raw.usagematerial, spoolForFmt, _unit)
        : "—";
    /* 成否表示: 印刷中/一時停止中のジョブは ▶/⏸ で表示
       ★ 「印刷中」は『現在印刷しているID(currentPrintID)と一致 かつ
          aggregator 状態が printStarted/printPaused』のみで判定する。
          1機器で同時に印刷中なのは最大1ジョブのため、印刷中行は最大1行。 */
    const isCurrentJob = curPrintId && String(raw.id) === String(curPrintId) && isActive(printState);
    const { finish, finishCls } = resolveHistoryFinishStatus({
      isCurrentJob,
      isPaused: printState === PRINT_STATE_CODE.printPaused,
      printfinish: raw.printfinish,
      discontinued: raw.discontinued === true
    });
    // 中止確定セルには理由をツールチップで補足する
    const finishTitle = finishCls === "result-aborted"
      ? "中止（より新しい印刷が開始されたため継続されていません。成否は不明）"
      : "";
    const md5short  = raw.filemd5 ? raw.filemd5.substring(0, 8) : "";
    const videoLink = raw.videoUrl
      ? `<button class="video-link icon-btn" data-url="${raw.videoUrl}" title="動画">📹</button>`
      : "";

    // 時間詳細行（準備・確認・停止・後処理があれば表示）
    const timeDetails = [];
    if (preptime) timeDetails.push(`準備${preptime}`);
    if (checktime) timeDetails.push(`確認${checktime}`);
    if (pausetime) timeDetails.push(`停止${pausetime}`);
    if (posttime) timeDetails.push(`後処理${posttime}`);
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
        let text;
        if (spName || colName) {
          text = `${colorBox}${matTag} ${spName}/${colName}`;
        } else if (info.spoolId) {
          // スプール削除済みだが ID は残っている
          text = `${colorBox}${matTag} <span class="text-muted">(削除済み #${info.spoolId.toString().slice(-4)})</span>`;
        } else {
          text = '(不明)';
        }
        if (idx === 0) {
          const editId = info.spoolId || raw.filamentId;
          if (editId) text += ` <button class="spool-edit icon-btn" data-id="${editId}" title="修正">✏</button>`;
        }
        const cnt = info.spoolCount ?? sp?.printCount ?? 0;
        const remMm = info.expectedRemain ?? sp?.remainingLengthMm ?? 0;
        const remFmt = formatRemainingFilamentAmount(remMm, sp);
        parts.push(`<div class="spool-line">${text}</div>`);
        parts.push(`<div class="spool-meta">残:${remFmt.display} 回:${cnt}</div>`);
      });
      spoolHtml = parts.join("");
    }

    // ★ Phase5(U2): 帰属未確認（消費ありなのに確定スプール無し）の完了ジョブへ「未確認」チップを付す。
    //   raw は jobsToRaw で materialUsedMm→usagematerial に改名済みのため adapt して判定する。
    const _attrPres = getAttributionPresentation({
      materialUsedMm: raw.usagematerial,
      filamentInfo: raw.filamentInfo,
      filamentId: raw.filamentId,
      printfinish: raw.printfinish   // ★ P1-5: 完了判定に必要（印刷中=null は除外）
    });
    if (_attrPres.state === "pending") {
      spoolHtml += `<span class="attr-chip" title="このジョブの消費フィラメントが未確定です（確認してください）">${_attrPres.label}</span>`;
    }

    const tr = document.createElement("tr");
    const isPrinting = finishCls === "result-active";
    tr.className = `history-row${isPrinting ? " history-row-printing" : ""}`;
    tr.style.cursor = "pointer";   // ドリルダウン可能を示す（旧: 行ごとに設定）
    tr.innerHTML = `
      <td class="col-cmd">
        <button class="cmd-print icon-btn" title="印刷">▶</button>
        <button class="cmd-rename icon-btn" title="名前変更">✏</button>
        <button class="cmd-delete icon-btn" title="削除">🗑</button>
      </td>
      <td data-key="number" class="col-num">${index + 1}<div class="sub-id">${raw.id}</div></td>
      <td class="col-thumb">
        <img src="${thumbUrl}" alt="${name}" style="width:40px;min-height:40px" loading="lazy" decoding="async"
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
      <td data-key="printfinish" class="col-finish"><span class="${finishCls}"${finishTitle ? ` title="${finishTitle}"` : ""}>${finish}</span></td>
      <td data-key="usagematerial" class="usage-cell" data-mm="${raw.usagematerial != null ? raw.usagematerial : ''}" data-spool="${spoolForFmt?.id || ''}">${umaterial}</td>
      <td data-key="spool" class="col-spool">${spoolHtml}</td>
      <td data-key="filemd5" class="col-extra">
        ${videoLink}
        <span class="md5-short" title="${raw.filemd5 || ''}">${md5short}</span>
      </td>
    `;
    // ★ 描画律速対策: 行ごとの addEventListener を廃止し、tbody 1個へ委譲。
    //   行特定は data-row-index で行う（dispatch は _historyTbodyClick）。
    tr.dataset.rowIndex = String(index);
    tbody.appendChild(tr);
  });

  // ソート用リスナ追加 + ソートインジケータ
  if (table) {
    _bindSortHeaders(table, "print-history-table", hostname);
  }

  // ── ジョブ詳細ドリルダウン (5-1 + 4-3) ──
  const tableParent = table?.parentElement;
  let drilldown = null;
  if (tableParent) {
    // 既存のドリルダウンがあれば再利用
    drilldown = tableParent.querySelector(".job-drilldown");
    if (!drilldown) {
      drilldown = document.createElement("div");
      drilldown.className = "job-drilldown";
      drilldown.classList.add("pm-drilldown");
      tableParent.appendChild(drilldown);
    }
  }

  // ★ 描画律速対策: 行ごとの addEventListener（印刷/改名/削除/動画/スプール/ドリルダウン）を
  //   tbody 1個のイベント委譲に集約する。数百行 × 数リスナ＝数千リスナによるメモリ/再描画
  //   コストを排除する。tbody は innerHTML 入替で行が作り直されても永続するため、ハンドラは
  //   1度だけバインドし、行データ・コンテキストは _historyCtx に最新を保持して参照する。
  tbody._historyCtx = { rawArray, baseUrl, hostname, drilldown, table };
  if (!tbody._historyDelegated) {
    tbody._historyDelegated = true;
    tbody.addEventListener("click", _historyTbodyClick);
  }

  // ★ Phase5(U2): 印刷履歴カード ヘッダの「未確認 N」バッジを更新する
  //   （親の初期描画・子の relay 再描画の両パスがここを通る）。
  updateAttributionBadge(hostname);
  // ★ Phase5(U3): 帰属未確認の重複抑制通知（判定は別モジュール＝UI描画と分離）。
  //   親のみ発火・debounce 集約。子や 0件では no-op。
  scheduleAttributionNotice(hostname);
}

/**
 * 印刷履歴カード ヘッダの「未確認 N」件数バッジを更新する（Phase5 U2）。
 *
 * 対象ホストの帰属未確認 課題（履歴 pending ＋ 隔離消費）の件数を集約表示する。
 * 0 件のときはバッジを隠す。バッジ要素は panel_factory が history パネルの
 * ヘッダへ用意する（未構築なら no-op）。親・子（サテライト）双方で同じ表示。
 *
 * @function updateAttributionBadge
 * @param {string} hostname - 対象ホスト名
 * @returns {void}
 */
// ★ P1-3(レビュー): 隔離追加（履歴行を持たない）の状態変化を購読し、renderHistoryTable を
//   待たずにバッジ更新・通知再評価を直接動かす。UI描画(updateAttributionBadge)と
//   通知判定(scheduleAttributionNotice)は別関数のまま、ここで両者を駆動する。
if (typeof window !== "undefined" && typeof window.addEventListener === "function"
    && !window._3dpmonAttrListenerBound) {
  window._3dpmonAttrListenerBound = true;
  window.addEventListener("3dpmon:attribution-changed", (e) => {
    const h = e?.detail?.host;
    if (!h) return;
    try { updateAttributionBadge(h); } catch { /* no-op */ }
    try { scheduleAttributionNotice(h); } catch { /* no-op */ }
  });
}

export function updateAttributionBadge(hostname) {
  if (!hostname) return;
  try {
    // data-host は IP/コロン等を含み得るため CSS セレクタ用エスケープを避け、走査で一致判定する。
    const panels = document.querySelectorAll('[data-panel-type="history"]');
    let panel = null;
    for (const p of panels) { if (p.dataset && p.dataset.host === hostname) { panel = p; break; } }
    if (!panel) return;
    const badge = panel.querySelector(".panel-attr-badge");
    if (!badge) return;
    // ★ #410-7: 詳細（履歴/隔離で確認可能）と 集約済み（上限超過で詳細なし）を分けて示す。
    //   バッジ本文は詳細件数、集約済みがあれば "+M" を付し、ツールチップで内訳を明示する。
    const detail = getAttributionIssueIdsForHost(hostname).size;
    const archived = countUnattributedArchiveForHost(hostname);
    const total = detail + archived;
    if (total > 0) {
      badge.textContent = archived > 0 ? `未確認 ${detail}+${archived}` : `未確認 ${detail}`;
      badge.title = archived > 0
        ? `未確認 ${total} 件（確認可能 ${detail} 件・集約済み ${archived} 件＝詳細なし）`
        : `未確認 ${detail} 件`;
      badge.hidden = false;
    } else {
      badge.textContent = "";
      badge.title = "";
      badge.hidden = true;
    }
  } catch { /* DOM 未構築・環境非DOM は無視 */ }
}

/**
 * 履歴テーブル tbody のクリックを委譲処理する単一ハンドラ。
 * 行は data-row-index → _historyCtx.rawArray[index] で特定する。
 *
 * @private
 * @param {MouseEvent} ev
 * @returns {Promise<void>}
 */
async function _historyTbodyClick(ev) {
  const tbody = ev.currentTarget;
  const ctx = tbody?._historyCtx;
  if (!ctx) return;
  const { rawArray, baseUrl, hostname, drilldown } = ctx;

  const trEl = ev.target.closest("tr.history-row");
  if (!trEl) return;
  const idx = Number(trEl.dataset.rowIndex);
  const raw = rawArray[idx];
  if (!raw) return;

  if (ev.target.closest(".cmd-print")) {
    const thumbUrl = resolveThumbUrl(hostname, raw.filename, raw.thumbUrl);
    handlePrintClick(raw, thumbUrl, hostname);
    return;
  }
  if (ev.target.closest(".cmd-rename")) { handleRenameClick(raw, hostname); return; }
  if (ev.target.closest(".cmd-delete")) { handleDeleteClick(raw, hostname); return; }
  if (ev.target.closest(".video-link")) { showVideoOverlay(raw.videoUrl); return; }
  const editBtn = ev.target.closest(".spool-edit");
  if (editBtn) { await _handleHistorySpoolEdit(raw, baseUrl, hostname, editBtn.dataset.id); return; }
  if (ev.target.closest(".spool-assign")) { await _handleHistorySpoolAssign(raw, baseUrl, hostname); return; }

  // ボタン/フォーム以外 → ドリルダウン
  if (ev.target.closest("button, select, input")) return;
  if (drilldown) _renderJobDrilldown(drilldown, raw, baseUrl, hostname);
}

/**
 * 履歴行のスプール「修正」操作（旧 .spool-edit クリックハンドラと同一ロジック）。
 *
 * @private
 * @param {Object} raw - 行データ
 * @param {string} baseUrl - サムネイルベースURL
 * @param {string} hostname - ホスト名
 * @param {string} [sid] - 現在のスプールID（編集ボタンの data-id）
 * @returns {Promise<void>}
 */
async function _handleHistorySpoolEdit(raw, baseUrl, hostname, sid) {
  // ★ リレー子（satellite）では履歴フィラメント修正は未対応（複合操作のRPC未実装）。
  //   ローカル状態だけが書き換わる「見かけ操作」を防ぐため明示ブロックする。
  if (typeof window !== "undefined" && window._3dpmonRelayChild === true) {
    const { showAlert } = await import("./dashboard_notification_manager.js");
    showAlert("履歴のフィラメント修正は親機でのみ操作できます", "warn");
    return;
  }
  const materialUsedMm = raw.usagematerial || 0;
  const result = await showHistoryFilamentDialog({
    hostname, materialUsedMm, currentSpoolId: sid, jobId: String(raw.id)
  });
  if (!result) return;
  const { spool: newSp } = result;
  // 同一スプール選択時はスキップ
  if (sid && newSp.id === sid) return;
  // ★ ADR-0004 + Option1（手動編集=権威）: 累積減算(updateSpool ±materialUsedMm)は
  //   二重計上の温床なので使わない。先に帰属(filamentInfo)を書き換えてから、旧/新
  //   スプールを総量基準で権威再計算する（recomputeSpoolFromManualEdit が再アンカーも実施）。
  _applyFilamentToRaw(raw, getSpoolById(newSp.id) || newSp);
  // 保存済み履歴を直接更新（updateHistoryList の再パースでデータ破壊を防ぐ）
  _patchHistoryFilament(raw, hostname);
  const recoTs = Date.now();
  _recomputeAndRefreshSpool(sid, recoTs);          // 旧スプール（帰属が外れた）
  _recomputeAndRefreshSpool(newSp.id, recoTs);     // 新スプール（帰属が付いた）
  saveUnifiedStorage(true);
  const updatedSp = getSpoolById(newSp.id) || newSp;
  // 現在印刷中ジョブなら機器装着スプール・プレビューも連動
  _linkCurrentPrintSpool(raw, updatedSp, hostname);
  // パネルのフィラメントプレビューを更新
  const hostPreview = window._filamentPreviews?.get(hostname);
  if (hostPreview) updateFilamentPreview(updatedSp, hostPreview);
  // UI 再描画
  const allJobs = loadHistory(hostname);
  renderHistoryTable(jobsToRaw(allJobs), baseUrl, hostname);
}

/**
 * 履歴行のスプール「指定」操作（旧 .spool-assign クリックハンドラと同一ロジック）。
 *
 * @private
 * @param {Object} raw - 行データ
 * @param {string} baseUrl - サムネイルベースURL
 * @param {string} hostname - ホスト名
 * @returns {Promise<void>}
 */
async function _handleHistorySpoolAssign(raw, baseUrl, hostname) {
  // ★ リレー子（satellite）では履歴フィラメント指定は未対応（複合操作のRPC未実装）。
  if (typeof window !== "undefined" && window._3dpmonRelayChild === true) {
    const { showAlert } = await import("./dashboard_notification_manager.js");
    showAlert("履歴のフィラメント指定は親機でのみ操作できます", "warn");
    return;
  }
  const materialUsedMm = raw.usagematerial || 0;
  const result = await showHistoryFilamentDialog({
    hostname, materialUsedMm, currentSpoolId: null, jobId: String(raw.id)
  });
  if (!result) return;
  const { spool: newSp } = result;
  // ★ ADR-0004 + Option1（手動編集=権威）: 「指定」は過去ジョブへスプールを後付け帰属する操作。
  //   filamentInfo を書き込んでから recomputeSpoolFromManualEdit で総量基準に残量を再計算する
  //   （= 総量 − 当該スプールに明示帰属する全完了ジョブの消費）。インポート済み履歴でも即反映。
  _applyFilamentToRaw(raw, getSpoolById(newSp.id) || newSp);
  // 保存済み履歴を直接更新
  _patchHistoryFilament(raw, hostname);
  _recomputeAndRefreshSpool(newSp.id, Date.now());
  saveUnifiedStorage(true);
  const updatedSp = getSpoolById(newSp.id) || newSp;
  // 現在印刷中ジョブなら機器装着スプール・プレビューも連動
  _linkCurrentPrintSpool(raw, updatedSp, hostname);
  // パネルのフィラメントプレビューを更新
  const hostPreview = window._filamentPreviews?.get(hostname);
  if (hostPreview) updateFilamentPreview(updatedSp, hostPreview);
  // UI 再描画
  const allJobs = loadHistory(hostname);
  renderHistoryTable(jobsToRaw(allJobs), baseUrl, hostname);
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
  const thumbUrl = resolveThumbUrl(hostname, raw.rawFilename || raw.filename, raw.thumbUrl);
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
  // ★ J: 印刷後処理時間（進捗100%→完了。立ち会えたときのみ実測値あり）
  const postSec = raw.postProcessingTime != null ? Number(raw.postProcessingTime) : null;
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
  // 後処理は 0 でも「実測したが≈0(K1-Max 等)」を示すため値があれば表示
  if (postSec != null) addCard("後処理", formatDuration(postSec), "");
  if (materialFmt) addCard("消費量", materialFmt.display, "");
  // 観測フラグ: live=実測 / partial=途中参加 / 既定(history)=取れなかった
  if (raw.observed === "partial") addCard("観測", "途中参加", "区間時間は一部のみ");

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
  const spool          = getCurrentSpool(hostname);
  const materialContext = createMaterialPrintContext(hostname);
  const hasCfsSupply  = materialContext.hasCfsSupply;
  const useK2CfsPrintStart = getPrinterType(hostname) === "creality-k2" &&
    materialContext.displayMode === MATERIAL_DISPLAY_MODE.MULTI_SLOT;
  const k2CfsAssignmentModel = useK2CfsPrintStart
    ? createK2CfsPrintAssignmentDialogModel(raw, materialContext)
    : null;
  const remaining      = spool?.remainingLengthMm ?? 0;

  // ファイル別の過去実績
  const insight = buildFileInsight(raw.filename || raw.rawFilename || "", hostname);
  const filename = (raw.filename || "").split("/").pop();
  const safeFilename = escapePrintDialogHtml(filename);
  const safeThumbUrl = escapePrintDialogHtml(thumbUrl || THUMB_PLACEHOLDER);

  // GCode メタデータ (アップロード時に抽出済み)
  // ★ per-host キャッシュ: ホスト名プレフィックス付きで取得（同名ファイルのメタデータ混在を防止）
  const gcMeta = raw._gcodeMeta || _gcodeMetaCache.get(`${hostname}:${filename}`) || _gcodeMetaCache.get(filename) || {};

  // ★ 必要フィラメント量（正確な値を優先順で選択）
  //   1. 成功印刷の実績平均 — 最も信頼性が高い
  //   2. GCode メタデータの推定値 — アップロード時に解析済み
  //   3. raw.usagematerial — 履歴の実消費量（失敗時は過少になるため最低優先）
  let materialNeeded, materialSource;
  let materialUnreliable = false; // 信頼性の低いデータフラグ
  if (insight?.avgMaterialMm > 0) {
    materialNeeded = insight.avgMaterialMm;
    materialSource = "実績ベース";
  } else if (gcMeta.filamentMm > 0) {
    materialNeeded = gcMeta.filamentMm;
    materialSource = "GCode見積";
  } else {
    materialNeeded = Number(raw.usagematerial || 0);
    if (materialNeeded > 0) {
      // 過去の印刷実績（成功/失敗/途中）から消費量を推定
      if (raw.printfinish === 1) {
        materialSource = "機器報告";
      } else if (insight?.totalCount > 0) {
        // 印刷実績はあるが成功がない → 部分消費値
        materialUnreliable = true;
        materialSource = "⚠ 途中消費の参考値";
      } else {
        // 一度も印刷していない or 不明
        materialUnreliable = true;
        materialSource = "⚠ 参考値（実績なし）";
      }
    }
  }

  const afterRemaining = remaining - materialNeeded;
  const isShort        = remaining > 0 && materialNeeded > remaining;

  // フィラメント量を人間可読にフォーマット
  const fmtNeed  = formatFilamentAmount(materialNeeded, spool);
  const fmtRemain = formatRemainingFilamentAmount(remaining, spool);
  const fmtAfter = formatRemainingFilamentAmount(afterRemaining, spool);

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
  html += `<img src="${safeThumbUrl}" class="pm-print-thumb" onerror="this.onerror=null;this.src='${THUMB_PLACEHOLDER}'">`;
  html += `<div><strong class="pm-print-filename">${safeFilename}</strong></div></div>`;

  // スプール未装着警告。CFS/CFS-Cの実機slotが観測済みの場合は、台帳スプール未装着を
  // 物理フィラメント未装着として扱わず、read-only CFS観測として別表示にする。
  if (!spool && !hasCfsSupply && !useK2CfsPrintStart) {
    html += `<div class="pm-print-section pm-print-warn-section">`;
    html += `<div class="pm-print-section-title">⚠ スプール未装着</div>`;
    html += `<div>フィラメント管理でスプールを装着してから印刷することを推奨します。</div>`;
    html += `<div>消費量の追跡・残量計算ができません。</div>`;
    html += `</div>`;
  } else if (hasCfsSupply || useK2CfsPrintStart) {
    const sectionClass = materialContext.stale ? "pm-print-warn-section" : "pm-print-info-section";
    html += `<div class="pm-print-section ${sectionClass}">`;
    const cfsSectionTitle = hasCfsSupply
      ? `${materialContext.stale ? "⚠ " : ""}CFS/CFS-C供給を観測`
      : "CFS/CFS-C供給を取得待ち";
    html += `<div class="pm-print-section-title">${cfsSectionTitle}</div>`;
    if (materialContext.selectedLabel) {
      html += `<div>選択中: <strong>${escapePrintDialogHtml(materialContext.selectedLabel)}</strong></div>`;
    } else {
      html += `<div>装填済みスロット: <strong>${materialContext.loadedRows.length}</strong>件</div>`;
    }
    if (materialContext.stale) {
      html += `<div>現在のCFS情報は最終観測値です。プリンタ本体の表示も確認してください。</div>`;
    }
    html += `<div>3DPmon台帳スプールは未連携のため、正確な残量台帳計算は後続Gateで扱います。</div>`;
    html += `</div>`;
    if (k2CfsAssignmentModel) {
      html += k2CfsAssignmentModel.html;
    }
  }

  // 素材ミスマッチ警告
  if (materialMismatch) {
    html += `<div class="pm-print-section pm-print-danger-section">`;
    html += `<div class="pm-print-section-title">🚨 素材不一致</div>`;
    html += `<div>GCode 指定: <strong>${escapePrintDialogHtml(gcodeMaterial)}</strong></div>`;
    html += `<div>装着スプール: <strong>${escapePrintDialogHtml(spoolMaterial)}</strong></div>`;
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
  } else {
    // 成功実績なし — GCodeメタ or 履歴filamentInfo からフォールバック表示
    // 履歴の filamentInfo から素材情報を補完
    let effectiveMeta = gcMeta;
    if (Object.keys(effectiveMeta).length === 0 && Array.isArray(raw.filamentInfo) && raw.filamentInfo.length > 0) {
      const fi = raw.filamentInfo[0];
      effectiveMeta = {};
      if (fi.materialName) effectiveMeta.material = fi.materialName;
      if (fi.weight) effectiveMeta.filament = `${fi.weight}g`;
      if (fi.length) effectiveMeta.filamentMm = fi.length;
    }
    const metaHtml = _buildMetaHtml(effectiveMeta);
    if (metaHtml) {
      html += `<div class="pm-print-section pm-print-neutral-section">`;
      html += `<div class="pm-print-section-title">📄 GCode 情報</div>`;
      html += metaHtml;
      html += `</div>`;
    }
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
  html += `<div>必要量: ${fmtNeed.display}${materialSource ? ` (${materialSource})` : ""}</div>`;
  if (materialUnreliable) {
    html += `<div class="pm-print-alert-danger">⚠ この印刷物の成功実績がまだないため、参考値を表示しています。実際の必要量は異なる可能性があります。</div>`;
  }
  if (estSec > 0) {
    html += `<div>予想所要: ${formatDuration(estSec)} (${durLabel})</div>`;
    html += `<div>予想完了: ${expectedFinish}</div>`;
  }
  html += `</div>`;

  // ダイアログレベルと確認ボタンを危険度に応じて変更
  let dialogLevel = "info";
  let confirmLabel = "印刷する";
  if (k2CfsAssignmentModel?.disabledReason) {
    dialogLevel = "warnRed";
    confirmLabel = "OK";
  } else if (useK2CfsPrintStart) {
    dialogLevel = "info";
    confirmLabel = "CFS割当で印刷する";
  } else if (materialMismatch) {
    dialogLevel = "warnRed";
    confirmLabel = "🚨 素材不一致 — それでも印刷する";
  } else if (isShort) {
    dialogLevel = "warnRed";
    confirmLabel = "⚠ 不足の可能性あり — それでも印刷する";
  } else if (!spool && !hasCfsSupply) {
    dialogLevel = "warn";
    confirmLabel = "スプール未装着のまま印刷する";
  } else if (materialContext.stale) {
    dialogLevel = "warn";
    confirmLabel = "最終観測CFS情報のまま印刷する";
  }

  const ok = await showConfirmDialog({
    level:       dialogLevel,
    title:       "印刷実行の確認",
    html,
    confirmText: confirmLabel,
    cancelText:  "キャンセル"
  });
  if (!ok) return;
  if (k2CfsAssignmentModel?.disabledReason) {
    return;
  }

  if (spool && !useK2CfsPrintStart) {
    useFilament(materialNeeded, "", hostname);
  }

  // 実際にプリントコマンドを送信
  const target = raw.rawFilename ?? raw.filename;
  if (useK2CfsPrintStart && k2CfsAssignmentModel) {
    let commandIdForCleanup = null;
    try {
      const assignments = readK2CfsPrintAssignmentsFromDialog(k2CfsAssignmentModel);
      const request = createK2CfsPrintStartRequestFromUi({
        hostname,
        raw,
        dialogModel: k2CfsAssignmentModel,
        assignments,
      });
      commandIdForCleanup = request.commandId;
      let pendingRegistered = false;
      let submittedAt = null;
      await sendK2CfsPrintStartRequest(hostname, request, {
        onBeforeTransportDispatch: () => {
          const materialBindingPlan = createK2CfsMaterialBindingPlanFromPrintStartRequest(request);
          rememberMaterialAccountingPrintStartRequest({
            hostname,
            commandRequest: request,
            materialBindingPlan,
            preparedAt: new Date().toISOString(),
          });
          pendingRegistered = true;
          submittedAt = new Date().toISOString();
        },
      });
      if (pendingRegistered) {
        await markMaterialAccountingPrintStartRequestSubmitted({
          hostname,
          commandId: request.commandId,
          submittedAt,
        });
      }
      pushLog("K2/CFS印刷開始: colorMatch → multiColorPrint を送信しました", "send", false, hostname);
    } catch (error) {
      forgetMaterialAccountingPrintStartRequest({ hostname, commandId: commandIdForCleanup });
      pushLog(`K2/CFS印刷開始を中止しました: ${error.message}`, "error", false, hostname);
      await showConfirmDialog({
        level: "error",
        title: "CFS印刷開始失敗",
        message: error.message,
        confirmText: "OK",
      });
    }
    return;
  }
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

  // 重複警告セクション（per-host で詳細表示）
  if (exists) {
    html += `<div class="pm-print-section pm-print-warn-section">`;
    html += `<div class="pm-print-section-title">⚠ ファイル重複</div>`;
    const names = existsHosts.map(h => {
      const m = monitorData.machines[h];
      return m?.storedData?.hostname?.rawValue || h;
    });
    if (existsHosts.length === 1) {
      html += `<div><strong>${names[0]}</strong> に同名ファイルが存在します（上書きされます）</div>`;
    } else {
      html += `<div>${existsHosts.length}台に同名ファイルが存在します（上書きされます）</div>`;
      html += `<div class="pm-print-remain-label">${names.join(", ")}</div>`;
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

  // ★ このパネルの進捗 UI 要素を per-host レジストリへ登録。
  //   アップロード進捗は「対象ホスト自身のパネル」へ表示するため、
  //   _uploadToHost などはこのレジストリを参照する（特定パネル固定の排除）。
  if (hostname) {
    _uploadPanelRegistry.set(hostname, { btn, progress, percentEl });
  }

  let currentFile = null;

  /* 進捗バー操作はモジュールレベルの per-host ヘルパー
     (_showHostProgress / _updateHostProgress / _hideHostProgress) に一本化。
     かつての panel-closure 版 (showProgress/hideProgress/updateProgress) は
     「最初に初期化されたパネル固定」コンタミネーションの原因のため廃止。 */

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
  function readFile(file, onProgress) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onprogress = e => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total);
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
    // ★ ローカルファイル読み込みフェーズの進捗は、登録済み全パネルに等しく表示する
    //   （D&D には起点パネルが無いため特定パネル固定を避ける）。
    const registeredHosts = Array.from(_uploadPanelRegistry.keys());
    _setBtnDisabledForHosts(registeredHosts, true);
    _showProgressForHosts(registeredHosts);
    const onReadProgress = (loaded, total) => {
      for (const h of registeredHosts) _updateHostProgress(h, loaded, total);
    };
    let thumb;
    let gcMeta = {};
    try {
      const text = await readFile(file, onReadProgress);
      onReadProgress(file.size, file.size);
      thumb = extractThumb(text);
      gcMeta = _extractGcodeMeta(text);
      // ★ ここでは抽出のみ。キャッシュ書き込みはアップロード先(targets)確定後に
      //   全ホストへ行う（後段参照）。単一ホストキーへの先行書き込みは
      //   「平均時間が1番目の機器にしか登録されない」コンタミネーションの原因だった。
    } catch (e) {
      _hideProgressForHosts(registeredHosts);
      _setBtnDisabledForHosts(registeredHosts, false);
      console.error(e);
      showConfirmDialog({
        level: "error",
        title: "ファイル読み込み失敗",
        message: e.message,
        confirmText: "OK"
      });
      return;
    }
    _hideProgressForHosts(registeredHosts);
    _setBtnDisabledForHosts(registeredHosts, false);

    // 接続中プリンタ一覧（D&D版と同じロジック）
    const allHosts = Object.keys(monitorData.machines).filter(
      h => h !== "_$_NO_MACHINE_$_"
        && monitorData.machines[h]?.storedData
        && getConnectionState(h) === "connected"
    );

    // ★ サムネイル欠落時はローカル代替（data-URI）を使う。機器固定パス(defData)は
    //   K1 にしか無く Moonraker では 404 になるため、機種非依存の代替で 404 を避ける。
    if (!thumb) {
      thumb = THUMB_PLACEHOLDER;
    }

    // ★ 接続中ホストが0台なら即エラー
    if (allHosts.length === 0) {
      showConfirmDialog({
        level: "error",
        title: "アップロード不可",
        message: "接続中のプリンタがありません。接続設定を確認してください。",
        confirmText: "OK"
      });
      return;
    }

    // 各ホストでの重複チェック（per-host で個別判定）
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
        <div class="pm-print-section pm-print-neutral-section">
          <div class="pm-print-section-title">🖨 送信先</div>
          <div><strong>${name}</strong>${dup}</div>
        </div>`;
    } else if (allHosts.length > 1) {
      const checkboxes = allHosts.map(h => {
        const m = monitorData.machines[h];
        const name = m.storedData?.hostname?.rawValue || h;
        const dup = existsHosts.includes(h) ? ' <span class="pm-upload-dup-tag">(上書き)</span>' : "";
        return `<label class="pm-upload-host-label"><input type="checkbox" class="pm-upload-host-chk" value="${h}" checked> ${name}${dup}</label>`;
      }).join("");
      hostSelectHtml = `
        <div class="pm-print-section pm-print-neutral-section">
          <div class="pm-print-section-title">🖨 送信先</div>
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
          // ★ 1件も選択されていなければ空配列。直後の「送信先未選択」エラーで止める。
          //   かつては [hostname]（最初のホスト）にフォールバックし、全解除しても
          //   最初の機器にだけ送信されるコンタミネーション欠陥だった。
          _lastSelectedUploadHosts = [...checked].map(el => el.value);
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
      ? _lastSelectedUploadHosts
      : allHosts;

    // ★ 全チェックを外して確認した場合はキャンセル扱い
    if (targets.length === 0) {
      showConfirmDialog({
        level: "warn",
        title: "送信先未選択",
        message: "アップロード先のプリンタが選択されていません。",
        confirmText: "OK"
      });
      return;
    }

    // ★ gcode メタ（印刷予定秒数など）を「アップロードする全ホスト」のキャッシュへ登録。
    //   renderFileList は `${host}:${basename}` キーで平均時間を引くため、
    //   全ターゲットに書かないと2番目以降の機器で平均時間が "—" になる。
    if (registerGcodeMetaForHosts(_gcodeMetaCache, targets, file.name, gcMeta) > 0) {
      _saveGcodeMetaCache();
    }

    // ★ 進捗は「アップロード先の各ホスト自身のパネル」へ表示する。
    //   各 _uploadToHost が対象ホストの進捗を更新するため、全機器が平等に
    //   自分のパネルで進捗を確認できる（特定パネルへの固定を排除）。
    _setBtnDisabledForHosts(targets, true);
    _showProgressForHosts(targets);
    for (const h of targets) _updateHostProgress(h, 0, file.size);

    // 全ホストへ並行アップロード + 結果サマリー
    const results = await Promise.all(
      targets.map(h => _uploadToHost(file, h))
    );
    _hideProgressForHosts(targets);
    _setBtnDisabledForHosts(targets, false);

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
      // ★ 進捗は対象ホスト自身のパネルへ反映（特定パネルへの固定を排除）
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) _updateHostProgress(targetHost, e.loaded, e.total);
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

  // ★ D&D ドロップ時のファイル処理関数をモジュールレベル参照へ登録（毎回上書き）。
  //   prepareAndConfirm は進捗を per-host、送信先を allHosts 動的取得で扱う
  //   host 非依存処理になっているため、どのパネルが登録したものでも等価。
  //   かつてはドキュメント drop ハンドラが最初のパネルのクロージャを永続
  //   キャプチャしており、最初のホストの UI・hostname で処理されていた。
  _dropFileHandler = prepareAndConfirm;

  // ドキュメント全体のドラッグ&ドロップは1度だけ登録（host 非依存）
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

      // ★ 最新の host 非依存ハンドラ経由で処理（最初のパネル固定を排除）
      _dropFileHandler?.(file);
    });
  }

  if (dropClose) dropClose.addEventListener("click", hideDropLayer);
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
    const isSuccess = job.printfinish === 1;
    const entry = map.get(key) || {
      md5: job.filemd5 || "",
      count: 0,           // 全印刷回数
      successCount: 0,    // 成功印刷回数
      totalSec: 0,        // 成功印刷の合計秒数（平均算出用）
      failCount: 0        // 失敗印刷回数（参考表示用）
    };
    if (!entry.md5 && job.filemd5) entry.md5 = job.filemd5;
    entry.count++;
    if (isSuccess) {
      // ★ 成功印刷のみを平均値の算出対象にする
      //    失敗/中断は途中で止めた時間・量なので平均を汚染する
      entry.successCount++;
      entry.totalSec += sec;
    } else {
      entry.failCount++;
    }
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
    } else if (j.printfinish == null) {
      // 進行中/不明（printfinish が null/undefined）: 統計対象外
      continue;
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

  // ★ 進行中/不明（printfinish == null）を除外した確定済み印刷数
  const printCount = successCount + failCount;
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
  // ★ Moonraker 等は K1 の区切り文字列ではなく、解析済みエントリ配列(info.entries)を
  //   直接供給できる。供給があればそれを使い、無ければ従来の fileInfo 文字列を解析する。
  const arr = Array.isArray(info.entries)
    ? info.entries.slice()
    : parseFileInfo(info.fileInfo, baseUrl);

  // 最新の一覧をアップロード検証用に保持
  _fileListMap.set(hostname, arr.slice());

  // 履歴から印刷回数と実使用時間を取得
  const stats = buildHistoryStats(hostname);
  arr.forEach(item => {
    item.thumbUrl = resolveThumbUrl(hostname, item.filename || item.basename, item.thumbUrl);
    const st = stats.get(item.filename);
    if (st) {
      item.filemd5 = st.md5;
      item.printCount = st.count;
      // ★ 成功印刷のみの平均時間を使用（失敗/中断の途中データを排除）
      if (st.successCount > 0) {
        item.usagetime = Math.round(st.totalSec / st.successCount);
      }
    }
    // 履歴が無い場合、アップロード時に抽出した GCode メタデータをフォールバック
    const cached = _gcodeMetaCache.get(`${hostname}:${item.basename}`) || _gcodeMetaCache.get(item.basename);
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

  arr.forEach((item, index) => {
    const tr = document.createElement("tr");
    tr.className = "file-row";
    tr.dataset.rowIndex = String(index);
    const md5short = item.filemd5 ? item.filemd5.substring(0, 8) : "";
    // 更新日時を YYYY/MM/DD HH:MM:SS 形式にフォーマット
    const d = item.mtime;
    const mtimeStr = d instanceof Date && !isNaN(d)
      ? `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`
      : "—";

    // ファイル別実績
    const insight = buildFileInsight(item.filename, hostname);
    // ★ 単位トグル(m/mm)に応じて予定量を表示（ファイル一覧は g/¥ 換算なし）
    const _unit = monitorData.appSettings.filamentUnit === "mm" ? "mm" : "m";
    const expectHtml = formatUsageHtml(item.expect, null, _unit);

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
          style="width:40px;min-height:40px"
          loading="lazy"
          decoding="async"
          onerror="this.onerror=null;this.src='${THUMB_PLACEHOLDER}'"
        >
      </td>
      <td data-key="filename">${item.basename}</td>
      <td data-key="layer">${item.layer.toLocaleString()}</td>
      <td data-key="size">${item.size.toLocaleString()}</td>
      <td data-key="mtime">${mtimeStr}</td>
      <td data-key="expect" class="usage-cell" data-mm="${item.expect != null ? item.expect : ''}">${expectHtml}</td>
      <td data-key="prints">${printsLabel}</td>
      <td data-key="avgtime">${avgTimeLabel}</td>
      <td data-key="md5" class="col-md5" title="${item.filemd5 || ''}">${md5short}</td>
    `;
    tbody.appendChild(tr);
  });

  // ★ 描画律速対策: 行ごとの addEventListener を tbody 1個のイベント委譲へ集約。
  //   行特定は data-row-index → _fileCtx.arr[index]。tbody は永続するため 1度だけバインド。
  tbody._fileCtx = { arr, hostname };
  if (!tbody._fileDelegated) {
    tbody._fileDelegated = true;
    tbody.addEventListener("click", _fileTbodyClick);
  }

  // ソート用リスナ + インジケータ
  if (fileTable) {
    _bindSortHeaders(fileTable, "file-list-table", hostname);
  }
  pushLog("[renderFileList] UI へ反映しました", "info", false, hostname);
}

/**
 * ファイル一覧 tbody のクリックを委譲処理する単一ハンドラ。
 * 行は data-row-index → _fileCtx.arr[index] で特定する。
 *
 * @private
 * @param {MouseEvent} ev
 * @returns {void}
 */
function _fileTbodyClick(ev) {
  const tbody = ev.currentTarget;
  const ctx = tbody?._fileCtx;
  if (!ctx) return;
  const { arr, hostname } = ctx;
  const trEl = ev.target.closest("tr.file-row");
  if (!trEl) return;
  const item = arr[Number(trEl.dataset.rowIndex)];
  if (!item) return;
  if (ev.target.closest(".cmd-print"))  { handlePrintClick(item, item.thumbUrl, hostname); return; }
  if (ev.target.closest(".cmd-rename")) { handleRenameClick(item, hostname); return; }
  if (ev.target.closest(".cmd-delete")) { handleDeleteClick(item, hostname); return; }
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
