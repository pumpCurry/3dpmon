/**
 * WebSocket モックヘルパー
 * テスト用に WebSocket 送受信をモック化する
 */

/**
 * WebSocket モックを生成
 * @returns {Object} ws モック（send, close, readyState, addEventListener 等）
 */
export function createMockWebSocket() {
  const listeners = {};
  const sentMessages = [];

  const ws = {
    readyState: 1, // WebSocket.OPEN
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,

    /** @type {Array<string>} 送信されたJSONメッセージの配列 */
    sentMessages,

    /**
     * メッセージ送信のモック
     * @param {string} data - JSON文字列
     */
    send(data) {
      sentMessages.push(data);
    },

    /**
     * 接続を閉じるモック
     */
    close() {
      ws.readyState = 3; // CLOSED
    },

    /**
     * イベントリスナー登録
     * @param {string} event - イベント名
     * @param {Function} handler - ハンドラ
     */
    addEventListener(event, handler) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    },

    /**
     * イベントリスナー解除
     * @param {string} event - イベント名
     * @param {Function} handler - ハンドラ
     */
    removeEventListener(event, handler) {
      if (!listeners[event]) return;
      listeners[event] = listeners[event].filter((h) => h !== handler);
    },

    /**
     * イベントを発火させる（テスト用）
     * @param {string} event - イベント名
     * @param {*} data - イベントデータ
     */
    _emit(event, data) {
      if (!listeners[event]) return;
      listeners[event].forEach((h) => h(data));
    },

    /**
     * 送信メッセージをクリア（テスト間リセット用）
     */
    _reset() {
      sentMessages.length = 0;
      ws.readyState = 1;
    },

    /**
     * 最後に送信されたメッセージをパースして返す
     * @returns {Object|null} パース済みJSON or null
     */
    _lastSent() {
      if (sentMessages.length === 0) return null;
      return JSON.parse(sentMessages[sentMessages.length - 1]);
    },
  };

  return ws;
}

/**
 * 送信されたコマンドメッセージを検証するヘルパー
 * @param {string} jsonStr - 送信されたJSON文字列
 * @param {string} expectedMethod - 期待するmethod
 * @param {Object} expectedParams - 期待するparams（部分一致）
 * @returns {boolean}
 */
export function validateSentCommand(jsonStr, expectedMethod, expectedParams = {}) {
  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed.method !== expectedMethod) return false;
    for (const [key, value] of Object.entries(expectedParams)) {
      if (parsed.params[key] !== value) return false;
    }
    return true;
  } catch {
    return false;
  }
}
