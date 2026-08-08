/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 PrinterSession モジュール
 * @file dashboard_printer_session.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_printer_session
 *
 * 【機能内容サマリ】
 * - 物理 device に紐づく接続 session metadata を表現
 * - WS9999 / HTTP / MaterialProvider / Camera など複数 transport の同居準備を行う
 * - Gate 11 では read-only metadata として保持し、command authority には使わない
 *
 * 【公開関数一覧】
 * - {@link createPrinterSession}：PrinterSession metadata を生成
 * - {@link closePrinterSession}：PrinterSession metadata を closed 状態へ更新
 * - {@link clonePrinterSession}：PrinterSession metadata の clone を生成
 *
 * @version 1.390.1336 (PR #432)
 * @since   1.390.1336 (PR #432)
 * @lastModified 2026-08-09 01:05:00
 * -----------------------------------------------------------
 * @todo
 * - Data Schema v3 の deviceSessions / deviceEndpoints store と接続する
 */

"use strict";

/**
 * PrinterSession schema version。
 *
 * 【詳細説明】
 * - Gate 11 では Facade 内の揮発 metadata として扱い、永続 Data Schema v3 の version ではない。
 *
 * @constant {number}
 */
export const PRINTER_SESSION_SCHEMA_VERSION = 1;

/**
 * 文字列IDを空でない値へ正規化する。
 *
 * 【詳細説明】
 * - deviceId / sessionId が空文字のまま session metadata に入ると、複数実機の transport が
 *   同じ bucket へ混ざるため、生成境界で拒否する。
 *
 * @private
 * @param {*} value - ID 候補
 * @param {string} name - エラー表示用の ID 名
 * @returns {string} 正規化済み ID
 * @throws {TypeError} ID が空の場合
 */
function requireNonEmptyId(value, name) {
  const id = String(value ?? "").trim();
  if (!id) {
    throw new TypeError(`PrinterSession requires a non-empty ${name}.`);
  }
  return id;
}

/**
 * 任意値を安全に clone する。
 *
 * 【詳細説明】
 * - session metadata は呼び出し側へ返すため、外部 mutation が内部状態へ戻らないよう clone する。
 * - 現在扱う metadata は JSON 互換値に限定している。
 *
 * @private
 * @param {*} value - clone 対象
 * @returns {*} clone 済み値
 */
function cloneJsonValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * transport kind を正規化する。
 *
 * 【詳細説明】
 * - 空 kind は `unknown` に寄せ、Gate 11 の metadata 収集で例外を増やさない。
 * - 正式 authority 化前に未知 transport が混じっても、証拠として残せるようにする。
 *
 * @private
 * @param {*} value - transport kind 候補
 * @returns {string} 正規化済み kind
 */
function normalizeTransportKind(value) {
  const kind = String(value ?? "").trim().toLowerCase();
  return kind || "unknown";
}

/**
 * transport metadata を正規化する。
 *
 * 【詳細説明】
 * - endpoint / role / authority は任意だが、後続 review で transport の意味を追えるよう保持する。
 * - command authority ではないため、`authority` 未指定時は `read-only-observation` にする。
 *
 * @private
 * @param {object|null|undefined} transport - transport 候補
 * @returns {object} 正規化済み transport
 */
function normalizeTransport(transport) {
  const source = transport && typeof transport === "object" ? transport : {};
  return {
    kind: normalizeTransportKind(source.kind),
    endpoint: String(source.endpoint ?? "").trim() || null,
    role: String(source.role ?? "").trim() || null,
    authority: String(source.authority ?? "").trim() || "read-only-observation",
    observedAt: String(source.observedAt ?? "").trim() || null,
    metadata: cloneJsonValue(source.metadata || {}),
  };
}

/**
 * transport 配列を重複なく正規化する。
 *
 * 【詳細説明】
 * - 同一 kind / endpoint / role の transport は1件に集約する。
 * - metadata は最初に観測した値を残し、後続 Gate で event 化するまでは上書きしない。
 *
 * @private
 * @param {Array<object>|object|null|undefined} transports - transport 候補
 * @returns {Array<object>} 正規化済み transport 配列
 */
function normalizeTransports(transports) {
  const sourceList = Array.isArray(transports)
    ? transports
    : transports ? [transports] : [];
  const records = sourceList.map((transport) => normalizeTransport(transport));
  const unique = [];
  const keys = new Set();
  for (const record of records) {
    const key = `${record.kind}\n${record.endpoint || ""}\n${record.role || ""}`;
    if (keys.has(key)) {
      continue;
    }
    keys.add(key);
    unique.push(record);
  }
  return unique;
}

/**
 * PrinterSession metadata を生成する。
 *
 * 【詳細説明】
 * - `deviceId` は物理機、`sessionId` は接続 lifecycle を表す。
 * - transports は read-only metadata として保持し、Gate 11 時点では command routing には使わない。
 *
 * @function createPrinterSession
 * @param {object} options - session 生成オプション
 * @param {string} options.deviceId - 物理 device ID
 * @param {string} options.sessionId - 接続 session ID
 * @param {string=} options.family - printer family
 * @param {string=} options.adapterId - adapter ID
 * @param {string=} options.protocol - protocol ID
 * @param {string=} options.openedAt - session 開始時刻 ISO 文字列
 * @param {Array<object>|object=} options.transports - transport metadata
 * @param {object=} options.metadata - 補助 metadata
 * @returns {object} PrinterSession metadata
 * @example
 * const session = createPrinterSession({ deviceId, sessionId, transports: [{ kind: "ws9999" }] });
 */
export function createPrinterSession(options = {}) {
  const deviceId = requireNonEmptyId(options.deviceId, "deviceId");
  const sessionId = requireNonEmptyId(options.sessionId, "sessionId");
  return {
    schemaVersion: PRINTER_SESSION_SCHEMA_VERSION,
    deviceId,
    sessionId,
    family: String(options.family ?? "").trim() || null,
    adapterId: String(options.adapterId ?? "").trim() || null,
    protocol: String(options.protocol ?? "").trim() || null,
    status: "active",
    openedAt: String(options.openedAt ?? "").trim() || null,
    closedAt: null,
    transports: normalizeTransports(options.transports),
    metadata: cloneJsonValue(options.metadata || {}),
  };
}

/**
 * PrinterSession metadata を closed 状態へ更新する。
 *
 * 【詳細説明】
 * - close は冪等にし、複数回呼ばれても最初の closedAt を保持する。
 *
 * @function closePrinterSession
 * @param {object|null|undefined} session - session metadata
 * @param {object=} options - close オプション
 * @param {string=} options.closedAt - 終了時刻 ISO 文字列
 * @returns {object|null} closed session、または入力が無い場合 null
 * @example
 * const closed = closePrinterSession(session, { closedAt: new Date().toISOString() });
 */
export function closePrinterSession(session, options = {}) {
  if (!session) {
    return null;
  }
  if (session.status === "closed") {
    return session;
  }
  session.status = "closed";
  session.closedAt = String(options.closedAt ?? "").trim() || null;
  return session;
}

/**
 * PrinterSession metadata の clone を返す。
 *
 * 【詳細説明】
 * - Facade 外へ metadata を返すときに使い、呼び出し側 mutation から内部状態を保護する。
 *
 * @function clonePrinterSession
 * @param {object|null|undefined} session - session metadata
 * @returns {object|null} clone 済み session、または null
 * @example
 * const session = clonePrinterSession(facade.getSession(deviceId));
 */
export function clonePrinterSession(session) {
  return session ? cloneJsonValue(session) : null;
}
