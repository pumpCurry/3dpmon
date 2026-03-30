/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Electron プリロード モジュール
 * @file electron/preload.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module electron_preload
 *
 * 【機能内容サマリ】
 * - Electron のメインプロセスとレンダラープロセスの橋渡し
 * - contextBridge を通じて安全にネイティブ機能を公開
 * - 将来的なファイル保存・システム通知等の IPC を担当
 *
 * 【公開関数一覧】
 * - window.electronAPI.isElectron：Electron 環境かどうかを返す
 * - window.electronAPI.getPlatform：OS プラットフォームを返す
 *
 * @version 1.390.783 (PR #366)
 * @since   1.390.783 (PR #366)
 * @lastModified 2026-03-10 21:00:00
 * -----------------------------------------------------------
 * @todo
 * - ファイル保存ダイアログの IPC 実装
 * - ネイティブ通知の IPC 実装
 */

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/**
 * レンダラープロセスに公開する API を定義する。
 *
 * 【詳細説明】
 * - contextBridge.exposeInMainWorld を使い、
 *   window.electronAPI 経由でのみアクセス可能にする
 * - nodeIntegration: false のまま安全にネイティブ機能を利用できる
 *
 * @function exposeAPI
 * @returns {void}
 */
contextBridge.exposeInMainWorld("electronAPI", {
  /**
   * Electron 環境で動作しているかを返す。
   * ブラウザ版との分岐判定に使用。
   *
   * @function isElectron
   * @returns {boolean} 常に true
   */
  isElectron: () => true,

  /**
   * OS プラットフォーム文字列を返す。
   *
   * @function getPlatform
   * @returns {string} "win32" | "darwin" | "linux" 等
   */
  getPlatform: () => process.platform,

  /* ─── リレーサーバ IPC API ─── */

  /**
   * state delta をリレーサーバに配信する。
   * aggregator 周期ごとにレンダラーから呼び出す。
   *
   * @param {Object} delta - 差分データ
   */
  relayBroadcast: (delta) => ipcRenderer.send("relay-broadcast", delta),

  /**
   * 特定クライアントに state snapshot を送信する。
   *
   * @param {string} clientId - 対象クライアントID
   * @param {Object} state - フルステートデータ
   */
  relaySendSnapshot: (clientId, state) => ipcRenderer.send("relay-send-snapshot", { clientId, state }),

  /**
   * リレーサーバ設定を取得する。
   *
   * @returns {Promise<{enabled: boolean, port: number, clients: Array}>}
   */
  relayGetConfig: () => ipcRenderer.invoke("relay-get-config"),

  /**
   * リレー経由のコマンドを受信するリスナーを登録する。
   * 子（satellite）からのコマンドを親レンダラーが処理する。
   *
   * @param {Function} callback - (data: {target, method, params}) => void
   */
  onRelayCommand: (callback) => ipcRenderer.on("relay-command", (_, data) => callback(data)),

  /**
   * リレー経由のフィラメント操作を受信するリスナーを登録する。
   *
   * @param {Function} callback - (data: {action, data}) => void
   */
  onRelayFilament: (callback) => ipcRenderer.on("relay-filament", (_, data) => callback(data)),

  /**
   * リレー経由のスナップショット要求を受信するリスナーを登録する。
   *
   * @param {Function} callback - (data: {clientId}) => void
   */
  onRelayRequestSnapshot: (callback) => ipcRenderer.on("relay-request-snapshot", (_, data) => callback(data))
});
