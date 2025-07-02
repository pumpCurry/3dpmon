/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 ダッシュボード管理クラス
 * @file DashboardManager.js
 * -----------------------------------------------------------
 * @module core/DashboardManager
 *
 * 【機能内容サマリ】
 * - タイトルバーとサイドメニューを生成しカード領域を描画
 *
 * 【公開クラス一覧】
 * - {@link DashboardManager}：ダッシュボード統括クラス
 *
 * @version 1.390.600 (PR #277)
 * @since   1.390.576 (PR #260)
 * @lastModified 2025-07-01 12:00:00
 * -----------------------------------------------------------
 * @todo
 * - カード動的ロードと配置永続化
 */

import TitleBar from '@cards/Bar_Title.js';
import SideMenu from '@cards/Bar_SideMenu.js';
import SideBar from '@bars/Bar_Side.js';
import LayoutStore from './LayoutStore.js';
import CardContainer from './CardContainer.js';
import DeviceFilterBar from '../widgets/DeviceFilterBar.js';

/**
 * ダッシュボード全体を管理するクラス。
 */
export default class DashboardManager {
  /**
   * @param {Object} bus - EventBus インスタンス
   * @param {Object} cm - ConnectionManager インスタンス
   */
  constructor(bus, cm) {
    /** @type {Object} */
    this.bus = bus;
    /** @type {Object} */
    this.cm = cm;
    /** @type {LayoutStore} */
    this.store = new LayoutStore();
    this.store.current = { id: 'default', name: 'Default', updated: 0, grid: [], filter: 'ALL' };
    /** @type {HTMLElement|null} */
    this.root = null;
    /** @type {HTMLElement|null} */
    this.main = null;
    /** @type {TitleBar|null} */
    this.titleBar = null;
    /** @type {SideMenu|null} */
    this.sideMenu = null;
    /** @type {SideBar|null} */
    this.sideBar = null;
    /** @type {CardContainer|null} */
    this.container = null;
    /** @type {DeviceFilterBar|null} */
    this.filterBar = null;
  }

  /**
   * ルート要素へダッシュボードを描画する。
   *
   * @param {HTMLElement} root - 描画先ルート要素
   * @returns {void}
   */
  render(root) {
    this.root = root;
    if (!this.root) return;

    this.titleBar = new TitleBar(this.bus);
    this.titleBar.mount(this.root);
    this.titleBar.setTabs([
      { id: 'd1', label: 'Dummy1', color: '#f66' }
    ]);

    this.sideMenu = new SideMenu(this.bus);
    this.sideMenu.mount(this.root);
    this.sideBar = new SideBar(this.bus);
    this.sideBar.mount(this.root);
    this.bus.on('menu:global', () => this.sideMenu && this.sideMenu.open());
    this.bus.on('menu:close', () => this.sideMenu && this.sideMenu.close());
    this.bus.on('sidebar:conn', () => {
      import('../dialogs/ConnManagerModal.js').then(({ default: Dlg }) => new Dlg(this.bus).open());
    });
    this.bus.on('sidebar:logs', () => {
      import('../dialogs/LogViewerModal.js').then(({ default: Dlg }) => new Dlg(this.bus).open());
    });
    this.bus.on('sidebar:theme', async () => {
      const { setTheme, getTheme, THEMES } = await import('./ThemeManager.js');
      const idx = THEMES.indexOf(getTheme());
      setTheme(THEMES[(idx + 1) % THEMES.length]);
    });
    this.bus.on('conn:add', (meta) => {
      if (this.titleBar) {
        this.titleBar.addTab({ id: meta.id, label: meta.ip, color: meta.color, icon: meta.icon });
      }
    });
    this.bus.on('conn:remove', ({ id }) => {
      this.titleBar && this.titleBar.removeTab(id);
    });

    this.main = document.createElement('main');
    this.main.className = 'dashboard-main';
    this.root.appendChild(this.main);

    this.container = new CardContainer(this.bus, this.store);
    this.container.mount(this.main);
    this.filterBar = new DeviceFilterBar(this.store, this.bus);
    this.filterBar.mount(this.root);
  }
}
