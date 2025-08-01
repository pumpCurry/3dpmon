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
 * - {@link reserveFilament}：使用量予約
 * - {@link finalizeFilamentUsage}：使用量確定
 * - {@link autoCorrectCurrentSpool}：履歴から残量補正
 *
* @version 1.390.764 (PR #352)
* @since   1.390.193 (PR #86)
* @lastModified 2025-07-28 22:48:26
 * -----------------------------------------------------------
 * @todo
 * - none
*/

"use strict";

import {
  monitorData,
  currentHostname,
  setStoredData
} from "./dashboard_data.js";
import { saveUnifiedStorage } from "./dashboard_storage.js";
import { consumeInventory } from "./dashboard_filament_inventory.js";
import { updateStoredDataToDOM } from "./dashboard_ui.js";
import { updateHistoryList } from "./dashboard_printmanager.js";
import { getDeviceIp } from "./dashboard_connection.js";

// Material density [g/cm^3]
export const MATERIAL_DENSITY = {
  PLA: 1.24,
  PETG: 1.27,
  ABS: 1.04,
  TPU: 1.20
};

export function getMaterialDensity(mat) {
  return MATERIAL_DENSITY[mat] || MATERIAL_DENSITY.PLA;
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
 * monitorData.currentSpoolId を参照するだけで副作用はない。
 * @function getCurrentSpoolId
 * @returns {string|null} - 現在のスプールID。未設定時は null
 */
export function getCurrentSpoolId() {
  return monitorData.currentSpoolId;
}

/**
 * 現在使用中のスプール情報を取得する。
 * {@link getSpoolById} を利用する単純な参照で副作用はない。
 * @function getCurrentSpool
 * @returns {Object|null} - 現在のスプールオブジェクト。無い場合は null
 */
export function getCurrentSpool() {
  return getSpoolById(monitorData.currentSpoolId);
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
 * @returns {void}
 */
export function setCurrentSpoolId(id) {
  const prevId = monitorData.currentSpoolId;
  if (prevId === id) return;
  const prevSpool = getSpoolById(prevId);
  const newSpool = getSpoolById(id);

  const machine = monitorData.machines[currentHostname] || {};
  const printId = machine.printStore?.current?.id ?? "";

  let remaining = 0;
  if (prevSpool && prevSpool.currentJobStartLength != null) {
    const used = prevSpool.currentJobStartLength - prevSpool.remainingLengthMm;
    const expected = prevSpool.currentJobExpectedLength ?? used;
    remaining = Math.max(0, expected - used);
    finalizeFilamentUsage(used, prevSpool.currentPrintID);
  }

  monitorData.currentSpoolId = id;
  monitorData.filamentSpools.forEach(sp => {
    sp.isActive = sp.id === id;
    sp.isInUse = sp.id === id;
  });


  if (prevSpool) {
    if (Array.isArray(prevSpool.printIdRanges) && prevSpool.printIdRanges.length) {
      const r = prevSpool.printIdRanges[prevSpool.printIdRanges.length - 1];
      if (r && r.endPrintID == null) {
        r.endPrintID = String(printId || prevSpool.currentPrintID || "");
      }
    }
    prevSpool.removedAt = Date.now();
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
    newSpool.isPending = true;
    if (remaining > 0) {
      // 継続ジョブの残り分を新しいスプールに予約
      reserveFilament(remaining, printId);
    }
    // UI に即座に残量を反映させるため storedData を更新
    setStoredData("filamentRemainingMm", newSpool.remainingLengthMm, true);
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
        const baseUrl = `http://${getDeviceIp()}:80`;
        updateHistoryList([buf], baseUrl);
      }
    }
  }

  // 現在スプールの残量を storedData に即時反映
  if (newSpool) {
    setStoredData("filamentRemainingMm", newSpool.remainingLengthMm, true);
    updateStoredDataToDOM();
  }

  saveUnifiedStorage();
}

/**
 * 新しいスプール（フィラメントリール）情報を追加する
 *
 * @param {Object} data 追加するスプール情報オブジェクト
 * @param {boolean} [data.isFavorite] お気に入りフラグ
 * @returns {Object} 登録されたスプールオブジェクト
 */
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
    isDeleted: false

  };
  monitorData.filamentSpools.push(spool);
  saveUnifiedStorage();
  return spool;
}

export function updateSpool(id, patch) {
  const s = monitorData.filamentSpools.find(sp => sp.id === id);
  if (!s) return;
  Object.assign(s, patch);
  saveUnifiedStorage();
}

