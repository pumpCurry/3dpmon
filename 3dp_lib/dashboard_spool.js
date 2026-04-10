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
import { consumeInventory } from "./dashboard_filament_inventory.js";
import { updateStoredDataToDOM } from "./dashboard_ui.js";
import { updateHistoryList, loadHistory } from "./dashboard_printmanager.js";
import { getDeviceIp, getHttpPort } from "./dashboard_connection.js";

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
 * 現在使用するスプールIDを更新し状態を反映する。
 * monitorData.currentSpoolId や対象スプールのフラグを変更し、
 * 必要に応じて履歴情報や残量を更新する副作用がある。履歴補完時は
 * {@link updateHistoryList} を呼び出して保存と UI 更新も行う。
 * さらに前スプールで印刷途中だった場合は、その時点までの使用量を
 * {@link finalizeFilamentUsage} で確定し、新スプールへ残りの予定
 * 長さを {@link reserveFilament} で引き継ぐ。
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

  let remaining = 0;
  if (host && prevSpool && prevSpool.currentJobStartLength != null) {
    const used = prevSpool.currentJobStartLength - prevSpool.remainingLengthMm;
    const expected = prevSpool.currentJobExpectedLength ?? used;
    remaining = Math.max(0, expected - used);
    finalizeFilamentUsage(used, prevSpool.currentPrintID, host);
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


  if (prevSpool) {
    if (Array.isArray(prevSpool.printIdRanges) && prevSpool.printIdRanges.length) {
      const r = prevSpool.printIdRanges[prevSpool.printIdRanges.length - 1];
      if (r && r.endPrintID == null) {
        r.endPrintID = String(printId || prevSpool.currentPrintID || "");
      }
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
    // ★ B5: 交換記録を即座に保存（印刷前の再起動でも記録が残る）
    logSpoolChange(newSpool, printId);
    newSpool.isPending = false;  // 即座に記録済み（遅延実行を廃止）
    newSpool.updatedAt = Date.now();  // ★ C1: 時系列判定用タイムスタンプ更新
    if (host && remaining > 0) {
      // 継続ジョブの残り分を新しいスプールに予約
      reserveFilament(remaining, printId, host);
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
          const baseUrl = `http://${getDeviceIp(host)}:${getHttpPort(host)}`;
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

  saveUnifiedStorage(true);
  return true;
}

/**
 * 新しいスプール（フィラメントリール）情報を追加する
 *
 * @param {Object} data 追加するスプール情報オブジェクト
 * @param {boolean} [data.isFavorite] お気に入りフラグ
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

export function addSpool(data) {
  // UI から渡されるデータを元に初期値を設定したスプールオブジェクトを生成する
  const id = genId();
  const serialNo = ++monitorData.spoolSerialCounter;
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
    costPerMm: 0
  };
  spool.costPerMm = _calcCostPerMm(spool);
  monitorData.filamentSpools.push(spool);
  saveUnifiedStorage(true);
  return spool;
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
    const baseUrl = `http://${getDeviceIp(host)}:${getHttpPort(host)}`;
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
  s.usedLengthLog.push({ jobId: normalizedJobId, used: resolvedUsed });
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
  updateStoredDataToDOM();
  saveUnifiedStorage(true);
  if (entry) {
    const baseUrl = `http://${getDeviceIp(host)}:${getHttpPort(host)}`;
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
 * 使用履歴から現在スプールの残量や印刷回数を補正する。
 *
 * @function autoCorrectCurrentSpool
 * @returns {void}
 * @description
 * usageHistory を新しい順に探索し、現在のスプールに一致する
 * 交換記録を見つけた場合、その後の使用量合計から残量を再計算
 * する。途中で別スプールへの交換が記録されていれば補正は行わ
 * ない。
 */
export function autoCorrectCurrentSpool(hostname) {
  if (!hostname || hostname === "_$_NO_MACHINE_$_") {
    console.error(`[IMPL_ERROR] autoCorrectCurrentSpool: 異常な機器指定 hostname="${hostname}"`);
    return;
  }
  const spool = getCurrentSpool(hostname);
  if (!spool) return;

  const logs = monitorData.usageHistory || [];

  let startIdx = -1;
  let change = null;
  // 最新から過去に向かって交換記録を検索
  for (let i = logs.length - 1; i >= 0; i--) {
    const e = logs[i];
    if (e.startLength != null && e.spoolId === spool.id) {
      change = e;
      startIdx = i;
      break;
    }
  }
  // ★ フォールバック: usageHistory に startLength エントリがない場合、
  //   spool.updatedAt を基準に、それ以降の完了印刷だけを遡及加算する。
  //   起点は現在の remainingLengthMm（最後に保存された残量）。
  const isFallback = !change;
  if (isFallback) {
    const updatedAt = Number(spool.updatedAt ?? 0);
    if (!updatedAt) return;
    // ★ ライブ追跡済みジョブを重複カウントしないよう、usageHistory の jobId を収集
    const trackedJobIds = new Set();
    for (const e of logs) {
      if (e.spoolId === spool.id && e.jobId) trackedJobIds.add(String(e.jobId));
    }
    const persistedHistory = loadHistory(hostname);
    let fallbackTotal = 0;
    let fallbackCount = 0;
    for (const entry of persistedHistory) {
      if (!entry.printfinish) continue;
      const used = Number(entry.materialUsedMm ?? NaN);
      if (!Number.isFinite(used) || used <= 0) continue;
      // entry.id は epoch秒、updatedAt は epoch ms → 秒に変換して比較
      const entryStartMs = Number(entry.id) * 1000;
      if (!Number.isFinite(entryStartMs) || entryStartMs <= updatedAt) continue;
      // ライブ追跡済みのジョブは除外（二重減算防止）
      if (trackedJobIds.has(String(entry.id))) continue;
      fallbackTotal += used;
      fallbackCount += 1;
      console.log(`[autoCorrect:fallback] ${hostname}: jobId=${entry.id} から ${used.toFixed(0)}mm を遡及加算 (updatedAt=${updatedAt})`);
    }
    if (fallbackTotal > 0) {
      const expected = spool.remainingLengthMm - fallbackTotal;
      if (expected < 0) {
        console.warn(`[autoCorrect:fallback] ${hostname}: total(${fallbackTotal.toFixed(0)}) > remaining(${spool.remainingLengthMm.toFixed(0)}) → 変更なし`);
        return;
      }
      spool.remainingLengthMm = expected;
      spool.updatedAt = Date.now();
      spool.printCount = (spool.printCount || 0) + fallbackCount;
      saveUnifiedStorage();
    }
    return;
  }

  // 履歴から取得した開始残量が数値でなければ補正不能と判断
  const startLen = Number(change.startLength);
  if (!Number.isFinite(startLen)) return;

  // ★ 印刷IDベースの範囲判定
  // startPrintID: スプール装着時の印刷epoch（下限）
  // endPrintID: 次のスプール交換時の印刷epoch（上限）
  const startPrintIdNum = Number(change.startPrintID ?? 0);
  let endPrintIdNum = Infinity;
  for (let i = startIdx + 1; i < logs.length; i++) {
    if (logs[i].startLength != null) {
      const nextId = Number(logs[i].startPrintID ?? 0);
      if (Number.isFinite(nextId) && nextId > 0) {
        endPrintIdNum = nextId;
      }
      break;
    }
  }

  // usageHistory からアプリ記録済みの消費を積算
  const recordedJobIds = new Set();
  let total = 0;
  let count = 0;
  for (let i = startIdx + 1; i < logs.length; i++) {
    const e = logs[i];
    if (e.startLength != null) break; // 次の交換で終了
    if (e.spoolId !== spool.id) continue;
    if (e.isSnapshot) continue;
    const u = Number(e.usedLength);
    if (!isNaN(u) && u > 0) {
      total += u;
      count += 1;
      if (e.jobId) recordedJobIds.add(String(e.jobId));
    }
  }

  // ★ 遡及補正: プリンター報告履歴（printStore.history）から未記録の完了印刷を加算
  // アプリOFF中の印刷はusageHistoryに記録されないが、プリンター履歴には残っている
  const persistedHistory = loadHistory(hostname);
  if (startPrintIdNum > 0) {
    for (const entry of persistedHistory) {
      const entryId = String(entry.id ?? "");
      if (!entryId || recordedJobIds.has(entryId)) continue;
      if (!entry.printfinish) continue;
      const used = Number(entry.materialUsedMm ?? NaN);
      if (!Number.isFinite(used) || used <= 0) continue;

      const numId = Number(entry.id);
      if (!Number.isFinite(numId) || numId <= 0) continue;
      if (numId <= startPrintIdNum) continue;           // 装着前の印刷
      if (endPrintIdNum < Infinity && numId > endPrintIdNum) continue;  // 取り外し後の印刷

      total += used;
      count += 1;
      console.log(`[autoCorrect] ${hostname}: 未記録印刷 jobId=${entryId} から ${used.toFixed(0)}mm を遡及加算`);
    }
  }

  // 計算された残量
  const expected = startLen - total;
  if (!Number.isFinite(expected)) return;

  // 異常検知: 消費合計が起点残量を超える場合は変更せず警告
  if (total > startLen) {
    console.warn(`[autoCorrect] ${hostname}: total(${total.toFixed(0)}) > startLen(${startLen.toFixed(0)}) → 残量変更なし`);
    return;
  }

  const diff = Math.abs(expected - spool.remainingLengthMm);
  if (Number.isFinite(diff) && (diff > 0.1 || spool.printCount !== count)) {
    spool.remainingLengthMm = expected;
    spool.updatedAt = Date.now();
    spool.printCount = count;
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
