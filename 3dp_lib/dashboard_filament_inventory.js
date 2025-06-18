/**
 * @fileoverview
 * 3Dプリンタ監視ツール 3dpmon 用 フィラメント在庫管理モジュール
 * dashboard_filament_inventory.js
 * (c) pumpCurry 2025
 * -----------------------------------------------------------
 * @module dashboard_filament_inventory
 *
 * 【機能内容サマリ】
 * - フィラメントプリセット単位での在庫数管理
 * - 在庫消費時の統計更新
 *
 * 【公開関数一覧】
 * - {@link getInventory}：在庫配列取得
 * - {@link getInventoryItem}：IDから在庫取得
 * - {@link setInventoryQuantity}：在庫数設定
 * - {@link adjustInventory}：在庫数増減
 * - {@link consumeInventory}：消費登録
 *
 * @version 1.390.226 (PR #101)
 * @since   1.390.226 (PR #101)
 */

"use strict";

import { monitorData } from "./dashboard_data.js";
import { saveUnifiedStorage } from "./dashboard_storage.js";

/**
 * 在庫一覧を取得する。
 *
 * @function getInventory
 * @returns {Array<Object>} 在庫アイテム配列
 */
export function getInventory() {
  return monitorData.filamentInventory;
}

/**
 * 指定IDの在庫情報を返す。
 *
 * @function getInventoryItem
 * @param {string} modelId - プリセットID
 * @returns {Object|null} 在庫オブジェクト
 */
export function getInventoryItem(modelId) {
  return monitorData.filamentInventory.find(v => v.modelId === modelId) || null;
}

/**
 * 内部用：在庫アイテムを確保するヘルパー。
 *
 * @private
 * @param {string} modelId - プリセットID
 * @returns {Object} 新規または既存の在庫オブジェクト
 */
function ensureItem(modelId) {
  let item = getInventoryItem(modelId);
  if (!item) {
    item = {
      modelId,
      quantity: 0,
      isUnlimitedStock: false,
      lastUsedAt: null,
      totalUsedNum: 0
    };
    monitorData.filamentInventory.push(item);
  }
  return item;
}

/**
 * 在庫数を設定する。
 *
 * @function setInventoryQuantity
 * @param {string} modelId - プリセットID
 * @param {number} quantity - 設定する在庫数
 * @returns {number} 設定後の在庫数
 */
export function setInventoryQuantity(modelId, quantity) {
  const item = ensureItem(modelId);
  item.quantity = Number(quantity) || 0;
  saveUnifiedStorage();
  return item.quantity;
}

/**
 * 在庫数を増減させる。
 *
 * @function adjustInventory
 * @param {string} modelId - プリセットID
 * @param {number} delta - 変化量（負数可）
 * @returns {number} 更新後の在庫数
 */
export function adjustInventory(modelId, delta) {
  const item = ensureItem(modelId);
  item.quantity = (item.quantity || 0) + Number(delta);
  saveUnifiedStorage();
  return item.quantity;
}

/**
 * スプール使用時に在庫を消費し統計を更新する。
 *
 * @function consumeInventory
 * @param {string} modelId - プリセットID
 * @param {number} [amount=1] - 使用本数
 * @returns {number} 在庫更新後の数量
 */
export function consumeInventory(modelId, amount = 1) {
  const item = ensureItem(modelId);
  const a = Number(amount) || 1;
  if (!item.isUnlimitedStock) item.quantity -= a;
  item.totalUsedNum = (item.totalUsedNum || 0) + a;
  item.lastUsedAt = Date.now().toString();
  saveUnifiedStorage();
  return item.quantity;
}

