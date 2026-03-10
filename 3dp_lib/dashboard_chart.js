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
 * - マルチプリンタ対応: per-host Chart.js インスタンス管理
 *
 * 【公開関数一覧】
 * - {@link initTemperatureGraph}：グラフ初期化（パネル本体＋ホスト名を受け取る）
 * - {@link resetTemperatureGraph}：グラフデータリセット
 * - {@link resetTemperatureGraphView}：表示範囲リセット
 * - {@link updateTemperatureGraphFromStoredData}：データ更新
 * - {@link switchChartHost}：指定ホストのチャート状態を確保
 *
 * @version 1.390.788 (PR #366)
 * @since   1.390.193 (PR #86)
 * @lastModified 2026-03-11 02:00:00
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
// 内部状態管理（per-host）
// ==============================

/** 取得対象キー群（サーバーから渡される storedData のキーに合わせる） */
const DATASET_KEYS = ["nozzleCurrent", "nozzleTarget", "bedCurrent", "bedTarget", "boxCurrent"];
const FIELD_KEYS   = ["nozzleTemp", "targetNozzleTemp", "bedTemp0", "targetBedTemp0", "boxTemp"];

/**
 * @typedef {Object} HostChartState
 * @property {Chart|null} chart       - Chart.js インスタンス
 * @property {Object}     tempData    - データセット別時系列データ
 * @property {Object}     pointQueue  - キューバッファ
 * @property {number}     lastUpdate  - 最終更新タイムスタンプ
 * @property {boolean}    updateQueued - 更新キュー済みフラグ
 * @property {boolean}    isFirstRender - 初回描画フラグ
 * @property {Object}     config      - 構成パラメータ
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
    const pq = {};
    const td = {};
    DATASET_KEYS.forEach(key => { pq[key] = []; td[key] = []; });
    _hostCharts.set(hostname, {
      chart: null,
      tempData: td,
      pointQueue: pq,
      lastUpdate: 0,
      updateQueued: false,
      isFirstRender: true,
      config: { ...DEFAULT_CONFIG }
    });
  }
  return _hostCharts.get(hostname);
}

// ==============================
// 初期化・リセット
// ==============================

/**
 * グラフの初期化処理。
 * パネル本体内の canvas を検索し、Chart.js インスタンスを per-host で作成する。
 *
 * @param {HTMLElement} [panelBody] - パネル本体要素（省略時は document から検索）
 * @param {string} [hostname]      - ホスト名
 * @param {object} [userConfig={}] - オプション指定
 */
export function initTemperatureGraph(panelBody, hostname, userConfig = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...userConfig };

  /* canvas をパネル内から検索 */
  const canvas = panelBody
    ? panelBody.querySelector("#temp-graph-canvas") || panelBody.querySelector("canvas")
    : document.getElementById("temp-graph-canvas");
  if (!canvas) {
    console.warn("initTemperatureGraph: canvas 要素が見つかりません");
    return;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    console.warn("initTemperatureGraph: 2D コンテキスト取得に失敗");
    return;
  }

  /* ホスト状態を取得し config を設定 */
  const host = hostname || "_default";
  const hs = _getHostState(host);
  hs.config = cfg;

  /* 既存チャートがあれば破棄 */
  if (hs.chart) {
    hs.chart.destroy();
    hs.chart = null;
  }

  hs.chart = new Chart(ctx, {
    type: "line",
    data: {
      datasets: [
        { label: "ノズル温度 (現在)", data: hs.tempData.nozzleCurrent, fill: false, borderWidth: 2 },
        { label: "ノズル温度 (目標)", data: hs.tempData.nozzleTarget,  fill: false, borderWidth: 2 },
        { label: "ベッド温度 (現在)", data: hs.tempData.bedCurrent,    fill: false, borderWidth: 2 },
        { label: "ベッド温度 (目標)", data: hs.tempData.bedTarget,     fill: false, borderWidth: 2 },
        { label: "箱内温度 (現在)",   data: hs.tempData.boxCurrent,     fill: false, borderWidth: 2 }
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
        samples: cfg.decimationSamples
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
 * グラフをクリアし、全データと状態をリセットする。
 *
 * @param {string} [hostname] - 対象ホスト名（省略時は全ホスト）
 */
export function resetTemperatureGraph(hostname) {
  if (hostname) {
    const hs = _getHostState(hostname);
    DATASET_KEYS.forEach(key => {
      hs.tempData[key].length = 0;
      hs.pointQueue[key].length = 0;
    });
    if (hs.chart) {
      hs.chart.data.datasets.forEach(ds => (ds.data = []));
      hs.chart.resetZoom?.();
      hs.chart.update();
    }
    hs.isFirstRender = true;
  } else {
    /* 全ホストをリセット */
    for (const [, hs] of _hostCharts) {
      DATASET_KEYS.forEach(key => {
        hs.tempData[key].length = 0;
        hs.pointQueue[key].length = 0;
      });
      if (hs.chart) {
        hs.chart.data.datasets.forEach(ds => (ds.data = []));
        hs.chart.resetZoom?.();
        hs.chart.update();
      }
      hs.isFirstRender = true;
    }
  }
}

/**
 * 指定ホストのチャート状態を確保する。
 * per-host Chart インスタンス方式では各ホストが独立しているため、
 * 状態オブジェクトの初期化のみを行う。
 *
 * @param {string} hostname - ホスト名
 */
export function switchChartHost(hostname) {
  /* ホスト状態が未作成なら作成だけ行う */
  if (hostname) _getHostState(hostname);
}

/**
 * 温度グラフのズームおよびパン表示のみを初期状態へ戻す。
 *
 * @param {string} [hostname] - 対象ホスト名（省略時は全ホスト）
 */
export function resetTemperatureGraphView(hostname) {
  if (hostname) {
    const hs = _hostCharts.get(hostname);
    hs?.chart?.resetZoom?.();
  } else {
    for (const [, hs] of _hostCharts) {
      hs.chart?.resetZoom?.();
    }
  }
}

// ==============================
// グラフ更新処理
// ==============================

/**
 * 古いデータ点を削除して表示対象時間枠を制限する
 * @param {Array<{t:number,y:number}>} arr
 * @param {number} now - 現在時刻(ms)
 * @param {number} timeWindowMs - 表示範囲(ms)
 * @returns {Array} - フィルタ済み配列
 */
function filterOldData(arr, now, timeWindowMs) {
  return arr.filter(pt => pt.t >= now - timeWindowMs);
}

/**
 * Chart.jsの更新を間引き制御（スロットリング）して呼び出す
 * @private
 * @param {HostChartState} hs - ホスト状態
 */
function scheduleChartUpdate(hs) {
  const now = Date.now();

  if (now - hs.lastUpdate >= hs.config.throttleIntervalMs) {
    hs.chart.update(hs.isFirstRender ? undefined : "none");
    hs.lastUpdate = now;
    hs.isFirstRender = false;
  } else if (!hs.updateQueued) {
    hs.updateQueued = true;
    setTimeout(() => {
      hs.chart.update("none");
      hs.lastUpdate = Date.now();
      hs.updateQueued = false;
    }, hs.config.throttleIntervalMs - (now - hs.lastUpdate));
  }
}

/**
 * storedData オブジェクトから最新温度データを抽出し、
 * 時系列グラフに反映する。
 *
 * @param {Record<string, {rawValue: number|string}>} dataStore - storedData
 * @param {string} [hostname] - ホスト名
 */
export function updateTemperatureGraphFromStoredData(dataStore, hostname) {
  const now = Date.now();
  const host = hostname || "_default";
  const hs = _getHostState(host);

  const getVal = key => parseFloat(dataStore[key]?.rawValue ?? 0) || 0;

  /* 1) データ点をキューに追加 */
  hs.pointQueue.nozzleCurrent.push({ t: now, y: getVal("nozzleTemp") });
  hs.pointQueue.nozzleTarget.push({ t: now, y: getVal("targetNozzleTemp") });
  hs.pointQueue.bedCurrent.push({ t: now, y: getVal("bedTemp0") });
  hs.pointQueue.bedTarget.push({ t: now, y: getVal("targetBedTemp0") });
  hs.pointQueue.boxCurrent.push({ t: now, y: getVal("boxTemp") });

  /* 2) キューから本体に移し、古い点を除去 */
  DATASET_KEYS.forEach(key => {
    hs.tempData[key].push(...hs.pointQueue[key]);
    hs.tempData[key] = filterOldData(hs.tempData[key], now, hs.config.timeWindowMs);
    hs.pointQueue[key].length = 0;
  });

  /* 3) Chart.js がある場合のみ描画更新 */
  if (!hs.chart) return;
  DATASET_KEYS.forEach((key, idx) => {
    hs.chart.data.datasets[idx].data = hs.tempData[key];
  });
  scheduleChartUpdate(hs);
}
