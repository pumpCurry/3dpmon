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
import { getDisplayValue, setStoredData, consumeDirtyKeysForHost, getHostsWithDirtyKeys } from "./dashboard_data.js";
import { dashboardMapping } from "./dashboard_ui_mapping.js";         // フィールド別定義と処理
import { initializeCommandPalette } from "./dashboard_send_command.js";

/* ─── B: data-field 要素キャッシュ（per-host） ─── */

/**
 * ホスト名とフィールド名の複合キー ("hostname\0fieldName") で
 * DOM 要素の Set を保持するキャッシュ。
 * パネル追加時に registerFieldElements(root, hostname) で登録し、
 * パネル削除時に unregisterFieldElements(root, hostname) で除去する。
 *
 * @type {Map<string, Set<Element>>}
 * @private
 */
const _fieldCache = new Map();

/**
 * 複合キャッシュキーを生成する。
 * @private
 * @param {string} hostname - ホスト名
 * @param {string} fieldName - data-field 属性値
 * @returns {string}
 */
function _cacheKey(hostname, fieldName) {
  return hostname + "\0" + fieldName;
}

/**
 * registerFieldElements:
 * 指定ルート要素配下の全 [data-field] 要素をキャッシュに登録する。
 * パネル生成時（addPanel）に呼び出す。
 *
 * @param {HTMLElement} root - スキャン対象のルート要素
 * @param {string} [hostname] - このパネルが属するホスト名（省略時は currentHostname）
 * @returns {void}
 */
export function registerFieldElements(root, hostname) {
  if (!root) return;
  const host = hostname || currentHostname || "";
  root.querySelectorAll("[data-field]").forEach(el => {
    const field = el.getAttribute("data-field");
    if (!field) return;
    const ck = _cacheKey(host, field);
    if (!_fieldCache.has(ck)) _fieldCache.set(ck, new Set());
    _fieldCache.get(ck).add(el);
    /* 要素自体にもホスト名を記録（逆引き用） */
    el._boundHost = host;
  });
}

/**
 * unregisterFieldElements:
 * 指定ルート要素配下の全 [data-field] 要素をキャッシュから除去する。
 * パネル削除時（removePanel）に呼び出す。
 *
 * @param {HTMLElement} root - スキャン対象のルート要素
 * @param {string} [hostname] - このパネルが属するホスト名（省略時は要素の _boundHost）
 * @returns {void}
 */
export function unregisterFieldElements(root, hostname) {
  if (!root) return;
  root.querySelectorAll("[data-field]").forEach(el => {
    const field = el.getAttribute("data-field");
    if (!field) return;
    const host = hostname || el._boundHost || currentHostname || "";
    const ck = _cacheKey(host, field);
    const set = _fieldCache.get(ck);
    if (set) {
      set.delete(el);
      if (set.size === 0) _fieldCache.delete(ck);
    }
  });
}

/**
 * 指定ホストの data-field 要素を取得する。
 *
 * @private
 * @param {string} hostname - ホスト名
 * @param {string} fieldName - data-field 属性値
 * @returns {Set<Element>} 対応する要素群（空Setの場合あり）
 */
function _getFieldElements(hostname, fieldName) {
  const ck = _cacheKey(hostname, fieldName);
  if (_fieldCache.has(ck)) {
    return _fieldCache.get(ck);
  }
  /* キャッシュミス: 空Set を返す（パネルが無いホストの要素は存在しない） */
  return _emptySet;
}

/** @private 空の Set 定数（毎回生成を避ける） */
const _emptySet = new Set();

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
 * hostname を指定することで特定ホストのパネル要素のみを更新できる。
 *
 * @param {string} fieldName - 反映対象フィールド名（data-field属性に一致）
 * @param {{value:string, unit:string}|string|null} [data] - 表示値オブジェクト（省略時は getDisplayValue にフォールバック）
 * @param {string} [hostname] - 対象ホスト名（省略時は currentHostname）
 */
