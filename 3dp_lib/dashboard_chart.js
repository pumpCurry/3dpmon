/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 温度グラフ描画モジュール（uPlot 版）
 * @file dashboard_chart.js
 * @copyright (c) pumpCurry 2025-2026 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_chart
 *
 * 【機能内容サマリ】
 * - uPlot を用いた温度時系列グラフ描画（ストリーミング特化・低CPU）
 * - マルチプリンタ対応: per-host uPlot インスタンス管理
 * - 表示時間枠でのスライディングウィンドウ・throttle 更新
 * - ドラッグズーム（ロック切替）・表示範囲リセット
 *
 * 【chart.js からの移行理由】
 * - 旧 chart.js + time 軸(date-fns) は 500ms 毎の全再描画で measureText/draw が
 *   renderer CPU を占有していた（実測: 可視 renderer 68% / GPU 24%）。
 * - uPlot は canvas 直描画でラベル計測コストが小さく、2Hz 更新でもほぼ無コスト。
 * - 異常検知は dashboard_thermal_guard.js が描画から独立して担う（描画レート非依存）。
 *
 * 【公開関数一覧】
 * - {@link initTemperatureGraph}：グラフ初期化（パネル本体＋ホスト名）
 * - {@link resetTemperatureGraph}：グラフデータリセット
 * - {@link resetTemperatureGraphView}：表示範囲（ズーム）リセット
 * - {@link toggleChartInteractionLock}：ドラッグズームのロック切替
 * - {@link updateTemperatureGraphFromStoredData}：データ更新
 * - {@link switchChartHost}：指定ホストのチャート状態を確保
 *
 * @version 2.0.0
 * @since   1.390.193 (PR #86)
 * -----------------------------------------------------------
 * @todo
 * - none
 *
 * ※ uPlot 本体(JS/CSS)は HTML 側で読み込んでください（window.uPlot グローバル）。
 */

"use strict";

// ==============================
// 設定定数
// ==============================

/**
 * デフォルト構成パラメータ
 * - timeWindowMs: 表示範囲の時間幅（ms）
 * - throttleIntervalMs: 描画更新の最小間隔（ms）
 */
const DEFAULT_CONFIG = {
  timeWindowMs:       15 * 60 * 1000,
  throttleIntervalMs: 500,
};

/** データ系列の順序（uPlot data[1..5] に対応） */
const DATASET_KEYS = ["nozzleCurrent", "nozzleTarget", "bedCurrent", "bedTarget", "boxCurrent"];

/** storedData のキー（DATASET_KEYS と同順） */
const FIELD_KEYS = ["nozzleTemp", "targetNozzleTemp", "bedTemp0", "targetBedTemp0", "boxTemp"];

/** 系列の表示定義（uPlot series[1..5]） */
const SERIES_DEFS = [
  { label: "ノズル(現在)", stroke: "#e6194b", width: 2 },
  { label: "ノズル(目標)", stroke: "#f58231", width: 1.5, dash: [5, 4] },
  { label: "ベッド(現在)", stroke: "#3cb44b", width: 2 },
  { label: "ベッド(目標)", stroke: "#1f9e89", width: 1.5, dash: [5, 4] },
  { label: "箱内(現在)",   stroke: "#4363d8", width: 2 },
];

// ==============================
// 内部状態管理（per-host）
// ==============================

/**
 * @typedef {Object} HostChartState
 * @property {Object|null} u            - uPlot インスタンス
 * @property {Array<Array<number>>} data - [xs(秒), nozzleCur, nozzleTgt, bedCur, bedTgt, boxCur]
 * @property {number}  lastUpdate       - 最終描画更新タイムスタンプ(ms)
 * @property {boolean} updateQueued     - 更新キュー済みフラグ
 * @property {boolean} isFirstRender    - 初回描画フラグ
 * @property {Object}  config           - 構成パラメータ
 * @property {HTMLElement|null} container - uPlot マウント先
 * @property {ResizeObserver|null} ro   - リサイズ追従
 * @property {boolean} zoomLocked       - ドラッグズーム無効フラグ
 */

/** @type {Map<string, HostChartState>} */
const _hostCharts = new Map();

/**
 * 指定ホストのチャート状態を取得（なければ作成）。
 * @private
 * @param {string} hostname
 * @returns {HostChartState}
 */
function _getHostState(hostname) {
  if (!_hostCharts.has(hostname)) {
    _hostCharts.set(hostname, {
      u: null,
      data: [[], [], [], [], [], []],
      lastUpdate: 0,
      updateQueued: false,
      isFirstRender: true,
      config: { ...DEFAULT_CONFIG },
      container: null,
      ro: null,
      zoomLocked: true,
      // ★ M: 表示ウィンドウ（最新から viewMs ぶんをスライド表示）。既定=保持枠と同じ。
      viewMs: DEFAULT_CONFIG.timeWindowMs,
      // ユーザーがドラッグズームしたか（true の間はスライド追従を止め、その範囲を保持）
      userZoomed: false,
      // 自前の setScale 中フラグ（setScale フックでユーザー操作と区別するため）
      _progScale: false,
    });
  }
  return _hostCharts.get(hostname);
}

/**
 * uPlot オプションを構築する。
 * @private
 * @param {Object} cfg 構成
 * @param {number} w 幅(px)
 * @param {number} h 高さ(px)
 * @param {boolean} locked ドラッグズーム無効
 * @returns {Object} uPlot opts
 */
function _buildOpts(cfg, w, h, locked, hs) {
  const axisStroke = "#888";
  const gridStroke = "rgba(128,128,128,0.18)";
  const tickStroke = "rgba(128,128,128,0.30)";
  // ★ M: 0℃ 救済 — 軸 min を常に 0 よりわずかに下げ、0℃ ちょうどの点が下端に張り付いて
  //   ホバー/視認できなくなるのを防ぐ。上端も余白を確保。
  const yRange = (_u, dataMin, dataMax) => {
    const lo = Math.min(0, Number.isFinite(dataMin) ? dataMin : 0) - 3;
    const hi = (Number.isFinite(dataMax) ? dataMax : 100) + 5;
    return [lo, hi];
  };
  return {
    width: w,
    height: h,
    cursor: {
      drag: { x: !locked, y: false, setScale: true },
      focus: { prox: 20 },
    },
    legend: { show: true, live: true },
    scales: { x: { time: true }, y: { range: yRange } },
    // ★ M: ユーザーのドラッグズームを検出（自前の setScale 中は _progScale で除外）。
    //   ユーザー操作時はスライド追従を止め、その拡大範囲を保持する。
    hooks: {
      setScale: [
        (u, key) => {
          if (key === "x" && hs && !hs._progScale) hs.userZoomed = true;
        },
      ],
    },
    series: [
      {},
      ...SERIES_DEFS.map(s => ({
        label: s.label, stroke: s.stroke, width: s.width,
        dash: s.dash, points: { show: false },
        value: (_u, v) => (v == null ? "--" : v.toFixed(1) + "℃"),
      })),
    ],
    axes: [
      {
        stroke: axisStroke, grid: { stroke: gridStroke }, ticks: { stroke: tickStroke },
        // ★ M: 縦補助線の刻み候補。15分表示では概ね1分、短い絞り込み時は秒単位まで uPlot が選ぶ。
        //   秒を含めることで「1分表示で秒まで読める」要望に対応（uPlot は刻みが秒なら自動で秒表示）。
        incrs: [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900],
      },
      {
        stroke: axisStroke, grid: { stroke: gridStroke }, ticks: { stroke: tickStroke },
        size: 50, values: (_u, vals) => vals.map(v => v + "℃"),
      },
    ],
  };
}

// ==============================
// 初期化・リセット
// ==============================

/**
 * グラフの初期化処理。
 * パネル本体内の .temp-graph-area を探し、uPlot インスタンスを per-host で作成する。
 *
 * @param {HTMLElement} [panelBody] - パネル本体要素（省略時は document から検索）
 * @param {string} hostname        - ホスト名
 * @param {object} [userConfig={}] - オプション指定
 */
export function initTemperatureGraph(panelBody, hostname, userConfig = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...userConfig };

  if (!window.uPlot) {
    console.warn("initTemperatureGraph: uPlot が未ロードです（HTML で読み込んでください）");
    return;
  }

  /* uPlot のマウント先コンテナを検索（.temp-graph-area） */
  const findContainer = (root) => {
    if (!root) return null;
    return root.querySelector(".temp-graph-area")
        || root.querySelector("#temp-graph-canvas")?.parentElement
        || null;
  };
  const container = panelBody
    ? findContainer(panelBody)
    : (document.querySelector(".temp-graph-area") || document.getElementById("temp-graph-canvas")?.parentElement);

  if (!container) {
    console.debug("initTemperatureGraph: コンテナ未検出（パネルシステムでは正常）");
    return;
  }
  if (!hostname) {
    console.warn("initTemperatureGraph: hostname が未指定のため初期化をスキップ");
    return;
  }

  const host = hostname;
  const hs = _getHostState(host);
  hs.config = cfg;

  /* 既存インスタンス・リサイズ監視を破棄 */
  if (hs.u) { try { hs.u.destroy(); } catch { /* noop */ } hs.u = null; }
  if (hs.ro) { try { hs.ro.disconnect(); } catch { /* noop */ } hs.ro = null; }

  /* 旧 canvas 等を除去して uPlot を載せる */
  container.innerHTML = "";
  hs.container = container;
  hs.zoomLocked = true;

  const w = Math.max(container.clientWidth || 0, 120);
  // ★ M/N: 凡例ぶんの高さは固定値で確保する。
  //   旧実装は ResizeObserver 内で legend.offsetHeight を読み（強制同期レイアウト）→setSize
  //   していたため、リサイズ時にレイアウトスラッシングのループに陥り CPU が暴走していた。
  //   固定 reserve なら測定不要＝ループしない（凡例の折返しは CSS の max-height+スクロールで吸収）。
  const LEGEND_RESERVE_PX = 40;
  const h = Math.max((container.clientHeight || 0) - LEGEND_RESERVE_PX, 100);
  hs.u = new window.uPlot(_buildOpts(cfg, w, h, hs.zoomLocked, hs), hs.data, container);
  hs.userZoomed = false;
  hs.viewMs = cfg.timeWindowMs;

  /* コンテナのサイズ変化に追従（凡例ぶんを固定差し引き。offsetHeight 測定はしない）。 */
  hs.ro = new ResizeObserver(() => {
    if (!hs.u) return;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (cw <= 0 || ch <= 0) return;
    const plotH = Math.max(80, ch - LEGEND_RESERVE_PX);
    // 同寸法での無駄な再設定を避ける（setSize ループ防止）
    if (hs._lastW !== cw || hs._lastH !== plotH) {
      hs._lastW = cw; hs._lastH = plotH;
      hs.u.setSize({ width: cw, height: plotH });
    }
  });
  hs.ro.observe(container);

  hs.isFirstRender = true;
}

