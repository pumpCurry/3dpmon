/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 ステージプレビュー モジュール
 * @file dashboard_stage_preview.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_stage_preview
 *
 * 【機能内容サマリ】
 * - XY/Z プレビューの表示と履歴管理
 * - ローカルストレージに履歴保存し再読み込み
 * - マルチプリンタ対応: per-host パネル本体参照 + 状態管理
 *
 * 【公開関数一覧】
 * - {@link restoreXYPreviewState} など複数を一括エクスポート
 *
 * @version 1.390.788 (PR #366)
 * @since   1.390.214 (PR #95)
 * @lastModified 2026-03-11 02:00:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

const maxDots = 128;

// 回転状態（全パネル共有 — 画面に表示できるのは操作中1パネルだけ）
let stageRotX = 0;
let stageRotZ = 0;
const STAGE_ROT_X_MIN = 0;
const STAGE_ROT_X_MAX = 70;
const STAGE_SCALE = 0.5;

// ---------------------------------------------------------------------------
// per-host プレビュー状態
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} PreviewHostState
 * @property {Array}  xyDots           DOM ドット要素配列
 * @property {number} xyUpdateCount    更新カウンタ
 * @property {boolean} xyInitialized   初期化済みフラグ
 * @property {Array}  xyHistory        XY 座標履歴
 * @property {number} xyHistoryIndex   現在の履歴インデックス
 * @property {{x:number,y:number}} lastXYPosition  最終XY座標
 * @property {number} lastZPosition    最終Z座標
 * @property {string|null} currentModel プリンタモデル名
 * @property {number} stageSizeMm      ステージサイズ(mm)
 * @property {number} stageZMaxMm      Z最大値(mm)
 * @property {HTMLElement|null} panelBody パネル本体要素
 */

/** @type {Map<string, PreviewHostState>} */
const _previewHostStates = new Map();

/**
 * per-host 状態を取得（なければ作成）
 * @private
 * @param {string} [hostname]
 * @returns {PreviewHostState}
 */
function _getPreviewState(hostname) {
  const host = hostname || "_default";
  if (!_previewHostStates.has(host)) {
    _previewHostStates.set(host, {
      xyDots: [],
      xyUpdateCount: 0,
      xyInitialized: false,
      xyHistory: [],
      xyHistoryIndex: 0,
      lastXYPosition: { x: 0, y: 0 },
      lastZPosition: 0,
      currentModel: null,
      stageSizeMm: 300,
      stageZMaxMm: 300,
      panelBody: null
    });
  }
  return _previewHostStates.get(host);
}

/**
 * パネル本体要素内で要素を検索する。
 * @private
 * @param {PreviewHostState} state
 * @param {string} id
 * @returns {HTMLElement|null}
 */
function _findInPanel(state, id) {
  if (!state.panelBody) return null;
  return state.panelBody.querySelector(`[id$="__${id}"]`)
      || state.panelBody.querySelector(`#${id}`);
}

/**
 * パネル本体を登録する。
 * @param {HTMLElement} panelBody - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function registerPreviewPanel(panelBody, hostname) {
  const s = _getPreviewState(hostname);
  s.panelBody = panelBody;
}

/**
 * プリンタモデルに応じてステージサイズとZ軸上限を設定し、
 * 既存プレビューを再描画する。
 *
 * @param {string} model - プリンタモデル名
 * @param {string} [hostname] - ホスト名
 */
function setPrinterModel(model, hostname) {
  const s = _getPreviewState(hostname);
  if (s.currentModel === model) return;
  s.currentModel = model;

  if (model === "K1 Max") {
    s.stageSizeMm = 300;
    s.stageZMaxMm = 300;
  } else if (["K1C", "K1A", "K1", "K1 SE"].includes(model)) {
    s.stageSizeMm = 220;
    s.stageZMaxMm = 250;
  } else {
    return;
  }

  const stageElem = _findInPanel(s, "xy-stage");
  if (!stageElem) return;
  const px = s.stageSizeMm * STAGE_SCALE;
  stageElem.style.width = `${px}px`;
  stageElem.style.height = `${px}px`;
  stageElem.innerHTML = "";
  s.xyDots.length = 0;
  s.xyInitialized = false;

  const labelBottom = s.panelBody
    ? s.panelBody.querySelector(".z-label-bottom")
    : null;
  if (labelBottom) labelBottom.textContent = String(s.stageZMaxMm);

  updateXYPreview(s.lastXYPosition.x, s.lastXYPosition.y, hostname);
  updateZPreview(s.lastZPosition, hostname);
}

/**
 * localStorage から保存済みの XY プレビュー情報を読み込み、
 * 各種履歴データを復元する。
 *
 * @param {string} [hostname] - ホスト名
 */
function restoreXYPreviewState(hostname) {
  const s = _getPreviewState(hostname);
  const storageKey = hostname ? `xyPreviewState_${hostname}` : "xyPreviewState";
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      const obj = JSON.parse(saved);
      s.xyHistory = obj.xyHistory || [];
      s.xyHistoryIndex = obj.xyHistoryIndex || 0;
      s.lastXYPosition = obj.lastXYPosition || { x: 0, y: 0 };
    }
  } catch (e) {
    console.warn("XYプレビュー復元エラー:", e);
  }
}

