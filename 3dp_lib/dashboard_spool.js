/** 2025-06-22 13:06:00
 * @description 3Dプリンタ監視ツール 3dpmon 用 フィラメントスプール管理モジュール
 * @file dashboard_spool.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_spool
 *
 * 【機能内容サマリ】
 * - 材料密度変換やスプール一覧の管理
 * - 使用量更新・現在スプール設定
 *
 * 【公開関数一覧】
 * - {@link getMaterialDensity}：密度取得
 * - {@link lengthFromWeight}：重量→長さ変換
 * - {@link weightFromLength}：長さ→重量変換
 * - {@link getSpools}：スプール一覧取得
 * - {@link getSpoolById}：ID指定取得
 * - {@link getCurrentSpoolId}：現在ID取得
 * - {@link getCurrentSpool}：現在スプール取得
 * - {@link setCurrentSpoolId}：現在ID設定
 * - {@link addSpool}：スプール追加
 * - {@link updateSpool}：スプール更新
 * - {@link deleteSpool}：スプール削除
 * - {@link useFilament}：使用量反映
 * - {@link beginExternalPrint}：外部開始印刷初期化
 * - {@link reserveFilament}：使用量予約
 * - {@link finalizeFilamentUsage}：使用量確定
 * - {@link autoCorrectCurrentSpool}：履歴から残量補正
 *
* @version 1.390.787 (PR #367)
* @since   1.390.193 (PR #86)
* @lastModified 2026-03-12
 * -----------------------------------------------------------
 * @todo
 * - none
*/

"use strict";

import {
  monitorData,
  setStoredDataForHost
} from "./dashboard_data.js";
import { saveUnifiedStorage, trimUsageHistory } from "./dashboard_storage.js";
import {
  appendMountEvent,
  appendUnmountEvent,
  reconcileSpool,
  getOpenFilamentEvent,
  resolveFilamentEvent,
  deriveSpoolRemaining
} from "./dashboard_filament_ledger.js";
import { consumeInventory } from "./dashboard_filament_inventory.js";
import { updateStoredDataToDOM } from "./dashboard_ui.js";
import { updateHistoryList, loadHistory, saveHistory } from "./dashboard_printmanager.js";
import { getDisplayBaseUrl } from "./dashboard_connection.js";

/**
 * ADR-0005: 一時停止の印刷状態コード（dashboard_ui_mapping.js の
 * PRINT_STATE_CODE.printPaused=5 と同値）。ui_mapping は notification_manager 等の
 * 重い依存を持つため、循環/重依存 import を避けてここでローカル定義する。
 * @private
 */
const _PRINT_PAUSED = 5;

/**
 * aggregator の rebaselineHostUsage アクセサ（循環参照回避用）。
 * boot 時に {@link registerRebaselineHostUsage} で設定される。未設定時は no-op。
 * @private
 * @type {?Function}
 */
let _rebaselineHostUsage = null;

/**
 * aggregator の rebaselineHostUsage を登録する（boot 時、循環 import 回避）。
 *
 * @param {Function} fn - rebaselineHostUsage(host, {accumulated, prevUsed})
 * @returns {void}
 */
export function registerRebaselineHostUsage(fn) {
  _rebaselineHostUsage = fn;
}

/**
 * スプールのライフサイクル状態定数
 * @enum {string}
 */
export const SPOOL_STATE = {
  /** 登録済み・未装着（開封直後、まだプリンタに装着されていない） */
  INVENTORY:  "inventory",
  /** プリンタに装着中 */
  MOUNTED:    "mounted",
  /** 取り外して保管中（残量あり、再利用可能） */
  STORED:     "stored",
  /** 残量ゼロ近く（使い切り） */
  EXHAUSTED:  "exhausted",
  /** 廃棄済み（ソフトデリート） */
  DISCARDED:  "discarded"
};

/** 使い切り判定の閾値 [mm]（約 0.3g PLA 相当） */
const EXHAUSTED_THRESHOLD_MM = 100;

/**
 * スプールオブジェクトの現在のライフサイクル状態を返す。
 * 既存のブーリアンフラグ群から状態を導出する。
 *
 * @param {Object} spool - スプールオブジェクト
 * @returns {string} SPOOL_STATE の値
 */
export function getSpoolState(spool) {
  if (!spool) return SPOOL_STATE.INVENTORY;
  if (spool.deleted || spool.isDeleted) return SPOOL_STATE.DISCARDED;
  if (spool.isActive) return SPOOL_STATE.MOUNTED;
  if (spool.removedAt) {
    return (spool.remainingLengthMm ?? 0) <= EXHAUSTED_THRESHOLD_MM
      ? SPOOL_STATE.EXHAUSTED
      : SPOOL_STATE.STORED;
  }
  return SPOOL_STATE.INVENTORY;
}

/**
 * スプールの状態に対応する日本語ラベルを返す。
 *
 * @param {string} state - SPOOL_STATE の値
 * @returns {string} 日本語ラベル
 */
export function getSpoolStateLabel(state) {
  switch (state) {
    case SPOOL_STATE.INVENTORY:  return "未使用";
    case SPOOL_STATE.MOUNTED:    return "装着中";
    case SPOOL_STATE.STORED:     return "保管中";
    case SPOOL_STATE.EXHAUSTED:  return "使い切り";
    case SPOOL_STATE.DISCARDED:  return "廃棄済";
    default: return "不明";
  }
}

/**
 * スプールの人間可読な表示IDを返す。
 * serialNo をゼロパディングして `#001` 形式にフォーマットする。
 *
 * @param {Object} spool - スプールオブジェクト
 * @returns {string} 表示用ID（例: "#001"）
 */
export function formatSpoolDisplayId(spool) {
  if (!spool) return "#???";
  return `#${String(spool.serialNo || 0).padStart(3, "0")}`;
}

/**
 * 素材ごとの密度 [g/cm³]。
 * 重量⇔長さ変換に使用。キーは大文字小文字区別なしで照合すべき。
 * @type {Object.<string, number>}
 */
export const MATERIAL_DENSITY = {
  PLA: 1.24,
  "PLA+": 1.24,
  "PLA Silk": 1.24,
  PETG: 1.27,
  "PETG-CF": 1.35,
  ABS: 1.04,
  ASA: 1.07,
  TPU: 1.20,
  PA: 1.14,
  Nylon: 1.14,
  PC: 1.20,
  PVA: 1.19,
  HIPS: 1.04
};

/**
 * 素材名から密度を取得する。大文字小文字を区別せずに照合する。
 * 一致しない場合は PLA の密度をフォールバック値として返す。
 * @param {string} mat - 素材名
 * @returns {number} 密度 [g/cm³]
 */
export function getMaterialDensity(mat) {
  if (!mat) return MATERIAL_DENSITY.PLA;
  // 完全一致
  if (MATERIAL_DENSITY[mat] != null) return MATERIAL_DENSITY[mat];
  // 大文字小文字非依存で検索
  const upper = mat.toUpperCase();
  for (const [key, val] of Object.entries(MATERIAL_DENSITY)) {
    if (key.toUpperCase() === upper) return val;
  }
  return MATERIAL_DENSITY.PLA;
}

export function lengthFromWeight(weightGram, density, diameterMm = 1.75) {
  const d = density || MATERIAL_DENSITY.PLA;
  const area = Math.PI * (diameterMm / 2) ** 2; // mm^2
  return (weightGram * 1000) / (area * d); // mm
}

export function weightFromLength(lengthMm, density, diameterMm = 1.75) {
  const d = density || MATERIAL_DENSITY.PLA;
  const area = Math.PI * (diameterMm / 2) ** 2; // mm^2
  return (area * lengthMm * d) / 1000; // g
}

/**
 * フィラメント量 (mm) を人間可読な複数単位に変換する。
 *
 * spool が渡された場合はグラム・コスト換算も含む。
 * 表示用フォーマットであり、元データの精度は保持する。
 *
 * @function formatFilamentAmount
 * @param {number} mm - フィラメント量 (mm)
 * @param {Object} [spool] - スプールオブジェクト (density, purchasePrice, totalLengthMm, material, filamentDiameter, currencySymbol)
 * @returns {{ mm: number, m: string, g: string|null, cost: string|null, currency: string, display: string }}
 */
export function formatFilamentAmount(mm, spool = null) {
  // ★ B4: undefined/NaN を 0 にマスクしない（追跡失敗を隠さない）
  const val = Number(mm);
  if (!Number.isFinite(val)) {
    return { mm: null, m: "---", g: null, cost: null, currency: "", display: "---" };
  }
  const m = (val / 1000).toFixed(1);

  let g = null;
  let cost = null;
  let currency = "¥";

  if (spool) {
    const density = spool.density || getMaterialDensity(spool.material || spool.materialName);
    const diameter = spool.filamentDiameter || 1.75;
    const w = weightFromLength(val, density, diameter);
    g = w.toFixed(0);
    currency = spool.currencySymbol || "¥";

    if (spool.purchasePrice > 0 && spool.totalLengthMm > 0) {
      const ratio = val / spool.totalLengthMm;
      cost = (spool.purchasePrice * ratio).toFixed(0);
    }
  }

  // 表示文字列の組み立て
  let display = `${m}m`;
  if (g != null) {
    display += cost != null ? ` (${g}g, ${currency}${cost})` : ` (${g}g)`;
  }

  return { mm: val, m, g, cost, currency, display };
}

/**
 * 使用量を「距離」と「(重量, 費用)」の2段に分けた HTML を返す。
 *
 * - 単位トグル(unit)に応じて距離を m / mm 表示で切り替える。
 * - スプールが渡され重量/費用が算出できる場合は2行目に括弧表示。
 * - 右寄せ・改行は呼び出し側CSS(.usage-cell)で制御する。
 *
 * @function formatUsageHtml
 * @param {number} mm - フィラメント量 (mm)
 * @param {Object|null} spool - スプール（g/¥算出用、無ければ距離のみ）
 * @param {string} [unit="m"] - "m" | "mm"
 * @returns {string} 2段表示の HTML 文字列
 */
export function formatUsageHtml(mm, spool = null, unit = "m") {
  const f = formatFilamentAmount(mm, spool);
  if (f.mm == null) return `<span class="usage-dist">---</span>`;
  const distance = unit === "mm"
    ? `${Math.round(f.mm)}mm`
    : `${f.m}m`;
  let second = "";
  if (f.g != null) {
    second = f.cost != null ? `(${f.g}g, ${f.currency}${f.cost})` : `(${f.g}g)`;
  }
  const distHtml = `<span class="usage-dist">${distance}</span>`;
  return second
    ? `${distHtml}<span class="usage-sub">${second}</span>`
    : distHtml;
}

