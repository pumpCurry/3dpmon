/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 capability model モジュール
 * @file dashboard_capabilities.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_capabilities
 *
 * 【機能内容サマリ】
 * - Printer Core v3 が UI や Adapter へ公開する capability 名を定義
 * - K1/K2 系 WS9999 status payload から観測済み capability を推定
 * - capability 配列を決定的な set 形状へ正規化
 *
 * 【公開関数一覧】
 * - {@link createCapabilitySet}：capability 名の集合を決定的な object へ正規化
 * - {@link hasCapability}：capability set に指定 capability が含まれるか判定
 * - {@link mergeCapabilitySets}：複数 capability set を重複なく統合
 * - {@link inferK1Capabilities}：K1 系 payload から capability set を推定
 * - {@link inferK2Capabilities}：K2 系 payload から capability set を推定
 *
 * @version 1.390.1303 (PR #432)
 * @since   1.390.1296 (PR #432)
 * @lastModified 2026-08-07 21:00:10
 * -----------------------------------------------------------
 * @todo
 * - CFS-C 実機 fixture 取得後に CFS-C 固有 capability を追加する
 */

"use strict";

/**
 * Printer Core v3 capability set の schema version。
 *
 * 【詳細説明】
 * - capability 名そのものは文字列で表現し、set object 側に version を持たせる。
 *
 * @constant {number}
 */
export const PRINTER_CAPABILITY_SCHEMA_VERSION = 1;

/**
 * Printer Core v3 で扱う capability 名。
 *
 * 【詳細説明】
 * - 名前空間を `domain.feature` 形式へ揃え、Adapter と UI の結合を避ける。
 * - Gate 2 では K1 dry-run 比較に必要な状態観測 capability を中心に定義する。
 *
 * @constant {object}
 */
export const PRINTER_CAPABILITIES = Object.freeze({
  CAMERA_MJPEG: "camera.mjpeg",
  CAMERA_WEBRTC: "camera.webrtc",
  COMMAND_LED: "command.led",
  MATERIAL_CFS: "material.cfs",
  MATERIAL_CFS_TOPOLOGY: "material.cfsTopology",
  MATERIAL_EXTERNAL_SOURCE: "material.externalSource",
  MATERIAL_MULTI_SOURCE: "material.multiSource",
  STATUS_AI_DETECTION: "status.aiDetection",
  STATUS_ERROR: "status.error",
  STATUS_FANS: "status.fans",
  STATUS_LAYERS: "status.layers",
  STATUS_LIGHT: "status.light",
  STATUS_POSITION: "status.position",
  STATUS_PRINT_JOB: "status.printJob",
  STATUS_PROGRESS: "status.progress",
  STATUS_TEMPERATURES: "status.temperatures",
});

/**
 * 空の capability set。
 *
 * 【詳細説明】
 * - payload が取得できない Instance でも同じ形状を返せるように共通定数化する。
 *
 * @constant {object}
 */
export const EMPTY_CAPABILITY_SET = Object.freeze({
  schemaVersion: PRINTER_CAPABILITY_SCHEMA_VERSION,
  values: Object.freeze([]),
});

/**
 * capability 名を比較用の標準形へ変換する。
 *
 * 【詳細説明】
 * - capability は ASCII の名前空間文字列として扱う。
 * - 空文字や null は capability として採用しない。
 *
 * @private
 * @param {*} value - capability 名候補
 * @returns {?string} 標準化した capability 名、または null
 */
function normalizeCapabilityName(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

/**
 * object が指定 key を自前プロパティとして持つか判定する。
 *
 * 【詳細説明】
 * - payload は実機由来の plain object を想定するが、fixture やテストでは prototype が異なる
 *   object も渡り得るため、`Object.prototype.hasOwnProperty.call` に統一する。
 *
 * @private
 * @param {object|null|undefined} object - 検査対象 object
 * @param {string} key - 検査する key
 * @returns {boolean} key が存在する場合 true
 */
function hasOwn(object, key) {
  return !!object && Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * payload に指定 key のいずれかが含まれるか判定する。
 *
 * 【詳細説明】
 * - K1 firmware は同じ意味の値を `fan` と `modelFanPct` のように複数名で返すことがある。
 *
 * @private
 * @param {object|null|undefined} payload - WS9999 status payload
 * @param {string[]} keys - 検査する key 一覧
 * @returns {boolean} いずれかの key が存在する場合 true
 */
function hasAny(payload, keys) {
  return keys.some((key) => hasOwn(payload, key));
}

/**
 * K2 `boxsInfo` から観測された material source 数を数える。
 *
 * 【詳細説明】
 * - `materialBoxs` は CFS unit / external box の単位であり、source は `materials[]` の各 entry として扱う。
 *
 * @private
 * @param {object|null|undefined} boxsInfo - K2 `boxsInfo` payload
 * @returns {number} 観測された material source 数
 */
function countK2MaterialSources(boxsInfo) {
  const boxes = Array.isArray(boxsInfo?.materialBoxs) ? boxsInfo.materialBoxs : [];
  return boxes.reduce((count, box) => {
    return count + (Array.isArray(box?.materials) ? box.materials.length : 0);
  }, 0);
}

/**
 * capability 名の集合を決定的な object へ正規化する。
 *
 * 【詳細説明】
 * - 重複を除き、文字列順に並べることで fixture 比較と snapshot 比較を安定させる。
 * - unknown capability も将来互換のため拒否せず保持する。
 *
 * @function createCapabilitySet
 * @param {Array<*>} values - capability 名候補の配列
 * @returns {{schemaVersion: number, values: string[]}} 正規化済み capability set
 * @example
 * const capabilities = createCapabilitySet(["status.temperatures", "status.temperatures"]);
 */
export function createCapabilitySet(values) {
  const uniqueValues = Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => normalizeCapabilityName(value))
    .filter(Boolean))).sort();
  return {
    schemaVersion: PRINTER_CAPABILITY_SCHEMA_VERSION,
    values: uniqueValues,
  };
}

/**
 * capability set に指定 capability が含まれるか判定する。
 *
 * 【詳細説明】
 * - 配列そのもの、または `createCapabilitySet()` の戻り値のどちらも受け付ける。
 *
 * @function hasCapability
 * @param {Array<string>|object|null|undefined} capabilitySet - capability set または配列
 * @param {string} capability - 検査する capability 名
 * @returns {boolean} capability が含まれる場合 true
 * @example
 * const canShowCamera = hasCapability(state.capabilities, PRINTER_CAPABILITIES.CAMERA_MJPEG);
 */
export function hasCapability(capabilitySet, capability) {
  const values = Array.isArray(capabilitySet) ? capabilitySet : capabilitySet?.values;
  const normalized = normalizeCapabilityName(capability);
  return !!normalized && Array.isArray(values) && values.includes(normalized);
}

/**
 * 複数 capability set を重複なく統合する。
 *
 * 【詳細説明】
 * - Instance が過去 frame で見た capability と最新 frame で見た capability を蓄積するために使う。
 *
 * @function mergeCapabilitySets
 * @param {...(Array<string>|object|null|undefined)} capabilitySets - 統合元 capability set 群
 * @returns {{schemaVersion: number, values: string[]}} 統合済み capability set
 * @example
 * const merged = mergeCapabilitySets(oldState.capabilities, newState.capabilities);
 */
export function mergeCapabilitySets(...capabilitySets) {
  const values = [];
  for (const capabilitySet of capabilitySets) {
    if (Array.isArray(capabilitySet)) {
      values.push(...capabilitySet);
    } else if (Array.isArray(capabilitySet?.values)) {
      values.push(...capabilitySet.values);
    }
  }
  return createCapabilitySet(values);
}

/**
 * K1 系 WS9999 status payload から capability set を推定する。
 *
 * 【詳細説明】
 * - capability は「この frame に値がある」ことを根拠に推定する。
 * - 推定は dry-run であり、後続 Gate で機種 catalog と統合して authority 化する。
 *
 * @function inferK1Capabilities
 * @param {object|null|undefined} payload - K1 系 WS9999 status payload
 * @returns {{schemaVersion: number, values: string[]}} 推定 capability set
 * @example
 * const capabilities = inferK1Capabilities(statusPayload);
 */
export function inferK1Capabilities(payload) {
  if (!payload || typeof payload !== "object") {
    return createCapabilitySet([]);
  }

  const values = [];
  if (hasAny(payload, ["nozzleTemp", "targetNozzleTemp", "bedTemp0", "targetBedTemp0", "boxTemp", "targetBoxTemp"])) {
    values.push(PRINTER_CAPABILITIES.STATUS_TEMPERATURES);
  }
  if (hasAny(payload, ["fan", "fanAuxiliary", "fanCase", "modelFanPct", "auxiliaryFanPct", "caseFanPct"])) {
    values.push(PRINTER_CAPABILITIES.STATUS_FANS);
  }
  if (hasAny(payload, ["curPosition", "autohome"])) {
    values.push(PRINTER_CAPABILITIES.STATUS_POSITION);
  }
  if (hasAny(payload, ["layer", "TotalLayer"])) {
    values.push(PRINTER_CAPABILITIES.STATUS_LAYERS);
  }
  if (hasAny(payload, ["printProgress", "dProgress"])) {
    values.push(PRINTER_CAPABILITIES.STATUS_PROGRESS);
  }
  if (hasAny(payload, ["state", "deviceState", "printFileName", "fileName", "printStartTime", "printId"])) {
    values.push(PRINTER_CAPABILITIES.STATUS_PRINT_JOB);
  }
  if (hasAny(payload, ["err"])) {
    values.push(PRINTER_CAPABILITIES.STATUS_ERROR);
  }
  if (hasAny(payload, ["lightSw"])) {
    values.push(PRINTER_CAPABILITIES.STATUS_LIGHT);
  }
  if (hasAny(payload, ["aiDetection", "aiSw", "aiPausePrint", "aiFirstFloor"])) {
    values.push(PRINTER_CAPABILITIES.STATUS_AI_DETECTION);
  }
  if (Number(payload.video) === 1 || Number(payload.video1) === 1) {
    values.push(PRINTER_CAPABILITIES.CAMERA_MJPEG);
  }
  if (Number(payload.webrtcSupport) === 1) {
    values.push(PRINTER_CAPABILITIES.CAMERA_WEBRTC);
  }
  if (hasAny(payload, ["materialDetect", "materialStatus"])) {
    values.push(PRINTER_CAPABILITIES.MATERIAL_EXTERNAL_SOURCE);
  }
  return createCapabilitySet(values);
}

/**
 * K2 系 WS9999 payload から capability set を推定する。
 *
 * 【詳細説明】
 * - K2 Pro Combo は K1 と近い status key を返すため、まず K1 推定結果を再利用する。
 * - `cfsConnect` と `boxsInfo` は CFS 接続と topology 観測を表すため、material 系 capability を追加する。
 * - Gate 4 では read-only 観測だけを扱い、CFS 制御 command capability は追加しない。
 *
 * @function inferK2Capabilities
 * @param {object|null|undefined} payload - K2 系 WS9999 payload
 * @returns {{schemaVersion: number, values: string[]}} 推定 capability set
 * @example
 * const capabilities = inferK2Capabilities({ model: "F012", cfsConnect: 1 });
 */
export function inferK2Capabilities(payload) {
  if (!payload || typeof payload !== "object") {
    return createCapabilitySet([]);
  }

  const values = [...inferK1Capabilities(payload).values];
  if (hasAny(payload, ["cfsConnect", "boxsInfo"])) {
    values.push(PRINTER_CAPABILITIES.MATERIAL_CFS);
  }
  if (payload.boxsInfo && typeof payload.boxsInfo === "object") {
    values.push(PRINTER_CAPABILITIES.MATERIAL_CFS_TOPOLOGY);
    if (countK2MaterialSources(payload.boxsInfo) > 1) {
      values.push(PRINTER_CAPABILITIES.MATERIAL_MULTI_SOURCE);
    }
  }
  return createCapabilitySet(values);
}