/**
 * 現在の XY プレビュー履歴情報を localStorage へ保存する。
 *
 * @param {string} [hostname] - ホスト名
 */
function saveXYPreviewState(hostname) {
  const s = _getPreviewState(hostname);
  const storageKey = hostname ? `xyPreviewState_${hostname}` : "xyPreviewState";
  const obj = {
    xyHistory: s.xyHistory,
    xyHistoryIndex: s.xyHistoryIndex,
    lastXYPosition: s.lastXYPosition
  };
  try {
    localStorage.setItem(storageKey, JSON.stringify(obj));
  } catch (e) {
    console.warn("XYプレビュー保存エラー:", e);
  }
}

/**
 * 保存済みの XY 履歴を画面上のドットへ展開し、表示状態を復元する。
 * @private
 * @param {PreviewHostState} s
 */
function _restoreXYHistoryDots(s) {
  const stagePx = s.stageSizeMm * STAGE_SCALE;
  s.xyDots.forEach(dot => { dot.style.display = "none"; });
  s.xyHistory.forEach((pos, idx) => {
    if (idx >= s.xyDots.length) return;
    if (!pos || typeof pos.x !== "number" || typeof pos.y !== "number") return;
    const screenX = stagePx - (pos.x * STAGE_SCALE);
    const screenY = pos.y * STAGE_SCALE;
    const dot = s.xyDots[idx];
    dot.style.right = (screenX - 1.5) + "px";
    dot.style.bottom = (screenY - 1.5) + "px";
    dot.style.display = "block";
  });
  s.xyUpdateCount = s.xyHistoryIndex + 1;
}

/**
 * XY ステージの背景格子やラベル、履歴表示用ドットなど初期描画を行う。
 *
 * @param {HTMLElement} [panelBody] - パネル本体要素
 * @param {string} [hostname] - ホスト名
 */