/**
 * 使用量カラムのヘッダーラベルを単位に応じて返す。
 *
 * @function usageHeaderLabel
 * @param {string} base - ベース名（"使用量" / "予定量"）
 * @param {string} [unit="m"] - "m" | "mm"
 * @returns {string} 例 "使用量(m)" / "予定量(mm)"
 */
export function usageHeaderLabel(base, unit = "m") {
  return `${base}(${unit === "mm" ? "mm" : "m"})`;
}

/**
 * スプール1つについての消費パターンと予測分析を返す。
 *
 * usedLengthLog・printCount・purchasePrice から
 * コスト効率・消費ペース・枯渇予測を算出する。
 *
 * @function buildSpoolAnalytics
 * @typedef {Object} WasteReport
 * @property {number} totalWastedSpools - 廃棄スプール数
 * @property {number} totalWastedLengthMm - 廃棄フィラメント長 [mm]
 * @property {number} totalWastedWeightGram - 廃棄フィラメント重量 [g]
 * @property {number} totalWastedCost - 廃棄推定損失額
 * @property {Map<string, {length: number, weight: number, cost: number, count: number}>} wastedByMaterial
 * @property {Array<{spool: Object, wastedLength: number, wastedCost: number}>} recentWasted
 */

/**
 * 廃棄スプールの損失レポートを生成する。
 * deleted===true かつ remainingLengthMm > 0 のスプールを対象に、
 * 残量の長さ・重量・推定コストを集計する。
 *
 * @returns {WasteReport} 廃棄ロスレポート
 */
export function buildWasteReport() {
  const allSpools = getSpools();
  const wastedByMaterial = new Map();
  const recentWasted = [];
  let totalLen = 0;
  let totalWeight = 0;
  let totalCost = 0;
  let count = 0;

  for (const sp of allSpools) {
    // 廃棄済みで残量がある（＝ロス発生）スプールのみ対象
    if (!sp.deleted && !sp.isDeleted) continue;
    const remain = sp.remainingLengthMm || 0;
    if (remain <= 0) continue;

    count++;
    const density = getMaterialDensity(sp.materialName || sp.material);
    const wGram = weightFromLength(remain, density, sp.filamentDiameter || 1.75);
    // コストの按分: (残量/総量) × 購入額
    const total = sp.totalLengthMm || 1;
    const price = sp.purchasePrice || 0;
    const wastedCost = total > 0 ? price * (remain / total) : 0;

    totalLen += remain;
    totalWeight += wGram;
    totalCost += wastedCost;

    // 素材別集計
    const mat = sp.materialName || sp.material || "不明";
    if (!wastedByMaterial.has(mat)) {
      wastedByMaterial.set(mat, { length: 0, weight: 0, cost: 0, count: 0 });
    }
    const entry = wastedByMaterial.get(mat);
    entry.length += remain;
    entry.weight += wGram;
    entry.cost += wastedCost;
    entry.count++;

    recentWasted.push({ spool: sp, wastedLength: remain, wastedCost });
  }

  // 直近の廃棄を降順（removedAt が新しい順）でソート
  recentWasted.sort((a, b) => (b.spool.removedAt || 0) - (a.spool.removedAt || 0));

  return {
    totalWastedSpools: count,
    totalWastedLengthMm: totalLen,
    totalWastedWeightGram: totalWeight,
    totalWastedCost: totalCost,
    wastedByMaterial,
    recentWasted
  };
}

/**
 * @param {string} spoolId - スプール ID
 * @returns {Object|null} 分析結果。スプール未発見時は null
 */
export function buildSpoolAnalytics(spoolId) {
  const spool = getSpoolById(spoolId);
  if (!spool) return null;

  const totalMm = spool.totalLengthMm || 0;
  const remainMm = spool.remainingLengthMm || 0;
  const consumedMm = Math.max(0, totalMm - remainMm);
  const consumedPct = totalMm > 0 ? (consumedMm / totalMm) * 100 : 0;
  const printCount = spool.printCount || 0;

  // ★ 成功印刷回数を usageHistory から算出（spool.printCount は成功+失敗の合計）
  let successCount = 0;
  (monitorData.usageHistory || []).forEach(u => {
    if (u.spoolId === spoolId && u.type === "complete") successCount++;
  });
  // usageHistory がない場合は printCount をフォールバック
  if (successCount === 0 && printCount > 0) successCount = printCount;

  const avgPerPrint = successCount > 0 ? consumedMm / successCount : 0;

  // コスト計算（成功印刷ベース）
  const price = spool.purchasePrice || 0;
  const costPerPrint = successCount > 0 && price > 0 ? price / successCount : 0;
  const remainingCost = totalMm > 0 && price > 0 ? price * (remainMm / totalMm) : 0;
  const currency = spool.currencySymbol || "¥";

  // 使用期間
  const startedAt = spool.startedAt || 0;
  const now = Date.now();
  const daysActive = startedAt > 0 ? Math.max(1, (now - startedAt) / (1000 * 60 * 60 * 24)) : 0;
  const printsPerDay = daysActive > 0 ? successCount / daysActive : 0;

  // 枯渇予測（成功印刷ベース）
  const mmPerDay = daysActive > 0 ? consumedMm / daysActive : 0;
  const estimatedRemainingPrints = avgPerPrint > 0 ? Math.floor(remainMm / avgPerPrint) : null;
  const estimatedRemainingDays = mmPerDay > 0 ? Math.round(remainMm / mmPerDay) : null;

  // 消費推移（usedLengthLog からジョブごとの消費を取得）
  const log = Array.isArray(spool.usedLengthLog) ? spool.usedLengthLog : [];

  // 重量換算
  const density = spool.density || getMaterialDensity(spool.material || spool.materialName);
  const diameter = spool.filamentDiameter || 1.75;
  const remainGram = weightFromLength(remainMm, density, diameter);
  const consumedGram = weightFromLength(consumedMm, density, diameter);

  return {
    // 基本
    totalMm, remainMm, consumedMm, consumedPct,
    remainGram: Number(remainGram.toFixed(0)),
    consumedGram: Number(consumedGram.toFixed(0)),
    printCount, successCount, avgPerPrint,
    // コスト
    price, currency, costPerPrint, remainingCost,
    // ペース
    daysActive: Number(daysActive.toFixed(1)),
    printsPerDay: Number(printsPerDay.toFixed(2)),
    mmPerDay: Number(mmPerDay.toFixed(0)),
    // 予測
    estimatedRemainingPrints,
    estimatedRemainingDays,
    // 消費ログ
    usedLengthLog: log,
    material: spool.materialName || spool.material || ""
  };
}

/**
 * スプール識別用の一意な ID を生成する。
 *
 * 日時と乱数を組み合わせた文字列を返す。
 *
 * @private
 * @returns {string} 生成した ID
 */
function genId() {
  return `spool_${Date.now()}_${Math.random().toString(16).slice(2,8)}`;
}

export function getSpools(includeDeleted = false) {
  return includeDeleted ? monitorData.filamentSpools : monitorData.filamentSpools.filter(s => !s.deleted);
}

/**
 * 指定IDに一致するスプール情報を取得する。
 * monitorData.filamentSpools から削除されていないエントリを検索し、
 * 見つかった場合はそのオブジェクトを返す。データの変更は行わない。
 *
 * @function getSpoolById
 * @param {string} id - 取得したいスプールのID
 * @returns {Object|null} - スプールオブジェクト。存在しない場合は null
 */
export function getSpoolById(id) {
  return monitorData.filamentSpools.find(s => s.id === id && !s.deleted) || null;
}

/**
 * 現在設定されているスプールIDを返す。
 * per-host マップ（hostSpoolMap）から取得する。
 * hostname 未指定時は null を返す。
 *
 * @function getCurrentSpoolId
 * @param {string} hostname - 対象ホスト名
 * @returns {string|null} - 現在のスプールID。未設定時は null
 */
export function getCurrentSpoolId(hostname) {
  if (!hostname || hostname === "_$_NO_MACHINE_$_") {
    console.error(`[IMPL_ERROR] getCurrentSpoolId: 異常な機器指定 hostname="${hostname}"`);
    return null;
  }
  if (monitorData.hostSpoolMap[hostname] !== undefined) {
    return monitorData.hostSpoolMap[hostname];
  }
  return null;
}

/**
 * 現在使用中のスプール情報を取得する。
 * hostname が指定された場合は per-host マップから取得する。
 *
 * @function getCurrentSpool
 * @param {string} hostname - 対象ホスト名
 * @returns {Object|null} - 現在のスプールオブジェクト。無い場合は null
 */
export function getCurrentSpool(hostname) {
  return getSpoolById(getCurrentSpoolId(hostname));
}

/**
 * 指定ホストの最後に完了した印刷の printId（数値）を返す。
 * mountHistory の区間下限/上限（sinceJobId/untilJobId）の確定に使う。
 * 完了 = materialUsedMm > 0。printStore.history の id（=開始 epoch 秒）の最大値。
 *
 * @private
 * @param {string} host - ホスト名
 * @returns {number} 最後に完了した printId（無ければ 0）
 */
function _latestCompletedPrintId(host) {
  const machine = monitorData.machines?.[host];
  const hist = machine?.printStore?.history;
  if (!Array.isArray(hist)) return 0;
  let max = 0;
  for (const job of hist) {
    if (!(Number(job?.materialUsedMm || 0) > 0)) continue;
    const pid = Number(job?.id);
    if (Number.isFinite(pid) && pid > max) max = pid;
  }
  return max;
}

/**
 * 完了ジョブの消費量を信頼ソース printStore.history に upsert する（ADR-0004）。
 *
 * reconcile は printStore.history を権威とするため、finalize 完了時に
 * 当該ジョブの materialUsedMm / filamentInfo / printfinish をここで確実に入れて
 * 整合させる。既存エントリがあれば materialUsedMm / filamentInfo を補完し、
 * 無ければ最小限のエントリを作成する。printStore.history が後で reqHistory で
 * 上書き（id union マージ）されてもプリンタ報告値が優先されるため害は無い。
 *
 * @private
 * @param {string} host - ホスト名
 * @param {string} jobId - 完了ジョブID（printId 文字列 = epoch 秒）
 * @param {number} usedMm - 確定消費量(mm)
 * @param {boolean} isSuccess - 成功フラグ
 * @returns {void}
 */
