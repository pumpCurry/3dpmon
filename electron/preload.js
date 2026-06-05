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
   * package.json のバージョン文字列を返す。
   * @returns {string} "2.1.010" 等
   */
  getVersion: () => ipcRenderer.sendSync("get-app-version"),

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
   * カメラ／画像パススルー用のホスト→エンドポイント マップをメインプロセスへ渡す。
   * 子向け /relay-camera/{host}/snapshot.jpg（port）および
   * /relay-image/{host}/downloads/...（httpPort）の転送許可先になる。
   *
   * @param {Object<string, {ip: string, port: number, httpPort?: number}>} map - ホスト名→{ip, port, httpPort}
   */
  setCameraEndpoints: (map) => ipcRenderer.send("set-camera-endpoints", map),

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
  onRelayRequestSnapshot: (callback) => ipcRenderer.on("relay-request-snapshot", (_, data) => callback(data)),

  /**
   * 子クライアントからの操作モード昇格要求を受信するリスナーを登録する（親側）。
   * 親レンダラーが appSettings の PIN と照合して検証する。
   *
   * @param {Function} callback - (data: {clientId, pin}) => void
   */
  onRelayPromoteRequest: (callback) => ipcRenderer.on("relay-promote-request", (_, data) => callback(data)),

  /**
   * 昇格PIN検証結果をリレーサーバへ返す（親側）。
   *
   * @param {string} clientId - 対象クライアントID
   * @param {boolean} granted - 許可するか
   * @param {string} [reason] - 拒否理由
   */
  relayPromoteResponse: (clientId, granted, reason) =>
    ipcRenderer.send("relay-promote-response", { clientId, granted, reason }),

  /* ─── ARP 解決 API ─── */

  /**
   * 指定 IP の MAC アドレスを ARP テーブルから取得する。
   * @param {string} ip - 対象 IP アドレス
   * @returns {Promise<string|null>} MAC アドレス（"fc:ee:28:01:4a:1b"）または null
   */
  arpResolve: (ip) => ipcRenderer.invoke("arp-resolve", ip),

  /**
   * ARP テーブル全スキャン。Creality 機器の自動検出に使用。
   * @returns {Promise<Array<{ip:string, mac:string, isCreality:boolean}>>}
   */
  arpScan: () => ipcRenderer.invoke("arp-scan"),

  /* ─── About ダイアログ IPC ─── */

  /**
   * メインプロセスから About ダイアログ表示要求を受信する。
   * @param {Function} callback - () => void
   */
  onShowAboutDialog: (callback) => ipcRenderer.on("show-about-dialog", () => callback())
});