function initXYPreview(panelBody, hostname) {
  const s = _getPreviewState(hostname);
  if (panelBody) s.panelBody = panelBody;

  const container = _findInPanel(s, "xy-stage");
  if (!container) return;
  container.style.userSelect = "none";
  const gridCount = 7;
  const width = container.clientWidth;
  const height = container.clientHeight;

  // 左右の羽
  const leftWing = document.createElement("div");
  leftWing.className = "stage-wing left";
  container.appendChild(leftWing);
  const rightWing = document.createElement("div");
  rightWing.className = "stage-wing right";
  container.appendChild(rightWing);

  // 下のつまみ
  const leftTab = document.createElement("div");
  leftTab.className = "stage-tab left";
  container.appendChild(leftTab);
  const rightTab = document.createElement("div");
  rightTab.className = "stage-tab right";
  container.appendChild(rightTab);

  // XYZ軸の棒
  ["x-axis", "y-axis", "z-axis", "z-axis-cross"].forEach(cls => {
    const el = document.createElement("div");
    el.className = `axis ${cls}`;
    container.appendChild(el);
  });

  for (let i = 1; i <= gridCount; i++) {
    const hLine = document.createElement("div");
    hLine.style.position = "absolute";
    hLine.style.left = "0";
    hLine.style.width = "100%";
    hLine.style.height = (i === Math.ceil(gridCount / 2)) ? "2px" : "1px";
    hLine.style.backgroundColor = (i === Math.ceil(gridCount / 2)) ? "#999" : "#777";
    hLine.style.top = (i * height / (gridCount + 1)) + "px";
    container.appendChild(hLine);

    const vLine = document.createElement("div");
    vLine.style.position = "absolute";
    vLine.style.top = "0";
    vLine.style.height = "100%";
    vLine.style.width = (i === Math.ceil(gridCount / 2)) ? "2px" : "1px";
    vLine.style.backgroundColor = (i === Math.ceil(gridCount / 2)) ? "#999" : "#777";
    vLine.style.left = (i * width / (gridCount + 1)) + "px";
    container.appendChild(vLine);
  }

  // 方向ラベル
  const labelX = document.createElement("div");
  labelX.className = "xy-label x";
  labelX.textContent = "X";
  labelX.style.right = "4px";
  labelX.style.bottom = "4px";
  container.appendChild(labelX);

  const labelY = document.createElement("div");
  labelY.className = "xy-label y";
  labelY.textContent = "Y";
  labelY.style.left = "4px";
  labelY.style.top = "4px";
  container.appendChild(labelY);

  const label0 = document.createElement("div");
  label0.className = "xy-label zero";
  label0.textContent = "0";
  label0.style.left = "4px";
  label0.style.bottom = "4px";
  container.appendChild(label0);

  // 履歴用ドット生成
  s.xyDots.length = 0;
  for (let i = 0; i < maxDots; i++) {
    const dot = document.createElement("div");
    dot.style.position = "absolute";
    dot.style.width = "3px";
    dot.style.height = "3px";
    dot.style.background = "gray";
    dot.style.borderRadius = "50%";
    dot.style.display = "none";
    container.appendChild(dot);
    s.xyDots.push(dot);
  }

  // 現在位置ドット
  const currentDot = document.createElement("div");
  currentDot.id = "xy-current-dot";
  currentDot.style.position = "absolute";
  currentDot.style.width = "5px";
  currentDot.style.height = "5px";
  currentDot.style.background = "red";
  currentDot.style.borderRadius = "50%";
  container.appendChild(currentDot);

  // 現在位置の円
  const currentCircle = document.createElement("div");
  currentCircle.id = "xy-current-circle";
  currentCircle.style.position = "absolute";
  currentCircle.style.width = "10px";
  currentCircle.style.height = "10px";
  currentCircle.style.border = "2px solid red";
  currentCircle.style.borderRadius = "50%";
  container.appendChild(currentCircle);

  // ドラッグ回転
  let dragging = false, lastX = 0, lastY = 0;
  container.style.cursor = "grab";
  const onMouseMove = e => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    stageRotZ -= dx * 0.5;
    const newX = stageRotX - dy * 0.5;
    stageRotX = Math.min(Math.max(newX, STAGE_ROT_X_MIN), STAGE_ROT_X_MAX);
    lastX = e.clientX;
    lastY = e.clientY;
    _applyStageTransform(s);
  };
  container.addEventListener("mousedown", e => {
    e.preventDefault();
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    container.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
  });
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", () => {
    dragging = false;
    container.style.cursor = "grab";
    document.body.style.userSelect = "";
  });

  _applyStageTransform(s);
  _restoreXYHistoryDots(s);
  s.xyInitialized = true;
}

/**
 * 渡された X,Y 座標を元に XY プレビューの現在位置および
 * 履歴ドットを更新する。
 *
 * @param {number} x - X 座標値(mm)
 * @param {number} y - Y 座標値(mm)
 * @param {string} [hostname] - ホスト名
 */