function _upsertHistoryUsage(host, jobId, usedMm, isSuccess) {
  const machine = monitorData.machines?.[host];
  if (!machine) return;
  if (!machine.printStore || typeof machine.printStore !== "object") {
    machine.printStore = { current: null, history: [], videos: {} };
  }
  if (!Array.isArray(machine.printStore.history)) machine.printStore.history = [];
  const hist = machine.printStore.history;
  // printStore.history の id は数値（epoch 秒）。jobId 文字列を数値化して照合・格納。
  const numId = Number(jobId);
  const idVal = Number.isFinite(numId) ? numId : jobId;
  let entry = hist.find(h => String(h.id) === String(jobId));
  if (!entry) {
    entry = { id: idVal };
    hist.push(entry);
  }
  // materialUsedMm はプリンタ確定値を優先（既存があれば尊重し、未設定/0 のみ埋める）
  if (!(Number(entry.materialUsedMm) > 0)) {
    entry.materialUsedMm = usedMm;
  }
  if (entry.printfinish == null) entry.printfinish = isSuccess ? 1 : 0;
  // ★ filamentInfo はここでは書かない。推定 usedMm を filamentInfo に固定すると
  //   reqHistory マージ(FILAMENT_KEYS は null のみ補完)で上書きされず、
  //   attributedUsed が推定値を使い続けてしまうため。単一スプールは materialUsedMm
  //   （reqHistory でプリンタ確定値に置換される）で帰属し、複数スプールの
  //   filamentInfo は finalizeFilamentUsage 本体の履歴記録が担う。
}

/**
 * ADR-0005: 分割（複数リール / 1ジョブ）の per-reel 消費を信頼ソース printStore.history に
 * 反映する。当該リールの filamentInfo エントリ(usedMm)を spoolId 単位で upsert し、
 * materialUsedMm を全リール usedMm の合計（ジョブ総消費）に更新する。
 *
 * 単一スプールジョブには使わない（materialUsedMm をプリンタ確定値に委ねる _upsertHistoryUsage の
 * 方針を維持）。分割が成立したジョブにのみ呼び、derive が各リールを正しく帰属できるようにする。
 *
 * @private
 * @param {string} host - ホスト名
 * @param {string|number} jobId - 対象ジョブID（printId）
 * @param {Object} reelSpool - リールのスプールオブジェクト（id/メタ）
 * @param {number} usedMm - 当該リールの消費量(mm)
 * @returns {void}
 */
function _upsertSplitReel(host, jobId, reelSpool, usedMm) {
  if (!host || !reelSpool) return;
  const machine = monitorData.machines?.[host];
  if (!machine?.printStore || typeof machine.printStore !== "object") return;
  if (!Array.isArray(machine.printStore.history)) machine.printStore.history = [];
  const hist = machine.printStore.history;
  const idStr = String(jobId);
  let entry = hist.find(h => String(h.id) === idStr);
  if (!entry) {
    const numId = Number(jobId);
    entry = { id: Number.isFinite(numId) ? numId : jobId };
    hist.push(entry);
  }
  entry.filamentInfo = Array.isArray(entry.filamentInfo) ? entry.filamentInfo : [];
  const used = Math.max(0, Number(usedMm) || 0);
  const existing = entry.filamentInfo.find(fi => fi && fi.spoolId === reelSpool.id);
  if (existing) {
    existing.usedMm = used;
  } else {
    entry.filamentInfo.push({
      spoolId: reelSpool.id,
      serialNo: reelSpool.serialNo,
      spoolName: reelSpool.name,
      colorName: reelSpool.colorName,
      filamentColor: reelSpool.filamentColor,
      material: reelSpool.material,
      usedMm: used
    });
  }
  // materialUsedMm = 全リール usedMm 合計（ジョブ総消費）
  let total = 0;
  for (const fi of entry.filamentInfo) total += Math.max(0, Number(fi?.usedMm) || 0);
  if (total > 0) entry.materialUsedMm = total;
  if (entry.printfinish == null) entry.printfinish = 1;
}

/**
 * 現在使用するスプールIDを更新し状態を反映する。
 * monitorData.currentSpoolId や対象スプールのフラグを変更し、
 * 必要に応じて履歴情報や残量を更新する副作用がある。履歴補完時は
 * {@link updateHistoryList} を呼び出して保存と UI 更新も行う。
 * さらに印刷途中の交換では ADR-0005 の状態認識つき帰属を行う:
 * 稼働中(printing)=ジョブ全体を新スプールへ帰属（旧の当該ジョブ debit は計上しない）、
 * 一時停止(paused)=分割（旧→切れ時点まで／新→再開後、{@link finalizeFilamentUsage} で旧を確定）。
 * ライブ使用量は aggregator の rebaselineHostUsage で再ベースラインし、0張り付き(B1)を防ぐ。
 *
 * @function setCurrentSpoolId
 * @param {string} id - 新しく設定するスプールID
 * @param {string} hostname - 対象ホスト名
 * @returns {boolean} 設定成功時 true、既に他ホストに装着済みの場合 false
 */
