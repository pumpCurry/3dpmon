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
let _monoLast = 0;
export function monotonicNowMs() {
  const raw = (typeof performance !== "undefined" && typeof performance.now === "function")
    ? performance.now()
    : Date.now();
  // ★ レビュー(P2): performance.now が無い環境の Date.now フォールバックは単調でないため、
  //   最終値との Math.max で最低限「後退しない」契約を満たす（壁時計後退でも throttle が壊れない）。
  if (raw >= _monoLast) { _monoLast = raw; return raw; }
  return _monoLast;
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
/** タイムゾーン単位の Intl.DateTimeFormat キャッシュ（レビュー P1: 集計毎の大量生成を防ぐ）。 */
const _fmtCache = new Map();

/**
 * 指定 IANA タイムゾーンの日付フォーマッタを返す（キャッシュ）。
 * @private
 * @param {string} timeZone
 * @returns {Intl.DateTimeFormat}
 */
function _formatterFor(timeZone) {
  let fmt = _fmtCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit"
    });
    _fmtCache.set(timeZone, fmt);
  }
  return fmt;
}

function _partsAtZone(epochMs, timeZone) {
  const out = { year: "1970", month: "01", day: "01" };
  for (const p of _formatterFor(timeZone).formatToParts(new Date(epochMs))) {
    if (p.type === "year" || p.type === "month" || p.type === "day") out[p.type] = p.value;
  }
  return out;
}

/**
 * 業務日付キー("YYYY-MM-DD")を「カレンダー日」単位で加減算する（DST 安全）。
 *
 * ★ レビュー(P0): 「nowMs − d*86400000」は 24 時間前であってカレンダー前日ではない。DST 開始日を
 * 跨ぐと 1 日飛んで N 日に満たない配列になる。キー文字列を UTC の Date でカレンダー日として増減し、
 * ゾーン変換を挟まないことで DST の影響を受けないようにする。
 *
 * @param {string} key - "YYYY-MM-DD"
 * @param {number} days - 加算日数（負で過去）
 * @returns {string} "YYYY-MM-DD"
 */
export function shiftDateKey(key, days) {
  const [y, m, d] = String(key).split("-").map(Number);
  const x = new Date(Date.UTC(y, (m || 1) - 1, (d || 1) + (Number(days) || 0)));
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}-${String(x.getUTCDate()).padStart(2, "0")}`;
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
 * ★ 数値は epoch ミリ秒のみを受け付ける（epoch 秒を渡すと 1970 年になるため、呼び出し側で ms へ）。
 *
 * @param {number|string|null|undefined} value
 * @returns {?number} epoch ミリ秒、または受理不能なら null
 */
/**
 * タイムゾーンなしの「壁時計」文字列を、指定 IANA タイムゾーンでの実時刻(epoch ms)へ変換する。
 *
 * ★ レビュー(P1): 旧履歴の offset なし文字列（"2026-04-01T10:00:00" 等）を移行するための明示関数。
 * 「そのゾーンでの 10:00」として解釈する（暗黙のローカル/UTC 解釈をしない）。DST の実オフセットも
 * 当該瞬間で算出する。offset 付き文字列は本関数ではなく {@link parseInstantStrict} を使うこと。
 *
 * @param {string} wallStr - "YYYY-MM-DDTHH:mm[:ss]"（offset/Z なし）
 * @param {string} timeZone - IANA タイムゾーン
 * @returns {?number} epoch ミリ秒、または解釈不能なら null
 */
export function epochMsFromWallClock(wallStr, timeZone) {
  const s = String(wallStr == null ? "" : wallStr).trim().replace(/[zZ]$/, "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) return null;
  const asUtcMs = Date.parse(s + "Z"); // 壁時計値をいったん UTC とみなす
  if (!Number.isFinite(asUtcMs)) return null;
  // 当該瞬間の timeZone オフセット(ms) を算出し、壁時計 → 実時刻へ補正する
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(asUtcMs))) p[part.type] = part.value;
  const asIfLocalMs = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offsetMs = asIfLocalMs - asUtcMs;
  return asUtcMs - offsetMs;
}

export function parseInstantStrict(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const s = value.trim();
    // ★ レビュー(P2): 末尾判定でなく「完全な offset/Z 付き ISO 日時」を検査してからparseする
    //   （エンジン依存の寛容な Date.parse 差を排除）。
    //   例: 2026-04-01T10:00:00Z / 2026-04-01T10:00:00.123+09:00 / 2026-04-01T10:00+0900
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
      const t = Date.parse(s);
      return Number.isFinite(t) ? t : null;
    }
  }
  return null;
}