/**
 * 温度グラフのドラッグズームのロックを切り替える。
 * ロック中はドラッグによる範囲ズームを無効化する（ページスクロール阻害防止）。
 *
 * @param {string} hostname - 対象ホスト名
 * @param {boolean} [locked] - true=ロック、false=アンロック。省略時はトグル
 * @returns {boolean} 切り替え後のロック状態
 */
export function toggleChartInteractionLock(hostname, locked) {
  const hs = _hostCharts.get(hostname);
  if (!hs?.u) return true;

  const wasLocked = hs.zoomLocked;
  const newLocked = locked !== undefined ? locked : !wasLocked;
  hs.zoomLocked = newLocked;

  /* uPlot の cursor.drag.x を切り替える（次のドラッグ操作から反映） */
  if (hs.u.cursor && hs.u.cursor.drag) {
    hs.u.cursor.drag.x = !newLocked;
  }
  return newLocked;
}

/**
 * グラフをクリアし、全データと状態をリセットする。
 *
 * @param {string} hostname - 対象ホスト名（省略時は全ホスト）
 */
export function resetTemperatureGraph(hostname) {
  const clearOne = (hs) => {
    for (let i = 0; i < hs.data.length; i++) hs.data[i] = [];
    if (hs.u) {
      hs.u.setData(hs.data);
      hs.u.setScale?.("x", { min: null, max: null });
    }
    hs.isFirstRender = true;
  };

  if (hostname) {
    const hs = _hostCharts.get(hostname);
    if (hs) clearOne(hs);
  } else {
    for (const [, hs] of _hostCharts) clearOne(hs);
  }
}

