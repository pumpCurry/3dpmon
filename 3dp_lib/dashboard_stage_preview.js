/**
 * dashboard_stage_preview.js (ver.1.129 / 1.3β)
 * XYプレビューやZプレビューを担当する処理
 *
 * - 1.125のコードを継承し、特に大幅な変更はなし
 * - XY履歴を localStorage に保存し、再読み込み時に復元
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

/**
 * XYプレビューをlocalStorageから復元
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
 * XYプレビュー状態をlocalStorageへ保存
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
 * XYプレビューの初期化(背景格子, ラベル, ドット生成)
 */
function initXYPreview() {
  const container = document.getElementById("xy-stage");
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
    stageRotZ = (stageRotZ + dx * 0.5 + 360) % 360;
    stageRotX = (stageRotX - dy * 0.5 + 360) % 360;
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

  xyInitialized = true;
  xyUpdateCount = 0;
}

/**
 * XYプレビューを更新する(即時呼び出し)
 * @param {number} x
 * @param {number} y
 */
function updateXYPreview(x, y) {
  if (!xyInitialized) {
    initXYPreview();
  }
  // スケール定義
  const STAGE_SIZE_MM = 300;
  const SCALE = 0.5;

  const stagePx = STAGE_SIZE_MM * SCALE;
  const screenX = stagePx - (x * SCALE);
  const screenY = y * SCALE;

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
 * Zプレビュー更新(即時呼び出し)
 * @param {number} z
 */
function updateZPreview(z) {
  const scale = 0.5;
  const clampedZ = Math.min(z, 350);
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
}

function applyStageTransform() {
  const container = document.getElementById("xy-stage");
  if (container) {
    stageRotX = (stageRotX + 360) % 360;
    stageRotZ = (stageRotZ + 360) % 360;
    container.style.transform = `rotateX(${stageRotX}deg) rotateZ(${stageRotZ}deg)`;
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

// --- 新しい固定アングル ---
function setFlatView() {
  stageRotX = 0;
  stageRotZ = 0;
  applyStageTransform();
}

function setTilt45View() {
  stageRotX = 45;
  stageRotZ = 0;
  applyStageTransform();
}

function setObliqueView() {
  stageRotX = 65;
  stageRotZ = 72.5;
  applyStageTransform();
}

let spinTimer = null;
function toggleZSpin() {
  if (spinTimer) {
    clearInterval(spinTimer);
    spinTimer = null;
  } else {
    spinTimer = setInterval(() => {
      stageRotZ = (stageRotZ + 2) % 360;
      applyStageTransform();
    }, 100);
  }
}

export {
  restoreXYPreviewState,
  saveXYPreviewState,
  initXYPreview,
  updateXYPreview,
  updateZPreview,
  applyStageTransform,
  setTopView,
  setCameraView,
  setFlatView,
  setTilt45View,
  setObliqueView,
  toggleZSpin
};
