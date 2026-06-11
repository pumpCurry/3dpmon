/**
 * @fileoverview マルチホスト behavioral テスト用 共有ヘルパ
 *
 * 「複数台テストを必須に」を実用的にするための最小ツール群。
 * 単一ホスト("優先1ホスト")の omission(書き漏れ)バグは、実パイプラインを
 * 2台以上流して「各ホストが期待フィールドを持つ」と検証して初めて捕まる。
 *
 * ⚠ vi.mock は vitest がファイル先頭へホイストする仕様のため、本ヘルパには
 *   移設できない。新しい per-host テストを書くときは
 *   tests/unit/processData_multihost.test.js の mock ブロック（dashboard_data は
 *   実物のまま、重い副作用依存だけ vi.mock）をテンプレとしてコピーし、
 *   メッセージ生成と検証だけ本ヘルパを使うこと。
 *
 * 本ヘルパはアプリのモジュールを import しない（node 安全・依存フリー）。
 */

/**
 * status メッセージを処理したら、各ホストの storedData に必ず存在すべきキー。
 * err はマッピング上 errorStatus 要素へ出る。新フィールド追加時はここに足す。
 * @type {string[]}
 */
export const EXPECTED_DISPLAY_KEYS = ["state", "nozzleTemp", "bedTemp0", "printProgress", "fan", "err"];

/**
 * K1 系のアイドル状態 status メッセージ（最小構成）を生成する。
 * @param {string} host ホスト名（hostname フィールドにも入る）
 * @param {object} [over] 上書きフィールド
 * @returns {object} WebSocket 受信形式の status メッセージ
 */
export function makeK1Status(host, over = {}) {
  return {
    hostname: host,
    model: "K1 Max",
    state: 0,
    deviceState: 1,
    printProgress: 0,
    printJobTime: 0,
    printStartTime: 0,
    printLeftTime: 0,
    printFileName: "",
    fileName: "",
    nozzleTemp: 25.0,
    targetNozzleTemp: 0,
    bedTemp0: 25.0,
    targetBedTemp0: 0,
    fan: 0,
    lightSw: 0,
    curFeedratePct: 100,
    layer: 0,
    TotalLayer: 0,
    err: { errcode: 0, key: 0 },
    ...over,
  };
}

/**
 * storedData に未格納の期待キーを返す（空配列なら全て格納済み）。
 * @param {object} storedData machine.storedData
 * @param {string[]} [keys] 期待キー（既定 EXPECTED_DISPLAY_KEYS）
 * @returns {string[]} 欠落キー
 */
export function missingStoredKeys(storedData, keys = EXPECTED_DISPLAY_KEYS) {
  return keys.filter((k) => storedData?.[k] === undefined);
}

/**
 * 全ホストについて欠落キーを集計する。omission バグ検出の中核。
 * @param {object} monitorData app の monitorData（machines マップ）
 * @param {string[]} hosts 検査対象ホスト
 * @param {string[]} [keys] 期待キー
 * @returns {Record<string,string[]>} host→欠落キー配列（欠落のあるホストのみ）
 */
export function findMissingPerHost(monitorData, hosts, keys = EXPECTED_DISPLAY_KEYS) {
  const out = {};
  for (const host of hosts) {
    const sd = monitorData?.machines?.[host]?.storedData;
    const missing = missingStoredKeys(sd, keys);
    if (missing.length) out[host] = missing;
  }
  return out;
}

/**
 * 各ホストの storedData キー集合（ソート済み）を返す。parity 検証用。
 * @param {object} monitorData
 * @param {string} host
 * @returns {string[]}
 */
export function storedKeysOf(monitorData, host) {
  return Object.keys(monitorData?.machines?.[host]?.storedData ?? {}).sort();
}
