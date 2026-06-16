/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 サーマル異常検知 / 熱フェーズ判定モジュール
 * @file dashboard_thermal_guard.js
 * @copyright (c) pumpCurry 2026 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_thermal_guard
 *
 * 【設計意図】
 * - 「異常をわかること」と「グラフを描画すること」を分離する。
 *   グラフ描画(chart.js)は重く、2Hz 連続再描画が CPU を占有していた。
 *   一方、温度異常の検知は浮動小数の比較数発で済む。よって検知は
 *   データ経路上(aggregator)で 2Hz(以上) 実行し、描画レートとは独立させる。
 * - 検知対象は **温度フィールド限定**（nozzle / bed / box）。
 *   err(errcode/key, 解除時 0,0)・fan 等ビット値(0/1)は一切対象にしない。
 * - 絶対上限は機器報告値(maxNozzleTemp / maxBedTemp)を優先し、無ければ既定値。
 *
 * 【純関数方針】
 * - DOM や他モジュールに依存しない。入力(reading) + 状態(state) → 結果(result)。
 *   これによりブラウザ版・モックデータでの整合性確認(vitest)が容易。
 * - 着色の最終的な色計算・発報・バッジ更新は呼び出し側(UI 層)が行う。本モジュールは
 *   「フェーズ / 強度 / 方向 / アラート」という意味情報だけを返す。
 *
 * 【公開関数一覧】
 * - {@link DEFAULT_THERMAL_CONFIG}：既定しきい値
 * - {@link createThermalState}：ホスト毎の保持状態を生成
 * - {@link evaluateThermal}：1サンプルを評価し結果を返す
 *
 * @version 1.0.0
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

/**
 * 既定のしきい値・パラメータ。
 * 通知設定モーダルから上書きできるよう、すべて evaluateThermal の config 引数で差し替え可能。
 *
 * @type {Object}
 */
export const DEFAULT_THERMAL_CONFIG = {
  /** 検知全体の ON/OFF */
  enabled: true,
  /** 室温の想定値(℃)。目標未設定チャンネルの基準に使う */
  ambientC: 25,
  /** 安定とみなす目標差の帯域(℃)。|差| <= これ なら stable(ニュートラル) */
  stableBandC: 3,
  /** 連続スケールが最大濃度に達する温度差(℃)。|差| がこれ以上で intensity=1 */
  colorSpanC: 40,

  /* --- 絶対上限(error/赤)。機器報告 max が無い場合のフォールバック --- */
  nozzleMaxC: 300,
  bedMaxC: 120,
  boxMaxC: 65,

  /* --- 急変化(error/赤)。連続サンプル間の |ΔT/Δt| --- */
  nozzleRateMaxCps: 15,
  bedRateMaxCps: 5,
  boxRateMaxCps: 20,
  /** レート判定に採用する Δt の下限(ms)。これ未満は採用しない(ノイズ/重複) */
  rateMinDtMs: 100,
  /** レート判定に採用する Δt の上限(ms)。これ超は採用しない(間欠/復帰直後) */
  rateMaxDtMs: 5000,

  /* --- 目標乖離の継続(warn/黄) --- */
  deviationLimitC: 20,
  deviationDurationMs: 10000,

  /* --- オーバーシュート(error/赤)。目標到達後に超過し続ける --- */
  overshootLimitC: 15,
  overshootDurationMs: 5000,

  /* --- 昇温不良(warn/黄)。加熱指令中なのに上がらない --- */
  noRiseWindowMs: 30000,
  noRiseMinC: 2,

  /* --- 方向矢印のレート閾値(℃/s) --- */
  /** これ以上の変化率で「明確な上昇/下降」= ▲▼。未満かつ不感帯超は「微増/微減」= △▽ */
  arrowStrongRateCps: 0.5,
};

/**
 * 現在有効なしきい値(通知設定モーダルから上書き)。既定の浅いコピー。
 * @private
 * @type {Object}
 */
let _activeConfig = { ...DEFAULT_THERMAL_CONFIG };

/**
 * 現在のしきい値を取得する(aggregator から評価時に使用)。
 * @returns {Object}
 */
export function getThermalConfig() {
  return _activeConfig;
}

/**
 * しきい値を上書きする(設定 UI / 永続化から復元時に使用)。
 * 未指定キーは既定値で補完する。
 * @param {Object} [patch] - 上書きする一部設定
 * @returns {Object} 反映後の有効設定
 */
