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
 * @version 1.390.1296 (PR #432)
 * @since   1.390.1296 (PR #432)
 * @lastModified 2026-08-07 11:42:13
 * -----------------------------------------------------------
 * @todo
 * - K1C 実環境 fixture 取得後に K1C/CFS-C 固有差分を capability catalog へ追加する
 */

"use strict";

import { inferK1Capabilities } from "./dashboard_capabilities.js";
import { normalizeK1StatusPayload } from "./dashboard_normalized_state.js";

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
   * K1 系 frame を NormalizedPrinterState へ変換する。
   *
   * 【詳細説明】
   * - 変換不能な frame は空 state として返し、呼び出し側が sequence を維持できるようにする。
   * - Gate 2 ではこの戻り値を UI authority にせず、legacy 比較と smoke test にのみ使う。
   *
   * @function normalizeFrame
   * @param {object|null|undefined} frame - fixture event、transport frame、または raw payload
   * @param {object=} context - Instance 由来の文脈
   * @param {?string=} context.deviceId - 物理機 identity
   * @param {?string=} context.sessionId - 接続セッション ID
   * @param {?number=} context.sequence - Instance 内の受信順序
   * @param {?string=} context.receivedAt - 受信時刻 ISO 文字列
   * @returns {object} 正規化済み NormalizedPrinterState
   * @example
   * const state = adapter.normalizeFrame(event, { sequence: 1 });
   */
  normalizeFrame(frame, context = {}) {
    const payload = extractK1StatusPayload(frame);
    const capabilities = inferK1Capabilities(payload);
    return normalizeK1StatusPayload(payload, {
      ...context,
      adapterId: this.adapterId,
      protocol: this.protocol,
      capabilities,
    });
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
