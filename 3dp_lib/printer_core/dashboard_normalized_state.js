/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 normalized state モジュール
 * @file dashboard_normalized_state.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_normalized_state
 *
 * 【機能内容サマリ】
 * - Adapter が生成する NormalizedPrinterState の標準形を提供
 * - K1 系 WS9999 status payload を legacy processData と比較しやすい状態へ正規化
 * - 温度、ファン、印刷状態、位置、エラー、AI/カメラ能力を意味単位へ分解
 *
 * 【公開関数一覧】
 * - {@link createEmptyNormalizedPrinterState}：空の NormalizedPrinterState を生成
 * - {@link normalizeK1StatusPayload}：K1 系 payload を NormalizedPrinterState へ変換
 * - {@link toFiniteNumber}：実機 payload の数値文字列を安全に number 化
 * - {@link parseK1Position}：`X:... Y:... Z:...` 形式の現在位置を分解
 *
 * @version 1.390.1296 (PR #432)
 * @since   1.390.1296 (PR #432)
 * @lastModified 2026-08-07 11:42:13
 * -----------------------------------------------------------
 * @todo
 * - Gate 3 以降で K2 Pro Combo / CFS topology の正規化フィールドを追加する
 */

"use strict";

import { EMPTY_CAPABILITY_SET } from "./dashboard_capabilities.js";

/**
 * NormalizedPrinterState の schema version。
 *
 * 【詳細説明】
 * - Gate 2 では dry-run 比較用の version であり、永続 Data Schema v3 の store version ではない。
 *
 * @constant {number}
 */
export const NORMALIZED_PRINTER_STATE_SCHEMA_VERSION = 1;

/**
 * K1 系印刷状態コードと Printer Core v3 ラベルの対応。
 *
 * 【詳細説明】
 * - legacy `PRINT_STATE_CODE` と同じ数値を維持し、UI の既存語彙へ接続しやすくする。
 *
 * @constant {object}
 */
const K1_PRINT_STATE_LABELS = Object.freeze({
  0: "idle",
  1: "printing",
  2: "completed",
  3: "checking",
  4: "failed",
  5: "paused",
});

/**
 * 実機 payload 値を有限 number へ変換する。
 *
 * 【詳細説明】
 * - K1 系 firmware は温度などを `"27.500000"` のような文字列で返す。
 * - 空文字、null、undefined、NaN、Infinity は `fallback` へ寄せる。
 *
 * @function toFiniteNumber
 * @param {*} value - 数値候補
 * @param {?number=} fallback - 変換不能な場合の戻り値
 * @returns {?number} 有限 number、または fallback
 * @example
 * const nozzleTemp = toFiniteNumber(payload.nozzleTemp);
 */
export function toFiniteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

/**
 * 実機 payload 値を percent 値へ変換する。
 *
 * 【詳細説明】
 * - 0 未満や 100 超の外れ値は表示崩れを防ぐため 0..100 に丸める。
 * - 変換不能な値は null として扱い、0 と区別する。
 *
 * @function toPercentNumber
 * @param {*} value - percent 値候補
 * @returns {?number} 0..100 の number、または null
 * @example
 * const fanPct = toPercentNumber(payload.modelFanPct);
 */
export function toPercentNumber(value) {
  const numberValue = toFiniteNumber(value);
  if (numberValue === null) {
    return null;
  }
  return Math.max(0, Math.min(100, numberValue));
}

/**
 * 最初に取得できた有限 number を返す。
 *
 * 【詳細説明】
 * - firmware 差で同じ値が複数 key に出るため、優先順位を配列で表現する。
 *
 * @private
 * @param {Array<*>} values - 数値候補の配列
 * @returns {?number} 最初に変換できた有限 number、または null
 */
function firstFiniteNumber(values) {
  for (const value of values) {
    const numberValue = toFiniteNumber(value);
    if (numberValue !== null) {
      return numberValue;
    }
  }
  return null;
}

/**
 * 最初に取得できた percent number を返す。
 *
 * 【詳細説明】
 * - `modelFanPct` 系がある場合はそちらを優先し、旧 `fan` 系を fallback とする。
 *
 * @private
 * @param {Array<*>} values - percent 候補の配列
 * @returns {?number} 最初に変換できた percent number、または null
 */
function firstPercentNumber(values) {
  for (const value of values) {
    const percentValue = toPercentNumber(value);
    if (percentValue !== null) {
      return percentValue;
    }
  }
  return null;
}

/**
 * string 値を null 許容の trimmed string へ変換する。
 *
 * 【詳細説明】
 * - 空文字は legacy の意味を壊さないため空文字のまま返す。
 * - null / undefined は未観測として null を返す。
 *
 * @private
 * @param {*} value - 文字列候補
 * @returns {?string} 文字列、または null
 */
function toNullableString(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

/**
 * K1 系 `curPosition` 文字列を XYZ 座標へ分解する。
 *
 * 【詳細説明】
 * - legacy `parseCurPosition()` と同じ `X:... Y:... Z:...` 形式を受け付ける。
 * - 一部軸が欠ける値は壊れた payload とみなし null を返す。
 *
 * @function parseK1Position
 * @param {*} value - `curPosition` 値
 * @returns {{x: number, y: number, z: number, raw: string}|null} 分解済み座標、または null
 * @example
 * const position = parseK1Position("X:296.50 Y:220.00 Z:300.16");
 */
export function parseK1Position(value) {
  if (typeof value !== "string") {
    return null;
  }
  const x = value.match(/X:\s*([-+]?\d+(?:\.\d+)?)/iu);
  const y = value.match(/Y:\s*([-+]?\d+(?:\.\d+)?)/iu);
  const z = value.match(/Z:\s*([-+]?\d+(?:\.\d+)?)/iu);
  if (!x || !y || !z) {
    return null;
  }
  return {
    x: Number(x[1]),
    y: Number(y[1]),
    z: Number(z[1]),
    raw: value,
  };
}

/**
 * payload の key 一覧を比較しやすい配列へ変換する。
 *
 * 【詳細説明】
 * - differential test で「この状態はどの raw field から来たか」を追えるようにする。
 *
 * @private
 * @param {object|null|undefined} payload - WS9999 status payload
 * @returns {string[]} ソート済み key 一覧
 */
function listRawKeys(payload) {
  return payload && typeof payload === "object" ? Object.keys(payload).sort() : [];
}

/**
 * 温度系 payload を NormalizedPrinterState の温度 object へ変換する。
 *
 * 【詳細説明】
 * - nozzle / bed / chamber を固定 slot とし、存在しない値は null にする。
 *
 * @private
 * @param {object} payload - K1 系 WS9999 status payload
 * @returns {object} 正規化済み温度 object
 */
function normalizeTemperatures(payload) {
  return {
    nozzle: {
      current: toFiniteNumber(payload.nozzleTemp),
      target: toFiniteNumber(payload.targetNozzleTemp),
      max: toFiniteNumber(payload.maxNozzleTemp),
    },
    bed: {
      current: firstFiniteNumber([payload.bedTemp0, payload.bedTemp1, payload.bedTemp2]),
      target: firstFiniteNumber([payload.targetBedTemp0, payload.targetBedTemp1, payload.targetBedTemp2]),
      max: toFiniteNumber(payload.maxBedTemp),
    },
    chamber: {
      current: toFiniteNumber(payload.boxTemp),
      target: toFiniteNumber(payload.targetBoxTemp),
      max: toFiniteNumber(payload.maxBoxTemp),
    },
  };
}

/**
 * ファン系 payload を NormalizedPrinterState のファン object へ変換する。
 *
 * 【詳細説明】
 * - `modelFanPct` / `auxiliaryFanPct` / `caseFanPct` を優先し、旧名 `fan` 系へ fallback する。
 *
 * @private
 * @param {object} payload - K1 系 WS9999 status payload
 * @returns {object} 正規化済み fan object
 */
function normalizeFans(payload) {
  return {
    partCoolingPct: firstPercentNumber([payload.modelFanPct, payload.fan]),
    auxiliaryPct: firstPercentNumber([payload.auxiliaryFanPct, payload.fanAuxiliary]),
    chamberPct: firstPercentNumber([payload.caseFanPct, payload.fanCase]),
  };
}

/**
 * K1 系状態コードを Printer Core v3 ラベルへ変換する。
 *
 * 【詳細説明】
 * - 未知の状態コードは `unknown` として保持し、元コードは `stateCode` に残す。
 *
 * @private
 * @param {*} stateCode - K1 系 `state` 値
 * @returns {{stateCode: ?number, stateLabel: string}} 状態コードとラベル
 */
function normalizePrintState(stateCode) {
  const code = toFiniteNumber(stateCode);
  return {
    stateCode: code,
    stateLabel: code === null ? "unknown" : (K1_PRINT_STATE_LABELS[code] || "unknown"),
  };
}

/**
 * 印刷ジョブ系 payload を NormalizedPrinterState の print object へ変換する。
 *
 * 【詳細説明】
 * - legacy processData と同じく `printFileName` を優先し、`fileName` を fallback にする。
 * - `printStartTime` は ID として使われるため数値化して `startedAtSec` に保持する。
 *
 * @private
 * @param {object} payload - K1 系 WS9999 status payload
 * @returns {object} 正規化済み print object
 */
function normalizePrint(payload) {
  const state = normalizePrintState(payload.state);
  return {
    ...state,
    deviceStateCode: toFiniteNumber(payload.deviceState),
    progressPct: firstPercentNumber([payload.printProgress, payload.dProgress]),
    layer: toFiniteNumber(payload.layer),
    totalLayer: toFiniteNumber(payload.TotalLayer),
    remainingSec: toFiniteNumber(payload.printLeftTime),
    elapsedSec: toFiniteNumber(payload.printJobTime),
    fileName: toNullableString(payload.printFileName ?? payload.fileName),
    jobId: toNullableString(payload.printId),
    startedAtSec: toFiniteNumber(payload.printStartTime),
  };
}

/**
 * エラー payload を NormalizedPrinterState の error object へ変換する。
 *
 * 【詳細説明】
 * - legacy processData は `err.errcode` と `err.key` を通知重複判定に使うため、同じ値を保持する。
 * - エラーなしは `active:false` として表す。
 *
 * @private
 * @param {object} payload - K1 系 WS9999 status payload
 * @returns {object} 正規化済み error object
 */
function normalizeError(payload) {
  const raw = payload.err && typeof payload.err === "object" ? payload.err : null;
  const code = toFiniteNumber(raw?.errcode);
  const key = toFiniteNumber(raw?.key);
  return {
    active: !!raw && !(code === 0 && key === 0),
    code,
    key,
    value: raw && Object.prototype.hasOwnProperty.call(raw, "value") ? toNullableString(raw.value) : null,
    raw,
  };
}

/**
 * AI 関連 payload を NormalizedPrinterState の ai object へ変換する。
 *
 * 【詳細説明】
 * - K1/K2 系 firmware は AI 機能を複数 flag で返すため、各 flag をそのまま number で保持する。
 *
 * @private
 * @param {object} payload - K1 系 WS9999 status payload
 * @returns {object} 正規化済み AI object
 */
function normalizeAi(payload) {
  return {
    detection: toFiniteNumber(payload.aiDetection),
    switchEnabled: toFiniteNumber(payload.aiSw),
    pauseOnDetection: toFiniteNumber(payload.aiPausePrint),
    firstLayer: toFiniteNumber(payload.aiFirstFloor),
  };
}

/**
 * カメラ関連 payload を NormalizedPrinterState の camera object へ変換する。
 *
 * 【詳細説明】
 * - `video` / `video1` / `webrtcSupport` を boolean capability として扱う。
 *
 * @private
 * @param {object} payload - K1 系 WS9999 status payload
 * @returns {object} 正規化済み camera object
 */
function normalizeCamera(payload) {
  return {
    mjpeg: Number(payload.video) === 1 || Number(payload.video1) === 1,
    webrtc: Number(payload.webrtcSupport) === 1,
    timelapseEnabled: Number(payload.videoElapse) === 1,
  };
}

/**
 * 空の NormalizedPrinterState を生成する。
 *
 * 【詳細説明】
 * - Adapter がまだ frame を観測していない Instance でも同じ形状を返す。
 * - 呼び出し側が deviceId や sessionId を注入できるよう options を受け取る。
 *
 * @function createEmptyNormalizedPrinterState
 * @param {object=} options - 生成オプション
 * @param {?string=} options.deviceId - 物理機 identity
 * @param {?string=} options.sessionId - 接続セッション ID
 * @param {?string=} options.adapterId - Adapter ID
 * @returns {object} 空の NormalizedPrinterState
 * @example
 * const state = createEmptyNormalizedPrinterState({ deviceId: "serial:demo" });
 */
export function createEmptyNormalizedPrinterState(options = {}) {
  return {
    schemaVersion: NORMALIZED_PRINTER_STATE_SCHEMA_VERSION,
    source: {
      adapterId: options.adapterId ?? null,
      protocol: options.protocol ?? null,
      sequence: options.sequence ?? 0,
      receivedAt: options.receivedAt ?? null,
      rawKeys: [],
    },
    identity: {
      deviceId: options.deviceId ?? null,
      sessionId: options.sessionId ?? null,
      reportedModel: null,
      reportedHostname: null,
    },
    capabilities: options.capabilities ?? EMPTY_CAPABILITY_SET,
    temperatures: normalizeTemperatures({}),
    fans: normalizeFans({}),
    light: {
      enabled: null,
    },
    print: normalizePrint({}),
    motion: {
      position: null,
      rawPosition: null,
    },
    error: normalizeError({}),
    camera: normalizeCamera({}),
    ai: normalizeAi({}),
  };
}

/**
 * K1 系 WS9999 status payload を NormalizedPrinterState へ変換する。
 *
 * 【詳細説明】
 * - Gate 2 では legacy processData と並走する dry-run 状態を生成するだけで、UI へは送らない。
 * - raw field の意味を壊さず比較できるよう、未観測値は null として明示する。
 *
 * @function normalizeK1StatusPayload
 * @param {object|null|undefined} payload - K1 系 WS9999 status payload
 * @param {object=} options - 正規化オプション
 * @param {?string=} options.deviceId - 物理機 identity
 * @param {?string=} options.sessionId - 接続セッション ID
 * @param {?string=} options.adapterId - Adapter ID
 * @param {?string=} options.protocol - 受信 protocol 名
 * @param {?number=} options.sequence - Instance 内の受信順序
 * @param {?string=} options.receivedAt - 受信時刻 ISO 文字列
 * @param {object=} options.capabilities - Adapter が推定した capability set
 * @returns {object} 正規化済み NormalizedPrinterState
 * @example
 * const state = normalizeK1StatusPayload(payload, { adapterId: "creality-k1" });
 */
export function normalizeK1StatusPayload(payload, options = {}) {
  if (!payload || typeof payload !== "object") {
    return createEmptyNormalizedPrinterState(options);
  }

  const position = parseK1Position(payload.curPosition);
  return {
    schemaVersion: NORMALIZED_PRINTER_STATE_SCHEMA_VERSION,
    source: {
      adapterId: options.adapterId ?? "creality-k1",
      protocol: options.protocol ?? "ws9999",
      sequence: options.sequence ?? 0,
      receivedAt: options.receivedAt ?? null,
      rawKeys: listRawKeys(payload),
    },
    identity: {
      deviceId: options.deviceId ?? null,
      sessionId: options.sessionId ?? null,
      reportedModel: toNullableString(payload.model),
      reportedHostname: toNullableString(payload.hostname ?? payload.deviceName),
    },
    capabilities: options.capabilities ?? EMPTY_CAPABILITY_SET,
    temperatures: normalizeTemperatures(payload),
    fans: normalizeFans(payload),
    light: {
      enabled: payload.lightSw === null || payload.lightSw === undefined ? null : Number(payload.lightSw) === 1,
    },
    print: normalizePrint(payload),
    motion: {
      position: position ? { x: position.x, y: position.y, z: position.z } : null,
      rawPosition: position?.raw ?? null,
    },
    error: normalizeError(payload),
    camera: normalizeCamera(payload),
    ai: normalizeAi(payload),
  };
}
