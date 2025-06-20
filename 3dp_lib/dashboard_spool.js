/**
 * @fileoverview
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
 *
 * @version 1.390.322 (PR #144)
 * @since   1.390.193 (PR #86)
 * @lastModified 2025-06-20 17:18:46
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

function genId() {
  return `spool_${Date.now()}_${Math.random().toString(16).slice(2,8)}`;
}

export function getSpools(includeDeleted = false) {
  return includeDeleted ? monitorData.filamentSpools : monitorData.filamentSpools.filter(s => !s.deleted);
}

export function getSpoolById(id) {
  return monitorData.filamentSpools.find(s => s.id === id && !s.deleted) || null;
}

export function getCurrentSpoolId() {
  return monitorData.currentSpoolId;
}

export function getCurrentSpool() {
  return getSpoolById(monitorData.currentSpoolId);
}

export function setCurrentSpoolId(id) {
  const prevId = monitorData.currentSpoolId;
  if (prevId === id) return;
  const prevSpool = getSpoolById(prevId);
  const newSpool = getSpoolById(id);

  monitorData.currentSpoolId = id;
  monitorData.filamentSpools.forEach(sp => {
    sp.isActive = sp.id === id;
    sp.isInUse = sp.id === id;
  });
  const machine = monitorData.machines[currentHostname] || {};
  const printId = machine.printStore?.current?.id ?? "";

  if (prevSpool) {
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
      if (buf) buf.filamentId = newSpool.id;
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
  const spool = {
    id,
    spoolId: id,
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
  s.deleted = true;
  s.isDeleted = true;
  s.isInUse = false;
  s.isActive = false;
  s.removedAt = Date.now();
  if (monitorData.currentSpoolId === id) monitorData.currentSpoolId = null;
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
  monitorData.usageHistory.push({
    usageId: Date.now(),
    spoolId: spool.id,
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
    jobId,
    startedAt: Date.now(),
    usedLength: lengthMm,
    currentLength: spool.remainingLengthMm
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
  s.printCount = (s.printCount || 0) + 1;
  s.currentPrintID = jobId;
  s.usedLengthLog.push({ jobId, used: lengthMm });
  logUsage(s, lengthMm, jobId);
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
