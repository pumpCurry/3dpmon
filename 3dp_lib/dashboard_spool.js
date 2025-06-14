"use strict";

/**
 * @fileoverview
 * フィラメントスプールの一覧と選択状態を管理するモジュール。
 * CRUD 操作と使用量の更新を担当します。
 */
import { monitorData } from "./dashboard_data.js";
import { saveUnifiedStorage } from "./dashboard_storage.js";

/**
 * 一意なスプールIDを生成します。
 * @returns {string} 生成されたID文字列
 */
function genId() {
  return `spool_${Date.now()}_${Math.random().toString(16).slice(2,8)}`;
}

/**
 * スプール一覧を取得します。
 * @param {boolean} [includeDeleted=false] - 削除フラグの立ったスプールも含める場合は true
 * @returns {Array<Object>} スプールオブジェクト配列
 */
export function getSpools(includeDeleted = false) {
  return includeDeleted ? monitorData.filamentSpools : monitorData.filamentSpools.filter(s => !s.deleted);
}

/**
 * 指定IDのスプールを取得します。
 * @param {string} id - スプールID
 * @returns {Object|null} 見つかったスプール、存在しない場合 null
 */
export function getSpoolById(id) {
  return monitorData.filamentSpools.find(s => s.id === id && !s.deleted) || null;
}

/**
 * 現在選択中のスプールIDを返します。
 * @returns {string|null} 選択されていない場合は null
 */
export function getCurrentSpoolId() {
  return monitorData.currentSpoolId;
}

/**
 * 現在選択中のスプールオブジェクトを返します。
 * @returns {Object|null} 選択スプール、存在しない場合 null
 */
export function getCurrentSpool() {
  return getSpoolById(monitorData.currentSpoolId);
}

/**
 * 選択中スプールIDを設定します。
 * @param {string|null} id - 設定するスプールID
 * @returns {void}
 */
export function setCurrentSpoolId(id) {
  monitorData.currentSpoolId = id;
  saveUnifiedStorage();
}

/**
 * 新しいスプールを追加します。
 * @param {Object} data - 追加するスプール情報
 * @returns {Object} 追加されたスプールオブジェクト
 */
export function addSpool(data) {
  const spool = {
    id: genId(),
    name: data.name || "",
    color: data.color || "",
    material: data.material || "",
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
    manufacturerName: data.manufacturerName || "",
    purchasePrice: Number(data.purchasePrice) || 0,
    density: Number(data.density) || 0,
    totalLengthMm: Number(data.totalLengthMm) || 0,
    remainingLengthMm: Number(data.remainingLengthMm) || 0,
    deleted: false,
    // old keys for backward compatibility
    color: data.color || "",
    material: data.material || ""
  };
  monitorData.filamentSpools.push(spool);
  saveUnifiedStorage();
  return spool;
}

/**
 * 既存スプールの情報を更新します。
 * @param {string} id - 更新対象スプールID
 * @param {Object} patch - 更新するプロパティ群
 * @returns {void}
 */
export function updateSpool(id, patch) {
  const s = monitorData.filamentSpools.find(sp => sp.id === id);
  if (!s) return;
  Object.assign(s, patch);
  saveUnifiedStorage();
}

/**
 * スプールを論理削除します。
 * @param {string} id - 削除対象ID
 * @returns {void}
 */
export function deleteSpool(id) {
  const s = monitorData.filamentSpools.find(sp => sp.id === id);
  if (!s) return;
  s.deleted = true;
  if (monitorData.currentSpoolId === id) monitorData.currentSpoolId = null;
  saveUnifiedStorage();
}

/**
 * 現在選択中のスプールの残量を減らします。
 * @param {number} lengthMm - 使用したフィラメント長(mm)
 * @returns {void}
 */
export function useFilament(lengthMm) {
  const s = getCurrentSpool();
  if (!s) return;
  s.remainingLengthMm = Math.max(0, s.remainingLengthMm - lengthMm);
  saveUnifiedStorage();
}
