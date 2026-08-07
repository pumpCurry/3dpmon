/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 PrinterInstance モジュール
 * @file dashboard_printer_instance.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_printer_instance
 *
 * 【機能内容サマリ】
 * - 1台の物理プリンタに対応する PrinterInstance を表現
 * - Adapter から得た NormalizedPrinterState を sequence 付きで保持
 * - Gate 2 では legacy processData と並走する dry-run 状態の入れ物として機能
 *
 * 【公開関数一覧】
 * - {@link PrinterInstance}：物理プリンタ単位の normalized state holder
 * - {@link createPrinterInstance}：PrinterInstance の factory
 *
 * @version 1.390.1296 (PR #432)
 * @since   1.390.1296 (PR #432)
 * @lastModified 2026-08-07 11:42:13
 * -----------------------------------------------------------
 * @todo
 * - Data Schema v3 の device/session repository と接続する
 */

"use strict";

import { mergeCapabilitySets } from "./dashboard_capabilities.js";
import { createEmptyNormalizedPrinterState } from "./dashboard_normalized_state.js";

/**
 * 1台の物理プリンタに対応する Printer Core v3 Instance。
 *
 * 【詳細説明】
 * - deviceId は物理機、sessionId は接続単位を表す。
 * - Adapter の受信 frame 正規化結果を最新状態として保持する。
 */
export class PrinterInstance {
  /**
   * PrinterInstance を生成する。
   *
   * 【詳細説明】
   * - Adapter は `normalizeFrame(frame, context)` を提供する object として受け取る。
   * - clock はテストで固定できるよう注入可能にする。
   *
   * @param {object} options - Instance 生成オプション
   * @param {string} options.deviceId - 物理機 identity
   * @param {string=} options.sessionId - 接続セッション ID
   * @param {object} options.adapter - Printer Adapter
   * @param {Function=} options.clock - 現在時刻 Date を返す関数
   * @throws {TypeError} Adapter が normalizeFrame を持たない場合
   */
  constructor(options) {
    if (!options?.adapter || typeof options.adapter.normalizeFrame !== "function") {
      throw new TypeError("PrinterInstance requires an adapter with normalizeFrame().");
    }
    this.deviceId = String(options.deviceId || "unknown-device");
    this.sessionId = String(options.sessionId || `session:${this.deviceId}`);
    this.adapter = options.adapter;
    this.clock = typeof options.clock === "function" ? options.clock : () => new Date();
    this.sequence = 0;
    this.capabilities = createEmptyNormalizedPrinterState({
      deviceId: this.deviceId,
      sessionId: this.sessionId,
      adapterId: this.adapter.adapterId,
      protocol: this.adapter.protocol,
    }).capabilities;
    this.state = createEmptyNormalizedPrinterState({
      deviceId: this.deviceId,
      sessionId: this.sessionId,
      adapterId: this.adapter.adapterId,
      protocol: this.adapter.protocol,
      capabilities: this.capabilities,
    });
  }

  /**
   * 受信 frame を観測し、最新 NormalizedPrinterState を更新する。
   *
   * 【詳細説明】
   * - sequence は Instance 内で単調増加させ、legacy stream との比較順序を安定させる。
   * - Adapter が推定した capability は過去観測分と統合して保持する。
   *
   * @function observeFrame
   * @param {object|null|undefined} frame - 受信 frame または raw payload
   * @param {object=} context - 観測文脈
   * @param {?string=} context.receivedAt - 受信時刻 ISO 文字列
   * @returns {object} 更新後の NormalizedPrinterState
   * @example
   * const state = instance.observeFrame(payload);
   */
  observeFrame(frame, context = {}) {
    const nextSequence = this.sequence + 1;
    const receivedAt = context.receivedAt ?? this.clock().toISOString();
    const nextState = this.adapter.normalizeFrame(frame, {
      ...context,
      deviceId: this.deviceId,
      sessionId: this.sessionId,
      sequence: nextSequence,
      receivedAt,
    });
    this.sequence = nextSequence;
    this.capabilities = mergeCapabilitySets(this.capabilities, nextState.capabilities);
    this.state = {
      ...nextState,
      capabilities: this.capabilities,
    };
    return this.state;
  }

  /**
   * 最新 NormalizedPrinterState を返す。
   *
   * 【詳細説明】
   * - 呼び出し側が直接 mutation しないよう、トップレベルだけ shallow copy して返す。
   *
   * @function getState
   * @returns {object} 最新 NormalizedPrinterState
   * @example
   * const current = instance.getState();
   */
  getState() {
    return { ...this.state };
  }
}

/**
 * PrinterInstance を生成する。
 *
 * 【詳細説明】
 * - tests や Facade が class 名に直接依存しないための factory。
 *
 * @function createPrinterInstance
 * @param {object} options - Instance 生成オプション
 * @returns {PrinterInstance} PrinterInstance instance
 * @example
 * const instance = createPrinterInstance({ deviceId: "serial:demo", adapter });
 */
export function createPrinterInstance(options) {
  return new PrinterInstance(options);
}
