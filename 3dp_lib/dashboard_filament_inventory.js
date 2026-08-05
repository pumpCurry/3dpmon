/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 フィラメント在庫管理モジュール
 * @file dashboard_filament_inventory.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
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
 * @version 1.390.317 (PR #143)
 * @since   1.390.226 (PR #101)
 * @lastModified 2025-06-19 22:38:18
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

import { monitorData } from "./dashboard_data.js";
import { saveUnifiedStorage } from "./dashboard_storage.js";
import { sendRelayFilament } from "./dashboard_client_sync.js";

/**
 * リレー子（satellite/readonly）判定。
 *
 * ★ 監査 P0(第2報): 在庫は親が唯一の権威。子はローカル変更せず親へ RPC 委譲し、
 * 結果は relay-delta（filamentInventory を含む）で還流する。従来は在庫操作に
 * ガードが一切無く、子で増減しても親へ伝わらず、親で増減しても子へ伝わらず、
 * 在庫が親子で完全に別管理になっていた。
 *
 * @private
 * @returns {boolean} リレー子なら true
 */
function _isRelayChildInv() {
  return typeof window !== "undefined" && window._3dpmonRelayChild === true;
}

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
      totalUsedNum: 0,
      minStockAlert: 1  // デフォルト閾値: 1（在庫1以下で警告）
    };
    monitorData.filamentInventory.push(item);
  }
  // 既存アイテムに minStockAlert がなければ補完
  if (item.minStockAlert == null) item.minStockAlert = 1;
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
  const q = Number(quantity) || 0;
  if (_isRelayChildInv()) {
    sendRelayFilament("setInventoryQuantity", { modelId, quantity: q });
    return q; // 楽観値。親確定後に relay-delta で正が還流する
  }
  const item = ensureItem(modelId);
  item.quantity = q;
  saveUnifiedStorage(true);
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
  const d = Number(delta) || 0;
  if (_isRelayChildInv()) {
    sendRelayFilament("adjustInventory", { modelId, delta: d });
    const cur = getInventoryItem(modelId);
    return (cur?.quantity || 0) + d; // 楽観値
  }
  const item = ensureItem(modelId);
  item.quantity = (item.quantity || 0) + d;
  saveUnifiedStorage(true);
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
/**
 * 在庫の最小閾値を設定する。
 *
 * @param {string} modelId - プリセットID
 * @param {number} threshold - 閾値（この数以下で警告）
 * @returns {number} 設定後の閾値
 */
export function setMinStockAlert(modelId, threshold) {
  const t = Math.max(0, Number(threshold) || 0);
  if (_isRelayChildInv()) {
    sendRelayFilament("setMinStockAlert", { modelId, threshold: t });
    return t; // 楽観値
  }
  const item = ensureItem(modelId);
  item.minStockAlert = t;
  saveUnifiedStorage(true);
  return item.minStockAlert;
}

/**
 * 指定プリセットの在庫が閾値以下かどうか判定する。
 *
 * @param {string} modelId - プリセットID
 * @returns {boolean} 閾値以下なら true
 */
export function isLowStock(modelId) {
  const item = getInventoryItem(modelId);
  if (!item) return false;
  if (item.isUnlimitedStock) return false;
  return item.quantity <= (item.minStockAlert ?? 1);
}

/**
 * 在庫が閾値以下のプリセットID一覧を返す。
 *
 * @returns {Array<{modelId: string, quantity: number, minStockAlert: number}>}
 */
export function getLowStockPresets() {
  return monitorData.filamentInventory
    .filter(inv => !inv.isUnlimitedStock && inv.quantity <= (inv.minStockAlert ?? 1))
    .map(inv => ({ modelId: inv.modelId, quantity: inv.quantity, minStockAlert: inv.minStockAlert ?? 1 }));
}

export function consumeInventory(modelId, amount = 1) {
  const item = ensureItem(modelId);
  const a = Number(amount) || 1;
  if (!item.isUnlimitedStock) item.quantity -= a;
  item.totalUsedNum = (item.totalUsedNum || 0) + a;
  item.lastUsedAt = Date.now().toString();
  saveUnifiedStorage(true);
  return item.quantity;
}

