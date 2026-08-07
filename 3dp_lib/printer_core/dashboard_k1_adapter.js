/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 K1 Adapter モジュール
 * @file dashboard_k1_adapter.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_k1_adapter
 *
 * 【機能内容サマリ】
 * - Creality K1/K1 Max 系 WS9999 frame を NormalizedPrinterState へ変換
 * - fixture event / raw payload の両方を dry-run 入力として受け付ける
 * - 送信経路を持たず、Gate 2 では legacy processData と並走する読み取り専用 Adapter として動作
 *
 * 【公開関数一覧】
 * - {@link extractK1StatusPayload}：fixture event や frame から status payload を抽出
 * - {@link K1Adapter}：K1 系 payload を正規化する Adapter class
 * - {@link createK1Adapter}：K1Adapter の factory
 *
 * @version 1.390.1298 (PR #432)
 * @since   1.390.1296 (PR #432)
 * @lastModified 2026-08-07 16:50:55
 * -----------------------------------------------------------
 * @todo
 * - K1C 実環境 fixture 取得後に K1C/CFS-C 固有差分を capability catalog へ追加する
 */

"use strict";

import { inferK1Capabilities } from "./dashboard_capabilities.js";
import { createK1StatusPatch } from "./dashboard_normalized_state.js";

/**
 * K1 Adapter の既定 ID。
 *
 * 【詳細説明】
 * - Adapter ID は state.source.adapterId に入り、differential test の観測元として使う。
 *
 * @constant {string}
 */
export const K1_ADAPTER_ID = "creality-k1";

/**
 * K1 Adapter が扱う protocol 名。
 *
 * 【詳細説明】
 * - Gate 2 時点では既存接続層の WS9999 受信 frame のみを対象にする。
 *
 * @constant {string}
 */
export const K1_ADAPTER_PROTOCOL = "ws9999";

/**
 * K1 delta frame を意味値へ戻すために累積する raw key 一覧。
 *
 * 【詳細説明】
 * - `video` と `video1`、`printProgress` と `dProgress` のように複数 raw key から
 *   1つの semantic field を作る値は、delta 単体では正しい優先順位を復元できない。
 * - Adapter 内部で protocol state として保持し、Normalized Patch には観測 key だけを出す。
 *
 * @constant {string[]}
 */
const K1_PROTOCOL_STATE_KEYS = Object.freeze([
  "video",
  "video1",
  "printProgress",
  "dProgress",
  "printFileName",
  "fileName",
  "bedTemp0",
  "bedTemp1",
  "bedTemp2",
  "targetBedTemp0",
  "targetBedTemp1",
  "targetBedTemp2",
  "hostname",
  "deviceName",
]);

/**
 * K1Adapter が Instance 越しに保持する内部状態。
 *
 * @typedef {object} K1AdapterState
 * @property {number} schemaVersion - Adapter 内部状態の schema version
 * @property {object} raw - delta frame を累積した raw protocol state
 */

/**
 * 空の K1 Adapter 内部状態を生成する。
 *
 * 【詳細説明】
 * - Instance が初回 frame を処理する前でも同じ shape を Adapter に渡せるようにする。
 *
 * @private
 * @returns {K1AdapterState} 空の K1 Adapter 内部状態
 */
function createEmptyK1AdapterState() {
  return {
    schemaVersion: 1,
    raw: {},
  };
}

/**
 * K1 Adapter 内部状態を deep clone する。
 *
 * 【詳細説明】
 * - Instance が保持する state を Adapter 側で直接 mutate しないための防御的 clone。
 *
 * @private
 * @param {K1AdapterState|null|undefined} adapterState - 既存 Adapter 内部状態
 * @returns {K1AdapterState} clone 済み Adapter 内部状態
 */
function cloneK1AdapterState(adapterState) {
  if (!adapterState || typeof adapterState !== "object") {
    return createEmptyK1AdapterState();
  }
  return {
    schemaVersion: 1,
    raw: {
      ...(adapterState.raw && typeof adapterState.raw === "object" ? adapterState.raw : {}),
    },
  };
}

/**
 * K1 raw delta payload を Adapter 内部 protocol state へ反映する。
 *
 * 【詳細説明】
 * - multi-raw-field の semantic 値だけを復元対象にし、NormalizedState そのものとは分離する。
 * - `null` や空文字も firmware から届いた明示値なので、key が存在する場合はそのまま保持する。
 *
 * @private
 * @param {K1AdapterState|null|undefined} previousState - 既存 Adapter 内部状態
 * @param {object|null|undefined} payload - 今回観測した K1 raw payload
 * @returns {K1AdapterState} 更新後 Adapter 内部状態
 */
function reduceK1AdapterState(previousState, payload) {
  const nextState = cloneK1AdapterState(previousState);
  if (!payload || typeof payload !== "object") {
    return nextState;
  }
  for (const key of K1_PROTOCOL_STATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      nextState.raw[key] = payload[key];
    }
  }
  return nextState;
}

/**
 * fixture event や frame から K1 系 status payload を抽出する。
 *
 * 【詳細説明】
 * - `events.ndjson` の event、`payload` wrapper、raw payload のいずれも受け付ける。
 * - JSON body 以外の frame や heartbeat では null を返し、Adapter 呼び出し側で無視できるようにする。
 *
 * @function extractK1StatusPayload
 * @param {object|null|undefined} frame - fixture event、transport frame、または raw payload
 * @returns {object|null} K1 系 status payload、または null
 * @example
 * const payload = extractK1StatusPayload(fixtureEvent);
 */
export function extractK1StatusPayload(frame) {
  if (!frame || typeof frame !== "object") {
    return null;
  }
  if (frame.payload?.bodyKind === "json" && frame.payload?.body && typeof frame.payload.body === "object") {
    return frame.payload.body;
  }
  if (frame.bodyKind === "json" && frame.body && typeof frame.body === "object") {
    return frame.body;
  }
  if (frame.payload && typeof frame.payload === "object" && !Array.isArray(frame.payload)) {
    return extractK1StatusPayload(frame.payload);
  }
  if (frame.ModeCode === "heart_beat") {
    return null;
  }
  return frame;
}

/**
 * Creality K1/K1 Max 系 dry-run Adapter。
 *
 * 【詳細説明】
 * - 送信 API を持たせず、受信 payload から NormalizedPrinterState を生成する責務だけに限定する。
 * - 後続 Gate で command path を切り替える前に、legacy processData との差分をこの class で観測する。
 */
export class K1Adapter {
  /**
   * K1Adapter を生成する。
   *
   * 【詳細説明】
   * - test で adapterId を差し替えられるよう options を受け取る。
   *
   * @param {object=} options - Adapter 生成オプション
   * @param {string=} options.adapterId - Adapter ID
   */
  constructor(options = {}) {
    this.adapterId = options.adapterId || K1_ADAPTER_ID;
    this.protocol = options.protocol || K1_ADAPTER_PROTOCOL;
    this.family = "k1";
    this.readOnly = true;
  }

  /**
   * frame から capability set を推定する。
   *
   * 【詳細説明】
   * - frame 抽出に失敗した場合は空 capability set を返す。
   *
   * @function getCapabilities
   * @param {object|null|undefined} frame - fixture event、transport frame、または raw payload
   * @returns {{schemaVersion: number, values: string[]}} capability set
   * @example
   * const capabilities = adapter.getCapabilities(event);
   */
  getCapabilities(frame) {
    return inferK1Capabilities(extractK1StatusPayload(frame));
  }

  /**
   * K1 系 frame を Normalized Patch へ変換する。
   *
   * 【詳細説明】
   * - 変換不能な frame は空 patch として返し、呼び出し側が sequence を維持できるようにする。
   * - Gate 2 ではこの戻り値を Instance が既存 state へ適用し、legacy 比較と smoke test にのみ使う。
   *
   * @function normalizeFrame
   * @param {object|null|undefined} frame - fixture event、transport frame、または raw payload
   * @param {object=} context - Instance 由来の文脈
   * @param {?string=} context.deviceId - 物理機 identity
   * @param {?string=} context.sessionId - 接続セッション ID
   * @param {?number=} context.sequence - Instance 内の受信順序
   * @param {?string=} context.receivedAt - 受信時刻 ISO 文字列
   * @param {K1AdapterState=} context.adapterState - 前回 frame までの Adapter 内部状態
   * @returns {object} 正規化済み Normalized Patch
   * @example
   * const state = adapter.normalizeFrame(event, { sequence: 1 });
   */
  normalizeFrame(frame, context = {}) {
    const payload = extractK1StatusPayload(frame);
    const adapterState = reduceK1AdapterState(context.adapterState, payload);
    const capabilities = inferK1Capabilities(payload);
    const normalizedPatch = createK1StatusPatch(payload, {
      ...context,
      adapterId: this.adapterId,
      protocol: this.protocol,
      capabilities,
      protocolState: adapterState.raw,
    });
    return {
      ...normalizedPatch,
      adapterState,
    };
  }
}

/**
 * K1Adapter を生成する。
 *
 * 【詳細説明】
 * - Facade や tests で class 名に直接依存しないための small factory。
 *
 * @function createK1Adapter
 * @param {object=} options - Adapter 生成オプション
 * @returns {K1Adapter} K1Adapter instance
 * @example
 * const adapter = createK1Adapter();
 */
export function createK1Adapter(options = {}) {
  return new K1Adapter(options);
}
