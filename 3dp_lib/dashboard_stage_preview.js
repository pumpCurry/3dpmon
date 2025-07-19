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
 *
 * 【公開関数一覧】
 * - {@link restoreXYPreviewState} など複数を一括エクスポート
 *
* @version 1.390.748 (PR #345)
* @since   1.390.214 (PR #95)
* @lastModified 2025-07-19 19:51:00
 * -----------------------------------------------------------
 * @todo
 * - none
*/

const maxDots = 128;
const xyDots = [];
let xyUpdateCount = 0;
let xyInitialized = false;

// XYプレビュー履歴用
let xyHistory = [];       // { x, y }の履歴を保持
let xyHistoryIndex = 0;   // xyDotsに割り当てるインデックス
let lastXYPosition = { x: 0, y: 0 };

// 回転状態
let stageRotX = 0;
let stageRotZ = 0;
const STAGE_ROT_X_MIN = 0;
const STAGE_ROT_X_MAX = 70;

// XYプレビューのスケール関連定数
// ステージサイズ(mm)・Z最大値(mm)はモデル毎に可変
let stageSizeMm = 300;   // X/Y 最大長さ
let stageZMaxMm = 300;   // Z 最大値
const STAGE_SCALE = 0.5; // 画面上の倍率

let currentModel = null;       // 設定済みモデル名
let lastZPosition = 0;         // 最後に描画したZ値

/**
 * プリンタモデルに応じてステージサイズとZ軸上限を設定し、
 * 既存プレビューを再描画する。
 *
 * @param {string} model - プリンタモデル名
 * @returns {void}
 */
function setPrinterModel(model) {
  if (currentModel === model) return;
  currentModel = model;
  if (model === "K1 Max") {
    stageSizeMm = 300;
    stageZMaxMm = 300;
  } else if (["K1C", "K1A", "K1", "K1 SE"].includes(model)) {
    stageSizeMm = 220;
    stageZMaxMm = 250;
  } else {
    return; // 未対応モデルは変更なし
  }
  const stageElem = document.getElementById("xy-stage");
  if (!stageElem) return; // テスト環境などでDOMが無い場合
  const px = stageSizeMm * STAGE_SCALE;
  stageElem.style.width = `${px}px`;
  stageElem.style.height = `${px}px`;
  stageElem.innerHTML = "";
  xyDots.length = 0;
  xyInitialized = false;
  const labelBottom = document.querySelector("#z-preview-container .z-label-bottom");
  if (labelBottom) labelBottom.textContent = String(stageZMaxMm);
  updateXYPreview(lastXYPosition.x, lastXYPosition.y);
  updateZPreview(lastZPosition);
}

/**
 * localStorage から保存済みの XY プレビュー情報を読み込み、
 * 各種履歴データを復元する。
 *
 * @returns {void}
 */
function restoreXYPreviewState() {
  try {
    const saved = localStorage.getItem("xyPreviewState");
    if (saved) {
      const obj = JSON.parse(saved);
      xyHistory = obj.xyHistory || [];
      xyHistoryIndex = obj.xyHistoryIndex || 0;
      lastXYPosition = obj.lastXYPosition || { x: 0, y: 0 };
    }
  } catch (e) {
    console.warn("XYプレビュー復元エラー:", e);
  }
}

/**
 * 現在の XY プレビュー履歴情報を localStorage へ保存する。
 *
 * @returns {void}
 */
function saveXYPreviewState() {
  const obj = {
    xyHistory,
    xyHistoryIndex,
    lastXYPosition
  };
  try {
    localStorage.setItem("xyPreviewState", JSON.stringify(obj));
  } catch (e) {
    console.warn("XYプレビュー保存エラー:", e);
  }
}

/**
 * 保存済みの XY 履歴を画面上のドットへ展開し、
 * 表示状態を復元する。
 *
 * @returns {void}
 */
function restoreXYHistoryDots() {
  const stagePx = stageSizeMm * STAGE_SCALE;
  xyDots.forEach(dot => {
    dot.style.display = "none";
  });
  xyHistory.forEach((pos, idx) => {
    if (idx >= xyDots.length) return;
    if (!pos || typeof pos.x !== "number" || typeof pos.y !== "number") {
      return;
    }
    const screenX = stagePx - (pos.x * STAGE_SCALE);
    const screenY = pos.y * STAGE_SCALE;
    const dot = xyDots[idx];
    dot.style.right = (screenX - 1.5) + "px";
    dot.style.bottom = (screenY - 1.5) + "px";
    dot.style.display = "block";
  });
  xyUpdateCount = xyHistoryIndex + 1;
}

/**
 * XY ステージの背景格子やラベル、履歴表示用ドットなど
 * 初期描画を行う。
 *
 * @returns {void}
 */
function initXYPreview() {
  const container = document.getElementById("xy-stage");
  if (!container) return; // DOM が存在しなければ何もしない
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
  
  // 下のつまみ（左右それぞれ）
  const leftTab = document.createElement("div");
  leftTab.className = "stage-tab left";
  container.appendChild(leftTab);
  const rightTab = document.createElement("div");
  rightTab.className = "stage-tab right";
  container.appendChild(rightTab);

  // XYZ軸の棒
  const axisX = document.createElement("div");
  axisX.className = "axis x-axis";
  container.appendChild(axisX);
  const axisY = document.createElement("div");
  axisY.className = "axis y-axis";
  container.appendChild(axisY);
  const axisZ = document.createElement("div");
  axisZ.className = "axis z-axis";
  container.appendChild(axisZ);
  const axisZCross = document.createElement("div");
  axisZCross.className = "axis z-axis-cross";
  container.appendChild(axisZCross);
  
  for (let i = 1; i <= gridCount; i++) {
    // 横線
    const hLine = document.createElement("div");
    hLine.style.position = "absolute";
    hLine.style.left = "0";
    hLine.style.width = "100%";
    hLine.style.height = (i === Math.ceil(gridCount / 2)) ? "2px" : "1px";
    hLine.style.backgroundColor = (i === Math.ceil(gridCount / 2)) ? "#999" : "#777";
    hLine.style.top = (i * height / (gridCount + 1)) + "px";
    container.appendChild(hLine);

    // 縦線
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
  for (let i = 0; i < maxDots; i++) {
    const dot = document.createElement("div");
    dot.style.position = "absolute";
    dot.style.width = "3px";
    dot.style.height = "3px";
    dot.style.background = "gray";
    dot.style.borderRadius = "50%";
    dot.style.display = "none";
    container.appendChild(dot);
    xyDots.push(dot);
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
    // マウス移動量に応じてZ軸回転値を更新（右ドラッグで右回転）
    stageRotZ -= dx * 0.5;
    const newX = stageRotX - dy * 0.5;
    stageRotX = Math.min(Math.max(newX, STAGE_ROT_X_MIN), STAGE_ROT_X_MAX);
    lastX = e.clientX;
    lastY = e.clientY;
    applyStageTransform();
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

  applyStageTransform();
  restoreXYHistoryDots();

  xyInitialized = true;
}

/**
 * 渡された X,Y 座標を元に XY プレビューの現在位置および
 * 履歴ドットを更新する。
 *
 * @param {number} x - X 座標値(mm)
 * @param {number} y - Y 座標値(mm)
 * @returns {void}
 */
function updateXYPreview(x, y) {
  if (!xyInitialized) {
    initXYPreview();
  }
  // スケール定義
  const stagePx = stageSizeMm * STAGE_SCALE;
  const screenX = stagePx - (x * STAGE_SCALE);
  const screenY = y * STAGE_SCALE;

  const currentDot = document.getElementById("xy-current-dot");
  const currentCircle = document.getElementById("xy-current-circle");

  currentDot.style.right = (screenX - 2.5) + "px";
  currentDot.style.bottom = (screenY - 2.5) + "px";
  currentCircle.style.right = (screenX - 5) + "px";
  currentCircle.style.bottom = (screenY - 5) + "px";

  // 履歴用ドット
  const index = xyUpdateCount % maxDots;
  const dot = xyDots[index];
  dot.style.right = (screenX - 1.5) + "px";
  dot.style.bottom = (screenY - 1.5) + "px";
  dot.style.display = "block";

  xyUpdateCount++;

  xyHistoryIndex = index;
  xyHistory[index] = { x, y };
  lastXYPosition = { x, y };
  saveXYPreviewState();
}

/**
 * Z 軸の進捗バーおよび数値表示を更新する。
 *
 * @param {number} z - Z 座標値(mm)
 * @returns {void}
 */
function updateZPreview(z) {
  const scale = 0.5;
  const clampedZ = Math.min(z, stageZMaxMm);
  const barHeight = clampedZ * scale;
  const barDiv = document.getElementById("z-preview");
  if (barDiv) {
    barDiv.style.height = barHeight + "px";
    barDiv.style.backgroundColor = (z < 0) ? "magenta" : "";
  }
  const zValueElem = document.getElementById("z-value");
  if (zValueElem) {
    zValueElem.textContent = z.toFixed(2);
  }
  lastZPosition = z;
}

/**
 * 現在保持している回転値を DOM に反映させ、
 * ステージの傾きと回転を更新する。
 *
 * @returns {void}
 */
function applyStageTransform() {
  const container = document.getElementById("xy-stage");
  if (container) {
    stageRotX = Math.min(Math.max(stageRotX, STAGE_ROT_X_MIN), STAGE_ROT_X_MAX);
    const rotZ = ((stageRotZ % 360) + 360) % 360;
    container.style.transform = `rotateX(${stageRotX}deg) rotateZ(${rotZ}deg)`;
  }
}

/**
 * ステージを真上から見た角度にリセットする。
 *
 * @returns {void}
 */
function setTopView() {
  stageRotX = 0;
  stageRotZ = 0;
  applyStageTransform();
}

/**
 * カメラ視点からの角度に設定する。
 *
 * @returns {void}
 */
function setCameraView() {
  stageRotX = 50;
  stageRotZ = 50;
  applyStageTransform();
}

// --- 新しい固定アングル ---
/**
 * ステージを完全な俯瞰状態にし、Z スピンも停止する。
 *
 * @returns {void}
 */
function setFlatView() {
  stopZSpin();
  stageRotX = 0;
  stageRotZ = 0;
  applyStageTransform();
}

/**
 * 45 度の傾きを持つ斜め視点に設定する。
 * Z スピンは停止される。
 *
 * @returns {void}
 */
function setTilt45View() {
  stopZSpin();
  stageRotX = 45;
  stageRotZ = 0;
  applyStageTransform();
}

/**
 * 斜め上から見下ろす視点に設定する。
 * Z スピンは停止される。
 *
 * @returns {void}
 */
function setObliqueView() {
  stopZSpin();
  stageRotX = 65;
  stageRotZ = 72.5;
  applyStageTransform();
}

let spinTimer = null;
/**
 * スピンボタンの状態を切り替える。
 *
 * @param {boolean} active - ボタンをアクティブ表示にするかどうか
 * @returns {void}
 */
function updateSpinButton(active) {
  const btn = document.getElementById("btn-stage-spin");
  if (!btn) return;
  if (active) {
    btn.classList.add("stage-spin-active");
  } else {
    btn.classList.remove("stage-spin-active");
  }
}

/**
 * Z スピンを停止し、タイマーをクリアする。
 *
 * @returns {void}
 */
function stopZSpin() {
  if (spinTimer) {
    clearInterval(spinTimer);
    spinTimer = null;
    updateSpinButton(false);
  }
}
/**
 * Z スピンの開始と停止をトグルする。
 *
 * @returns {void}
 */
function toggleZSpin() {
  if (spinTimer) {
    stopZSpin();
  } else {
    spinTimer = setInterval(() => {
      // 連続回転させるため値を増加させ続ける
      stageRotZ += 2;
      applyStageTransform();
    }, 100);
    updateSpinButton(true);
  }
}

export {
  restoreXYPreviewState,
  saveXYPreviewState,
  initXYPreview,
  updateXYPreview,
  updateZPreview,
  setPrinterModel,
  applyStageTransform,
  setTopView,
  setCameraView,
  setFlatView,
  setTilt45View,
  setObliqueView,
  toggleZSpin,
  stopZSpin
};