export function setCurrentSpoolId(id, hostname) {
  // ★ hostname ガード: 空/undefined/PLACEHOLDER は即拒否（データ破壊防止）
  if (!hostname || hostname === "_$_NO_MACHINE_$_") {
    console.error(`[IMPL_ERROR] setCurrentSpoolId: 異常な機器指定 hostname="${hostname}", id="${id}"`);
    import("./dashboard_notification_manager.js").then(m =>
      m.showAlert(`プログラム実装エラー: setCurrentSpoolId に異常な機器指定がありました`, "error")
    ).catch(() => {});
    return false;
  }
  const host = hostname;
  let prevId = getCurrentSpoolId(host);

  // hostname が空で hostSpoolMap にエントリがない場合、
  // isActive なスプールから直接取得する (孤立スプールの取り外し用)
  if (prevId == null && id == null) {
    // 取り外し要求だが prevId が見つからない → isActive なスプールを探す
    const orphan = monitorData.filamentSpools.find(s =>
      s.isActive && (!s.hostname || s.hostname === host)
    );
    if (orphan) {
      prevId = orphan.id;
    } else {
      return true; // 取り外すものがない
    }
  }
  if (prevId === id) return true;
  const prevSpool = getSpoolById(prevId);
  const newSpool = getSpoolById(id);

  // 同じスプールが別ホストに既に装着されていないかチェック
  if (id && host && newSpool) {
    for (const [h, spId] of Object.entries(monitorData.hostSpoolMap)) {
      if (spId === id && h !== host) {
        const m = monitorData.machines[h] || {};
        const displayName = m.storedData?.hostname?.rawValue || h;
        console.warn(`setCurrentSpoolId: spool ${id} is already mounted on ${displayName}`);
        return false;
      }
    }
  }

  // per-host 操作: hostname が無い場合はグローバル設定のみ
  const machine = host ? (monitorData.machines[host] || {}) : {};
  const printId = String(machine.printStore?.current?.id ?? "");

  // ★ ADR-0005: 状態認識つき帰属。印刷途中のスプール交換のとき、発生時の状態で
  //   「稼働中(printing) = ジョブ全体→新スプール（旧の当該ジョブ debit は計上しない＝B2是正）」/
  //   「一時停止(paused) = 分割（旧→切れ時点まで, 新→再開後）」を決める。
  const _midPrintSwap = !!(host && prevSpool && newSpool && prevSpool.currentJobStartLength != null);
  // 発生時の状態文脈（aggregator が記録済み）を優先、無ければライブ状態にフォールバック（R5）。
  const _ev = host ? getOpenFilamentEvent(host) : null;
  const _liveState = Number(machine?.runtimeData?.state ?? machine?.storedData?.state?.rawValue ?? 0);
  const _stateForAttr = (_ev && _ev.stateAtEvent != null) ? Number(_ev.stateAtEvent) : _liveState;
  const _runoutConfirmed = !!(_ev && _ev.runout);
  // 区間境界: Lc=最新完了 printId（厳密 > 境界の基点。進行中 printId は使わない）。
  const _Lc = host ? _latestCompletedPrintId(host) : 0;
  // 進行中ジョブ J（分割では旧 unmount until=J）。
  const _J = Number(prevSpool?.currentPrintID || printId) || 0;
  // ライブ使用量基線（プリンタの現ジョブ累積。未取得は consumed-so-far で近似）。
  let _usedAtSwap = Number(machine?.storedData?.usedMaterialLength?.rawValue);
  if (!Number.isFinite(_usedAtSwap) || _usedAtSwap < 0) {
    _usedAtSwap = Math.max(0,
      (Number(prevSpool?.currentJobStartLength) || 0) - (Number(prevSpool?.remainingLengthMm) || 0));
  }
  // 帰属モード決定。同秒衝突(Lc===J)は分割境界が潰れる → 安全側で whole に縮退。
  let _mode = _stateForAttr === _PRINT_PAUSED ? "split" : "whole";
  if (_midPrintSwap && _mode === "split" && _Lc > 0 && _Lc === _J) {
    console.warn(`[setCurrentSpoolId] ${host}: Lc===J(${_J}) 同秒衝突のため分割を whole に縮退`);
    _mode = "whole";
  }

  // 旧スプールの確定（分割のみ。稼働中=全体では旧を中途 finalize しない＝ジョブ全体を新へ帰属）。
  let _Uold = 0;
  if (_midPrintSwap && _mode === "split") {
    const _startLen = Number(prevSpool.currentJobStartLength) || 0;
    const _consumed = Math.max(0, _startLen - (Number(prevSpool.remainingLengthMm) || 0));
    // 切れ確定なら旧スプールを 0 へ駆動（物理的に空）。それ以外は consumed-so-far。
    _Uold = _runoutConfirmed ? _startLen : _consumed;
    finalizeFilamentUsage(_Uold, prevSpool.currentPrintID, host);
  } else if (host && prevSpool && !newSpool && prevSpool.currentJobStartLength != null) {
    // 純粋な取り外し（mid-print だが新スプール無し）: 従来どおり中途確定（残量保全）。
    const _used = Math.max(0,
      (Number(prevSpool.currentJobStartLength) || 0) - (Number(prevSpool.remainingLengthMm) || 0));
    finalizeFilamentUsage(_used, prevSpool.currentPrintID, host);
  }

  // per-host マップを更新（hostSpoolMap が唯一の権威）
  // ★ 存在チェック: id が truthy なら対応スプールが filamentSpools に存在することを確認
  if (id && !newSpool) {
    console.error(`[IMPL_ERROR] setCurrentSpoolId: スプール "${id}" が filamentSpools に存在しません。hostSpoolMap を汚染しません`);
    return false;
  }
  monitorData.hostSpoolMap[host] = id;

  // ★ アトミック更新: 対象ホストのスプールのみ isActive を更新
  //   他ホストに装着中のスプールには絶対に触れない
  if (prevSpool) {
    Object.assign(prevSpool, { isActive: false, isInUse: false });
  }
  if (newSpool) {
    Object.assign(newSpool, { isActive: true, isInUse: true, hostname: host });
  }


  // ★ ADR-0004: 単調増加 ts（同一 tick で mount/unmount を区別できるよう ts と evId を分ける）
  const nowTs = Date.now();

  if (prevSpool) {
    if (Array.isArray(prevSpool.printIdRanges) && prevSpool.printIdRanges.length) {
      const r = prevSpool.printIdRanges[prevSpool.printIdRanges.length - 1];
      if (r && r.endPrintID == null) {
        r.endPrintID = String(printId || prevSpool.currentPrintID || "");
      }
    }
    // ★ ADR-0004/0005: 取外しイベントを mountHistory に追記。
    //   分割(一時停止交換)では旧区間に進行中ジョブ J を含める（until=J）。
    //   稼働中=全体/通常取り外しでは最新完了 Lc（J を除外）。
    if (host) {
      appendUnmountEvent({
        host,
        spoolId: prevSpool.id,
        untilJobId: (_midPrintSwap && _mode === "split") ? _J : _Lc,
        ts: nowTs
      });
    }
    prevSpool.removedAt = Date.now();
    prevSpool.hostname = null;
    prevSpool.isInUse = false;
    prevSpool.isPending = false;
    prevSpool.currentPrintID = "";
    prevSpool.currentJobStartLength = null;
    prevSpool.currentJobExpectedLength = null;
  }
  if (newSpool) {
    newSpool.startLength = newSpool.remainingLengthMm;
    newSpool.startPrintID = printId;
    newSpool.startedAt = Date.now();
    newSpool.currentPrintID = printId;
    newSpool.currentJobStartLength = null;
    newSpool.currentJobExpectedLength = null;
    // ★ ADR-0004/0005: 装着イベントを mountHistory に追記。
    //   sinceJobId = Lc（最新完了 printId・厳密 > 境界）。進行中 J は Lc 区間に含まれる。
    //   稼働中=全体では anchor に usedAtSwap を加算し live==authority を保つ
    //   （J 全体が新スプールに帰属し、完了時 derive と一致）。それ以外は現残量。
    if (host) {
      appendMountEvent({
        host,
        spoolId: newSpool.id,
        anchorRemainingMm: (_midPrintSwap && _mode === "whole")
          ? (Number(newSpool.remainingLengthMm) || 0) + _usedAtSwap
          : newSpool.remainingLengthMm,
        sinceJobId: _Lc,
        ts: nowTs + 1
      });
    }
    // ★ B5: 交換記録を即座に保存（印刷前の再起動でも記録が残る）
    logSpoolChange(newSpool, printId);
    newSpool.isPending = false;  // 即座に記録済み（遅延実行を廃止）
    newSpool.updatedAt = Date.now();  // ★ C1: 時系列判定用タイムスタンプ更新
    if (_midPrintSwap) {
      // ★ ADR-0005 P4 (B1): ライブ使用量カウンタを文脈に応じて再ベースライン（0張り付き解消）。
      const _newRemain = Number(newSpool.remainingLengthMm) || 0;
      newSpool.currentJobExpectedLength = null;
      newSpool.currentPrintID = _J ? String(_J) : printId;
      if (_mode === "whole") {
        // 稼働中=全体: 新残量 + usedAtSwap を基点に accumulated=usedAtSwap（J 全体を新へ）。
        newSpool.currentJobStartLength = _newRemain + _usedAtSwap;
        _rebaselineHostUsage?.(host, { accumulated: _usedAtSwap, prevUsed: _usedAtSwap });
      } else {
        // 一時停止=分割: 新残量を基点に accumulated=0, prevUsed=usedAtResume（再開後のみ計上）。
        newSpool.currentJobStartLength = _newRemain;
        _rebaselineHostUsage?.(host, { accumulated: 0, prevUsed: _usedAtSwap });
        // 進行中ジョブ J に旧リールの per-reel 消費(U_old)を信頼ソースへ反映（derive 分割帰属）。
        if (_J) _upsertSplitReel(host, _J, prevSpool, _Uold);
      }
      // 旧スプールは印刷フラグ解除済み → 信頼ソースから残量を冪等補正
      //   （whole: until=Lc で J 除外 → J前の値へ復元 / split: until=J で U_old 反映）。
      if (prevSpool) {
        try { reconcileSpool(prevSpool.id, { ts: nowTs }); }
        catch (e) { console.warn(`[setCurrentSpoolId] reconcileSpool(prev) 失敗:`, e?.message || e); }
      }
    }
    if (host) {
      // UI に即座に残量を反映させるため storedData を更新
      setStoredDataForHost(host, "filamentRemainingMm", newSpool.remainingLengthMm, true);
      // ----- 印刷履歴更新処理 -----
      // 起動直後にスプール情報が欠落している場合、
      // 現在ジョブおよび履歴からフィラメントIDを補完する
      if (machine.printStore) {
        const curJob = machine.printStore.current;
        if (curJob && !curJob.filamentId && curJob.id === printId) {
          curJob.filamentId = newSpool.id;
        }
        const hist = machine.printStore.history;
        if (Array.isArray(hist)) {
          const entry = hist.find(h => h.id === printId && !h.filamentId);
          if (entry) entry.filamentId = newSpool.id;
        }
      }
      if (Array.isArray(machine.historyData)) {
        const buf = machine.historyData.find(h => h.id === printId && !h.filamentId);
        if (buf) {
          buf.filamentId = newSpool.id;
          // 履歴バッファに補完したフィラメントIDを画面へ即反映する
          const baseUrl = getDisplayBaseUrl(host);
          updateHistoryList([buf], baseUrl, "print-current-container", host);
        }
      }
    }
  }

  // 現在スプールの残量を storedData に即時反映
  // スプール取外し時は null をセットしてゴースト表示を防止
  if (host && newSpool) {
    setStoredDataForHost(host, "filamentRemainingMm", newSpool.remainingLengthMm, true);
    updateStoredDataToDOM();
  } else if (host && !newSpool) {
    setStoredDataForHost(host, "filamentRemainingMm", null, true);
    updateStoredDataToDOM();
  }

  // ★ ADR-0005 P6: inferred(暫定推定)スプールを実スプールで置換したら推定 phantom を破棄
  //   （ユーザーが正しいリールを登録＝推定が外れた。在庫汚染を残さない）。
  if (prevSpool && prevSpool.inferred && newSpool && newSpool.id !== prevSpool.id) {
    prevSpool.deleted = true;
    prevSpool.isDeleted = true;
  }

  // ★ ADR-0005: 交換でイベント文脈を解決（mid-print swap はモード、その他は default-continue）。
  if (host && _ev) {
    try { resolveFilamentEvent(host, _midPrintSwap ? _mode : "default-continue", { ts: nowTs }); }
    catch (e) { console.warn(`[setCurrentSpoolId] resolveFilamentEvent 失敗:`, e?.message || e); }
  }

  saveUnifiedStorage(true);
  return true;
}

/**
 * 新しいスプール（フィラメントリール）情報を追加する
 *
 * @param {Object} data 追加するスプール情報オブジェクト
 * @param {boolean} [data.isFavorite] お気に入りフラグ
 * @param {Object} [opts]
 * @param {boolean} [opts.inferred=false] ADR-0005 P6: 暫定推定スプール（serialNo を採番せず inferred:true）
 * @returns {Object} 登録されたスプールオブジェクト
 */
/**
 * スプールのコスト単価(円/mm)を算出する。
 * purchasePrice と totalLengthMm が揃っている場合のみ計算。
 * @param {Object} spool - スプールオブジェクト
 * @returns {number} コスト単価（円/mm）。算出不能な場合は 0
 */
function _calcCostPerMm(spool) {
  const price = Number(spool.purchasePrice);
  const total = Number(spool.totalLengthMm);
  if (price > 0 && total > 0) return price / total;
  return 0;
}