/**
 * 指定ホストのチャート状態を確保する（per-host 方式の遅延初期化）。
 *
 * @param {string} hostname - ホスト名
 */
export function switchChartHost(hostname) {
  if (hostname) _getHostState(hostname);
}

/**
 * グラフの保持時間枠（=メモリ保持＆表示範囲）を分単位で設定する。
 *
 * 【詳細説明】
 * - 既定 15 分。この枠を超えた古い点は {@link _trimWindow} で破棄されるため、
 *   メモリは「枠 × 更新レート」で上限が決まり、起動時間に比例して無制限に増えない。
 * - 既存の全 per-host チャートと、以後生成されるチャートの両方へ即時反映する。
 * - 範囲外は安全側にクランプ（1〜720分、不正値は15分）。
 *
 * @function setChartWindowMinutes
 * @param {number} minutes - 保持/表示する分数
 * @returns {number} 実際に適用された分数
 */
export function setChartWindowMinutes(minutes) {
  const m = Number(minutes);
  const clamped = (Number.isFinite(m) && m >= 1) ? Math.min(Math.round(m), 720) : 15;
  DEFAULT_CONFIG.timeWindowMs = clamped * 60 * 1000;
  for (const [, hs] of _hostCharts) {
    hs.config.timeWindowMs = DEFAULT_CONFIG.timeWindowMs;
    // 表示ウィンドウが保持枠を超えないようクランプ（超えるとデータ無しの空白になる）
    if (hs.viewMs > DEFAULT_CONFIG.timeWindowMs) hs.viewMs = DEFAULT_CONFIG.timeWindowMs;
  }
  return clamped;
}

