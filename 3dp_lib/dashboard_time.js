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
 * 値が有効な IANA タイムゾーン名なら正規化して返し、無効なら null を返す。
 *
 * ★ レビュー(P1): import/手動編集で "Asia/Toky" "JST" "Japan" 等が入ると Intl が RangeError を
 * 投げ、レポート全体が停止する。保存・snapshot 適用・import 時に本関数で検証し、無効値は採用しない
 * （UTC へ黙って変えるのではなく、呼び出し側で直前の有効値を維持する）。
 *
 * @param {*} value - 候補タイムゾーン
 * @returns {?string} 有効な IANA 名、または null
 */
export function normalizeTimeZone(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const tz = value.trim();
  try {
    // 無効な timeZone は RangeError。有効なら解決名を返す（Intl が正準化する場合がある）。
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone || tz;
  } catch {
    return null;
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
/**
 * instant を指定ゾーンで表した壁時計文字列 "YYYY-MM-DDTHH:mm:ss" を返す（内部）。
 * @private
 */
function _wallStrAtZone(instantMs, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(instantMs))) p[part.type] = part.value;
  // hourCycle:h23 でも稀に "24" を返す環境があるため 00 へ寄せる
  const hh = p.hour === "24" ? "00" : p.hour;
  return `${p.year}-${p.month}-${p.day}T${hh}:${p.minute}:${p.second}`;
}

export function epochMsFromWallClock(wallStr, timeZone) {
  const s = String(wallStr == null ? "" : wallStr).trim().replace(/[zZ]$/, "");
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return null;
  const wall = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || "00"}`;
  const wallUtcMs = Date.parse(wall + "Z"); // 壁時計値をいったん UTC とみなした基準
  if (!Number.isFinite(wallUtcMs)) return null;

  // ★ レビュー(P0): 1回だけの offset 補正は DST 切替付近で誤変換する。切替を挟む候補オフセットを
  //   複数試し、各候補 instant を「同じゾーンへ round-trip」して元の壁時計に一致するものだけ採用する。
  //   一致0件=存在しない時刻(春の gap)→null / 一致2件=重複時刻(秋の overlap)→曖昧として null。
  const offsets = new Set();
  for (const h of [-12, -6, 0, 6, 12]) {
    const probe = wallUtcMs + h * 3600000;
    // offset(ms) = (probe をゾーン表記した壁時計を UTC とみなした値) − probe
    const off = Date.parse(_wallStrAtZone(probe, timeZone) + "Z") - probe;
    if (Number.isFinite(off)) offsets.add(off);
  }
  const valid = new Set();
  for (const off of offsets) {
    const cand = wallUtcMs - off;
    if (_wallStrAtZone(cand, timeZone) === wall) valid.add(cand);
  }
  if (valid.size === 1) return [...valid][0];
  return null; // 0=gap(存在しない) / 2以上=overlap(曖昧) は安全側で null（未検証として隔離）
}

/** 指定年月(1-based)の日数を返す（内部）。 */
function _daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function parseInstantStrict(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const s = value.trim();
  // ★ レビュー(P2): 完全な offset/Z 付き ISO 日時を検査する（エンジン依存の寛容 parse 差を排除）。
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|([+-])(\d{2}):?(\d{2}))$/.exec(s);
  if (!m) return null;
  const Y = +m[1], Mo = +m[2], D = +m[3], H = +m[4], Mi = +m[5], S = m[6] != null ? +m[6] : 0;
  // ★ レビュー(P1 item4): 形式だけでなく実在する年月日時かを検証（2026-02-31 等を弾く）。
  if (Mo < 1 || Mo > 12) return null;
  if (D < 1 || D > _daysInMonth(Y, Mo)) return null;
  if (H > 23 || Mi > 59 || S > 59) return null;
  if (m[7]) { // Z ではなくオフセット指定
    const oh = +m[8], om = +m[9];
    if (oh > 14 || om > 59) return null; // オフセット範囲（±14:00 まで）
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