export function addSpool(data, { inferred = false } = {}) {
  // UI から渡されるデータを元に初期値を設定したスプールオブジェクトを生成する
  const id = genId();
  // ★ ADR-0005 P6/R1: inferred(暫定推定)スプールは serialNo を採番しない
  //   （不可逆な spoolSerialCounter を消費しない。確定時に confirmInferredSpool で採番）。
  const serialNo = inferred ? null : ++monitorData.spoolSerialCounter;
  const spool = {
    id,
    spoolId: id,
    serialNo,
    presetId: data.presetId || null,
    modelId: data.modelId || data.presetId || null,
    name: data.name || "",
    color: data.color || "",
    colorName: data.colorName || "",
    material: data.material || "",
    brand: data.brand || data.manufacturerName || "",
    printTempMin: data.printTempMin == null ? null : Number(data.printTempMin),
    printTempMax: data.printTempMax == null ? null : Number(data.printTempMax),
    bedTempMin:   data.bedTempMin   == null ? null : Number(data.bedTempMin),
    bedTempMax:   data.bedTempMax   == null ? null : Number(data.bedTempMax),
    density:      data.density      == null ? null : Number(data.density),
    reelSubName: data.reelSubName || "",
    materialName: data.materialName || data.material || "",
    materialSubName: data.materialSubName || "",
    filamentDiameter: Number(data.filamentDiameter) || 1.75,
    filamentColor: data.filamentColor || data.color || "#22C55E",
    reelOuterDiameter: Number(data.reelOuterDiameter) || 200,
    reelThickness: Number(data.reelThickness) || 68,
    reelWindingInnerDiameter: Number(data.reelWindingInnerDiameter) || 95,
    reelCenterHoleDiameter: Number(data.reelCenterHoleDiameter) || 54,
    reelBodyColor: data.reelBodyColor || "#A1A1AA",
    reelFlangeTransparency: data.reelFlangeTransparency ?? 0.4,
    reelWindingForegroundColor:
      data.reelWindingForegroundColor || "#71717A",
    reelCenterHoleForegroundColor:
      data.reelCenterHoleForegroundColor || "#F4F4F5",
    manufacturerName: data.manufacturerName || data.brand || "",
    purchasePrice: Number(data.purchasePrice) || 0,
    currencySymbol: data.currencySymbol || "\u00A5",
    purchaseLink: data.purchaseLink || "",
    priceCheckDate: data.priceCheckDate || "",
    totalLengthMm: Number(data.totalLengthMm) || 0,
    remainingLengthMm: Number(data.remainingLengthMm) || 0,
    weightGram: Number(data.weightGram) || 0,
    printCount: Number(data.printCount) || 0,
    startDate: data.startDate || new Date().toISOString(),
    startLength: Number(data.startLength ?? data.remainingLengthMm) || 0,
    startPrintID: data.startPrintID || "",
    startedAt: data.startedAt || Date.now(),
    currentPrintID: data.currentPrintID || "",
    /**
     * 現在印刷中ジョブ開始時の残量 [mm]
     * @type {?number}
     */
    currentJobStartLength: data.currentJobStartLength ?? null,
    /**
     * 現在印刷中ジョブで消費予定の長さ [mm]
     * @type {?number}
     */
    currentJobExpectedLength: data.currentJobExpectedLength ?? null,
    removedAt: data.removedAt || null,
    note: data.note || "",
    usedLengthLog: data.usedLengthLog || [],
    /**
     * スプールを装着してから取り外すまでの印刷ID範囲配列
     * @type {Array<{startPrintID:string,endPrintID:?string}>}
     */
    printIdRanges: data.printIdRanges || [],
    isActive: false,
    isInUse: false,
    /**
     * 交換後まだ印刷に使用されていない状態かどうか
     * @type {boolean}
     */
    isPending: false,
    isFavorite: data.isFavorite || false,
    deleted: false,
    isDeleted: false,
    hostname: data.hostname || null,
    /** コスト単価(円/mm) — purchasePrice / totalLengthMm から自動算出 */
    costPerMm: 0,
    /** ADR-0005 P6: 暫定推定フラグ（true=未確定。serial/inventory 未消費・ユーザー確定待ち） */
    inferred: !!inferred
  };
  spool.costPerMm = _calcCostPerMm(spool);
  monitorData.filamentSpools.push(spool);
  saveUnifiedStorage(true);
  return spool;
}

/**
 * ADR-0005 P6: 暫定推定スプールを生成する（同プリセット・満タン仮定）。
 *
 * 一時停止中に旧スプールを使い切った高確度ケース（2信号一致）で、ユーザーが新リールを
 * 登録しなかった場合に自動生成する。R1 厳守: `++spoolSerialCounter` も `consumeInventory` も
 * **しない**（不可逆資源を消費しない）。`inferred:true` で生成し、確定は
 * {@link confirmInferredSpool}、取消は {@link deleteSpool}。残量導出(ledger)は inferred に無依存。
 *
 * @function addInferredSpool
 * @param {Object} source - 複製元（旧スプール等）。preset/material/color/geometry を引き継ぐ
 * @returns {Object} 生成した inferred スプール
 */
export function addInferredSpool(source = {}) {
  const total = Number(source.totalLengthMm) || 330000;
  const data = {
    presetId: source.presetId || null,
    modelId: source.modelId || source.presetId || null,
    name: source.name || "",
    reelSubName: source.reelSubName || "",
    color: source.color || "",
    colorName: source.colorName || "",
    filamentColor: source.filamentColor || source.color || "#22C55E",
    material: source.material || "",
    materialName: source.materialName || source.material || "",
    materialSubName: source.materialSubName || "",
    brand: source.brand || source.manufacturerName || "",
    manufacturerName: source.manufacturerName || source.brand || "",
    density: source.density ?? null,
    printTempMin: source.printTempMin ?? null,
    printTempMax: source.printTempMax ?? null,
    bedTempMin: source.bedTempMin ?? null,
    bedTempMax: source.bedTempMax ?? null,
    filamentDiameter: source.filamentDiameter || 1.75,
    reelOuterDiameter: source.reelOuterDiameter,
    reelThickness: source.reelThickness,
    reelWindingInnerDiameter: source.reelWindingInnerDiameter,
    reelCenterHoleDiameter: source.reelCenterHoleDiameter,
    reelBodyColor: source.reelBodyColor,
    purchasePrice: Number(source.purchasePrice) || 0,
    currencySymbol: source.currencySymbol || "¥",
    // R2: 満タン仮定は推定値（ユーザー訂正可）
    totalLengthMm: total,
    remainingLengthMm: total
  };
  return addSpool(data, { inferred: true });
}

/**
 * ADR-0005 P6: 暫定推定スプールを確定する（実スプール化）。
 *
 * `serialNo` を採番（`++spoolSerialCounter`）し `inferred` を解除。presetId があれば
 * プリセット在庫を1消費する（任意）。非 inferred / 未発見は no-op。
 *
 * @function confirmInferredSpool
 * @param {string} id - 対象スプールID
 * @param {Object} [opts]
 * @param {boolean} [opts.consumePreset=true] - presetId があれば在庫を1消費するか
 * @returns {?Object} 確定後スプール（未発見/非inferred は null）
 */
export function confirmInferredSpool(id, { consumePreset = true } = {}) {
  const s = monitorData.filamentSpools.find(sp => sp.id === id);
  if (!s || !s.inferred) return null;
  s.serialNo = ++monitorData.spoolSerialCounter;
  s.inferred = false;
  if (consumePreset && s.presetId) {
    try { consumeInventory(s.presetId, 1); }
    catch (e) { console.warn("[confirmInferredSpool] consumeInventory 失敗:", e?.message || e); }
  }
  saveUnifiedStorage(true);
  return s;
}

/**
 * ADR-0005 P6 (F-A 完全可逆): inferred(推定)スプールを取り消し、superseded 旧スプールを
 * 完全復元する。
 *
 * 「同一リール戻し」等で #3 推定が外れた場合に呼ぶ。#3 時に保存した残量スナップショット
 * (`_supersedes`) から、#3 以降に inferred へ帰属した消費を差し引いた残量で旧スプールを
 * 再装着し、inferred を削除する（残量を正しく巻き戻す）。スナップショットが無い inferred は
 * 単純な取り外し＋削除にフォールバック。印刷継続中でも aggregator が old から追跡を続ける。
 *
 * @function revertInferredSpool
 * @param {string} id - inferred スプールID
 * @returns {?Object} 復元した旧スプール（復元対象が無ければ null）
 */
export function revertInferredSpool(id) {
  const inferred = monitorData.filamentSpools.find(sp => sp.id === id);
  if (!inferred) return null;
  const sup = inferred._supersedes;
  const host = sup?.host || inferred.hostname || null;
  const nowTs = Date.now();

  // #3 以降に inferred へ帰属した消費（= 物理的には同一リールの消費）を算出
  let inferredUsed = 0;
  try {
    const d = deriveSpoolRemaining(id);
    inferredUsed = Math.max(0, (Number(inferred.totalLengthMm) || 0) - (Number(d.remainingMm) || 0));
  } catch (e) { /* noop */ }

  // inferred を取り外し（mountHistory に unmount 追記）＋削除
  if (host) {
    appendUnmountEvent({ host, spoolId: inferred.id, untilJobId: _latestCompletedPrintId(host), ts: nowTs });
  }
  inferred.deleted = true; inferred.isDeleted = true;
  inferred.isActive = false; inferred.isInUse = false;
  inferred.currentPrintID = ""; inferred.currentJobStartLength = null;
  inferred.hostname = null;

  const old = sup?.spoolId ? monitorData.filamentSpools.find(sp => sp.id === sup.spoolId) : null;
  if (!old || !host) {
    // 復元対象なし → inferred を外すだけ
    if (host && monitorData.hostSpoolMap[host] === id) monitorData.hostSpoolMap[host] = null;
    if (host) {
      setStoredDataForHost(host, "filamentRemainingMm", null, true);
      updateStoredDataToDOM();
    }
    saveUnifiedStorage(true);
    return null;
  }

  // 旧（実は同一リール）の残量 = スナップショット − inferred 期間の消費
  const oldRestored = Math.max(0, (Number(sup.prevRemaining) || 0) - inferredUsed);
  // 既存ジョブ（#3 の J まで）を除外する since（この時点を新基点に）
  const sinceBase = Math.max(_latestCompletedPrintId(host), Number(sup.printID) || 0);

  old.deleted = false; old.isDeleted = false;
  old.isActive = true; old.isInUse = true; old.hostname = host; old.removedAt = null;
  old.remainingLengthMm = oldRestored;
  old.currentPrintID = "";
  old.currentJobStartLength = null;
  monitorData.hostSpoolMap[host] = old.id;
  appendMountEvent({ host, spoolId: old.id, anchorRemainingMm: oldRestored, sinceJobId: sinceBase, ts: nowTs + 1 });

  // ライブ使用量カウンタを再ベースライン（印刷継続中でも old から正しく追跡）
  try {
    const used = Number(monitorData.machines?.[host]?.storedData?.usedMaterialLength?.rawValue);
    _rebaselineHostUsage?.(host, { accumulated: 0, prevUsed: Number.isFinite(used) ? used : null });
  } catch (e) { /* noop */ }

  setStoredDataForHost(host, "filamentRemainingMm", oldRestored, true);
  updateStoredDataToDOM();
  saveUnifiedStorage(true);
  return old;
}

export function updateSpool(id, patch) {
  const s = monitorData.filamentSpools.find(sp => sp.id === id);
  if (!s) return;
  Object.assign(s, patch);
  // purchasePrice or totalLengthMm が変わった場合に costPerMm を再算出
  if ("purchasePrice" in patch || "totalLengthMm" in patch) {
    s.costPerMm = _calcCostPerMm(s);
  }
  saveUnifiedStorage(true);
}

