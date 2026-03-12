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
 * - data-field に基づく per-host DOM 更新
 * - 更新マーク管理と storedData のDOM反映（マルチホスト対応）
 * - data-field 要素キャッシュによる高速 DOM 検索
 *
 * 【公開関数一覧】
 * - {@link updateStoredDataToDOM}：全接続ホストの変更キューを巡回しDOM反映
 * - {@link clearNewClasses}：更新マーク除去
 * - {@link registerFieldElements}：data-field 要素をキャッシュに登録
 * - {@link unregisterFieldElements}：data-field 要素をキャッシュから除去
 *
 * @version 1.390.785 (PR #366)
 * @since   1.390.193 (PR #86)
 * @lastModified 2026-03-12 12:00:00
 * -----------------------------------------------------------
 * @todo
 * - none
*/

"use strict";

import { monitorData, PLACEHOLDER_HOSTNAME, scopedById } from "./dashboard_data.js";
import { getDisplayValue, consumeDirtyKeysForHost, getHostsWithDirtyKeys } from "./dashboard_data.js";
import { dashboardMapping } from "./dashboard_ui_mapping.js";         // フィールド別定義と処理

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
 * @param {string} [hostname] - このパネルが属するホスト名
 * @returns {void}
 */
export function registerFieldElements(root, hostname) {
  if (!root) return;
  const host = hostname || "";
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
    const host = hostname || el._boundHost || "";
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

      /* フィラメントプレビュー描画更新
       * ※ 残量計算自体は aggregator の per-host ループ内で全ホスト分実行済み。
       *   ここでは per-host Map からホストのインスタンスを取得して反映する。
       *   markAllKeysDirty → isNew=true で必要なフィールドのみ再描画される。
       *   data-field 要素が存在しないパネル構成でも到達するよう、
       *   DOM ノード取得より前に配置する。
       */
      /* フィラメントプレビュー: per-host Map から該当ホストのインスタンスを取得 */
      {
        const fp = window._filamentPreviews?.get(host);
        if (fp) {
          if (key === "filamentRemainingMm") {
            const val = Number(d.rawValue);
            if (!isNaN(val)) fp.setRemainingLength(val);
          }
          if (key === "materialStatus") {
            const present = Number(d.rawValue) === 0;
            fp.setState({
              isFilamentPresent: present,
              showUsedUpIndicator: !present
            });
          }
        }
      }

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

