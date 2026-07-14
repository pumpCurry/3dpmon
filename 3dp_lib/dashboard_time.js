/**
 * @fileoverview 時計の用途分離 境界モジュール（レビュー第3弾 時計衛生）
 * @file dashboard_time.js
 * @copyright (c) pumpCurry 2026 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_time
 *
 * 【方針】Temporal 全面移行の前段として、時計を用途別に分離する内部境界を設ける。
 *   後で Temporal へ移行するときは、本モジュール内部だけを交換できるようにする。
 *   （現行 Electron 33 = Chromium 130 / Node 20 はネイティブ Temporal 非対応・Safari 未確定のため
 *    ネイティブ Temporal は必須にしない。）
 *
 * - {@link wallNowMs}      永続する実時刻（作成/完了/ログ/保存/外部比較）。epoch ミリ秒。
 * - {@link monotonicNowMs} 短時間の経過測定（throttle/タイムアウト/UI間隔）。壁時計補正の影響を受けない。
 * - {@link dateKey}/{@link monthKey} 明示 IANA タイムゾーンでの業務日付キー（実行PCローカル依存を排除）。
 * - {@link parseInstantStrict} epoch 数値、または Z/±HH:mm 付き ISO のみを厳格に epoch ms へ。
 *
 * 【重要】イベント順序は時刻で決めない（親権威 seq を使う）。イベントIDに wallNow を使わない
 *   （seq または crypto.randomUUID）。壁時計は後退・重複し得るため。
 *
 * @version 2.3.0
 * @since   2.3.0
 * -----------------------------------------------------------
 */

"use strict";

/**
 * 永続する実時刻（epoch ミリ秒）。作成/完了/ログ/保存/外部システムとの比較に使う。
 * 将来 Temporal.Now.instant().epochMilliseconds へ置換可能。
 * @returns {number} epoch ミリ秒
 */
export function wallNowMs() {
  return Date.now();
}

/**
 * 単調増加の経過測定用時刻（ミリ秒）。throttle/タイムアウト/同一セッションの経過に使う。
 * 壁時計の補正（NTP/手動変更/VM時計ずれ）の影響を受けない。
 * performance.now が無い環境（古い node 等）は Date.now にフォールバックする。
 * @returns {number} ミリ秒（基準は環境依存＝差分のみ意味を持つ）
 */
export function monotonicNowMs() {
  return (typeof performance !== "undefined" && typeof performance.now === "function")
    ? performance.now()
    : Date.now();
}

/**
 * 実行環境の解決済み IANA タイムゾーン（"Asia/Tokyo" 等）。取得不能なら "UTC"。
 * @returns {string}
 */
export function resolvedLocalTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * epoch ミリ秒を指定 IANA タイムゾーンの年月日パーツへ分解する（内部）。
 * @private
 * @param {number} epochMs
 * @param {string} timeZone
 * @returns {{year:string, month:string, day:string}}
 */
function _partsAtZone(epochMs, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  });
  const out = { year: "1970", month: "01", day: "01" };
  for (const p of fmt.formatToParts(new Date(epochMs))) {
    if (p.type === "year" || p.type === "month" || p.type === "day") out[p.type] = p.value;
  }
  return out;
}

/**
 * 業務日付キー "YYYY-MM-DD"（指定 IANA タイムゾーン基準）。
 * 実行PCのローカル日付に暗黙依存せず、明示ゾーンで決定論的に決まる。
 * @param {number} epochMs - epoch ミリ秒
 * @param {string} [timeZone] - IANA タイムゾーン（省略時は解決済みローカル＝後方互換）
 * @returns {string} "YYYY-MM-DD"
 */
export function dateKey(epochMs, timeZone = resolvedLocalTimeZone()) {
  const p = _partsAtZone(epochMs, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * 業務月キー "YYYY-MM"（指定 IANA タイムゾーン基準）。
 * @param {number} epochMs - epoch ミリ秒
 * @param {string} [timeZone] - IANA タイムゾーン（省略時は解決済みローカル）
 * @returns {string} "YYYY-MM"
 */
export function monthKey(epochMs, timeZone = resolvedLocalTimeZone()) {
  const p = _partsAtZone(epochMs, timeZone);
  return `${p.year}-${p.month}`;
}

/**
 * epoch 数値、または Z/±HH:mm(±HHmm) オフセット付き ISO 文字列だけを厳格に epoch ms へ変換する。
 *
 * ★ レビュー: タイムゾーンなし文字列は曖昧（"2026-04-01"=UTC / "2026-04-01T10:00:00"=ローカル と
 * 解釈が割れる）ため、業務ロジックの正本としては受理しない（null を返す）。永続データは epoch を
 * 正本にし、文字列を保存する場合は必ず Z か オフセットを付けること。
 *
 * @param {number|string|null|undefined} value
 * @returns {?number} epoch ミリ秒、または受理不能なら null
 */
export function parseInstantStrict(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const s = value.trim();
    // Z、または 末尾の ±HH:mm / ±HHmm オフセットを含む ISO のみ許可
    if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
      const t = Date.parse(s);
      return Number.isFinite(t) ? t : null;
    }
  }
  return null;
}
