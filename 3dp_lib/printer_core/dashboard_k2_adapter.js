/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 K2 Adapter モジュール
 * @file dashboard_k2_adapter.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_k2_adapter
 *
 * 【機能内容サマリ】
 * - Creality K2 Pro Combo 系 WS9999 status frame を NormalizedPrinterState へ変換
 * - CFS `boxsInfo` frame を read-only material topology へ変換
 * - 送信経路を持たず、Gate 4 では fixture / live shadow 用の読み取り専用 Adapter として動作
 *
 * 【公開関数一覧】
 * - {@link extractK2Payload}：fixture event や frame から K2 payload を抽出
 * - {@link extractK2BoxsInfo}：K2 payload から CFS boxsInfo を抽出
 * - {@link K2Adapter}：K2 系 payload を正規化する Adapter class
 * - {@link createK2Adapter}：K2Adapter の factory
 *
 * @version 1.390.1302 (PR #432)
 * @since   1.390.1302 (PR #432)
 * @lastModified 2026-08-07 20:48:46
 * -----------------------------------------------------------
 * @todo
 * - K2 Pro Combo 実機 live shadow 接続後に delta frame の追加 alias を確認する
 */

"use strict";

import { inferK2Capabilities } from "./dashboard_capabilities.js";
import {
  createK2BoxsInfoPatch,
  createK2StatusPatch,
} from "./dashboard_normalized_state.js";

/**
 * K2 Adapter の既定 ID。
 *
 * 【詳細説明】
 * - Adapter ID は state.source.adapterId に入り、K1 と K2 の観測元を明確に分離する。
 *
 * @constant {string}
 */
export const K2_ADAPTER_ID = "creality-k2";

/**
 * K2 Adapter が扱う protocol 名。
 *
 * 【詳細説明】
 * - Gate 4 では HTTP /info ではなく WS9999 の status / boxsInfo を正規化対象にする。
 *
 * @constant {string}
 */
export const K2_ADAPTER_PROTOCOL = "ws9999";

/**
 * K2 delta frame を意味値へ戻すために累積する raw key 一覧。
 *
 * 【詳細説明】
 * - K2 Pro Combo fixture は K1 と同じ status alias を多く返すため、Gate 2 の delta 方針を継承する。
 * - `cfsConnect` は status frame 側で CFS 接続有無を表すため、boxsInfo とは別に保持する。
 *
 * @constant {string[]}
 */
const K2_PROTOCOL_STATE_KEYS = Object.freeze([
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
  "cfsConnect",
]);

/**
 * K2Adapter が Instance 越しに保持する内部状態。
 *
 * @typedef {object} K2AdapterState
 * @property {number} schemaVersion - Adapter 内部状態の schema version
 * @property {object} raw - delta frame を累積した raw protocol state
 */

/**
 * 空の K2 Adapter 内部状態を生成する。
 *
 * 【詳細説明】
 * - Instance が初回 frame を処理する前でも同じ shape を Adapter に渡せるようにする。
 *
 * @private
 * @returns {K2AdapterState} 空の K2 Adapter 内部状態
 */
function createEmptyK2AdapterState() {
  return {
    schemaVersion: 1,
    raw: {},
  };
}

/**
 * K2 Adapter 内部状態を deep clone する。
 *
 * 【詳細説明】
 * - Instance が保持する state を Adapter 側で直接 mutate しないための防御的 clone。
 *
 * @private
 * @param {K2AdapterState|null|undefined} adapterState - 既存 Adapter 内部状態
 * @returns {K2AdapterState} clone 済み Adapter 内部状態
 */
function cloneK2AdapterState(adapterState) {
  if (!adapterState || typeof adapterState !== "object") {
    return createEmptyK2AdapterState();
  }
  return {
    schemaVersion: 1,
    raw: {
      ...(adapterState.raw && typeof adapterState.raw === "object" ? adapterState.raw : {}),
    },
  };
}

/**
 * K2 raw delta payload を Adapter 内部 protocol state へ反映する。
 *
 * 【詳細説明】
 * - status payload の alias 復元に必要な key だけを保持し、CFS topology の完全 snapshot は
 *   NormalizedState 側に保存する。
 * - `null` や空文字も firmware から届いた明示値なので、key が存在する場合はそのまま保持する。
 *
 * @private
 * @param {K2AdapterState|null|undefined} previousState - 既存 Adapter 内部状態
 * @param {object|null|undefined} payload - 今回観測した K2 raw payload
 * @returns {K2AdapterState} 更新後 Adapter 内部状態
 */
function reduceK2AdapterState(previousState, payload) {
  const nextState = cloneK2AdapterState(previousState);
  if (!payload || typeof payload !== "object") {
    return nextState;
  }
  for (const key of K2_PROTOCOL_STATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      nextState.raw[key] = payload[key];
    }
  }
  return nextState;
}

/**
 * fixture event や frame から K2 系 payload を抽出する。
 *
 * 【詳細説明】
 * - `events.ndjson` の event、`payload` wrapper、raw payload のいずれも受け付ける。
 * - heartbeat frame は状態ではないため null を返す。
 *
 * @function extractK2Payload
 * @param {object|null|undefined} frame - fixture event、transport frame、または raw payload
 * @returns {object|null} K2 系 payload、または null
 * @example
 * const payload = extractK2Payload(fixtureEvent);
 */
export function extractK2Payload(frame) {
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
    return extractK2Payload(frame.payload);
  }
  if (frame.ModeCode === "heart_beat") {
    return null;
  }
  return frame;
}