export function updateDataField(fieldName, data = undefined, hostname) {
  const host = hostname || currentHostname || "";
  const displayData = data ?? getDisplayValue(fieldName, host);
  const elements = _getFieldElements(host, fieldName);

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
 * 全接続ホストの変更キューを巡回し、各ホストのパネル要素だけを正確に更新する。
 * ホストごとに consumeDirtyKeysForHost() で変更キーを取得し、
 * _getFieldElements(hostname, fieldName) でそのホストのパネル要素のみに反映する。
 *
 * - checkbox要素、.value/.unitを持つ要素、その他のtextContent要素を識別して更新
 * - dashboardMapping に process がある場合は computedValue を再生成
 * - getDisplayValue(key, hostname) により value/unit を取得
 * - 複数DOM要素がある場合にもすべて反映
 */
export function updateStoredDataToDOM() {
  /* dirty key を持つ全ホストを巡回（並列表示対応） */
  const dirtyHosts = getHostsWithDirtyKeys();
  if (dirtyHosts.length === 0) return;

  for (const host of dirtyHosts) {
    if (host === PLACEHOLDER_HOSTNAME) continue;
    const machine = monitorData.machines[host];
    if (!machine) continue;
    const storedData = machine.storedData;
    const dirtyKeys = consumeDirtyKeysForHost(host);

    for (const key of dirtyKeys) {
      const d = storedData[key];
      if (!d?.isNew) continue;

      const map = dashboardMapping[key] || {};

      /* domProps 横展開（スコープ付きID で検索） */
      if (Array.isArray(map.domProps)) {
        map.domProps.forEach(({ id, prop }) => {
          try {
            const el = scopedById(id, host);
            if (!el) throw new Error(`element not found`);
            if (!(prop in el)) throw new Error(`property "${prop}" does not exist on element`);
            el[prop] = d.rawValue;
          } catch (err) {
            console.warn(
              `[updateStoredDataToDOM] domProps update skipped for id="${id}", prop="${prop}":`,
              err.message
            );
          }
        });
      }

      /* DOMキー決定 & computedValue 再生成 */
      const elementKey = dashboardMapping[key]?.elementKey || key;
      if (d.rawValue != null && typeof dashboardMapping[key]?.process === "function") {
        try {
          d.computedValue = dashboardMapping[key].process(d.rawValue);
        } catch (e) {
          console.warn(`[updateStoredDataToDOM] process() failed for "${key}"`, e);
          d.computedValue = null;
        }
      }

      /* 表示用データ取得（ホスト指定） */
      const { value, unit } = getDisplayValue(key, host) || {
        value: String(d.rawValue ?? ""),
        unit: ""
      };

      /* data-field 属性に対応する DOM 要素群の取得（per-host キャッシュ） */
      const nodes = _getFieldElements(host, elementKey);
      if (nodes.size === 0) {
        if (d.isFromEquipVal) {
          console.debug(`[updateStoredDataToDOM] data-field="${elementKey}" 要素なし (host="${host}", key="${key}")`);
        }
        d.isNew = false;
        continue;
      }

      /* 各要素への反映 */
      nodes.forEach(el => {
        _applyValueToElement(el, d, value, unit);
        el.classList.remove("old");
        el.classList.add("new");
        _newElements.add(el);
      });

      /* フィラメントプレビュー更新（TODO: per-host化予定） */
      if (host === currentHostname && window.filamentPreview) {
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

      d.isNew = false;
    }
  }
}

/**
 * 要素の種別に応じて値を反映する内部ヘルパー。
 *
 * @private
 * @param {HTMLElement} el - 対象要素
 * @param {StoredDatum} d - storedData エントリ
 * @param {string} value - 表示用値
 * @param {string} unit - 表示用単位
 */
function _applyValueToElement(el, d, value, unit) {
  const tag = el.tagName;
  const type = el.type?.toLowerCase?.();

  if (tag === "INPUT" && type === "checkbox") {
    const raw = d.rawValue;
    const isOn = typeof raw === "boolean"
      ? raw
      : typeof raw === "number"
        ? raw >= 1
        : String(raw).trim().toLowerCase() === "true" || String(raw).trim() === "1";
    el.checked = isOn;
  } else if (tag === "INPUT" && (type === "range" || type === "number")) {
    const num = parseFloat(value);
    if (!isNaN(num)) el.value = num;
  } else if (tag === "INPUT" && type === "text") {
    el.value = value;
  } else if (el.querySelector(".value") || el.querySelector(".unit")) {
    const valueEl = el.querySelector(".value");
    if (valueEl) valueEl.textContent = value;
    const unitEl = el.querySelector(".unit");
    if (unitEl) unitEl.textContent = unit;
  } else {
    el.textContent = `${value}${unit}`;
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

