/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Card_Settings コンポーネント
 * @file Card_Settings.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module cards/Card_Settings
 *
 * 【機能内容サマリ】
 * - Card_Settings コンポーネントのひな形
 *
 * 【公開クラス一覧】
 * - {@link Card_Settings}：UI コンポーネントクラス
 *
* @version 1.390.653 (PR #303)
* @since   1.390.531 (PR #1)
* @lastModified 2025-07-04 12:00:00
 * -----------------------------------------------------------
 * @todo
 * - 実装詳細を追加
 */

/**
 * Card_Settings コンポーネントクラス
 */
import BaseCard from './BaseCard.js';
import { exportLayouts } from '../core/backup.js';
import LayoutStore from '../core/LayoutStore.js';

export class Card_Settings extends BaseCard {
  /** @type {string} */
  static id = 'SETG';

  /**
   * @param {{bus:Object,store:LayoutStore}} cfg - 設定
   */
  constructor(cfg) {
    super(cfg.bus);
    /** @type {LayoutStore} */
    this.store = cfg.store;
  }

  /**
   * DOM 要素を生成してカードを表示する。
   * @param {HTMLElement} root - 追加先
   * @returns {void}
   */
  mount(root) {
    this.el = document.createElement('div');
    this.el.className = 'card settings-card';
    const exp = document.createElement('button');
    exp.className = 'export-btn';
    exp.title = 'Export';
    exp.textContent = 'Export Layouts';
    exp.addEventListener('click', () => this.#onExport());
    const imp = document.createElement('button');
    imp.className = 'import-btn';
    imp.title = 'Import';
    imp.textContent = 'Import JSON';
    imp.addEventListener('click', () => this.#onImport());
    this.el.append(exp, imp);
    root.appendChild(this.el);
  }

  /**
   * エクスポートボタン押下時処理。JSON を生成しダウンロードする。
   * @private
   * @returns {void}
   */
  #onExport() {
    const data = exportLayouts();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    a.href = URL.createObjectURL(blob);
    a.download = `layouts-${y}${m}${d}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /**
   * インポートボタン押下処理。ファイル選択して LayoutStore へ追加する。
   * @private
   * @returns {void}
   */
  #onImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const json = JSON.parse(String(reader.result));
          const layouts = json.layouts || [];
          this.store.importJson(layouts);
        } catch (e) {
          console.error('[import]', e);
        }
      };
      reader.readAsText(file);
    });
    input.click();
  }
}
