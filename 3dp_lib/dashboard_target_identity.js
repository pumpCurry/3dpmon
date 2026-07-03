/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 接続先(dest)正規化・同一性ヘルパ
 * @file dashboard_target_identity.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_target_identity
 *
 * 【機能内容サマリ】
 * - 接続先文字列 dest の解析(parseDest)と正規化(normalizeDest)
 * - IPv4 / IPv6(bracket・bare) / hostname:port の判定
 * - `dest.split(":")[0]` / ポート判定 `dest.includes(":")` の唯一の代替
 *
 * 【設計意図】
 * - 「機体同一性(hostname/mac)」「到達先(dest)」を混ぜないための土台。
 * - dest は到達先でしかない。IPv6 や hostname:port を素朴な split(":") で
 *   壊さないよう、解析はすべて本モジュールに集約する。
 *
 * 【公開関数一覧】
 * - {@link parseDest}：dest を解析
 * - {@link normalizeDest}：既定ポート補完つき正規化 dest を得る
 * - {@link isIPv4}：IPv4 リテラル判定
 * - {@link isIpLiteral}：IPリテラル(v4/v6)判定
 * - {@link extractHost}：dest からホスト部のみ抽出(旧 _extractIp 相当)
 *
 * @version 1.400.0 (audit P0 identity)
 * @since   1.400.0
 * @lastModified 2026-07-04 00:00:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */
"use strict";

/**
 * 文字列が IPv4 リテラルかを判定する。
 *
 * @param {string} s - 判定対象
 * @returns {boolean} IPv4 なら true
 */
export function isIPv4(s) {
  const parts = String(s || "").split(".");
  if (parts.length !== 4) return false;
  return parts.every(x => {
    if (!/^\d{1,3}$/.test(x)) return false;
    const n = Number(x);
    return n >= 0 && n <= 255;
  });
}

/**
 * 接続先文字列 dest を解析する。IPv4 / IPv6(bracket・bare) / hostname を扱う。
 *
 * 返却オブジェクト:
 * - `ok`         : 解析成功(hostname:port の port が不正なときのみ false)
 * - `host`       : ホスト部(IPv6 は角括弧を外した生アドレス)
 * - `port`       : ポート番号 or null(未指定)
 * - `hasPort`    : 明示ポートを含むか
 * - `isIPv4/isIPv6/isHostname`
 * - `reason`     : ok=false の理由
 *
 * @param {string} input - "192.168.1.5:9999" / "[fe80::1]:80" / "fe80::1" / "host" 等
 * @returns {{ok:boolean, host?:string, port?:number|null, hasPort?:boolean,
 *   isIPv4?:boolean, isIPv6?:boolean, isHostname?:boolean, reason?:string}}
 */
export function parseDest(input) {
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, reason: "empty" };

  // [IPv6]:port または [IPv6]
  const m = raw.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (m) {
    const port = m[2] ? Number(m[2]) : null;
    return {
      ok: port == null || (Number.isInteger(port) && port > 0 && port <= 65535),
      host: m[1],
      port,
      hasPort: !!m[2],
      isIPv4: false,
      isIPv6: true,
      isHostname: false
    };
  }

  const colonCount = (raw.match(/:/g) || []).length;

  // IPv4:port または hostname:port（コロン1個）
  if (colonCount === 1) {
    const idx = raw.indexOf(":");
    const host = raw.slice(0, idx);
    const portRaw = raw.slice(idx + 1);
    const port = Number(portRaw);
    return {
      ok: !!host && /^\d+$/.test(portRaw) && Number.isInteger(port) && port > 0 && port <= 65535,
      host,
      port,
      hasPort: true,
      isIPv4: isIPv4(host),
      isIPv6: false,
      isHostname: !isIPv4(host)
    };
  }

  // bare IPv6（コロン2個以上・角括弧なし）
  if (colonCount > 1) {
    return {
      ok: true,
      host: raw,
      port: null,
      hasPort: false,
      isIPv4: false,
      isIPv6: true,
      isHostname: false
    };
  }

  // bare IPv4 または hostname（コロンなし）
  return {
    ok: true,
    host: raw,
    port: null,
    hasPort: false,
    isIPv4: isIPv4(raw),
    isIPv6: false,
    isHostname: !isIPv4(raw)
  };
}

/**
 * dest を「host:port」正規形へ整える。IPv6 は角括弧で包む。
 * 明示ポートが無ければ `defaultPort` を補完する。
 *
 * @param {string} input - 接続先文字列
 * @param {{defaultPort?:number}} [opts] - 既定ポート
 * @returns {ReturnType<typeof parseDest> & {normalizedDest?:string, port?:number|null}}
 *   parseDest の結果に `normalizedDest` を加えたもの。port 不正/欠落時は ok=false。
 */
export function normalizeDest(input, { defaultPort } = {}) {
  const p = parseDest(input);
  if (!p.ok) return p;
  const port = p.port || defaultPort;
  if (!port) return { ...p, ok: false, reason: "missing-port" };
  const hostPart = p.isIPv6 ? `[${p.host}]` : p.host;
  return {
    ...p,
    port,
    hasPort: true,
    normalizedDest: `${hostPart}:${port}`
  };
}

/**
 * dest がIPリテラル(IPv4 または IPv6)かを判定する。
 * ホスト名は false。IP→hostname 移行の対象判定に使う。
 *
 * @param {string} s - 接続先文字列
 * @returns {boolean} IPv4/IPv6 リテラルなら true
 */
export function isIpLiteral(s) {
  const p = parseDest(s);
  return !!p.ok && (!!p.isIPv4 || !!p.isIPv6);
}

/**
 * dest からホスト部のみを抽出する（旧 `_extractIp` 相当）。
 * "192.168.1.5:9999" → "192.168.1.5" / "[fe80::1]:80" → "fe80::1" /
 * "fe80::1" → "fe80::1" / "host" → "host"
 *
 * @param {string} dest - 接続先文字列
 * @returns {string} ホスト部（解析不能時は空文字）
 */
export function extractHost(dest) {
  const p = parseDest(dest);
  return p.ok ? (p.host || "") : "";
}
