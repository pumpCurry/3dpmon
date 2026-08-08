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
 * - {@link createK2PrinterFacade}：K2 read-only 用 PrinterFacade の factory
 *
 * @version 1.390.1336 (PR #432)
 * @since   1.390.1296 (PR #432)
 * @lastModified 2026-08-09 01:05:00
 * -----------------------------------------------------------
 * @todo
 * - Gate 5 以降で K2 live shadow pipeline へ接続する
 */

"use strict";

import { createK1Adapter } from "./dashboard_k1_adapter.js";
import { createK2Adapter } from "./dashboard_k2_adapter.js";
import { createPrinterInstance } from "./dashboard_printer_instance.js";
import {
  clonePrinterSession,
  closePrinterSession,
  createPrinterSession,
} from "./dashboard_printer_session.js";

/**
 * PrinterFacade が外部へ返す error code。
 *
 * 【詳細説明】
 * - live shadow 側が `error.message` の自然文ではなく、安定した code で復旧可否を判定できるようにする。
 *
 * @constant {object}
 */
export const PRINTER_FACADE_ERROR_CODES = Object.freeze({
  SESSION_NOT_STARTED: "session-not-started",
});

/**
 * PrinterFacade の lifecycle error。
 *
 * 【詳細説明】
 * - Error として既存 catch 経路に乗せつつ、`code` と `details` で機械判定できる形にする。
 */
export class PrinterFacadeSessionError extends Error {
  /**
   * PrinterFacadeSessionError を生成する。
   *
   * 【詳細説明】
   * - message は人間向けの診断、code は呼び出し側の分岐条件として使う。
   *
   * @param {string} message - エラーメッセージ
   * @param {string} code - 安定した error code
   * @param {object=} details - deviceId/sessionId などの補助情報
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = "PrinterFacadeSessionError";
    this.code = code;
    this.details = details;
  }
}

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
    this.sessions = new Map();
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
   * - 同じ deviceId の既存 Instance は、新 Instance の構築成功後に close して置き換える。
   *
   * @function beginSession
   * @param {object} options - Instance 取得オプション
   * @param {string} options.deviceId - 物理機 identity
   * @param {string} options.sessionId - 接続セッション ID
   * @param {object=} options.adapter - Printer Adapter
   * @param {string=} options.family - printer family
   * @param {Array<object>|object=} options.transports - session に紐づく transport metadata
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
    const openedAt = this.clock().toISOString();
    const session = createPrinterSession({
      deviceId,
      sessionId,
      family: options?.family,
      adapterId: adapter.adapterId,
      protocol: adapter.protocol,
      openedAt,
      transports: options?.transports || {
        kind: adapter.protocol || "unknown",
        role: "status-stream",
      },
      metadata: options?.sessionMetadata || {},
    });
    const previousInstance = this.instances.get(deviceId);
    if (previousInstance && typeof previousInstance.close === "function") {
      previousInstance.close();
    }
    const previousSession = this.sessions.get(deviceId);
    if (previousSession) {
      closePrinterSession(previousSession, { closedAt: openedAt });
    }
    this.instances.set(deviceId, instance);
    this.sessions.set(deviceId, session);
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
      throw new PrinterFacadeSessionError(
        `PrinterFacade session has not been started for deviceId "${deviceId}".`,
        PRINTER_FACADE_ERROR_CODES.SESSION_NOT_STARTED,
        { deviceId, sessionId }
      );
    }
    return instance.observeFrame(options.frame, {
      ...options.context,
      sessionId,
      receivedAt: options.receivedAt,
    });
  }

  /**
   * deviceId に対応する Instance へ frame を流し、accepted flag 付き result を返す。
   *
   * 【詳細説明】
   * - `observeFrame()` の成功時 state / 拒否時 object という互換 union を、呼び出し側が安全に扱える
   *   `{ accepted:true, state }` または `{ accepted:false, reason }` へ包む。
   * - session 未開始は authority 化前の lifecycle 診断として rejection に変換し、Adapter 例外はそのまま投げる。
   *
   * @function observeFrameResult
   * @param {object} options - 観測オプション
   * @param {string} options.deviceId - 物理機 identity
   * @param {string} options.sessionId - 接続セッション ID
   * @param {object|null|undefined} options.frame - 受信 frame または raw payload
   * @returns {object} accepted flag 付き観測結果
   * @example
   * const result = facade.observeFrameResult({ deviceId, sessionId, frame });
   */
  observeFrameResult(options) {
    const deviceId = this._requireNonEmptyId(options?.deviceId, "deviceId");
    const sessionId = this._requireNonEmptyId(options?.sessionId, "sessionId");
    const instance = this.instances.get(deviceId);
    if (!instance) {
      return {
        accepted: false,
        reason: PRINTER_FACADE_ERROR_CODES.SESSION_NOT_STARTED,
        deviceId,
        sessionId,
        activeSessionId: null,
      };
    }
    if (typeof instance.observeFrameResult === "function") {
      return instance.observeFrameResult(options.frame, {
        ...options.context,
        sessionId,
        receivedAt: options.receivedAt,
      });
    }
    const state = instance.observeFrame(options.frame, {
      ...options.context,
      sessionId,
      receivedAt: options.receivedAt,
    });
    if (state?.accepted === false) {
      return state;
    }
    return {
      accepted: true,
      state,
    };
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
    instance.close();
    closePrinterSession(this.sessions.get(deviceId), {
      closedAt: this.clock().toISOString(),
    });
    this.sessions.delete(deviceId);
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

  /**
   * deviceId に対応する active PrinterSession metadata を返す。
   *
   * 【詳細説明】
   * - Gate 11 では read-only diagnostic metadata であり、command routing には使わない。
   * - 呼び出し側 mutation で Facade 内部状態が壊れないよう clone を返す。
   *
   * @function getSession
   * @param {string} deviceId - 物理機 identity
   * @returns {object|null} PrinterSession metadata、または null
   * @example
   * const session = facade.getSession("serial:demo");
   */
  getSession(deviceId) {
    const normalizedDeviceId = this._requireNonEmptyId(deviceId, "deviceId");
    return clonePrinterSession(this.sessions.get(normalizedDeviceId));
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

/**
 * K2 read-only 用 PrinterFacade を生成する。
 *
 * 【詳細説明】
 * - Gate 4 の K2 Pro Combo + CFS fixture replay で使う convenience factory。
 * - generic `createPrinterFacade()` は adapter 指定漏れを拒否するため、K2 を明示したい場所だけで使う。
 *
 * @function createK2PrinterFacade
 * @param {object=} options - Facade 生成オプション
 * @returns {PrinterFacade} K2 Adapter factory 済み PrinterFacade instance
 * @example
 * const facade = createK2PrinterFacade();
 */
export function createK2PrinterFacade(options = {}) {
  return new PrinterFacade({
    ...options,
    adapterFactory: options.adapterFactory || createK2Adapter,
  });
}
