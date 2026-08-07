/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 PrinterFacade モジュール
 * @file dashboard_printer_facade.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_printer_facade
 *
 * 【機能内容サマリ】
 * - UI/connection 層が PrinterInstance を直接管理しないための facade を提供
 * - deviceId ごとに Instance を作成・再利用し、受信 frame を Adapter へ流す
 * - Gate 2 では dry-run の normalized state 生成入口としてのみ利用
 *
 * 【公開関数一覧】
 * - {@link PrinterFacade}：Printer Core v3 dry-run facade
 * - {@link createPrinterFacade}：PrinterFacade の factory
 *
 * @version 1.390.1296 (PR #432)
 * @since   1.390.1296 (PR #432)
 * @lastModified 2026-08-07 11:42:13
 * -----------------------------------------------------------
 * @todo
 * - Gate 3 以降で legacy connection 層の shadow pipeline へ接続する
 */

"use strict";

import { createK1Adapter } from "./dashboard_k1_adapter.js";
import { createPrinterInstance } from "./dashboard_printer_instance.js";

/**
 * Printer Core v3 dry-run facade。
 *
 * 【詳細説明】
 * - 複数プリンタの Instance を deviceId で保持する。
 * - 既定 Adapter は K1 dry-run Adapter とし、Gate 2 の K1 fixture differential を最小構成で動かす。
 */
export class PrinterFacade {
  /**
   * PrinterFacade を生成する。
   *
   * 【詳細説明】
   * - adapterFactory と clock は tests で注入できるようにする。
   *
   * @param {object=} options - Facade 生成オプション
   * @param {Function=} options.adapterFactory - Adapter 生成関数
   * @param {Function=} options.clock - 現在時刻 Date を返す関数
   */
  constructor(options = {}) {
    this.instances = new Map();
    this.adapterFactory = typeof options.adapterFactory === "function" ? options.adapterFactory : createK1Adapter;
    this.clock = typeof options.clock === "function" ? options.clock : () => new Date();
  }

  /**
   * deviceId に対応する PrinterInstance を取得、または生成する。
   *
   * 【詳細説明】
   * - 同じ deviceId に対する複数 frame は同じ Instance に集約する。
   * - Adapter を明示しない場合は facade の adapterFactory から生成する。
   *
   * @function getOrCreateInstance
   * @param {object} options - Instance 取得オプション
   * @param {string} options.deviceId - 物理機 identity
   * @param {string=} options.sessionId - 接続セッション ID
   * @param {object=} options.adapter - Printer Adapter
   * @returns {object} PrinterInstance
   * @example
   * const instance = facade.getOrCreateInstance({ deviceId: "serial:demo" });
   */
  getOrCreateInstance(options) {
    const deviceId = String(options?.deviceId || "unknown-device");
    if (this.instances.has(deviceId)) {
      return this.instances.get(deviceId);
    }
    const adapter = options?.adapter || this.adapterFactory(options?.adapterOptions || {});
    const instance = createPrinterInstance({
      deviceId,
      sessionId: options?.sessionId,
      adapter,
      clock: this.clock,
    });
    this.instances.set(deviceId, instance);
    return instance;
  }

  /**
   * deviceId に対応する Instance へ frame を流し、NormalizedPrinterState を返す。
   *
   * 【詳細説明】
   * - connection 層から見た dry-run の単一入口として使う想定。
   * - 送信処理や legacy state の更新は行わない。
   *
   * @function observeFrame
   * @param {string} deviceId - 物理機 identity
   * @param {object|null|undefined} frame - 受信 frame または raw payload
   * @param {object=} context - 観測文脈
   * @param {string=} context.sessionId - 接続セッション ID
   * @returns {object} 更新後の NormalizedPrinterState
   * @example
   * const state = facade.observeFrame("serial:demo", payload);
   */
  observeFrame(deviceId, frame, context = {}) {
    const instance = this.getOrCreateInstance({
      deviceId,
      sessionId: context.sessionId,
      adapter: context.adapter,
      adapterOptions: context.adapterOptions,
    });
    return instance.observeFrame(frame, context);
  }

  /**
   * deviceId に対応する最新 state を返す。
   *
   * 【詳細説明】
   * - Instance が未作成の場合は null を返す。
   *
   * @function getState
   * @param {string} deviceId - 物理機 identity
   * @returns {object|null} 最新 NormalizedPrinterState、または null
   * @example
   * const state = facade.getState("serial:demo");
   */
  getState(deviceId) {
    return this.instances.get(String(deviceId))?.getState() ?? null;
  }
}

/**
 * PrinterFacade を生成する。
 *
 * 【詳細説明】
 * - connection 層や tests が class 名に直接依存しないための factory。
 *
 * @function createPrinterFacade
 * @param {object=} options - Facade 生成オプション
 * @returns {PrinterFacade} PrinterFacade instance
 * @example
 * const facade = createPrinterFacade();
 */
export function createPrinterFacade(options = {}) {
  return new PrinterFacade(options);
}