/**
 * 温度グラフの「絞り込み（ドラッグズーム）を解除」して、最新からの表示ウィンドウへ戻す。
 *
 * ★ M: 旧実装はデータ破棄ではないが setScale(null,null)=全データ自動範囲だった。
 * ここではユーザーズームを解除し、現在の viewMs（既定15分）ぶんの最新スライド表示へ戻す
 * （データは保持したまま「絞り込みからもどす」）。ドラッグズーム後の復帰手段。
 *
 * @param {string} hostname - 対象ホスト名（省略時は全ホスト）
 */
export function resetTemperatureGraphView(hostname) {
  const resetOne = (hs) => {
    if (!hs?.u) return;
    hs.userZoomed = false;
    _applySlidingWindow(hs);
  };
  if (hostname) {
    resetOne(_hostCharts.get(hostname));
  } else {
    for (const [, hs] of _hostCharts) resetOne(hs);
  }
}

/**
 * 指定ホストの温度グラフの表示ウィンドウ（最新から何分を見せるか）を設定する。
 *
 * ★ M: 15/10/5/3/1分の絞り込みドロップダウン用。選択するとユーザーズームを解除し、
 * 最新から指定分ぶんのスライド表示へ戻す（ドラッグズーム中でも選び直せば復帰できる）。
 * 保持枠（{@link setChartWindowMinutes}）と独立。viewMs は保持枠を超えない値にクランプ。
 *
 * @function setChartViewMinutes
 * @param {string} hostname - 対象ホスト名
 * @param {number} minutes - 表示する分数（最新から）
 * @returns {number} 適用された分数
 */
