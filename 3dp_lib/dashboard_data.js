/**
 * @fileoverview
 * Domain model and in‑memory data operations for 3Dプリンタ監視ダッシュボード (v1.322)
 *
 * - アプリケーション全体の状態 (monitorData)
 * - currentHostname の管理
 * - storedData / runtimeData への純粋な読み書きユーティリティ
 *
 * このモジュールは他のすべてのモジュールから参照されますが、
 * 自身は他モジュールを import しません（循環参照回避）。
 */

"use strict";

/**
 * @typedef {Object} StoredDatum
 * @property {*}     rawValue      元の生データ
 * @property {*}     computedValue UI 用に変換されたデータ
 * @property {boolean} isNew        DOM 反映対象フラグ
 */

/**
 * @typedef {Object} MachineData
 * @property {Object.<string,StoredDatum>} storedData  表示・UI 用データ
 * @property {Object}                runtimeData  揮発性データ（heartbeat など）
 * @property {Array<Object>}         historyData  印刷履歴
 */

/**
 * @fileoverview
 * monitorData: 全アプリケーションの内部状態を保持
 * @namespace monitorData
 * @property {{updateInterval:number, logLevel:string, autoConnect:boolean, wsDest:string, cameraToggle:boolean}} appSettings
 *   アプリ全体の設定
 * @property {Object.<string, MachineData>} machines
 *   ホスト名をキーとする機器データのマップ
 */

/**
 * 機器未選択・未設定状態のプレースホルダ用ホスト名
 * サーバー側からは絶対に返されない値とすることで、
 * フロントエンド側の「未設定状態」を安全に表現する。
 * @constant {string}
 */
export const PLACEHOLDER_HOSTNAME = "_$_NO_MACHINE_$_";

/**
 * 現在監視中の機器ホスト名
 * - null の場合: 未設定または初期化前
 * - PLACEHOLDER_HOSTNAME の場合: 強制的な「未選択」状態
 * - 通常は実際のホスト名文字列を保持する
 * @type {string|null}
 */
export let currentHostname = null;

/**
 * setCurrentHostname:
 * 指定されたホスト名を現在の監視対象として設定し、
 * monitorData.machines に当該ホスト用のデータ構造がなければ初期化します。
 *
 * @param {string} host - 設定する機器ホスト名（nullやPLACEHOLDER_HOSTNAME以外）
 */
export function setCurrentHostname(host) {
  currentHostname = host;

  // 対象ホストのデータ構造が未初期化なら、空の構造で初期化する
  if (!monitorData.machines[host]) {
    monitorData.machines[host] = {
      storedData: {},   // 監視データ（加工前の値や変換値など）
      runtimeData: {},  // 現在の温度・状態など、常に上書きされる値
      historyData: []   // 印刷履歴などの配列データ
    };
  }
}

/**
 * monitorData: 設定と機器データ全体を保持するグローバルオブジェクト
 * @type {{
 *   appSettings: {
 *     updateInterval: number,
 *     logLevel: string,
 *     autoConnect: boolean,
 *     wsDest: string,
 *     cameraToggle: boolean,
 *     notificationSettings: Record<string, any>
 *   },
 *   machines: Record<string, MachineData>,
 *   filamentSpools: Array<Object>,
 *   currentSpoolId: string|null
 * }}
 */
export const monitorData = {
  appSettings: {
    updateInterval: 500,
    logMaxLines: 1000,
    logLevel: "info",
    autoConnect: true,
    wsDest: "",          // 接続先 IP:PORT
    cameraToggle: false,  // カメラ ON/OFF
    notificationSettings: {}
  },
  machines: {
    [PLACEHOLDER_HOSTNAME]: {
      storedData: {},
      runtimeData: {},
      historyData: []
    }
  },
  filamentSpools: [],
  currentSpoolId: null,
  temporaryBuffer: []
};


/**
 * getCurrentMachine:
 *  - currentHostname に対応する MachineData を返す
 * @returns {MachineData|null}
 */
export function getCurrentMachine() {
  return currentHostname ? monitorData.machines[currentHostname] : null;
}

/**
 * setStoredData:
 *  - currentHostname の storedData[key] に raw/computed を設定し、isNew フラグを立てる
 *
 * @param {string} key     - フィールド名
 * @param {*}      value   - 設定する値
 * @param {boolean} [isRaw=false] - true のとき rawValue、false のとき computedValue として扱う
 */
export function setStoredData(key, value, isRaw = false) {
  const machine = getCurrentMachine();
  if (!machine) return;
  let d = machine.storedData[key];
  if (!d) {
    d = { rawValue: null, computedValue: null, isNew: true };
    machine.storedData[key] = d;
  }
  if (isRaw) {
    d.rawValue = value;
  } else {
    d.computedValue = value;
  }
  d.isNew = true;
}

/**
 * getDisplayValue:
 *  - storedData[fieldName] から {value,unit} 形式の表示用オブジェクトを生成
 *
 * @param {string} fieldName
 * @returns {{value:string,unit:string}|null}
 */
export function getDisplayValue(fieldName) {
  const machine = getCurrentMachine();
  if (!machine) return null;
  const d = machine.storedData[fieldName];
  if (!d) return null;
  if (d.computedValue && typeof d.computedValue === "object" && "value" in d.computedValue) {
    return { value: String(d.computedValue.value), unit: d.computedValue.unit || "" };
  }
  return { value: String(d.rawValue ?? ""), unit: "" };
}