/**
 * K2 payload から CFS `boxsInfo` object を抽出する。
 *
 * 【詳細説明】
 * - firmware は `{ boxsInfo: {...} }` wrapper で返すため、Adapter 境界で topology 部分だけを分離する。
 *
 * @function extractK2BoxsInfo
 * @param {object|null|undefined} frame - fixture event、transport frame、または raw payload
 * @returns {object|null} `boxsInfo` object、または null
 * @example
 * const boxsInfo = extractK2BoxsInfo(event);
 */
export function extractK2BoxsInfo(frame) {
  const payload = extractK2Payload(frame);
  return payload?.boxsInfo && typeof payload.boxsInfo === "object" ? payload.boxsInfo : null;
}

/**
 * payload が boxsInfo 専用 frame か判定する。
 *
 * 【詳細説明】
 * - `boxsInfo` 以外の status key が混在する将来 payload では status と topology の両方を処理できるよう、
 *   専用 frame だけをここで true とする。
 *
 * @private
 * @param {object|null|undefined} payload - K2 raw payload
 * @returns {boolean} boxsInfo 専用 frame の場合 true
 */
function isBoxsInfoOnlyPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const keys = Object.keys(payload);
  return keys.length === 1 && keys[0] === "boxsInfo";
}

/**
 * Creality K2 Pro Combo 系 read-only Adapter。
 *
 * 【詳細説明】
 * - 送信 API を持たせず、status / boxsInfo payload から NormalizedPrinterState を生成する責務だけに限定する。
 * - CFS topology は capability と state に投影するが、CFS 制御や filament ledger への書き込みは行わない。
 */
export class K2Adapter {
  /**
   * K2Adapter を生成する。
   *
   * 【詳細説明】
   * - test で adapterId を差し替えられるよう options を受け取る。
   *
   * @param {object=} options - Adapter 生成オプション
   * @param {string=} options.adapterId - Adapter ID
   * @param {string=} options.protocol - protocol 名
   */
  constructor(options = {}) {
    this.adapterId = options.adapterId || K2_ADAPTER_ID;
    this.protocol = options.protocol || K2_ADAPTER_PROTOCOL;
    this.family = "k2";
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
    return inferK2Capabilities(extractK2Payload(frame));
  }

  /**
   * K2 系 frame を Normalized Patch へ変換する。
   *
   * 【詳細説明】
   * - status frame は K1 と同系の raw key を正規化し、`boxsInfo` frame は material topology だけを更新する。
   * - 変換不能な frame は空 patch として返し、呼び出し側が sequence を維持できるようにする。
   *
   * @function normalizeFrame
   * @param {object|null|undefined} frame - fixture event、transport frame、または raw payload
   * @param {object=} context - Instance 由来の文脈
   * @param {?string=} context.deviceId - 物理機 identity
   * @param {?string=} context.sessionId - 接続セッション ID
   * @param {?number=} context.sequence - Instance 内の受信順序
   * @param {?string=} context.receivedAt - 受信時刻 ISO 文字列
   * @param {K2AdapterState=} context.adapterState - 前回 frame までの Adapter 内部状態
   * @returns {object} 正規化済み Normalized Patch
   * @example
   * const state = adapter.normalizeFrame(event, { sequence: 1 });
   */
  normalizeFrame(frame, context = {}) {
    const payload = extractK2Payload(frame);
    const adapterState = reduceK2AdapterState(context.adapterState, payload);
    const capabilities = inferK2Capabilities(payload);
    const commonOptions = {
      ...context,
      adapterId: this.adapterId,
      protocol: this.protocol,
      capabilities,
      protocolState: adapterState.raw,
    };
    const normalizedPatch = isBoxsInfoOnlyPayload(payload)
      ? createK2BoxsInfoPatch(payload.boxsInfo, commonOptions)
      : createK2StatusPatch(payload, commonOptions);
    return {
      ...normalizedPatch,
      adapterState,
    };
  }
}

/**
 * K2Adapter を生成する。
 *
 * 【詳細説明】
 * - Facade や tests で class 名に直接依存しないための small factory。
 *
 * @function createK2Adapter
 * @param {object=} options - Adapter 生成オプション
 * @returns {K2Adapter} K2Adapter instance
 * @example
 * const adapter = createK2Adapter();
 */
export function createK2Adapter(options = {}) {
  return new K2Adapter(options);
}