export function setChartViewMinutes(hostname, minutes) {
  const hs = _hostCharts.get(hostname);
  const m = Number(minutes);
  const clamped = (Number.isFinite(m) && m >= 1) ? Math.round(m) : 15;
  if (!hs) return clamped;
  // 保持枠を超える表示は無意味（データが無い）ため保持枠でクランプ
  const maxMin = Math.round((hs.config.timeWindowMs || DEFAULT_CONFIG.timeWindowMs) / 60000);
  const eff = Math.min(clamped, maxMin);
  hs.viewMs = eff * 60 * 1000;
  hs.userZoomed = false;
  _applySlidingWindow(hs);
  return eff;
}

// ==============================
// グラフ更新処理
// ==============================

/**
 * 表示時間枠を外れた古い先頭データを全系列から除去する。
 * @private
 * @param {HostChartState} hs
 * @param {number} nowSec 現在時刻(秒)
 */
function _trimWindow(hs, nowSec) {
  const xs = hs.data[0];
  const cutoff = nowSec - hs.config.timeWindowMs / 1000;
  let drop = 0;
  while (drop < xs.length && xs[drop] < cutoff) drop++;
  if (drop > 0) {
    for (let i = 0; i < hs.data.length; i++) hs.data[i].splice(0, drop);
  }
}

/**
 * 最新から viewMs ぶんへ x 軸表示範囲をスライドさせる（ユーザーズーム中は何もしない）。
 * @private
 * @param {HostChartState} hs
 */
function _applySlidingWindow(hs) {
  if (!hs.u || hs.userZoomed) return;
  const xs = hs.data[0];
  if (!xs.length) return;
  const maxX = xs[xs.length - 1];
  const minX = maxX - hs.viewMs / 1000;
  hs._progScale = true;
  try { hs.u.setScale("x", { min: minX, max: maxX }); }
  finally { hs._progScale = false; }
}

/**
 * uPlot の再描画を throttle して呼び出す。
 * @private
 * @param {HostChartState} hs
 */
function _scheduleUpdate(hs) {
  if (!hs.u) return;
  const now = Date.now();
  if (now - hs.lastUpdate >= hs.config.throttleIntervalMs) {
    hs.u.setData(hs.data);
    _applySlidingWindow(hs);
    hs.lastUpdate = now;
    hs.isFirstRender = false;
  } else if (!hs.updateQueued) {
    hs.updateQueued = true;
    setTimeout(() => {
      if (hs.u) { hs.u.setData(hs.data); _applySlidingWindow(hs); }
      hs.lastUpdate = Date.now();
      hs.updateQueued = false;
    }, hs.config.throttleIntervalMs - (now - hs.lastUpdate));
  }
}

/**
 * storedData から最新温度を抽出し、時系列グラフに反映する。
 * uPlot 未生成（パネル未展開）でもデータは蓄積し、生成時に履歴が乗る。
 *
 * @param {Record<string, {rawValue: number|string}>} dataStore - storedData
 * @param {string} hostname - ホスト名
 */
export function updateTemperatureGraphFromStoredData(dataStore, hostname) {
  if (!hostname) return;
  const host = hostname;
  const hs = _getHostState(host);

  const nowSec = Date.now() / 1000;
  const getVal = (key) => parseFloat(dataStore[key]?.rawValue ?? 0) || 0;

  /* 1) 各系列へ追加（x は秒・全系列同一サンプル時刻で整列） */
  hs.data[0].push(nowSec);
  for (let i = 0; i < FIELD_KEYS.length; i++) {
    hs.data[i + 1].push(getVal(FIELD_KEYS[i]));
  }

  /* 2) 表示枠外の古い点を除去 */
  _trimWindow(hs, nowSec);

  /* 3) throttle 描画更新（uPlot がある場合のみ） */
  _scheduleUpdate(hs);
}
