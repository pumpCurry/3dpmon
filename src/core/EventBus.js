/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 簡易イベントバスモジュール
 * @file EventBus.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * -----------------------------------------------------------
 * @module core/EventBus
 *
 * 【機能内容サマリ】
 * - publish/subscribe 形式の簡易イベントバスを提供
 *
 * 【公開定数一覧】
 * - {@link bus}：シングルトンのイベントバス
 *
* @version 1.390.536 (PR #245)
* @since   1.390.536 (PR #245)
* @lastModified 2025-06-28 19:30:39
 * -----------------------------------------------------------
 * @todo
 * - なし
 */

/**
 * 簡易 publish/subscribe イベントバス。
 * コールバック登録と通知を行う。
 *
 * @constant {Object}
 */
export const bus = (() => {
  /** @type {Map<string, Function[]>} */
  const map = new Map();
  return {
    /**
     * 指定イベントのリスナーを登録する。
     *
     * @param {string} evt - イベント名
     * @param {Function} fn - コールバック関数
     * @returns {void}
     */
    on(evt, fn) {
      const list = map.get(evt) ?? [];
      list.push(fn);
      map.set(evt, list);
    },
    /**
     * 指定イベントのリスナーを解除する。
     *
     * @param {string} evt - イベント名
     * @param {Function} fn - コールバック関数
     * @returns {void}
     */
    off(evt, fn) {
      const list = map.get(evt) ?? [];
      map.set(evt, list.filter(f => f !== fn));
    },
    /**
     * イベントを発火し、登録されたリスナーへ通知する。
     *
     * @param {string} evt - イベント名
     * @param {*} data - 任意のデータ
     * @returns {void}
     */
    emit(evt, data) {
      (map.get(evt) ?? []).forEach(f => f(data));
    }
  };
})();
