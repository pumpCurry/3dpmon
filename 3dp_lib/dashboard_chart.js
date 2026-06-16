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
function _buildOpts(cfg, w, h, locked) {
  const axisStroke = "#888";
  const gridStroke = "rgba(128,128,128,0.18)";
  const tickStroke = "rgba(128,128,128,0.30)";
  return {
    width: w,
    height: h,
    cursor: {
      drag: { x: !locked, y: false, setScale: true },
      focus: { prox: 20 },
    },
    legend: { show: true, live: true },
    scales: { x: { time: true } },
    series: [
      {},
      ...SERIES_DEFS.map(s => ({
        label: s.label, stroke: s.stroke, width: s.width,
        dash: s.dash, points: { show: false },
        value: (_u, v) => (v == null ? "--" : v.toFixed(1) + "℃"),
      })),
    ],
    axes: [
      { stroke: axisStroke, grid: { stroke: gridStroke }, ticks: { stroke: tickStroke } },
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
  const h = Math.max(container.clientHeight || 0, 120);
  hs.u = new window.uPlot(_buildOpts(cfg, w, h, hs.zoomLocked), hs.data, container);

  /* コンテナのサイズ変化に追従（chart.js の responsive 相当） */
  hs.ro = new ResizeObserver(() => {
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (cw > 0 && ch > 0 && hs.u) hs.u.setSize({ width: cw, height: ch });
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
 * 温度グラフのズーム表示のみを初期状態（自動範囲）へ戻す。
 *
 * @param {string} hostname - 対象ホスト名（省略時は全ホスト）
 */
export function resetTemperatureGraphView(hostname) {
  const resetOne = (hs) => {
    if (!hs?.u) return;
    hs.u.setScale("x", { min: null, max: null });
  };
  if (hostname) {
    resetOne(_hostCharts.get(hostname));
  } else {
    for (const [, hs] of _hostCharts) resetOne(hs);
  }
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
 * uPlot の再描画を throttle して呼び出す。
 * @private
 * @param {HostChartState} hs
 */
function _scheduleUpdate(hs) {
  if (!hs.u) return;
  const now = Date.now();
  if (now - hs.lastUpdate >= hs.config.throttleIntervalMs) {
    hs.u.setData(hs.data);
    hs.lastUpdate = now;
    hs.isFirstRender = false;
  } else if (!hs.updateQueued) {
    hs.updateQueued = true;
    setTimeout(() => {
      if (hs.u) hs.u.setData(hs.data);
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