export function deleteSpool(id) {
  const s = monitorData.filamentSpools.find(sp => sp.id === id);
  if (!s) return;
  if (Array.isArray(s.printIdRanges) && s.printIdRanges.length) {
    const machine = monitorData.machines[currentHostname] || {};
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
  if (monitorData.currentSpoolId === id) monitorData.currentSpoolId = null;
  saveUnifiedStorage();
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
  saveUnifiedStorage();
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
  saveUnifiedStorage();
}

/**
 * スプール使用履歴を追加するヘルパー。
 *
 * @private
 * @param {Object} spool - 対象スプール
 * @param {number} lengthMm - 使用した長さ [mm]
 * @param {string} jobId - 関連ジョブID
 * @returns {void}
 */
function logUsage(spool, lengthMm, jobId) {
  monitorData.usageHistory.push({
    usageId: Date.now(),
    spoolId: spool.id,
    spoolSerial: spool.serialNo,
    jobId,
    startedAt: Date.now(),
    usedLength: lengthMm,
    currentLength: spool.remainingLengthMm
  });
  saveUnifiedStorage();
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
  saveUnifiedStorage();
}

export function useFilament(lengthMm, jobId = "") {
  const s = getCurrentSpool();
  if (!s) return;
  const machine = monitorData.machines[currentHostname];
  if (machine?.printStore?.current) {
    machine.printStore.current.filamentId = s.id;
  }
  if (s.isPending) {
    logSpoolChange(s, jobId);
    s.isPending = false;
  }
  // 現在の印刷ジョブ開始時点の残量と必要量を記録
  s.currentJobStartLength = s.remainingLengthMm;
  s.currentJobExpectedLength = lengthMm;
  // 残量を先に減算して保持
  s.remainingLengthMm = Math.max(0, s.remainingLengthMm - lengthMm);
  s.currentPrintID = jobId;
  s.usedLengthLog.push({ jobId, used: lengthMm });
  // ページリロード直後でも残量が巻き戻らないよう即座に保存
  saveUnifiedStorage();
}

/**
 * 現在の印刷ジョブに必要なフィラメント長を予約する。
 * 残量は減算せず開始時の値を保持するのみで、実際の減算は完了時に行う。
 * 履歴バッファへスプール情報を追記後、{@link updateHistoryList} を利用して
 * 永続化と画面反映を行う。
 *
 * @function reserveFilament
 * @param {number} lengthMm - 予定消費量 [mm]
 * @param {string} [jobId=""] - 印刷ジョブID
 * @returns {void}
 */
export function reserveFilament(lengthMm, jobId = "") {
  const s = getCurrentSpool();
  if (!s) return;
  const machine = monitorData.machines[currentHostname];
  if (machine?.printStore?.current) {
    machine.printStore.current.filamentId = s.id;
  }
  if (s.isPending) {
    logSpoolChange(s, jobId);
    s.isPending = false;
  }
  s.currentJobStartLength = s.remainingLengthMm;
  s.currentJobExpectedLength = lengthMm;
  s.currentPrintID = jobId;
  // --- 印刷開始時点で履歴にスプール情報を記録 -------------------
  let entry = null;
  if (machine && Array.isArray(machine.historyData)) {
    entry = machine.historyData.find(h => h.id === jobId);
    if (!entry) {
      entry = { id: jobId };
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
  saveUnifiedStorage();
  if (entry) {
    const baseUrl = `http://${getDeviceIp()}:80`;
    updateHistoryList([entry], baseUrl);
  }
}

/**
 * 実際に使用したフィラメント長を残量に反映して確定する。
 * 予約時に記録した startLength から使用量を差し引き更新する。
 *
 * @function finalizeFilamentUsage
 * @param {number} lengthMm - 実使用量 [mm]
 * @param {string} [jobId=""] - 印刷ジョブID
 * @returns {void}
 * @description
 * 使用完了時点のスプール情報を履歴にスナップショットとして保存する。
 * スプール名や色を後から変更しても当時の状態を保持するため、
 * name/color/material などのメタ情報を同時に記録する。
 * 履歴更新後は {@link updateHistoryList} を介して永続化し UI へ即時反映する。
 */
export function finalizeFilamentUsage(lengthMm, jobId = "") {
  const s = getCurrentSpool();
  if (!s || s.currentPrintID !== jobId) return;
  const startLen = s.currentJobStartLength ?? s.remainingLengthMm;
  const used = Number(lengthMm);
  if (!isNaN(used)) {
    s.remainingLengthMm = Math.max(0, startLen - used);
  }
  s.printCount = (s.printCount || 0) + 1;
  s.currentJobStartLength = null;
  s.currentJobExpectedLength = null;
  s.currentPrintID = "";
  s.usedLengthLog.push({ jobId, used: used });
  // 現在のスプール情報を履歴に追加
  const machine = monitorData.machines[currentHostname];
  let entry = null;
  if (machine && Array.isArray(machine.historyData)) {
    entry = machine.historyData.find(h => h.id === jobId);
    if (!entry) {
      entry = { id: jobId };
      machine.historyData.push(entry);
    }
    entry.filamentInfo ??= [];
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
  logUsage(s, used, jobId);
  updateStoredDataToDOM();
  saveUnifiedStorage();
  if (entry) {
    const baseUrl = `http://${getDeviceIp()}:80`;
    updateHistoryList([entry], baseUrl);
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
    saveUnifiedStorage();
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
export function autoCorrectCurrentSpool() {
  const spool = getCurrentSpool();
  if (!spool) return;

  const logs = monitorData.usageHistory;
  if (!Array.isArray(logs) || logs.length === 0) return;

  let startIdx = -1;
  let change = null;
  // 最新から過去に向かって交換記録を検索
  for (let i = logs.length - 1; i >= 0; i--) {
    const e = logs[i];
    if (e.startLength != null) {
      if (e.spoolId === spool.id) {
        change = e;
        startIdx = i;
        break;
      }
      // 他スプールへの交換が後にあれば補正不可
      if (!change) return;
    }
  }
  if (!change) return;

  // 履歴から取得した開始残量が数値でなければ補正不能と判断
  const startLen = Number(change.startLength);
  if (!Number.isFinite(startLen)) return;

  let total = 0;
  let count = 0;
  for (let i = startIdx + 1; i < logs.length; i++) {
    const e = logs[i];
    if (e.startLength != null) break; // 次の交換で終了
    if (e.spoolId !== spool.id) continue;
    const u = Number(e.usedLength);
    if (!isNaN(u)) {
      total += u;
      count += 1;
    }
  }

  // 計算された残量が有限値でなければ補正しない
  const expected = Math.max(0, startLen - total);
  if (!Number.isFinite(expected)) return;
  const diff = Math.abs(expected - spool.remainingLengthMm);
  if (Number.isFinite(diff) && (diff > 0.1 || spool.printCount !== count)) {
    spool.remainingLengthMm = expected;
    spool.printCount = count;
    saveUnifiedStorage();
  }
}
