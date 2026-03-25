/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 共通UIコンポーネント
 * @file dashboard_ui_components.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_ui_components
 *
 * 【機能内容サマリ】
 * - 空状態/ローディング/エラー状態の統一コンポーネント
 *
 * 【公開関数一覧】
 * - {@link createEmptyState}：空状態パネルを生成
 * - {@link createLoadingState}：ローディング表示を生成
 * - {@link createErrorState}：エラー表示を生成
 * - {@link createSkeletonLines}：スケルトンローディング行を生成
 *
 * @version 1.390.810 (PR #367)
 * @since   1.390.810 (PR #367)
 * @lastModified 2026-03-25
 * -----------------------------------------------------------
 */

"use strict";

/**
 * 空状態コンポーネントを生成する。
 * データがない、接続がない等の状態を統一的に表示。
 *
 * @param {Object} options - 表示オプション
 * @param {string} [options.icon="📭"] - アイコン（絵文字）
 * @param {string} [options.title] - タイトル（太字）
 * @param {string} [options.message] - 説明テキスト
 * @param {string} [options.actionLabel] - CTAボタンのラベル
 * @param {Function} [options.onAction] - CTAボタンのクリックハンドラ
 * @returns {HTMLElement} 空状態の DOM 要素
 */
export function createEmptyState(options = {}) {
  const el = document.createElement("div");
  el.className = "state-empty";
  el.setAttribute("role", "status");

  const icon = document.createElement("div");
  icon.className = "state-icon";
  icon.textContent = options.icon || "📭";
  icon.setAttribute("aria-hidden", "true");
  el.appendChild(icon);

  if (options.title) {
    const title = document.createElement("div");
    title.className = "state-title";
    title.textContent = options.title;
    el.appendChild(title);
  }

  if (options.message) {
    const msg = document.createElement("div");
    msg.className = "state-message";
    msg.textContent = options.message;
    el.appendChild(msg);
  }

  if (options.actionLabel && options.onAction) {
    const btn = document.createElement("button");
    btn.className = "state-action btn-font-sm";
    btn.textContent = options.actionLabel;
    btn.addEventListener("click", options.onAction);
    el.appendChild(btn);
  }

  return el;
}

/**
 * ローディング状態コンポーネントを生成する。
 *
 * @param {Object} [options] - 表示オプション
 * @param {string} [options.message="読み込み中…"] - メッセージ
 * @returns {HTMLElement} ローディングの DOM 要素
 */
export function createLoadingState(options = {}) {
  const el = document.createElement("div");
  el.className = "state-loading";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");

  const icon = document.createElement("div");
  icon.className = "state-icon";
  icon.textContent = "⏳";
  icon.setAttribute("aria-hidden", "true");
  el.appendChild(icon);

  const msg = document.createElement("div");
  msg.className = "state-message";
  msg.textContent = options.message || "読み込み中…";
  el.appendChild(msg);

  return el;
}

/**
 * エラー状態コンポーネントを生成する。
 *
 * @param {Object} options - 表示オプション
 * @param {string} [options.title="エラーが発生しました"] - タイトル
 * @param {string} [options.message] - エラー詳細
 * @param {string} [options.retryLabel="再試行"] - リトライボタンラベル
 * @param {Function} [options.onRetry] - リトライハンドラ
 * @returns {HTMLElement} エラーの DOM 要素
 */
export function createErrorState(options = {}) {
  const el = document.createElement("div");
  el.className = "state-error";
  el.setAttribute("role", "alert");

  const icon = document.createElement("div");
  icon.className = "state-icon";
  icon.textContent = "⚠️";
  icon.setAttribute("aria-hidden", "true");
  el.appendChild(icon);

  const title = document.createElement("div");
  title.className = "state-title";
  title.textContent = options.title || "エラーが発生しました";
  el.appendChild(title);

  if (options.message) {
    const msg = document.createElement("div");
    msg.className = "state-message";
    msg.textContent = options.message;
    el.appendChild(msg);
  }

  if (options.onRetry) {
    const btn = document.createElement("button");
    btn.className = "state-action btn-font-sm";
    btn.textContent = options.retryLabel || "再試行";
    btn.addEventListener("click", options.onRetry);
    el.appendChild(btn);
  }

  return el;
}

/**
 * スケルトンローディング行を生成する。
 * テーブルやカードのプレースホルダーとして使用。
 *
 * @param {number} [lines=3] - 行数
 * @param {HTMLElement} [container] - 追加先コンテナ（省略時は新規div）
 * @returns {HTMLElement} スケルトン行を含む DOM 要素
 */
export function createSkeletonLines(lines = 3, container = null) {
  const el = container || document.createElement("div");
  const widths = ["w-75", "w-50", "w-25"];
  for (let i = 0; i < lines; i++) {
    const line = document.createElement("div");
    line.className = `skeleton skeleton-line ${widths[i % widths.length]}`;
    el.appendChild(line);
  }
  return el;
}