export function setThermalConfig(patch) {
  _activeConfig = { ...DEFAULT_THERMAL_CONFIG, ...(patch || {}) };
  return _activeConfig;
}

/**
 * 検知対象チャンネル定義。
 * tempKey/targetKey/maxKey は storedData のキー名。box は目標なし。
 *
 * @type {Array<Object>}
 */
const CHANNELS = [
  { key: "nozzle", label: "ノズル", tempKey: "nozzleTemp", targetKey: "targetNozzleTemp", maxKey: "maxNozzleTemp", maxCfg: "nozzleMaxC", rateCfg: "nozzleRateMaxCps", hasTarget: true },
  { key: "bed",    label: "ベッド", tempKey: "bedTemp0",   targetKey: "targetBedTemp0",   maxKey: "maxBedTemp",   maxCfg: "bedMaxC",   rateCfg: "bedRateMaxCps",    hasTarget: true },
  { key: "box",    label: "箱内",   tempKey: "boxTemp",    targetKey: null,                maxKey: null,           maxCfg: "boxMaxC",   rateCfg: "boxRateMaxCps",    hasTarget: false },
];

/** @type {number} 方向(↑↓)判定の不感帯(℃/s) */
const RATE_EPS_CPS = 0.05;

/**
 * 数値化ヘルパ。null/undefined/空/非数は NaN。
 * @param {*} v
 * @returns {number}
 */
