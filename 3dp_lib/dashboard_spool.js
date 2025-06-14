"use strict";

import { monitorData } from "./dashboard_data.js";
import { saveUnifiedStorage } from "./dashboard_storage.js";

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
  monitorData.currentSpoolId = id;
  saveUnifiedStorage();
}

/**
 * 新しいスプール（フィラメントリール）情報を追加する
 *
 * @param {Object} data 追加するスプール情報オブジェクト
 * @returns {Object} 登録されたスプールオブジェクト
 */
export function addSpool(data) {
  // UI から渡されるデータを元に初期値を設定したスプールオブジェクトを生成する
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
    totalLengthMm: Number(data.totalLengthMm) || 0,
    remainingLengthMm: Number(data.remainingLengthMm) || 0,
    deleted: false,
    // 後方互換性維持のため旧フィールドを残しておく
    color: data.color || "",
    material: data.material || ""
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
  if (monitorData.currentSpoolId === id) monitorData.currentSpoolId = null;
  saveUnifiedStorage();
}

export function useFilament(lengthMm) {
  const s = getCurrentSpool();
  if (!s) return;
  s.remainingLengthMm = Math.max(0, s.remainingLengthMm - lengthMm);
  saveUnifiedStorage();
}