function updateXYPreview(x, y, hostname) {
  const s = _getPreviewState(hostname);
  if (!s.xyInitialized) return;

  const stagePx = s.stageSizeMm * STAGE_SCALE;
  const screenX = stagePx - (x * STAGE_SCALE);
  const screenY = y * STAGE_SCALE;

  const currentDot = _findInPanel(s, "xy-current-dot");
  const currentCircle = _findInPanel(s, "xy-current-circle");
  if (!currentDot || !currentCircle) return;

  currentDot.style.right = (screenX - 2.5) + "px";
  currentDot.style.bottom = (screenY - 2.5) + "px";
  currentCircle.style.right = (screenX - 5) + "px";
  currentCircle.style.bottom = (screenY - 5) + "px";

  const index = s.xyUpdateCount % maxDots;
  const dot = s.xyDots[index];
  if (!dot) return;
  dot.style.right = (screenX - 1.5) + "px";
  dot.style.bottom = (screenY - 1.5) + "px";
  dot.style.display = "block";

  s.xyUpdateCount++;
  s.xyHistoryIndex = index;
  s.xyHistory[index] = { x, y };
  s.lastXYPosition = { x, y };

  saveXYPreviewState(hostname);
}

/**
 * Z 軸の進捗バーおよび数値表示を更新する。
 *
 * @param {number} z - Z 座標値(mm)
 * @param {string} [hostname] - ホスト名
 */
function updateZPreview(z, hostname) {
  const s = _getPreviewState(hostname);
  const scale = 0.5;
  const clampedZ = Math.min(z, s.stageZMaxMm);
  const barHeight = clampedZ * scale;
  const barDiv = _findInPanel(s, "z-preview");
  if (barDiv) {
    barDiv.style.height = barHeight + "px";
    barDiv.style.backgroundColor = (z < 0) ? "magenta" : "";
  }
  const zValueElem = _findInPanel(s, "z-value");
  if (zValueElem) {
    zValueElem.textContent = z.toFixed(2);
  }
  s.lastZPosition = z;
}

/**
 * 回転値を DOM に反映させ、ステージの傾きと回転を更新する。
 * @private
 * @param {PreviewHostState} s
 */
function _applyStageTransform(s) {
  const container = _findInPanel(s, "xy-stage");
  if (container) {
    stageRotX = Math.min(Math.max(stageRotX, STAGE_ROT_X_MIN), STAGE_ROT_X_MAX);
    const rotZ = ((stageRotZ % 360) + 360) % 360;
    container.style.transform = `rotateX(${stageRotX}deg) rotateZ(${rotZ}deg)`;
  }
}

/**
 * 全パネルにステージ回転を適用する。
 */
function applyStageTransform() {
  for (const [, s] of _previewHostStates) {
    _applyStageTransform(s);
  }
}

function setTopView() {
  stageRotX = 0;
  stageRotZ = 0;
  applyStageTransform();
}

function setCameraView() {
  stageRotX = 50;
  stageRotZ = 50;
  applyStageTransform();
}

function setFlatView() {
  stopZSpin();
  stageRotX = 0;
  stageRotZ = 0;
  applyStageTransform();
}

function setTilt45View() {
  stopZSpin();
  stageRotX = 45;
  stageRotZ = 0;
  applyStageTransform();
}

function setObliqueView() {
  stopZSpin();
  stageRotX = 65;
  stageRotZ = 72.5;
  applyStageTransform();
}

let spinTimer = null;

function updateSpinButton(active) {
  /* 全パネルのスピンボタンを更新 */
  for (const [, s] of _previewHostStates) {
    const btn = _findInPanel(s, "btn-stage-spin");
    if (!btn) continue;
    if (active) btn.classList.add("stage-spin-active");
    else        btn.classList.remove("stage-spin-active");
  }
}

function stopZSpin() {
  if (spinTimer) {
    clearInterval(spinTimer);
    spinTimer = null;
    updateSpinButton(false);
  }
}

function toggleZSpin() {
  if (spinTimer) {
    stopZSpin();
  } else {
    spinTimer = setInterval(() => {
      stageRotZ += 2;
      applyStageTransform();
    }, 100);
    updateSpinButton(true);
  }
}

/**
 * ホスト切替（後方互換）。
 * per-host パネル方式では特別な処理不要。
 * @param {string} hostname
 */
function switchPreviewHost(hostname) {
  if (hostname) _getPreviewState(hostname);
}

export {
  restoreXYPreviewState,
  saveXYPreviewState,
  initXYPreview,
  updateXYPreview,
  updateZPreview,
  setPrinterModel,
  registerPreviewPanel,
  applyStageTransform,
  setTopView,
  setCameraView,
  setFlatView,
  setTilt45View,
  setObliqueView,
  toggleZSpin,
  stopZSpin,
  switchPreviewHost
};
