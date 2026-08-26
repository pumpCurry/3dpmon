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
 * @version 1.390.1312 (PR #432)
 * @since   1.390.1296 (PR #432)
 * @lastModified 2026-08-08 07:32:05
 * -----------------------------------------------------------
 * @todo
 * - Data Schema v3 の device/session repository と接続する
 */

"use strict";

import { mergeCapabilitySets } from "./dashboard_capabilities.js";
import {
  applyNormalizedStatePatch,
  cloneNormalizedValue,
  createEmptyNormalizedPrinterState,
} from "./dashboard_normalized_state.js";

/**
 * 必須 ID を空文字ではない文字列へ正規化する。
 *
 * 【詳細説明】
 * - unknown-device への混入を防ぐため、deviceId/sessionId は Core 境界で fail-closed にする。
 *
 * @private
 * @param {*} value - ID 候補
 * @param {string} name - エラー表示用の ID 名
 * @returns {string} 正規化済み ID
 * @throws {TypeError} 空 ID の場合
 */
function requireNonEmptyId(value, name) {
  const id = String(value ?? "").trim();
  if (!id) {
    throw new TypeError(`PrinterInstance requires a non-empty ${name}.`);
  }
  return id;
}

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
    this.deviceId = requireNonEmptyId(options.deviceId, "deviceId");
    this.sessionId = requireNonEmptyId(options.sessionId, "sessionId");
    this.adapter = options.adapter;
    this.clock = typeof options.clock === "function" ? options.clock : () => new Date();
    this.sequence = 0;
    this.active = true;
    this.adapterState = null;
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
    const incomingSessionId = String(context.sessionId ?? "").trim();
    if (!this.active) {
      return {
        accepted: false,
        reason: "session-closed",
        deviceId: this.deviceId,
        sessionId: incomingSessionId || null,
        activeSessionId: this.sessionId,
      };
    }
    if (incomingSessionId !== this.sessionId) {
      return {
        accepted: false,
        reason: "stale-session",
        deviceId: this.deviceId,
        sessionId: incomingSessionId || null,
        activeSessionId: this.sessionId,
      };
    }
    const nextSequence = this.sequence + 1;
    const receivedAt = context.receivedAt ?? this.clock().toISOString();
    const normalizedPatch = this.adapter.normalizeFrame(frame, {
      ...context,
      deviceId: this.deviceId,
      sessionId: this.sessionId,
      sequence: nextSequence,
      receivedAt,
      adapterState: this.adapterState,
    });
    this.sequence = nextSequence;
    this.adapterState = normalizedPatch.adapterState ?? this.adapterState;
    this.capabilities = mergeCapabilitySets(this.capabilities, normalizedPatch.capabilities);
    this.state = {
      ...applyNormalizedStatePatch(this.state, normalizedPatch),
      capabilities: this.capabilities,
    };
    return cloneNormalizedValue(this.state);
  }

  /**
   * 受信 frame を観測し、成功/拒否を明示した result object を返す。
   *
   * 【詳細説明】
   * - 既存の `observeFrame()` は後方互換のため、成功時に NormalizedPrinterState を直接返す。
   * - K2/CFS Provider や authority 化前の呼び出し側が union 型を取り違えないよう、この入口では
   *   `{ accepted:true, state }` と `{ accepted:false, reason }` の形に統一する。
   *
   * @function observeFrameResult
   * @param {object|null|undefined} frame - 受信 frame または raw payload
   * @param {object=} context - 観測文脈
   * @param {?string=} context.receivedAt - 受信時刻 ISO 文字列
   * @returns {object} accepted flag 付き観測結果
   * @example
   * const result = instance.observeFrameResult(payload, { sessionId });
   */
  observeFrameResult(frame, context = {}) {
    const state = this.observeFrame(frame, context);
    if (state?.accepted === false) {
      return state;
    }
    return {
      accepted: true,
      state,
    };
  }

  /**
   * 最新 NormalizedPrinterState を返す。
   *
   * 【詳細説明】
   * - 呼び出し側が直接 mutation しないよう、deep clone を返す。
   *
   * @function getState
   * @returns {object} 最新 NormalizedPrinterState
   * @example
   * const current = instance.getState();
   */
  getState() {
    return cloneNormalizedValue(this.state);
  }

  /**
   * Instance を closed 状態へ移行する。
   *
   * 【詳細説明】
   * - Facade が同じ deviceId で新 session を開始した場合、旧参照からの直接 observe を拒否する。
   * - close は冪等にし、複数回呼ばれても状態を巻き戻さない。
   *
   * @function close
   * @returns {boolean} 今回の呼び出しで active から closed へ変化した場合 true
   * @example
   * const closed = instance.close();
   */
  close() {
    if (!this.active) {
      return false;
    }
    this.active = false;
    return true;
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
