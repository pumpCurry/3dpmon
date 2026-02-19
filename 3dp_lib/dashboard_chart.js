/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 グラフ描画モジュール
 * @file dashboard_chart.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_chart
 *
 * 【機能内容サマリ】
 * - Chart.js を用いた温度グラフ描画
 * - データ点の間引きやスロットリング更新に対応
 * - Zoom プラグインによる拡大・パン操作
 * - マルチペイン対応: キャンバス要素ごとに独立した状態を管理
 *
 * 【公開関数一覧】
 * - {@link initTemperatureGraph}：グラフ初期化
 * - {@link resetTemperatureGraph}：グラフデータリセット
 * - {@link resetTemperatureGraphView}：表示範囲リセット
 * - {@link updateTemperatureGraphFromStoredData}：データ更新
 *
 * @version 1.400.318 (PR #303)
 * @since   1.390.193 (PR #86)
 * @lastModified 2025-07-04 10:30:00
 * -----------------------------------------------------------
 * @todo
 * - none
 *
 * ※ Chart.js および Zoom プラグインは HTML 側で読み込んでください。
 */

"use strict";

// ==============================
// 設定定数
// ==============================

/**
 * デフォルト構成パラメータ
 */
const DEFAULT_CONFIG = {
  timeWindowMs:       15 * 60 * 1000,
  decimationSamples:  180,
  throttleIntervalMs: 500,
};

/** 取得対象キー群 */
const DATASET_KEYS = ["nozzleCurrent", "nozzleTarget", "bedCurrent", "bedTarget", "boxCurrent"];
const FIELD_KEYS   = ["nozzleTemp", "targetNozzleTemp", "bedTemp0", "targetBedTemp0", "boxTemp"];

// ==============================
// マルチインスタンス状態管理
// ==============================

/**
 * キャンバス要素ごとのグラフ状態を保持するマップ
 * @type {Map<HTMLCanvasElement, ChartState>}
 */
const chartStateMap = new Map();

/**
 * @typedef {Object} ChartState
 * @property {Chart|null}  chart
 * @property {Object}      data        - DATASET_KEYS ごとのデータ配列
 * @property {Object}      pointQueue  - DATASET_KEYS ごとのキュー配列
 * @property {Object}      config      - 設定オブジェクト
 * @property {number}      lastUpdate  - 最終更新時刻 (ms)
 * @property {boolean}     updateQueued
 * @property {boolean}     isFirstRender
 */

/**
 * キャンバス要素に対応する状態を取得（なければ生成）します。
 * @param {HTMLCanvasElement} canvasEl
 * @returns {ChartState}
 */
function getChartState(canvasEl) {
  if (!chartStateMap.has(canvasEl)) {
    const data = {};
    const pointQueue = {};
    DATASET_KEYS.forEach(key => {
      data[key] = [];
      pointQueue[key] = [];
    });
    chartStateMap.set(canvasEl, {
      chart: null,
      data,
      pointQueue,
      config: { ...DEFAULT_CONFIG },
      lastUpdate: 0,
      updateQueued: false,
      isFirstRender: true
    });
  }
  return chartStateMap.get(canvasEl);
}

/**
 * canvasEl が指定されていない場合のフォールバック。
 * 後方互換性のため p1-temp-graph-canvas を探します。
 * @returns {HTMLCanvasElement|null}
 */
function resolveCanvas(canvasEl) {
  if (canvasEl instanceof HTMLCanvasElement) return canvasEl;
  return /** @type {HTMLCanvasElement|null} */ (
    document.getElementById("p1-temp-graph-canvas") ||
    document.getElementById("temp-graph-canvas")
  );
}

// ==============================
// 初期化・リセット
// ==============================

/**
 * グラフの初期化処理
 *
 * @param {object}             [userConfig={}] - オプション指定
 * @param {HTMLCanvasElement}  [canvasEl]      - 対象キャンバス（省略時は後方互換フォールバック）
 */
export function initTemperatureGraph(userConfig = {}, canvasEl) {
  const canvas = resolveCanvas(canvasEl);
  if (!canvas) {
    console.warn("initTemperatureGraph: canvas 要素が見つかりません");
    return;
  }

  const state = getChartState(canvas);
  state.config = { ...DEFAULT_CONFIG, ...userConfig };

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    console.warn("initTemperatureGraph: 2D コンテキスト取得に失敗");
    return;
  }

  // 既存インスタンスがあれば破棄
  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }

  state.chart = new Chart(ctx, {
    type: "line",
    data: {
      datasets: [
        { label: "ノズル温度 (現在)", data: state.data.nozzleCurrent, fill: false, borderWidth: 2 },
        { label: "ノズル温度 (目標)", data: state.data.nozzleTarget,  fill: false, borderWidth: 2 },
        { label: "ベッド温度 (現在)", data: state.data.bedCurrent,    fill: false, borderWidth: 2 },
        { label: "ベッド温度 (目標)", data: state.data.bedTarget,     fill: false, borderWidth: 2 },
        { label: "算内温度 (現在)",   data: state.data.boxCurrent,     fill: false, borderWidth: 2 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      parsing: { xAxisKey: "t", yAxisKey: "y" },
      plugins: {
        zoom: {
          pan: { enabled: true, mode: "x" },
          zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            mode: "x"
          }
        }
      },
      decimation: {
        enabled: true,
        algorithm: "lttb",
        samples: state.config.decimationSamples
      },
      scales: {
        x: {
          type: "time",
          time: {
            tooltipFormat: "HH:mm:ss.SSS",
            unit: "second",
            displayFormats: {
              second: "HH:mm:ss",
              minute: "HH:mm"
            }
          },
          title: { display: true, text: "時間" }
        },
        y: {
          title: { display: true, text: "温度 (℃)" }
        }
      }
    }
  });
}

/**
 * グラフをクリアし、全データと状態をリセットします。
 *
 * @param {HTMLCanvasElement} [canvasEl]
 */
export function resetTemperatureGraph(canvasEl) {
  const canvas = resolveCanvas(canvasEl);
  if (!canvas) return;
  const state = getChartState(canvas);

  DATASET_KEYS.forEach(key => {
    state.data[key].length = 0;
    state.pointQueue[key].length = 0;
  });

  if (state.chart) {
    state.chart.data.datasets.forEach(ds => (ds.data = []));
    state.chart.resetZoom?.();
    state.chart.update();
  }

  state.isFirstRender = true;
}

/**
 * 温度グラフのズームおよびパン表示のみを初期状態へ戺します。
 *
 * @param {HTMLCanvasElement} [canvasEl]
 * @returns {void}
 */
export function resetTemperatureGraphView(canvasEl) {
  const canvas = resolveCanvas(canvasEl);
  if (!canvas) return;
  const state = getChartState(canvas);
  if (state.chart) {
    state.chart.resetZoom?.();
  }
}

// ==============================
// グラフ更新処理
// ==============================

/**
 * 古いデータ点を削除して表示対象時間枚を制限する
 */
function filterOldData(arr, now, timeWindowMs) {
  return arr.filter(pt => pt.t >= now - timeWindowMs);
}

/**
 * Chart.jsの更新を間引き制御（スロットリング）して呼び出す
 */
function scheduleChartUpdate(state) {
  const now = Date.now();

  if (now - state.lastUpdate >= state.config.throttleIntervalMs) {
    state.chart.update(state.isFirstRender ? undefined : "none");
    state.lastUpdate = now;
    state.isFirstRender = false;
  } else if (!state.updateQueued) {
    state.updateQueued = true;
    setTimeout(() => {
      state.chart.update("none");
      state.lastUpdate = Date.now();
      state.updateQueued = false;
    }, state.config.throttleIntervalMs - (now - state.lastUpdate));
  }
}

/**
 * storedData オブジェクトから最新温度データを抽出し、
 * 時系列グラフに反映する。
 *
 * @param {Record<string, {rawValue: number|string, computedValue?: any, isNew?: boolean}>} dataStore
 * @param {HTMLCanvasElement} [canvasEl] - 対象キャンバス（省略時は後方互換フォールバック）
 * @returns {void}
 */
export function updateTemperatureGraphFromStoredData(dataStore, canvasEl) {
  const canvas = resolveCanvas(canvasEl);
  if (!canvas) return;
  const state = getChartState(canvas);
  if (!state.chart) return;

  const now = Date.now();

  // データ取得関数
  const getVal = key => parseFloat(dataStore[key]?.rawValue ?? 0) || 0;

  // 1) 現在時刻付きのデータ点をキューに追加
  state.pointQueue.nozzleCurrent.push({ t: now, y: getVal("nozzleTemp") });
  state.pointQueue.nozzleTarget.push({ t: now, y: getVal("targetNozzleTemp") });
  state.pointQueue.bedCurrent.push({ t: now, y: getVal("bedTemp0") });
  state.pointQueue.bedTarget.push({ t: now, y: getVal("targetBedTemp0") });
  state.pointQueue.boxCurrent.push({ t: now, y: getVal("boxTemp") });

  // 2) キューから本体に移し、過去の点を除去
  DATASET_KEYS.forEach((key, idx) => {
    state.data[key].push(...state.pointQueue[key]);
    state.data[key] = filterOldData(state.data[key], now, state.config.timeWindowMs);
    state.chart.data.datasets[idx].data = state.data[key];
    state.pointQueue[key].length = 0;
  });

  // 3) Chartの再描画（スロットル付き）
  scheduleChartUpdate(state);
}