function num(v) {
  if (v === null || v === undefined || v === "") return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * ホスト毎に保持する評価状態を生成する。
 * aggregator の per-host state(_getState(host).thermal)に格納して使う。
 *
 * @returns {Object} 初期状態
 */
export function createThermalState() {
  const ch = {};
  for (const c of CHANNELS) {
    ch[c.key] = {
      lastTemp: NaN,
      lastTs: 0,
      devSince: 0,        // 乖離継続の起点(ms)。0=未発生
      overSince: 0,       // オーバーシュート継続の起点(ms)
      noRiseStartTs: 0,   // 昇温監視窓の起点(ms)
      noRiseStartTemp: NaN,
    };
  }
  return {
    ch,
    /** アクティブなアラート: key=`${channel}.${category}` → alert オブジェクト */
    active: {},
  };
}

/**
 * セル状態 → 背景/文字色を返す純関数(DOM 非依存・単一の真実源)。
 * dashboard_ui の着色とプレビューハーネスの双方で共用する。
 * - stable は null(着色解除)。
 * - heating/cooling は intensity に応じた rgba オーバーレイ(連続グラデ＝「徐々に」)。
 * - warn/error はテーマ追従の CSS 変数を使用(ダークモード対応)。
 *
 * @param {?{phase:string,intensity:number,direction:number,level:?string}} cell
 * @returns {?{bg:string, fg:string}}
 */
export function thermalCellStyle(cell) {
  if (!cell) return null;
  if (cell.level === "error") return { bg: "var(--color-danger-bg)",  fg: "var(--color-danger-text)" };
  if (cell.level === "warn")  return { bg: "var(--color-warning-bg)", fg: "var(--color-warning-text)" };
  if (cell.intensity > 0 && cell.phase === "heating") {
    const a = (0.12 + cell.intensity * 0.5).toFixed(3);
    return { bg: `rgba(99,153,34,${a})`, fg: "" };
  }
  if (cell.intensity > 0 && cell.phase === "cooling") {
    const a = (0.12 + cell.intensity * 0.5).toFixed(3);
    return { bg: `rgba(55,138,221,${a})`, fg: "" };
  }
  return null;
}

/**
 * 方向矢印(▲△▽▼)の色を返す。向き基準: 上昇=緑 / 下降=青 / 安定=淡色。
 * @param {?{direction:number}} cell
 * @returns {string} CSS color
 */
export function thermalArrowColor(cell) {
  const d = cell?.direction || 0;
  if (d > 0) return "#639922"; // 上昇基調
  if (d < 0) return "#378ADD"; // 下降基調
  return "var(--color-text-tertiary)";
}

/**
 * 方向値(±2=▲▼, ±1=△▽, 0=なし)を矢印文字へ変換する。
 * @param {number} direction
 * @returns {string} 矢印文字(空=なし)
 */
export function thermalArrowGlyph(direction) {
  switch (direction) {
    case 2:  return "▲";
    case 1:  return "△";
    case -1: return "▽";
    case -2: return "▼";
    default: return "";
  }
}

/**
 * チャンネル単位の熱フェーズ(色表示用)を求める。
 *
 * @private
 * @param {Object} c チャンネル定義
 * @param {number} current 現在温度
 * @param {number} target  目標温度(未設定は NaN)
 * @param {number} rate    ℃/s(不明は NaN)
 * @param {Object} cfg     config
 * @returns {{phase:('heating'|'cooling'|'stable'), intensity:number, direction:(1|0|-1)}}
 */
function computePhase(c, current, target, rate, cfg) {
  // 方向: ±2=明確な上昇/下降(▲▼), ±1=微増/微減(△▽), 0=安定(矢印なし)
  let dir = 0;
  if (Number.isFinite(rate)) {
    const a = Math.abs(rate);
    if (a >= cfg.arrowStrongRateCps) dir = rate > 0 ? 2 : -2;
    else if (a > RATE_EPS_CPS) dir = rate > 0 ? 1 : -1;
  }

  if (!Number.isFinite(current)) return { phase: "stable", intensity: 0, direction: 0 };

  const hasActiveTarget = c.hasTarget && Number.isFinite(target) && target > 0;

  if (hasActiveTarget) {
    const delta = current - target;
    const intensity = Math.min(Math.abs(delta) / cfg.colorSpanC, 1);
    if (delta < -cfg.stableBandC) return { phase: "heating", intensity, direction: dir };
    if (delta > cfg.stableBandC)  return { phase: "cooling", intensity, direction: dir };
    return { phase: "stable", intensity: 0, direction: dir };
  }

  // 目標未設定/0: 室温基準。方向はレート優先。
  const above = current - cfg.ambientC;
  const intensity = Math.min(Math.abs(above) / cfg.colorSpanC, 1);
  if (Math.abs(above) <= cfg.stableBandC) return { phase: "stable", intensity: 0, direction: dir };
  if (dir > 0) return { phase: "heating", intensity, direction: dir };
  if (dir < 0) return { phase: "cooling", intensity, direction: dir };
  // 動いていない: 室温より高ければ放熱中とみなす
  return { phase: above > 0 ? "cooling" : "heating", intensity, direction: dir };
}

/**
 * 1サンプル(全チャンネル)を評価する。
 *
 * @param {Object} reading 温度関連の生値。
 *   { nozzleTemp, targetNozzleTemp, bedTemp0, targetBedTemp0, boxTemp, maxNozzleTemp, maxBedTemp }
 * @param {Object} state {@link createThermalState} が返した状態(破壊的に更新)
 * @param {number} now 現在時刻(ms, Date.now())
 * @param {Object} [config=DEFAULT_THERMAL_CONFIG]
 * @returns {{
 *   cells: Object<string,{phase:string,intensity:number,direction:number,level:(null|'warn'|'error')}>,
 *   alerts: Array<Object>, newAlerts: Array<Object>, clearedAlerts: Array<Object>,
 *   counts: {error:number, warn:number}
 * }}
 */
export function evaluateThermal(reading, state, now, config = DEFAULT_THERMAL_CONFIG) {
  const cfg = { ...DEFAULT_THERMAL_CONFIG, ...config };
  const cells = {};
  const activeNow = {};
  const alerts = [];

  if (!cfg.enabled) {
    return { cells: {}, alerts: [], newAlerts: [], clearedAlerts: [], counts: { error: 0, warn: 0 } };
  }

  for (const c of CHANNELS) {
    const st = state.ch[c.key] || (state.ch[c.key] = {
      lastTemp: NaN, lastTs: 0, devSince: 0, overSince: 0, noRiseStartTs: 0, noRiseStartTemp: NaN,
    });

    const current = num(reading[c.tempKey]);
    const target = c.targetKey ? num(reading[c.targetKey]) : NaN;
    const hasActiveTarget = c.hasTarget && Number.isFinite(target) && target > 0;

    // 絶対上限: 機器報告 max を優先、無ければ既定
    const reportedMax = c.maxKey ? num(reading[c.maxKey]) : NaN;
    const maxLimit = (Number.isFinite(reportedMax) && reportedMax > 0) ? reportedMax : cfg[c.maxCfg];

    // レート(℃/s): 前サンプルとの差分。Δt が妥当な範囲のときのみ採用。
    let rate = NaN;
    if (Number.isFinite(st.lastTemp) && st.lastTs > 0) {
      const dt = now - st.lastTs;
      if (dt >= cfg.rateMinDtMs && dt <= cfg.rateMaxDtMs) {
        rate = (current - st.lastTemp) / (dt / 1000);
      }
    }

    const chAlerts = [];
    const addAlert = (category, level, code, message) => {
      const a = { channel: c.key, label: c.label, category, level, code, message };
      chAlerts.push(a);
      activeNow[`${c.key}.${category}`] = a;
    };

    if (Number.isFinite(current)) {
      // 1) 絶対上限(error)
      if (current >= maxLimit) {
        addAlert("over", "error", "THERMAL_OVER_MAX",
          `${c.label} ${current.toFixed(1)}℃ が上限 ${maxLimit}℃ に到達`);
      }

      // 2) 急変化(error)
      const rateMax = cfg[c.rateCfg];
      if (Number.isFinite(rate) && Math.abs(rate) > rateMax) {
        addAlert("rate", "error", "THERMAL_RATE",
          `${c.label} 温度が急変化 ${rate >= 0 ? "+" : ""}${rate.toFixed(1)}℃/s`);
      }

      if (hasActiveTarget) {
        const diff = current - target;

        // 3) オーバーシュート(error): 目標+overshootLimit を継続超過
        if (diff > cfg.overshootLimitC) {
          if (st.overSince === 0) st.overSince = now;
          if (now - st.overSince >= cfg.overshootDurationMs) {
            addAlert("overshoot", "error", "THERMAL_OVERSHOOT",
              `${c.label} が目標 ${target}℃ を ${diff.toFixed(1)}℃ 超過し継続`);
          }
        } else {
          st.overSince = 0;
        }

        // 4) 目標乖離の継続(warn)
        if (Math.abs(diff) > cfg.deviationLimitC) {
          if (st.devSince === 0) st.devSince = now;
          if (now - st.devSince >= cfg.deviationDurationMs) {
            addAlert("deviation", "warn", "THERMAL_DEVIATION",
              `${c.label} が目標 ${target}℃ から ${diff >= 0 ? "+" : ""}${diff.toFixed(1)}℃ 乖離`);
          }
        } else {
          st.devSince = 0;
        }

        // 5) 昇温不良(warn): 加熱指令中(目標を下回る)なのに窓内で上がらない
        const heatingDemand = diff < -cfg.stableBandC;
        if (heatingDemand) {
          if (st.noRiseStartTs === 0) {
            st.noRiseStartTs = now;
            st.noRiseStartTemp = current;
          } else if (now - st.noRiseStartTs >= cfg.noRiseWindowMs) {
            const rise = current - st.noRiseStartTemp;
            if (rise < cfg.noRiseMinC) {
              addAlert("norise", "warn", "THERMAL_NO_RISE",
                `${c.label} 加熱指令中に ${Math.round(cfg.noRiseWindowMs / 1000)}秒で +${rise.toFixed(1)}℃ しか上昇せず`);
            }
            // 窓をスライド(起点更新)して継続監視
            st.noRiseStartTs = now;
            st.noRiseStartTemp = current;
          }
        } else {
          st.noRiseStartTs = 0;
          st.noRiseStartTemp = NaN;
        }
      } else {
        // 目標未設定: 継続系タイマをリセット
        st.overSince = 0;
        st.devSince = 0;
        st.noRiseStartTs = 0;
        st.noRiseStartTemp = NaN;
      }
    }

    // フェーズ(色表示)
    const phase = computePhase(c, current, target, rate, cfg);

    // セルの代表レベル: error > warn > null
    let level = null;
    if (chAlerts.some(a => a.level === "error")) level = "error";
    else if (chAlerts.some(a => a.level === "warn")) level = "warn";

    cells[c.key] = { ...phase, level };
    alerts.push(...chAlerts);

    // 状態更新(レート用の前回値)
    if (Number.isFinite(current)) {
      st.lastTemp = current;
      st.lastTs = now;
    }
  }

  // 新規 / 解除アラートの差分(ワンショット通知・自動復帰用)
  const prevActive = state.active || {};
  const newAlerts = [];
  const clearedAlerts = [];
  for (const k of Object.keys(activeNow)) {
    if (!prevActive[k]) newAlerts.push(activeNow[k]);
  }
  for (const k of Object.keys(prevActive)) {
    if (!activeNow[k]) clearedAlerts.push(prevActive[k]);
  }
  state.active = activeNow;

  const counts = { error: 0, warn: 0 };
  for (const a of alerts) {
    if (a.level === "error") counts.error++;
    else if (a.level === "warn") counts.warn++;
  }

  return { cells, alerts, newAlerts, clearedAlerts, counts };
}