export function deleteSpool(id, hostname) {
  const host = hostname;
  const s = monitorData.filamentSpools.find(sp => sp.id === id);
  if (!s) return;
  if (host && Array.isArray(s.printIdRanges) && s.printIdRanges.length) {
    const machine = monitorData.machines[host] || {};
    const pid = machine.printStore?.current?.id ?? "";
    const r = s.printIdRanges[s.printIdRanges.length - 1];
    if (r && r.endPrintID == null) {
      r.endPrintID = String(pid || s.currentPrintID || "");
    }
  }
  s.deleted = true;
  s.isDeleted = true;
  s.isInUse = false;
  s.isActive = false;
  s.removedAt = Date.now();
  // per-host マップから削除（レガシーグローバル値も同期）
  for (const [h, spId] of Object.entries(monitorData.hostSpoolMap)) {
    if (spId === id) monitorData.hostSpoolMap[h] = null;
  }
  // ★ currentSpoolId は廃止済み。hostSpoolMap のみが権威。
  saveUnifiedStorage(true);
}

/**
 * 廃棄フラグを取り消してスプールを復活させる。
 *
 * @function restoreSpool
 * @param {string} id - 復活させるスプールID
 * @returns {void}
 */
export function restoreSpool(id) {
  const s = monitorData.filamentSpools.find(sp => sp.id === id);
  if (!s) return;
  s.deleted = false;
  s.isDeleted = false;
  saveUnifiedStorage(true);
}

/**
 * スプール交換履歴を記録する。
 *
 * @private
 * @param {Object} spool - 対象スプール
 * @param {string} [printId=""] - 交換時の印刷ジョブID
 * @returns {void}
 */
function logSpoolChange(spool, printId = "") {
  if (!spool) return;
  spool.printIdRanges ??= [];
  spool.printIdRanges.push({ startPrintID: String(printId), endPrintID: null });
  monitorData.usageHistory.push({
    usageId: Date.now(),
    spoolId: spool.id,
    spoolSerial: spool.serialNo,
    hostname: spool.hostname || null,  // ★ per-host 追跡用
    startPrintID: printId,
    startLength: spool.startLength,
    startedAt: spool.startedAt
  });
  trimUsageHistory();
  saveUnifiedStorage(true);
}

/**
 * スプール使用履歴を追加するヘルパー。
 *
 * @private
 * @param {Object} spool - 対象スプール
 * @param {number} lengthMm - 使用した長さ [mm]
 * @param {string} jobId - 関連ジョブID
 * @param {string} [type="complete"] - 使用種別 ("complete" | "fail" | "snapshot")
 * @returns {void}
 */
function logUsage(spool, lengthMm, jobId, type = "complete") {
  monitorData.usageHistory.push({
    usageId: Date.now(),
    spoolId: spool.id,
    spoolSerial: spool.serialNo,
    hostname: spool.hostname || null,  // ★ per-host 追跡用
    jobId,
    startedAt: Date.now(),
    usedLength: lengthMm,
    currentLength: spool.remainingLengthMm,
    type
  });
  trimUsageHistory();
  saveUnifiedStorage(true);
}

/**
 * 印刷中の途中経過をスナップショットとして履歴に追加する。
 *
 * @function addUsageSnapshot
 * @param {Object} spool - 対象スプール
 * @param {string} jobId - 印刷ジョブID
 * @param {number} remainMm - スナップショット時点の残量 [mm]
 * @returns {void}
 */
export function addUsageSnapshot(spool, jobId, remainMm) {
  monitorData.usageHistory.push({
    usageId: Date.now(),
    spoolId: spool.id,
    spoolSerial: spool.serialNo,
    hostname: spool.hostname || null,  // ★ per-host 追跡用
    jobId,
    startedAt: Date.now(),
    currentLength: remainMm,
    isSnapshot: true
  });
  trimUsageHistory();
  saveUnifiedStorage(true);
}

/**
 * 予約済みフィラメント長を即時消費として反映し、残量を更新する。
 * ページリロード時に残量が復元されるようストレージと DOM を同期させる。
 *
 * @function useFilament
 * @param {number} lengthMm - 使用したフィラメント長 [mm]
 * @param {string} [jobId=""] - 印刷ジョブID
 * @returns {void}
 */
export function useFilament(lengthMm, jobId = "", hostname) {
  const host = hostname;
  if (!host) { console.warn("[useFilament] hostname 未指定"); return; }
  // ★ バリデーション: 非数値・負値・異常値を拒否
  const amount = Number(lengthMm);
  if (!Number.isFinite(amount) || amount < 0) {
    console.warn(`[useFilament] 無効な消費量: ${lengthMm}`);
    return;
  }
  if (amount > 1000000) {
    // 1000m超は明らかに異常（最長スプールでも~400m）
    console.warn(`[useFilament] 異常に大きい消費量: ${amount}mm — スキップ`);
    return;
  }
  const s = getCurrentSpool(host);
  if (!s) return;
  const machine = monitorData.machines[host];
  if (machine?.printStore?.current) {
    machine.printStore.current.filamentId = s.id;
  }
  const normalizedJobId = String(jobId ?? "");
  if (s.isPending) {
    // スプール交換直後の初回使用であれば履歴に交換記録を追加
    logSpoolChange(s, normalizedJobId);
    s.isPending = false;
  }
  // ★ 予約減算を廃止。基点のみ記録し、実際の減算は aggregatorUpdate の delta 追跡で行う。
  s.currentJobStartLength = s.remainingLengthMm;
  s.currentJobExpectedLength = amount;
  // remainingLengthMm は変更しない（aggregatorUpdate が delta で更新する）
  s.currentPrintID = normalizedJobId;
  // ページリロード直後でも基点が巻き戻らないよう即座に保存
  saveUnifiedStorage(true);
}

/**
 * 外部で開始された印刷ジョブのフィラメント使用量を初期化する。
 * {@link useFilament} と同等の処理を行うが、呼び出し元から対象スプールを受け取る。
 *
 * @function beginExternalPrint
 * @param {Object} spool - 対象スプール
 * @param {number} lengthMm - 予定消費量 [mm]
 * @param {string} [jobId=""] - 印刷ジョブID
 * @returns {void}
 */
export function beginExternalPrint(spool, lengthMm, jobId = "", hostname) {
  const host = hostname;
  if (!host) return;
  if (!spool) return;
  const machine = monitorData.machines[host];
  if (machine?.printStore?.current) {
    machine.printStore.current.filamentId = spool.id;
  }
  const normalizedJobId = String(jobId ?? "");

  // ★ Bug A fix: リジューム検出 — 直前に完了した同一ジョブIDの場合、
  // 残量の二重減算と usedLengthLog の重複追加を回避する
  const isResume = spool.lastCompletedPrintID === normalizedJobId;
  if (isResume) {
    console.info("[beginExternalPrint] リジューム検出:", normalizedJobId);
  }

  if (spool.isPending) {
    // スプール交換直後の初回使用であれば履歴に交換記録を追加
    logSpoolChange(spool, normalizedJobId);
    spool.isPending = false;
  }

  // ★ 予約減算を廃止。残量は「確定残量 - リアルタイム消費量」で表示する。
  //   beginExternalPrint は基点を記録するのみ。実際の減算は aggregatorUpdate の
  //   delta 追跡と finalizeFilamentUsage で行う。
  spool.currentJobStartLength = spool.remainingLengthMm;
  spool.currentJobExpectedLength = lengthMm;
  // remainingLengthMm は変更しない（aggregatorUpdate が delta で更新する）

  spool.currentPrintID = normalizedJobId;
  spool.lastCompletedPrintID = null; // リジューム検出フラグをクリア
  // ページリロード直後でも残量が巻き戻らないよう即座に保存
  saveUnifiedStorage(true);
}

/**
 * 現在の印刷ジョブに必要なフィラメント長を予約する。
 * 残量は減算せず開始時の値を保持するのみで、実際の減算は完了時に行う。
 * 履歴バッファへスプール情報を追記しつつ、現在の残量をストレージと DOM に
 * 同期させ {@link updateHistoryList} を利用して永続化と画面反映を行う。
 *
 * @function reserveFilament
 * @param {number} lengthMm - 予定消費量 [mm]
 * @param {string} [jobId=""] - 印刷ジョブID
 * @returns {void}
 */
export function reserveFilament(lengthMm, jobId = "", hostname) {
  const host = hostname;
  if (!host) return;
  const s = getCurrentSpool(host);
  if (!s) return;
  const machine = monitorData.machines[host];
  if (machine?.printStore?.current) {
    machine.printStore.current.filamentId = s.id;
  }
  const normalizedJobId = String(jobId ?? "");
  if (s.isPending) {
    logSpoolChange(s, normalizedJobId);
    s.isPending = false;
  }
  s.currentJobStartLength = s.remainingLengthMm;
  s.currentJobExpectedLength = lengthMm;
  s.currentPrintID = normalizedJobId;
  // DOM 表示とストレージに現在残量を即座に反映
  setStoredDataForHost(host, "filamentRemainingMm", s.remainingLengthMm, true);
  updateStoredDataToDOM();
  // --- 印刷開始時点で履歴にスプール情報を記録 -------------------
  let entry = null;
  if (machine && Array.isArray(machine.historyData)) {
    entry = machine.historyData.find(h => h.id === normalizedJobId);
    if (!entry) {
      entry = { id: normalizedJobId };
      machine.historyData.push(entry);
    }
    entry.filamentInfo ??= [];
    if (!entry.filamentInfo.some(info => info.spoolId === s.id)) {
      entry.filamentInfo.push({
        spoolId: s.id,
        serialNo: s.serialNo,
        spoolName: s.name,
        colorName: s.colorName,
        filamentColor: s.filamentColor,
        material: s.material,
        spoolCount: s.printCount,
        expectedRemain: s.remainingLengthMm
      });
    }
  }
  saveUnifiedStorage(true);
  if (entry) {
    const baseUrl = getDisplayBaseUrl(host);
    updateHistoryList([entry], baseUrl, "print-current-container", host);
  }
}

/**
 * 実際に使用したフィラメント長を残量に反映して確定する。
 * 予約時に記録した startLength から使用量を差し引き更新する。
 *
 * @function finalizeFilamentUsage
 * @param {number} lengthMm - 実使用量 [mm]
 * @param {string} [jobId=""] - 印刷ジョブID
 * @param {string} hostname - ホスト名
 * @param {boolean} [isSuccess=true] - 印刷成功フラグ（false=失敗/キャンセル）
 * @returns {void}
 * @description
 * 使用完了時点のスプール情報を履歴にスナップショットとして保存する。
 * スプール名や色を後から変更しても当時の状態を保持するため、
 * name/color/material などのメタ情報を同時に記録する。
 * 履歴更新後は {@link updateHistoryList} を介して永続化し UI へ即時反映する。
 */
