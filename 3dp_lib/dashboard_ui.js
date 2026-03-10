/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 UI 更新モジュール
 * @file dashboard_ui.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_ui
 *
 * 【機能内容サマリ】
 * - data-field に基づく DOM 更新
 * - 更新マーク管理と storedData のDOM反映
 * - 主要UIイベントハンドリング
 * - data-field 要素キャッシュによる高速 DOM 検索
 *
 * 【公開関数一覧】
 * - {@link updateDataField}：データフィールド更新
 * - {@link clearNewClasses}：更新マーク除去
 * - {@link updateStoredDataToDOM}：storedData反映
 * - {@link initUIEventHandlers}：UIイベント初期化
 * - {@link registerFieldElements}：data-field 要素をキャッシュに登録
 * - {@link unregisterFieldElements}：data-field 要素をキャッシュから除去
 *
* @version 1.390.784 (PR #366)
* @since   1.390.193 (PR #86)
* @lastModified 2026-03-10 23:30:00
 * -----------------------------------------------------------
 * @todo
 * - none
*/

"use strict";

import { monitorData, currentHostname, PLACEHOLDER_HOSTNAME, scopedById } from "./dashboard_data.js";
import { getDisplayValue, setStoredData, consumeDirtyKeys } from "./dashboard_data.js";
import { dashboardMapping } from "./dashboard_ui_mapping.js";         // フィールド別定義と処理
import { initializeCommandPalette } from "./dashboard_send_command.js";

/* ─── B: data-field 要素キャッシュ ─── */

/**
 * data-field 属性値をキーとし、対応する DOM 要素の Set を保持するキャッシュ。
 * パネル追加時に registerFieldElements() で登録し、
 * パネル削除時に unregisterFieldElements() で除去する。
 * updateStoredDataToDOM / updateDataField で querySelectorAll の代わりに使用。
 *
 * @type {Map<string, Set<Element>>}
 * @private
 */
const _fieldCache = new Map();

/**
 * registerFieldElements:
 * 指定ルート要素配下の全 [data-field] 要素をキャッシュに登録する。
 * パネル生成時（addPanel）に呼び出す。
 *
 * @param {HTMLElement} root - スキャン対象のルート要素
 * @returns {void}
 */
export function registerFieldElements(root) {
  if (!root) return;
  root.querySelectorAll("[data-field]").forEach(el => {
    const key = el.getAttribute("data-field");
    if (!key) return;
    if (!_fieldCache.has(key)) _fieldCache.set(key, new Set());
    _fieldCache.get(key).add(el);
  });
}

/**
 * unregisterFieldElements:
 * 指定ルート要素配下の全 [data-field] 要素をキャッシュから除去する。
 * パネル削除時（removePanel）に呼び出す。
 *
 * @param {HTMLElement} root - スキャン対象のルート要素
 * @returns {void}
 */
export function unregisterFieldElements(root) {
  if (!root) return;
  root.querySelectorAll("[data-field]").forEach(el => {
    const key = el.getAttribute("data-field");
    if (!key) return;
    const set = _fieldCache.get(key);
    if (set) {
      set.delete(el);
      if (set.size === 0) _fieldCache.delete(key);
    }
  });
}

/**
 * キャッシュから data-field 要素を取得する。
 * キャッシュにヒットしない場合は querySelectorAll にフォールバックし、結果をキャッシュする。
 *
 * @private
 * @param {string} fieldName - data-field 属性値
 * @returns {Set<Element>|NodeList} 対応する要素群
 */
function _getFieldElements(fieldName) {
  if (_fieldCache.has(fieldName)) {
    return _fieldCache.get(fieldName);
  }
  /* キャッシュミス: DOMから検索してキャッシュに登録（パネル外の要素にも対応） */
  const nodes = document.querySelectorAll(`[data-field="${fieldName}"]`);
  if (nodes.length > 0) {
    const set = new Set(nodes);
    _fieldCache.set(fieldName, set);
    return set;
  }
  return nodes; /* 空NodeList */
}

/* ─── D: 更新マーク追跡セット ─── */

/**
 * `.new` クラスが付与された要素を追跡するセット。
 * clearNewClasses() でページ全体を querySelectorAll(".new") するかわりに
 * このセットだけを走査する。
 *
 * @type {Set<Element>}
 * @private
 */
const _newElements = new Set();

/**
 * updateDataField:
 * 指定された `fieldName` を持つ DOM 要素群に対し、データを反映し `.new` クラスを付与する。
 * 
 * 対象となる DOM 要素は `[data-field="fieldName"]` セレクタで取得される。
 * 内部に `.value` / `.unit` クラスを持つ場合はそれぞれ分離して反映、
 * 持たない場合は全体にテキストとして文字列を反映する。
 *
 * @param {string} fieldName - 反映対象フィールド名（data-field属性に一致）
 * @param {{value:string, unit:string}|string|null} [data] - 表示値オブジェクト（省略時は getDisplayValue にフォールバック）
 */
export function updateDataField(fieldName, data = undefined) {
  const displayData = data ?? getDisplayValue(fieldName);
  const elements = _getFieldElements(fieldName);

  elements.forEach(el => {
    const valueEl = el.querySelector(".value");
    const unitEl = el.querySelector(".unit");

    if (displayData && typeof displayData === "object" && "value" in displayData) {
      if (valueEl) valueEl.textContent = displayData.value ?? "";
      if (unitEl) unitEl.textContent = displayData.unit ?? "";
    } else {
      const fallbackText = displayData != null ? String(displayData) : "";
      if (valueEl) {
        valueEl.textContent = fallbackText;
      } else {
        el.textContent = fallbackText;
      }
      if (unitEl) unitEl.textContent = "";
    }

    el.classList.remove("old");
    el.classList.add("new");
    _newElements.add(el);
  });
}

/**
 * clearNewClasses:
 * `.new` クラスをすべて `.old` に変更する。
 * aggregator のタイミングで定期的に呼ばれる。
 *
 * @function
 * @returns {void}
 */
export function clearNewClasses() {
  _newElements.forEach(el => {
    el.classList.remove("new");
    el.classList.add("old");
  });
  _newElements.clear();
}

/**
 * updateStoredDataToDOM:
 * 変更キュー（consumeDirtyKeys）から変更のあったキーだけを取得し、
 * 対応する DOM 要素を更新する。要素キャッシュ（_fieldCache）を用いて
 * querySelectorAll の繰り返し実行を回避する。
 *
 * - checkbox要素、.value/.unitを持つ要素、その他のtextContent要素を識別して更新
 * - dashboardMapping に process がある場合は computedValue を再生成
 * - getDisplayValue() により value/unit を取得
 * - 複数DOM要素がある場合にもすべて反映
 */
export function updateStoredDataToDOM() {
  if (!currentHostname || currentHostname === PLACEHOLDER_HOSTNAME) {
    console.warn("updateStoredDataToDOM: currentHostname is not set");
    return;
  }

  const machine = monitorData.machines[currentHostname];
  if (!machine) return;
  const storedData = machine.storedData;

  /* A: 変更キューから変更キーだけを取得（全キー走査を回避） */
  const dirtyKeys = consumeDirtyKeys();

  for (const key of dirtyKeys) {
    const d = storedData[key];
    if (!d?.isNew) continue; // isNew が false ならスキップ

    // ① mapping を取得
    const map = dashboardMapping[key] || {};

    // 横展開が必要な場合の処理（rawValueを特定の要素に代入させる）
    if (Array.isArray(map.domProps)) {
      map.domProps.forEach(({ id, prop }) => {
        try {
          /* パネルシステムではIDが hostname__ プレフィックス付きにスコープされる */
          const el = scopedById(id);
          if (!el) {
            throw new Error(`element not found`);
          }
          if (!(prop in el)) {
            throw new Error(`property "${prop}" does not exist on element`);
          }
          el[prop] = d.rawValue;
        } catch (err) {
          console.warn(
            `[updateStoredDataToDOM] domProps update skipped for id="${id}", prop="${prop}":`,
            err.message
          );
        }
      });
    }

    // --- ① DOMキー決定 & computedValue 再生成 ---
    const elementKey = dashboardMapping[key]?.elementKey || key;
    /* rawValue が null の場合は process を実行しない。
       nozzleDiff / bedDiff 等、aggregator が computedValue のみ直接設定する
       フィールドでは rawValue が常に null であり、process(null) で
       "null" 文字列に上書きされてしまうのを防ぐ。 */
    if (d.rawValue != null && typeof dashboardMapping[key]?.process === "function") {
      try {
        d.computedValue = dashboardMapping[key].process(d.rawValue);
      } catch (e) {
        console.warn(`[updateStoredDataToDOM] process() failed for "${key}"`, e);
        d.computedValue = null;
      }
    }

    // --- ② 表示用データ取得（value/unitの取得） ---
    const { value, unit } = getDisplayValue(key) || {
      value: String(d.rawValue ?? ""),
      unit: ""
    };

    // --- ③ data-field 属性に対応する DOM 要素群の取得（B: キャッシュ使用） ---
    const nodes = _getFieldElements(elementKey);
    if (!nodes || (nodes.size ?? nodes.length) === 0) {
      // デバッグ: data-field 要素が見つからないキーを出力
      if (d.isFromEquipVal) {
        console.debug(`[updateStoredDataToDOM] data-field="${elementKey}" 要素なし (key="${key}", raw=${JSON.stringify(d.rawValue)?.slice(0,50)})`);
      }
      d.isNew = false;
      continue;
    }

    // --- ④ 各要素への反映 ---
    nodes.forEach(el => {
      const tag = el.tagName;
      const type = el.type?.toLowerCase?.();

      // ---- checkbox 更新処理 ----
      if (tag === "INPUT" && type === "checkbox") {
        const raw = d.rawValue;
        const isOn = typeof raw === "boolean"
          ? raw
          : typeof raw === "number"
            ? raw >= 1
            : String(raw).trim().toLowerCase() === "true" || String(raw).trim() === "1";
        el.checked = isOn;
      }
      // ---- range スライダー更新処理 ----
      else if (tag === "INPUT" && (type === "range"||type === "number")) {
        // 既に getDisplayValue() で加工した表示用 value を使う
        const num = parseFloat(value);
        if (!isNaN(num)) {
          el.value = num;
        }
      }
      // ---- textbox 更新処理 ----
      else if (tag === "INPUT" && type === "text") {
        el.value = value;
      }
      // ---- .value / .unit を持つ表示要素への反映 ----
      else if (el.querySelector(".value") || el.querySelector(".unit")) {

        // 変数に格納してからチェック
        const valueEl = el.querySelector(".value");
        if (valueEl) {
          valueEl.textContent = value;
        }
        const unitEl = el.querySelector(".unit");
        if (unitEl) {
          unitEl.textContent = unit;
        }
      }

      // ---- その他 textContent にまとめて出力 ----
      else {
        el.textContent = `${value}${unit}`;
      }

      // ---- D: クラスで更新表示（.new → .old 切替）+ 追跡 ----
      el.classList.remove("old");
      el.classList.add("new");
      _newElements.add(el);
    });

    if (window.filamentPreview) {
      if (key === "filamentRemainingMm") {
        const val = Number(d.rawValue);
        if (!isNaN(val)) window.filamentPreview.setRemainingLength(val);
      }
      if (key === "materialStatus") {
        const present = Number(d.rawValue) === 0;
        window.filamentPreview.setState({
          isFilamentPresent: present,
          showUsedUpIndicator: !present
        });
      }
    }

    // --- ⑤ isNew フラグリセット ---
    d.isNew = false;
  }
}
/**
 * ログ／通知ボックス・タブ ボタンの参照（遅延取得）。
 * bootPanelSystem() が元DOM要素を除去しGridStackパネルに再配置するため、
 * モジュールロード時に取得すると参照が失効する。使用時に都度取得する。
 */

/** 自動スクロール状態と最後にアクティブだったタブ */
let isAutoScrollEnabled = true;
let lastActiveTab       = "received";

/** (A) 自動スクロール ON/OFF の検知 */
function initAutoScrollHandlers() {
  const receivedBox = document.getElementById("log");
  const notifBox    = document.getElementById("notification-history");
  [receivedBox, notifBox].forEach(box => {
    if (!box) return;
    box.addEventListener("scroll", () => {
      const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 5;
      isAutoScrollEnabled = atBottom;
    });
  });
}

/** (B) タブ切り替え時の表示切り替え＋スクロール復帰 */
function initTabHandlers() {
  const tabReceived     = document.getElementById("tab-received");
  const tabNotification = document.getElementById("tab-notification");
  const receivedBox     = document.getElementById("log");
  const notifBox        = document.getElementById("notification-history");
  const tsReceivedEl    = document.getElementById("last-log-timestamp");
  const tsErrorEl       = document.getElementById("last-notification-timestamp");

  if (!tabReceived || !tabNotification) return;

  tabReceived.addEventListener("click", () => {
    lastActiveTab = "received";
    tabReceived.classList.add("active");
    tabNotification.classList.remove("active");
    if (receivedBox) receivedBox.classList.remove("hidden");
    if (tsReceivedEl) tsReceivedEl.classList.remove("hidden");
    if (notifBox) notifBox.classList.add("hidden");
    if (tsErrorEl) tsErrorEl.classList.add("hidden");
    if (isAutoScrollEnabled && receivedBox) {
      receivedBox.scrollTop = receivedBox.scrollHeight;
    }
  });

  tabNotification.addEventListener("click", () => {
    lastActiveTab = "notification";
    tabNotification.classList.add("active");
    tabReceived.classList.remove("active");
    if (receivedBox) receivedBox.classList.add("hidden");
    if (tsReceivedEl) tsReceivedEl.classList.add("hidden");
    if (notifBox) notifBox.classList.remove("hidden");
    if (tsErrorEl) tsErrorEl.classList.remove("hidden");
    if (isAutoScrollEnabled && notifBox) {
      notifBox.scrollTop = notifBox.scrollHeight;
    }
  });
}

/**
 * 外部から一度だけ呼び出すイニシャライザ
 */
export function initUIEventHandlers() {
  initAutoScrollHandlers();
  initTabHandlers();
  initializeCommandPalette();
  adjustPrintCurrentCardPosition();
  window.addEventListener("resize", adjustPrintCurrentCardPosition);
}

/**
 * 温度グラフと操作パネルの配置状況に応じて
 * "現在の印刷" カードを移動させる。
 *
 * 温度グラフが操作パネルと同じ行に配置されている場合のみ
 * グラフの直後へ挿入し、折り返している場合は
 * 履歴カードの直前に戻す。
 *
 * @function adjustPrintCurrentCardPosition
 * @private
 * @returns {void}
 */
let adjustTimer = null;
let lastSameRow = null;

function adjustPrintCurrentCardPosition() {
  if (adjustTimer) {
    clearTimeout(adjustTimer);
  }
  adjustTimer = setTimeout(() => {
    const wrapper = document.getElementById("graph-current-wrapper");
    const graph = wrapper ? wrapper.querySelector(".graph-wrapper") : null;
    const info = document.querySelector(".info-wrapper");
    const printCard = document.getElementById("print-current-card");
    const historyCard = document.getElementById("print-history-card");

    if (!wrapper || !graph || !info || !printCard || !historyCard) return;

    const sameRow = Math.abs(wrapper.offsetTop - info.offsetTop) < 5;
    if (sameRow === lastSameRow) return;
    lastSameRow = sameRow;

    if (sameRow) {
      if (printCard.parentNode !== wrapper) {
        wrapper.appendChild(printCard);
      }
    } else if (historyCard.parentNode && historyCard.previousSibling !== printCard) {
      historyCard.parentNode.insertBefore(printCard, historyCard);
    }
  }, 100);
}

