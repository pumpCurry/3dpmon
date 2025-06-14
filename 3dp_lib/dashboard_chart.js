/**
 * @fileoverview
 * dashboard_chart.js (ver.1.324)
 *
 * Chart.js を用いた温度グラフ描画モジュール。
 * - グラフ描画を初期化し、storedData からの温度データを時間軸上に描画
 * - 外部指定設定（timeWindow, decimation, throttle）に対応
 * - Zoom プラグイン前提でスケーリング/パン操作可
 * - スロットリングされた再描画、データ再初期化処理を含む
 *
 * ※ Chart.js および Zoom プラグインは HTML 側で明示的に読み込む必要があります。
 *   <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
 *   <script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom"></script>
 */

"use strict";

// ==============================
// 設定定数
// ==============================

/**
 * デフォルト構成パラメータ
 * - timeWindowMs: 表示範囲の時間幅（ms）
 * - decimationSamples: LTTBアルゴリズムで間引く最大点数
 * - throttleIntervalMs: Chart更新の最小間隔（ms）
 */
const DEFAULT_CONFIG = {
  timeWindowMs:       15 * 60 * 1000,
  decimationSamples:  180,
  throttleIntervalMs: 500,
};

// ==============================
// 内部状態管理
// ==============================

let tempChart = null;
let config = { ...DEFAULT_CONFIG };
let lastUpdate = 0;
let updateQueued = false;
let isFirstRender = true;

/** 取得対象キー群（サーバーから渡される storedData のキーに合わせる） */
const DATASET_KEYS = ["nozzleCurrent", "nozzleTarget", "bedCurrent", "bedTarget", "boxCurrent"];
const FIELD_KEYS   = ["nozzleTemp", "targetNozzleTemp", "bedTemp0", "targetBedTemp0", "boxTemp"];

/** 一時キューと本体格納用データ */
const pointQueue = {};
const tempData   = {};
// DATASET_KEYS の数だけ初期化
DATASET_KEYS.forEach(key => {
  pointQueue[key] = [];
  tempData[key]   = [];
});

// ==============================
// 初期化・リセット
// ==============================

/**
 * グラフの初期化処理
 * Chart.js による描画設定を行い、Canvasが存在しない場合は処理しない。
 *
 * @param {object} userConfig - オプション指定 { timeWindowMs, decimationSamples, throttleIntervalMs }
 */
export function initTemperatureGraph(userConfig = {}) {
  config = { ...DEFAULT_CONFIG, ...userConfig };

  const canvas = document.getElementById("temp-graph-canvas");
  if (!canvas) {
    console.warn("initTemperatureGraph: canvas 要素が見つかりません");
    return;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    console.warn("initTemperatureGraph: 2D コンテキスト取得に失敗");
    return;
  }

  tempChart = new Chart(ctx, {
    type: "line",
    data: {
      datasets: [
        { label: "ノズル温度 (現在)", data: tempData.nozzleCurrent, fill: false, borderWidth: 2 },
        { label: "ノズル温度 (目標)", data: tempData.nozzleTarget,  fill: false, borderWidth: 2 },
        { label: "ベッド温度 (現在)", data: tempData.bedCurrent,    fill: false, borderWidth: 2 },
        { label: "ベッド温度 (目標)", data: tempData.bedTarget,     fill: false, borderWidth: 2 },
        { label: "箱内温度 (現在)",   data: tempData.boxCurrent,     fill: false, borderWidth: 2 }
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
        samples: config.decimationSamples
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
 * Chart.js Zoom プラグインが使用されている場合はズーム範囲もリセットします。
 */
export function resetTemperatureGraph() {
  DATASET_KEYS.forEach(key => {
    tempData[key].length = 0;
    pointQueue[key].length = 0;
  });

  if (tempChart) {
    tempChart.data.datasets.forEach(ds => (ds.data = []));
    tempChart.resetZoom?.();  // Zoom プラグインを使っている場合はズームをリセット
    tempChart.update();
  }

  isFirstRender = true;
}

// ==============================
// グラフ更新処理
// ==============================

/**
 * 古いデータ点を削除して表示対象時間枠を制限する
 * @param {Array<{t:number,y:number}>} arr
 * @param {number} now - 現在時刻(ms)
 * @returns {Array} - フィルタ済み配列
 */
function filterOldData(arr, now) {
  return arr.filter(pt => pt.t >= now - config.timeWindowMs);
}

/**
 * Chart.js の update 呼び出し回数を間引きます。
 * @returns {void}
 */
function scheduleChartUpdate() {
  const now = Date.now();

  if (now - lastUpdate >= config.throttleIntervalMs) {
    tempChart.update(isFirstRender ? undefined : "none");
    lastUpdate = now;
    isFirstRender = false;
  } else if (!updateQueued) {
    updateQueued = true;
    setTimeout(() => {
      tempChart.update("none");
      lastUpdate = Date.now();
      updateQueued = false;
    }, config.throttleIntervalMs - (now - lastUpdate));
  }
}

/**
 * storedData オブジェクトから最新温度データを抽出し、
 * 時系列グラフに反映する（キュー → 本体転送 → Chart.js 更新）。
 *
 * @param {Record<string, {rawValue: number|string, computedValue?: any, isNew?: boolean}>} dataStore
 *   温度データを含む storedData（各フィールドに rawValue を持つオブジェクト）のマップ
 * @returns {void}
 */
export function updateTemperatureGraphFromStoredData(dataStore) {
  if (!tempChart) return;
  const now = Date.now();

  // データ取得関数：NaN や null を 0 扱いにする
  const getVal = key => parseFloat(dataStore[key]?.rawValue ?? 0) || 0;

  // 1) 現在時刻付きのデータ点をキューに追加
  pointQueue.nozzleCurrent.push({ t: now, y: getVal("nozzleTemp") });
  pointQueue.nozzleTarget.push({ t: now, y: getVal("targetNozzleTemp") });
  pointQueue.bedCurrent.push({ t: now, y: getVal("bedTemp0") });
  pointQueue.bedTarget.push({ t: now, y: getVal("targetBedTemp0") });
  pointQueue.boxCurrent.push({ t: now, y: getVal("boxTemp") });

  // 2) キューから本体に移し、過去の点を除去
  DATASET_KEYS.forEach((key, idx) => {
    tempData[key].push(...pointQueue[key]);
    tempData[key] = filterOldData(tempData[key], now);
    tempChart.data.datasets[idx].data = tempData[key];
    pointQueue[key].length = 0;
  });

  // 3) Chartの再描画（スロットル付き）
  scheduleChartUpdate();
}