export function finalizeFilamentUsage(lengthMm, jobId = "", hostname, isSuccess = true) {
  const host = hostname;
  if (!host) return;
  const s = getCurrentSpool(host);
  if (!s) {
    // スプール未設定 — transient フィールドのクリアだけは行えない（対象なし）
    return;
  }
  const normalizedJobId = String(jobId ?? "");
  // ★ ADR-0004: 多重 finalize ガード。既に確定済みの同一 jobId なら
  //   残量・log・printCount を一切触らず即 return（二重減算の根を断つ）。
  if (normalizedJobId && normalizedJobId === s.lastCompletedPrintID) {
    console.debug(`[finalizeFilamentUsage] ${host}: jobId=${normalizedJobId} は確定済み → スキップ`);
    return;
  }
  if (s.currentPrintID && s.currentPrintID !== normalizedJobId) {
    // jobId 不一致 — 別のジョブの完了通知なので無視するが、
    // transient フィールドが古いジョブのまま残留していたらクリアする
    console.warn(
      "finalizeFilamentUsage: jobId mismatch, clearing stale transient fields",
      { stored: s.currentPrintID, received: normalizedJobId }
    );
    s.currentJobStartLength = null;
    s.currentJobExpectedLength = null;
    s.currentPrintID = "";
    saveUnifiedStorage(true);
    return;
  }
  const startLen = s.currentJobStartLength ?? s.remainingLengthMm;
  const used = Number(lengthMm);
  const expectedLength = Number(s.currentJobExpectedLength ?? NaN);
  let resolvedUsed = used;
  if (
    (isNaN(resolvedUsed) || resolvedUsed <= 0) &&
    !isNaN(expectedLength) &&
    expectedLength > 0
  ) {
    // 使用量が0または不明なのに予定使用量がある場合は、
    // 予定使用量をフォールバックとして採用し、ログを残す
    console.warn(
      "finalizeFilamentUsage: used length was empty. fallback to expected length.",
      { used: resolvedUsed, expectedLength, jobId: normalizedJobId }
    );
    resolvedUsed = expectedLength;
  }
  // ★ B2: 0消費は残量を変更しない（二重finalize等による偽値での破壊を防止）
  if (!isNaN(resolvedUsed) && resolvedUsed > 0) {
    s.remainingLengthMm = Math.max(0, startLen - resolvedUsed);
    s.updatedAt = Date.now();  // ★ C1: 時系列判定用タイムスタンプ更新
  } else if (resolvedUsed === 0 || isNaN(resolvedUsed)) {
    console.warn(`[finalizeFilamentUsage] resolvedUsed=${resolvedUsed} → 残量変更なし (${hostname})`);
  }
  // 成功時のみ printCount をインクリメント（失敗/キャンセルは含めない）
  if (isSuccess && resolvedUsed > 0) {
    s.printCount = (s.printCount || 0) + 1;
  }
  s.currentJobStartLength = null;
  s.currentJobExpectedLength = null;
  // ★ Bug A fix: currentPrintID を即クリアせず lastCompletedPrintID に保持。
  // リジューム時に beginExternalPrint が同じ jobId で呼ばれた場合、
  // スプール紐付けを継続できるようにする。
  s.lastCompletedPrintID = normalizedJobId;
  s.currentPrintID = "";
  // ★ ADR-0004: usedLengthLog 重複防止（同一 jobId の再 push を弾く）
  if (!Array.isArray(s.usedLengthLog)) s.usedLengthLog = [];
  if (!s.usedLengthLog.some(l => String(l.jobId) === normalizedJobId)) {
    s.usedLengthLog.push({ jobId: normalizedJobId, used: resolvedUsed });
  }
  // 現在のスプール情報を履歴に追加
  const machine = monitorData.machines[host];
  let entry = null;
  if (machine && Array.isArray(machine.historyData)) {
    entry = machine.historyData.find(h => h.id === normalizedJobId);
    if (!entry) {
      entry = { id: normalizedJobId };
      machine.historyData.push(entry);
    }
    entry.filamentInfo ??= [];
    // ★ B3: 重複チェック — spoolId + expectedRemain の完全一致で判定
    //   A→B→A交換でAの2回目が消失しないよう、残量も比較する
    const isDuplicate = entry.filamentInfo.some(info =>
      info.spoolId === s.id &&
      Math.abs((info.expectedRemain ?? 0) - s.remainingLengthMm) < 0.1
    );
    if (!isDuplicate) {
      const costPerMm = s.costPerMm || _calcCostPerMm(s);
      const materialCost = costPerMm > 0 && resolvedUsed > 0
        ? Math.round(resolvedUsed * costPerMm * 100) / 100 : 0;
      entry.filamentInfo.push({
        spoolId: s.id,
        serialNo: s.serialNo,
        spoolName: s.name,
        colorName: s.colorName,
        filamentColor: s.filamentColor,
        material: s.material,
        spoolCount: s.printCount,
        expectedRemain: s.remainingLengthMm,
        usedMm: resolvedUsed,
        materialCostYen: materialCost
      });
      // ★ ジョブレコードにもコスト集計を書き込み（統計用）
      entry.materialUsedMm = resolvedUsed;
      entry.materialCostYen = (entry.materialCostYen || 0) + materialCost;
    }
  }
  logUsage(s, resolvedUsed, normalizedJobId, isSuccess ? "complete" : "fail");
  // ★ ADR-0004: 完了確定値を信頼ソース printStore.history に反映してから reconcile する。
  //   これが無いと「history にまだ当該ジョブが無い」タイミングで reconcile が
  //   モードA(total-Σ)を計算し、確定したばかりの消費を取りこぼして残量を盛り戻してしまう。
  //   reconcile は printStore.history を権威とするため、ここで確実に入れて整合させる。
  //   失敗ジョブ(materialUsedMm<=0)は信頼ソースに完了として入れない（attributedUsed の対象外）。
  if (resolvedUsed > 0) {
    _upsertHistoryUsage(host, normalizedJobId, resolvedUsed, isSuccess);
  }
  // ★ ADR-0005: このジョブに別リールの filamentInfo が既にある（=分割／一時停止交換）なら、
  //   当該リールの per-reel usedMm を printStore.history に反映してから reconcile する
  //   （複数リールを各々正しく帰属。単一スプールジョブには触れず materialUsedMm 権威を維持）。
  if (resolvedUsed > 0) {
    const _entry = machine?.printStore?.history?.find(h => String(h.id) === normalizedJobId);
    const _isSplit = Array.isArray(_entry?.filamentInfo)
      && _entry.filamentInfo.some(fi => fi && fi.spoolId && fi.spoolId !== s.id);
    if (_isSplit) _upsertSplitReel(host, normalizedJobId, s, resolvedUsed);
  }
  // ★ 完了直後に信頼ソースから残量を冪等補正（finalize の startLen-used 値は暫定。reconcile が権威）。
  //   currentPrintID は上で "" にクリア済みなので reconcile は走る。
  try {
    reconcileSpool(s.id, { ts: Date.now() });
  } catch (e) {
    console.warn(`[finalizeFilamentUsage] reconcileSpool 失敗 (${host}):`, e?.message || e);
  }
  updateStoredDataToDOM();
  saveUnifiedStorage(true);
  if (entry) {
    const baseUrl = getDisplayBaseUrl(host);
    updateHistoryList([entry], baseUrl, "print-current-container", host);
  }
  cleanupUsageSnapshots(jobId);
}

/**
 * 指定ジョブのスナップショット履歴を削除する。
 *
 * @function cleanupUsageSnapshots
 * @param {string} jobId - 対象ジョブID
 * @returns {void}
 */
export function cleanupUsageSnapshots(jobId) {
  if (!jobId) return;
  const before = monitorData.usageHistory.length;
  monitorData.usageHistory = monitorData.usageHistory.filter(
    e => !(e.jobId === jobId && e.isSnapshot)
  );
  if (before !== monitorData.usageHistory.length) {
    saveUnifiedStorage(true);
  }
}

/**
 * プリセットデータからスプールを新規作成する。
 *
 * @param {Object} preset - フィラメントプリセット
 *   - name プロパティが存在する場合はスプール名として使用
 * @param {Object} [override] - 上書きするオプション
 * @returns {Object} - 追加されたスプール
 */
export function addSpoolFromPreset(preset, override = {}) {
  if (!preset) return null;
  const data = {
    presetId: preset.presetId,
    modelId: preset.presetId,
    name: preset.name || `${preset.brand} ${preset.colorName}`,
    color: preset.color,
    colorName: preset.colorName,
    material: preset.material,
    brand: preset.brand,
    filamentDiameter:
      preset.filamentDiameter ?? preset.diameter,
    reelOuterDiameter: preset.reelOuterDiameter,
    reelThickness: preset.reelThickness,
    reelWindingInnerDiameter: preset.reelWindingInnerDiameter,
    reelCenterHoleDiameter: preset.reelCenterHoleDiameter,
    reelBodyColor: preset.reelBodyColor,
    reelFlangeTransparency: preset.reelFlangeTransparency,
    reelWindingForegroundColor: preset.reelWindingForegroundColor,
    reelCenterHoleForegroundColor: preset.reelCenterHoleForegroundColor,
    totalLengthMm:
      preset.filamentTotalLength ?? preset.defaultLength,
    remainingLengthMm:
      preset.filamentCurrentLength ??
      (preset.filamentTotalLength ?? preset.defaultLength),
    purchaseLink: preset.purchaseLink,
    purchasePrice: preset.price,
    currencySymbol: preset.currencySymbol || "\u00A5",
    priceCheckDate: preset.priceCheckDate,
    note: preset.note,
    ...override
  };
  const spool = addSpool(data);
  if (preset.presetId) {
    consumeInventory(preset.presetId, 1);
  }
  return spool;
}

/**
 * オフライン完了ジョブに付与する filamentInfo エントリを構築する純関数。
 *
 * @function buildOfflineFilamentInfo
 * @param {Object} spool - 現在装着スプール
 * @param {number} usedMm - そのジョブの消費量(mm)
 * @returns {Object} filamentInfo エントリ（isOfflineInferred=true）
 */
export function buildOfflineFilamentInfo(spool, usedMm) {
  return {
    spoolId: spool.id,
    serialNo: spool.serialNo,
    spoolName: spool.name,
    colorName: spool.colorName,
    filamentColor: spool.filamentColor,
    material: spool.material,
    spoolCount: spool.printCount,
    expectedRemain: spool.remainingLengthMm,
    usedMm: Number(usedMm) || 0,
    isOfflineInferred: true   // 3dpmon 停止中に完了→現在装着から推定したフラグ
  };
}

