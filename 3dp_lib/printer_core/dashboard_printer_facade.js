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
 * - deviceId ごとに明示 session lifecycle を管理し、受信 frame を Adapter へ流す
 * - Gate 2 では dry-run の normalized state 生成入口としてのみ利用
 *
 * 【公開関数一覧】
 * - {@link PrinterFacade}：Printer Core v3 dry-run facade
 * - {@link createPrinterFacade}：PrinterFacade の factory
 * - {@link createK1PrinterFacade}：K1 dry-run 用 PrinterFacade の factory
 *
 * @version 1.390.1297 (PR #432)
 * @since   1.390.1296 (PR #432)
 * @lastModified 2026-08-07 12:22:00
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
 * - Adapter は beginSession 時に明示指定または adapterFactory で解決し、generic facade では暗黙に K1 化しない。
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
    this.adapterFactory = typeof options.adapterFactory === "function" ? options.adapterFactory : null;
    this.clock = typeof options.clock === "function" ? options.clock : () => new Date();
  }

  /**
   * 必須 ID を空文字ではない文字列へ正規化する。
   *
   * 【詳細説明】
   * - facade 境界で空 ID を拒否し、複数実機が同じ unknown bucket へ混ざることを防ぐ。
   *
   * @private
   * @param {*} value - ID 候補
   * @param {string} name - エラー表示用の ID 名
   * @returns {string} 正規化済み ID
   * @throws {TypeError} 空 ID の場合
   */
  _requireNonEmptyId(value, name) {
    const id = String(value ?? "").trim();
    if (!id) {
      throw new TypeError(`PrinterFacade requires a non-empty ${name}.`);
    }
    return id;
  }

  /**
   * Adapter を解決する。
   *
   * 【詳細説明】
   * - generic facade では adapter 指定漏れを silent K1 fallback にせず、明示エラーにする。
   *
   * @private
   * @param {object=} options - Adapter 解決オプション
   * @returns {object} Printer Adapter
   * @throws {Error} Adapter を解決できない場合
   */
  _resolveAdapter(options = {}) {
    if (options.adapter) {
      return options.adapter;
    }
    if (this.adapterFactory) {
      return this.adapterFactory(options.adapterOptions || {});
    }
    throw new Error("Adapter has not been resolved for PrinterFacade session.");
  }

  /**
   * deviceId に対応する PrinterInstance session を開始する。
   *
   * 【詳細説明】
   * - 新 session は beginSession だけが作成し、古い frame で session が巻き戻らないようにする。
   * - 同じ deviceId の既存 Instance は新 session で置き換える。
   *
   * @function beginSession
   * @param {object} options - Instance 取得オプション
   * @param {string} options.deviceId - 物理機 identity
   * @param {string} options.sessionId - 接続セッション ID
   * @param {object=} options.adapter - Printer Adapter
   * @returns {object} PrinterInstance
   * @example
   * const instance = facade.beginSession({ deviceId: "serial:demo", sessionId: "session:1", adapter });
   */
  beginSession(options) {
    const deviceId = this._requireNonEmptyId(options?.deviceId, "deviceId");
    const sessionId = this._requireNonEmptyId(options?.sessionId, "sessionId");
    const adapter = this._resolveAdapter(options);
    const instance = createPrinterInstance({
      deviceId,
      sessionId,
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
   * @param {object} options - 観測オプション
   * @param {string} options.deviceId - 物理機 identity
   * @param {string} options.sessionId - 接続セッション ID
   * @param {object|null|undefined} options.frame - 受信 frame または raw payload
   * @returns {object} 更新後の NormalizedPrinterState
   * @example
   * const state = facade.observeFrame({ deviceId: "serial:demo", sessionId: "session:1", frame: payload });
   */
  observeFrame(options) {
    const deviceId = this._requireNonEmptyId(options?.deviceId, "deviceId");
    const sessionId = this._requireNonEmptyId(options?.sessionId, "sessionId");
    const instance = this.instances.get(deviceId);
    if (!instance) {
      throw new Error(`PrinterFacade session has not been started for deviceId "${deviceId}".`);
    }
    return instance.observeFrame(options.frame, {
      ...options.context,
      sessionId,
      receivedAt: options.receivedAt,
    });
  }

  /**
   * deviceId に対応する active session を終了する。
   *
   * 【詳細説明】
   * - sessionId が一致する場合だけ削除し、古い close event が新 session を消さないようにする。
   *
   * @function endSession
   * @param {object} options - session 終了オプション
   * @param {string} options.deviceId - 物理機 identity
   * @param {string} options.sessionId - 接続セッション ID
   * @returns {boolean} active session を削除した場合 true
   * @example
   * facade.endSession({ deviceId: "serial:demo", sessionId: "session:1" });
   */
  endSession(options) {
    const deviceId = this._requireNonEmptyId(options?.deviceId, "deviceId");
    const sessionId = this._requireNonEmptyId(options?.sessionId, "sessionId");
    const instance = this.instances.get(deviceId);
    if (!instance || instance.sessionId !== sessionId) {
      return false;
    }
    return this.instances.delete(deviceId);
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
    const normalizedDeviceId = this._requireNonEmptyId(deviceId, "deviceId");
    return this.instances.get(normalizedDeviceId)?.getState() ?? null;
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

/**
 * K1 dry-run 用 PrinterFacade を生成する。
 *
 * 【詳細説明】
 * - Gate 2 の fixture differential で使う convenience factory。
 * - generic `createPrinterFacade()` は adapter 指定漏れを拒否するため、K1 を明示したい場所だけで使う。
 *
 * @function createK1PrinterFacade
 * @param {object=} options - Facade 生成オプション
 * @returns {PrinterFacade} K1 Adapter factory 済み PrinterFacade instance
 * @example
 * const facade = createK1PrinterFacade();
 */
export function createK1PrinterFacade(options = {}) {
  return new PrinterFacade({
    ...options,
    adapterFactory: options.adapterFactory || createK1Adapter,
  });
}
