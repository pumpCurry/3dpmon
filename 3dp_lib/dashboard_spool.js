"use strict";

import { monitorData } from "./dashboard_data.js";
import { saveUnifiedStorage } from "./dashboard_storage.js";

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
  monitorData.currentSpoolId = id;
  saveUnifiedStorage();
}

export function addSpool(data) {
  const spool = {
    id: genId(),
    name: data.name || "",
    color: data.color || "",
    material: data.material || "",
    totalLengthMm: Number(data.totalLengthMm) || 0,
    remainingLengthMm: Number(data.remainingLengthMm) || 0,
    weightGram: Number(data.weightGram) || 0,
    deleted: false
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
