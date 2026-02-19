/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 接続設定モーダルモジュール
 * @file dashboard_conn_settings.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_conn_settings
 *
 * 【機能内容サマリ】
 * - 接続設定モーダル（プリンタ名・色・IP・WS・CAM・自動接続）
 * - connections[] の CRUD と色設定
 *
 * 【公開クラス一覧】
 * - {@link ConnSettingsModal}：接続設定モーダルクラス
 *
 * @version 1.400.001 (PR #303)
 * @since   1.400.001 (PR #303)
 * @lastModified 2025-07-04 10:30:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

import { monitorData } from "./dashboard_data.js";
import { saveUnifiedStorage } from "./dashboard_storage.js";
import { connectWs, disconnectWs } from "./dashboard_connection.js";

/** IP アドレス検証 */
const IP_RE = /^(25[0-5]|2[0-4]\d|1?\d{1,2})(\.(25[0-5]|2[0-4]\d|1?\d{1,2})){3}$/;
/** ポート番号検証 */
const PORT_RE = /^(6553[0-5]|655[0-2]\d|65[0-4]\d{2}|6[0-4]\d{3}|[1-5]?\d{0,4})$/;

/**
 * 一意な接続 ID を生成します。
 * @returns {string}
 */
function genId() {
  return `conn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 接続設定モーダルクラス。
 * プリンタごとの名前・色・IP・ポート・自動接続を管理します。
 */
export class ConnSettingsModal {
  constructor() {
    /** @type {HTMLDialogElement|null} */
    this.dialog = null;
  }

  /**
   * モーダルを開く。
   * @returns {void}
   */
  open() {
    if (this.dialog) return;
    this.dialog = document.createElement("dialog");
    this.dialog.className = "conn-settings-dialog";
    this.dialog.setAttribute("role", "dialog");
    this.dialog.setAttribute("aria-modal", "true");
    this.dialog.setAttribute("aria-label", "接続設定");

    this.dialog.innerHTML = `
      <div class="conn-settings-header">
        <h2>接続設定</h2>
        <button class="conn-settings-close" aria-label="閉じる">×</button>
      </div>
      <div class="conn-settings-body"></div>
      <div class="conn-settings-footer">
        <button class="conn-add-btn">＋ プリンタを追加</button>
      </div>
    `;

    this.dialog.querySelector(".conn-settings-close")
      ?.addEventListener("click", () => this.close());
    this.dialog.querySelector(".conn-add-btn")
      ?.addEventListener("click", () => this.#addConnection());
    this.dialog.addEventListener("click", e => {
      if (e.target === this.dialog) this.close();
    });

    document.body.appendChild(this.dialog);
    this.#render();
    this.dialog.showModal();
  }

  /**
   * モーダルを閉じる。
   * @returns {void}
   */
  close() {
    if (!this.dialog) return;
    this.dialog.close();
    this.dialog.remove();
    this.dialog = null;
  }

  /**
   * 接続一覧を再描画する。
   * @private
   */
  #render() {
    if (!this.dialog) return;
    const body = this.dialog.querySelector(".conn-settings-body");
    if (!body) return;
    body.innerHTML = "";

    const connections = monitorData.appSettings.connections || [];
    if (connections.length === 0) {
      body.innerHTML = '<p class="conn-empty">接続が登録されていません。</p>';
      return;
    }

    connections.forEach(conn => {
      const entry = this.#buildEntry(conn);
      body.appendChild(entry);
    });
  }

  /**
   * 接続エントリ要素を生成する。
   * @private
   * @param {{id:string,name:string,color:string,ip:string,wsPort:number,camPort?:number,autoConnect:boolean}} conn
   * @returns {HTMLElement}
   */
  #buildEntry(conn) {
    const div = document.createElement("div");
    div.className = "conn-entry";
    div.dataset.id = conn.id;

    const indicator = this.#getIndicator(conn);

    div.innerHTML = `
      <div class="conn-indicator">${indicator}</div>
      <div class="conn-fields">
        <div class="conn-top-row">
          <input type="text"  class="conn-name"  value="${this.#esc(conn.name)}"  placeholder="プリンタ名" aria-label="プリンタ名">
          <input type="color" class="conn-color" value="${conn.color || '#4a9eff'}" aria-label="プリンタカラー">
          <label class="conn-auto-label">
            <input type="checkbox" class="conn-auto" ${conn.autoConnect ? "checked" : ""}> 自動接続
          </label>
          <label class="conn-auto-label">
            <input type="checkbox" class="conn-cam-auto" ${conn.autoCamera ? "checked" : ""}> 接続時カメラON
          </label>
        </div>
        <div class="conn-addr-row">
          <label>IP <input type="text"   class="conn-ip"  value="${this.#esc(conn.ip)}"     placeholder="192.168.1.x" aria-label="IPアドレス"></label>
          <label>WS <input type="number" class="conn-ws"  value="${conn.wsPort || ''}"      placeholder="9999" min="1" max="65535" aria-label="WSポート"></label>
          <label>CAM<input type="number" class="conn-cam" value="${conn.camPort || ''}"     placeholder="8080" min="1" max="65535" aria-label="CAMポート"></label>
        </div>
        <div class="conn-action-row">
          <button class="conn-save-btn">保存</button>
          <button class="conn-delete-btn">削除</button>
        </div>
      </div>
    `;

    div.querySelector(".conn-save-btn")
      ?.addEventListener("click", () => this.#saveEntry(div, conn.id));
    div.querySelector(".conn-delete-btn")
      ?.addEventListener("click", () => this.#deleteEntry(conn.id));

    return div;
  }

  /**
   * 接続インジケーター文字列を返す。
   * @private
   */
  #getIndicator(conn) {
    // 将来的には connectionMap から接続状態を読むが、現時点では IP の有無で判定
    if (!conn.ip) return "⚫";
    return "🔴";
  }

  /**
   * エントリを保存する。
   * @private
   */
  #saveEntry(div, id) {
    const name      = div.querySelector(".conn-name")?.value.trim() || "";
    const color     = div.querySelector(".conn-color")?.value || "#4a9eff";
    const ip        = div.querySelector(".conn-ip")?.value.trim() || "";
    const wsPort    = parseInt(div.querySelector(".conn-ws")?.value || "9999", 10);
    const camPort   = parseInt(div.querySelector(".conn-cam")?.value || "0", 10) || undefined;
    const auto      = div.querySelector(".conn-auto")?.checked ?? false;
    const autoCamera = div.querySelector(".conn-cam-auto")?.checked ?? false;

    // 入力検証
    if (ip && !IP_RE.test(ip)) {
      alert("IP アドレスの形式が正しくありません");
      return;
    }
    if (isNaN(wsPort) || !PORT_RE.test(String(wsPort))) {
      alert("WS ポート番号が正しくありません");
      return;
    }

    const connections = monitorData.appSettings.connections;
    const idx = connections.findIndex(c => c.id === id);
    if (idx !== -1) {
      connections[idx] = { ...connections[idx], name, color, ip, wsPort, camPort, autoConnect: auto, autoCamera };
    }
    saveUnifiedStorage();
    this.#render();
    // ペインのカラーを即時反映
    this.#applyColors();
  }

  /**
   * エントリを削除する。
   * @private
   */
  #deleteEntry(id) {
    if (!confirm("この接続を削除しますか？")) return;
    monitorData.appSettings.connections = (monitorData.appSettings.connections || []).filter(c => c.id !== id);
    // ペイン割り当てをクリア
    const pa = monitorData.appSettings.paneAssignment;
    for (const k of Object.keys(pa)) {
      if (pa[k] === id) pa[k] = null;
    }
    saveUnifiedStorage();
    this.#render();
  }

  /**
   * 新しい接続を追加する。
   * @private
   */
  #addConnection() {
    const newConn = {
      id:          genId(),
      name:        `プリンタ ${(monitorData.appSettings.connections?.length || 0) + 1}`,
      color:       "#4a9eff",
      ip:          "",
      wsPort:      9999,
      camPort:     undefined,
      autoConnect: false,
      autoCamera:  false
    };
    if (!monitorData.appSettings.connections) {
      monitorData.appSettings.connections = [];
    }
    monitorData.appSettings.connections.push(newConn);
    saveUnifiedStorage();
    this.#render();
  }

  /**
   * 各ペインのプリンタカラー CSS 変数を更新する。
   * @private
   */
  #applyColors() {
    const pa = monitorData.appSettings.paneAssignment || {};
    for (const [pane, connId] of Object.entries(pa)) {
      if (!connId) continue;
      const conn = (monitorData.appSettings.connections || []).find(c => c.id === connId);
      if (!conn) continue;
      const paneEl = document.getElementById(`pane-${pane}`);
      if (paneEl) {
        paneEl.style.setProperty("--printer-color", conn.color);
        paneEl.style.setProperty("--printer-color-faint", conn.color + "1a");
      }
    }
  }

  /**
   * HTML エスケープ
   * @private
   */
  #esc(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
}