/**
 * 履歴ジョブにフィラメント継続紐付けを行うべきか判定する純関数。
 * 既に filamentInfo を持つジョブは尊重し、上書きしない。
 *
 * @function shouldLinkOfflineJob
 * @param {Object} job - 履歴ジョブ
 * @returns {boolean} 紐付けすべきなら true
 */
export function shouldLinkOfflineJob(job) {
  if (!job) return false;
  if (Array.isArray(job.filamentInfo) && job.filamentInfo.length > 0) return false;
  if (job.filamentId) return false;  // 既に紐付け済み
  return true;
}

/**
 * 指定ジョブID群（オフライン中に完了した印刷）に、現在装着スプールの
 * filamentInfo を遡及的に紐付ける。フィラメント交換していなければ
 * 現在のフィラメントで印刷が継続されたとみなす要望に対応。
 *
 * @private
 * @param {string} hostname - ホスト名
 * @param {Object} spool - 現在装着スプール
 * @param {Set<string>} jobIds - 紐付け対象ジョブID（文字列）
 * @returns {number} 紐付けたジョブ数
 */
function _linkOfflineJobsToSpool(hostname, spool, jobIds) {
  if (!spool || !jobIds || jobIds.size === 0) return 0;
  let jobs;
  try { jobs = loadHistory(hostname); } catch { return 0; }
  if (!Array.isArray(jobs) || !jobs.length) return 0;
  let linked = 0;
  for (const job of jobs) {
    if (!jobIds.has(String(job.id))) continue;
    if (!shouldLinkOfflineJob(job)) continue;
    const usedMm = Number(job.materialUsedMm ?? job.usagematerial ?? 0) || 0;
    job.filamentInfo = [buildOfflineFilamentInfo(spool, usedMm)];
    job.filamentId = spool.id;
    linked++;
  }
  if (linked > 0) {
    try {
      saveHistory(jobs, hostname);
      console.log(`[autoCorrect] ${hostname}: ${linked}件のオフライン完了印刷に現在フィラメント(${spool.id})を継続紐付け`);
    } catch (e) {
      console.warn("[autoCorrect] オフライン紐付けの saveHistory 失敗:", e);
    }
  }
  return linked;
}

/**
 * 現在スプールの残量・印刷回数を信頼ソースから補正する（ADR-0004）。
 *
 * @function autoCorrectCurrentSpool
 * @param {string} hostname - 対象ホスト名
 * @returns {void}
 * @description
 * v2.2.1012 で累積減算ベースの自前補正を撤去し、{@link reconcileSpool}
 * （mountHistory + printStore.history からの冪等再計算）に委譲する。
 * これにより二重減算が構造的に不能になる。
 *
 * ★ 3dpmon 停止中に完了した印刷は、フィラメント交換していなければ
 *   現在装着スプールで継続印刷したとみなし、当該ジョブへ filamentInfo を
 *   遡及紐付けする（reconcile の帰属計算の入力になる）。
 * ★ 印刷中(currentPrintID あり)のスプールは reconcile しない（オシレーション回避）。
 */
export function autoCorrectCurrentSpool(hostname) {
  if (!hostname || hostname === "_$_NO_MACHINE_$_") {
    console.error(`[IMPL_ERROR] autoCorrectCurrentSpool: 異常な機器指定 hostname="${hostname}"`);
    return;
  }
  const spool = getCurrentSpool(hostname);
  if (!spool) return;
  // ★ 印刷中スプールは触らない（二重防御。呼び出し側 aggregator でも !isPrinting で守る）
  if (spool.currentPrintID) return;

  // ── オフライン完了印刷へ現在フィラメントを継続紐付け（filamentInfo を補完）──
  //   この紐付けが reconcile の attributedUsed の入力になるため reconcile の前に行う。
  const beforeRemain = Number(spool.remainingLengthMm);
  try {
    const persistedHistory = loadHistory(hostname);
    if (Array.isArray(persistedHistory) && persistedHistory.length) {
      // 装着区間の下限（startPrintID/最新 mount の sinceJobId）以降の未紐付け完了印刷を対象
      const sinceId = Number(spool.startPrintID) || 0;
      const linkJobIds = new Set();
      for (const entry of persistedHistory) {
        if (!entry || !shouldLinkOfflineJob(entry)) continue;
        if (!entry.printfinish) continue;
        const used = Number(entry.materialUsedMm ?? NaN);
        if (!Number.isFinite(used) || used <= 0) continue;
        const numId = Number(entry.id);
        if (!Number.isFinite(numId) || numId <= 0) continue;
        // sinceId が確定している場合のみ下限で絞る（0=ブートストラップは全件対象）
        if (sinceId > 0 && numId <= sinceId) continue;
        linkJobIds.add(String(entry.id));
      }
      if (linkJobIds.size > 0) {
        _linkOfflineJobsToSpool(hostname, spool, linkJobIds);
      }
    }
  } catch (e) {
    console.warn(`[autoCorrect] ${hostname}: オフライン紐付けに失敗:`, e?.message || e);
  }

  // ── 残量・printCount は信頼ソースから冪等に再計算（権威）──
  const res = reconcileSpool(spool.id, { ts: Date.now() });
  if (res && Math.abs((res.after ?? 0) - (beforeRemain || 0)) > 0.1) {
    console.log(`[autoCorrect] ${hostname}: reconcile ${beforeRemain?.toFixed?.(0)} → ${res.after?.toFixed?.(0)} (mode=${res.mode}, verified=${res.verified})`);
    saveUnifiedStorage();
  }
}

/* ===================================================================
   残フィラメント活用提案 (Phase C)
   =================================================================== */

/**
 * 指定した残量で印刷可能なファイルを提案する。
 * ファイル一覧から必要量 ≤ remainingMm のものを抽出しスコアリング。
 *
 * @param {number} remainingMm - スプールの残フィラメント(mm)
 * @param {string} material - スプールの素材名
 * @param {string} hostname - 対象ホスト名
 * @param {Object} [options] - オプション
 * @param {number} [options.maxResults=5] - 最大結果数
 * @returns {Array<{basename: string, materialNeeded: number, matchScore: number, reason: string}>}
 */
/**
 * hostSpoolMap の参照整合性を検証・修復する。
 * 存在しない/削除済みスプールを指すエントリを null にクリアする。
 * 起動時および saveUnifiedStorage 前に呼び出す。
 *
 * @returns {number} 修復されたエントリ数
 */
export function validateHostSpoolMap() {
  let repaired = 0;
  const spoolIds = new Set(
    monitorData.filamentSpools.filter(s => !s.deleted && !s.isDeleted).map(s => s.id)
  );
  for (const [host, spoolId] of Object.entries(monitorData.hostSpoolMap)) {
    if (spoolId && !spoolIds.has(spoolId)) {
      console.warn(`[validateHostSpoolMap] ${host}: スプール "${spoolId}" が filamentSpools に存在しません → null にクリア`);
      monitorData.hostSpoolMap[host] = null;
      repaired++;
    }
  }
  if (repaired > 0) {
    console.warn(`[validateHostSpoolMap] ${repaired} 件の孤立エントリを修復しました`);
  }
  return repaired;
}

export function buildFilamentRecommendations(remainingMm, material, hostname, options = {}) {
  const maxResults = options.maxResults || 5;
  if (!remainingMm || remainingMm <= 0 || !hostname) return [];

  // 動的 import を避けるため、getFileList/buildFileInsight は呼び出し側から渡す設計にしない。
  // 代わりに printmanager からの export を使う（循環参照回避のため遅延import）。
  let fileList, buildInsight;
  try {
    // eslint-disable-next-line no-eval
    const pm = _pmAccessor;
    fileList = pm?.getFileList?.(hostname) || [];
    buildInsight = pm?.buildFileInsight;
  } catch {
    return [];
  }

  if (!fileList.length) return [];

  const matUpper = (material || "").toUpperCase().trim();
  const candidates = [];

  for (const file of fileList) {
    let materialNeeded = Number(file.usagematerial || file.expect || 0);

    // 実績ベースの消費量が利用可能ならそちらを優先
    if (buildInsight) {
      const insight = buildInsight(file.filename || file.basename, hostname);
      if (insight?.avgMaterialMm > 0) {
        materialNeeded = insight.avgMaterialMm;
      }
    }

    if (materialNeeded <= 0 || materialNeeded > remainingMm) continue;

    // スコアリング
    let score = 0;
    const reasons = [];

    // 素材一致ボーナス
    // (GCodeメタから素材が分かる場合)
    const fileMat = (file._gcodeMeta?.material || "").toUpperCase().trim();
    if (fileMat && matUpper && fileMat === matUpper) {
      score += 100;
      reasons.push("素材一致");
    }

    // フィット率ボーナス（残量にぴったり使い切れるほど高い）
    const fitRatio = materialNeeded / remainingMm;
    score += Math.round(50 * fitRatio);
    if (fitRatio > 0.7) reasons.push("残量を有効活用");

    // 印刷頻度ボーナス
    const printCount = file.printCount || 0;
    if (printCount > 0) {
      score += Math.min(30, printCount * 10);
      reasons.push(`過去${printCount}回印刷`);
    }

    if (reasons.length === 0) reasons.push("印刷可能");

    candidates.push({
      basename: file.basename || (file.filename || "").split("/").pop(),
      materialNeeded: Math.round(materialNeeded),
      matchScore: score,
      reason: reasons.join("・")
    });
  }

  // スコア降順 → 必要量降順（残量をより使い切る方を優先）
  candidates.sort((a, b) => b.matchScore - a.matchScore || b.materialNeeded - a.materialNeeded);
  return candidates.slice(0, maxResults);
}

/**
 * printmanager モジュールへのアクセサ（循環参照回避用）。
 * boot 時に registerPrintManagerAccessor() で設定される。
 * @private
 * @type {Object|null}
 */
let _pmAccessor = null;

/**
 * printmanager のアクセサを登録する。
 * 循環参照を回避するため、boot 時に呼び出す。
 *
 * @param {Object} accessor - {getFileList, buildFileInsight} を持つオブジェクト
 */
export function registerPrintManagerAccessor(accessor) {
  _pmAccessor = accessor;
}
