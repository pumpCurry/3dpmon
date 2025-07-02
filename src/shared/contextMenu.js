/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 汎用コンテキストメニュー
 * @file contextMenu.js
 * -----------------------------------------------------------
 * @module shared/contextMenu
 *
 * 【機能内容サマリ】
 * - 要素右クリックで表示する簡易メニューを提供
 *
 * 【公開関数一覧】
 * - {@link showContextMenu}: メニュー表示
 *
 * @version 1.390.640 (PR #298)
 * @since   1.390.640 (PR #298)
 * @lastModified 2025-07-03 13:40:00
 * -----------------------------------------------------------
 * @todo
 * - なし
 */

/**
 * コンテキストメニューを表示する。
 *
 * @param {HTMLElement} target - 対象要素
 * @param {Array<{label:string,action:Function}>} items - メニュー項目
 * @returns {void}
 */
export function showContextMenu(target, items) {
  const menu = document.createElement('ul');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.style.position = 'absolute';
  menu.style.top = `${target.clientY || 0}px`;
  menu.style.left = `${target.clientX || 0}px`;
  items.forEach(({ label, action }) => {
    const li = document.createElement('li');
    li.textContent = label;
    li.tabIndex = 0;
    li.setAttribute('role', 'menuitem');
    li.addEventListener('click', () => {
      action();
      close();
    });
    menu.appendChild(li);
  });
  document.body.appendChild(menu);
  menu.focus();
  function close() {
    menu.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey);
}

export default { showContextMenu };
